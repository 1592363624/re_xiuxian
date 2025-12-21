/**
 * 地图系统路由
 */
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const Player = require('../models/player');
const Map = require('../models/map');
const Realm = require('../models/realm');
const auth = require('../middleware/auth');

// Helper to get realm rank
async function getPlayerRealmRank(realmName) {
    const realm = await Realm.findOne({ where: { name: realmName } });
    return realm ? realm.rank : 0;
}

// 获取当前地图信息
router.get('/info', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        let mapId = player.current_map_id;
        
        // 如果玩家没有地图信息，初始化为新手村 (假设ID为1或者type为NOVICE的第一个)
        if (!mapId) {
            const defaultMap = await Map.findOne({ 
                where: { type: 'NOVICE' },
                order: [['id', 'ASC']] 
            });
            
            if (defaultMap) {
                mapId = defaultMap.id;
                player.current_map_id = mapId;
                await player.save();
            } else {
                return res.status(500).json({ error: 'No maps defined' });
            }
        }

        const map = await Map.findByPk(mapId);
        if (!map) {
             // 可能是地图被删了，重置回新手村
             const defaultMap = await Map.findOne({ where: { type: 'NOVICE' } });
             if (defaultMap) {
                 player.current_map_id = defaultMap.id;
                 await player.save();
                 return res.json({ current_map: defaultMap, connected_maps: [] });
             }
             return res.status(404).json({ error: 'Map not found' });
        }

        // 获取连接的地图信息
        let connectedMaps = [];
        if (map.connections && map.connections.length > 0) {
            connectedMaps = await Map.findAll({
                where: {
                    id: { [Op.in]: map.connections }
                },
                attributes: ['id', 'name', 'type', 'min_realm_rank', 'safety_level', 'description']
            });
        }

        res.json({
            current_map: map,
            connected_maps: connectedMaps
        });
    } catch (error) {
        console.error('Map Info Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 移动到目标地图
router.post('/move', auth, async (req, res) => {
    try {
        const { targetMapId } = req.body;
        if (!targetMapId) return res.status(400).json({ error: 'Target map ID required' });

        const player = await Player.findByPk(req.user.id);
        const currentMap = await Map.findByPk(player.current_map_id);
        const targetMap = await Map.findByPk(targetMapId);

        if (!currentMap || !targetMap) return res.status(404).json({ error: 'Map not found' });

        // 检查连通性
        if (!currentMap.connections.includes(Number(targetMapId))) {
             return res.status(400).json({ error: '目标地图未连接' });
        }

        // 检查境界要求
        const playerRank = await getPlayerRealmRank(player.realm);
        if (playerRank < targetMap.min_realm_rank) {
            return res.status(403).json({ error: `境界不足，需达到 ${targetMap.min_realm_rank} 级境界` });
        }

        // 计算消耗
        let cost = 10; // 同层级
        if (currentMap.type !== targetMap.type) {
            cost = 50; // 跨层级
        }

        if (player.mp_current < cost) {
            return res.status(400).json({ error: `灵力不足，需要 ${cost} 点灵力` });
        }

        // 扣除消耗并移动
        player.mp_current = BigInt(player.mp_current) - BigInt(cost);
        player.current_map_id = targetMap.id;
        player.last_map_move_time = new Date();
        await player.save();

        res.json({ 
            message: `移动成功，消耗 ${cost} 点灵力`, 
            new_map: targetMap,
            mp_current: player.mp_current.toString()
        });

    } catch (error) {
        console.error('Map Move Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
