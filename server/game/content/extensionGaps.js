/**
 * 「数据集登记了」≠「它里面每一块都能被资料片扩展」。
 *
 * `DATASET_SPECS.<ds>.collections` 没点到的区块走的是 passthrough：资料片往里写会被
 * `_applyOps` 判成"没有该集合"当场抛（这倒不会静默失效，坏在**加不了**）。而这一族缺口最坑的地方是
 * "登记了一半"：条目集合开了口子、它配套的表没开 —— 于是资料片加得出那个条目，却落不了地。
 * 仓里已经撞过三次同一形状：
 *   · `spirit_beast_data` 登记了灵兽，`settings`（战力权重表）没登记 → 新属性进不了战力（任务 #18）；
 *   · `formation_data` 登记了阵法，两张标签表没登记 → 新流派被路由自己的合法集挡掉（任务 #19）；
 *   · `technique_data` 登记了功法，`grades` 没登记 → 新功法写一个表里没有的品阶，
 *     `getRequiredProficiency` 返回 Infinity，那部功法一层都突破不了（本轮登记并配启动闸）。
 *
 * 所以这里放**检测器 + 台账**，而不是再靠人偶然撞上一次：
 *   `unregisteredContentTables()` 把所有"形状是一张条目表、却没登记成集合"的区块现数出来；
 *   `NOT_A_COLLECTION` 只登记"本就不该给 pack 写"的那些，且**每条必须带理由**、
 *   理由一旦不再命中就反过来报（过期豁免比没有豁免更糟 —— 它会把新缺口藏进旧表里）。
 * 剩下的每一条都是一个**能力缺口**：数量只许变小（棘轮在 tests/ContentExtensionGaps.test.js）。
 */
'use strict';

const { DATASET_SPECS } = require('./ContentRegistry');

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const realKeys = obj => Object.keys(obj).filter(k => !k.startsWith('_'));

/**
 * 数组元素里出现这些键，就认为每条是一个"条目"（有自己的身份），
 * 资料片想加一条 = 想加一个条目 —— 这正是集合登记该管的事。
 */
const IDENTITY_FIELDS = ['id', 'key', 'name', 'code', 'type', 'level', 'stage', 'floor',
    'item_id', 'item_key', 'seed_id', 'node_key', 'location_key', 'resource_id', 'purpose',
    'from_star', 'from_level', 'plot_index'];

const MIN_ENTRIES = 2;
const OBJ_ELEMENT_RATIO = 0.6;
const SHARED_FIELDS = 2;
const MAX_DEPTH = 3;

/** 这个路径是否已被登记集合覆盖（本身是集合、或在某个集合里面） */
function coveredByCollection(registered, at) {
    return registered.includes(at) || registered.some(r => `${at}.`.startsWith(`${r}.`));
}

/** 它只是"装已登记集合的命名空间"（如 cave / global / element_match）吗？这种块不该被报成缺口 */
function isNamespaceOfRegistered(registered, at) {
    return registered.some(r => r.startsWith(`${at}.`));
}

function shapeOfList(node) {
    const objs = node.filter(isObj);
    if (!objs.length || objs.length / node.length < OBJ_ELEMENT_RATIO) return null;
    const withId = objs.filter(o => realKeys(o).some(k => IDENTITY_FIELDS.includes(k)));
    if (withId.length / objs.length < OBJ_ELEMENT_RATIO) return null;
    const fields = new Set();
    for (const o of objs) for (const k of realKeys(o)) fields.add(k);
    return { kind: 'list', entries: node.length, fields: [...fields] };
}

function shapeOfTable(node) {
    const keys = realKeys(node);
    if (keys.length < MIN_ENTRIES) return null;
    const values = keys.map(k => node[k]);
    const objs = values.filter(isObj);
    if (objs.length / values.length < 0.8) return null;
    let shared = null;
    for (const v of objs) {
        const ks = new Set(realKeys(v));
        shared = shared === null ? ks : new Set([...shared].filter(x => ks.has(x)));
    }
    if (!shared || shared.size < SHARED_FIELDS) return null;
    const fields = new Set(shared);
    for (const v of objs) for (const k of realKeys(v)) fields.add(k);
    return { kind: 'table', entries: keys.length, fields: [...fields] };
}

function shapeOf(node) {
    if (Array.isArray(node)) return shapeOfList(node);
    if (isObj(node)) return shapeOfTable(node);
    return null;
}

