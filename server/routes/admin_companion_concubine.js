/**
 * GM 后台道侣/侍妾系统管理路由
 *
 * 统一管理批次3道侣/侍妾系统的 GM 操作：
 *
 * 道侣系统：
 *   1. POST /api/admin/companion-concubine/dao-companion/break：强制解除道侣
 *   2. POST /api/admin/companion-concubine/dao-companion/set-heart-contract：调整心契等级
 *   3. POST /api/admin/companion-concubine/heart-tribulation/trigger：触发心劫
 *
 * 侍妾系统：
 *   4. POST /api/admin/companion-concubine/concubine/grant：直接发放侍妾
 *   5. POST /api/admin/companion-concubine/concubine/set-attr：调整侍妾属性
 *   6. POST /api/admin/companion-concubine/voyage/finish：立即完成远航
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作必须记录 admin_logs 表（操作人、操作类型、目标、详情）
 *
 * 对应玩法文档：批次3设计文档第5章（道侣 / 侍妾系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const CompanionService = require('../game/services/CompanionService');
const ConcubineService = require('../game/services/ConcubineService');
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
        console.error('[AdminCompanionConcubine] 记录管理员日志失败:', error);
    }
}

// ==================== 道侣系统管理接口 ====================

/**
 * POST /api/admin/companion-concubine/dao-companion/break
 * GM 强制解除道侣关系
 * 请求体：{ player_id: number }
 */
router.post('/dao-companion/break', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }

        const result = await CompanionService.gmBreakDaoCompanion(player_id);
        if (result.success) {
            await logAdminAction(req.player.id, 'companion_break', {
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
 * POST /api/admin/companion-concubine/dao-companion/set-heart-contract
 * GM 调整心契等级（0-5）
 * 请求体：{ player_id: number, level: number(0-5) }
 */
router.post('/dao-companion/set-heart-contract', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, level } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!Number.isInteger(level) || level < 0 || level > 5) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'level 必须为 0-5 之间的整数'
            });
        }

        const result = await CompanionService.gmSetHeartContractLevel(player_id, level);
        if (result.success) {
            await logAdminAction(req.player.id, 'companion_set_heart_contract', {
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

/**
 * POST /api/admin/companion-concubine/heart-tribulation/trigger
 * GM 触发心劫事件
 * 请求体：{ player_id: number }
 */
router.post('/heart-tribulation/trigger', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }

        const result = await CompanionService.gmTriggerHeartTribulation(player_id);
        if (result.success) {
            await logAdminAction(req.player.id, 'companion_trigger_heart_tribulation', {
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

// ==================== 侍妾系统管理接口 ====================

/**
 * POST /api/admin/companion-concubine/concubine/grant
 * GM 直接发放侍妾
 * 请求体：{ player_id: number, concubine_key: string }
 */
router.post('/concubine/grant', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, concubine_key } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!concubine_key || typeof concubine_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_key 必填且必须为字符串'
            });
        }

        const result = await ConcubineService.gmGrantConcubine(player_id, concubine_key);
        if (result.success) {
            await logAdminAction(req.player.id, 'concubine_grant', {
                player_id, concubine_key, message: result.message
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
 * POST /api/admin/companion-concubine/concubine/set-attr
 * GM 调整侍妾属性
 * 请求体：{
 *   concubine_id: number,
 *   attr: 'charm'|'intimacy'|'loyalty'|'exp'|'realm_rank',
 *   value: number
 * }
 */
router.post('/concubine/set-attr', auth, adminCheck, async (req, res, next) => {
    try {
        const { concubine_id, attr, value } = req.body;
        if (!concubine_id || typeof concubine_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'concubine_id 必填且必须为数字'
            });
        }
        const allowedAttrs = ['charm', 'intimacy', 'loyalty', 'exp', 'realm_rank'];
        if (!allowedAttrs.includes(attr)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `attr 必须为 ${allowedAttrs.join('/')} 之一`
            });
        }
        if (typeof value !== 'number' || value < 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'value 必须为非负数'
            });
        }

        const result = await ConcubineService.gmSetConcubineAttr(concubine_id, attr, value);
        if (result.success) {
            await logAdminAction(req.player.id, 'concubine_set_attr', {
                concubine_id, attr, value, message: result.message
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
 * POST /api/admin/companion-concubine/voyage/finish
 * GM 立即完成远航
 * 请求体：{ voyage_id: number }
 */
router.post('/voyage/finish', auth, adminCheck, async (req, res, next) => {
    try {
        const { voyage_id } = req.body;
        if (!voyage_id || typeof voyage_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'voyage_id 必填且必须为数字'
            });
        }

        const result = await ConcubineService.gmFinishVoyage(voyage_id);
        if (result.success) {
            await logAdminAction(req.player.id, 'concubine_voyage_finish', {
                voyage_id, message: result.message
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
