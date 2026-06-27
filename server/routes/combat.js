/**
 * 战斗系统路由
 * 
 * 提供怪物战斗相关接口
 */
const express = require('express');
const router = express.Router();
const CombatService = require('../game/services/CombatService');
const auth = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const Validator = require('../utils/validator');
const ConfigHelper = require('../utils/configHelper');

/**
 * 遭遇怪物
 */
router.post('/encounter', auth, async (req, res, next) => {
    try {
        const { monsterId } = req.body;
        Validator.isRequired(monsterId, '怪物ID');
        const result = await CombatService.encounter(req.user.id, monsterId);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 发起攻击
 */
router.post('/attack', auth, async (req, res, next) => {
    try {
        const { action } = req.body;
        const result = await CombatService.attack(req.user.id, action || 'attack');

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 怪物行动（客户端轮询）
 */
router.post('/monster-turn', auth, async (req, res, next) => {
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
        next(error);
    }
});

/**
 * 尝试逃跑
 */
router.post('/flee', auth, async (req, res, next) => {
    try {
        const result = await CombatService.flee(req.user.id);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取战斗状态
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const { battle_id } = req.query;
        const status = await CombatService.getBattleStatus(req.user.id, battle_id);

        res.json({
            code: 200,
            ...status
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取战斗历史
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const history = await CombatService.getBattleHistory(req.user.id, limit);

        res.json({
            code: 200,
            count: history.length,
            battles: history
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 使用物品（战斗中使用）
 */
router.post('/use-item', auth, async (req, res, next) => {
    try {
        const { itemId, quantity } = req.body;

        // 输入验证
        Validator.isNonEmptyString(itemId, '物品ID');
        Validator.isPositiveInteger(quantity || 1, '数量');

        // 验证服务对象存在性
        if (!CombatService.useItem) {
            throw new AppError('战斗服务暂不可用', 503, ErrorCodes.SERVICE_UNAVAILABLE);
        }

        const result = await CombatService.useItem(req.user.id, itemId, quantity || 1);

        res.json({
            code: 200,
            message: result.message,
            player_hp: result.player_hp,
            player_mp: result.player_mp
        });
    } catch (error) {
        next(error);
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
router.get('/monsters', auth, async (req, res, next) => {
    try {
        const player = await require('../models/player').findByPk(req.user.id);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

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

        // 使用 ConfigHelper 安全读取技能灵力消耗配置
        const skillMpCost = ConfigHelper.getNumericConfig(
            'game_balance', 'combat.skill_mp_cost', 20, 1, 1000
        );

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
        next(error);
    }
});

/**
 * 使用技能
 */
router.post('/skill', auth, async (req, res, next) => {
    try {
        const { skillIndex } = req.body;
        const result = await CombatService.useSkill(req.user.id, skillIndex || 0);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 逃跑（兼容旧接口）
 */
router.post('/escape', auth, async (req, res, next) => {
    try {
        const result = await CombatService.flee(req.user.id);

        res.json({
            code: 200,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取战斗统计
 */
router.get('/stats', auth, async (req, res, next) => {
    try {
        const stats = await CombatService.getCombatStats(req.user.id);

        res.json({
            code: 200,
            ...stats
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
