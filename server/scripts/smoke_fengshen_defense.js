/**
 * 封神台防守快照的属性来源探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么单独一个：封神台是异步 PvP —— 挑战者一侧用 CombatResolver.resolveCombatStats 现算，
 * 防守一侧用的是 setDefense 当时存进 defense_config.snapshot 的那份属性。改造前存的是
 * players.attributes 里的 atk / def / speed / hp_max —— 那是旧属性管线留下的"输出键"：
 * 新管线既不写它们，也不以它们为基数（实测 re_xiuxian_test 上同一玩家按 blob 键算出战力 6185，
 * 按解析链路算是 98，差 63 倍）。攻守两套数字，排名结果就不可信，而且这类偏差不会报错。
 *
 * 这里在 blob 里放一个明显的诱饵值（999999），任何还去读旧键的实现都会当场暴露。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_fengshen_defense.js
 * 探针自建/复用玩家 fengshentest1，只动它自己的行，结束时清掉自己造的数据。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5093);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const FengshenRanking = require('../models/fengshenRanking');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const CombatResolver = require('../game/combat/CombatResolver');
const FengshenService = require('../game/services/FengshenService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const DECOY = 999999;
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function ensurePlayer() {
    let player = await Player.findOne({ where: { username: 'fengshentest1' } });
    if (!player) {
        player = await Player.create({
            username: 'fengshentest1',
            password: 'not-a-real-hash',
            nickname: '封神探针',
            realm: '筑基初期',
            realm_rank: 11,
            exp: 0,
            spirit_stones: 10000,
            hp_current: 5000,
            mp_current: 5000,
            lifespan_current: 120,
            attributes: {},
            token_version: 0
        });
    }
    await FengshenRanking.destroy({ where: { player_id: player.id } });
    // 键级补丁写诱饵值（整块覆盖必须走事务，blobWriteGuard 盯着）
    await PlayerStateStore.patchPlayerState(player.id, {
        attributes: { atk: DECOY, def: DECOY, speed: DECOY, hp_max: DECOY, hp_current: 1 }
    });
    // 列上的当前气血另设一个值：blob 里那份镜像是 1，两者不一致才能验"取的是列"
    await Player.update({ hp_current: 1234 }, { where: { id: player.id } });
    return Player.findByPk(player.id);
}

// F6 需要"多个真实玩家同时改防守阵容"，所以另建一批一次性探针号（结束时删掉，不留给别的探针看到）。
async function ensureProbePlayers(count) {
    const players = [];
    for (let i = 1; i <= count; i++) {
        const username = `fsprobe${i}`;
        let player = await Player.findOne({ where: { username } });
        if (!player) {
            player = await Player.create({
                username,
                password: 'not-a-real-hash',
                nickname: `封神并发探针${i}`,
                realm: '筑基初期',
                realm_rank: 11,
                exp: 0,
                spirit_stones: 1000,
                hp_current: 5000,
                mp_current: 5000,
                lifespan_current: 120,
                attributes: {},
                token_version: 0,
                pvp_mode: 'active'
            });
        }
        await FengshenRanking.destroy({ where: { player_id: player.id } });
        players.push(player);
    }
    return players;
}

// 把表撑大：整表 FOR UPDATE 的扫描窗口只有几毫秒，行太少时"撞不上"不等于"不会撞"。
// 这些行只用假 player_id（重算不 join players 表），探针结束即删。
async function widenRankingTable(size) {
    const ids = Array.from({ length: size }, (_, i) => 998001 + i);
    await FengshenRanking.destroy({ where: { player_id: ids } });
    await FengshenRanking.bulkCreate(ids.map(pid => ({
        player_id: pid,
        rank: 0,
        season: 1,
        defense_config: { probe: true },
        fengshen_score: 1000,
        total_wins: 0,
        total_losses: 0,
        daily_challenge_count: 0,
        daily_defend_count: 0,
        last_challenge_date: null
    })));
    return ids;
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await ensurePlayer();
    const attrs = player.attributes || {};
    const { stats } = await CombatResolver.resolveCombatStats(player);

    check(
        'F0 诱饵键确实进了 blob，且解析链路不认它（否则后面的断言都是空的）',
        Number(attrs.atk) === DECOY && Number(stats.atk) !== DECOY,
        `blob.atk=${attrs.atk}, 解析后 atk=${stats.atk}`
    );

    await FengshenService.setDefense(player.id, { probe: true });
    const ranking = await FengshenRanking.findOne({ where: { player_id: player.id } });
    const snapshot = (ranking && ranking.defense_config && ranking.defense_config.snapshot) || {};

    check(
        'F1 防守快照来自解析链路，不是 attributes 里的旧输出键',
        Number(snapshot.atk) === Number(stats.atk)
            && Number(snapshot.def) === Number(stats.def)
            && Number(snapshot.speed) === Number(stats.speed)
            && Number(snapshot.hp_max) === Number(stats.hp_max)
            && Number(snapshot.atk) !== DECOY,
        `snapshot=${snapshot.atk}/${snapshot.def}/${snapshot.speed}/${snapshot.hp_max} 解析=${stats.atk}/${stats.def}/${stats.speed}/${stats.hp_max} 诱饵=${DECOY}`
    );

    check(
        'F2 快照里的当前气血取 players 列值（blob 那份镜像可能已被原子扣减落下）',
        Number(snapshot.hp_current) === 1234,
        `snapshot.hp_current=${snapshot.hp_current}, blob 镜像=${attrs.hp_current}, 列=1234`
    );

    const snapshotPower = FengshenService._calculatePowerFromSnapshot(snapshot);
    const livePower = await FengshenService._calculatePowerFromAttributes(player);
    check(
        'F3 攻守两侧同源：同一玩家按防守快照和按当前属性算出的战力一致',
        Math.round(snapshotPower) === Math.round(livePower),
        `快照战力=${Math.round(snapshotPower)}, 现属性战力=${Math.round(livePower)}`
    );

    // ===== F4：名次重算与 SQL 的 ORDER BY 逐格一致 =====
    // 锁顺序改成 id 升序之后，名次排序从 SQL 搬进了 JS —— 这一步就是验它俩等价（含同分按 created_at 升序）。
    const SEED = [
        { player_id: 999001, fengshen_score: 900, total_wins: 9, created_at: new Date('2026-01-05T00:00:00Z') },
        { player_id: 999002, fengshen_score: 1200, total_wins: 3, created_at: new Date('2026-01-04T00:00:00Z') },
        { player_id: 999003, fengshen_score: 1200, total_wins: 9, created_at: new Date('2026-01-03T00:00:00Z') },
        { player_id: 999004, fengshen_score: 800, total_wins: 1, created_at: new Date('2026-01-02T00:00:00Z') },
        { player_id: 999005, fengshen_score: 800, total_wins: 1, created_at: new Date('2026-01-01T00:00:00Z') }
    ];
    const seededIds = SEED.map(s => s.player_id);
    await FengshenRanking.destroy({ where: { player_id: seededIds } });
    for (const s of SEED) {
        await FengshenRanking.create({
            player_id: s.player_id, rank: 0, season: 1, defense_config: { probe: true },
            fengshen_score: s.fengshen_score, total_wins: s.total_wins, total_losses: 0,
            daily_challenge_count: 0, daily_defend_count: 0, last_challenge_date: null,
            created_at: s.created_at
        });
    }

    const recalcTx = await sequelize.transaction();
    try {
        await FengshenService._recalculateRanks(recalcTx);
        await recalcTx.commit();
    } catch (e) {
        await recalcTx.rollback();
        throw e;
    }

    // 期望顺序直接问数据库要，不在探针里再抄一份排序实现
    const expectedRows = await sequelize.query(
        `SELECT player_id FROM fengshen_rankings
         WHERE defense_config IS NOT NULL AND player_id IN (:ids)
         ORDER BY fengshen_score DESC, total_wins DESC, created_at ASC`,
        { replacements: { ids: seededIds }, type: sequelize.QueryTypes.SELECT }
    );
    const seeded = await FengshenRanking.findAll({ where: { player_id: seededIds } });
    // 名次是"全表"的（探针玩家那一行也参与），所以比的是**相对次序**：
    // 按名次排出来的种子行序列，必须等于按 SQL 分数序排出来的同一批种子行
    const actualOrder = seeded.slice().sort((a, b) => Number(a.rank) - Number(b.rank)).map(r => Number(r.player_id));
    const expectedOrder = expectedRows.map(row => Number(row.player_id));
    const mismatch = actualOrder.join(',') !== expectedOrder.join(',');
    check(
        'F4 重算出的名次次序与 SQL ORDER BY（含同分按 created_at 升序）一致',
        !mismatch && seeded.length === SEED.length && new Set(actualOrder).size === SEED.length,
        `重算=[${actualOrder.join(' ')}] SQL=[${expectedOrder.join(' ')}]`
    );

    // ===== F5：并发名次重算不许互相打回 =====
    // 整张表都是 FOR UPDATE。改造前按积分序逐行加锁，两笔并发扫描看到的积分序可以不同 → InnoDB 死锁；
    // 现在锁顺序恒为 id 升序，等待图不可能成环。6 路并发里任何一笔报错就红。
    const races = await Promise.all(Array.from({ length: 6 }, async () => {
        const t = await sequelize.transaction();
        try {
            await FengshenService._recalculateRanks(t);
            await t.commit();
            return null;
        } catch (e) {
            if (!t.finished) await t.rollback();
            return e.message;
        }
    }));
    check('F5 并发名次重算 6 路全部成功（无死锁）',
        races.every(r => r === null), races.filter(Boolean).slice(0, 2).join(' | ') || '6/6 通过');

    // ===== F6：并发"保存防守阵容"不许互相死锁（回归门禁）=====
    // 改造前 setDefense 的锁次序是「先 FOR UPDATE 自己那一行 → 再 ORDER BY id ASC 扫全表」：自己那一行的
    // id 通常远大于扫描起点，于是本事务变成"持着高位、去要低位"，另一笔并发 setDefense 恰好相反 → ABBA。
    // 现在改成「先按 id 升序锁完整张表 → 再动自己那一行」（FengshenService._lockRankingsByIdAsc），
    // 两笔并发只剩单向等待。F7 用同一批语句把这个差分压成确定性结论。
    // 这一条不需要跨表、不需要调度器和玩家操作撞车：**两个玩家同一天各点一次保存防守阵容**就能踩到，
    // 玩家侧看到的是一条 500「服务器错误」，阵容没存上但没有任何提示。
    // 整表 FOR UPDATE 只跑几毫秒，所以先把表撑到 1500 行再压 —— 窗口太小导致的"没撞上"是空断言。
    const probePlayers = await ensureProbePlayers(6);
    const wideIds = await widenRankingTable(1500);
    for (const p of probePlayers) await FengshenService.setDefense(p.id, { probe: 'setup' });

    const isLockFailure = m => /Deadlock found|Lock wait timeout|死锁|锁等待/i.test(m);
    // 先量一下"事务窗口"有多大：撞不上死锁时，得说清楚是顺序对了还是窗口太小（空断言）。
    const timingTx = await sequelize.transaction();
    const sweepStart = Date.now();
    await FengshenService._lockRankingsByIdAsc(timingTx);
    const sweepMs = Date.now() - sweepStart;
    await timingTx.rollback();
    const callStart = Date.now();
    await FengshenService.setDefense(probePlayers[0].id, { probe: 'timing' });
    const callMs = Date.now() - callStart;

    const rounds = 8;
    let attempts = 0;
    let overlappedCalls = 0;
    const lockFailures = [];
    const otherErrors = [];
    for (let round = 0; round < rounds; round++) {
        const spans = [];
        const settled = await Promise.all(probePlayers.map(p => {
            const span = { start: Date.now(), end: 0 };
            spans.push(span);
            return FengshenService.setDefense(p.id, { probe: `round${round}` })
                .then(() => { span.end = Date.now(); return null; },
                    err => { span.end = Date.now(); return err && err.message ? err.message : String(err); });
        }));
        attempts += settled.length;
        // 自己这一笔和别的笔在时间上真的交叠过吗？没有交叠的并发探针是空断言（偷菜那次的教训）
        for (let i = 0; i < spans.length; i++) {
            for (let j = i + 1; j < spans.length; j++) {
                if (spans[i].start < spans[j].end && spans[j].start < spans[i].end) {
                    overlappedCalls++;
                    break;
                }
            }
        }
        for (const msg of settled) {
            if (!msg) continue;
            (isLockFailure(msg) ? lockFailures : otherErrors).push(msg);
        }
    }
    check(
        `F6 并发保存防守阵容 ${probePlayers.length} 路 × ${rounds} 轮全部成功（无死锁）`,
        lockFailures.length === 0 && otherErrors.length === 0 && overlappedCalls > 0,
        `${attempts} 次调用，与其他调用时间交叠 ${overlappedCalls} 次，死锁/锁等待 ${lockFailures.length} 次`
        + `；整表升序加锁 ${sweepMs}ms / 单笔 setDefense ${callMs}ms（锁窗口只占 ${callMs ? Math.round(sweepMs / callMs * 100) : 0}%，`
        + '所以这里的 0 次是"没撞上"而不是"证明了不会撞"）'
        + (otherErrors.length ? ` | 其他错误: ${otherErrors.slice(0, 2).join(' | ')}` : '')
    );

    // ===== F7：锁顺序差分（把 F6 的"没撞上"变成确定性结论）=====
    // 直接按两条路径的语句顺序压库：两笔事务各锁一行"自己的"排名记录（id 一大一小），然后都去
    // ORDER BY id ASC 扫全表。旧顺序（先自己那行 → 再扫表）必然成环；新顺序（先扫表 → 再动自己那行）
    // 只剩单向等待。为什么绕开 service 调用：F6 量到"持锁再伸手"的窗口只占单笔调用的百分之几，
    // 压几十次也可能一次都不撞 —— 那是窗口小，不是顺序对。这里把窗口钉死，唯一变量就是语句先后。
    const rankRows = await FengshenRanking.findAll({
        where: { player_id: probePlayers.map(p => p.id) },
        attributes: ['id'],
        order: [['id', 'ASC']]
    });
    const lowId = Number(rankRows[0].id);
    const highId = Number(rankRows[rankRows.length - 1].id);
    const SWEEP_SQL = 'SELECT id FROM fengshen_rankings WHERE defense_config IS NOT NULL ORDER BY id ASC FOR UPDATE';
    const OWN_SQL = 'SELECT id FROM fengshen_rankings WHERE id = ? FOR UPDATE';

    async function tryQuery(t, sql, replacements) {
        try {
            await sequelize.query(sql, { replacements, transaction: t });
            return null;
        } catch (err) {
            return String((err.parent && err.parent.code) || err.code || err.message);
        }
    }

    async function deadlockCountFor(ownRowFirst) {
        const tA = await sequelize.transaction();
        const tB = await sequelize.transaction();
        const codes = [];
        try {
            if (ownRowFirst) {
                codes.push(await tryQuery(tA, OWN_SQL, [highId]));
                codes.push(await tryQuery(tB, OWN_SQL, [lowId]));
                codes.push(...await Promise.all([tryQuery(tA, SWEEP_SQL), tryQuery(tB, SWEEP_SQL)]));
            } else {
                // B 的扫描不 await：它就是会阻塞在 A 已持有的行上，等 A 提交后才继续
                const sweepB = tryQuery(tB, SWEEP_SQL);
                codes.push(await tryQuery(tA, SWEEP_SQL));
                codes.push(await tryQuery(tA, OWN_SQL, [highId]));
                await tA.commit();
                codes.push(await sweepB);
                codes.push(await tryQuery(tB, OWN_SQL, [lowId]));
                await tB.commit();
            }
        } finally {
            for (const t of [tA, tB]) {
                if (!t.finished) await t.rollback().catch(() => {});
            }
        }
        return codes.filter(c => c && /DEADLOCK/i.test(c)).length;
    }

    const oldOrderDeadlocks = await deadlockCountFor(true);
    const newOrderDeadlocks = await deadlockCountFor(false);
    check(
        'F7 锁顺序差分：旧顺序(own→sweep)成环、新顺序(sweep→own)只剩单向等待',
        oldOrderDeadlocks > 0 && newOrderDeadlocks === 0,
        `旧顺序死锁 ${oldOrderDeadlocks} 笔，新顺序 ${newOrderDeadlocks} 笔（own 行 id=${lowId}/${highId}）`
    );

    // wideIds / seededIds 用的是假 player_id（998xxx / 999xxx），根本没有对应的 players 行，
    // 级联只按传进去的真实 id 清，所以这两批撑表/种子行仍然要探针自己删。
    await FengshenRanking.destroy({ where: { player_id: wideIds } });
    await FengshenRanking.destroy({ where: { player_id: seededIds } });
    // 6 个 fsprobe 探针号：它们的 fengshen_rankings 行按 player_id 归属，连同其它派生行一起交给级联那扇门
    const purged = await PlayerCascadePurge.deletePlayers(probePlayers.map(p => p.id));
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
    // fengshentest1 跨运行复用、不删，所以它那一行排名记录仍要手写清掉
    await FengshenRanking.destroy({ where: { player_id: player.id } });
    await PlayerStateStore.patchPlayerState(player.id, {
        attributes: { atk: null, def: null, speed: null, hp_max: null, hp_current: null }
    });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    await sequelize.close().catch(() => {});
    process.exit(2);
});
