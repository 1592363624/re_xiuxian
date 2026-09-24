/**
 * 写操作请求防重放 + 签名校验中间件。
 *
 * 挡的是两类简单作弊：
 *   1. 抓包后原样重放（CE 加速后狂发同一领取包）—— 时间戳过期 / nonce 已用过；
 *   2. 抓包后改 body 再发 —— HMAC 覆盖 method+url+body，改完签名对不上。
 *
 * 模式（环境变量 REQUEST_GUARD）：
 *   enforce —— 默认（非测试）。缺头/验不过一律 401/400
 *   log     —— 只记日志放行（灰度观察用）
 *   off     —— 完全关闭（本地调试）
 * 测试进程（JEST_WORKER_ID）默认 off，避免单测被拦。
 *
 * 依赖 JWT 载荷里的 rk（见 LoginSession.issueLoginToken）。旧令牌没有 rk 时
 * enforce 模式返回 401，提示重新登录——不能静默降级成"不验签"，否则等于没开。
 */
'use strict';

const jwt = require('jsonwebtoken');
const {
    signRequest,
    safeEqualHex,
    isTimestampFresh,
    isWellFormedNonce
} = require('../utils/requestSign');

/**
 * 不需要签名的路径前缀（完整 originalUrl 口径，含 /api）：
 * 登录注册尚未拿到 rk；健康检查与 multipart 上传另议。
 */
const SKIP_PATH_PREFIXES = [
    '/api/auth',
    '/api/health',
    '/api/uploads'
];

/** 内存 nonce 池：单进程部署够用。键 = nonce，值 = 过期时间戳 */
const noncePool = new Map();
const NONCE_TTL_MS = 120_000; // 略大于时间戳容忍窗，窗口外的包连 nonce 都不用查
const NONCE_POOL_MAX = 50_000;

let lastSweepAt = 0;

function sweepNonces(now = Date.now()) {
    if (now - lastSweepAt < 30_000 && noncePool.size < NONCE_POOL_MAX) return;
    lastSweepAt = now;
    for (const [key, expireAt] of noncePool) {
        if (expireAt <= now) noncePool.delete(key);
    }
    // 兜底：异常洪水时硬砍最老的一批，保证内存有界
    if (noncePool.size > NONCE_POOL_MAX) {
        const overflow = noncePool.size - NONCE_POOL_MAX;
        let i = 0;
        for (const key of noncePool.keys()) {
            noncePool.delete(key);
            if (++i >= overflow) break;
        }
    }
}

/**
 * 记账一个 nonce。已存在返回 false（重放）。
 * @returns {boolean} true = 首次出现
 */
function claimNonce(nonce, now = Date.now()) {
    sweepNonces(now);
    if (noncePool.has(nonce)) return false;
    noncePool.set(nonce, now + NONCE_TTL_MS);
    return true;
}

function resolveMode() {
    // 显式配置优先：单测可以 REQUEST_GUARD=enforce 打开拦截做断言
    const raw = String(process.env.REQUEST_GUARD || '').trim().toLowerCase();
    if (raw === 'off' || raw === 'log' || raw === 'enforce') return raw;
    // 未配置：Jest 默认 off（避免历史单测全被拦），其余环境 enforce
    if (process.env.JEST_WORKER_ID) return 'off';
    return 'enforce';
}

function shouldSkip(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    // 必须用 originalUrl：中间件挂在 app.use('/api', …) 下时 req.path 已被剥掉 /api
    // （登录 /api/auth/login 会变成 /auth/login），只拿 req.path 匹配 SKIP 前缀会漏，
    // 表现就是「登录也要求签名头」——用户卡在登录页。
    const fullPath = String(req.originalUrl || '').split('?')[0];
    const mountPath = String(req.path || '').split('?')[0];
    return SKIP_PATH_PREFIXES.some((prefix) => {
        const short = prefix.replace(/^\/api/, '') || '/'; // '/auth' | '/health' | '/uploads'
        return fullPath === prefix
            || fullPath.startsWith(prefix + '/')
            || mountPath === short
            || mountPath.startsWith(short + '/');
    });
}

/** 从 Authorization Bearer JWT 里取出 rk（只 decode 不 verify 的场景不走这里） */
function extractRequestKey(req) {
    const header = req.header('Authorization') || '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) return { error: '未提供认证令牌，拒绝访问', status: 401 };

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
        return { error: '令牌无效或已过期', status: 401 };
    }
    if (!decoded.rk || typeof decoded.rk !== 'string') {
        return { error: '会话缺少请求签名密钥，请重新登录', status: 401, code: 'REQUEST_KEY_MISSING' };
    }
    return { rk: decoded.rk, decoded };
}

/**
 * Express 中间件：挂在 express.json({ verify }) 之后、业务路由之前。
 * 建议挂在 /api 上，与限流同级。
 */
function requestGuard(req, res, next) {
    const mode = resolveMode();
    if (mode === 'off' || shouldSkip(req)) return next();

    const fail = (status, message, code) => {
        if (mode === 'log') {
            console.warn(`[requestGuard] 放行但违规 ${req.method} ${req.originalUrl}: ${message}`);
            return next();
        }
        return res.status(status).json({ code: status, message, error_code: code || 'REQUEST_GUARD' });
    };

    const timestamp = req.header('X-Request-Timestamp');
    const nonce = req.header('X-Request-Nonce');
    const signature = req.header('X-Request-Signature');

    if (!timestamp || !nonce || !signature) {
        return fail(401, '缺少请求签名头，请刷新页面后重试', 'REQUEST_SIGN_MISSING');
    }
    if (!isTimestampFresh(timestamp)) {
        return fail(401, '请求时间戳已过期，请重试', 'REQUEST_STALE');
    }
    if (!isWellFormedNonce(nonce)) {
        return fail(400, '请求 nonce 非法', 'REQUEST_NONCE_INVALID');
    }

    const keyResult = extractRequestKey(req);
    if (keyResult.error) {
        return fail(keyResult.status, keyResult.error, keyResult.code);
    }

    // 先占 nonce 再验签：验签失败也消耗 nonce，避免同一 nonce 无限试签
    if (!claimNonce(nonce)) {
        return fail(401, '检测到重复请求，已拒绝', 'REQUEST_REPLAYED');
    }

    const expected = signRequest(keyResult.rk, {
        method: req.method,
        url: req.originalUrl,
        timestamp,
        nonce,
        rawBody: req.rawBody
    });

    if (!safeEqualHex(expected, String(signature).toLowerCase())) {
        return fail(400, '请求签名校验失败', 'REQUEST_SIGN_INVALID');
    }

    return next();
}

/** 测试用：清空 nonce 池 */
function resetNoncePool() {
    noncePool.clear();
    lastSweepAt = 0;
}

module.exports = {
    requestGuard,
    claimNonce,
    resetNoncePool,
    resolveMode,
    shouldSkip,
    extractRequestKey,
    SKIP_PATH_PREFIXES
};
