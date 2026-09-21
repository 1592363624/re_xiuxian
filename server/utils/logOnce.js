/**
 * 只报一次的错误日志。
 *
 * 兜底分支（"配置读不到就按未配置处理"）本身是刻意的 fail-closed，
 * 但一声不响会让"面板永远空"没有任何线索；而高频路径上每调一次打一行又会把日志刷爆。
 * 所以：同一个 key 只打一次，够定位，不刷屏。
 */
'use strict';

const seen = new Set();

/**
 * @param {string} key 去重键，约定用 `服务名.方法名`
 * @param {string} message 说明（会带 [key] 前缀）
 */
function logOnce(key, message) {
    if (seen.has(key)) return;
    seen.add(key);
    console.error(`[${key}] ${message}`);
}

/** 测试用：清空已记录过的 key */
function resetLogOnce() { seen.clear(); }

module.exports = { logOnce, resetLogOnce };
