/**
 * 神识淬炼服务
 *
 * 实现批次3设计文档第4.4节「神识淬炼系统」的全部业务逻辑：
 *   1. 查询神识面板（余额/上限/恢复速率/淬炼次数/CD）
 *   2. 神识淬炼（100 香火 = 1 神识，每日 3 次，CD 1 小时）
 *   3. GM 发放神识（支持正负数）
 *
 * 神识上限公式：
 *   divine_sense_max = 100 + (realm_rank - 14) * 50 + dayan_level * 100
 *   说明：
 *     - 100 为基础值（base_max 配置）
 *     - realm_rank >= 15（炼气期以上）后每级 +50
 *     - dayan_level 为大衍诀层数（0-5），每层 +100
 *
 * 神识自然恢复：
 *   regen_rate_per_hour = 10（每小时恢复 10 点）
 *   神识不足上限时按时间累计恢复，淬炼/消耗时同步结算
 *
 * 设计原则：
 *   - 所有阈值/比例从 late_stage_data.json 配置读取，禁止硬编码
 *   - 关键操作（淬炼/GM 发放）使用事务 + LOCK.UPDATE 行级锁
 *   - 跨日重置每日次数（按 DATEONLY 比较）
 *   - 冷却时间检查（checkCooldown）
 *   - 关键事件通过 WebSocketNotificationService 推送，事务外推送避免阻塞
 *
 * 数据模型：
 *   - Player: 玩家主表（incense_balance/divine_sense_balance）
 *   - PlayerDivineSense: 神识表（1:1，divine_sense_current/divine_sense_max）
 *   - PlayerIncenseLog: 香火流水表（淬炼消耗记录）
 *   - PlayerAscension: 飞升表（dayan_level 用于上限计算）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerDivineSense = require('../../models/playerDivineSense');
const PlayerIncenseLog = require('../../models/playerIncenseLog');
const PlayerAscension = require('../../models/playerAscension');
const sequelize = require('../../config/database');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');

/**
 * 工具函数：跨日重置每日次数（按 DATEONLY 比较）
 * @param {Object} model - 模型实例
 * @param {string} dateField - 日期字段名
 * @param {string} countField - 次数字段名
 * @param {number} resetValue - 重置后的次数（默认 0）
 */
function resetDailyCountIfCrossDay(model, dateField, countField, resetValue = 0) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastDate = model[dateField];
    if (lastDate) {
        const lastStr = lastDate instanceof Date
            ? lastDate.toISOString().slice(0, 10)
            : String(lastDate).slice(0, 10);
        if (lastStr !== today) {
            model[countField] = resetValue;
            model[dateField] = today;
        }
    } else {
        // 首次设置
        model[countField] = resetValue;
        model[dateField] = today;
    }
}

/**
 * 工具函数：检查冷却时间是否已过
 * @param {Object} model - 模型实例
 * @param {string} timeField - 上次操作时间字段
 * @param {number} cooldownSec - 冷却秒数
 * @returns {{ready: boolean, remainingSec: number}}
 */
function checkCooldown(model, timeField, cooldownSec) {
    const lastTime = model[timeField];
    if (!lastTime) return { ready: true, remainingSec: 0 };
    const lastMs = lastTime instanceof Date ? lastTime.getTime() : new Date(lastTime).getTime();
    const elapsedSec = Math.floor((Date.now() - lastMs) / 1000);
    if (elapsedSec >= cooldownSec) {
        return { ready: true, remainingSec: 0 };
    }
    return { ready: false, remainingSec: cooldownSec - elapsedSec };
}

/**
 * 计算玩家神识上限
 * 公式：base_max + max(0, realm_rank - realm_rank_base) * per_rank_bonus + dayan_level * dayan_per_level_bonus
 * @param {Object} player - 玩家对象（含 realm_rank 字段）
 * @param {Object} ascension - 玩家飞升记录（含 dayan_level，可为 null）
 * @param {Object} senseCfg - divine_sense 配置节
 * @returns {number} 神识上限
 */
