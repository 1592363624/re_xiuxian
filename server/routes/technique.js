/**
 * 功法系统路由
 *
 * 提供功法的查询、习得、修炼、层数突破、神通领悟、装备切换等接口。
 * 所有接口均需登录鉴权（authMiddleware 会向 req 注入 player）。
 *
 * 错误处理约定：
 *   业务异常统一由 TechniqueService 抛出 AppError（携带 statusCode 与 errorCode），
 *   此处捕获后按其 statusCode 返回；未知异常一律降级为 500，避免泄漏内部堆栈。
 */
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const TechniqueService = require('../game/services/TechniqueService');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');

/**
 * 统一异常响应处理
 * 说明：AppError 带有 statusCode 属性，属于可预期的业务错误，直接透传给前端展示；
 *       其余异常记录日志后返回通用错误信息。
 * @param {Error} error - 捕获的异常
 * @param {Object} res - Express 响应对象
 * @param {string} fallbackMsg - 未知异常时的兜底提示
 */
function handleError(error, res, fallbackMsg) {
    if (error && error.statusCode) {
        return res.status(error.statusCode).json({
            code: error.statusCode,
            message: error.message,
            error_code: error.errorCode
        });
    }
    console.error(`${fallbackMsg}:`, error);
    return res.status(500).json({ code: 500, message: fallbackMsg });
}

/**
 * 获取功法总览（已习得 + 可习得）
 * GET /api/technique/list
 */
router.get('/list', authMiddleware, async (req, res) => {
    try {
        const data = await TechniqueService.getPlayerTechniques(req.player.id);
        res.json({ code: 200, data });
    } catch (error) {
        handleError(error, res, '获取功法列表失败');
    }
});

/**
 * 习得功法
 * POST /api/technique/learn
 * body: { technique_id: string }
 */
router.post('/learn', authMiddleware, async (req, res) => {
    try {
        const { technique_id } = req.body;
        if (!technique_id || typeof technique_id !== 'string') {
            return res.status(400).json({ code: 400, message: '缺少参数：technique_id' });
        }

        const result = await TechniqueService.learnTechnique(req.player.id, technique_id);
        // 事务已提交，推送资源变更（研习消耗灵石或宗门贡献），驱动前端资源条刷新
        // 说明：前端收到 player:updated 后会 fetchPlayer 全覆盖，changes 仅作语义标记/日志，不含过期数值
        WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'technique_learn', {
            cost: result.cost
        });
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        handleError(error, res, '习得功法失败');
    }
});

/**
 * 修炼功法（提升熟练度）
 * POST /api/technique/practice
 * body: { technique_id: string }
 */
router.post('/practice', authMiddleware, async (req, res) => {
    try {
        const { technique_id } = req.body;
        if (!technique_id || typeof technique_id !== 'string') {
            return res.status(400).json({ code: 400, message: '缺少参数：technique_id' });
        }

        const result = await TechniqueService.practice(req.player.id, technique_id);
        // 修炼会扣灵石/灵力、加修为，事务提交后推送，驱动前端资源条联动刷新
        WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'technique_practice', {
            spirit_stone_cost: result.spirit_stone_cost,
            mp_cost: result.mp_cost,
            exp_gain: result.exp_gain
        });
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        handleError(error, res, '修炼功法失败');
    }
});

/**
 * 突破功法层数
 * POST /api/technique/breakthrough
 * body: { technique_id: string }
 */
router.post('/breakthrough', authMiddleware, async (req, res) => {
    try {
        const { technique_id } = req.body;
        if (!technique_id || typeof technique_id !== 'string') {
            return res.status(400).json({ code: 400, message: '缺少参数：technique_id' });
        }

        const result = await TechniqueService.breakthrough(req.player.id, technique_id);
        // 突破扣灵石，事务提交后推送，驱动前端资源条联动刷新
        WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'technique_breakthrough', {
            spirit_stone_cost: result.spirit_stone_cost,
            breakthrough_success: result.breakthrough_success
        });
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        handleError(error, res, '功法突破失败');
    }
});

/**
 * 领悟神通
 * POST /api/technique/comprehend
 * body: { technique_id: string }
 */
router.post('/comprehend', authMiddleware, async (req, res) => {
    try {
        const { technique_id } = req.body;
        if (!technique_id || typeof technique_id !== 'string') {
            return res.status(400).json({ code: 400, message: '缺少参数：technique_id' });
        }

        const result = await TechniqueService.comprehend(req.player.id, technique_id);
        // 领悟神通扣灵石，事务提交后推送，驱动前端资源条联动刷新
        WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'technique_comprehend', {
            spirit_stone_cost: result.spirit_stone_cost,
            comprehend_success: result.comprehend_success
        });
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        handleError(error, res, '领悟神通失败');
    }
});

/**
 * 装备/卸下功法
 * POST /api/technique/equip
 * body: { technique_id: string, slot: 'main' | 'auxiliary' | null }
 */
router.post('/equip', authMiddleware, async (req, res) => {
    try {
        const { technique_id, slot } = req.body;
        if (!technique_id || typeof technique_id !== 'string') {
            return res.status(400).json({ code: 400, message: '缺少参数：technique_id' });
        }
        // slot 允许显式传 null（表示卸下），因此只校验非 null 时的取值合法性
        if (slot !== null && slot !== undefined && !['main', 'auxiliary'].includes(slot)) {
            return res.status(400).json({ code: 400, message: 'slot 只能为 main / auxiliary / null' });
        }

        const result = await TechniqueService.equipTechnique(
            req.player.id,
            technique_id,
            slot === undefined ? null : slot
        );
        // 装备（主修切换）可能扣灵石，事务提交后推送，驱动前端资源条联动刷新
        WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'technique_equip', {
            cost: result.cost,
            equip_slot: result.equip_slot
        });
        res.json({ code: 200, message: result.message, data: result });
    } catch (error) {
        handleError(error, res, '功法装备操作失败');
    }
});

module.exports = router;
