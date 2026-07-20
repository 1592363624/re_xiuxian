/**
 * 飞升+夺舍重生系统玩家路由
 *
 * 提供玩家端飞升灵界、空间节点、问道、法相天地、探寻裂缝、天机回溯、
 * 夺舍重生等玩法的 HTTP 接口：
 *
 * 飞升相关：
 *   1. GET  /api/ascension/profile：获取飞升面板
 *   2. POST /api/ascension/search-node：搜寻空间节点
 *   3. POST /api/ascension/stabilize-node：定星稳固节点
 *   4. POST /api/ascension/ascend：飞升灵界
 *   5. POST /api/ascension/revert：天机回溯
 *   6. POST /api/ascension/ask-dao：问道
 *   7. POST /api/ascension/dharma-form：修炼法相天地
 *   8. POST /api/ascension/explore-fracture：探寻裂缝
 *
 * 夺舍相关：
 *   9.  POST /api/reincarnation/reborn：触发夺舍重生
 *   10. POST /api/reincarnation/choose：选择重生目标
 *   11. GET  /api/reincarnation/records：获取夺舍记录
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 AscensionService / ReincarnationService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 状态机互斥校验在 Service 内部完成（通过 PlayerStateMachine.canStart）
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第3章（飞升+夺舍重生系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const AscensionService = require('../game/services/AscensionService');
const ReincarnationService = require('../game/services/ReincarnationService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * @param {Object} result - Service 返回的 { success, message, data }
 * @param {Object} res - Express 响应对象
 */
function sendServiceResult(result, res) {
    if (result.success) {
        return res.json({
            code: 200,
            message: result.message || 'success',
            data: result.data || null
        });
    }
    // 业务失败返回 200 + success:false，便于前端按业务提示处理
    return res.json({
        code: 200,
        success: false,
        message: result.message,
        data: result.data || null,
        error_code: result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR
    });
}

// ==================== 飞升相关接口 ====================

/**
 * GET /api/ascension/profile
 * 获取飞升面板数据（飞升进度、大衍诀、节点列表、问道感悟、法相等级、成功率预估）
 * 该接口为只读操作，不需要状态机互斥校验
 */
router.get('/ascension/profile', auth, async (req, res, next) => {
    try {
        const result = await AscensionService.getProfile(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/ascension/search-node
 * 搜寻空间节点（CD 1 小时，从 node_pool 加权随机抽取）
 * 无请求体参数
 */
router.post('/ascension/search-node', auth, async (req, res, next) => {
    try {
        const result = await AscensionService.searchNode(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/ascension/stabilize-node
 * 定星稳固节点（消耗神识+灵石，稳固 30 分钟）
 * 请求体：{ node_id: number }
 */
router.post('/ascension/stabilize-node', auth, async (req, res, next) => {
    try {
        const { node_id } = req.body;
        if (!node_id || (typeof node_id !== 'number' && typeof node_id !== 'string')) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'node_id 必填且必须为数字'
            });
        }
        const result = await AscensionService.stabilizeNode(req.player.id, Number(node_id));
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/ascension/ascend
 * 飞升灵界（事务+行级锁，成功飞升灵界，失败残魂-30、修为-10%、虚弱2小时）
 * 无请求体参数
 */
router.post('/ascension/ascend', auth, async (req, res, next) => {
    try {
        const result = await AscensionService.ascend(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/ascension/revert
 * 天机回溯（每日1次，跨日重置，回到飞升前状态）
 * 无请求体参数
 */
router.post('/ascension/revert', auth, async (req, res, next) => {
    try {
        const result = await AscensionService.revert(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/ascension/ask-dao
 * 问道（每日3次、CD 30分钟、消耗灵石、积累感悟、10%暴击双倍）
 * 无请求体参数
 */
router.post('/ascension/ask-dao', auth, async (req, res, next) => {
    try {
        const result = await AscensionService.askDao(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/ascension/dharma-form
 * 修炼法相天地（9级数值表，消耗问道感悟+灵石，失败返还30%灵石）
 * 无请求体参数
 */
router.post('/ascension/dharma-form', auth, async (req, res, next) => {
    try {
        const result = await AscensionService.practiceDharmaForm(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/ascension/explore-fracture
 * 探寻裂缝（每日5次、CD 10分钟、消耗神识+灵石、15%反噬概率）
 * 无请求体参数
 */
router.post('/ascension/explore-fracture', auth, async (req, res, next) => {
    try {
        const result = await AscensionService.exploreFracture(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

// ==================== 夺舍相关接口 ====================

/**
 * POST /api/reincarnation/reborn
 * 触发夺舍重生（飞升失败/寿命尽/PVP被杀时调用，推送3个目标按 weight 加权随机）
 * 请求体：{ death_reason: string } - 死亡原因
 *   - lifespan_out：寿元耗尽
 *   - pvp_kill：PVP 被杀
 *   - breakthrough_fail：突破失败
 *   - ascension_fail：飞升失败
 */
router.post('/reincarnation/reborn', auth, async (req, res, next) => {
    try {
        const { death_reason } = req.body;
        if (!death_reason || typeof death_reason !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'death_reason 必填且必须为字符串（lifespan_out/pvp_kill/breakthrough_fail/ascension_fail）'
            });
        }
        const result = await ReincarnationService.triggerReincarnation(req.player.id, death_reason);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/reincarnation/choose
 * 选择重生目标（事务+行级锁，计算境界跌落、属性继承、残魂恢复至50、72小时冷却）
 * 请求体：{ target_id: number }
 */
router.post('/reincarnation/choose', auth, async (req, res, next) => {
    try {
        const { target_id } = req.body;
        if (!target_id && target_id !== 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_id 必填'
            });
        }
        const result = await ReincarnationService.chooseTarget(req.player.id, Number(target_id));
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/reincarnation/records
 * 获取夺舍历史记录（分页查询）
 * 查询参数：?page=1&page_size=10
 */
router.get('/reincarnation/records', auth, async (req, res, next) => {
    try {
        const page = req.query.page ? parseInt(req.query.page, 10) : 1;
        const pageSize = req.query.page_size ? parseInt(req.query.page_size, 10) : 10;
        const result = await ReincarnationService.getRecords(req.player.id, page, pageSize);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;