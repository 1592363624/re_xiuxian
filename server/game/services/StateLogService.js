/**
 * 状态转移日志服务
 *
 * 提供状态变更日志的记录和查询能力：
 *   - logStateChange: 记录一次状态转移（供 PlayerStateMachine 和各 route 调用）
 *   - queryLogs: 分页查询日志（供 admin 接口调用）
 *   - getRecentErrors: 查询最近的异常状态变更（供监控告警）
 *
 * 设计要点：
 *   1. 日志记录失败不影响主业务流程（catch 后仅 console.warn）
 *   2. 延迟加载 Player 模型查询昵称，避免循环依赖
 *   3. 支持批量查询和按玩家/动作/状态类型筛选
 */
'use strict';

const PlayerStateLog = require('../../models/playerStateLog');
const { Op } = require('sequelize');

class StateLogService {
    /**
     * 记录一次状态转移
     * @param {Object} params - 日志参数
     * @param {number} params.playerId - 玩家ID
     * @param {string} params.stateType - 状态类型 (seclusion/combat/adventure/moving/ban)
     * @param {string} params.action - 动作类型 (enter/exit/transition/auto_clean/error)
     * @param {string} [params.fromState] - 变更前状态枚举
     * @param {string} [params.toState] - 变更后状态枚举
     * @param {string} [params.source] - 触发来源 (route/cleaner/gm/system)
     * @param {Object|string} [params.details] - 详情对象或字符串
     * @returns {Promise<void>}
     */
    static async logStateChange({ playerId, stateType, action, fromState = null, toState = null, source = 'system', details = null }) {
        try {
            // 延迟加载 Player 模型，避免循环依赖
            const Player = require('../../models/player');
            // 查询玩家昵称（冗余存储，避免查询日志时 JOIN）
            let nickname = null;
            try {
                const player = await Player.findByPk(playerId, { attributes: ['nickname'] });
                nickname = player?.nickname || null;
            } catch (e) {
                // 查询玩家失败不阻断日志记录
            }

            // details 统一序列化为字符串存储
            const detailsStr = details && typeof details === 'object'
                ? JSON.stringify(details)
                : (details || null);

            await PlayerStateLog.create({
                player_id: playerId,
                player_nickname: nickname,
                state_type: stateType,
                action,
                from_state: fromState,
                to_state: toState,
                source,
                details: detailsStr
            });
        } catch (err) {
            // 日志记录失败不影响主业务流程
            console.warn('[StateLogService] 记录状态日志失败:', err.message);
        }
    }

    /**
     * 分页查询状态转移日志
     * @param {Object} filters - 筛选条件
     * @param {number} [filters.playerId] - 按玩家ID筛选
     * @param {string} [filters.action] - 按动作类型筛选
     * @param {string} [filters.stateType] - 按状态类型筛选
     * @param {number} [filters.page=1] - 页码
     * @param {number} [filters.limit=20] - 每页条数
     * @returns {Promise<Object>} { logs, total, currentPage, totalPages }
     */
    static async queryLogs({ playerId, action, stateType, page = 1, limit = 20 } = {}) {
        const where = {};
        if (playerId) where.player_id = playerId;
        if (action) where.action = action;
        if (stateType) where.state_type = stateType;

        // 限制单页最大条数，防止恶意大请求
        const safeLimit = Math.min(Math.max(1, limit), 100);
        const safePage = Math.max(1, page);
        const offset = (safePage - 1) * safeLimit;

        const { rows, count } = await PlayerStateLog.findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: safeLimit,
            offset
        });

        return {
            logs: rows,
            total: count,
            currentPage: safePage,
            totalPages: Math.ceil(count / safeLimit)
        };
    }

    /**
     * 查询最近的异常状态变更
     * 用于监控告警，返回 action='error' 的最近记录
     * @param {number} [limit=10] - 返回条数
     * @returns {Promise<Array>} 异常日志列表
     */
    static async getRecentErrors(limit = 10) {
        const safeLimit = Math.min(Math.max(1, limit), 50);
        return await PlayerStateLog.findAll({
            where: { action: 'error' },
            order: [['createdAt', 'DESC']],
            limit: safeLimit
        });
    }

    /**
     * 清理过期日志（定期维护）
     * 默认保留 30 天的日志
     * @param {number} [retainDays=30] - 保留天数
     * @returns {Promise<number>} 删除的记录数
     */
    static async cleanOldLogs(retainDays = 30) {
        const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
        const result = await PlayerStateLog.destroy({
            where: {
                createdAt: { [Op.lt]: cutoff }
            }
        });
        return result;
    }
}

module.exports = StateLogService;
