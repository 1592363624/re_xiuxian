/**
 * 灵兽系统玩家路由
 *
 * 提供玩家端灵兽系统的 8 个 HTTP 接口：
 *   1. GET  /api/spirit-beast/types         - 获取所有灵兽种类（图鉴）
 *   2. GET  /api/spirit-beast/list          - 获取我的灵兽列表
 *   3. GET  /api/spirit-beast/:beastId      - 灵兽详情
 *   4. POST /api/spirit-beast/catch         - 寻觅/捕获灵兽 { beast_key }
 *   5. POST /api/spirit-beast/:beastId/feed - 喂养灵兽
 *   6. POST /api/spirit-beast/:beastId/interact - 互动灵兽
 *   7. POST /api/spirit-beast/:beastId/set-active - 设置出战
 *   8. POST /api/spirit-beast/:beastId/release - 放生灵兽
 *   9. GET  /api/spirit-beast/daily-status  - 获取今日捕获次数等信息
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 SpiritBeastService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *   - 业务错误用 AppError + ErrorCodes，统一通过 sendServiceResult 包装
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SpiritBeastService = require('../game/services/SpiritBeastService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * 业务失败仍返回 HTTP 200，由 code/success 区分（与 companion.js 路由保持一致）
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
 * GET /api/spirit-beast/types
 * 获取所有灵兽种类（图鉴）
 * 返回配置中的全部灵兽种类 + 玩家已捕获标记 + 元素/稀有度配置
 */
router.get('/types', auth, async (req, res, next) => {
    try {
        const result = await SpiritBeastService.getBeastTypes(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/list
 * 获取我的灵兽列表
 * 按 出战 > 星级 > 等级 > 捕获时间 排序
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const result = await SpiritBeastService.getMyBeasts(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/daily-status
 * 获取今日捕获状态：今日次数/上限/剩余/灵兽背包容量
 * 必须放在 /:beastId 路由之前，否则会被识别为 beastId
 */
router.get('/daily-status', auth, async (req, res, next) => {
    try {
        const result = await SpiritBeastService.getDailyStatus(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/:beastId
 * 灵兽详情：完整属性 + 战力 + 元素相克 + 冷却剩余
 */
router.get('/:beastId', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.getBeastDetail(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/catch
 * 寻觅/捕获灵兽
 * 请求体：{ beast_key: string }
 */
router.post('/catch', auth, async (req, res, next) => {
    try {
        const { beast_key } = req.body;
        if (!beast_key || typeof beast_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beast_key 必填且必须为字符串'
            });
        }
        const result = await SpiritBeastService.catchBeast(req.player.id, beast_key);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/feed
 * 喂养灵兽：消耗灵石，增加经验/忠诚度，1 小时冷却
 */
router.post('/:beastId/feed', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.feedBeast(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/interact
 * 互动灵兽：增加忠诚度+经验，10 分钟冷却，无消耗
 */
router.post('/:beastId/interact', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.interactBeast(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/set-active
 * 设置出战灵兽：同时仅 1 只出战
 */
router.post('/:beastId/set-active', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.setActiveBeast(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/release
 * 放生灵兽：返还部分灵石，删除灵兽记录
 */
router.post('/:beastId/release', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.releaseBeast(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
