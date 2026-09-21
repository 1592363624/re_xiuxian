/**
 * 内容注册中心（DLC / 资料片层）
 *
 * 目标：加内容 = 放数据文件，而不是改一堆 Service。
 *
 * 三层结构
 *   1. 基础层  server/config/<dataset>.json          —— 现网既有内容，保持不动
 *   2. 资料片  server/content/packs/<packId>/*.json  —— 目录扫描自动发现，无注册代码
 *   3. 合并视图                                      —— 回灌 ConfigLoader，
 *      现网数十处 getConfig('item_data') 调用点一行不改就能看到新内容
 *
 * 每个 pack 的一个数据文件针对一个集合（collection），文件名就决定目标：
 *   <dataset>.json            → 该数据集的主集合
 *   <dataset>__<collection>.json → 指定集合（用于 technique_data__skills.json 这种同数据集多集合）
 * 形如：
 *   { "dataset": "item_data",
 *     "add":      [ { "id": "qingzhu_fengyun_sword", "effect": { "matk": 12 } } ],  // 全新内容
 *     "override": { "wooden_sword": { "effect": { "matk": 8 } } },                   // 给已有内容补字段
 *     "remove":   [ "obsolete_item" ],                                               // 下架
 *     "replace":  false }                                                            // 整集合替换（少用）
 * override 采用"一层深合并"：patch 里的对象字段（如 effect）与原值合并而非整块替换，
 * 于是"早期只做攻击、后期补法攻"这种需求只写一行数据。
 *
 * 启动期硬校验（不过则抛错，不留运行期静默失效）；后台热更走 reload()，跑的是同一套闸：
 * 两条路径都调 _refreshDerivedAndValidate()，所以"改基础配置"不会成为绕过校验的旁门：
 * 把一个拼错的属性键写进 item_data，如果只有启动期校验，表现就是玩家身上凭空少一份加成。
 * reload() 校验不过时会把该数据集退回上一份通过校验的视图再抛错，ConfigLoader 连带退回运行缓存，
 * 一次失败的编辑不会让运行中的进程突然看不到资料片内容。
 *   - manifest 合法、depends 满足、目录名与 manifest.id 一致
 *   - add 不能撞已有 id（要改用 override）；override/remove 的目标必须存在
 *   - stat_definitions 交给 StatRegistry 校验（派生公式/环/存储键冲突）
 *   - 物品 effect 键必须是已注册属性、其别名，或在效果词表内
 *   - 跨数据集引用（掉落/产出/宝库 → 物品）必须存在
 *   - 五行属性名（功法/神通的 element）必须是 role_init.spirit_roots 里的真实灵根
 */
'use strict';

const fs = require('fs');
const path = require('path');
// 神通特效词表（叶子模块，无依赖）：校验与战斗/属性折叠共用同一张表
const {
    isKnownSkillEffectKey, skillEffectVocabulary, SKILL_STAT_EFFECTS
} = require('../combat/skillEffects');

/**
 * 数据集结构：collections 里每个集合是 { field, key }（数组，key 为主键字段）
 * 或 { field, map: true }（对象映射，键即主键）。
 */
const DATASET_SPECS = {
    item_data: { collections: { items: { key: 'id' } } },
    // 神通（skills）也要能被资料片扩展：只登记 techniques 的话，
    // 资料片就没法新增一条"打剑意伤害"的神通，新伤害档位依旧进不了战斗。
    technique_data: { collections: { techniques: { map: true }, skills: { map: true, optional: true } } },
    resource_data: { collections: { resource_yields: { key: 'resource_id' } } },
    drop_data: { collections: { drops: { key: 'monster_id' }, boss_drops: { key: 'monster_id', optional: true } } },
    map_data: { collections: { maps: { key: 'id' } } },
    realm_breakthrough: { collections: { realms: { key: 'id' } } },
    // 展示用的标签表也登记成集合：资料片能加宗门/副本/器灵，但过去没法给它配中文名，
    // 结果就是"加了内容反而启动失败"（启动期闸要求每个键都有标签）。map 集合按键合并，
    // `_note` 这类字符串值走 passthrough 原样保留。
    sect_data: { collections: { sects: { key: 'id' }, 'global.bonus_labels': { map: true, optional: true } } },
    spirit_beast_data: { collections: { beast_types: { key: 'beast_key' } } },
    dungeon_data: { collections: { chapters: { key: 'id' } } },
    multi_dungeon_data: {
        collections: {
            dungeons: { map: true },
            'global.variable_labels': { map: true, optional: true },
            'global.reward_type_labels': { map: true, optional: true }
        }
    },
    achievement_data: { collections: { achievements: { key: 'id' } } },
    world_boss_data: { collections: { bosses: { key: 'boss_key' } } },
    // 兽潮妖兽与灵兽探渊的层以前根本不在这个注册表里：资料片加不了新妖兽/新层，
    // 更糟的是下面 _validateCombatStatBlocks 里那两条"兽潮/探渊"的校验分支永远读不到数据集，
    // 于是声明写错了也没有任何启动期信号（看起来有闸，其实闸没接线）。
    beast_invasion_data: { collections: { beasts: { key: 'beast_key' } } },
    spirit_beast_abyss_data: { collections: { floors: { key: 'floor' } } },
    // 切磋木人的属性块本来就以 stats 的形式写在内容里（max_hp/atk/def/speed），
    // 但这份数据集没登记：资料片加不了木人，服务里那份 require(JSON) 又把这个文件永久缓存住，
    // 于是它既是"内容层的盲区"也是"校验层的盲区"。登记之后两件事一起解决。
    sparring_woodman: { collections: { woodmen: { key: 'key' } } },
    // 傀儡是"友方版本的怪物"：base_stats 就是一整块属性，出战/护法时按比例折算进玩家战斗。
    // 不登记的话资料片既加不了傀儡类型，也解释不了为什么傀儡的属性键不受启动期校验管。
    puppet_data: { collections: { puppet_types: { map: true } } },
    // 下面这几份是"一个玩法一个文件、条目数组住在第二层"的典型：登记之前资料片完全碰不到它们，
    // 而这些玩法恰恰是最需要"只加数据就能扩"的内容（妾室/道侣、灵兽段位、宗门专属、飞升形态、后期法则）。
    companion_data: { collections: { concubines: { key: 'concubine_key' } } },
    spirit_beast_pvp_data: { collections: { 'spirit_beast_pvp.tiers': { key: 'key' } } },
    sect_special_data: {
        collections: {
            'star_platform.star_forms': { key: 'id' },
            'fate_disk.fates': { key: 'id' }
        }
    },
    ascension_data: {
        collections: {
            'dharma_form.levels': { key: 'level' },
            'fracture_explore.rewards': { key: 'name' }
        }
    },
    late_stage_data: {
        collections: {
            'divine_temple.offerings': { key: 'name' },
            'law.convert_options': { key: 'name' },
            'second_soul.fragment_types': { map: true },
            'second_soul.dispatch_modes': { map: true }
        }
    },
    // 历练事件：这份内容以前根本不在 config/ 里，而是抄在 AdventureEventService 的代码里
    // （模板 / 抽取权重 / AI 标题 / AI 保底经验四份）。抄在代码里的内容对所有内容闸都是隐形的：
    // 物品引用不校验、资料片加不进来、启动期报错也指不到它。搬进来之后它才受这条链保护。
    // events 放第一个 = 主集合：资料片只写 <dataset>.json 时进的就是它；
    // 要动类型表得写 <dataset>__event_types.json（权重/标题是一张按类型索引的表，不是数组）。
    adventure_event_data: {
        collections: {
            events: { key: 'id' },
            event_types: { map: true }
        }
    },
    // 洞府整份都没登记过：五座设施、四条灵种、五处景观、五种访客遭遇、十件商人货摊全是内容，
    // 资料片既加不了"符箓阁"也加不了一株新灵草，而洞府的产出/冷却/升级材料又恰恰是最常扩的东西。
    cave_data: {
        collections: {
            'cave.facilities': { map: true },
            'cave.garden.seeds': { key: 'seed_id' },
            'cave.social.landscapes': { key: 'id' },
            'cave.social.visit_encounters.encounters': { key: 'id' },
            'cave.social.merchant.items': { key: 'item_key' }
        }
    },
    // 放养场所（灵田/火山口…）是一条条内容：场所名、境界门槛、偏好五行、产出物与权重。
    // 以前整份文件没登记，资料片加不了新场所；同时它也是物品引用的盲区（yield_items[].item_id）。
    spirit_beast_pasture_data: { collections: { 'pasture.locations': { key: 'location_key' } } },
    // 境界 → 灵力上限：realm_data / realm_breakthrough 都可被资料片扩展，唯独这张表不行，
    // 于是"资料片新开一个境界"会算不出 mp_max（AttributeService 读不到就是 null，静默降级）。
    spirit_system: { collections: { realm_settings: { map: true } } },
    taoism_gate_data: { collections: { dao_paths: { map: true } } },
    dayan_data: { collections: { levels: { map: true }, fragments: { map: true } } },
    fishing_data: { collections: { rods: { map: true }, baits: { map: true }, ponds: { map: true } } },
    gambling_stone_data: { collections: { origins: { map: true }, qualities: { map: true }, cut_methods: { map: true } } },
    artifact_spirit_data: {
        collections: {
            spirit_types: { map: true },
            spirit_bonus_stat_labels: { map: true, optional: true },
            spirit_effect_labels: { map: true, optional: true }
        }
    },
    stock_data: { collections: { stocks: { key: 'code' } } },
    lottery_data: { collections: { ranks: { map: true }, pool: { key: 'name' } } },
    formation_data: { collections: { formations: { key: 'id' } } },
    crafting_data: { collections: { alchemy_recipes: { key: 'id' }, refining_recipes: { key: 'id' } } },
    stat_definitions: { collections: { stats: { key: 'key' } } },
    // 法宝深度玩法（血魔剑/虚天鼎/遮天瓶…）的每一套配置都住在 settings.<法宝id> 下，
    // 登记成 map 集合之后，资料片就能"只写一个 JSON"给自己新增一件可祭炼的法宝；
    // 不登记的话它连合并视图都没有，新增法宝只能改基础配置 + 改服务代码。
    artifact_deep_lines: { collections: { settings: { map: true } } },
    // 宗门战领地是纯内容（一张图上的一块块地：产出、上限、地图坐标）。不登记的话资料片加不了一块领地，
    // 而领地字段写错也没有任何启动期信号。
    sect_war_data: { collections: { territories: { key: 'territory_key' } } },
    // 天时系统：加一条吉时/凶时、或一种凡俗活动，本该只是写数据；不登记就只能改 DualTimeService。
    time_system: {
        collections: {
            heavenly_events: { key: 'key' },
            mortal_activities: { map: true }
        }
    },
    // 慕兰战线：后勤路线、巡山路线、临战刻印类型、军功商店货架、军功里程碑档位都是条目集合。
    // 登记之前资料片碰不到它们；更要紧的是这份文件根本不在合并视图里，
    // _validateItemKeysDeep 那道深扫自然也看不见它 —— 于是货架与掉落里 4 个不存在的物品 id
    // 一直躺着（玩家兑换时收到"物品发放失败"；里程碑更狠：先把"已发放"记进表再吞掉发放异常，
    // 奖励永久丢失且不会再补）。登记之后这两件事一起解决。
    border_military_data: {
        collections: {
            support_routes: { map: true },
            'beast_patrol.routes': { map: true },
            'war_imprint.imprint_types': { map: true },
            'military_shop.items': { key: 'key' },
            'milestones.thresholds': { key: 'merit' }
        }
    },
    // 伤害/战力公式档位：资料片加了新属性（battleRoles）之后，还要能加一条用它的公式，
    // 否则"新属性进了面板却进不了战斗"，扩展性承诺只兑现一半。
    combat_formulas: { collections: { profiles: { map: true } } },
    effect_vocabulary: { collections: { effects: { key: 'id' } } },
    talents: { collections: { root: { key: 'id', root: true } } },
    titles: { collections: { root: { key: 'id', root: true } } }
};

