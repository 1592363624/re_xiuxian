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
// 修复：境界顺序统一从 gameConstants 读取，避免重复定义和不一致
const { REALM_ORDER } = require('../utils/gameConstants');
// 引入 WebSocket 通知服务，用于战斗关键节点主动推送玩家数据更新
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');

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

        // 推送战斗攻击结果，前端据此刷新玩家 HP/状态（战斗中 HP 变化需实时同步）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.user.id, 'combat_action', {
                action: 'attack',
                battle_ended: result.battleEnded || result.victory || false,
                hp_current: result.player_hp
            });
        } catch (e) {
            console.warn('[Combat] 推送战斗攻击事件失败:', e.message);
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

        // 推送逃跑结果，前端据此刷新战斗状态（退出战斗或继续战斗）
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.user.id, 'combat_flee', {
                fled: result.fled || false,
                battle_ended: result.fled || false
            });
        } catch (e) {
            console.warn('[Combat] 推送逃跑事件失败:', e.message);
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
 * 放弃战斗（强制脱离卡死的战斗，不计入战斗历史）
 * 使用场景：玩家有遗留的过期战斗记录，flee 又失败时，用此接口直接清除
 * 与 flee 的区别：abandon 无概率失败、不保存战斗记录、无惩罚
 */
router.post('/abandon', auth, async (req, res, next) => {
    try {
        const result = await CombatService.abandon(req.user.id);

        // 推送放弃战斗事件，前端据此关闭战斗面板
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.user.id, 'combat_abandon', {
                battle_ended: true
            });
        } catch (e) {
            console.warn('[Combat] 推送放弃战斗事件失败:', e.message);
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
        // 历史记录默认/最大条数从配置读取，避免硬编码
        const { infrastructure } = require('../modules');
        const historyConfig = infrastructure.ConfigLoader.getConfig('game_balance')?.combat_history || {};
        const defaultLimit = historyConfig.default_limit ?? 20;
        const maxLimit = historyConfig.max_limit ?? 100;
        const limit = Math.min(parseInt(req.query.limit) || defaultLimit, maxLimit);
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
 *
 * 修复 B1 bug：用 RealmService.getRealmRank 替代 REALM_ORDER.indexOf 比较。
 * 旧逻辑下，化神期及以上境界在 REALM_ORDER 中返回 -1，难度判断错误。
 * 新逻辑直接用 rank 数值比较，正确支持所有境界。
 * @param {string} monsterRealm 怪物境界
 * @param {string} playerRealm 玩家境界
 * @returns {object} 难度信息 { class, name, safe }
 */
function _getMonsterDifficulty(monsterRealm, playerRealm) {
    const RealmService = require('../game/core/RealmService');
    const playerRank = RealmService.getRealmRank(playerRealm || '凡人');
    const monsterRank = RealmService.getRealmRank(monsterRealm);

    const diff = monsterRank - playerRank;
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
        // 修复：避免函数体内动态 require，统一在文件顶部引入
        const Player = require('../models/player');
        const MapConfigLoader = require('../game/services/MapConfigLoader');
        const player = await Player.findByPk(req.user.id);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

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
