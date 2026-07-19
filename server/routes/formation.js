/**
 * 阵法系统路由
 *
 * 提供玩家端阵法玩法的 HTTP 接口：
 * 1. GET    /api/formation/config：获取阵法全局配置与全阵法列表（前端展示规则用）
 * 2. GET    /api/formation/status：查询玩家阵法状态总览（已学/激活/熟练度/冷却）
 * 3. POST   /api/formation/learn：学习阵法（消耗灵石，需境界+前置）
 * 4. POST   /api/formation/activate：布阵激活（消耗灵石，4小时持续）
 * 5. POST   /api/formation/deactivate：撤阵（30分钟冷却）
 * 6. GET    /api/formation/active-effect：获取当前激活阵法效果（战力预览用）
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 FormationService 中
 * 阵法为被动效果，不进入状态机互斥，无需 canStart 校验
 *
 * 对应玩法文档：第17章（战力、阵法与日常试刀）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const FormationService = require('../game/services/FormationService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * @param {Object} result - Service 返回的 { success, message, data, error_code }
 * @param {Object} res - Express 响应对象
 */
function sendServiceResult(result, res) {
    if (result.success) {
        return res.json({
            code: 200,
            message: result.message,
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

/**
 * GET /api/formation/config
 * 获取阵法全局配置与全阵法列表
 * 该接口为只读操作，不需要登录（用于展示规则）
 */
router.get('/config', async (req, res, next) => {
    try {
        const config = FormationService.getConfig();
        res.json({
            code: 200,
            data: config
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/formation/status
 * 查询玩家阵法状态总览（已学/激活/熟练度/冷却）
 * 该接口为只读操作，不需要状态机校验
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const status = await FormationService.getStatus(req.player);
        res.json({
            code: 200,
            data: status
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/formation/learn
 * 学习阵法
 * 请求体：{ formation_id: string }
 *
 * 校验：境界达标 + 前置阵法 + 灵石消耗
 */
router.post('/learn', auth, async (req, res, next) => {
    try {
        const { formation_id } = req.body;

        // 参数校验
        if (!formation_id || typeof formation_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'formation_id 必填且必须为字符串'
            });
        }

        const result = await FormationService.learnFormation(req.player, formation_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/formation/activate
 * 布阵激活
 * 请求体：{ formation_id: string }
 *
 * 校验：已学习 + 无其他激活阵法（或已超时）+ 撤阵冷却已过 + 灵石消耗
 */
router.post('/activate', auth, async (req, res, next) => {
    try {
        const { formation_id } = req.body;

        if (!formation_id || typeof formation_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'formation_id 必填且必须为字符串'
            });
        }

        const result = await FormationService.activateFormation(req.player, formation_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/formation/deactivate
 * 撤阵
 * 撤阵后进入冷却期（默认30分钟），期间不可再次布阵
 */
router.post('/deactivate', auth, async (req, res, next) => {
    try {
        const result = await FormationService.deactivateFormation(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/formation/active-effect
 * 获取当前激活阵法效果（战力预览用）
 * 可选查询参数：?opponent_category=attack（用于PVP相克判定预览）
 */
router.get('/active-effect', auth, async (req, res, next) => {
    try {
        const opponentCategory = req.query.opponent_category || null;
        // 校验对手类型（如提供）
        const validCategories = ['attack', 'defense', 'support', 'special'];
        if (opponentCategory && !validCategories.includes(opponentCategory)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `opponent_category 可选值：${validCategories.join('/')}`
            });
        }

        const effect = await FormationService.getActiveFormationEffect(req.player, opponentCategory);
        res.json({
            code: 200,
            data: effect
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
