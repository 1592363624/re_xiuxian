/**
 * 法则转换系统玩家路由
 *
 * 提供玩家端法则转换系统的 HTTP 接口：
 *   1. GET  /api/law/profile：获取法则面板
 *   2. POST /api/law/convert-divine-sense：神识→法则点（100 神识=1 法则点）
 *   3. POST /api/law/convert-fragment：碎片→法则点（空间=5点/其他=3点）
 *   4. POST /api/law/convert：法则转换（消耗法则点，兑换7种效果）
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 LawService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第4.5节（法则转换系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const LawService = require('../game/services/LawService');
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
 * GET /api/law/profile
 * 获取法则面板数据（法则点/5 类碎片存量/转换选项/每日获取进度）
 * 该接口为只读操作，不需要状态机互斥校验
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await LawService.getProfile(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/law/convert-divine-sense
 * 神识→法则点转换（100 神识=1 法则点，受每日上限限制）
 * 请求体：{ divine_sense_amount: number }
 */
router.post('/convert-divine-sense', auth, async (req, res, next) => {
    try {
        const { divine_sense_amount } = req.body;
        const amountNum = Number(divine_sense_amount);
        if (!Number.isInteger(amountNum) || amountNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'divine_sense_amount 必须为正整数'
            });
        }
        const result = await LawService.convertDivineSenseToPoints(req.player.id, amountNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/law/convert-fragment
 * 碎片→法则点转换（空间=5点/其他=3点，受每日上限限制）
 * 请求体：{ fragment_type: string, fragment_count: number }
 */
router.post('/convert-fragment', auth, async (req, res, next) => {
    try {
        const { fragment_type, fragment_count } = req.body;
        if (!fragment_type || typeof fragment_type !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'fragment_type 必填且必须为字符串'
            });
        }
        const countNum = Number(fragment_count);
        if (!Number.isInteger(countNum) || countNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'fragment_count 必须为正整数'
            });
        }
        const result = await LawService.convertFragmentToPoints(req.player.id, fragment_type, countNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/law/convert
 * 法则转换（消耗法则点，兑换7种永久/临时效果）
 * 请求体：{ convert_id: string, count?: number(1-100, 默认1) }
 */
router.post('/convert', auth, async (req, res, next) => {
    try {
        const { convert_id, count } = req.body;
        if (!convert_id || typeof convert_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'convert_id 必填且必须为字符串'
            });
        }
        const countNum = count === undefined ? 1 : Number(count);
        if (!Number.isInteger(countNum) || countNum < 1 || countNum > 100) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'count 必须为 1-100 之间的整数'
            });
        }
        const result = await LawService.convert(req.player.id, convert_id, countNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;