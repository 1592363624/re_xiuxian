/**
 * 事件奇遇路由
 * GET  /api/fated-event/info | status
 * POST /api/fated-event/trigger | choose
 * 玩法文档：xiuxian_game_guide.md 第22节
 */
'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const FatedEventService = require('../game/services/FatedEventService');
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
        res.json({ code: 200, message: 'ok', data: FatedEventService.getInfo() });
    } catch (err) { handleError(err, res, next); }
});

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await FatedEventService.getStatus(req.player.id);
        res.json({ code: 200, message: 'ok', data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/trigger', auth, async (req, res, next) => {
    try {
        const data = await FatedEventService.trigger(req.player.id, {
            forceEventId: req.body.event_id || null,
            source: 'manual'
        });
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/choose', auth, async (req, res, next) => {
    try {
        const data = await FatedEventService.choose(req.player.id, req.body.choice_id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

module.exports = router;
