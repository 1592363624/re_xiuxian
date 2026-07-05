/**
 * PVP 斗法状态注册文件
 *
 * 将 PVP 斗法状态处理逻辑注册到 StateRegistry。
 * PVP 战斗状态来自 pvp_battle_records 表中 status='ongoing' 的记录。
 * - attacker_id 和 defender_id 都被视为处于 PVP 战斗中
 * - 超时未完成的 PVP 战斗由 cleanExpired 自动判平并结算
 *
 * 设计原则：
 * - PVP 战斗与一切其他状态互斥（闭关/历练/移动/悟道等）
 * - 复用 pvp_battle_records 表，无需新增 Player 字段
 * - 清理逻辑委托给 PvpService 处理（含自动结算逻辑）
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const PvpBattleRecord = require('../../../models/pvpBattleRecord');
const { Op } = require('sequelize');

/**
 * 注册 PVP 斗法状态处理器
 */
function registerPvpState() {
    StateRegistry.register('pvp', {
        metadata: {
            displayName: '斗法',
            stateEnum: PlayerStateMachine.PlayerState.IN_PVP_BATTLE,
            exclusive: true  // PVP 战斗与其他状态互斥
        },

        /**
         * 获取玩家 PVP 战斗状态快照
         * 查询 pvp_battle_records 中玩家作为攻击方或防守方的进行中战斗
         * @param {number} playerId - 玩家ID
         * @returns {Object} 状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { in_pvp_battle: false };
            try {
                const battle = await PvpBattleRecord.findOne({
                    where: {
                        [Op.and]: [
                            { status: 'ongoing' },
                            {
                                [Op.or]: [
                                    { attacker_id: playerId },
                                    { defender_id: playerId }
                                ]
                            }
                        ]
                    },
                    order: [['started_at', 'DESC']]
                });
                if (!battle) return snapshot;

                return {
                    in_pvp_battle: true,
                    battle_id: battle.id,
                    is_attacker: battle.attacker_id === playerId,
                    opponent_id: battle.attacker_id === playerId ? battle.defender_id : battle.attacker_id,
                    battle_type: battle.battle_type,
                    total_rounds: battle.total_rounds,
                    started_at: battle.started_at ? new Date(battle.started_at).toISOString() : null
                };
            } catch (err) {
                console.warn('[Pvp Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         * 用于状态机互斥校验
         * @param {number} playerId - 玩家ID
         * @returns {Promise<string|null>} IN_PVP_BATTLE 或 null
         */
        async getActiveState(playerId) {
            try {
                const count = await PvpBattleRecord.count({
                    where: {
                        [Op.and]: [
                            { status: 'ongoing' },
                            {
                                [Op.or]: [
                                    { attacker_id: playerId },
                                    { defender_id: playerId }
                                ]
                            }
                        ]
                    }
                });
                return count > 0 ? PlayerStateMachine.PlayerState.IN_PVP_BATTLE : null;
            } catch (err) {
                console.warn('[Pvp Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期 PVP 战斗：自动判平并结算
         * 超时阈值由 game_balance.json pvp.max_rounds * round_timeout_seconds 计算
         * 委托给 PvpService 处理具体结算逻辑
         * @param {Object} ctx - 清理上下文 { batchSize, notify }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, cleaned: 0, failed: 0 };
            const batchSize = ctx.batchSize || 100;

            try {
                // 延迟加载 PvpService，避免循环依赖
                const PvpService = require('../../services/PvpService');
                const result = await PvpService.cleanExpiredBattles({ batchSize, notify: ctx.notify });
                return result || stats;
            } catch (err) {
                console.warn('[Pvp Registration] 清理过期 PVP 战斗失败:', err.message);
                stats.failed = 1;
                return stats;
            }
        },

        /**
         * 状态转移校验：PVP 战斗中禁止任何新状态
         * @param {string} newStateEnum - 要进入的新状态枚举
         * @param {Array} activeStates - 当前所有激活状态
         * @returns {Object} { allowed, reason }
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '斗法进行中，无法开始此操作' };
        }
    });
}

module.exports = registerPvpState;
