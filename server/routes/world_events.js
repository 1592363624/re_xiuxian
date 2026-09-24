/**
 * 世界事件与凶名路由
 * GET  /api/world-events/status
 * POST /api/world-events/trigger   [GM]
 * POST /api/world-events/kill      记杀戮并评凶名
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const WorldEventsService = require('../game/services/WorldEventsService');

router.get('/status', auth, async (req, res, next) => {
    try {
        require('../game/services/zhiguiHooks')(req.player.id, 'world_risk_open');
        const data = await WorldEventsService.getStatus(req.player.id);
        res.json({ code: 200, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') next();
    else res.status(403).json({ code: 403, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR, message: '需要管理员权限' });
};

router.post('/trigger', auth, adminCheck, async (req, res, next) => {
    try {
        const data = await WorldEventsService.trigger();
        res.json({ code: 200, message: data ? `【${data.title}】` : '未触发', data });
    } catch (err) { next(err); }
});

router.post('/kill', auth, async (req, res, next) => {
    try {
        require('../game/services/zhiguiHooks')(req.player.id, 'world_event_touch');
        const data = await WorldEventsService.onKill(req.player.id);
        res.json({ code: 200, message: data.title ? `获得凶名【${data.title.name}】` : '杀戮 +1', data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
