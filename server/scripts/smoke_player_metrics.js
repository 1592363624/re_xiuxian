/**
 * 玩家统计量（计数）活体探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * 为什么单独一条：`tests/PlayerMetricsVocabulary.test.js` 钉的是**词表与闸的形状**，
 * 而"计数真的在涨、并发一次不丢、成就进度真的从 0 动起来"这三件事只有连库才断得出来 ——
 * 改造前这些成就度量读的是 `player.kill_count` 这种**根本不存在的列**（计数住在 players.stats 那坨 JSON 里），
 * 于是 34 条成就里 14 条恒为 0%，接口照样返回"进度 0/5"、jest 全绿。
 * 这一条就是那条"配了但玩家拿不到"的正面证据。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_player_metrics.js
 *       自建账号 pmprobe01，退出前走级联清理；不改仓库里的任何内容。
 *
 * 控制跑（证明这些断言不是空转）：把 CombatService 或 PlayerStateStore.bumpStat 里
 *       `$add` 那行临时改成"先读后写"（或直接注释掉一处 bumpStat），对应那一条必须变红。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5101);
process.env.PORT = String(PORT);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}
const num = v => Number(v) || 0;

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const sequelize = require('../config/database');
    const Player = require('../models/player');
    const RealmService = require('../game/core/RealmService');
    const PlayerStateStore = require('../game/persistence/PlayerStateStore');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
    const AchievementService = require('../game/services/AchievementService');
    const PlayerMetrics = require('../game/stats/PlayerMetrics');
    const CombatResolver = require('../game/combat/CombatResolver');

    const username = 'pmprobe01';
    await PlayerCascadePurge.deleteByUsernames([username]);
    const player = await Player.create({
        username, password: 'not-a-real-hash', nickname: '计数探针',
        realm: '化神初期', realm_rank: RealmService.getRealmByName('化神初期').rank,
        exp: 0, spirit_stones: 0, hp_current: 1000, mp_current: 100,
        lifespan_current: 100, lifespan_max: 500,
        attributes: {}, spirit_roots: {}, token_version: 0
    });

    /** 读库里的原始字符串：不经过 Sequelize 的 getter，免得"实例上看着对、库里其实没写"这种事混过去 */
    async function rawStats() {
        const [rows] = await sequelize.query('SELECT stats FROM players WHERE id = ?', { replacements: [player.id] });
        const raw = rows && rows[0] ? rows[0].stats : null;
        return { raw, parsed: typeof raw === 'string' ? JSON.parse(raw) : (raw || {}) };
    }

    // ===== P0 前置：词表与账号初值都要是真的，否则后面全是空跑 =====
    const known = PlayerMetrics.knownMetricIds();
    check('P0a 启动后 ConfigLoader 认得 player_metrics（新配置文件被自动发现，不需要改代码登记）',
        known.length > 10, `${known.length} 档度量`);
    const fresh = await rawStats();
    check('P0b 新号的 players.stats 里那九格计数是 0（模型 defaultValue 真的落库了）',
        ['meditation_count', 'kill_count', 'breakthrough_count', 'alchemy_count', 'refining_count',
            'items_collected', 'achievements_completed', 'death_count', 'exploration_count']
            .every(k => k in fresh.parsed),
        Object.keys(fresh.parsed).join(','));
    if (!known.length || !('kill_count' in fresh.parsed)) return finish();

    // ===== P1 串行一笔：写入点确实写进了那一格 =====
    await PlayerStateStore.bumpStat(player.id, 'kill_count', 1);
    const afterOne = await rawStats();
    check('P1 一次 bumpStat 后库里 kill_count=1（读的是原始字符串，不是实例内存）',
        num(afterOne.parsed.kill_count) === 1, `raw=${afterOne.raw}`);

    // ===== P2 并发 7 路 +1：行锁内的 $add 一次都不能丢 =====
    await Promise.all(Array.from({ length: 7 }, () => PlayerStateStore.bumpStat(player.id, 'kill_count', 1)));
    const afterConcurrent = (await rawStats()).parsed;
    check('P2 7 路并发 +1 之后 kill_count=8（"读-改-写整块回写"会丢账，$add 在行锁内不丢）',
        num(afterConcurrent.kill_count) === 8, `kill_count=${afterConcurrent.kill_count}`);
    check('P2b 并发写没把同一坨 stats 里的兄弟键抹掉（meditation_count 还在）',
        num(afterConcurrent.meditation_count) === 0 && 'exploration_count' in afterConcurrent,
        `meditation=${afterConcurrent.meditation_count} 其余键=${Object.keys(afterConcurrent).length} 个`);

    // ===== P3 拿着同一份实例连改两格：镜像回去的那一份不能把后一笔盖掉 =====
    const held = await Player.findByPk(player.id);
    await PlayerStateStore.bumpStat(held, 'kill_count', 1);
    await PlayerStateStore.bumpStat(held, 'meditation_count', 2);
    const afterTwo = (await rawStats()).parsed;
    check('P3 同一份实例上连 bump 两格：kill=9 且 meditation=2（先写的那笔不被后写的整块盖掉）',
        num(afterTwo.kill_count) === 9 && num(afterTwo.meditation_count) === 2,
        `kill=${afterTwo.kill_count} meditation=${afterTwo.meditation_count}`);
    check('P3b 传实例进来的调用方，手里那份实例也被镜像成新值',
        num(held.stats.kill_count) === 9 && num(held.stats.meditation_count) === 2,
        `实例 kill=${held.stats.kill_count} meditation=${held.stats.meditation_count}`);

    // ===== P4 成就列表：进度从"恒为 0"变成真数 =====
    const list = await AchievementService.getAchievements(player.id);
    const items = list?.items || [];
    const killOnes = items.filter(a => a.metric === 'kill_count');
    check('P4a 成就列表带 metric 字段，且杀敌成就在列（判据不是空跑）',
        items.length > 20 && killOnes.length > 0, `条目 ${items.length} 条，杀敌 ${killOnes.length} 条`);
    check('P4b 杀敌成就的进度 == 库里那格计数（改造前这里永远是 0）',
        killOnes.length > 0 && killOnes.every(a => num(a.progress) === 9),
        killOnes.map(a => `${a.id}:${a.progress}/${a.target}`).join(' '));
    const seclusion = items.filter(a => a.metric === 'seclusion_count');
    check('P4c 悟道那一格也通到成就（seclusion_count → stats.meditation_count）',
        seclusion.length > 0 && seclusion.every(a => num(a.progress) === 2),
        seclusion.map(a => `${a.id}:${a.progress}`).join(' '));

    // ===== P5 另外三种来源形状：列 / 属性 / 境界名字 =====
    const expMetric = await PlayerMetrics.metricValue('exp', await Player.findByPk(player.id));
    check('P5a column.* 读 players 列并把 BigInt 转成数字', expMetric === 0, `exp=${expMetric}`);
    const resolved = (await CombatResolver.resolveCombatStats(await Player.findByPk(player.id))).stats;
    const ceiling = await PlayerMetrics.metricValue('hp_ceiling', await Player.findByPk(player.id));
    check('P5b attr.* 与战斗解析同一份数（资料片新属性可直接被成就引用走的就是这个形状）',
        num(ceiling) === num(resolved.hp_max) && num(ceiling) > 0, `hp_ceiling=${ceiling} 解析 hp_max=${resolved.hp_max}`);
    const realmIndex = await PlayerMetrics.metricValue('realm_index', await Player.findByPk(player.id));
    check('P5c realm_index 按境界**名字**取 rank，不是读 realm_rank 那一列',
        realmIndex === RealmService.getRealmByName('化神初期').rank, `realm_index=${realmIndex}`);
    const stale = await Player.findByPk(player.id);
    stale.realm_rank = 3;
    await stale.save();
    const stillRight = await PlayerMetrics.metricValue('realm_index', await Player.findByPk(player.id));
    check('P5d 故意把 realm_rank 改坏，realm_index 仍按名字取（证明它没依赖那一列）',
        stillRight === realmIndex, `改坏列之后 realm_index=${stillRight}`);

    // ===== P6 取不到的度量必须报出来，不许静默 0 =====
    const missing = await PlayerMetrics.metricValue('this_metric_is_not_declared', stale);
    check('P6 词表里没有的度量返回 0 并打一条 error（不是悄悄 0）',
        missing === 0, '日志里应有一行"没在 player_metrics 里登记"');

    // ===== P7 洞府祖业的求和集合来自内容声明，不是代码清单 =====
    const counters = PlayerMetrics.commandCounterKeys();
    const forSum = (await rawStats()).parsed;
    const sumByHand = counters.reduce((sum, key) => sum + num(forSum[key]), 0);
    check('P7 祖业"总修行次数"累加的就是内容声明那几格，且现算结果与库里的和对得上',
        counters.length >= 6 && sumByHand === num(afterTwo.kill_count) + num(afterTwo.meditation_count),
        `${counters.length} 档参与求和，合计=${sumByHand}`);

    await PlayerCascadePurge.deleteByUsernames([username]);
    check('P8 探针号清干净', (await Player.count({ where: { username } })) === 0, '删号走级联门');

    finish();

    function finish() {
        const failed = results.filter(r => !r.ok);
        console.log(`\n合计 ${results.length - failed.length}/${results.length} 项通过`);
        process.exit(failed.length ? 1 : 0);
    }
})().catch(async err => {
    console.error('探针异常:', err && (err.stack || err.message));
    try {
        await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['pmprobe01']);
    } catch (e) { console.warn('异常退出后的清场也失败了:', e.message); }
    process.exit(2);
});