function calcDivineSenseMax(player, ascension, senseCfg) {
    const realmRank = Number(player.realm_rank || 0);
    const dayanLevel = ascension ? Number(ascension.dayan_level || 0) : 0;
    const base = Number(senseCfg.base_max || 100);
    const rankBase = Number(senseCfg.max_formula_realm_rank_base || 14);
    const perRankBonus = Number(senseCfg.max_formula_per_rank_bonus || 50);
    const dayanBonus = Number(senseCfg.max_formula_dayan_per_level_bonus || 100);

    // realm_rank 小于等于 rankBase 时无境界加成（防止低境界异常上限）
    const rankBonus = Math.max(0, realmRank - rankBase) * perRankBonus;
    return base + rankBonus + dayanLevel * dayanBonus;
}

/**
 * 结算神识自然恢复（按时间累计）
 * 更新 divine_sense_current 与 last_regen_time，但不保存（保存由调用方在事务中处理）
 * @param {Object} sense - PlayerDivineSense 实例
 * @param {Object} senseCfg - divine_sense 配置节
 */
function applyRegen(sense, senseCfg) {
    const now = Date.now();
    const lastRegen = sense.last_regen_time
        ? (sense.last_regen_time instanceof Date ? sense.last_regen_time.getTime() : new Date(sense.last_regen_time).getTime())
        : now;
    const elapsedSec = Math.max(0, Math.floor((now - lastRegen) / 1000));
    const regenRate = Number(sense.regen_rate_per_hour || senseCfg.regen_rate_per_hour || 10);
    // 按小时比例计算恢复量
    const regenAmount = Math.floor(regenRate * (elapsedSec / 3600));
    if (regenAmount > 0) {
        const max = Number(sense.divine_sense_max || 0);
        const current = Number(sense.divine_sense_current || 0);
        sense.divine_sense_current = Math.min(max, current + regenAmount);
    }
    sense.last_regen_time = new Date();
}

