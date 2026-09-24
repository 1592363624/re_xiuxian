/**
 * "属性词表在代码里被点名"的普查户口册（2026-09-21，任务 #15/#17）
 *
 * 业主那条"新加的属性要在所有用到它的地方直接算"，反面形状就是这里抓的东西：
 * 一段代码写出 `['atk','def','hp_max', ...]` 或 `{atk:0, def:0, ...}` 这种**属性键清单**，
 * 于是资料片新加的那一档从这条缝里漏过去 —— 不报错，只是"这个属性在这里永远不生效"。
 * 属性引擎本身早就泛化了（注册表驱动），剩下的全是这些**局部点名**。
 *
 * 判定不了的一律要求写结论，结论必须说清"为什么这里点名不会丢新属性"：
 *   generic_block   这块随后由 withDeclaredStats/mergeDeclaredStats 或泛化循环并上声明层，
 *                   写出来的那几个键只是零值模板/兜底顺序
 *   display_only    只透出给人看的裁剪，不进任何结算
 *   synonym_table   同义词/别名表（血量三种叫法），本来就是闭合词表
 *   legacy_compat   向后兼容的旧键位（新增项已在同一函数里并进来）
 *   db_columns      数据库列/配置字段就叫这几个名字
 *   pending_owner_decision  真缺口：泛化它会改到现网数字，等业主拍板（必须写清缺哪一步）
 *
 * 双向棘轮：内容/代码多出一个新点名字段 → 红；台账里的条目不再命中（改了/删了）→ 也红。
 * 底部还有一条"扫描器还看得见 ≥25 处"的底线，防止检测器空转变成假绿。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const statDefs = JSON.parse(fs.readFileSync(path.join(SERVER, 'config/stat_definitions.json'), 'utf8')).stats;
const stats = new Set(statDefs.map(s => s.key));
for (const pack of fs.readdirSync(path.join(SERVER, 'content/packs'))) {
    const f = path.join(SERVER, 'content/packs', pack, 'stat_definitions.json');
    if (!fs.existsSync(f)) continue;
    for (const s of JSON.parse(fs.readFileSync(f, 'utf8')).stats || []) {
        if (s.__op === 'remove') stats.delete(s.key); else stats.add(s.key);
    }
}

function collectJsFiles(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) { if (name !== 'node_modules') collectJsFiles(full, out); }
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * 检测器：把（相对路径, 源码）里"≥3 个注册属性名挤在一起"的位置抓出来。
 *
 * 为什么不解析括号（试过，两种形状都会漏）：
 *   1. 只看单行数组会漏跨行的 `const X = [\n 'atk',\n 'def',\n 'hp_max'\n]`；
 *   2. 改成匹配 `[…]`/`{…}` 又会在**嵌套处截断** —— `{ ...fullAttrs, atk: Math.floor(a*b), def: c }`
 *      里第一个 `}` 就把字面量切断了，SparringService 那一处因此看不见（假绿）。
 * 所以现在按"属性名出现位置"聚类：同一个文件里，相邻名字间距 ≤300 字符算一坨，
 * 一坨里出现 ≥3 个不同的注册属性名就是一个点名字段。这跟字面量怎么写、几行、有没有嵌套无关。
 */
function findStatLiterals(relPath, text) {
    const positions = [];
    for (const m of text.matchAll(/'([a-z_]+)'|\b([a-z_]+)\s*:/g)) {
        const name = m[1] || m[2];
        if (!stats.has(name)) continue;
        const before = text.slice(0, m.index);
        const line = before.split('\n').length;
        const codeLine = before.split('\n').pop();
        if (/^\s*(\*|\/\/|\/\*)/.test(codeLine.trim())) continue;    // 注释里的举例不算
        positions.push({ name, at: m.index, line });
    }
    const hits = [];
    let cluster = [];
    const flush = () => {
        const names = [...new Set(cluster.map(c => c.name))].sort();
        if (names.length >= 3) {
            const first = cluster[0];
            hits.push({ key: `${relPath}:${first.line}`, names, line: first.line });
        }
        cluster = [];
    };
    for (const p of positions) {
        if (cluster.length && p.at - cluster[cluster.length - 1].at > 300) flush();
        cluster.push(p);
    }
    flush();
    return hits;
}

