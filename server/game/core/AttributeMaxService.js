/**
 * 属性最大值服务模块
 * 处理属性最大值计算、恢复机制、丹药效果等核心业务逻辑
 */

/**
 * 丹药永久属性上限加成白名单：config/item_data.json 的 effect 字段 → player.attributes 存储键
 * 只有列在此处的键会被服务端采信；hp_restore / breakthrough_bonus / longevity_add 等
 * 由各自子系统（战斗回复、突破、寿元）单独处理，不属于属性上限加成
 */
const PILL_BONUS_KEY_MAP = {
    hp_max: 'hp_bonus',
    mp_max: 'mp_bonus',
    atk: 'atk_bonus',
    def: 'def_bonus',
    speed: 'speed_bonus',
    sense: 'sense_bonus'
};

/** 存储键 → 属性上限键，用于回显丹药使用后的上限值 */
const PILL_BONUS_TO_MAX_KEY = {
    hp_bonus: 'hp_max',
    mp_bonus: 'mp_max'
};

/** 兜底上限，attribute_system.json: attribute_pill_limits 缺失时生效 */
const DEFAULT_PILL_LIMITS = {
    max_increase_per_use: 500,
    max_total_bonus_per_attribute: 100000,
    max_temp_boost_minutes: 1440
};

/** 恢复结算兜底窗口：单次最多结算 24 小时，少于一分钟不结算 */
const DEFAULT_RECOVERY_SETTLEMENT = {
    max_window_minutes: 1440,
    min_settlement_minutes: 1
};

class AttributeMaxService {
    constructor() {
        this.configLoader = null;
        this.attributeConfig = null;
        this.spiritConfig = null;
    }

    /**
     * 初始化属性最大值服务
     * @param {Object} configLoader - 配置加载器实例
     */
    async initialize(configLoader) {
        this.configLoader = configLoader;
        // 加载灵力系统配置
        this.spiritConfig = await configLoader.loadConfig('spirit_system');
        try {
            this.attributeConfig = await configLoader.loadConfig('attribute_system');
        } catch (error) {
            // 配置文件不存在时使用默认配置
            this.attributeConfig = {};
            console.warn('配置文件不存在: attribute_system.json，将使用默认配置');
        }
    }

    /**
     * 计算玩家属性最大值
     *
     * 修复（2026-07-20）：
     *   原代码 `realmConfig?.[realm]` 把 realmConfig 当作 map 用（按境界名索引），
     *   但所有调用者传的都是 `RealmService.getRealmByName(player.realm)` 返回的
     *   单个境界对象（含 name 字段），导致 realmData 永远为 {}，最终所有境界
     *   的属性上限都退化为默认值（HP=100, MP=0）。
     *   现在智能识别 realmConfig 参数类型：
     *     - 数组（realms 列表）：按 player.realm 查找
     *     - 单个境界对象（含 name 字段）：直接使用
     *     - map（按境界名索引）：用 realmConfig[player.realm]
     *     - 空值：从 RealmService 实时查询
     *
     * @param {Object} player - 玩家对象
     * @param {Object|Array} realmConfig - 境界配置（单个境界对象 / realms 数组 / 按境界名索引的 map）
     * @returns {Object} 属性最大值对象
     */
    calculateAttributeMaxValues(player, realmConfig) {
        const attributes = player.attributes || {};
        const realm = player.realm || '凡人';

        // 智能识别 realmConfig 参数类型，提取当前境界的数据
        let realmData = {};
        if (Array.isArray(realmConfig)) {
            // 数组形式：按 name 字段查找
            realmData = realmConfig.find(r => r.name === realm) || {};
        } else if (realmConfig && typeof realmConfig === 'object') {
            if (realmConfig.name === realm) {
                // 单个境界对象：直接使用
                realmData = realmConfig;
            } else if (realmConfig[realm]) {
                // map 形式：按境界名索引
                realmData = realmConfig[realm];
            } else if (realmConfig.realms && Array.isArray(realmConfig.realms)) {
                // 包装对象：{ realms: [...] }
                realmData = realmConfig.realms.find(r => r.name === realm) || {};
            } else {
                // 兜底：尝试从 RealmService 实时查询
                try {
                    const RealmService = require('./RealmService');
                    const r = RealmService.getRealmByName(realm);
                    if (r) realmData = r;
                } catch (e) { /* 忽略，使用默认 {} */ }
            }
        } else if (!realmConfig) {
            // 未传：从 RealmService 实时查询
            try {
                const RealmService = require('./RealmService');
                const r = RealmService.getRealmByName(realm);
                if (r) realmData = r;
            } catch (e) { /* 忽略 */ }
        }

        // 根据境界计算最大值
        const maxValues = {
            hp_max: this.calculateHPMax(attributes, realmData),
            mp_max: this.calculateMPMax(attributes, realmData, realm),
            lifespan_max: this.calculateLifespanMax(attributes, realmData)
        };

        return maxValues;
    }

