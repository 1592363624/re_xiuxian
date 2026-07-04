/**
 * 玩家状态注册中心
 *
 * 设计目的：
 *   修仙游戏存在多种"进行中"临时状态（闭关/战斗/历练/移动/封禁...），
 *   新增玩法时若每加一种状态就要修改 StateCleanerService/PlayerStateService/PlayerStateMachine，
 *   会违反开闭原则，导致核心代码不断膨胀且容易引入 bug。
 *
 *   本注册中心作为"插件式架构"的入口，让每个玩法模块通过 register() 注册自己的状态处理逻辑，
 *   核心服务（Cleaner/StateService/StateMachine）通过遍历注册表统一调度，无需感知具体玩法。
 *
 * 使用方式：
 *   // 在玩法模块启动时注册（如 server/game/state/registrations/seclusion.js）
 *   StateRegistry.register('seclusion', {
 *     metadata: { displayName: '闭关', exclusive: true },
 *     getSnapshot: async (playerId) => { ... },
 *     cleanExpired: async (ctx) => { ... },
 *     canTransitionTo: (newState, currentStates) => { ... }
 *   });
 *
 * 设计原则：
 *   1. 开闭原则：新增玩法只需新增注册文件，不修改核心服务
 *   2. 单一职责：注册中心只负责存储和遍历，不包含业务逻辑
 *   3. 容错隔离：单个玩法注册失败或执行异常不影响其他玩法
 *   4. 可观测性：提供 list() 方法供运维查询已注册的状态类型
 */
'use strict';

/**
 * @typedef {Object} StateHandler
 * @property {Object} metadata - 状态元信息
 * @property {string} metadata.displayName - 显示名称（如"闭关"/"战斗"）
 * @property {boolean} [metadata.exclusive] - 是否互斥状态（同时只能有一个进行中）
 * @property {string} [metadata.stateEnum] - 状态枚举值（如 'SECLUDED'）
 * @property {Function} getSnapshot - 获取玩家在此状态下的快照
 * @property {Function} cleanExpired - 清理过期状态（批量）
 * @property {Function} [canTransitionTo] - 状态转移校验（可选）
 * @property {Function} [getActiveState] - 获取玩家当前激活的状态枚举（可选，用于互斥校验）
 */
class StateRegistry {
    constructor() {
        /** @type {Map<string, StateHandler>} 状态处理器映射表 */
        this._handlers = new Map();
        /** @type {Map<string, number>} 注册顺序（用于稳定遍历顺序） */
        this._order = new Map();
        this._nextOrder = 0;
    }

    /**
     * 注册一个状态处理器
     * @param {string} stateType - 状态类型唯一标识（如 'seclusion'/'combat'/'adventure'）
     * @param {StateHandler} handler - 状态处理器
     * @throws {Error} 重复注册或参数不合法时抛错
     */
    register(stateType, handler) {
        if (!stateType || typeof stateType !== 'string') {
            throw new Error(`[StateRegistry] stateType 必须是非空字符串，收到: ${stateType}`);
        }
        if (!handler || typeof handler !== 'object') {
            throw new Error(`[StateRegistry] handler 必须是对象，收到: ${typeof handler}`);
        }
        if (typeof handler.getSnapshot !== 'function') {
            throw new Error(`[StateRegistry] ${stateType} 缺少 getSnapshot 方法`);
        }
        if (typeof handler.cleanExpired !== 'function') {
            throw new Error(`[StateRegistry] ${stateType} 缺少 cleanExpired 方法`);
        }
        if (this._handlers.has(stateType)) {
            console.warn(`[StateRegistry] 状态类型 "${stateType}" 已注册，将被覆盖`);
        }
        this._handlers.set(stateType, handler);
        this._order.set(stateType, this._nextOrder++);
        console.log(`[StateRegistry] 状态 "${stateType}" 已注册 (${handler.metadata?.displayName || '未命名'})`);
    }

    /**
     * 注销一个状态处理器（一般不需要，仅用于测试或热更新）
     * @param {string} stateType - 状态类型
     */
    unregister(stateType) {
        this._handlers.delete(stateType);
        this._order.delete(stateType);
    }

    /**
     * 获取单个状态处理器
     * @param {string} stateType - 状态类型
     * @returns {StateHandler|undefined}
     */
    get(stateType) {
        return this._handlers.get(stateType);
    }

    /**
     * 获取所有已注册的状态处理器（按注册顺序排序）
     * @returns {Array<{stateType: string, handler: StateHandler}>}
     */
    list() {
        return Array.from(this._handlers.entries())
            .map(([stateType, handler]) => ({ stateType, handler }))
            .sort((a, b) => (this._order.get(a.stateType) || 0) - (this._order.get(b.stateType) || 0));
    }

    /**
     * 遍历所有注册的状态处理器并执行回调
     * 容错设计：单个 handler 抛错不影响其他 handler
     * @param {Function} callback - 回调 (stateType, handler) => Promise<any>
     * @returns {Promise<Array<{stateType: string, success: boolean, result: any, error: string|null}>>}
     */
    async mapAll(callback) {
        const results = [];
        for (const { stateType, handler } of this.list()) {
            try {
                const result = await callback(stateType, handler);
                results.push({ stateType, success: true, result, error: null });
            } catch (err) {
                results.push({ stateType, success: false, result: null, error: err.message });
                console.error(`[StateRegistry] 处理器 "${stateType}" 执行失败:`, err.message);
            }
        }
        return results;
    }

    /**
     * 清空所有注册（仅用于测试）
     */
    clear() {
        this._handlers.clear();
        this._order.clear();
        this._nextOrder = 0;
    }
}

// 单例导出，全局共享一个注册中心
const registry = new StateRegistry();

module.exports = registry;
module.exports.StateRegistry = StateRegistry;
