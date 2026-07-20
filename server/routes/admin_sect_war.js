/**
 * GM 后台宗门战管理路由
 *
 * 提供宗门战/领地争夺系统的GM管理接口（参考 docs/批次2_多人玩法设计方案.md 第三章）：
 *   1. GET    /metrics                  - 统计指标（活跃战役数/总资源点数/赛季数）
 *   2. GET    /wars                     - 分页查询所有战役（含已结算）
 *   3. GET    /seasons                  - 分页查询所有赛季
 *   4. POST   /season/create            - 创建新赛季（body: season_name, start_date, end_date）
 *   5. POST   /season/:seasonId/settle  - 强制结算赛季（GM介入）
 *   6. POST   /wars/:warId/advance      - 手动推进战役状态（应急用，慎用）
 *   7. POST   /territories/initialize   - 初始化资源点（赛季开始时调用）
 *   8. POST   /production/settle        - 手动触发资源点产出结算（应急用）
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作记录 admin_logs 表（操作人/操作类型/目标/详情/IP）
 */
'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const SectWar = require('../models/sectWar');
const SectWarSeason = require('../models/sectWarSeason');
const SectWarTerritory = require('../models/sectWarTerritory');
const SectWarParticipant = require('../models/sectWarParticipant');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const SectWarService = require('../game/services/SectWarService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

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
        console.error('记录管理员日志失败:', error);
    }
}

/**
 * GET /api/admin/sect-war/metrics
 * 统计指标
 * 注意：此路由必须放在 /:warId 之前，否则 "metrics" 会被解析为 warId
 */
