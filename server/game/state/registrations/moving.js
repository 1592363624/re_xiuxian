/**
 * 移动状态注册文件
 *
 * 将地图移动相关状态处理逻辑注册到 StateRegistry，
 * 由 StateCleanerService 统一调度清理过期移动（到达目的地）。
 *
 * 架构演进：
 *   v1：移动完成由 index.js 专用定时任务处理（5s 间隔），与其他状态清理逻辑分离
 *   v2（当前）：迁移到 StateCleanerService 统一调度，通过 per-state interval 配置
 *              保持 5s 高频清理，与其他状态架构一致
 *
 * 移动状态存储在 Player 表（is_moving/move_end_time 等字段），无需额外表
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const Player = require('../../../models/player');
const MapConfigLoader = require('../../services/MapConfigLoader');
const { Op } = require('sequelize');

/**
 * 注册移动状态处理器
 */
function registerMovingState() {
    StateRegistry.register('moving', {
        metadata: {
            displayName: '移动',
            stateEnum: PlayerStateMachine.PlayerState.MOVING,
            exclusive: true  // 移动与其他 exclusive 状态互斥
        },

        /**
         * 获取玩家移动状态快照
         * @param {number} playerId
         * @returns {Object} 移动状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { is_moving: false };
            try {
                const player = await Player.findByPk(playerId);
                if (!player || !player.is_moving) return snapshot;

                const now = Date.now();
                const endTimeMs = player.move_end_time ? new Date(player.move_end_time).getTime() : 0;
                return {
                    is_moving: true,
                    from_map_id: player.moving_from_map_id,
                    to_map_id: player.moving_to_map_id,
                    move_start_time: player.move_start_time ? new Date(player.move_start_time).toISOString() : null,
                    move_end_time: player.move_end_time ? new Date(player.move_end_time).toISOString() : null,
                    remaining_seconds: Math.max(0, Math.floor((endTimeMs - now) / 1000))
                };
            } catch (err) {
                console.warn('[Moving Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         * @param {number} playerId
         * @returns {string|null} 激活时返回 'MOVING'，否则返回 null
         */
        async getActiveState(playerId) {
            try {
                const player = await Player.findByPk(playerId, { attributes: ['id', 'is_moving'] });
                return (player && player.is_moving) ? PlayerStateMachine.PlayerState.MOVING : null;
            } catch (err) {
                console.warn('[Moving Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期移动：自动到达目的地
         * 扫描所有 is_moving=true 且 move_end_time <= now 的玩家，
         * 更新 current_map_id 并清空移动字段，推送 move:completed 事件给在线玩家。
         *
         * 设计要点：
         *   1. 移动是高频状态（玩家随时可能到达），通过 per-state interval 配置 5s 间隔
         *   2. 不需要事务+行级锁（与闭关/战斗不同），因为移动完成是单字段更新，无并发冲突
         *   3. 通过 WebSocketNotificationService.emitToPlayer 推送 'move:completed' 事件
         *      前端监听此事件触发 fetchPlayer 刷新 UI
         *
         * @param {Object} ctx - 清理上下文 { batchSize, notify }
         * @returns {Object} 清理统计 { scanned, arrived, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, arrived: 0, failed: 0 };
            const batchSize = ctx.batchSize || 100;
            const now = new Date();

            // 查询所有已到达目的地但状态仍为 moving 的玩家
            const movingPlayers = await Player.findAll({
                where: {
                    is_moving: true,
                    move_end_time: { [Op.lte]: now }
                },
                limit: batchSize
            });

            stats.scanned = movingPlayers.length;
            if (movingPlayers.length === 0) return stats;

            // 延迟加载 WebSocketNotificationService，避免循环依赖
            let wsService = null;
            try {
                wsService = require('../../services/WebSocketNotificationService');
            } catch (e) {
                console.warn('[Moving Cleaner] 加载 WebSocketNotificationService 失败:', e.message);
            }

            for (const player of movingPlayers) {
                try {
                    const targetMapId = player.moving_to_map_id;
                    const targetMap = MapConfigLoader.getMap(targetMapId);

                    // 更新玩家位置和清空移动字段
                    player.current_map_id = targetMapId;
                    player.last_map_move_time = now;
                    player.is_moving = false;
                    player.moving_from_map_id = null;
                    player.moving_to_map_id = null;
                    player.move_start_time = null;
                    player.move_end_time = null;
                    await player.save();

                    stats.arrived += 1;

                    if (ctx.logEach) {
                        console.log(`[Moving Cleaner] 玩家 ${player.id} 移动完成，到达 ${targetMap?.name || targetMapId}`);
                    }

                    // 记录自动清理日志（异步，不阻塞清理流程）
                    try {
                        const StateLogService = require('../../services/StateLogService');
                        StateLogService.logStateChange({
                            playerId: player.id,
                            stateType: 'moving',
                            action: 'auto_clean',
                            fromState: 'MOVING',
                            toState: 'IDLE',
                            source: 'cleaner',
                            details: { map_id: targetMapId, map_name: targetMap?.name || '未知' }
                        }).catch(() => { /* 日志失败不影响清理 */ });
                    } catch (e) { /* StateLogService 加载失败静默 */ }

                    // 通过 Socket 推送 move:completed 事件给在线玩家
                    // 前端监听此事件触发 clearMovingState + fetchPlayer 刷新 UI
                    if (wsService) {
                        try {
                            wsService.emitToPlayer(player.id, 'move:completed', {
                                player_id: player.id,
                                map_id: targetMapId,
                                map_name: targetMap?.name || '未知'
                            });
                        } catch (e) {
                            // 推送失败不影响清理（玩家下次刷新会拿到最新状态）
                        }
                    }
                } catch (err) {
                    stats.failed += 1;
                    console.error(`[Moving Cleaner] 玩家 ${player.id} 移动完成处理失败:`, err.message);
                }
            }

            return stats;
        },

        /**
         * 状态转移校验：移动中默认不允许任何新状态
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '移动中，无法开始此操作' };
        }
    });
}

module.exports = registerMovingState;
