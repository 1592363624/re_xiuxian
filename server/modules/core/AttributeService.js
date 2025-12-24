/**
 * 属性服务模块
 * 处理玩家属性计算、成长、加点等核心业务逻辑
 */
class AttributeService {
    constructor() {
        this.configLoader = null;
    }

    /**
     * 初始化属性服务
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 获取角色初始化配置
     * @returns {Object} 角色初始化配置
     */
    getRoleInitConfig() {
        return this.configLoader?.getConfig('role_init') || {};
    }

    /**
     * 获取境界配置
     * @param {string} realmName - 境界名称
     * @returns {Object|null} 境界配置
     */
    getRealmConfig(realmName) {
        const config = this.configLoader?.getConfig('realm_breakthrough');
        if (!config?.realms) return null;
        return config.realms.find(r => r.name === realmName) || null;
    }

    /**
     * 计算玩家完整属性
     * @param {Object} player - 玩家对象
     * @returns {Object} 完整属性
     */
    calculateFullAttributes(player) {
        const attributes = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});
        
        const realm = this.getRealmConfig(player.realm);
        const roleConfig = this.getRoleInitConfig();

        const spiritRoot = player.spirit_root || '无';
        const spiritRootBonuses = roleConfig.spiritRootBonuses?.[spiritRoot] || {};

        const fullAttributes = {
            hp_max: (realm?.base_hp || 100) + (attributes.hp_bonus || 0) + (spiritRootBonuses.hp_max || 0),
            mp_max: (realm?.base_mp || 0) + (attributes.mp_bonus || 0) + (spiritRootBonuses.mp_max || 0),
            atk: (realm?.base_atk || 10) + (attributes.atk_bonus || 0) + (spiritRootBonuses.atk || 0),
            def: (realm?.base_def || 5) + (attributes.def_bonus || 0) + (spiritRootBonuses.def || 0),
            speed: (realm?.base_speed || 10) + (attributes.speed_bonus || 0) + (spiritRootBonuses.speed || 0),
            sense: (realm?.base_sense || 10) + (attributes.sense_bonus || 0),
            luck: (attributes.luck || 10),
            wisdom: (attributes.wisdom || 10),
            cultivate_speed: this.calculateCultivateSpeed(player, attributes),
            physique: this.calculatePhysique(player),
            talent: this.calculateTalent(player)
        };

        return fullAttributes;
    }

    /**
     * 计算修炼速度
     * @param {Object} player - 玩家对象
     * @param {Object} attributes - 基础属性
     * @returns {number} 修炼速度
     */
    calculateCultivateSpeed(player, attributes) {
        const baseSpeed = 10;
        const wisdomBonus = (attributes.wisdom || 10) * 0.5;
        const senseBonus = (player.attributes?.sense_bonus || 0) * 0.3;
        return Math.floor(baseSpeed + wisdomBonus + senseBonus);
    }

    /**
     * 计算体质
     * @param {Object} player - 玩家对象
     * @returns {number} 体质值
     */
    calculatePhysique(player) {
        const attributes = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});
        
        const hpBonus = attributes.hp_bonus || 0;
        const defBonus = attributes.def_bonus || 0;
        
        return Math.floor((hpBonus * 0.5) + (defBonus * 0.3) + 10);
    }

    /**
     * 计算天赋
     * @param {Object} player - 玩家对象
     * @returns {number} 天赋值
     */
    calculateTalent(player) {
        const attributes = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});
        
        const senseBonus = attributes.sense_bonus || 0;
        const wisdomBonus = attributes.wisdom || 10;
        
        return Math.floor((senseBonus * 0.5) + (wisdomBonus * 0.5) + 10);
    }

    /**
     * 获取灵根属性加成
     * @param {string} spiritRoot - 灵根类型
     * @returns {Object} 加成信息
     */
    getSpiritRootBonus(spiritRoot) {
        const roleConfig = this.getRoleInitConfig();
        return roleConfig.spiritRootBonuses?.[spiritRoot] || null;
    }

    /**
     * 属性加点
     * @param {Object} player - 玩家对象
     * @param {Object} points - 加点分配
     * @returns {Object} 加点结果
     */
    async allocatePoints(player, points) {
        const attributes = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});
        
        const availablePoints = player.attribute_points || 0;
        const totalPointsNeeded = Object.values(points).reduce((sum, p) => sum + p, 0);
        
        if (totalPointsNeeded > availablePoints) {
            return { 
                success: false, 
                message: `可用属性点不足，需要 ${totalPointsNeeded} 点，仅有 ${availablePoints} 点` 
            };
        }

        const newAttributes = { ...attributes };
        for (const [attr, value] of Object.entries(points)) {
            if (value > 0) {
                const bonusAttr = `${attr}_bonus`;
                newAttributes[bonusAttr] = (newAttributes[bonusAttr] || 0) + value;
            }
        }

        player.attributes = newAttributes;
        player.attribute_points = availablePoints - totalPointsNeeded;
        await player.save();

        return {
            success: true,
            message: '属性点分配成功',
            newAttributes: newAttributes,
            remainingPoints: player.attribute_points
        };
    }

    /**
     * 获取属性介绍
     * @param {string} attributeName - 属性名称
     * @returns {Object} 属性介绍
     */
    getAttributeDescription(attributeName) {
        const descriptions = {
            hp_max: '最大生命值，影响角色存活能力',
            mp_max: '最大灵力值，影响技能使用',
            atk: '攻击力，影响战斗伤害',
            def: '防御力，影响受到的伤害减免',
            speed: '速度，影响行动顺序和闪避率',
            sense: '感知，影响突破成功率和危险预知',
            luck: '幸运，影响暴击率和掉落奖励',
            wisdom: '智慧，影响修炼效率和技能领悟',
            cultivate_speed: '修炼速度，影响修为积累速度',
            physique: '体质，影响生命回复和抗性',
            talent: '天赋，影响突破概率和境界上限'
        };

        return {
            name: attributeName,
            description: descriptions[attributeName] || '未知属性',
            icon: this.getAttributeIcon(attributeName)
        };
    }

    /**
     * 获取属性图标
     * @param {string} attributeName - 属性名称
     * @returns {string} 图标标识
     */
    getAttributeIcon(attributeName) {
        const icons = {
            hp_max: '❤️',
            mp_max: '💙',
            atk: '⚔️',
            def: '🛡️',
            speed: '💨',
            sense: '👁️',
            luck: '🍀',
            wisdom: '📚',
            cultivate_speed: '📈',
            physique: '💪',
            talent: '⭐'
        };
        return icons[attributeName] || '📊';
    }

    /**
     * 计算战斗属性
     * @param {Object} player - 玩家对象
     * @param {string} battleType - 战斗类型
     * @returns {Object} 战斗属性
     */
    getBattleAttributes(player, battleType = 'normal') {
        const fullAttributes = this.calculateFullAttributes(player);
        const realm = this.getRealmConfig(player.realm);

        let attackMultiplier = 1;
        let defenseMultiplier = 1;
        let speedMultiplier = 1;

        switch (battleType) {
            case 'pvp':
                attackMultiplier = 1.2;
                defenseMultiplier = 0.8;
                break;
            case 'boss':
                attackMultiplier = 1.5;
                defenseMultiplier = 0.6;
                break;
            case 'training':
                attackMultiplier = 0.5;
                defenseMultiplier = 1.5;
                break;
        }

        return {
            attack: Math.floor(fullAttributes.atk * attackMultiplier),
            defense: Math.floor(fullAttributes.def * defenseMultiplier),
            maxHp: fullAttributes.hp_max,
            maxMp: fullAttributes.mp_max,
            speed: Math.floor(fullAttributes.speed * speedMultiplier),
            criticalRate: this.calculateCriticalRate(player, fullAttributes),
            hitRate: this.calculateHitRate(player, fullAttributes),
            dodgeRate: this.calculateDodgeRate(player, fullAttributes)
        };
    }

    /**
     * 计算暴击率
     * @param {Object} player - 玩家对象
     * @param {Object} attributes - 属性
     * @returns {number} 暴击率 (0-100)
     */
    calculateCriticalRate(player, attributes) {
        const luck = attributes.luck || 10;
        const realm = this.getRealmConfig(player.realm);
        const realmBonus = (realm?.rank || 0) * 0.5;
        
        return Math.min(50, Math.max(5, luck * 0.3 + realmBonus));
    }

    /**
     * 计算命中率
     * @param {Object} player - 玩家对象
     * @param {Object} attributes - 属性
     * @returns {number} 命中率 (0-100)
     */
    calculateHitRate(player, attributes) {
        const sense = attributes.sense || 10;
        return Math.min(100, Math.max(70, 80 + sense * 0.2));
    }

    /**
     * 计算闪避率
     * @param {Object} player - 玩家对象
     * @param {Object} attributes - 属性
     * @returns {number} 闪避率 (0-100)
     */
    calculateDodgeRate(player, attributes) {
        const speed = attributes.speed || 10;
        const luck = attributes.luck || 10;
        return Math.min(40, Math.max(5, speed * 0.15 + luck * 0.1));
    }
}

module.exports = new AttributeService();
