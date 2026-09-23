/**
 * GM 后台封神台管理路由
 *
 * 补上 FengshenService.settleSeason 的唯一入口：
 *   此前赛季结算写完但没有 routes / 调度器调用，赛季永远停在 1。
 *
 * 接口：
 *   1. GET  /api/admin/fengshen/season      查看当前赛季与配置摘要
 *   2. POST /api/admin/fengshen/season/settle  强制结算本赛季（发奖+积分重置+赛季递增）
 *
 * 权限：auth + adminCheck
 * 审计：写操作记录 admin_logs
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const FengshenService = require('../game/services/FengshenService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 管理员权限中间件
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 记录管理员操作日志（失败不阻塞主流程）
 */
async function logAdminAction(adminId, action, details, req) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action,
            target_id: details?.old_season ?? null,
            details: JSON.stringify(details || {}),
            ip: req?.ip || req?.connection?.remoteAddress || null
        });
    } catch (e) {
        console.warn('[admin_fengshen] 审计日志写入失败:', e.message);
    }
}

/**
 * GET /api/admin/fengshen/season
 * 当前赛季信息 + 结算配置摘要（只读，便于 GM 结算前确认）
 */
router.get('/season', auth, adminCheck, async (req, res, next) => {
    try {
        const seasonInfo = await FengshenService.getSeasonInfo();
        const cfg = typeof FengshenService.getFengshenConfig === 'function'
            ? FengshenService.getFengshenConfig()
            : {};
        res.json({
            code: 200,
            data: {
                season: seasonInfo,
                settle_config: {
                    top_rank_reward_enabled: cfg.top_rank_reward_enabled !== false,
                    top_ranks: cfg.top_ranks || [1, 2, 3],
                    rank_reward_honor: cfg.rank_reward_honor || [500, 300, 150],
                    rank_reward_stones: cfg.rank_reward_stones || [5000, 3000, 1500],
                    base_score: cfg.base_score || 1000
                }
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/fengshen/season/settle
 * 强制结算封神台赛季
 * 适用：赛季配置错误 / 紧急结束 / 系统异常时手动推进
 * 注意：会发放排名奖励、重置全员积分并递增赛季编号
 */
router.post('/season/settle', auth, adminCheck, async (req, res, next) => {
    try {
        const result = await FengshenService.settleSeason();

        await logAdminAction(req.player.id, 'fengshen_season_force_settle', {
            old_season: result.old_season,
            new_season: result.new_season,
            settled: result.settled,
            total_players: result.total_players,
            rewards_count: Array.isArray(result.rewards) ? result.rewards.length : 0,
            reason: result.reason || null
        }, req);

        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
