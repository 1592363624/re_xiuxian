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
 *          granted/failed 里都是 `{ item_key, quantity }`（failed 另带 `reason`），顺序与入参一致。
 *          **故意不带 item_name**：这份回执会被调用方原样落库（历练的 player_adventures.rewards 就是），
 *          名字一旦冻进历史，资料片改一次 item_data 就留下一屏过期名字 —— 全仓口径是"库里只存引用，
 *          名字在出参那一刻按 item_data 解析"（见 itemNaming.withItemNames 与本文件下方的 describeGrant）。
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
            granted.push({ item_key: itemKey, quantity });
        } catch (error) {
            failed.push({ item_key: itemKey, quantity, reason: error.message });
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
 * 名字在这里现算（回执里没有），所以这条出参文本与那份要落库的回执是两件事。
 * @param {Array<Object>} granted - grantItems 的 granted
 * @param {Array<Object>} failed - grantItems 的 failed
 * @param {string} [separator] - 条目分隔符
 * @returns {{text: string, allFailed: boolean}} text 为空表示一件都没发到
 */
function describeGrant(granted, failed = [], separator = '、') {
    const text = (granted || [])
        .map(i => `${itemName(i.item_key) || i.item_key}x${i.quantity}`).join(separator);
    const allFailed = (granted || []).length === 0 && (failed || []).length > 0;
    return { text, allFailed };
}

/**
 * 把回执转成"给玩家看的那份掉落摘要"：`{key, quantity, item_name}`。
 * 名字在这里现算（回执本身只有引用），所以三条战线/巡边/探禁的播报文案共用这一份形状，
 * 不必各自去 `g.item_name` —— 那个字段刻意不存在，免得有人把整份回执原样落库。
 */
function toDropSummary(granted) {
    return (granted || []).map(g => ({
        key: g.item_key,
        quantity: g.quantity,
        item_name: itemName(g.item_key) || g.item_key
    }));
}

/**
 * 从一份结算摘要里把所有"没发到"的条目收集起来。
 *
 * 为什么要这一层：各结算分支各自把失败记进自己那份 summary（`normal_drops[].failed`、
 * `first_clear[].failed`、`*_drops_failed`…），而**给玩家看的那句话是外面另一处拼的** ——
 * 于是"回执里明明写着没发到，玩家读到的还是'通关！'"。收集写成通用的（按键名 `*failed` 找），
 * 以后新增一条掉落分支只要按约定把失败放进 `failed` 数组，结算文本自动带上它，不需要再改拼装处。
 *
 * @param {*} node - summary / 结果对象（数组、对象、循环引用都受得住）
 * @param {Object} [options]
 * @param {number} [options.maxDepth] - 递归深度上限（默认 6，防呆住的结构一路吃内存）
 * @returns {Array<{item_key:string, quantity:number, reason:string, path:string}>} 顺序稳定（按遍历次序）
 */
function collectGrantFailures(node, options = {}) {
    const { maxDepth = 6 } = options;
    const out = [];
    const seen = new WeakSet();
    const walk = (value, path, depth) => {
        if (depth > maxDepth || value === null || value === undefined) return;
        if (typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
            return;
        }
        for (const [key, value2] of Object.entries(value)) {
            const childPath = path ? `${path}.${key}` : key;
            if (/failed$/i.test(key) && Array.isArray(value2)) {
                for (const entry of value2) {
                    if (!entry || typeof entry !== 'object') continue;
                    const itemKey = entry.item_key ?? entry.key ?? entry.material ?? entry.material_key;
                    if (typeof itemKey !== 'string' || !itemKey) continue;
                    const rawQty = pick(entry, QTY_FIELDS);
                    out.push({
                        item_key: itemKey,
                        quantity: Number.isFinite(Number(rawQty)) && Number(rawQty) > 0 ? Number(rawQty) : 1,
                        reason: String(entry.reason || entry.error || '未说明原因'),
                        path: childPath
                    });
                }
                continue;       // 失败数组本身不再往下走（里面的条目就是叶子）
            }
            walk(value2, childPath, depth + 1);
        }
    };
    walk(node, '', 0);
    return out;
}

/**
 * 把收集到的失败写成结算文本的尾巴（名字在这里现算，与其他出参同一口径）。
 *
 * 按物品**归并**再报：一场结算里同一件东西常常是"每人一份、五个人都没发到"，
 * 逐条列会把同一个名字印五遍（探针实测过这种文本），既难读也浪费那串名额。
 * @param {Array<Object>} failures - collectGrantFailures 的结果
 * @param {Object} [options]
 * @param {number} [options.max] - 最多点几种的名字（默认 4，其余并进"等 N 种"）
 * @param {string} [options.separator] - 与主句之间的分隔（默认全角竖线）
 * @returns {string} 没有失败时返回空串（调用方直接拼，不必判空）
 */
function describeGrantFailures(failures, options = {}) {
    const { max = 4, separator = '｜' } = options;
    const list = failures || [];
    if (!list.length) return '';
    const byKey = new Map();
    let pieces = 0;
    for (const f of list) {
        const qty = Number.isFinite(Number(f.quantity)) && Number(f.quantity) > 0 ? Number(f.quantity) : 1;
        byKey.set(f.item_key, (byKey.get(f.item_key) || 0) + qty);
        pieces += qty;
    }
    const kinds = [...byKey.entries()];
    const names = kinds.slice(0, max).map(([key, qty]) => `${itemName(key) || key}x${qty}`).join('、');
    const more = kinds.length > max ? ` 等 ${kinds.length} 种` : '';
    return `${separator}背包放不下，${pieces} 件未获得：${names}${more}（可清包后再来，本局不会补发）`;
}

module.exports = {
    grantItems, describeGrant, toDropSummary, collectGrantFailures, describeGrantFailures,
    KEY_FIELDS, QTY_FIELDS
};
