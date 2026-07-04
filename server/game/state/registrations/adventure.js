/**
 * 历练状态注册文件
 *
 * 将历练相关状态处理逻辑注册到 StateRegistry。
 * 历练状态来自独立表 PlayerAdventure（status='in_progress' 表示进行中）。
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const PlayerAdventure = require('../../../models/playerAdventure');
const { Op } = require('sequelize');

/**
 * 注册历练状态处理器
 */
function registerAdventureState() {
    StateRegistry.register('adventure', {
        metadata: {
            displayName: '历练',
            stateEnum: PlayerStateMachine.PlayerState.ADVENTURING,
            exclusive: true
        },

        /**
         * 获取玩家历练状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { is_adventuring: false };
            try {
                const adventure = await PlayerAdventure.findOne({
                    where: { player_id: playerId, status: 'in_progress' },
                    order: [['created_at', 'DESC']]
                });
                if (!adventure) return snapshot;

                const now = Date.now();
                const endTimeMs = adventure.end_time ? new Date(adventure.end_time).getTime() : 0;
                return {
                    is_adventuring: true,
                    adventure_id: adventure.id,
                    event_type: adventure.event_type,
                    map_id: adventure.map_id,
                    map_name: adventure.map_name,
                    start_time: adventure.start_time ? new Date(adventure.start_time).toISOString() : null,
                    end_time: adventure.end_time ? new Date(adventure.end_time).toISOString() : null,
                    is_expired: endTimeMs > 0 && now > endTimeMs,
                    remaining_seconds: Math.max(0, Math.floor((endTimeMs - now) / 1000))
                };
            } catch (err) {
                console.warn('[Adventure Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         */
        async getActiveState(playerId) {
            try {
                const adventure = await PlayerAdventure.findOne({
                    where: { player_id: playerId, status: 'in_progress' },
                    attributes: ['id']
                });
                return adventure ? PlayerStateMachine.PlayerState.ADVENTURING : null;
            } catch (err) {
                console.warn('[Adventure Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期历练：标记为已完成等待玩家领取
         * 不自动结算奖励，玩家需手动领取（避免 AI 生成的事件奖励计算复杂）
         * @param {Object} ctx - 清理上下文 { batchSize, notify, autoComplete }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, marked: 0, failed: 0 };
            const batchSize = ctx.batchSize || 100;
            const now = new Date();

            const expiredAdventures = await PlayerAdventure.findAll({
                where: { status: 'in_progress', end_time: { [Op.lt]: now } },
                limit: batchSize
            });

            stats.scanned = expiredAdventures.length;
            if (expiredAdventures.length === 0) return stats;

            const playerIds = new Set();
            for (const adv of expiredAdventures) {
                try {
                    if (ctx.autoComplete === true) {
                        adv.status = 'completed';
                        await adv.save();
                    }
                    playerIds.add(adv.player_id);
                    stats.marked += 1;
                } catch (err) {
                    stats.failed += 1;
                    console.error(`[Adventure Cleaner] 历练 ${adv.id} 标记失败:`, err.message);
                }
            }

            if (ctx.notify) {
                for (const playerId of playerIds) {
                    try {
                        ctx.notify(playerId, 'adventure_expired', {
                            adventure_ended: true,
                            need_claim: true
                        });
                    } catch (e) { /* 推送失败不影响清理 */ }
                }
            }

            return stats;
        },

        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '历练中，无法开始此操作' };
        }
    });
}

module.exports = registerAdventureState;
