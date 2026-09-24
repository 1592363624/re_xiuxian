/**
 * 系统任务「尘缘指归」路由
 *
 * GET  /api/system-quest/board    面板全量（ensure + 追认快进）
 * GET  /api/system-quest/current  轻量当前环
 * POST /api/system-quest/sync     手动触发 ensure
 *
 * 鉴权：requireAuth。服务：game/services/SystemQuestService.js
 */
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const SystemQuestService = require('../game/services/SystemQuestService');

router.get('/board', authMiddleware, async (req, res, next) => {
    try {
        const data = await SystemQuestService.getBoard(req.player.id);
        res.json({ success: true, ...data });
    } catch (err) { next(err); }
});

router.get('/current', authMiddleware, async (req, res, next) => {
    try {
        const data = await SystemQuestService.getCurrent(req.player.id);
        res.json({ success: true, ...data });
    } catch (err) { next(err); }
});

router.post('/sync', authMiddleware, async (req, res, next) => {
    try {
        const { row, advanced, grant_error } = await SystemQuestService.ensureChain(req.player.id);
        res.json({
            success: true,
            status: row?.status || 'active',
            current_node_id: row?.current_node_id || null,
            advanced,
            grant_error: grant_error || null
        });
    } catch (err) { next(err); }
});

module.exports = router;
