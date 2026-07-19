/**
 * 元婴出窍状态注册文件
 *
 * 将元婴出窍相关状态处理逻辑（快照查询/过期清理/互斥校验）注册到 StateRegistry，
 * 让 StateCleanerService 和 PlayerStateService 无需感知元婴业务细节。
 *
 * 设计要点：
 * 1. 元婴出窍与闭关、战斗、移动、历练、悟道、PVP 互斥（exclusive: true）
 * 2. 过期自动结算：调用 NascentSoulService.cleanExpiredSoulOut 完成收益结算
 * 3. 玩家非正常退出时由 StateCleanerService 自动结算，避免状态卡死
 * 4. 出窍期间禁止其他玩法，但允许查看状态、问道等只读操作由业务层校验
 *
 * 接入步骤参考 .trae/skills/project-architecture-design/SKILL.md
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const Player = require('../../../models/player');
const sequelize = require('../../../config/database');
const { Op } = require('sequelize');

/**
 * 注册元婴出窍状态处理器
 */
function registerNascentSoulState() {
    StateRegistry.register('nascent_soul', {
        metadata: {
            displayName: '元婴出窍',
            stateEnum: PlayerStateMachine.PlayerState.SOUL_OUT,
            exclusive: true  // 出窍与其他所有状态互斥
        },

        /**
         * 获取玩家元婴出窍状态快照
         * @param {number} playerId - 玩家ID
         * @returns {Object} 出窍状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { soul_state: 'none' };
            try {
                const player = await Player.findByPk(playerId);
                if (!player || player.soul_state !== 'out') return snapshot;

                const now = Date.now();
                const endTimeMs = player.soul_out_end_time ? new Date(player.soul_out_end_time).getTime() : 0;
                return {
                    soul_state: 'out',
                    target: player.soul_out_target || 'explore',
                    start_time: player.soul_out_start_time ? new Date(player.soul_out_start_time).toISOString() : null,
                    end_time: player.soul_out_end_time ? new Date(player.soul_out_end_time).toISOString() : null,
                    duration: player.soul_out_duration || 0,
                    remaining_seconds: Math.max(0, Math.floor((endTimeMs - now) / 1000))
                };
            } catch (err) {
                console.warn('[NascentSoul Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举（用于状态机互斥校验）
         * @param {number} playerId - 玩家ID
         * @returns {string|null} 激活时返回 'SOUL_OUT'，否则返回 null
         */
        async getActiveState(playerId) {
            try {
                const player = await Player.findByPk(playerId, {
                    attributes: ['id', 'soul_state']
                });
                return (player && player.soul_state === 'out')
                    ? PlayerStateMachine.PlayerState.SOUL_OUT
                    : null;
            } catch (err) {
                console.warn('[NascentSoul Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期元婴出窍：自动结算修为收益并重置状态
         * 委托给 NascentSoulService.cleanExpiredSoulOut 完成
         * @param {Object} ctx - 清理上下文 { batchSize, logger, notify }
         * @returns {Object} 清理统计 { scanned, settled, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, settled: 0, failed: 0 };
            try {
                // 延迟加载避免循环依赖
                const NascentSoulService = require('../../services/NascentSoulService');
                const result = await NascentSoulService.cleanExpiredSoulOut(ctx);
                return result;
            } catch (err) {
                console.error('[NascentSoul Cleaner] 清理过期出窍失败:', err.message);
                stats.failed = 1;
                return stats;
            }
        },

        /**
         * 状态转移校验：元婴出窍中默认不允许任何新状态（exclusive: true 已处理）
         * 出窍期间玩家肉身静止，无法进行闭关、战斗、移动、历练等操作
         * 问道、法相凝聚等需要静心的操作也禁止
         */
        canTransitionTo(newStateEnum, activeStates) {
            // 默认走 exclusive 互斥规则
            return {
                allowed: false,
                reason: '元婴出窍中，肉身静止，无法开始此操作'
            };
        }
    });
}

module.exports = registerNascentSoulState;
