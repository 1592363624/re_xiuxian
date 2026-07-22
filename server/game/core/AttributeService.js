/**
 * 属性服务模块
 * 处理玩家属性计算、成长、加点等核心业务逻辑
 *
 * 装备加成集成说明：
 *   - calculateFullAttributes 保持同步，通过 player._equipmentBonus 读取装备加成
 *   - calculateFullAttributesAsync 为异步版本，内部获取装备加成后调用同步方法
 *   - 需要装备加成的调用方应使用 calculateFullAttributesAsync
 *
 * 灵兽加成集成说明（2026-07-20 新增）：
 *   - 出战灵兽会按比例加成玩家属性（atk/def/hp_max/speed）
 *   - 加成比例 = base_rate + star_level * star_rate + level * level_rate（上限 max_rate）
 *   - 通过 player._spiritBeastBonus 传入（异步版本自动填充）
 *   - 加成来源记录在 breakdown.spirit_beast 中，便于前端展示
 *
 * 法宝深线加成集成说明（2026-07-22 新增）：
 *   - 三条法宝深线（血魔剑/虚天鼎/大五行幻世轮）提供战力加成
 *   - 血魔剑：百分比加成（atk/def + battle 特效：暴击/吸血/反噬）
 *   - 虚天鼎：绝对值加成（atk/def + 化极倍率 + 反噬）
 *   - 大五行幻世轮：百分比加成（atk/def/hp_max/speed + 相位 × 阶数倍率）
 *   - 掌天瓶为纯辅助法宝，无战力加成，不参与属性计算
 *   - 通过 player._artifactDeepLineBonus 传入（异步版本自动填充）
 *   - 归一化结构：{ is_active, absolute, percent, effects, breakdown }
 *   - absolute 直接叠加到 final；percent 基于 final 乘算；effects 记录在 breakdown.artifact_deep_line.effects
 */
