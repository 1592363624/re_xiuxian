/**
 * 统一异常处理中间件
 * 
 * 提供标准化的错误类和错误处理逻辑，确保所有 API 返回一致的错误格式
 */

/**
 * 应用级错误类
 * 用于表示可预期的业务错误（isOperational = true），
 * 区别于系统级未预期错误
 */
class AppError extends Error {
    constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * 标准错误码
 * 扩展错误码用于器灵系统等新模块细分业务场景，便于前端精确识别
 */
const ErrorCodes = {
    // 业务错误 (4xx)
    UNAUTHORIZED: 'UNAUTHORIZED',
    BAD_REQUEST: 'BAD_REQUEST',
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    BUSINESS_LOGIC_ERROR: 'BUSINESS_LOGIC_ERROR',

    // 扩展业务错误（器灵/法宝/养成系统细分场景）
    FEATURE_DISABLED: 'FEATURE_DISABLED',              // 功能未开启
    REALM_NOT_ENOUGH: 'REALM_NOT_ENOUGH',              // 境界不足
    EQUIPMENT_BROKEN: 'EQUIPMENT_BROKEN',              // 装备已破碎
    ALREADY_EXISTS: 'ALREADY_EXISTS',                  // 资源已存在（重复操作）
    LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',                  // 次数/额度超限
    CONDITION_NOT_MET: 'CONDITION_NOT_MET',            // 前置条件不满足
    COOLDOWN: 'COOLDOWN',                              // 冷却中
    INSUFFICIENT_RESOURCES: 'INSUFFICIENT_RESOURCES',  // 资源不足（灵石/物品）
    PLAYER_DEAD: 'PLAYER_DEAD',                         // 玩家已陨落

    // 系统错误 (5xx)
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
    CONFIG_ERROR: 'CONFIG_ERROR'
};

/**
 * Express 全局错误处理中间件
 * 必须放在所有路由之后注册
 */
function errorHandler(err, req, res, next) {
    const statusCode = err.statusCode || 500;
    const errorCode = err.errorCode || ErrorCodes.INTERNAL_ERROR;
    const message = err.isOperational ? err.message : '服务器错误';

    // 仅记录非业务错误的完整堆栈
    if (err.isOperational) {
        console.warn(`[${errorCode}] ${err.message}`);
    } else {
        console.error(`[${errorCode}] ${err.message}`, err.stack);
    }

    res.status(statusCode).json({
        code: statusCode,
        error_code: errorCode,
        message: message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
}

module.exports = { errorHandler, AppError, ErrorCodes };
