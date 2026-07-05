/**
 * 药园系统路由
 *
 * 提供药园种植相关接口：查询药园、播种、采收、一键采收
 * 路由仅负责请求接收、参数校验、调用 Service、返回响应
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const GardenService = require('../game/services/GardenService');
const auth = require('../middleware/auth');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 初始化服务（注入配置加载器）
const configLoader = infrastructure.ConfigLoader;
GardenService.initialize(configLoader);

/**
 * GET /api/garden/status
 * 查询药园完整状态（含所有地块、成熟状态、可用种子列表）
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const gardenStatus = await GardenService.getGardenStatus(player.id);
        res.json({ code: 200, data: gardenStatus });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/garden/plant
 * 播种
 * body: { plot_index: number, seed_id: string }
 */
router.post('/plant', auth, async (req, res, next) => {
    try {
        const { plot_index, seed_id } = req.body;

        // 参数校验
        if (!plot_index || !Number.isInteger(plot_index) || plot_index < 1) {
            throw new AppError('地块序号无效（需为正整数）', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!seed_id || typeof seed_id !== 'string') {
            throw new AppError('种子ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await GardenService.plant(player.id, plot_index, seed_id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/garden/harvest
 * 采收指定地块的成熟作物
 * body: { plot_index: number }
 */
router.post('/harvest', auth, async (req, res, next) => {
    try {
        const { plot_index } = req.body;

        if (!plot_index || !Number.isInteger(plot_index) || plot_index < 1) {
            throw new AppError('地块序号无效（需为正整数）', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await GardenService.harvest(player.id, plot_index);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/garden/harvest-all
 * 一键采收所有成熟作物
 */
router.post('/harvest-all', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await GardenService.harvestAll(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
