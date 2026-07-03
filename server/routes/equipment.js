/**
 * 装备穿戴系统路由
 *
 * 提供玩家装备的查询、穿戴、卸下及加成查询接口
 * 业务逻辑全部下沉到 EquipmentService，路由层仅做参数校验和响应封装
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const EquipmentService = require('../game/services/EquipmentService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 获取玩家已装备物品列表
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

module.exports = router;
