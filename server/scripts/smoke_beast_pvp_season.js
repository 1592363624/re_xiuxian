/**
 * 灵兽 PvP 赛季结算：一笔结算只能发一次奖（需要 MySQL，走 .env 指向的隔离库）
 *
 * 盯的缺陷形状：`checkSeasonExpiry` 用**不带锁**的 findAll 粗筛出到期赛季，把那份快照交给
 * `_settleSeason`；而 `_settleSeason` 从头到尾没有再确认"这一行现在还是 active 吗"。
 * 于是任何"先读到、后执行"的重放 —— 调度器一轮 tick 与一次手动结算重叠、上一轮卡在慢查询里、
 * 或者第二个 PM2 实例 —— 都会拿着"结算之前"的快照再走一遍：前 100 名的赛季奖励**发两遍**，
 * `settlement_summary` 被后那份按旧快照整块盖掉。
 * 与 FengshenService.settleSeason / ArtifactDeepLineService.settleExpiredSheaths 同一类，只是这条没人碰过。
 *
 * 顺带两处一起钉住：
 *   - 新赛季必须与结算在**同一个事务**里建：原来 commit 之后才 create，建失败（唯一键/进程被杀）
 *     就留下"上一季 settled、下一季不存在"的空档，排位停摆且没人补。
 *   - 发奖循环按名次逐个锁 players，而并发对局按"挑战者→防守者"锁同一批行 —— 次序不固定就是 ABBA。
 *     现在两边都走 _lockPlayersByIdAsc；锁次序压不出来（见 smoke_fengshen_defense F6/F7 的教训），
 *     交给 BlobWriteRaceGates 的静态闸管。
 *
 * 为什么不用"同时发两笔"当主证据：第一次跑控制实验时发现两笔并发会撞在新赛季同名上
 * （第二笔以 Validation error 收场），双发被另一个 bug 遮住了 —— 那种绿是假绿。
 * 所以主证据改成**确定性的"旧快照重放"**：先读一份快照 → 让第一笔完整结算完 → 再拿那份快照跑第二笔。
 * 并发那一组只用来要求"干净地退出，不是崩掉"。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_beast_pvp_season.js
 * 只用自建探针号 bpvp_s1..s3，跑完按 id 差集清理，不碰库里原有的赛季。
 */
'use strict';

