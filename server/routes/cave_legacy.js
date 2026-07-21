/**
 * 坐化遗府系统路由
 *
 * 提供玩家端和管理员端的 HTTP 接口：
 *
 *   玩家端接口（需 auth 中间件）：
 *     1. GET  /api/cave-legacy/active：查看当前开启的遗府
 *     2. POST /api/cave-legacy/spin：转动分宝（每期每人一次）
 *     3. GET  /api/cave-legacy/history：查询分宝记录
 *
 *   管理员端接口（需 auth + adminCheck 双层鉴权）：
 *     4. POST /api/cave-legacy/admin/preview：预览遗府（查询可分配物品 + 合格玩家估算）
 *     5. POST /api/cave-legacy/admin/open：开启遗府活动
 *     6. POST /api/cave-legacy/admin/close：手动关闭遗府
 *     7. GET  /api/cave-legacy/admin/status：查看后台状态
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 CaveLegacyService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 管理员接口必须通过 adminCheck 二次校验（req.player.role === 'admin'）
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：第16节"坐化遗府"
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const CaveLegacyService = require('../game/services/CaveLegacyService');
const AdminLog = require('../models/admin_log');
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
 * 统一包装 Service 返回结果为 HTTP 响应
 * 约定：成功返回 { code: 200, message, data }；失败返回 { code: 200, success: false, message, error_code }
 * @param {Object} result - Service 返回的 { success, message, data, error_code }
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
        console.error('[CaveLegacy] 记录管理员日志失败:', error);
    }
}

// ==================== 玩家端接口 ====================

/**
 * GET /api/cave-legacy/active
 * 查看当前开启的遗府（含玩家参与状态、剩余物品摘要）
 */
router.get('/active', auth, async (req, res, next) => {
    try {
        const result = await CaveLegacyService.getActiveLegacy(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/cave-legacy/spin
 * 转动分宝（每期每人一次）
 * 请求体：{ legacy_id: number }
 */
router.post('/spin', auth, async (req, res, next) => {
    try {
        const { legacy_id } = req.body;
        const legacyIdNum = Number(legacy_id);
        if (!Number.isFinite(legacyIdNum) || legacyIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'legacy_id 无效'
            });
        }
        const result = await CaveLegacyService.spinLegacy(req.player, legacyIdNum);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/cave-legacy/history
 * 查询玩家本人的分宝记录
 * 查询参数：page（页码，默认1）、page_size（每页条数，默认10）
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const { page, page_size } = req.query;
        const result = await CaveLegacyService.getHistory(req.player, page, page_size);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

// ==================== 管理员端接口 ====================

/**
 * POST /api/cave-legacy/admin/preview
 * 预览遗府：查询坐化玩家的可分配资产和合格玩家估算
 * 请求体：{ owner_player_id: number }
 */
router.post('/admin/preview', auth, adminCheck, async (req, res, next) => {
    try {
        const { owner_player_id } = req.body;
        const ownerIdNum = Number(owner_player_id);
        if (!Number.isFinite(ownerIdNum) || ownerIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'owner_player_id 无效'
            });
        }
        const result = await CaveLegacyService.previewLegacy(req.player, ownerIdNum);
        if (result.success) {
            await logAdminAction(req.player.id, 'cave_legacy_preview', {
                owner_player_id: ownerIdNum,
                items_count: result.data?.items_count,
                eligible_estimate: result.data?.eligible_players_estimate
            }, req);
        }
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/cave-legacy/admin/open
 * 开启遗府活动
 * 请求体：{ owner_player_id: number, duration_hours?: number }
 */
router.post('/admin/open', auth, adminCheck, async (req, res, next) => {
    try {
        const { owner_player_id, duration_hours } = req.body;
        const ownerIdNum = Number(owner_player_id);
        if (!Number.isFinite(ownerIdNum) || ownerIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'owner_player_id 无效'
            });
        }
        const result = await CaveLegacyService.openLegacy(req.player, ownerIdNum, duration_hours);
        if (result.success) {
            await logAdminAction(req.player.id, 'cave_legacy_open', {
                owner_player_id: ownerIdNum,
                duration_hours: duration_hours || 24,
                legacy_id: result.data?.legacy_id,
                items_count: result.data?.items_count
            }, req);
        }
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/cave-legacy/admin/close
 * 管理员手动关闭遗府
 * 请求体：{ legacy_id: number }
 */
router.post('/admin/close', auth, adminCheck, async (req, res, next) => {
    try {
        const { legacy_id } = req.body;
        const legacyIdNum = Number(legacy_id);
        if (!Number.isFinite(legacyIdNum) || legacyIdNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'legacy_id 无效'
            });
        }
        const result = await CaveLegacyService.closeLegacy(req.player, legacyIdNum);
        if (result.success) {
            await logAdminAction(req.player.id, 'cave_legacy_close', {
                legacy_id: legacyIdNum,
                summary: result.data?.summary
            }, req);
        }
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/cave-legacy/admin/status
 * 管理员查看后台状态：所有遗府列表（含已关闭）
 * 查询参数：status（状态过滤：open/closed/all，默认 all）、page、page_size
 */
router.get('/admin/status', auth, adminCheck, async (req, res, next) => {
    try {
        const { status, page, page_size } = req.query;
        const result = await CaveLegacyService.getAdminStatus(req.player, status || 'all', page || 1, page_size || 20);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