    /**
     * 计算气血最大值
     */
    calculateHPMax(attributes, realmData) {
        const baseHP = realmData.base_hp || 100;
        const realmMultiplier = realmData.hp_multiplier || 1;

        return Math.floor(baseHP * realmMultiplier);
    }

    /**
     * 计算灵力最大值
     *
     * 修复（2026-07-20）：
     *   原代码 `realmData.realm || '凡人'` 读取的是境界对象的 realm 字段，
     *   但 realm_breakthrough.json 中境界对象的字段名是 name（不是 realm），
     *   导致 realm 永远为 '凡人'，非凡人境界的 MP 上限全部错误退化为 0。
     *   现在从 player.realm 直接传入，避免字段名不匹配。
     */
    calculateMPMax(attributes, realmData, realm) {
        // 优先使用传入的 realm，否则尝试从 realmData.name 读取，最后兜底 '凡人'
        const actualRealm = realm || realmData?.name || '凡人';

        // 使用灵力系统配置
        if (this.spiritConfig && this.spiritConfig.realm_settings && this.spiritConfig.realm_settings[actualRealm]) {
            return this.spiritConfig.realm_settings[actualRealm].spirit_power_max || 0;
        }
        
        // 备用计算逻辑：按小境界自动计算
        if (realm === '凡人') {
            return 0; // 凡人阶段无灵力
        }
        
        // 解析境界层级（炼气/筑基用层数，其他用初期/中期/后期/大圆满）
        const realmMatch = realm.match(/(炼气期|筑基期)(\d+)层/);
        if (realmMatch) {
            const realmType = realmMatch[1];
            const layer = parseInt(realmMatch[2]);
            const growthCurve = this.spiritConfig?.spirit_power?.growth_curve || {};
            
            // 根据境界类型选择增长曲线
            if (growthCurve.linear?.apply_to?.includes(realmType)) {
                const linearConfig = growthCurve.linear;
                return linearConfig.base + (layer * linearConfig.per_level);
            } else {
                // 默认线性增长
                const baseValue = this.spiritConfig?.spirit_power?.base_value || 100;
                const increase = this.spiritConfig?.spirit_power?.realm_increase || 100;
                return baseValue + (layer * increase);
            }
        } else {
            // 其他境界用初期/中期/后期/大圆满格式
            const realmType = realm.replace(/(初期|中期|后期|大圆满)/, '');
            const growthCurve = this.spiritConfig?.spirit_power?.growth_curve || {};
            
            // 根据境界类型选择增长曲线
            if (growthCurve.exponential?.apply_to?.includes(realmType)) {
                const exponentialConfig = growthCurve.exponential;
                // 初期：1倍，中期：1.5倍，后期：2.25倍，大圆满：3.375倍
                const stageMultipliers = { '初期': 1, '中期': 1.5, '后期': 2.25, '大圆满': 3.375 };
                const stage = realm.match(/(初期|中期|后期|大圆满)/)[1];
                return Math.floor(exponentialConfig.base * stageMultipliers[stage]);
            } else if (growthCurve.logarithmic?.apply_to?.includes(realmType)) {
                const logarithmicConfig = growthCurve.logarithmic;
                // 初期：1倍，中期：1.2倍，后期：1.44倍，大圆满：1.728倍
                const stageMultipliers = { '初期': 1, '中期': 1.2, '后期': 1.44, '大圆满': 1.728 };
                const stage = realm.match(/(初期|中期|后期|大圆满)/)[1];
                return Math.floor(logarithmicConfig.base * stageMultipliers[stage]);
            } else {
                // 默认线性增长
                const baseValue = this.spiritConfig?.spirit_power?.base_value || 100;
                return baseValue * 10;
            }
        }
        
        // 兜底计算
        const baseMP = realmData.base_mp || 0;
        const realmMultiplier = realmData.mp_multiplier || 1;
        
        return Math.floor(baseMP * realmMultiplier);
    }

