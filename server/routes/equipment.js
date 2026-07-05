/**
 * 装备穿戴系统路由
 *
 * 提供玩家装备的查询、穿戴、卸下、加成查询接口
 * 法宝深度系统（v1.2 新增）：祭炼、本命、祭出/收回、调序、散念、修理、一键修理
 *
 * 设计原则：
 *   - 路由层仅做参数校验和响应封装，业务逻辑全部下沉到 EquipmentService
 *   - 所有写操作必须经过 auth 中间件鉴权
 *   - 响应统一格式：{ code: number, message?: string, ...result }
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const EquipmentService = require('../game/services/EquipmentService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 获取玩家已装备物品列表（含法宝深度系统字段）
 * GET /api/equipment
 */
router.get('/', auth, async (req, res, next) => {
    try {
        const data = await EquipmentService.getEquipped(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

/**
 * 穿戴装备
 * POST /api/equipment/equip
 * body: { item_key }
 */
router.post('/equip', auth, async (req, res, next) => {
    try {
        const { item_key } = req.body;
        if (!item_key) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.equip(req.user.id, item_key);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 卸下装备
 * POST /api/equipment/unequip
 * body: { slot }
 */
router.post('/unequip', auth, async (req, res, next) => {
    try {
        const { slot } = req.body;
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.unequip(req.user.id, slot);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取装备总加成
 * GET /api/equipment/bonus
 */
router.get('/bonus', auth, async (req, res, next) => {
    try {
        const data = await EquipmentService.getEquipmentBonus(req.user.id);
        res.json({ code: 200, data });
    } catch (error) {
        next(error);
    }
});

// ========================================
// 法宝深度系统接口（v1.2 新增）
// ========================================

/**
 * 祭炼（精炼）装备
 * POST /api/equipment/refine
 * body: { slot }
 * 业务效果：消耗灵石+材料，按成功率随机成功/失败，成功则 refine_level +1
 */
router.post('/refine', auth, async (req, res, next) => {
    try {
        const { slot } = req.body;
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.refineItem(req.user.id, slot);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 设置本命法器
 * POST /api/equipment/benming
 * body: { slot }
 * 业务效果：消耗灵石+材料，将装备绑定为本命，分配 benming_slot
 */
router.post('/benming', auth, async (req, res, next) => {
    try {
        const { slot } = req.body;
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.setBenming(req.user.id, slot);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 祭出本命法器
 * POST /api/equipment/summon
 * body: { slot }
 * 业务效果：标记 is_summoned=true，受场景限制（闭关/移动中禁用）
 */
router.post('/summon', auth, async (req, res, next) => {
    try {
        const { slot } = req.body;
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.summonTreasure(req.user.id, slot);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 收回本命法器
 * POST /api/equipment/recall
 * body: { slot }
 * 业务效果：标记 is_summoned=false
 */
router.post('/recall', auth, async (req, res, next) => {
    try {
        const { slot } = req.body;
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.recallTreasure(req.user.id, slot);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 调整装备排序
 * POST /api/equipment/order
 * body: { slot, new_order }
 * 业务效果：更新 sort_order 字段，影响面板显示顺序
 */
router.post('/order', auth, async (req, res, next) => {
    try {
        const { slot, new_order } = req.body;
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (typeof new_order !== 'number' || new_order < 0 || new_order > 99) {
            throw new AppError('排序值必须为 0~99 之间的整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.adjustOrder(req.user.id, slot, new_order);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 散念（解除本命法器）
 * POST /api/equipment/disperse
 * body: { slot }
 * 业务效果：清除本命标记，回收部分材料
 */
router.post('/disperse', auth, async (req, res, next) => {
    try {
        const { slot } = req.body;
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.disperseSpirit(req.user.id, slot);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 修理单件装备
 * POST /api/equipment/repair
 * body: { slot }
 * 业务效果：恢复耐久至 max_durability，扣减 max_durability 上限
 */
router.post('/repair', auth, async (req, res, next) => {
    try {
        const { slot } = req.body;
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await EquipmentService.repair(req.user.id, slot);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * 一键修理所有装备
 * POST /api/equipment/repair-all
 * body: {} (无需参数)
 * 业务效果：遍历所有装备，对需要修理的逐个调用 repair
 */
router.post('/repair-all', auth, async (req, res, next) => {
    try {
        const result = await EquipmentService.repairAll(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
