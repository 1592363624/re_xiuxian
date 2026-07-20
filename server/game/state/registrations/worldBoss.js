/**
 * 世界BOSS战斗状态注册文件
 *
 * 将世界BOSS战斗状态处理逻辑注册到 StateRegistry。
 * 玩家攻击BOSS后进入此状态，与一切其他状态互斥（闭关/历练/移动/PVP/悟道/副本等）。
 *
 * 状态来源：
 *   world_boss_damage_records 表中 last_attack_time 在配置的 attack_cooldown_seconds 内
 *   （即玩家正在攻击BOSS，且BOSS还活着）
 *
 * 设计原则：
 *   - 世界BOSS战斗与其他 exclusive 状态互斥
 *   - 玩家主动撤退或BOSS被击杀/过期后自动退出状态
 *   - 状态清理由 WorldBossSchedulerService 周期触发
 */
'use strict';

const StateRegistry = require('../StateRegistry');
const PlayerStateMachine = require('../PlayerStateMachine');
const WorldBossDamageRecord = require('../../../models/worldBossDamageRecord');
const WorldBoss = require('../../../models/worldBoss');
const { Op } = require('sequelize');

/**
 * 注册世界BOSS战斗状态处理器
 */
function registerWorldBossState() {
    StateRegistry.register('world_boss', {
        metadata: {
            displayName: '讨伐世界BOSS',
            stateEnum: PlayerStateMachine.PlayerState.IN_WORLD_BOSS,
            exclusive: true  // 世界BOSS战斗与其他状态互斥
        },

        /**
         * 获取玩家世界BOSS战斗状态快照
         * 查询 world_boss_damage_records 中玩家最近一次攻击的BOSS记录
         * @param {number} playerId - 玩家ID
         * @returns {Object} 状态快照
         */
        async getSnapshot(playerId) {
            const snapshot = { in_world_boss: false };
            try {
                // 查询玩家最近一次伤害记录（30分钟内）
                const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
                const record = await WorldBossDamageRecord.findOne({
                    where: {
                        player_id: playerId,
                        last_attack_time: { [Op.gte]: thirtyMinAgo }
                    },
                    order: [['last_attack_time', 'DESC']]
                });
                if (!record) return snapshot;

                // 检查 BOSS 是否还活着
                const boss = await WorldBoss.findByPk(record.boss_id);
                if (!boss || boss.status !== 'active') return snapshot;

                return {
                    in_world_boss: true,
                    boss_id: record.boss_id,
                    boss_name: boss.boss_name,
                    boss_phase: boss.phase,
                    boss_hp_current: boss.hp_current?.toString() || '0',
                    boss_hp_max: boss.hp_max?.toString() || '0',
                    my_total_damage: record.total_damage?.toString() || '0',
                    my_damage_count: record.damage_count,
                    my_death_count: record.death_count,
                    last_attack_time: record.last_attack_time ? new Date(record.last_attack_time).toISOString() : null
                };
            } catch (err) {
                console.warn('[WorldBoss Registration] 获取快照失败:', err.message);
                return snapshot;
            }
        },

        /**
         * 获取玩家当前激活状态枚举
         * 用于状态机互斥校验
         * @param {number} playerId - 玩家ID
         * @returns {Promise<string|null>} IN_WORLD_BOSS 或 null
         */
        async getActiveState(playerId) {
            try {
                // 查询玩家最近一次伤害记录（30分钟内）
                const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
                const record = await WorldBossDamageRecord.findOne({
                    where: {
                        player_id: playerId,
                        last_attack_time: { [Op.gte]: thirtyMinAgo }
                    }
                });
                if (!record) return null;

                // 检查 BOSS 是否还活着
                const boss = await WorldBoss.findByPk(record.boss_id);
                if (!boss || boss.status !== 'active') return null;

                return PlayerStateMachine.PlayerState.IN_WORLD_BOSS;
            } catch (err) {
                console.warn('[WorldBoss Registration] 查询激活状态失败:', err.message);
                return null;
            }
        },

        /**
         * 清理过期世界BOSS战斗状态
         * 由 WorldBossSchedulerService 周期触发（5秒一次）
         * 实际清理逻辑：BOSS被击杀/过期后，所有相关伤害记录自动失效
         * @param {Object} ctx - 清理上下文 { batchSize, notify }
         */
        async cleanExpired(ctx = {}) {
            const stats = { scanned: 0, cleaned: 0, failed: 0 };
            // 玩家主动退出战斗由撤退接口处理，这里只做日志
            return stats;
        },

        /**
         * 状态转移校验：世界BOSS战斗中禁止任何新状态
         * @param {string} newStateEnum - 要进入的新状态枚举
         * @param {Array} activeStates - 当前所有激活状态
         * @returns {Object} { allowed, reason }
         */
        canTransitionTo(newStateEnum, activeStates) {
            return { allowed: false, reason: '正在讨伐世界BOSS，无法开始此操作（请先撤退）' };
        }
    });
}

module.exports = registerWorldBossState;