const DEFAULT_COLLECTION = (dataset) => {
    const spec = DATASET_SPECS[dataset];
    if (!spec) return null;
    return Object.keys(spec.collections)[0];
};

/**
 * 非属性效果词表：这些 effect 键不属于"属性"，由各子系统自行消费。
 * 显式列出是为了让校验区分"故意不是属性"与"属性名拼错了"——后者必须启动期失败。
 */
const BASE_EFFECT_VOCABULARY = [
    { id: 'hp_restore', label: '气血恢复', description: '回复气血' },
    { id: 'mp_restore', label: '灵力恢复', description: '回复灵力' },
    { id: 'exp', label: '修为', description: '直接增加修为' },
    { id: 'spirit_stones', label: '灵石', description: '直接增加灵石' },
    { id: 'spirit_stones_random', label: '随机灵石', description: '随机灵石' },
    { id: 'breakthrough_bonus', label: '突破加成', description: '提升突破成功率', format: 'ratio_pct' },
    { id: 'longevity_add', label: '寿元', description: '增加寿元' },
    { id: 'toxicity_reduce', label: '丹毒清除', description: '降低丹毒' },
    { id: 'alchemy_bonus', label: '炼丹成功率', description: '炼丹成功率加成' },
    { id: 'seal_bonus', label: '封印加成', description: '封印/法则加成' },
    { id: 'divine_sense_bonus', label: '神识储备', description: '神识储备加成' },
    { id: 'dungeon_ticket', label: '副本凭证', description: '副本入场凭证' },
    { id: 'learn_recipe', label: '学习配方', description: '学习配方' },
    { id: 'ascension_protect_material', label: '飞升护持', description: '飞升护持材料' },
    // 通配效果：由属性系统展开到"全部已注册属性"，因此新增属性自动被它覆盖
    { id: 'all_stats_bonus', label: '全属性', description: '全属性加成（随属性注册表自动扩展）', wildcard: true }
];

/** 跨数据集引用完整性检查（nested 指条目内层的数组字段） */
const REFERENCES = [
    { dataset: 'drop_data', collection: 'drops', nested: 'drops', field: 'item_id', target: 'item_data' },
    { dataset: 'drop_data', collection: 'boss_drops', nested: 'drops', field: 'item_id', target: 'item_data' },
    { dataset: 'resource_data', collection: 'resource_yields', nested: null, field: 'item_id', target: 'item_data' },
    { dataset: 'sect_data', collection: 'sects', nested: 'treasury', field: 'item_key', target: 'item_data' }
];

/**
 * 显式豁免的"可选物品引用"：这些路径上的 item 键允许指向不存在的物品，
 * 因为读它的代码本身就写了缺失时的降级分支，或者干脆还没有代码在读。
 *
 * 为什么写在这里而不是放宽整道闸：每一条例外都要写理由，理由要能在代码里查到；
 * 新增一条时必须回答"到底是没实现、还是故意可选"，否则这道闸就会悄悄变成摆设。
 */
const OPTIONAL_ITEM_REFS = [
    {
        at: 'sect_special_data.spirit_eye_tree.harvest.produce_item_key',
        item: 'spirit_eye_fruit',
        reason: '采收分支自己写了"物品配置不存在时给一次性经验奖励"（SectSpecialService 的 harvest），缺物品是设计允许的降级；要真出果实只需补这个物品，代码不用改'
    },
    {
        at: 'sect_special_data.spirit_eye_tree.seed_item_key',
        item: 'spirit_eye_seed',
        reason: '全仓库没有任何代码读 seed_item_key：灵眼树的"结果实"有实现，"留种"没有。补实现时要么一并发放这个物品，要么删掉这个键'
    },
    {
        at: 'sect_special_data.star_platform.star_chart_item_key',
        item: 'star_chart',
        reason: '全仓库没有任何代码读 star_chart_item_key：星台玩法读的是 star_forms，这个键是未完成玩法留下的'
    }
];

class ContentError extends Error {}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 集合名允许写成点号路径（如 `spirit_beast_pvp.tiers`）。
 *
 * 为什么需要：现网最大的几份玩法配置（late_stage_data / ascension_data / sect_special_data
 * / spirit_beast_pvp_data …）都是"一个文件里再分子系统"的形状，真正的条目数组住在第二、三层。
 * 只支持顶层集合的话，这些玩法就永远进不了资料片层 —— 而它们恰恰是最需要"只加数据就能扩展"的内容。
 * 路径只用来定位容器，条目的合并/覆盖/删除规则与顶层集合完全一样，不是第二套机制。
 */
function getPath(data, collectionName) {
    let cursor = data;
    for (const segment of String(collectionName).split('.')) {
        if (!isPlainObject(cursor)) return undefined;
        cursor = cursor[segment];
    }
    return cursor;
}

/** 沿路径逐层浅拷贝后写回（不修改基础配置那份对象，否则一次热更就会污染下一次合并） */
function setPath(root, collectionName, value) {
    const [head, ...rest] = String(collectionName).split('.');
    if (!rest.length) return { ...(isPlainObject(root) ? root : {}), [head]: value };
    const child = isPlainObject(root?.[head]) ? root[head] : {};
    return { ...(isPlainObject(root) ? root : {}), [head]: setPath(child, rest.join('.'), value) };
}

/** 集合规范化：统一成条目数组 + 主键，并记住回写方式 */
function readCollection(dataset, data, collectionName) {
    const spec = DATASET_SPECS[dataset]?.collections?.[collectionName];
    if (!spec) throw new ContentError(`数据集 ${dataset} 未登记集合 ${collectionName}`);

    if (spec.root) {
        if (!Array.isArray(data)) throw new ContentError(`${dataset}: 根结构应为数组`);
        return { spec, entries: data, passthrough: {} };
    }

    const raw = getPath(data, collectionName);
    if (raw === undefined || raw === null) {
        if (spec.optional) return { spec, entries: [], passthrough: {} };
        throw new ContentError(`${dataset}.${collectionName} 缺失`);
    }

    if (spec.map) {
        if (!isPlainObject(raw)) throw new ContentError(`${dataset}.${collectionName} 应为对象映射`);
        const entries = [];
        const passthrough = {};
        for (const [key, value] of Object.entries(raw)) {
            // _comment / _meta 这类说明性键不是内容，原样保留，不能被当成条目展开
            if (isPlainObject(value)) entries.push({ ...value, __pk: key });
            else passthrough[key] = value;
        }
        return { spec, entries, passthrough };
    }

    if (!Array.isArray(raw)) throw new ContentError(`${dataset}.${collectionName} 应为数组`);
    return { spec, entries: raw, passthrough: {} };
}

/**
 * 展示标签取法：基础配置里标签是字符串（`"morale": "士气"`），
 * 而资料片通过 map 集合追加的条目必然是对象（`{id, label}`），合并后两种形状并存。
 * 所有读标签的地方都过这一层 —— 否则资料片加的标签会印成 `[object Object]`。
 */
function contentLabel(value, fallback = null) {
    if (typeof value === 'string') return value.trim() || fallback;
    if (isPlainObject(value)) {
        const label = value.label ?? value.name;
        if (typeof label === 'string' && label.trim()) return label.trim();
    }
    return fallback;
}

