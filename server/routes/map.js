/**
 * 地图系统路由
 * 
 * 静态配置从 map_data.json 读取，动态数据从数据库读取
 * 支持即时移动和延时移动两种模式
 */
const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerMapPosition = require('../models/playerMapPosition');
const PlayerMovement = require('../models/playerMovement');
const MapConfigLoader = require('../services/MapConfigLoader');
const Realm = require('../models/realm');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

const mapConfig = MapConfigLoader;

/**
 * 获取境界等级
 */
async function getRealmRank(realmName) {
    const realm = await Realm.findOne({ where: { name: realmName } });
    return realm ? realm.rank : 0;
}

/**
 * 获取当前地图信息
 */
router.get('/info', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        let playerMapPos = await PlayerMapPosition.findOne({
            where: { player_id: player.id }
        });

        let mapId = player.current_map_id;

        if (!mapId) {
            const defaultMap = mapConfig.getDefaultMap();
            if (defaultMap) {
                mapId = defaultMap.id;
                player.current_map_id = mapId;
                await player.save();

                playerMapPos = await PlayerMapPosition.create({
                    player_id: player.id,
                    map_id: mapId
                });
            }
        }

        const mapConfigData = mapConfig.getMap(mapId);
        if (!mapConfigData) {
            const defaultMap = mapConfig.getDefaultMap();
            if (defaultMap) {
                player.current_map_id = defaultMap.id;
                await player.save();
                return res.json({ 
                    current_map: defaultMap, 
                    player_data: null,
                    connected_maps: [],
                    is_moving: false
                });
            }
            return res.status(404).json({ error: 'Map not found' });
        }

        const connectedMaps = mapConfig.getConnectedMaps(mapId);

        const responseData = {
            ...mapConfigData,
            player_data: playerMapPos ? {
                exploration_progress: playerMapPos.exploration_progress,
                visited_nodes: playerMapPos.visited_nodes,
                last_visit_time: playerMapPos.last_visit_time,
                resource_gather_count: playerMapPos.resource_gather_count,
                monster_defeat_count: playerMapPos.monster_defeat_count
            } : null
        };

        res.json({
            current_map: responseData,
            connected_maps: connectedMaps.map(m => ({
                id: m.id,
                name: m.name,
                type: m.type,
                environment: m.environment,
                requiredRealm: m.requiredRealm,
                danger_level: m.danger_level,
                description: m.description,
                travel_time: m.travel_time
            })),
            is_moving: player.is_moving || false
        });
    } catch (error) {
        console.error('Map Info Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 计算移动到目标地图的消耗
 */
function calculateTravelCost(targetMap, player, currentMap = null) {
    const baseCost = 10;
    const baseTime = 60;
    
    const typeMultiplier = {
        'country': 1,
        'sect': 1,
        'mountain': 1.5,
        'ocean': 2,
        'talent': 3,
        'world': 5
    };
    
    const terrainFactor = {
        'plains': 1,
        'mountain': 1.5,
        'ocean': 2,
        'cave': 1.8,
        'mixed': 1.2,
        'celestial': 1
    };
    
    const dangerLevel = targetMap.danger_level || 1;
    const travelTime = targetMap.travel_time || 5;
    const type = targetMap.type || 'country';
    const environment = targetMap.environment || 'plains';
    
    let distance = 0;
    let time = baseTime;
    
    if (currentMap && currentMap.x !== undefined && targetMap.x !== undefined) {
        distance = Math.sqrt(
            Math.pow(targetMap.x - currentMap.x, 2) + 
            Math.pow(targetMap.y - currentMap.y, 2)
        );
        const terrainMod = terrainFactor[environment] || 1;
        const playerSpeed = player.attributes?.speed || 10;
        time = Math.floor(baseTime + (distance * terrainMod * 10) / (playerSpeed / 10));
    } else {
        time = travelTime * 60;
    }
    
    let cost = baseCost;
    cost += Math.floor(distance / 10);
    cost += dangerLevel * 2;
    cost += travelTime / 2;
    cost *= typeMultiplier[type] || 1;
    
    return {
        cost: Math.floor(cost),
        time: time,
        distance: Math.floor(distance * 100) / 100
    };
}

/**
 * 开始移动到目标地图（延时模式）
 * 
 * 设置玩家为移动状态，扣除灵力，记录移动历史
 */
router.post('/start-move', auth, async (req, res) => {
    try {
        const { targetMapId } = req.body;
        if (!targetMapId) return res.status(400).json({ error: '目标地图ID不能为空' });

        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: '玩家不存在' });

        if (player.is_moving) {
            return res.status(400).json({ error: '您正在移动中，请等待到达目的地' });
        }

        const currentMapId = player.current_map_id;
        if (currentMapId == targetMapId) {
            return res.status(400).json({ error: '您已经在目标地图' });
        }

        const currentMapConfig = mapConfig.getMap(currentMapId);
        const targetMapConfig = mapConfig.getMap(targetMapId);

        if (!currentMapConfig || !targetMapConfig) {
            return res.status(404).json({ error: '地图配置不存在' });
        }

        const canEnter = mapConfig.canEnter(targetMapConfig, player.realm);
        if (!canEnter) {
            return res.status(403).json({ 
                error: `境界不足，需达到 ${targetMapConfig.requiredRealm} 才能进入` 
            });
        }

        const travelCostInfo = calculateTravelCost(targetMapConfig, player, currentMapConfig);
        
        if (player.mp_current < travelCostInfo.cost) {
            return res.status(400).json({ 
                error: `灵力不足，需要 ${travelCostInfo.cost} 点灵力` 
            });
        }

        const now = new Date();
        const endTime = new Date(now.getTime() + travelCostInfo.time * 1000);

        const t = await sequelize.transaction();
        try {
            player.mp_current = BigInt(player.mp_current) - BigInt(travelCostInfo.cost);
            player.is_moving = true;
            player.moving_from_map_id = currentMapId;
            player.moving_to_map_id = targetMapId;
            player.move_start_time = now;
            player.move_end_time = endTime;
            await player.save({ transaction: t });

            await PlayerMovement.create({
                player_id: player.id,
                from_map_id: currentMapId,
                from_map_name: currentMapConfig.name,
                to_map_id: targetMapId,
                to_map_name: targetMapConfig.name,
                distance: travelCostInfo.distance,
                mp_consumed: travelCostInfo.cost,
                duration_seconds: travelCostInfo.time,
                status: 'moving',
                started_at: now
            }, { transaction: t });

            await t.commit();

            res.json({
                code: 200,
                message: `开始移动，预计需要 ${formatTime(travelCostInfo.time)}`,
                data: {
                    from_map_id: currentMapId,
                    to_map_id: targetMapId,
                    from_map_name: currentMapConfig.name,
                    to_map_name: targetMapConfig.name,
                    start_time: now.toISOString(),
                    end_time: endTime.toISOString(),
                    total_seconds: travelCostInfo.time,
                    remaining_seconds: travelCostInfo.time
                }
            });
        } catch (e) {
            await t.rollback();
            throw e;
        }

    } catch (error) {
        console.error('Start Move Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 查询移动状态
 */
router.get('/move-status', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: '玩家不存在' });

        if (!player.is_moving) {
            return res.json({
                code: 200,
                is_moving: false
            });
        }

        const now = new Date();
        const endTime = new Date(player.move_end_time);
        const remainingMs = endTime - now;
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

        const fromMap = mapConfig.getMap(player.moving_from_map_id);
        const toMap = mapConfig.getMap(player.moving_to_map_id);

        res.json({
            code: 200,
            is_moving: true,
            from_map_id: player.moving_from_map_id,
            to_map_id: player.moving_to_map_id,
            from_map_name: fromMap?.name || '未知',
            to_map_name: toMap?.name || '未知',
            start_time: player.move_start_time,
            end_time: player.move_end_time,
            remaining_seconds: remainingSeconds,
            total_seconds: Math.ceil((endTime - new Date(player.move_start_time)) / 1000)
        });
    } catch (error) {
        console.error('Move Status Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 取消移动（可选功能）
 */
router.post('/cancel-move', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: '玩家不存在' });

        if (!player.is_moving) {
            return res.status(400).json({ error: '您当前没有在移动中' });
        }

        player.is_moving = false;
        player.moving_from_map_id = null;
        player.moving_to_map_id = null;
        player.move_start_time = null;
        player.move_end_time = null;
        await player.save();

        const movement = await PlayerMovement.findOne({
            where: { 
                player_id: player.id, 
                status: 'moving' 
            },
            order: [['createdAt', 'DESC']]
        });

        if (movement) {
            movement.status = 'cancelled';
            movement.completed_at = new Date();
            await movement.save();
        }

        res.json({
            code: 200,
            message: '移动已取消，已退回起点'
        });
    } catch (error) {
        console.error('Cancel Move Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 完成移动（供内部调用或定时任务）
 */
router.post('/complete-move-internal', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: '玩家不存在' });

        if (!player.is_moving) {
            return res.status(400).json({ error: '玩家不在移动中' });
        }

        const targetMapId = player.moving_to_map_id;
        const targetMapConfig = mapConfig.getMap(targetMapId);

        player.current_map_id = targetMapId;
        player.last_map_move_time = new Date();
        player.is_moving = false;
        player.moving_from_map_id = null;
        player.moving_to_map_id = null;
        player.move_start_time = null;
        player.move_end_time = null;
        await player.save();

        await PlayerMapPosition.upsert({
            player_id: player.id,
            map_id: targetMapId,
            last_visit_time: new Date()
        });

        const movement = await PlayerMovement.findOne({
            where: { 
                player_id: player.id, 
                status: 'moving' 
            },
            order: [['createdAt', 'DESC']]
        });

        if (movement) {
            movement.status = 'completed';
            movement.completed_at = new Date();
            await movement.save();
        }

        res.json({
            code: 200,
            message: `已到达 ${targetMapConfig?.name || '目标地图'}`,
            new_map: targetMapConfig,
            mp_current: player.mp_current.toString()
        });
    } catch (error) {
        console.error('Complete Move Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 辅助函数：格式化时间
 */
function formatTime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}分钟`;
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    if (hours < 24) return `${hours}小时${remainingMins}分钟`;
    const days = Math.floor(hours / 24);
    return `${days}天${hours % 24}小时`;
}

/**
 * 获取地图静态配置列表
 */
router.get('/config', async (req, res) => {
    try {
        const allMaps = mapConfig.getAllMaps();
        res.json({
            maps: allMaps.map(m => ({
                id: m.id,
                name: m.name,
                type: m.type,
                environment: m.environment,
                x: m.x,
                y: m.y,
                requiredRealm: m.requiredRealm,
                danger_level: m.danger_level,
                travel_time: m.travel_time,
                description: m.description,
                connections: m.connections
            }))
        });
    } catch (error) {
        console.error('Map Config Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 验证地图配置
 */
router.get('/validate', auth, async (req, res) => {
    try {
        const validation = mapConfig.validate();
        res.json(validation);
    } catch (error) {
        console.error('Map Validate Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
