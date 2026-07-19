/**
 * 元婴出窍与高阶境界服务
 *
 * 实现玩法文档第3、18章描述的高阶境界机制：
 *   1. 元婴出窍：元婴初期以上玩家可将元神离体，进行探索/窥探/远方修炼
 *   2. 问道：化神初期以上玩家每日可向天道问道，积累感悟值用于突破加成
 *   3. 法相天地：化神后期以上玩家可凝聚法相，每级提供5%属性加成
 *   4. 探寻裂缝：炼虚初期以上玩家可探寻虚空裂缝，获得稀有材料
 *   5. 虚弱/残魂：突破失败、出窍时间过长等触发，影响修炼与突破
 *   6. 夺舍重生：残魂过低或肉身毁灭时，可尝试夺舍重生
 *
 * 设计原则：
 *   - 所有可变参数从 realm_breakthrough.json 的 high_realm_features 配置读取
 *   - 重大状态变更通过 WebSocket 主动推送
 *   - 与状态机集成，元婴出窍期间互斥其他操作
 *   - 行级锁 + 事务保证并发安全
 *   - 日重置、冷却等"游戏时间"逻辑统一封装
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');

/**
 * 高阶境界配置缓存（避免每次访问都查 ConfigLoader）
 */
function getHighRealmConfig() {
    const config = configLoader.getConfig('realm_breakthrough');
    return config?.high_realm_features || {};
}

/**
 * 获取元婴出窍配置
 */
function getSoulOutConfig() {
    return getHighRealmConfig().nascent_soul_out || {
        min_realm_rank: 19,
        min_realm_name: '元婴初期',
        default_duration_sec: 1800,
        max_duration_sec: 7200,
        daily_limit: 5,
        cooldown_sec: 600,
        sense_consumption_rate: 0.05,
        exp_reward_rate: 0.01
    };
}

/**
 * 获取问道配置
 */
function getAskDaoConfig() {
    return getHighRealmConfig().ask_dao || {
        min_realm_rank: 23,
        min_realm_name: '化神初期',
        daily_limit: 3,
        cooldown_sec: 3600,
        insight_base_gain: 10,
        insight_random_range: 20,
        exp_cost_rate: 0.005
    };
}

/**
 * 获取法相天地配置
 */
function getDharmaFormConfig() {
    return getHighRealmConfig().dharma_form || {
        min_realm_rank: 25,
        min_realm_name: '化神后期',
        max_level: 9,
        exp_cost_per_level: 1000000,
        sense_cost_per_level: 100,
        attribute_bonus_per_level: 0.05
    };
}

/**
 * 获取探寻裂缝配置
 */
function getFractureConfig() {
    return getHighRealmConfig().fracture_explore || {
        min_realm_rank: 27,
        min_realm_name: '炼虚初期',
        daily_limit: 2,
        cooldown_sec: 7200,
        sense_cost: 50,
        discover_chance: 0.6,
        rare_drop_chance: 0.05
    };
}

/**
 * 获取虚弱配置
 */
function getWeaknessConfig() {
    return getHighRealmConfig().weakness || {
        exp_loss_rate_on_breakthrough_fail: 0.15,
        duration_sec: 3600,
        exp_gain_rate_penalty: 0.5,
        breakthrough_prob_penalty: 20
    };
}

/**
 * 获取残魂配置
 */
function getRemnantSoulConfig() {
    return getHighRealmConfig().remnant_soul || {
        trigger_threshold: 30,
        recovery_rate_per_hour: 5,
        max_value: 100
    };
}

/**
 * 获取夺舍配置
 */
function getReincarnationConfig() {
    return getHighRealmConfig().reincarnation || {
        min_remnant_soul: 50,
        success_rate: 0.4,
        cooldown_sec: 86400
    };
}

/**
 * 工具函数：判断玩家境界是否达到指定境界要求
 * @param {Object} player - 玩家对象
 * @param {number} minRank - 最低境界排名
 * @returns {boolean}
 */
function isRealmMet(player, minRank) {
    const currentRealm = RealmService.getRealmByName(player.realm);
    if (!currentRealm) return false;
    return currentRealm.rank >= minRank;
}

/**
 * 工具函数：跨日重置每日次数（按 DATEONLY 比较）
 * @param {Object} player - 玩家对象
 * @param {string} dateField - 日期字段名
 * @param {string} countField - 次数字段名
 */
function resetDailyCountIfCrossDay(player, dateField, countField) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastDate = player[dateField];
    if (lastDate) {
        // 转为 YYYY-MM-DD 字符串比较
        const lastStr = lastDate instanceof Date
            ? lastDate.toISOString().slice(0, 10)
            : String(lastDate).slice(0, 10);
        if (lastStr !== today) {
            player[countField] = 0;
            player[dateField] = today;
        }
    } else {
        // 首次设置
        player[countField] = 0;
        player[dateField] = today;
    }
}

/**
 * 工具函数：检查冷却时间是否已过
 * @param {Object} player - 玩家对象
 * @param {string} timeField - 上次操作时间字段
 * @param {number} cooldownSec - 冷却秒数
 * @returns {{ready: boolean, remainingSec: number}}
 */
