/**
 * 灵兽放养与偷菜路由
 *
 * 对应玩法文档第8节"灵兽放养/偷菜"——异步多人经济PVP玩法
 * 路由前缀：/api/spirit-beast/pasture
 *
 * 接口列表（8个，全部需要 auth 鉴权）：
 *   1. GET  /locations      - 获取可用放养场所列表（按境界过滤）
 *   2. POST /start          - 开始放养（标记灵兽 is_pasturing=true）
 *   3. POST /recall         - 召回灵兽（提前召回0%/到期1.0%/超期0.8% 产物折扣）
 *   4. GET  /status         - 获取当前放养状态（active_pastures 列表 + 剩余时间）
 *   5. GET  /history        - 获取放养历史（已结算的放养记录）
 *   6. POST /steal          - 偷菜：放养中的灵兽偷其他玩家药园的成熟作物
 *   7. GET  /steal-history  - 获取我偷别人历史
 *   8. GET  /stolen-history - 获取别人偷我历史
 *
 * 设计要点：
 *   - 所有接口必须 auth 鉴权，业务逻辑全部在 BeastPastureService 中实现
 *   - 路由层只做参数提取与转发，不处理业务逻辑
 *   - 错误响应统一：{ code, success:false, message }
 *   - 成功响应统一：{ code:200, data }
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const BeastPastureService = require('../game/services/BeastPastureService');

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

// ==================== 放养管理接口 ====================

/**
 * GET /api/spirit-beast/pasture/locations
 * 获取可用放养场所列表（按玩家境界过滤）
 * 返回：locations 列表 + 同时放养上限 + 最小/最大放养时长
 */
router.get('/locations', auth, async (req, res, next) => {
    try {
        const result = await BeastPastureService.getLocations(req.player);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽放养] 获取场所列表失败:', e);
        next(e);
    }
});

/**
 * POST /api/spirit-beast/pasture/start
 * 开始放养
 * Body: { beast_id: number, location_key: string, duration_hours: number }
 * 校验：
 *   - 灵兽属于玩家、未出战、未放养中
 *   - 当前放养数量未达上限
 *   - 时长在 min_duration_hours ~ max_duration_hours 之间
 *   - 玩家境界达到场所 min_realm_rank
 */
router.post('/start', auth, async (req, res, next) => {
    try {
        const beastId = parseInt(req.body.beast_id);
        const locationKey = req.body.location_key;
        const durationHours = parseFloat(req.body.duration_hours);

        if (!beastId || !locationKey || !durationHours) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: '参数不完整：需要 beast_id / location_key / duration_hours'
            });
        }

        const result = await BeastPastureService.startPasture(req.player, beastId, locationKey, durationHours);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽放养] 开始放养失败:', e);
        next(e);
    }
});

/**
 * POST /api/spirit-beast/pasture/recall
 * 召回灵兽（手动召回，根据到期情况应用不同折扣）
 * Body: { beast_id: number }
 * 召回类型：
 *   - early 提前召回：放养产物按 0% 结算（仅保留偷菜收获）
 *   - manual 正常召回：到达结束时间但未超宽限期，按 100% 结算
 *   - auto 超期召回：超过宽限期，按 80% 结算
 */
router.post('/recall', auth, async (req, res, next) => {
    try {
        const beastId = parseInt(req.body.beast_id);
        if (!beastId) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: '参数不完整：需要 beast_id'
            });
        }

        const result = await BeastPastureService.recallBeast(req.player, beastId);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽放养] 召回灵兽失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pasture/status
 * 获取当前放养状态
 * 返回：active_pastures 列表（含剩余秒数/是否到期/偷菜次数/被偷次数）
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const result = await BeastPastureService.getPastureStatus(req.player);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽放养] 获取状态失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pasture/history
 * 获取放养历史（已结算的放养记录）
 * Query: page=1, page_size=10
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size) || 10));
        const result = await BeastPastureService.getPastureHistory(req.player, page, pageSize);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽放养] 获取历史失败:', e);
        next(e);
    }
});

// ==================== 偷菜系统接口 ====================

/**
 * POST /api/spirit-beast/pasture/steal
 * 偷菜：放养中的灵兽偷其他玩家药园的成熟作物
 * Body: { beast_id: number, target_player_id: number, target_plot_index?: number }
 *
 * 多人交互核心：
 *   - 偷菜方：放养中的灵兽（is_pasturing=true）
 *   - 被偷方：成熟地块（status=mature）
 *   - 护院：被偷方出战灵兽（is_active=true）会尝试拦截
 *   - 成功率：基础35% + 速度/忠诚度/星级加成 + 无护院加成30%
 *   - 拦截率：基础40% + 速度/忠诚度/星级加成
 *   - 冷却：同灵兽1h / 每日总计10次 / 同地块24h
 */
router.post('/steal', auth, async (req, res, next) => {
    try {
        const beastId = parseInt(req.body.beast_id);
        const targetPlayerId = parseInt(req.body.target_player_id);
        const targetPlotIndex = req.body.target_plot_index !== undefined && req.body.target_plot_index !== null
            ? parseInt(req.body.target_plot_index)
            : null;

        if (!beastId || !targetPlayerId) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: '参数不完整：需要 beast_id / target_player_id'
            });
        }

        const result = await BeastPastureService.stealCrops(req.player, beastId, targetPlayerId, targetPlotIndex);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽放养] 偷菜失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pasture/steal-history
 * 获取我偷别人的历史记录
 * Query: page=1, page_size=10
 */
router.get('/steal-history', auth, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size) || 10));
        const result = await BeastPastureService.getStealHistory(req.player, page, pageSize);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽放养] 获取偷菜历史失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pasture/stolen-history
 * 获取别人偷我的历史记录
 * Query: page=1, page_size=10
 */
router.get('/stolen-history', auth, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size) || 10));
        const result = await BeastPastureService.getStolenHistory(req.player, page, pageSize);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽放养] 获取被偷历史失败:', e);
        next(e);
    }
});

module.exports = router;
