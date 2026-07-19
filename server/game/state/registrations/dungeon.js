/**
 * 副本系统状态注册文件
 *
 * 将副本进行中状态（IN_DUNGEON）相关处理逻辑注册到 StateRegistry，
 * 让 StateCleanerService 和 PlayerStateService 无需感知副本业务细节。
 *
 * 设计要点：
 * 1. 副本与闭关、战斗、移动、历练、悟道、PVP、元婴出窍互斥（exclusive: true）
 * 2. 过期自动结算：调用 DungeonService.cleanExpiredDungeon 完成超时结算
 *    - 失败结算（不发放奖励）
 *    - 清理 player_dungeon_progress 记录
 *    - 重置玩家 in_dungeon 状态字段
 * 3. 玩家非正常退出时由 StateCleanerService 自动结算，避免状态卡死
 * 4. 副本期间禁止其他玩法，仅允许查询当前节点内容等只读操作
 *
 * 接入步骤参考 nascent_soul.js 与 game/state/index.js
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const Player = require('../../../models/player');

/**
 * 注册副本系统状态处理器
 */
function registerDungeonState() {
    StateRegistry.register('dungeon', {
        metadata: {
            displayName: '副本挑战',
            stateEnum: PlayerStateMachine.PlayerState.IN_DUNGEON,
            exclusive: true  // 副本与其他所有状态互斥
        },

        /**
         * 获取玩家副本状态快照
         * @param {number} playerId - 玩家ID
         * @returns {Object} 副本状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { in_dungeon: false };
            try {
                const player = await Player.findByPk(playerId, {
                    attributes: ['id', 'in_dungeon', 'dungeon_chapter_id', 'dungeon_node_id', 'dungeon_difficulty', 'dungeon_start_time']
                });
                if (!player || !player.in_dungeon) return snapshot;

                return {
                    in_dungeon: true,
                    chapter_id: player.dungeon_chapter_id,
                    node_id: player.dungeon_node_id,
                    difficulty: player.dungeon_difficulty,
                    start_time: player.dungeon_start_time ? new Date(player.dungeon_start_time).toISOString() : null
                };
            } catch (err) {
                console.warn('[Dungeon Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举（用于状态机互斥校验）
         * @param {number} playerId - 玩家ID
         * @returns {string|null} 激活时返回 'IN_DUNGEON'，否则返回 null
         */
        async getActiveState(playerId) {
            try {
                const player = await Player.findByPk(playerId, {
                    attributes: ['id', 'in_dungeon']
                });
                return (player && player.in_dungeon)
                    ? PlayerStateMachine.PlayerState.IN_DUNGEON
                    : null;
            } catch (err) {
                console.warn('[Dungeon Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期副本：自动结算并重置玩家状态
         * 委托给 DungeonService.cleanExpiredDungeon 完成
         * @param {Object} ctx - 清理上下文 { batchSize, logger, notify }
         * @returns {Object} 清理统计 { scanned, settled, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, settled: 0, failed: 0 };
            try {
                // 延迟加载避免循环依赖
                const DungeonService = require('../../services/DungeonService');
                const result = await DungeonService.cleanExpiredDungeon(ctx);
                return result;
            } catch (err) {
                console.error('[Dungeon Cleaner] 清理过期副本失败:', err.message);
                stats.failed = 1;
                return stats;
            }
        },

        /**
         * 状态转移校验：副本挑战中默认不允许任何新状态（exclusive: true 已处理）
         * 副本期间玩家被锁定在副本场景内，无法进行闭关、战斗、移动、历练等操作
         */
        canTransitionTo(newStateEnum, activeStates) {
            // 默认走 exclusive 互斥规则
            return {
                allowed: false,
                reason: '副本挑战中，无法分心他事'
            };
        }
    });
}

module.exports = registerDungeonState;
