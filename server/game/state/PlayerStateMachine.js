/**
 * 玩家状态机
 *
 * 设计目的：
 *   统一管理玩家"进行中"状态的互斥校验，避免散落在各 route 中的零散判断。
 *   例如：闭关中能否开始战斗？移动中能否开始历练？战斗中能否开始闭关？
 *
 *   状态机通过 StateRegistry 收集所有已注册状态的当前激活情况，
 *   根据各状态注册时声明的 exclusive 和 canTransitionTo 规则统一校验。
 *
 * 使用方式：
 *   // 在 route 中开始新状态前调用
 *   const check = await PlayerStateMachine.canStart(playerId, 'SECLUDED');
 *   if (!check.allowed) {
 *     throw new AppError(check.reason, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
 *   }
 *
 * 状态枚举约定：
 *   IDLE - 空闲（无任何进行中状态）
 *   SECLUDED - 闭关中
 *   IN_BATTLE - 战斗中
 *   ADVENTURING - 历练中
 *   MOVING - 移动中
 *   BANNED - 封禁中（特殊状态，禁止一切操作）
 *   MEDITATING - 静思悟道中（与闭关互斥）
 *   IN_PVP_BATTLE - PVP斗法中（与一切状态互斥）
 *   新增玩法可注册自定义枚举值
 *
 * 互斥规则（默认）：
 *   - 战斗（IN_BATTLE）与一切互斥
 *   - 闭关（SECLUDED）与一切互斥
 *   - 移动（MOVING）与一切互斥
 *   - 历练（ADVENTURING）与一切互斥
 *   - 封禁（BANNED）禁止一切新状态
 *   - 各状态可通过 canTransitionTo 自定义例外（如允许移动中触发历练）
 */
'use strict';

const StateRegistry = require('./StateRegistry');

/**
 * 状态枚举常量（与各注册模块保持一致）
 * 新增玩法可在此扩展，或在自己的注册文件中定义后引用
 */
const PlayerState = Object.freeze({
    IDLE: 'IDLE',
    SECLUDED: 'SECLUDED',
    IN_BATTLE: 'IN_BATTLE',
    ADVENTURING: 'ADVENTURING',
    MOVING: 'MOVING',
    BANNED: 'BANNED',
    MEDITATING: 'MEDITATING',  // 静思悟道中（与闭关互斥）
    IN_PVP_BATTLE: 'IN_PVP_BATTLE'  // PVP斗法中（与一切状态互斥）
});

class PlayerStateMachine {
    /**
     * 获取玩家当前所有激活的状态枚举列表
     * 通过遍历注册中心各 handler 的 getActiveState 方法收集
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Array<{stateType: string, stateEnum: string, displayName: string}>>}
     */
    static async getActiveStates(playerId) {
        const activeStates = [];
        const entries = StateRegistry.list();
        for (const { stateType, handler } of entries) {
            // 仅当 handler 声明了 getActiveState 且返回非空才认为该状态激活
            if (typeof handler.getActiveState === 'function') {
                try {
                    const stateEnum = await handler.getActiveState(playerId);
                    if (stateEnum) {
                        activeStates.push({
                            stateType,
                            stateEnum,
                            displayName: handler.metadata?.displayName || stateType
                        });
                    }
                } catch (err) {
                    // 单个状态查询失败不阻塞其他状态
                    console.warn(`[PlayerStateMachine] 查询 ${stateType} 激活状态失败:`, err.message);
                }
            }
        }
        return activeStates;
    }

