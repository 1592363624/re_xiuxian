/**
 * 第二元神系统玩家路由
 *
 * 提供玩家端第二元神系统的 HTTP 接口：
 *   1. GET  /api/second-soul/profile：获取第二元神面板
 *   2. POST /api/second-soul/condense：凝练第二元神
 *   3. POST /api/second-soul/divide：分化第三元神
 *   4. POST /api/second-soul/dispatch：切换调度模式（combat/cultivate/scout/defend）
 *   5. POST /api/second-soul/cultivate：开始独立修炼
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 SecondSoulService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 状态机互斥校验在 Service 内部完成（通过 PlayerStateMachine.canStart）
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第4.2节（第二元神系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SecondSoulService = require('../game/services/SecondSoulService');
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
    // 业务失败返回 200 + success:false，便于前端按业务提示处理
    return res.json({
        code: 200,
        success: false,
        message: result.message,
        data: result.data || null,
        error_code: result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR
    });
}

/**
 * GET /api/second-soul/profile
 * 获取第二元神面板数据（主元神/副元神列表、属性、修炼状态、调度状态）
 * 该接口为只读操作，不需要状态机互斥校验
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await SecondSoulService.getProfile(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/second-soul/condense
 * 凝练第二元神（化神期 + 5 类残篇 + 灵石/神识/残魂消耗）
 * 请求体：{ soul_name: string }
 */
router.post('/condense', auth, async (req, res, next) => {
    try {
        const { soul_name } = req.body;
        if (!soul_name || typeof soul_name !== 'string' || soul_name.trim().length === 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'soul_name 必填且必须为非空字符串'
            });
        }
        if (soul_name.length > 50) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'soul_name 长度不能超过 50 个字符'
            });
        }
        const result = await SecondSoulService.condense(req.player.id, soul_name.trim());
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/second-soul/divide
 * 分化第三元神（需第二元神境界≥化神期）
 * 请求体：{ soul_name: string }
 */
router.post('/divide', auth, async (req, res, next) => {
    try {
        const { soul_name } = req.body;
        if (!soul_name || typeof soul_name !== 'string' || soul_name.trim().length === 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'soul_name 必填且必须为非空字符串'
            });
        }
        if (soul_name.length > 50) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'soul_name 长度不能超过 50 个字符'
            });
        }
        const result = await SecondSoulService.divide(req.player.id, soul_name.trim());
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/second-soul/dispatch
 * 切换元神调度模式（combat/cultivate/scout/defend，各模式独立 CD）
 * 请求体：{ soul_index: number(2|3), mode: string }
 */
router.post('/dispatch', auth, async (req, res, next) => {
    try {
        const { soul_index, mode } = req.body;
        if (![2, 3].includes(Number(soul_index))) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'soul_index 必须为 2 或 3'
            });
        }
        if (!['combat', 'cultivate', 'scout', 'defend'].includes(mode)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'mode 必须为 combat/cultivate/scout/defend 之一'
            });
        }
        const result = await SecondSoulService.dispatch(req.player.id, Number(soul_index), mode);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/second-soul/cultivate
 * 开始独立修炼（12 小时上限，每日 2 次）
 * 请求体：{ soul_index: number(2|3) }
 */
router.post('/cultivate', auth, async (req, res, next) => {
    try {
        const { soul_index } = req.body;
        if (![2, 3].includes(Number(soul_index))) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'soul_index 必须为 2 或 3'
            });
        }
        const result = await SecondSoulService.cultivate(req.player.id, Number(soul_index));
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
