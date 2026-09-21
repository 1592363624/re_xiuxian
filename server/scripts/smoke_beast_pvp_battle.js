/**
 * 灵兽PVP 对局：并发挑战不能把同一份灵石押两次（需要 MySQL，走 .env 指向的隔离库）
 *
 * 形状：`challenge` 的资格校验全部在**开事务之前**做（读的是不带锁的 player / ranking 快照）：
 *   第 5 步 "挑战方灵石够不够押注" 用 `player.spirit_stones`（无锁那一份）
 *   第 3 步 "今日挑战次数" 用 `challengerRanking.daily_challenge_count`（无锁那一份）
 * 然后才 `sequelize.transaction()` → `_lockPlayersByIdAsc` 锁住同一批行 → 直接用**锁到的新值**扣钱。
 * 于是同一玩家对两个不同对手（绕开同对手冷却）同时发两笔：两笔都通过校验，
 * 各自从"锁到的那份"扣一次 → 余额被扣成负数 / 每日上限形同虚设。
 * 与宗门日常任务、太一门引道是同一类（判定用旧快照、写入用新快照），只是这条链此前零覆盖。
 *
 * 探针不靠运气交错：两笔用 Promise.all 齐发，且每笔的"校验 → 扣款"之间隔着几十毫秒的
 * 战斗计算与多次查询，窗口足够宽。判的是回读库里的最终余额，不是返回码。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_beast_pvp_battle.js
 * 只用自建探针号 bpvp_b1..b3，跑完按主键删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5086);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const SpiritBeast = require('../models/spiritBeast');
const SpiritBeastPvpSeason = require('../models/spiritBeastPvpSeason');
const SpiritBeastPvpRanking = require('../models/spiritBeastPvpRanking');
const SpiritBeastPvpMatch = require('../models/spiritBeastPvpMatch');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const SpiritBeastPvpService = require('../game/services/SpiritBeastPvpService');

const SEASON_NAME = '探针赛季-对局';
const ACCOUNTS = ['bpvp_b1', 'bpvp_b2', 'bpvp_b3'];
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const cfg = () => infrastructure.ConfigLoader.getConfig('spirit_beast_pvp_data').spirit_beast_pvp;
const stonesOf = async id => Number(BigInt((await Player.findByPk(id)).spirit_stones || 0));
/** 成功路径只回 {data}（没有 success 字段），被拒才回 {success:false, message} */
const accepted = r => !!r && r.success !== false && !!r.data && r.data.match_id > 0;
const rejected = r => !!r && r.success === false;

