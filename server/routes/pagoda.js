/**
 * 琉璃古塔路由
 * GET  /api/pagoda/info | status | ranking | history
 * POST /api/pagoda/climb | exit | reset
 * 玩法文档：xiuxian_game_guide.md 第30节
 */
'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const PagodaService = require('../game/services/PagodaService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

function handleError(err, res, next) {
    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            code: err.statusCode,
            error_code: err.errorCode,
            message: err.message
        });
    }
    next(err);
}

router.get('/info', auth, (req, res, next) => {
    try {
        res.json({ code: 200, message: 'ok', data: PagodaService.getInfo() });
    } catch (err) { handleError(err, res, next); }
});

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await PagodaService.getStatus(req.player.id);
        res.json({ code: 200, message: 'ok', data });
    } catch (err) { handleError(err, res, next); }
});

router.get('/ranking', auth, async (req, res, next) => {
    try {
        const limit = Number(req.query.limit) || 20;
        const data = await PagodaService.getRanking(limit);
        res.json({ code: 200, message: 'ok', data: { ranking: data } });
    } catch (err) { handleError(err, res, next); }
});

router.get('/history', auth, async (req, res, next) => {
    try {
        const limit = Number(req.query.limit) || 20;
        const data = await PagodaService.getHistory(req.player.id, limit);
        res.json({ code: 200, message: 'ok', data: { history: data } });
    } catch (err) { handleError(err, res, next); }
});

router.post('/climb', auth, async (req, res, next) => {
    try {
        const data = await PagodaService.climb(req.player.id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/exit', auth, async (req, res, next) => {
    try {
        const data = await PagodaService.exitTower(req.player.id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/reset', auth, async (req, res, next) => {
    try {
        const data = await PagodaService.resetTower(req.player.id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

module.exports = router;
