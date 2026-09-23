/**
 * 每日计数（切磋 / 决斗）活体探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * 为什么要这一条：`sparring_count` 与 `duel_count` 是"每日计数"这一族 —— 新值不是"加一笔"，
 * 而是"换日则从 1 重新开始，否则当日 +1"，还要连带写 `last_sparring_date` / `duel_last_time` 这些同日标记。
 * 2026-09-22 之前这两处是"读整份 players.stats → 改两格 → 把整份赋回这一列"，现在改走
 * `PlayerStateStore.setStatKeys` 的**键级**补丁。静态那两条闸（ContentRegistry 的 writer 扫描 +
 * tests/PlayerMetricsVocabulary 的禁整值回写）只能证明"形状换了"，换日清零仍然成立、
 * 上限校验仍然排在锁住该玩家之后、以及"我只该动这几格、别把同坨 JSON 里其它键带走旧值"
 * 这三件事都必须连库才断得出来。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_daily_counters.js
 *       自建账号 dc_a / dc_b，退出前删净对局行并走级联清理；不改仓库里的任何配置。
 *
 * 控制跑（证明这些断言不是空转）：
 *   ① 把 PvpService 那一笔换回旧的整块赋回（`const s={...player.stats}; s.sparring_count=…; player.stats=s;`）
 *      并在 setStatKeys 之前先 `patchPlayerState(id,{stats:{probe_key:7}})` —— S2 会红（探针注入的那格被整块写带走）；
 *   ② 把 `_resetDailyDuelCountIfNewDay` / 切磋的换日判断注释掉 → S3/D2（换日必须从 1 重新开始）当场红；
 *   ③ 把每日上限的校验挪到锁住玩家之前（或对 stats 用请求开始时的旧实例）→ S4/D3 红：
 *      两条并发会双双通过校验、计数超发。这条就是"按玩家计数的上限校验必须排在锁之后"那句口径的活证据。
 * 配置一律在内存里 monkeypatch（cooldown 归零、daily_limit 调小），仓库 json 一个字都不改。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5158);
process.env.PORT = String(PORT);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}
const num = v => Number(v) || 0;
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const sequelize = require('../config/database');
    const Player = require('../models/player');
    const PvpBattleRecord = require('../models/pvpBattleRecord');
    const { Op } = require('sequelize');
    const PlayerStateStore = require('../game/persistence/PlayerStateStore');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
    const PvpService = require('../game/services/PvpService');
    const DuelService = require('../game/services/DuelService');

    const NAMES = ['dc_a', 'dc_b'];

    // ---- 内存里改配置：冷却归零、每日上限可调（不动仓库 json） ----
    const loader = infrastructure.ConfigLoader;
    const originalGetConfig = loader.getConfig.bind(loader);
    let overrides = { duelLimit: 3, sparLimit: 20 };
    loader.getConfig = (name) => {
        const cfg = originalGetConfig(name);
        if (name !== 'game_balance' || !cfg || !cfg.pvp_extended) return cfg;
        const clone = { ...cfg, pvp_extended: { ...cfg.pvp_extended } };
        clone.pvp_extended.duel = { ...(cfg.pvp_extended.duel || {}), cooldown_seconds: 0, daily_duel_limit: overrides.duelLimit };
        clone.pvp_extended.sparring = { ...(cfg.pvp_extended.sparring || {}), cooldown_seconds: 0, daily_limit: overrides.sparLimit };
        return clone;
    };

    async function seed(username) {
        return await Player.create({
            username, password: 'not-a-real-hash', nickname: '每日计数探针',
            realm: '筑基初期', realm_rank: 6, exp: 0, spirit_stones: 300000,
            hp_current: 5000, mp_current: 1000, lifespan_current: 100, lifespan_max: 500,
            attack_power: 500, defense_power: 300, hp_max: 5000, mp_max: 1000, speed: 200,
            luck: 10, sense: 100, dao_heart: 50,
            soul_power_current: 100, soul_power_max: 100,
            invincible_until: '1970-01-01 00:00:00', rebirth_token: 1,
            weak_count: 0, hp_regen_timer: 0, mp_regen_timer: 0,
            inventory_capacity: 50, pvp_mode: 'active',
            titles: [], attributes: {}, amount: 0,
            spirit_stones_pinned: 0, spirit_stones_pinned_at: '1970-01-01 00:00:00',
            location_id: 1, current_floor: 1, highest_floor: 1
        });
    }
    await PlayerCascadePurge.deleteByUsernames(NAMES);
    const a = await seed(NAMES[0]);
    const b = await seed(NAMES[1]);
    const ids = [a.id, b.id];

    async function wipeBattles() {
        await PvpBattleRecord.destroy({
            where: { [Op.or]: [{ attacker_id: { [Op.in]: ids } }, { defender_id: { [Op.in]: ids } }] }, force: true
        });
    }
    /** 读库里的原始 stats（不经 getter，防"实例上看着对、其实没落库"） */
    async function rawStats(id) {
        const [rows] = await sequelize.query('SELECT stats FROM players WHERE id = ?', { replacements: [id] });
        const raw = rows && rows[0] ? rows[0].stats : '{}';
        return typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    }
    async function run(label, fn) {
        try { return { ok: true, result: await fn() }; }
        catch (e) { return { ok: false, code: e.errorCode || '', message: String(e.message || e) }; }
    }

    // ===== S1 切磋第一次：当日计数从 0 变 1，同日标记一起落 ----
    const first = await run('spar', () => PvpService.sparringWithDummy(a.id, 3));
    const s1 = await rawStats(a.id);
    check('S1 第一次切磋之后 sparring_count=1 且 last_sparring_date=今天（计数与标记同一笔写）',
        first.ok && num(s1.sparring_count) === 1 && s1.last_sparring_date === today(),
        first.ok ? `count=${s1.sparring_count} date=${s1.last_sparring_date}` : `被拒：${first.code} ${first.message}`);
    check('S1b 同日标记里那一串 ISO 时间也真写进去了（旧口径同一事务里带的三格，一格都没漏）',
        typeof s1.last_sparring_time === 'string' && s1.last_sparring_time.length > 10,
        `last_sparring_time=${s1.last_sparring_time}`);

    // ===== S2 键级写只动自己那几格（防我这次改动引入的新风险：整块覆盖） =====
    await PlayerStateStore.setStatKeys(a.id, { probe_sibling_key: 7 });
    await PlayerStateStore.bumpStat(a.id, 'meditation_count', 3);
    const second = await run('spar2', () => PvpService.sparringWithDummy(a.id, 3));
    const s2 = await rawStats(a.id);
    check('S2 同一天再切磋：计数 +1（不清零），且同坨 stats 里别的键一格都没被带走',
        second.ok && num(s2.sparring_count) === 2
        && num(s2.probe_sibling_key) === 7 && num(s2.meditation_count) === 3,
        `count=${s2.sparring_count} probe=${s2.probe_sibling_key} meditation=${s2.meditation_count}`);

    // ===== S3 换日必须从 1 重新开始（清零与累加是同一次原子写，不是"先写 0 再写 1"） =====
    await PlayerStateStore.setStatKeys(a.id, {
        sparring_count: 5, last_sparring_date: yesterday(), last_sparring_time: new Date(Date.now() - 86400000).toISOString()
    });
    const rolled = await run('spar3', () => PvpService.sparringWithDummy(a.id, 3));
    const s3 = await rawStats(a.id);
    check('S3 昨天的 5 次在今天第一笔之后变成 1（不是 6，也不是 0/半态）',
        rolled.ok && num(s3.sparring_count) === 1 && s3.last_sparring_date === today(),
        `count=${s3.sparring_count} date=${s3.last_sparring_date}（改前是昨天的 5）`);

    // ===== S4 上限校验排在锁之后：两条并发只允许过一条 =====
    overrides.sparLimit = 1;
    await PlayerStateStore.setStatKeys(a.id, { sparring_count: 0, last_sparring_date: today() });
    const legs = await Promise.all([
        run('c1', () => PvpService.sparringWithDummy(a.id, 3)),
        run('c2', () => PvpService.sparringWithDummy(a.id, 3))
    ]);
    const passed = legs.filter(l => l.ok).length;
    const rejected = legs.find(l => !l.ok);
    const s4 = await rawStats(a.id);
    check('S4 每日上限=1 时两条并发切磋只成一条（超发就等于绕过配额）',
        passed === 1 && !!rejected,
        `成 ${passed} 败 ${2 - passed}，被拒理由=${rejected ? `${rejected.code} ${rejected.message}` : '无'}`);
    check('S4b 计数最终就是 1（既不是 0 也不是 2：清零/累加/校验三者看到的是同一份锁内值）',
        num(s4.sparring_count) === 1, `sparring_count=${s4.sparring_count}`);
    overrides.sparLimit = 20;

    // ===== D1 决斗：计数与双方赌注在同一笔事务里 =====
    const stonesBefore = [num((await Player.findByPk(a.id)).spirit_stones), num((await Player.findByPk(b.id)).spirit_stones)];
    const challenged = await run('duel', () => DuelService.challenge(a.id, b.id, 50));
    const d1 = await rawStats(a.id);
    check('D1 发起决斗之后 duel_count=1、duel_last_date=今天',
        challenged.ok && num(d1.duel_count) === 1 && d1.duel_last_date === today(),
        challenged.ok ? `count=${d1.duel_count} date=${d1.duel_last_date}` : `被拒：${challenged.code} ${challenged.message}`);
    const stonesAfter = [num((await Player.findByPk(a.id)).spirit_stones), num((await Player.findByPk(b.id)).spirit_stones)];
    check('D1b 计数那一笔没把同事务里扣的赌注盖掉（双方各冻结 50 灵石，键级写只动 stats 那几格）',
        stonesBefore[0] - stonesAfter[0] === 50 && stonesBefore[1] - stonesAfter[1] === 50,
        `甲 ${stonesBefore[0]}→${stonesAfter[0]}，乙 ${stonesBefore[1]}→${stonesAfter[1]}`);

    // ===== D2 决斗换日清零 =====
    await wipeBattles();
    await PlayerStateStore.setStatKeys(a.id, { duel_count: 2, duel_last_date: yesterday(), duel_last_time: new Date(Date.now() - 86400000).toISOString() });
    const rolled2 = await run('duel2', () => DuelService.challenge(a.id, b.id, 50));
    const d2 = await rawStats(a.id);
    check('D2 昨天的 2 次在今天第一笔之后变成 1（清零与累加同一次写）',
        rolled2.ok && num(d2.duel_count) === 1 && d2.duel_last_date === today(),
        rolled2.ok ? `count=${d2.duel_count}` : `被拒：${rolled2.message}`);

    // ===== D3 决斗上限排在锁后 =====
    await wipeBattles();
    overrides.duelLimit = 1;
    await PlayerStateStore.setStatKeys(a.id, { duel_count: 1, duel_last_date: today(), duel_last_time: '2020-01-01T00:00:00.000Z' });
    const over = await run('duel3', () => DuelService.challenge(a.id, b.id, 50));
    const d3 = await rawStats(a.id);
    check('D3 已到当日上限时再发起被拒，且计数不再涨（校验读的是锁内那份新值，不是请求开始时的旧快照）',
        !over.ok && /上限/.test(over.message) && num(d3.duel_count) === 1,
        over.ok ? '竟然又发起成功了' : `${over.code} ${over.message}｜count=${d3.duel_count}`);
    overrides.duelLimit = 3;

    // ===== D4 两条并发决斗：只成一条 =====
    await wipeBattles();
    await PlayerStateStore.setStatKeys(a.id, { duel_count: 0, duel_last_date: today(), duel_last_time: '2020-01-01T00:00:00.000Z' });
    const dl = await Promise.all([
        run('d1', () => DuelService.challenge(a.id, b.id, 50)),
        run('d2', () => DuelService.challenge(a.id, b.id, 50))
    ]);
    const dPassed = dl.filter(l => l.ok).length;
    const dRejected = dl.find(l => !l.ok);
    check('D4 同一玩家两条并发发起决斗只成一条（另一条被"进行中/上限/冷却"里哪一条挡住要打印出来）',
        dPassed === 1,
        `成 ${dPassed} 败 ${2 - dPassed}，被拒理由=${dRejected ? `${dRejected.code} ${dRejected.message}` : '无'}`);
    check('D4b 决斗计数最终是 1（超发或互相盖掉都判红）',
        num((await rawStats(a.id)).duel_count) === 1, `duel_count=${(await rawStats(a.id)).duel_count}`);

    // ===== Z 清场 =====
    loader.getConfig = originalGetConfig;
    await wipeBattles();
    await PlayerCascadePurge.deleteByUsernames(NAMES);
    check('Z1 探针号与对局行清干净',
        (await Player.count({ where: { username: NAMES } })) === 0
        && (await PvpBattleRecord.count({ where: { [Op.or]: [{ attacker_id: { [Op.in]: ids } }, { defender_id: { [Op.in]: ids } }] } })) === 0,
        '对局行不在级联清理的"归属"档里，探针自己删');

    finish();

    function finish() {
        const failed = results.filter(r => !r.ok);
        console.log(`\n合计 ${results.length - failed.length}/${results.length} 项通过`);
        process.exit(failed.length ? 1 : 0);
    }
})().catch(async err => {
    console.error('探针异常:', err && (err.stack || err.message));
    try {
        const { Op } = require('sequelize');
        const PvpBattleRecord = require('../models/pvpBattleRecord');
        const Player = require('../models/player');
        const ids = (await Player.findAll({ where: { username: ['dc_a', 'dc_b'] }, attributes: ['id'] })).map(p => p.id);
        if (ids.length) {
            await PvpBattleRecord.destroy({ where: { [Op.or]: [{ attacker_id: { [Op.in]: ids } }, { defender_id: { [Op.in]: ids } }] }, force: true });
        }
        await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['dc_a', 'dc_b']);
    } catch (e) { console.warn('异常退出后的清场也失败了:', e.message); }
    process.exit(2);
});
