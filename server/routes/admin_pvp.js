/**
 * GM 后台 PVP 斗法管理路由
 *
 * 提供以下接口：
 * 1. GET    /metrics：统计指标（在线战斗数、段位分布、今日战斗总数）
 * 2. GET    /list：分页查询玩家段位列表（query: page, limit, filter=all/top/bottom, sort=score_desc）
 * 3. GET    /:playerId：查询指定玩家 PVP 详情
 * 4. PUT    /:playerId/score：修改玩家段位积分（body: score, reason）
 * 5. POST   /:playerId/score/reset：重置玩家段位（score=0, rank=散修）
 * 6. POST   /battle/:battleId/cancel：强制取消进行中的战斗（GM 介入）
 * 7. GET    /battles：分页查询所有战斗记录（query: page, limit, player_id, status）
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作必须记录 admin_logs 表（操作人、操作类型、目标、详情）
 */
'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const Player = require('../models/player');
const PvpBattleRecord = require('../models/pvpBattleRecord');
const PvpRanking = require('../models/pvpRanking');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const PvpService = require('../game/services/PvpService');
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
 * GET /api/admin/pvp/metrics
 * 统计指标（在线战斗数、段位分布、今日战斗总数）
 * 注意：此路由必须放在 /:playerId 路由之前，否则 "metrics" 会被解析为 playerId
 */
