/**
 * 接口网关模块
 * 负责统一处理 API 请求的路由分发、权限校验、参数验证和响应格式化
 * 应用服务层的核心入口
 */
const express = require('express');
const router = express.Router();

const responseFormatter = (res) => ({
    success: (data, message = 'success') => {
        res.json({ code: 200, data, message });
    },
    error: (message, code = 500, data = null) => {
        res.status(code).json({ code, message, data });
    },
    paginate: (items, total, page, pageSize) => {
        res.json({
            code: 200,
            data: {
                items,
                pagination: {
                    total,
                    page,
                    pageSize,
                    totalPages: Math.ceil(total / pageSize)
                }
            },
            message: 'success'
        });
    }
});

router.use((req, res, next) => {
    req.resFormatter = responseFormatter(res);
    next();
});

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

const requireAuth = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ code: 401, message: '未登录或登录已过期' });
    }
    next();
};

const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ code: 401, message: '未登录或登录已过期' });
        }
        // 角色以数据库（req.player.role）为准，与各 adminCheck 同一口径。
        // JWT 载荷只有 { id, username, v }，不含 role；即便写入也会在
        // 升/降管理员、封禁后过期。原先读 req.user.role 对所有合法 token
        // 都拿到 undefined，导致公告配图上传等 requireRole 接口永远 403。
        const role = req.player?.role ?? req.user.role;
        if (!roles.includes(role)) {
            return res.status(403).json({ code: 403, message: '权限不足' });
        }
        next();
    };
};

router.asyncHandler = asyncHandler;
router.requireAuth = requireAuth;
router.requireRole = requireRole;

module.exports = router;
