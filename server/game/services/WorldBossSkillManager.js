/**
 * 世界BOSS 技能管理器
 *
 * 职责：
 *   1. 根据当前阶段从配置读取可用技能表
 *   2. 按权重随机选择下一个触发的技能（含冷却检查）
 *   3. 执行技能效果：
 *      - single_target_basic / single_target_skill: 单体伤害
 *      - aoe_all: AOE 伤害（影响当前攻击者，并广播给所有参战玩家）
 *      - summon: 召唤小怪（存入 boss.minions）
 *      - self_buff: BOSS 自身 Buff（ATK 提升 / 吸血 / 免控）
 *      - ultimate_screen_wide: 全屏必杀（高倍率 AOE）
 *   4. 管理 Buff 过期清理
 *   5. 解析 effect 字符串获取参数（如 atk_up_50_percent → 0.5）
 *
 * 配置来源：
 *   - 静态技能表：world_boss_data.json → bosses[].skills[phase].skills[]
 *   - 全局配置：game_balance.json → world_boss.boss_skills
 *
 * 设计说明：
 *   - 技能冷却用 ms 时间戳记录在 boss.skill_cooldowns JSON 字段
 *   - Buff 用列表记录在 boss.active_buffs JSON 字段，过期自动清理
 *   - 小怪用列表记录在 boss.minions JSON 字段，限上限 max_minions_per_boss
 *   - 调用方负责在事务内保存 boss 实例
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

/**
 * 获取世界BOSS配置
 * @returns {Object} world_boss_data 配置对象
 */
function getWorldBossDataConfig() {
    return configLoader.getConfig('world_boss_data') || {};
}

/**
 * 获取 game_balance 中的 world_boss 配置
 * @returns {Object} world_boss 配置块
 */
function getWorldBossBalanceConfig() {
    const balance = configLoader.getConfig('game_balance') || {};
    return balance.world_boss || {};
}

/**
 * 获取 BOSS 技能系统全局配置
 * @returns {Object} boss_skills 配置块
 */
function getBossSkillsConfig() {
    const wbCfg = getWorldBossBalanceConfig();
    return wbCfg.boss_skills || {};
}

class WorldBossSkillManager {
    /**
     * 根据 boss_key 和当前阶段获取可用技能列表
     * @param {string} bossKey - BOSS 配置键（如 qingyuanzi）
     * @param {number} phase - 当前阶段（1/2/3）
     * @returns {Array} 可用技能列表（每项含 name/description/type/damage_multiplier/cooldown_seconds/effect）
     */
    static getSkillsForPhase(bossKey, phase) {
        const config = getWorldBossDataConfig();
        const bossStatic = (config.bosses || []).find(b => b.boss_key === bossKey);
        if (!bossStatic || !bossStatic.skills) return [];

        // skills 数组按 phase 字段分组，每个 phase 有 2 个技能
        const phaseGroup = bossStatic.skills.find(s => s.phase === phase);
        if (!phaseGroup || !Array.isArray(phaseGroup.skills)) return [];

        return phaseGroup.skills;
    }

