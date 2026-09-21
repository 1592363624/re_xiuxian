/**
 * 按引用批量发物品，并且**说清哪些真发到了**。
 *
 * 背景：各处发奖励的形状是 `try { addItem(...) } catch { console.warn(...) }` —— 发失败只在日志里，
 * 而给玩家看的那份摘要/广播照旧写"获得 X、Y、Z"。玩家以为拿到了，背包里没有，也没第二次机会
 * （战线里程碑那条就是这么修的，见 tests/BorderContentGate 与 smoke_border_rewards）。
 * 物品键写错这类原因已经被启动期校验堵住了（ContentRegistry._validateItemKeysDeep），
 * 剩下的失败都是运行期的：背包满、并发冲突、底层异常。这些不该继续静默。
 *
 * 这一层只改"诚实度"，不改任何数值：发得出照发，发不出的从摘要里消失并被点出来。
 */
'use strict';

const InventoryService = require('../services/InventoryService');
const { itemName } = require('./itemNaming');
const { logOnce } = require('../../utils/logOnce');

/** 条目里的键/数量字段名各家不同，这里统一按顺序找 */
const KEY_FIELDS = ['item_key', 'item_id', 'key', 'material', 'material_key'];
const QTY_FIELDS = ['quantity', 'qty', 'count', 'num'];

function pick(entry, fields) {
    for (const field of fields) {
        if (entry && entry[field] !== undefined && entry[field] !== null) return entry[field];
    }
    return undefined;
}

/**
 * @param {number} playerId - 收奖玩家
 * @param {Array<Object|string>} entries - 引用列表（`['key']` 或 `[{item_key, quantity}]`）
 * @param {Object} t - 事务（必传：发奖必须和记账同生同死）
 * @param {Object} [options]
 * @param {string} [options.label] - 日志里点名这是哪条链（默认按调用文件不好拿，所以显式传）
 * @param {number} [options.defaultQuantity] - 条目没写数量时发几件（默认 1）
 * @param {Function} [options.extraArgs] - 需要给 addItem 传额外参数时用 mapItem(entry) → [...extra]
 * @returns {Promise<{granted: Array<Object>, failed: Array<Object>}>}
 *          granted/failed 里都是 `{ item_key, quantity, item_name, reason? }`，顺序与入参一致
 */
async function grantItems(playerId, entries, t, options = {}) {
    const { label = 'grantItems', defaultQuantity = 1, extraArgsFor = null } = options;
    const granted = [];
    const failed = [];
    for (const raw of entries || []) {
        if (raw === null || raw === undefined) continue;
        const entry = typeof raw === 'object' ? raw : { item_key: raw };
        const itemKey = pick(entry, KEY_FIELDS);
        if (!itemKey) continue;
        const rawQty = pick(entry, QTY_FIELDS);
        const quantity = Number.isFinite(Number(rawQty)) && Number(rawQty) > 0 ? Number(rawQty) : defaultQuantity;
        const extra = extraArgsFor ? extraArgsFor(entry) : [];
        try {
            await InventoryService.addItem(playerId, itemKey, quantity, t, ...extra);
            granted.push({ item_key: itemKey, quantity, item_name: itemName(itemKey) || itemKey });
        } catch (error) {
            failed.push({ item_key: itemKey, quantity, item_name: itemName(itemKey) || itemKey, reason: error.message });
            // 同一处、同一件只响一次，避免刷屏；但一定要响 —— "已跳过"不该只活在日志里
            logOnce(`itemGrant.failed:${label}:${itemKey}`,
                `[itemGrant] ${label}：玩家 ${playerId} 的 ${itemKey} x${quantity} 发放失败，`
                + `已按"没发到"上报（不会写进玩家摘要）：${error.message}`);
        }
    }
    return { granted, failed };
}

/**
 * 把发放结果写成给玩家看的那句话：只报名字，不报键名，也不提没发到的东西。
 * @param {Array<Object>} granted - grantItems 的 granted
 * @param {Array<Object>} failed - grantItems 的 failed
 * @param {string} [separator] - 条目分隔符
 * @returns {{text: string, allFailed: boolean}} text 为空表示一件都没发到
 */
function describeGrant(granted, failed = [], separator = '、') {
    const text = (granted || []).map(i => `${i.item_name}x${i.quantity}`).join(separator);
    const allFailed = (granted || []).length === 0 && (failed || []).length > 0;
    return { text, allFailed };
}

module.exports = { grantItems, describeGrant, KEY_FIELDS, QTY_FIELDS };
