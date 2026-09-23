/**
 * 灵兽稀有度词表的唯一读取口（2026-09-22）。
 *
 * 词表本身住在 `spirit_beast_data.rarity_config`（本轮登记成 map 集合，资料片可自带一档），
 * 但改造前它被 **6 处**各自读一遍，而且每一处的兜底都不一样：
 *   · 图鉴 / 列表 / 详情：`rarityConfig[key]?.name || key` → 少写 name 就把裸键 `mythic` 印给玩家；
 *   · 颜色：`?.color || '#9ca3af'` → 把 common 那一档的颜色抄进了代码；
 *   · `getMyBeasts` 的 `by_rarity`：**手打四档**统计 → 资料片加一档，玩家有 3 只新灵兽也不计，
 *     而 `settings.max_beasts_per_player` 照算，于是"总数 5 / 分档 2"这种自相矛盾的界面；
 *   · 放生返还：`Number(...?.release_return_ratio) || 0.2` → 缺档按最便宜的 0.2 退钱；
 *   · 升星消耗：读的是**另一张表** `star_upgrade.rarity_cost_multiplier`，缺档回落 1.0
 *     （common 的倍率）→ 越稀有的灵兽升星反而越便宜，方向直接反了。
 *
 * 所以"加一档稀有度"以前要改 6 个地方，漏一个不会报错、只会算错。现在只问这里。
 *
 * 兜底值（`FALLBACK`）只在**词表里根本没有这一档**时才走到 —— 那是内容下架/历史数据的情形，
 * 现网正常内容永不到达：启动期 `_validateBeastRarity()` 会拒绝"灵兽用了没登记的档位"、
 * "档位没有中文名/颜色/order"、"词表与升星倍率表对不上"。名字兜底沿用物品那套先例
 * （配置失效的物品印「未知物品 · 物品配置已失效」），不再印裸键。
 */
'use strict';

const { contentLabel, contentNumber } = require('../content/ContentRegistry');

const DATASET = 'spirit_beast_data';

/** 词表查不到时的最后一层（内容下架 / 玩家身上有已删档位的旧行） */
const FALLBACK = Object.freeze({
    label: '未知品阶',
    color: '#9ca3af',
    rank: 0,
    starUpMultiplier: 1,
    releaseReturnRatio: 0.2
});

function datasetOf(configLoader) {
    if (typeof configLoader?.getConfig !== 'function') return {};
    return configLoader.getConfig(DATASET) || {};
}

function isEntry(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 伴生表的一格：基础配置写裸数字，资料片经 map 集合加进来必然是对象 → 两种形状都认 */
function scalarOf(table, key, fallback) {
    if (!isEntry(table)) return fallback;
    const value = contentNumber(table[key], null);
    return value === null ? fallback : value;
}

/**
 * 由低到高的完整词表。每一档都带齐"界面与结算要用的那几样"，
 * 消费端不再自己去猜 `name` 还是 `label`、倍率在哪张表里。
 * `declared_order` 只在内容真写了 order 时才有值 —— 排序需要兜底，但"这一档高在哪"不能是猜出来的。
 */
function rarityTable(configLoader) {
    const config = datasetOf(configLoader);
    const dict = isEntry(config.rarity_config) ? config.rarity_config : {};
    const multipliers = isEntry(config.star_upgrade) ? config.star_upgrade.rarity_cost_multiplier : null;
    const rows = Object.entries(dict)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, raw], index) => {
            const entry = isEntry(raw) ? raw : {};
            const order = Number(entry.order);
            const declaredOrder = Number.isFinite(order) ? order : null;
            const label = contentLabel(entry, FALLBACK.label);
            return {
                key,
                label,
                color: typeof entry.color === 'string' && entry.color.trim() ? entry.color.trim() : FALLBACK.color,
                order: declaredOrder ?? (Number.MAX_SAFE_INTEGER - 1000 + index),
                declared_order: declaredOrder,
                releaseReturnRatio: contentNumber(entry.release_return_ratio, null) ?? FALLBACK.releaseReturnRatio,
                starUpMultiplier: scalarOf(multipliers, key, FALLBACK.starUpMultiplier)
            };
        });
    // 没写 order 的档排在最后、按键名定序：结果必须确定，否则同一份内容两次启动的统计顺序会不同
    return rows.sort((a, b) => (a.order - b.order) || String(a.key).localeCompare(String(b.key)));
}