    /**
     * 选择下一个触发的技能（按权重随机 + 冷却检查）
     *
     * 算法：
     *   1. 获取当前阶段所有技能
     *   2. 过滤掉冷却中的技能
     *   3. 根据技能 type 分配权重（basic=50, skill=30, aoe=15, summon=3, buff=1, ultimate=1）
     *   4. 加权随机选择
     *   5. 如果所有技能都在冷却，返回基础技能（damage_multiplier=1.0）
     *
     * @param {string} bossKey - BOSS 配置键
     * @param {number} phase - 当前阶段
     * @param {Object} skillCooldowns - 当前冷却状态 { skill_name: expire_ms }
     * @param {Object} activeBuffs - 当前激活的 Buff 列表
     * @returns {Object|null} 选中的技能对象，附带 _cooldown_ms 字段
     */
    static selectSkill(bossKey, phase, skillCooldowns, activeBuffs) {
        const skillsCfg = getBossSkillsConfig();
        const availableSkills = this.getSkillsForPhase(bossKey, phase);
        if (availableSkills.length === 0) return null;

        const now = Date.now();
        const cooldowns = skillCooldowns || {};

        // 过滤掉冷却中的技能
        const readySkills = availableSkills.filter(s => {
            const expire = cooldowns[s.name] || 0;
            return expire <= now;
        });

        // 如果所有技能都在冷却，返回一个虚拟的基础攻击（伤害 1.0x，无特效）
        if (readySkills.length === 0) {
            return {
                name: '普通攻击',
                description: 'BOSS 暂无可用技能，进行普通攻击',
                type: 'single_target_basic',
                damage_multiplier: 1.0,
                cooldown_seconds: 0,
                effect: 'none',
                _cooldown_ms: 0
            };
        }

        // 如果有 self_buff 技能且已激活同类 Buff，跳过避免重复叠加
        const buffFilterEnabled = skillsCfg.enable_self_buff !== false;
        const filteredSkills = readySkills.filter(s => {
            if (s.type === 'self_buff' && buffFilterEnabled) {
                // 检查是否已有同类 Buff 激活
                const hasSameBuff = (activeBuffs || []).some(b => b.effect === s.effect);
                return !hasSameBuff;
            }
            return true;
        });

        const candidates = filteredSkills.length > 0 ? filteredSkills : readySkills;

        // 按技能 type 分配权重
        const weights = {
            single_target_basic: skillsCfg.basic_skill_weight || 50,
            single_target_skill: skillsCfg.skill_weight || 30,
            aoe_all: skillsCfg.aoe_weight || 15,
            summon: skillsCfg.summon_weight || 3,
            self_buff: skillsCfg.buff_weight || 1,
            ultimate_screen_wide: skillsCfg.ultimate_weight || 1
        };

        // 加权随机选择
        const totalWeight = candidates.reduce((sum, s) => sum + (weights[s.type] || 1), 0);
        let rand = Math.random() * totalWeight;
        for (const s of candidates) {
            rand -= (weights[s.type] || 1);
            if (rand <= 0) {
                return { ...s, _cooldown_ms: (s.cooldown_seconds || 0) * 1000 };
            }
        }

        // 兜底返回第一个
        return { ...candidates[0], _cooldown_ms: (candidates[0].cooldown_seconds || 0) * 1000 };
    }