function walkInto(value, at, out, ctx, depth) {
    if (!isObj(value) || depth > MAX_DEPTH) return;
    for (const key of realKeys(value)) {
        const child = value[key];
        const childAt = at ? `${at}.${key}` : key;
        if (coveredByCollection(ctx.registered, childAt)) continue;
        const namespace = isNamespaceOfRegistered(ctx.registered, childAt);
        if (Array.isArray(child)) {
            const shape = shapeOf(child);
            // 数组不会是"已登记集合的父壳"，但条目内部的数组一律不报（要扩的是父条目那一块）
            if (shape && !namespace) out.push({ at: childAt, ...shape, keys: identityValues(child), ...ctx.tag });
            continue;
        }
        if (!isObj(child)) continue;
        const shape = shapeOf(child);
        if (shape && !namespace) out.push({ at: childAt, ...shape, keys: realKeys(child), ...ctx.tag });
        walkInto(child, childAt, out, ctx, depth + 1);
    }
}

/** 一张列表的"条目名"：取第一个在多数元素上都出现的身份字段（`id` / `name` / `code`…） */
function identityValues(list) {
    const objs = list.filter(isObj);
    if (!objs.length) return [];
    for (const field of IDENTITY_FIELDS) {
        const values = objs.map(o => o[field]).filter(v => typeof v === 'string' || typeof v === 'number');
        if (values.length / objs.length >= 0.8) return values.map(String);
    }
    return [];
}

/**
 * 收集同一个数据集里、所有**已登记集合**的条目字段（`字段名 → (值 → 出现条数)`）。
 * 用来判"这张表是不是被某个条目当外键指着" —— 那才是资料片真正落不了地的地方。
 */
function collectionFields(content, dataset, registered) {
    const byField = new Map();
    const root = content.datasets.get(dataset);
    const add = (field, value) => {
        if (typeof value !== 'string' && typeof value !== 'number') return;
        if (!byField.has(field)) byField.set(field, new Map());
        const values = byField.get(field);
        const key = String(value);
        values.set(key, (values.get(key) || 0) + 1);
    };
    const walkEntry = (entry, prefix) => {
        for (const field of realKeys(entry)) {
            const v = entry[field];
            if (Array.isArray(v)) {
                for (const item of v) {
                    if (item !== null && typeof item === 'object' && isObj(item)) walkEntry(item, field);
                    else add(field, item);
                }
            } else if (isObj(v)) {
                for (const inner of realKeys(v)) add(inner, v[inner]);
            } else add(prefix ? `${prefix}_${field}` : field, v);
        }
    };
    for (const path of registered) {
        let node = root;
        for (const seg of path.split('.')) {
            if (!node) break;
            node = node[seg];
        }
        const entries = Array.isArray(node) ? node.filter(isObj)
            : (isObj(node) ? realKeys(node).map(k => node[k]).filter(isObj) : []);
        for (const entry of entries) walkEntry(entry, '');
    }
    return byField;
}

/**
 * 字段名与表名的对应关系（机械规则，不做语义猜测）：
 * `fish_pool` ↔ `fish_pools`、`rarity` ↔ `rarity_config`、`grade` ↔ `grades`、
 * `blueprint_key` ↔ `blueprints`。
 * 为什么要这条规则：早先按"值有没有撞上表里的键"数引用，`level_table` 的键是 1~10，
 * 于是所有写了 `level: 3` 的条目都被算成引用它 —— 那是 §31 那 83 条假称号引用的同一个病。
 *
 * `_key` / `_id` / `_type` 三个后缀是 2026-09-23 补的，起因是 `puppet_data.blueprints` 这一格：
 * 五档傀儡的 `blueprint_key` 指着它，而判据把字段规约成 "blueprint_key"、把表规约成 "blueprint"，
 * 两边对不上 → 台账报"0 处外键证据"，于是这一格在优先级上等于不存在（实测：剥掉后缀后同一份
 * 内容立刻数出 5 处）。这类"登记了主表、没登记它的外键目标表"正是资料片最容易落不了地的形状。
 * 补完在现网重测过一遍：缺口数与"有证据的缺口数"都没变（33 / 0），也不产生过期豁免 ——
 * 也就是这条只是让**下一次**同样的洞带着证据出现，不给现有内容添结论。
 */
const SUFFIXES = /(?:_config|_table|_list|_data|_options|_entries|_types?|_pool|_pools|_levels|_display_names|_labels|_catalog|_key|_id)?$/;
const singular = w => (/(?:ses|xes|zes)$/.test(w) ? w.slice(0, -2) : (/ies$/.test(w) ? `${w.slice(0, -3)}y` : (/s$/.test(w) ? w.slice(0, -1) : w)));
const normalise = name => singular(String(name).toLowerCase().replace(SUFFIXES, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|\_$/g, ''));

