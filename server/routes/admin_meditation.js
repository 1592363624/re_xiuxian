/**
 * GM 后台 悟道与瓶颈管理路由
 *
 * 提供以下接口：
 * 1. GET  /list：分页查询所有正在悟道或处于瓶颈期的玩家
 * 2. GET  /:playerId：查询指定玩家的悟道状态与瓶颈详情
 * 3. POST /:playerId/force-settle：强制结算玩家悟道
 * 4. POST /:playerId/force-interrupt：强制中断玩家悟道（带惩罚）
 * 5. PUT  /:playerId/bottleneck：修改瓶颈状态（用于测试和补偿）
 * 6. POST /:playerId/bottleneck/reset：重置瓶颈状态
 * 7. GET  /metrics：获取悟道与瓶颈系统统计指标
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 */
'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const Player = require('../models/player');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const MeditationService = require('../game/services/MeditationService');
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
 * 记录管理员操作日志
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
 * GET /api/admin/meditation/metrics
 * 获取悟道与瓶颈系统统计指标
 * 注意：此路由必须放在 /:playerId 路由之前，否则 "metrics" 会被解析为 playerId
 */
router.get('/metrics', auth, adminCheck, async (req, res, next) => {
    try {
        // 当前悟道中的玩家数
        const meditatingCount = await Player.count({ where: { is_meditating: true } });

        // 各瓶颈状态的玩家数
        const bottleneckActive = await Player.count({ where: { bottleneck_state: 'active' } });
        const bottleneckBroken = await Player.count({ where: { bottleneck_state: 'broken' } });
        const bottleneckFailed = await Player.count({ where: { bottleneck_state: 'failed' } });
        const bottleneckNone = await Player.count({ where: { bottleneck_state: 'none' } });

        // 各境界瓶颈玩家分布
        const bottleneckByRealm = await Player.findAll({
            attributes: [
                'realm_rank',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            where: {
                bottleneck_state: { [Op.in]: ['active', 'broken', 'failed'] }
            },
            group: ['realm_rank'],
            raw: true
        });

        const cfg = MeditationService.getMeditationConfig();
        const btCfg = MeditationService.getBreakthroughConfig();

        res.json({
            code: 200,
            data: {
                meditation: {
                    meditating_count: meditatingCount,
                    daily_normal_limit: cfg.daily_normal_limit,
                    daily_deep_limit: cfg.daily_deep_limit,
                    cooldown_seconds: cfg.cooldown_seconds
                },
                bottleneck: {
                    enabled: btCfg.bottleneck_enabled !== false,
                    bottleneck_realms: btCfg.bottleneck_realms || [],
                    max_failure_count: btCfg.bottleneck_max_failure_count || 3,
                    broken_bonus: btCfg.broken_breakthrough_bonus || 30,
                    state_distribution: {
                        none: bottleneckNone,
                        active: bottleneckActive,
                        broken: bottleneckBroken,
                        failed: bottleneckFailed
                    },
                    by_realm: bottleneckByRealm
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/meditation/list
 * 分页查询所有正在悟道或处于瓶颈期的玩家
 */
router.get('/list', auth, adminCheck, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = (page - 1) * limit;
        const filter = req.query.filter || 'all';  // all/meditating/bottleneck

        const whereClause = {};
        if (filter === 'meditating') {
            whereClause.is_meditating = true;
        } else if (filter === 'bottleneck') {
            whereClause.bottleneck_state = { [Op.in]: ['active', 'broken', 'failed'] };
        } else {
            whereClause[Op.or] = [
                { is_meditating: true },
                { bottleneck_state: { [Op.in]: ['active', 'broken', 'failed'] } }
            ];
        }

        const { count, rows } = await Player.findAndCountAll({
            attributes: [
                'id', 'nickname', 'realm', 'realm_rank',
                'is_meditating', 'meditation_mode', 'meditation_start_time', 'meditation_end_time', 'meditation_duration',
                'bottleneck_state', 'bottleneck_realm_rank', 'bottleneck_insight', 'bottleneck_threshold',
                'bottleneck_started_at', 'breakthrough_failure_count',
                'last_meditation_time', 'daily_meditation_count', 'daily_deep_meditation_count'
            ],
            where: whereClause,
            limit,
            offset,
            order: [['id', 'ASC']]
        });

        res.json({
            code: 200,
            data: {
                list: rows,
                total: count,
                page,
                pageSize: limit
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/meditation/:playerId
 * 查询指定玩家的悟道状态与瓶颈详情
 */
router.get('/:playerId', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId);
        if (!playerId) {
            return res.status(400).json({ code: 400, message: 'playerId 参数无效' });
        }

        const player = await Player.findByPk(playerId, {
            attributes: [
                'id', 'nickname', 'realm', 'realm_rank', 'exp', 'spirit_stones',
                'is_meditating', 'meditation_mode', 'meditation_start_time', 'meditation_end_time', 'meditation_duration',
                'meditation_insight', 'daily_meditation_count', 'daily_deep_meditation_count',
                'last_meditation_date', 'last_meditation_time',
                'bottleneck_state', 'bottleneck_realm_rank', 'bottleneck_insight', 'bottleneck_threshold',
                'bottleneck_started_at', 'breakthrough_failure_count'
            ]
        });

        if (!player) {
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        res.json({
            code: 200,
            data: player
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/meditation/:playerId/force-settle
 * 强制结算玩家悟道（无惩罚，相当于自动到期）
 */
router.post('/:playerId/force-settle', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parseInt(req.params.playerId);

        const locked = await Player.findByPk(playerId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });

        if (!locked) {
            await t.commit();
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        if (!locked.is_meditating) {
            await t.commit();
            return res.status(400).json({ code: 400, message: '该玩家当前未在悟道中' });
        }

        const cfg = MeditationService.getMeditationConfig();
        const result = await MeditationService._settleMeditation(locked, cfg, {
            transaction: t,
            source: 'gm_force_settle'
        });

        await t.commit();

        await logAdminAction(req.player.id, 'meditation_force_settle', {
            target_id: playerId,
            mode: result.mode,
            insight_gain: result.insight_gain,
            exp_gain: result.exp_gain,
            bottleneck_broken: result.bottleneck_broken
        }, req);

        res.json({
            code: 200,
            message: '悟道已强制结算',
            data: result
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

/**
 * POST /api/admin/meditation/:playerId/force-interrupt
 * 强制中断玩家悟道（带惩罚）
 */
router.post('/:playerId/force-interrupt', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId);
        const result = await MeditationService.interruptMeditation(playerId);

        await logAdminAction(req.player.id, 'meditation_force_interrupt', {
            target_id: playerId,
            insight_gain: result.insight_gain,
            exp_gain: result.exp_gain
        }, req);

        res.json({
            code: 200,
            message: '悟道已强制中断（带惩罚）',
            data: result
        });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({
                code: error.statusCode,
                error_code: error.errorCode,
                message: error.message
            });
        }
        next(error);
    }
});

/**
 * PUT /api/admin/meditation/:playerId/bottleneck
 * 修改瓶颈状态（用于测试和补偿）
 * 请求体：{ bottleneck_state?, bottleneck_insight?, bottleneck_threshold?, breakthrough_failure_count? }
 */
router.put('/:playerId/bottleneck', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parseInt(req.params.playerId);
        const { bottleneck_state, bottleneck_insight, bottleneck_threshold, breakthrough_failure_count } = req.body;

        const locked = await Player.findByPk(playerId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });

        if (!locked) {
            await t.commit();
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        const updates = {};
        if (bottleneck_state !== undefined) {
            const allowedStates = ['none', 'active', 'broken', 'failed'];
            if (!allowedStates.includes(bottleneck_state)) {
                await t.commit();
                return res.status(400).json({ code: 400, message: `bottleneck_state 无效，可选值：${allowedStates.join('/')}` });
            }
            updates.bottleneck_state = bottleneck_state;
            if (bottleneck_state === 'none') {
                updates.bottleneck_realm_rank = null;
                updates.bottleneck_insight = 0;
                updates.bottleneck_threshold = 100;
                updates.bottleneck_started_at = null;
                updates.breakthrough_failure_count = 0;
            } else if (bottleneck_state === 'active' && !locked.bottleneck_started_at) {
                updates.bottleneck_started_at = new Date();
            }
        }
        if (bottleneck_insight !== undefined) {
            updates.bottleneck_insight = Math.max(0, Math.min(bottleneck_insight, locked.bottleneck_threshold || 100));
        }
        if (bottleneck_threshold !== undefined) {
            updates.bottleneck_threshold = Math.max(1, bottleneck_threshold);
        }
        if (breakthrough_failure_count !== undefined) {
            updates.breakthrough_failure_count = Math.max(0, breakthrough_failure_count);
        }

        await locked.update(updates, { transaction: t });
        await t.commit();

        await logAdminAction(req.player.id, 'meditation_modify_bottleneck', {
            target_id: playerId,
            updates
        }, req);

        res.json({
            code: 200,
            message: '瓶颈状态已更新',
            data: {
                id: locked.id,
                nickname: locked.nickname,
                bottleneck_state: locked.bottleneck_state,
                bottleneck_insight: locked.bottleneck_insight,
                bottleneck_threshold: locked.bottleneck_threshold,
                breakthrough_failure_count: locked.breakthrough_failure_count
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

/**
 * POST /api/admin/meditation/:playerId/bottleneck/reset
 * 重置瓶颈状态（清空所有瓶颈字段）
 */
router.post('/:playerId/bottleneck/reset', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parseInt(req.params.playerId);

        const locked = await Player.findByPk(playerId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });

        if (!locked) {
            await t.commit();
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        locked.bottleneck_state = 'none';
        locked.bottleneck_realm_rank = null;
        locked.bottleneck_insight = 0;
        locked.bottleneck_threshold = 100;
        locked.bottleneck_started_at = null;
        locked.breakthrough_failure_count = 0;
        await locked.save({ transaction: t });
        await t.commit();

        await logAdminAction(req.player.id, 'meditation_reset_bottleneck', {
            target_id: playerId
        }, req);

        res.json({
            code: 200,
            message: '瓶颈状态已重置',
            data: {
                id: locked.id,
                nickname: locked.nickname,
                bottleneck_state: locked.bottleneck_state
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

/**
 * GET /api/admin/meditation/metrics
 * 获取悟道与瓶颈系统统计指标（已移到文件前部，此处仅为注释占位）
 * 真正实现在文件顶部
 */

module.exports = router;