function checkCooldown(player, timeField, cooldownSec) {
    const lastTime = player[timeField];
    if (!lastTime) return { ready: true, remainingSec: 0 };
    const lastMs = lastTime instanceof Date ? lastTime.getTime() : new Date(lastTime).getTime();
    const elapsedSec = Math.floor((Date.now() - lastMs) / 1000);
    if (elapsedSec >= cooldownSec) {
        return { ready: true, remainingSec: 0 };
    }
    return { ready: false, remainingSec: cooldownSec - elapsedSec };
}

class NascentSoulService {
    /**
     * 获取玩家元婴系统状态总览
     * @param {Object} player - 玩家对象
     * @returns {Object} 元婴系统状态数据
     */
    getStatus(player) {
        const soulOutCfg = getSoulOutConfig();
        const askDaoCfg = getAskDaoConfig();
        const dharmaCfg = getDharmaFormConfig();
        const fractureCfg = getFractureConfig();
        const remnantCfg = getRemnantSoulConfig();
        const weaknessCfg = getWeaknessConfig();
        const reincarnationCfg = getReincarnationConfig();

        const currentRealm = RealmService.getRealmByName(player.realm);
        const realmRank = currentRealm?.rank || 0;

        // 虚弱状态判断
        const weaknessEndTime = player.weakness_end_time;
        const isWeak = weaknessEndTime && new Date(weaknessEndTime) > new Date();
        const weaknessRemainingSec = isWeak
            ? Math.floor((new Date(weaknessEndTime) - Date.now()) / 1000)
            : 0;

        // 出窍冷却
        const soulOutCooldown = checkCooldown(player, 'last_soul_out_time', soulOutCfg.cooldown_sec);
        // 问道冷却
        const askDaoCooldown = checkCooldown(player, 'last_ask_dao_date', askDaoCfg.cooldown_sec);
        // 裂缝冷却
        const fractureCooldown = checkCooldown(player, 'last_fracture_explore_time', fractureCfg.cooldown_sec);
        // 夺舍冷却
        const reincarnationCooldown = checkCooldown(player, 'last_reincarnation_time', reincarnationCfg.cooldown_sec);

        // 出窍剩余时间
        let soulOutRemainingSec = 0;
        if (player.soul_state === 'out' && player.soul_out_end_time) {
            soulOutRemainingSec = Math.max(0, Math.floor((new Date(player.soul_out_end_time) - Date.now()) / 1000));
        }

        return {
            realm: player.realm,
            realm_rank: realmRank,
            // 元婴出窍
            soul_out: {
                unlocked: realmRank >= soulOutCfg.min_realm_rank,
                state: player.soul_state || 'none',
                target: player.soul_out_target || 'explore',
                daily_count: player.daily_soul_out_count || 0,
                daily_limit: soulOutCfg.daily_limit,
                cooldown_ready: soulOutCooldown.ready,
                cooldown_remaining_sec: soulOutCooldown.remainingSec,
                out_remaining_sec: soulOutRemainingSec,
                start_time: player.soul_out_start_time,
                end_time: player.soul_out_end_time
            },
            // 问道
            ask_dao: {
                unlocked: realmRank >= askDaoCfg.min_realm_rank,
                insight: player.ask_dao_insight || 0,
                daily_count: player.daily_ask_dao_count || 0,
                daily_limit: askDaoCfg.daily_limit,
                cooldown_ready: askDaoCooldown.ready,
                cooldown_remaining_sec: askDaoCooldown.remainingSec
            },
            // 法相天地
            dharma_form: {
                unlocked: realmRank >= dharmaCfg.min_realm_rank,
                level: player.dharma_form_level || 0,
                max_level: dharmaCfg.max_level,
                attribute_bonus: (player.dharma_form_level || 0) * dharmaCfg.attribute_bonus_per_level,
                next_level_exp_cost: dharmaCfg.exp_cost_per_level,
                next_level_sense_cost: dharmaCfg.sense_cost_per_level
            },
            // 探寻裂缝
            fracture_explore: {
                unlocked: realmRank >= fractureCfg.min_realm_rank,
                daily_count: player.daily_fracture_explore_count || 0,
                daily_limit: fractureCfg.daily_limit,
                cooldown_ready: fractureCooldown.ready,
                cooldown_remaining_sec: fractureCooldown.remainingSec,
                sense_cost: fractureCfg.sense_cost
            },
            // 虚弱
            weakness: {
                is_weak: isWeak,
                end_time: weaknessEndTime,
                remaining_sec: weaknessRemainingSec,
                exp_gain_penalty: weaknessCfg.exp_gain_rate_penalty,
                breakthrough_penalty: weaknessCfg.breakthrough_prob_penalty
            },
            // 残魂
            remnant_soul: {
                value: player.remnant_soul ?? 100,
                max: remnantCfg.max_value,
                trigger_threshold: remnantCfg.trigger_threshold,
                is_unstable: (player.remnant_soul ?? 100) < remnantCfg.trigger_threshold,
                recovery_rate_per_hour: remnantCfg.recovery_rate_per_hour
            },
            // 夺舍
            reincarnation: {
                available: (player.remnant_soul ?? 100) >= reincarnationCfg.min_remnant_soul,
                cooldown_ready: reincarnationCooldown.ready,
                cooldown_remaining_sec: reincarnationCooldown.remainingSec,
                success_rate: reincarnationCfg.success_rate,
                min_remnant_soul: reincarnationCfg.min_remnant_soul
            }
        };
    }

