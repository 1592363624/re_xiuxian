/**
 * 试炼古塔（琉璃塔）路由
 *
 * 1. GET  /api/trial-tower/status
 * 2. POST /api/trial-tower/challenge
 * 3. GET  /api/trial-tower/ranking
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const TrialTowerService = require('../game/services/TrialTowerService');
const CombatResolver = require('../game/combat/CombatResolver');

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await TrialTowerService.getStatus(req.player.id);
        res.json({ code: 200, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.post('/challenge', auth, async (req, res, next) => {
    try {
        const resolved = await CombatResolver.resolveCombatStats(req.player);
        const power = CombatResolver.computePower(resolved.stats, req.player.realm_rank || 0);
        const data = await TrialTowerService.challenge(req.player.id, power);
        res.json({
            code: 200,
            message: data.win ? `闯过第 ${data.floor} 层！` : `第 ${data.floor} 层挑战失败`,
            data
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

router.get('/ranking', auth, async (req, res, next) => {
    try {
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const data = await TrialTowerService.getRanking(limit);
        res.json({ code: 200, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