// 必须在 require('../index') 之前定端口：index.js 加载时就 server.listen(PORT)，
// 晚一步它会去抢 :5000（业主自己那台服务端）。
const PORT = Number(process.env.SMOKE_PORT || 5092);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const SpiritBeastPvpSeason = require('../models/spiritBeastPvpSeason');
const SpiritBeastPvpRanking = require('../models/spiritBeastPvpRanking');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const SpiritBeastPvpService = require('../game/services/SpiritBeastPvpService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const ACCOUNTS = ['bpvp_s1', 'bpvp_s2', 'bpvp_s3'];
const NAME_PREFIX = '探针赛季-';
/** 开跑前库里已有的赛季 id：清理只碰这次新冒出来的 */
let idsBefore = new Set();
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const cfg = () => infrastructure.ConfigLoader.getConfig('spirit_beast_pvp_data').spirit_beast_pvp;

/** 与结算用同一份内容，按名次自己算一遍期望奖励 */
function expectedReward(rank, tierKey) {
    const s = cfg().season;
    let reward = Number((cfg().tiers.find(t => t.key === tierKey) || {}).season_reward_spirit_stones || 0);
    if (rank === 1) reward += Number(s.top1_reward_spirit_stones);
    else if (rank <= 3) reward += Number(s.top3_reward_spirit_stones);
    else if (rank <= 10) reward += Number(s.top10_reward_spirit_stones);
    else reward += Number(s.top100_reward_spirit_stones);
    return reward;
}

async function ensurePlayer(username) {
    let player = await Player.findOne({ where: { username } });
    if (!player) {
        player = await Player.create({
            username, password: 'not-a-real-hash', nickname: `赛季探针${username.slice(-1)}`,
            realm: '炼气3层', realm_rank: 3, exp: 0, spirit_stones: 1000,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    } else {
        player.spirit_stones = 1000n;
        await player.save();
    }
    return player;
}

async function stones(id) {
    const p = await Player.findByPk(id);
    return Number(BigInt(p.spirit_stones || 0));
}

async function seedSeason(name, players, tierKey) {
    const season = await SpiritBeastPvpSeason.create({
        season_name: name,
        start_time: new Date(Date.now() - 8 * 86400000),
        end_time: new Date(Date.now() - 3600000),            // 已到期
        status: 'active'
    });
    const seeded = [];
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        await SpiritBeastPvpRanking.create({
            season_id: season.id, player_id: p.id, player_nickname_snapshot: p.nickname,
            tier: tierKey, ranking_points: 1000 - i * 100, total_wins: 10 - i,
            total_losses: 0, total_draws: 0, total_matches: 10 - i, win_rate: 1.0,
            best_beast_id: 1, total_bet_won: 0, total_bet_lost: 0,
            daily_challenge_count: 0, daily_first_win_claimed: false
        });
        seeded.push({ player_id: Number(p.id), rank: i + 1, reward: expectedReward(i + 1, tierKey) });
    }
    return { season, seeded };
}

async function totalStones(seeded) {
    let sum = 0;
    for (const s of seeded) sum += await stones(s.player_id);
    return sum;
}

async function newSeasonIds() {
    const all = await SpiritBeastPvpSeason.findAll({ attributes: ['id', 'status'], raw: true });
    return all.filter(r => !idsBefore.has(Number(r.id)));
}

async function main() {
    await bootApp(app, { port: PORT });
    const tierKey = (cfg().tiers || [])[0]?.key;
    if (!tierKey) throw new Error('内容里没有 tiers，探针没法算期望奖励');

    await SpiritBeastPvpSeason.destroy({ where: { season_name: { [Op.like]: `${NAME_PREFIX}%` } } });
    const players = [];
    for (const a of ACCOUNTS) players.push(await ensurePlayer(a));
    const A = await seedSeason(`${NAME_PREFIX}重放`, players, tierKey);
    const B = await seedSeason(`${NAME_PREFIX}并发`, players, tierKey);
    // 基线取在播种之后：P7 要数的是"结算这一步新建了几个赛季"，把自己种的那两个也算进去就没意义了
    idsBefore = new Set((await SpiritBeastPvpSeason.findAll({ attributes: ['id'], raw: true })).map(r => Number(r.id)));
    check('P0 两个赛季都是"已到期的 active"，且每个名次期望奖励 > 0',
        [A, B].every(x => x.season.status === 'active' && new Date(x.season.end_time) < new Date())
        && A.seeded.every(s => Number.isFinite(s.reward) && s.reward > 0),
        `期望=${A.seeded.map(s => s.reward).join('/')}`);

    // ===== P1 第一笔完整结算 =====
    // 先取两份"还在 active"的快照，模拟两轮 tick / 调度器与手动各读到一次
    const staleA1 = await SpiritBeastPvpSeason.findByPk(A.season.id);
    const staleA2 = await SpiritBeastPvpSeason.findByPk(A.season.id);
    const stones0 = await totalStones(A.seeded);
    const first = await SpiritBeastPvpService._settleSeason(staleA1);
    const stones1 = await totalStones(A.seeded);
    check('P1 首笔结算成功且按名次发钱', first?.settled === true
        && stones1 - stones0 === A.seeded.reduce((n, s) => n + s.reward, 0),
        `实发合计 ${stones1 - stones0} / 应发 ${A.seeded.reduce((n, s) => n + s.reward, 0)}`);

    // ===== P2 关键：拿"首笔结算之前"读到的另一份旧快照重放一遍 =====
    // 不带守卫时，这一笔看的是自己手上那份 active 快照，会完整再走一遍 → 双发。
    const replay = await SpiritBeastPvpService._settleSeason(staleA2);
    check('P2 旧快照重放被挡住：第二笔 settled:false 并写明原因',
        replay?.settled === false && typeof replay.reason === 'string' && replay.reason.length > 0,
        `重放=${JSON.stringify(replay).slice(0, 120)}`);
    check('P3 重放那笔一分钱都没多发（双发会正好再来一遍）',
        await totalStones(A.seeded) === stones1, '');
    check('P4 重放也没有把 settlement_summary 盖成旧内容',
        (await SpiritBeastPvpSeason.findByPk(A.season.id)).settlement_summary?.top_100?.length === A.seeded.length,
        JSON.stringify((await SpiritBeastPvpSeason.findByPk(A.season.id)).settlement_summary?.top_100
            ?.map(r => `${r.rank}:${r.reward_spirit_stones}`)));

    // ===== P5 真并发：要求干净退出（一笔成、另一笔带 reason），不接受以异常收场 =====
    const tickA = await SpiritBeastPvpSeason.findByPk(B.season.id);
    const tickB = await SpiritBeastPvpSeason.findByPk(B.season.id);
    check('P5 并发双读同一行都是 active（这一组是"崩不崩"的行为检查，双发证据在 P2/P3）',
        tickA.status === 'active' && tickB.status === 'active' && Number(tickA.id) === Number(tickB.id), '');
    const both = await Promise.all([
        SpiritBeastPvpService._settleSeason(tickA).catch(e => ({ crashed: e.message })),
        SpiritBeastPvpService._settleSeason(tickB).catch(e => ({ crashed: e.message }))
    ]);
    check('P6 并发两笔：恰好一笔成、另一笔带原因退出，都不以异常收场',
        both.every(r => !r.crashed) && both.filter(r => r.settled === true).length === 1
        && both.filter(r => r.settled === false).length === 1,
        JSON.stringify(both.map(r => r.crashed ? `crash:${r.crashed}` : `${r.settled}/${r.reason || ''}`)).slice(0, 200));

    // ===== P7 结算与建赛季原子：两个赛季各自建且只建一个 =====
    const created = await newSeasonIds();
    check('P7 两次结算共新增 2 个 active 赛季（不多不少，不出现"settled 却无下季"）',
        created.length === 2 && created.every(r => r.status === 'active'),
        `新增=${JSON.stringify(created)}`);

    // ===== P8 调度器再跑一轮：无事可做 =====
    const sumBefore = await totalStones(A.seeded);
    await SpiritBeastPvpService.checkSeasonExpiry();
    check('P8 再跑一次调度器：不多建赛季、不多发一分钱',
        (await newSeasonIds()).length === created.length && await totalStones(A.seeded) === sumBefore,
        `新增赛季 ${created.length}→${(await newSeasonIds()).length}`);

    // ===== P9/P10 取锁助手本身（challenge 没有端到端探针：要备灵兽与赌注；这里至少证明
    //        "打乱顺序传进去也按 id 升序返回、且一行都不丢"，静态闸钉的是"必须走它"）=====
    const tx = await sequelize.transaction();
    try {
        const shuffled = [...players].sort((a, b) => Number(b.id) - Number(a.id));
        const locked = await SpiritBeastPvpService._lockPlayersByIdAsc(tx, shuffled.map(p => p.id));
        check('P9 _lockPlayersByIdAsc 把传进去的行一行不少地锁回来',
            locked.length === players.length
            && shuffled.every(p => locked.some(l => Number(l.id) === Number(p.id))),
            `传入 ${shuffled.length} 锁到 ${locked.length}`);
        check('P10 返回次序是 id 升序（与调用方传参顺序无关）',
            locked.every((r, i) => i === 0 || Number(locked[i - 1].id) <= Number(r.id)),
            locked.map(r => r.id).join('→'));
        await tx.rollback();
    } catch (e) {
        await tx.rollback().catch(() => {});
        check('P9 取锁助手能跑', false, e.message);
    }
}

(async () => {
    let hard = 0;
    try {
        await main();
    } catch (e) {
        hard = 1;
        console.error('探针异常：', e.message, e.stack);
    } finally {
        try {
            // 只删这次跑出来的：自己种的（按名字前缀）+ 结算新建的（id 不在开跑前的集合里）
            const all = await SpiritBeastPvpSeason.findAll({ attributes: ['id', 'season_name'], raw: true });
            const mine = all.filter(r => String(r.season_name).startsWith(NAME_PREFIX) || !idsBefore.has(Number(r.id)))
                .map(r => Number(r.id));
            const ids = (await Player.findAll({ where: { username: { [Op.in]: ACCOUNTS } }, attributes: ['id'], raw: true })).map(r => r.id);
            // 按 season_id 的那一条留着：它捞的是"这几个赛季里所有人的排名行"，列名不是归属档，级联不认；
            // 而按 player_id 归属的那一条（上面原来那行）交回给那扇门 —— 排名行的列就是 player_id。
            if (mine.length) await SpiritBeastPvpRanking.destroy({ where: { season_id: { [Op.in]: mine } } });
            if (mine.length) await SpiritBeastPvpSeason.destroy({ where: { id: { [Op.in]: mine } } });
            const purged = await PlayerCascadePurge.deletePlayers(ids);
            console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`
                + `（另有本次产生的 ${mine.length} 个赛季按 id 删掉）`);
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