function measure() {
    const dirs = ['game', 'routes', 'models'];
    const files = dirs.flatMap(d => collectJsFiles(path.join(SERVER, d)));
    const hits = [];
    for (const f of files) {
        const rel = path.relative(SERVER, f).replace(/\\/g, '/');
        if (rel.startsWith('content/packs/')) continue;
        for (const h of findStatLiterals(rel, fs.readFileSync(f, 'utf8'))) hits.push(h);
    }
    return hits;
}

/**
 * 逐条结论（2026-09-21 每条都连上下文打开看过，不是按文件名猜的）。
 * key = 文件:行；行号漂移时这条闸会红，那是要你重新确认结论仍然成立，不是让你删条目。
 */
// PuppetService 这六处只改行号、没加 anchor：那几处是同一块「atk/def/hp/speed 四键」的近似重复写法，
// 附近没有一行能在整份文件里唯一命中（判据要求锚点唯一 + 附近恰好一处点名字段），
// 硬编一个会假锚定。等这块收成一份「傀儡行 → 出参」的投影（灵兽那边已有 beastView.js 先例）时再换锚定。
const LEDGER = {
    'game/combat/CombatResolver.js:335': { verdict: 'legacy_compat', reason: 'game_balance 里那几个 base_*_weight 是旧 GM 字段名，这张表把旧名桥到属性键；桥盖不住的属性仍按 def.powerWeight 计（同函数下面遍历 registry.all()）' },
    'game/combat/MonsterStats.js:65': { verdict: 'generic_block', reason: '查不到境界配置时整只默认怪的兜底值；真怪的基础块随后被 withDeclaredStats 并上内容声明层' },
    'game/combat/MonsterStats.js:81': { verdict: 'db_columns', reason: '按境界表已有的四个列名取值（base_hp/base_atk/base_def/base_speed），声明层在 withDeclaredStats 里泛化合并' },
    'game/combat/MonsterStats.js:125': { verdict: 'generic_block', reason: '通用怪模板：game_balance 的 base_monster_* 四个基础列，怪物自己的 stats 声明由外层 withDeclaredStats 并进来' },
    'game/combat/MonsterStats.js:196': { verdict: 'pending_owner_decision', reason: '境界→怪基础值的钳制表只夹这四档：资料片若给境界表加一列（如 base_blood_power）并让属性声明带 base.realmField，这里既读不到也不钳范围。改法是按注册表遍历 base.realmField，但会牵动每只怪的数值上下限口径，等签字' },
    'game/combat/skillEffects.js:26': { verdict: 'synonym_table', reason: '效果名 → 属性键 + scale + 口径 的桥（SKILL_STAT_EFFECTS），它存在的意义就是把别名收敛到一处，新属性走注册表、新效果走词表登记' },
    'game/content/ContentRegistry.js:1662': { verdict: 'synonym_table', anchor: 'INSTANCE_OWNED_STATS = [', reason: 'INSTANCE_OWNED_STATS 是"实例行自己拥有的列"词表（含血量三种叫法），用于拒绝内容里重复声明，不消费属性。2026-09-22 一天内因登记词表集合与加启动闸漂过六次（1222→1438→1441→1502→1509→1662），每次都只是上面又插了一道校验器 —— 所以这一条起改用 anchor 锚定，纯搬家不再要求人肉重读（锚点失配或附近多处仍会红）' },
    'game/core/AttributeMaxService.js:75': { verdict: 'db_columns', reason: '池子上限只有气血/法力/寿元三个概念，其余注册属性没有"上限"这一层' },
    'game/core/ExperienceService.js:154': { verdict: 'legacy_compat', reason: '突破预览的旧六键为兼容保留；同函数下面按注册表 base.realmField 把新列并进同一份 gain（2026-09-21 改）' },
    'game/core/PlayerService.js:81': { verdict: 'generic_block', anchor: 'const initialAttributes = roleInitConfig', reason: '建号初值，真值来自 role_init.initialAttributes，这份只是配置缺失时的兜底（行号 2026-09-22 因上方插入 initialAttributeBlob 与陨落计数而 46→79→81，逐行重读确认形状未变；blob 那一格现在过 initialAttributeBlob 过滤，只剩注册表认得 attributeField 的档 + 神识池）' },
    'game/services/AdventureEventService.js:838': { verdict: 'display_only', reason: '历练战斗响应里给前端显示的怪物摘要（字符串化），结算用 buildMonsterStats 那份整块' },
    'game/services/AIService.js:595': { verdict: 'display_only', reason: '让大模型生成怪物时附在 prompt 里的字段清单；生成的怪再走内容校验与 withDeclaredStats。新属性不会由 AI 造出来，但也不会因此丢：这条只约束产出形状' },
    'game/services/ArtifactDeepLineService.js:47': { verdict: 'synonym_table', reason: '就是 BONUS_ROUTES 那张口径表本身：深线的字段名（atk_bonus_rate 等）→ 桶 + 属性键，泛化规则在它之后才接管。表在 2026-09-22 之后只用来翻译字段名，"有哪几条线"已经搬到内容 artifact_deep_lines.combat_bonus_sources' },
    'game/services/ArtifactDeepLineService.js:3620': { verdict: 'generic_block', anchor: 'const absolute = { atk: 0, def: 0, hp_max: 0', reason: 'absolute/percent 两个零值模板（同一坨）；来源清单来自内容表、字段分发在 _routeBonusFields，注册表认得的新属性自动进账（见 DeepLineBonusRouting 第 7 组）。行号 2026-09-22 一天内漂过两次（3492→3618→3620），两次都是往该文件上方插静态方法，逐行重读确认形状未变' },
    'game/services/ArtifactSpiritService.js:231': { verdict: 'pending_owner_decision', reason: '器灵加成聚合器是孤儿（provider 名单里没有它），且 percent 里写的是 crit/dodge，不是注册表键名 crit_rate/dodge_rate → 见 DeepLineBonusRouting 第 6 组台账，接不接等业主' },
    'game/services/BeastAbyssService.js:1001': { verdict: 'pending_owner_decision', reason: '探渊打野怪：怪侧走 withDeclaredStats 泛化，我方灵兽侧只手写 atk/def/hp_max。灵兽整块属性住在 stat_block，而快照（beastView）压根没带它 → 要让灵兽的新属性在探渊打出来，得先把块带进快照并给 beast_abyss_round 定 attack_stat（改平衡）' },
    'game/services/BeastAbyssService.js:1081': { verdict: 'pending_owner_decision', reason: '探渊 PVP 腿：与上一条同形状，且这是异步玩家对玩家的灵兽战 —— 口径要与打野怪同时改，只改一边会让"同一只灵兽"在两种对手面前不一样' },
    'game/services/BeastInvasionService.js:222': { verdict: 'db_columns', anchor: 'hp_max: BigInt(staticData.base_hp)', reason: '建兽潮行时把内容里的 base_* 写进列（列名固定），战斗时才由 mergeDeclaredStats 拼整块' },
    'game/services/BeastInvasionService.js:287': { verdict: 'display_only', reason: '兽潮状态响应里的血量/攻防摘要（BigInt 转字符串），不进结算' },
    'game/services/BeastInvasionService.js:342': { verdict: 'display_only', reason: '兽潮列表分页响应里的血量/攻防摘要（另一处状态响应在 286），BigInt 转字符串给前端，不进结算' },
    'game/services/BeastInvasionService.js:953': { verdict: 'generic_block', anchor: 'const beastStats = mergeDeclaredStats({', reason: 'mergeDeclaredStats 的入参：兽潮怪的内容声明层在它里面泛化合并（改造前攻守各只递一个数，注释里记着）' },
    'game/services/BeastInvasionService.js:1979': { verdict: 'display_only', reason: '兽潮结算回执里的怪物血量/攻防快照（奖励与战斗已在别处算完），这几行只用于回执展示' },
    'game/services/CombatService.js:222': { verdict: 'display_only', anchor: 'hp: monsterData.max_hp.toString()', reason: 'in_battle 响应里的怪物摘要，不进结算' },
    'game/services/DungeonService.js:56': { verdict: 'db_columns', reason: '副本用 BigInt 记账的四列（气血/法力池 + 攻防参与扫荡判定），与副本表列名一致；战斗属性另有整块来源' },
    'game/services/DungeonService.js:735': { verdict: 'generic_block', reason: 'withDeclaredStats 入参：副本怪因此也能带暴击/闪避/抗性（血量三种叫法是兼容别名，见 579 行的别名说明）' },
    'game/services/PuppetService.js:962': { verdict: 'synonym_table', anchor: "HP_KEYS.concat('atk', 'def', 'speed')", reason: '_statsOf 里"行上的老列覆盖内容声明"的那几个列名（含血量三种叫法），其余键按内容声明泛化。2026-09-23：五处「傀儡行 → 四键」的手抄块收进 game/stats/puppetView.js，本文件只剩这一处' },
    'game/stats/puppetView.js:19': { verdict: 'db_columns', anchor: 'PUPPET_STAT_COLUMNS = Object.freeze(', reason: '傀儡行对外露哪几列的**唯一一处**清单（工坊列表、PlayerPuppet.create、制造/淬炼/出战三份回执以前各抄一遍四个键，共五份）。以后给傀儡多看一档属性只改这里；真正落库还缺 player_puppets 上的存储位（加列或照灵兽 stat_block 加 JSON 块，属改表需业主授权）' },
    'game/services/PvpService.js:2186': { verdict: 'display_only', reason: 'PVP 主页/榜上那份玩家档案的 details 摘要（外加把权重表原样回显给前端），结算不读这里；结算用 resolveCombatStats 的整块' },
    'game/services/PvpService.js:2360': { verdict: 'db_columns', reason: '木人桩（打桩玩具）对手的构造属性，配置里就只有这四个 base_* 键' },
    'game/services/PvpService.js:2381': { verdict: 'pending_owner_decision', reason: '切磋模拟的入参块：玩家侧手挑五档传进 _simulateSparringBattle，其余注册属性不进这场战斗 —— 与 SparringService:312 的"整块 + 覆盖"做法不一致，统一会改切磋伤害期望，等拍板' },
    'game/services/ReincarnationService.js:92': {
        verdict: 'db_columns',
        anchor: 'const INHERIT_STAT_FIELDS = [',
        reason: '夺舍继承哪几档 = reincarnation_targets 表的那四个 base_* 列（外加 sense 是神识池、单走 blob），'
            + '键名与 targetField 只写这一处，回执/推送/记录行都从它推导（2026-09-22 把原来手抄的两份三档清单并掉）；'
            + '每一档必须是注册属性由 tests/ReincarnationInheritance.test.js 逐档钉。'
            + '2026-09-23 改成锚定：这一格因"神识读写收进 game/core/sensePool.js"在文件头上多了一行 require 而 91→92，'
            + '附近没有别的点名字段清单可分辨，所以按 anchor 锚住而不是再手工搬行号'
    },
    'game/services/SparringService.js:312': { verdict: 'generic_block', reason: '先展开 ...fullAttrs（整块解析结果）再覆盖切磋自己算的几个数 —— 新属性天然在块里，这条正是想要的形状' },
    'game/services/SpiritBeastService.js:1177': { verdict: 'generic_block', reason: '这四项只是"内容没配 combat_power_weight"时的兜底；有配置时逐档遍历内容声明的权重并按注册表解析别名（那份配置的 _comment 与 tests/BeastPowerWeights.test.js 就是钉这个的），所以资料片加一档权重不需要动代码' },
    'game/services/SpiritBeastService.js:1538': { verdict: 'display_only', anchor: 'extra_stats: SpiritBeastService._extraStatsOf', reason: '灵兽详情里把有列的四档原样透出；没列的那档由同函数下一行的 extra_stats 整块外发（标签取自注册表），所以新属性不依赖这张清单。2026-09-22 因"灵兽稀有度收成词表"在那几行里插了 rarity_name/rarity_color/rarity_order 而 1537→1538，逐行重读确认形状未变，并改用 anchor 锚定（这一格附近唯一命中，以后搬家不用再手工改行）' },
    'game/services/TechniqueService.js:1186': { verdict: 'generic_block', anchor: '全零加成模板', reason: '全零模板；累加循环遍历 _calcSingleBonus 的输出（那份又是遍历 cfg.bonuses），功法的新属性自动进账。2026-09-22 因相克表读取端改 contentList 而 1183→1186，逐行重读确认形状未变' },
    'game/services/WorldBossService.js:266': { verdict: 'display_only', reason: '世界 BOSS 行的序列化视图（列原样透出给列表/详情接口）；真正参战的那份由 mergeDeclaredStats 并内容声明层' },
    'game/services/WorldBossService.js:628': { verdict: 'generic_block', anchor: 'atk: Number(boss.atk) || 0,', reason: 'mergeDeclaredStats 入参：BOSS 的 stats 声明层在它里面并入同一块（改造前守方只递 {def}）' },
    'game/services/WorldBossService.js:1940': { verdict: 'display_only', reason: 'BOSS 状态响应里的血量/攻防摘要' },
    'game/services/WorldBossSkillManager.js:421': { verdict: 'display_only', reason: '技能描述里给玩家看的数值占位（atk_up/def_up 这类buff文案），不是结算输入' },
    'game/stats/beastView.js:33': { verdict: 'db_columns', reason: '灵兽快照的固定字段顺序（对外契约，探渊那份额外带体力）。注意：新属性不在这里 → 探渊看不见 stat_block，这条与 BeastAbyssService:1001 是同一笔债' },
    'routes/admin.js:252': { verdict: 'db_columns', anchor: "'hp_current', 'hp_max', 'mp_current', 'mp_max',", reason: 'GM 改玩家的**列**白名单（含 attributes 整块那一列），不是属性键白名单。2026-09-23：原 routes/admin.js:561 的 GM 建号初值兜底随 reset-player 改走 AccountDeletionService 而删除，该条目一并清掉' },
    'routes/admin_spirit_beast.js:112': { verdict: 'display_only', anchor: 'rarity_name: rarities[beast.rarity]?.label', reason: 'GM 侧灵兽视图的四个真列；没专属列的属性由同处下一行的 extra_stats 整块外发，GM 面板按注册表标签渲染（代码里就写着这条约定）。2026-09-22 因"灵兽稀有度收成词表"在同一块里加了 element_name/rarity_name/rarity_color/rarity_order 而 112→127，逐行重读确认形状未变，并改用 anchor 锚定（以后这一段搬家不用再手工改行）' },
    'routes/attribute.js:49': { verdict: 'legacy_compat', reason: '面板接口的旧顶层汇总块（十个键 + max 三件套），为老前端保留；新属性由 panel_schema/final 那两条泛化通道下发，不依赖这张表' },
    'models/beastInvasion.js:50': { verdict: 'db_columns', reason: 'player 侧兽潮行的建表列（hp_max/atk/def/speed 是真列）；战斗时另由 mergeDeclaredStats 从内容声明拼整块' },
    'models/player.js:67': { verdict: 'db_columns', reason: 'players 表里这几档确实是列（寿元/神识都在），整块可变属性住 attributes 那一列由 blobWriteGuard 管，'
        + '这几档自己的"读-改-写整值回写"由 numericWriteGuard 管（同一族洞的另一半：覆盖单位从一坨键变成一列）' },
    'models/spiritBeast.js:231': { verdict: 'db_columns', reason: 'spirit_beasts 自己的四个战斗列（hp_max/atk/def/speed 是"按配置基础值×等级星级重设"的整值），'
        + '这里点名它们只为把它们放进数值写回守卫的**观察档（默认 off）**：那一类写回语义上就是最后一份说了算，'
        + '拿 players 的属性词表去判它等于把"重设"当"丢数据"。玩家侧的属性全集仍只在 stat_definitions 里' },
    'models/playerPuppet.js:69': { verdict: 'db_columns', reason: 'player_puppets 的建表列；傀儡的新属性不住列里，由 PuppetService._statsOf 按内容声明 × 等级成长泛化补' },
    'models/spiritBeast.js:89': { verdict: 'db_columns', reason: 'spirit_beasts 的建表列；资料片那档没列的属性走 stat_block 整块（migration_0088），加属性不再需要 ALTER TABLE' },
    'models/worldBoss.js:43': { verdict: 'db_columns', reason: 'world_bosses 的建表列；BOSS 的触发属性由 world_boss_data.stats 声明、结算时 mergeDeclaredStats 并入' }
};

