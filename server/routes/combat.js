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
        const status = await CombatService.getBattleStatus(req.user.id);

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
        
        if (!itemId) {
            return res.status(400).json({ error: '物品ID不能为空' });
        }

        const player = await require('../models/player').findByPk(req.user.id);
        const item = await require('../models/item').findOne({
            where: { player_id: req.user.id, item_key: itemId }
        });

        if (!item || item.quantity < (quantity || 1)) {
            return res.status(400).json({ error: '物品数量不足' });
        }

        const itemConfig = await require('../services/ItemConfigLoader').getItem(itemId);
        if (!itemConfig || itemConfig.type !== 'consumable') {
            return res.status(400).json({ error: '该物品不可使用' });
        }

        const effect = itemConfig.effect || {};
        let message = '使用物品成功';

        if (effect.hp_restore) {
            const restoreAmount = Math.min(
                effect.hp_restore * (quantity || 1),
                Number(player.hp_max) - Number(player.hp_current)
            );
            player.hp_current = BigInt(Number(player.hp_current) + restoreAmount);
            message += `，恢复 ${restoreAmount} 气血`;
        }

        if (effect.mp_restore) {
            const restoreAmount = Math.min(
                effect.mp_restore * (quantity || 1),
                Number(player.attributes?.mp_max || 0) - Number(player.mp_current)
            );
            player.mp_current = BigInt(Number(player.mp_current) + restoreAmount);
            message += `，恢复 ${restoreAmount} 灵力`;
        }

        item.quantity -= (quantity || 1);
        if (item.quantity <= 0) {
            await item.destroy();
        } else {
            await item.save();
        }

        await player.save();

        res.json({
            code: 200,
            message: message,
            player_hp: player.hp_current.toString(),
            player_mp: player.mp_current.toString()
        });
    } catch (error) {
        console.error('Use Item Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 获取当前地图可遭遇怪物列表
 */
router.get('/monsters', auth, async (req, res) => {
    try {
        const player = await require('../models/player').findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        const MapConfigLoader = require('../services/MapConfigLoader');
        const mapConfig = MapConfigLoader.getMap(player.current_map_id);
        
        if (!mapConfig || !mapConfig.monsters) {
            return res.json({
                map_id: player.current_map_id,
                monsters: []
            });
        }

        const monsters = mapConfig.monsters.map(m => ({
            id: m.id,
            name: m.name,
            realm: m.realm,
            exp: m.exp
        }));

        res.json({
            map_id: player.current_map_id,
            monsters: monsters
        });
    } catch (error) {
        console.error('Get Monsters Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
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