router.get('/metrics', auth, adminCheck, async (req, res, next) => {
    try {
        // 进行中的战斗数
        const ongoingBattles = await PvpBattleRecord.count({ where: { status: 'ongoing' } });

        // 今日战斗总数（按 created_at 当日统计）
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        const todayBattleCount = await PvpBattleRecord.count({
            where: {
                created_at: { [Op.between]: [todayStart, todayEnd] }
            }
        });

        // 段位分布：按 rank_tier 分组统计玩家数
        const rankDistribution = await PvpRanking.findAll({
            attributes: [
                'rank_tier',
                [sequelize.fn('COUNT', sequelize.col('player_id')), 'count']
            ],
            group: ['rank_tier'],
            raw: true
        });

        // 段位积分 Top 10（最高分玩家）
        const topPlayers = await PvpRanking.findAll({
            attributes: ['player_id', 'score', 'rank_tier', 'season_wins', 'season_losses', 'win_streak'],
            order: [['score', 'DESC']],
            limit: 10
        });

        // 批量查询 Top 10 玩家昵称
        const topPlayerIds = topPlayers.map(r => r.player_id);
        const topPlayerInfos = topPlayerIds.length > 0
            ? await Player.findAll({
                where: { id: topPlayerIds },
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            })
            : [];
        const playerMap = new Map(topPlayerInfos.map(p => [p.id, p]));

        const topList = topPlayers.map((r, idx) => {
            const p = playerMap.get(r.player_id);
            return {
                rank: idx + 1,
                player_id: r.player_id,
                nickname: p?.nickname || '未知',
                realm: p?.realm || '凡人',
                score: r.score,
                rank_tier: r.rank_tier,
                season_wins: r.season_wins,
                season_losses: r.season_losses,
                win_streak: r.win_streak
            };
        });

        const cfg = PvpService.getPvpConfig();

        res.json({
            code: 200,
            data: {
                ongoing_battles: ongoingBattles,
                today_battle_count: todayBattleCount,
                rank_distribution: rankDistribution,
                top_players: topList,
                config: {
                    enabled: cfg.enabled !== false,
                    daily_challenge_limit: cfg.daily_challenge_limit || 10,
                    daily_defend_limit: cfg.daily_defend_limit || 5,
                    cooldown_seconds: cfg.cooldown_seconds || 300,
                    max_rounds: cfg.max_rounds || 30,
                    round_timeout_seconds: cfg.round_timeout_seconds || 60
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/pvp/list
 * 分页查询玩家段位列表
 * query: page=1, limit=20, filter=all/top/bottom, sort=score_desc
 */
router.get('/list', auth, adminCheck, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const offset = (page - 1) * limit;
        const filter = req.query.filter || 'all';  // all/top/bottom
        const sort = req.query.sort || 'score_desc';  // score_desc/score_asc/wins_desc

        // 构造排序
        let order = [['score', 'DESC']];
        if (sort === 'score_asc') order = [['score', 'ASC']];
        else if (sort === 'wins_desc') order = [['season_wins', 'DESC']];

        // 构造筛选条件
        const cfg = PvpService.getPvpConfig();
        const ranks = cfg.ranks || [];
        let whereClause = {};
        if (filter === 'top') {
            // top: 大能/宗主段位
            const topTiers = ranks.filter(r => r.min_score >= 7000).map(r => r.name);
            whereClause.rank_tier = { [Op.in]: topTiers };
        } else if (filter === 'bottom') {
            // bottom: 散修段位
            const bottomTiers = ranks.filter(r => r.min_score < 500).map(r => r.name);
            whereClause.rank_tier = { [Op.in]: bottomTiers };
        }

        const { count, rows } = await PvpRanking.findAndCountAll({
            where: whereClause,
            order,
            limit,
            offset
        });

        // 批量查询玩家基础信息
        const playerIds = rows.map(r => r.player_id);
        const players = playerIds.length > 0
            ? await Player.findAll({
                where: { id: playerIds },
                attributes: ['id', 'nickname', 'realm', 'realm_rank', 'pvp_score', 'pvp_rank', 'honor', 'karma', 'weakness_end_time']
            })
            : [];
        const playerMap = new Map(players.map(p => [p.id, p]));

        const list = rows.map(r => {
            const p = playerMap.get(r.player_id);
            return {
                player_id: r.player_id,
                nickname: p?.nickname || '未知',
                realm: p?.realm || '凡人',
                realm_rank: p?.realm_rank || 0,
                score: r.score,
                rank_tier: r.rank_tier,
                season_wins: r.season_wins,
                season_losses: r.season_losses,
                season_draws: r.season_draws,
                win_streak: r.win_streak,
                max_win_streak: r.max_win_streak,
                total_battles: r.total_battles,
                honor: p ? p.honor?.toString() : '0',
                karma: p?.karma || 0,
                weakness_end_time: p?.weakness_end_time || null
            };
        });

        res.json({
            code: 200,
            data: {
                list,
                total: count,
                page,
                page_size: limit
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/pvp/battles
 * 分页查询所有战斗记录
 * query: page=1, limit=20, player_id, status
 * 注意：此路由必须放在 /:playerId 路由之前，否则 "battles" 会被解析为 playerId
 */
router.get('/battles', auth, adminCheck, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const offset = (page - 1) * limit;
        const playerIdFilter = req.query.player_id ? parseInt(req.query.player_id) : null;
        const statusFilter = req.query.status;  // ongoing/finished/cancelled

        // 构造筛选条件
        const whereClause = {};
        if (playerIdFilter) {
            whereClause[Op.or] = [
                { attacker_id: playerIdFilter },
                { defender_id: playerIdFilter }
            ];
        }
        if (statusFilter && ['ongoing', 'finished', 'cancelled'].includes(statusFilter)) {
            whereClause.status = statusFilter;
        }

        const { count, rows } = await PvpBattleRecord.findAndCountAll({
            where: whereClause,
            order: [['started_at', 'DESC']],
            limit,
            offset
        });

        // 批量查询双方玩家昵称
        const playerIds = new Set();
        for (const r of rows) {
            playerIds.add(r.attacker_id);
            playerIds.add(r.defender_id);
        }
        const playerIdsArray = Array.from(playerIds);
        const players = playerIdsArray.length > 0
            ? await Player.findAll({
                where: { id: playerIdsArray },
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            })
            : [];
        const playerMap = new Map(players.map(p => [p.id, p]));

        const list = rows.map(r => {
            const attacker = playerMap.get(r.attacker_id);
            const defender = playerMap.get(r.defender_id);
            return {
                battle_id: r.id,
                attacker: {
                    id: r.attacker_id,
                    nickname: attacker?.nickname || '未知',
                    realm: attacker?.realm || '凡人'
                },
                defender: {
                    id: r.defender_id,
                    nickname: defender?.nickname || '未知',
                    realm: defender?.realm || '凡人'
                },
                battle_type: r.battle_type,
                status: r.status,
                winner_id: r.winner_id,
                total_rounds: r.total_rounds,
                attacker_score_change: r.attacker_score_change,
                defender_score_change: r.defender_score_change,
                spirit_stone_reward: r.spirit_stone_reward,
                drop_item_key: r.drop_item_key,
                karma_change: r.karma_change,
                started_at: r.started_at,
                finished_at: r.finished_at
            };
        });

        res.json({
            code: 200,
            data: {
                list,
                total: count,
                page,
                page_size: limit
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/pvp/:playerId
 * 查询指定玩家 PVP 详情
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
                'pvp_score', 'pvp_rank', 'honor', 'karma', 'weakness_end_time'
            ]
        });
        if (!player) {
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        const ranking = await PvpRanking.findOne({
            where: { player_id: playerId }
        });

        // 查询该玩家最近 10 场战斗
        const recentBattles = await PvpBattleRecord.findAll({
            where: {
                [Op.or]: [
                    { attacker_id: playerId },
                    { defender_id: playerId }
                ]
            },
            order: [['started_at', 'DESC']],
            limit: 10
        });

        res.json({
            code: 200,
            data: {
                player: {
                    id: player.id,
                    nickname: player.nickname,
                    realm: player.realm,
                    realm_rank: player.realm_rank,
                    exp: player.exp?.toString(),
                    spirit_stones: player.spirit_stones?.toString(),
                    pvp_score: player.pvp_score,
                    pvp_rank: player.pvp_rank,
                    honor: player.honor?.toString(),
                    karma: player.karma,
                    weakness_end_time: player.weakness_end_time
                },
                ranking: ranking ? {
                    score: ranking.score,
                    rank_tier: ranking.rank_tier,
                    season_wins: ranking.season_wins,
                    season_losses: ranking.season_losses,
                    season_draws: ranking.season_draws,
                    win_streak: ranking.win_streak,
                    max_win_streak: ranking.max_win_streak,
                    daily_challenge_count: ranking.daily_challenge_count,
                    daily_defend_count: ranking.daily_defend_count,
                    total_battles: ranking.total_battles,
                    last_challenge_date: ranking.last_challenge_date,
                    last_battle_time: ranking.last_battle_time
                } : null,
                recent_battles: recentBattles.map(r => ({
                    battle_id: r.id,
                    battle_type: r.battle_type,
                    status: r.status,
                    is_attacker: r.attacker_id === playerId,
                    opponent_id: r.attacker_id === playerId ? r.defender_id : r.attacker_id,
                    winner_id: r.winner_id,
                    total_rounds: r.total_rounds,
                    started_at: r.started_at,
                    finished_at: r.finished_at
                }))
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/pvp/:playerId/score
 * 修改玩家段位积分（body: score, reason）
 * 注意：score 改动后会同步更新 pvp_rank 字段（基于 _getRankName 计算）
 */
router.put('/:playerId/score', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parseInt(req.params.playerId);
        const { score, reason } = req.body;

        // 参数校验
        if (score === undefined || score === null) {
            await t.commit();
            return res.status(400).json({ code: 400, message: 'score 参数不能为空' });
        }
        const newScore = parseInt(score);
        if (!Number.isFinite(newScore) || newScore < 0) {
            await t.commit();
            return res.status(400).json({ code: 400, message: 'score 必须为非负整数' });
        }

        // 行级锁玩家
        const locked = await Player.findByPk(playerId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!locked) {
            await t.commit();
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        const oldScore = locked.pvp_score || 0;
        // 更新玩家冗余字段
        locked.pvp_score = newScore;
        locked.pvp_rank = PvpService._getRankName(newScore);

        // 同步更新 pvp_rankings 表
        const ranking = await PvpService._getOrCreateRanking(playerId, t);
        const oldRankingScore = ranking.score || 0;
        ranking.score = newScore;
        ranking.rank_tier = locked.pvp_rank;

        await locked.save({ transaction: t });
        await ranking.save({ transaction: t });
        await t.commit();

        // 记录管理员操作日志
        await logAdminAction(req.player.id, 'pvp_modify_score', {
            target_id: playerId,
            old_score: oldScore,
            new_score: newScore,
            old_ranking_score: oldRankingScore,
            new_rank_tier: locked.pvp_rank,
            reason: reason || 'GM 调整段位积分'
        }, req);

        res.json({
            code: 200,
            message: '段位积分已更新',
            data: {
                id: locked.id,
                nickname: locked.nickname,
                old_score: oldScore,
                new_score: newScore,
                pvp_rank: locked.pvp_rank
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

/**
 * POST /api/admin/pvp/:playerId/score/reset
 * 重置玩家段位（score=0, rank=散修）
 * 注意：仅重置积分与段位，保留胜负记录与荣誉值（避免误操作清空历史成就）
 */
router.post('/:playerId/score/reset', auth, adminCheck, async (req, res, next) => {
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

        const oldScore = locked.pvp_score || 0;
        const oldRank = locked.pvp_rank || '散修';

        // 重置玩家冗余字段
        locked.pvp_score = 0;
        locked.pvp_rank = '散修';

        // 同步重置 pvp_rankings 表
        const ranking = await PvpService._getOrCreateRanking(playerId, t);
        ranking.score = 0;
        ranking.rank_tier = '散修';
        // 保留胜负记录与最高连胜，仅重置当前连胜与每日次数
        ranking.win_streak = 0;
        ranking.daily_challenge_count = 0;
        ranking.daily_defend_count = 0;

        await locked.save({ transaction: t });
        await ranking.save({ transaction: t });
        await t.commit();

        await logAdminAction(req.player.id, 'pvp_reset_score', {
            target_id: playerId,
            old_score: oldScore,
            old_rank: oldRank
        }, req);

        res.json({
            code: 200,
            message: '段位已重置',
            data: {
                id: locked.id,
                nickname: locked.nickname,
                pvp_score: 0,
                pvp_rank: '散修'
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

/**
 * POST /api/admin/pvp/battle/:battleId/cancel
 * 强制取消进行中的战斗（GM 介入）
 * 仅对 status='ongoing' 的战斗生效，将其置为 'cancelled'
 */
router.post('/battle/:battleId/cancel', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const battleId = parseInt(req.params.battleId);
        if (!battleId) {
            await t.commit();
            return res.status(400).json({ code: 400, message: 'battleId 参数无效' });
        }

        const { reason } = req.body;

        // 行级锁战斗记录
        const locked = await PvpBattleRecord.findByPk(battleId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!locked) {
            await t.commit();
            return res.status(404).json({ code: 404, message: '战斗记录不存在' });
        }

        if (locked.status !== 'ongoing') {
            await t.commit();
            return res.status(400).json({ code: 400, message: `战斗状态为 ${locked.status}，无法取消` });
        }

        // 强制取消：双方均不得分，状态置为 cancelled
        const now = new Date();
        locked.status = 'cancelled';
        locked.winner_id = null;
        locked.finished_at = now;

        // 追加取消日志
        const log = locked.battle_log ? JSON.parse(locked.battle_log) : [];
        log.push({
            round: locked.total_rounds,
            event: 'gm_cancelled',
            reason: reason || 'GM 强制取消',
            admin_id: req.player.id,
            timestamp: now.toISOString()
        });
        locked.battle_log = JSON.stringify(log);
        await locked.save({ transaction: t });
        await t.commit();

        // 推送取消事件给双方
        try {
            const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
            WebSocketNotificationService.notifyPlayerUpdate(locked.attacker_id, 'pvp_cancelled', {
                battle_id: locked.id,
                reason: 'gm_cancel',
                message: '斗法已被管理员强制取消'
            });
            WebSocketNotificationService.notifyPlayerUpdate(locked.defender_id, 'pvp_cancelled', {
                battle_id: locked.id,
                reason: 'gm_cancel',
                message: '斗法已被管理员强制取消'
            });
        } catch (e) { /* 推送失败不阻塞 */ }

        await logAdminAction(req.player.id, 'pvp_cancel_battle', {
            battle_id: battleId,
            attacker_id: locked.attacker_id,
            defender_id: locked.defender_id,
            reason: reason || 'GM 强制取消'
        }, req);

        res.json({
            code: 200,
            message: '战斗已强制取消',
            data: {
                battle_id: locked.id,
                status: locked.status,
                finished_at: locked.finished_at
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

module.exports = router;
