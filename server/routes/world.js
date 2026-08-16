/**
 * 大世界地图路由（World Map MVP）
 *
 * 依赖 WorldMovementService 提供服务器权威的世界坐标移动与同图在线玩家查询。
 * 与原有 map.js 的"跨图延时移动"体系并存：本路由负责大世界内即时走位。
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const WorldMovementService = require('../game/services/WorldMovementService');

/**
 * 获取玩家大世界状态（无坐标时自动分配随机出生点）
 */
router.get('/state', auth, async (req, res) => {
    try {
        const data = await WorldMovementService.getWorldState(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        console.error('World State Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 世界移动（点击地图目标点，服务器权威校验后更新坐标）
 * 请求体：{ x: number, y: number }
 */
router.post('/move', auth, async (req, res) => {
    try {
        const { x, y } = req.body;
        if (x == null || y == null) {
            return res.status(400).json({ code: 400, message: '目标坐标不能为空' });
        }

        const result = await WorldMovementService.move(req.user.id, x, y);

        if (result.success) {
            res.json({ code: 200, message: result.message, data: result.data });
        } else {
            const status = result.message.includes('坐标无效') ? 400 : 400;
            res.status(status).json({ code: 400, message: result.message, data: result.data });
        }
    } catch (error) {
        console.error('World Move Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 获取当前地图的在线玩家列表（大世界同图可见）
 */
router.get('/players', auth, async (req, res) => {
    try {
        const state = await WorldMovementService.getWorldState(req.user.id);
        const players = await WorldMovementService.getOnlinePlayersInMap(state.map_id);
        res.json({
            code: 200,
            data: {
                map_id: state.map_id,
                map_name: state.map_name,
                players
            }
        });
    } catch (error) {
        console.error('World Players Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

module.exports = router;