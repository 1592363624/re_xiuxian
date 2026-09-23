/**
 * 风希的诅咒路由
 * GET  /api/fengxi/status
 * POST /api/fengxi/escape
 * POST /api/fengxi/fight
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const FengxiCurseService = require('../game/services/FengxiCurseService');

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await FengxiCurseService.getStatus(req.player.id);
        res.json({ code: 200, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.post('/escape', auth, async (req, res, next) => {
    try {
        const data = await FengxiCurseService.escape(req.player.id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.post('/fight', auth, async (req, res, next) => {
    try {
        const data = await FengxiCurseService.fight(req.player.id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
