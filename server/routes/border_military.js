/**
 * 慕兰战线系统路由
 *
 * 提供慕兰战线完整闭环的玩家端 HTTP 接口，对应玩法文档第16节：
 *   1. GET    /api/border-military/status          : 查询玩家战线状态（军衔/军议/今日行动/里程碑）
 *   2. POST   /api/border-military/support         : 执行支援慕兰（4 种路线）
 *   3. GET    /api/border-military/briefing         : 查询今日军议（密令/险棋/粮道路线）
 *   4. GET    /api/border-military/rank             : 查询军衔信息
 *   5. GET    /api/border-military/intel            : 查询军报列表
 *   6. POST   /api/border-military/intel/collect    : 搜集军报（每日 1 次）
 *   7. POST   /api/border-military/intel/identify   : 辨报
 *   8. POST   /api/border-military/intel/public     : 公开军报
 *   9. GET    /api/border-military/shop             : 查询军功司兑换列表
 *  10. POST   /api/border-military/exchange         : 军功兑换
 *  11. GET    /api/border-military/history          : 查询支援历史
 *  12. GET    /api/border-military/beast-patrol     : 查询灵兽巡边状态
 *  13. POST   /api/border-military/beast-patrol     : 派出灵兽巡边
 *  14. POST   /api/border-military/beast-patrol/return : 灵兽巡边归来结算
 *  15. GET    /api/border-military/remnant-map      : 查询残图匣状态
 *  16. POST   /api/border-military/remnant-map/combine : 拼残图
 *  17. POST   /api/border-military/remnant-map/explore : 按图探禁
 *  18. GET    /api/border-military/imprint          : 查询临战刻印状态
 *  19. POST   /api/border-military/imprint/apply    : 施加临战刻印
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 BorderMilitaryService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const BorderMilitaryService = require('../game/services/BorderMilitaryService');
const { ErrorCodes } = require('../middleware/errorHandler');

// 初始化服务（注入配置加载器，与 sect_special.js 风格一致）
const { infrastructure } = require('../modules');
BorderMilitaryService.initialize(infrastructure.ConfigLoader);

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * @param {Object} result - Service 返回的 { success, message, data }
 * @param {Object} res - Express 响应对象
 */
function sendServiceResult(result, res) {
    if (result.success) {
        return res.json({
            code: 200,
            message: result.message || 'success',
            data: result.data || null
        });
    }
    return res.json({
        code: 200,
        success: false,
        message: result.message,
        data: result.data || null,
        error_code: result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR
    });
}

// ==================== 慕兰军议 / 状态查询 ====================

/**
 * GET /api/border-military/status
 * 查询玩家战线状态（军衔 / 今日军议 / 今日各行动状态 / 里程碑进度）
 * 该接口为只读操作，自动初始化今日军议
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const result = await BorderMilitaryService.getStatus(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/border-military/briefing
 * 查询今日军议（密令路线 / 险棋路线 / 粮道路线）
 */
