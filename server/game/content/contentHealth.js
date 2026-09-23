/**
 * 内容体检报告：把散在十几道闸里的"配了但玩家拿不到 / 写了但没人读"的账，
 * 用**同一批判据函数**现算成一份可读完的东西（`scripts/content_health_report.js` 是它的命令行外壳）。
 *
 * 唯一的硬规矩：**这里不实现任何判据**。
 * 每一条数字都必须由内容层/台账里那同一个函数算出来 ——
 *   `ContentRegistry.itemReferenceIndex()` / `titleGrantIndex()` / `titleMirrorPaths()` /
 *   `statWriterCalls()` / `sourceLedgers` 那几张表。
 * 为什么这么定：一份自己另写一套规则的报告会很快变成"跟闸对不上的旧文档"，
 * 那种东西比没有报告更糟（人会拿它当结论）。所以 `tests/ContentHealthReport.test.js` 逐条比对
 * "报告里的数字 == 判据现算的结果"，并做控制跑让某个数字动起来，证明它不是印常量的机器。
 */
'use strict';

const {
    normalizeRefPath, ITEM_GRANT_PATHS, ITEM_SINK_PATHS, TITLE_UNREACHABLE_REASONS, DEAD_CONTENT_FIELDS
} = require('./sourceLedgers');
const { statWriterCalls } = require('./ContentRegistry');
const { summarizeGaps } = require('./extensionGaps');
const PlayerMetrics = require('../stats/PlayerMetrics');

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** 计数：某个归一化后的内容路径是不是"发货路径" */
const isGrantPath = at => ITEM_GRANT_PATHS.some(g => g.re.test(at));
const isSinkPath = at => ITEM_SINK_PATHS.some(g => g.re.test(at));

/** 物品的来源账：分两种"没来源"（完全没被引用 / 只作为去路被引用），报告与棘轮判的是不同东西 */
function itemReachability(content) {
    const items = content.dataset('item_data')?.items || [];
    const pathsOf = new Map();                         // item id → 归一化后的引用路径集合
    for (const [raw, ids] of content.itemReferenceIndex().entries()) {
        const at = normalizeRefPath(raw);
        for (const id of ids) {
            if (!pathsOf.has(id)) pathsOf.set(id, new Set());
            pathsOf.get(id).add(at);
        }
    }
    const all = items.map(i => String(i.id));
    const packIds = new Set(items.filter(i => i.__content_origin).map(i => String(i.id)));
    const hasSource = id => [...(pathsOf.get(id) || [])].some(isGrantPath);
    const zeroSource = all.filter(id => !hasSource(id));
    return {
        total: all.length,
        fromPacks: packIds.size,
        withSource: all.filter(hasSource).length,
        zeroSource,
        noReferenceAtAll: zeroSource.filter(id => !(pathsOf.get(id) || []).size),
        referencedOnlyAsSink: zeroSource.filter(id => (pathsOf.get(id) || []).size > 0).length,
        zeroSourceInPacks: zeroSource.filter(id => packIds.has(id)),
        grantPathKinds: ITEM_GRANT_PATHS.length,
        sinkPathKinds: ITEM_SINK_PATHS.length,
        evidence: 'ContentRegistry.itemReferenceIndex() + game/content/sourceLedgers.js 的 ITEM_GRANT_PATHS / ITEM_SINK_PATHS'
    };
}

/** 称号的两本账（引用方向 + 来源方向） */
function titleReachability(content) {
    const titles = content.dataset('titles') || [];
    const known = new Set(titles.filter(t => t && t.id).map(t => String(t.id)));
    const grants = content.titleGrantIndex();
    const withSource = titles.filter(t => grants.has(String(t.id))).map(t => String(t.id));
    const zero = titles.filter(t => !grants.has(String(t.id))).map(t => String(t.id));
    return {
        total: titles.length,
        withSource: withSource.length,
        zeroSource: zero,
        danglingRefs: [...grants.keys()].filter(id => !known.has(id)),
        mirrorOccurrences: content.titleMirrorPaths().length,
        reasonLedgerComplete: zero.every(id => Object.prototype.hasOwnProperty.call(TITLE_UNREACHABLE_REASONS, id)),
        evidence: 'ContentRegistry.titleGrantIndex() / titleMirrorPaths() + sourceLedgers.TITLE_UNREACHABLE_REASONS'
    };
}

/** 玩家统计量词表的账：来源形状分布 + 每一格谁在写 */
function metricsLedger(content) {
    const table = content.dataset('player_metrics')?.metrics || {};
    const ids = Object.keys(table).filter(k => !k.startsWith('_'));
    const writers = statWriterCalls();
    const byKind = {};
    const statsKeys = [];
    for (const id of ids) {
        const from = String(table[id].from || '');
        const kind = from.includes('.') ? from.slice(0, from.indexOf('.')) : from;
        byKind[kind] = (byKind[kind] || 0) + 1;
        if (kind === 'stats') statsKeys.push({ id, key: from.slice('stats.'.length) });
    }
    return {
        total: ids.length,
        byKind,
        statsWritten: statsKeys.filter(s => writers.has(s.key)).map(s => s.id),
        statsPending: ids.filter(id => table[id].pending_writer !== undefined),
        statsLegacyWriter: ids.filter(id => table[id].legacy_writer !== undefined),
        statsUnwritten: statsKeys.filter(s => !writers.has(s.key) && table[s.id].pending_writer === undefined).map(s => s.id),
        evidence: 'ContentRegistry.statWriterCalls()（bumpStat / setStatKeys 两种形状）+ config/player_metrics.json'
    };
}

