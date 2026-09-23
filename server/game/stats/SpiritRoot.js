/**
 * 灵根解析：把"玩家身上那份灵根数据"归一成一个规范记录，供全游戏共用。
 *
 * 为什么要单独一个模块：现网同时存在三种写法，而且此前没有一个地方把它们对上过——
 *   1. player.spirit_root            —— 根本不存在的列（模型里没有），读出来永远 undefined
 *   2. player.spirit_roots           —— { type: 'thunder' }（老角色/种子数据）
 *   3. player.spirit_roots           —— { '金灵根': { level, affinity } }（PlayerService 新建角色写的）
 *   role_init.spiritRootBonuses      —— 以中文 '金'/'木'/… 为键
 * 结果就是 spirit_root provider 与 routes/player.js 的加成查询双双落空：
 * 灵根从来没往属性里加过任何东西，PvP 的五行克制也只认形状 2。
 *
 * 这里只做一件事：按 role_init.spirit_roots 这张表（id/type/name 三种键）把任意形状解析成
 *   { type, name, display, bonus }
 * 新增一种灵根只需要往 role_init 里加数据，四个消费点自动跟上。
 */
'use strict';

/** 解析结果按 role_init 对象缓存：配置热更后是新对象，缓存自然失效 */
const indexCache = new WeakMap();

function rootIndex(roleInit) {
    if (!roleInit) return null;
    const hit = indexCache.get(roleInit);
    if (hit) return hit;

    const byKey = new Map();
    for (const root of roleInit.spirit_roots || []) {
        if (!root || typeof root !== 'object') continue;
        const record = {
            type: root.type || root.id || null,
            name: root.name || root.displayName || null,
            display: root.displayName || root.name || null
        };
        for (const key of [root.id, root.type, root.name, root.displayName]) {
            if (typeof key === 'string' && key && !byKey.has(key)) byKey.set(key, record);
        }
    }
    const bonuses = roleInit.spiritRootBonuses || {};
    const built = { byKey, bonuses };
    indexCache.set(roleInit, built);
    return built;
}

/** 从存储形状里抽出所有候选灵根键（不止一个：多灵根时是 { fire: 50, water: 50 } 这种权重表） */
function candidateKeys(player) {
    const out = [];
    const stored = player?.spirit_roots;

    if (typeof stored === 'string') out.push(stored);
    else if (stored && typeof stored === 'object') {
        if (typeof stored.type === 'string') out.push(stored.type);
        if (typeof stored.name === 'string') out.push(stored.name);
        for (const [key, value] of Object.entries(stored)) {
            // { '金灵根': {...} }：键名本身就是中文灵根
            if (key.endsWith('灵根')) { out.push(key.slice(0, -2)); continue; }
            // { fire: 80, water: 50 }：元素名 → 亲和度，0 表示没有这条灵根
            if (key !== 'type' && key !== 'name' && Number(value) > 0) out.push(key);
        }
    }

    // 兼容历史上真出现过的标量列（模型已无此列，手工构造的对象/旧快照仍可能带）
    if (typeof player?.spirit_root === 'string') out.push(player.spirit_root);
    return [...new Set(out.filter(Boolean))];
}

/** 灵根强度：老形状放在 value 字段，新形状放在某个 'X灵根' 键的 affinity 字段 */
function storedValue(player) {
    const stored = player?.spirit_roots;
    if (!stored || typeof stored !== 'object' || typeof stored === 'string') return 0;
    if (Number.isFinite(stored.value)) return stored.value;
    for (const entry of Object.values(stored)) {
        if (entry && typeof entry === 'object' && Number.isFinite(entry.affinity)) return entry.affinity;
    }
    return 0;
}

/**
 * @param {Object} player - 玩家实例或任意带灵根字段的对象
 * @param {Object} roleInit - role_init 配置对象
 * @returns {{type: string|null, name: string|null, display: string|null, value: number, bonus: Object}|null}
 */
