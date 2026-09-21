/**
 * JSON 文本列的读取helper：空值给默认，损坏必须响。
 *
 * 为什么不允许 `catch { return [] }`：读出来是空，下一次写入就把"空"落回库里，
 * 玩家那一列数据就这么消失了 —— 和"旧快照覆盖新快照"是同一类静默数据丢失。
 * 仓库里 40 多个 JSON 列本来就没有 try/catch（坏了直接抛），这 11 列是例外，现在对齐。
 */
'use strict';

/**
 * @param {string} modelName 模型名（报错时用，便于定位表）
 * @param {string} fieldName 字段名
 * @param {*} raw 列里存的原始值
 * @param {any} fallback 空值时的默认（[] / {} / null）
 * @returns {any} 解析结果或 fallback
 * @throws 内容是坏 JSON 时抛错，错误里带模型.字段与前 60 个字符
 */
function readJsonColumn(modelName, fieldName, raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    if (typeof raw === 'object') return raw;            // 有的库驱动已按 JSON 列返回对象
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `${modelName}.${fieldName} 存的不是合法 JSON（${String(raw).slice(0, 60)}…）：${error.message}；`
            + '把它读成空再写回去会抹掉这一列的数据，所以直接抛'
        );
    }
}

module.exports = { readJsonColumn };