function looksLikePointer(field, tableAt) {
    const f = normalise(field);
    const block = normalise(tableAt.split('.').pop());
    if (!f || !block) return false;
    return f === block || f.endsWith(`_${block}`) || block.endsWith(`_${f}`);
}

/**
 * 键全是数字的表（`level_table` 的 1~10、`upgrade_table` 的档位）不接受"名字指针"判据。
 * 为什么：实测 `taoism_gate_data.level_table` 被 `dao_paths[].skill_min_level = 5` 命中过一次 ——
 * 那是一个**门槛值**不是外键，数字撞上了键而已。数字表要扩的是"再加一档"，
 * 靠引用某个具体数字来判定"这张表被指着"永远分不清这两种情况，所以宁可不判。
 */
const allNumeric = keys => keys.length > 0 && keys.every(k => /^-?\d+(\.\d+)?$/.test(k));

/**
 * 现数：每个已登记数据集里，形状是一张条目表却没登记成集合的区块。
 * @param {ContentRegistry} content 已 load() 的内容视图（读合并视图，与报告其余板块同源）
 */
function unregisteredContentTables(content) {
    const found = [];
    for (const [dataset, spec] of Object.entries(DATASET_SPECS)) {
        const root = content.datasets.get(dataset);
        // 数组形状的基础文件：整份就是主集合（走 applyOps 的裸数组分支），没有"未登记区块"可言。
        // PACK_ONLY_DATASETS 没有基础文件，同理跳过。
        if (!isObj(root)) continue;
        const registered = Object.keys(spec.collections || {});
        const rows = [];
        walkInto(root, '', rows, { registered, tag: { dataset } }, 1);
        const fields = collectionFields(content, dataset, registered);
        for (const row of rows) {
            // 外键信号：同数据集里某个**已登记集合**的条目，用一个名字对得上的字段指着这张表的键。
            // 命中就说明"资料片加得出那个条目、指不到这张表里的新键"（§16/§17/本轮 grades 同一个形状）。
            const keySet = new Set(row.keys);
            const pointers = [];
            const numericKeyed = allNumeric(row.keys);
            if (!numericKeyed) {
                for (const [field, values] of fields) {
                    if (!looksLikePointer(field, row.at)) continue;
                    const hits = [...values.entries()].filter(([v]) => keySet.has(v));
                    if (hits.length) {
                        pointers.push({ field, entries: hits.reduce((n, [, c]) => n + c, 0), values: hits.map(([v]) => v).slice(0, 8) });
                    }
                }
            }
            row.numericKeyed = numericKeyed;
            row.pointers = pointers;
            row.pointerEntries = pointers.reduce((n, p) => n + p.entries, 0);
        }
        found.push(...rows);
    }
    return found;
}

/**
 * 「本就不该被资料片扩展」的区块 —— 只登记这一侧，缺口那一侧交给棘轮计数。
 * 理由必须说清"它是什么、为什么资料片不该动它"，且**路径必须仍然命中**（过期就红）。
 */