router.get('/briefing', auth, async (req, res, next) => {
    try {
        const briefing = BorderMilitaryService.getDailyBriefing();
        res.json({
            code: 200,
            data: briefing,
            message: `今日军议：密令=${briefing?.secret_order || '-'}, 险棋=${briefing?.risky_route || '-'}, 粮道=${briefing?.grain_route || '-'}`
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/border-military/rank
 * 查询军衔信息（含累计军功 / 可用军功 / 军衔等级 / 加成比例）
 */
router.get('/rank', auth, async (req, res, next) => {
    try {
        const rankInfo = BorderMilitaryService.getMilitaryRank(req.player);
        res.json({ code: 200, data: rankInfo });
    } catch (err) {
        next(err);
    }
});

// ==================== 支援慕兰 ====================

/**
 * POST /api/border-military/support
 * 执行支援慕兰
 * 请求体：{ route: 'scout' | 'lamp_breaker' | 'array_guard' | 'raid' }
 */
router.post('/support', auth, async (req, res, next) => {
    try {
        const { route } = req.body;
        if (!route || typeof route !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'route 必填，可选：scout/lamp_breaker/array_guard/raid'
            });
        }
        const result = await BorderMilitaryService.supportMulanan(req.player, route);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/border-military/history
 * 查询支援历史（默认 20 条，最多 100 条）
 * 查询参数：?limit=20
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 20;
        const result = await BorderMilitaryService.getSupportHistory(req.player, limit);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

// ==================== 慕兰谍影 ====================

/**
 * GET /api/border-military/intel
 * 查询军报列表
 * 查询参数：?only_today=1 (默认只看今日)
 */
router.get('/intel', auth, async (req, res, next) => {
    try {
        const onlyToday = req.query.only_today !== '0' && req.query.only_today !== 'false';
        const result = await BorderMilitaryService.getIntelList(req.player, onlyToday);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/intel/collect
 * 搜集军报（每日 1 次，生成 3 条真假混杂的军报）
 */
router.post('/intel/collect', auth, async (req, res, next) => {
    try {
        const result = await BorderMilitaryService.collectIntel(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/intel/identify
 * 辨报（研判某条军报的真伪）
 * 请求体：{ report_id: number }
 */
router.post('/intel/identify', auth, async (req, res, next) => {
    try {
        const { report_id } = req.body;
        if (!report_id || typeof report_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'report_id 必填且必须为数字'
            });
        }
        const result = await BorderMilitaryService.identifyIntel(req.player, report_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/intel/public
 * 公开军报（将辨报后的军报交给前线，每日限 1 次）
 * 请求体：{ report_id: number }
 */
router.post('/intel/public', auth, async (req, res, next) => {
    try {
        const { report_id } = req.body;
        if (!report_id || typeof report_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'report_id 必填且必须为数字'
            });
        }
        const result = await BorderMilitaryService.publicIntel(req.player, report_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

// ==================== 军功司 ====================

/**
 * GET /api/border-military/shop
 * 查询军功司兑换列表（含可兑换状态）
 */
router.get('/shop', auth, async (req, res, next) => {
    try {
        const result = BorderMilitaryService.getMilitaryShop(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/exchange
 * 军功兑换
 * 请求体：{ item_key: string, quantity?: number }
 */
router.post('/exchange', auth, async (req, res, next) => {
    try {
        const { item_key, quantity } = req.body;
        if (!item_key || typeof item_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'item_key 必填且必须为字符串'
            });
        }
        const qty = parseInt(quantity, 10) || 1;
        const result = await BorderMilitaryService.exchangeMerit(req.player, item_key, qty);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

// ==================== 灵兽边境 ====================

/**
 * GET /api/border-military/beast-patrol
 * 查询灵兽巡边状态（active 巡边 + 最近 10 条历史）
 */
router.get('/beast-patrol', auth, async (req, res, next) => {
    try {
        const result = await BorderMilitaryService.beastPatrolStatus(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/beast-patrol
 * 派出灵兽巡边
 * 请求体：{ beast_id: number, route: 'scout' | 'grain_guard' | 'camp_raid' }
 */
router.post('/beast-patrol', auth, async (req, res, next) => {
    try {
        const { beast_id, route } = req.body;
        if (!beast_id || typeof beast_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beast_id 必填且必须为数字'
            });
        }
        if (!route || typeof route !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'route 必填，可选：scout/grain_guard/camp_raid'
            });
        }
        const result = await BorderMilitaryService.beastPatrol(req.player, beast_id, route);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/beast-patrol/return
 * 灵兽巡边归来结算
 * 请求体：{ patrol_id: number }
 */
router.post('/beast-patrol/return', auth, async (req, res, next) => {
    try {
        const { patrol_id } = req.body;
        if (!patrol_id || typeof patrol_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'patrol_id 必填且必须为数字'
            });
        }
        const result = await BorderMilitaryService.beastPatrolReturn(req.player, patrol_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

// ==================== 残图匣 ====================

/**
 * GET /api/border-military/remnant-map
 * 查询残图匣状态（4 类残片 + 完整残图 + 可拼图/可探禁状态）
 */
router.get('/remnant-map', auth, async (req, res, next) => {
    try {
        const result = await BorderMilitaryService.getRemnantMapStatus(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/remnant-map/combine
 * 拼残图（消耗 4 类残片各 1 个 + 灵石，获得 1 张完整残图）
 */
router.post('/remnant-map/combine', auth, async (req, res, next) => {
    try {
        const result = await BorderMilitaryService.combineRemnantMap(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/remnant-map/explore
 * 按图探禁（消耗 1 张完整残图，每日限 1 次）
 */
router.post('/remnant-map/explore', auth, async (req, res, next) => {
    try {
        const result = await BorderMilitaryService.exploreRemnantMap(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

// ==================== 临战刻印 ====================

/**
 * GET /api/border-military/imprint
 * 查询临战刻印状态（active 刻印 + 最近 10 条历史 + 可用刻印类型）
 */
router.get('/imprint', auth, async (req, res, next) => {
    try {
        const result = await BorderMilitaryService.getImprintStatus(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/border-military/imprint/apply
 * 施加临战刻印
 * 请求体：{ artifact_id: number, imprint_type: 'lamp_breaker' | 'array_guard' | 'scout_stealth' }
 */
router.post('/imprint/apply', auth, async (req, res, next) => {
    try {
        const { artifact_id, imprint_type } = req.body;
        if (!artifact_id || typeof artifact_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'artifact_id 必填且必须为数字'
            });
        }
        if (!imprint_type || typeof imprint_type !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'imprint_type 必填，可选：lamp_breaker/array_guard/scout_stealth'
            });
        }
        const result = await BorderMilitaryService.applyWarImprint(req.player, artifact_id, imprint_type);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
