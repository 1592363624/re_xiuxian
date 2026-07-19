/**
 * 宗门专属玩法系统路由
 *
 * 提供六大宗门各自专属玩法的接口：
 *   - 灵眼之树（落云宗）：浇灌/采收/查询
 *   - 观星台（星宫）：观星/查询
 *   - 命盘推演（天星宗）：推演/查询
 *   - 天阶试炼（凌霄宫）：攀登/查询
 *   - 魔道功法（阴罗宗）：修炼/净化/查询
 *   - 炉鼎侍妾（合欢宗）：问安/反哺/远航/护法/查询
 *
 * 路由仅负责请求接收、参数校验、调用 Service、返回响应，不含业务逻辑
 *
 * 路由前缀：/api/sect-special
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const SectSpecialService = require('../game/services/SectSpecialService');
const auth = require('../middleware/auth');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 初始化服务（注入配置加载器，与 cave_social.js 风格一致）
const configLoader = infrastructure.ConfigLoader;
SectSpecialService.initialize(configLoader);

// ==================== 公共接口 ====================

/**
 * GET /api/sect-special/info
 * 获取玩家宗门专属玩法信息（自动根据宗门返回对应子系统数据）
 */
router.get('/info', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.getSpecialInfo(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 灵眼之树（落云宗） ====================

/**
 * GET /api/sect-special/tree
 * 查询灵眼树状态
 */
router.get('/tree', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.getTreeInfo(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/tree/water
 * 浇灌灵眼树
 */
router.post('/tree/water', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.waterTree(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/tree/harvest
 * 采收灵眼果
 */
router.post('/tree/harvest', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.harvestTree(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 观星台（星宫） ====================

/**
 * GET /api/sect-special/star
 * 查询观星状态和当前 buff
 */
router.get('/star', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.getStarInfo(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/star/observe
 * 观星（每日免费1次，额外消耗灵石）
 */
router.post('/star/observe', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.observeStar(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 命盘推演（天星宗） ====================

/**
 * GET /api/sect-special/fate
 * 查询命盘状态和当前 buff
 */
router.get('/fate', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.getFateInfo(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/fate/divine
 * 推演命盘（每日免费1次，额外消耗灵石）
 */
router.post('/fate/divine', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.divineFate(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 天阶试炼（凌霄宫） ====================

/**
 * GET /api/sect-special/stairs
 * 查询天阶状态
 */
router.get('/stairs', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.getStairsInfo(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/stairs/climb
 * 攀登天阶（每日3次，消耗灵石）
 */
router.post('/stairs/climb', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.climbStairs(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 魔道功法（阴罗宗） ====================

/**
 * GET /api/sect-special/dark-arts
 * 查询魔道状态
 */
router.get('/dark-arts', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.getDarkArtsInfo(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/dark-arts/practice
 * 修炼魔道（每日3次，消耗灵石）
 */
router.post('/dark-arts/practice', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.practiceDarkArts(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/dark-arts/purify
 * 净化魔气（每日1次，消耗灵石）
 */
router.post('/dark-arts/purify', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.purifyCorruption(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 炉鼎侍妾（合欢宗） ====================

/**
 * GET /api/sect-special/furnace
 * 查询炉鼎状态
 */
router.get('/furnace', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.getFurnaceInfo(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/furnace/greet
 * 每日问安（获得贡献、经验、灵力恢复）
 */
router.post('/furnace/greet', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.greetConcubine(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/furnace/feedback
 * 灵力反哺（消耗灵力获得经验）
 */
router.post('/furnace/feedback', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.feedbackSpirit(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/furnace/voyage
 * 开始远航（选择路线，等待时间后结算）
 * body: { route_id: string }
 */
router.post('/furnace/voyage', auth, async (req, res, next) => {
    try {
        const { route_id } = req.body;
        if (!route_id) {
            throw new AppError('远航路线ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.startVoyage(player.id, route_id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/furnace/voyage/settle
 * 远航归来结算
 */
router.post('/furnace/voyage/settle', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.settleVoyage(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/sect-special/furnace/protect
 * 请侍妾护法（获得突破加成 buff）
 */
router.post('/furnace/protect', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await SectSpecialService.protectConcubine(player.id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
