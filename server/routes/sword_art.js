/**
 * 剑诀线路由
 * GET  /api/sword-art/info | status
 * POST /api/sword-art/compose | comprehend | refine | formation/inspect | formation/deploy
 * 玩法文档：xiuxian_game_guide.md 第30节
 */
'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SwordArtService = require('../game/services/SwordArtService');
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
        res.json({ code: 200, message: 'ok', data: SwordArtService.getInfo() });
    } catch (err) { handleError(err, res, next); }
});

router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await SwordArtService.getStatus(req.player.id);
        res.json({ code: 200, message: 'ok', data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/compose', auth, async (req, res, next) => {
    try {
        const data = await SwordArtService.compose(req.player.id, req.body.manual_id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/comprehend', auth, async (req, res, next) => {
    try {
        const data = await SwordArtService.comprehend(req.player.id, req.body.manual_id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/refine', auth, async (req, res, next) => {
    try {
        const data = await SwordArtService.refine(req.player.id, req.body.manual_id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/formation/inspect', auth, async (req, res, next) => {
    try {
        const data = await SwordArtService.inspectFormation(req.player.id, req.body.formation_id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

router.post('/formation/deploy', auth, async (req, res, next) => {
    try {
        const data = await SwordArtService.deployFormation(req.player.id, req.body.formation_id);
        res.json({ code: 200, message: data.message, data });
    } catch (err) { handleError(err, res, next); }
});

module.exports = router;
