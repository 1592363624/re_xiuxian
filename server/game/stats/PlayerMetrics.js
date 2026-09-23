/**
 * 玩家统计量（metric）取数：成就、洞府祖业、后台看的"玩家做到哪儿了"共用这一份实现。
 *
 * 为什么要单独一个模块（2026-09-22）：以前这些数散在三处，而且三处互相不认识 ——
 *   ① `AchievementService.METRIC_SOURCES`：一张 `metric → (player) => player.xxx` 的代码表，
 *      而它点的 `player.kill_count / meditation_count / exploration_count` **根本不是 players 的列**
 *      （计数住在 players.stats 那坨 JSON 里）→ 取到 undefined → 按 0 处理，
 *      于是 34 条成就里 14 条永远停在 0%，接口照样返回"进度 0/5"，没有任何地方报错。
 *      这与当年 spirit_root provider 读 `player.spirit_root`（模型里没这列）是同一个病。
 *   ② `CaveLegacyService` 把"总修行次数"手写成一个六项求和（meditation/breakthrough/kill/
 *      exploration/alchemy/refining）→ 新加的计数永远进不了祖业。
 *   ③ players.stats 里那些计数值本身是 v0.3 时代留下的：现在的代码一件都不往上涨。
 * 现在：词表在内容里（`config/player_metrics.json`，登记成 map 集合，资料片可以加一档），
 * 取数只有这里一份，求和集合由内容自己声明（`cumulative_command`），
 * 事件点统一走 `PlayerStateStore.bumpStat` 累加。
 *
 * 来源形状（写别的启动期抛，见 ContentRegistry._validatePlayerMetrics）：
 *   stats.<key>   players.stats 里的 JSON 计数
 *   column.<列名>  players 上的标量列（BigInt 会自动转数字）
 *   attr.<属性键>  属性引擎解析出来的最终值（必须是注册属性 —— 于是资料片新属性直接就能被成就引用）
 *   query.<名字>  下面 QUERIES 里注册过的取数函数（真的要去查库的那几档）
 *   realm_index   按 players.realm 这个**名字**查境界 rank（不读 realm_rank 列，那列会和名字不同步）
 */
'use strict';

const Player = require('../../models/player');
const { logOnce } = require('../../utils/logOnce');

/** 需要查库的度量都登记在这里：键名就是内容里 `query.<名字>` 的那一段 */
const QUERIES = {
    /** 广结善缘：到访过玩家洞府的**不同访客数**（同一个访客来一百次也只算一个人） */
    cave_distinct_visitors: async (player) => {
        const CaveVisitor = require('../../models/caveVisitor');
        return Number(await CaveVisitor.count({
            where: { cave_owner_id: player.id },
            distinct: true,
            col: 'visitor_id'
        })) || 0;
    }
};

/**
 * 服务装配时注入的 ConfigLoader（合并视图）。
 * 为什么不只依赖全局单例：单元测试里全局 ConfigLoader 没 initialize，
 * 那样 PlayerMetrics 会静默拿到空表 → 度量全 0 → 又变成"配了但读不到"那一族。
 * 所以启动时（initializeGameServices）与测试装配时都显式注一份。
 */
let injectedLoader = null;

function configure(options = {}) {
    if (options.configLoader !== undefined) injectedLoader = options.configLoader;
}

/** 内容层读法：优先注入的 loader，其次全局 ConfigLoader（合并视图，热更后也认），不 require JSON */
function metricsTable(configLoader) {
    const loader = configLoader || injectedLoader || require('../../modules').infrastructure.ConfigLoader;
    let table = null;
    try {
        table = loader?.getConfig('player_metrics')?.metrics || null;
    } catch (error) {
        logOnce('PlayerMetrics.table', `player_metrics 读取失败，成就度量按"未配置"兜底: ${error.message}`);
    }
    return table || {};
}

function specOf(id, configLoader) {
    return metricsTable(configLoader)[id] || null;
}

