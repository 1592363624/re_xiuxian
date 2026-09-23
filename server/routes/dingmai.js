/**
 * 落云宗定脉路由
 * GET  /api/dingmai/info | status
 * POST /api/dingmai/act
 * 玩法文档：xiuxian_game_guide.md 第25节
 */
'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const DingmaiService = require('../game/services/DingmaiService');
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
        res.json({ code: 200, message: 'ok', data: DingmaiService.getInfo() });
    } catch (err) { handleError(err, res, next); }
});

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await DingmaiService.getStatus(req.player.id);
        res.json({ code: 200, message: 'ok', data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/act', auth, async (req, res, next) => {
    try {
        const data = await DingmaiService.act(req.player.id, req.body.action, req.body.element);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

module.exports = router;
