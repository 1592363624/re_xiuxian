/**
 * 器灵系统服务（法宝器灵养成与多人试炼竞技）
 *
 * 提供器灵系统 8 大核心业务逻辑（玩法文档第7节/第895-909行 法宝、器灵与徽章）：
 *   1. awaken：唤醒器灵（消耗资源，绑定到指定已装备法宝，4种类型可选）
 *   2. getMySpirits：我的器灵列表（含装备配置合并展示）
 *   3. getSpiritDetail：器灵详情（单个器灵完整状态）
 *   4. trial：器灵试炼（按战力评分获取奖励，每日次数限制，累计分进排行榜）
 *   5. protect：器灵护主（开启限时减伤/反弹/回血状态，消耗亲密度）
 *   6. activate：催发器灵（限时属性爆发，消耗力量值）
 *   7. pet：抚摸法宝（增加亲密度+经验，CD 冷却）
 *   8. nurture：温养器灵（增加力量值，CD 冷却+灵石消耗）
 *   9. getTrialRanking：器灵试炼榜（全服累计分排行，多人竞争）
 *
 * 设计原则：
 *   - 所有可变参数从 artifact_spirit_data.json 读取，禁止硬编码
 *   - 多表/多字段变更使用事务 + 行级锁（player_artifact_spirits + players + items）
 *   - BigInt 安全：试炼累计分和灵石消耗使用 safeBigInt 运算
 *   - WebSocket 推送通过 WebSocketNotificationService.notifyPlayerUpdate
 *   - 冷却时间基于数据库时间戳字段（last_pet_at/last_nurture_at/last_protect_at/last_activate_at）
 *   - 与战斗系统集成：getCombatBonus 供 AttributeService 调用计算最终属性
 */
'use strict';

const Player = require('../../models/player');
const PlayerEquipment = require('../../models/playerEquipment');
const PlayerArtifactSpirit = require('../../models/playerArtifactSpirit');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// 延迟引入 InventoryService / WebSocketNotificationService，避免循环依赖
let InventoryServiceInstance = null;
let WebSocketNotificationService = null;

