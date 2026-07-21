/**
 * 闭关状态注册文件
 *
 * 将闭关相关状态处理逻辑（快照查询/过期清理/互斥校验）注册到 StateRegistry，
 * 让 StateCleanerService 和 PlayerStateService 无需感知闭关业务细节。
 *
 * 新增玩法时参考此文件结构即可接入状态自愈体系。
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const Player = require('../../../models/player');
const sequelize = require('../../../config/database');
const { Op } = require('sequelize');
const { infrastructure } = require('../../../modules');
// 修复：统一使用 RealmService 读取配置文件，避免数据库 Realm 表与配置不一致
// （init_realms.js 与 realm_breakthrough.json 数据严重不一致，导致倍率计算错误）
const RealmService = require('../../../game/core/RealmService');

const configLoader = infrastructure.ConfigLoader;

/**
 * 读取闭关配置（与 routes/seclusion.js 共用配置源）
 */
function getSeclusionConfigs() {
    const config = configLoader.getConfig('seclusion');
    return {
        normal: config?.settings?.normal_seclusion?.value || { max_duration: 1800, daily_limit: 3, cooldown: 300, exp_rate: 1 },
        deep: config?.settings?.deep_seclusion?.value || {
            min_duration: 14400, max_duration: 28800, daily_limit: 1,
            cooldown: 3600, exp_rate: 2, min_realm: '筑基期', forced_penalty: 0.5
        },
        base_exp_rate: parseFloat(config?.settings?.seclusion_exp_rate?.value) || 1
    };
}

/**
 * 获取境界加成倍率（与 routes/seclusion.js 逻辑保持一致）
 *
 * 修复（2026-07-20）：
 *   原代码直接查询数据库 Realm 表（init_realms.js），其境界 rank 与
 *   realm_breakthrough.json 配置文件不一致（化神初期 db.rank=27 vs config.rank=23）。
 *   现统一通过 RealmService 读取配置文件，保证数据源唯一。
 */
function getRealmMultiplier(realmName) {
    try {
        const realm = RealmService.getRealmByName(realmName);
        if (realm && realm.rank) {
            return 1.0 + (realm.rank - 1) * 0.1;
        }
    } catch (err) {
        console.error('[Seclusion Registration] 获取境界加成失败:', err.message);
    }
    return 1.0;
}

/**
 * 注册闭关状态处理器
 */
