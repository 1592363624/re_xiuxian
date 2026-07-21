/**
 * 侍妾系统玩家路由
 *
 * 提供玩家端侍妾系统的 13 个 HTTP 接口：
 *   1. GET  /api/concubine/list：侍妾列表
 *   2. POST /api/concubine/seek-fate：红尘寻缘
 *   3. POST /api/concubine/ask-after：每日问安
 *   4. POST /api/concubine/backfeed：灵力反哺
 *   5. POST /api/concubine/gift：赠予物品
 *   6. POST /api/concubine/place：安置侍妾
 *   7. POST /api/concubine/recall：召回侍妾
 *   8. POST /api/concubine/dismiss：遣散侍妾
 *   9. POST /api/concubine/voyage/start：侍妾远航
 *  10. GET  /api/concubine/voyage/status：远航状态
 *  11. POST /api/concubine/voyage/return：远航归来
 *  12. POST /api/concubine/protect：请侍妾护法
 *  13. POST /api/concubine/awaken：觉醒婉影
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 ConcubineService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第5.7节（道侣 / 侍妾 API 接口设计）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ConcubineService = require('../game/services/ConcubineService');
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
 * GET /api/concubine/list
 * 侍妾列表：查询玩家所有侍妾及状态
 * 该接口为只读操作
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const result = await ConcubineService.getList(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/seek-fate
 * 红尘寻缘（每日 1 次免费，额外 3 次消耗灵石）
 * 无请求体参数
 */
router.post('/seek-fate', auth, async (req, res, next) => {
    try {
        const result = await ConcubineService.seekFate(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/ask-after
 * 每日问安（亲密度 +2、魅力 +1、忠诚度 +1）
 * 请求体：{ concubine_id: number }
 */
router.post('/ask-after', auth, async (req, res, next) => {
    try {
        const { concubine_id } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        const result = await ConcubineService.askAfter(req.player.id, concubine_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/backfeed
 * 灵力反哺（侍妾修为 +1000，消耗玩家修为 500）
 * 请求体：{ concubine_id: number }
 */
router.post('/backfeed', auth, async (req, res, next) => {
    try {
        const { concubine_id } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        const result = await ConcubineService.backfeed(req.player.id, concubine_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/gift
 * 赠予物品（按物品价值提升亲密度/魅力）
 * 请求体：{ concubine_id: number, item_key: string, count: number(1-99) }
 */
router.post('/gift', auth, async (req, res, next) => {
    try {
        const { concubine_id, item_key, count } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        if (!item_key || typeof item_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'item_key 必填且必须为字符串'
            });
        }
        if (!Number.isInteger(count) || count <= 0 || count > 99) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'count 必须为 1-99 之间的整数'
            });
        }
        const result = await ConcubineService.gift(req.player.id, concubine_id, item_key, count);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/place
 * 安置侍妾（安置至洞府）
 * 请求体：{ concubine_id: number, location: string }
 */
router.post('/place', auth, async (req, res, next) => {
    try {
        const { concubine_id, location } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        if (!location || typeof location !== 'string' || location.trim().length === 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'location 必填且必须为非空字符串'
            });
        }
        if (location.length > 50) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'location 长度不能超过 50 个字符'
            });
        }
        const result = await ConcubineService.place(req.player.id, concubine_id, location.trim());
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/recall
 * 召回侍妾（从洞府召回）
 * 请求体：{ concubine_id: number }
 */
router.post('/recall', auth, async (req, res, next) => {
    try {
        const { concubine_id } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        const result = await ConcubineService.recall(req.player.id, concubine_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/dismiss
 * 遣散侍妾（解除侍妾关系）
 * 请求体：{ concubine_id: number }
 */
router.post('/dismiss', auth, async (req, res, next) => {
    try {
        const { concubine_id } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        const result = await ConcubineService.dismiss(req.player.id, concubine_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/voyage/start
 * 侍妾远航（4 种模式：safe/balanced/risky/moon_palace）
 * 请求体：{ concubine_id: number, mode: 'safe'|'balanced'|'risky'|'moon_palace' }
 */
router.post('/voyage/start', auth, async (req, res, next) => {
    try {
        const { concubine_id, mode } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        if (!['safe', 'balanced', 'risky', 'moon_palace'].includes(mode)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'mode 必须为 safe(稳妥)/balanced(均衡)/risky(冒险)/moon_palace(月殿寻痕) 之一'
            });
        }
        const result = await ConcubineService.startVoyage(req.player.id, concubine_id, mode);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/concubine/voyage/status
 * 远航状态：查询玩家所有远航记录
 */
router.get('/voyage/status', auth, async (req, res, next) => {
    try {
        const result = await ConcubineService.getVoyageStatus(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/voyage/return
 * 远航归来（领取奖励，必须在归来后 24 小时内领取）
 * 请求体：{ voyage_id: number }
 */
router.post('/voyage/return', auth, async (req, res, next) => {
    try {
        const { voyage_id } = req.body;
        if (!voyage_id || typeof voyage_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'voyage_id 必填且必须为数字'
            });
        }
        const result = await ConcubineService.returnVoyage(req.player.id, voyage_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/protect
 * 请侍妾护法（闭关时减少被打断 30%）
 * 请求体：{ concubine_id: number }
 */
router.post('/protect', auth, async (req, res, next) => {
    try {
        const { concubine_id } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        const result = await ConcubineService.protect(req.player.id, concubine_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/concubine/awaken
 * 觉醒婉影（特定侍妾觉醒为高阶形态）
 * 请求体：{ concubine_id: number }
 */
router.post('/awaken', auth, async (req, res, next) => {
    try {
        const { concubine_id } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        const result = await ConcubineService.awaken(req.player.id, concubine_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