router.get('/metrics', auth, adminCheck, async (req, res, next) => {
    try {
        // 各状态战役数
        const warStatusCounts = {};
        for (const status of ['preparing', 'announced', 'active', 'settled']) {
            warStatusCounts[status] = await SectWar.count({ where: { status } });
        }

        // 资源点统计
        const totalTerritories = await SectWarTerritory.count();
        const ownedTerritories = await SectWarTerritory.count({
            where: { owner_sect_id: { [Op.ne]: null } }
        });

        // 赛季统计
        const activeSeasonCount = await SectWarSeason.count({ where: { status: 'active' } });
        const totalSeasons = await SectWarSeason.count();

        // 今日参战玩家数（去重）
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        const todayParticipants = await SectWarParticipant.count({
            where: {
                join_time: { [Op.between]: [todayStart, todayEnd] }
            },
            distinct: true,
            col: 'player_id'
        });

        // 当前配置
        const cfg = SectWarService.getSectWarConfig();

        res.json({
            code: 200,
            data: {
                war_status_counts: warStatusCounts,
                active_war_count: warStatusCounts.preparing + warStatusCounts.announced + warStatusCounts.active,
                total_territories: totalTerritories,
                owned_territories: ownedTerritories,
                active_season_count: activeSeasonCount,
                total_seasons: totalSeasons,
                today_participants: todayParticipants,
                config: {
                    enabled: cfg.enabled !== false,
                    declare_cost_spirit_stones: cfg.declare_cost_spirit_stones || 5000,
                    max_attacker_count: cfg.max_attacker_count || 20,
                    max_defender_count: cfg.max_defender_count || 30,
                    respawn_seconds: cfg.respawn_seconds || 60,
                    territory_capture_seconds: cfg.territory_capture_seconds || 30
                }
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/sect-war/wars
 * 分页查询所有战役（含已结算）
 * query: page=1, limit=20, status=all|preparing|announced|active|settled（可选过滤）
 */
router.get('/wars', auth, adminCheck, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const statusFilter = req.query.status;

        const result = await SectWarService.getWarList(statusFilter || 'all', page, limit);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/sect-war/seasons
 * 分页查询所有赛季
 * query: page=1, limit=20, status=active|pending|ended（可选过滤）
 */
router.get('/seasons', auth, adminCheck, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const offset = (page - 1) * limit;
        const statusFilter = req.query.status;

        const whereClause = {};
        if (['active', 'pending', 'ended'].includes(statusFilter)) {
            whereClause.status = statusFilter;
        }

        const { count, rows } = await SectWarSeason.findAndCountAll({
            where: whereClause,
            order: [['id', 'DESC']],
            limit,
            offset
        });

        res.json({
            code: 200,
            data: {
                total: count,
                page,
                limit,
                list: rows.map(s => ({
                    season_id: s.id,
                    season_name: s.season_name,
                    start_date: s.start_date,
                    end_date: s.end_date,
                    status: s.status,
                    total_wars: s.total_wars,
                    settled: s.settled
                }))
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/sect-war/season/create
 * 创建新赛季
 * body: { season_name: string, start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD' }
 * 审计：记录 admin_logs
 */
router.post('/season/create', auth, adminCheck, async (req, res, next) => {
    try {
        const { season_name, start_date, end_date } = req.body;
        if (!season_name || !start_date || !end_date) {
            throw new AppError('赛季名称/起始日期/结束日期不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 日期格式校验（YYYY-MM-DD）
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(start_date) || !dateRegex.test(end_date)) {
            throw new AppError('日期格式错误，需为 YYYY-MM-DD', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (new Date(start_date) >= new Date(end_date)) {
            throw new AppError('起始日期必须早于结束日期', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectWarService.createSeason(season_name, start_date, end_date);

        // 审计日志
        await logAdminAction(req.player.id, 'sect_war_season_create', {
            season_id: result.season_id,
            season_name,
            start_date,
            end_date
        }, req);

        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/sect-war/season/:seasonId/settle
 * 强制结算赛季（GM介入）
 * 适用场景：赛季配置错误/紧急结束/系统异常时手动结算
 * 审计：记录 admin_logs
 */
router.post('/season/:seasonId/settle', auth, adminCheck, async (req, res, next) => {
    try {
        const seasonId = parseInt(req.params.seasonId);
        if (!seasonId || seasonId <= 0) {
            throw new AppError('赛季ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectWarService.settleSeason(seasonId);

        // 审计日志
        await logAdminAction(req.player.id, 'sect_war_season_force_settle', {
            season_id: seasonId
        }, req);

        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/sect-war/territories/initialize
 * 初始化资源点（赛季开始时调用）
 * 适用场景：赛季新建后未自动初始化资源点，或资源点数据损坏时重置
 * 注意：会清空当前赛季所有资源点的归属，慎用
 * body: { season_id: number }
 * 审计：记录 admin_logs
 */
router.post('/territories/initialize', auth, adminCheck, async (req, res, next) => {
    try {
        const seasonId = parseInt(req.body.season_id);
        if (!seasonId || seasonId <= 0) {
            throw new AppError('赛季ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 调用服务层初始化（内部使用事务）
        // initializeTerritories 返回已创建的资源点数量（数字），而非数组
        const sequelize = require('../config/database');
        const createdCount = await sequelize.transaction(async (t) => {
            return await SectWarService.initializeTerritories(seasonId, t);
        });

        // 审计日志
        await logAdminAction(req.player.id, 'sect_war_territories_init', {
            season_id: seasonId,
            territory_count: typeof createdCount === 'number' ? createdCount : 0
        }, req);

        res.json({
            code: 200,
            data: {
                season_id: seasonId,
                initialized_count: typeof createdCount === 'number' ? createdCount : 0,
                message: createdCount > 0 ? `成功初始化 ${createdCount} 个资源点` : '资源点已存在，无需重复初始化'
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/sect-war/production/settle
 * 手动触发资源点产出结算（应急用）
 * 适用场景：定时任务失败/产出未到账时手动补偿
 * 注意：会向所有归属宗门发放当日产出，可能重复发放，请确认后使用
 * 审计：记录 admin_logs
 */
router.post('/production/settle', auth, adminCheck, async (req, res, next) => {
    try {
        const result = await SectWarService.settleTerritoryProduction();

        // 审计日志
        await logAdminAction(req.player.id, 'sect_war_production_manual_settle', {
            settled_count: result?.settled_count || 0,
            total_reward: result?.total_reward || 0
        }, req);

        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/sect-war/wars/:warId/advance
 * 手动推进战役状态（应急用，慎用）
 * 适用场景：定时任务失败导致战役卡在 preparing/announced 阶段
 * 流程：preparing → announced → active → settled（自动判定结算）
 * 审计：记录 admin_logs
 */
router.post('/wars/:warId/advance', auth, adminCheck, async (req, res, next) => {
    try {
        const warId = parseInt(req.params.warId);
        if (!warId || warId <= 0) {
            throw new AppError('战役ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectWarService.advanceWarState(warId);

        // 审计日志
        await logAdminAction(req.player.id, 'sect_war_advance_state', {
            war_id: warId,
            previous_status: result?.previous_status,
            current_status: result?.current_status
        }, req);

        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
