/**
 * 战斗系统路由
 * 
 * 提供怪物战斗相关接口
 */
const express = require('express');
const router = express.Router();
const CombatService = require('../game/services/CombatService');
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
        res.status(500).json({ code: 500, message: error.message || '服务器错误' });
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
        res.status(status).json({ code: status, message: error.message || '服务器错误' });
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
        res.status(500).json({ code: 500, message: error.message || '服务器错误' });
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
        res.status(500).json({ code: 500, message: error.message || '服务器错误' });
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
        res.status(500).json({ code: 500, message: error.message || '服务器错误' });
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
        res.status(500).json({ code: 500, message: error.message || '服务器错误' });
    }
});

/**
 * 使用物品（战斗中使用）
 */
router.post('/use-item', auth, async (req, res) => {
    try {
        const { itemId, quantity } = req.body;
        
        // 调用 Service 层方法
        const result = await game.CombatService.useItem(req.user.id, itemId, quantity || 1);
        
        res.json({
            code: 200,
            message: result.message,
            player_hp: result.player_hp,
            player_mp: result.player_mp
        });
    } catch (error) {
        console.error('Use Item Error:', error);
        res.status(400).json({ code: 400, message: error.message || '服务器错误' });
    }
});

/**
 * 计算怪物相对玩家的难度标签
 * @param {string} monsterRealm 怪物境界
 * @param {string} playerRealm 玩家境界
 * @returns {object} 难度信息 { class, name, safe }
 */
function _getMonsterDifficulty(monsterRealm, playerRealm) {
    const realmOrder = [
        '凡人', '炼气1层', '炼气2层', '炼气3层', '炼气4层', '炼气5层',
        '炼气6层', '炼气7层', '炼气8层', '炼气9层', '炼气10层',
        '筑基期', '筑基初期', '筑基中期', '筑基后期', '筑基圆满',
        '金丹期', '金丹初期', '金丹中期', '金丹后期', '金丹圆满',
        '元婴期'
    ];
    const playerIdx = realmOrder.indexOf(playerRealm || '凡人');
    const monsterIdx = realmOrder.indexOf(monsterRealm);
    
    const diff = monsterIdx - playerIdx;
    if (diff <= -2) return { class: 'text-emerald-400', name: '弱小的怪物', safe: true };
    if (diff <= 0) return { class: 'text-yellow-400', name: '同级怪物', safe: true };
    if (diff <= 2) return { class: 'text-orange-400', name: '较强的怪物', safe: false };
    return { class: 'text-red-400', name: '极危险的怪物', safe: false };
}

/**
 * 获取当前地图可遭遇怪物列表
 */
router.get('/monsters', auth, async (req, res) => {
    try {
        const player = await require('../models/player').findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const MapConfigLoader = require('../game/services/MapConfigLoader');
        const mapConfig = MapConfigLoader.getMap(player.current_map_id);
        
        if (!mapConfig || !mapConfig.monsters) {
            return res.json({
                code: 200,
                data: {
                    map_id: player.current_map_id,
                    monsters: []
                }
            });
        }

        // 读取技能灵力消耗配置
        const configLoader = require('../modules/infrastructure/ConfigLoader');
        let skillMpCost = 20; // 默认值
        try {
            const balanceConfig = await configLoader.loadConfig('game_balance');
            skillMpCost = balanceConfig?.combat?.skill_mp_cost || 20;
        } catch (e) {
            // 配置加载失败使用默认值
        }

        const monsters = mapConfig.monsters.map(m => ({
            id: m.id,
            name: m.name,
            realm: m.realm,
            exp: m.exp,
            // 由后端计算难度标签，避免前端硬编码境界顺序
            difficulty: _getMonsterDifficulty(m.realm, player.realm)
        }));

        res.json({
            code: 200,
            data: {
                map_id: player.current_map_id,
                monsters: monsters,
                skill_mp_cost: skillMpCost
            }
        });
    } catch (error) {
        console.error('Get Monsters Error:', error);
        res.status(500).json({ code: 500, message: error.message || '服务器错误' });
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
        res.status(status).json({ code: status, message: error.message || '服务器错误' });
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
        res.status(500).json({ code: 500, message: error.message || '服务器错误' });
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
        res.status(500).json({ code: 500, message: error.message || '服务器错误' });
    }
});

module.exports = router;
