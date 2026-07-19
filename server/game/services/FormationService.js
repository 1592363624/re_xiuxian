/**
 * 阵法系统核心服务
 *
 * 功能概述：
 *   - 10大阵法，4类（攻击/防御/辅助/特殊）×4品阶（凡/灵/仙/圣）
 *   - 学习机制：境界达标 + 灵石消耗 + 前置阵法校验
 *   - 布阵/撤阵：4小时持续，撤阵后30分钟冷却，期间不可切换
 *   - 熟练度：每次布阵 +1，每100点 +5% 效果，上限1000
 *   - 阵法相克：attack > defense > support > special > attack，PVP时相克方效果 -20%
 *   - 战力加成：阵法效果作用于玩家属性计算（atk/def/hp_max/mp_max/speed/sense）
 *   - 阵法为被动效果，不进入状态机互斥
 *
 * 关键文件依赖：
 *   - server/config/formation_data.json：阵法静态配置
 *   - server/models/playerFormation.js：玩家已学阵法模型
 *   - server/models/player.js：玩家模型（含 active_formation_id 字段）
 *   - server/game/services/RealmService.js：境界查询
 *   - server/game/services/WebSocketNotificationService.js：实时推送
 */

const { infrastructure } = require('../../modules');
const Player = require('../../models/player');
const PlayerFormation = require('../../models/playerFormation');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');

/**
 * 工具函数：BigInt 安全转换
 * @param {*} value - 任意值
 * @returns {bigint}
 */
function safeBigInt(value) {
    if (value === null || value === undefined) return 0n;
    if (typeof value === 'bigint') return value;
    try { return BigInt(value); } catch (e) { return 0n; }
}

/**
 * 获取阵法配置（懒加载，每次调用都从ConfigLoader读取最新）
 * @returns {Object}
 */
function getFormationConfig() {
    return infrastructure.ConfigLoader.getConfig('formation_data') || { global: {}, formations: [] };
}

/**
 * 根据阵法ID获取阵法配置
 * @param {string} formationId - 阵法ID
 * @returns {Object|null}
 */
function getFormationById(formationId) {
    const cfg = getFormationConfig();
    return cfg.formations?.find(f => f.id === formationId) || null;
}

/**
 * 工具函数：冷却检查
 * @param {Object} player - 玩家对象
 * @param {string} timeField - 时间字段
 * @param {number} cooldownSec - 冷却秒数
 * @returns {{ready: boolean, remainingSec: number}}
 */
function checkCooldown(player, timeField, cooldownSec) {
    const lastTime = player[timeField];
    if (!lastTime) return { ready: true, remainingSec: 0 };
    const lastMs = lastTime instanceof Date ? lastTime.getTime() : new Date(lastTime).getTime();
    const elapsedSec = Math.floor((Date.now() - lastMs) / 1000);
    if (elapsedSec >= cooldownSec) return { ready: true, remainingSec: 0 };
    return { ready: false, remainingSec: cooldownSec - elapsedSec };
}

class FormationService {
    /**
     * 获取阵法全局配置（供前端展示规则说明）
     * @returns {Object}
     */
    getConfig() {
        const cfg = getFormationConfig();
        return {
            global: cfg.global,
            formations: cfg.formations?.map(f => ({
                id: f.id,
                name: f.name,
                category: f.category,
                category_display: cfg.global.category_display_names?.[f.category] || f.category,
                grade: f.grade,
                grade_display: cfg.global.grade_display_names?.[f.grade] || f.grade,
                description: f.description,
                min_realm_rank: f.min_realm_rank,
                recommended_realm: f.recommended_realm,
                learn_cost_spirit_stones: f.learn_cost_spirit_stones,
                prerequisite_formation_id: f.prerequisite_formation_id,
                activate_cost_spirit_stones: f.activate_cost_spirit_stones,
                effects: f.effects,
                lore: f.lore
            }))
        };
    }

