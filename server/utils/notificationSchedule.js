/**
 * 公告定时字段的解析与校验
 *
 * 前端用的是 `<input type="datetime-local">`，它给出的是**不带时区**的 "YYYY-MM-DDTHH:mm"。
 * 服务进程已统一把 TZ 设为 Asia/Shanghai（见 index.js 顶部），因此 `new Date(该字符串)`
 * 正是按北京时间理解 —— 与库里其它时间列的口径一致，不需要手工 +8 小时。
 *
 * 解析失败一律抛 AppError(400) 而不是静默当作 null：GM 手填错格式却"看起来保存成功"，
 * 会变成一条永不发布（或永不下架）的公告，排查成本远高于当场提示。
 */
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 解析一个可选的定时时间
 * @param {*} value - 请求体里的值（字符串 / null / 空串 / Date）
 * @param {string} label - 字段中文名，用于错误文案（如"预约发布时间"）
 * @returns {Date|null} 空值返回 null（表示不限制）
 * @throws {AppError} 格式非法时抛 400
 */
function parseScheduleTime(value, label) {
    if (value === undefined || value === null || value === '') return null;

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new AppError(`${label}格式不正确，应为 YYYY-MM-DDTHH:mm`, 400, ErrorCodes.VALIDATION_ERROR);
    }
    return date;
}

/**
 * 校验发布时间与下架时间的先后关系
 * @param {Date|null} publishAt - 预约发布时间
 * @param {Date|null} expiresAt - 自动下架时间
 * @throws {AppError} 下架时间早于发布时间时抛 400
 */
function validateScheduleRange(publishAt, expiresAt) {
    if (publishAt && expiresAt && expiresAt.getTime() <= publishAt.getTime()) {
        throw new AppError('自动下架时间必须晚于预约发布时间', 400, ErrorCodes.VALIDATION_ERROR);
    }
}

/**
 * 一次性解析并校验两个字段
 * @param {Object} body - 请求体
 * @returns {{publishAt: Date|null, expiresAt: Date|null}}
 */
function parseAnnouncementSchedule(body = {}) {
    const publishAt = parseScheduleTime(body.publishAt, '预约发布时间');
    const expiresAt = parseScheduleTime(body.expiresAt, '自动下架时间');
    validateScheduleRange(publishAt, expiresAt);
    return { publishAt, expiresAt };
}

module.exports = { parseScheduleTime, validateScheduleRange, parseAnnouncementSchedule };
