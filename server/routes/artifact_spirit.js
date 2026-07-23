/**
 * 器灵系统玩家路由
 *
 * 提供玩家端器灵系统的 HTTP 接口（玩法文档第7节/第895-909行 法宝、器灵与徽章）：
 *   1. POST /api/artifact-spirit/awaken：唤醒器灵（消耗资源绑定到指定已装备法宝）
 *   2. GET  /api/artifact-spirit/list：我的器灵列表
 *   3. GET  /api/artifact-spirit/:spirit_id：器灵详情
 *   4. POST /api/artifact-spirit/trial：器灵试炼（每日次数限制，累计分进排行榜）
 *   5. POST /api/artifact-spirit/protect：器灵护主（开启限时减伤/反弹/回血状态）
 *   6. POST /api/artifact-spirit/activate：催发器灵（限时属性爆发）
 *   7. POST /api/artifact-spirit/pet：抚摸法宝（增加亲密度+经验，CD冷却）
 *   8. POST /api/artifact-spirit/nurture：温养器灵（增加力量值，CD冷却+灵石消耗）
 *   9. GET  /api/artifact-spirit/trial-ranking：器灵试炼榜（全服累计分排行）
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 ArtifactSpiritService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *   - 注意：/:spirit_id 动态路由必须放在 /trial-ranking 之后，避免 "trial-ranking" 被当作 spirit_id
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ArtifactSpiritService = require('../game/services/ArtifactSpiritService');
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
    return res.json({
        code: 200,
        success: false,
        message: result.message,
        data: result.data || null,
        error_code: result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR
    });
}

/**
 * POST /api/artifact-spirit/awaken
 * 唤醒器灵（消耗灵石+物品，在指定已装备法宝上唤醒器灵）
 * 请求体：{ equipment_id: number, spirit_type: 'attack'|'defense'|'support'|'balance', spirit_name?: string }
 */
router.post('/awaken', auth, async (req, res, next) => {
    try {
        const { equipment_id, spirit_type, spirit_name } = req.body;

        // 参数校验
        const equipmentIdNum = Number(equipment_id);
        if (!Number.isFinite(equipmentIdNum) || equipmentIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'equipment_id 必须为正整数'
            });
        }
        if (!['attack', 'defense', 'support', 'balance'].includes(spirit_type)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'spirit_type 仅支持 attack/defense/support/balance'
            });
        }
        if (spirit_name !== undefined && spirit_name !== null && typeof spirit_name !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'spirit_name 必须为字符串'
            });
        }

        const result = await ArtifactSpiritService.awaken(req.player.id, equipmentIdNum, spirit_type, spirit_name);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/artifact-spirit/list
 * 我的器灵列表（含装备配置合并展示）
 * 该接口为只读操作
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const result = await ArtifactSpiritService.getMySpirits(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/artifact-spirit/trial-ranking
 * 器灵试炼榜（全服累计分排行）
 * 查询参数：page（页码，默认1）、page_size（每页条数，默认20）
 * 注意：该路由必须在 /:spirit_id 之前定义，否则 "trial-ranking" 会被当作 spirit_id
 */
router.get('/trial-ranking', auth, async (req, res, next) => {
    try {
        const { page, page_size } = req.query;
        const result = await ArtifactSpiritService.getTrialRanking(req.player.id, page, page_size);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/artifact-spirit/:spirit_id
 * 器灵详情（单个器灵完整状态、冷却时间、试炼记录）
 * 路径参数：spirit_id
 */
router.get('/:spirit_id', auth, async (req, res, next) => {
    try {
        const spiritIdNum = Number(req.params.spirit_id);
        if (!Number.isFinite(spiritIdNum) || spiritIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'spirit_id 必须为正整数'
            });
        }
        const result = await ArtifactSpiritService.getSpiritDetail(req.player.id, spiritIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/artifact-spirit/trial
 * 器灵试炼（按器灵战力评分获取奖励，每日次数限制）
 * 请求体：{ spirit_id: number }
 */
router.post('/trial', auth, async (req, res, next) => {
    try {
        const { spirit_id } = req.body;
        const spiritIdNum = Number(spirit_id);
        if (!Number.isFinite(spiritIdNum) || spiritIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'spirit_id 必须为正整数'
            });
        }
        const result = await ArtifactSpiritService.trial(req.player.id, spiritIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/artifact-spirit/protect
 * 器灵护主（开启限时护主状态，消耗亲密度）
 * 请求体：{ spirit_id: number }
 */
router.post('/protect', auth, async (req, res, next) => {
    try {
        const { spirit_id } = req.body;
        const spiritIdNum = Number(spirit_id);
        if (!Number.isFinite(spiritIdNum) || spiritIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'spirit_id 必须为正整数'
            });
        }
        const result = await ArtifactSpiritService.protect(req.player.id, spiritIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/artifact-spirit/activate
 * 催发器灵（限时属性爆发，消耗力量值）
 * 请求体：{ spirit_id: number }
 */
router.post('/activate', auth, async (req, res, next) => {
    try {
        const { spirit_id } = req.body;
        const spiritIdNum = Number(spirit_id);
        if (!Number.isFinite(spiritIdNum) || spiritIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'spirit_id 必须为正整数'
            });
        }
        const result = await ArtifactSpiritService.activate(req.player.id, spiritIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/artifact-spirit/pet
 * 抚摸法宝（增加亲密度+经验，CD冷却）
 * 请求体：{ spirit_id: number }
 */
router.post('/pet', auth, async (req, res, next) => {
    try {
        const { spirit_id } = req.body;
        const spiritIdNum = Number(spirit_id);
        if (!Number.isFinite(spiritIdNum) || spiritIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'spirit_id 必须为正整数'
            });
        }
        const result = await ArtifactSpiritService.pet(req.player.id, spiritIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/artifact-spirit/nurture
 * 温养器灵（增加力量值，CD冷却+灵石消耗）
 * 请求体：{ spirit_id: number }
 */
router.post('/nurture', auth, async (req, res, next) => {
    try {
        const { spirit_id } = req.body;
        const spiritIdNum = Number(spirit_id);
        if (!Number.isFinite(spiritIdNum) || spiritIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'spirit_id 必须为正整数'
            });
        }
        const result = await ArtifactSpiritService.nurture(req.player.id, spiritIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
