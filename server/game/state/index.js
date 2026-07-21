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

    // 世界BOSS讨伐状态（批次2多人玩法：与一切状态互斥，玩家需先撤退才能开始其他操作）
    require('./registrations/worldBoss')();

    // 宗门战参战状态（批次2多人玩法：与一切状态互斥，玩家需先离开战役才能开始其他操作）
    require('./registrations/sectWar')();

    // 飞升状态（批次3：与一切状态互斥，飞升尝试超时10分钟自动失败）
    require('./registrations/ascension')();

    // 夺舍状态（批次3：与一切状态互斥，超时30分钟强制随机选定目标）
    require('./registrations/reincarnation')();

    // 闭关双修状态（玩家间道侣 1v1 长期社交：与一切状态互斥，时间戳自然过期）
    require('./registrations/dualCultivation')();

    // 妖兽入侵斩妖状态（多人公共事件：与一切状态互斥，玩家需先撤退才能开始其他操作）
    require('./registrations/beastInvasion')();

    // 封禁状态
    require('./registrations/ban')();

    const count = StateRegistry.list().length;
    console.log(`[StateRegistry] 状态处理器注册完成，共 ${count} 个`);
}

module.exports = {
    StateRegistry,
    registerAllStates
};
