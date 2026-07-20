/**
 * 神庙系统玩家路由
 *
 * 提供玩家端神庙系统的 HTTP 接口：
 *   1. GET  /api/divine-temple/profile：获取神庙面板
 *   2. POST /api/divine-temple/upgrade：升级神庙
 *   3. POST /api/divine-temple/repair-defense：修复护界禁制
 *   4. POST /api/divine-temple/exchange-offering：兑换供奉
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 DivineTempleService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第4.3.3节（神庙升级与供奉兑换）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const DivineTempleService = require('../game/services/DivineTempleService');
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
 * GET /api/divine-temple/profile
 * 获取神庙面板数据（等级/护界禁制/供奉池/升级表/可兑换供奉）
 * 该接口为只读操作，不需要状态机互斥校验
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await DivineTempleService.getProfile(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/divine-temple/upgrade
 * 升级神庙（消耗香火+灵石，按 10 级表）
 * 无请求体参数
 */
router.post('/upgrade', auth, async (req, res, next) => {
    try {
        const result = await DivineTempleService.upgrade(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/divine-temple/repair-defense
 * 修复护界禁制（消耗灵石修复 100 点禁制，CD 1 小时）
 * 无请求体参数
 */
router.post('/repair-defense', auth, async (req, res, next) => {
    try {
        const result = await DivineTempleService.repairDefense(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/divine-temple/exchange-offering
 * 兑换供奉（用香火兑换灵石/神识丹/法则碎片等）
 * 请求体：{ offering_id: string }
 */
router.post('/exchange-offering', auth, async (req, res, next) => {
    try {
        const { offering_id } = req.body;
        if (!offering_id || typeof offering_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'offering_id 必填且必须为字符串'
            });
        }
        const result = await DivineTempleService.exchangeOffering(req.player.id, offering_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
