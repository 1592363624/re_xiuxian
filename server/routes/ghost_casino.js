/**
 * 鬼赌坊路由
 * GET  /api/ghost-casino/status
 * POST /api/ghost-casino/destiny-slip        - 闯关
 * POST /api/ghost-casino/destiny-slip/cash    - 兑奖离场
 * POST /api/ghost-casino/six-paths/buy        - 买彩票
 * POST /api/ghost-casino/six-paths/draw       - [GM] 开奖
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const GhostCasinoService = require('../game/services/GhostCasinoService');

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await GhostCasinoService.getStatus(req.player.id);
        res.json({ code: 200, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.post('/destiny-slip', auth, async (req, res, next) => {
    try {
        const data = await GhostCasinoService.playDestinySlip(req.player.id);
        res.json({ code: 200, message: data.message || (data.win ? '过关' : '失败'), data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.post('/destiny-slip/cash', auth, async (req, res, next) => {
    try {
        const data = await GhostCasinoService.playDestinySlip(req.player.id, { cashOut: true });
        res.json({ code: 200, message: `兑奖离场 +${data.gain}`, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.post('/six-paths/buy', auth, async (req, res, next) => {
    try {
        const data = await GhostCasinoService.buyWheelTicket(req.player.id, req.body.count);
        res.json({ code: 200, message: `购入 ${data.bought} 注`, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') next();
    else res.status(403).json({ code: 403, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR, message: '需要管理员权限' });
};

router.post('/six-paths/draw', auth, adminCheck, async (req, res, next) => {
    try {
        const data = await GhostCasinoService.drawWheel();
        res.json({ code: 200, message: data.drawn ? '开奖完成' : (data.reason || '未开奖'), data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
