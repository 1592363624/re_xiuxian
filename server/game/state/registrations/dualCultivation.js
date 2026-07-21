/**
 * 双修状态注册文件
 *
 * 将双修（IN_DUAL_CULTIVATION）状态处理逻辑注册到 StateRegistry，
 * 让 StateCleanerService 和 PlayerStateService 无需感知双修业务细节。
 *
 * 设计要点：
 *   1. 双修与闭关、战斗、移动、历练、悟道、PVP、副本等互斥（exclusive: true）
 *   2. 双修状态来源：dao_companions 表中 last_dual_cultivation_time 在配置的
 *      dual_cultivation_max_duration_seconds 内 + status='accepted'
 *   3. 玩家非正常退出时由 StateCleanerService 自动清理（无需结算，因为收益在双修开始时已发放）
 *
 * 新增玩法接入步骤请参考 seclusion.js / meditation.js 的注册模式
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const DaoCompanions = require('../../../models/daoCompanions');
const { Op } = require('sequelize');
const { infrastructure } = require('../../../modules');

const configLoader = infrastructure.ConfigLoader;

/**
 * 读取双修配置（与 DaoCompanionService 共用配置源）
 * @returns {Object} 双修配置对象
 */
function getDualCultivationConfigs() {
    const config = configLoader.getConfig('dao_companion_data');
    return {
        max_duration: config?.settings?.dual_cultivation_max_duration_seconds || 300,
        min_duration: config?.settings?.dual_cultivation_min_duration_seconds || 60
    };
}

/**
 * 注册双修状态处理器
 */
function registerDualCultivationState() {
    StateRegistry.register('dual_cultivation', {
        metadata: {
            displayName: '闭关双修',
            stateEnum: PlayerStateMachine.PlayerState.IN_DUAL_CULTIVATION,
            exclusive: true  // 双修与其他状态互斥
        },

        /**
         * 获取玩家双修状态快照
         * 查询 dao_companions 表中玩家最近一次双修记录
         * @param {number} playerId - 玩家ID
         * @returns {Object} 双修状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { in_dual_cultivation: false };
            try {
                const cfg = getDualCultivationConfigs();
                const cutoffTime = new Date(Date.now() - cfg.max_duration * 1000);
                // 查询玩家最近一次双修记录（在最大持续时间内的）
                const companion = await DaoCompanions.findOne({
                    where: {
                        status: 'accepted',
                        [Op.or]: [
                            { player_a_id: playerId },
                            { player_b_id: playerId }
                        ],
                        last_dual_cultivation_time: { [Op.gte]: cutoffTime }
                    }
                });
                if (!companion) return snapshot;

                const now = Date.now();
                const startTimeMs = companion.last_dual_cultivation_time
                    ? new Date(companion.last_dual_cultivation_time).getTime()
                    : 0;
                const elapsedSeconds = Math.floor((now - startTimeMs) / 1000);
                const partnerId = companion.player_a_id === playerId
                    ? companion.player_b_id
                    : companion.player_a_id;

                return {
                    in_dual_cultivation: true,
                    companion_id: companion.id,
                    partner_id: partnerId,
                    start_time: companion.last_dual_cultivation_time,
                    elapsed_seconds: elapsedSeconds,
                    remaining_seconds: Math.max(0, cfg.max_duration - elapsedSeconds)
                };
            } catch (err) {
                console.warn('[DualCultivation Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举（用于状态机互斥校验）
         * @param {number} playerId - 玩家ID
         * @returns {Promise<string|null>} IN_DUAL_CULTIVATION 或 null
         */
        async getActiveState(playerId) {
            try {
                const cfg = getDualCultivationConfigs();
                const cutoffTime = new Date(Date.now() - cfg.max_duration * 1000);
                const companion = await DaoCompanions.findOne({
                    where: {
                        status: 'accepted',
                        [Op.or]: [
                            { player_a_id: playerId },
                            { player_b_id: playerId }
                        ],
                        last_dual_cultivation_time: { [Op.gte]: cutoffTime }
                    },
                    attributes: ['id']
                });
                return companion ? PlayerStateMachine.PlayerState.IN_DUAL_CULTIVATION : null;
            } catch (err) {
                console.warn('[DualCultivation Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期双修状态：双修无需显式清理（收益在开始时已发放）
         * 状态自动随时间流逝过期（getActiveState 会自然返回 null）
         * 此处仅为兼容 StateCleanerService 调用约定
         * @param {Object} ctx - 清理上下文 { batchSize, notify }
         * @returns {Object} 清理统计 { scanned, settled, failed }
         */
        async cleanExpired(ctx = {}) {
            // 双修状态基于时间戳自动过期，无需主动清理
            return { scanned: 0, settled: 0, failed: 0 };
        },

        /**
         * 状态转移校验：双修中默认不允许任何新状态（exclusive: true 已处理）
         * @param {string} newStateEnum - 要进入的新状态枚举值
         * @param {Array} activeStates - 当前所有激活状态
         * @returns {Object} { allowed: boolean, reason: string }
         */
        canTransitionTo(newStateEnum, activeStates) {
            // 默认走 exclusive 互斥规则，无需自定义
            return { allowed: false, reason: '闭关双修中，无法开始此操作' };
        }
    });
}

module.exports = registerDualCultivationState;
