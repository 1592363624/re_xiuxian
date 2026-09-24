/**
 * 风雷翅路由
 * GET  /api/wind-wings/status
 * POST /api/wind-wings/raid   body: { mode: 'steal'|'break'|'instant' }
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const WindThunderWingsService = require('../game/services/WindThunderWingsService');

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await WindThunderWingsService.getStatus(req.player.id);
        res.json({ code: 200, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.post('/raid', auth, async (req, res, next) => {
    try {
        const mode = String(req.body.mode || 'steal');
        const data = await WindThunderWingsService.raid(req.player.id, mode, Number(req.body.target_power) || 0);
        res.json({ code: 200, message: data.message, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
