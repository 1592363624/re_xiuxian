/**
 * 宗门管理路由（GM 后台）
 *
 * 提供以下接口：
 *   1. GET    /api/admin/sect/list                       - 获取所有宗门成员列表（分页、可按宗门筛选）
 *   2. GET    /api/admin/sect/stats                      - 获取宗门统计数据（成员数、总贡献度、长老数）
 *   3. PUT    /api/admin/sect/:playerId/contribution     - 调整玩家宗门贡献度
 *   4. PUT    /api/admin/sect/:playerId/role              - 设置玩家宗门身份（弟子/长老）
 *   5. POST   /api/admin/sect/:playerId/kick             - 踢出宗门
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证 + admin 权限（auth + adminCheck 双层中间件）
 *   - 业务逻辑下沉到 SectService 的 GM 辅助方法，路由层仅做参数校验与响应封装
 *   - 所有操作记录到 AdminLog，便于审计追溯
 *   - 使用 AppError + ErrorCodes 抛错，由全局 errorHandler 统一处理
 *
 * 路由顺序说明：
 *   静态路径（/list、/stats）定义在动态参数路由 /:playerId 之前，
 *   避免被 /:playerId 误匹配。
 */

const express = require('express');
const router = express.Router();

// 中间件与服务
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const SectService = require('../game/services/SectService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * GM 权限校验中间件
 * 复用 admin.js / admin_ai.js 中的 adminCheck 逻辑：检查 req.player.role === 'admin'
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 写入管理员操作日志（封装，避免代码重复）
 * @param {Object} params - { adminId, action, targetId, detail, req }
 */
async function logAdminAction({ adminId, action, targetId = null, detail = '', req = null }) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action: action,
            target_id: targetId,
            details: JSON.stringify({ detail }),
            ip: req?.ip || req?.connection?.remoteAddress || null
        });
    } catch (e) {
        // 日志写入失败不应阻塞主流程，仅打印警告
        console.error('[admin_sect] 写入操作日志失败:', e.message);
    }
}

/**
 * 校验 playerId 是否为有效正整数
 * @param {string} playerId - 路径参数
 * @returns {number} 解析后的玩家ID
 */
function parsePlayerId(playerId) {
    const id = parseInt(playerId);
    if (isNaN(id) || id <= 0) {
        throw new AppError('玩家ID必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
    }
    return id;
}

/**
 * GET /api/admin/sect/list
 * 获取所有宗门成员列表（分页，可按宗门筛选）
 * 查询参数：sect_id（可选）、page（默认1）、page_size（默认从配置读取）
 * 返回：玩家昵称、宗门ID/名称、贡献度、身份、加入时间、点卯时间、传功时间
 */
router.get('/list', auth, adminCheck, async (req, res, next) => {
    try {
        const { sect_id, page, page_size } = req.query;
        const data = await SectService.getAllMembers({
            sect_id: sect_id || undefined,
            page: page || undefined,
            page_size: page_size || undefined
        });
        res.json({
            code: 200,
            message: 'success',
            data
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/sect/stats
 * 获取宗门统计数据
 * 返回：每个宗门的成员数、总贡献度、长老数、弟子数
 */
router.get('/stats', auth, adminCheck, async (req, res, next) => {
    try {
        const stats = await SectService.getSectStats();
        res.json({
            code: 200,
            message: 'success',
            data: { sects: stats }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/sect/:playerId/contribution
 * 调整玩家宗门贡献度
 * 请求体：{ contribution: number }
 */
router.put('/:playerId/contribution', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const { contribution } = req.body;

        if (contribution === undefined) {
            throw new AppError('缺少必要参数：contribution', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectService.updateMemberContribution(playerId, contribution);

        // 记录操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'sect_update_contribution',
            targetId: playerId,
            detail: `调整玩家 ${playerId} 的宗门贡献度为 ${result.contribution}`,
            req
        });

        res.json({
            code: 200,
            message: '宗门贡献度调整成功',
            data: result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/sect/:playerId/role
 * 设置玩家宗门身份（弟子/长老）
 * 请求体：{ role: 'disciple' | 'elder' }
 */
router.put('/:playerId/role', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const { role } = req.body;

        if (!role) {
            throw new AppError('缺少必要参数：role', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectService.updateMemberRole(playerId, role);

        // 记录操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'sect_update_role',
            targetId: playerId,
            detail: `设置玩家 ${playerId} 的宗门身份为 ${result.role}`,
            req
        });

        res.json({
            code: 200,
            message: '宗门身份设置成功',
            data: result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/sect/:playerId/kick
 * 踢出宗门（删除 PlayerSect 记录，贡献度随之清空）
 */
router.post('/:playerId/kick', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const result = await SectService.kickMember(playerId);

        // 记录操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'sect_kick_member',
            targetId: playerId,
            detail: `将玩家 ${playerId} 踢出宗门【${result.sect_name}】`,
            req
        });

        res.json({
            code: 200,
            message: `已将玩家踢出宗门【${result.sect_name}】`,
            data: result
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
