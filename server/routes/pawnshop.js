/**
 * 当铺系统路由（聚宝当铺）
 *
 * 提供玩家在当铺的状态查询、估值、典当、赎回、当票列表与历史记录接口
 * 业务逻辑全部下沉到 PawnshopService，路由层仅做参数校验和响应封装
 * 所有接口均使用 auth 中间件鉴权，错误统一通过 next(error) 交给全局 errorHandler
 *
 * 路由清单：
 *   1. GET  /status      - 获取当铺状态（信用/今日次数/活跃当票）
 *   2. POST /appraise    - 估值预览（不实际典当）
 *   3. POST /pawn        - 典当物品
 *   4. POST /redeem      - 赎回当票
 *   5. GET  /list        - 当票列表（分页，支持 filter=all/active/redeemed/overdue）
 *   6. GET  /history    - 历史记录（分页）
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证（auth 中间件）
 *   - 业务错误统一使用 AppError + ErrorCodes 抛出
 *   - 参数校验在路由层完成，业务校验在 Service 层完成
 *   - 灵石金额使用 BIGINT 存储，序列化为字符串避免 JS Number 精度问题
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const PawnshopService = require('../game/services/PawnshopService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * GET /api/pawnshop/status
 * 获取当铺状态（信用额度/今日次数/活跃当票/最近历史）
 * 返回：{ credit, daily_pawn_count, daily_pawn_limit, active_listings_count, active_listings, history, config }
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await PawnshopService.getStatus(req.user.id);
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/pawnshop/appraise
 * 估值预览（不实际典当，仅返回估值）
 * body: { item_key, quantity }
 * 返回：{ item_info, base_price, valuation_per_item, total_valuation, pawn_amount, pawn_fee, redeem_amount_7d }
 */
router.post('/appraise', auth, async (req, res, next) => {
    try {
        const { item_key, quantity } = req.body;
        if (!item_key) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const data = await PawnshopService.appraise(
            req.user.id,
            item_key,
            parseInt(quantity) || 1
        );
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/pawnshop/pawn
 * 典当物品（扣减物品、增加灵石、创建当票）
 * body: { item_key, quantity }
 * 返回：{ success, message, listing_id, pawn_amount, redeem_amount_initial, redeem_deadline, spirit_stones_after }
 */
router.post('/pawn', auth, async (req, res, next) => {
    try {
        const { item_key, quantity } = req.body;
        if (!item_key) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await PawnshopService.pawn(
            req.user.id,
            item_key,
            parseInt(quantity) || 1
        );
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/pawnshop/redeem
 * 赎回当票（扣减灵石、归还物品、增加信用）
 * body: { listing_id }
 * 返回：{ success, message, listing_id, redeem_amount, credit_after, spirit_stones_after }
 */
router.post('/redeem', auth, async (req, res, next) => {
    try {
        const { listing_id } = req.body;
        if (!listing_id) {
            throw new AppError('当票 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await PawnshopService.redeem(
            req.user.id,
            parseInt(listing_id)
        );
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/pawnshop/list
 * 当票列表（分页，支持 filter=all/active/redeemed/overdue）
 * query: { page, limit, filter }
 * 返回：{ list, total, page, page_size, total_pages }
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const data = await PawnshopService.getList(req.user.id, {
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 10,
            filter: req.query.filter || 'all'
        });
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/pawnshop/history
 * 历史记录（分页）
 * query: { page, limit }
 * 返回：{ list, total, page, page_size, total_pages }
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const data = await PawnshopService.getHistory(req.user.id, {
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 10
        });
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
