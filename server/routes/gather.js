/**
 * 采集系统路由
 *
 * 提供资源采集相关接口
 * 修复：批量上限从配置读取、batch-collect 业务逻辑下沉 Service、统一错误处理为 next(error)
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const GatheringService = require('../game/services/GatheringService');
const auth = require('../middleware/auth');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 懒加载配置（避免模块加载时配置未初始化）
const configLoader = infrastructure.ConfigLoader;
function getGatherConfig() {
    return configLoader.getConfig('game_balance')?.gather || {};
}

/**
 * 获取当前地图可采集资源列表
 */
router.get('/resources', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const resources = await GatheringService.getMapResources(player.id, player.current_map_id);

        res.json({
            code: 200,
            data: {
                map_id: player.current_map_id,
                resources: resources
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 执行采集
 */
router.post('/collect', auth, async (req, res, next) => {
    try {
        const { resource_id, resourceId } = req.body;
        const resourceIdToUse = resource_id || resourceId;
        if (!resourceIdToUse) {
            throw new AppError('资源ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await GatheringService.collect(req.user.id, resourceIdToUse);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        // 修复：不再通过 message 字符串匹配判断状态码，统一交给 errorHandler 处理
        // Service 层抛出 AppError 时自带正确状态码；其他未知错误走 500
        next(error);
    }
});

/**
 * 获取玩家采集统计
 */
router.get('/stats', auth, async (req, res, next) => {
    try {
        const stats = await GatheringService.getPlayerStats(req.user.id);

        res.json({
            code: 200,
            data: stats
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 批量采集（一次采集多个同类资源）
 * 批量上限从配置读取，业务逻辑委托 GatheringService.batchCollect
 */
router.post('/batch-collect', auth, async (req, res, next) => {
    try {
        const { resourceId, count } = req.body;

        if (!resourceId) {
            throw new AppError('资源ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 批量上限从配置读取，避免硬编码
        const maxAllowed = getGatherConfig().batch_max_count ?? 10;
        const result = await GatheringService.batchCollect(req.user.id, resourceId, count, maxAllowed);

        res.json({
            code: 200,
            message: `完成 ${result.total_success} 次采集`,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
