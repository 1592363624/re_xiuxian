/**
 * 万宝阁展品鉴赏（CaveSocialService）：修为/声望/热度三笔账必须与"成功鉴赏的次数"一一对上
 * （需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要这条：CaveSocialService 此前运行时零覆盖，而 appreciateExhibit 一个方法里按
 * "鉴赏者 → 展品主人"这个业务次序**串行**锁两行 players（见 SAME_TABLE_DEBT）。
 * 两个人互相鉴赏对方展出的法宝时，两笔事务正好以相反次序伸手要同两行 —— 这是同表这一类，
 * 跨表普查按"模型对"聚合，players|players 凑不成对，它看不见。
 * S6 量的就是这个：改前几轮互鉴出多少次 Deadlock 就写多少次，改后必须为 0。
 *
 * 顺带钉住两笔更容易漏的账：
 *   - S7 heat_count 必须等于该展品成功的鉴赏笔数 —— 两笔事务各自"读热度 → +1 → 存回"就是旧快照覆盖新快照；
 *   - S5 appreciate.daily_limit 在并发下是否真挡得住（每日上限是按 玩家 计的，所以要把对这个人的
 *     计数挪到已经锁住他 players 行之后，不额外加取锁边）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_cave_social.js
 * 只用自建探针号 cs_a / cs_b 与四件现成丹药，跑完删干净。
 */
'use strict';

// 必须在 require('../index') 之前定端口：index.js 加载时就 server.listen(PORT)，晚一步会去抢 :5000。
const PORT = Number(process.env.SMOKE_PORT || 5178);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const Item = require('../models/item');
const PlayerCave = require('../models/playerCave');
const CaveTreasureLog = require('../models/caveTreasureLog');
const CaveExhibit = require('../models/caveExhibit');
const CaveExhibitAppreciation = require('../models/caveExhibitAppreciation');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const InventoryService = require('../game/services/InventoryService');
const CaveService = require('../game/services/CaveService');
const CaveSocialService = require('../game/services/CaveSocialService');

const NAMES = ['cs_a', 'cs_b'];
// 四件品质 ≥ uncommon（能上架）且 ≥ rare（主人必得声望）的现成丹药
const GOODS = ['high_healing_pill', 'foundation_pill', 'mid_longevity_pill', 'gold_pill'];
const RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };
const EXP_BASE = 50, EXP_PER_QUALITY = 30, ENLIGHTEN_MULT = 3;   // cave_data.json: cave.social.treasure_pavilion
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; }; };
const isDeadlock = s => /Deadlock|lock wait timeout|ER_LOCK_DEADLOCK/i.test(s);
const reasonOf = e => `${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : String(e)}`.slice(0, 120);
async function safe(fn) {
    try { return { ok: true, r: await fn() }; } catch (e) { return { ok: false, why: reasonOf(e) }; }
}

async function exp(id) { return N((await Player.findByPk(id, { attributes: ['exp'] })).exp); }
async function honor(id) { return N((await Player.findByPk(id, { attributes: ['honor'] })).honor); }
async function heat(exhibitId) { return Number((await CaveExhibit.findByPk(exhibitId)).heat_count || 0); }
async function appCount(playerId) { return CaveExhibitAppreciation.count({ where: { appreciator_id: playerId } }); }
/** 合法的修为增量只有两种：基础值，或顿悟后的 3 倍 —— 且必须与 is_enlightened 那条记录一致 */
function expectedExp(quality) {
    const base = EXP_BASE + EXP_PER_QUALITY * (RANK[quality] || 0);
    return [BigInt(base), BigInt(base * ENLIGHTEN_MULT)];
}

async function seed(username) {
    let p = await Player.findOne({ where: { username } });
    const data = { realm: '筑基初期', realm_rank: 6, exp: 1000, honor: 0, spirit_stones: 50000, hp_current: 80000, mp_current: 5000 };
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `鉴赏探针${username.slice(-1)}`,
            lifespan_current: 300, attributes: {}, token_version: 0, ...data
        });
    } else {
        await Player.update(data, { where: { id: p.id } });
    }
    return p;
}