    /**
     * 元婴出窍
     * @param {number} playerId - 玩家ID
     * @param {string} target - 出窍目标：explore/scout/cultivate
     * @param {number} durationSec - 出窍时长(秒)
     * @returns {Promise<Object>} 出窍结果
     */
    async startSoulOut(playerId, target = 'explore', durationSec = null) {
        const t = await sequelize.transaction();
        try {
            // 行级锁防止并发
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const cfg = getSoulOutConfig();
            // 境界检查
            if (!isRealmMet(player, cfg.min_realm_rank)) {
                await t.rollback();
                return { success: false, message: `境界不足，需达到 ${cfg.min_realm_name} 方可元婴出窍` };
            }

            // 状态校验：必须为空闲
            if (player.soul_state !== 'none') {
                await t.rollback();
                return { success: false, message: `当前元神状态为 ${player.soul_state}，无法再次出窍` };
            }

            // 跨日重置每日次数
            resetDailyCountIfCrossDay(player, 'last_soul_out_date', 'daily_soul_out_count');

            // 每日次数检查
            if (player.daily_soul_out_count >= cfg.daily_limit) {
                await t.rollback();
                return { success: false, message: `今日出窍次数已达上限 ${cfg.daily_limit} 次` };
            }

            // 冷却检查
            const cooldown = checkCooldown(player, 'last_soul_out_time', cfg.cooldown_sec);
            if (!cooldown.ready) {
                await t.rollback();
                return {
                    success: false,
                    message: `出窍冷却中，剩余 ${cooldown.remainingSec} 秒`,
                    cooldown_remaining_sec: cooldown.remainingSec
                };
            }

            // 虚弱检查
            if (player.weakness_end_time && new Date(player.weakness_end_time) > new Date()) {
                await t.rollback();
                return { success: false, message: '虚弱状态下无法出窍' };
            }

            // 残魂过低检查
            const remnantCfg = getRemnantSoulConfig();
            if ((player.remnant_soul ?? 100) < remnantCfg.trigger_threshold) {
                await t.rollback();
                return {
                    success: false,
                    message: `残魂值过低（${player.remnant_soul}），无法稳定出窍，请先修复残魂`
                };
            }

            // 校验目标类型
            const validTargets = ['explore', 'scout', 'cultivate'];
            if (!validTargets.includes(target)) {
                await t.rollback();
                return { success: false, message: `无效的出窍目标：${target}` };
            }

            // 时长校验
            const finalDuration = durationSec
                ? Math.min(Math.max(durationSec, 300), cfg.max_duration_sec) // 最少5分钟，最多上限
                : cfg.default_duration_sec;

            // 神识消耗（按基础神识 × 比率 × 时长系数）
            const currentRealm = RealmService.getRealmByName(player.realm);
            const baseSense = currentRealm?.base_sense || 10;
            const senseCost = Math.floor(baseSense * cfg.sense_consumption_rate * (finalDuration / 3600));
            const attrs = typeof player.attributes === 'string'
                ? JSON.parse(player.attributes)
                : (player.attributes || {});
            const currentSense = attrs.sense || baseSense;
            if (currentSense < senseCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `神识不足，需要 ${senseCost} 点神识，当前 ${currentSense} 点`
                };
            }

            // 扣除神识
            attrs.sense = currentSense - senseCost;
            player.attributes = attrs;

            // 设置出窍状态
            const now = new Date();
            const endTime = new Date(now.getTime() + finalDuration * 1000);
            player.soul_state = 'out';
            player.soul_out_start_time = now;
            player.soul_out_end_time = endTime;
            player.soul_out_duration = finalDuration;
            player.soul_out_target = target;
            player.daily_soul_out_count = (player.daily_soul_out_count || 0) + 1;

            await player.save({ transaction: t });
            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'soul_out_start', {
                    soul_state: 'out',
                    target,
                    start_time: now,
                    end_time: endTime,
                    duration: finalDuration,
                    sense_cost: senseCost
                });
            } catch (e) {
                console.error('[NascentSoulService] 推送出窍开始状态失败:', e.message);
            }

            return {
                success: true,
                message: `元婴出窍成功，目标：${target}，时长 ${finalDuration} 秒`,
                data: {
                    soul_state: 'out',
                    target,
                    start_time: now,
                    end_time: endTime,
                    duration: finalDuration,
                    sense_cost: senseCost,
                    daily_count: player.daily_soul_out_count,
                    daily_limit: cfg.daily_limit
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[NascentSoulService] 元婴出窍失败:', err);
            return { success: false, message: `出窍失败：${err.message}` };
        }
    }

    /**
     * 元婴归来（主动召回）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 归来结果
     */
    async endSoulOut(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            if (player.soul_state !== 'out') {
                await t.rollback();
                return { success: false, message: `当前元神状态为 ${player.soul_state}，无需召回` };
            }

            const cfg = getSoulOutConfig();
            const now = new Date();
            const startTime = new Date(player.soul_out_start_time);
            const actualDuration = Math.max(0, Math.floor((now - startTime) / 1000));
            const plannedDuration = player.soul_out_duration || cfg.default_duration_sec;

            // 计算收益
            // 1. 修为收益：按当前修为 × 比率 × (实际时长 / 计划时长)
            // 2. 提前召回按比例折减
            // 3. 不同目标有不同奖励偏向
            const completionRate = Math.min(1, actualDuration / plannedDuration);
            const expReward = this._calculateSoulOutReward(player, actualDuration, player.soul_out_target, completionRate);

            // 残魂消耗：出窍期间会消耗少量残魂
            const remnantSoulCost = Math.min(5, actualDuration / 3600 * 2);
            const newRemnantSoul = Math.max(0, (player.remnant_soul ?? 100) - remnantSoulCost);

            // 重置状态
            player.soul_state = 'none';
            player.soul_out_start_time = null;
            player.soul_out_end_time = null;
            player.soul_out_duration = 0;
            player.soul_out_target = 'explore';
            player.last_soul_out_time = now;
            player.remnant_soul = newRemnantSoul;

            // 增加修为
            if (expReward > 0) {
                player.exp = BigInt(player.exp || 0) + BigInt(expReward);
            }

            await player.save({ transaction: t });
            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'soul_out_end', {
                    soul_state: 'none',
                    actual_duration: actualDuration,
                    completion_rate: completionRate,
                    exp_reward: expReward,
                    remnant_soul_cost: remnantSoulCost,
                    remnant_soul: newRemnantSoul
                });
            } catch (e) {
                console.error('[NascentSoulService] 推送出窍归来状态失败:', e.message);
            }

            return {
                success: true,
                message: `元婴归来！本次出窍 ${actualDuration} 秒，获得修为 ${expReward}，消耗残魂 ${remnantSoulCost.toFixed(2)}`,
                data: {
                    soul_state: 'none',
                    actual_duration: actualDuration,
                    completion_rate: completionRate,
                    exp_reward: expReward,
                    remnant_soul_cost: remnantSoulCost,
                    remnant_soul: newRemnantSoul,
                    cooldown_remaining_sec: cfg.cooldown_sec
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[NascentSoulService] 元婴归来失败:', err);
            return { success: false, message: `归来失败：${err.message}` };
        }
    }

    /**
     * 计算元婴出窍奖励
     * @param {Object} player - 玩家对象
     * @param {number} durationSec - 实际出窍时长
     * @param {string} target - 出窍目标
     * @param {number} completionRate - 完成率
     * @returns {number} 修为奖励
     * @private
     */
    _calculateSoulOutReward(player, durationSec, target, completionRate) {
        const cfg = getSoulOutConfig();
        const currentRealm = RealmService.getRealmByName(player.realm);
        const realmRank = currentRealm?.rank || 1;
        const baseSense = currentRealm?.base_sense || 10;

        // 基础修为 = 当前修为 × 0.01 × (时长 / 3600) × 境界系数
        const baseExp = Math.floor(
            Number(player.exp || 0) * cfg.exp_reward_rate * (durationSec / 3600) * (1 + (realmRank - 19) * 0.1)
        );

        // 目标偏向加成
        let targetMultiplier = 1.0;
        if (target === 'cultivate') targetMultiplier = 1.5;      // 远方修炼偏向修为
        else if (target === 'explore') targetMultiplier = 1.0;   // 探索平衡
        else if (target === 'scout') targetMultiplier = 0.7;     // 窥探偏向信息

        // 完成率折减（提前召回按比例折减，正常归来为1.0）
        return Math.floor(baseExp * targetMultiplier * completionRate);
    }

    /**
     * 问道
     * 化神初期以上玩家每日可向天道问道，获得感悟值，用于突破加成
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 问道结果
     */
    async askDao(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const cfg = getAskDaoConfig();
            // 境界检查
            if (!isRealmMet(player, cfg.min_realm_rank)) {
                await t.rollback();
                return { success: false, message: `境界不足，需达到 ${cfg.min_realm_name} 方可问道` };
            }

            // 跨日重置每日次数
            resetDailyCountIfCrossDay(player, 'last_ask_dao_date', 'daily_ask_dao_count');

            // 每日次数检查
            if (player.daily_ask_dao_count >= cfg.daily_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日问道次数已达上限 ${cfg.daily_limit} 次`
                };
            }

            // 状态校验：出窍中不可问道
            if (player.soul_state === 'out') {
                await t.rollback();
                return { success: false, message: '元婴出窍中，无法静心问道' };
            }

            // 修为消耗
            const expCost = Math.floor(Number(player.exp || 0) * cfg.exp_cost_rate);
            if (Number(player.exp || 0) < expCost) {
                await t.rollback();
                return { success: false, message: `修为不足，需要 ${expCost} 点修为` };
            }

            // 计算感悟值获得
            const insightGain = cfg.insight_base_gain + Math.random() * cfg.insight_random_range;

            // 扣除修为
            player.exp = BigInt(player.exp || 0) - BigInt(expCost);
            // 增加感悟值
            player.ask_dao_insight = (player.ask_dao_insight || 0) + insightGain;
            player.daily_ask_dao_count = (player.daily_ask_dao_count || 0) + 1;
            player.last_ask_dao_date = new Date().toISOString().slice(0, 10);

            await player.save({ transaction: t });
            await t.commit();

            // 问道事件文本
            const daoEvents = [
                '忽觉天地法则流转，对大道有了新的感悟',
                '神识感应到一丝天道气息，感悟值提升',
                '冥冥中似有指引，对突破有了新的理解',
                '顿悟一丝法则之力，感悟值提升',
                '元神与天地共鸣，对大道有了更深认识'
            ];
            const eventText = daoEvents[Math.floor(Math.random() * daoEvents.length)];

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'ask_dao', {
                    insight_gain: insightGain,
                    total_insight: player.ask_dao_insight,
                    exp_cost: expCost,
                    event: eventText,
                    daily_count: player.daily_ask_dao_count,
                    daily_limit: cfg.daily_limit
                });
            } catch (e) {
                console.error('[NascentSoulService] 推送问道状态失败:', e.message);
            }

            return {
                success: true,
                message: `${eventText}，获得感悟值 ${insightGain.toFixed(2)}，消耗修为 ${expCost}`,
                data: {
                    insight_gain: insightGain,
                    total_insight: player.ask_dao_insight,
                    exp_cost: expCost,
                    event: eventText,
                    daily_count: player.daily_ask_dao_count,
                    daily_limit: cfg.daily_limit
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[NascentSoulService] 问道失败:', err);
            return { success: false, message: `问道失败：${err.message}` };
        }
    }

    /**
     * 凝聚法相天地
     * 化神后期以上玩家可消耗修为与神识提升法相等级，每级提供5%属性加成
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 凝聚结果
     */
    async cultivateDharmaForm(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const cfg = getDharmaFormConfig();
            // 境界检查
            if (!isRealmMet(player, cfg.min_realm_rank)) {
                await t.rollback();
                return { success: false, message: `境界不足，需达到 ${cfg.min_realm_name} 方可凝聚法相` };
            }

            const currentLevel = player.dharma_form_level || 0;
            // 等级上限
            if (currentLevel >= cfg.max_level) {
                await t.rollback();
                return { success: false, message: `法相天地已达最高等级 ${cfg.max_level}` };
            }

            // 状态校验：出窍中不可凝聚
            if (player.soul_state === 'out') {
                await t.rollback();
                return { success: false, message: '元婴出窍中，无法凝聚法相' };
            }

            // 计算升级消耗（按下一级）
            const nextLevel = currentLevel + 1;
            const expCost = cfg.exp_cost_per_level * nextLevel;
            const senseCost = cfg.sense_cost_per_level * nextLevel;

            // 修为检查
            if (Number(player.exp || 0) < expCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `修为不足，需要 ${expCost} 点修为，当前 ${player.exp}`
                };
            }

            // 神识检查
            const attrs = typeof player.attributes === 'string'
                ? JSON.parse(player.attributes)
                : (player.attributes || {});
            const currentSense = attrs.sense || 10;
            if (currentSense < senseCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `神识不足，需要 ${senseCost} 点神识，当前 ${currentSense}`
                };
            }

            // 扣除消耗
            player.exp = BigInt(player.exp || 0) - BigInt(expCost);
            attrs.sense = currentSense - senseCost;
            player.attributes = attrs;

            // 提升法相等级
            player.dharma_form_level = nextLevel;

            // 同步属性最大值（法相等级提供属性加成）
            // 注：实际属性加成在战斗/突破时动态计算，不修改基础属性

            await player.save({ transaction: t });
            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'dharma_form_upgraded', {
                    level: nextLevel,
                    exp_cost: expCost,
                    sense_cost: senseCost,
                    attribute_bonus: nextLevel * cfg.attribute_bonus_per_level
                });
            } catch (e) {
                console.error('[NascentSoulService] 推送法相升级失败:', e.message);
            }

            return {
                success: true,
                message: `法相天地突破至 ${nextLevel} 层，获得 ${(nextLevel * cfg.attribute_bonus_per_level * 100).toFixed(0)}% 属性加成`,
                data: {
                    level: nextLevel,
                    max_level: cfg.max_level,
                    exp_cost: expCost,
                    sense_cost: senseCost,
                    attribute_bonus: nextLevel * cfg.attribute_bonus_per_level,
                    next_level_exp_cost: cfg.exp_cost_per_level * (nextLevel + 1),
                    next_level_sense_cost: cfg.sense_cost_per_level * (nextLevel + 1)
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[NascentSoulService] 凝聚法相失败:', err);
            return { success: false, message: `凝聚法相失败：${err.message}` };
        }
    }

    /**
     * 探寻虚空裂缝
     * 炼虚初期以上玩家可探寻虚空裂缝，获得稀有材料
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 探寻结果
     */
    async exploreFracture(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const cfg = getFractureConfig();
            // 境界检查
            if (!isRealmMet(player, cfg.min_realm_rank)) {
                await t.rollback();
                return { success: false, message: `境界不足，需达到 ${cfg.min_realm_name} 方可探寻裂缝` };
            }

            // 跨日重置
            const today = new Date().toISOString().slice(0, 10);
            const lastDateStr = player.last_fracture_explore_time
                ? new Date(player.last_fracture_explore_time).toISOString().slice(0, 10)
                : null;
            if (lastDateStr !== today) {
                player.daily_fracture_explore_count = 0;
            }

            // 每日次数检查
            if (player.daily_fracture_explore_count >= cfg.daily_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日探寻次数已达上限 ${cfg.daily_limit} 次`
                };
            }

            // 冷却检查
            const cooldown = checkCooldown(player, 'last_fracture_explore_time', cfg.cooldown_sec);
            if (!cooldown.ready) {
                await t.rollback();
                return {
                    success: false,
                    message: `探寻冷却中，剩余 ${cooldown.remainingSec} 秒`
                };
            }

            // 状态校验：出窍中不可探寻
            if (player.soul_state === 'out') {
                await t.rollback();
                return { success: false, message: '元婴出窍中，无法探寻裂缝' };
            }

            // 神识消耗
            const attrs = typeof player.attributes === 'string'
                ? JSON.parse(player.attributes)
                : (player.attributes || {});
            const currentSense = attrs.sense || 10;
            if (currentSense < cfg.sense_cost) {
                await t.rollback();
                return {
                    success: false,
                    message: `神识不足，需要 ${cfg.sense_cost} 点神识，当前 ${currentSense}`
                };
            }

            // 扣除神识
            attrs.sense = currentSense - cfg.sense_cost;
            player.attributes = attrs;

            // 探寻结果判定
            const discoverRoll = Math.random();
            const isDiscovered = discoverRoll < cfg.discover_chance;
            const isRareDrop = isDiscovered && Math.random() < cfg.rare_drop_chance;

            // 残魂消耗（裂缝探索有反噬风险）
            const remnantSoulCost = 2 + Math.random() * 3;
            const newRemnantSoul = Math.max(0, (player.remnant_soul ?? 100) - remnantSoulCost);
            player.remnant_soul = newRemnantSoul;

            // 修为奖励（即使未发现也有少量）
            const baseExp = Math.floor(Number(player.exp || 0) * 0.002);
            const expReward = isRareDrop
                ? baseExp * 5
                : (isDiscovered ? baseExp * 2 : Math.floor(baseExp * 0.5));
            player.exp = BigInt(player.exp || 0) + BigInt(expReward);

            player.daily_fracture_explore_count = (player.daily_fracture_explore_count || 0) + 1;
            player.last_fracture_explore_time = new Date();

            // 物品掉落（暂以消息形式返回，实际物品入库由 InventoryService 处理）
            let dropItem = null;
            let dropMessage = '';
            if (isRareDrop) {
                const rareItems = [
                    { name: '空间法则碎片', count: 1, rarity: '传说' },
                    { name: '万年灵乳', count: 1, rarity: '史诗' },
                    { name: '逆灵通道坐标', count: 1, rarity: '传说' },
                    { name: '虚灵丹丹方', count: 1, rarity: '史诗' }
                ];
                dropItem = rareItems[Math.floor(Math.random() * rareItems.length)];
                dropMessage = `发现稀有材料：${dropItem.name} ×${dropItem.count}（${dropItem.rarity}）`;
            } else if (isDiscovered) {
                const normalItems = [
                    { name: '虚空残片', count: 1, rarity: '稀有' },
                    { name: '灵气结晶', count: 2, rarity: '普通' },
                    { name: '法则残屑', count: 1, rarity: '稀有' }
                ];
                dropItem = normalItems[Math.floor(Math.random() * normalItems.length)];
                dropMessage = `获得材料：${dropItem.name} ×${dropItem.count}（${dropItem.rarity}）`;
            } else {
                dropMessage = '未发现裂缝，但获得了少量修为';
            }

            await player.save({ transaction: t });
            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'fracture_explore', {
                    discovered: isDiscovered,
                    rare_drop: isRareDrop,
                    drop_item: dropItem,
                    exp_reward: expReward,
                    remnant_soul_cost: remnantSoulCost,
                    remnant_soul: newRemnantSoul,
                    daily_count: player.daily_fracture_explore_count,
                    daily_limit: cfg.daily_limit
                });
            } catch (e) {
                console.error('[NascentSoulService] 推送裂缝探索失败:', e.message);
            }

            return {
                success: true,
                message: `${dropMessage}，获得修为 ${expReward}，消耗残魂 ${remnantSoulCost.toFixed(2)}`,
                data: {
                    discovered: isDiscovered,
                    rare_drop: isRareDrop,
                    drop_item: dropItem,
                    exp_reward: expReward,
                    remnant_soul_cost: remnantSoulCost,
                    remnant_soul: newRemnantSoul,
                    daily_count: player.daily_fracture_explore_count,
                    daily_limit: cfg.daily_limit
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[NascentSoulService] 探寻裂缝失败:', err);
            return { success: false, message: `探寻裂缝失败：${err.message}` };
        }
    }

    /**
     * 残魂恢复
     * 玩家可通过闭关、丹药、宗门加成等方式恢复残魂
     * @param {Object} player - 玩家对象
     * @param {number} amount - 恢复量
     * @param {Object} transaction - 事务（可选）
     * @returns {Promise<Object>} 恢复结果
     */
    async recoverRemnantSoul(player, amount, transaction = null) {
        const cfg = getRemnantSoulConfig();
        const before = player.remnant_soul ?? 100;
        const after = Math.min(cfg.max_value, before + amount);
        player.remnant_soul = after;
        if (transaction) {
            await player.save({ transaction });
        } else {
            await player.save();
        }
        return {
            success: true,
            before,
            after,
            recovered: after - before
        };
    }

    /**
     * 触发虚弱状态
     * 在突破失败、出窍超时等场景调用
     * @param {Object} player - 玩家对象
     * @param {number} durationSec - 虚弱持续秒数
     * @param {Object} transaction - 事务
     */
    async triggerWeakness(player, durationSec, transaction) {
        const cfg = getWeaknessConfig();
        const finalDuration = durationSec || cfg.duration_sec;
        const endTime = new Date(Date.now() + finalDuration * 1000);
        player.weakness_end_time = endTime;
        if (transaction) {
            await player.save({ transaction });
        } else {
            await player.save();
        }
        return { success: true, end_time: endTime, duration: finalDuration };
    }

    /**
     * 检查玩家是否处于虚弱状态
     * @param {Object} player - 玩家对象
     * @returns {boolean}
     */
    isWeak(player) {
        return player.weakness_end_time && new Date(player.weakness_end_time) > new Date();
    }

    /**
     * 获取虚弱对修炼效率的惩罚系数
     * @param {Object} player - 玩家对象
     * @returns {number} 1.0=无虚弱，0.5=标准虚弱惩罚
     */
    getWeaknessExpRatePenalty(player) {
        if (!this.isWeak(player)) return 1.0;
        return 1.0 - getWeaknessConfig().exp_gain_rate_penalty;
    }

    /**
     * 获取虚弱对突破成功率的惩罚
     * @param {Object} player - 玩家对象
     * @returns {number} 0=无惩罚，20=标准惩罚
     */
    getWeaknessBreakthroughPenalty(player) {
        if (!this.isWeak(player)) return 0;
        return getWeaknessConfig().breakthrough_prob_penalty;
    }

    /**
     * 获取问道感悟值对突破的加成
     * @param {Object} player - 玩家对象
     * @returns {number} 突破成功率加成（百分比）
     */
    getAskDaoBreakthroughBonus(player) {
        const insight = player.ask_dao_insight || 0;
        // 每10点感悟提供1%突破加成，最高20%
        return Math.min(20, Math.floor(insight / 10));
    }

    /**
     * 突破成功后清零问道感悟值
     * @param {Object} player - 玩家对象
     * @param {Object} transaction - 事务
     */
    async clearAskDaoInsightOnBreakthrough(player, transaction) {
        player.ask_dao_insight = 0;
        if (transaction) {
            await player.save({ transaction });
        } else {
            await player.save();
        }
    }

    /**
     * 获取法相天地属性加成系数
     * @param {Object} player - 玩家对象
     * @returns {number} 加成系数（1.0=无加成，1.05=5%加成）
     */
    getDharmaFormBonus(player) {
        const cfg = getDharmaFormConfig();
        const level = player.dharma_form_level || 0;
        return 1.0 + level * cfg.attribute_bonus_per_level;
    }

    /**
     * 夺舍重生
     * 残魂过低时玩家可尝试夺舍，重置境界但保留部分修为
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 夺舍结果
     */
    async reincarnate(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const cfg = getReincarnationConfig();
            // 残魂检查
            if ((player.remnant_soul ?? 100) < cfg.min_remnant_soul) {
                await t.rollback();
                return {
                    success: false,
                    message: `残魂值过低，无法夺舍，需要至少 ${cfg.min_remnant_soul} 残魂值`
                };
            }

            // 冷却检查
            const cooldown = checkCooldown(player, 'last_reincarnation_time', cfg.cooldown_sec);
            if (!cooldown.ready) {
                await t.rollback();
                return {
                    success: false,
                    message: `夺舍冷却中，剩余 ${cooldown.remainingSec} 秒`
                };
            }

            // 夺舍成功率判定
            const roll = Math.random();
            const success = roll < cfg.success_rate;

            if (!success) {
                // 夺舍失败：残魂大幅下降，触发虚弱
                player.remnant_soul = Math.max(0, (player.remnant_soul ?? 100) - 30);
                player.last_reincarnation_time = new Date();
                await this.triggerWeakness(player, 7200, t); // 2小时虚弱
                await player.save({ transaction: t });
                await t.commit();

                return {
                    success: false,
                    message: '夺舍失败！残魂大幅下降，进入2小时虚弱状态',
                    data: {
                        remnant_soul: player.remnant_soul,
                        weakness_end_time: player.weakness_end_time
                    }
                };
            }

            // 夺舍成功：境界降为元婴初期，保留30%修为，残魂恢复满值
            const oldRealm = player.realm;
            const oldExp = Number(player.exp || 0);
            const newExp = Math.floor(oldExp * 0.3);

            player.realm = '元婴初期';
            player.exp = BigInt(newExp);
            player.remnant_soul = 100;
            player.last_reincarnation_time = new Date();
            // 清空瓶颈
            player.bottleneck_state = 'none';
            player.bottleneck_insight = 0;
            player.breakthrough_failure_count = 0;
            // 清空法相等级（夺舍后需重新凝聚）
            player.dharma_form_level = 0;
            player.ask_dao_insight = 0;
            // 清空出窍状态
            player.soul_state = 'none';
            player.soul_out_start_time = null;
            player.soul_out_end_time = null;

            // 更新属性到元婴初期
            const newRealm = RealmService.getRealmByName('元婴初期');
            if (newRealm) {
                const attrs = typeof player.attributes === 'string'
                    ? JSON.parse(player.attributes)
                    : (player.attributes || {});
                attrs.hp_max = newRealm.base_hp;
                attrs.mp_max = newRealm.base_mp;
                attrs.atk = newRealm.base_atk;
                attrs.def = newRealm.base_def;
                player.attributes = attrs;
                player.hp_current = newRealm.base_hp;
                player.mp_current = newRealm.base_mp;
                player.lifespan_max = newRealm.base_lifespan;
            }

            await player.save({ transaction: t });
            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'reincarnation_success', {
                    old_realm: oldRealm,
                    new_realm: '元婴初期',
                    old_exp: oldExp,
                    new_exp: newExp,
                    remnant_soul: 100
                });
            } catch (e) {
                console.error('[NascentSoulService] 推送夺舍成功失败:', e.message);
            }

            return {
                success: true,
                message: `夺舍成功！从 ${oldRealm} 重生为 元婴初期，保留 30% 修为`,
                data: {
                    old_realm: oldRealm,
                    new_realm: '元婴初期',
                    old_exp: oldExp,
                    new_exp: newExp,
                    remnant_soul: 100
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[NascentSoulService] 夺舍失败:', err);
            return { success: false, message: `夺舍失败：${err.message}` };
        }
    }

    /**
     * 自动清理过期的元婴出窍状态（由 StateCleanerService 调度）
     * @param {Object} ctx - 清理上下文
     * @returns {Promise<Object>} 清理统计
     */
    async cleanExpiredSoulOut(ctx = {}) {
        const stats = { scanned: 0, settled: 0, failed: 0 };
        const batchSize = ctx.batchSize || 100;
        const now = new Date();

        const expiredPlayers = await Player.findAll({
            where: {
                soul_state: 'out',
                soul_out_end_time: { [Op.lt]: now }
            },
            limit: batchSize
        });

        stats.scanned = expiredPlayers.length;
        if (expiredPlayers.length === 0) return stats;

        for (const player of expiredPlayers) {
            const t = await sequelize.transaction();
            try {
                const locked = await Player.findByPk(player.id, {
                    lock: t.LOCK.UPDATE,
                    transaction: t
                });

                if (!locked || locked.soul_state !== 'out') {
                    await t.commit();
                    continue;
                }

                // 自动结算（按完整时长计算收益，因为已经到 end_time）
                const startTime = new Date(locked.soul_out_start_time);
                const actualDuration = Math.max(0, Math.floor((now - startTime) / 1000));
                const completionRate = 1.0; // 到期自动结算视为完整完成
                const expReward = this._calculateSoulOutReward(
                    locked, actualDuration, locked.soul_out_target, completionRate
                );

                const remnantSoulCost = Math.min(5, actualDuration / 3600 * 2);

                locked.soul_state = 'none';
                locked.soul_out_start_time = null;
                locked.soul_out_end_time = null;
                locked.soul_out_duration = 0;
                locked.soul_out_target = 'explore';
                locked.last_soul_out_time = now;
                locked.remnant_soul = Math.max(0, (locked.remnant_soul ?? 100) - remnantSoulCost);
                if (expReward > 0) {
                    locked.exp = BigInt(locked.exp || 0) + BigInt(expReward);
                }

                await locked.save({ transaction: t });
                await t.commit();
                stats.settled += 1;

                // 推送通知
                if (ctx.notify) {
                    try {
                        ctx.notify(locked.id, 'soul_out_auto_settled', {
                            soul_state: 'none',
                            actual_duration: actualDuration,
                            exp_reward: expReward,
                            remnant_soul_cost: remnantSoulCost,
                            remnant_soul: locked.remnant_soul,
                            auto_settled: true
                        });
                    } catch (e) { /* 推送失败不影响清理 */ }
                }
            } catch (err) {
                if (t && !t.finished) await t.rollback();
                stats.failed += 1;
                console.error(`[NascentSoulService] 玩家 ${player.id} 出窍自动结算失败:`, err.message);
            }
        }
        return stats;
    }

    /**
     * 残魂自然恢复定时任务（每小时调用）
     * @returns {Promise<Object>} 恢复统计
     */
    async naturalRecoverRemnantSoul() {
        const stats = { recovered: 0, failed: 0 };
        const cfg = getRemnantSoulConfig();
        try {
            // 查找残魂低于满值的玩家
            const players = await Player.findAll({
                where: {
                    remnant_soul: { [Op.lt]: cfg.max_value }
                },
                limit: 500
            });

            for (const p of players) {
                try {
                    const before = p.remnant_soul ?? 100;
                    const after = Math.min(cfg.max_value, before + cfg.recovery_rate_per_hour);
                    if (after > before) {
                        // 使用 update 避免触发 hooks
                        await Player.update(
                            { remnant_soul: after },
                            { where: { id: p.id } }
                        );
                        stats.recovered += 1;
                    }
                } catch (e) {
                    stats.failed += 1;
                }
            }
        } catch (err) {
            console.error('[NascentSoulService] 残魂自然恢复失败:', err.message);
        }
        return stats;
    }
}

// 导出单例
module.exports = new NascentSoulService();