async function ensureFighter(username, stones) {
    let player = await Player.findOne({ where: { username } });
    if (!player) {
        player = await Player.create({
            username, password: 'x', nickname: `对局探针${username.slice(-1)}`,
            realm: '炼气3层', realm_rank: 3, exp: 0, spirit_stones: stones,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    } else {
        player.spirit_stones = BigInt(stones);
        player.is_dead = false; player.is_banned = false; player.ip_address = null;
        await player.save();
    }
    await SpiritBeast.destroy({ where: { player_id: player.id } });
    const e = cfg().eligibility;
    const beast = await SpiritBeast.create({
        player_id: player.id, beast_key: 'yin_ji', beast_name: '阴蛟', element: 'metal',
        rarity: 'rare', star_level: 1, beast_soul: 0, last_upgrade_star_time: new Date(),
        level: Number(e.min_beast_level) + 5, exp: 0, hp_max: 5000, atk: 800, def: 400,
        speed: 300, loyalty: Number(e.min_beast_loyalty) + 40,
        is_active: true, is_pasturing: false, is_exploring: false, stamina: 100
    });
    return { player, beast };
}

/**
 * 重置计数但**保留排名行**。
 * 之前这里是删行：两笔并发各自 `_getOrCreateRanking` 插同一行，
 * 第二笔以 SequelizeUniqueConstraintError(uk_pvp_season_player) 崩掉 —— 于是"只成一笔"
 * 是被一个无关的键撞出来的，双花到底会不会发生根本没观察到（同一类假绿第二次踩到）。
 */
async function resetCounters(seasonId, fighters) {
    await SpiritBeastPvpSeason.update({ status: 'active', settled_at: null }, { where: { id: seasonId } });
    for (const f of fighters) {
        await SpiritBeastPvpService._getOrCreateRanking(f.player, seasonId);
        await SpiritBeastPvpRanking.update({
            daily_challenge_count: 0, daily_first_win_claimed: false, daily_reset_at: new Date()
        }, { where: { player_id: f.player.id, season_id: seasonId } });
    }
    await SpiritBeastPvpMatch.destroy({ where: { season_id: seasonId } });
}

async function main() {
    await bootApp(app, { port: PORT });
    const e = cfg().eligibility, betCfg = cfg().bet;
    if (Number(betCfg.min_spirit_stones) <= 0) throw new Error('押注下限配成 0，双花测试没意义');

    await SpiritBeastPvpSeason.destroy({ where: { season_name: SEASON_NAME } });
    const now = new Date();
    const season = await SpiritBeastPvpSeason.create({
        season_name: SEASON_NAME, start_time: now, status: 'active',
        end_time: new Date(now.getTime() + 30 * 86400000)
    });

    const bet = Number(betCfg.min_spirit_stones);
    const A = await ensureFighter('bpvp_b1', bet);          // 只有刚好一注的灵石
    const B = await ensureFighter('bpvp_b2', 5000);
    const C = await ensureFighter('bpvp_b3', 5000);
    check('B0 播种完成：A 的余额只够一注，三只需要门槛的灵兽都合格',
        await stonesOf(A.player.id) === bet && A.beast.level >= Number(e.min_beast_level),
        `A=${await stonesOf(A.player.id)} 门槛=${e.min_beast_level}/${e.min_beast_loyalty} 押注=${bet}`);

    // ===== B1 一场真对局跑通（锁次序改过，先证明正常路径没坏）=====
    const stonesBeforePair = await stonesOf(A.player.id) + await stonesOf(B.player.id);
    const one = await SpiritBeastPvpService.challenge(A.player, B.player.id, A.beast.id, 'balanced', bet, false);
    check('B1 单发挑战真跑通并落库', accepted(one)
        && (await SpiritBeastPvpMatch.count({ where: { season_id: season.id } })) === 1,
        `${one.message || ''} 结果=${one.data?.result} 回合=${one.data?.total_rounds}`);
    const rankA = await SpiritBeastPvpRanking.findOne({ where: { player_id: A.player.id, season_id: season.id } });
    const rankB = await SpiritBeastPvpRanking.findOne({ where: { player_id: B.player.id, season_id: season.id } });
    const sumOf = r => Number(r.total_wins) + Number(r.total_losses) + Number(r.total_draws);
    check('B2 双方排名行各记一场（每人胜负平合计=1，两人相加=2）',
        !!rankA && !!rankB && Number(rankA.total_matches) === 1 && Number(rankB.total_matches) === 1
        && sumOf(rankA) === 1 && sumOf(rankB) === 1,
        `A=${rankA && rankA.total_wins}/${rankA && rankA.total_losses}/${rankA && rankA.total_draws}`
        + ` B=${rankB && rankB.total_wins}/${rankB && rankB.total_losses}/${rankB && rankB.total_draws}`);

    const bonus = Number(one.data?.first_win_bonus || 0);
    const stonesAfterPair = await stonesOf(A.player.id) + await stonesOf(B.player.id);
    check('B3 押注只是转移，两人数额合计只多出一个首胜奖励',
        stonesAfterPair === stonesBeforePair + bonus,
        `前=${stonesBeforePair} 后=${stonesAfterPair} 首胜奖励=${bonus}`);

    // ===== B4 同对手冷却真的生效（B5 要用不同对手绕开它，得先确认它长什么样）=====
    const cooled = await SpiritBeastPvpService.challenge(A.player, B.player.id, A.beast.id, 'balanced', bet, false);
    check('B4 同对手冷却生效', rejected(cooled) && /冷却/.test(cooled.message || ''), cooled.message);

    // ===== B5 关键：只有一份 1000 灵石，同时对两个不同对手各押 1000 =====
    await Player.update({ spirit_stones: bet }, { where: { id: [A.player.id, B.player.id, C.player.id] } });
    await resetCounters(season.id, [A, B, C]);
    const before = await stonesOf(A.player.id);
    const trioBefore = before + await stonesOf(B.player.id) + await stonesOf(C.player.id);
    // 战斗结果换成"挑战方必输"的桩：不然 A 赢了第一局就有钱押第二局，两笔都成是合法的，
    // 测不出双花（第一版就被这点骗过 —— 断言写"最多成一笔"，真正该钉的是"不够钱的那笔必须被拒"）。
    const realBattle = SpiritBeastPvpService._executeBattle;
    SpiritBeastPvpService._executeBattle = () => ({
        winner: 'defender', total_rounds: 3, final_challenger_hp: 0, final_defender_hp: 1000, log: []
    });
    let pair;
    try {
        pair = await Promise.all([
            SpiritBeastPvpService.challenge(A.player, B.player.id, A.beast.id, 'balanced', bet, false)
                .catch(err => ({ crashed: `${err.name}: ${err.message}` })),
            SpiritBeastPvpService.challenge(A.player, C.player.id, A.beast.id, 'balanced', bet, false)
                .catch(err => ({ crashed: `${err.name}: ${err.message}` }))
        ]);
    } finally {
        SpiritBeastPvpService._executeBattle = realBattle;
    }
    const aAfter = await stonesOf(A.player.id);
    const bAfter = await stonesOf(B.player.id);
    const cAfter = await stonesOf(C.player.id);
    const okCount = pair.filter(accepted).length;
    const bonuses = pair.reduce((n, r) => n + Number(r.data?.first_win_bonus || 0), 0);
    check('B5 只够一注的余额：并发两笔最多成一笔（同一份灵石不能押两次）', okCount <= 1,
        `成功=${okCount} 明细=${pair.map(r => r.crashed ? `crash:${r.crashed}` : `${accepted(r) ? 'ok' : 'rejected'}/${(r.message || '').slice(0, 22)}`).join(' ; ')}`);
    check('B6 三个人余额都不为负（双花会把 A 扣成 -100）',
        aAfter >= 0 && bAfter >= 0 && cAfter >= 0,
        `A 前=${before} 后=${aAfter} B=${bAfter} C=${cAfter}`);
    check('B7 全系统守恒：三人总量只多出"首胜奖励"那么多（押注是转移，不是印钱）',
        (aAfter + bAfter + cAfter) - trioBefore === bonuses,
        `总前=${trioBefore} 总后=${aAfter + bAfter + cAfter} 差=${(aAfter + bAfter + cAfter) - trioBefore} 首胜奖励=${bonuses}`
        + ` 各笔=${pair.map(r => r.data ? `${r.data.result}:won${r.data.bet_won}/lost${r.data.bet_lost}` : '被拒/崩').join(',')}`);
    const aRankAfter = await SpiritBeastPvpRanking.findOne({ where: { player_id: A.player.id, season_id: season.id } });
    check('B8 被拒的那笔说得出"灵石不足"，且没偷偷多记场次/多扣每日次数',
        pair.some(r => rejected(r) && /灵石不足/.test(r.message || ''))
        && (await SpiritBeastPvpMatch.count({ where: { season_id: season.id } })) === okCount
        && Number(aRankAfter.daily_challenge_count) === okCount,
        `落库场次=${await SpiritBeastPvpMatch.count({ where: { season_id: season.id } })} 成功=${okCount}`
        + ` A今日次数=${aRankAfter.daily_challenge_count} 被拒原因=${pair.map(r => r.message).filter(Boolean).join(',')}`);

    // ===== B8 互攻不死锁（这次改的就是两边的取锁次序）=====
    let deadlock = 0, rounds = 0, crashed = [];
    for (let i = 0; i < 6; i++) {
        await resetCounters(season.id, [A, B, C]);
        await Player.update({ spirit_stones: 20000 }, { where: { id: [A.player.id, B.player.id] } });
        const res = await Promise.all([
            SpiritBeastPvpService.challenge(A.player, B.player.id, A.beast.id, 'balanced', bet, true).catch(err => ({ crashed: err.message })),
            SpiritBeastPvpService.challenge(B.player, A.player.id, B.beast.id, 'balanced', bet, true).catch(err => ({ crashed: err.message }))
        ]);
        rounds++;
        for (const r of res) {
            if (r.crashed) crashed.push(r.crashed);
            if (/Deadlock|ER_LOCK_DEADLOCK|锁等待|Lock wait timeout/i.test(r.crashed || '')) deadlock++;
        }
    }
    check('B9 甲乙互攻 6 轮：没有死锁/锁超时（行为回归；次序的硬闸在 BlobWriteRaceGates 静态那条）',
        deadlock === 0 && crashed.length === 0,
        `轮数=${rounds} 死锁=${deadlock} 异常=${[...new Set(crashed)].join('|').slice(0, 120) || '无'}`);

    await resetCounters(season.id, [A, B, C]);
    await SpiritBeastPvpSeason.destroy({ where: { id: season.id } });
}

(async () => {
    let hard = 0;
    try {
        await main();
    } catch (err) {
        hard = 1;
        console.error('探针异常：', err.message, err.stack);
    } finally {
        try {
            const ids = (await Player.findAll({ where: { username: { [Op.in]: ACCOUNTS } }, attributes: ['id'], raw: true })).map(r => r.id);
            if (ids.length) {
                await SpiritBeastPvpRanking.destroy({ where: { player_id: { [Op.in]: ids } } });
                await SpiritBeastPvpMatch.destroy({ where: { challenger_player_id: { [Op.in]: ids } } });
                await SpiritBeastPvpMatch.destroy({ where: { defender_player_id: { [Op.in]: ids } } });
                await SpiritBeast.destroy({ where: { player_id: { [Op.in]: ids } } });
            }
            await SpiritBeastPvpSeason.destroy({ where: { season_name: SEASON_NAME } });
            await Player.destroy({ where: { username: { [Op.in]: ACCOUNTS } }, force: true });
        } catch (err) { console.error('清理失败:', err.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
