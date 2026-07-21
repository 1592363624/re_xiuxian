/**
 * GM 后台多人副本系统管理路由
 *
 * 统一管理批次3多人副本系统的 GM 操作：
 *   1. POST /api/admin/multi-dungeon/force-dissolve：强制解散副本
 *   2. POST /api/admin/multi-dungeon/adjust-variable：调整副本变量
 *   3. POST /api/admin/multi-dungeon/grant-reward：直接发放副本奖励
 *   4. POST /api/admin/multi-dungeon/reset-cooldown：重置玩家冷却
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作必须记录 admin_logs 表（操作人、操作类型、目标、详情）
 *
 * 对应玩法文档：批次3设计文档第6章（多人副本系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const MultiDungeonService = require('../game/services/MultiDungeonService');
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
        console.error('[AdminMultiDungeon] 记录管理员日志失败:', error);
    }
}

// ==================== 多人副本系统管理接口 ====================

/**
 * POST /api/admin/multi-dungeon/force-dissolve
 * GM 强制解散副本
 * 请求体：{ instance_id: number }
 */
router.post('/force-dissolve', auth, adminCheck, async (req, res, next) => {
    try {
        const { instance_id } = req.body;
        if (!instance_id || typeof instance_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'instance_id 必填且必须为数字'
            });
        }

        const result = await MultiDungeonService.gmForceDissolve(instance_id, req.player.id);
        if (result.success) {
            await logAdminAction(req.player.id, 'multi_dungeon_force_dissolve', {
                instance_id, message: result.message
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
 * POST /api/admin/multi-dungeon/adjust-variable
 * GM 调整副本变量（通用变量 + 昆吾山/虚天殿/小极宫专属变量）
 * 请求体：{ instance_id: number, variable: string, value: number }
 *
 * 2026-07-21 扩展：支持昆吾山/虚天殿/小极宫专属变量调整
 *   - 通用：morale/vigilance/demon_corruption/seal_stability/soul_stability/harvest_multiplier
 *   - 昆吾山专属：demonic_qi/mountain_seal/treasure_pressure/linglong/seal_progress/tower_shadow_hp
 *   - 虚天殿专属：path_choice/formation_power/void_soul_hp
 *   - 小极宫专属：curse_disorder/ice_seal_power/flame_power/yinluo_banner_qi
 */
router.post('/adjust-variable', auth, adminCheck, async (req, res, next) => {
    try {
        const { instance_id, variable, value } = req.body;
        if (!instance_id || typeof instance_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'instance_id 必填且必须为数字'
            });
        }
        // 2026-07-21 扩展：支持昆吾山/虚天殿/小极宫专属变量
        const allowedVars = [
            // 通用变量
            'morale', 'vigilance', 'demon_corruption', 'seal_stability', 'soul_stability', 'harvest_multiplier',
            // 昆吾山·封魔塔专属变量
            'demonic_qi', 'mountain_seal', 'treasure_pressure', 'linglong', 'seal_progress', 'tower_shadow_hp',
            // 虚天殿专属变量
            'path_choice', 'formation_power', 'void_soul_hp',
            // 小极宫专属变量（2026-07-21 新增）
            'curse_disorder', 'ice_seal_power', 'flame_power', 'yinluo_banner_qi'
        ];
        if (!allowedVars.includes(variable)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `variable 必须为 ${allowedVars.join('/')} 之一`
            });
        }
        if (typeof value !== 'number' || Number.isNaN(value)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'value 必须为数字'
            });
        }

        const result = await MultiDungeonService.gmAdjustVariable(instance_id, variable, value, req.player.id);
        if (result.success) {
            await logAdminAction(req.player.id, 'multi_dungeon_adjust_variable', {
                instance_id, variable, value, message: result.message
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
 * POST /api/admin/multi-dungeon/grant-reward
 * GM 直接发放副本奖励
 * 请求体：{ player_id: number, dungeon_key: string, reward_key: string }
 */
router.post('/grant-reward', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, dungeon_key, reward_key } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!['yanyue', 'duanwu', 'kunwu', 'xutian'].includes(dungeon_key)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'dungeon_key 必须为 yanyue / duanwu / kunwu / xutian'
            });
        }
        if (!reward_key || typeof reward_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'reward_key 必填且必须为字符串'
            });
        }

        const result = await MultiDungeonService.gmGrantReward(player_id, dungeon_key, reward_key, req.player.id);
        if (result.success) {
            await logAdminAction(req.player.id, 'multi_dungeon_grant_reward', {
                player_id, dungeon_key, reward_key, message: result.message
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
 * POST /api/admin/multi-dungeon/reset-cooldown
 * GM 重置玩家冷却
 * 请求体：{ player_id: number, dungeon_key: string }
 * dungeon_key 支持传 'all' 重置所有副本冷却
 */
router.post('/reset-cooldown', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, dungeon_key } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!['yanyue', 'duanwu', 'kunwu', 'xutian', 'all'].includes(dungeon_key)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'dungeon_key 必须为 yanyue / duanwu / kunwu / xutian / all'
            });
        }

        const result = await MultiDungeonService.gmResetCooldown(player_id, dungeon_key, req.player.id);
        if (result.success) {
            await logAdminAction(req.player.id, 'multi_dungeon_reset_cooldown', {
                player_id, dungeon_key, message: result.message
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
