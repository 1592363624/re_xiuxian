/**
 * 道侣系统玩家路由
 *
 * 提供玩家端道侣系统的 11 个 HTTP 接口：
 *   1. GET  /api/companion/profile：道侣面板
 *   2. POST /api/companion/seek：寻找道侣（发起邀请）
 *   3. POST /api/companion/accept：同意结侣
 *   4. POST /api/companion/break：解除道侣
 *   5. POST /api/companion/dual-cultivate：闭关双修
 *   6. POST /api/companion/warm-nourish：温养
 *   7. POST /api/companion/pluck-supplement：采补
 *   8. POST /api/companion/vow：立誓
 *   9. GET  /api/companion/heart-contract：心契面板
 *  10. GET  /api/companion/heart-tribulation：获取待处理心劫事件
 *  11. POST /api/companion/heart-tribulation/choose：心劫抉择
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 CompanionService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第5.7节（道侣 / 侍妾 API 接口设计）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const CompanionService = require('../game/services/CompanionService');
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
 * GET /api/companion/profile
 * 道侣面板：查看道侣关系状态、心契等级、双修次数、誓言、心劫
 * 该接口为只读操作
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await CompanionService.getProfile(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/companion/seek
 * 寻找道侣（发起邀请）
 * 请求体：{ target_player_id: number }
 */
router.post('/seek', auth, async (req, res, next) => {
    try {
        const { target_player_id } = req.body;
        if (!target_player_id || typeof target_player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_player_id 必填且必须为数字'
            });
        }
        const result = await CompanionService.seek(req.player.id, target_player_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/companion/accept
 * 同意结侣
 * 请求体：{ companion_id: number }
 */
router.post('/accept', auth, async (req, res, next) => {
    try {
        const { companion_id } = req.body;
        if (!companion_id || typeof companion_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'companion_id 必填且必须为数字'
            });
        }
        const result = await CompanionService.accept(req.player.id, companion_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/companion/break
 * 解除道侣（协议解除 / 毁誓解除）
 * 请求体：{ mode: 'agreement' | 'vow_break' }
 */
router.post('/break', auth, async (req, res, next) => {
    try {
        const { mode } = req.body;
        if (!['agreement', 'vow_break'].includes(mode)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'mode 必须为 agreement(协议解除) 或 vow_break(毁誓解除)'
            });
        }
        const result = await CompanionService.breakCompanion(req.player.id, mode);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/companion/dual-cultivate
 * 闭关双修（+5% 修为，日上限 3 次）
 * 无请求体参数
 */
router.post('/dual-cultivate', auth, async (req, res, next) => {
    try {
        const result = await CompanionService.dualCultivate(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/companion/warm-nourish
 * 温养（双方各 +3% 修为，日上限 2 次）
 * 无请求体参数
 */
router.post('/warm-nourish', auth, async (req, res, next) => {
    try {
        const result = await CompanionService.warmNourish(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/companion/pluck-supplement
 * 采补（主方 +10%，副方 -3%，日上限 1 次）
 * 无请求体参数
 */
router.post('/pluck-supplement', auth, async (req, res, next) => {
    try {
        const result = await CompanionService.pluckSupplement(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/companion/vow
 * 立誓（3 种类型：protect/secret/cultivate，30 天有效期）
 * 请求体：{ vow_type: 'protect' | 'secret' | 'cultivate' }
 */
router.post('/vow', auth, async (req, res, next) => {
    try {
        const { vow_type } = req.body;
        if (!['protect', 'secret', 'cultivate'].includes(vow_type)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'vow_type 必须为 protect(护道)/secret(守秘)/cultivate(共修) 之一'
            });
        }
        const result = await CompanionService.vow(req.player.id, vow_type);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/companion/heart-contract
 * 心契面板：查看心契等级、经验、下一级进度
 */
router.get('/heart-contract', auth, async (req, res, next) => {
    try {
        const result = await CompanionService.getHeartContract(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/companion/heart-tribulation
 * 获取待处理心劫事件
 */
router.get('/heart-tribulation', auth, async (req, res, next) => {
    try {
        const result = await CompanionService.getHeartTribulation(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/companion/heart-tribulation/choose
 * 心劫抉择（稳/狠/骗）
 * 请求体：{ event_id: number, option: 'steady' | 'ruthless' | 'deceive' }
 */
router.post('/heart-tribulation/choose', auth, async (req, res, next) => {
    try {
        const { event_id, option } = req.body;
        if (!event_id || typeof event_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'event_id 必填且必须为数字'
            });
        }
        if (!['steady', 'ruthless', 'deceive'].includes(option)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'option 必须为 steady(稳)/ruthless(狠)/deceive(骗) 之一'
            });
        }
        const result = await CompanionService.chooseHeartTribulation(req.player.id, event_id, option);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
