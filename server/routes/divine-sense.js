/**
 * 神识淬炼系统玩家路由
 *
 * 提供玩家端神识淬炼系统的 HTTP 接口：
 *   1. GET  /api/divine-sense/profile：获取神识面板
 *   2. POST /api/divine-sense/quench：神识淬炼（100 香火 = 1 神识）
 *   3. POST /api/divine-sense/duel/challenge：发起神识对决挑战
 *   4. POST /api/divine-sense/duel/accept：接受神识对决挑战
 *   5. POST /api/divine-sense/duel/action：执行神识对决行动（凝神/固元）
 *   6. GET  /api/divine-sense/duel/active：查询当前进行中的神识对决
 *   7. GET  /api/divine-sense/duel/history：查询神识对决历史
 *   8. POST /api/divine-sense/duel/surrender：投降
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 DivineSenseService / DivineDuelService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第4.4节（神识淬炼系统）+ 第18节（神识对决）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const DivineSenseService = require('../game/services/DivineSenseService');
const DivineDuelService = require('../game/services/DivineDuelService');
const Player = require('../models/player');
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

// ===== 神识对决接口（玩法文档第18节） =====

/**
 * POST /api/divine-sense/duel/challenge
 * 发起神识对决挑战
 * 请求体：{ target_player_id: number, bet_type: 'spirit_stone'|'divine_sense', bet_amount: number }
 */
router.post('/duel/challenge', auth, async (req, res, next) => {
    try {
        const { target_player_id, bet_type, bet_amount } = req.body;

        // 参数校验
        const targetIdNum = Number(target_player_id);
        if (!Number.isFinite(targetIdNum) || targetIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_player_id 无效'
            });
        }
        if (!['spirit_stone', 'divine_sense'].includes(bet_type)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'bet_type 仅支持 spirit_stone / divine_sense'
            });
        }
        const betAmountNum = Number(bet_amount);
        if (!Number.isInteger(betAmountNum) || betAmountNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'bet_amount 必须为正整数'
            });
        }

        // 查询发起方玩家完整对象（含 realm_rank）
        const challenger = await Player.findByPk(req.player.id);
        if (!challenger) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }

        const result = await DivineDuelService.challenge(challenger, targetIdNum, bet_type, betAmountNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/divine-sense/duel/accept
 * 接受神识对决挑战
 * 请求体：{ duel_id: number }
 */
router.post('/duel/accept', auth, async (req, res, next) => {
    try {
        const { duel_id } = req.body;
        const duelIdNum = Number(duel_id);
        if (!Number.isFinite(duelIdNum) || duelIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'duel_id 无效'
            });
        }

        const player = await Player.findByPk(req.player.id);
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }

        const result = await DivineDuelService.accept(player, duelIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/divine-sense/duel/action
 * 执行神识对决行动（凝神 focus / 固元 stabilize）
 * 请求体：{ duel_id: number, action: 'focus'|'stabilize' }
 */
router.post('/duel/action', auth, async (req, res, next) => {
    try {
        const { duel_id, action } = req.body;
        const duelIdNum = Number(duel_id);
        if (!Number.isFinite(duelIdNum) || duelIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'duel_id 无效'
            });
        }
        if (!['focus', 'stabilize'].includes(action)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'action 仅支持 focus（凝神）/ stabilize（固元）'
            });
        }

        const player = await Player.findByPk(req.player.id);
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }

        const result = await DivineDuelService.action(player, duelIdNum, action);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/divine-sense/duel/active
 * 查询当前进行中的神识对决
 */
router.get('/duel/active', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.player.id);
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }
        const result = await DivineDuelService.getActiveDuel(player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/divine-sense/duel/history
 * 查询神识对决历史
 * 查询参数：page（页码，默认1）、page_size（每页条数，默认10）
 */
router.get('/duel/history', auth, async (req, res, next) => {
    try {
        const { page, page_size } = req.query;
        const player = await Player.findByPk(req.player.id);
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }
        const result = await DivineDuelService.getHistory(player, page, page_size);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/divine-sense/duel/surrender
 * 投降
 * 请求体：{ duel_id: number }
 */
router.post('/duel/surrender', auth, async (req, res, next) => {
    try {
        const { duel_id } = req.body;
        const duelIdNum = Number(duel_id);
        if (!Number.isFinite(duelIdNum) || duelIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'duel_id 无效'
            });
        }

        const player = await Player.findByPk(req.player.id);
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }

        const result = await DivineDuelService.surrender(player, duelIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;

