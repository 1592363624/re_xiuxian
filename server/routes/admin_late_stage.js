/**
 * GM 后台后期系统管理路由
 *
 * 统一管理批次3后期系统 6 大子系统的 GM 操作：
 *
 * 第二元神系统：
 *   1. POST /api/admin/late-stage/second-soul/adjust-attributes：调整副元神属性
 *
 * 小世界系统：
 *   2. POST /api/admin/late-stage/small-world/reset：重置玩家小世界
 *   3. POST /api/admin/late-stage/small-world/set-level：调整小世界等级
 *
 * 神庙系统：
 *   4. POST /api/admin/late-stage/divine-temple/set-level：调整神庙等级
 *
 * 香火系统：
 *   5. POST /api/admin/late-stage/incense/grant：发放/扣减香火
 *
 * 神识系统：
 *   6. POST /api/admin/late-stage/divine-sense/grant：发放/扣减神识
 *
 * 法则系统：
 *   7. POST /api/admin/late-stage/law/grant-points：发放/扣减法则点
 *   8. POST /api/admin/late-stage/law/grant-fragment：发放/扣减法则碎片
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作必须记录 admin_logs 表（操作人、操作类型、目标、详情）
 *
 * 对应玩法文档：批次3设计文档第4章（后期系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const SecondSoulService = require('../game/services/SecondSoulService');
const SmallWorldService = require('../game/services/SmallWorldService');
const DivineTempleService = require('../game/services/DivineTempleService');
const IncenseService = require('../game/services/IncenseService');
const DivineSenseService = require('../game/services/DivineSenseService');
const LawService = require('../game/services/LawService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 管理员权限中间件
 * 校验 req.player.role === 'admin'，否则拒绝访问
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 记录管理员操作日志（审计）
 * 注意：日志写入失败不阻塞主流程，仅打印告警
 * @param {number} adminId - 管理员ID
 * @param {string} action - 操作类型
 * @param {Object} details - 操作详情
 * @param {Object} req - 请求对象（用于获取 IP）
 */
async function logAdminAction(adminId, action, details, req) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action,
            details: JSON.stringify(details),
            ip: req.ip || req.connection?.remoteAddress
        });
    } catch (error) {
        console.error('[AdminLateStage] 记录管理员日志失败:', error);
    }
}

// ==================== 第二元神系统管理接口 ====================

/**
 * POST /api/admin/late-stage/second-soul/adjust-attributes
 * GM 调整副元神属性（atk/def/hp_max/speed/sense）
 * 请求体：{ player_id: number, soul_index: 2|3, attributes: { atk?, def?, hp_max?, speed?, sense? } }
 */
router.post('/second-soul/adjust-attributes', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, soul_index, attributes } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (![2, 3].includes(Number(soul_index))) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'soul_index 必须为 2 或 3'
            });
        }
        if (!attributes || typeof attributes !== 'object') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'attributes 必须为对象'
            });
        }

        const result = await SecondSoulService.gmAdjustAttributes(player_id, Number(soul_index), attributes);
        if (result.success) {
            await logAdminAction(req.player.id, 'late_stage_soul_adjust_attrs', {
                player_id, soul_index, attributes, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

// ==================== 小世界系统管理接口 ====================

/**
 * POST /api/admin/late-stage/small-world/reset
 * GM 重置玩家小世界（删除小世界与神庙记录，玩家可重新开辟）
 * 请求体：{ player_id: number }
 */
router.post('/small-world/reset', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }

        const result = await SmallWorldService.gmReset(player_id);
        if (result.success) {
            await logAdminAction(req.player.id, 'late_stage_small_world_reset', {
                player_id, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/late-stage/small-world/set-level
 * GM 调整小世界等级（1-10）
 * 请求体：{ player_id: number, level: number(1-10) }
 */
router.post('/small-world/set-level', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, level } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!Number.isInteger(level) || level < 1 || level > 10) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'level 必须为 1-10 之间的整数'
            });
        }

        const result = await SmallWorldService.gmSetLevel(player_id, level);
        if (result.success) {
            await logAdminAction(req.player.id, 'late_stage_small_world_set_level', {
                player_id, level, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

// ==================== 神庙系统管理接口 ====================

/**
 * POST /api/admin/late-stage/divine-temple/set-level
 * GM 调整神庙等级（1-10）
 * 请求体：{ player_id: number, level: number(1-10) }
 */
router.post('/divine-temple/set-level', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, level } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!Number.isInteger(level) || level < 1 || level > 10) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'level 必须为 1-10 之间的整数'
            });
        }

        const result = await DivineTempleService.gmSetLevel(player_id, level);
        if (result.success) {
            await logAdminAction(req.player.id, 'late_stage_temple_set_level', {
                player_id, level, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

// ==================== 香火系统管理接口 ====================

/**
 * POST /api/admin/late-stage/incense/grant
 * GM 发放/扣减香火
 * 请求体：{ player_id: number, amount: number(正数发放/负数扣减，范围 -1000000~1000000) }
 */
router.post('/incense/grant', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, amount } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!Number.isInteger(amount) || amount === 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'amount 必须为非零整数'
            });
        }

        const result = await IncenseService.gmGrant(player_id, amount);
        if (result.success) {
            await logAdminAction(req.player.id, 'late_stage_incense_grant', {
                player_id, amount, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

// ==================== 神识系统管理接口 ====================

/**
 * POST /api/admin/late-stage/divine-sense/grant
 * GM 发放/扣减神识
 * 请求体：{ player_id: number, amount: number(正数发放/负数扣减，范围 -10000~10000) }
 */
router.post('/divine-sense/grant', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, amount } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!Number.isInteger(amount) || amount === 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'amount 必须为非零整数'
            });
        }

        const result = await DivineSenseService.gmGrant(player_id, amount);
        if (result.success) {
            await logAdminAction(req.player.id, 'late_stage_divine_sense_grant', {
                player_id, amount, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

// ==================== 法则系统管理接口 ====================

/**
 * POST /api/admin/late-stage/law/grant-points
 * GM 发放/扣减法则点
 * 请求体：{ player_id: number, amount: number(正数发放/负数扣减，范围 -10000~10000) }
 */
router.post('/law/grant-points', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, amount } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!Number.isInteger(amount) || amount === 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'amount 必须为非零整数'
            });
        }

        const result = await LawService.gmGrantPoints(player_id, amount);
        if (result.success) {
            await logAdminAction(req.player.id, 'late_stage_law_grant_points', {
                player_id, amount, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/late-stage/law/grant-fragment
 * GM 发放/扣减法则碎片
 * 请求体：{
 *   player_id: number,
 *   fragment_type: 'space'|'time'|'five_elements'|'soul'|'karma',
 *   amount: number(正数发放/负数扣减，范围 -1000~1000)
 * }
 */
router.post('/law/grant-fragment', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, fragment_type, amount } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!['space', 'time', 'five_elements', 'soul', 'karma'].includes(fragment_type)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'fragment_type 必须为 space/time/five_elements/soul/karma 之一'
            });
        }
        if (!Number.isInteger(amount) || amount === 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'amount 必须为非零整数'
            });
        }

        const result = await LawService.gmGrantFragment(player_id, fragment_type, amount);
        if (result.success) {
            await logAdminAction(req.player.id, 'late_stage_law_grant_fragment', {
                player_id, fragment_type, amount, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;