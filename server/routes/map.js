/**
 * 地图系统路由
 * 
 * 静态配置从 map_data.json 读取，动态数据从数据库读取
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const PlayerMapPosition = require('../models/playerMapPosition');
const MapConfigLoader = require('../services/MapConfigLoader');
const Realm = require('../models/realm');
const auth = require('../middleware/auth');

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
 * 
 * 合并静态配置和玩家动态数据返回
 */
router.get('/info', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        // 获取或创建玩家地图位置记录
        let playerMapPos = await PlayerMapPosition.findOne({
            where: { player_id: player.id }
        });

        let mapId = player.current_map_id;

        // 如果玩家没有地图信息，初始化为默认地图
        if (!mapId) {
            const defaultMap = mapConfig.getDefaultMap();
            if (defaultMap) {
                mapId = defaultMap.id;
                player.current_map_id = mapId;
                await player.save();

                // 创建位置记录
                playerMapPos = await PlayerMapPosition.create({
                    player_id: player.id,
                    map_id: mapId
                });
            }
        }

        // 获取静态地图配置
        const mapConfigData = mapConfig.getMap(mapId);
        if (!mapConfigData) {
            // 地图配置不存在，重置到默认地图
            const defaultMap = mapConfig.getDefaultMap();
            if (defaultMap) {
                player.current_map_id = defaultMap.id;
                await player.save();
                return res.json({ 
                    current_map: defaultMap, 
                    player_data: null,
                    connected_maps: [] 
                });
            }
            return res.status(404).json({ error: 'Map not found' });
        }

        // 获取连接地图的静态配置
        const connectedMaps = mapConfig.getConnectedMaps(mapId);

        // 构建返回数据
        const responseData = {
            ...mapConfigData,
            // 动态数据（如果有）
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
                required_realm: m.required_realm,
                danger_level: m.danger_level,
                description: m.description,
                travel_time: m.travel_time
            }))
        });
    } catch (error) {
        console.error('Map Info Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 移动到目标地图
 * 
 * 验证境界要求，消耗灵力，更新玩家位置
 */
router.post('/move', auth, async (req, res) => {
    try {
        const { targetMapId } = req.body;
        if (!targetMapId) return res.status(400).json({ error: 'Target map ID required' });

        const player = await Player.findByPk(req.user.id);
        const currentMapId = player.current_map_id;

        // 获取静态配置
        const currentMapConfig = mapConfig.getMap(currentMapId);
        const targetMapConfig = mapConfig.getMap(targetMapId);

        if (!currentMapConfig || !targetMapConfig) {
            return res.status(404).json({ error: 'Map not found' });
        }

        // 检查连通性
        if (!mapConfig.isConnected(currentMapId, targetMapId)) {
            return res.status(400).json({ error: '目标地图未连接' });
        }

        // 检查境界要求
        const canEnter = mapConfig.canEnter(targetMapConfig, player.realm);
        if (!canEnter) {
            return res.status(403).json({ 
                error: `境界不足，需达到 ${targetMapConfig.required_realm} 才能进入` 
            });
        }

        // 计算移动消耗
        const travelCost = calculateTravelCost(targetMapConfig);
        if (player.mp_current < travelCost) {
            return res.status(400).json({ 
                error: `灵力不足，需要 ${travelCost} 点灵力` 
            });
        }

        // 扣除消耗并更新位置
        player.mp_current = BigInt(player.mp_current) - BigInt(travelCost);
        player.current_map_id = targetMapId;
        player.last_map_move_time = new Date();
        await player.save();

        // 更新玩家地图位置记录
        await PlayerMapPosition.upsert({
            player_id: player.id,
            map_id: targetMapId,
            last_visit_time: new Date()
        });

        res.json({ 
            message: `移动成功，消耗 ${travelCost} 点灵力`, 
            new_map: targetMapConfig,
            mp_current: player.mp_current.toString()
        });

    } catch (error) {
        console.error('Map Move Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 计算移动消耗
 */
function calculateTravelCost(targetMap) {
    const baseCost = 10;
    const typeMultiplier = {
        'country': 1,
        'sect': 1,
        'mountain': 1.5,
        'ocean': 2,
        'talent': 3,
        'world': 5
    };
    
    const dangerLevel = targetMap.danger_level || 1;
    const travelTime = targetMap.travel_time || 5;
    const type = targetMap.type || 'country';
    
    let cost = baseCost;
    cost += dangerLevel * 2;  // 危险等级加成
    cost += travelTime / 2;   // 移动时间加成
    cost *= typeMultiplier[type] || 1;  // 类型加成
    
    return Math.floor(cost);
}

/**
 * 更新地图探索进度
 */
router.post('/explore', auth, async (req, res) => {
    try {
        const { nodeId, progress } = req.body;
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        const playerMapPos = await PlayerMapPosition.findOne({
            where: { player_id: player.id }
        });

        if (!playerMapPos) {
            return res.status(400).json({ error: '未找到地图位置记录' });
        }

        // 更新探索进度
        if (progress !== undefined) {
            playerMapPos.exploration_progress = Math.min(100, Math.max(0, progress));
        }

        // 记录已访问节点
        if (nodeId && !playerMapPos.visited_nodes.includes(nodeId)) {
            playerMapPos.visited_nodes.push(nodeId);
        }

        playerMapPos.last_visit_time = new Date();
        await playerMapPos.save();

        res.json({
            message: '探索进度已更新',
            player_data: {
                exploration_progress: playerMapPos.exploration_progress,
                visited_nodes: playerMapPos.visited_nodes
            }
        });
    } catch (error) {
        console.error('Map Explore Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 获取地图静态配置列表
 * 无需认证，用于前端预加载
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
                required_realm: m.required_realm,
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
 * GM 或开发调试用
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
