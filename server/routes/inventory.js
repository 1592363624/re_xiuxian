/**
 * 背包（储物袋）系统路由
 *
 * 提供玩家物品的查询、使用、丢弃接口
 * 业务逻辑全部下沉到 InventoryService，路由层仅做参数校验和响应封装
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const InventoryService = require('../game/services/InventoryService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 获取玩家背包列表
 * GET /api/inventory
 */
router.get('/', auth, async (req, res, next) => {
    try {
        const data = await InventoryService.getInventory(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 使用物品（消耗品）
 * POST /api/inventory/use
 * body: { item_key, quantity }
 */
router.post('/use', auth, async (req, res, next) => {
    try {
        const { item_key, quantity } = req.body;
        if (!item_key) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await InventoryService.useItem(
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
 * 丢弃物品
 * POST /api/inventory/discard
 * body: { item_key, quantity }
 */
router.post('/discard', auth, async (req, res, next) => {
    try {
        const { item_key, quantity } = req.body;
        if (!item_key) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await InventoryService.discardItem(
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
 * 获取物品分类（用于前端按类型筛选）
 * GET /api/inventory/categories
 */
router.get('/categories', auth, async (req, res, next) => {
    try {
        const data = await InventoryService.getInventory(req.user.id);
        // 按 type 分组统计
        const categories = {};
        for (const item of data.items) {
            const type = item.type || 'unknown';
            if (!categories[type]) {
                categories[type] = { type, count: 0, total_quantity: 0 };
            }
            categories[type].count += 1;
            categories[type].total_quantity += item.quantity;
        }
        res.json({
            code: 200,
            data: {
                categories: Object.values(categories),
                capacity: data.capacity,
                total_count: data.total_count
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