    /**
     * 计算寿命最大值
     */
    calculateLifespanMax(attributes, realmData) {
        const baseLifespan = realmData.base_lifespan || 60;
        const realmBonus = realmData.lifespan_bonus || 0;
        
        return Math.floor(baseLifespan + realmBonus);
    }

    /**
     * 计算装备道具对属性最大值的加成
     * @param {Object} player - 玩家对象
     * @param {string} attributeKey - 属性键名
     * @returns {number} 加成值
     */
    calculateItemBonus(player, attributeKey) {
        // TODO: 实现装备道具加成计算
        // 这里需要集成物品系统来计算装备加成
        return 0;
    }

    /**
     * 处理属性恢复逻辑
     *
     * 修复（2026-07-20）：
     *   原代码优先用 spirit_system.json 的 recovery 配置，但该配置字段名是
     *   `rate_per_minute` / `rate_per_second`，而非 `hp_recovery_per_minute`，
     *   导致 recoveryRates.hp_recovery_per_minute 为 undefined，调用时报错。
     *   且 spirit_system.json 只管 MP（灵力）的恢复速率，不管 HP（气血）。
     *   现在统一使用 attribute_system.json 的 attribute_recovery 配置，
     *   它同时包含 HP 和 MP 的恢复速率，字段名也一致。
     *   如果 attribute_system 配置缺失，使用硬编码默认值（自然恢复：HP/MP 各 1/分钟）。
     *
     * @param {Object} player - 玩家对象
     * @param {Object} maxValues - 属性最大值
     * @param {string} recoveryType - 恢复类型（natural/meditation）
     * @param {number} duration - 持续时间（分钟）
     * @returns {Object} 恢复后的属性值 { hp_current, mp_current, recovered: { hp, mp } }
     */
    processAttributeRecovery(player, maxValues, recoveryType, duration) {
        // 统一使用 attribute_system.json 的恢复速率配置
        // 字段结构：attribute_recovery.{recoveryType}_recovery.{hp,mp}_recovery_per_minute
        const recoveryConfig = this.attributeConfig?.attribute_recovery || {};
        const typeKey = `${recoveryType}_recovery`; // natural_recovery / meditation_recovery
        const recoveryRates = recoveryConfig[typeKey] || recoveryConfig.natural_recovery || {
            // 兜底默认值：自然恢复 HP/MP 各 1/分钟
            hp_recovery_per_minute: 1,
            mp_recovery_per_minute: 1,
            hp_recovery_multiplier: 1,
            mp_recovery_multiplier: 1
        };

        const currentHp = Number(player.hp_current || 0);
        const currentMp = Number(player.mp_current || 0);
        const maxHp = maxValues.hp_max || 100;
        const maxMp = maxValues.mp_max || 0;

        // 计算恢复量（不超过上限，且不超过剩余空间）
        const hpRate = recoveryRates.hp_recovery_per_minute || 0;
        const mpRate = recoveryRates.mp_recovery_per_minute || 0;
        const hpMult = recoveryRates.hp_recovery_multiplier || 1;
        const mpMult = recoveryRates.mp_recovery_multiplier || 1;

        const hpRecovery = Math.max(0, Math.min(
            Math.floor(hpRate * duration * hpMult),
            Math.max(0, maxHp - currentHp)
        ));
        const mpRecovery = Math.max(0, Math.min(
            Math.floor(mpRate * duration * mpMult),
            Math.max(0, maxMp - currentMp)
        ));

        return {
            hp_current: Math.min(currentHp + hpRecovery, maxHp),
            mp_current: Math.min(currentMp + mpRecovery, maxMp),
            recovered: {
                hp: hpRecovery,
                mp: mpRecovery
            }
        };
    }

