/**
 * 属性注册中心：全游戏"有哪些属性、属性怎么算、谁能用它"的唯一权威。
 *
 * 解决的问题：此前属性词表散落在 23+ 处硬编码清单里
 * （AttributeService 的 base/白名单/图标/描述、AttributeMaxService 的丹药白名单、
 *  game_balance 的祭炼倍率、各 Service 的战力公式、routes 的响应字段枚举、前端标签表）。
 * 加一个属性（例如给武器加法攻）要逐个改。现在只改数据。
 *
 * 定义来源：config/stat_definitions.json（基础层）+ DLC pack 的 stats 数据集（追加层），
 * 由 ContentRegistry 合并后调用 load()。
 */
'use strict';

const Expr = require('./Expr');

const UNITS = new Set(['point', 'percent']);
const AGGREGATIONS = new Set(['flat_then_pct', 'flat_only']);

const REQUIRED = ['key', 'label'];

class StatDefinitionError extends Error {}

/** 归一化单条定义并校验；任何非法定义在启动期抛错，而不是运行期静默失效 */
function normalize(raw, origin = 'base') {
    if (!raw || typeof raw !== 'object') throw new StatDefinitionError(`属性定义不是对象 (来自 ${origin})`);
    for (const field of REQUIRED) {
        if (typeof raw[field] !== 'string' || raw[field].trim() === '') {
            throw new StatDefinitionError(`属性定义缺少 ${field} (来自 ${origin})`);
        }
    }
    if (!/^[a-z][a-z0-9_]*$/.test(raw.key)) {
        throw new StatDefinitionError(`属性 key "${raw.key}" 必须为 snake_case (来自 ${origin})`);
    }

    const unit = raw.unit || 'point';
    if (!UNITS.has(unit)) throw new StatDefinitionError(`属性 ${raw.key} 的 unit "${unit}" 非法`);

    const agg = raw.agg || (unit === 'percent' ? 'flat_only' : 'flat_then_pct');
    if (!AGGREGATIONS.has(agg)) throw new StatDefinitionError(`属性 ${raw.key} 的 agg "${agg}" 非法`);
    if (unit === 'percent' && agg === 'flat_then_pct') {
        throw new StatDefinitionError(`属性 ${raw.key} 为 percent 单位时不能用 flat_then_pct（百分点不再乘百分比）`);
    }

    const base = raw.base || {};
    if (typeof base !== 'object') throw new StatDefinitionError(`属性 ${raw.key} 的 base 必须是对象`);

    const panel = raw.panel || {};
    const def = {
        key: raw.key,
        label: raw.label,
        icon: raw.icon || '📊',
        description: raw.description || '',
        group: raw.group || 'other',
        unit,
        agg,
        base: {
            realmField: base.realmField || null,
            fallbackRealmField: base.fallbackRealmField || null,
            spiritField: base.spiritField || null,
            attributeField: base.attributeField || null,
            constant: typeof base.constant === 'number' ? base.constant : null,
            default: typeof base.default === 'number' ? base.default : 0
        },
        derive: typeof raw.derive === 'string' && raw.derive.trim() ? raw.derive : null,
        min: Number.isFinite(raw.min) ? raw.min : null,
        max: Number.isFinite(raw.max) ? raw.max : null,
        floor: raw.floor !== false,
        // 玩家可加点：客户端提交键 → attributes 存储键
        allocatable: raw.allocatable === true,
        allocInputKey: raw.allocInputKey || raw.key,
        bonusKey: raw.bonusKey || `${raw.key}_bonus`,
        // 丹药等永久加成：物品 effect 字段 → attributes 存储键
        pill: raw.pill === true,
        pillEffectKey: raw.pillEffectKey || raw.key,
        // 别名：现网物品/法宝 effect 用的是 hp_steal、crit、dodge 这类老键名，映射到规范属性键
        aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(a => typeof a === 'string' && a) : [],
        // 装备祭炼每级加成系数（0 表示不参与祭炼成长）
        refineRate: Number.isFinite(raw.refineRate) ? raw.refineRate : 0,
        // 战力评分权重（0 表示不计入战力）
        powerWeight: Number.isFinite(raw.powerWeight) ? raw.powerWeight : 0,
        panel: {
            visible: panel.visible !== false,
            order: Number.isFinite(panel.order) ? panel.order : 1000,
            suffix: panel.suffix || (unit === 'percent' ? '%' : ''),
            // 窄位（左栏属性格、装备卡角标）用的短名，缺省回落到 label
            shortLabel: panel.shortLabel || raw.label,
            // 展示位置：sidebar = 左栏常驻属性格；detail = 属性详情/悬浮层。
            // 左栏宽度是量出来的（w-72 三列，格内 px-1/text-base），不能什么都往里塞，
            // 所以由定义决定，前端不再自己写死一份属性清单。
            spot: panel.spot === 'sidebar' ? 'sidebar' : 'detail'
        },
        battleRoles: Array.isArray(raw.battleRoles) ? raw.battleRoles.filter(r => typeof r === 'string') : [],
        origin
    };

    if (def.derive) {
        try {
            Expr.referencedIdents(def.derive);
        } catch (error) {
            throw new StatDefinitionError(`属性 ${def.key} 的 derive 表达式非法: ${error.message}`);
        }
    }

    return def;
}