/** 只在内存里改配置，不动仓库文件：这条要证的是"这个键有代码在读"，不是"值等于 3" */
async function withAppreciateOverride(patch, fn) {
    const orig = CaveSocialService.getTreasurePavilionConfig.bind(CaveSocialService);
    CaveSocialService.getTreasurePavilionConfig = () => {
        const c = orig();
        return { ...c, appreciate: { ...(c.appreciate || {}), ...patch } };
    };
    try { return await fn(); } finally { CaveSocialService.getTreasurePavilionConfig = orig; }
}

/** 删记录必须同时把热度清零：heat_count 不跟着回零，S7 那条"热度=成功笔数"就成了探针自己造的假红 */
async function resetAppreciations(ids) {
    const mine = await CaveExhibit.findAll({ where: { player_id: { [Op.in]: ids } }, attributes: ['id'] });
    await CaveExhibitAppreciation.destroy({
        where: {
            [Op.or]: [
                { appreciator_id: { [Op.in]: ids } },
                { exhibit_id: { [Op.in]: mine.map(e => e.id) } }
            ]
        }, force: true
    });
    await CaveExhibit.update({ heat_count: 0 }, { where: { player_id: { [Op.in]: ids } } });
}

/** 寻宝的配额/冷却都读 treasure_hunt 配置，并发腿要在内存里抬高它们（不动仓库文件） */
async function withTreasureHuntOverride(patch, fn) {
    const orig = CaveSocialService.getTreasureHuntConfig.bind(CaveSocialService);
    CaveSocialService.getTreasureHuntConfig = () => ({ ...(orig() || {}), ...patch });
    try { return await fn(); } finally { CaveSocialService.getTreasureHuntConfig = orig; }
}

/**
 * 把 Math.random 钉成 0：寻宝的 `Math.random() < successRate` 必成立、`_weightedSelect` 必落在第一个
 * 选项（treasure），于是"锁第二行 players"这件事从概率变成必然（借取率取下限 5%），并发腿的死锁计数才读得懂。
 * 只在探针窗口里生效，finally 必须还原（调度器也在这个进程里跑）。
 */
async function withZeroRandom(fn) {
    const orig = Math.random;
    Math.random = () => 0;
    try { return await fn(); } finally { Math.random = orig; }
}

