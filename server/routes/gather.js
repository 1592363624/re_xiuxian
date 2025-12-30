/**
 * 采集系统路由
 * 
 * 提供资源采集相关接口
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const GatheringService = require('../services/GatheringService');
const auth = require('../middleware/auth');

/**
 * 获取当前地图可采集资源列表
 */
router.get('/resources', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        const resources = await GatheringService.getMapResources(player.id, player.current_map_id);

        res.json({
            map_id: player.current_map_id,
            resources: resources
        });
    } catch (error) {
        console.error('Get Resources Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 执行采集
 */
router.post('/collect', auth, async (req, res) => {
    try {
        const { resource_id, resourceId } = req.body;
        const resourceIdToUse = resource_id || resourceId;
        if (!resourceIdToUse) {
            return res.status(400).json({ error: '资源ID不能为空' });
        }

        const result = await GatheringService.collect(req.user.id, resourceIdToUse);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        console.error('Collect Error:', error);
        const status = error.message.includes('不足') || error.message.includes('冷却') ? 400 : 500;
        res.status(status).json({ error: error.message || 'Server error' });
    }
});

/**
 * 获取玩家采集统计
 */
router.get('/stats', auth, async (req, res) => {
    try {
        const stats = await GatheringService.getPlayerStats(req.user.id);

        res.json({
            code: 200,
            data: stats
        });
    } catch (error) {
        console.error('Get Stats Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 批量采集（一次采集多个同类资源）
 */
router.post('/batch-collect', auth, async (req, res) => {
    try {
        const { resourceId, count } = req.body;
        
        if (!resourceId) {
            return res.status(400).json({ error: '资源ID不能为空' });
        }

        const maxCount = Math.min(count || 1, 10);
        const results = [];
        let totalMpUsed = 0;
        let totalItems = {};

        for (let i = 0; i < maxCount; i++) {
            try {
                const result = await GatheringService.collect(req.user.id, resourceId);
                results.push({
                    success: true,
                    quantity: result.quantity,
                    is_crit: result.is_crit
                });
                
                totalMpUsed += result.mp_cost;
                totalItems[result.item_id] = (totalItems[result.item_id] || 0) + result.quantity;
            } catch (e) {
                results.push({
                    success: false,
                    error: e.message
                });
                break;
            }
        }

        res.json({
            code: 200,
            message: `完成 ${results.filter(r => r.success).length} 次采集`,
            total_attempts: results.length,
            total_success: results.filter(r => r.success).length,
            total_mp_used: totalMpUsed,
            total_items: totalItems,
            details: results
        });
    } catch (error) {
        console.error('Batch Collect Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

module.exports = router;
