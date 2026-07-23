/**
 * 赌石系统路由
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   赌石流程是 `.赌石` 生成三块原石，再用 `.切 <编号>` 购买切开。
 *
 * 接口清单（10个）：
 *   1. GET  /config            — 获取配置（无需鉴权）
 *   2. GET  /profile           — 赌石档案（需鉴权）
 *   3. POST /generate          — 生成3块原石（需鉴权）
 *   4. GET  /stones            — 未切开原石列表（需鉴权）
 *   5. GET  /stones/:id        — 原石详情（含线索）（需鉴权）
 *   6. POST /cut               — 切开原石（需鉴权）
 *   7. GET  /records           — 切开历史记录（需鉴权）
 *   8. GET  /ranking           — 排行榜（需鉴权）
 *   9. POST /list              — 上架拍卖行（需鉴权）
 *  10. POST /unlist            — 取消上架（需鉴权）
 *  11. POST /insight           — 灵识透石（需鉴权，熟练度100级解锁）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const GamblingStoneService = require('../game/services/GamblingStoneService');

// ============================================================
// 通用响应包装：统一处理 { success, message?, data } 的返回模式
// 成功返回 200 + { code:200, message?, data }
// 失败返回 400 + { code:400, message }
// ============================================================
function wrap(res, result) {
    if (result.success) {
        const body = { code: 200 };
        if (result.message) body.message = result.message;
        if (result.data !== undefined) body.data = result.data;
        return res.json(body);
    }
    return res.status(400).json({ code: 400, message: result.message || '操作失败' });
}

/**
 * 1. 获取赌石系统配置（无需鉴权）
 * 供前端展示产地/品质/切法/线索规则说明
 */
router.get('/config', (req, res, next) => {
    try {
        const config = GamblingStoneService.getConfig();
        if (!config) {
            return res.status(500).json({ code: 500, message: '赌石系统配置未加载' });
        }
        // 过滤内部字段，只返回前端展示需要的配置
        const publicConfig = {
            enabled: config.enabled,
            daily: config.daily,
            origins: config.origins,
            qualities: config.qualities,
            clues: config.clues,
            cut_methods: config.cut_methods,
            skill: config.skill,
            trade: config.trade,
            ranking: config.ranking
        };
        return res.json({ code: 200, data: publicConfig });
    } catch (err) {
        next(err);
    }
});

/**
 * 2. 获取玩家赌石档案（含熟练度/日次数/统计/诅咒状态）
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const result = await GamblingStoneService.getProfile(playerId);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 3. 生成3块原石（每日3次上限）
 * 玩法文档：`.赌石` 生成三块原石
 */
router.post('/generate', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const result = await GamblingStoneService.generateStones(playerId);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 4. 获取当前未切开原石列表
 */
router.get('/stones', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const result = await GamblingStoneService.getStones(playerId);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 5. 获取原石详情（含4维线索展示）
 */
router.get('/stones/:id', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const stoneId = parseInt(req.params.id);
        if (!Number.isFinite(stoneId)) {
            return res.status(400).json({ code: 400, message: '原石ID无效' });
        }
        const result = await GamblingStoneService.getStoneDetail(playerId, stoneId);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 6. 切开原石（核心博彩逻辑）
 * 玩法文档：`.切 <编号>` 购买切开
 * 请求体：{ stone_id: number, cut_method: 'rough'|'fine'|'divine_sense' }
 */
router.post('/cut', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const { stone_id, cut_method } = req.body;
        if (!Number.isFinite(stone_id)) {
            return res.status(400).json({ code: 400, message: '原石ID无效' });
        }
        if (!cut_method || !['rough', 'fine', 'divine_sense'].includes(cut_method)) {
            return res.status(400).json({ code: 400, message: '切法无效，可选：rough/fine/divine_sense' });
        }
        const result = await GamblingStoneService.cutStone(playerId, stone_id, cut_method);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 7. 获取切开历史记录（分页）
 * 查询参数：page（页码，默认1）、page_size（每页数量，默认20）
 */
router.get('/records', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size) || 20));
        const result = await GamblingStoneService.getRecords(playerId, page, pageSize);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 8. 获取排行榜
 * 查询参数：type（排行类型：biggest_win/total_profit/rare_count/skill_level）
 */
router.get('/ranking', auth, async (req, res, next) => {
    try {
        const type = req.query.type || 'biggest_win';
        const result = await GamblingStoneService.getRanking(type);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 9. 上架拍卖行（未切开原石流转）
 * 请求体：{ stone_id: number, price: number }
 */
router.post('/list', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const { stone_id, price } = req.body;
        if (!Number.isFinite(stone_id)) {
            return res.status(400).json({ code: 400, message: '原石ID无效' });
        }
        if (!Number.isFinite(price) || price <= 0) {
            return res.status(400).json({ code: 400, message: '上架价格必须为正数' });
        }
        const result = await GamblingStoneService.listStone(playerId, stone_id, price);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 10. 取消上架
 * 请求体：{ stone_id: number }
 */
router.post('/unlist', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const { stone_id } = req.body;
        if (!Number.isFinite(stone_id)) {
            return res.status(400).json({ code: 400, message: '原石ID无效' });
        }
        const result = await GamblingStoneService.unlistStone(playerId, stone_id);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

/**
 * 11. 灵识透石（熟练度100级解锁，查看1条真实线索）
 * 请求体：{ stone_id: number }
 */
router.post('/insight', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const { stone_id } = req.body;
        if (!Number.isFinite(stone_id)) {
            return res.status(400).json({ code: 400, message: '原石ID无效' });
        }
        const result = await GamblingStoneService.insightStone(playerId, stone_id);
        return wrap(res, result);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
