/**
 * 大衍诀修炼服务
 *
 * 设计依据：xiuxian_game_guide.md 第23节·大衍诀与傀儡路线
 *   `.参悟大衍诀` / `.大衍诀` / `.修炼大衍诀` 查看和推进层数
 *
 * 系统定位：
 *   大衍诀是后期成长线，核心价值是提高神识操控、傀儡运用、裂缝探索、节点稳定和飞升前置能力。
 *   修炼后按层数提供有效神识倍率（x1.30/x1.60/x2.00/x2.45/x3.00），
 *   影响探查、斗法神识威压、御宝预算、傀儡牵丝和神识类成功率判定。
 *
 * 核心机制：
 *   1. 5层修炼：凝识→分念→控傀→千机→衍神，每层需对应残篇突破
 *   2. 参悟推进：每日3次，冷却10分钟，消耗修为获得大衍诀经验
 *   3. 突破判定：经验满后消耗残篇尝试突破，成功率随层数递减
 *   4. 神识联动：层数影响神识上限（dayan_level * 100），已在 DivineSenseService 中集成
 *   5. 飞升前置：五层·衍神是飞升灵界的必要条件
 *
 * 数据模型：
 *   - PlayerAscension 表（已存在 dayan_level + dayan_exp 字段，无需新建表）
 *   - 残篇作为物品存储在 player_items 表（item_data.json 已定义5种残篇）
 *
 * 设计原则：
 *   - 所有阈值/比例从 dayan_data.json 读取，禁止硬编码
 *   - 关键操作使用事务 + LOCK.UPDATE 行级锁
 *   - 跨日重置每日参悟次数
 *   - WebSocket 推送突破结果
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const Player = require('../../models/player');
const PlayerAscension = require('../../models/playerAscension');
const InventoryService = require('./InventoryService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// 单例库存服务
const inventoryService = InventoryService;

class DayanService {
    constructor() {
        this.configLoader = null;
    }

    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        console.log('[DayanService] 大衍诀修炼服务初始化完成');
    }

    /**
     * 获取大衍诀配置
     * @returns {Object} 配置对象
     */
    getDayanConfig() {
        return this.configLoader?.getConfig('dayan_data') || {};
    }

    /**
     * 获取或创建玩家的飞升记录（含大衍诀数据）
     * @param {number} playerId - 玩家ID
     * @param {Object} [transaction] - 可选事务
     * @returns {Promise<Object>} PlayerAscension 实例
     * @private
     */
    async _getOrCreateAscension(playerId, transaction = null) {
        const options = transaction ? { transaction } : {};
        let ascension = await PlayerAscension.findOne({
            where: { player_id: playerId },
            ...options
        });
        if (!ascension) {
            ascension = await PlayerAscension.create({
                player_id: playerId,
                dayan_level: 0,
                dayan_exp: 0,
                // 字段名与 playerAscension.js 模型一致：ascension_state（非 ascension_status）
                ascension_state: 'preparing'
            }, options);
        }
        return ascension;
    }

    /**
     * 获取大衍诀修炼状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 大衍诀状态
     */
    async getDayanStatus(playerId) {
        const cfg = this.getDayanConfig();
        if (!cfg.enabled) {
            throw new AppError('大衍诀系统未启用', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const ascension = await this._getOrCreateAscension(playerId);
        const currentLevel = ascension.dayan_level || 0;
        const currentExp = ascension.dayan_exp || 0;

        // 获取当前层配置
        const levels = cfg.levels || {};
        const currentLevelCfg = levels[String(currentLevel)] || levels['0'];
        const nextLevelCfg = levels[String(currentLevel + 1)];

        // 计算突破所需残篇
        let nextFragmentInfo = null;
        if (nextLevelCfg && nextLevelCfg.fragment_required) {
            const fragmentKey = nextLevelCfg.fragment_required;
            const fragmentCfg = (cfg.fragments || {})[fragmentKey];
            const ownedQuantity = await inventoryService.getItemQuantity(playerId, fragmentKey);
            nextFragmentInfo = {
                item_key: fragmentKey,
                name: fragmentCfg?.name || fragmentKey,
                required: nextLevelCfg.fragment_count || 1,
                owned: ownedQuantity,
                source: fragmentCfg?.source || '未知',
                description: fragmentCfg?.description || ''
            };
        }

        // 计算参悟状态
        const meditateCfg = cfg.meditate || {};
        const today = new Date().toISOString().slice(0, 10);
        const lastMeditateDate = ascension.last_meditate_date
            ? (ascension.last_meditate_date instanceof Date
                ? ascension.last_meditate_date.toISOString().slice(0, 10)
                : String(ascension.last_meditate_date).slice(0, 10))
            : null;
        const isCrossDay = lastMeditateDate !== today;
        const dailyUsed = isCrossDay ? 0 : (ascension.dayan_meditate_count || 0);
        const dailyLimit = meditateCfg.daily_limit || 3;
        const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);

        // 计算冷却剩余
        let cooldownRemainingSec = 0;
        if (ascension.last_meditate_at) {
            const lastMs = new Date(ascension.last_meditate_at).getTime();
            const elapsed = Math.floor((Date.now() - lastMs) / 1000);
            const cooldown = meditateCfg.cooldown_sec || 600;
            cooldownRemainingSec = Math.max(0, cooldown - elapsed);
        }

        // 计算参悟消耗（修为）
        const costExpBase = meditateCfg.cost_exp_base || 500;
        const costExpPerLevel = meditateCfg.cost_exp_per_level || 300;
        const meditateCost = costExpBase + currentLevel * costExpPerLevel;

        // 计算神识倍率与上限加成
        const senseMultiplier = currentLevelCfg?.sense_multiplier || 1.0;
        const senseBonusPerLevel = cfg.sense_bonus_per_level || 100;
        const senseMaxBonus = currentLevel * senseBonusPerLevel;

        return {
            enabled: cfg.enabled,
            current_level: currentLevel,
            current_level_name: currentLevelCfg?.name || '未入门',
            current_level_description: currentLevelCfg?.description || '',
            current_exp: currentExp,
            exp_to_next: currentLevelCfg?.exp_to_next || 0,
            sense_multiplier: senseMultiplier,
            sense_max_bonus: senseMaxBonus,
            can_ascend: currentLevel >= (cfg.ascension_requirement?.required_level || 5),
            ascension_requirement: cfg.ascension_requirement || {},
            meditate: {
                daily_limit: dailyLimit,
                daily_used: dailyUsed,
                daily_remaining: dailyRemaining,
                cooldown_remaining_sec: cooldownRemainingSec,
                can_meditate: dailyRemaining > 0 && cooldownRemainingSec === 0,
                cost_exp: meditateCost,
                exp_per_meditate: meditateCfg.exp_per_meditate || 100
            },
            next_fragment: nextFragmentInfo,
            can_breakthrough: nextLevelCfg !== undefined && currentExp >= (currentLevelCfg?.exp_to_next || 0) && nextFragmentInfo !== null,
            player_exp: player.exp ? player.exp.toString() : '0',
            player_realm: player.realm,
            player_realm_rank: player.realm_rank
        };
    }

    /**
     * 参悟大衍诀（消耗修为 + 获得大衍诀经验）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 参悟结果
     */
    async meditate(playerId) {
        const cfg = this.getDayanConfig();
        if (!cfg.enabled) {
            throw new AppError('大衍诀系统未启用', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 境界检查
        const minRealmRank = cfg.min_realm_rank || 15;
        const meditateCfg = cfg.meditate || {};

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已陨落，无法参悟', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if ((player.realm_rank || 0) < minRealmRank) {
                throw new AppError(`需达到炼气期（rank≥${minRealmRank}）方可参悟大衍诀`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const ascension = await this._getOrCreateAscension(playerId, t);
            // 行级锁
            const lockedAscension = await PlayerAscension.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            const currentLevel = lockedAscension.dayan_level || 0;
            const maxLevel = cfg.max_level || 5;
            if (currentLevel >= maxLevel) {
                throw new AppError('大衍诀已修至最高层，无需再参悟', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 跨日重置次数
            const today = new Date().toISOString().slice(0, 10);
            const lastDate = lockedAscension.last_meditate_date
                ? (lockedAscension.last_meditate_date instanceof Date
                    ? lockedAscension.last_meditate_date.toISOString().slice(0, 10)
                    : String(lockedAscension.last_meditate_date).slice(0, 10))
                : null;
            if (lastDate !== today) {
                lockedAscension.dayan_meditate_count = 0;
            }

            // 每日次数检查
            const dailyLimit = meditateCfg.daily_limit || 3;
            if ((lockedAscension.dayan_meditate_count || 0) >= dailyLimit) {
                throw new AppError(`今日参悟次数已达上限（${dailyLimit}次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 冷却检查
            if (lockedAscension.last_meditate_at) {
                const lastMs = new Date(lockedAscension.last_meditate_at).getTime();
                const elapsed = Math.floor((Date.now() - lastMs) / 1000);
                const cooldown = meditateCfg.cooldown_sec || 600;
                if (elapsed < cooldown) {
                    const remaining = cooldown - elapsed;
                    throw new AppError(`参悟冷却中，剩余 ${remaining} 秒`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            // 修为消耗
            const costExpBase = meditateCfg.cost_exp_base || 500;
            const costExpPerLevel = meditateCfg.cost_exp_per_level || 300;
            const costExp = costExpBase + currentLevel * costExpPerLevel;
            const playerExp = BigInt(player.exp || 0);
            if (playerExp < BigInt(costExp)) {
                throw new AppError(`修为不足，参悟需消耗 ${costExp} 修为`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣除修为
            player.exp = playerExp - BigInt(costExp);

            // 增加大衍诀经验
            const expGain = meditateCfg.exp_per_meditate || 100;
            const currentLevelCfg = (cfg.levels || {})[String(currentLevel)] || {};
            const expToNext = currentLevelCfg.exp_to_next || 0;
            let newExp = (lockedAscension.dayan_exp || 0) + expGain;
            // 经验不超过当前层上限
            if (expToNext > 0 && newExp > expToNext) {
                newExp = expToNext;
            }
            lockedAscension.dayan_exp = newExp;
            lockedAscension.dayan_meditate_count = (lockedAscension.dayan_meditate_count || 0) + 1;
            lockedAscension.last_meditate_at = new Date();
            lockedAscension.last_meditate_date = today;

            await lockedAscension.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            // WebSocket 通知（事务外）
            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: cfg.websocket?.events?.dayan_meditate || 'dayan_meditate',
                    data: {
                        level: currentLevel,
                        exp_gained: expGain,
                        exp_current: newExp,
                        exp_to_next: expToNext,
                        can_breakthrough: expToNext > 0 && newExp >= expToNext
                    }
                });
            } catch (e) {
                console.warn('[DayanService] WebSocket 通知失败:', e.message);
            }

            return {
                success: true,
                message: `参悟大衍诀成功，获得 ${expGain} 经验`,
                level: currentLevel,
                level_name: currentLevelCfg.name || '未入门',
                exp_gained: expGain,
                exp_current: newExp,
                exp_to_next: expToNext,
                can_breakthrough: expToNext > 0 && newExp >= expToNext,
                cost_exp: costExp,
                player_exp_after: player.exp.toString(),
                daily_remaining: Math.max(0, dailyLimit - lockedAscension.dayan_meditate_count)
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 突破大衍诀层数（消耗残篇 + 成功率判定）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 突破结果
     */
    async breakthrough(playerId) {
        const cfg = this.getDayanConfig();
        if (!cfg.enabled) {
            throw new AppError('大衍诀系统未启用', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const lockedAscension = await PlayerAscension.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!lockedAscension) {
                throw new AppError('大衍诀数据未初始化，请先参悟', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const currentLevel = lockedAscension.dayan_level || 0;
            const maxLevel = cfg.max_level || 5;
            if (currentLevel >= maxLevel) {
                throw new AppError('大衍诀已修至最高层', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 检查经验是否足够
            const currentLevelCfg = (cfg.levels || {})[String(currentLevel)] || {};
            const expToNext = currentLevelCfg.exp_to_next || 0;
            if (expToNext > 0 && (lockedAscension.dayan_exp || 0) < expToNext) {
                throw new AppError(`经验不足，需 ${expToNext} 经验方可突破`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 检查残篇
            const nextLevelCfg = (cfg.levels || {})[String(currentLevel + 1)];
            if (!nextLevelCfg) {
                throw new AppError('无法获取下一层配置', 500, ErrorCodes.INTERNAL_ERROR);
            }
            const fragmentKey = nextLevelCfg.fragment_required;
            const fragmentCount = nextLevelCfg.fragment_count || 1;
            if (!fragmentKey) {
                throw new AppError('下一层突破未配置残篇要求', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 检查残篇数量（事务内加锁查询）
            const hasFragment = await inventoryService.hasItem(playerId, fragmentKey, fragmentCount, t);
            if (!hasFragment) {
                const fragmentCfg = (cfg.fragments || {})[fragmentKey];
                throw new AppError(
                    `需要 ${fragmentCfg?.name || fragmentKey} x${fragmentCount} 方可突破`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 扣除残篇
            const removeOk = await inventoryService.removeItem(playerId, fragmentKey, fragmentCount, t);
            if (!removeOk) {
                throw new AppError('残篇扣除失败', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 成功率判定
            const breakthroughCfg = cfg.breakthrough || {};
            const baseRate = breakthroughCfg.success_rate_base || 0.8;
            const decay = breakthroughCfg.success_rate_per_level_decay || 0.1;
            const minRate = breakthroughCfg.min_success_rate || 0.3;
            const successRate = Math.max(minRate, baseRate - currentLevel * decay);
            const isSuccess = Math.random() < successRate;

            if (isSuccess) {
                // 突破成功
                lockedAscension.dayan_level = currentLevel + 1;
                lockedAscension.dayan_exp = 0; // 重置经验
                await lockedAscension.save({ transaction: t });
                await t.commit();

                // WebSocket 通知
                try {
                    WebSocketNotificationService.notifyPlayer(playerId, {
                        type: cfg.websocket?.events?.dayan_breakthrough_success || 'dayan_breakthrough_success',
                        data: {
                            old_level: currentLevel,
                            new_level: currentLevel + 1,
                            new_level_name: nextLevelCfg.name,
                            sense_multiplier: nextLevelCfg.sense_multiplier
                        }
                    });
                } catch (e) {
                    console.warn('[DayanService] WebSocket 通知失败:', e.message);
                }

                return {
                    success: true,
                    breakthrough: true,
                    message: `突破成功！大衍诀晋升至${nextLevelCfg.name}`,
                    old_level: currentLevel,
                    new_level: currentLevel + 1,
                    new_level_name: nextLevelCfg.name,
                    new_level_description: nextLevelCfg.description,
                    sense_multiplier: nextLevelCfg.sense_multiplier,
                    can_ascend: (currentLevel + 1) >= (cfg.ascension_requirement?.required_level || 5)
                };
            } else {
                // 突破失败：残篇已消耗，经验保留
                await t.commit();

                try {
                    WebSocketNotificationService.notifyPlayer(playerId, {
                        type: cfg.websocket?.events?.dayan_breakthrough_failed || 'dayan_breakthrough_failed',
                        data: {
                            level: currentLevel,
                            success_rate: successRate
                        }
                    });
                } catch (e) {
                    console.warn('[DayanService] WebSocket 通知失败:', e.message);
                }

                return {
                    success: true,
                    breakthrough: false,
                    message: `突破失败，残篇已损耗，经验保留。成功率 ${(successRate * 100).toFixed(0)}%`,
                    level: currentLevel,
                    success_rate: successRate,
                    exp_current: lockedAscension.dayan_exp
                };
            }
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 检查飞升前置条件（大衍诀五层·衍神）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 检查结果
     */
    async checkAscensionRequirement(playerId) {
        const cfg = this.getDayanConfig();
        const requiredLevel = cfg.ascension_requirement?.required_level || 5;
        const ascension = await this._getOrCreateAscension(playerId);
        const currentLevel = ascension.dayan_level || 0;
        return {
            required_level: requiredLevel,
            current_level: currentLevel,
            met: currentLevel >= requiredLevel,
            message: currentLevel >= requiredLevel
                ? '大衍诀已达五层·衍神，满足飞升前置条件'
                : `需大衍诀${requiredLevel}层·衍神方可飞升，当前${currentLevel}层`
        };
    }
}

module.exports = new DayanService();
