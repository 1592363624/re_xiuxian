/**
 * 抽奖（寻仙机缘）系统路由
 *
 * 提供玩家端抽奖面板查询与抽奖接口。
 * 鉴权：requireAuth（玩家登录态）。
 * 服务：game/services/LotteryService.js
 */
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const LotteryService = require('../game/services/LotteryService');

/**
 * GET /api/lottery/panel
 * 获取抽奖面板信息（花费 / 保底 / 奖池预览 / 玩家保底进度）
 */
router.get('/panel', authMiddleware, async (req, res, next) => {
    try {
        const data = await LotteryService.getPanel(req.player.id);
        res.json({ success: true, ...data });
    } catch (err) { next(err); }
});

/**
 * POST /api/lottery/draw
 * 抽奖
 * body: { mode: 'single' | 'ten' }
 */
router.post('/draw', authMiddleware, async (req, res, next) => {
    try {
        const { mode } = req.body || {};
        const result = await LotteryService.draw(req.player.id, mode || 'single');
        res.json({ success: true, ...result });
    } catch (err) { next(err); }
});

module.exports = router;
