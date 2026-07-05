/**
 * 洞府系统路由
 *
 * 提供洞府相关接口：开辟洞府、查询洞府、升级设施、领取灵石、解锁地块
 * 路由仅负责请求接收、参数校验、调用 Service、返回响应，不含业务逻辑
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const CaveService = require('../game/services/CaveService');
const GardenService = require('../game/services/GardenService');
const auth = require('../middleware/auth');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 初始化服务（注入配置加载器）
const configLoader = infrastructure.ConfigLoader;
CaveService.initialize(configLoader);
GardenService.initialize(configLoader);

// 有效设施类型白名单（防止注入非法参数）
const VALID_FACILITIES = ['spirit_vein', 'quiet_room', 'pill_room', 'tool_room', 'grand_formation'];

/**
 * GET /api/cave/info
 * 查询洞府完整信息（含灵脉待领取灵石、各设施等级、药园地块数）
 */
router.get('/info', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const caveInfo = await CaveService.getCaveInfo(player.id);
        res.json({ code: 200, data: caveInfo });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave/open
 * 开辟洞府（消耗灵石，激活灵脉）
 */
router.post('/open', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveService.openCave(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave/upgrade
 * 升级洞府设施
 * body: { facility: 'spirit_vein' | 'quiet_room' | 'pill_room' | 'tool_room' | 'grand_formation' }
 */
router.post('/upgrade', auth, async (req, res, next) => {
    try {
        const { facility } = req.body;

        // 参数校验（白名单防注入）
        if (!facility || !VALID_FACILITIES.includes(facility)) {
            throw new AppError(`无效的设施类型，可选: ${VALID_FACILITIES.join(', ')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveService.upgradeFacility(player.id, facility);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave/collect-stones
 * 领取灵脉产出的灵石
 */
router.post('/collect-stones', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveService.collectSpiritStones(player.id);
        res.json({
            code: 200,
            message: `成功领取 ${result.collected} 灵石`,
            data: result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave/unlock-plot
 * 解锁新的药园地块
 */
router.post('/unlock-plot', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveService.unlockGardenPlot(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
