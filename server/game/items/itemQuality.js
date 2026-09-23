/**
 * 品质档序的唯一读取口。
 *
 * 档名住在 `game_balance.item_qualities`（2026-09-22 登记成 map 集合，资料片能加一档），
 * 但代码里曾经抄了 **6 份**六档清单：CraftingService 的品质浮动升档序、CaveSocialService 的万宝阁
 * 品质排名、CaveLegacyService 的遗宝可分配档、FishingService 三处（其中一处直接写进 SQL 的
 * `FIELD(...)` 里）。抄一份的后果不是编译不过，而是**加一档时那一处继续按旧的序排**：
 * 新档在品质排名里等于不存在、在 SQL 排序里落进 0，界面与排行都看不出问题。
 *
 * 所以以后要"品质谁高谁低"，只问这里。**内容里不许再写第二份档序**（`quality_order` 那一族已删并由
 * `ContentRegistry._validateItemQualities` 拦回写）：上一版留着"各服务可写 `quality_order` 覆盖"的退路，
 * 而现网那两份与词表逐字相同 = 纯镜像，资料片加一档时镜像不跟着长，新档在炼制浮动与万宝阁排名里等于不存在。
 * 要"只用其中几档"（遗宝只发低档那种）写 `include_qualities`，那是筛选不是档序。
 */
'use strict';

const CONFIG = 'game_balance';

function tableOf(configLoader) {
    const balance = (typeof configLoader?.getConfig === 'function' ? configLoader.getConfig(CONFIG) : null) || {};
    const table = balance.item_qualities || {};
    return Object.entries(table)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, cfg]) => ({
            key,
            label: cfg?.label || key,
            tone: cfg?.tone || 'neutral',
            order: Number.isFinite(Number(cfg?.order)) ? Number(cfg.order) : 0
        }))
        .sort((a, b) => a.order - b.order);
}

/** 由低到高的全部档名；词表读不到时返回空数组（调用方不许另立档序 —— `quality_order` 已被启动闸禁止） */
function qualityOrder(configLoader) {
    return tableOf(configLoader).map(entry => entry.key);
}

/** 某一档的位次（0 起）；未声明或读不到返回 -1，让调用方自己决定怎么兜底 */
function qualityIndexOf(configLoader, quality) {
    if (quality === undefined || quality === null || quality === '') return -1;
    return qualityOrder(configLoader).indexOf(String(quality));
}

/**
 * 排名用的"高度"：未知档=0（与旧代码 `indexOf(...) >= 0 ? idx : 0` 同口径）。
 * 用 order 而不是数组下标，这样中间插一档不会把旧档的排名整体挪走。
 */
function qualityRank(configLoader, quality) {
    const table = tableOf(configLoader);
    const hit = table.find(entry => entry.key === String(quality ?? ''));
    if (hit) return hit.order;
    return 0;
}

/** "某一档及以上"的判断（广播、权重加成这类阈值语义）；比 `quality === 'legendary' || quality === 'mythic'` 抗加档 */
function qualityAtLeast(configLoader, quality, thresholdKey) {
    return qualityRank(configLoader, quality) >= qualityRank(configLoader, thresholdKey);
}

/** 伴生参数表的一格：基础配置写裸数字，资料片经 map 集合加进来必然是对象（`{id,value}`）*/
function scalarValue(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const field of ['value', 'number', 'weight', 'ratio']) {
            const inner = raw[field];
            if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
        }
    }
    return null;
}

/**
 * 按品质从"档名 → 一个数"的伴生参数表里取值（典当估价系数这类）。
 *
 * 规则：**本档有就用本档；没有就用词表里不高于本档的最近一档**；整张表都比它高才落到 fallback。
 * 为什么不是 `table[quality] ?? table['common']` 那种写法（这就是原来的写法）：
 * 典表的系数是**越高档越慷慨不得**的递减曲线（common 0.6 → legendary 0.3），
 * 兜到 common 等于给最高档品质发了全表最大的系数 —— §26 把品质长成六档之后，
 * 45 件神话物品的典当估值按 0.6 算（传说只有 0.3）。**加一档不会报错，只会算错钱**，
 * 而"往哪一档兜底"这个决定本身是猜的：单调继承至少保证不会出现"越稀有越值钱回来"的反向。
 *
 * @returns {{value: number|null, inheritedFrom: string|null}} 带上"继承自哪一档"，
 *          因为报告与启动日志要能点名（静默继承与静默兜底是同一种病的两个阶段）
 */
function qualityParamFor(configLoader, table, quality) {
    if (!table || typeof table !== 'object') return { value: null, inheritedFrom: null };
    const direct = scalarValue(table[quality]);
    if (direct !== null) return { value: direct, inheritedFrom: null };
    const order = tableOf(configLoader);
    const rank = qualityRank(configLoader, quality);
    if (rank <= 0 && !order.some(entry => entry.key === String(quality ?? ''))) {
        return { value: null, inheritedFrom: null };       // 品质本身不在词表里：不猜，让调用方决定
    }
    let best = null;
    for (const entry of order) {
        if (entry.order > rank) break;
        const value = scalarValue(table[entry.key]);
        if (value !== null) best = { key: entry.key, value };
    }
    return best ? { value: best.value, inheritedFrom: best.key } : { value: null, inheritedFrom: null };
}

/** 整张伴生表相对词表的覆盖情况：`missing` 是"没有自己的值、会按最近一档继承"的那些档 */
function qualityParamCoverage(configLoader, table) {
    const missing = [];
    for (const entry of tableOf(configLoader)) {
        if (scalarValue(table?.[entry.key]) === null) {
            const inherited = qualityParamFor(configLoader, table, entry.key);
            missing.push({ key: entry.key, inheritedFrom: inherited.inheritedFrom });
        }
    }
    return { total: tableOf(configLoader).length, missing };
}

module.exports = { qualityOrder, qualityIndexOf, qualityRank, qualityAtLeast, qualityParamFor, qualityParamCoverage, scalarValue };