describe('属性键点名普查（资料片新属性的最后一条缝）', () => {
    const measured = measure();
    const measuredKeys = measured.map(h => h.key);
    const readLines = file => fs.readFileSync(path.join(SERVER, file), 'utf8').split(/\r?\n/);

    /**
     * 行号锚定：条目可以带一个 `anchor`（该点名字段附近、在这份文件里唯一的一段代码）。
     *
     * 为什么要有这条：同一个 `ContentRegistry.js` 的行号一天内漂过六次（每加一道启动闸就漂一次），
     * 每一次都要人去"逐行重读确认形状未变"。那个动作本身没有信息量 —— 有信息量的是
     * **"这段代码还在不在、还是不是那个形状"**，而那正好是锚点能机械回答的。
     * 三种情况仍然必须红（跟随≠放行）：锚点 0 命中 / 命中多行（不唯一，按不住）/
     * 锚点附近不是**恰好一处**点名字段（0 处 = 形状变了；≥2 处 = 不敢猜是哪一处）。
     */
    function resolveLedgerKeys(sites, ledger, lineAt, windowSize = 8) {
        const byKey = new Map(sites.map(h => [h.key, h]));
        const linesOfFile = new Map();
        for (const h of sites) {
            const file = h.key.slice(0, h.key.lastIndexOf(':'));
            if (!linesOfFile.has(file)) linesOfFile.set(file, []);
            linesOfFile.get(file).push(h);
        }
        const out = {};
        const followed = [];
        const problems = [];
        for (const [key, entry] of Object.entries(ledger)) {
            if (byKey.has(key) || !entry.anchor) { out[key] = entry; continue; }
            const file = key.slice(0, key.lastIndexOf(':'));
            const text = lineAt(file);
            if (!text) { problems.push(`${key}：文件读不到，锚点无法校验`); continue; }
            const hits = [];
            text.forEach((line, i) => { if (line.includes(entry.anchor)) hits.push(i + 1); });
            if (hits.length === 0) {
                problems.push(`${key}：锚点「${entry.anchor}」在 ${file} 里一处都没有 → 那一段代码的形状变了，结论必须重读`);
                continue;
            }
            if (hits.length > 1) {
                problems.push(`${key}：锚点「${entry.anchor}」命中 ${hits.length} 行（${hits.join('/')}）→ 不唯一，不许自动跟随`);
                continue;
            }
            const near = (linesOfFile.get(file) || []).filter(h => Math.abs(h.line - hits[0]) <= windowSize);
            if (near.length !== 1) {
                problems.push(`${key}：锚点唯一命中 ${file}:${hits[0]}，但它附近 ${windowSize} 行内有 ${near.length} 处点名字段`
                    + `（要恰好 1 处）→ ${near.length ? '不敢猜是哪一处' : '字面量已经不在这儿了'}，结论必须重读`);
                continue;
            }
            out[`${file}:${near[0].line}`] = entry;
            followed.push(`${key} → ${file}:${near[0].line}`);
        }
        return { ledger: out, followed, problems };
    }

    const resolved = resolveLedgerKeys(measured, LEDGER, readLines);

    /** 两头对照：新点名字段没有结论 → 要报；结论过期 → 也要报（纯函数，便于用假数据证伪） */
    const diffAgainstLedger = (sites, ledger) => ({
        unlisted: sites.filter(h => !ledger[h.key]).map(h => `${h.key} [${h.names.join(',')}]`),
        stale: Object.keys(ledger).filter(k => !sites.some(h => h.key === k))
    });

    test('锚点条目：锚点必须真的唯一命中那一处（写个假锚点当结论，等于没有结论）', () => {
        const anchored = Object.entries(LEDGER).filter(([, e]) => e.anchor).map(([k]) => k);
        expect(anchored.length).toBeGreaterThanOrEqual(3);
        expect(resolved.problems).toEqual([]);
        if (resolved.followed.length) {
            console.log(`行号锚定自动跟随（结论本身没变，只是它搬了家）：${resolved.followed.join(' ; ')}`);
        }
        // 反证一：假锚点 → 必须红（0 命中）
        const fake = resolveLedgerKeys(measured, {
            'game/content/ContentRegistry.js:1': { verdict: 'synonym_table', reason: '一条测试用的假锚点条目，长度足够长', anchor: 'zz_this_identifier_does_not_exist' }
        }, readLines);
        expect(fake.problems.join()).toContain('一处都没有');
        // 反证二：锚点命中多行 → 不许自动跟随
        const many = resolveLedgerKeys(measured, {
            'game/content/ContentRegistry.js:1': { verdict: 'synonym_table', reason: '一条测试用的假锚点条目，长度足够长', anchor: 'return' }
        }, readLines);
        expect(many.problems.join()).toContain('不唯一');
        // 反证三：锚点唯一命中，但附近没有点名字段 → 红（形状变了，不是搬家）
        const far = resolveLedgerKeys(measured, {
            'game/content/ContentRegistry.js:1': { verdict: 'synonym_table', reason: '一条测试用的假锚点条目，长度足够长', anchor: 'const DEFAULT_COLLECTION' }
        }, readLines);
        expect(far.problems.join()).toContain('字面量已经不在这儿了');
    });

    test('每一个点名字段都有结论，且结论说得出为什么（多一条红、少一条也红）', () => {
        const { unlisted, stale } = diffAgainstLedger(measured, resolved.ledger);
        // 行号漂移是这里最常见的红：同一文件里一旧一新成对出现，八成只是上面加了十几行。
        // 带锚点的条目已经在上一步自动跟过了；剩下的这些要把"该改成哪一行"讲出来，省得下一个人去猜。
        const drifted = stale.filter(k => unlisted.some(u => u.startsWith(k.split(':')[0] + ':')))
            .map(k => `${k} → ${unlisted.filter(u => u.startsWith(k.split(':')[0] + ':')).map(u => u.split(' ')[0]).join(', ')}`);
        if (drifted.length && unlisted.length === stale.length) {
            throw new Error(`这些点名字段的行号漂了（上面 additions 里就是新行号）。给这条结论补一个唯一 anchor 就不用再手工改行；`
                + `不加就得逐条重读后再改行：\n  ${drifted.join('\n  ')}`);
        }
        expect(unlisted).toEqual([]);
        expect(stale).toEqual([]);
        for (const [key, entry] of Object.entries(resolved.ledger)) {
            expect(['generic_block', 'display_only', 'synonym_table', 'legacy_compat', 'db_columns', 'pending_owner_decision'])
                .toContain(entry.verdict);
            if (typeof entry.reason !== 'string' || entry.reason.length <= 15) {
                throw new Error(`结论太薄（要说清"为什么这里点名不会丢新属性"）：${key} → ${JSON.stringify(entry.reason)}`);
            }
        }
    });

    test('底线：扫描器还看得见 ≥25 处（少了说明检测器坏了，不是代码变干净了）', () => {
        expect(measured.length).toBeGreaterThanOrEqual(25);
        // 而且真的覆盖到这些文件，不是全落在同一个文件里
        const scannedFiles = new Set(measuredKeys.map(k => k.split(':')[0]));
        expect(scannedFiles.size).toBeGreaterThanOrEqual(12);
        // 具体点名几处"必须还在扫描范围内"的位置，防止范围悄悄缩掉
        for (const f of ['game/services/PuppetService.js', 'game/combat/MonsterStats.js',
            'models/player.js', 'routes/admin.js']) {
            expect(scannedFiles.has(f)).toBe(true);
        }
        // 反面：这次真的改掉的白名单，现在一处都不该再命中（能命中就说明它又点名了）
        expect(measuredKeys.filter(k => k.startsWith('game/services/SecondSoulService.js'))).toEqual([]);
    });

    test('形状钉子：跨行清单、嵌套函数调用里的清单都要抓到；注释与零散提及不算', () => {
        expect(findStatLiterals('virtual/x.js', "const allowed = [\n    'atk',\n    'def',\n    'hp_max',\n];\n")
            .map(h => h.names.join('+'))).toEqual(['atk+def+hp_max']);
        // 上一版按括号解析时这一条会漏（第一个 } 就截断了）—— 聚类才不会
        expect(findStatLiterals('virtual/n.js',
            "const stats = {\n  ...fullAttrs,\n  atk: Math.floor(a * b),\n  def: c,\n  speed: d\n};\n")
            .map(h => h.names.join('+'))).toEqual(['atk+def+speed']);
        expect(findStatLiterals('virtual/y.js', "const two = ['atk', 'def'];")).toEqual([]);
        expect(findStatLiterals('virtual/z.js', "/** 例如 atk: 0, def: 0, hp_max: 0 这类键 */\nconst x = 1;\n")).toEqual([]);
    });

    /**
     * 控制跑：证明"两头都会红"这件事本身成立。
     *
     * 这里刻意不往真实文件里注入（试过：那要求还原逐字节相同，而这个仓库可能被另一路改动同时写，
     * 一个体检用例不该有能力弄坏别人的工作树）。用合成清单驱动同一个纯函数，
     * 断的是"对照逻辑"这条真正要证明的东西。
     */
    test('控制跑：合成就绪的两头断链各被点到（新增没结论要红、结论过期也要红）', () => {
        const site = (key, ...names) => ({ key, names: names.sort() });
        const fakeLedger = {
            'virtual/a.js:1': { verdict: 'db_columns', reason: '已有结论的一条，用来验证它不在清单时会报过期' },
            'virtual/b.js:2': { verdict: 'generic_block', reason: '清单里根本没有这一处，条目就该被判过期' }
        };
        const { unlisted, stale } = diffAgainstLedger(
            [site('virtual/a.js:1', 'atk', 'def', 'hp_max'), site('virtual/c.js:9', 'atk', 'def', 'speed')],
            fakeLedger
        );
        expect(unlisted).toEqual(['virtual/c.js:9 [atk,def,speed]']);   // 新增点名字段没结论 → 红
        expect(stale).toEqual(['virtual/b.js:2']);                       // 结论指向已不存在的处 → 红
        // 反向对照：都齐了就必须全绿，否则上面两条是"只要非空就红"的假闸
        expect(diffAgainstLedger([site('virtual/a.js:1', 'atk', 'def', 'hp_max')],
            { 'virtual/a.js:1': fakeLedger['virtual/a.js:1'] })).toEqual({ unlisted: [], stale: [] });
    });

    test('已经改掉的三处不许悄悄改回去：元神与功法/属性相关的白名单不能重新出现', () => {
        const read = f => fs.readFileSync(path.join(SERVER, f), 'utf8');
        // 元神继承与 GM 改属性以前各写死一份五档清单，现在一律按注册表来
        const soul = read('game/services/SecondSoulService.js');
        expect(soul).not.toMatch(/allowedFields\s*=\s*\[\s*'atk'/);
        expect(soul).toMatch(/statRegistry\.all\(\)/);
        // 突破预览旧六键保留，但注册表并集那条循环不能丢
        const exp = read('game/core/ExperienceService.js');
        expect(exp).toMatch(/base\s*&&\s*def\.base\.realmField|def\.base\s*&&\s*def\.base\.realmField/);
    });
});
