/**
 * 成就系统路由
 *
 * 提供玩家端成就查询与奖励领取接口。
 * 鉴权：requireAuth（玩家登录态）。
 * 服务：game/services/AchievementService.js
 */
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const AchievementService = require('../game/services/AchievementService');

/**
 * GET /api/achievement/list
 * 获取成就总览（含玩家进度 / 是否达成 / 是否已领奖）
 */
router.get('/list', authMiddleware, async (req, res, next) => {
    try {
        const data = await AchievementService.getAchievements(req.player.id);
        res.json({ success: true, ...data });
    } catch (err) { next(err); }
});

/**
 * POST /api/achievement/claim
 * 领取成就奖励
 * body: { achievement_id: string }
 */
router.post('/claim', authMiddleware, async (req, res, next) => {
    try {
        const { achievement_id } = req.body;
        if (!achievement_id) {
            return res.status(400).json({ success: false, error: '缺少 achievement_id' });
        }
        const result = await AchievementService.claimReward(req.player.id, achievement_id);
        res.json({ success: true, ...result });
    } catch (err) { next(err); }
});

module.exports = router;
