/**
 * 静思悟道状态注册文件
 *
 * 将悟道相关状态处理逻辑（快照查询/过期清理/互斥校验）注册到 StateRegistry，
 * 让 StateCleanerService 和 PlayerStateService 无需感知悟道业务细节。
 *
 * 设计要点：
 * 1. 悟道与闭关、战斗、移动、历练互斥（exclusive: true）
 * 2. 过期自动结算：根据时长类型计算感悟值和修为奖励
 * 3. 若玩家处于瓶颈期，感悟值按 bottleneck_insight_rate 加成
 * 4. 玩家非正常退出时由 StateCleanerService 自动结算，避免状态卡死
 *
 * 新增玩法接入步骤请参考 .trae/skills/project-architecture-design/SKILL.md 第二章
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const Player = require('../../../models/player');
const sequelize = require('../../../config/database');
const { Op } = require('sequelize');
const { infrastructure } = require('../../../modules');

const configLoader = infrastructure.ConfigLoader;

/**
 * 读取悟道配置（与 routes/meditation.js 共用配置源）
 * @returns {Object} 悟道配置对象
 */
function getMeditationConfigs() {
    const config = configLoader.getConfig('game_balance');
    return {
        duration_types: config?.meditation?.duration_types || {
            short: { duration: 60, insight_base: 5, insight_random: 3, exp_reward_rate: 0.01, label: '静思一刻' },
            medium: { duration: 300, insight_base: 20, insight_random: 8, exp_reward_rate: 0.02, label: '凝神悟道' },
            long: { duration: 1800, insight_base: 80, insight_random: 20, exp_reward_rate: 0.03, label: '闭关参悟' }
        },
        deep: config?.meditation?.deep || {
            enabled: true, duration: 3600, insight_base: 200, insight_random: 50,
            exp_reward_rate: 0.05, min_realm_rank: 11, label: '深度悟道'
        },
        daily_normal_limit: config?.meditation?.daily_normal_limit || 10,
        daily_deep_limit: config?.meditation?.daily_deep_limit || 2,
        cooldown_seconds: config?.meditation?.cooldown_seconds || 30,
        bottleneck_insight_rate: config?.meditation?.bottleneck_insight_rate || 1.5,
        deep_bottleneck_insight_rate: config?.meditation?.deep_bottleneck_insight_rate || 3.0,
        interrupt_penalty_rate: config?.meditation?.interrupt_penalty_rate || 0.3,
        deep_interrupt_penalty_rate: config?.meditation?.deep_interrupt_penalty_rate || 0.5,
        max_exp_reward_per_session: config?.meditation?.max_exp_reward_per_session || 100000
    };
}

/**
 * 注册静思悟道状态处理器
 */
