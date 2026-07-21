/**
 * 游戏全局常量定义
 *
 * 包含：
 * 1. 灵根属性枚举与中文名映射
 * 2. 境界顺序数组 REALM_ORDER（与 realm_breakthrough.json 严格对齐）
 * 3. 大境界名 → 最低 rank 映射 REALM_TIER_MIN_RANK
 *
 * 设计原则：
 * - REALM_ORDER 仅用于"按境界名称查找索引"的简单场景
 * - 涉及境界比较（min_realm 校验、境界门槛判断等）应使用 RealmService.getRealmRank()
 *   配合 RealmService.resolveMinRealmRank() 完成"大境界名→最低 rank"的解析
 * - 避免在业务代码中直接使用 REALM_ORDER.indexOf 比较境界，因为
 *   "筑基期"这种大境界名并不在 REALM_ORDER 中（玩家实际境界是"筑基初期"等）
 */

// 灵根属性枚举
const ATTRIBUTES = {
    METAL: 'metal', // 金
    WOOD: 'wood',   // 木
    WATER: 'water', // 水
    FIRE: 'fire',   // 火
    EARTH: 'earth', // 土
    THUNDER: 'thunder', // 雷
    ICE: 'ice',     // 冰
    WIND: 'wind'    // 风
};

// 灵根属性中文名映射
const ATTRIBUTE_NAMES = {
    [ATTRIBUTES.METAL]: '金',
    [ATTRIBUTES.WOOD]: '木',
    [ATTRIBUTES.WATER]: '水',
    [ATTRIBUTES.FIRE]: '火',
    [ATTRIBUTES.EARTH]: '土',
    [ATTRIBUTES.THUNDER]: '雷',
    [ATTRIBUTES.ICE]: '冰',
    [ATTRIBUTES.WIND]: '风'
};

/**
 * 境界顺序数组
 *
 * 修复说明（2026-07-19）：
 *   旧版 REALM_ORDER 包含 "炼气11层/12层/13层/圆满" 和 "筑基期/金丹期/元婴期/化神期" 等
 *   大境界名，但 realm_breakthrough.json 中实际并无这些境界（最高炼气10层，且子境界用
 *   "大圆满"而非"圆满"）。这导致深度闭关等用 indexOf 比较境界的功能在化神期及以上
 *   玩家身上返回 -1，被错误拦截。
 *
 *   现在严格对齐 realm_breakthrough.json，仅保留真实存在的境界名。
 *   "大境界名"（如"筑基期"）的解析改由 RealmService.resolveMinRealmRank() 完成。
 *
 * 索引值与 realm_breakthrough.json 的 rank 字段一致：
 *   0=凡人, 1-10=炼气1-10层, 11-14=筑基初期/中期/后期/大圆满,
 *   15-18=金丹初期/中期/后期/大圆满, 19-22=元婴初期/中期/后期/大圆满,
 *   23-26=化神初期/中期/后期/大圆满, 27-30=炼虚初期/中期/后期/大圆满,
 *   31-34=合体初期/中期/后期/大圆满, 35-38=大乘初期/中期/后期/大圆满,
 *   39=渡劫期, 40=真仙
 */
const REALM_ORDER = [
    '凡人',                                                                 // rank 0
    '炼气1层', '炼气2层', '炼气3层', '炼气4层', '炼气5层',                  // rank 1-5
    '炼气6层', '炼气7层', '炼气8层', '炼气9层', '炼气10层',                 // rank 6-10
    '筑基初期', '筑基中期', '筑基后期', '筑基大圆满',                       // rank 11-14
    '金丹初期', '金丹中期', '金丹后期', '金丹大圆满',                       // rank 15-18
    '元婴初期', '元婴中期', '元婴后期', '元婴大圆满',                       // rank 19-22
    '化神初期', '化神中期', '化神后期', '化神大圆满',                       // rank 23-26
    '炼虚初期', '炼虚中期', '炼虚后期', '炼虚大圆满',                       // rank 27-30
    '合体初期', '合体中期', '合体后期', '合体大圆满',                       // rank 31-34
    '大乘初期', '大乘中期', '大乘后期', '大乘大圆满',                       // rank 35-38
    '渡劫期',                                                               // rank 39
    '真仙'                                                                  // rank 40
];

/**
 * 大境界名 → 最低子境界 rank 映射
 *
 * 用于解析"筑基期"这类大境界名为该境界最低 rank（即"筑基初期"的 rank=11）。
 * 配置文件中的 min_realm 字段（如 seclusion.json 的 "min_realm": "筑基期"）
 * 通过此映射转换为数值 rank 后再与玩家境界 rank 比较。
 *
 * 注意：此映射必须与 realm_breakthrough.json 中的境界结构保持同步。
 *
 * 修复（2026-07-20）：
 *   多人副本配置 multi_dungeon_data.json 使用同义词"结丹期"作为队员最低境界要求，
 *   而 realm_breakthrough.json 实际境界名是"金丹初期/中期/后期/大圆满"。
 *   "结丹"与"金丹"在修仙小说中常作同义词使用（结丹=凝聚金丹），
 *   故在映射表中增加"结丹期"作为"金丹期"的同义别名，避免境界校验误判。
 *   同理"元神期"为"化神期"同义词（化神=元神出窍），一并添加。
 */
const REALM_TIER_MIN_RANK = {
    '凡人': 0,
    '炼气期': 1,
    '筑基期': 11,
    '金丹期': 15,
    '结丹期': 15,    // 同义别名：结丹期 = 金丹期（凝聚金丹之意）
    '元婴期': 19,
    '化神期': 23,
    '元神期': 23,    // 同义别名：元神期 = 化神期（元神出窍之意）
    '炼虚期': 27,
    '合体期': 31,
    '大乘期': 35,
    '渡劫期': 39,
    '真仙': 40
};

module.exports = {
    ATTRIBUTES,
    ATTRIBUTE_NAMES,
    REALM_ORDER,
    REALM_TIER_MIN_RANK
};
