/**
 * 封禁状态注册文件
 *
 * 将封禁相关状态处理逻辑注册到 StateRegistry。
 * 封禁状态存储在 Player 表（is_banned/ban_expire_time 字段）。
 * 封禁是特殊状态：不允许开始任何新状态，但过期后需要自动解封。
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const Player = require('../../../models/player');
const { Op } = require('sequelize');

/**
 * 注册封禁状态处理器
 */
function registerBanState() {
    StateRegistry.register('ban', {
        metadata: {
            displayName: '封禁',
            stateEnum: PlayerStateMachine.PlayerState.BANNED,
            exclusive: false  // 封禁可与其它状态共存（如封禁期间闭关仍会过期）
        },

        /**
         * 获取玩家封禁状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { is_banned: false };
            try {
                const player = await Player.findByPk(playerId, {
                    attributes: ['id', 'is_banned', 'ban_expire_time', 'ban_reason']
                });
                if (!player || !player.is_banned) return snapshot;

                return {
                    is_banned: true,
                    ban_reason: player.ban_reason,
                    ban_expire_time: player.ban_expire_time ? new Date(player.ban_expire_time).toISOString() : null
                };
            } catch (err) {
                console.warn('[Ban Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         */
        async getActiveState(playerId) {
            try {
                const player = await Player.findByPk(playerId, {
                    attributes: ['id', 'is_banned', 'ban_expire_time']
                });
                if (!player || !player.is_banned) return null;
                // 封禁已过期但未清理时，不算激活（由 cleanExpired 处理）
                if (player.ban_expire_time && new Date(player.ban_expire_time) < new Date()) {
                    return null;
                }
                return PlayerStateMachine.PlayerState.BANNED;
            } catch (err) {
                console.warn('[Ban Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期封禁：自动解封
         * @param {Object} ctx - 清理上下文 { batchSize }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, unbanned: 0, failed: 0 };
            const batchSize = ctx.batchSize || 100;
            const now = new Date();

            const expiredBans = await Player.findAll({
                where: {
                    is_banned: true,
                    ban_expire_time: { [Op.lt]: now }
                },
                limit: batchSize
            });

            stats.scanned = expiredBans.length;
            if (expiredBans.length === 0) return stats;

            for (const player of expiredBans) {
                try {
                    player.is_banned = false;
                    player.ban_expire_time = null;
                    // 保留 ban_reason 作为历史记录，不清空
                    await player.save();
                    stats.unbanned += 1;
                    console.log(`[Ban Cleaner] 玩家 ${player.id} 封禁到期，自动解封`);
                } catch (err) {
                    stats.failed += 1;
                    console.error(`[Ban Cleaner] 玩家 ${player.id} 解封失败:`, err.message);
                }
            }

            return stats;
        },

        /**
         * 封禁状态特殊：禁止一切新状态（在 PlayerStateMachine.canStart 中已特殊处理）
         * 此处返回 false 由状态机统一拦截
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '账号已封禁，无法进行任何操作' };
        }
    });
}

module.exports = registerBanState;