function registerMeditationState() {
    StateRegistry.register('meditation', {
        metadata: {
            displayName: '静思悟道',
            stateEnum: PlayerStateMachine.PlayerState.MEDITATING,
            exclusive: true  // 悟道与其他状态互斥（与闭关一样不能同时进行）
        },

        /**
         * 获取玩家悟道状态快照
         * @param {number} playerId - 玩家ID
         * @returns {Object} 悟道状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { is_meditating: false };
            try {
                const player = await Player.findByPk(playerId);
                if (!player || !player.is_meditating) return snapshot;

                const now = Date.now();
                const endTimeMs = player.meditation_end_time ? new Date(player.meditation_end_time).getTime() : 0;
                return {
                    is_meditating: true,
                    mode: player.meditation_mode || 'normal',
                    start_time: player.meditation_start_time ? new Date(player.meditation_start_time).toISOString() : null,
                    end_time: player.meditation_end_time ? new Date(player.meditation_end_time).toISOString() : null,
                    duration: player.meditation_duration || 0,
                    remaining_seconds: Math.max(0, Math.floor((endTimeMs - now) / 1000))
                };
            } catch (err) {
                console.warn('[Meditation Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举（用于状态机互斥校验）
         * @param {number} playerId - 玩家ID
         * @returns {string|null} 激活时返回 'MEDITATING'，否则返回 null
         */
        async getActiveState(playerId) {
            try {
                const player = await Player.findByPk(playerId, { attributes: ['id', 'is_meditating'] });
                return (player && player.is_meditating) ? PlayerStateMachine.PlayerState.MEDITATING : null;
            } catch (err) {
                console.warn('[Meditation Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期悟道：自动结算感悟值和修为奖励并重置状态
         * 涉及多字段变更（玩家 exp/insight/状态），用事务 + 行级锁包裹
         * @param {Object} ctx - 清理上下文 { batchSize, logger, notify }
         * @returns {Object} 清理统计 { scanned, settled, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, settled: 0, failed: 0 };
            const batchSize = ctx.batchSize || 100;
            const now = new Date();

            // 查询悟道已过期但仍在悟道中的玩家
            const expiredPlayers = await Player.findAll({
                where: {
                    is_meditating: true,
                    meditation_end_time: { [Op.lt]: now }
                },
                limit: batchSize
            });

            stats.scanned = expiredPlayers.length;
            if (expiredPlayers.length === 0) return stats;

            const cfg = getMeditationConfigs();

            for (const player of expiredPlayers) {
                // 单个玩家结算用事务包裹，确保状态重置和奖励增加原子性
                const t = await sequelize.transaction();
                try {
                    // 行级锁，防止与玩家主动中断悟道并发冲突
                    const locked = await Player.findByPk(player.id, {
                        lock: t.LOCK.UPDATE,
                        transaction: t
                    });

                    // 二次校验：加锁后再次确认仍在悟道中
                    if (!locked || !locked.is_meditating) {
                        await t.commit();
                        continue;
                    }

                    // 委托给 MeditationService 完成结算逻辑（避免在此处重复实现）
                    const MeditationService = require('../../services/MeditationService');
                    const result = await MeditationService._settleMeditation(locked, cfg, { transaction: t, source: 'auto_clean' });

                    await t.commit();
                    stats.settled += 1;

                    if (ctx.logEach) {
                        console.log(`[Meditation Cleaner] 玩家 ${locked.id} 悟道自动结算，获感悟 ${result.insight_gain}，修为 ${result.exp_gain}`);
                    }

                    // 记录自动清理日志（异步，不阻塞清理流程）
                    try {
                        const StateLogService = require('../../services/StateLogService');
                        StateLogService.logStateChange({
                            playerId: locked.id,
                            stateType: 'meditation',
                            action: 'auto_clean',
                            fromState: 'MEDITATING',
                            toState: 'IDLE',
                            source: 'cleaner',
                            details: {
                                mode: result.mode,
                                insight_gain: result.insight_gain,
                                exp_gain: result.exp_gain,
                                duration: result.actual_duration
                            }
                        }).catch(() => { /* 日志失败不影响清理 */ });
                    } catch (e) { /* StateLogService 加载失败静默 */ }

                    // 通过 Socket 推送状态变更给在线玩家
                    if (ctx.notify) {
                        try {
                            ctx.notify(locked.id, 'meditation_auto_settled', {
                                is_meditating: false,
                                insight_gain: result.insight_gain,
                                exp_gain: result.exp_gain,
                                meditation_insight: locked.meditation_insight,
                                bottleneck_state: locked.bottleneck_state,
                                bottleneck_broken: result.bottleneck_broken,
                                last_meditation_time: locked.last_meditation_time,
                                auto_settled: true
                            });
                        } catch (e) { /* 推送失败不影响清理 */ }

                        // 推送系统通知
                        try {
                            const NotificationService = require('../../services/NotificationService');
                            const notifyMsg = result.bottleneck_broken
                                ? `您的${result.mode === 'deep' ? '深度' : ''}悟道已到期自动结算，获得感悟 ${result.insight_gain} 点，修为 ${result.exp_gain} 点。瓶颈已破除，可尝试突破！`
                                : `您的${result.mode === 'deep' ? '深度' : ''}悟道已到期自动结算，获得感悟 ${result.insight_gain} 点，修为 ${result.exp_gain} 点。`;
                            await new NotificationService().createNotification({
                                type: 'meditation_auto_settled',
                                title: '悟道到期结算',
                                content: notifyMsg,
                                priority: 'normal',
                                targetPlayerId: locked.id,
                                metadata: {
                                    insight_gain: result.insight_gain,
                                    exp_gain: result.exp_gain,
                                    mode: result.mode,
                                    bottleneck_broken: result.bottleneck_broken
                                }
                            });
                        } catch (e) {
                            console.warn('[Meditation Cleaner] 推送系统通知失败:', e.message);
                        }
                    }
                } catch (err) {
                    if (!t.finished) await t.rollback();
                    stats.failed += 1;
                    console.error(`[Meditation Cleaner] 玩家 ${player.id} 悟道结算失败:`, err.message);
                }
            }

            return stats;
        },

        /**
         * 状态转移校验：悟道中默认不允许任何新状态（exclusive: true 已处理）
         * 此处可自定义例外，如允许悟道中被 GM 强制拉入战斗
         */
        canTransitionTo(newStateEnum, activeStates) {
            // 默认走 exclusive 互斥规则，无需自定义
            return { allowed: false, reason: '静思悟道中，无法开始此操作' };
        }
    });
}

module.exports = registerMeditationState;
