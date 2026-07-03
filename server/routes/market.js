/**
 * 坊市（万宝楼）系统路由
 *
 * 提供坊市挂单的查询、搜索、上架、购买（换物）、下架接口
 * 业务逻辑全部下沉到 MarketService，路由层仅做参数校验和响应封装
 * 所有接口均使用 auth 中间件鉴权，错误统一通过 next(error) 交给全局 errorHandler
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const MarketService = require('../game/services/MarketService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 获取坊市挂单列表（分页，支持按物品类型/名称筛选）
 * GET /api/market/list
 * query: { page, type, keyword }
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const filter = {
            type: req.query.type || null,
            keyword: req.query.keyword || null
        };
        const data = await MarketService.getListings(page, filter);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 搜索坊市挂单（按物品名称模糊搜索）
 * GET /api/market/search
 * query: { keyword, page }
 */
router.get('/search', auth, async (req, res, next) => {
    try {
        const keyword = req.query.keyword;
        if (!keyword) {
            throw new AppError('搜索关键词不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const page = parseInt(req.query.page) || 1;
        const data = await MarketService.searchListings(keyword, page);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取我的货摊（当前玩家的所有挂单）
 * GET /api/market/my
 * query: { page }
 */
router.get('/my', auth, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const data = await MarketService.getMyListings(req.user.id, page);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 上架物品（创建挂单）
 * POST /api/market/list
 * body: { item_key, quantity, want_item_key, want_quantity }
 */
router.post('/list', auth, async (req, res, next) => {
    try {
        const { item_key, quantity, want_item_key, want_quantity } = req.body;
        if (!item_key) {
            throw new AppError('出售物品键名不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!want_item_key) {
            throw new AppError('换取物品键名不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await MarketService.createListing(
            req.user.id,
            item_key,
            parseInt(quantity) || 1,
            want_item_key,
            parseInt(want_quantity) || 1
        );
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 购买挂单（换物交易）
 * POST /api/market/buy
 * body: { listing_id }
 */
router.post('/buy', auth, async (req, res, next) => {
    try {
        const { listing_id } = req.body;
        if (!listing_id) {
            throw new AppError('挂单ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await MarketService.buyListing(req.user.id, parseInt(listing_id));
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 下架挂单（退还物品给卖家）
 * POST /api/market/cancel
 * body: { listing_id }
 */
router.post('/cancel', auth, async (req, res, next) => {
    try {
        const { listing_id } = req.body;
        if (!listing_id) {
            throw new AppError('挂单ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await MarketService.cancelListing(req.user.id, parseInt(listing_id));
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
