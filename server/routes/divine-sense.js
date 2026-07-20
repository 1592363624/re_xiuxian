/**
 * 神识淬炼系统玩家路由
 *
 * 提供玩家端神识淬炼系统的 HTTP 接口：
 *   1. GET  /api/divine-sense/profile：获取神识面板
 *   2. POST /api/divine-sense/quench：神识淬炼（100 香火 = 1 神识）
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 DivineSenseService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第4.4节（神识淬炼系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const DivineSenseService = require('../game/services/DivineSenseService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * @param {Object} result - Service 返回的 { success, message, data }
 * @param {Object} res - Express 响应对象
 */
function sendServiceResult(result, res) {
    if (result.success) {
        return res.json({
            code: 200,
            message: result.message || 'success',
            data: result.data || null
        });
    }
    return res.json({
        code: 200,
        success: false,
        message: result.message,
        data: result.data || null,
        error_code: result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR
    });
}

/**
 * GET /api/divine-sense/profile
 * 获取神识面板数据（神识余额/上限/恢复速率/淬炼次数/CD/用途消耗表）
 * 该接口为只读操作，不需要状态机互斥校验
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await DivineSenseService.getProfile(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/divine-sense/quench
 * 神识淬炼（100 香火 = 1 神识，每日 3 次，CD 1 小时）
 * 请求体：{ amount: number(1-100) }
 */
router.post('/quench', auth, async (req, res, next) => {
    try {
        const { amount } = req.body;
        const amountNum = Number(amount);
        if (!Number.isInteger(amountNum) || amountNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'amount 必须为正整数'
            });
        }
        const result = await DivineSenseService.quench(req.player.id, amountNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