    /**
     * 校验玩家是否可以开始新状态
     * @param {number} playerId - 玩家ID
     * @param {string} newStateEnum - 要进入的新状态枚举值
     * @param {Object} [logCtx] - 日志上下文（可选，传入则记录拦截日志）
     * @param {string} [logCtx.source] - 触发来源 (route/cleaner/gm/system)
     * @param {string} [logCtx.stateType] - 目标状态类型 (seclusion/combat/...)
     * @returns {Promise<{allowed: boolean, reason: string, conflict: string|null}>}
     *   - allowed: 是否允许
     *   - reason: 不允许时的原因（用于 AppError 提示）
     *   - conflict: 冲突的状态类型（如 'seclusion'），可用于日志
     */
    static async canStart(playerId, newStateEnum, logCtx = null) {
        const activeStates = await this.getActiveStates(playerId);

        // 无激活状态，允许一切
        if (activeStates.length === 0) {
            return { allowed: true, reason: '', conflict: null };
        }

        // 封禁状态特殊处理：禁止一切新状态
        const banned = activeStates.find(s => s.stateEnum === PlayerState.BANNED);
        if (banned) {
            // 记录被拦截的转移尝试（异步，不阻塞返回）
            this._logBlockedTransition(playerId, logCtx, activeStates, newStateEnum, banned.stateType, '账号已封禁');
            return {
                allowed: false,
                reason: '账号已封禁，无法进行任何操作',
                conflict: banned.stateType
            };
        }

        // 遍历所有激活状态，调用其 canTransitionTo 校验是否允许转移到新状态
        for (const active of activeStates) {
            const handler = StateRegistry.get(active.stateType);
            if (!handler) continue;

            // 优先使用状态自定义的转移校验
            if (typeof handler.canTransitionTo === 'function') {
                const transition = handler.canTransitionTo(newStateEnum, activeStates);
                if (!transition.allowed) {
                    const reason = transition.reason || `${active.displayName}中无法开始此操作`;
                    this._logBlockedTransition(playerId, logCtx, activeStates, newStateEnum, active.stateType, reason);
                    return {
                        allowed: false,
                        reason,
                        conflict: active.stateType
                    };
                }
            } else {
                // 默认规则：exclusive 状态之间互斥
                if (handler.metadata?.exclusive !== false) {
                    const reason = `${active.displayName}中，无法开始此操作`;
                    this._logBlockedTransition(playerId, logCtx, activeStates, newStateEnum, active.stateType, reason);
                    return {
                        allowed: false,
                        reason,
                        conflict: active.stateType
                    };
                }
            }
        }

        return { allowed: true, reason: '', conflict: null };
    }

    /**
     * 内部方法：记录被拦截的状态转移（异步，不阻塞主流程）
     * @private
     */
    static _logBlockedTransition(playerId, logCtx, activeStates, newStateEnum, conflictType, reason) {
        // 仅当传入 logCtx 时才记录，避免纯查询场景产生噪音日志
        if (!logCtx) return;
        try {
            const StateLogService = require('../services/StateLogService');
            const fromSummary = activeStates.map(s => s.stateEnum).join('+') || 'IDLE';
            StateLogService.logStateChange({
                playerId,
                stateType: logCtx.stateType || conflictType,
                action: 'transition',
                fromState: fromSummary,
                toState: newStateEnum,
                source: logCtx.source || 'system',
                details: { blocked: true, conflict: conflictType, reason }
            }).catch(() => { /* 日志失败不影响主流程 */ });
        } catch (e) {
            // StateLogService 加载失败时静默
        }
    }

    /**
     * 记录状态进入（供各 route 在成功进入状态后调用）
     * @param {number} playerId - 玩家ID
     * @param {string} stateType - 状态类型 (seclusion/combat/adventure/moving/ban)
     * @param {string} stateEnum - 状态枚举值
     * @param {Object} [options] - 额外选项
     * @param {string} [options.source='route'] - 触发来源
     * @param {string} [options.fromState] - 进入前的状态枚举（可选，不传则记录为 null）
     * @param {Object|string} [options.details] - 详情
     * @returns {Promise<void>}
     *
     * 注意：fromState 应在状态变更前获取并传入，而非在此方法中查询，
     *       因为此时状态已经变更，查询到的是新状态而非旧状态。
     */
    static async logEnter(playerId, stateType, stateEnum, options = {}) {
        const StateLogService = require('../services/StateLogService');
        await StateLogService.logStateChange({
            playerId,
            stateType,
            action: 'enter',
            fromState: options.fromState || null,  // 由调用方传入旧状态，避免时序问题
            toState: stateEnum,
            source: options.source || 'route',
            details: options.details
        });
    }

    /**
     * 记录状态退出（供各 route 在成功退出状态后调用）
     * @param {number} playerId - 玩家ID
     * @param {string} stateType - 状态类型
     * @param {string} stateEnum - 退出前的状态枚举值
     * @param {Object} [options] - 额外选项
     * @param {string} [options.source='route'] - 触发来源
     * @param {Object|string} [options.details] - 详情
     * @returns {Promise<void>}
     */
    static async logExit(playerId, stateType, stateEnum, options = {}) {
        const StateLogService = require('../services/StateLogService');
        const toSummary = await this.getStateSummary(playerId);
        await StateLogService.logStateChange({
            playerId,
            stateType,
            action: 'exit',
            fromState: stateEnum,
            toState: toSummary,
            source: options.source || 'route',
            details: options.details
        });
    }

    /**
     * 获取玩家状态的简化字符串表示（用于日志和调试）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<string>} 如 "IDLE" 或 "SECLUDED+IN_BATTLE"
     */
    static async getStateSummary(playerId) {
        const activeStates = await this.getActiveStates(playerId);
        if (activeStates.length === 0) return PlayerState.IDLE;
        return activeStates.map(s => s.stateEnum).join('+');
    }
}

module.exports = PlayerStateMachine;
module.exports.PlayerState = PlayerState;
