/**
 * 妖兽入侵玩家路由
 *
 * 提供妖兽入侵系统的玩家侧接口（参考 xiuxian_game_guide.md 第16节 妖兽入侵）：
 *   1. GET    /active               - 获取当前活跃的妖兽入侵事件
 *   2. GET    /list                 - 获取历史妖兽入侵事件列表（query: status, limit, offset）
 *   3. GET    /:invasionId          - 获取妖兽入侵事件详情（含技能/聚合战报/倒计时）
 *   4. POST   /:invasionId/contribute - 捐献物品到锁灵大阵（body: item_key, quantity）
 *   5. GET    /:invasionId/contribution/progress - 获取捐献进度（含各物品累计/排行榜）
 *   6. GET    /:invasionId/contribution/me - 获取玩家自己的捐献记录
 *   7. POST   /:invasionId/attack   - 攻击妖兽（body: skill_id 可选，默认 basic）
 *   8. POST   /:invasionId/revive   - 原地复活（消耗灵石，60秒CD）
 *   9. POST   /:invasionId/retreat  - 撤退（5分钟内禁入）
 *  10. GET    /:invasionId/ranking  - 获取伤害排行（query: limit）
 *  11. GET    /:invasionId/rewards  - 获取奖励池说明
 *  12. GET    /help                 - 获取玩法帮助说明
 *
 * 权限：所有接口需要 auth 中间件验证 JWT
 * 设计：路由层只做参数提取与响应包装，业务逻辑全部在 BeastInvasionService 中
 *
 * 注意：动态路由 /:invasionId 必须放在静态路由之后，否则 "active" / "list" / "help" 会被解析为 invasionId
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const BeastInvasionService = require('../game/services/BeastInvasionService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 解析路径参数 invasionId 为正整数
 * @param {string} raw - 原始路径参数
 * @returns {number} 解析后的事件ID
 */
function parseInvasionId(raw) {
    const id = parseInt(raw, 10);
    if (isNaN(id) || id <= 0) {
        throw new AppError('事件ID必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
    }
    return id;
}

// =========================================================================
// 静态路由（必须放在 /:invasionId 之前，避免被动态参数解析）
// =========================================================================

/**
 * GET /api/beast-invasion/active
 * 获取当前活跃的妖兽入侵事件
 */
router.get('/active', auth, async (req, res, next) => {
    try {
        const result = await BeastInvasionService.getActiveInvasion();
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/beast-invasion/list
 * 获取历史妖兽入侵事件列表
 * query: status=active|defeated|escaped|expired（可选过滤），limit=20（最大100），offset=0
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const filter = {
            status: req.query.status,
            limit: parseInt(req.query.limit, 10) || 20,
            offset: parseInt(req.query.offset, 10) || 0
        };
        const result = await BeastInvasionService.listInvasions(filter);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/beast-invasion/help
 * 获取妖兽入侵玩法帮助说明
 */
router.get('/help', auth, async (req, res, next) => {
    try {
        const result = await BeastInvasionService.getHelp(null);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

// =========================================================================
// 动态路由 /:invasionId
// =========================================================================

/**
 * GET /api/beast-invasion/:invasionId
 * 获取妖兽入侵事件详情
 */
router.get('/:invasionId', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const result = await BeastInvasionService.getInvasionDetail(invasionId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/beast-invasion/:invasionId/contribute
 * 玩家捐献物品到锁灵大阵
 * body: { item_key: string, quantity: number }
 */
router.post('/:invasionId/contribute', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const playerId = req.player.id;
        const { item_key, quantity } = req.body || {};

        if (!item_key || typeof item_key !== 'string') {
            throw new AppError('item_key 必填且必须为字符串', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await BeastInvasionService.contribute(playerId, invasionId, item_key, quantity);
        res.json({ code: 200, data: result, message: '捐献成功' });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/beast-invasion/:invasionId/contribution/progress
 * 获取捐献进度（含各物品累计/排行榜）
 */
router.get('/:invasionId/contribution/progress', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const result = await BeastInvasionService.getContributionProgress(invasionId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/beast-invasion/:invasionId/contribution/me
 * 获取玩家自己的捐献记录
 */
router.get('/:invasionId/contribution/me', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const playerId = req.player.id;
        const result = await BeastInvasionService.getPlayerContribution(playerId, invasionId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/beast-invasion/:invasionId/attack
 * 玩家攻击妖兽
 * body: { skill_id?: string } - 可选，默认 basic（支持 basic/skill/ultimate）
 */
router.post('/:invasionId/attack', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const playerId = req.player.id;
        const options = {};
        if (req.body && req.body.skill_id) {
            options.skill_id = req.body.skill_id;
        }

        const result = await BeastInvasionService.attackBeast(playerId, invasionId, options);
        res.json({ code: 200, data: result, message: '斩妖成功' });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/beast-invasion/:invasionId/revive
 * 原地复活（消耗灵石，60秒CD）
 */
router.post('/:invasionId/revive', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const playerId = req.player.id;
        const result = await BeastInvasionService.revive(playerId, invasionId);
        res.json({ code: 200, data: result, message: '复活成功' });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/beast-invasion/:invasionId/retreat
 * 撤退（5分钟内禁入）
 */
router.post('/:invasionId/retreat', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const playerId = req.player.id;
        const result = await BeastInvasionService.retreat(playerId, invasionId);
        res.json({ code: 200, data: result, message: '撤退成功' });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/beast-invasion/:invasionId/ranking
 * 获取伤害排行
 * query: limit=100（最大500）
 */
router.get('/:invasionId/ranking', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const limit = parseInt(req.query.limit, 10) || 100;
        const result = await BeastInvasionService.getAttackRanking(invasionId, limit);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/beast-invasion/:invasionId/rewards
 * 获取奖励池说明
 */
router.get('/:invasionId/rewards', auth, async (req, res, next) => {
    try {
        const invasionId = parseInvasionId(req.params.invasionId);
        const result = await BeastInvasionService.getRewardsInfo(invasionId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
