/**
 * 属性最大值服务模块
 * 处理属性最大值计算、恢复机制、丹药效果等核心业务逻辑
 */
class AttributeMaxService {
    constructor() {
        this.configLoader = null;
        this.attributeConfig = null;
    }

    /**
     * 初始化属性最大值服务
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        // 移除对attribute_system配置的依赖，使用硬编码值
        this.attributeConfig = {};
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
        if (realmData.realm === '凡人') {
            return 0; // 凡人阶段无灵力
        }
        
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
        const recoveryConfig = this.attributeConfig?.attribute_recovery || {};
        const recoveryRates = recoveryConfig[`${recoveryType}_recovery`] || recoveryConfig.natural_recovery;
        
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