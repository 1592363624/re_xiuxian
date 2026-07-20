/**
 * 世界BOSS玩家路由
 *
 * 提供世界BOSS系统的玩家侧接口（参考 docs/批次2_多人玩法设计方案.md 第二章）：
 *   1. GET    /available            - 获取可挑战的BOSS列表（含状态/HP/阶段/参与人数）
 *   2. GET    /:bossId              - 获取BOSS详情（含技能/排行前10/玩家战绩）
 *   3. POST   /:bossId/attack       - 攻击BOSS（body: skill_id 可选，默认 basic）
 *   4. POST   /:bossId/revive       - 原地复活（消耗灵石，60秒CD）
 *   5. POST   /:bossId/retreat      - 撤退（5分钟内禁入）
 *   6. GET    /:bossId/ranking      - 获取伤害排行（query: type=personal|sect, limit）
 *   7. GET    /season/ranking       - 获取赛季排行（query: season_id, limit）
 *   8. GET    /seasons              - 获取赛季列表
 *
 * 权限：所有接口需要 auth 中间件验证 JWT
 * 设计：路由层只做参数提取与响应包装，业务逻辑全部在 WorldBossService 中
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const WorldBossService = require('../game/services/WorldBossService');
const WorldBossSeason = require('../models/worldBossSeason');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { Op } = require('sequelize');

/**
 * GET /api/world-boss/available
 * 获取可挑战的BOSS列表
 * 注意：此路由必须放在 /:bossId 之前，否则 "available" 会被解析为 bossId
 */
router.get('/available', auth, async (req, res, next) => {
    try {
        const result = await WorldBossService.getAvailableBosses();
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/world-boss/seasons
 * 获取赛季列表（含 active/pending/ended 全部状态）
 * query: status=active|pending|ended（可选过滤），limit=20（最大100）
 * 注意：此路由必须放在 /:bossId 之前
 */
router.get('/seasons', auth, async (req, res, next) => {
    try {
        const statusFilter = req.query.status;
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);

        const whereClause = {};
        if (['active', 'pending', 'ended'].includes(statusFilter)) {
            whereClause.status = statusFilter;
        }

        const seasons = await WorldBossSeason.findAll({
            where: whereClause,
            order: [['id', 'DESC']],
            limit
        });

        res.json({
            code: 200,
            data: seasons.map(s => ({
                season_id: s.id,
                season_name: s.season_name,
                start_date: s.start_date,
                end_date: s.end_date,
                status: s.status,
                total_bosses_killed: s.total_bosses_killed,
                total_damage_dealt: s.total_damage_dealt?.toString() || '0',
                settlement_time: s.settlement_time
            }))
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/world-boss/season/ranking
 * 获取赛季排行
 * query: season_id（必填）, limit=100（最大500）
 * 注意：此路由必须放在 /:bossId 之前
 */
router.get('/season/ranking', auth, async (req, res, next) => {
    try {
        const seasonId = parseInt(req.query.season_id);
        const limit = parseInt(req.query.limit) || 100;

        if (!seasonId) {
            throw new AppError('赛季ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await WorldBossService.getSeasonRanking(seasonId, limit);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/world-boss/:bossId
 * 获取BOSS详情
 * 包含：基础信息/当前HP/阶段/技能列表/伤害排行前10/当前玩家战绩
 */
router.get('/:bossId', auth, async (req, res, next) => {
    try {
        const bossId = parseInt(req.params.bossId);
        if (!bossId || bossId <= 0) {
            throw new AppError('BOSS ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.player.id;
        const result = await WorldBossService.getBossDetail(bossId, playerId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/world-boss/:bossId/ranking
 * 获取伤害排行（个人或宗门）
 * query: type=personal|sect（默认 personal）, limit=100（最大500）
 */
router.get('/:bossId/ranking', auth, async (req, res, next) => {
    try {
        const bossId = parseInt(req.params.bossId);
        if (!bossId || bossId <= 0) {
            throw new AppError('BOSS ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const type = req.query.type === 'sect' ? 'sect' : 'personal';
        const limit = parseInt(req.query.limit) || 100;

        const result = await WorldBossService.getDamageRanking(bossId, type, limit);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/world-boss/:bossId/attack
 * 攻击BOSS
 * body: { skill_id?: string } - 技能ID，可选，默认 'basic'
 * 返回：伤害值/BOSS反击/阶段切换/是否击杀/奖励等
 */
router.post('/:bossId/attack', auth, async (req, res, next) => {
    try {
        const bossId = parseInt(req.params.bossId);
        if (!bossId || bossId <= 0) {
            throw new AppError('BOSS ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.player.id;
        const skillId = req.body.skill_id || 'basic';

        // skill_id 安全校验：仅允许字母数字下划线，防止注入
        if (!/^[a-zA-Z0-9_]+$/.test(skillId)) {
            throw new AppError('技能ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await WorldBossService.attackBoss(playerId, bossId, skillId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/world-boss/:bossId/revive
 * 原地复活
 * 消耗灵石（默认 1000），60秒CD
 * 仅在 BOSS 战死亡状态下可调用
 */
router.post('/:bossId/revive', auth, async (req, res, next) => {
    try {
        const bossId = parseInt(req.params.bossId);
        if (!bossId || bossId <= 0) {
            throw new AppError('BOSS ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.player.id;
        const result = await WorldBossService.revive(playerId, bossId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/world-boss/:bossId/retreat
 * 撤退
 * 主动脱离BOSS战，5分钟内不可再次加入
 */
router.post('/:bossId/retreat', auth, async (req, res, next) => {
    try {
        const bossId = parseInt(req.params.bossId);
        if (!bossId || bossId <= 0) {
            throw new AppError('BOSS ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.player.id;
        const result = await WorldBossService.retreat(playerId, bossId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