    /**
     * 获取玩家阵法状态总览
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>}
     */
    async getStatus(player) {
        const cfg = getFormationConfig();
        const currentRealm = RealmService.getRealmByName(player.realm);
        const realmRank = currentRealm?.rank || 0;

        // 已学阵法列表
        const learnedFormations = await PlayerFormation.findAll({
            where: { player_id: player.id },
            order: [['learned_at', 'ASC']]
        });
        const learnedMap = new Map(learnedFormations.map(f => [f.formation_id, f]));

        // 当前激活阵法详情
        let activeFormation = null;
        if (player.active_formation_id) {
            const f = getFormationById(player.active_formation_id);
            if (f) {
                const playerFormation = learnedMap.get(player.active_formation_id);
                const proficiency = playerFormation?.proficiency || 0;
                const activatedAt = player.formation_activated_at;
                const durationSec = cfg.global.active_duration_seconds;
                const elapsedSec = activatedAt ? Math.floor((Date.now() - (activatedAt instanceof Date ? activatedAt.getTime() : new Date(activatedAt).getTime())) / 1000) : 0;
                const remainingSec = Math.max(0, durationSec - elapsedSec);
                const actualEffects = this._calculateEffectWithProficiency(f, proficiency);

                activeFormation = {
                    formation_id: f.id,
                    name: f.name,
                    category: f.category,
                    category_display: cfg.global.category_display_names?.[f.category] || f.category,
                    grade: f.grade,
                    grade_display: cfg.global.grade_display_names?.[f.grade] || f.grade,
                    proficiency,
                    activated_at: activatedAt,
                    remaining_seconds: remainingSec,
                    duration_seconds: durationSec,
                    effects: actualEffects,
                    description: f.description
                };
            }
        }

        // 撤阵冷却检查
        const cooldown = checkCooldown(player, 'last_formation_deactivate_time', cfg.global.deactivate_cooldown_seconds);

        return {
            realm_rank: realmRank,
            realm_name: player.realm,
            min_realm_rank: cfg.global.min_realm_rank,
            unlocked: realmRank >= cfg.global.min_realm_rank,
            active_formation: activeFormation,
            learned_count: learnedFormations.length,
            learned_formations: learnedFormations.map(lf => {
                const f = getFormationById(lf.formation_id);
                return {
                    formation_id: lf.formation_id,
                    name: f?.name || lf.formation_id,
                    category: f?.category,
                    category_display: f ? (cfg.global.category_display_names?.[f.category] || f.category) : null,
                    grade: f?.grade,
                    grade_display: f ? (cfg.global.grade_display_names?.[f.grade] || f.grade) : null,
                    proficiency: lf.proficiency,
                    proficiency_max: cfg.global.proficiency_max,
                    learned_at: lf.learned_at,
                    effects: f ? this._calculateEffectWithProficiency(f, lf.proficiency) : null
                };
            }),
            deactivate_cooldown_ready: cooldown.ready,
            deactivate_cooldown_remaining_sec: cooldown.remainingSec,
            active_duration_seconds: cfg.global.active_duration_seconds,
            proficiency_effect_step: cfg.global.proficiency_effect_step,
            proficiency_effect_bonus_ratio: cfg.global.proficiency_effect_bonus_ratio
        };
    }

