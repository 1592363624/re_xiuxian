/**
 * 宗门战参战状态注册文件
 *
 * 将宗门战参战状态处理逻辑注册到 StateRegistry。
 * 玩家加入宗门战后进入此状态，与一切其他状态互斥。
 *
 * 状态来源：
 *   sect_war_participants 表中 leave_time 为 NULL 且对应战役状态为 active
 *
 * 设计原则：
 *   - 宗门战参战与其他 exclusive 状态互斥
 *   - 玩家主动离开或战役结束后自动退出状态
 *   - 状态清理由 SectWarSchedulerService 周期触发
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const SectWarParticipant = require('../../../models/sectWarParticipant');
const SectWar = require('../../../models/sectWar');
const { Op } = require('sequelize');

/**
 * 注册宗门战参战状态处理器
 */
function registerSectWarState() {
    StateRegistry.register('sect_war', {
        metadata: {
            displayName: '宗门战',
            stateEnum: PlayerStateMachine.PlayerState.IN_SECT_WAR,
            exclusive: true  // 宗门战参战与其他状态互斥
        },

        /**
         * 获取玩家宗门战参战状态快照
         * 查询 sect_war_participants 中玩家未离开的记录，且对应战役状态为 active
         * @param {number} playerId - 玩家ID
         * @returns {Object} 状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { in_sect_war: false };
            try {
                const participant = await SectWarParticipant.findOne({
                    where: {
                        player_id: playerId,
                        leave_time: null
                    },
                    order: [['join_time', 'DESC']]
                });
                if (!participant) return snapshot;

                // 检查战役是否还在 active
                const war = await SectWar.findByPk(participant.war_id);
                if (!war || war.status !== 'active') return snapshot;

                return {
                    in_sect_war: true,
                    war_id: participant.war_id,
                    war_name: war.war_name,
                    side: participant.side,
                    sect_id: participant.sect_id,
                    sect_name: participant.sect_name,
                    kill_count: participant.kill_count,
                    death_count: participant.death_count,
                    damage_dealt: participant.damage_dealt?.toString() || '0',
                    contribution_score: participant.contribution_score,
                    join_time: participant.join_time ? new Date(participant.join_time).toISOString() : null
                };
            } catch (err) {
                console.warn('[SectWar Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         * @param {number} playerId - 玩家ID
         * @returns {Promise<string|null>} IN_SECT_WAR 或 null
         */
        async getActiveState(playerId) {
            try {
                const participant = await SectWarParticipant.findOne({
                    where: {
                        player_id: playerId,
                        leave_time: null
                    }
                });
                if (!participant) return null;

                const war = await SectWar.findByPk(participant.war_id);
                if (!war || war.status !== 'active') return null;

                return PlayerStateMachine.PlayerState.IN_SECT_WAR;
            } catch (err) {
                console.warn('[SectWar Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期宗门战参战状态
         * 由 SectWarSchedulerService 周期触发（5秒一次）
         * 实际清理逻辑：战役结束后，所有 leave_time 为 NULL 的记录自动设置 leave_time
         * @param {Object} ctx - 清理上下文 { batchSize, notify }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, cleaned: 0, failed: 0 };
            return stats;
        },

        /**
         * 状态转移校验：宗门战参战中禁止任何新状态
         * @param {string} newStateEnum - 要进入的新状态枚举
         * @param {Array} activeStates - 当前所有激活状态
         * @returns {Object} { allowed, reason }
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '正在参与宗门战，无法开始此操作（请先离开战役）' };
        }
    });
}

module.exports = registerSectWarState;