class StatRegistry {
    constructor() {
        this.reset();
    }

    reset() {
        this._stats = new Map();
        this._byBonusKey = new Map();
        this._byAlias = new Map();
        this._loaded = false;
    }

    /** 载入一组定义（重复 key 视为覆盖：DLC 可改基础属性；来源会记录在覆盖者身上） */
    load(rawDefs = [], origin = 'base') {
        for (const raw of rawDefs) {
            const def = normalize(raw, origin);
            this._stats.set(def.key, def);
        }
        this._reindex();
        return this;
    }

    _reindex() {
        this._byBonusKey = new Map();
        this._byAlias = new Map();
        for (const def of this._stats.values()) {
            if (this._byBonusKey.has(def.bonusKey)) {
                throw new StatDefinitionError(
                    `属性 ${def.key} 的存储键 ${def.bonusKey} 与 ${this._byBonusKey.get(def.bonusKey).key} 冲突`
                );
            }
            this._byBonusKey.set(def.bonusKey, def);

            for (const alias of def.aliases) {
                if (this._stats.has(alias)) {
                    throw new StatDefinitionError(`属性 ${def.key} 的别名 ${alias} 与另一个属性键冲突`);
                }
                if (this._byAlias.has(alias)) {
                    throw new StatDefinitionError(
                        `属性 ${def.key} 的别名 ${alias} 已被 ${this._byAlias.get(alias).key} 占用`
                    );
                }
                this._byAlias.set(alias, def);
            }
        }
        this._ordered = this.all().sort((a, b) => a.panel.order - b.panel.order || a.key.localeCompare(b.key));
        this._loaded = true;
    }

    /** 装配期总校验：派生公式依赖必须存在、不能有环、加点输入键不能撞车 */
    validate() {
        const errors = [];

        for (const def of this._stats.values()) {
            if (!def.derive) continue;
            for (const dep of Expr.referencedIdents(def.derive)) {
                if (!this._stats.has(dep)) {
                    errors.push(`属性 ${def.key} 的 derive 引用了未注册的属性 "${dep}"`);
                }
            }
        }

        const inputKeys = new Map();
        for (const def of this._stats.values()) {
            if (!def.allocatable) continue;
            if (inputKeys.has(def.allocInputKey)) {
                errors.push(`加点输入键 ${def.allocInputKey} 同时属于 ${def.key} 与 ${inputKeys.get(def.allocInputKey)}`);
            }
            inputKeys.set(def.allocInputKey, def.key);
        }

        const cycleError = this._findCycle();
        if (cycleError) errors.push(cycleError);

        if (errors.length) {
            throw new StatDefinitionError(`属性注册中心校验失败:\n  - ${errors.join('\n  - ')}`);
        }
        return true;
    }

    /** 派生依赖拓扑排序，顺带检出环 */
    _findCycle() {
        const WHITE = 0, GRAY = 1, BLACK = 2;
        const color = new Map();
        for (const key of this._stats.keys()) color.set(key, WHITE);

        const visit = (key, path) => {
            color.set(key, GRAY);
            const def = this._stats.get(key);
            const deps = def && def.derive ? [...Expr.referencedIdents(def.derive)] : [];
            for (const dep of deps) {
                if (!this._stats.has(dep)) continue; // validate() 已报
                const nextPath = [...path, dep];
                if (color.get(dep) === GRAY) return `属性派生成环: ${nextPath.join(' -> ')}`;
                if (color.get(dep) === WHITE) {
                    const found = visit(dep, nextPath);
                    if (found) return found;
                }
            }
            color.set(key, BLACK);
            return null;
        };

        for (const key of color.keys()) {
            if (color.get(key) !== WHITE) continue;
            const found = visit(key, [key]);
            if (found) return found;
        }
        return null;
    }