function keyOf(entry, spec, index) {
    if (!isPlainObject(entry)) throw new ContentError(`条目 #${index} 不是对象`);
    // map 集合：对象键即主键；pack 新增时用条目的 id 字段作为对象键
    if (spec.map) {
        const value = entry.__pk ?? entry.id;
        if (typeof value !== 'string' && typeof value !== 'number') {
            throw new ContentError(`条目 #${index} 属于对象映射集合，但既无对象键也无 id`);
        }
        return String(value);
    }
    const value = spec.key ? entry[spec.key] : undefined;
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new ContentError(`条目 #${index} 缺少主键字段 ${spec.key}`);
    }
    return String(value);
}

/** 把一组 add/override/remove 应用到一个集合 */
function applyOps({ dataset, collection, packId, baseEntries, spec, add = [], override = {}, remove = [], replace = false }) {
    if (replace) {
        if (!Array.isArray(add) || add.length === 0) {
            throw new ContentError(`pack ${packId}: ${dataset}.${collection} 声明 replace 但 add 为空`);
        }
        return add.map((entry, i) => ({ ...entry, __content_origin: packId, __pk: keyOf(entry, spec, i) }));
    }

    const entries = baseEntries.map(entry => ({ ...entry, __pk: keyOf(entry, spec, 0) }));
    const index = new Map(entries.map(entry => [entry.__pk, entry]));

    for (const [i, raw] of add.entries()) {
        const key = keyOf(raw, spec, i);
        if (index.has(key)) {
            throw new ContentError(
                `pack ${packId}: ${dataset}.${collection} 新增的 "${key}" 已存在。要修改既有内容请写 override，不要重复 add。`
            );
        }
        const entry = { ...raw, __content_origin: packId, __pk: key };
        entries.push(entry);
        index.set(key, entry);
    }

    for (const [key, patch] of Object.entries(override)) {
        const existing = index.get(key);
        if (!existing) {
            throw new ContentError(`pack ${packId}: ${dataset}.${collection} 要 override 的 "${key}" 不存在（id 拼错？）`);
        }
        if (!isPlainObject(patch)) throw new ContentError(`pack ${packId}: ${dataset}.${collection} override.${key} 必须是对象`);

        for (const [field, value] of Object.entries(patch)) {
            // 一层深合并：effect/bonuses 这类嵌套对象补字段而不是整块替换
            if (isPlainObject(value) && isPlainObject(existing[field])) {
                existing[field] = { ...existing[field], ...value };
            } else {
                existing[field] = value;
            }
        }
        existing.__content_overridden_by = [...new Set([...(existing.__content_overridden_by || []), packId])];
    }

    const removed = new Set(remove.map(String));
    for (const key of removed) {
        if (!index.has(key)) {
            throw new ContentError(`pack ${packId}: ${dataset}.${collection} 要移除的 "${key}" 不存在`);
        }
    }
    return removed.size ? entries.filter(entry => !removed.has(entry.__pk)) : entries;
}

class ContentRegistry {
    /**
     * @param {Object} options
     * @param {string} [options.packDir]   资料片根目录，默认 server/content/packs
     * @param {string} [options.configPath] 基础数据目录，默认 server/config
     * @param {Object} [options.statRegistry] 属性注册中心；传入则合并后的 stat_definitions 会装入并校验
     */
    constructor(options = {}) {
        const serverRoot = path.join(__dirname, '..', '..');
        this.packDir = options.packDir || path.join(serverRoot, 'content', 'packs');
        this.configPath = options.configPath || path.join(serverRoot, 'config');
        this.statRegistry = options.statRegistry || null;

        this.packs = [];
        this.datasets = new Map();
        this.collectionStates = new Map(); // `${dataset}` -> 最终集合数组（含内部标记）
        this.report = { packs: [], merged: {}, warnings: [] };
        this._knownEffects = new Set();
        this._wildcards = new Set();
        this._effectVocabulary = [];
    }

    _loadBase(dataset) {
        const file = path.join(this.configPath, `${dataset}.json`);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (error) {
            throw new ContentError(`基础数据集 ${dataset}.json 解析失败: ${error.message}`);
        }
    }

    /** 目录扫描发现资料片：新增 pack 不需要改任何注册代码 */
    discoverPacks() {
        this.packs = [];
        if (!fs.existsSync(this.packDir)) return this.packs;

        const dirNames = fs.readdirSync(this.packDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort();

        for (const dirName of dirNames) {
            const dir = path.join(this.packDir, dirName);
            const manifestFile = path.join(dir, 'pack.json');
            if (!fs.existsSync(manifestFile)) continue; // 无 manifest 视为未发布目录

            let manifest;
            try {
                manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
            } catch (error) {
                throw new ContentError(`pack ${dirName} 的 pack.json 解析失败: ${error.message}`);
            }
            if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
                throw new ContentError(`pack ${dirName}: pack.json 缺少 id`);
            }
            if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
                throw new ContentError(`pack ${manifest.id}: pack.json 缺少 version`);
            }
            if (manifest.id !== dirName) {
                throw new ContentError(`pack ${dirName}: manifest.id "${manifest.id}" 与目录名不一致`);
            }

            // 文件名即目标：<dataset>.json 写主集合，<dataset>__<collection>.json 写指定集合。
            // 有了后一种写法，一个资料片才能同时新增功法和神通（同一数据集的两个集合）。
            // 嵌套集合用多个段落表示（`spirit_beast_pvp_data__spirit_beast_pvp__tiers.json`
            // → 集合路径 spirit_beast_pvp.tiers），因为现网大玩法的条目数组普遍住在第二层。
            const files = fs.readdirSync(dir)
                .filter(name => name.endsWith('.json') && name !== 'pack.json')
                .map(name => name.replace(/\.json$/, ''))
                .sort()
                .map(key => {
                    const [dataset, ...path] = key.split('__');
                    return { key, dataset, collection: path.length ? path.join('.') : null };
                });

            this.packs.push({
                id: manifest.id,
                name: manifest.name || manifest.id,
                version: manifest.version,
                enabled: manifest.enabled !== false,
                depends: Array.isArray(manifest.depends) ? manifest.depends : [],
                priority: Number.isFinite(manifest.priority) ? manifest.priority : 100,
                files,
                datasets: [...new Set(files.map(file => file.dataset))],
                dir
            });
        }

