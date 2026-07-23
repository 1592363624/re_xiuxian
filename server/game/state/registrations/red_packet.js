/**
 * 红包系统状态注册文件
 *
 * 将红包系统的定期清理逻辑注册到 StateRegistry，由 StateCleanerService 统一调度。
 *
 * 红包系统不是传统的"玩家持续状态"（如闭关/战斗），而是一种"异步任务"：
 *   - 过期未领完的红包需要定期清理，将剩余金额退还发送者
 *
 * 本注册文件负责：
 *   1. cleanExpired：定期清理过期红包，退款未领取部分给发送者
 *   2. getSnapshot：返回玩家相关的红包状态快照（活跃红包数）
 *
 * 设计原则：
 *   - 复用 RedPacketService.cleanExpiredRedPackets 方法
 *   - 不引入新的"玩家状态"概念，仅作为定期任务的调度入口
 *   - 容错隔离：清理失败不影响其他状态处理器
 *
 * 关联文件：
 *   - server/game/services/RedPacketService.js（核心业务逻辑）
 *   - server/routes/chat.js（HTTP 路由）
 *   - server/game/state/index.js（注册入口）
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const RedPacketService = require('../../services/RedPacketService');

/**
 * 注册红包系统状态处理器
 * 注意：red_packet 不是 exclusive 状态，不参与状态机互斥校验
 */
function registerRedPacketState() {
    StateRegistry.register('red_packet', {
        metadata: {
            displayName: '红包',
            // 红包不是互斥状态，玩家可以在任何状态下发/领红包
            // 仅为定期清理任务注册，不参与状态机互斥
            exclusive: false,
            // 无对应的状态枚举（红包不阻塞其他操作）
            stateEnum: null
        },

        /**
         * 获取玩家红包相关状态快照
         * 返回玩家当前活跃的红包数（发送的 + 可领取的）
         * @param {number} playerId - 玩家ID
         * @returns {Object} 状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { has_red_packet_activity: false };
            try {
                const ChatRedPacket = require('../../../models/chatRedPacket');
                const { Op } = require('sequelize');

                // 查询玩家发送的活跃红包数
                const sentActive = await ChatRedPacket.count({
                    where: {
                        sender_id: playerId,
                        status: 'active',
                        expire_at: { [Op.gt]: new Date() }
                    }
                });

                return {
                    has_red_packet_activity: sentActive > 0,
                    sent_active_count: sentActive
                };
            } catch (err) {
                console.warn('[RedPacket Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         * 红包不是互斥状态，始终返回 null
         * @param {number} playerId - 玩家ID
         * @returns {Promise<null>}
         */
        async getActiveState(playerId) {
            return null;
        },

        /**
         * 清理过期红包，退款未领取部分给发送者
         * 由 StateCleanerService 定期调用（默认 5s 间隔）
         *
         * @param {Object} ctx - 清理上下文 { batchSize, notify, autoSettle }
         * @returns {Object} 清理统计 { scanned, cleaned, refunded, failed }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, cleaned: 0, refunded: 0, failed: 0 };

            try {
                const result = await RedPacketService.cleanExpiredRedPackets();
                stats.cleaned = result.refunded_count || 0;
                stats.refunded = result.total_refund_amount || 0;
                return stats;
            } catch (err) {
                console.warn('[RedPacket Registration] 清理过期红包失败:', err.message);
                stats.failed += 1;
                return stats;
            }
        },

        /**
         * 状态转移校验：红包不互斥任何状态
         * @param {string} newStateEnum - 要进入的新状态枚举
         * @param {Array} activeStates - 当前所有激活状态
         * @returns {Object} { allowed: true }
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: true, reason: null };
        }
    });
}

module.exports = registerRedPacketState;
