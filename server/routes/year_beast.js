/**
 * 年兽大作战路由
 * POST /api/year-beast/party            创建讨伐
 * POST /api/year-beast/party/:id/join   加入
 * POST /api/year-beast/party/:id/start  开始
 * POST /api/year-beast/party/:id/cracker 放爆竹
 * POST /api/year-beast/party/:id/focus   集火
 * GET  /api/year-beast/party/:id
 * POST /api/year-beast/settle
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const YearBeastService = require('../game/services/YearBeastService');

function wrap(fn) {
    return async (req, res, next) => {
        try {
            const data = await fn(req);
            res.json({ code: 200, data });
        } catch (err) {
            if (err instanceof AppError) {
                return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
            }
            next(err);
        }
    };
}

router.post('/party', auth, wrap(async (req) => YearBeastService.createParty(req.player.id)));
router.post('/party/:id/join', auth, wrap(async (req) => YearBeastService.joinParty(req.params.id, req.player.id)));
router.post('/party/:id/start', auth, wrap(async (req) => YearBeastService.startParty(req.params.id, req.player.id)));
router.post('/party/:id/cracker', auth, wrap(async (req) => YearBeastService.firecracker(req.params.id, req.player.id)));
router.post('/party/:id/focus', auth, wrap(async (req) => YearBeastService.focusFire(req.params.id, req.player.id)));
router.get('/party/:id', auth, wrap(async (req) => YearBeastService.getParty(req.params.id)));
router.post('/settle', auth, wrap(async (req) => YearBeastService.settle(req.player.id, { isAssist: !!req.body.is_assist })));

module.exports = router;
