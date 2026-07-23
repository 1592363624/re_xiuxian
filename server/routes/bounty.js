/**
 * PVP 悬赏系统路由（玩家端）
 *
 * 提供玩家间悬赏追杀玩法的 HTTP 接口：
 * 1. POST /api/bounty/publish：发布悬赏（body: target_id, amount, reason?）
 * 2. POST /api/bounty/:bountyId/accept：接取悬赏（自动发起 PVP 战斗）
 * 3. GET  /api/bounty/list：悬赏榜单（query: page, page_size, status?）
 * 4. GET  /api/bounty/my：我的悬赏（发布的 + 接取的）
 * 5. POST /api/bounty/:bountyId/cancel：取消悬赏（仅发布者可取消 active 状态）
 * 6. POST /api/bounty/:bountyId/counter：反悬赏（被悬赏者对悬赏者发起反向悬赏）
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 BountyService 中
 * 统一响应格式：{ code: 200, message, data }
 * 所有接口均需 auth 中间件鉴权
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const BountyService = require('../game/services/BountyService');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 悬赏状态白名单（用于 list 接口的状态过滤校验）
 */
const VALID_BOUNTY_STATUSES = ['active', 'accepted', 'completed', 'expired', 'cancelled'];

/**
 * POST /api/bounty/publish
 * 发布悬赏追杀任务
 * body: { target_id: number, amount: number, reason?: string }
 */
router.post('/publish', auth, async (req, res, next) => {
    try {
        const { target_id, amount, reason } = req.body;

        // 参数校验：target_id
        if (!target_id) {
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

        // 参数校验：amount
        if (amount === undefined || amount === null) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'amount 参数不能为空'
            });
        }
        const amountNum = Number(amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'amount 参数必须为正数'
            });
        }

        // reason 可选，若提供则校验类型
        if (reason !== undefined && reason !== null && typeof reason !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'reason 参数必须为字符串'
            });
        }

        const result = await BountyService.publishBounty(req.player.id, targetId, amountNum, reason);

        // 推送悬赏发布事件给发起方（前端据此刷新悬赏列表）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'bounty_publish_success', {
                bounty_id: result.bounty_id,
                target_id: targetId,
                bounty_amount: amountNum
            });
        } catch (e) {
            console.warn('[Bounty] 推送悬赏发布事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '悬赏发布成功',
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
 * POST /api/bounty/:bountyId/accept
 * 接取悬赏（自动发起 bounty 类型 PVP 战斗）
 * 路径参数：bountyId - 悬赏ID
 */
router.post('/:bountyId/accept', auth, async (req, res, next) => {
    try {
        const bountyId = parseInt(req.params.bountyId);
        if (!Number.isFinite(bountyId) || bountyId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'bountyId 参数无效'
            });
        }

        const result = await BountyService.acceptBounty(req.player.id, bountyId);

        // 推送接单事件给接单方（前端据此进入战斗 UI）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'bounty_accept_success', {
                bounty_id: bountyId,
                battle_id: result.battle_id,
                opponent_info: result.opponent_info
            });
        } catch (e) {
            console.warn('[Bounty] 推送接单事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '悬赏已接取，斗法已开启',
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
 * GET /api/bounty/list
 * 悬赏榜单（分页 + 状态过滤）
 * query: { page?: number, page_size?: number, status?: string }
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.page_size) || 20;
        const status = req.query.status;

        // 状态参数校验（可选，若提供须在白名单内）
        if (status && !VALID_BOUNTY_STATUSES.includes(status)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `无效的 status 参数，可选值：${VALID_BOUNTY_STATUSES.join('/')}`
            });
        }

        const result = await BountyService.getBountyList(page, pageSize, status);

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
 * GET /api/bounty/my
 * 我的悬赏（发布的 + 接取的）
 */
router.get('/my', auth, async (req, res, next) => {
    try {
        const result = await BountyService.getMyBounties(req.player.id);

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
 * POST /api/bounty/:bountyId/cancel
 * 取消悬赏（仅发布者可取消，仅 active 状态可取消）
 * 路径参数：bountyId - 悬赏ID
 */
router.post('/:bountyId/cancel', auth, async (req, res, next) => {
    try {
        const bountyId = parseInt(req.params.bountyId);
        if (!Number.isFinite(bountyId) || bountyId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'bountyId 参数无效'
            });
        }

        const result = await BountyService.cancelBounty(req.player.id, bountyId);

        // 推送取消事件给发布方
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'bounty_cancel_success', {
                bounty_id: bountyId,
                refund_amount: result.refund_amount
            });
        } catch (e) {
            console.warn('[Bounty] 推送取消事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '悬赏已取消',
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
 * POST /api/bounty/:bountyId/counter
 * 反悬赏：被悬赏者对悬赏者发起反向悬赏
 *
 * 玩法说明：被悬赏的玩家不只能被动防守，还可以花费灵石主动反击，
 * 对悬赏自己的人发起反向悬赏。反悬赏金额 = 原悬赏金额 * 倍率（默认 1.2）。
 * 反悬赏链深度有上限（默认 3 次），防止无限连锁。
 *
 * 路径参数：bountyId - 原悬赏ID
 * body: { reason?: string } - 反悬赏理由（可选）
 */
router.post('/:bountyId/counter', auth, async (req, res, next) => {
    try {
        const bountyId = parseInt(req.params.bountyId);
        if (!Number.isFinite(bountyId) || bountyId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'bountyId 参数无效'
            });
        }

        // reason 可选，若提供则校验类型与长度
        const { reason } = req.body;
        if (reason !== undefined && reason !== null && typeof reason !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'reason 参数必须为字符串'
            });
        }
        if (reason && reason.length > 180) {
            // 反悬赏理由上限略短于 200，留出 [反悬赏] 前缀空间
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '反悬赏理由不能超过 180 字'
            });
        }

        const result = await BountyService.counterBounty(req.player.id, bountyId, reason);

        // 推送反悬赏事件给发起方
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'bounty_counter_success', {
                bounty_id: result.bounty_id,
                original_bounty_id: bountyId,
                counter_amount: result.bounty_amount,
                counter_chain_depth: result.counter_chain_depth
            });
        } catch (e) {
            console.warn('[Bounty] 推送反悬赏事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '反悬赏发布成功',
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
