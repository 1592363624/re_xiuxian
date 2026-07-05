/**
 * 静思悟道服务
 *
 * 提供悟道玩法的核心业务逻辑：
 * 1. startMeditation：开始悟道（含状态机互斥校验、每日次数校验、冷却校验）
 * 2. interruptMeditation：主动中断悟道（带惩罚）
 * 3. getStatus：获取悟道状态快照
 * 4. _settleMeditation：内部结算方法（供 cleanExpired 和正常结束调用）
 *
 * 瓶颈系统：
 * - checkAndTriggerBottleneck：突破时调用，检查是否进入瓶颈期
 * - handleBreakthroughSuccess：突破成功时清理瓶颈状态
 * - handleBreakthroughFailure：突破失败时累加失败次数、增加感悟补偿
 *
 * 设计原则：
 * - 所有可变参数从 game_balance.json 读取，禁止硬编码
 * - 多表/多字段变更使用事务 + 行级锁
 * - 不直接操作 HTTP 响应，由路由层处理
 */
'use strict';

const Player = require('../../models/player');
const sequelize = require('../../config/database');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const PlayerStateMachine = require('../state/PlayerStateMachine');
const { infrastructure } = require('../../modules');

const configLoader = infrastructure.ConfigLoader;

class MeditationService {
    /**
     * 读取悟道配置
     * @returns {Object} 悟道配置对象
     */
    static getMeditationConfig() {
        const config = configLoader.getConfig('game_balance');
        return config?.meditation || {};
    }

    /**
     * 读取突破瓶颈配置
     * @returns {Object} 突破配置对象
     */
    static getBreakthroughConfig() {
        const config = configLoader.getConfig('game_balance');
        return config?.breakthrough || {};
    }

    /**
     * 跨日重置每日次数（若 last_meditation_date 不是今天）
     * @param {Object} player - 玩家实例
     */
    static _resetDailyCountersIfNewDay(player) {
        const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
        const lastDate = player.last_meditation_date
            ? new Date(player.last_meditation_date).toISOString().slice(0, 10)
            : null;
        if (lastDate !== today) {
            player.daily_meditation_count = 0;
            player.daily_deep_meditation_count = 0;
            player.last_meditation_date = today;
        }
    }

