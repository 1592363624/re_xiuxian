/**
 * 悬赏系统状态注册文件
 *
 * 将悬赏系统的定期清理逻辑注册到 StateRegistry，由 StateCleanerService 统一调度。
 *
 * 悬赏系统不是传统的"玩家持续状态"（如闭关/战斗），而是一种"异步任务"：
 *   - 过期悬赏需要定期清理并退款给发布者
 *   - 已接取悬赏对应的战斗结束后需要结算（同步钩子 + 异步扫描双保险）
 *
 * 本注册文件负责：
 *   1. cleanExpired：定期清理过期悬赏 + 扫描结算已结束战斗但未结算的悬赏
 *   2. getSnapshot：返回玩家相关的悬赏状态快照（已发布的活跃悬赏数 + 被悬赏状态）
 *
 * 设计原则：
 *   - 复用 BountyService 的 cleanExpiredBounties / settlePendingBountyBattles 方法
 *   - 不引入新的"玩家状态"概念，仅作为定期任务的调度入口
 *   - 容错隔离：清理失败不影响其他状态处理器
 *
 * 关联文件：
 *   - server/game/services/BountyService.js（核心业务逻辑）
 *   - server/routes/bounty.js（HTTP 路由）
 *   - server/game/state/index.js（注册入口）
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const BountyService = require('../../services/BountyService');

/**
 * 注册悬赏系统状态处理器
 * 注意：bounty 不是 exclusive 状态，不参与状态机互斥校验
 */
function registerBountyState() {
    StateRegistry.register('bounty', {
        metadata: {
            displayName: '悬赏',
            // 悬赏不是互斥状态，玩家可以在任何状态下发布/接取悬赏
            // 仅为定期清理任务注册，不参与状态机互斥
            exclusive: false,
            // 无对应的状态枚举（悬赏不阻塞其他操作）
            stateEnum: null
        },

        /**
         * 获取玩家悬赏相关状态快照
         * 返回玩家当前活跃的发布悬赏数 + 是否被悬赏
         * @param {number} playerId - 玩家ID
         * @returns {Object} 状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { has_bounty_activity: false };
            try {
                const PlayerBounty = require('../../../models/playerBounty');
                const { Op } = require('sequelize');

                // 查询玩家作为发布者的活跃悬赏数
                const publishedActive = await PlayerBounty.count({
                    where: {
                        publisher_id: playerId,
                        status: { [Op.in]: ['active', 'accepted'] }
                    }
                });

                // 查询玩家是否被悬赏（活跃状态）
                const targetedActive = await PlayerBounty.count({
                    where: {
                        target_id: playerId,
                        status: { [Op.in]: ['active', 'accepted'] }
                    }
                });

                // 查询玩家作为接单者的进行中悬赏
                const acceptedOngoing = await PlayerBounty.count({
                    where: {
                        acceptor_id: playerId,
                        status: 'accepted'
                    }
                });

                return {
                    has_bounty_activity: publishedActive > 0 || targetedActive > 0 || acceptedOngoing > 0,
                    published_active_count: publishedActive,
                    targeted_active_count: targetedActive,
                    accepted_ongoing_count: acceptedOngoing
                };
            } catch (err) {
                console.warn('[Bounty Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         * 悬赏不是互斥状态，始终返回 null
         * @param {number} playerId - 玩家ID
         * @returns {Promise<null>}
         */
        async getActiveState(playerId) {
            return null;
        },

        /**
         * 清理过期悬赏 + 扫描结算已结束战斗的悬赏
         * 由 StateCleanerService 定期调用（默认 60s 间隔）
         *
         * 两阶段清理：
         *   1. settlePendingBountyBattles：扫描已接取悬赏对应的已结束战斗并结算
         *      （这是同步钩子的兜底机制，防止 PvpService 钩子调用失败）
         *   2. cleanExpiredBounties：清理过期未接取的悬赏，退款给发布者
         *
         * @param {Object} ctx - 清理上下文 { batchSize, notify, autoComplete, autoSettle }
         * @returns {Object} 清理统计 { scanned, settled, cleaned, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, settled: 0, cleaned: 0, failed: 0 };

            try {
                // 阶段1：扫描结算已接取悬赏对应的已结束战斗
                // 这是 PvpService._settleBattle 中同步钩子的兜底机制
                // 如果同步钩子正常工作，此处扫描应返回 settled=0
                if (ctx.autoSettle !== false) {
                    try {
                        const settleStats = await BountyService.settlePendingBountyBattles();
                        stats.scanned += settleStats.scanned || 0;
                        stats.settled += settleStats.settled || 0;
                        stats.failed += settleStats.failed || 0;
                    } catch (err) {
                        console.warn('[Bounty Registration] 扫描结算悬赏失败:', err.message);
                        stats.failed += 1;
                    }
                }

                // 阶段2：清理过期未接取的悬赏，退款给发布者
                try {
                    const cleanStats = await BountyService.cleanExpiredBounties();
                    stats.scanned += cleanStats.scanned || 0;
                    stats.cleaned += cleanStats.cleaned || 0;
                    stats.failed += cleanStats.failed || 0;
                } catch (err) {
                    console.warn('[Bounty Registration] 清理过期悬赏失败:', err.message);
                    stats.failed += 1;
                }

                return stats;
            } catch (err) {
                console.warn('[Bounty Registration] 清理悬赏整体失败:', err.message);
                stats.failed += 1;
                return stats;
            }
        },

        /**
         * 状态转移校验：悬赏不互斥任何状态
         * @param {string} newStateEnum - 要进入的新状态枚举
         * @param {Array} activeStates - 当前所有激活状态
         * @returns {Object} { allowed: true }
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: true, reason: null };
        }
    });
}

module.exports = registerBountyState;
