/**
 * 状态注册中心入口
 *
 * 在服务启动时统一调用 registerAll()，将所有玩法模块的状态处理器注册到 StateRegistry。
 * 新增玩法时：
 *   1. 在本目录下创建 registrations/xxx.js
 *   2. 在下方 registerAll() 中添加一行 require('./registrations/xxx')();
 *
 * 这样核心服务（StateCleanerService/PlayerStateService/PlayerStateMachine）无需感知具体玩法，
 * 实现开闭原则。
 */
'use strict';

const StateRegistry = require('./StateRegistry');

/**
 * 注册所有玩法模块的状态处理器
 * 在 server/index.js 启动时调用一次
 */
function registerAllStates() {
    console.log('[StateRegistry] 开始注册玩家状态处理器...');

    // 闭关状态
    require('./registrations/seclusion')();

    // 战斗状态
    require('./registrations/combat')();

    // 历练状态
    require('./registrations/adventure')();

    // 移动状态（注：移动的过期清理由 index.js 专用定时任务处理，此处仅注册快照和互斥校验）
    require('./registrations/moving')();

    // 静思悟道状态（第三阶段新增：与闭关/战斗/历练/移动互斥，过期自动结算感悟值）
    require('./registrations/meditation')();

    // PVP 斗法状态（第四阶段新增：与一切状态互斥，过期自动判平结算）
    require('./registrations/pvp')();

    // 元婴出窍状态（高阶境界扩展：与一切状态互斥，过期自动结算修为收益）
    require('./registrations/nascent_soul')();

    // 副本挑战状态（第五阶段新增：与一切状态互斥，过期自动结算失败并清理进度）
    require('./registrations/dungeon')();

    // 封禁状态
    require('./registrations/ban')();

    const count = StateRegistry.list().length;
    console.log(`[StateRegistry] 状态处理器注册完成，共 ${count} 个`);
}

module.exports = {
    StateRegistry,
    registerAllStates
};
