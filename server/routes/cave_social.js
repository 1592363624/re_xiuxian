/**
 * 洞府社交系统路由
 *
 * 提供洞府社交玩法接口：拜访洞府、留言、查看留言/访客、布置景观、洞府商人
 * 路由仅负责请求接收、参数校验、调用 Service、返回响应，不含业务逻辑
 *
 * 对应玩法文档指令：
 *   - 拜访洞府      -> POST /api/cave-social/visit
 *   - 洞府留言      -> POST /api/cave-social/messages
 *   - 查看留言      -> GET  /api/cave-social/messages
 *   - 查看访客      -> GET  /api/cave-social/visitors
 *   - 布置景观      -> POST /api/cave-social/landscape
 *   - 查看货品      -> GET  /api/cave-social/merchant
 *   - 购买商品      -> POST /api/cave-social/merchant/buy
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const CaveSocialService = require('../game/services/CaveSocialService');
const auth = require('../middleware/auth');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 初始化服务（注入配置加载器）
const configLoader = infrastructure.ConfigLoader;
CaveSocialService.initialize(configLoader);

/**
 * POST /api/cave-social/visit
 * 拜访他人洞府
 * body: { target_player_id: number }
 */
router.post('/visit', auth, async (req, res, next) => {
    try {
        const { target_player_id } = req.body;
        if (!target_player_id) {
            throw new AppError('目标玩家ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.visitCave(player.id, Number(target_player_id));
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/messages
 * 在他人洞府留言
 * body: { target_player_id: number, content: string }
 */
router.post('/messages', auth, async (req, res, next) => {
    try {
        const { target_player_id, content } = req.body;
        if (!target_player_id) {
            throw new AppError('目标玩家ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!content) {
            throw new AppError('留言内容不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.leaveMessage(player.id, Number(target_player_id), content);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/messages
 * 查看自己洞府的留言列表
 * query: { limit?: number }
 */
router.get('/messages', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const result = await CaveSocialService.getMessages(player.id, limit);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/visitors
 * 查看自己洞府的访客记录
 * query: { limit?: number }
 */
router.get('/visitors', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const result = await CaveSocialService.getVisitors(player.id, limit);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/landscapes
 * 查询可布置的景观列表（含已布置状态）
 */
router.get('/landscapes', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const PlayerCave = require('../models/playerCave');
        const cave = await PlayerCave.findOne({ where: { player_id: player.id } });
        const landscapes = CaveSocialService.getLandscapesConfig();

        const result = landscapes.map(l => ({
            id: l.id,
            name: l.name,
            description: l.description,
            cost: l.cost,
            bonus: l.bonus,
            required_realm_rank: l.required_realm_rank,
            can_setup: (player.realm_rank || 0) >= l.required_realm_rank,
            is_current: cave?.landscape_id === l.id
        }));

        res.json({ code: 200, data: { landscapes: result, current_landscape_id: cave?.landscape_id || null } });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/landscape
 * 布置洞府景观
 * body: { landscape_id: string }
 */
router.post('/landscape', auth, async (req, res, next) => {
    try {
        const { landscape_id } = req.body;
        if (!landscape_id) {
            throw new AppError('景观ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.setLandscape(player.id, landscape_id);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/merchant
 * 查看洞府商人货品（按时间自动刷新）
 */
router.get('/merchant', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.getMerchantGoods(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/merchant/buy
 * 购买洞府商人商品
 * body: { item_index: number, quantity?: number }
 */
router.post('/merchant/buy', auth, async (req, res, next) => {
    try {
        const { item_index, quantity = 1 } = req.body;
        if (!item_index) {
            throw new AppError('商品编号不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.buyMerchantItem(player.id, Number(item_index), Number(quantity));
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
