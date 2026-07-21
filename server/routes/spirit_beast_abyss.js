/**
 * 灵兽探渊路由
 *
 * 对应玩法文档第24节"灵兽探渊"——异步多人PVE+PVP混合探索玩法
 * 路由前缀：/api/spirit-beast/abyss
 *
 * 接口列表（8个，全部需要 auth 鉴权）：
 *   1. GET  /floors      - 获取可用深渊层数列表（按境界过滤）
 *   2. POST /start       - 开始探渊（标记灵兽 is_exploring=true，扣减体力）
 *   3. POST /recall      - 召回灵兽（手动召回，提前召回有惩罚）
 *   4. GET  /status      - 获取当前探渊状态（active_explores 列表 + 剩余时间）
 *   5. GET  /history     - 获取探渊历史（已结算的探渊记录）
 *   6. GET  /encounters  - 获取遭遇历史（某次探渊的遭遇日志）
 *   7. GET  /ranking     - 获取探渊排行榜（最深层数/累计探渊次数/累计PVP胜利）
 *   8. GET  /config      - 获取探渊配置（事件类型/体力/每日限制等）
 *
 * 设计要点：
 *   - 所有接口必须 auth 鉴权，业务逻辑全部在 BeastAbyssService 中实现
 *   - 路由层只做参数提取与转发，不处理业务逻辑
 *   - 错误响应统一：{ code, success:false, message }
 *   - 成功响应统一：{ code:200, data }
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const BeastAbyssService = require('../game/services/BeastAbyssService');

/**
 * 统一响应包装：将 Service 返回的 {success:false,message} 转为 400 响应
 * 将 {data} 转为 200 响应
 * @param {object} res - express response 对象
 * @param {object} result - Service 返回的结果
 */
function sendServiceResult(res, result) {
    if (result.success === false) {
        return res.status(result.code || 400).json({
            code: result.code || 400,
            success: false,
            message: result.message
        });
    }
    return res.status(200).json({
        code: 200,
        ...result
    });
}

// ==================== 探渊管理接口 ====================

/**
 * GET /api/spirit-beast/abyss/floors
 * 获取可用深渊层数列表（按玩家境界过滤）
 * 返回：floors 列表 + 同时探渊上限 + 最小/最大探渊时长 + 每日次数限制
 */
router.get('/floors', auth, async (req, res, next) => {
    try {
        const result = await BeastAbyssService.getFloors(req.player);
        return sendServiceResult(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/abyss/start
 * 开始探渊
 * body: { beast_id: number, duration_hours: number }
 * 校验：灵兽归属/出战状态/放养状态/探渊状态/受伤状态/体力/每日次数/同时探渊上限/境界
 */
router.post('/start', auth, async (req, res, next) => {
    try {
        const { beast_id, duration_hours } = req.body;
        const result = await BeastAbyssService.startExplore(req.player, beast_id, duration_hours);
        return sendServiceResult(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/abyss/recall
 * 召回灵兽（手动召回）
 * body: { beast_id: number }
 * 召回类型：early(提前召回,层数减半+经验惩罚)/manual(到期召回,正常结算)/auto(超期自动召回)
 */
router.post('/recall', auth, async (req, res, next) => {
    try {
        const { beast_id } = req.body;
        const result = await BeastAbyssService.recallBeast(req.player, beast_id);
        return sendServiceResult(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/abyss/status
 * 获取当前探渊状态
 * 返回：active_explores 列表（含剩余时间/是否到期/层数/体力消耗）
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const result = await BeastAbyssService.getExploreStatus(req.player);
        return sendServiceResult(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/abyss/history
 * 获取探渊历史（已结算的记录）
 * query: page, page_size
 * 返回：history 列表（含层数/PVP战绩/怪物击杀/宝箱/陷阱/奖励快照）
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const page_size = parseInt(req.query.page_size) || 10;
        const result = await BeastAbyssService.getExploreHistory(req.player, page, page_size);
        return sendServiceResult(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/abyss/encounters
 * 获取遭遇历史（某次探渊的遭遇日志）
 * query: explore_id
 * 返回：encounters 列表（含层数/遭遇类型/结果/HP/经验/物品/灵石/PVP对手）
 */
router.get('/encounters', auth, async (req, res, next) => {
    try {
        const explore_id = parseInt(req.query.explore_id);
        const result = await BeastAbyssService.getEncounterHistory(req.player, explore_id);
        return sendServiceResult(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/abyss/ranking
 * 获取探渊排行榜
 * query: category(deepest_floor/total_explore_count/total_pvp_wins), page, page_size
 * 返回：ranking 列表（含玩家昵称/境界/层数/战绩）
 */
router.get('/ranking', auth, async (req, res, next) => {
    try {
        const category = req.query.category || 'deepest_floor';
        const page = parseInt(req.query.page) || 1;
        const page_size = parseInt(req.query.page_size) || 20;
        const result = await BeastAbyssService.getRanking(category, page, page_size);
        return sendServiceResult(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/abyss/config
 * 获取探渊配置（事件类型/体力/每日限制/受伤恢复等）
 * 返回：config 对象（供前端展示规则说明）
 */
router.get('/config', auth, async (req, res, next) => {
    try {
        const config = BeastAbyssService.config;
        if (!config) {
            return res.status(500).json({ code: 500, success: false, message: '探渊配置未加载' });
        }
        return res.status(200).json({
            code: 200,
            data: {
                abyss: {
                    total_floors: config.abyss.total_floors,
                    min_duration_hours: config.abyss.min_duration_hours,
                    max_duration_hours: config.abyss.max_duration_hours,
                    max_concurrent_beasts: config.abyss.max_concurrent_beasts,
                    stamina_per_explore: config.abyss.stamina_per_explore,
                    stamina_max: config.abyss.stamina_max,
                    stamina_recover_per_hour: config.abyss.stamina_recover_per_hour,
                    daily_explore_limit: config.abyss.daily_explore_limit,
                    beast_hp_injury_recover_hours: config.abyss.beast_hp_injury_recover_hours,
                    pvp_encounter_base_rate: config.abyss.pvp_encounter_base_rate,
                    pvp_winner_loot_ratio: config.abyss.pvp_winner_loot_ratio
                },
                event_types: config.event_types,
                beast_soul_config: config.beast_soul_config,
                recall_config: config.recall_config
            }
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