async function main() {
    await bootApp(app, { port: PORT });
    InventoryService.initialize(infrastructure.ConfigLoader);
    CaveSocialService.initialize(infrastructure.ConfigLoader);

    const ids = [];
    for (const n of NAMES) ids.push((await seed(n)).id);
    const [A, B] = ids;
    const myExhibits = await CaveExhibit.findAll({ where: { player_id: { [Op.in]: ids } }, attributes: ['id'] });
    await CaveExhibitAppreciation.destroy({
        where: {
            [Op.or]: [
                { appreciator_id: { [Op.in]: ids } },
                { exhibit_id: { [Op.in]: myExhibits.map(e => e.id) } }
            ]
        }, force: true
    });
    await CaveExhibit.destroy({ where: { player_id: { [Op.in]: ids } }, force: true });
    await Item.destroy({ where: { player_id: { [Op.in]: ids }, item_key: { [Op.in]: GOODS } }, force: true });
    await CaveTreasureLog.destroy({
        where: { [Op.or]: [{ hunter_id: { [Op.in]: ids } }, { cave_owner_id: { [Op.in]: ids } }] }, force: true
    });
    for (const id of ids) for (const key of GOODS) await InventoryService.addItem(id, key, 1, null);

    // ===== S0 双方各上架四件展品（上架要从背包真实扣一件） =====
    const exA = {}, exB = {};
    for (const key of GOODS) {
        exA[key] = (await CaveSocialService.listExhibit(A, key)).exhibit.id;
        exB[key] = (await CaveSocialService.listExhibit(B, key)).exhibit.id;
    }
    const bagEmpty = (await Item.count({ where: { player_id: { [Op.in]: ids }, item_key: { [Op.in]: GOODS } } })) === 0;
    check('S0 双方各上架 4 件展品（背包扣干、展品行都在）（否则后面全是空跑）',
        bagEmpty && (await CaveExhibit.count({ where: { player_id: { [Op.in]: ids } } })) === 8,
        `背包剩余 ${await Item.count({ where: { player_id: { [Op.in]: ids }, item_key: { [Op.in]: GOODS } } })} 展品 ${await CaveExhibit.count({ where: { player_id: { [Op.in]: ids } } })}/8`);
    if (!bagEmpty) return;

    // ===== S1 鉴赏一次：鉴赏者得修为、主人得声望、热度 +1 =====
    const expBefore = await exp(A), honorBefore = await honor(B);
    const r1 = await CaveSocialService.appreciateExhibit(A, exB[GOODS[0]]);
    const gain = await exp(A) - expBefore;
    const okExp = expectedExp('rare').includes(gain);
    check('S1 鉴赏一次：修为按品质算（基础 110 或顿悟 330）且**回执等于库里真加的量**、主人声望 +1、热度 +1',
        okExp && Number(r1.exp_gained) === Number(gain) && (await honor(B) - honorBefore) === 1n
        && await heat(exB[GOODS[0]]) === 1,
        `回执 ${r1.exp_gained} 实得 +${gain} 声望 +${await honor(B) - honorBefore} 热度=${await heat(exB[GOODS[0]])} 顿悟=${r1 && r1.is_enlightened}`);

    // ===== S2 / S3 两条前置校验：同一展品当天只能一次、不能鉴赏自己的 =====
    const replay = await safe(() => CaveSocialService.appreciateExhibit(A, exB[GOODS[0]]));
    const afterReplay = { exp: await exp(A), heat: await heat(exB[GOODS[0]]), rows: await appCount(A) };
    check('S2 重复鉴赏同一展品必须被拒且不再发第二笔（修为/热度/记录都不许多）',
        !replay.ok && /已鉴赏|明日再来/.test(replay.why) && afterReplay.exp === expBefore + gain
        && afterReplay.heat === 1 && afterReplay.rows === 1,
        `原因=${replay.why || '（没拒）'} 修为 ${afterReplay.exp - expBefore}(应 ${gain}) 热度=${afterReplay.heat} 记录=${afterReplay.rows}`);
    const own = await safe(() => CaveSocialService.appreciateExhibit(A, exA[GOODS[0]]));
    check('S3 鉴赏自己洞府的展品必须被拒',
        !own.ok && /自己/.test(own.why),
        `原因=${own.why || '（没拒）'}`);

    // ===== S4 每日上限（配置原值 daily_limit=3）：第四笔必须被挡 =====
    const e2 = await safe(() => CaveSocialService.appreciateExhibit(A, exB[GOODS[1]]));
    const e3 = await safe(() => CaveSocialService.appreciateExhibit(A, exB[GOODS[2]]));
    const e4 = await safe(() => CaveSocialService.appreciateExhibit(A, exB[GOODS[3]]));
    check('S4 今日鉴赏次数上限（daily_limit=3）在顺序点击下真的生效，第四笔说得清原因',
        e2.ok && e3.ok && !e4.ok && /上限/.test(e4.why) && await appCount(A) === 3,
        `第2笔=${e2.ok ? '成' : e2.why} 第3笔=${e3.ok ? '成' : e3.why} 第4笔=${e4.ok ? '（没挡）' : e4.why} 记录=${await appCount(A)}`);

    // ===== S5 并发下的每日上限：同一人同时点两场，上限不该被双击绕过 =====
    await resetAppreciations(ids);
    await Player.update({ exp: 1000 }, { where: { id: A } });
    const expS5 = await exp(A);
    const concurrent = await withAppreciateOverride({ daily_limit: 1 }, async () => Promise.all([
        safe(() => CaveSocialService.appreciateExhibit(A, exB[GOODS[0]])),
        safe(() => CaveSocialService.appreciateExhibit(A, exB[GOODS[1]]))
    ]));
    const succeeded = concurrent.filter(c => c.ok).length;
    const heatSum = await heat(exB[GOODS[0]]) + await heat(exB[GOODS[1]]);
    check('S5 同一个人同时点两件展品：daily_limit=1 必须只放行一笔（上限是按人算的，锁着他自己的行再数）',
        succeeded === 1 && await appCount(A) === 1 && heatSum === 1,
        `放行 ${succeeded}/2 笔 记录=${await appCount(A)} 热度合计=${heatSum}（改前两笔都过：上限被双击绕过）`);
    check('S5b 只放行一笔时修为也只加一笔的量',
        await exp(A) - expS5 >= 110n && await exp(A) - expS5 <= 330n,
        `修为 +${await exp(A) - expS5}（应只有一笔：110 或 330）`);

    // ===== S6 并发腿：两人互相鉴赏对方的展品（appreciateExhibit：鉴赏者 → 主人） =====
    // 与切磋那条不同：**这里 4 轮每一轮都是真并发**（每轮鉴赏的是不同的展品对，当天没有"已鉴赏过"的重复，
    // 每日上限只在内存里临时抬高），所以死锁计数才是可以直接读的数字。
    await resetAppreciations(ids);
    const exB2 = GOODS.map(k => exB[k]), exA2 = GOODS.map(k => exA[k]);
    let dead1 = 0, dead2 = 0, rounds = 0, bothOk = 0;
    await withAppreciateOverride({ daily_limit: 20 }, async () => {
        for (let i = 0; i < 4; i++) {
            const [r1c, r2c] = await Promise.all([
                safe(() => CaveSocialService.appreciateExhibit(A, exB2[i])),   // 锁 A → B
                safe(() => CaveSocialService.appreciateExhibit(B, exA2[i]))    // 锁 B → A
            ]);
            rounds++;
            if (!r1c.ok && isDeadlock(r1c.why)) dead1++;
            if (!r2c.ok && isDeadlock(r2c.why)) dead2++;
            if (r1c.ok && r2c.ok) bothOk++;
        }
    });
    check('S6 两人互相鉴赏 4 轮：一次死锁都不该有（改前这里是"我先锁还是你先锁"相撞）',
        dead1 + dead2 === 0,
        `实况=${rounds} 轮里 A 腿 ${dead1} 次、B 腿 ${dead2} 次死锁；不是探针坏，是没改锁次序`);

    // ===== S7 热度必须等于成功笔数：读-改-写覆盖（旧快照盖新快照）在这条上必露 =====
    const pairs = await CaveExhibit.findAll({ where: { player_id: { [Op.in]: ids } } });
    const mismatch = [];
    for (const e of pairs) {
        const rows = await CaveExhibitAppreciation.count({ where: { exhibit_id: e.id } });
        if (Number(e.heat_count || 0) !== rows) mismatch.push(`展品 ${e.id} 热度 ${e.heat_count} 但记录 ${rows}`);
    }
    check('S7 每件展品的 heat_count 与它成功的鉴赏笔数一一对上（并发跑完之后）',
        mismatch.length === 0 && bothOk >= 1,
        `对不上：${mismatch.join('；') || '无'}｜4 轮里双方都成功的轮数=${bothOk}（全被死锁打掉的话这条等于没测）`);

    // ===================== 洞天寻宝（treasureHunt）：同一服务里的第二条通路 =====================
    const stonesOf = async id => N((await Player.findByPk(id, { attributes: ['spirit_stones'] })).spirit_stones);
    const boxStones = async () => (await Player.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['spirit_stones'] }))
        .reduce((s, p) => s + N(p.spirit_stones), 0n);

    // ===== T0 双方开府（寻宝要求对方 is_opened） =====
    await CaveService.openCave(A).catch(() => {});
    await CaveService.openCave(B).catch(() => {});
    const opened = await PlayerCave.count({ where: { player_id: { [Op.in]: ids }, is_opened: true } });
    check('T0 两个探针号都开得了洞府（开不了的话寻宝那几条全是空跑）', opened === 2, `已开府 ${opened}/2`);
    if (opened !== 2) return;
    const boxT0 = await boxStones();
    const logT0 = await CaveTreasureLog.count({ where: { hunter_id: { [Op.in]: ids } } });

    // ===== T1 一次寻宝：手续费离开格子，借取量在两人之间原样搬运 =====
    const aBefore = await stonesOf(A), bBefore = await stonesOf(B);
    const t1 = await withZeroRandom(() => CaveSocialService.treasureHunt(A, B, 1));
    const steal = bBefore * 50n / 1000n;      // treasure.spirit_stone_steal_rate 下限 5%（random 钉成 0）
    check('T1 寻得宝物：手续费 100 离开格子、借取量在两人之间原样搬运（回执等于库里真动的量）',
        t1.result_type === 'treasure' && Number(t1.rewards.spirit_stones) === Number(steal)
        && await stonesOf(B) === bBefore - steal && await stonesOf(A) === aBefore + steal - 100n
        && await boxStones() === boxT0 - 100n,
        `结果=${t1.result_type} 回执=${t1.rewards && t1.rewards.spirit_stones} 实借=${bBefore - await stonesOf(B)} B=${await stonesOf(B)} A=${await stonesOf(A)} 格 ${boxT0}→${await boxStones()}`);

    // ===== T2 同一人同时点两次同一个洞府：每日上限 + 24h 冷却都不该被并发绕过 =====
    // 先把 T1 那笔日志清掉：否则"上限/冷却"会先被上一笔 legitimate 的记录挡掉，量的就不是并发而是顺序了
    await CaveTreasureLog.destroy({ where: { hunter_id: { [Op.in]: ids } }, force: true });
    const bBefore2 = await stonesOf(B);
    const logsBefore2 = await CaveTreasureLog.count({ where: { hunter_id: A } });
    const pair = await withTreasureHuntOverride({ daily_limit: 1 }, async () => Promise.all([
        withZeroRandom(() => safe(() => CaveSocialService.treasureHunt(A, B, 2))),
        withZeroRandom(() => safe(() => CaveSocialService.treasureHunt(A, B, 3)))
    ]));
    const passed = pair.filter(p => p.ok).length;
    check('T2 同一个人同时点同一个洞府两次：daily_limit=1 与冷却只该放行一笔（校验必须排在锁住寻宝者之后）',
        passed === 1 && await CaveTreasureLog.count({ where: { hunter_id: A } }) === logsBefore2 + 1
        && await stonesOf(B) === bBefore2 - bBefore2 * 50n / 1000n,
        `放行 ${passed}/2 笔 日志 +${await CaveTreasureLog.count({ where: { hunter_id: A } }) - logsBefore2} 主人被借 ${bBefore2 - await stonesOf(B)}（应等于一笔 ${bBefore2 * 50n / 1000n}＝主人当前余额的 5%）｜理由：${pair.map(p => p.ok ? '成' : p.why).join(' / ')}`);
    check('T2b 被拒的那一笔不能收手续费', await boxStones() === boxT0 - 200n,
        `格 ${boxT0}→${await boxStones()}（两笔成功的寻宝各交 100）`);

    // ===== T3 并发腿：两人同时互闯对方洞府（treasureHunt：寻宝者 → 洞府主人） =====
    let deadT = 0, roundsT = 0, bothT = 0, whyT = '';
    await withTreasureHuntOverride({ daily_limit: 50 }, async () => {
        for (let i = 0; i < 6; i++) {
            // 每轮开头清日志：cooldown_seconds 传 0 会被服务里的 `|| 86400` 吃掉（0 是 falsy），
            // 所以清日志才是真把冷却挪开 —— 抬高配置不等于关掉冷却。
            await CaveTreasureLog.destroy({ where: { hunter_id: { [Op.in]: ids } }, force: true });
            const [r1, r2] = await Promise.all([
                withZeroRandom(() => safe(() => CaveSocialService.treasureHunt(A, B, 1))),
                withZeroRandom(() => safe(() => CaveSocialService.treasureHunt(B, A, 1)))
            ]);
            roundsT++;
            if (!r1.ok && isDeadlock(r1.why)) deadT++;
            if (!r2.ok && isDeadlock(r2.why)) deadT++;
            if (!r1.ok) whyT = `A→B:${r1.why}`;
            if (!r2.ok) whyT = `${whyT} B→A:${r2.why}`;
            if (r1.ok && r2.ok) bothT++;
        }
    });
    check('T3 两人同时互闯对方洞府 6 轮：一次死锁都不该有（改前 hunter→owner 与 owner→hunter 相撞）',
        deadT === 0 && bothT === roundsT,
        `实况=${roundsT} 轮里 ${deadT} 次 Deadlock、双方都成交 ${bothT} 轮（每轮都被强制走 treasure 分支＝两边真的都要第二行锁）｜被拒理由：${whyT || '无'}`);

    // ===== T4 全部跑完：格子里少掉的灵石必须正好等于成功笔数 × 手续费 =====
    // 笔数不能拿日志表当计数：T3 每轮开头会清日志（绕开 24h 冷却），清掉的笔就不在表里了
    const logsAll = await CaveTreasureLog.count({ where: { hunter_id: { [Op.in]: ids } } });
    const success = 1 + passed + bothT * 2;
    check('T4 账本收口：格子只因为手续费变小，借取全是两人之间的搬运（多扣/漏退/重复借都会在这里露）',
        await boxStones() === boxT0 - 100n * BigInt(success),
        `成功 ${success} 笔（T1 一笔 + T2 放行 ${passed} 笔 + T3 ${bothT} 轮各 2 笔；日志表现存 ${logsAll - logT0} 条，清过的不算）× 100 手续费｜格 ${boxT0}→${await boxStones()}`);
}

