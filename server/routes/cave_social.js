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
 *   - 洞天寻宝      -> POST /api/cave-social/treasure
 *   - 寻宝日志      -> GET  /api/cave-social/treasure/logs
 *   - 访客接待列表  -> GET  /api/cave-social/visitors/reception
 *   - 接待访客      -> POST /api/cave-social/visitors/:recordId/receive
 *   - 驱逐访客      -> POST /api/cave-social/visitors/:recordId/expel
 *   - 忽略访客      -> POST /api/cave-social/visitors/:recordId/ignore
 *   - 万宝阁展品列表 -> GET    /api/cave-social/exhibits
 *   - 上架展品       -> POST   /api/cave-social/exhibits/list
 *   - 取下展品       -> DELETE /api/cave-social/exhibits/:exhibitId
 *   - 查看他人展品   -> GET    /api/cave-social/exhibits/player/:playerId
 *   - 鉴赏展品       -> POST   /api/cave-social/exhibits/:exhibitId/appreciate
 *   - 展品热度榜     -> GET    /api/cave-social/exhibits/heat-board
 *   - 我的洞天绘卷   -> GET    /api/cave-social/scroll/me
 *   - 查看他人绘卷   -> GET    /api/cave-social/scroll/player/:playerId
 *   - 题词           -> POST   /api/cave-social/scroll/:playerId/inscribe
 *   - 绘卷风貌榜     -> GET    /api/cave-social/scroll/ranking
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

// ==================== 洞天寻宝系统 ====================

/**
 * POST /api/cave-social/treasure
 * 洞天寻宝：在他人洞府探索地块寻宝
 *
 * 多人交互玩法：寻宝成功从洞府主人灵石中借取资源，失败触发陷阱/护阵惩罚
 * body: { target_player_id: number, plot_number: number }
 */
