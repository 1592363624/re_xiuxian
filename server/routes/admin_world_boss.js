/**
 * GM 后台世界BOSS管理路由
 *
 * 提供世界BOSS系统的GM管理接口（参考 docs/批次2_多人玩法设计方案.md 第二章）：
 *   1. GET    /metrics              - 统计指标（活跃BOSS数/总击杀数/赛季数）
 *   2. GET    /bosses               - 分页查询所有BOSS实例（含已结束）
 *   3. GET    /seasons              - 分页查询所有赛季
 *   4. POST   /spawn                - 手动刷新BOSS（body: boss_key, custom_hp?）
 *   5. POST   /:bossId/expire       - 强制过期BOSS（GM介入）
 *   6. POST   /season/create        - 创建新赛季（body: season_name, start_date, end_date）
 *   7. POST   /season/:seasonId/settle - 强制结算赛季（GM介入）
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作记录 admin_logs 表（操作人/操作类型/目标/详情/IP）
 */
'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const WorldBoss = require('../models/worldBoss');
const WorldBossSeason = require('../models/worldBossSeason');
const WorldBossDamageRecord = require('../models/worldBossDamageRecord');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const WorldBossService = require('../game/services/WorldBossService');
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
 * GET /api/admin/world-boss/metrics
 * 统计指标
 * 注意：此路由必须放在 /:bossId 之前，否则 "metrics" 会被解析为 bossId
 */