/**
 * BigInt 安全转换工具
 * 防御场景：数据库 BIGINT 字段可能返回 string/null/undefined/number/bigint
 * @param {string|number|bigint|null|undefined} value - 待转换的值
 * @returns {bigint} 转换后的 BigInt，null/undefined 返回 0n
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    return BigInt(String(value));
}

class ArtifactSpiritService {
    /**
     * 构造函数
     * 初始化配置加载器引用
     */
    constructor() {
        this.configLoader = null;
    }

    /**
     * 初始化方法（接受配置注入）
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 读取器灵配置
     * 从 artifact_spirit_data.json 读取配置
     * @returns {Object} 器灵配置对象
     */
    getSpiritConfig() {
        if (!this.configLoader) {
            const { infrastructure } = require('../../modules');
            this.configLoader = infrastructure.ConfigLoader;
        }
        return this.configLoader.getConfig('artifact_spirit_data') || {};
    }

    /**
     * 获取 InventoryService 实例（延迟引入避免循环依赖）
     * InventoryService 导出的是单例实例（module.exports = new InventoryService()）
     * @returns {Object} InventoryService 实例
     */
    _getInventoryService() {
        if (!InventoryServiceInstance) {
            // InventoryService.js 导出的是单例，直接使用，无需 new
            InventoryServiceInstance = require('./InventoryService');
            // 若已初始化则跳过，否则尝试初始化（需 configLoader）
            if (this.configLoader && typeof InventoryServiceInstance.initialize === 'function') {
                InventoryServiceInstance.initialize(this.configLoader);
            }
        }
        return InventoryServiceInstance;
    }

    /**
     * 获取 WebSocketNotificationService（延迟引入）
     * @returns {Object} WebSocket 通知服务
     */
    _getWebSocketService() {
        if (!WebSocketNotificationService) {
            try {
                WebSocketNotificationService = require('../../modules/websocket/WebSocketNotificationService');
            } catch (e) {
                WebSocketNotificationService = null;
            }
        }
        return WebSocketNotificationService;
    }

    /**
     * 推送 WebSocket 通知（安全封装，避免通知失败影响主流程）
     * @param {number} playerId - 玩家ID
     * @param {string} eventType - 事件类型
     * @param {Object} payload - 通知数据
     */
    _notify(playerId, eventType, payload) {
        try {
            const wsService = this._getWebSocketService();
            if (wsService && typeof wsService.notifyPlayerUpdate === 'function') {
                wsService.notifyPlayerUpdate(playerId, eventType, payload);
            }
        } catch (e) {
            // 通知失败不影响主流程，仅记录日志
            console.warn(`[ArtifactSpiritService] WebSocket通知失败: ${eventType}`, e.message);
        }
    }

    /**
     * 校验玩家是否解锁器灵系统
     * 筑基期(realm_rank=3)解锁
     * @param {Object} player - 玩家实例
     * @returns {boolean} 是否解锁
     */
    _isUnlocked(player) {
        const config = this.getSpiritConfig();
        const requiredRank = config.unlock_realm_rank || 3;
        return (player.realm_rank || 0) >= requiredRank;
    }

    /**
     * 校验器灵类型是否合法
     * @param {string} spiritType - 器灵类型
     * @returns {boolean} 是否合法
     */
    _isValidSpiritType(spiritType) {
        const config = this.getSpiritConfig();
        const types = config.spirit_types || {};
        return Object.prototype.hasOwnProperty.call(types, spiritType);
    }

    /**
     * 跨日重置每日试炼次数
     * @param {Object} spirit - PlayerArtifactSpirit 实例
     */
    _resetDailyTrialIfNewDay(spirit) {
        const today = new Date().toISOString().slice(0, 10);
        const lastDate = spirit.last_trial_date
            ? new Date(spirit.last_trial_date).toISOString().slice(0, 10)
            : null;
        if (lastDate !== today) {
            spirit.daily_trial_count = 0;
            spirit.last_trial_date = today;
        }
    }

    /**
     * 计算器灵战斗加成（供 AttributeService 调用）
     * 返回归一化结构，与法宝深线加成保持一致
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { is_active, absolute, percent, effects, breakdown }
     */
    async getCombatBonus(playerId) {
        const result = {
            is_active: false,
            absolute: { atk: 0, def: 0, hp_max: 0, mp_max: 0, speed: 0 },
            percent: { atk: 0, def: 0, crit: 0, dodge: 0 },
            effects: [],
            breakdown: []
        };

        try {
            // 查询玩家所有已唤醒器灵
            const spirits = await PlayerArtifactSpirit.findAll({
                where: { player_id: playerId, is_awakened: true }
            });
            if (spirits.length === 0) return result;

            const config = this.getSpiritConfig();
            const spiritTypes = config.spirit_types || {};

            result.is_active = true;

            for (const spirit of spirits) {
                const typeConfig = spiritTypes[spirit.spirit_type];
                if (!typeConfig) continue;

                const baseBonus = typeConfig.base_bonus || {};
                const levelBonus = typeConfig.level_bonus_per_level || {};
                const level = spirit.spirit_level || 1;

                // 计算各属性百分比加成（基础 + 等级*每级加成）
                const atkPercent = (baseBonus.atk_percent || 0) + (levelBonus.atk_percent || 0) * level;
                const defPercent = (baseBonus.def_percent || 0) + (levelBonus.def_percent || 0) * level;
                const critPercent = (baseBonus.crit_percent || 0) + (levelBonus.crit_percent || 0) * level;
                const dodgePercent = (baseBonus.dodge_percent || 0) + (levelBonus.dodge_percent || 0) * level;

                result.percent.atk += atkPercent;
                result.percent.def += defPercent;
                result.percent.crit += critPercent;
                result.percent.dodge += dodgePercent;

                // 催发状态：额外倍率加成
                if (spirit.activate_active_until && new Date(spirit.activate_active_until) > new Date()) {
                    const activateConfig = config.activate || {};
                    const multiplier = activateConfig.bonus_multiplier || 1.5;
                    result.percent.atk += atkPercent * (multiplier - 1);
                    result.percent.def += defPercent * (multiplier - 1);
                    result.effects.push({
                        type: 'activate',
                        spirit_type: spirit.spirit_type,
                        activate_effect: typeConfig.activate_effect,
                        value: typeConfig.activate_value,
                        until: spirit.activate_active_until
                    });
                }

                // 护主状态：记录战斗特效供战斗系统读取
                if (spirit.protect_active_until && new Date(spirit.protect_active_until) > new Date()) {
                    result.effects.push({
                        type: 'protect',
                        spirit_type: spirit.spirit_type,
                        protect_effect: typeConfig.protect_effect,
                        value: typeConfig.protect_value,
                        until: spirit.protect_active_until
                    });
                }

                result.breakdown.push({
                    item_key: spirit.item_key,
                    spirit_type: spirit.spirit_type,
                    spirit_level: level,
                    atk_percent: atkPercent,
                    def_percent: defPercent,
                    crit_percent: critPercent,
                    dodge_percent: dodgePercent
                });
            }
        } catch (e) {
            console.warn('[ArtifactSpiritService] getCombatBonus 异常:', e.message);
        }

        return result;
    }

    // ========================================
    // 1. 唤醒器灵
    // ========================================

    /**
     * 唤醒器灵
     * 消耗灵石+物品，在指定已装备法宝上唤醒器灵
     * @param {number} playerId - 玩家ID
     * @param {number} equipmentId - 装备记录ID（player_equipment.id）
     * @param {string} spiritType - 器灵类型（attack/defense/support/balance）
     * @param {string} [spiritName] - 器灵自定义名称（可选）
     * @returns {Promise<Object>} { success, message, data }
     */
    async awaken(playerId, equipmentId, spiritType, spiritName = null) {
        // 参数校验
        if (!equipmentId || !Number.isFinite(Number(equipmentId))) {
            return { success: false, message: '装备ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!this._isValidSpiritType(spiritType)) {
            return { success: false, message: '器灵类型无效（仅支持 attack/defense/support/balance）', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = this.getSpiritConfig();
        if (!config.enabled) {
            return { success: false, message: '器灵系统未开启', error_code: ErrorCodes.FEATURE_DISABLED };
        }

        const t = await sequelize.transaction();
        try {
            // 1. 查询玩家（加行级锁）
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在', error_code: ErrorCodes.NOT_FOUND };
            }
            if (player.is_dead) {
                await t.rollback();
                return { success: false, message: '已陨落，无法唤醒器灵', error_code: ErrorCodes.PLAYER_DEAD };
            }
            if (!this._isUnlocked(player)) {
                await t.rollback();
                return { success: false, message: `境界未达要求，需筑基期(rank=${config.unlock_realm_rank})解锁`, error_code: ErrorCodes.REALM_NOT_ENOUGH };
            }

            // 2. 校验装备归属且已装备
            const equipment = await PlayerEquipment.findOne({
                where: { id: equipmentId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!equipment) {
                await t.rollback();
                return { success: false, message: '装备不存在或不属于该玩家', error_code: ErrorCodes.NOT_FOUND };
            }
            if (equipment.durability <= 0) {
                await t.rollback();
                return { success: false, message: '装备已破碎，无法唤醒器灵', error_code: ErrorCodes.EQUIPMENT_BROKEN };
            }

            // 3. 校验该装备是否已有器灵
            const existing = await PlayerArtifactSpirit.findOne({
                where: { player_id: playerId, equipment_id: equipmentId },
                transaction: t
            });
            if (existing && existing.is_awakened) {
                await t.rollback();
                return { success: false, message: '该法宝已唤醒器灵，无法重复唤醒', error_code: ErrorCodes.ALREADY_EXISTS };
            }

            // 4. 扣减灵石
            const awakenConfig = config.awaken || {};
            const costConfig = awakenConfig.cost || {};
            const spiritStonesCost = BigInt(costConfig.spirit_stones || 0);
            if (player.spirit_stones === null || safeBigInt(player.spirit_stones) < spiritStonesCost) {
                await t.rollback();
                return { success: false, message: '灵石不足', error_code: ErrorCodes.INSUFFICIENT_RESOURCES };
            }
            player.spirit_stones = safeBigInt(player.spirit_stones) - spiritStonesCost;

            // 5. 扣减物品
            const inventoryService = this._getInventoryService();
            const requiredItems = costConfig.items || [];
            for (const reqItem of requiredItems) {
                const hasItem = await inventoryService.hasItem(playerId, reqItem.item_id, reqItem.quantity, t);
                if (!hasItem) {
                    await t.rollback();
                    return { success: false, message: `物品不足：${reqItem.item_id} 需要 ${reqItem.quantity}`, error_code: ErrorCodes.INSUFFICIENT_RESOURCES };
                }
            }
            for (const reqItem of requiredItems) {
                await inventoryService.removeItem(playerId, reqItem.item_id, reqItem.quantity, t);
            }

            // 6. 计算成功率（基础 + 祭炼等级加成）
            const successRateBase = awakenConfig.success_rate_base || 0.8;
            const successRatePerRefine = awakenConfig.success_rate_per_refine_level || 0.02;
            const successRateMax = awakenConfig.success_rate_max || 0.98;
            const refineLevel = equipment.refine_level || 0;
            const finalRate = Math.min(successRateMax, successRateBase + refineLevel * successRatePerRefine);
            const isSuccess = Math.random() < finalRate;

            if (!isSuccess) {
                // 唤醒失败：资源已消耗，返回失败但不创建器灵
                await player.save({ transaction: t });
                await t.commit();
                this._notify(playerId, 'spirit_awaken_failed', {
                    equipment_id: equipmentId,
                    item_key: equipment.item_key,
                    success_rate: finalRate
                });
                return {
                    success: false,
                    message: `唤醒失败（成功率 ${(finalRate * 100).toFixed(1)}%），消耗资源不返还`,
                    data: { success_rate: finalRate }
                };
            }

            // 7. 创建器灵记录
            const spiritData = {
                player_id: playerId,
                equipment_id: equipmentId,
                item_key: equipment.item_key,
                spirit_type: spiritType,
                spirit_name: spiritName ? String(spiritName).slice(0, 50) : null,
                spirit_level: 1,
                spirit_exp: 0,
                intimacy: awakenConfig.intimacy_init || 10,
                power: awakenConfig.power_init || 50,
                is_awakened: true,
                awakened_at: new Date(),
                state: 'idle'
            };

            const spirit = existing
                ? await existing.update(spiritData, { transaction: t })
                : await PlayerArtifactSpirit.create(spiritData, { transaction: t });

            await player.save({ transaction: t });
            await t.commit();

            this._notify(playerId, 'spirit_awakened', {
                spirit_id: spirit.id,
                equipment_id: equipmentId,
                item_key: equipment.item_key,
                spirit_type: spiritType,
                success_rate: finalRate
            });

            return {
                success: true,
                message: `器灵唤醒成功！类型：${(config.spirit_types[spiritType] || {}).name || spiritType}`,
                data: {
                    spirit_id: spirit.id,
                    spirit_type: spiritType,
                    spirit_name: spirit.spirit_name,
                    spirit_level: 1,
                    intimacy: spirit.intimacy,
                    power: spirit.power,
                    success_rate: finalRate
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[ArtifactSpiritService.awaken] 异常:', err);
            throw new AppError(`唤醒器灵失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }

    // ========================================
    // 2. 我的器灵列表
    // ========================================

    /**
     * 获取玩家所有已唤醒器灵列表
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data: { spirits, count } }
     */
    async getMySpirits(playerId) {
        try {
            const spirits = await PlayerArtifactSpirit.findAll({
                where: { player_id: playerId, is_awakened: true },
                order: [['awakened_at', 'DESC']]
            });

            const config = this.getSpiritConfig();
            const spiritTypes = config.spirit_types || {};

            // 合并装备配置信息
            const equipmentIds = spirits.map(s => s.equipment_id);
            const equipments = equipmentIds.length > 0
                ? await PlayerEquipment.findAll({ where: { id: { [Op.in]: equipmentIds } } })
                : [];
            const equipmentMap = new Map(equipments.map(e => [e.id, e]));

            const result = spirits.map(spirit => {
                const equipment = equipmentMap.get(spirit.equipment_id);
                const typeConfig = spiritTypes[spirit.spirit_type] || {};
                return {
                    spirit_id: spirit.id,
                    equipment_id: spirit.equipment_id,
                    item_key: spirit.item_key,
                    spirit_type: spirit.spirit_type,
                    spirit_type_name: typeConfig.name || spirit.spirit_type,
                    spirit_type_desc: typeConfig.desc || '',
                    spirit_name: spirit.spirit_name,
                    spirit_level: spirit.spirit_level,
                    spirit_exp: spirit.spirit_exp,
                    intimacy: spirit.intimacy,
                    power: spirit.power,
                    awakened_at: spirit.awakened_at,
                    state: spirit.state,
                    is_protecting: !!(spirit.protect_active_until && new Date(spirit.protect_active_until) > new Date()),
                    is_activating: !!(spirit.activate_active_until && new Date(spirit.activate_active_until) > new Date()),
                    trial_best_score: spirit.trial_best_score,
                    trial_total_score: safeBigInt(spirit.trial_total_score).toString(),
                    equipment_slot: equipment?.slot || null,
                    is_equipment_broken: equipment ? equipment.durability <= 0 : false
                };
            });

            return {
                success: true,
                message: 'success',
                data: { spirits: result, count: result.length }
            };
        } catch (err) {
            console.error('[ArtifactSpiritService.getMySpirits] 异常:', err);
            throw new AppError(`获取器灵列表失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }

    // ========================================
    // 3. 器灵详情
    // ========================================

    /**
     * 获取指定器灵详情
     * @param {number} playerId - 玩家ID
     * @param {number} spiritId - 器灵记录ID
     * @returns {Promise<Object>} { success, data }
     */
    async getSpiritDetail(playerId, spiritId) {
        try {
            const spirit = await PlayerArtifactSpirit.findOne({
                where: { id: spiritId, player_id: playerId }
            });
            if (!spirit || !spirit.is_awakened) {
                return { success: false, message: '器灵不存在或未唤醒', error_code: ErrorCodes.NOT_FOUND };
            }

            const config = this.getSpiritConfig();
            const spiritTypes = config.spirit_types || {};
            const typeConfig = spiritTypes[spirit.spirit_type] || {};
            const growthConfig = config.growth || {};

            // 计算升级所需经验
            const expPerLevel = growthConfig.exp_per_level || [];
            const nextLevelExp = spirit.spirit_level < (growthConfig.max_level || 10)
                ? (expPerLevel[spirit.spirit_level - 1] || 0)
                : 0;

            // 计算冷却剩余时间
            const now = new Date();
            const petCdMs = (growthConfig.intimacy_pet_cd_seconds || 3600) * 1000;
            const nurtureCdMs = (growthConfig.power_nurture_cd_seconds || 7200) * 1000;
            const protectCdMs = (config.protect?.cooldown_seconds || 1800) * 1000;
            const activateCdMs = (config.activate?.cooldown_seconds || 3600) * 1000;

            const petCdRemaining = spirit.last_pet_at ? Math.max(0, petCdMs - (now - new Date(spirit.last_pet_at))) : 0;
            const nurtureCdRemaining = spirit.last_nurture_at ? Math.max(0, nurtureCdMs - (now - new Date(spirit.last_nurture_at))) : 0;
            const protectCdRemaining = spirit.last_protect_at ? Math.max(0, protectCdMs - (now - new Date(spirit.last_protect_at))) : 0;
            const activateCdRemaining = spirit.last_activate_at ? Math.max(0, activateCdMs - (now - new Date(spirit.last_activate_at))) : 0;

            return {
                success: true,
                message: 'success',
                data: {
                    spirit_id: spirit.id,
                    equipment_id: spirit.equipment_id,
                    item_key: spirit.item_key,
                    spirit_type: spirit.spirit_type,
                    spirit_type_name: typeConfig.name || spirit.spirit_type,
                    spirit_type_desc: typeConfig.desc || '',
                    spirit_name: spirit.spirit_name,
                    spirit_level: spirit.spirit_level,
                    spirit_exp: spirit.spirit_exp,
                    next_level_exp: nextLevelExp,
                    max_level: growthConfig.max_level || 10,
                    intimacy: spirit.intimacy,
                    intimacy_max: growthConfig.intimacy_max || 100,
                    power: spirit.power,
                    power_max: growthConfig.power_max || 1000,
                    awakened_at: spirit.awakened_at,
                    state: spirit.state,
                    is_protecting: !!(spirit.protect_active_until && new Date(spirit.protect_active_until) > now),
                    protect_active_until: spirit.protect_active_until,
                    is_activating: !!(spirit.activate_active_until && new Date(spirit.activate_active_until) > now),
                    activate_active_until: spirit.activate_active_until,
                    trial_best_score: spirit.trial_best_score,
                    trial_total_count: spirit.trial_total_count,
                    trial_total_score: safeBigInt(spirit.trial_total_score).toString(),
                    daily_trial_count: spirit.daily_trial_count,
                    daily_trial_limit: config.trial?.daily_limit || 3,
                    cooldowns: {
                        pet: Math.ceil(petCdRemaining / 1000),
                        nurture: Math.ceil(nurtureCdRemaining / 1000),
                        protect: Math.ceil(protectCdRemaining / 1000),
                        activate: Math.ceil(activateCdRemaining / 1000)
                    }
                }
            };
        } catch (err) {
            console.error('[ArtifactSpiritService.getSpiritDetail] 异常:', err);
            throw new AppError(`获取器灵详情失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }

    // ========================================
    // 4. 器灵试炼
    // ========================================

    /**
     * 器灵试炼
     * 按器灵战力评分获取奖励，每日次数限制
     * @param {number} playerId - 玩家ID
     * @param {number} spiritId - 器灵记录ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async trial(playerId, spiritId) {
        if (!spiritId || !Number.isFinite(Number(spiritId))) {
            return { success: false, message: '器灵ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = this.getSpiritConfig();
        const t = await sequelize.transaction();
        try {
            // 1. 查询器灵（加锁）
            const spirit = await PlayerArtifactSpirit.findOne({
                where: { id: spiritId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!spirit || !spirit.is_awakened) {
                await t.rollback();
                return { success: false, message: '器灵不存在或未唤醒', error_code: ErrorCodes.NOT_FOUND };
            }

            // 2. 跨日重置每日次数
            this._resetDailyTrialIfNewDay(spirit);

            // 3. 校验每日次数
            const dailyLimit = config.trial?.daily_limit || 3;
            if (spirit.daily_trial_count >= dailyLimit) {
                await t.rollback();
                return { success: false, message: `今日试炼次数已用完（${dailyLimit}次/日）`, error_code: ErrorCodes.LIMIT_EXCEEDED };
            }

            // 4. 计算试炼分数
            // 分数 = (基础难度 + 等级*难度系数) * 力量倍率 * 亲密度倍率 * 随机波动(0.8~1.2)
            const trialConfig = config.trial || {};
            const baseDifficulty = trialConfig.base_difficulty || 100;
            const difficultyPerLevel = trialConfig.difficulty_per_level || 50;
            const scorePerPower = trialConfig.score_multiplier_per_power || 1.5;
            const scorePerIntimacy = trialConfig.score_multiplier_per_intimacy || 0.5;
            const randomFactor = 0.8 + Math.random() * 0.4;

            const baseScore = (baseDifficulty + spirit.spirit_level * difficultyPerLevel) * randomFactor;
            const powerBonus = spirit.power * scorePerPower;
            const intimacyBonus = spirit.intimacy * scorePerIntimacy;
            const totalScore = Math.floor(baseScore + powerBonus + intimacyBonus);

            // 5. 匹配奖励档位
            const rewards = trialConfig.rewards || [];
            let matchedReward = rewards[0] || { exp: 50, spirit_stones: 100, power_gain: 2 };
            for (const reward of rewards) {
                if (totalScore >= (reward.min_score || 0)) {
                    matchedReward = reward;
                }
            }

            // 6. 更新器灵状态
            spirit.daily_trial_count += 1;
            spirit.trial_total_count += 1;
            spirit.trial_total_score = safeBigInt(spirit.trial_total_score) + BigInt(totalScore);
            if (totalScore > spirit.trial_best_score) {
                spirit.trial_best_score = totalScore;
            }
            spirit.last_trial_at = new Date();

            // 7. 增加经验（触发升级判定）
            const growthConfig = config.growth || {};
            const expPerLevel = growthConfig.exp_per_level || [];
            const maxLevel = growthConfig.max_level || 10;
            spirit.spirit_exp += matchedReward.exp || 0;

            let leveledUp = false;
            while (spirit.spirit_level < maxLevel) {
                const needExp = expPerLevel[spirit.spirit_level - 1] || 0;
                if (spirit.spirit_exp >= needExp && needExp > 0) {
                    spirit.spirit_exp -= needExp;
                    spirit.spirit_level += 1;
                    leveledUp = true;
                } else {
                    break;
                }
            }

            // 8. 增加力量值
            const powerGain = matchedReward.power_gain || 0;
            const powerMax = growthConfig.power_max || 1000;
            spirit.power = Math.min(powerMax, spirit.power + powerGain);

            await spirit.save({ transaction: t });

            // 9. 发放灵石奖励
            const stoneReward = BigInt(matchedReward.spirit_stones || 0);
            if (stoneReward > 0) {
                const player = await Player.findByPk(playerId, {
                    lock: t.LOCK.UPDATE,
                    transaction: t
                });
                if (player) {
                    player.spirit_stones = safeBigInt(player.spirit_stones) + stoneReward;
                    await player.save({ transaction: t });
                }
            }

            await t.commit();

            this._notify(playerId, 'spirit_trial_completed', {
                spirit_id: spirit.id,
                score: totalScore,
                rewards: matchedReward,
                leveled_up: leveledUp
            });

            return {
                success: true,
                message: leveledUp ? `试炼完成！器灵升级至 Lv.${spirit.spirit_level}` : '试炼完成',
                data: {
                    spirit_id: spirit.id,
                    score: totalScore,
                    is_best_score: totalScore === spirit.trial_best_score,
                    rewards: {
                        exp: matchedReward.exp || 0,
                        spirit_stones: matchedReward.spirit_stones || 0,
                        power_gain: powerGain
                    },
                    spirit_level: spirit.spirit_level,
                    spirit_exp: spirit.spirit_exp,
                    leveled_up: leveledUp,
                    daily_trial_count: spirit.daily_trial_count,
                    daily_trial_limit: dailyLimit
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[ArtifactSpiritService.trial] 异常:', err);
            throw new AppError(`器灵试炼失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }

    // ========================================
    // 5. 器灵护主
    // ========================================

    /**
     * 器灵护主
     * 开启限时护主状态，消耗亲密度
     * @param {number} playerId - 玩家ID
     * @param {number} spiritId - 器灵记录ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async protect(playerId, spiritId) {
        if (!spiritId || !Number.isFinite(Number(spiritId))) {
            return { success: false, message: '器灵ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = this.getSpiritConfig();
        const protectConfig = config.protect || {};
        const t = await sequelize.transaction();
        try {
            const spirit = await PlayerArtifactSpirit.findOne({
                where: { id: spiritId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!spirit || !spirit.is_awakened) {
                await t.rollback();
                return { success: false, message: '器灵不存在或未唤醒', error_code: ErrorCodes.NOT_FOUND };
            }

            // 校验亲密度
            const intimacyRequired = protectConfig.intimacy_required || 20;
            if (spirit.intimacy < intimacyRequired) {
                await t.rollback();
                return { success: false, message: `亲密度不足，需 ${intimacyRequired} 点`, error_code: ErrorCodes.CONDITION_NOT_MET };
            }

            // 校验冷却
            const cooldownSec = protectConfig.cooldown_seconds || 1800;
            if (spirit.last_protect_at) {
                const elapsed = (Date.now() - new Date(spirit.last_protect_at).getTime()) / 1000;
                if (elapsed < cooldownSec) {
                    await t.rollback();
                    return { success: false, message: `护主冷却中，剩余 ${Math.ceil(cooldownSec - elapsed)} 秒`, error_code: ErrorCodes.COOLDOWN };
                }
            }

            // 扣减亲密度
            const intimacyCost = protectConfig.intimacy_cost || 5;
            spirit.intimacy = Math.max(0, spirit.intimacy - intimacyCost);

            // 设置护主状态
            const durationSec = protectConfig.duration_seconds || 300;
            const now = new Date();
            const until = new Date(now.getTime() + durationSec * 1000);
            spirit.protect_active_until = until;
            spirit.last_protect_at = now;
            spirit.state = 'protecting';

            await spirit.save({ transaction: t });
            await t.commit();

            this._notify(playerId, 'spirit_protect_activated', {
                spirit_id: spirit.id,
                active_until: until,
                intimacy_cost: intimacyCost
            });

            return {
                success: true,
                message: `器灵护主已开启，持续 ${durationSec} 秒`,
                data: {
                    spirit_id: spirit.id,
                    active_until: until,
                    duration_seconds: durationSec,
                    intimacy_cost: intimacyCost,
                    intimacy_remaining: spirit.intimacy
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[ArtifactSpiritService.protect] 异常:', err);
            throw new AppError(`器灵护主失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }

    // ========================================
    // 6. 催发器灵
    // ========================================

    /**
     * 催发器灵
     * 限时属性爆发，消耗力量值
     * @param {number} playerId - 玩家ID
     * @param {number} spiritId - 器灵记录ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async activate(playerId, spiritId) {
        if (!spiritId || !Number.isFinite(Number(spiritId))) {
            return { success: false, message: '器灵ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = this.getSpiritConfig();
        const activateConfig = config.activate || {};
        const t = await sequelize.transaction();
        try {
            const spirit = await PlayerArtifactSpirit.findOne({
                where: { id: spiritId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!spirit || !spirit.is_awakened) {
                await t.rollback();
                return { success: false, message: '器灵不存在或未唤醒', error_code: ErrorCodes.NOT_FOUND };
            }

            // 校验力量值
            const powerRequired = activateConfig.power_required || 100;
            if (spirit.power < powerRequired) {
                await t.rollback();
                return { success: false, message: `力量值不足，需 ${powerRequired} 点`, error_code: ErrorCodes.CONDITION_NOT_MET };
            }

            // 校验冷却
            const cooldownSec = activateConfig.cooldown_seconds || 3600;
            if (spirit.last_activate_at) {
                const elapsed = (Date.now() - new Date(spirit.last_activate_at).getTime()) / 1000;
                if (elapsed < cooldownSec) {
                    await t.rollback();
                    return { success: false, message: `催发冷却中，剩余 ${Math.ceil(cooldownSec - elapsed)} 秒`, error_code: ErrorCodes.COOLDOWN };
                }
            }

            // 扣减力量值
            const powerCost = activateConfig.power_cost || 50;
            spirit.power = Math.max(0, spirit.power - powerCost);

            // 设置催发状态
            const durationSec = activateConfig.duration_seconds || 180;
            const now = new Date();
            const until = new Date(now.getTime() + durationSec * 1000);
            spirit.activate_active_until = until;
            spirit.last_activate_at = now;
            spirit.state = 'activating';

            await spirit.save({ transaction: t });
            await t.commit();

            this._notify(playerId, 'spirit_activate_triggered', {
                spirit_id: spirit.id,
                active_until: until,
                power_cost: powerCost
            });

            return {
                success: true,
                message: `器灵催发已开启，持续 ${durationSec} 秒`,
                data: {
                    spirit_id: spirit.id,
                    active_until: until,
                    duration_seconds: durationSec,
                    power_cost: powerCost,
                    power_remaining: spirit.power,
                    bonus_multiplier: activateConfig.bonus_multiplier || 1.5
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[ArtifactSpiritService.activate] 异常:', err);
            throw new AppError(`催发器灵失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }

    // ========================================
    // 7. 抚摸法宝
    // ========================================

    /**
     * 抚摸法宝（增加亲密度+经验）
     * @param {number} playerId - 玩家ID
     * @param {number} spiritId - 器灵记录ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async pet(playerId, spiritId) {
        if (!spiritId || !Number.isFinite(Number(spiritId))) {
            return { success: false, message: '器灵ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = this.getSpiritConfig();
        const growthConfig = config.growth || {};
        const t = await sequelize.transaction();
        try {
            const spirit = await PlayerArtifactSpirit.findOne({
                where: { id: spiritId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!spirit || !spirit.is_awakened) {
                await t.rollback();
                return { success: false, message: '器灵不存在或未唤醒', error_code: ErrorCodes.NOT_FOUND };
            }

            // 校验冷却
            const cooldownSec = growthConfig.intimacy_pet_cd_seconds || 3600;
            if (spirit.last_pet_at) {
                const elapsed = (Date.now() - new Date(spirit.last_pet_at).getTime()) / 1000;
                if (elapsed < cooldownSec) {
                    await t.rollback();
                    return { success: false, message: `抚摸冷却中，剩余 ${Math.ceil(cooldownSec - elapsed)} 秒`, error_code: ErrorCodes.COOLDOWN };
                }
            }

            // 增加亲密度
            const intimacyGain = growthConfig.intimacy_pet_gain || 5;
            const intimacyMax = growthConfig.intimacy_max || 100;
            const intimacyBefore = spirit.intimacy;
            spirit.intimacy = Math.min(intimacyMax, spirit.intimacy + intimacyGain);

            // 增加经验
            const expGain = growthConfig.intimacy_pet_exp_gain || 20;
            spirit.spirit_exp += expGain;

            // 升级判定
            const expPerLevel = growthConfig.exp_per_level || [];
            const maxLevel = growthConfig.max_level || 10;
            let leveledUp = false;
            while (spirit.spirit_level < maxLevel) {
                const needExp = expPerLevel[spirit.spirit_level - 1] || 0;
                if (spirit.spirit_exp >= needExp && needExp > 0) {
                    spirit.spirit_exp -= needExp;
                    spirit.spirit_level += 1;
                    leveledUp = true;
                } else {
                    break;
                }
            }

            spirit.last_pet_at = new Date();
            await spirit.save({ transaction: t });
            await t.commit();

            this._notify(playerId, 'spirit_petted', {
                spirit_id: spirit.id,
                intimacy_gain: spirit.intimacy - intimacyBefore,
                exp_gain: expGain,
                leveled_up: leveledUp
            });

            return {
                success: true,
                message: leveledUp ? `抚摸完成，器灵升级至 Lv.${spirit.spirit_level}！` : '抚摸完成，亲密度与经验已增加',
                data: {
                    spirit_id: spirit.id,
                    intimacy_gain: spirit.intimacy - intimacyBefore,
                    intimacy: spirit.intimacy,
                    intimacy_max: intimacyMax,
                    exp_gain: expGain,
                    spirit_exp: spirit.spirit_exp,
                    spirit_level: spirit.spirit_level,
                    leveled_up: leveledUp
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[ArtifactSpiritService.pet] 异常:', err);
            throw new AppError(`抚摸法宝失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }

    // ========================================
    // 8. 温养器灵
    // ========================================

    /**
     * 温养器灵（增加力量值，消耗灵石）
     * @param {number} playerId - 玩家ID
     * @param {number} spiritId - 器灵记录ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async nurture(playerId, spiritId) {
        if (!spiritId || !Number.isFinite(Number(spiritId))) {
            return { success: false, message: '器灵ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = this.getSpiritConfig();
        const growthConfig = config.growth || {};
        const t = await sequelize.transaction();
        try {
            const spirit = await PlayerArtifactSpirit.findOne({
                where: { id: spiritId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!spirit || !spirit.is_awakened) {
                await t.rollback();
                return { success: false, message: '器灵不存在或未唤醒', error_code: ErrorCodes.NOT_FOUND };
            }

            // 校验力量值上限
            const powerMax = growthConfig.power_max || 1000;
            if (spirit.power >= powerMax) {
                await t.rollback();
                return { success: false, message: '力量值已满，无法继续温养', error_code: ErrorCodes.CONDITION_NOT_MET };
            }

            // 校验冷却
            const cooldownSec = growthConfig.power_nurture_cd_seconds || 7200;
            if (spirit.last_nurture_at) {
                const elapsed = (Date.now() - new Date(spirit.last_nurture_at).getTime()) / 1000;
                if (elapsed < cooldownSec) {
                    await t.rollback();
                    return { success: false, message: `温养冷却中，剩余 ${Math.ceil(cooldownSec - elapsed)} 秒`, error_code: ErrorCodes.COOLDOWN };
                }
            }

            // 扣减灵石
            const stoneCost = BigInt(growthConfig.power_nurture_cost_spirit_stones || 1000);
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在', error_code: ErrorCodes.NOT_FOUND };
            }
            if (safeBigInt(player.spirit_stones) < stoneCost) {
                await t.rollback();
                return { success: false, message: '灵石不足', error_code: ErrorCodes.INSUFFICIENT_RESOURCES };
            }
            player.spirit_stones = safeBigInt(player.spirit_stones) - stoneCost;

            // 增加力量值
            const powerGain = growthConfig.power_nurture_gain || 20;
            const powerBefore = spirit.power;
            spirit.power = Math.min(powerMax, spirit.power + powerGain);
            spirit.last_nurture_at = new Date();

            await spirit.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            this._notify(playerId, 'spirit_nurtured', {
                spirit_id: spirit.id,
                power_gain: spirit.power - powerBefore,
                spirit_stones_cost: Number(stoneCost)
            });

            return {
                success: true,
                message: '温养完成，力量值已增加',
                data: {
                    spirit_id: spirit.id,
                    power_gain: spirit.power - powerBefore,
                    power: spirit.power,
                    power_max: powerMax,
                    spirit_stones_cost: Number(stoneCost)
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[ArtifactSpiritService.nurture] 异常:', err);
            throw new AppError(`温养器灵失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }

    // ========================================
    // 9. 器灵试炼榜
    // ========================================

    /**
     * 器灵试炼榜（全服累计分排行）
     * @param {number} playerId - 当前玩家ID（用于标注自己排名）
     * @param {number} [page=1] - 页码
     * @param {number} [pageSize=20] - 每页条数
     * @returns {Promise<Object>} { success, data: { ranking, my_rank, total, page, page_size } }
     */
    async getTrialRanking(playerId, page = 1, pageSize = 20) {
        try {
            const config = this.getSpiritConfig();
            const topCount = config.trial_ranking?.top_count || 50;
            const pageNum = Math.max(1, Number(page) || 1);
            const pageSizeNum = Math.min(100, Math.max(1, Number(pageSize) || 20));

            const offset = (pageNum - 1) * pageSizeNum;
            const spirits = await PlayerArtifactSpirit.findAll({
                where: { is_awakened: true, trial_total_score: { [Op.gt]: 0 } },
                order: [['trial_total_score', 'DESC'], ['trial_best_score', 'DESC']],
                limit: pageSizeNum,
                offset: offset
            });

            // 批量查询对应玩家基础信息（避免 N+1 查询，与 FengshenService 保持一致）
            const playerIds = spirits.map(s => s.player_id);
            const players = playerIds.length > 0
                ? await Player.findAll({
                    where: { id: playerIds },
                    attributes: ['id', 'nickname', 'realm', 'realm_rank']
                })
                : [];
            const playerMap = new Map(players.map(p => [p.id, p]));

            // 统计总数
            const total = await PlayerArtifactSpirit.count({
                where: { is_awakened: true, trial_total_score: { [Op.gt]: 0 } }
            });

            // 查询当前玩家排名
            let myRank = 0;
            let mySpirit = null;
            if (playerId) {
                mySpirit = await PlayerArtifactSpirit.findOne({
                    where: { player_id: playerId, is_awakened: true },
                    order: [['trial_total_score', 'DESC']]
                });
                if (mySpirit) {
                    // COUNT 比自己分高的就是自己的排名
                    const higherCount = await PlayerArtifactSpirit.count({
                        where: {
                            is_awakened: true,
                            trial_total_score: { [Op.gt]: safeBigInt(mySpirit.trial_total_score) }
                        }
                    });
                    myRank = higherCount + 1;
                }
            }

            const spiritTypes = config.spirit_types || {};
            const ranking = spirits.map((spirit, idx) => {
                const typeConfig = spiritTypes[spirit.spirit_type] || {};
                const p = playerMap.get(spirit.player_id);
                return {
                    rank: offset + idx + 1,
                    player_id: spirit.player_id,
                    player_name: p?.nickname || '未知道友',
                    player_realm: p?.realm || '',
                    spirit_id: spirit.id,
                    spirit_type: spirit.spirit_type,
                    spirit_type_name: typeConfig.name || spirit.spirit_type,
                    spirit_name: spirit.spirit_name,
                    spirit_level: spirit.spirit_level,
                    trial_best_score: spirit.trial_best_score,
                    trial_total_score: safeBigInt(spirit.trial_total_score).toString(),
                    trial_total_count: spirit.trial_total_count,
                    is_self: spirit.player_id === playerId
                };
            });

            return {
                success: true,
                message: 'success',
                data: {
                    ranking,
                    my_rank: myRank,
                    my_spirit: mySpirit ? {
                        spirit_id: mySpirit.id,
                        spirit_type: mySpirit.spirit_type,
                        trial_total_score: safeBigInt(mySpirit.trial_total_score).toString(),
                        trial_best_score: mySpirit.trial_best_score
                    } : null,
                    total,
                    page: pageNum,
                    page_size: pageSizeNum,
                    top_count: topCount
                }
            };
        } catch (err) {
            console.error('[ArtifactSpiritService.getTrialRanking] 异常:', err);
            throw new AppError(`获取试炼榜失败: ${err.message}`, 500, ErrorCodes.INTERNAL_ERROR);
        }
    }
}

// 单例导出
const artifactSpiritService = new ArtifactSpiritService();
module.exports = artifactSpiritService;
