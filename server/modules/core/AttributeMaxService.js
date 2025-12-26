/**
 * 属性最大值服务模块
 * 处理属性最大值计算、恢复机制、丹药效果等核心业务逻辑
 */
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
    initialize(configLoader) {
        this.configLoader = configLoader;
        // 加载灵力系统配置
        this.spiritConfig = configLoader.loadConfig('spirit_system');
        try {
            this.attributeConfig = configLoader.loadConfig('attribute_system');
        } catch (error) {
            // 配置文件不存在时使用默认配置
            this.attributeConfig = {};
            console.warn('配置文件不存在: attribute_system.json，将使用默认配置');
        }
    }

    /**
     * 计算玩家属性最大值
     * @param {Object} player - 玩家对象
     * @param {Object} realmConfig - 境界配置
     * @returns {Object} 属性最大值对象
     */
    calculateAttributeMaxValues(player, realmConfig) {
        const attributes = player.attributes || {};
        const realm = player.realm || '凡人';
        const realmData = realmConfig?.[realm] || {};
        
        // 根据境界计算最大值
        const maxValues = {
            hp_max: this.calculateHPMax(attributes, realmData),
            mp_max: this.calculateMPMax(attributes, realmData),
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
     */
    calculateMPMax(attributes, realmData) {
        const realm = realmData.realm || '凡人';
        
        // 使用灵力系统配置
        if (this.spiritConfig && this.spiritConfig.realm_settings && this.spiritConfig.realm_settings[realm]) {
            return this.spiritConfig.realm_settings[realm].spirit_power_max || 0;
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
     * @param {Object} player - 玩家对象
     * @param {Object} maxValues - 属性最大值
     * @param {string} recoveryType - 恢复类型（natural/meditation）
     * @param {number} duration - 持续时间（分钟）
     * @returns {Object} 恢复后的属性值
     */
    processAttributeRecovery(player, maxValues, recoveryType, duration) {
        // 优先使用灵力系统配置
        let recoveryRates = {};
        if (this.spiritConfig && this.spiritConfig.spirit_power && this.spiritConfig.spirit_power.recovery) {
            recoveryRates = this.spiritConfig.spirit_power.recovery[recoveryType] || this.spiritConfig.spirit_power.recovery.natural;
        } else {
            // 备用配置
            const recoveryConfig = this.attributeConfig?.attribute_recovery || {};
            recoveryRates = recoveryConfig[`${recoveryType}_recovery`] || recoveryConfig.natural_recovery;
        }
        
        const currentHp = player.hp_current || 0;
        const currentMp = player.mp_current || 0;
        const maxHp = maxValues.hp_max || 100;
        const maxMp = maxValues.mp_max || 0;

        // 计算恢复量
        const hpRecovery = Math.min(
            Math.floor(recoveryRates.hp_recovery_per_minute * duration * (recoveryRates.hp_recovery_multiplier || 1)),
            maxHp - currentHp
        );

        const mpRecovery = Math.min(
            Math.floor(recoveryRates.mp_recovery_per_minute * duration * (recoveryRates.mp_recovery_multiplier || 1)),
            maxMp - currentMp
        );

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
     * 应用丹药效果到属性最大值
     * @param {Object} player - 玩家对象
     * @param {Object} pillEffect - 丹药效果配置
     * @returns {Object} 更新后的属性最大值
     */
    applyPillEffect(player, pillEffect) {
        const maxValues = this.calculateAttributeMaxValues(player);
        
        if (pillEffect.type === 'permanent_max_increase') {
            // 永久提升最大值
            for (const [attrKey, increase] of Object.entries(pillEffect.attributes)) {
                const maxKey = `${attrKey}_max`;
                if (maxValues[maxKey] !== undefined) {
                    maxValues[maxKey] += increase;
                }
            }
        } else if (pillEffect.type === 'temporary_max_boost') {
            // 临时提升最大值（需要记录时效）
            const boostKey = `temp_max_boost_${Date.now()}`;
            maxValues[boostKey] = {
                attributes: pillEffect.attributes,
                expires_at: Date.now() + (pillEffect.duration * 60 * 1000) // 转换为毫秒
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