    /**
     * 开始静思悟道
     * @param {number} playerId - 玩家ID
     * @param {string} durationType - 时长类型：short/medium/long/deep
     * @returns {Object} 开始结果
     */
    static async startMeditation(playerId, durationType = 'medium') {
        const cfg = this.getMeditationConfig();
        const btCfg = this.getBreakthroughConfig();

        // 校验时长类型
        const isDeep = durationType === 'deep';
        let durationCfg;
        if (isDeep) {
            if (!cfg.deep?.enabled) {
                throw new AppError('深度悟道未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            durationCfg = cfg.deep;
        } else {
            durationCfg = cfg.duration_types?.[durationType];
            if (!durationCfg) {
                throw new AppError(`无效的悟道时长类型：${durationType}`, 400, ErrorCodes.VALIDATION_ERROR);
            }
        }

        // 状态机互斥校验
        const stateCheck = await PlayerStateMachine.canStart(
            playerId,
            PlayerStateMachine.PlayerState.MEDITATING,
            { source: 'route', stateType: 'meditation' }
        );
        if (!stateCheck.allowed) {
            throw new AppError(stateCheck.reason, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 事务包裹：状态校验 + 字段更新原子性
        const t = await sequelize.transaction();
        try {
            // 行级锁
            const locked = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!locked) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 死亡玩家不可悟道
            if (locked.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法悟道', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 二次校验：加锁后再确认未在悟道中（防止并发）
            if (locked.is_meditating) {
                await t.commit();
                throw new AppError('已在悟道中，无法重复开始', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 跨日重置每日次数
            this._resetDailyCountersIfNewDay(locked);

            // 每日次数校验
            if (isDeep) {
                const limit = cfg.daily_deep_limit || 2;
                if (locked.daily_deep_meditation_count >= limit) {
                    await t.commit();
                    throw new AppError(`今日深度悟道次数已达上限（${limit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                // 深度悟道境界校验
                const minRank = cfg.deep?.min_realm_rank || 11;
                if ((locked.realm_rank || 0) < minRank) {
                    await t.commit();
                    throw new AppError(`深度悟道需境界排名 ${minRank} 及以上`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            } else {
                const limit = cfg.daily_normal_limit || 10;
                if (locked.daily_meditation_count >= limit) {
                    await t.commit();
                    throw new AppError(`今日悟道次数已达上限（${limit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            // 冷却校验
            const cooldown = cfg.cooldown_seconds || 30;
            if (locked.last_meditation_time) {
                const elapsed = (Date.now() - new Date(locked.last_meditation_time).getTime()) / 1000;
                if (elapsed < cooldown) {
                    await t.commit();
                    const remain = Math.ceil(cooldown - elapsed);
                    throw new AppError(`悟道冷却中，请 ${remain} 秒后再试`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            // 深度悟道瓶颈要求：深度悟道需在瓶颈状态下才能进行（提供更高收益）
            if (isDeep && btCfg.bottleneck_enabled && locked.bottleneck_state !== 'active' && locked.bottleneck_state !== 'broken') {
                await t.commit();
                throw new AppError('深度悟道需在瓶颈期方可进行', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 写入悟道状态
            const now = new Date();
            const duration = durationCfg.duration;
            const endTime = new Date(now.getTime() + duration * 1000);

            locked.is_meditating = true;
            locked.meditation_start_time = now;
            locked.meditation_end_time = endTime;
            locked.meditation_duration = duration;
            locked.meditation_mode = isDeep ? 'deep' : 'normal';

            // 累加每日次数
            if (isDeep) {
                locked.daily_deep_meditation_count += 1;
            } else {
                locked.daily_meditation_count += 1;
            }

            await locked.save({ transaction: t });
            await t.commit();

            // 记录状态进入日志（异步）
            try {
                const StateLogService = require('./StateLogService');
                await StateLogService.logStateChange({
                    playerId: locked.id,
                    stateType: 'meditation',
                    action: 'enter',
                    fromState: 'IDLE',
                    toState: 'MEDITATING',
                    source: 'route',
                    details: { mode: locked.meditation_mode, duration, durationType }
                });
            } catch (e) { /* 日志失败不阻塞主流程 */ }

            return {
                success: true,
                message: `${isDeep ? '深度' : ''}悟道已开始`,
                mode: locked.meditation_mode,
                start_time: now.toISOString(),
                end_time: endTime.toISOString(),
                duration,
                duration_type: durationType,
                label: durationCfg.label || (isDeep ? '深度悟道' : '静思悟道'),
                daily_count: isDeep ? locked.daily_deep_meditation_count : locked.daily_meditation_count,
                daily_limit: isDeep ? (cfg.daily_deep_limit || 2) : (cfg.daily_normal_limit || 10)
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 主动中断悟道（带惩罚）
     * @param {number} playerId - 玩家ID
     * @returns {Object} 中断结果
     */
    static async interruptMeditation(playerId) {
        const cfg = this.getMeditationConfig();

        const t = await sequelize.transaction();
        try {
            const locked = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!locked) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (!locked.is_meditating) {
                await t.commit();
                throw new AppError('当前未在悟道中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const isDeep = locked.meditation_mode === 'deep';
            const penaltyRate = isDeep
                ? (cfg.deep_interrupt_penalty_rate || 0.5)
                : (cfg.interrupt_penalty_rate || 0.3);

            // 委托 _settleMeditation 结算（带中断标记）
            const result = await this._settleMeditation(locked, cfg, {
                transaction: t,
                source: 'interrupt',
                penaltyRate
            });

            await t.commit();

            // 记录状态退出日志
            try {
                const StateLogService = require('./StateLogService');
                await StateLogService.logStateChange({
                    playerId: locked.id,
                    stateType: 'meditation',
                    action: 'exit',
                    fromState: 'MEDITATING',
                    toState: 'IDLE',
                    source: 'route',
                    details: {
                        mode: result.mode,
                        interrupted: true,
                        insight_gain: result.insight_gain,
                        exp_gain: result.exp_gain,
                        penalty_rate: penaltyRate
                    }
                });
            } catch (e) { /* 日志失败不阻塞 */ }

            return {
                success: true,
                message: '悟道已中断',
                interrupted: true,
                ...result
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 获取悟道状态快照
     * @param {number} playerId - 玩家ID
     * @returns {Object} 状态快照
     */
    static async getStatus(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const cfg = this.getMeditationConfig();
        const btCfg = this.getBreakthroughConfig();
        const now = Date.now();

        // 跨日重置（仅读取时同步一次）
        const today = new Date().toISOString().slice(0, 10);
        const lastDate = player.last_meditation_date
            ? new Date(player.last_meditation_date).toISOString().slice(0, 10)
            : null;
        const dailyReset = lastDate !== today;

        const result = {
            is_meditating: player.is_meditating,
            // 悟道相关字段（统一使用 meditation_ 前缀，与数据库字段保持一致）
            meditation_mode: player.is_meditating ? player.meditation_mode : null,
            meditation_start_time: player.is_meditating ? player.meditation_start_time : null,
            meditation_end_time: player.is_meditating ? player.meditation_end_time : null,
            meditation_duration: player.is_meditating ? player.meditation_duration : null,
            meditation_insight: player.is_meditating ? (player.meditation_insight || 0) : 0,
            // 每日次数（使用与数据库字段一致的命名，便于前端直接映射）
            daily_meditation_count: dailyReset ? 0 : player.daily_meditation_count,
            daily_deep_meditation_count: dailyReset ? 0 : player.daily_deep_meditation_count,
            daily_normal_limit: cfg.daily_normal_limit || 10,
            daily_deep_limit: cfg.daily_deep_limit || 2,
            // 冷却相关：返回剩余秒数（后端权威计算，避免前端时钟漂移）+ 当前服务器时间戳
            cooldown_seconds: cfg.cooldown_seconds || 30,
            cooldown_remaining: 0,  // 默认值，下方根据 last_meditation_time 计算
            server_time: now,  // 服务器时间戳（毫秒），供前端本地 tick 计算
            last_meditation_time: player.last_meditation_time,
            // 瓶颈状态
            bottleneck: {
                enabled: btCfg.bottleneck_enabled !== false,
                state: player.bottleneck_state || 'none',
                realm_rank: player.bottleneck_realm_rank,
                insight: player.bottleneck_insight || 0,
                threshold: player.bottleneck_threshold || 100,
                started_at: player.bottleneck_started_at,
                failure_count: player.breakthrough_failure_count || 0,
                max_failure_count: btCfg.bottleneck_max_failure_count || 3,
                // 是否处于瓶颈境界的标志
                in_bottleneck_realm: (btCfg.bottleneck_realms || []).includes(player.realm_rank || 0)
            },
            // 配置项供前端展示（与 /meditation/config 接口保持一致的字段名）
            duration_types: cfg.duration_types,
            deep_config: cfg.deep
        };

        // 计算冷却剩余秒数：基于 last_meditation_time + cooldown_seconds
        if (player.last_meditation_time) {
            const lastMs = new Date(player.last_meditation_time).getTime();
            const cooldownMs = (cfg.cooldown_seconds || 30) * 1000;
            const elapsedMs = now - lastMs;
            if (elapsedMs < cooldownMs) {
                result.cooldown_remaining = Math.ceil((cooldownMs - elapsedMs) / 1000);
            }
        }

        if (player.is_meditating) {
            const endTimeMs = player.meditation_end_time ? new Date(player.meditation_end_time).getTime() : 0;
            result.remaining_seconds = Math.max(0, Math.floor((endTimeMs - now) / 1000));
        }

        return result;
    }

    /**
     * 内部结算方法：计算感悟值和修为奖励，并清空悟道状态
     * 注意：调用方必须已对 player 加行级锁，并传入事务
     * @param {Object} locked - 已加锁的玩家实例
     * @param {Object} cfg - 悟道配置
     * @param {Object} options - 选项 { transaction, source, penaltyRate }
     * @returns {Object} 结算结果
     */
    static async _settleMeditation(locked, cfg, options = {}) {
        const t = options.transaction;
        const isDeep = locked.meditation_mode === 'deep';
        const durationCfg = isDeep ? cfg.deep : (cfg.duration_types?.[locked.meditation_mode === 'deep' ? 'deep' : 'medium'] || {});

        // 根据模式查找对应的时长配置
        let actualDurationCfg;
        if (isDeep) {
            actualDurationCfg = cfg.deep || {};
        } else {
            // 通过时长匹配时长类型
            const duration = locked.meditation_duration;
            const types = cfg.duration_types || {};
            actualDurationCfg = Object.values(types).find(t => t.duration === duration) || Object.values(types)[0] || {};
        }

        const startTime = new Date(locked.meditation_start_time);
        const now = new Date();
        const actualDuration = Math.max(0, Math.floor((now - startTime) / 1000));
        const plannedDuration = locked.meditation_duration || actualDurationCfg.duration || 0;

        // 完成度：实际时长 / 计划时长（中断时可能小于1）
        const completionRatio = plannedDuration > 0 ? Math.min(1, actualDuration / plannedDuration) : 1;

        // 计算基础感悟值
        const insightBase = actualDurationCfg.insight_base || 0;
        const insightRandom = actualDurationCfg.insight_random || 0;
        let insightGain = insightBase + Math.floor(Math.random() * (insightRandom + 1));

        // 中断惩罚：按完成度折减感悟值
        if (options.penaltyRate !== undefined) {
            insightGain = Math.floor(insightGain * completionRatio * (1 - options.penaltyRate));
        } else if (completionRatio < 1) {
            // 自动结算时若时长不足也按比例折减
            insightGain = Math.floor(insightGain * completionRatio);
        }

        // 修为奖励
        const expRate = actualDurationCfg.exp_reward_rate || 0.01;
        const currentExp = Number(locked.exp || 0);
        let expGain = Math.floor(currentExp * expRate * completionRatio);
        const maxExp = cfg.max_exp_reward_per_session || 100000;
        if (expGain > maxExp) expGain = maxExp;

        // 瓶颈期加成：若玩家处于瓶颈期，感悟值按瓶颈加成倍率提升
        const btCfg = this.getBreakthroughConfig();
        let bottleneckBroken = false;
        let insightToBottleneck = 0;
        if (btCfg.bottleneck_enabled && locked.bottleneck_state === 'active') {
            const bottleneckRate = isDeep
                ? (cfg.deep_bottleneck_insight_rate || 3.0)
                : (cfg.bottleneck_insight_rate || 1.5);
            insightToBottleneck = Math.floor(insightGain * (bottleneckRate - 1));

            // 累加到瓶颈感悟值
            const oldInsight = locked.bottleneck_insight || 0;
            const newInsight = oldInsight + insightToBottleneck;
            locked.bottleneck_insight = newInsight;

            // 检查是否破除瓶颈
            if (newInsight >= (locked.bottleneck_threshold || 100)) {
                locked.bottleneck_state = 'broken';
                locked.bottleneck_insight = locked.bottleneck_threshold;
                bottleneckBroken = true;
            }
        }

        // 累加到玩家本命感悟值（用于其他系统，如突破加成）
        locked.meditation_insight = (locked.meditation_insight || 0) + insightGain;

        // 增加修为
        if (expGain > 0) {
            locked.exp = BigInt(locked.exp || 0) + BigInt(expGain);
        }

        // 清空悟道状态
        locked.is_meditating = false;
        locked.meditation_mode = 'normal';
        locked.meditation_start_time = null;
        locked.meditation_duration = 0;
        locked.meditation_end_time = null;
        locked.last_meditation_time = now;

        await locked.save({ transaction: t });

        return {
            mode: isDeep ? 'deep' : 'normal',
            actual_duration: actualDuration,
            planned_duration: plannedDuration,
            completion_ratio: completionRatio,
            insight_gain: insightGain,
            insight_to_bottleneck: insightToBottleneck,
            exp_gain: expGain,
            bottleneck_broken: bottleneckBroken,
            bottleneck_insight: locked.bottleneck_insight,
            bottleneck_threshold: locked.bottleneck_threshold
        };
    }

    // ============================================================
    // 突破瓶颈系统方法
    // ============================================================

    /**
     * 检查并触发瓶颈状态
     * 在玩家尝试突破前调用：若当前境界属于瓶颈境界且尚未进入瓶颈期，则触发瓶颈
     * @param {Object} player - 玩家实例
     * @param {Object} nextRealm - 下一境界配置
     * @returns {Object} { triggered: boolean, reason: string }
     */
    static checkAndTriggerBottleneck(player, nextRealm) {
        const btCfg = this.getBreakthroughConfig();
        if (!btCfg.bottleneck_enabled) {
            return { triggered: false, reason: '瓶颈系统未启用' };
        }

        // 当前境界是否属于瓶颈境界
        const bottleneckRealms = btCfg.bottleneck_realms || [];
        if (!bottleneckRealms.includes(player.realm_rank || 0)) {
            return { triggered: false, reason: '当前境界非瓶颈境界' };
        }

        // 已处于瓶颈期
        if (player.bottleneck_state === 'active' || player.bottleneck_state === 'broken') {
            return { triggered: false, reason: '已处于瓶颈期' };
        }

        // 已失败过：保持 failed 状态直到重试
        if (player.bottleneck_state === 'failed') {
            return { triggered: false, reason: '瓶颈已破除待重试或失败待重试' };
        }

        // 触发瓶颈：根据境界计算阈值
        const baseThreshold = btCfg.bottleneck_threshold_base || 100;
        const perRankAdd = btCfg.bottleneck_threshold_per_rank || 50;
        const threshold = baseThreshold + ((player.realm_rank || 0) - 10) * perRankAdd;

        player.bottleneck_state = 'active';
        player.bottleneck_realm_rank = player.realm_rank;
        player.bottleneck_insight = 0;
        player.bottleneck_threshold = threshold;
        player.bottleneck_started_at = new Date();
        player.breakthrough_failure_count = 0;

        return {
            triggered: true,
            reason: `突破遇到瓶颈，需积累感悟 ${threshold} 点方可破除`,
            bottleneck_threshold: threshold
        };
    }

    /**
     * 处理突破成功：清理瓶颈状态
     * @param {Object} player - 玩家实例
     * @param {Object} transaction - 事务（可选）
     */
    static async handleBreakthroughSuccess(player, transaction = null) {
        const options = transaction ? { transaction } : {};
        player.bottleneck_state = 'none';
        player.bottleneck_realm_rank = null;
        player.bottleneck_insight = 0;
        player.bottleneck_threshold = 100;
        player.bottleneck_started_at = null;
        player.breakthrough_failure_count = 0;
        await player.save(options);
    }

    /**
     * 处理突破失败：累加失败次数，提供感悟补偿
     * @param {Object} player - 玩家实例（已加锁）
     * @param {Object} transaction - 事务
     * @returns {Object} 失败处理结果
     */
    static async handleBreakthroughFailure(player, transaction = null) {
        const btCfg = this.getBreakthroughConfig();
        const options = transaction ? { transaction } : {};

        const failureCount = (player.breakthrough_failure_count || 0) + 1;
        const maxFailureCount = btCfg.bottleneck_max_failure_count || 3;

        // 每次失败给予瓶颈感悟补偿
        const insightCompensation = btCfg.bottleneck_failure_insight_gain || 10;
        let bottleneckBroken = false;

        if (player.bottleneck_state === 'active') {
            const oldInsight = player.bottleneck_insight || 0;
            const newInsight = oldInsight + insightCompensation;
            player.bottleneck_insight = newInsight;

            // 失败次数达上限或感悟达阈值，自动破除瓶颈
            if (newInsight >= (player.bottleneck_threshold || 100) || failureCount >= maxFailureCount) {
                player.bottleneck_state = 'broken';
                player.bottleneck_insight = player.bottleneck_threshold;
                bottleneckBroken = true;
            }
        } else if (player.bottleneck_state === 'broken') {
            // 已破除瓶颈但突破失败：转 failed 状态，等待重试
            player.bottleneck_state = 'failed';
        } else if (player.bottleneck_state === 'failed') {
            // failed 状态再次失败：累加失败次数
            if (failureCount >= maxFailureCount * 2) {
                // 超过双倍上限，自动破除瓶颈
                player.bottleneck_state = 'broken';
                bottleneckBroken = true;
            }
        }

        player.breakthrough_failure_count = failureCount;
        await player.save(options);

        return {
            failure_count: failureCount,
            max_failure_count: maxFailureCount,
            insight_compensation: insightCompensation,
            bottleneck_broken: bottleneckBroken,
            bottleneck_state: player.bottleneck_state,
            bottleneck_insight: player.bottleneck_insight
        };
    }
}

module.exports = MeditationService;
