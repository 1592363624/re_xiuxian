/**
 * 决斗系统路由（玩家端）
 *
 * 提供玩家间正式 1v1 决斗玩法的 HTTP 接口：
 * 1. POST /api/duel/challenge       发起决斗（body: target_id, bet_amount）
 * 2. POST /api/duel/:duelId/accept  接受决斗
 * 3. POST /api/duel/:duelId/reject  拒绝决斗（退还赌注）
 * 4. POST /api/duel/:duelId/action  出招（body: action: 'skill'|'defend'|'charge'）
 * 5. GET  /api/duel/history         决斗历史（query: page, page_size）
 * 6. GET  /api/duel/:duelId         查询决斗状态
 * 路由注册顺序：静态路径（/challenge, /history）优先于动态参数（/:duelId）
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 DuelService 中
 * 统一响应格式：{ code: 200, message, data }
 * 决斗不可逃跑（玩法文档明确要求，故不提供 flee 接口）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const duelService = require('../game/services/DuelService');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * POST /api/duel/challenge
 * 发起决斗（body: target_id, bet_amount）
 */
router.post('/challenge', auth, async (req, res, next) => {
    try {
        const { target_id, bet_amount } = req.body;

        // 参数校验：目标玩家ID
        if (target_id === undefined || target_id === null || target_id === '') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_id 参数不能为空'
            });
        }
        const targetId = parseInt(target_id);
        if (!Number.isFinite(targetId) || targetId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_id 参数无效'
            });
        }

        // 参数校验：赌注金额
        if (bet_amount === undefined || bet_amount === null || bet_amount === '') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'bet_amount 参数不能为空'
            });
        }
        const betAmount = Number(bet_amount);
        if (!Number.isFinite(betAmount) || betAmount <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'bet_amount 参数无效'
            });
        }

        const result = await duelService.challenge(req.player.id, targetId, betAmount);

        res.json({
            code: 200,
            message: '决斗挑战已发起，等待对手接受',
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * POST /api/duel/:duelId/accept
 * 接受决斗（仅被挑战方可调用）
 */
router.post('/:duelId/accept', auth, async (req, res, next) => {
    try {
        const duelId = parseInt(req.params.duelId);
        if (!Number.isFinite(duelId) || duelId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'duelId 参数无效'
            });
        }

        const result = await duelService.acceptDuel(req.player.id, duelId);

        // 推送决斗接受事件（前端据此进入战斗 UI）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'duel_accept', {
                duel_id: duelId,
                status: 'active'
            });
        } catch (e) {
            console.warn('[Duel] 推送接受事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '决斗已开始',
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * POST /api/duel/:duelId/reject
 * 拒绝决斗（仅被挑战方可调用，退还赌注）
 */
router.post('/:duelId/reject', auth, async (req, res, next) => {
    try {
        const duelId = parseInt(req.params.duelId);
        if (!Number.isFinite(duelId) || duelId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'duelId 参数无效'
            });
        }

        const result = await duelService.rejectDuel(req.player.id, duelId);

        // 推送决斗拒绝事件
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'duel_reject', {
                duel_id: duelId,
                status: 'cancelled'
            });
        } catch (e) {
            console.warn('[Duel] 推送拒绝事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '决斗已拒绝，赌注已退还',
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * POST /api/duel/:duelId/action
 * 出招（body: action: 'skill'|'defend'|'charge'）
 * skill=神通，defend=防御，charge=蓄力
 */
router.post('/:duelId/action', auth, async (req, res, next) => {
    try {
        const duelId = parseInt(req.params.duelId);
        if (!Number.isFinite(duelId) || duelId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'duelId 参数无效'
            });
        }

        const { action } = req.body;

        // 参数校验：出招类型
        if (!action) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'action 参数不能为空'
            });
        }
        const allowedActions = ['skill', 'defend', 'charge'];
        if (!allowedActions.includes(action)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `无效的 action：${action}，可选值：${allowedActions.join('/')}`
            });
        }

        const result = await duelService.executeDuelAction(req.player.id, duelId, action);

        // 推送出招事件（前端据此刷新回合状态）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'duel_action', {
                duel_id: duelId,
                round: result.round,
                your_action: result.your_action,
                resolved: result.resolved,
                battle_ended: result.battle_ended || false
            });
        } catch (e) {
            console.warn('[Duel] 推送出招事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: result.battle_ended ? '决斗已结束' : (result.resolved ? '回合已结算' : '已出招，等待对手'),
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/duel/history
 * 决斗历史（query: page, page_size）
 * 注意：此静态路由必须在 /:duelId 之前注册，否则 'history' 会被当作 :duelId 匹配
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(Math.max(1, parseInt(req.query.page_size) || 20), 100);

        const result = await duelService.getDuelHistory(req.player.id, page, pageSize);

        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/duel/:duelId
 * 查询决斗状态
 * 注意：此动态路由需在 /history 之后注册，避免 'history' 被当作 :duelId
 */
router.get('/:duelId', auth, async (req, res, next) => {
    try {
        const duelId = parseInt(req.params.duelId);
        if (!Number.isFinite(duelId) || duelId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'duelId 参数无效'
            });
        }

        const result = await duelService.getDuelStatus(req.player.id, duelId);

        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

module.exports = router;