class DivineSenseService {
    /**
     * 获取玩家神识面板数据
     * 包含神识余额/上限/恢复速率/淬炼次数/CD/用途消耗表
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getProfile(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('late_stage_data');
        const senseCfg = config.divine_sense;

        // 获取或创建神识记录（懒创建：首次访问时初始化）
        let sense = await PlayerDivineSense.findOne({ where: { player_id: playerId } });
        const ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
        const expectedMax = calcDivineSenseMax(player, ascension, senseCfg);

        if (!sense) {
            // 首次访问，初始化神识记录
            sense = await PlayerDivineSense.create({
                player_id: playerId,
                divine_sense_max: expectedMax,
                divine_sense_current: expectedMax, // 初次创建满血
                regen_rate_per_hour: senseCfg.regen_rate_per_hour || 10,
                last_regen_time: new Date(),
                daily_quench_count: 0,
                last_quench_date: null,
                last_quench_time: null,
                total_quenched: 0,
                total_consumed: 0
            });
        } else {
            // 同步结算自然恢复
            applyRegen(sense, senseCfg);
            // 上限发生变化的场景（升级/大衍诀层数变化），同步更新上限（仅当计算值更高时）
            if (expectedMax > Number(sense.divine_sense_max)) {
                const diff = expectedMax - Number(sense.divine_sense_max);
                sense.divine_sense_max = expectedMax;
                // 上限提升时同步增加当前值（避免上限涨了当前值不变）
                sense.divine_sense_current = Number(sense.divine_sense_current) + diff;
            }
            await sense.save();
        }

        // 淬炼 CD 计算
        const cdInfo = checkCooldown(sense, 'last_quench_time', senseCfg.quench_cooldown_seconds);
        const dailyCount = Number(sense.daily_quench_count || 0);
        const dailyLimit = Number(senseCfg.quench_daily_limit || 3);

        return {
            success: true,
            data: {
                divine_sense: {
                    current: Number(sense.divine_sense_current),
                    max: Number(sense.divine_sense_max),
                    regen_rate_per_hour: Number(sense.regen_rate_per_hour),
                    last_regen_time: sense.last_regen_time,
                    total_quenched: Number(sense.total_quenched),
                    total_consumed: Number(sense.total_consumed)
                },
                quench_info: {
                    daily_count: dailyCount,
                    daily_limit: dailyLimit,
                    daily_remaining: Math.max(0, dailyLimit - dailyCount),
                    cooldown_ready: cdInfo.ready,
                    cooldown_remaining_sec: cdInfo.remainingSec,
                    cost_incense_per_sense: Number(senseCfg.quench_ratio_incense_to_sense),
                    max_amount_per_time: Number(senseCfg.quench_max_amount_per_time)
                },
                usage_table: senseCfg.usage_table || [],
                player_incense_balance: Number(player.incense_balance || 0)
            }
        };
    }

    /**
     * 神识淬炼
     * 100 香火 = 1 神识，每日 3 次，CD 1 小时
     * 单次最多可淬炼 100 神识（即消耗 10000 香火）
     * @param {number} playerId - 玩家ID
     * @param {number} amount - 期望淬炼的神识数量（1-100）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async quench(playerId, amount) {
        // 参数校验
        if (!Number.isInteger(amount) || amount <= 0) {
            return { success: false, message: 'amount 必须为正整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = configLoader.getConfig('late_stage_data');
        const senseCfg = config.divine_sense;

        if (amount > senseCfg.quench_max_amount_per_time) {
            return {
                success: false,
                message: `单次最多淬炼 ${senseCfg.quench_max_amount_per_time} 神识`,
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 获取或创建神识记录
            let sense = await PlayerDivineSense.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            const ascension = await PlayerAscension.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            const expectedMax = calcDivineSenseMax(player, ascension, senseCfg);
            if (!sense) {
                sense = await PlayerDivineSense.create({
                    player_id: playerId,
                    divine_sense_max: expectedMax,
                    divine_sense_current: expectedMax,
                    regen_rate_per_hour: senseCfg.regen_rate_per_hour || 10,
                    last_regen_time: new Date(),
                    daily_quench_count: 0,
                    last_quench_date: null,
                    last_quench_time: null,
                    total_quenched: 0,
                    total_consumed: 0
                }, { transaction: t });
            } else {
                // 同步自然恢复与上限更新
                applyRegen(sense, senseCfg);
                if (expectedMax > Number(sense.divine_sense_max)) {
                    const diff = expectedMax - Number(sense.divine_sense_max);
                    sense.divine_sense_max = expectedMax;
                    sense.divine_sense_current = Number(sense.divine_sense_current) + diff;
                }
            }

            // 跨日重置每日次数
            resetDailyCountIfCrossDay(sense, 'last_quench_date', 'daily_quench_count', 0);

            // 每日次数校验
            if (Number(sense.daily_quench_count) >= senseCfg.quench_daily_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日淬炼次数已达上限（${senseCfg.quench_daily_limit} 次/日）`
                };
            }

            // 冷却校验
            const cdInfo = checkCooldown(sense, 'last_quench_time', senseCfg.quench_cooldown_seconds);
            if (!cdInfo.ready) {
                await t.rollback();
                return {
                    success: false,
                    message: `淬炼冷却中，剩余 ${Math.ceil(cdInfo.remainingSec / 60)} 分钟`
                };
            }

            // 神识上限校验（淬炼后不能超过上限）
            const currentSense = Number(sense.divine_sense_current);
            const maxSense = Number(sense.divine_sense_max);
            if (currentSense + amount > maxSense) {
                await t.rollback();
                return {
                    success: false,
                    message: `淬炼后神识将超过上限（${currentSense}+${amount}>${maxSense}），请先消耗部分神识`
                };
            }

            // 香火消耗校验
            const incenseCost = amount * senseCfg.quench_ratio_incense_to_sense;
            const currentIncense = Number(player.incense_balance || 0);
            if (currentIncense < incenseCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `香火不足，需要 ${incenseCost}，当前 ${currentIncense}`
                };
            }

            // 执行淬炼：扣香火、加神识、更新统计
            const oldIncense = currentIncense;
            const newIncense = currentIncense - incenseCost;
            player.incense_balance = newIncense;

            const oldSense = currentSense;
            const newSense = currentSense + amount;
            sense.divine_sense_current = newSense;
            sense.daily_quench_count = Number(sense.daily_quench_count) + 1;
            sense.last_quench_time = new Date();
            sense.last_quench_date = new Date().toISOString().slice(0, 10);
            sense.total_quenched = Number(sense.total_quenched) + amount;

            // 同步玩家表的冗余 divine_sense_balance 字段（加速查询）
            player.divine_sense_balance = newSense;

            // 写入香火流水
            await PlayerIncenseLog.create({
                player_id: playerId,
                change_type: 'quench',
                change_amount: -incenseCost,
                balance_after: newIncense,
                reason: `神识淬炼：消耗 ${incenseCost} 香火，获得 ${amount} 神识`
            }, { transaction: t });

            await player.save({ transaction: t });
            await sense.save({ transaction: t });
            await t.commit();

            // 事务外推送通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'divine_sense_quenched', {
                    quench_amount: amount,
                    incense_cost: incenseCost,
                    old_sense: oldSense,
                    new_sense: newSense,
                    sense_max: maxSense,
                    daily_count: Number(sense.daily_quench_count),
                    daily_limit: senseCfg.quench_daily_limit
                });
            } catch (e) {
                console.warn('[DivineSenseService] 推送淬炼通知失败:', e.message);
            }

            return {
                success: true,
                message: `神识淬炼成功！消耗 ${incenseCost} 香火，获得 ${amount} 神识（${oldSense}→${newSense}）`,
                data: {
                    quench_amount: amount,
                    incense_cost: incenseCost,
                    old_sense: oldSense,
                    new_sense: newSense,
                    sense_max: maxSense,
                    daily_count: Number(sense.daily_quench_count),
                    daily_limit: senseCfg.quench_daily_limit,
                    new_incense_balance: newIncense
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineSenseService] quench 异常:', err);
            throw err;
        }
    }

    /**
     * GM 发放神识
     * 直接调整玩家神识（不走淬炼 CD/次数校验），支持正负数
     * @param {number} playerId - 玩家ID
     * @param {number} amount - 数量（正数增加，负数扣减）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmGrant(playerId, amount) {
        if (!Number.isInteger(amount) || amount === 0) {
            return { success: false, message: 'amount 必须为非零整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        // GM 发放范围限制（防止误操作）
        if (amount < -10000 || amount > 10000) {
            return { success: false, message: 'amount 范围必须在 -10000 到 10000 之间', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = configLoader.getConfig('late_stage_data');
        const senseCfg = config.divine_sense;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 获取或创建神识记录
            let sense = await PlayerDivineSense.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            const ascension = await PlayerAscension.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            const expectedMax = calcDivineSenseMax(player, ascension, senseCfg);
            if (!sense) {
                sense = await PlayerDivineSense.create({
                    player_id: playerId,
                    divine_sense_max: expectedMax,
                    divine_sense_current: expectedMax,
                    regen_rate_per_hour: senseCfg.regen_rate_per_hour || 10,
                    last_regen_time: new Date(),
                    daily_quench_count: 0,
                    last_quench_date: null,
                    last_quench_time: null,
                    total_quenched: 0,
                    total_consumed: 0
                }, { transaction: t });
            } else {
                applyRegen(sense, senseCfg);
                if (expectedMax > Number(sense.divine_sense_max)) {
                    const diff = expectedMax - Number(sense.divine_sense_max);
                    sense.divine_sense_max = expectedMax;
                    sense.divine_sense_current = Number(sense.divine_sense_current) + diff;
                }
            }

            const oldSense = Number(sense.divine_sense_current);
            const maxSense = Number(sense.divine_sense_max);
            // 计算实际变化（扣减时不低于 0，增加时允许超过上限由 GM 显式控制）
            let newSense;
            let actualChange;
            if (amount > 0) {
                // GM 发放神识可超过上限（作为特权），但记录时仅累计 earned
                newSense = oldSense + amount;
                actualChange = amount;
                sense.total_quenched = Number(sense.total_quenched) + amount;
            } else {
                // 扣减不能低于 0
                newSense = Math.max(0, oldSense + amount);
                actualChange = newSense - oldSense;
                if (actualChange === 0) {
                    await t.rollback();
                    return { success: false, message: '玩家神识已为 0，无法扣减' };
                }
                sense.total_consumed = Number(sense.total_consumed) + Math.abs(actualChange);
            }

            sense.divine_sense_current = newSense;
            // 同步玩家冗余字段
            player.divine_sense_balance = newSense;

            await player.save({ transaction: t });
            await sense.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `神识 ${actualChange > 0 ? '发放' : '扣减'} ${Math.abs(actualChange)}（${oldSense} → ${newSense}）`,
                data: {
                    old_sense: oldSense,
                    new_sense: newSense,
                    sense_max: maxSense,
                    change: actualChange
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineSenseService] gmGrant 异常:', err);
            throw err;
        }
    }
}

module.exports = DivineSenseService;