router.post('/treasure', auth, async (req, res, next) => {
    try {
        const { target_player_id, plot_number } = req.body;
        if (!target_player_id) {
            throw new AppError('目标玩家ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!plot_number || !Number.isInteger(Number(plot_number))) {
            throw new AppError('地块编号必须为整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.treasureHunt(player.id, Number(target_player_id), Number(plot_number));
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/treasure/logs
 * 查询寻宝日志
 * query: { role?: 'hunter'|'owner', limit?: number }
 *   - role=hunter（默认）：查询自己作为寻宝者的记录
 *   - role=owner：查询自己洞府被他人寻宝的记录
 */
router.get('/treasure/logs', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const role = req.query.role === 'owner' ? 'owner' : 'hunter';
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const result = await CaveSocialService.getTreasureLogs(player.id, role, limit);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 接待/驱逐访客系统 ====================

/**
 * GET /api/cave-social/visitors/reception
 * 获取待处理的访客列表（洞府主人视角）
 * query: { limit?: number }
 */
router.get('/visitors/reception', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const result = await CaveSocialService.getVisitorReceptionList(player.id, limit);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/visitors/:recordId/receive
 * 接待访客（消耗灵石，赠予访客临时增益buff）
 */
router.post('/visitors/:recordId/receive', auth, async (req, res, next) => {
    try {
        const recordId = parseInt(req.params.recordId, 10);
        if (!recordId) {
            throw new AppError('访客记录ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.receiveVisitor(player.id, recordId);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/visitors/:recordId/expel
 * 驱逐访客（封锁访客拜访+寻宝24h）
 */
router.post('/visitors/:recordId/expel', auth, async (req, res, next) => {
    try {
        const recordId = parseInt(req.params.recordId, 10);
        if (!recordId) {
            throw new AppError('访客记录ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.expelVisitor(player.id, recordId);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/visitors/:recordId/ignore
 * 忽略访客（不予理睬，不影响访客行为）
 */
router.post('/visitors/:recordId/ignore', auth, async (req, res, next) => {
    try {
        const recordId = parseInt(req.params.recordId, 10);
        if (!recordId) {
            throw new AppError('访客记录ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.ignoreVisitor(player.id, recordId);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 万宝阁展品系统 ====================

/**
 * GET /api/cave-social/exhibits
 * 获取我的万宝阁展品列表
 * 返回：展品列表、当前数量、上限、最低品质要求
 */
router.get('/exhibits', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.getMyExhibits(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/exhibits/list
 * 上架展品至万宝阁
 * body: { item_key: string }
 */
router.post('/exhibits/list', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const { item_key } = req.body;
        if (!item_key) {
            throw new AppError('物品ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await CaveSocialService.listExhibit(player.id, item_key);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/cave-social/exhibits/:exhibitId
 * 从万宝阁取下展品（物品归还背包）
 */
router.delete('/exhibits/:exhibitId', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const exhibitId = parseInt(req.params.exhibitId, 10);
        if (!exhibitId) {
            throw new AppError('展品ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await CaveSocialService.unlistExhibit(player.id, exhibitId);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/exhibits/player/:playerId
 * 查看他人洞府的万宝阁展品（供鉴赏）
 * 返回：展品列表（含今日已鉴赏标记）、今日鉴赏次数、剩余次数
 */
router.get('/exhibits/player/:playerId', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const targetPlayerId = parseInt(req.params.playerId, 10);
        if (!targetPlayerId) {
            throw new AppError('目标玩家ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await CaveSocialService.viewPlayerExhibits(player.id, targetPlayerId);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/exhibits/:exhibitId/appreciate
 * 鉴赏展品（获得修为，有概率触发顿悟）
 */
router.post('/exhibits/:exhibitId/appreciate', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const exhibitId = parseInt(req.params.exhibitId, 10);
        if (!exhibitId) {
            throw new AppError('展品ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await CaveSocialService.appreciateExhibit(player.id, exhibitId);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/exhibits/heat-board
 * 获取万宝阁热度榜（全服展品热度 Top N）
 * query: { limit?: number } 默认 20，上限 100
 */
router.get('/exhibits/heat-board', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const result = await CaveSocialService.getHeatBoard(limit);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

// ==================== 洞天绘卷系统 ====================

/**
 * GET /api/cave-social/scroll/me
 * 查看自己的洞天绘卷
 *
 * 返回：洞府全景信息、风貌评级（6档）、各项得分明细、近期题词列表、今日题词状态
 * 用于玩家查看自己洞府的整体风貌与文化展示
 */
router.get('/scroll/me', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const result = await CaveSocialService.getMyScroll(player.id);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/scroll/player/:playerId
 * 查看他人洞天绘卷
 *
 * 返回：目标洞府全景信息、风貌评级、各项得分、近期题词、当前玩家对该洞府的今日题词状态
 * 用于拜访者欣赏他人洞府风貌并题词互动
 */
router.get('/scroll/player/:playerId', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const targetPlayerId = parseInt(req.params.playerId, 10);
        if (!targetPlayerId) {
            throw new AppError('目标玩家ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await CaveSocialService.viewPlayerScroll(player.id, targetPlayerId);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/cave-social/scroll/:playerId/inscribe
 * 在他人洞天绘卷上题词
 *
 * 多人交互玩法：拜访者为他人洞府题写评语，被题词者获得声望奖励（每日上限）
 * body: { content: string } 题词内容（最长20字）
 */
router.post('/scroll/:playerId/inscribe', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const targetPlayerId = parseInt(req.params.playerId, 10);
        if (!targetPlayerId) {
            throw new AppError('目标玩家ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const { content } = req.body;
        if (!content || typeof content !== 'string') {
            throw new AppError('题词内容不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await CaveSocialService.inscribeScroll(player.id, targetPlayerId, content);
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/cave-social/scroll/ranking
 * 获取洞天绘卷风貌排行榜
 *
 * 按风貌综合得分排序，展示全服洞府风貌等级 Top N
 * query: { limit?: number } 默认 20，上限 100
 */
router.get('/scroll/ranking', auth, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const result = await CaveSocialService.getScrollRanking(limit);
        res.json({ code: 200, data: result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
