/**
 * 物品引用 → 中文名。名字只有一个来源：内容里的 item_data（资料片新增的物品自动生效）。
 *
 * 为什么要单独一层：掉落/奖励/收集物这类列表在内容里只写 item_key 或 item_id（那是引用，
 * 不是给人看的文字）。以前每条链各自把裸键摊给界面，表现就是战斗日志里的
 * "获得物品: wild_herb x3"、副本进度里的 "jade_core ×2" —— 想让界面显示中文名，
 * 得在客户端再抄一份物品典（资料片加了新物品就又露馅），或者逐个接口补。
 * 统一在这一层按读的时候解析：写进库的仍然只是引用，名字永远跟着内容走。
 */
'use strict';

const { infrastructure } = require('../../modules');

let sourceRef = null;
let index = new Map();

/** 物品索引：配置热更或资料片重载后（数组换了引用）自动重建 */
function itemIndex() {
    const items = infrastructure.ConfigLoader.getConfig('item_data')?.items || [];
    if (items !== sourceRef) {
        sourceRef = items;
        index = new Map(items.map(item => [String(item.id), item]));
    }
    return index;
}

/**
 * 按引用取内容里的整条物品定义。
 * 除名字之外还要看说明/品质等的调用方走这里，避免各自再建一份索引。
 * @param {string} itemKey - 物品 key
 * @returns {Object|null} 物品定义；查不到返回 null
 */
function itemInfo(itemKey) {
    if (itemKey === null || itemKey === undefined) return null;
    return itemIndex().get(String(itemKey)) || null;
}

/**
 * @param {string} itemKey - 物品 key
 * @returns {string|null} 内容里登记的名字；查不到返回 null（调用方自己决定退回键名）
 */
function itemName(itemKey) {
    return itemInfo(itemKey)?.name || null;
}

/**
 * 给一批物品引用补上 item_name。
 * @param {Array<Object>} list - [{item_id|item_key, quantity}] 之类的引用列表
 * @param {string} [keyField] - 引用字段名；省略则 item_id / item_key 都认
 * @returns {Array<Object>} 同形状但带 item_name 的新数组（不改动入参）
 */
function withItemNames(list, keyField = null) {
    if (!Array.isArray(list)) return list || [];
    return list.map(entry => {
        if (!entry || typeof entry !== 'object') return entry;
        const key = keyField ? entry[keyField] : (entry.item_id ?? entry.item_key);
        const name = itemName(key);
        return name ? { ...entry, item_name: name } : entry;
    });
}

module.exports = { itemName, itemInfo, withItemNames };
