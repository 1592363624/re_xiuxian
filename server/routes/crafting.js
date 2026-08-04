/**
 * 炼制系统路由
 *
 * 提供玩家炼丹/炼器的查询、学习、炼制接口
 *
 * 设计原则：
 *   - 路由层仅做参数校验和响应封装，业务逻辑全部下沉到 CraftingService
 *   - 所有写操作必须经过 auth 中间件鉴权
 *   - 响应统一格式：{ code: number, message?: string, ...result }
 *
 * 接口列表：
 *   GET  /api/crafting/recipes           - 获取已学配方列表
 *   GET  /api/crafting/available         - 获取所有可学习配方
 *   POST /api/crafting/learn             - 学习配方（通过丹方/图谱）
 *   POST /api/crafting/craft             - 炼制物品（auto 一键模式）
 *   POST /api/crafting/craft/start       - 开炉，创建火候会话
 *   POST /api/crafting/craft/heat        - 提交单阶段火候
 *   POST /api/crafting/craft/finish      - 开炉结算，产出成品
 *   POST /api/crafting/craft/cancel      - 停火散炉，放弃会话
 *   GET  /api/crafting/craft/session     - 查询当前火候会话（断线重连）
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const CraftingService = require('../game/services/CraftingService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 获取玩家已学配方列表（含材料持有量、冷却状态、实际成功率）
 * GET /api/crafting/recipes
 */
router.get('/recipes', auth, async (req, res, next) => {
    try {
        const data = await CraftingService.getLearnedRecipes(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取所有可学习配方列表（含学习状态）
 * GET /api/crafting/available
 */
router.get('/available', auth, async (req, res, next) => {
    try {
        const data = await CraftingService.getAvailableRecipes(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 学习配方（通过消耗丹方/图谱物品）
 * POST /api/crafting/learn
 * body: { item_key: string } - 丹方/图谱的物品key
 */
router.post('/learn', auth, async (req, res, next) => {
    try {
        const { item_key } = req.body;
        if (!item_key) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await CraftingService.learnRecipe(req.user.id, item_key);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 炼制物品
 * POST /api/crafting/craft
 * body: { recipe_id: string, quantity?: number } - 配方ID和炼制次数（默认1）
 */
router.post('/craft', auth, async (req, res, next) => {
    try {
        const { recipe_id, quantity = 1 } = req.body;
        if (!recipe_id) {
            throw new AppError('配方 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 显式声明 auto 模式：跳过火候交互，承担固定成功率惩罚
        const result = await CraftingService.craft(req.user.id, recipe_id, quantity, { auto: true });
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 开炉：创建火候炼制会话
 * POST /api/crafting/craft/start
 * body: { recipe_id: string, quantity?: number }
 */
router.post('/craft/start', auth, async (req, res, next) => {
    try {
        const { recipe_id, quantity = 1 } = req.body;
        if (!recipe_id) {
            throw new AppError('配方 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await CraftingService.craftStart(req.user.id, recipe_id, quantity);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 控火：提交当前阶段的火候档位
 * POST /api/crafting/craft/heat
 * body: { heat: number }
 */
router.post('/craft/heat', auth, async (req, res, next) => {
    try {
        const { heat } = req.body;
        // 允许 0 值通过校验，故用 undefined/null 判断而非真值判断
        if (heat === undefined || heat === null) {
            throw new AppError('火候档位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await CraftingService.craftHeat(req.user.id, heat);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 开炉结算：执行炼制并产出成品
 * POST /api/crafting/craft/finish
 */
router.post('/craft/finish', auth, async (req, res, next) => {
    try {
        const result = await CraftingService.craftFinish(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 停火散炉：主动放弃当前会话
 * POST /api/crafting/craft/cancel
 */
router.post('/craft/cancel', auth, async (req, res, next) => {
    try {
        const result = CraftingService.craftCancel(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 查询当前火候会话状态（用于断线重连恢复界面）
 * GET /api/crafting/craft/session
 */
router.get('/craft/session', auth, async (req, res, next) => {
    try {
        const data = CraftingService.getHeatSession(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
