/**
 * 神魂风险路由
 * GET /api/soul-risk/status
 * GET /api/soul-risk/enemies
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const SoulRiskService = require('../game/services/SoulRiskService');

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await SoulRiskService.getStatus(req.player.id);
        res.json({ code: 200, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.get('/enemies', auth, async (req, res, next) => {
    try {
        const data = await SoulRiskService.getStatus(req.player.id);
        res.json({
            code: 200,
            data: { enemies: data.enemies, revenge_power_bonus: data.revenge_power_bonus }
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