/** 成就的形状账：用了哪些奖励键、几档分组、每组几条、有没有死分组 */
function achievementReport(content) {
    const dataset = content.dataset('achievement_data') || {};
    const list = dataset.achievements || [];
    const categories = dataset.categories || {};
    const catKeys = Object.keys(categories).filter(k => !k.startsWith('_'));
    const rewardKeys = {};
    for (const a of list) {
        for (const k of Object.keys(a.reward || {})) rewardKeys[k] = (rewardKeys[k] || 0) + 1;
    }
    const perCategory = {};
    for (const key of catKeys) perCategory[key] = 0;
    for (const a of list) {
        const key = String(a.category);
        perCategory[key] = (perCategory[key] || 0) + 1;
    }
    return {
        total: list.length,
        rewardKeys,
        withItems: list.filter(a => Array.isArray(a.reward?.items)).length,
        withTitle: list.filter(a => !!a.reward?.title_id).length,
        categories: catKeys.length,
        deadCategories: catKeys.filter(key => !perCategory[key]),
        perCategory,
        evidence: 'config/achievement_data.json 合并视图；同一份数据由 ContentRegistry._validateAchievementRewards() 与 _validateAchievementCategories() 判'
    };
}

/** "写了但没人读"的字段：现数还剩几处（每一格都点名负责让它为 0 的那道闸） */
function deadFieldLedger(content) {
    const mirrors = content.titleMirrorPaths();
    const cats = content.dataset('achievement_data')?.categories || {};
    const counts = {
        achievement_category_color: Object.values(cats).filter(v => isObj(v) && v.color !== undefined).length,
        title_name_mirror: mirrors.length,
        legacy_writer: Object.entries(content.dataset('player_metrics')?.metrics || {})
            .filter(([, spec]) => isObj(spec) && spec.legacy_writer !== undefined).length,
        technique_grade_order: Object.values(content.dataset('technique_data')?.grades || {})
            .filter(v => isObj(v) && v.order !== undefined).length
    };
    return DEAD_CONTENT_FIELDS.map(entry => ({ ...entry, occurrences: counts[entry.id] ?? null }));
}

/**
 * 「配了、资料片却扩不动」的账：形状是一张条目表、却没登记成集合的区块。
 * 与前面几块的方向相反 —— 那几块判"玩家拿不拿得到"，这块判"以后加内容要不要改代码"。
 * 数字全部来自 `extensionGaps.summarizeGaps()`（棘轮与 tests/ContentExtensionGaps.test.js 判同一个函数）。
 */
function extensionLedger(content) {
    const g = summarizeGaps(content);
    return {
        registeredCollections: g.counts.registeredCollections,
        candidates: g.counts.candidates,
        open: g.counts.open,
        exempted: g.counts.exempted,
        withPointers: g.counts.withPointers,
        // 优先级由"被已登记条目当外键指着"决定，所以这里点名是哪根指针
        pointers: g.open.filter(r => r.pointerEntries > 0)
            .map(r => ({ id: r.id, entries: r.entries, via: r.pointers.map(p => `${p.field}×${p.entries}`), exit: r.exit })),
        openTop: g.open.slice(0, 10).map(r => ({ id: r.id, kind: r.kind, entries: r.entries })),
        staleExemptions: g.stale,
        staleExits: g.staleExits,
        evidence: g.evidence
    };
}

/** 装配本身：几套资料片、几个数据集、几个注册属性 */
function assemblyReport(content) {
    const report = content.report || {};
    const registry = content._statRegistryForValidation();
    return {
        packs: (report.packs || []).filter(p => p.enabled).map(p => `${p.id}@${p.version}`),
        datasets: content.datasets.size,
        // 注册中心自己那份计数（count 是它的访问器；退到 statKeys() 只是为了它改名时报告不撒谎）
        registeredStats: typeof registry.count === 'number'
            ? registry.count
            : (typeof registry.statKeys === 'function' ? registry.statKeys().length : null),
        sourceKinds: PlayerMetrics.sourceKinds(),
        evidence: 'ContentRegistry.load() 的 report + _statRegistryForValidation() + PlayerMetrics.sourceKinds()'
    };
}

/**
 * 整份报告。返回的是**结构化数据**，怎么打印由调用方（命令行 / 后台）决定。
 * @param {ContentRegistry} content 已经 load() 过的内容视图
 */
function buildReport(content) {
    return {
        generatedAt: new Date().toISOString(),
        assembly: assemblyReport(content),
        items: itemReachability(content),
        titles: titleReachability(content),
        metrics: metricsLedger(content),
        achievements: achievementReport(content),
        deadFields: deadFieldLedger(content),
        extension: extensionLedger(content)
    };
}

module.exports = {
    buildReport,
    itemReachability,
    titleReachability,
    metricsLedger,
    achievementReport,
    deadFieldLedger,
    extensionLedger,
    assemblyReport,
    normalizeRefPath,
    isGrantPath,
    isSinkPath
};