/** key → 那一档（给 `_formatBeast` 这类"整表传下去"的调用点用；查不到就是 undefined，由 helpers 兜底） */
function rarityMap(configLoader) {
    const out = {};
    for (const row of rarityTable(configLoader)) out[row.key] = row;
    return out;
}

function entryOf(configLoader, key) {
    const table = rarityTable(configLoader);
    return table.find(row => row.key === String(key ?? '')) || null;
}

function rarityLabel(configLoader, key) {
    return entryOf(configLoader, key)?.label || FALLBACK.label;
}

function rarityColor(configLoader, key) {
    return entryOf(configLoader, key)?.color || FALLBACK.color;
}

/** 档位高低（order 越大越稀有）；词表里没有 = 0，低于一切已登记档 */
function rarityRank(configLoader, key) {
    return entryOf(configLoader, key)?.order ?? FALLBACK.rank;
}

/** 升星消耗的稀有度倍率；缺档 = 1.0（并由启动闸保证正常内容不会走到这里） */
function starUpMultiplier(configLoader, key) {
    return entryOf(configLoader, key)?.starUpMultiplier ?? FALLBACK.starUpMultiplier;
}

/** 放生返还比例；缺档 = 0.2 */
function releaseReturnRatio(configLoader, key) {
    return entryOf(configLoader, key)?.releaseReturnRatio ?? FALLBACK.releaseReturnRatio;
}

/**
 * 按稀有度计数：词表里每一档都出现（0 也发），数据里撞到词表外的档位另列一条。
 * 以前是手打四档 —— 那正是"加一档之后统计凭空少算、界面上总数对不上"的形状。
 */
function countByRarity(configLoader, rows) {
    const counts = new Map();
    for (const row of rarityTable(configLoader)) counts.set(row.key, 0);
    for (const row of rows || []) {
        const key = String(row?.rarity ?? '');
        counts.set(key, (counts.get(key) || 0) + (Number(row?.count ?? 1) || 0));
    }
    return [...counts.entries()].map(([key, count]) => ({
        key,
        label: rarityLabel(configLoader, key),
        color: rarityColor(configLoader, key),
        count
    }));
}

/** 外发给界面的词表（图鉴筛选、管理端下拉都读它，不再自己抄一份档位名） */
function vocabularyForApi(configLoader) {
    return rarityTable(configLoader).map(row => ({
        key: row.key,
        name: row.label,
        color: row.color,
        order: row.order,
        release_return_ratio: row.releaseReturnRatio,
        star_up_cost_multiplier: row.starUpMultiplier
    }));
}

/**
 * 升星的实际消耗 = 消耗表那一行 × 这一档的稀有度倍率。
 *
 * 为什么也收进这里：`getUpgradePreview`（给玩家看的）与 `upgradeStar`（真扣材料的）
 * 各自抄了一遍这三行乘法。抄两份的后果与"六处各读一次词表"一样 —— 改其中一处，
 * 玩家看到的预览和实际扣的就不是同一个数。
 *
 * 键名用 camelCase（代码侧 API），因为两个调用点都写成
 * `const { beastSoulCost, yaodanCost, spiritStonesCost } = starUpCost(...)`：
 * 出参给的是 snake_case 时那三个变量全是 undefined，而 JS 不报错 —— 预览会返回
 * `spirit_stones: undefined.toString()` 当场炸（真库探针 R4 抓到的就是这个），
 * 而"兽魂不足"那类比较只会得 NaN，一路静默。
 */
function starUpCost(configLoader, rarityKey, upgradeEntry) {
    const multiplier = starUpMultiplier(configLoader, rarityKey);
    const entry = upgradeEntry || {};
    return {
        multiplier,
        beastSoulCost: Math.floor((Number(entry.beast_soul_cost) || 0) * multiplier),
        yaodanCost: Math.floor((Number(entry.yaodan_cost) || 0) * multiplier),
        spiritStonesCost: BigInt(Math.floor((Number(entry.spirit_stones_cost) || 0) * multiplier))
    };
}

module.exports = {
    DATASET,
    FALLBACK,
    rarityTable,
    rarityMap,
    entryOf,
    rarityLabel,
    rarityColor,
    rarityRank,
    starUpMultiplier,
    starUpCost,
    releaseReturnRatio,
    countByRarity,
    vocabularyForApi
};