router.get('/metrics', auth, adminCheck, async (req, res, next) => {
    try {
        // 当前活跃BOSS数（pending + active）
        const activeBossCount = await WorldBoss.count({
            where: { status: { [Op.in]: ['pending', 'active'] } }
        });

        // 历史总击杀BOSS数
        const totalBossesKilled = await WorldBoss.count({ where: { status: 'defeated' } });

        // 当前活跃赛季数
        const activeSeasonCount = await WorldBossSeason.count({ where: { status: 'active' } });

        // 总赛季数
        const totalSeasons = await WorldBossSeason.count();

        // 今日参与世界BOSS的玩家数（去重）
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        const todayParticipants = await WorldBossDamageRecord.count({
            where: {
                is_participant: 1,
                updated_at: { [Op.between]: [todayStart, todayEnd] }
            },
            distinct: true,
            col: 'player_id'
        });

        // 当前配置
        const cfg = WorldBossService.getWorldBossConfig();

        res.json({
            code: 200,
            data: {
                active_boss_count: activeBossCount,
                total_bosses_killed: totalBossesKilled,
                active_season_count: activeSeasonCount,
                total_seasons: totalSeasons,
                today_participants: todayParticipants,
                config: {
                    enabled: cfg.enabled !== false,
                    attack_cooldown_seconds: cfg.attack_cooldown_seconds || 5,
                    revive_cost_spirit_stones: cfg.revive_cost_spirit_stones || 1000,
                    revive_cooldown_seconds: cfg.revive_cooldown_seconds || 60
                }
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/world-boss/bosses
 * 分页查询所有BOSS实例（含已结束）
 * query: page=1, limit=20, status=pending|active|defeated|expired（可选过滤）
 * 注意：此路由必须放在 /:bossId 之前
 */
router.get('/bosses', auth, adminCheck, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const offset = (page - 1) * limit;
        const statusFilter = req.query.status;

        const whereClause = {};
        if (['pending', 'active', 'defeated', 'expired'].includes(statusFilter)) {
            whereClause.status = statusFilter;
        }

        const { count, rows } = await WorldBoss.findAndCountAll({
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
                bosses: rows.map(b => ({
                    boss_id: b.id,
                    boss_key: b.boss_key,
                    boss_name: b.boss_name,
                    realm_rank_min: b.realm_rank_min,
                    hp_max: b.hp_max?.toString() || '0',
                    hp_current: b.hp_current?.toString() || '0',
                    phase: b.phase,
                    status: b.status,
                    spawn_time: b.spawn_time,
                    active_start_time: b.active_start_time,
                    defeat_time: b.defeat_time,
                    expire_time: b.expire_time,
                    season_id: b.season_id,
                    total_damage_taken: b.total_damage_taken?.toString() || '0',
                    total_damage_dealt: b.total_damage_dealt?.toString() || '0',
                    participant_count: b.participant_count,
                    killer_player_id: b.killer_player_id,
                    killer_nickname: b.killer_nickname,
                    first_kill_server: b.first_kill_server === 1
                }))
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/world-boss/seasons
 * 分页查询所有赛季
 * query: page=1, limit=20, status=active|pending|ended（可选过滤）
 * 注意：此路由必须放在 /:bossId 之前
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

        const { count, rows } = await WorldBossSeason.findAndCountAll({
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
                seasons: rows.map(s => ({
                    season_id: s.id,
                    season_name: s.season_name,
                    start_date: s.start_date,
                    end_date: s.end_date,
                    status: s.status,
                    total_bosses_killed: s.total_bosses_killed,
                    total_damage_dealt: s.total_damage_dealt?.toString() || '0',
                    settlement_time: s.settlement_time
                }))
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/world-boss/spawn
 * 手动刷新BOSS
 * body: { boss_key: string, custom_hp?: number, season_id?: number }
 * 审计：记录 admin_logs
 */
router.post('/spawn', auth, adminCheck, async (req, res, next) => {
    try {
        const { boss_key, custom_hp, season_id } = req.body;

        if (!boss_key) {
            throw new AppError('boss_key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // custom_hp 安全校验：必须为正整数
        const customHp = custom_hp ? parseInt(custom_hp) : null;
        if (customHp !== null && (isNaN(customHp) || customHp <= 0)) {
            throw new AppError('custom_hp 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const seasonId = season_id ? parseInt(season_id) : 0;

        const result = await WorldBossService.spawnBoss(boss_key, seasonId, customHp);

        // 审计日志
        await logAdminAction(req.player.id, 'world_boss_spawn', {
            boss_key,
            boss_id: result.boss_id,
            custom_hp: customHp,
            season_id: seasonId
        }, req);

        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/world-boss/season/create
 * 创建新赛季
 * body: { season_name: string, start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD' }
 * 审计：记录 admin_logs
 * 注意：此路由必须放在 /:bossId 之前
 */
router.post('/season/create', auth, adminCheck, async (req, res, next) => {
    try {
        const { season_name, start_date, end_date } = req.body;

        if (!season_name || !start_date || !end_date) {
            throw new AppError('赛季名称/开始日期/结束日期不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await WorldBossService.createSeason(season_name, start_date, end_date);

        // 审计日志
        await logAdminAction(req.player.id, 'world_boss_season_create', {
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
 * POST /api/admin/world-boss/season/:seasonId/settle
 * 强制结算赛季
 * 审计：记录 admin_logs
 * 注意：此路由必须放在 /:bossId 之前
 */
router.post('/season/:seasonId/settle', auth, adminCheck, async (req, res, next) => {
    try {
        const seasonId = parseInt(req.params.seasonId);
        if (!seasonId || seasonId <= 0) {
            throw new AppError('赛季ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await WorldBossService.settleSeason(seasonId);

        // 审计日志
        await logAdminAction(req.player.id, 'world_boss_season_settle', {
            season_id: seasonId,
            season_name: result.season_name,
            total_bosses_killed: result.total_bosses_killed
        }, req);

        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/world-boss/:bossId/expire
 * 强制过期BOSS（GM介入）
 * 适用场景：BOSS配置错误/玩家卡死/紧急下线
 * 审计：记录 admin_logs
 */
router.post('/:bossId/expire', auth, adminCheck, async (req, res, next) => {
    try {
        const bossId = parseInt(req.params.bossId);
        if (!bossId || bossId <= 0) {
            throw new AppError('BOSS ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await WorldBossService.expireBoss(bossId);

        // 审计日志
        await logAdminAction(req.player.id, 'world_boss_force_expire', {
            boss_id: bossId,
            boss_name: result.boss_name
        }, req);

        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
