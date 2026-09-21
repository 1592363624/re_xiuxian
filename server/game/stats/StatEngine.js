/**
 * 属性求解引擎：把"一堆加成来源"归约成"一份最终属性"。
 *
 * 与旧实现的关键差别（旧代码在 calculateFullAttributes 里手写 9 个来源、
 *  三种互相冲突的百分比口径，新增来源或属性都要改这个函数）：
 *   1. 来源是注册进来的 Provider，引擎不认得"装备/灵兽/功法"这些具体玩法；
 *      新增一个加成来源 = 注册一个 provider，不碰引擎。
 *   2. 全部来源先归一化成同一种修饰符 {flat, pct}，再用唯一一条聚合规则求值：
 *        value = clamp((base + Σflat) * (1 + Σpct))
 *      不再有"这个来源乘基础、那个来源乘最终"的口径分裂。
 *   3. 属性集合、上下限、是否取整、派生公式全部来自 StatRegistry（数据）。
 *
 * 因此给一件武器加 matk 之后：面板、加点、战力、战斗公式、来源明细全部自动出现该属性。
 */
'use strict';

const Expr = require('./Expr');

/**
 * 把来源返回的各种历史写法归一化成 { statKey: {flat, pct} }。
 * 支持：
 *   { atk: 5 }                     → atk +5 绝对值
 *   { atk_pct: 20 } / 0.2          → atk +20%（pctUnit 决定数值口径）
 *   { atk: { flat: 5, pct: 0.2 } } → 结构化
 * 未知属性键不再静默丢弃：登记到 unknown，由引擎按 strict 决定抛错或告警。
 */
function normalizeModifiers(raw, options = {}) {
    const { pctUnit = 'percent_number', pctSuffix = '_pct' } = options;
    const out = {};
    const unknown = [];

    const toFraction = (value) => (pctUnit === 'fraction' ? value : value / 100);

    const put = (statKey, delta) => {
        if (!out[statKey]) out[statKey] = { flat: 0, pct: 0 };
        out[statKey].flat += delta.flat || 0;
        out[statKey].pct += delta.pct || 0;
    };

    if (!raw || typeof raw !== 'object') return { mods: out, unknown };

    for (const [key, value] of Object.entries(raw)) {
        if (key.endsWith(pctSuffix)) {
            const statKey = key.slice(0, -pctSuffix.length);
            if (typeof value !== 'number' || !Number.isFinite(value)) { unknown.push(key); continue; }
            put(statKey, { pct: toFraction(value) });
            continue;
        }

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            // 结构化写法的 pct 固定为"小数倍率"，与 pctUnit 无关
            const flat = typeof value.flat === 'number' ? value.flat : 0;
            const pct = typeof value.pct === 'number' ? value.pct : 0;
            put(key, { flat, pct });
            continue;
        }

        if (typeof value !== 'number' || !Number.isFinite(value)) { unknown.push(key); continue; }
        put(key, { flat: value });
    }

    return { mods: out, unknown };
}

class StatEngine {
    /**
     * @param {StatRegistry} registry
     * @param {Object} deps
     * @param {Object} deps.baseProviders 属性 base 取值环境（realm 配置、spirit 配置、attributes）
     * @param {boolean} [deps.strict] 运行期发现未知属性键时抛错。默认 false：
     *        配置写错由 ContentRegistry 在启动期硬校验拦下，运行期只告警并记入 meta，避免一个脏数据炸掉整条属性面板。
     */
    constructor(registry, deps = {}) {
        this.registry = registry;
        this.providers = [];
        this.strict = deps.strict === true;
        this.warnings = [];
    }

    /**
     * 注册一个加成来源。
     * @param {Object} provider { id, label, order, collect(ctx), pctUnit, pctSuffix, enabled(ctx) }
     */
    registerProvider(provider) {
        if (!provider || typeof provider.id !== 'string' || typeof provider.collect !== 'function') {
            throw new Error('属性来源必须有 id 与 collect(ctx)');
        }
        this.providers.push(provider);
        this.providers.sort((a, b) => (a.order || 100) - (b.order || 100));
        return this;
    }

    unregisterProvider(id) {
        this.providers = this.providers.filter(p => p.id !== id);
    }

    listProviders() { return this.providers.map(p => ({ id: p.id, label: p.label || p.id, order: p.order || 100 })); }

    /** 并行收集所有来源的原始加成（单个来源失败不影响整体，按空加成处理并记录） */
    async collect(ctx) {
        const failures = [];
        const active = this._applicableProviders(ctx);

        const results = await Promise.all(active.map(async (provider) => {
            try {
                const raw = await provider.collect(ctx);
                return { provider, raw: raw || {} };
            } catch (error) {
                failures.push({ id: provider.id, message: error.message });
                return { provider, raw: {}, failed: true };
            }
        }));

        return { collected: Object.fromEntries(results.map(r => [r.provider.id, r])), failures };
    }

    /**
     * 同步收集：只跑不查库的来源。
     * 副本/宗门战开局要用"不含装备的静态快照"（改造前就是这个口径，保持不变），
     * 因此需要一个不经过 await 的版本，而不是把异步结果硬塞成同步。
     */
    collectStatic(ctx) {
        const collected = {};
        for (const provider of this._applicableProviders(ctx)) {
            if (provider.requiresIo) continue;
            collected[provider.id] = { provider, raw: provider.collect(ctx) || {} };
        }
        return { collected, failures: [] };
    }

    _applicableProviders(ctx) {
        return this.providers.filter(p => !p.enabled || p.enabled(ctx));
    }