    /**
     * 执行技能效果，返回技能执行结果
     *
     * @param {Object} boss - BOSS 实例（含 atk/phase/skill_cooldowns/active_buffs/minions）
     * @param {Object} skill - 选中的技能对象（来自 selectSkill）
     * @param {Object} target - 目标玩家运行时状态 { battleHp, battleHpMax, playerDef, playerBeastElement }
     * @param {Object} ctx - 上下文 { bossKey, bossElement, cfgBalance, playerId }
     * @returns {Object} 技能执行结果
     *   {
     *     skill_name, skill_type, damage_multiplier,
     *     counter_damage,            // 对当前攻击者造成的伤害
     *     aoe_damage,                // AOE 伤害（同 counter_damage，区分用于前端展示）
     *     is_aoe,                    // 是否 AOE
     *     is_summon,                 // 是否召唤
     *     is_buff,                   // 是否 Buff
     *     minions_summoned,          // 本次召唤的小怪列表
     *     buff_applied,              // 本次施加的 Buff
     *     lifesteal_amount,          // 吸血回复量
     *     boss_hp_recovered,         // BOSS HP 实际回复量
     *     description                // 技能描述
     *   }
     */
    static executeSkill(boss, skill, target, ctx) {
        const cfg = getBossSkillsConfig();
        const result = {
            skill_name: skill.name,
            skill_type: skill.type,
            damage_multiplier: skill.damage_multiplier,
            counter_damage: 0,
            aoe_damage: 0,
            is_aoe: false,
            is_summon: false,
            is_buff: false,
            minions_summoned: [],
            buff_applied: null,
            lifesteal_amount: 0,
            boss_hp_recovered: 0,
            description: skill.description || ''
        };

        // 计算 BOSS 当前攻击力（含 Buff 加成）
        const bossAtk = this.getEffectiveBossAtk(boss);
        const bossElement = ctx.bossElement || null;
        const playerBeastElement = target.playerBeastElement || null;

        // BOSS→玩家相克系数
        const counterFactor = this._calculateElementalCounter(bossElement, playerBeastElement);

        // 玩家防御减伤（2026-07-21 新增）
        // 与玩家攻击 BOSS 的减伤公式对称：def_reduction = def / (def + atk * 2 + 1000)
        // 设计目的：让玩家 DEF 属性在 BOSS 战中有意义，避免 BOSS 反击直接秒杀
        // 化神初期玩家 def=560, BOSS atk=2000：
        //   def_reduction = 560 / (560 + 4000 + 1000) = 0.1007 → 减伤 10%
        //   反击伤害 = 2000 * 1.0 * 0.8993 * 1.0 * 1.0 = 1799（原为 2000，减伤 10%）
        // 高防御玩家（如 def=2000）：
        //   def_reduction = 2000 / (2000 + 4000 + 1000) = 0.286 → 减伤 28.6%
        //   反击伤害 = 2000 * 1.0 * 0.714 * 1.0 * 1.0 = 1428（减伤 28.6%）
        const playerDef = Number(target.playerDef) || 0;
        const counterDefReduction = playerDef / (playerDef + bossAtk * 2 + 1000);

        switch (skill.type) {
            case 'single_target_basic':
            case 'single_target_skill': {
                // 单体伤害 = BOSS ATK * 技能倍率 * (1 - def_reduction) * 相克系数 * 随机浮动
                const randomFactor = 0.9 + Math.random() * 0.2;
                const damage = Math.floor(
                    bossAtk * skill.damage_multiplier * (1 - counterDefReduction)
                    * counterFactor * randomFactor
                );
                result.counter_damage = damage;
                // 处理附加效果（流血/眩晕/破甲）—— 简化处理，仅记录 effect 字段
                result.effect = skill.effect;
                break;
            }

            case 'aoe_all':
            case 'ultimate_screen_wide': {
                // AOE / 全屏必杀：对当前攻击者造成伤害，其他参战玩家通过 Socket 广播
                // 注意：ultimate_screen_wide 使用更高的伤害倍率（2.5-3.0x）
                const randomFactor = 0.9 + Math.random() * 0.2;
                const damage = Math.floor(
                    bossAtk * skill.damage_multiplier * (1 - counterDefReduction)
                    * counterFactor * randomFactor
                );
                result.counter_damage = damage;
                result.aoe_damage = damage;
                result.is_aoe = true;
                result.effect = skill.effect;
                break;
            }

            case 'summon': {
                // 召唤小怪：根据 BOSS HP 比例计算小怪属性
                // 限制最大小怪数量，超过上限不再召唤
                result.is_summon = true;
                const maxMinions = cfg.max_minions_per_boss || 5;
                const currentMinions = boss.minions || [];
                if (currentMinions.length < maxMinions) {
                    const minion = this._generateMinion(boss, ctx.bossKey, skill);
                    if (minion) {
                        result.minions_summoned.push(minion);
                    }
                }
                break;
            }

            case 'self_buff': {
                // BOSS 自身 Buff：ATK 提升 / 吸血 / 免控
                result.is_buff = true;
                const buff = this._generateBuff(skill, cfg);
                if (buff) {
                    result.buff_applied = buff;
                }
                break;
            }

            default:
                // 未知技能类型，按基础攻击处理
                result.counter_damage = Math.floor(
                    bossAtk * (1 - counterDefReduction) * counterFactor
                );
                break;
        }

        // 吸血处理（如果 BOSS 有 lifesteal Buff 激活）
        const hasLifesteal = (boss.active_buffs || []).some(b => b.lifesteal_percent > 0);
        if (hasLifesteal && result.counter_damage > 0) {
            const lifestealBuff = (boss.active_buffs || []).find(b => b.lifesteal_percent > 0);
            const lifestealRatio = (lifestealBuff?.lifesteal_percent || 0) / 100;
            result.lifesteal_amount = Math.floor(result.counter_damage * lifestealRatio);
        }

        return result;
    }