(async () => {
    let hard = 0;
    try {
        await main();
    } catch (e) {
        console.error('探针异常：', e && e.stack ? e.stack : e);
        hard++;
    } finally {
        const fails = results.filter(r => !r.ok).length + hard;
        try {
            const ps = await Player.findAll({ where: { username: { [Op.in]: NAMES } } });
            const ids = ps.map(p => p.id);
            if (ids.length) {
                const mine = await CaveExhibit.findAll({ where: { player_id: { [Op.in]: ids } }, attributes: ['id'] });
                await CaveExhibitAppreciation.destroy({
                    where: {
                        [Op.or]: [
                            { appreciator_id: { [Op.in]: ids } },
                            { exhibit_id: { [Op.in]: mine.map(e => e.id) } }
                        ]
                    }, force: true
                });
                await CaveExhibit.destroy({ where: { player_id: { [Op.in]: ids } }, force: true });
                await CaveTreasureLog.destroy({
                    where: { [Op.or]: [{ hunter_id: { [Op.in]: ids } }, { cave_owner_id: { [Op.in]: ids } }] }, force: true
                });
                await PlayerCave.destroy({ where: { player_id: { [Op.in]: ids } }, force: true });
                await Item.destroy({ where: { player_id: { [Op.in]: ids }, item_key: { [Op.in]: GOODS } }, force: true });
                await Player.destroy({ where: { id: { [Op.in]: ids } }, force: true });
            }
            console.log(`清理：探针号 ${NAMES.join('/')} 与它们的展品/鉴赏记录/背包行已删（残留 ${
                (await Player.count({ where: { username: { [Op.in]: NAMES } } }))} 个账号）`);
        } catch (ce) {
            console.warn('清理失败：', ce.message);
        }
        const pass = results.filter(r => r.ok).length;
        console.log(`\n展品鉴赏探针：${pass}/${results.length} 通过${hard ? '，另有 1 处探针异常' : ''}`);
        await sequelize.close();
        process.exit(fails ? 1 : 0);
    }
})();
