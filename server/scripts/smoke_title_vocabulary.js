/**
 * 称号词表活体探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * 为什么单独一条：称号这张表今天同时改了三件事，而它们全都是**只在库里才看得出来**的：
 *   ① 副本/切磋的发放路径原来指着 **10 档 titles 里根本不存在的称号**（掩月破阵者、封魔塔主、伏魔者…）
 *      —— `addTitleToInstance` 不查词表，裸 id 照样写进 players.titles，而界面与属性引擎都按
 *      `titles.find(t => t.id === …)` 取名/取加成 → 玩家拿到的是一个查无此名的字符串；
 *   ② 33 档基础称号里 32 档**没有任何发放路径**（`condition` 那栏纯是给人看的文案，没代码读它），
 *      本轮把 15 档与既有成就按"数字对得上"挂到了一起（hermit↔枯坐千时、battle_master↔千夫所指…）；
 *   ③ 新挂上的这些档**带真数值**（sense 40 / cultivate_speed_pct 20 那种），所以"发出去了"还不够，
 *      得证明戴上之后属性引擎真的吃进去。
 * 静态那一道（ContentRegistry._validateTitleGrants + tests/TitleSourceCoverage）管的是引用与来源，
 * 这一条管的是"从库里读出来的那一份 titles 装配"与"属性引擎真的按 id 查表"。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_title_vocabulary.js
 *       自建账号 titlevocab01，退出前走级联清理；不改仓库里的任何内容。
 *
 * 控制跑（证明这些断言不是空转）：
 *   · 把 config/titles.json 里 yanyue_breaker 那一档整块删掉 → T1 立刻红（发放路径指着没有的档），
 *     并且此时服务**根本起不来**（启动闸先抛），这正是那道闸要的效果；
 *   · 把 providers.js 里 title 那一站的 `titles.find(...)` 换成 `titles[0]`（拿错档）→
 *     T3 的"sense 恰好等于 hermit 声明的 40"当场红；
 *   · 把成就 seclusion_1000 的 reward.title_id 去掉 → T2 红。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5103);
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
    const AttributeService = require('../game/core/AttributeService');
    const CombatResolver = require('../game/combat/CombatResolver');
    const { ContentRegistry } = require('../game/content/ContentRegistry');

    const username = 'titlevocab01';
    await PlayerCascadePurge.deleteByUsernames([username]);
    const player = await Player.create({
        username, password: 'not-a-real-hash', nickname: '称号词表探针',
        realm: '化神初期', realm_rank: RealmService.getRealmByName('化神初期').rank,
        exp: 0, spirit_stones: 0, hp_current: 1000, mp_current: 100,
        lifespan_current: 100, lifespan_max: 500,
        attributes: {}, spirit_roots: {}, titles: [], token_version: 0
    });

    const titles = infrastructure.ConfigLoader.getConfig('titles') || [];
    const byId = new Map(titles.map(t => [String(t.id), t]));
    async function rawTitles() {
        const [rows] = await sequelize.query('SELECT titles FROM players WHERE id = ?', { replacements: [player.id] });
        const raw = rows && rows[0] ? rows[0].titles : '[]';
        try { return JSON.parse(typeof raw === 'string' ? raw : '[]') || []; } catch { return []; }
    }
    async function claim(id) {
        try { return { ok: true, result: await AchievementService.claimReward(player.id, id) }; }
        catch (e) { return { ok: false, code: e.errorCode || '', message: String(e.message || e) }; }
    }

    // ===== T1 装配出来的这份 titles，认得所有发放路径指向的 id =====
    // 现网视图单独建一份 ContentRegistry：判的是"内容里真写了这些发放路径"，不依赖全局 ConfigLoader 的缓存
    const view = new ContentRegistry({
        configPath: require('path').join(__dirname, '..', 'config'),
        packDir: require('path').join(__dirname, '..', 'content', 'packs'),
        statRegistry: require('../game/stats').statRegistry
    });
    view.load();
    const grants = view.titleGrantIndex();
    const unresolved = [...grants.keys()].filter(id => !byId.has(id));
    check('T1 库里这份 titles 认得每一条发放路径指向的称号（副本/切磋/成就）',
        grants.size >= 29 && unresolved.length === 0,
        `${grants.size} 档被引用，查不到名字的：${unresolved.join(', ') || '无'}`);
    check('T1b 本轮补齐的那 10 档副本称号都有名字（以前是"裸 id 进库、界面查无此名"）',
        ['yanyue_breaker', 'kunwu_tower_master', 'xutian_conqueror', 'beiming_breaker',
            'luoyun_guardian', 'cangkun_explorer', 'blood_purgatory_survivor', 'demon_slayer',
            'huanglong_master', 'canglongjiang_zhenjiaozhe_title'].every(id => (byId.get(id) || {}).name),
        `掩月破阵者=${(byId.get('yanyue_breaker') || {}).name}`);

    // ===== T2 成就挂上的 15 档真的发得出去（挑一档带真数值的：hermit ← 枯坐千时） =====
    const cfg = infrastructure.ConfigLoader.getConfig('achievement_data') || {};
    const withTitles = (cfg.achievements || []).filter(a => a.reward?.title_id);
    check('T2a 成就表里有成就开始发称号了（本轮把 condition 数字对得上的 15 档挂上）',
        withTitles.length >= 15, `${withTitles.length} 条成就带 reward.title_id`);
    const seclusion1000 = withTitles.find(a => a.metric === 'seclusion_count' && num(a.target) === 1000);
    check('T2b 挂接按"条件数字与成就 target 完全一致"来配，不是照名字猜',
        !!seclusion1000 && seclusion1000.reward.title_id === 'hermit',
        seclusion1000 ? `${seclusion1000.id}(${seclusion1000.name}) → ${seclusion1000.reward.title_id}` : '没找到 1000 次打坐那条成就');
    if (seclusion1000) {
        // 成就上写的 metric 与真正累加的那一格**不是同一个名字**（seclusion_count → stats.meditation_count），
        // 所以这里必须照词表声明去 bump，不能拿成就的 metric 当 stats 键名（第一版就 bump 错了格子）
        const spec = PlayerMetrics.specOf(seclusion1000.metric) || {};
        const statKey = String(spec.from || '').startsWith('stats.') ? spec.from.slice('stats.'.length) : '';
        check('T2b2 这一档成就的度量确实指向某个 stats 计数（词表在中间做翻译）',
            !!statKey, `${seclusion1000.metric} → ${spec.from}（bump 的是 ${statKey}）`);
        await PlayerStateStore.bumpStat(player.id, statKey, num(seclusion1000.target));
        const got = await claim(seclusion1000.id);
        const landed = await rawTitles();
        check('T2c 领取之后 players.titles 里真的多出这一档（走的是 addTitleToInstance）',
            got.ok && landed.includes('hermit'),
            got.ok ? `titles=${JSON.stringify(landed)}，文案=${got.result.message}` : `被拒：${got.message}`);
    }

    // ===== T3 戴上它之后，属性引擎真的吃进这一档声明的加成 =====
    const declared = (byId.get('hermit') || {}).bonuses || {};
    check('T3a hermit 这一档确实带着数值（不是空壳，所以 T3 有东西可判）',
        num(declared.sense) > 0, JSON.stringify(declared));
    const bare = (await CombatResolver.resolveCombatStats(await Player.findByPk(player.id))).stats;
    await PlayerStateStore.patchPlayerState(player.id, { columns: { equipped_title_id: 'hermit' } });
    const wearer = await Player.findByPk(player.id);
    const withTitle = (await CombatResolver.resolveCombatStats(wearer)).stats;
    check('T3b 戴上之后 sense 恰好多出这一档声明的量（称号→属性引擎这一站真的按 id 查了表）',
        num(withTitle.sense) - num(bare.sense) === num(declared.sense),
        `sense ${bare.sense} → ${withTitle.sense}，声明 +${declared.sense}`);

    // ===== T4 补齐的副本档：名字查得到，且刻意零加成不被当成 bug =====
    await PlayerStateStore.patchPlayerState(player.id, { titles: [...(await rawTitles()), 'yanyue_breaker'] });
    const owned = await rawTitles();
    const resolvedNames = owned.map(id => (byId.get(id) || {}).name || null);
    const serviceTitles = AttributeService.getAllTitles();
    check('T4 玩家手里的每一档称号都能解析出中文名（owned_titles 里不再出现裸 id）',
        owned.includes('yanyue_breaker') && resolvedNames.every(Boolean)
        && serviceTitles.length === titles.length && serviceTitles.some(t => t.id === 'yanyue_breaker'),
        `${JSON.stringify(owned)} → ${JSON.stringify(resolvedNames)}，AttributeService 也给出 ${serviceTitles.length} 档`);
    const withDungeon = (await CombatResolver.resolveCombatStats(await Player.findByPk(player.id))).stats;
    check('T4b 副本档 bonuses 是刻意为空（荣誉档），所以戴上它属性一分不变 —— 要数值等业主签字',
        num(withDungeon.sense) === num(withTitle.sense),
        `sense ${withTitle.sense} → ${withDungeon.sense}`);

    // ===== T5 反证：词表里查不到的 id，运行期是静默无加成（这就是为什么只能靠启动闸拦） =====
    await PlayerStateStore.patchPlayerState(player.id, { titles: [...(await rawTitles()), 'probe_never_defined'] });
    await PlayerStateStore.patchPlayerState(player.id, { columns: { equipped_title_id: 'probe_never_defined' } });
    const ghost = (await CombatResolver.resolveCombatStats(await Player.findByPk(player.id))).stats;
    check('T5 指向不存在的称号时运行期**没有任何信号**（与"什么都没戴"完全一样，也不抛）→ 引用方向必须在启动期硬拦',
        num(ghost.sense) === num(bare.sense) && num(ghost.sense) !== num(withTitle.sense),
        `sense 不戴=${bare.sense}、戴真档=${withTitle.sense}、戴不存在的档=${ghost.sense}（第三种与第一种无异，静默）`);
    await PlayerStateStore.patchPlayerState(player.id, { columns: { equipped_title_id: null } });

    // ===== T6 清场 =====
    await PlayerCascadePurge.deleteByUsernames([username]);
    check('T6 探针号清干净', (await Player.count({ where: { username } })) === 0, '删号走级联门');

    finish();

    function finish() {
        const failed = results.filter(r => !r.ok);
        console.log(`\n合计 ${results.length - failed.length}/${results.length} 项通过`);
        process.exit(failed.length ? 1 : 0);
    }
})().catch(async err => {
    console.error('探针异常:', err && (err.stack || err.message));
    try {
        await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['titlevocab01']);
    } catch (e) { console.warn('异常退出后的清场也失败了:', e.message); }
    process.exit(2);
});
