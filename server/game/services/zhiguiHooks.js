/**
 * 指归（系统任务）动作上报 —— 业务成功路径末尾的一行调用。
 * 故意 fire-and-forget + 延后一拍：指归失败绝不影响原业务；
 * 延后是为了避开调用方尚未 commit 的外层事务，避免嵌套锁与半截快照。
 */
'use strict';

function zhigui(playerId, action, meta) {
    setImmediate(() => {
        try {
            require('./SystemQuestService').onAction(playerId, action, meta || {}).catch(() => {});
        } catch { /* 服务未就绪时静默 */ }
    });
}

module.exports = zhigui;

