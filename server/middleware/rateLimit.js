/**
 * 限流中间件
 *
 * 用途：压制脚本刷接口——重复提交领奖、批量试密码、高频扫交易行等最容易实施的作弊。
 * 阈值按"单个玩家正常游戏轮询量的数倍"设定，避免误伤在线玩家。
 *
 * 注意：限流键取 req.ip。服务部署在反向代理之后时必须通过环境变量 TRUST_PROXY_HOPS
 * 声明代理层数（见 index.js），否则所有玩家会共用同一个 IP 计数。
 */
const { rateLimit } = require('express-rate-limit');
const { infrastructure } = require('../modules');

/** game_balance.rate_limit 缺失时的兜底阈值（次数 / 窗口秒数） */
const DEFAULT_LIMITS = {
    api: { limit: 600, window_seconds: 60 },
    action: { limit: 120, window_seconds: 60 },
    auth: { limit: 10, window_seconds: 900 },
    admin: { limit: 200, window_seconds: 60 }
};

/** 触发限流时返回给客户端的提示 */
const LIMIT_MESSAGES = {
    api: '请求过于频繁，请稍后再试',
    action: '操作过于频繁，请稍后再试',
    auth: '登录尝试过于频繁，请稍后再试',
    admin: '后台操作过于频繁，请稍后再试'
};

/**
 * 读取限流配置
 * ConfigLoader.getConfig 对未加载配置会抛错，这里统一兜底为默认阈值，
 * 保证限流不会因配置缺失而失效
 * @returns {Object} 与 DEFAULT_LIMITS 同结构、逐字段兜底的配置
 */
function getRateLimitConfig() {
    let configured = {};
    try {
        configured = infrastructure.ConfigLoader?.getConfig('game_balance')?.rate_limit || {};
    } catch (e) {
        console.warn('[限流] 读取 game_balance.rate_limit 失败，使用默认阈值:', e.message);
    }

    const merge = (fallback, override = {}) => ({
        limit: Number.isFinite(override.limit) && override.limit > 0 ? override.limit : fallback.limit,
        window_seconds: Number.isFinite(override.window_seconds) && override.window_seconds > 0
            ? override.window_seconds
            : fallback.window_seconds
    });

    return {
        api: merge(DEFAULT_LIMITS.api, configured.api),
        action: merge(DEFAULT_LIMITS.action, configured.action),
        auth: merge(DEFAULT_LIMITS.auth, configured.auth),
        admin: merge(DEFAULT_LIMITS.admin, configured.admin)
    };
}

/** 当前生效的限流器实例，键名同 DEFAULT_LIMITS */
const activeLimiters = {};

/**
 * 按当前配置重建所有限流器
 * 必须在请求处理之外调用（express-rate-limit 禁止在请求处理器内创建限流器）
 */
function rebuildLimiters() {
    const config = getRateLimitConfig();
    for (const key of Object.keys(DEFAULT_LIMITS)) {
        activeLimiters[key] = rateLimit({
            windowMs: config[key].window_seconds * 1000,
            limit: config[key].limit,
            standardHeaders: 'draft-7',
            legacyHeaders: false,
            handler: (req, res) => res.status(429).json({ code: 429, message: LIMIT_MESSAGES[key] })
        });
    }
}

// 模块加载即按默认阈值建好，保证配置未就绪时也有防护
rebuildLimiters();

/**
 * 配置加载完成后调用，改用 game_balance.rate_limit 中的运营阈值
 */
function initializeRateLimiters() {
    rebuildLimiters();
}

/**
 * 生成引用当前限流器的中间件（重建后自动生效）
 * @param {string} key - 限流档位：api / action / auth / admin
 * @returns {Function} Express 中间件
 */
function limiterFor(key) {
    return (req, res, next) => activeLimiters[key](req, res, next);
}

/** 全局 API 限流（含查询轮询） */
const apiLimiter = limiterFor('api');
/** 玩法写操作限流（开始闭关、抽奖、扫荡等领奖类接口） */
const actionLimiter = limiterFor('action');
/** 登录/注册限流（防撞库与暴力枚举） */
const authLimiter = limiterFor('auth');
/** GM 后台限流 */
const adminLimiter = limiterFor('admin');

module.exports = {
    apiLimiter,
    actionLimiter,
    authLimiter,
    adminLimiter,
    initializeRateLimiters,
    getRateLimitConfig
};