        // priority 小的先合并，后者可覆盖前者；同优先级按 id 稳定排序
        this.packs.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
        return this.packs;
    }

    /** 构建全部数据集的合并视图并做启动期校验 */
    load() {
        this.report = { packs: [], merged: {}, warnings: [] };
        this.datasets = new Map();
        this.collectionStates = new Map();
        this.discoverPacks();

        const active = this.packs.filter(pack => pack.enabled);
        this._checkDepends(active);

        // 全部登记过的数据集都要产出视图（哪怕没有 pack 碰它），
        // 否则 ConfigLoader 回灌时会把基础内容整块丢掉
        const targets = new Set(Object.keys(DATASET_SPECS));
        for (const pack of active) for (const dataset of pack.datasets) targets.add(dataset);
        const ordered = [...targets].sort((a, b) => this._loadRank(a) - this._loadRank(b));
        for (const dataset of ordered) this._mergeDataset(dataset, active);

        this._refreshDerivedAndValidate();

        this.report.packs = this.packs.map(pack => ({
            id: pack.id, name: pack.name, version: pack.version,
            enabled: pack.enabled, priority: pack.priority,
            depends: pack.depends, datasets: pack.datasets, files: pack.files.map(file => file.key)
        }));
        return this.report;
    }

    /** stat_definitions / effect_vocabulary 必须先于其他数据集 */
    _loadRank(dataset) {
        if (dataset === 'stat_definitions') return 0;
        if (dataset === 'effect_vocabulary') return 1;
        return 2;
    }

    _checkDepends(active) {
        const present = new Set(active.map(pack => pack.id));
        for (const pack of active) {
            for (const dep of pack.depends) {
                if (!present.has(dep)) {
                    throw new ContentError(`pack ${pack.id} 依赖 ${dep}，但该 pack 不存在或未启用`);
                }
            }
        }
    }

    _mergeDataset(dataset, activePacks) {
        const spec = DATASET_SPECS[dataset];
        if (!spec) {
            const base = this._loadBase(dataset);
            if (base) this.datasets.set(dataset, base);
            for (const pack of activePacks) {
                if (pack.datasets.includes(dataset)) {
                    this.report.warnings.push(
                        `数据集 ${dataset} 未在 DATASET_SPECS 登记，pack ${pack.id} 中的同名内容未合并`
                    );
                }
            }
            return;
        }

        const baseData = this._loadBase(dataset);
        const primaryCollection = DEFAULT_COLLECTION(dataset);

        // 每个数据集可含多个集合；pack 文件用 "into" 指定目标集合，默认主集合
        const states = new Map();
        const bases = new Map();
        const passthroughs = new Map();
        for (const collection of Object.keys(spec.collections)) {
            if (!baseData) {
                states.set(collection, []);
                bases.set(collection, null);
                passthroughs.set(collection, {});
                continue;
            }
            const view = readCollection(dataset, baseData, collection);
            const viewSpec = spec.collections[collection];
            bases.set(collection, view.entries);
            passthroughs.set(collection, view.passthrough);
            states.set(collection, view.entries.map((entry, i) => ({ ...entry, __pk: keyOf(entry, viewSpec, i) })));
        }

        for (const pack of activePacks) {
            // 同一数据集可以拆成多个文件：<dataset>.json 写主集合，
            // <dataset>__<collection>.json 写指定集合（否则资料片无法既加功法又加神通）
            for (const file of pack.files.filter(entry => entry.dataset === dataset)) {
                const ops = this._readPackFile(pack, file);
                // 资料片文件的形状是"操作包"（add/override/remove/replace）或裸数组。
                // 写成 {"events": [...]} 这种"照着基础配置文件抄一份"的样子时，过去一个字都不合并、
                // 也不报错：内容层日志照样说这个 pack 装配成功。本轮写测试就正好踩在这上面，
                // 作者只会以为是合并规则坏了，所以这里直接拒。
                const hasOps = Array.isArray(ops.add)
                    || Object.keys(ops.override || {}).length > 0
                    || (ops.remove || []).length > 0 || ops.replace === true;
                if (!hasOps) {
                    throw new ContentError(
                        `pack ${pack.id}/${file.key}.json 里没有任何 add/override/remove/replace：这份内容一个字都不会被合并。`
                        + '整个文件就是条目列表请直接写裸数组，否则写 {"into": "<集合名>", "add": [ ... ]}。'
                    );
                }
                if (file.collection && ops.into && file.collection !== ops.into) {
                    throw new ContentError(
                        `pack ${pack.id}/${file.key}.json：文件名指向集合 "${file.collection}"，` +
                        `但内容里写了 into "${ops.into}"，两者必须一致`
                    );
                }
                const collection = file.collection || ops.into || primaryCollection;
                if (!spec.collections[collection]) {
                    throw new ContentError(`pack ${pack.id}/${file.key}.json 指定 into "${collection}"，但 ${dataset} 没有该集合`);
                }
                if (ops.dataset && ops.dataset !== dataset) {
                    throw new ContentError(`pack ${pack.id}/${file.key}.json 声明 dataset "${ops.dataset}" 与文件名不符`);
                }

                const next = applyOps({
                    dataset,
                    collection,
                    packId: pack.id,
                    baseEntries: states.get(collection),
                    spec: spec.collections[collection],
                    add: ops.add || [],
                    override: ops.override || {},
                    remove: ops.remove || [],
                    replace: ops.replace === true
                });
                states.set(collection, next);
                if (!Array.isArray(pack.mergedInto)) pack.mergedInto = [];
                if (!pack.mergedInto.includes(dataset)) pack.mergedInto.push(dataset);
            }
        }

        // 生成对外视图（去掉内部标记），并保留带标记版本供校验用
        this.collectionStates.set(dataset, states);
        const view = baseData === null && !activePacks.some(p => p.datasets.includes(dataset))
            ? null
            : this._composeView(dataset, baseData, primaryCollection, states, passthroughs);
        if (view !== null) this.datasets.set(dataset, view);

        const totalMerged = [...states.values()].reduce((sum, list) => sum + list.length, 0);
        const totalBase = [...bases.values()].reduce((sum, list) => sum + (list ? list.length : 0), 0);
        this.report.merged[dataset] = { base_count: totalBase, merged_count: totalMerged };
    }

    _readPackFile(pack, file) {
        const target = path.join(pack.dir, `${file.key}.json`);
        try {
            const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
            if (Array.isArray(parsed)) return { add: parsed }; // 允许裸数组：整包都是新增
            if (!isPlainObject(parsed)) throw new ContentError('内容文件既不是对象也不是数组');
            return parsed;
        } catch (error) {
            throw new ContentError(`pack ${pack.id} 的 ${file.key}.json 解析失败: ${error.message}`);
        }
    }

    _composeView(dataset, baseData, primaryCollection, states, passthroughs = new Map()) {
        const spec = DATASET_SPECS[dataset];
        const strip = (list) => list.map(entry => {
            const { __pk, ...rest } = entry;
            return rest;
        });

        let result = baseData;
        if (result === null) {
            const first = Object.keys(spec.collections)[0];
            result = spec.collections[first].root ? [] : setPath({}, first, []);
        }

        for (const collection of Object.keys(spec.collections)) {
            const collectionSpec = spec.collections[collection];
            const list = strip(states.get(collection) || []);
            if (collectionSpec.root) {
                result = list;
                continue;
            }
            result = setPath(result, collection, collectionSpec.map
                ? {
                    // map 集合：对象键即主键，_comment 之类原样带回
                    ...(passthroughs.get(collection) || {}),
                    ...Object.fromEntries((states.get(collection) || []).map(entry => {
                        const { __pk, ...rest } = entry;
                        return [__pk, rest];
                    }))
                }
                : list);
        }
        return result;
    }

    /** 带内部标记的集合条目（校验用） */
    _entriesWithMeta(dataset, collection) {
        const states = this.collectionStates.get(dataset);
        if (!states) return [];
        if (!collection) {
            return [...states.values()].flat();
        }
        return states.get(collection) || [];
    }

    _loadStatsIntoRegistry() {
        if (!this.statRegistry) return;
        const defs = this.dataset('stat_definitions')?.stats || [];
        this.statRegistry.reset();
        this.statRegistry.load(defs.map(def => ({ ...def })), 'content');
        this.statRegistry.validate();
    }

    _buildEffectVocabulary() {
        this._effectVocabulary = [];
        this._knownEffects = new Set();
        this._wildcards = new Set();
        const add = (effect) => {
            if (typeof effect.id !== 'string') return;
            this._knownEffects.add(effect.id);
            if (effect.wildcard === true) this._wildcards.add(effect.id);
            this._effectVocabulary.push({
                id: effect.id,
                label: effect.label || effect.description || effect.id,
                // ratio_pct：配置里存 0.05 这种倍率，前端要显示成 5%
                format: effect.format || null,
                wildcard: effect.wildcard === true
            });
        };
        BASE_EFFECT_VOCABULARY.forEach(add);
        // 资料片可注册新的物品效果（连同展示名），前端才不会出现"加了效果但卡片显示原始键名"
        for (const extra of this.dataset('effect_vocabulary')?.effects || []) add(extra);
    }

    /** 非属性类物品效果的展示名，供前端渲染物品卡 */
    effectVocabulary() { return this._effectVocabulary; }

    /**
     * 物品 effect 键校验：属性名拼错、或新属性忘了在 stat_definitions/pack 里声明，
     * 都在启动期报错。此前这类问题的表现是"装备上加了个字段但游戏里毫无效果"。
     */
    _validateItemEffects() {
        if (!this.statRegistry) return;
        const unknown = new Map();

        for (const item of this._entriesWithMeta('item_data', 'items')) {
            const effect = item.effect;
            if (!isPlainObject(effect)) continue;
            for (const [key, value] of Object.entries(effect)) {
                if (typeof value !== 'number') continue;
                if (this.isKnownEffectKey(key)) continue;
                if (!unknown.has(key)) unknown.set(key, []);
                unknown.get(key).push(item.id || item.__pk);
            }
        }

        if (unknown.size) {
            const detail = [...unknown.entries()]
                .map(([key, items]) => `${key} (出现在 ${items.slice(0, 3).join(', ')}${items.length > 3 ? ` 等 ${items.length} 项` : ''})`)
                .join('; ');
            throw new ContentError(
                `物品 effect 含未登记的属性键: ${detail}。` +
                `请在 stat_definitions.json（或资料片）声明该属性，或在 effect_vocabulary.json 登记为非属性效果。`
            );
        }
    }

    /**
     * 五行属性名校验：功法/神通的 element 是拿去和玩家灵根比对的字符串，
     * 拼错（例如把"金"写成 gold）不会报错，只会让契合/相克永远不命中——
     * 现网就因此静默失效过一整条机制，所以这里在启动期直接拒收。
     * 灵兽的 element 属于另一套自洽词表（spirit_beast_data.elements，含 dark），
     * 不与玩家灵根比对，因此不在此校验范围内。
     */
    _validateElements() {
        const roleInit = this._loadBase('role_init');
        const rootTypes = new Set((roleInit?.spirit_roots || []).map(root => root.type).filter(Boolean));
        if (!rootTypes.size) return; // 读不到灵根表时不拦，交给 SpiritRoot 自身的降级路径

        const bad = [];
        for (const collection of ['techniques', 'skills']) {
            for (const entry of this._entriesWithMeta('technique_data', collection)) {
                const element = entry.element;
                if (element === undefined || element === null) continue;
                if (element === 'none' || rootTypes.has(element)) continue;
                bad.push(`${collection}.${entry.__pk || entry.name}="${element}"`);
            }
        }
        if (bad.length) {
            throw new ContentError(
                `功法/神通的 element 含未知灵根名: ${bad.join(', ')}。` +
                `可用值只有 role_init.spirit_roots[].type（${[...rootTypes].join('/')}）加 'none'。`
            );
        }
    }

    /**
     * 新建角色抽灵根的概率表与灵根声明是否对得上。
     *
     * 为什么单独一道：抽的是 spiritRootProbabilities 的**中文键**，声明的是 spirit_roots 的
     * name/type，两套键之间以前没有任何校验。于是两种错都只会静默发生：
     *   ① 键写错（或灵根改名了概率表没跟着改）→ 那一档概率白给，玩家永远抽不到这条灵根；
     *   ② 加了灵根（ bonuses 也配了）却忘了给概率 → 内容层看起来齐全，实际不可获得。
     * ① 直接拒；② 只警告，因为"先声明后开放"也可能是有意的节奏。
     */
    _validateSpiritRootRoll() {
        const roleInit = this._loadBase('role_init');
        const roots = (roleInit?.spirit_roots || []).map(root => root.name).filter(Boolean);
        const probabilities = roleInit?.spiritRootProbabilities || {};
        if (!roots.length) return;

        const unknown = Object.keys(probabilities).filter(key => !roots.includes(key));
        if (unknown.length) {
            throw new ContentError(
                `role_init.spiritRootProbabilities 含未声明的灵根名: ${unknown.join('/')}。` +
                `可用键只有 role_init.spirit_roots[].name（${roots.join('/')}）—— 写错的这一档谁也抽不到。`
            );
        }
        const unrollable = roots.filter(name => !(name in probabilities));
        if (unrollable.length) {
            console.warn(
                `[ContentRegistry] 灵根 ${unrollable.join('/')} 已在 spirit_roots 声明（bonus 也配了），` +
                `但 spiritRootProbabilities 没给概率 —— 新建角色永远抽不到它。若这是"先声明后开放"可以忽略本条。`
            );
        }
    }

    /**
     * 洞府药园每条灵种的 seed_id 必须是一件真物品。
     * GardenService.plant 直接拿 seed_id 去 removeItem(playerId, seed_id, 1) ——
     * 对不上时的表现是"药园里明明列着这一味，玩家点下去永远提示种子不足"，既不报错也不提示。
     */
    _validateGardenSeeds() {
        const seeds = this.dataset('cave_data')?.cave?.garden?.seeds;
        if (!Array.isArray(seeds) || !seeds.length) return;
        const itemIds = new Set((this.dataset('item_data')?.items || []).map(i => String(i.id)));
        if (!itemIds.size) return;
        const bad = seeds.filter(s => !itemIds.has(String(s.seed_id))).map(s => s.seed_id || '(缺 seed_id)');
        if (bad.length) {
            throw new ContentError(
                `洞府药园灵种的 seed_id 不是真物品（种植时按 seed_id 扣背包）: ${bad.join('/')}。`
                + '请在 item_data 补一件同名物品，或把 seed_id 改成已有种子的 item_key。'
            );
        }
    }

    /**
     * 历练事件的 type 必须先在 event_types 里声明。
     * selectEventType 只按 event_types 的 weight 抽类型，没声明的那一类永远不会被抽到 ——
     * 资料片加了新事件却忘了加类型，表现就是"内容装进来了，玩家一辈子碰不到"，而且两头都不报错。
     */
    _validateAdventureEvents() {
        const data = this.dataset('adventure_event_data');
        const events = data?.events;
        if (!Array.isArray(events) || !events.length) return;
        const types = data.event_types || {};
        if (!Object.keys(types).length) {
            throw new ContentError(
                'adventure_event_data 有事件却没有 event_types —— 类型表决定抽不抽得到这一类、'
                + '标题叫什么、AI 事件给多少保底经验，缺它等于历练发不出事件。'
            );
        }
        const unknown = events.filter(e => !types[e.type]).map(e => `${e.id}="${e.type}"`);
        if (unknown.length) {
            throw new ContentError(
                `历练事件的 type 没在 adventure_event_data.event_types 里声明: ${unknown.join(', ')}。`
                + `已声明的类型：${Object.keys(types).join('/') || '(一个都没有)'}。`
            );
        }
        // rewards.items 只认"物品键数组"这一种形状。服务里写的是 `if (items && Array.isArray(items))`，
        // 所以 `items: true` 这类配置等于"承诺发东西、永远不发"，两头都不报错（现网 combat_1 就是这样一条）。
        const itemIds = new Set((this.dataset('item_data')?.items || []).map(i => String(i.id)));
        const badShape = [];
        const unknownItems = [];
        for (const e of events) {
            const it = e?.rewards?.items;
            if (it === undefined || it === null) continue;
            if (!Array.isArray(it)) { badShape.push(`${e.id}=${JSON.stringify(it)}`); continue; }
            for (const k of it) if (!itemIds.has(String(k))) unknownItems.push(`${e.id}:${k}`);
        }
        if (badShape.length) {
            throw new ContentError(
                `历练事件的 rewards.items 必须是物品键数组，现在是 ${badShape.join(', ')}。`
                + '写 true/字符串都会被服务当"没有物品"静默跳过；战斗掉落走 drop_data，不填这个键就行。'
            );
        }
        if (unknownItems.length) {
            throw new ContentError(
                `历练事件引用了 item_data 里不存在的物品: ${unknownItems.join(', ')}。`
                + '背包里只会留下一条查不出名字的裸 id，等于没发；请在 item_data 补同名物品或改掉引用。'
            );
        }
        const unreachable = Object.entries(types)
            .filter(([, cfg]) => !(Number(cfg?.weight) > 0))
            .map(([id]) => id);
        if (unreachable.length) {
            console.warn(
                `[ContentRegistry] 历练事件类型 ${unreachable.join('/')} 的 weight 不是正数 —— 这一类永远不会被抽到。`
                + `若这是"先声明后开放"可以忽略本条。`
            );
        }
    }

    /**
     * 神通 effects 键校验。这些键过去无人消费（配了也只是文案），现在有 CombatResolver
     * 的战斗特效与功法属性折叠两条落地路径，所以拼错的键必须启动期失败，
     * 而不是像以前那样"领悟了一条永远不触发的大招"。
     */
    _validateSkillEffects() {
        const unknown = [];
        const unregistered = [];
        for (const entry of this._entriesWithMeta('technique_data', 'skills')) {
            if (!isPlainObject(entry.effects)) continue;
            for (const [key, value] of Object.entries(entry.effects)) {
                if (!isKnownSkillEffectKey(key)) {
                    unknown.push(`${entry.__pk}.${key}`);
                    continue;
                }
                const statSpec = SKILL_STAT_EFFECTS[key];
                if (statSpec && this.statRegistry && !this.statRegistry.has(statSpec.stat)) {
                    unregistered.push(`${entry.__pk}.${key}→${statSpec.stat}`);
                }
                const num = Number(value);
                if (!Number.isFinite(num)) unknown.push(`${entry.__pk}.${key}=${value}`);
            }
        }
        if (unknown.length || unregistered.length) {
            const vocab = skillEffectVocabulary();
            throw new ContentError(
                `神通 effects 校验失败：` +
                (unknown.length ? `未知特效键 ${unknown.join(', ')}；` : '') +
                (unregistered.length ? `目标属性未注册 ${unregistered.join(', ')}；` : '') +
                `可用键：${vocab.trigger} / 属性类 ${vocab.stats.join('/')} / 战斗类 ${vocab.procs.join('/')}` +
                `（数值一律用小数，0.15 表示 15%）。`
            );
        }
    }

    _validateReferences() {
        const errors = [];
        for (const ref of REFERENCES) {
            const spec = DATASET_SPECS[ref.dataset]?.collections?.[ref.collection];
            if (!spec) continue;
            const targetEntries = this._entriesWithMeta(ref.target, DEFAULT_COLLECTION(ref.target));
            const targetSpec = DATASET_SPECS[ref.target].collections[DEFAULT_COLLECTION(ref.target)];
            const targetKeys = new Set(targetEntries.map((entry, i) => keyOf(entry, targetSpec, i)));

            for (const entry of this._entriesWithMeta(ref.dataset, ref.collection)) {
                const candidates = ref.nested && Array.isArray(entry[ref.nested]) ? entry[ref.nested] : [entry];
                for (const candidate of candidates) {
                    if (!isPlainObject(candidate)) continue;
                    const value = candidate[ref.field];
                    if (value === undefined || value === null) continue;
                    if (!targetKeys.has(String(value))) {
                        errors.push(`${ref.dataset}.${ref.collection} 引用了不存在的 ${ref.target} 条目 "${value}"`);
                    }
                }
            }
        }
        if (errors.length) {
            throw new ContentError(`内容引用完整性校验失败:\n  - ${[...new Set(errors)].join('\n  - ')}`);
        }
    }

    /**
     * 掉落表指向的怪，必须是某张地图上真会刷出来的怪。
     *
     * 为什么单独一道：既有的掉落校验只管"item_id 存不存在"，于是资料片自己新造一个 monster_id
     * 时全部通过，而那张掉落表永远不会触发——内容加了，玩家一件也拿不到，且没有任何地方报错。
     * 这是"静默不生效"里最难发现的一类，只能靠这道闸。
     */
    _validateDropMonsters() {
        const maps = this.dataset('map_data')?.maps || {};
        const spawnable = new Set();
        for (const map of Object.values(maps)) {
            for (const monster of (map?.monsters || [])) {
                const id = typeof monster === 'string' ? monster : (monster?.id || monster?.monster_id);
                if (id) spawnable.add(id);
            }
        }
        // 只喂了部分数据集的单元测试里地图数据可能整个缺席，这时不做判定（宁可漏判也不误伤）
        if (!spawnable.size) return;

        const orphans = [];
        for (const entry of this._entriesWithMeta('drop_data', 'drops')) {
            if (entry?.monster_id && !spawnable.has(entry.monster_id)) orphans.push(entry.monster_id);
        }
        if (orphans.length) {
            throw new ContentError(
                `掉落表指向了地图上不会刷出的怪：${[...new Set(orphans)].join(', ')}。`
                + '这些掉落永远不会发生——请把掉落挂到已有的怪上，或在某张地图的 monsters 里真的把它加进去。'
            );
        }
    }

    /**
     * 境界链必须逐级相连、名字唯一。
     *
     * 为什么单独一道：realm_breakthrough 是资料片可增删的数据集，而境界之间的"下一境"
     * 是靠 rank 连续隐式成立的（配置里没有 next 指针）。删掉中间一个境界，配置自身看不出任何破绽，
     * 但两件事当场坏掉：突破链在那里断掉，而正卡在那个境界上的玩家 —— players.realm 存的是**名字**，
     * 从此查无此境界，表现是突破面板报"境界配置不存在"，不是"内容少了一条"。
     * 与掉落表那道闸同一类：坏在数据里，长在玩家身上。
     */
    _validateRealmChain() {
        const realms = this._entriesWithMeta('realm_breakthrough', 'realms');
        // 只喂了部分数据集的单元测试里这份配置可能整个缺席（宁可漏判也不误伤）
        if (!realms.length) return;

        const problems = [];
        const byRank = new Map();
        const names = new Set();
        for (const realm of realms) {
            const label = realm?.name || realm?.id || '(无名字无 id)';
            const rank = Number(realm?.rank);
            if (!Number.isInteger(rank)) {
                problems.push(`${label} 的 rank 不是整数（${JSON.stringify(realm?.rank)}）`);
                continue;
            }
            if (byRank.has(rank)) problems.push(`rank ${rank} 被 ${byRank.get(rank)} 和 ${label} 同时占用`);
            else byRank.set(rank, label);

            const name = String(realm?.name ?? '').trim();
            // 名字是 players.realm 里存的值：重名等于两个境界挤同一个键，查出来永远是先命中的那个
            if (!name) problems.push(`境界 ${realm?.id || rank} 没有 name，玩家身上没法存`);
            else if (names.has(name)) problems.push(`境界名字重复：${name}`);
            else names.add(name);
        }

        const ordered = [...byRank.keys()].sort((a, b) => a - b);
        for (let i = 1; i < ordered.length; i++) {
            if (ordered[i] !== ordered[i - 1] + 1) {
                problems.push(`rank ${ordered[i - 1] + 1} 缺失：境界链在「${byRank.get(ordered[i - 1])}」之后断了`);
            }
        }

        if (problems.length) {
            throw new ContentError(`境界链不完整：${[...new Set(problems)].join('；')}。`
                + '资料片可以加境界，但不要删掉或改号基础链里的境界 —— 玩家身上存的是境界名字。'
            );
        }
    }

    /**
     * 怪物声明的属性必须是注册表里的属性。
     *
     * 为什么单独一道：怪物属性现在由内容驱动（map_data 里 `stats: { crit_rate: 15 }` 就直接进结算），
     * 而结算侧读的是"属性块里的键"—— 一个拼错的键（`crit_change`）不会报错，只会永远不生效，
     * 表现是"我明明给这只怪加了暴击，它怎么从来不暴击"。这正是这一整套改造要消灭的那类静默失效。
     */
    _validateCombatStatBlocks() {
        const problems = [];
        let sawAnyEnemy = false;

        // 实例行撑腰的敌人（世界 BOSS / 兽潮妖兽）：这些数值以行为准，内容里再声明一遍就是两个真相
        const INSTANCE_OWNED_STATS = ['atk', 'def', 'speed', 'hp_max', 'max_hp', 'hp'];

        const checkEnemy = (label, enemy, reserved = []) => {
            if (!enemy || typeof enemy !== 'object') return;
            sawAnyEnemy = true;

            if (enemy.power_multiplier !== undefined) {
                const factor = Number(enemy.power_multiplier);
                if (!Number.isFinite(factor) || factor <= 0) {
                    problems.push(`${label} 的 power_multiplier 不是正数：${JSON.stringify(enemy.power_multiplier)}`);
                }
            }
            if (enemy.stats === undefined) return;
            if (!enemy.stats || typeof enemy.stats !== 'object' || Array.isArray(enemy.stats)) {
                problems.push(`${label} 的 stats 必须是对象（写属性键:数值）`);
                return;
            }
            for (const [key, value] of Object.entries(enemy.stats)) {
                if (reserved.includes(key)) {
                    problems.push(`${label} 在 stats 里声明了 ${key}：这个值以敌人实例行/配置里的基础字段为准，声明不会生效（请改 base_atk/base_def/base_hp 那一层）`);
                    continue;
                }
                if (!Number.isFinite(Number(value))) {
                    problems.push(`${label} 的属性 ${key} 不是数值：${JSON.stringify(value)}`);
                    continue;
                }
                // 没接注册中心的调用方（有的单测只要合并结果）不做"属性是否登记"判定
                if (this.statRegistry && !this.statRegistry.resolveStatKey(key)) {
                    problems.push(`${label} 声明了未注册的属性 "${key}"（结算读不到它，这只怪不会有任何效果）`);
                }
            }
        };

        // 野外怪（map_data）
        const maps = this.dataset('map_data')?.maps || {};
        for (const map of Object.values(maps)) {
            for (const monster of (map?.monsters || [])) checkEnemy(`${map?.id ?? '?'}/${monster?.id || '(无 id)'}`, monster);
        }

        // 副本怪与副本 BOSS（dungeon_data：节点上的 monster、章节末尾的 boss）
        for (const chapter of (this.dataset('dungeon_data')?.chapters || [])) {
            checkEnemy(`${chapter?.id || '?'}/boss`, chapter?.boss);
            for (const node of (chapter?.nodes || [])) {
                if (node?.monster) checkEnemy(`${chapter?.id}/${node?.id}`, node.monster);
            }
        }

        // 世界 BOSS 与兽潮妖兽（实例行上只有 atk/def/speed/hp，触发属性只能从静态声明来）
        for (const boss of (this.dataset('world_boss_data')?.bosses || [])) {
            checkEnemy(`world_boss/${boss?.boss_key || '?'}`, boss, INSTANCE_OWNED_STATS);
        }
        for (const beast of (this.dataset('beast_invasion_data')?.beasts || [])) {
            checkEnemy(`beast_invasion/${beast?.beast_key || '?'}`, beast, INSTANCE_OWNED_STATS);
        }

        // 灵兽探渊每层抽的怪：条目自己就带 atk/def/hp/speed，再在 stats 里写一遍同样是两个真相
        const ABYSS_OWNED = [...INSTANCE_OWNED_STATS, 'exp_reward', 'key', 'name', 'element'];
        for (const floor of (this.dataset('spirit_beast_abyss_data')?.floors || [])) {
            for (const monster of (floor?.monsters || [])) {
                checkEnemy(`beast_abyss/第${floor?.floor ?? '?'}层/${monster?.key || '?'}`, monster, ABYSS_OWNED);
            }
        }

        // 切磋木人：这份的 stats 就是属性块本身（max_hp/atk/def/speed），不是覆盖层，
        // 所以不做"与基础字段重名"的判定，但键名同样必须登记过 —— 木人写个 crit_change
        // 永远不会有人读，而玩家与策划都会以为那只木人会暴击。
        // HP 的几种叫法（hp/max_hp/hp_max）按存储别名放行：它们是各来源的列名，不是属性键。
        const { HP_KEYS } = require('../combat/CombatStats');
        for (const woodman of (this.dataset('sparring_woodman')?.woodmen || [])) {
            const label = `sparring/${woodman?.key || '?'}`;
            sawAnyEnemy = true;
            if (woodman?.power_multiplier !== undefined) {
                const factor = Number(woodman.power_multiplier);
                if (!Number.isFinite(factor) || factor <= 0) {
                    problems.push(`${label} 的 power_multiplier 不是正数：${JSON.stringify(woodman.power_multiplier)}`);
                }
            }
            const block = woodman?.stats;
            if (!block || typeof block !== 'object' || Array.isArray(block)) {
                problems.push(`${label} 缺少 stats 属性块（切磋战斗直接读它）`);
                continue;
            }
            for (const [key, value] of Object.entries(block)) {
                if (!Number.isFinite(Number(value))) {
                    problems.push(`${label} 的属性 ${key} 不是数值：${JSON.stringify(value)}`);
                } else if (this.statRegistry && !this.statRegistry.resolveStatKey(key) && !HP_KEYS.includes(key)) {
                    problems.push(`${label} 声明了未注册的属性 "${key}"（结算读不到它，这个木人不会有任何效果）`);
                }
            }
        }

        // 出战/护法傀儡（友方战斗单位）：base_stats 是它的属性块，PuppetService 折算整块进战斗，
        // 所以这里的规则与敌人一模一样 —— 写一个没登记的键不会报错，只是永远不会生效。
        // 连等级增长率（quench.stat_growth_rate）一起查：那一份以前只有 atk/speed 真的被读，
        // def/hp 两档写了也没人看，正是"改了数值没反应"那一类。
        const puppetData = this.dataset('puppet_data');
        for (const [typeKey, typeCfg] of Object.entries(puppetData?.puppet_types || {})) {
            const block = typeCfg?.base_stats;
            if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
            sawAnyEnemy = true;
            for (const [key, value] of Object.entries(block)) {
                if (!Number.isFinite(Number(value))) {
                    problems.push(`puppet/${typeKey} 的属性 ${key} 不是数值：${JSON.stringify(value)}`);
                } else if (this.statRegistry && !this.statRegistry.resolveStatKey(key) && !HP_KEYS.includes(key)) {
                    problems.push(`puppet/${typeKey} 声明了未注册的属性 "${key}"（傀儡折算时读不到它）`);
                }
            }
        }
        for (const key of Object.keys(puppetData?.quench?.stat_growth_rate || {})) {
            if (this.statRegistry && !this.statRegistry.resolveStatKey(key) && !HP_KEYS.includes(key)) {
                problems.push(`puppet 的等级增长率写了未登记的属性 "${key}"（没有一只傀儡会因此变强）`);
            }
        }

        // 只喂了部分数据集的单元测试里这两份配置可能整个缺席（宁可漏判也不误伤）
        if (!sawAnyEnemy) return;
        if (problems.length) {
            throw new ContentError(`战斗单位属性声明校验失败：\n  - ${[...new Set(problems)].join('\n  - ')}`);
        }
    }

    /** 合并后的数据集视图（已含资料片内容），形状与基础 config 文件一致 */
    dataset(name) { return this.datasets.get(name) || null; }

    /** 已登记的数据集名（后台按这份名单出下拉，不在名单里的数据集直接拒） */
    static get registeredDatasets() { return Object.keys(DATASET_SPECS); }

    /**
     * 某个集合的"主键 + 显示名"清单，给 GM 面板当下拉的数据源。
     *
     * 为什么要有：后台三个面板（侍妾 / 宗门 / 灵兽）以前各自抄了一份主键清单，
     * 资料片加一条内容，下拉里就没有它 —— 而服务端一直是按内容认的，本来选得出来。
     * 显示名按 name / display_name / title / label / <主键字段去 _key>_name 的顺序找，都没有就用主键。
     * @param {string} datasetName 已登记数据集名
     * @param {string|null} collectionName 集合名，省略则取该数据集的第一个集合
     * @returns {Array<{key: string, name: string, collection: string}>}
     */
    entryOptions(datasetName, collectionName = null) {
        const spec = DATASET_SPECS[datasetName];
        if (!spec) throw new ContentError(`数据集未登记，不能按内容出清单: ${datasetName}`);
        const name = collectionName || Object.keys(spec.collections || {})[0];
        if (!spec.collections[name]) throw new ContentError(`数据集 ${datasetName} 未登记集合 ${name}`);
        const data = this.dataset(datasetName);
        if (!data) throw new ContentError(`数据集未加载: ${datasetName}`);
        const { spec: colSpec, entries } = readCollection(datasetName, data, name);
        const stem = (colSpec.key || 'id').replace(/_key$/, '');
        return entries.map((entry, i) => {
            const key = keyOf(entry, colSpec, i);
            const label = entry.name ?? entry.display_name ?? entry.title ?? entry.label ?? entry[`${stem}_name`] ?? key;
            return { key, name: String(label), collection: name };
        });
    }

    /** 全部合并视图，供 ConfigLoader 回灌 */
    mergedDatasets() { return this.datasets; }

    /**
     * 深扫所有已合并的数据集：凡是长得像"物品引用"的字段（item_key / item_id / material_key /
     * xxx_item_key / xxx_item_id），值必须是真的物品 id。
     *
     * 为什么不只用 REFERENCES 那张表：REFERENCES 要一行行写"哪个数据集哪个集合的哪个字段"，
     * 而法宝深度这类配置是**任意深度嵌套**的（stages[].materials[].item_key、
     * thunder_wash.materials_tianlei[].item_key…），一行行列既写不完也一定会漏。
     * 漏掉的表现很难看：玩家在炼焰/祭炼进行到一半时才撞上"物品配置不存在"，
     * 整笔事务回滚 —— 材料扣了、进度没动，或者直接报内部错误。
     * 按字段名匹配是刻意的宽松：宁可多扫一些，也不要让一处引用没人管。
     */
    _validateItemKeysDeep() {
        const itemIds = new Set((this.dataset('item_data')?.items || []).map(i => String(i.id)));
        if (!itemIds.size) return;
        // 第三种形状：一个字段直接是一串物品 id 的数组（访客遭遇的 rewards.item_pool、
        // 各种"随机发一件"的池子）。以前这类字段名不在匹配里，池子里写个不存在的物品
        // 不会有任何信号 —— 玩家撞上那次遭遇就是"什么都没拿到"。
        const pattern = /^(item_key|item_id|material_key|[a-z_]+_item_key|[a-z_]+_item_id|item_pools?|[a-z_]+_item_pools?)$/;
        // 第二种形状：引用藏在"物品数组"的元素里，字段名只是 key
        // （慕兰战线的 military_shop.items[].key、support_routes.*.item_drops[].key、
        //   milestones.thresholds[].rewards.items[].key 都是这个写法）。
        // 光靠字段名匹配永远够不着它们 —— 那 4 个不存在的物品 id 就是这么躺到现在的。
        const itemArrayField = /^(items|item_drops|drop_items|rewards_items)$/;
        const offenders = [];
        const matchedExemptions = new Set();

        const reportMissing = (at, item) => {
            if (typeof item !== 'string' || itemIds.has(item)) return true;
            const ref = OPTIONAL_ITEM_REFS.find(r => r.at === at && (r.item === undefined || r.item === item));
            if (ref) { matchedExemptions.add(ref.at); return true; }
            offenders.push(`${at} = "${item}"`);
            return false;
        };

        const walk = (node, where, depth) => {
            if (depth > 8 || node == null || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node)) {
                const at = `${where}.${key}`;
                if (pattern.test(key)) {
                    const list = Array.isArray(value) ? value : [value];
                    for (const item of list) reportMissing(at, item);
                    continue;
                }
                if (itemArrayField.test(key) && Array.isArray(value)) {
                    for (const row of value) {
                        // 数组元素直接就是物品 id（历练事件的 rewards.items: ['spirit_herb']）。
                        // 以前这里只认对象元素，于是"裸 id 数组"整体绕过校验 —— ancient_token 就是靠这个
                        // 缝隙指着一条不存在的物品：发奖时照发，玩家拿到的是一条查不出名字的背包行。
                        // 同一条缝隙放大扫描后立刻又抓到 beast_invasion 的三枚伏妖令（全场广播的结算摘要里
                        // 印的就是裸键），可见这类引用不是孤例。
                        if (typeof row === 'string') { reportMissing(`${at}[]`, row); continue; }
                        if (!row || typeof row !== 'object' || !('key' in row)) continue;
                        // 索引不进路径：豁免表要能写稳定路径，也不能因为数组顺序变一下就失效
                        reportMissing(`${at}[].key`, row.key);
                    }
                }
                walk(value, at, depth + 1);
            }
        };

        for (const [dataset, data] of this.datasets.entries()) {
            if (dataset === 'item_data') continue;
            walk(data, dataset, 0);
        }

        // 豁免条目也会过期：物品补上了、或键被删了，留着它只会让"这条闸到底还管不管"再次变得看不清楚
        for (const ref of OPTIONAL_ITEM_REFS) {
            if (!matchedExemptions.has(ref.at)) {
                console.warn(`[ContentRegistry] 物品引用豁免已失效：${ref.at} 现在没有指向缺失的物品，请删掉这条例外`);
            }
        }

        if (offenders.length) {
            throw new ContentError(
                `内容里有物品引用指向不存在的物品（先补物品，或把引用改掉）:\n  - ${[...new Set(offenders)].join('\n  - ')}`
            );
        }
    }

    /**
     * 派生状态 + 全量校验：属性装进注册表、效果词表重建、四道引用/键名校验。
     * 启动期（load）和热更（reload）必须走同一个方法，否则"改基础配置"这条路径会绕过闸门：
     * 后台把一个拼错的属性键写进 item_data 时，表现不是报错而是玩家身上凭空少一份加成。
     */
    _refreshDerivedAndValidate() {
        this._loadStatsIntoRegistry();
        this._buildEffectVocabulary();
        this._validateItemEffects();
        this._validateElements();
        this._validateSpiritRootRoll();
        this._validateGardenSeeds();
        this._validateAdventureEvents();
        this._validateSkillEffects();
        this._validateReferences();
        this._validateItemKeysDeep();
        this._validateDropMonsters();
        this._validateRealmChain();
        this._validateCombatStatBlocks();
        this._validateDungeonChoiceVars();
        this._validateDungeonVariableLabels();
        this._validateDungeonRewardTypeLabels();
        this._validateArtifactSpiritLabels();
        this._validateSectBonusLabels();
    }

    /**
     * 器灵类型的展示元数据必须齐：加成键要有中文名，护主/催发效果要有标签与换算方式。
     *
     * 为什么算闸：面板以前自己抄了一份 4 档器灵的文案（连数值都抄成文本，如"攻击 +5%（每级 +2%）"）。
     * 内容改数值或加一档，界面不会跟着变 —— 抄的那份平灵型就已经漏了"暴击 +1%"。
     * 现在文案由服务端按内容数值拼（`ArtifactSpiritService.spiritTypeCatalog`），缺标签只能在这里响。
     */
    _validateArtifactSpiritLabels() {
        const data = this.datasets.get('artifact_spirit_data');
        const types = data && data.spirit_types;
        if (!types || typeof types !== 'object') return;
        const statLabels = data.spirit_bonus_stat_labels || {};
        const effectLabels = data.spirit_effect_labels || {};
        const errors = [];
        for (const [key, cfg] of Object.entries(types)) {
            for (const field of ['base_bonus', 'level_bonus_per_level']) {
                for (const stat of Object.keys((cfg && cfg[field]) || {})) {
                    if (!contentLabel(statLabels[stat])) {
                        errors.push(`spirit_types.${key}.${field} 的加成键 ${stat} 没有中文名（spirit_bonus_stat_labels）`);
                    }
                }
            }
            for (const field of ['protect_effect', 'activate_effect']) {
                const code = cfg && cfg[field];
                if (!code) continue;
                const meta = effectLabels[code];
                if (!contentLabel(meta)) {
                    errors.push(`spirit_types.${key}.${field}=${code} 在 spirit_effect_labels 里没有中文标签`);
                } else if (!['percent', 'none'].includes(meta.value_format)) {
                    errors.push(`spirit_types.${key}.${field}=${code} 的 value_format=${JSON.stringify(meta.value_format)}，只支持 percent/none`);
                }
            }
        }
        if (errors.length) {
            throw new ContentError(`器灵展示元数据校验失败:\n  - ${errors.join('\n  - ')}`);
        }
    }

    /**
     * 奖励条目的 type 必须有中文名：`multi_dungeon_data.global.reward_type_labels` 是奖励池
     * 显示名称的唯一来源（`_getRewardDisplayName` 只读这一份）。
     *
     * 为什么算闸：服务原来手写了一份 7 个类型的表，内容里第 8 种类型（sect_contribution）一出现，
     * 奖励池界面就把裸键名当奖励名印出来，而且没有任何异常 —— 只有启动期能钉住。
     */
    _validateDungeonRewardTypeLabels() {
        const data = this.datasets.get('multi_dungeon_data');
        const dungeons = data && data.dungeons;
        if (!dungeons || typeof dungeons !== 'object') return;
        const labels = (data.global && data.global.reward_type_labels) || {};
        const missing = new Set();
        const walk = (node, at) => {
            if (Array.isArray(node)) {
                for (const [i, row] of node.entries()) walk(row, `${at}[${i}]`);
                return;
            }
            if (!node || typeof node !== 'object') return;
            if (typeof node.type === 'string' && !contentLabel(labels[node.type])) missing.add(`${at} → ${node.type}`);
            for (const [key, value] of Object.entries(node)) {
                if (key === '_note') continue;
                if (value && typeof value === 'object') walk(value, `${at}.${key}`);
            }
        };
        for (const [key, dungeon] of Object.entries(dungeons)) walk((dungeon && dungeon.rewards) || {}, key);
        if (missing.size) {
            throw new ContentError(`副本奖励类型缺少中文标签（global.reward_type_labels）:\n  - ${[...missing].join('\n  - ')}`);
        }
    }

    /**
     * 宗门加成字段必须有展示元数据：`sect_data.global.bonus_labels` 是面板拿中文名与换算方式的唯一来源。
     *
     * 为什么算闸：客户端原来自己抄了一份 10 条字典，并且**按字典的键顺序去过滤** bonus ——
     * 内容里新增一种宗门加成而字典没跟上时，那行加成在面板上凭空消失，服务端与客户端都不报错。
     * 现在字典删了，缺元数据的后果仍然只会表现为"少一行"，所以只能在启动期钉。
     * format 只认两种：multiplier（1.1 → +10%）、ratio（0.15 → +15%）。
     */
    _validateSectBonusLabels() {
        const data = this.datasets.get('sect_data');
        if (!data) return;
        const labels = (data.global && data.global.bonus_labels) || {};
        const errors = [];

        for (const [key, meta] of Object.entries(labels)) {
            if (!contentLabel(meta)) {
                errors.push(`bonus_labels.${key} 没有中文 label`);
            } else if (!['multiplier', 'ratio'].includes(meta.format)) {
                errors.push(`bonus_labels.${key} 的 format=${JSON.stringify(meta && meta.format)}，只支持 multiplier/ratio`);
            }
        }

        const missing = new Set();
        for (const sect of (Array.isArray(data.sects) ? data.sects : [])) {
            for (const key of Object.keys((sect && sect.bonus) || {})) {
                if (!contentLabel(labels[key])) missing.add(key);
            }
        }
        if (missing.size) {
            errors.push(`sects[].bonus 用到了 bonus_labels 里没有的加成键：${[...missing].sort().join(', ')}`);
        }

        if (errors.length) throw new ContentError(`宗门加成展示元数据校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 副本变量必须有中文名：面板的外发清单与标签是同一份内容（`global.variable_labels`），
     * 少了标签不会报错给玩家，只会"这个变量永远不显示"——服务算得再对也没人看得见。
     */
    _validateDungeonVariableLabels() {
        const data = this.datasets.get('multi_dungeon_data');
        const dungeons = data && data.dungeons;
        if (!dungeons || typeof dungeons !== 'object') return;
        const global = (data.global && data.global.variable_labels) ? data.global : {};
        const labels = global.variable_labels || {};
        // "通用变量"的判据用内容自身：global 里写了 <变量>_min / <变量>_max 的那六个（士气/警戒/魔染/封印/神魂/收获倍率）
        const common = new Set(Object.keys(global)
            .filter(key => /_min$|_max$/.test(key))
            .map(key => key.replace(/_min$|_max$/, '')));

        const declared = new Set();
        for (const dungeon of Object.values(dungeons)) {
            for (const key of Object.keys(dungeon || {})) {
                if (key.startsWith('init_')) {
                    const name = key.slice('init_'.length);
                    if (common.has(name)) declared.add(name);
                }
            }
            for (const column of Object.keys(dungeon.instance_vars || {})) declared.add(column);
        }
        const missing = [...declared].filter(name => !contentLabel(labels[name]));
        if (missing.length) {
            throw new ContentError(`副本变量缺少 variable_labels 标签（前端面板不会显示这些变量）：${missing.sort().join(', ')}`);
        }
    }

    /**
     * 多人副本：内容里写的"抉择变量键"必须能被这个副本自己声明的词汇解释。
     *
     * 起因是黄龙山（migration_0060）：内容按短名写（eye_position / resonance_count_change /
     * contribution_score_self_change），服务与抉择记录表按带前缀的列名读
     * （huanglong_eye_position / huanglong_resonance_count_change…），两边对不上时**不报错**，
     * 抉择接口照样返回成功，只是阵眼/共鸣/贡献/叛道全都不生效 —— 玩家看得到文案，看不到结果。
     *
     * 判据只用内容自身，不认识任何代码里的清单：把键去掉后缀得到词干，词干必须是
     *   ① 通用变量之一（由各副本的 `init_<变量>` 初值键推出），或
     *   ② 该副本 `instance_vars` / `member_vars` 声明过的列名（含带 `<副本名>_` 前缀的形式）。
     * 资料片要加新副本变量：在 instance_vars / member_vars 里声明即可，这条校验与服务侧
     * MultiDungeonService._canonicalizeVarKeys 用的是同一份词汇。
     */
    _validateDungeonChoiceVars() {
        const data = this.datasets.get('multi_dungeon_data');
        const dungeons = data && data.dungeons;
        if (!dungeons || typeof dungeons !== 'object') return;

        const SUFFIXES = ['_others_change_highest', '_self_change', '_others_change', '_change', '_self', ''];
        const common = new Set(Object.values(dungeons)
            .flatMap(dungeon => Object.keys(dungeon || {}))
            .filter(key => key.startsWith('init_'))
            .map(key => key.slice('init_'.length)));

        const problems = [];
        for (const [dungeonKey, dungeon] of Object.entries(dungeons)) {
            const declared = new Set([
                ...Object.keys(dungeon.instance_vars || {}),
                ...Object.keys(dungeon.member_vars || {})
            ]);
            const seen = new Set();
            const walk = node => {
                if (Array.isArray(node)) return node.forEach(walk);
                if (!node || typeof node !== 'object') return;
                for (const [key, value] of Object.entries(node)) {
                    if (typeof value !== 'object' && /_change$|_self$|_others$|_position$/.test(key) && !seen.has(key)) {
                        seen.add(key);
                        const suffix = SUFFIXES.find(s => key.endsWith(s) && key.length > s.length);
                        const stem = suffix === undefined ? key : key.slice(0, key.length - suffix.length);
                        if (!common.has(stem) && !declared.has(stem) && !declared.has(`${dungeonKey}_${stem}`)) {
                            problems.push(`${dungeonKey} 的抉择键 ${key}（变量 ${stem}）没有声明：既不是通用变量，也不在 ${dungeonKey} 的 instance_vars / member_vars 里`);
                        }
                    }
                    walk(value);
                }
            };
            walk(dungeon.acts);
        }
        if (problems.length) {
            throw new ContentError(`副本抉择变量词汇对不上（这些抉择会静默不生效）：\n  ${problems.join('\n  ')}`);
        }
    }

    /**
     * 基础配置被改写后重新合并一个数据集。
     * 校验不过时把这一份数据集退回上一版通过校验的视图再抛错——调用方（ConfigLoader）会
     * 连带把运行时缓存退回旧值，于是一次失败的编辑不会让线上突然看不到资料片内容。
     */
    reload(dataset) {
        const active = this.packs.filter(pack => pack.enabled);
        const hadPrevious = this.datasets.has(dataset);
        const previous = this.datasets.get(dataset);
        try {
            this._mergeDataset(dataset, active);
            this._refreshDerivedAndValidate();
            return this.dataset(dataset);
        } catch (error) {
            if (hadPrevious) this.datasets.set(dataset, previous);
            else this.datasets.delete(dataset);
            try {
                this._refreshDerivedAndValidate();   // 退回旧视图后，派生状态也要跟着复原
            } catch (rollbackError) {
                console.error(`[ContentRegistry] 回滚 ${dataset} 的派生状态失败:`, rollbackError.message);
            }
            throw error;
        }
    }

    isKnownEffectKey(key) {
        if (this._knownEffects.has(key)) return true;
        if (!this.statRegistry) return true; // 未接注册中心时不做属性校验
        return Boolean(this.statRegistry.resolveStatKey(key));
    }

    /** 通配效果（如 all_stats_bonus）在属性系统里展开为全部已注册属性 */
    wildcardEffectKeys() { return [...this._wildcards]; }

    /** 启动自检 / 后台展示用 */
    status() {
        const datasets = {};
        for (const [dataset] of this.datasets.entries()) {
            datasets[dataset] = this._entriesWithMeta(dataset).length;
        }
        return { packs: this.report.packs, datasets, warnings: this.report.warnings };
    }
}

module.exports = {
    ContentRegistry,
    ContentError,
    DATASET_SPECS,
    BASE_EFFECT_VOCABULARY,
    REFERENCES,
    applyOps,
    contentLabel,
    isPlainObject
};
