/**
 * 夺舍重生状态注册文件
 *
 * 将夺舍重生相关状态处理逻辑（快照查询/过期清理/互斥校验）注册到 StateRegistry，
 * 让 StateCleanerService 和 PlayerStateService 无需感知夺舍业务细节。
 *
 * 设计要点：
 *   1. 夺舍状态与一切状态互斥（exclusive: true）
 *   2. 超时自动随机选定：夺舍触发后 30 分钟未选定目标的，由 cleanExpired 强制随机选定
 *   3. 玩家非正常退出时由 StateCleanerService 自动结算，避免状态卡死
 *   4. 夺舍期间（is_dead=true）禁止其他玩法
 *
 * 状态判定依据：
 *   - Player.is_dead === true 表示玩家处于夺舍待选定状态
 *   - ReincarnationService 内部缓存 _pendingTargets 存储待选定的 3 个目标
 *   - 30 分钟未选定则 forceRandomReincarnation 强制选一个
 *
 * 接入步骤参考 .trae/skills/project-architecture-design/SKILL.md
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const Player = require('../../../models/player');
const { Op } = require('sequelize');

// 夺舍状态枚举值（与 ReincarnationService 中保持一致）
const REINCARNATION_STATE_ENUM = 'REINCARNATING';

// 夺舍超时时间（30 分钟，单位：秒）
const REINCARNATION_TIMEOUT_SECONDS = 1800;

/**
 * 注册夺舍重生状态处理器
 */
function registerReincarnationState() {
    StateRegistry.register('reincarnation', {
        metadata: {
            displayName: '夺舍重生',
            stateEnum: REINCARNATION_STATE_ENUM,
            exclusive: true  // 夺舍与其他所有状态互斥
        },

        /**
         * 获取玩家夺舍状态快照
         * @param {number} playerId - 玩家ID
         * @returns {Object} 夺舍状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { reincarnation_state: 'none' };
            try {
                const player = await Player.findByPk(playerId, {
                    attributes: ['id', 'is_dead', 'death_reason', 'death_time', 'remnant_soul']
                });
                if (!player || !player.is_dead) {
                    return snapshot;
                }

                // 计算夺舍已进行时长，用于判断是否超时
                const deathTime = player.death_time ? new Date(player.death_time).getTime() : 0;
                const elapsedSec = deathTime > 0 ? Math.floor((Date.now() - deathTime) / 1000) : 0;
                const remainingSec = Math.max(0, REINCARNATION_TIMEOUT_SECONDS - elapsedSec);

                return {
                    reincarnation_state: 'pending',
                    is_dead: true,
                    death_reason: player.death_reason,
                    death_time: player.death_time ? new Date(player.death_time).toISOString() : null,
                    remnant_soul: player.remnant_soul,
                    elapsed_seconds: elapsedSec,
                    remaining_seconds: remainingSec,
                    is_timeout: remainingSec <= 0
                };
            } catch (err) {
                console.warn('[Reincarnation Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举（用于状态机互斥校验）
         * @param {number} playerId - 玩家ID
         * @returns {Promise<string|null>} 激活时返回 'REINCARNATING'，否则返回 null
         */
        async getActiveState(playerId) {
            try {
                const player = await Player.findByPk(playerId, {
                    attributes: ['id', 'is_dead']
                });
                return (player && player.is_dead) ? REINCARNATION_STATE_ENUM : null;
            } catch (err) {
                console.warn('[Reincarnation Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期夺舍状态：超时 30 分钟自动随机选定目标
         * 委托给 ReincarnationService.forceRandomReincarnation 完成
         * @param {Object} ctx - 清理上下文 { batchSize, logger, notify }
         * @returns {Object} 清理统计 { scanned, forced, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, forced: 0, failed: 0 };
            try {
                // 延迟加载避免循环依赖
                const ReincarnationService = require('../../services/ReincarnationService');

                // 查询所有死亡玩家（夺舍待选定状态）
                const timeoutThreshold = new Date(Date.now() - REINCARNATION_TIMEOUT_SECONDS * 1000);
                const deadPlayers = await Player.findAll({
                    where: {
                        is_dead: true,
                        death_time: { [Op.lt]: timeoutThreshold }
                    },
                    attributes: ['id', 'nickname', 'death_time', 'death_reason'],
                    limit: ctx.batchSize || 50
                });
                stats.scanned = deadPlayers.length;

                for (const player of deadPlayers) {
                    try {
                        const result = await ReincarnationService.forceRandomReincarnation(player.id);
                        if (result.success) {
                            stats.forced += 1;
                        } else {
                            stats.failed += 1;
                            console.warn(`[Reincarnation Cleaner] 玩家 ${player.id} 强制夺舍失败: ${result.message}`);
                        }
                    } catch (e) {
                        stats.failed += 1;
                        console.error(`[Reincarnation Cleaner] 玩家 ${player.id} 强制夺舍异常:`, e.message);
                    }
                }

                return stats;
            } catch (err) {
                console.error('[Reincarnation Cleaner] 清理过期夺舍失败:', err.message);
                stats.failed += 1;
                return stats;
            }
        },

        /**
         * 状态转移校验：夺舍中默认不允许任何新状态（exclusive: true 已处理）
         * 夺舍期间玩家肉身已毁，残魂飘荡，无法进行闭关、战斗、移动、历练等操作
         */
        canTransitionTo(newStateEnum, activeStates) {
            return {
                allowed: false,
                reason: '夺舍重生中，肉身已毁，无法开始此操作'
            };
        }
    });
}

module.exports = registerReincarnationState;