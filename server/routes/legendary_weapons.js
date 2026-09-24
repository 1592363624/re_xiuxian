/**
 * 通天灵宝炼制路由
 * GET  /api/legendary-weapons/config
 * POST /api/legendary-weapons/craft  body: { recipe, bonuses? }
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const LegendaryWeaponsService = require('../game/services/LegendaryWeaponsService');

router.get('/config', auth, async (req, res, next) => {
    try {
        res.json({ code: 200, data: LegendaryWeaponsService.config() });
    } catch (err) { next(err); }
});

router.post('/craft', auth, async (req, res, next) => {
    try {
        const data = await LegendaryWeaponsService.craft(req.player.id, req.body.recipe, req.body.bonuses || {});
        res.json({ code: 200, message: data.message, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