    /**
     * 求解最终属性（全来源，含查库来源）。
     * @param {Object} ctx 求解上下文，至少含 { player, realm, attributes }
     * @returns {Promise<{final, breakdown, info, meta}>}
     */
    async resolve(ctx) {
        return this._build(ctx, await this.collect(ctx));
    }

    /** 同步求解：跳过查库来源（装备/灵兽/功法/法宝深线） */
    resolveStatic(ctx) {
        return this._build(ctx, this.collectStatic(ctx));
    }

    _build(ctx, { collected, failures }) {
        const mods = {};            // statKey -> [{ providerId, flat, pct }]
        const unknownKeys = new Map(); // statKey -> [providerId]

        for (const [providerId, { provider, raw }] of Object.entries(collected)) {
            const { mods: normalized, unknown } = normalizeModifiers(raw, {
                pctUnit: provider.pctUnit || 'percent_number',
                pctSuffix: provider.pctSuffix || '_pct'
            });

            for (const [writtenKey, delta] of Object.entries(normalized)) {
                // 别名归一：现网内容里写的是 crit / dodge / hp_steal 这类老键名，
                // 必须先映射回规范属性键，否则它们会在"未知属性键"这一步被静默丢掉
                const def = this.registry.resolveStatKey(writtenKey);
                const statKey = def ? def.key : writtenKey;

                if (!this.registry.has(statKey)) {
                    if (!unknownKeys.has(writtenKey)) unknownKeys.set(writtenKey, []);
                    unknownKeys.get(writtenKey).push(providerId);
                    continue;
                }
                if (!mods[statKey]) mods[statKey] = [];
                mods[statKey].push({ providerId, ...delta });
            }
        }

        if (unknownKeys.size) {
            const detail = [...unknownKeys.entries()]
                .map(([statKey, from]) => `${statKey} <- ${from.join(',')}`).join('; ');
            if (this.strict) {
                throw new Error(`属性来源写入了未注册的属性键: ${detail}。请在 stat_definitions（或 DLC pack）中声明该属性。`);
            }
            this.warnings.push(`未注册属性键: ${detail}`);
        }

        const final = {};
        const breakdown = {};
        const resolvedDeps = {};

        for (const statKey of this.registry.resolutionOrder) {
            const def = this.registry.get(statKey);
            const contributions = mods[statKey] || [];

            let flatSum = 0;
            let pctSum = 0;
            const ignoredPct = [];

            for (const contribution of contributions) {
                flatSum += contribution.flat;
                if (def.agg === 'flat_only' && contribution.pct !== 0) {
                    ignoredPct.push({ from: contribution.providerId, pct: contribution.pct });
                    continue;
                }
                pctSum += contribution.pct;
            }

            const base = this._baseValue(def, ctx, resolvedDeps);
            let value = base + flatSum;
            if (def.agg === 'flat_then_pct') value = value * (1 + pctSum);
            if (def.min !== null && value < def.min) value = def.min;
            if (def.max !== null && value > def.max) value = def.max;
            value = def.floor ? Math.floor(value) : Math.round(value * 10000) / 10000;

            final[statKey] = value;
            resolvedDeps[statKey] = value;

            breakdown[statKey] = {
                base,
                agg: def.agg,
                sources: contributions.map(c => ({ from: c.providerId, flat: c.flat, pct: c.pct })),
                flat_total: flatSum,
                pct_total: contributions.reduce((sum, c) => sum + (def.agg === 'flat_then_pct' ? c.pct : 0), 0),
                ignored_pct: ignoredPct,
                final: value
            };
        }

        return {
            final,
            breakdown,
            info: this._infoFrom(ctx, collected),
            meta: {
                provider_failures: failures,
                unknown_stat_keys: [...unknownKeys.keys()],
                providers: this.listProviders().map(p => p.id),
                content_version: ctx.contentVersion || null
            }
        };
    }

    /** base 取值优先级：spiritField（灵力系统） > attributeField > realmField(+fallback) > constant > default */
    _baseValue(def, ctx, resolved) {
        if (def.derive) {
            const value = Expr.evaluate(def.derive, resolved, def.key);
            // 派生属性不再重复叠加 constant/default
            return value;
        }

        const { realmField, fallbackRealmField, spiritField, attributeField, constant, default: fallback } = def.base;
        const realm = ctx.realm || {};
        const attributes = ctx.attributes || {};

        if (spiritField && ctx.spiritRealm && Number.isFinite(Number(ctx.spiritRealm[spiritField]))) {
            return Number(ctx.spiritRealm[spiritField]);
        }
        if (attributeField && Number.isFinite(Number(attributes[attributeField])) && attributes[attributeField] !== null) {
            return Number(attributes[attributeField]);
        }
        if (realmField && Number.isFinite(Number(realm[realmField]))) return Number(realm[realmField]);
        if (fallbackRealmField && Number.isFinite(Number(realm[fallbackRealmField]))) return Number(realm[fallbackRealmField]);
        if (constant !== null) return constant;
        return fallback;
    }

    /**
     * info 由来源 provider 通过 ctx.infoContributions 追加（战斗要用的神通/特效等非数值信息），
     * 引擎本身不知道任何玩法。
     */
    _infoFrom(ctx, collected) {
        const info = { ...(ctx.baseInfo || {}) };
        for (const [providerId, { provider }] of Object.entries(collected)) {
            if (typeof provider.info !== 'function') continue;
            const contribution = provider.info(collected[providerId].raw, ctx);
            if (!contribution) continue;
            info[providerId] = contribution;
        }
        return info;
    }
}

module.exports = { StatEngine, normalizeModifiers };