    /**
     * 学习阵法
     * @param {Object} player - 玩家对象
     * @param {string} formationId - 阵法ID
     * @returns {Promise<Object>} Service 结果
     */
    async learnFormation(player, formationId) {
        const cfg = getFormationConfig();
        const formation = getFormationById(formationId);
        if (!formation) {
            return { success: false, message: '阵法不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        // 境界校验
        const currentRealm = RealmService.getRealmByName(player.realm);
        const realmRank = currentRealm?.rank || 0;
        if (realmRank < formation.min_realm_rank) {
            return {
                success: false,
                message: `境界不足，需达到 ${formation.recommended_realm} 或以上`,
                error_code: 'BUSINESS_LOGIC_ERROR'
            };
        }

        // 事务：检查重复 + 校验前置 + 扣灵石 + 创建记录
        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });

            // 重复学习校验
            const existing = await PlayerFormation.findOne({
                where: { player_id: player.id, formation_id: formationId },
                transaction: t
            });
            if (existing) {
                await t.commit();
                return { success: false, message: '已学习过该阵法', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            // 前置阵法校验
            if (formation.prerequisite_formation_id) {
                const prereq = await PlayerFormation.findOne({
                    where: { player_id: player.id, formation_id: formation.prerequisite_formation_id },
                    transaction: t
                });
                if (!prereq) {
                    const prereqFormation = getFormationById(formation.prerequisite_formation_id);
                    await t.commit();
                    return {
                        success: false,
                        message: `需先学习前置阵法：${prereqFormation?.name || formation.prerequisite_formation_id}`,
                        error_code: 'BUSINESS_LOGIC_ERROR'
                    };
                }
            }

            // 灵石消耗校验
            const playerStones = safeBigInt(lockedPlayer.spirit_stones);
            const cost = BigInt(formation.learn_cost_spirit_stones);
            if (playerStones < cost) {
                await t.commit();
                return {
                    success: false,
                    message: `灵石不足，需要 ${formation.learn_cost_spirit_stones} 灵石`,
                    error_code: 'BUSINESS_LOGIC_ERROR'
                };
            }

            // 扣灵石 + 创建学习记录
            lockedPlayer.spirit_stones = (playerStones - cost).toString();
            await lockedPlayer.save({ transaction: t });

            const newRecord = await PlayerFormation.create({
                player_id: player.id,
                formation_id: formationId,
                proficiency: 0
            }, { transaction: t });

            await t.commit();

            // 推送通知
            WebSocketNotificationService.notifyPlayerUpdate(player.id, {
                type: 'formation_learned',
                formation_id: formationId,
                formation_name: formation.name
            });

            return {
                success: true,
                message: `成功学习阵法：${formation.name}`,
                data: {
                    formation_id: formationId,
                    formation_name: formation.name,
                    proficiency: 0,
                    spirit_stones_remaining: lockedPlayer.spirit_stones?.toString() || '0'
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[FormationService.learnFormation] 错误:', err);
            return {
                success: false,
                message: '学习阵法失败，请稍后重试',
                error_code: 'INTERNAL_ERROR'
            };
        }
    }

    /**
     * 布阵激活
     * @param {Object} player - 玩家对象
     * @param {string} formationId - 阵法ID
     * @returns {Promise<Object>} Service 结果
     */
    async activateFormation(player, formationId) {
        const cfg = getFormationConfig();
        const formation = getFormationById(formationId);
        if (!formation) {
            return { success: false, message: '阵法不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });

            // 是否已学习
            const playerFormation = await PlayerFormation.findOne({
                where: { player_id: player.id, formation_id: formationId },
                transaction: t
            });
            if (!playerFormation) {
                await t.commit();
                return { success: false, message: '尚未学习该阵法，无法布阵', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            // 是否已有激活阵法
            if (lockedPlayer.active_formation_id) {
                const activatedAt = lockedPlayer.formation_activated_at;
                const durationSec = cfg.global.active_duration_seconds;
                const elapsedSec = activatedAt ? Math.floor((Date.now() - (activatedAt instanceof Date ? activatedAt.getTime() : new Date(activatedAt).getTime())) / 1000) : 0;
                if (elapsedSec < durationSec) {
                    await t.commit();
                    return {
                        success: false,
                        message: `已有激活阵法，需等待 ${durationSec - elapsedSec} 秒后方可切换（或先撤阵）`,
                        error_code: 'BUSINESS_LOGIC_ERROR'
                    };
                }
                // 超时自动撤阵，可继续激活新阵法
            }

            // 撤阵冷却校验
            const cooldown = checkCooldown(lockedPlayer, 'last_formation_deactivate_time', cfg.global.deactivate_cooldown_seconds);
            if (!cooldown.ready) {
                await t.commit();
                return {
                    success: false,
                    message: `撤阵冷却中，剩余 ${cooldown.remainingSec} 秒`,
                    error_code: 'BUSINESS_LOGIC_ERROR'
                };
            }

            // 灵石消耗校验（激活消耗）
            const playerStones = safeBigInt(lockedPlayer.spirit_stones);
            const cost = BigInt(formation.activate_cost_spirit_stones);
            if (playerStones < cost) {
                await t.commit();
                return {
                    success: false,
                    message: `灵石不足，布阵需要 ${formation.activate_cost_spirit_stones} 灵石`,
                    error_code: 'BUSINESS_LOGIC_ERROR'
                };
            }

            // 扣灵石 + 激活阵法 + 熟练度 +1
            lockedPlayer.spirit_stones = (playerStones - cost).toString();
            lockedPlayer.active_formation_id = formationId;
            lockedPlayer.formation_activated_at = new Date();
            await lockedPlayer.save({ transaction: t });

            // 熟练度 +1（上限封顶）
            const newProficiency = Math.min(
                cfg.global.proficiency_max,
                playerFormation.proficiency + cfg.global.proficiency_per_activate
            );
            playerFormation.proficiency = newProficiency;
            await playerFormation.save({ transaction: t });

            await t.commit();

            // 推送通知
            WebSocketNotificationService.notifyPlayerUpdate(player.id, {
                type: 'formation_activated',
                formation_id: formationId,
                formation_name: formation.name,
                proficiency: newProficiency
            });

            const actualEffects = this._calculateEffectWithProficiency(formation, newProficiency);
            const remainingSec = cfg.global.active_duration_seconds;

            return {
                success: true,
                message: `成功布阵：${formation.name}（熟练度 ${newProficiency}）`,
                data: {
                    formation_id: formationId,
                    formation_name: formation.name,
                    proficiency: newProficiency,
                    activated_at: lockedPlayer.formation_activated_at,
                    remaining_seconds: remainingSec,
                    duration_seconds: cfg.global.active_duration_seconds,
                    effects: actualEffects,
                    spirit_stones_remaining: lockedPlayer.spirit_stones?.toString() || '0'
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[FormationService.activateFormation] 错误:', err);
            return {
                success: false,
                message: '布阵失败，请稍后重试',
                error_code: 'INTERNAL_ERROR'
            };
        }
    }

    /**
     * 撤阵
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} Service 结果
     */
    async deactivateFormation(player) {
        const cfg = getFormationConfig();
        const t = await sequelize.transaction();
        try {
            const lockedPlayer = await Player.findByPk(player.id, { lock: t.LOCK.UPDATE, transaction: t });

            if (!lockedPlayer.active_formation_id) {
                await t.commit();
                return { success: false, message: '当前无激活阵法', error_code: 'BUSINESS_LOGIC_ERROR' };
            }

            const formationId = lockedPlayer.active_formation_id;
            const formation = getFormationById(formationId);
            const formationName = formation?.name || formationId;

            // 撤阵
            lockedPlayer.active_formation_id = null;
            lockedPlayer.formation_activated_at = null;
            lockedPlayer.last_formation_deactivate_time = new Date();
            await lockedPlayer.save({ transaction: t });

            await t.commit();

            // 推送通知
            WebSocketNotificationService.notifyPlayerUpdate(player.id, {
                type: 'formation_deactivated',
                formation_id: formationId,
                formation_name: formationName
            });

            return {
                success: true,
                message: `已撤阵：${formationName}（冷却 ${cfg.global.deactivate_cooldown_seconds} 秒）`,
                data: {
                    deactivated_formation_id: formationId,
                    deactivated_formation_name: formationName,
                    cooldown_seconds: cfg.global.deactivate_cooldown_seconds,
                    can_reactivate_at: lockedPlayer.last_formation_deactivate_time
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[FormationService.deactivateFormation] 错误:', err);
            return {
                success: false,
                message: '撤阵失败，请稍后重试',
                error_code: 'INTERNAL_ERROR'
            };
        }
    }

    /**
     * 计算含熟练度加成的实际效果
     * 公式：实际效果 = 基础效果 × (1 + floor(熟练度 / step) × bonus_ratio)
     * @param {Object} formation - 阵法配置
     * @param {number} proficiency - 当前熟练度
     * @returns {Object} 实际效果对象
     */
    _calculateEffectWithProficiency(formation, proficiency) {
        const cfg = getFormationConfig();
        const step = cfg.global.proficiency_effect_step || 100;
        const bonusRatio = cfg.global.proficiency_effect_bonus_ratio || 0.05;
        const multiplier = 1 + Math.floor((proficiency || 0) / step) * bonusRatio;

        const effects = formation.effects || {};
        const result = {};
        for (const [key, value] of Object.entries(effects)) {
            // 保留 4 位小数
            result[key] = Math.round(value * multiplier * 10000) / 10000;
        }
        result._proficiency_multiplier = multiplier;
        return result;
    }

    /**
     * 获取玩家当前激活阵法效果（供战力计算/战斗系统调用）
     * @param {Object} player - 玩家对象
     * @param {number|null} opponentFormationCategory - 对手阵法类型（用于相克判定，可选）
     * @returns {Promise<Object>} 阵法效果对象，无激活阵法时返回空效果
     */
    async getActiveFormationEffect(player, opponentFormationCategory = null) {
        const cfg = getFormationConfig();
        if (!player.active_formation_id) {
            return {
                active: false,
                formation_id: null,
                effects: {},
                counter_penalty: 0
            };
        }

        const formation = getFormationById(player.active_formation_id);
        if (!formation) {
            return { active: false, formation_id: null, effects: {}, counter_penalty: 0 };
        }

        // 查询熟练度
        const playerFormation = await PlayerFormation.findOne({
            where: { player_id: player.id, formation_id: player.active_formation_id }
        });
        const proficiency = playerFormation?.proficiency || 0;
        let effects = this._calculateEffectWithProficiency(formation, proficiency);

        // 相克判定：若对手阵法类型克制本方，效果按 (1 - counter_penalty_ratio) 衰减
        let counterPenalty = 0;
        if (opponentFormationCategory) {
            const counterMap = cfg.global.counter_relationships || {};
            // 若对手类型 → 本方类型 存在相克关系，则本方被克制
            if (counterMap[opponentFormationCategory] === formation.category) {
                counterPenalty = cfg.global.counter_penalty_ratio || 0;
                const decayMultiplier = 1 - counterPenalty;
                const decayedEffects = {};
                for (const [key, value] of Object.entries(effects)) {
                    if (key.startsWith('_')) {
                        decayedEffects[key] = value;
                    } else {
                        decayedEffects[key] = Math.round(value * decayMultiplier * 10000) / 10000;
                    }
                }
                effects = decayedEffects;
            }
        }

        return {
            active: true,
            formation_id: formation.id,
            formation_name: formation.name,
            category: formation.category,
            grade: formation.grade,
            proficiency,
            effects,
            counter_penalty: counterPenalty
        };
    }

    /**
     * 计算阵法战力加成数值（供 PvpService.getCombatPower 调用）
     * @param {Object} player - 玩家对象
     * @param {Object} attrs - 玩家基础属性 { atk, def, hp_max, speed, sense }
     * @returns {Promise<number>} 阵法带来的额外战力数值
     */
    async calculateCombatPowerBonus(player, attrs) {
        const cfg = getFormationConfig();
        const effect = await this.getActiveFormationEffect(player);
        if (!effect.active) return 0;

        const effects = effect.effects || {};
        const atk = Number(attrs.atk) || 0;
        const def = Number(attrs.def) || 0;
        const hpMax = Number(attrs.hp_max) || 0;
        const speed = Number(attrs.speed) || 0;
        const sense = Number(attrs.sense) || 0;

        // 阵法带来的属性增量
        const atkBonus = atk * (effects.atk_ratio || 0);
        const defBonus = def * (effects.def_ratio || 0);
        const hpBonus = hpMax * (effects.hp_max_ratio || 0);
        const speedBonus = speed * (effects.speed_ratio || 0);
        const senseBonus = sense * (effects.sense_ratio || 0);

        // 按 PVP 战力公式权重折算（简化：取平均权重 × 阵法权重系数）
        const cpCfg = (infrastructure.ConfigLoader.getConfig('game_balance')?.pvp_extended?.combat_power) || {};
        const atkWeight = cpCfg.base_atk_weight ?? 5.0;
        const defWeight = cpCfg.base_def_weight ?? 3.0;
        const hpWeight = cpCfg.base_hp_weight ?? 1.0;
        const speedWeight = cpCfg.base_speed_weight ?? 2.0;
        const senseWeight = cpCfg.base_sense_weight ?? 1.5;
        const formationWeight = cfg.global.combat_power_weight ?? 0.5;

        const bonusPower = (atkBonus * atkWeight
            + defBonus * defWeight
            + hpBonus * hpWeight
            + speedBonus * speedWeight
            + senseBonus * senseWeight) * formationWeight;

        return Math.floor(bonusPower);
    }

    /**
     * GM 后台：获取所有玩家阵法学习情况统计
     * @param {number} limit - 限制条数
     * @returns {Promise<Object>}
     */
    async gmGetFormationStats(limit = 100) {
        const totalLearned = await PlayerFormation.count();

        // 查询最近学习记录（原生查询，避免模型关联依赖）
        const [recentRows] = await sequelize.query(`
            SELECT pf.player_id, pf.formation_id, pf.proficiency, pf.learned_at,
                   p.nickname AS player_nickname, p.realm AS player_realm
            FROM player_formations pf
            LEFT JOIN players p ON p.id = pf.player_id
            ORDER BY pf.learned_at DESC
            LIMIT ?
        `, { replacements: [Math.min(limit, 500)] });

        // 统计每个阵法的学习人数
        const formationStats = {};
        const cfg = getFormationConfig();
        for (const f of cfg.formations || []) {
            formationStats[f.id] = {
                name: f.name,
                category: f.category,
                grade: f.grade,
                learned_count: 0
            };
        }
        const allRecords = await PlayerFormation.findAll({ attributes: ['formation_id'] });
        for (const r of allRecords) {
            if (formationStats[r.formation_id]) {
                formationStats[r.formation_id].learned_count++;
            }
        }

        // 统计当前激活阵法人数
        const [activeResult] = await sequelize.query(`
            SELECT active_formation_id, COUNT(*) as cnt
            FROM players
            WHERE active_formation_id IS NOT NULL
            GROUP BY active_formation_id
        `);
        const activeStats = {};
        for (const row of activeResult) {
            activeStats[row.active_formation_id] = row.cnt;
        }

        return {
            total_learned_records: totalLearned,
            formation_stats: Object.entries(formationStats).map(([id, s]) => ({
                formation_id: id,
                ...s,
                active_count: activeStats[id] || 0
            })),
            recent_learned: recentRows.map(r => ({
                player_id: r.player_id,
                player_nickname: r.player_nickname || `玩家${r.player_id}`,
                player_realm: r.player_realm,
                formation_id: r.formation_id,
                formation_name: getFormationById(r.formation_id)?.name || r.formation_id,
                proficiency: r.proficiency,
                learned_at: r.learned_at
            }))
        };
    }

    /**
     * GM 后台：给玩家发放阵法（直接学习，不消耗灵石）
     * @param {number} playerId - 玩家ID
     * @param {string} formationId - 阵法ID
     * @returns {Promise<Object>}
     */
    async gmGrantFormation(playerId, formationId) {
        const formation = getFormationById(formationId);
        if (!formation) {
            return { success: false, message: '阵法不存在', error_code: 'BUSINESS_LOGIC_ERROR' };
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在', error_code: 'NOT_FOUND' };
        }

        // 幂等：已学习则直接返回成功
        const existing = await PlayerFormation.findOne({
            where: { player_id: playerId, formation_id: formationId }
        });
        if (existing) {
            return {
                success: true,
                message: `玩家 ${player.nickname} 已学习过阵法：${formation.name}`,
                data: { formation_id: formationId, proficiency: existing.proficiency }
            };
        }

        await PlayerFormation.create({
            player_id: playerId,
            formation_id: formationId,
            proficiency: 0
        });

        return {
            success: true,
            message: `已给玩家 ${player.nickname} 发放阵法：${formation.name}`,
            data: { formation_id: formationId, formation_name: formation.name, proficiency: 0 }
        };
    }
}

module.exports = new FormationService();
