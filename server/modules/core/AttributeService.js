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
     * 获取天赋配置
     */
    getTalentConfig(talentId) {
        const talents = this.configLoader?.getConfig('talents') || [];
        return talents.find(t => t.id === talentId) || null;
    }

    /**
     * 获取称号配置
     */
    getTitleConfig(titleId) {
        const titles = this.configLoader?.getConfig('titles') || [];
        return titles.find(t => t.id === titleId) || null;
    }

    /**
     * 获取所有称号配置
     */
    getAllTitles() {
        return this.configLoader?.getConfig('titles') || [];
    }

    /**
     * 计算玩家完整属性
     * @param {Object} player - 玩家对象
     * @returns {Object} 完整属性对象 { final, breakdown, info }
     */
    calculateFullAttributes(player) {
        const attributes = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});
        
        const realm = this.getRealmConfig(player.realm);
        const roleConfig = this.getRoleInitConfig();

        // 1. 基础属性 (Realm Base)
        // 如果没有境界配置，使用默认值
        const base = {
            hp_max: realm?.base_hp || 100,
            mp_max: realm?.base_mp || 0,
            atk: realm?.base_atk || 10,
            def: realm?.base_def || 5,
            speed: realm?.base_speed || 10,
            sense: realm?.base_sense || 10,
            luck: attributes.luck || 10,
            wisdom: attributes.wisdom || 10,
            cultivate_speed: 10 // 基础修炼速度
        };

        // 计算衍生基础属性
        // 2. 灵根加成
        const spiritRoot = player.spirit_root || '无';
        const spiritRootBonuses = roleConfig.spiritRootBonuses?.[spiritRoot] || {};
        
        // 3. 分配点数/丹药加成 (Allocated/Pills)
        const allocated = {
            hp_max: attributes.hp_bonus || 0,
            mp_max: attributes.mp_bonus || 0,
            atk: attributes.atk_bonus || 0,
            def: attributes.def_bonus || 0,
            speed: attributes.speed_bonus || 0,
            sense: attributes.sense_bonus || 0
        };

        // 4. 天赋加成
        const talent = this.getTalentConfig(player.talent_id);
        // 天赋可能有百分比加成，需要基于当前基础(base)计算
        const talentBonus = this.calculateBonuses(base, talent?.bonuses);

        // 5. 称号加成
        const title = this.getTitleConfig(player.equipped_title_id);
        const titleBonus = this.calculateBonuses(base, title?.bonuses);

        // 6. 装备加成 (Placeholder)
        // TODO: 需要集成装备系统
        const equipmentBonus = {};

        // 汇总计算
        const final = { ...base };
        
        // 辅助函数：叠加属性
        const addAttr = (target, source) => {
            if (!source) return;
            for (const [k, v] of Object.entries(source)) {
                if (typeof v === 'number') {
                    target[k] = (target[k] || 0) + v;
                }
            }
        };

        addAttr(final, spiritRootBonuses);
        addAttr(final, allocated);
        addAttr(final, talentBonus);
        addAttr(final, titleBonus);
        addAttr(final, equipmentBonus);

        // 重新计算依赖最终属性的衍生属性
        // 修炼速度 = 基础 + 智慧*0.5 + 神识*0.3
        const wisdom = final.wisdom;
        const sense = final.sense;
        final.cultivate_speed = Math.floor(final.cultivate_speed + wisdom * 0.5 + sense * 0.3);
        
        // 应用修炼速度加成 (如果有百分比)
        // 检查各来源是否有 cultivate_speed_pct
        let cultivateSpeedPct = 0;
        if (talent?.bonuses?.cultivate_speed_pct) cultivateSpeedPct += talent.bonuses.cultivate_speed_pct;
        if (title?.bonuses?.cultivate_speed_pct) cultivateSpeedPct += title.bonuses.cultivate_speed_pct;
        
        final.cultivate_speed = Math.floor(final.cultivate_speed * (1 + cultivateSpeedPct / 100));

        return {
            final,
            breakdown: {
                base,
                spirit_root: spiritRootBonuses,
                allocated,
                talent: talentBonus,
                title: titleBonus,
                equipment: equipmentBonus,
                cultivation: { // 功法加成 (Placeholder)
                   hp_max: 0, mp_max: 0, atk: 0, def: 0
                }
            },
            info: {
                talent,
                title,
                spirit_root: spiritRoot
            }
        };
    }

    /**
     * 计算属性加成 (处理数值和百分比)
     */
    calculateBonuses(base, bonuses) {
        const result = {};
        if (!bonuses) return result;

        for (const [key, value] of Object.entries(bonuses)) {
            if (key.endsWith('_pct')) {
                // 百分比加成，不直接加到属性上，而是单独处理或转换
                // 这里我们只处理直接属性的百分比转换? 
                // 比如 atk_pct -> atk += base.atk * pct
                const baseKey = key.replace('_pct', '');
                if (base[baseKey] !== undefined) {
                    result[baseKey] = (result[baseKey] || 0) + Math.floor(base[baseKey] * value / 100);
                }
                // 保留百分比字段以便后续使用
                result[key] = value;
            } else {
                result[key] = value;
            }
        }
        return result;
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
                // 映射前端属性名到后端存储名 (如果需要)
                // 前端: atk, def, hp, sense, speed
                // 后端存储: atk_bonus, def_bonus, hp_bonus, sense_bonus, speed_bonus
                
                let bonusAttr = `${attr}_bonus`;
                if (attr === 'hp') bonusAttr = 'hp_bonus'; // hp -> hp_bonus (mapped to hp_max usually)
                
                newAttributes[bonusAttr] = (newAttributes[bonusAttr] || 0) + value;
            }
        }

        player.attributes = newAttributes;
        player.attribute_points = availablePoints - totalPointsNeeded;
        await player.save();

        // 重新计算并返回完整属性，以便前端更新
        const fullStats = this.calculateFullAttributes(player);

        return {
            success: true,
            message: '属性点分配成功',
            newAttributes: fullStats.final, // 返回最新的最终属性
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
            talent: '⭐'
        };
        return icons[attributeName] || '📊';
    }
}

module.exports = new AttributeService();