    get resolutionOrder() {
        // 被派生属性依赖的属性先算
        const sorted = [];
        const seen = new Set();
        const push = (key) => {
            if (seen.has(key)) return;
            seen.add(key);
            const def = this._stats.get(key);
            if (def && def.derive) {
                for (const dep of Expr.referencedIdents(def.derive)) {
                    if (this._stats.has(dep)) push(dep);
                }
            }
            sorted.push(key);
        };
        for (const key of this._stats.keys()) push(key);
        return sorted;
    }

    all() { return [...this._stats.values()]; }
    get(key) { return this._stats.get(key) || null; }
    has(key) { return this._stats.has(key); }
    get isLoaded() { return this._loaded; }
    get count() { return this._stats.size; }

    /** 从 attributes 存储键反查属性定义 */
    fromBonusKey(bonusKey) { return this._byBonusKey.get(bonusKey) || null; }

    /** 可加点白名单：客户端属性名 → attributes 存储键（取代 ALLOCATABLE_BONUS_KEYS） */
    allocatableMap() {
        const out = {};
        for (const def of this._stats.values()) {
            if (def.allocatable) out[def.allocInputKey] = def.bonusKey;
        }
        return out;
    }

    allocatableKeys() {
        return this._ordered.filter(d => d.allocatable).map(d => d.allocInputKey);
    }

    /** 丹药永久加成白名单：物品 effect 字段 → attributes 存储键（取代 PILL_BONUS_KEY_MAP） */
    pillEffectMap() {
        const out = {};
        for (const def of this._stats.values()) {
            if (def.pill) out[def.pillEffectKey] = def.bonusKey;
        }
        return out;
    }

    /** 祭炼每级成长系数（取代 game_balance 里手抄的 bonus_per_level） */
    refineRateMap() {
        const out = {};
        for (const def of this._stats.values()) {
            if (def.refineRate > 0) out[def.key] = def.refineRate;
        }
        return out;
    }

    /** 面板字段（含标签/图标/说明/后缀），前端直接渲染，不再各自硬编码 */
    panelStats() {
        return this._ordered
            .filter(d => d.panel.visible)
            .map(d => ({
                key: d.key,
                label: d.label,
                shortLabel: d.panel.shortLabel,
                icon: d.icon,
                description: d.description,
                suffix: d.panel.suffix,
                unit: d.unit,
                group: d.group,
                order: d.panel.order,
                spot: d.panel.spot,
                // 别名：现网物品/功法 effect 用 crit、dodge、hp_steal 这类老键名，
                // 一并下发，前端就不需要再抄一份"键名→标签"表了
                aliases: d.aliases,
                // 加点表单也按这份渲染：客户端提交 allocInputKey，服务端按注册表白名单校验
                allocatable: d.allocatable,
                allocInputKey: d.allocInputKey,
                bonusKey: d.bonusKey
            }));
    }

    /** 只取需要常驻显示在某处的属性（spot 为 null 时返回全部可见属性） */
    panelStatsFor(spot) {
        const all = this.panelStats();
        return spot ? all.filter(s => s.spot === spot) : all;
    }

    /** 所有可展示/可写入的属性键，供响应裁剪与调试 */
    statKeys() { return [...this._stats.keys()]; }

    battleRoleIndex() {
        const index = {};
        for (const def of this._stats.values()) {
            for (const role of def.battleRoles) {
                if (!index[role]) index[role] = [];
                index[role].push(def.key);
            }
        }
        return index;
    }

    /** 规范键或别名 → 属性定义；用于把物品 effect / 神通字段映射回属性 */
    resolveStatKey(name) {
        if (this._stats.has(name)) return this._stats.get(name);
        return this._byAlias.get(name) || null;
    }

    /** 该键名是否可作为一种属性加成写入（规范键、别名或存储键）——拼错属性名要能查得出来 */
    acceptsEffectKey(effectKey) {
        return this._stats.has(effectKey)
            || this._byAlias.has(effectKey)
            || Boolean(this._byBonusKey.get(effectKey));
    }
}

module.exports = { StatRegistry, StatDefinitionError, normalize, UNITS, AGGREGATIONS };
