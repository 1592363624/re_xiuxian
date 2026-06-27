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
 */
const ErrorCodes = {
    // 业务错误 (4xx)
    UNAUTHORIZED: 'UNAUTHORIZED',
    BAD_REQUEST: 'BAD_REQUEST',
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    BUSINESS_LOGIC_ERROR: 'BUSINESS_LOGIC_ERROR',

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