const EquipmentService = require('../services/EquipmentService');
const SpiritBeastService = require('../services/SpiritBeastService');
const ArtifactDeepLineService = require('../services/ArtifactDeepLineService');

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
     *
     * 修复（2026-07-20）：
     *   原代码 base.mp_max = realm?.base_mp || 0，使用 realm_breakthrough.json 的 base_mp，
     *   但 AttributeMaxService.calculateMPMax 使用 spirit_system.json 的 spirit_power_max，
     *   两套 MP 上限系统数值不一致（化神初期 base_mp=3200 vs spirit_power_max=100000），
     *   导致 mp_current 可恢复到 100000，但前端显示 mp_max=3200，出现 mp_current > mp_max 的混乱。
     *   现在统一使用 spirit_system.json 的 spirit_power_max 作为 MP 上限，与 AttributeMaxService 保持一致。
     *
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
        // 修复：mp_max 统一使用 spirit_system.json 的 spirit_power_max，与 AttributeMaxService 保持一致
        const spiritSystemConfig = this.configLoader?.getConfig('spirit_system');
        const spiritPowerMax = spiritSystemConfig?.realm_settings?.[player.realm]?.spirit_power_max;
        const base = {
            hp_max: realm?.base_hp || 100,
            mp_max: (typeof spiritPowerMax === 'number') ? spiritPowerMax : (realm?.base_mp || 0),
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

        // 6. 装备加成（由调用方通过 player._equipmentBonus 传入，异步版本会自动填充）
        const equipmentBonus = player._equipmentBonus || {};

        // 7. 灵兽加成（由调用方通过 player._spiritBeastBonus 传入，异步版本会自动填充）
        // 出战灵兽按比例加成 atk/def/hp_max/speed 等
        const spiritBeastBonus = player._spiritBeastBonus || {};
        const spiritBeastInfo = spiritBeastBonus.beast_info || null;
        // 剔除 beast_info 字段后剩下的就是纯属性加成
        const spiritBeastAttrBonus = {};
        for (const [k, v] of Object.entries(spiritBeastBonus)) {
            if (k !== 'beast_info' && typeof v === 'number') {
                spiritBeastAttrBonus[k] = v;
            }
        }

        // 8. 法宝深线加成（由调用方通过 player._artifactDeepLineBonus 传入，异步版本会自动填充）
        // 归一化结构：{ is_active, absolute, percent, effects, breakdown }
        //   - absolute: 绝对值加成（直接叠加到 final）
        //   - percent: 百分比加成（基于 final 乘算，0.05 表示 +5%）
        //   - effects: 战斗特殊效果（暴击/吸血/反噬等，不体现在属性面板）
        const artifactDeepLineBonus = player._artifactDeepLineBonus || null;

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
        addAttr(final, spiritBeastAttrBonus);

        // 8.1 法宝深线 - 绝对值加成（虚天鼎的 atk/def 绝对值）
        if (artifactDeepLineBonus && artifactDeepLineBonus.is_active) {
            addAttr(final, artifactDeepLineBonus.absolute);
        }

        // 8.2 法宝深线 - 百分比加成（血魔剑/大五行幻世轮的 atk/def/hp_max/speed 百分比）
        // 百分比加成基于当前 final 属性乘算（在绝对值加成之后，确保基数最大）
        const artifactDeepLinePercentApplied = {};
        if (artifactDeepLineBonus && artifactDeepLineBonus.is_active && artifactDeepLineBonus.percent) {
            for (const [key, rate] of Object.entries(artifactDeepLineBonus.percent)) {
                if (typeof rate === 'number' && rate !== 0 && typeof final[key] === 'number') {
                    const bonusValue = Math.floor(final[key] * rate);
                    final[key] += bonusValue;
                    artifactDeepLinePercentApplied[key] = bonusValue;
                }
            }
        }

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
                spirit_beast: spiritBeastAttrBonus, // 灵兽属性加成
                artifact_deep_line: { // 法宝深线加成（2026-07-22 新增）
                    is_active: !!(artifactDeepLineBonus && artifactDeepLineBonus.is_active),
                    absolute: artifactDeepLineBonus?.absolute || {},
                    percent_applied: artifactDeepLinePercentApplied, // 实际叠加的百分比值（已转换为绝对值）
                    effects: artifactDeepLineBonus?.effects || {}, // 战斗特殊效果（暴击/吸血/反噬等）
                    sources: artifactDeepLineBonus?.breakdown || {} // 各法宝深线原始返回
                },
                cultivation: { // 功法加成 (Placeholder)
                   hp_max: 0, mp_max: 0, atk: 0, def: 0
                }
            },
            info: {
                talent,
                title,
                spirit_root: spiritRoot,
                spirit_beast: spiritBeastInfo, // 灵兽简要信息（beast_id/beast_name/element/star_level/level/bonus_rate/combat_power）
                artifact_deep_line: artifactDeepLineBonus?.effects || null // 法宝深线战斗特效（供战斗系统读取）
            }
        };
    }

    /**
     * 计算玩家完整属性（异步版本，包含装备加成 + 灵兽加成 + 法宝深线加成）
     * 内部获取装备加成、灵兽加成和法宝深线加成后临时挂载到 player 对象，再调用同步方法计算
     * 调用后自动清理临时属性，不影响 player 原始数据
     *
     * 2026-07-22 新增法宝深线加成集成：
     *   - 三条法宝深线（血魔剑/虚天鼎/大五行幻世轮）的战力加成并行查询
     *   - 血魔剑：百分比加成 + 战斗特效（暴击/吸血/反噬）
     *   - 虚天鼎：绝对值加成（atk/def）+ 化极倍率 + 反噬
     *   - 大五行幻世轮：百分比加成（相位 × 阶数倍率）
     *
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} 完整属性对象 { final, breakdown, info }
     */
    async calculateFullAttributesAsync(player) {
        // 并行获取装备总加成、灵兽加成和法宝深线加成（提升性能）
        const [equipmentBonus, spiritBeastBonus, artifactDeepLineBonus] = await Promise.all([
            EquipmentService.getEquipmentBonus(player.id),
            SpiritBeastService.getActiveBeastBonus(player.id),
            // 法宝深线加成查询失败时回退到 inactive 状态，不影响属性计算主流程
            ArtifactDeepLineService.getAllArtifactDeepLineCombatBonuses(player.id).catch(() => ({ is_active: false, absolute: {}, percent: {}, effects: {}, breakdown: {} }))
        ]);
        // 临时挂载到 player 对象，供同步方法读取
        player._equipmentBonus = equipmentBonus;
        player._spiritBeastBonus = spiritBeastBonus;
        player._artifactDeepLineBonus = artifactDeepLineBonus;
        const result = this.calculateFullAttributes(player);
        // 清理临时属性，避免污染 player 原始数据
        delete player._equipmentBonus;
        delete player._spiritBeastBonus;
        delete player._artifactDeepLineBonus;
        return result;
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
