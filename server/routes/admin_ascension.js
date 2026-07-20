/**
 * GM 后台飞升+夺舍重生系统管理路由
 *
 * 提供以下接口：
 *   1. GET    /stats：飞升系统全局统计（飞升人数、成功率、活跃节点数）
 *   2. GET    /players：玩家飞升进度列表（分页）
 *   3. POST   /set-dayan-level：GM 调整大衍诀层数
 *   4. POST   /give-law-fragment：GM 发放法则碎片
 *   5. POST   /give-coord：GM 发放逆灵通道坐标
 *   6. POST   /reset-cooldown：GM 重置飞升冷却
 *   7. GET    /targets：夺舍目标列表
 *   8. POST   /targets：新增夺舍目标
 *   9. PUT    /targets/:id：编辑夺舍目标
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作必须记录 admin_logs 表（操作人、操作类型、目标、详情）
 *
 * 对应玩法文档：批次3设计文档第3章（飞升+夺舍重生系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const AscensionService = require('../game/services/AscensionService');
const ReincarnationService = require('../game/services/ReincarnationService');
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
        console.error('[AdminAscension] 记录管理员日志失败:', error);
    }
}

// ==================== 飞升系统管理接口 ====================

/**
 * GET /api/admin/ascension/stats
 * 获取飞升系统全局统计（飞升人数、成功率、活跃节点数、状态分布）
 */
router.get('/stats', auth, adminCheck, async (req, res, next) => {
    try {
        const stats = await AscensionService.gmGetStats();
        res.json({ code: 200, data: stats });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/ascension/players
 * 查询玩家飞升进度列表（分页）
 * 查询参数：?page=1&page_size=20
 */
router.get('/players', auth, adminCheck, async (req, res, next) => {
    try {
        const page = req.query.page ? parseInt(req.query.page, 10) : 1;
        const pageSize = req.query.page_size ? parseInt(req.query.page_size, 10) : 20;
        if (page < 1 || pageSize < 1 || pageSize > 100) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'page 必须 >=1，page_size 必须在 1-100 之间'
            });
        }
        const result = await AscensionService.gmGetPlayerList(page, pageSize);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/ascension/set-dayan-level
 * GM 调整大衍诀层数
 * 请求体：{ player_id: number, level: number(0-5) }
 */
router.post('/set-dayan-level', auth, adminCheck, async (req, res, next) => {
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

        const result = await AscensionService.gmSetDayanLevel(player_id, level);
        if (result.success) {
            await logAdminAction(req.player.id, 'ascension_set_dayan_level', {
                player_id, level, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/ascension/give-law-fragment
 * GM 发放法则碎片
 * 请求体：{ player_id: number, count: number(1-100) }
 */
router.post('/give-law-fragment', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, count } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'count 必须为 1-100 之间的整数'
            });
        }

        const result = await AscensionService.gmGiveLawFragment(player_id, count);
        if (result.success) {
            await logAdminAction(req.player.id, 'ascension_give_law_fragment', {
                player_id, count, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/ascension/give-coord
 * GM 发放逆灵通道坐标
 * 请求体：{ player_id: number, coord?: string }（coord 可选，默认随机生成）
 */
router.post('/give-coord', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, coord } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (coord !== undefined && coord !== null && typeof coord !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'coord 必须为字符串'
            });
        }

        const result = await AscensionService.gmGiveCoord(player_id, coord || null);
        if (result.success) {
            await logAdminAction(req.player.id, 'ascension_give_coord', {
                player_id, coord: coord || 'auto_generated', message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/ascension/reset-cooldown
 * GM 重置飞升冷却
 * 请求体：{ player_id: number }
 */
router.post('/reset-cooldown', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }

        const result = await AscensionService.gmResetCooldown(player_id);
        if (result.success) {
            await logAdminAction(req.player.id, 'ascension_reset_cooldown', {
                player_id, message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null
        });
    } catch (err) {
        next(err);
    }
});

// ==================== 夺舍目标管理接口 ====================

/**
 * GET /api/admin/ascension/targets
 * 获取所有夺舍目标配置列表
 */
router.get('/targets', auth, adminCheck, async (req, res, next) => {
    try {
        const result = await ReincarnationService.gmGetTargets();
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/ascension/targets
 * 新增夺舍目标
 * 请求体：{
 *   target_key: string, target_name: string, target_type: 'mortal'|'cultivator'|'monster',
 *   realm_rank: number, base_atk: number, base_def: number, base_hp_max: number,
 *   base_speed: number, base_sense: number, spirit_root_grade?: string, talent_id?: string,
 *   inherit_ratio?: number, drop_realm_count?: number, risk_level: 1|2|3,
 *   description?: string, weight?: number, is_rare?: boolean
 * }
 */
router.post('/targets', auth, adminCheck, async (req, res, next) => {
    try {
        const result = await ReincarnationService.gmCreateTarget(req.body);
        if (result.success) {
            await logAdminAction(req.player.id, 'ascension_create_target', {
                target_key: req.body.target_key,
                target_name: req.body.target_name,
                target_type: req.body.target_type
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
 * PUT /api/admin/ascension/targets/:id
 * 编辑夺舍目标
 * 路径参数：id - 目标ID
 * 请求体：可更新字段（target_name / target_type / realm_rank / base_atk / base_def / base_hp_max / base_speed / base_sense / inherit_ratio / drop_realm_count / risk_level / description / weight / is_rare）
 */
router.put('/targets/:id', auth, adminCheck, async (req, res, next) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (!targetId || isNaN(targetId)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '目标 ID 必须为数字'
            });
        }

        const result = await ReincarnationService.gmUpdateTarget(targetId, req.body);
        if (result.success) {
            await logAdminAction(req.player.id, 'ascension_update_target', {
                target_id: targetId,
                updates: req.body
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