function resolveSpiritRoot(player, roleInit) {
    const index = rootIndex(roleInit);
    if (!index) return null;

    const value = storedValue(player);
    for (const key of candidateKeys(player)) {
        const record = index.byKey.get(key);
        if (record) {
            return { ...record, value, bonus: index.bonuses[record.name] || {} };
        }
        // 表里没登记但加成表里有（例如只配了 spiritRootBonuses 的自定义灵根）
        if (index.bonuses[key]) {
            return { type: null, name: key, display: key, value, bonus: index.bonuses[key] };
        }
    }
    return null;
}

/** 灵根对属性的加成（provider 与展示层共用这一个入口） */
function spiritRootBonus(player, roleInit) {
    return resolveSpiritRoot(player, roleInit)?.bonus || {};
}

/**
 * 玩家身上"每一条"可识别灵根的 type 列表（多灵根场景）。
 * 五行契合/相克要按全部灵根判断，只看第一条会把 { fire: 50, water: 50 } 判错。
 */
function spiritRootTypes(player, roleInit) {
    const index = rootIndex(roleInit);
    if (!index) return [];
    const types = [];
    for (const key of candidateKeys(player)) {
        const record = index.byKey.get(key);
        const type = record?.type ?? (index.bonuses[key] ? key : null);
        if (type && !types.includes(type)) types.push(type);
    }
    return types;
}

/**
 * 抽灵根的"池子"定义 —— 唯一一处，建号（rollSpiritRoot）与启动闸（_validateSpiritRootRoll）都问它。
 *
 * 三条与"资料片能加灵根"绑在一起的口径：
 *   · 池子来自 `spirit_roots`，被 `roll_enabled:false` 关掉的不进池（"先声明后开放"要留痕，
 *     由启动闸强制）；
 *   · 权重走 `contentNumber` —— 资料片经 map 集合加的概率条目是 `{id,value}` 对象，
 *     直接 `+=` 会算成 NaN，坏掉的是整池（表现为"新号永远抽到第一个"），不只是那一条抽不到；
 *   · 键名一律取 `spirit_roots[].name`，所以概率表写英文 id 的那一档等于没写。
 *
 * @returns {{name:string, weight:number}[]} 有效权重为正的档位；一条都没有时是空数组（不是兜底假灵根）
 */
function spiritRootRollPool(roleInit) {
    const { contentNumber } = require('../content/ContentRegistry');
    const declared = (roleInit?.spirit_roots || [])
        .filter(root => root && typeof root === 'object' && root.name && root.roll_enabled !== false);
    const probabilities = roleInit?.spiritRootProbabilities || {};
    const weighted = declared
        .map(root => ({ name: root.name, weight: contentNumber(probabilities[root.name], NaN) }))
        .filter(entry => Number.isFinite(entry.weight) && entry.weight > 0);
    // 概率表整个读不到（或全被写成非正数）时按声明等分 —— 与改造前一致，但不写死五个中文名
    return weighted.length ? weighted : declared.map(root => ({ name: root.name, weight: 1 }));
}

/**
 * 建号抽灵根（PlayerService 调它，测试也直接打它）。
 *
 * @param {Object} roleInit role_init 的合并视图
 * @param {number} [ratio] [0,1) 的比率，传进来才能测。**内部再乘总权重**：
 *        概率表登记成 map 集合后资料片可以只加一条 `{id,value}`，总权重就不再是 1，
 *        若把它当"已乘过权重的绝对值"，掷骰永远落在区间前段 → 后面几档（含新加的）抽不到。
 * @returns {{name:string, weight:number, totalWeight:number, pool:string[]}|null}
 *          灵根表整个读不到时返回 null —— 宁可不发灵根，也不写一条查无此根的假灵根
 */
function rollSpiritRoot(roleInit, ratio = Math.random()) {
    const pool = spiritRootRollPool(roleInit);
    if (!pool.length) return null;
    const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
    const point = Math.min(Math.max(ratio, 0), 1) * totalWeight;

    let picked = pool[pool.length - 1];
    let cumulative = 0;
    for (const entry of pool) {
        cumulative += entry.weight;
        if (point < cumulative) { picked = entry; break; }
    }
    return { name: picked.name, weight: picked.weight, totalWeight, pool: pool.map(e => e.name) };
}

module.exports = { resolveSpiritRoot, spiritRootBonus, spiritRootTypes, spiritRootRollPool, rollSpiritRoot };