    /**
     * 读取恢复结算窗口配置（attribute_system.json: attribute_recovery.recovery_settlement）
     * @returns {Object} { max_window_minutes, min_settlement_minutes }
     */
    getRecoverySettlementConfig() {
        const settlement = this.attributeConfig?.attribute_recovery?.recovery_settlement || {};
        const pick = (value, fallback) =>
            (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : fallback;

        return {
            max_window_minutes: pick(settlement.max_window_minutes, DEFAULT_RECOVERY_SETTLEMENT.max_window_minutes),
            min_settlement_minutes: pick(
                settlement.min_settlement_minutes,
                DEFAULT_RECOVERY_SETTLEMENT.min_settlement_minutes
            )
        };
    }

    /**
     * 解析本次可结算的恢复分钟数（以服务端时钟为唯一依据）
     *
     * 安全约束：区间起点是 attributes.last_recovery_time（缺失时退回 player.last_online），
     * 终点是服务器当前时间。客户端传入的期望分钟数只能收缩区间、不能放大，
     * 因此无法通过伪造 duration_minutes 瞬间回满或绕过恢复冷却。
     *
     * @param {Object} player - 玩家对象
     * @param {number} [requestedMinutes] - 客户端期望分钟数（可选，仅作上限收敛）
     * @returns {number} 实际可结算分钟数
     */
    resolveRecoveryMinutes(player, requestedMinutes = null) {
        const settlement = this.getRecoverySettlementConfig();
        const attributes = player?.attributes || {};
        const baselineRaw = attributes.last_recovery_time || player?.last_online;
        const baseline = baselineRaw ? new Date(baselineRaw).getTime() : NaN;

        // 无基准时间（新建角色首次结算）时视为无累计时长
        if (!Number.isFinite(baseline)) return 0;

        const elapsedMinutes = Math.floor((Date.now() - baseline) / 60000);
        let minutes = Math.max(0, Math.min(elapsedMinutes, settlement.max_window_minutes));

        // 未传时长时不做额外收敛（Number(null) 与 Number(undefined) 语义不同，需显式判空）
        const hasRequested = requestedMinutes !== null && requestedMinutes !== undefined && requestedMinutes !== '';
        const requested = Number(requestedMinutes);
        if (hasRequested && Number.isFinite(requested) && requested >= 0) {
            minutes = Math.min(minutes, Math.floor(requested));
        }

        return minutes < settlement.min_settlement_minutes ? 0 : minutes;
    }

    /**
     * 生成"恢复已结算"时点的 attributes 快照，调用方负责落库
     * 所有 HP/MP 恢复入口（登录离线恢复、在线定时恢复、/recover 接口）共用该基准，
     * 避免同一段时间被重复结算
     * @param {Object} player - 玩家对象
     * @returns {Object} 新的 attributes 对象
     */
    buildAttributesAfterRecovery(player) {
        const attributes = { ...(player?.attributes || {}) };
        attributes.last_recovery_time = new Date().toISOString();
        return attributes;
    }

    /**
     * 计算灵力消耗
     * @param {number} level - 技能/法宝等级
     * @param {string} type - 消耗类型（spell/treasure）
     * @returns {number} 灵力消耗量
     */
    calculateSpiritConsumption(level, type) {
        if (!this.spiritConfig || !this.spiritConfig.spirit_power || !this.spiritConfig.spirit_power.consumption) {
            return type === 'spell' ? 20 : 30;
        }
        
        const consumptionConfig = this.spiritConfig.spirit_power.consumption;
        const baseCost = type === 'spell' ? consumptionConfig.base_spell_cost : consumptionConfig.base_treasure_cost;
        const multiplier = Math.pow(consumptionConfig.multiplier_per_level, level - 1);
        
        return Math.floor(baseCost * multiplier);
    }

    /**
     * 读取丹药加点上限配置（attribute_system.json: attribute_pill_limits）
     * @returns {Object} { max_increase_per_use, max_total_bonus_per_attribute }
     */
    getPillLimitsConfig() {
        const limits = this.attributeConfig?.attribute_pill_limits || {};
        const pick = (value, fallback) =>
            (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : fallback;

        return {
            max_increase_per_use: pick(limits.max_increase_per_use, DEFAULT_PILL_LIMITS.max_increase_per_use),
            max_total_bonus_per_attribute: pick(
                limits.max_total_bonus_per_attribute,
                DEFAULT_PILL_LIMITS.max_total_bonus_per_attribute
            ),
            max_temp_boost_minutes: pick(limits.max_temp_boost_minutes, DEFAULT_PILL_LIMITS.max_temp_boost_minutes)
        };
    }

    /**
     * 从服务端物品配置的 effect 字段解析永久属性上限加成
     *
     * 安全约束：数值只来自 config/item_data.json，客户端无法指定；
     * 白名单外的效果字段（hp_restore / breakthrough_bonus 等）由各自子系统处理，此处忽略。
     *
     * @param {Object} rawEffect - 物品配置的 effect 对象
     * @returns {Object|null} { type: 'permanent_max_increase', attributes: { hp_bonus: n, ... } }
     */
    buildPillEffectFromConfig(rawEffect) {
        if (!rawEffect || typeof rawEffect !== 'object') return null;

        const attributes = {};
        for (const [effectKey, bonusKey] of Object.entries(PILL_BONUS_KEY_MAP)) {
            const raw = rawEffect[effectKey];
            if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
            attributes[bonusKey] = Math.floor(raw);
        }

        if (Object.keys(attributes).length === 0) return null;
        return { type: 'permanent_max_increase', attributes };
    }

    /**
     * 解析指定丹药 item_key 的永久属性上限加成效果
     * @param {string} itemKey - 丹药 item_key
     * @returns {Object|null} 效果对象，非消耗品或无属性上限加成时返回 null
     */
    getPillMaxIncreaseEffect(itemKey) {
        const items = this.configLoader?.getConfig('item_data')?.items || [];
        const item = items.find(i => i.id === itemKey);
        if (!item || item.type !== 'consumable') return null;

        return this.buildPillEffectFromConfig(item.effect);
    }

    /**
     * 清洗丹药效果：丢弃白名单外的键名、非正整数数值，并按单次上限钳制
     * 作为 applyPillEffect / applyPillBonusToAttributes 的统一兜底，
     * 确保即使调用方传入外部数据也无法注入任意属性
     * @param {Object} pillEffect - 待清洗的效果对象
     * @returns {Object|null} 清洗后的效果，无有效加成时返回 null
     */
    sanitizePillEffect(pillEffect) {
        if (!pillEffect || typeof pillEffect !== 'object') return null;

        const allowedBonusKeys = Object.values(PILL_BONUS_KEY_MAP);
        const limits = this.getPillLimitsConfig();
        const rawAttributes = (pillEffect.attributes && typeof pillEffect.attributes === 'object')
            ? pillEffect.attributes : {};

        const attributes = {};
        for (const [bonusKey, raw] of Object.entries(rawAttributes)) {
            if (!allowedBonusKeys.includes(bonusKey)) continue;
            const value = Math.floor(Number(raw));
            if (!Number.isFinite(value) || value <= 0) continue;
            attributes[bonusKey] = Math.min(value, limits.max_increase_per_use);
        }

        if (Object.keys(attributes).length === 0) return null;

        if (pillEffect.type === 'temporary_max_boost') {
            const duration = Number(pillEffect.duration);
            if (!Number.isFinite(duration) || duration <= 0) return null;
            return {
                type: 'temporary_max_boost',
                attributes,
                duration: Math.min(duration, limits.max_temp_boost_minutes)
            };
        }

        return { type: 'permanent_max_increase', attributes };
    }

    /**
     * 将丹药加成累加进玩家属性对象
     *
     * 钳制顺序：配置名义值 → 单次上限 → 乘以品质倍率 → 再次钳到单次上限，
     * 因此任何一次服用都不可能超过 max_increase_per_use，玩家属性总量也不会超过
     * max_total_bonus_per_attribute。
     *
     * @param {Object} attributes - 玩家当前 attributes
     * @param {Object} pillEffect - 服务端解析出的丹药效果
     * @param {number} [multiplier] - 品质倍率（炼制品 effect_multiplier，默认 1）
     * @returns {Object} 新的 attributes（不修改入参）
     */
    applyPillBonusToAttributes(attributes, pillEffect, multiplier = 1) {
        const next = { ...(attributes || {}) };
        const effect = this.sanitizePillEffect(pillEffect);
        if (!effect || effect.type !== 'permanent_max_increase') return next;

        const limits = this.getPillLimitsConfig();
        const qualityMultiplier = Number.isFinite(Number(multiplier)) && Number(multiplier) > 0
            ? Number(multiplier)
            : 1;

        for (const [bonusKey, increase] of Object.entries(effect.attributes)) {
            const gained = Math.min(Math.floor(increase * qualityMultiplier), limits.max_increase_per_use);
            if (gained <= 0) continue;
            const current = Number(next[bonusKey]) || 0;
            next[bonusKey] = Math.min(current + gained, limits.max_total_bonus_per_attribute);
        }

        return next;
    }

    /**
     * 计算属性加成前后的差值，用于回显本次实际获得的加成
     * @param {Object} previousAttributes - 变化前的 attributes
     * @param {Object} nextAttributes - 变化后的 attributes
     * @returns {Object} { hp_bonus: 40, ... }，无变化时为空对象
     */
    diffAttributeBonuses(previousAttributes, nextAttributes) {
        const before = previousAttributes || {};
        const after = nextAttributes || {};
        const allowedBonusKeys = Object.values(PILL_BONUS_KEY_MAP);

        const diff = {};
        for (const key of allowedBonusKeys) {
            const delta = (Number(after[key]) || 0) - (Number(before[key]) || 0);
            if (delta > 0) diff[key] = delta;
        }

        return diff;
    }

    /**
     * 应用丹药效果到属性最大值（用于回显，落库由 applyPillBonusToAttributes 负责）
     * @param {Object} player - 玩家对象
     * @param {Object} pillEffect - 丹药效果配置（内部会再清洗一次）
     * @returns {Object} 更新后的属性最大值
     */
    applyPillEffect(player, pillEffect) {
        const maxValues = this.calculateAttributeMaxValues(player);
        const effect = this.sanitizePillEffect(pillEffect);
        if (!effect) return maxValues;

        if (effect.type === 'permanent_max_increase') {
            // 永久提升最大值
            for (const [bonusKey, increase] of Object.entries(effect.attributes)) {
                const maxKey = PILL_BONUS_TO_MAX_KEY[bonusKey];
                if (maxKey && maxValues[maxKey] !== undefined) {
                    maxValues[maxKey] += increase;
                }
            }
        } else if (effect.type === 'temporary_max_boost') {
            // 临时提升最大值（需要记录时效）
            const boostKey = `temp_max_boost_${Date.now()}`;
            maxValues[boostKey] = {
                attributes: effect.attributes,
                expires_at: Date.now() + (effect.duration * 60 * 1000) // 转换为毫秒
            };
        }

        return maxValues;
    }

    /**
     * 验证当前属性值是否超过最大值
     * @param {Object} player - 玩家对象
     * @param {Object} maxValues - 属性最大值
     * @returns {Object} 验证结果
     */
    validateAttributeValues(player, maxValues) {
        const issues = [];
        
        if (player.hp_current > (maxValues.hp_max || 100)) {
            issues.push({
                attribute: 'hp_current',
                current: player.hp_current,
                max: maxValues.hp_max,
                action: 'clamp'
            });
        }

        if (player.mp_current > (maxValues.mp_max || 0)) {
            issues.push({
                attribute: 'mp_current',
                current: player.mp_current,
                max: maxValues.mp_max,
                action: 'clamp'
            });
        }

        return {
            valid: issues.length === 0,
            issues: issues,
            correctedValues: this.correctAttributeValues(player, maxValues, issues)
        };
    }

    /**
     * 修正超出最大值的属性
     * @param {Object} player - 玩家对象
     * @param {Object} maxValues - 属性最大值
     * @param {Array} issues - 验证问题列表
     * @returns {Object} 修正后的属性值
     */
    correctAttributeValues(player, maxValues, issues) {
        const corrected = { ...player };
        
        for (const issue of issues) {
            if (issue.action === 'clamp') {
                corrected[issue.attribute] = issue.max;
            }
        }

        return corrected;
    }

    /**
     * 获取属性恢复速率信息
     * @param {string} recoveryType - 恢复类型
     * @returns {Object} 恢复速率配置
     */
    getRecoveryRates(recoveryType) {
        return this.attributeConfig?.attribute_recovery?.[`${recoveryType}_recovery`] || 
               this.attributeConfig?.attribute_recovery?.natural_recovery || {};
    }
}

module.exports = new AttributeMaxService();
