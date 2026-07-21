/**
 * 妖兽入侵战斗状态注册文件
 *
 * 将妖兽入侵斩妖状态处理逻辑注册到 StateRegistry。
 * 玩家攻击妖兽后进入此状态，与一切其他状态互斥（闭关/历练/移动/PVP/悟道/副本/世界BOSS 等）。
 *
 * 状态来源：
 *   beast_invasion_attacks 表中最近一次攻击记录的 created_at 在配置的 active_window_ms 内
 *   且对应的 beast_invasions 事件仍处于 active + battle 阶段
 *   （即玩家正在斩妖，且妖兽还活着、战斗阶段未超时）
 *
 * 设计原则：
 *   - 妖兽入侵斩妖与其他 exclusive 状态互斥
 *   - 玩家主动撤退或妖兽被击杀/逃脱/过期后自动退出状态
 *   - 状态清理由 BeastInvasionSchedulerService 周期触发（5 秒一次）
 *
 * 与 world_boss 状态注册的差异：
 *   world_boss 用 world_boss_damage_records 累计单条（每次攻击 UPDATE last_attack_time），
 *   而妖兽入侵用 beast_invasion_attacks 流水明细（每次攻击 INSERT 一条），
 *   故查询最近活跃时间用 MAX(created_at) 或 ORDER BY created_at DESC LIMIT 1。
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const BeastInvasionAttack = require('../../../models/beastInvasionAttack');
const BeastInvasion = require('../../../models/beastInvasion');
const { Op } = require('sequelize');

/**
 * 读取妖兽入侵活跃窗口配置（毫秒）
 * 与 game_balance.beast_invasion.active_window_ms 保持一致，默认 5 分钟
 * 活跃窗口外的攻击记录视为已脱离妖兽战状态
 * @returns {number} 活跃窗口毫秒数
 */
function getActiveWindowMs() {
    try {
        const { infrastructure } = require('../../../modules');
        const configLoader = infrastructure.ConfigLoader;
        const cfg = configLoader?.getConfig('game_balance')?.beast_invasion;
        return cfg?.active_window_ms || 300000;
    } catch (e) {
        return 300000; // 默认 5 分钟
    }
}

/**
 * 注册妖兽入侵斩妖状态处理器
 */
function registerBeastInvasionState() {
    StateRegistry.register('beast_invasion', {
        metadata: {
            displayName: '妖兽入侵斩妖',
            stateEnum: PlayerStateMachine.PlayerState.IN_BEAST_INVASION,
            exclusive: true  // 妖兽入侵斩妖与其他状态互斥
        },

        /**
         * 获取玩家妖兽入侵斩妖状态快照
         * 查询 beast_invasion_attacks 中玩家最近一次攻击记录
         * @param {number} playerId - 玩家ID
         * @returns {Object} 状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { in_beast_invasion: false };
            try {
                // 查询玩家最近一次攻击记录（活跃窗口内）
                const activeWindowMs = getActiveWindowMs();
                const activeThreshold = new Date(Date.now() - activeWindowMs);
                const record = await BeastInvasionAttack.findOne({
                    where: {
                        player_id: playerId,
                        created_at: { [Op.gte]: activeThreshold }
                    },
                    order: [['created_at', 'DESC']]
                });
                if (!record) return snapshot;

                // 检查妖兽入侵事件是否仍处于战斗阶段
                const invasion = await BeastInvasion.findByPk(record.invasion_id);
                if (!invasion || invasion.status !== 'active' || invasion.phase !== 'battle') {
                    return snapshot;
                }

                return {
                    in_beast_invasion: true,
                    invasion_id: record.invasion_id,
                    beast_name: invasion.beast_name,
                    beast_phase: invasion.phase,
                    beast_hp_current: invasion.hp_current?.toString() || '0',
                    beast_hp_max: invasion.hp_max?.toString() || '0',
                    my_last_damage: record.damage?.toString() || '0',
                    my_last_attack_time: record.created_at ? new Date(record.created_at).toISOString() : null,
                    skill_used: record.skill_used
                };
            } catch (err) {
                console.warn('[BeastInvasion Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         * 用于状态机互斥校验
         * @param {number} playerId - 玩家ID
         * @returns {Promise<string|null>} IN_BEAST_INVASION 或 null
         */
        async getActiveState(playerId) {
            try {
                // 查询玩家最近一次攻击记录（活跃窗口内）
                const activeWindowMs = getActiveWindowMs();
                const activeThreshold = new Date(Date.now() - activeWindowMs);
                const record = await BeastInvasionAttack.findOne({
                    where: {
                        player_id: playerId,
                        created_at: { [Op.gte]: activeThreshold }
                    }
                });
                if (!record) return null;

                // 检查妖兽入侵事件是否仍处于战斗阶段
                const invasion = await BeastInvasion.findByPk(record.invasion_id);
                if (!invasion || invasion.status !== 'active' || invasion.phase !== 'battle') {
                    return null;
                }

                return PlayerStateMachine.PlayerState.IN_BEAST_INVASION;
            } catch (err) {
                console.warn('[BeastInvasion Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期妖兽入侵斩妖状态
         * 由 BeastInvasionSchedulerService 周期触发（5秒一次）
         * 实际清理逻辑：妖兽被击杀/逃脱/过期后，所有相关攻击记录自动失效
         * 玩家主动撤退由 retreat 接口处理（更新 created_at 让记录立即过期）
         * @param {Object} ctx - 清理上下文 { batchSize, notify }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, cleaned: 0, failed: 0 };
            // 玩家主动退出战斗由撤退接口处理，这里只做日志
            return stats;
        },

        /**
         * 状态转移校验：妖兽入侵斩妖中禁止任何新状态
         * @param {string} newStateEnum - 要进入的新状态枚举
         * @param {Array} activeStates - 当前所有激活状态
         * @returns {Object} { allowed, reason }
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '正在妖兽入侵斩妖中，无法开始此操作（请先撤退）' };
        }
    });
}

module.exports = registerBeastInvasionState;