    /**
     * 获取 BOSS 当前有效攻击力（含 Buff 加成）
     * @param {Object} boss - BOSS 实例
     * @returns {number} 有效攻击力
     */
    static getEffectiveBossAtk(boss) {
        const baseAtk = Number(boss.atk) || 0;
        const buffs = boss.active_buffs || [];
        // 所有 Buff 的 atk_up_percent 累加
        const totalAtkUpPercent = buffs.reduce((sum, b) => sum + (b.atk_up_percent || 0), 0);
        return Math.floor(baseAtk * (1 + totalAtkUpPercent / 100));
    }

    /**
     * 检查 BOSS 是否免控（用于未来扩展玩家控制技能）
     * @param {Object} boss - BOSS 实例
     * @returns {boolean} 是否免控
     */
    static isImmuneControl(boss) {
        return (boss.active_buffs || []).some(b => b.immune_control === true);
    }

    /**
     * 清理已过期的 Buff
     * @param {Object} boss - BOSS 实例
     * @returns {Array} 本次清理的 Buff 名称列表
     */
    static cleanupExpiredBuffs(boss) {
        if (!boss.active_buffs || boss.active_buffs.length === 0) return [];
        const now = Date.now();
        const expired = [];
        const remaining = [];
        for (const buff of boss.active_buffs) {
            if (buff.expire_at && buff.expire_at <= now) {
                expired.push(buff.name);
            } else {
                remaining.push(buff);
            }
        }
        if (expired.length > 0) {
            boss.active_buffs = remaining;
        }
        return expired;
    }

    /**
     * 清理已过期的小怪
     * @param {Object} boss - BOSS 实例
     * @returns {Array} 本次清理的小怪 ID 列表
     */
    static cleanupExpiredMinions(boss) {
        if (!boss.minions || boss.minions.length === 0) return [];
        const cfg = getBossSkillsConfig();
        const expireSeconds = cfg.minion_expire_seconds || 60;
        const now = Date.now();
        const expired = [];
        const remaining = [];
        for (const minion of boss.minions) {
            const age = (now - (minion.spawn_time || 0)) / 1000;
            if (age > expireSeconds || (minion.hp_current || 0) <= 0) {
                expired.push(minion.minion_id);
            } else {
                remaining.push(minion);
            }
        }
        if (expired.length > 0) {
            boss.minions = remaining;
        }
        return expired;
    }

    /**
     * 更新技能冷却时间戳
     * @param {Object} boss - BOSS 实例
     * @param {Object} skill - 选中的技能对象（含 _cooldown_ms）
     */
    static updateCooldown(boss, skill) {
        if (!skill || !skill._cooldown_ms || skill._cooldown_ms <= 0) return;
        if (!boss.skill_cooldowns) boss.skill_cooldowns = {};
        boss.skill_cooldowns[skill.name] = Date.now() + skill._cooldown_ms;
    }