function registerSeclusionState() {
    StateRegistry.register('seclusion', {
        metadata: {
            displayName: '闭关',
            stateEnum: PlayerStateMachine.PlayerState.SECLUDED,
            exclusive: true  // 闭关与其他状态互斥
        },

        /**
         * 获取玩家闭关状态快照
         * @param {number} playerId
         * @returns {Object} 闭关状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { is_secluded: false };
            try {
                const player = await Player.findByPk(playerId);
                if (!player || !player.is_secluded) return snapshot;

                const now = Date.now();
                const endTimeMs = player.seclusion_end_time ? new Date(player.seclusion_end_time).getTime() : 0;
                return {
                    is_secluded: true,
                    mode: player.seclusion_mode || 'normal',
                    start_time: player.seclusion_start_time ? new Date(player.seclusion_start_time).toISOString() : null,
                    end_time: player.seclusion_end_time ? new Date(player.seclusion_end_time).toISOString() : null,
                    duration: player.seclusion_duration || 0,
                    remaining_seconds: Math.max(0, Math.floor((endTimeMs - now) / 1000))
                };
            } catch (err) {
                console.warn('[Seclusion Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举（用于状态机互斥校验）
         * @param {number} playerId
         * @returns {string|null} 激活时返回 'SECLUDED'，否则返回 null
         */
        async getActiveState(playerId) {
            try {
                const player = await Player.findByPk(playerId, { attributes: ['id', 'is_secluded'] });
                return (player && player.is_secluded) ? PlayerStateMachine.PlayerState.SECLUDED : null;
            } catch (err) {
                console.warn('[Seclusion Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期闭关：自动结算修为并重置状态
         * 涉及多表变更（玩家 exp/状态），用事务 + 行级锁包裹
         * @param {Object} ctx - 清理上下文 { batchSize, logger, notify }
         * @returns {Object} 清理统计 { scanned, settled, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, settled: 0, failed: 0 };
            const batchSize = ctx.batchSize || 100;
            const now = new Date();

            // 查询过期且仍在闭关中的玩家
            const expiredPlayers = await Player.findAll({
                where: {
                    is_secluded: true,
                    seclusion_end_time: { [Op.lt]: now }
                },
                limit: batchSize
            });

            stats.scanned = expiredPlayers.length;
            if (expiredPlayers.length === 0) return stats;

            const seclusionConfigs = getSeclusionConfigs();

            for (const player of expiredPlayers) {
                // 单个玩家结算用事务包裹，确保状态重置和修为增加原子性
                const t = await sequelize.transaction();
                try {
                    // 行级锁，防止与玩家主动结束闭关并发冲突
                    const locked = await Player.findByPk(player.id, {
                        lock: t.LOCK.UPDATE,
                        transaction: t
                    });

                    // 二次校验：加锁后再次确认仍在闭关中
                    if (!locked || !locked.is_secluded) {
                        await t.commit();
                        continue;
                    }

                    const startTime = new Date(locked.seclusion_start_time);
                    const actualDuration = Math.max(0, Math.floor((now - startTime) / 1000));
                    const isDeep = locked.seclusion_mode === 'deep';
                    const config = isDeep ? seclusionConfigs.deep : seclusionConfigs.normal;
                    // 修复：getRealmMultiplier 已改为同步函数（直接读配置，不再查数据库）
                    const realmMultiplier = getRealmMultiplier(locked.realm);

                    // 深度闭关已过 end_time 视为正常出关（不触发强行出关惩罚）
                    const expGain = Math.floor(
                        actualDuration * seclusionConfigs.base_exp_rate * realmMultiplier * config.exp_rate
                    );

                    // 更新玩家状态：增加修为 + 清空闭关字段
                    locked.exp = BigInt(locked.exp || 0) + BigInt(expGain);
                    locked.is_secluded = false;
                    locked.seclusion_mode = 'normal';
                    locked.seclusion_start_time = null;
                    locked.seclusion_duration = 0;
                    locked.seclusion_end_time = null;
                    locked.last_seclusion_time = now;
                    await locked.save({ transaction: t });

                    await t.commit();
                    stats.settled += 1;

                    if (ctx.logEach) {
                        console.log(`[Seclusion Cleaner] 玩家 ${locked.id} 闭关自动结算，获修为 ${expGain}`);
                    }

                    // 记录自动清理日志（异步，不阻塞清理流程）
                    try {
                        const StateLogService = require('../../services/StateLogService');
                        StateLogService.logStateChange({
                            playerId: locked.id,
                            stateType: 'seclusion',
                            action: 'auto_clean',
                            fromState: 'SECLUDED',
                            toState: 'IDLE',
                            source: 'cleaner',
                            details: { mode: isDeep ? 'deep' : 'normal', exp_gain: expGain, duration: actualDuration }
                        }).catch(() => { /* 日志失败不影响清理 */ });
                    } catch (e) { /* StateLogService 加载失败静默 */ }

                    // 通过 Socket 推送状态变更给在线玩家
                    if (ctx.notify) {
                        try {
                            ctx.notify(locked.id, 'seclusion_auto_settled', {
                                is_secluded: false,
                                exp_gain: expGain,
                                exp: locked.exp.toString(),
                                last_seclusion_time: locked.last_seclusion_time,
                                auto_settled: true
                            });
                        } catch (e) { /* 推送失败不影响清理 */ }

                        // 推送系统通知，让玩家在前端看到"闭关到期自动结算"的提示
                        try {
                            const NotificationService = require('../../services/NotificationService');
                            await new NotificationService().createNotification({
                                type: 'seclusion_auto_settled',
                                title: '闭关到期结算',
                                content: `您的${isDeep ? '深度' : '常规'}闭关已到期自动结算，本次获得修为 ${expGain} 点。`,
                                priority: 'normal',
                                targetPlayerId: locked.id,
                                metadata: { exp_gain: expGain, mode: isDeep ? 'deep' : 'normal' }
                            });
                        } catch (e) {
                            console.warn('[Seclusion Cleaner] 推送系统通知失败:', e.message);
                        }
                    }
                } catch (err) {
                    if (!t.finished) await t.rollback();
                    stats.failed += 1;
                    console.error(`[Seclusion Cleaner] 玩家 ${player.id} 闭关结算失败:`, err.message);
                }
            }

            return stats;
        },

        /**
         * 状态转移校验：闭关中默认不允许任何新状态（exclusive: true 已处理）
         * 此处可自定义例外，如允许闭关中被强制拉入战斗（GM 操作）
         */
        canTransitionTo(newStateEnum, activeStates) {
            // 默认走 exclusive 互斥规则，无需自定义
            return { allowed: false, reason: '闭关中，无法开始此操作' };
        }
    });
}

module.exports = registerSeclusionState;
