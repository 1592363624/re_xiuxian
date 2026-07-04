/**
 * 玩家状态聚合服务（插件式架构版本）
 *
 * 设计目的：
 *   修仙游戏存在多种"进行中"状态（闭关/战斗/历练/移动），分散在 Player 表和独立表中。
 *   前端断线重连后需要一次性获取所有进行中状态的快照，避免分别调用 3 个接口导致的中间态不一致窗口。
 *   本服务作为"状态聚合层"，统一从各 Service 读取状态并组装为单一快照。
 *
 * 架构演进：
 *   v1（硬编码版）：在本文件中写死 4 种状态的查询逻辑
 *   v2（插件式版，当前）：通过 StateRegistry 遍历所有已注册的状态处理器，调用其 getSnapshot
 *                        新增玩法只需在 registrations/ 下新增注册文件，本文件无需修改
 *
 * 使用场景：
 *   1. Socket 重连时（WebSocketNotificationService.io.on('connection')）主动推送状态快照
 *   2. /api/player/state 聚合接口（替代前端分别调 3 个 fetch）
 *
 * 设计原则：
 *   1. 只读：本服务不修改任何状态，仅负责查询和组装
 *   2. 容错：单个状态查询失败不阻塞整体快照返回
 *   3. 开闭原则：新增玩法无需修改本文件
 */
'use strict';

const StateRegistry = require('../state/StateRegistry');

class PlayerStateService {
    /**
     * 获取玩家进行中状态的完整快照
     * 通过 StateRegistry 遍历所有已注册的状态处理器，调用其 getSnapshot
     * @param {number} playerId - 玩家ID
     * @returns {Object} 状态快照 {
     *   player_id, server_time,
     *   states: { [stateType]: { ...状态快照... } },
     *   active_enums: ['SECLUDED', 'IN_BATTLE']  // 当前激活的状态枚举列表
     * }
     */
    static async getStateSnapshot(playerId) {
        const snapshot = {
            player_id: playerId,
            server_time: new Date().toISOString(),
            states: {},
            active_enums: []
        };

        if (!playerId) return snapshot;

        // 通过注册中心遍历所有状态处理器，调用 getSnapshot
        const results = await StateRegistry.mapAll(async (stateType, handler) => {
            return await handler.getSnapshot(playerId);
        });

        // 整理快照结果
        for (const result of results) {
            snapshot.states[result.stateType] = result.result;
            // 收集激活的状态枚举
            if (result.success && result.result) {
                // 检查快照中是否有激活标志
                const isActive = Object.values(result.result).some(v => v === true);
                if (isActive) {
                    const handler = StateRegistry.get(result.stateType);
                    if (handler?.metadata?.stateEnum) {
                        snapshot.active_enums.push(handler.metadata.stateEnum);
                    }
                }
            }
        }

        return snapshot;
    }

    /**
     * 获取玩家当前激活的状态枚举列表（轻量版，仅返回枚举值）
     * 通过 StateRegistry 各 handler 的 getActiveState 方法收集
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Array<{stateType: string, stateEnum: string, displayName: string}>>}
     */
    static async getActiveStates(playerId) {
        const activeStates = [];
        const entries = StateRegistry.list();
        for (const { stateType, handler } of entries) {
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
                    console.warn(`[PlayerStateService] 查询 ${stateType} 激活状态失败:`, err.message);
                }
            }
        }
        return activeStates;
    }
}

module.exports = PlayerStateService;
