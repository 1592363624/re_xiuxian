/**
 * 战斗状态注册文件
 *
 * 将战斗相关状态处理逻辑注册到 StateRegistry。
 * 战斗状态来自独立表 ActiveBattle（player_id 唯一约束保证一对一）。
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const ActiveBattle = require('../../../models/activeBattle');
const { Op } = require('sequelize');

/**
 * 注册战斗状态处理器
 */
function registerCombatState() {
    StateRegistry.register('combat', {
        metadata: {
            displayName: '战斗',
            stateEnum: PlayerStateMachine.PlayerState.IN_BATTLE,
            exclusive: true  // 战斗与其他状态互斥
        },

        /**
         * 获取玩家战斗状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { in_battle: false };
            try {
                const activeBattle = await ActiveBattle.findOne({
                    where: { player_id: playerId }
                });
                if (!activeBattle) return snapshot;

                return {
                    in_battle: true,
                    battle_id: activeBattle.battle_uuid,
                    monster_name: activeBattle.monster_name,
                    monster_id: activeBattle.monster_id,
                    round: activeBattle.round,
                    turn: activeBattle.turn,
                    is_player_turn: activeBattle.is_player_turn,
                    expires_at: activeBattle.expires_at ? new Date(activeBattle.expires_at).toISOString() : null
                };
            } catch (err) {
                console.warn('[Combat Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         */
        async getActiveState(playerId) {
            try {
                const activeBattle = await ActiveBattle.findOne({
                    where: { player_id: playerId },
                    attributes: ['id']
                });
                return activeBattle ? PlayerStateMachine.PlayerState.IN_BATTLE : null;
            } catch (err) {
                console.warn('[Combat Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期战斗：直接删除 ActiveBattle 记录
         * 过期战斗不保存到战斗历史（视为玩家逃跑），无奖励无惩罚
         * @param {Object} ctx - 清理上下文 { batchSize, notify }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, cleaned: 0, failed: 0 };
            const batchSize = ctx.batchSize || 100;
            const now = new Date();

            const expiredBattles = await ActiveBattle.findAll({
                where: { expires_at: { [Op.lt]: now } },
                limit: batchSize
            });

            stats.scanned = expiredBattles.length;
            if (expiredBattles.length === 0) return stats;

            const playerIds = expiredBattles.map(b => b.player_id);
            const deleted = await ActiveBattle.destroy({
                where: { expires_at: { [Op.lt]: now } }
            });
            stats.cleaned = deleted;

            // 推送战斗清理事件给在线玩家
            if (ctx.notify) {
                for (const playerId of playerIds) {
                    try {
                        ctx.notify(playerId, 'battle_expired', {
                            battle_ended: true,
                            reason: 'expired'
                        });
                    } catch (e) { /* 推送失败不影响清理 */ }
                }
            }

            return stats;
        },

        /**
         * 状态转移校验：战斗中默认不允许任何新状态
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '战斗中，无法开始此操作' };
        }
    });
}

module.exports = registerCombatState;
