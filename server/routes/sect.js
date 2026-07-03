/**
 * 宗门系统路由
 *
 * 提供宗门列表、详情、拜入/叛出、点卯、传功、宝库兑换、宗门任务等接口。
 * 业务逻辑全部下沉到 SectService，路由层仅做参数校验和响应封装。
 *
 * 路由顺序说明：
 *   静态路径（/list、/my、/quests 等）必须定义在动态参数路由 /:sectId 之前，
 *   否则 /list 会被 /:sectId 误匹配。
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SectService = require('../game/services/SectService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 获取所有宗门列表（基础信息）
 * GET /api/sect/list
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const list = SectService.getSectList();
        res.json({ code: 200, data: { sects: list } });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取我的宗门信息（合并静态配置 + 动态成员数据）
 * GET /api/sect/my
 */
router.get('/my', auth, async (req, res, next) => {
    try {
        const data = await SectService.getMySect(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取我的宗门任务列表（标记今日是否已完成）
 * GET /api/sect/quests
 */
router.get('/quests', auth, async (req, res, next) => {
    try {
        const data = await SectService.getQuests(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 拜入宗门
 * POST /api/sect/join
 * body: { sect_id }
 */
router.post('/join', auth, async (req, res, next) => {
    try {
        const { sect_id } = req.body;
        if (!sect_id) {
            throw new AppError('宗门ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await SectService.joinSect(req.user.id, sect_id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 叛出宗门
 * POST /api/sect/leave
 */
router.post('/leave', auth, async (req, res, next) => {
    try {
        const result = await SectService.leaveSect(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 每日点卯
 * POST /api/sect/check-in
 */
router.post('/check-in', auth, async (req, res, next) => {
    try {
        const result = await SectService.dailyCheckIn(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 宗门传功
 * POST /api/sect/transfer
 */
router.post('/transfer', auth, async (req, res, next) => {
    try {
        const result = await SectService.transferSkill(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 兑换宝库物品
 * POST /api/sect/exchange
 * body: { treasure_id }
 */
router.post('/exchange', auth, async (req, res, next) => {
    try {
        const { treasure_id } = req.body;
        if (!treasure_id) {
            throw new AppError('宝库物品ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await SectService.exchangeTreasury(req.user.id, treasure_id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 提交宗门任务
 * POST /api/sect/submit-quest
 * body: { quest_id }
 */
router.post('/submit-quest', auth, async (req, res, next) => {
    try {
        const { quest_id } = req.body;
        if (!quest_id) {
            throw new AppError('任务ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await SectService.submitQuest(req.user.id, quest_id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取宗门宝库物品列表
 * GET /api/sect/treasury/:sectId
 */
router.get('/treasury/:sectId', auth, async (req, res, next) => {
    try {
        const treasury = SectService.getTreasury(req.params.sectId);
        res.json({ code: 200, data: { treasury } });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取宗门详情（包含宝库和任务）
 * GET /api/sect/:sectId
 * 注意：动态参数路由必须放在所有静态路径之后，避免误匹配
 */
router.get('/:sectId', auth, async (req, res, next) => {
    try {
        const detail = SectService.getSectDetail(req.params.sectId);
        res.json({ code: 200, data: detail });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
