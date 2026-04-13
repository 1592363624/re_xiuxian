/**
 * 战斗系统路由
 * 
 * 提供怪物战斗相关接口
 */
const express = require('express');
const router = express.Router();
const CombatService = require('../services/CombatService');
const auth = require('../middleware/auth');

/**
 * 遭遇怪物
 */
router.post('/encounter', auth, async (req, res) => {
    try {
        const { monsterId } = req.body;
        const result = await CombatService.encounter(req.user.id, monsterId);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        console.error('Encounter Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 发起攻击
 */
router.post('/attack', auth, async (req, res) => {
    try {
        const { action } = req.body;
        const result = await CombatService.attack(req.user.id, action || 'attack');

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        console.error('Attack Error:', error);
        const status = error.message.includes('还未轮到') ? 400 : 500;
        res.status(status).json({ error: error.message || 'Server error' });
    }
});

/**
 * 怪物行动（客户端轮询）
 */
router.post('/monster-turn', auth, async (req, res) => {
    try {
        const result = await CombatService.monsterTurn(req.user.id);

        if (!result) {
            return res.json({
                in_battle: true,
                waiting_for_player: true
            });
        }

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        console.error('Monster Turn Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 尝试逃跑
 */
router.post('/flee', auth, async (req, res) => {
    try {
        const result = await CombatService.flee(req.user.id);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        console.error('Flee Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 获取战斗状态
 */
router.get('/status', auth, async (req, res) => {
    try {
        const { battle_id } = req.query;
        const status = await CombatService.getBattleStatus(req.user.id, battle_id);

        res.json({
            code: 200,
            ...status
        });
    } catch (error) {
        console.error('Get Status Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 获取战斗历史
 */
router.get('/history', auth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const history = await CombatService.getBattleHistory(req.user.id, limit);

        res.json({
            code: 200,
            count: history.length,
            battles: history
        });
    } catch (error) {
        console.error('Get History Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 使用物品（战斗中使用）
 */
router.post('/use-item', auth, async (req, res) => {
    try {
        const { itemId, quantity } = req.body;
        const result = await CombatService.useItem(req.user.id, itemId, quantity);
        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        console.error('Use Item Error:', error);
        res.status(error.status || 500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 获取当前地图可遭遇怪物列表
 */
router.get('/monsters', auth, async (req, res) => {
    try {
        const result = await CombatService.getMonsters(req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Get Monsters Error:', error);
        res.status(error.status || 500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 使用技能
 */
router.post('/skill', auth, async (req, res) => {
    try {
        const { skillIndex } = req.body;
        const result = await CombatService.useSkill(req.user.id, skillIndex || 0);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        console.error('Use Skill Error:', error);
        const status = error.message.includes('灵力不足') ? 400 : 
                      error.message.includes('技能') ? 400 : 500;
        res.status(status).json({ error: error.message || 'Server error' });
    }
});

/**
 * 逃跑（兼容旧接口）
 */
router.post('/escape', auth, async (req, res) => {
    try {
        const result = await CombatService.flee(req.user.id);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        console.error('Escape Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 获取战斗统计
 */
router.get('/stats', auth, async (req, res) => {
    try {
        const stats = await CombatService.getCombatStats(req.user.id);

        res.json({
            code: 200,
            ...stats
        });
    } catch (error) {
        console.error('Get Combat Stats Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

module.exports = router;
