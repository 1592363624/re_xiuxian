/**
 * 飞升状态注册文件
 *
 * 将飞升尝试相关状态处理逻辑（快照查询/过期清理/互斥校验）注册到 StateRegistry，
 * 让 StateCleanerService 和 PlayerStateService 无需感知飞升业务细节。
 *
 * 设计要点：
 *   1. 飞升尝试（ascension_state='ascending'）与一切状态互斥（exclusive: true）
 *   2. 超时自动失败：飞升尝试超过 10 分钟未结算的，由 cleanExpired 强制标记为失败
 *   3. 玩家非正常退出时由 StateCleanerService 自动结算，避免状态卡死
 *   4. 飞升期间禁止其他玩法，但允许查看飞升面板等只读操作（由业务层校验）
 *
 * 状态判定依据：
 *   - PlayerAscension.ascension_state === 'ascending' 表示玩家正在飞升尝试中
 *   - 飞升是瞬时操作（在 ascend 方法内完成结算），ascending 状态仅短暂存在
 *   - 异常情况下（进程崩溃等）可能卡在 ascending，由 cleanExpired 兜底
 *
 * 接入步骤参考 .trae/skills/project-architecture-design/SKILL.md
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const Player = require('../../../models/player');
const PlayerAscension = require('../../../models/playerAscension');
const PlayerAscensionNode = require('../../../models/playerAscensionNode');
const { Op } = require('sequelize');

// 飞升状态枚举值（与 AscensionService 中保持一致）
const ASCENSION_STATE_ENUM = 'ASCENDING';

// 飞升超时时间（10 分钟，单位：秒）
const ASCENSION_TIMEOUT_SECONDS = 600;

/**
 * 注册飞升状态处理器
 */
function registerAscensionState() {
    StateRegistry.register('ascension', {
        metadata: {
            displayName: '飞升尝试',
            stateEnum: ASCENSION_STATE_ENUM,
            exclusive: true  // 飞升与其他所有状态互斥
        },

        /**
         * 获取玩家飞升状态快照
         * @param {number} playerId - 玩家ID
         * @returns {Object} 飞升状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { ascension_state: 'none' };
            try {
                const ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
                if (!ascension || ascension.ascension_state !== 'ascending') {
                    return snapshot;
                }

                // 计算飞升已进行时长，用于判断是否超时
                const startTime = ascension.last_ascension_time
                    ? new Date(ascension.last_ascension_time).getTime()
                    : 0;
                const elapsedSec = startTime > 0 ? Math.floor((Date.now() - startTime) / 1000) : 0;
                const remainingSec = Math.max(0, ASCENSION_TIMEOUT_SECONDS - elapsedSec);

                return {
                    ascension_state: 'ascending',
                    dayan_level: ascension.dayan_level,
                    law_fragments_count: ascension.law_fragments_count,
                    reverse_channel_coord: ascension.reverse_channel_coord,
                    started_at: ascension.last_ascension_time
                        ? new Date(ascension.last_ascension_time).toISOString()
                        : null,
                    elapsed_seconds: elapsedSec,
                    remaining_seconds: remainingSec,
                    is_timeout: remainingSec <= 0
                };
            } catch (err) {
                console.warn('[Ascension Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举（用于状态机互斥校验）
         * @param {number} playerId - 玩家ID
         * @returns {Promise<string|null>} 激活时返回 'ASCENDING'，否则返回 null
         */
        async getActiveState(playerId) {
            try {
                const ascension = await PlayerAscension.findOne({
                    where: { player_id: playerId },
                    attributes: ['id', 'ascension_state']
                });
                return (ascension && ascension.ascension_state === 'ascending')
                    ? ASCENSION_STATE_ENUM
                    : null;
            } catch (err) {
                console.warn('[Ascension Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期飞升状态：超时 10 分钟自动失败 + 清理过期节点
         * 委托给 AscensionService 完成具体业务
         * @param {Object} ctx - 清理上下文 { batchSize, logger, notify }
         * @returns {Object} 清理统计 { scanned, timeout_failed, nodes_expired, nodes_completed, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, timeout_failed: 0, nodes_expired: 0, nodes_completed: 0, failed: 0 };
            try {
                // 延迟加载避免循环依赖
                const AscensionService = require('../../services/AscensionService');

                // 1. 清理超时的飞升尝试（ascension_state='ascending' 且超过 10 分钟）
                const timeoutThreshold = new Date(Date.now() - ASCENSION_TIMEOUT_SECONDS * 1000);
                const timeoutAscensions = await PlayerAscension.findAll({
                    where: {
                        ascension_state: 'ascending',
                        last_ascension_time: { [Op.lt]: timeoutThreshold }
                    },
                    limit: ctx.batchSize || 50
                });
                stats.scanned += timeoutAscensions.length;

                for (const ascension of timeoutAscensions) {
                    try {
                        // 超时强制标记为失败状态（避免玩家卡在 ascending）
                        // 注意：不调用 ascend 重新判定，直接标记失败并恢复可重试状态
                        ascension.ascension_state = 'failed';
                        await ascension.save();
                        stats.timeout_failed += 1;

                        // 推送超时通知
                        try {
                            const WebSocketNotificationService = require('../../services/WebSocketNotificationService');
                            WebSocketNotificationService.notifyPlayerUpdate(ascension.player_id, 'ascension_timeout', {
                                message: '飞升尝试超时（10 分钟未结算），已自动标记为失败',
                                ascension_state: 'failed'
                            });
                        } catch (e) {
                            console.warn('[Ascension Cleaner] 推送超时通知失败:', e.message);
                        }
                    } catch (e) {
                        stats.failed += 1;
                        console.error(`[Ascension Cleaner] 玩家 ${ascension.player_id} 飞升超时处理失败:`, e.message);
                    }
                }

                // 2. 委托 AscensionService 清理过期节点（discovered 过期 + stabilizing 完成结算）
                const nodeStats = await AscensionService.cleanExpiredNodes(ctx);
                stats.nodes_expired = nodeStats.expired || 0;
                stats.nodes_completed = nodeStats.completed || 0;
                stats.failed += nodeStats.failed || 0;
                stats.scanned += nodeStats.scanned || 0;

                return stats;
            } catch (err) {
                console.error('[Ascension Cleaner] 清理过期飞升失败:', err.message);
                stats.failed += 1;
                return stats;
            }
        },

        /**
         * 状态转移校验：飞升尝试中默认不允许任何新状态（exclusive: true 已处理）
         * 飞升期间玩家元神贯通天地，无法进行闭关、战斗、移动、历练等操作
         */
        canTransitionTo(newStateEnum, activeStates) {
            return {
                allowed: false,
                reason: '飞升尝试中，元神贯通天地，无法开始此操作'
            };
        }
    });
}

module.exports = registerAscensionState;