const NOT_A_COLLECTION = {
    'game_balance.pvp.ranks': 'PVP 段位是运行时赛季参数（整份 game_balance 在 NOT_PACKABLE 里，由 DatasetPackabilityLedger 判）。资料片加段位会直接改变现网匹配与结算口径，属数值签字范围而不是内容扩展',
    'game_balance.state_cleaner': '后台清理任务的开关与间隔，改了是运维行为；给 pack 写等于让内容层能开关服务线程',
    'game_balance.rate_limit': 'index.js 里的接口限流中间件按这张表取 limit/window_seconds（含管理端接口的独立一档）。它是防刷参数不是内容：资料片能改它就等于内容层可以决定"玩家多久能点一次"，这类键必须只由运维改',
    'game_balance.world_boss.rewards': '世界 BOSS 奖励系数：game_balance 整份在 NOT_PACKABLE，开这一格要先决定"运行参数表能不能被 pack 覆盖"这条口径',
    'game_balance.adventure.duration_types': '历练时长的三档参数（时长/奖励倍率/受伤率）。它是"合法全集"（路由按键挡参数），要开就得连 DurationType 的口径一起定',
    'game_balance.meditation.duration_types': '打坐时长档位，同 adventure.duration_types 一条口径',
    'game_balance.crafting.quality_float.tiers': '炼制品质浮动的档位曲线：改了是全局产出平衡（§26 品质词表已单独收成 item_qualities 一处），不该由 pack 各自调',
    'game_balance.item_categories': '物品大类清单（5 档，routes/config.js 直接下发）。它是分类词表而不是内容条目，要扩就得先决定"新分类下的物品归谁算"',
    'taoism_gate_data.daily_tasks': '包着 task_types 的参数壳（各任务的 target_count 与奖励）：要开口子开在 task_types 那一层，不要开这一层',
    'cave_data.cave.garden.plot_unlock_costs': '按 plot_index 排的地块解锁价：地块数由 player_caves 的列决定（改表需授权），资料片加不出第 7 块地，所以这张表不是"可增条目"表',
    'spirit_beast_pvp_data.spirit_beast_pvp.tactics.options': '灵兽 PVP 战术三档（atk/def 乘子）：它是战斗平衡表，且客户端把战术名当固定三项渲染；要开要先定"新战术怎么显示"'
    // 2026-09-23：删掉 `companion_data.heart_tribulation.options` 这条豁免。它当时写的是
    // "扩它 = 改心魔玩法本身（需设计）"，本轮实测证明这个判断错了：真正的障碍只有两件
    // —— 路由与服务各抄了一份三选一的字面数组、客户端自己有一张键→中文名表。
    // 两处都改成读内容之后，资料片加第四个选项零代码可用（登记 + _validateCompanionVoyage 对账）。
    // 留这条记录是因为豁免是最容易写错的一类结论：它把"我没做"写成"不该做"，
    // 而检测器会照单全收 —— 所以 stale 检查必须一直留着。
};

/**
 * 量到"被已登记条目当外键指着"的缺口，各自的出口。
 * 只写有指针证据的：`pointers` 会点名是哪个字段。没写出口不等于没出口，等于本轮还没读到那一步。
 */
const GAP_EXITS = {
    // 2026-09-22：这里原本只有 `spirit_beast_data.rarity_config` 一条（7 处 `rarity` 指着它、客户端还抄了两份字典）。
    // 那一格现已登记成 map 集合、档名与颜色改由内容下发（`game/stats/beastRarity.js`），缺口自己消失了 ——
    // 于是 stale 检查把它从本表里清了。留着一句过期结论比没有结论更坏，这条就是那道闸的第一次实际应用。
};

/** 台账判定：把现数结果分成 open / exempted / stale 三堆 */
function summarizeGaps(content) {
    const rows = unregisteredContentTables(content);
    const seen = new Set();
    const open = [];
    const exempted = [];
    for (const row of rows) {
        const id = `${row.dataset}.${row.at}`;
        seen.add(id);
        const extra = { id, pointers: row.pointers, exit: GAP_EXITS[id] || null };
        if (NOT_A_COLLECTION[id]) exempted.push({ ...row, ...extra, reason: NOT_A_COLLECTION[id] });
        else open.push({ ...row, ...extra });
    }
    const stale = Object.keys(NOT_A_COLLECTION).filter(id => !seen.has(id));
    const staleExits = Object.keys(GAP_EXITS).filter(id => !seen.has(id));
    // 排序即优先级：被已登记条目引用得越多的表，越先变成"资料片加得出条目、指不到新键"
    open.sort((a, b) => (b.pointerEntries - a.pointerEntries) || a.id.localeCompare(b.id));
    const withPointers = open.filter(r => r.pointerEntries > 0);
    return {
        open,
        exempted,
        stale,
        staleExits,
        counts: {
            candidates: rows.length,
            open: open.length,
            exempted: exempted.length,
            withPointers: withPointers.length,
            registeredCollections: Object.values(DATASET_SPECS)
                .reduce((n, spec) => n + Object.keys(spec.collections || {}).length, 0)
        },
        evidence: 'game/content/extensionGaps.unregisteredContentTables()（DATASET_SPECS + 合并视图形状 + 已登记集合条目的外键字段）+ 本文件 NOT_A_COLLECTION / GAP_EXITS'
    };
}

module.exports = {
    IDENTITY_FIELDS,
    shapeOfList,
    shapeOfTable,
    shapeOf,
    identityValues,
    coveredByCollection,
    isNamespaceOfRegistered,
    normalise,
    looksLikePointer,
    unregisteredContentTables,
    NOT_A_COLLECTION,
    GAP_EXITS,
    summarizeGaps
};