function knownMetricIds(configLoader) {
    return Object.keys(metricsTable(configLoader));
}

/** 内容里声明"进祖业总修行次数"的那些 stats 计数键（CaveLegacyService 用它求和，不再自己抄清单） */
function commandCounterKeys(configLoader) {
    const table = metricsTable(configLoader);
    const keys = [];
    for (const spec of Object.values(table)) {
        if (spec?.cumulative_command !== true) continue;
        const from = String(spec.from || '');
        if (!from.startsWith('stats.')) continue;      // 列/属性那类不是"次数"，不参与求和
        keys.push(from.slice('stats.'.length));
    }
    return keys;
}

function toNumber(value) {
    const n = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * 取一个度量的当前值。
 * @param {string} id 内容里声明的度量名（成就的 `metric` 字段）
 * @param {Object} player players 实例（或同形状的普通对象）
 * @param {Object} [options] { configLoader, resolvedStats } —— resolvedStats 传进来就不重复解析属性
 * @returns {Promise<number>} 取不到一律 0（但"取不到"在启动期就已经被闸拦掉了，运行期这里只可能是玩家真没这项数据）
 */
async function metricValue(id, player, options = {}) {
    const spec = specOf(id, options.configLoader);
    if (!spec) {
        logOnce(`PlayerMetrics.missing.${id}`,
            `度量 "${id}" 没在 player_metrics 里登记，进度会一直是 0（成就/后台引用了个不存在的统计量）`);
        return 0;
    }
    const from = String(spec.from || '');
    const dot = from.indexOf('.');
    const kind = dot < 0 ? from : from.slice(0, dot);
    const key = dot < 0 ? '' : from.slice(dot + 1);

    if (kind === 'column') return toNumber(player?.[key]);
    if (kind === 'stats') return toNumber(parseStats(player)?.[key]);
    if (kind === 'realm_index') {
        const RealmService = require('../core/RealmService');
        const cfg = player?.realm ? RealmService.getRealmByName(player.realm) : null;
        return cfg && cfg.rank ? toNumber(cfg.rank) : 0;
    }
    if (kind === 'attr') {
        const resolved = options.resolvedStats || await resolveAttr(player, options);
        return toNumber(resolved?.[key]);
    }
    if (kind === 'query') {
        const fn = QUERIES[key];
        if (!fn) {
            logOnce(`PlayerMetrics.query.${key}`, `度量 "${id}" 指向未登记的查询 query.${key}，按 0 处理`);
            return 0;
        }
        return toNumber(await fn(player));
    }
    logOnce(`PlayerMetrics.shape.${id}`, `度量 "${id}" 的来源形状不认识：from="${from}"（支持 stats/column/attr/query/realm_index）`);
    return 0;
}

async function resolveAttr(player, options) {
    const CombatResolver = require('../combat/CombatResolver');
    const { stats } = await CombatResolver.resolveCombatStats(player);
    return stats;
}

/** players.stats 可能是对象（JSON 列）也可能是字符串（历史行），两种都要能读 */
function parseStats(player) {
    const raw = player?.stats;
    if (!raw) return {};
    if (typeof raw === 'string') {
        try { return JSON.parse(raw) || {}; } catch { return {}; }
    }
    return typeof raw === 'object' ? raw : {};
}

/** 供启动期校验与后台展示：这台服务真能算的来源形状有哪些 */
function sourceKinds() {
    return ['stats', 'column', 'attr', 'query', 'realm_index'];
}

/** players 上真实存在的列名（启动闸校验 `column.<列名>` 用；不写死清单，模型改了自动跟上） */
function playerColumns() {
    return Object.keys(Player.rawAttributes || {});
}

module.exports = {
    configure,
    metricsTable,
    specOf,
    knownMetricIds,
    commandCounterKeys,
    metricValue,
    parseStats,
    sourceKinds,
    playerColumns,
    QUERIES
};
