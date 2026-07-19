/**
 * 封神台系统路由（玩家端）
 *
 * 提供封神台镜像排名竞技场的 HTTP 接口：
 * 1. GET  /api/fengshen/ranking  ：获取封神台排名榜（query: page, page_size）
 * 2. GET  /api/fengshen/my       ：获取我的封神台信息
 * 3. POST /api/fengshen/defense  ：设置防守阵容（body: defense_config）
 * 4. GET  /api/fengshen/defense  ：获取我的防守阵容
 * 5. POST /api/fengshen/challenge：挑战指定排名（body: target_rank）
 * 6. GET  /api/fengshen/season   ：获取赛季信息
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 FengshenService 中
 * 统一响应格式：{ code: 200, message, data }
 * 所有接口均使用 auth 中间件进行 JWT 鉴权
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const FengshenService = require('../game/services/FengshenService');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * GET /api/fengshen/ranking
 * 获取封神台排名榜（分页查询）
 * query: { page=1, page_size=20 }
 */
router.get('/ranking', auth, async (req, res, next) => {
    try {
        // 分页参数校验与范围限制
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(Math.max(1, parseInt(req.query.page_size) || 20), 100);

        const result = await FengshenService.getRanking(req.player.id, page, pageSize);

        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/fengshen/my
 * 获取我的封神台信息（排名/积分/胜负/今日次数/防守状态）
 */
router.get('/my', auth, async (req, res, next) => {
    try {
        const result = await FengshenService.getMyRanking(req.player.id);

        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * POST /api/fengshen/defense
 * 设置防守阵容（快照当前属性 + 前端传入装备/法宝配置）
 * body: { defense_config: { ... } }
 */
router.post('/defense', auth, async (req, res, next) => {
    try {
        const { defense_config } = req.body;

        // 参数校验：defense_config 必须为对象（允许空对象，表示使用默认属性）
        if (defense_config === undefined || defense_config === null) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'defense_config 参数不能为空'
            });
        }

        if (typeof defense_config !== 'object' || Array.isArray(defense_config)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'defense_config 必须为对象'
            });
        }

        const result = await FengshenService.setDefense(req.player.id, defense_config);

        // 推送防守阵容设置事件（前端据此刷新 UI）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'fengshen_defense_set', {
                rank: result.rank,
                fengshen_score: result.fengshen_score,
                defense_set_at: result.defense_set_at
            });
        } catch (e) {
            console.warn('[封神台] 推送防守设置事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '防守阵容设置成功',
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/fengshen/defense
 * 获取我的防守阵容
 */
router.get('/defense', auth, async (req, res, next) => {
    try {
        const result = await FengshenService.getDefense(req.player.id);

        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * POST /api/fengshen/challenge
 * 挑战指定排名的玩家
 * body: { target_rank: number }
 */
router.post('/challenge', auth, async (req, res, next) => {
    try {
        const { target_rank } = req.body;

        // 参数校验
        if (target_rank === undefined || target_rank === null) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_rank 参数不能为空'
            });
        }

        const targetRank = parseInt(target_rank);
        if (!Number.isFinite(targetRank) || targetRank <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_rank 参数无效，必须为正整数'
            });
        }

        const result = await FengshenService.challengeRank(req.player.id, targetRank);

        // 推送挑战结果事件给挑战者（前端据此刷新排名/积分 UI）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'fengshen_challenge_result', {
                attacker_wins: result.battle_result.attacker_wins,
                my_rank: result.my_rank,
                my_score: result.my_score,
                score_change: result.battle_result.attacker_score_change,
                daily_challenge_remaining: result.daily_challenge_remaining
            });
        } catch (e) {
            console.warn('[封神台] 推送挑战结果事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: result.battle_result.attacker_wins ? '挑战成功，排名已交换' : '挑战失败',
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/fengshen/season
 * 获取赛季信息（编号/时间/剩余天数/奖励规则）
 */
router.get('/season', auth, async (req, res, next) => {
    try {
        const result = await FengshenService.getSeasonInfo();

        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

module.exports = router;
