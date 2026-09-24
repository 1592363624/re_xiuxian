/**
 * 通天灵宝炼制路由
 * GET  /api/legendary-weapons/config
 * POST /api/legendary-weapons/craft  body: { recipe, bonuses? }
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const LegendaryWeaponsService = require('../game/services/LegendaryWeaponsService');

router.get('/config', auth, async (req, res, next) => {
    try {
        res.json({ code: 200, data: LegendaryWeaponsService.config() });
    } catch (err) { next(err); }
});

/** 配方清单（炼制面板第三页） */
router.get('/recipes', auth, async (req, res, next) => {
    try {
        const InventoryService = require('../game/services/InventoryService');
        const recipes = LegendaryWeaponsService.listRecipes();
        // 附带材料持有量，界面直接灰掉不可炼
        const allKeys = new Set();
        for (const r of recipes) {
            for (const k of Object.keys(r.materials || {})) {
                if (k !== 'spirit_stones') allKeys.add(k);
            }
        }
        const owned = await InventoryService.getItemQuantities(req.player.id, [...allKeys]).catch(() => new Map());
        const withStock = recipes.map(r => ({
            ...r,
            stock: Object.fromEntries(
                Object.keys(r.materials || {})
                    .filter(k => k !== 'spirit_stones')
                    .map(k => [k, Number(owned.get(k)) || 0])
            ),
            spirit_stones_cost: Number(r.materials?.spirit_stones) || 0
        }));
        res.json({ code: 200, data: { recipes: withStock } });
    } catch (err) { next(err); }
});

router.post('/craft', auth, async (req, res, next) => {
    try {
        const data = await LegendaryWeaponsService.craft(req.player.id, req.body.recipe, req.body.bonuses || {});
        res.json({ code: 200, message: data.message, data });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({ code: err.statusCode, error_code: err.errorCode, message: err.message });
        }
        next(err);
    }
});

module.exports = router;