    /**
     * 生成小怪对象
     * @param {Object} boss - BOSS 实例
     * @param {string} bossKey - BOSS 配置键（用于决定小怪名称）
     * @param {Object} skill - 召唤技能对象
     * @returns {Object|null} 小怪对象
     * @private
     */
    static _generateMinion(boss, bossKey, skill) {
        const cfg = getBossSkillsConfig();
        const bossHp = safeNumber(boss.hp_max);
        const bossAtk = safeNumber(boss.atk);
        const bossDef = safeNumber(boss.def);

        // 小怪属性按比例缩放
        const hpRatio = cfg.minion_hp_ratio || 0.05;
        const atkRatio = cfg.minion_atk_ratio || 0.3;
        const defRatio = cfg.minion_def_ratio || 0.5;

        // 小怪名称：根据 BOSS 类型差异化
        const minionNames = {
            qingyuanzi: '剑灵分身',
            yaoshou: '妖兽幼崽',
            mulan: '天庭神兵'
        };

        const minion = {
            minion_id: `m_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            name: minionNames[bossKey] || 'BOSS分身',
            description: skill.description || '',
            hp_max: Math.floor(bossHp * hpRatio),
            hp_current: Math.floor(bossHp * hpRatio),
            atk: Math.floor(bossAtk * atkRatio),
            def: Math.floor(bossDef * defRatio),
            spawn_time: Date.now(),
            expire_at: Date.now() + (cfg.minion_expire_seconds || 60) * 1000
        };

        return minion;
    }

    /**
     * 生成 Buff 对象
     * @param {Object} skill - Buff 技能对象
     * @param {Object} cfg - boss_skills 配置
     * @returns {Object|null} Buff 对象
     * @private
     */
    static _generateBuff(skill, cfg) {
        if (!skill.effect) return null;
        const buffDurationSeconds = cfg.buff_duration_seconds || 15;
        const now = Date.now();
        const buff = {
            name: skill.name,
            effect: skill.effect,
            atk_up_percent: 0,
            lifesteal_percent: 0,
            immune_control: false,
            applied_at: now,
            expire_at: now + buffDurationSeconds * 1000,
            description: skill.description || ''
        };

        // 解析 effect 字符串获取参数
        // 例：self_buff_atk_up_50_percent → atk_up_percent = 50
        //     self_buff_atk_up_60_percent_lifesteal → atk_up_percent = 60, lifesteal_percent = 30
        //     self_buff_atk_up_70_percent_immune_control → atk_up_percent = 70, immune_control = true
        const ratios = cfg.buff_atk_up_ratios || {};
        if (ratios[skill.effect] !== undefined) {
            buff.atk_up_percent = Math.round(ratios[skill.effect] * 100);
        }

        // 从 effect 名称推断附加属性
        if (skill.effect.includes('lifesteal')) {
            buff.lifesteal_percent = (cfg.lifesteal_ratio || 0.3) * 100;
        }
        if (skill.effect.includes('immune_control')) {
            buff.immune_control = true;
        }

        return buff;
    }

    /**
     * 五行相克计算（与 WorldBossService._calculateElementalCounter 一致）
     * 这里复用一份独立实现，避免循环依赖
     * @param {string|null} attackerElement
     * @param {string|null} defenderElement
     * @returns {number} 相克系数（1.5 / 0.75 / 1.0）
     * @private
     */
    static _calculateElementalCounter(attackerElement, defenderElement) {
        const cfg = getWorldBossBalanceConfig();
        const elementalCfg = cfg.elemental_counter || {};
        const advantageMultiplier = Number(elementalCfg.advantage_multiplier) || 1.5;
        const disadvantageMultiplier = Number(elementalCfg.disadvantage_multiplier) || 0.75;
        const neutralMultiplier = Number(elementalCfg.neutral_multiplier) || 1.0;
        const counterMatrix = elementalCfg.counter_matrix || {
            metal: 'wood', wood: 'earth', earth: 'water', water: 'fire', fire: 'metal'
        };

        if (!attackerElement || !defenderElement) return neutralMultiplier;
        if (attackerElement === defenderElement) return neutralMultiplier;
        if (counterMatrix[attackerElement] === defenderElement) return advantageMultiplier;
        if (counterMatrix[defenderElement] === attackerElement) return disadvantageMultiplier;
        return neutralMultiplier;
    }
}

/**
 * 安全转 number（防御 null/undefined/string 混合场景）
 */
function safeNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

module.exports = WorldBossSkillManager;
