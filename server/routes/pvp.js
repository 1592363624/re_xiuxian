/**
 * PVP 斗法系统路由（玩家端）
 *
 * 提供玩家间斗法玩法的 HTTP 接口：
 * 1. GET  /api/pvp/status：获取 PVP 状态（段位/次数/冷却/虚弱/进行中战斗）
 * 2. GET  /api/pvp/leaderboard：段位排行榜（query: limit=50）
 * 3. GET  /api/pvp/history：战斗历史（query: page=1, limit=20）
 * 4. POST /api/pvp/challenge：发起挑战（body: target_player_id, battle_type='normal'）
 * 5. POST /api/pvp/action：执行回合（body: action='attack'/'skill'/'defend', skill_index）
 * 6. POST /api/pvp/flee：逃跑
 * 7. POST /api/pvp/mode：切换避世/入世模式（body: mode='active'|'recluse'）
 * 8. GET  /api/pvp/combat-power：查询自己战力
 * 9. GET  /api/pvp/combat-power/:playerId：查询指定玩家战力
 * 10. GET /api/pvp/combat-power/compare/:playerA/:playerB：对比两个玩家战力
 * 11. POST /api/pvp/sparring：切磋木人（body: target_realm_rank）
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 PvpService 中
 * 统一响应格式：{ code: 200, message, data }
 * 路由顺序注意：/combat-power/compare/... 必须在 /combat-power/:playerId 之前定义
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const PvpService = require('../game/services/PvpService');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * GET /api/pvp/status
 * 获取 PVP 状态（段位/次数/冷却/虚弱/进行中战斗）
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const status = await PvpService.getStatus(req.player.id);

        res.json({
            code: 200,
            data: status
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
 * GET /api/pvp/leaderboard
 * 段位排行榜（query: limit=50）
 */
router.get('/leaderboard', auth, async (req, res, next) => {
    try {
        // limit 范围限制 1-100，默认 50
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const list = await PvpService.getLeaderboard(limit);

        res.json({
            code: 200,
            data: {
                list,
                total: list.length
            }
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
 * GET /api/pvp/history
 * 战斗历史（query: page=1, limit=20）
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const result = await PvpService.getBattleHistory(req.player.id, { page, limit });

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
 * POST /api/pvp/challenge
 * 发起挑战（body: target_player_id, battle_type='normal'）
 */
router.post('/challenge', auth, async (req, res, next) => {
    try {
        const { target_player_id, battle_type } = req.body;

        // 参数校验
        if (!target_player_id) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_player_id 参数不能为空'
            });
        }

        const targetId = parseInt(target_player_id);
        if (!Number.isFinite(targetId) || targetId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_player_id 参数无效'
            });
        }

        const result = await PvpService.challenge(req.player.id, targetId, battle_type || 'normal');

        // 推送斗法挑战事件给发起方（前端据此刷新战斗 UI）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'pvp_challenge', {
                battle_id: result.battle_id,
                opponent_id: targetId,
                first_attacker: result.first_attacker
            });
        } catch (e) {
            console.warn('[PVP] 推送挑战事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '斗法挑战已发起',
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
 * POST /api/pvp/action
 * 执行回合（body: action='attack'/'skill'/'defend', skill_index）
 */
router.post('/action', auth, async (req, res, next) => {
    try {
        const { action, skill_index } = req.body;

        // 参数校验
        if (!action) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'action 参数不能为空'
            });
        }

        const allowedActions = ['attack', 'skill', 'defend'];
        if (!allowedActions.includes(action)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `无效的 action：${action}，可选值：${allowedActions.join('/')}`
            });
        }

        const result = await PvpService.executeAction(req.player.id, action, skill_index);

        // 推送回合执行事件（前端据此刷新战斗回合）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'pvp_action', {
                battle_id: result.battle_id,
                round: result.round,
                action: result.action,
                damage: result.damage,
                battle_ended: result.battle_ended
            });
        } catch (e) {
            console.warn('[PVP] 推送回合事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: result.battle_ended ? '斗法已结束' : '回合执行完成',
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
 * POST /api/pvp/flee
 * 逃跑（攻击方主动放弃，判负）
 */
router.post('/flee', auth, async (req, res, next) => {
    try {
        const result = await PvpService.flee(req.player.id);

        // 推送逃跑事件
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'pvp_flee', {
                battle_id: result.battle_id,
                fled: result.fled,
                winner_id: result.winner_id
            });
        } catch (e) {
            console.warn('[PVP] 推送逃跑事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: '斗法已逃跑',
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
 * GET /api/pvp/mode
 * 查询当前玩家 PVP 模式（避世/入世）
 * - 返回 pvp_mode 字段值与中文名
 * - 用于前端 UI 展示当前模式状态
 */
router.get('/mode', auth, async (req, res, next) => {
    try {
        const result = await PvpService.getPvpMode(req.player.id);
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
 * POST /api/pvp/mode
 * 切换避世/入世模式（body: { mode: 'active'|'recluse' }）
 * - active=入世：可正常参与 PVP
 * - recluse=避世：免疫 PVP 挑战，但自身也无法发起挑战
 */
router.post('/mode', auth, async (req, res, next) => {
    try {
        const { mode } = req.body;

        // 参数校验
        if (!mode) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'mode 参数不能为空'
            });
        }

        const allowedModes = ['active', 'recluse'];
        if (!allowedModes.includes(mode)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `无效的 mode：${mode}，可选值：${allowedModes.join('/')}`
            });
        }

        const result = await PvpService.setPvpMode(req.player.id, mode);

        res.json({
            code: 200,
            message: `已切换为${result.mode_name}模式`,
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
 * GET /api/pvp/combat-power/compare/:playerA/:playerB
 * 对比两个玩家战力
 * 注意：此路由必须在 /combat-power/:playerId 之前定义，避免 "compare" 被匹配为 playerId
 */
router.get('/combat-power/compare/:playerA/:playerB', auth, async (req, res, next) => {
    try {
        const playerA = parseInt(req.params.playerA);
        const playerB = parseInt(req.params.playerB);

        // 参数校验
        if (!Number.isFinite(playerA) || playerA <= 0 || !Number.isFinite(playerB) || playerB <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '玩家ID参数无效'
            });
        }

        const result = await PvpService.compareCombatPower(playerA, playerB);

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
 * GET /api/pvp/combat-power
 * 查询自己战力（基于 pvp_extended.combat_power 权重计算）
 */
router.get('/combat-power', auth, async (req, res, next) => {
    try {
        const result = await PvpService.getCombatPower(req.player.id);

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
 * GET /api/pvp/combat-power/:playerId
 * 查询指定玩家战力
 */
router.get('/combat-power/:playerId', auth, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId);

        // 参数校验
        if (!Number.isFinite(playerId) || playerId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'playerId 参数无效'
            });
        }

        const result = await PvpService.getCombatPower(playerId);

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
 * POST /api/pvp/sparring
 * 切磋木人（零惩罚训练，body: { target_realm_rank: number }）
 * 木人属性按境界排名递增，战斗复用 PVP 伤害公式，仅获得经验奖励
 */
router.post('/sparring', auth, async (req, res, next) => {
    try {
        const { target_realm_rank } = req.body;

        // 参数校验
        if (target_realm_rank === undefined || target_realm_rank === null) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_realm_rank 参数不能为空'
            });
        }

        const targetRank = Number(target_realm_rank);
        if (!Number.isFinite(targetRank)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_realm_rank 参数无效'
            });
        }

        const result = await PvpService.sparringWithDummy(req.player.id, targetRank);

        res.json({
            code: 200,
            message: '切磋木人完成',
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
