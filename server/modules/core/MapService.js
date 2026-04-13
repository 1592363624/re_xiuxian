const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerMapPosition = require('../../models/playerMapPosition');
const PlayerMovement = require('../../models/playerMovement');
const RealmService = require('./RealmService');

/**
 * 地图服务模块
 * 处理地图、区域、资源分布等核心业务逻辑
 */
class MapService {
    constructor() {
        this.configLoader = null;
    }

    /**
     * 初始化地图服务
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 获取所有地图配置
     * @returns {Array} 地图配置列表
     */
    getAllMaps() {
        const config = this.configLoader?.getConfig('map_data');
        return config?.maps || [];
    }

    /**
     * 根据地图ID获取地图配置
     * @param {string} mapId - 地图ID
     * @returns {Object|null} 地图配置
     */
    getMapById(mapId) {
        const maps = this.getAllMaps();
        return maps.find(map => map.id === mapId) || null;
    }

    /**
     * 获取玩家当前可进入的地图列表
     * @param {Object} player - 玩家对象
     * @returns {Array} 可进入的地图列表
     */
    getAvailableMaps(player) {
        const maps = this.getAllMaps();
        const realm = player.realm || '凡人';
        
        return maps.filter(map => {
            const minRealm = map.minRealm || '凡人';
            return this.compareRealm(realm, minRealm) >= 0;
        });
    }

    /**
     * 比较境界等级
     * @param {string} realm1 - 境界1
     * @param {string} realm2 - 境界2
     * @returns {number} -1:小于, 0:等于, 1:大于
     */
    compareRealm(realm1, realm2) {
        const allRealms = this.getAllRealms();
        const rank1 = allRealms.find(r => r.name === realm1)?.rank || 0;
        const rank2 = allRealms.find(r => r.name === realm2)?.rank || 0;
        
        if (rank1 < rank2) return -1;
        if (rank1 > rank2) return 1;
        return 0;
    }

    /**
     * 获取所有境界
     * @returns {Array} 境界列表
     */
    getAllRealms() {
        const config = this.configLoader?.getConfig('realm_breakthrough');
        return config?.realms || [];
    }

    /**
     * 获取地图资源分布
     * @param {string} mapId - 地图ID
     * @returns {Array} 资源分布列表
     */
    getMapResources(mapId) {
        const map = this.getMapById(mapId);
        return map?.resources || [];
    }

    /**
     * 获取地图危险区域
     * @param {string} mapId - 地图ID
     * @returns {Array} 危险区域列表
     */
    getMapDangerZones(mapId) {
        const map = this.getMapById(mapId);
        return map?.dangerZones || [];
    }

    /**
     * 计算在地图中移动所需时间
     * @param {string} mapId - 地图ID
     * @param {number} distance - 距离
     * @param {number} speed - 速度
     * @returns {number} 所需时间(秒)
     */
    calculateTravelTime(mapId, distance, speed) {
        const map = this.getMapById(mapId);
        const terrainFactor = map?.terrainFactor || 1;
        return Math.ceil((distance * terrainFactor) / speed);
    }

    /**
     * 获取地图探索度
     * @param {string} mapId - 地图ID
     * @param {number} exploredAreas - 已探索区域数
     * @returns {number} 探索度百分比
     */
    getExplorationPercentage(mapId, exploredAreas) {
        const map = this.getMapById(mapId);
        const totalAreas = map?.totalAreas || 1;
        return Math.min(100, Math.floor((exploredAreas / totalAreas) * 100));
    }

    /**
     * 获取地图传送点
     * @param {string} mapId - 地图ID
     * @returns {Array} 传送点列表
     */
    getMapTeleports(mapId) {
        const map = this.getMapById(mapId);
        return map?.teleports || [];
    }

    /**
     * 计算移动到目标地图的消耗
     * @param {Object} targetMap 目标地图配置
     * @param {Object} player 玩家对象
     * @param {Object} currentMap 当前地图配置
     */
    calculateTravelCost(targetMap, player, currentMap = null) {
        const systemConfig = this.configLoader?.getConfig('system');
        const mapSysCfg = systemConfig?.map || {
            type_multiplier: { country: 1, sect: 1, mountain: 1.5, ocean: 2, talent: 3, world: 5 },
            terrain_factor: { plains: 1, mountain: 1.5, ocean: 2, cave: 1.8, mixed: 1.2, celestial: 1 }
        };

        const baseCost = 10;
        const baseTime = 60;
        
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
            const terrainMod = mapSysCfg.terrain_factor[environment] || 1;
            const playerSpeed = player.attributes?.speed || 10;
            time = Math.floor(baseTime + (distance * terrainMod * 10) / (playerSpeed / 10));
        } else {
            time = travelTime * 60;
        }
        
        let cost = baseCost;
        cost += Math.floor(distance / 10);
        cost += dangerLevel * 2;
        cost += travelTime / 2;
        cost *= mapSysCfg.type_multiplier[type] || 1;
        
        return {
            cost: Math.floor(cost),
            time: time,
            distance: Math.floor(distance * 100) / 100
        };
    }

    /**
     * 获取地图信息
     * @param {string} playerId 玩家ID
     */
    async getMapInfo(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) throw new Error('玩家不存在');

        let playerMapPos = await PlayerMapPosition.findOne({
            where: { player_id: player.id }
        });

        let mapId = player.current_map_id;

        if (!mapId) {
            const defaultMap = this.getAllMaps().find(m => m.id === 'mortal_village_1') || this.getAllMaps()[0];
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

        const mapConfigData = this.getMapById(mapId);
        if (!mapConfigData) {
            const defaultMap = this.getAllMaps().find(m => m.id === 'mortal_village_1') || this.getAllMaps()[0];
            if (defaultMap) {
                player.current_map_id = defaultMap.id;
                await player.save();
                return { 
                    current_map: defaultMap, 
                    player_data: null,
                    connected_maps: [],
                    is_moving: false
                };
            }
            throw new Error('Map not found');
        }

        // 处理连接的地图
        const connectedMapIds = mapConfigData.connections || [];
        const connectedMaps = this.getAllMaps().filter(m => connectedMapIds.includes(m.id));

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

        return {
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
        };
    }

    /**
     * 开始移动
     * @param {string} playerId 玩家ID
     * @param {string} targetMapId 目标地图ID
     */
    async startMove(playerId, targetMapId) {
        const player = await Player.findByPk(playerId);
        if (!player) throw new Error('玩家不存在');

        if (player.is_moving) {
            throw new Error('您正在移动中，请等待到达目的地');
        }

        const currentMapId = player.current_map_id;
        if (currentMapId == targetMapId) {
            throw new Error('您已经在目标地图');
        }

        const currentMapConfig = this.getMapById(currentMapId);
        const targetMapConfig = this.getMapById(targetMapId);

        if (!currentMapConfig || !targetMapConfig) {
            throw new Error('地图配置不存在');
        }

        const playerRealmRank = RealmService.getRealmByName(player.realm)?.rank || 0;
        const requiredRealmRank = RealmService.getRealmByName(targetMapConfig.requiredRealm || '凡人')?.rank || 0;

        if (playerRealmRank < requiredRealmRank) {
            throw new Error(`境界不足，需达到 ${targetMapConfig.requiredRealm} 才能进入`);
        }

        const travelCostInfo = this.calculateTravelCost(targetMapConfig, player, currentMapConfig);
        
        if (player.mp_current < travelCostInfo.cost) {
            throw new Error(`灵力不足，需要 ${travelCostInfo.cost} 点灵力`);
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

            return {
                travelCostInfo,
                currentMapConfig,
                targetMapConfig,
                now,
                endTime
            };
        } catch (e) {
            await t.rollback();
            throw e;
        }
    }

    /**
     * 取消移动
     * @param {string} playerId 玩家ID
     */
    async cancelMove(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) throw new Error('玩家不存在');

        if (!player.is_moving) {
            throw new Error('您当前没有在移动中');
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

        return true;
    }

    /**
     * 完成移动
     * @param {string} playerId 玩家ID
     */
    async completeMove(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) throw new Error('玩家不存在');

        if (!player.is_moving) {
            throw new Error('玩家不在移动中');
        }

        const targetMapId = player.moving_to_map_id;
        const targetMapConfig = this.getMapById(targetMapId);

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

        return {
            targetMapConfig,
            player
        };
    }

    /**
     * 检查地图是否安全
     * @param {string} mapId - 地图ID
     * @param {Object} player - 玩家对象
     * @returns {Object} 安全状态
     */
    checkMapSafety(mapId, player) {
        const map = this.getMapById(mapId);
        if (!map) {
            return { safe: false, reason: '地图不存在' };
        }

        const realm = player.realm || '凡人';
        const minRealm = map.minRealm || '凡人';
        
        if (this.compareRealm(realm, minRealm) < 0) {
            return { 
                safe: false, 
                reason: `需要至少 ${minRealm} 境界才能进入此地图` 
            };
        }

        return { safe: true, dangerLevel: map.dangerLevel || 'safe' };
    }

    /**
     * 获取地图事件
     * @param {string} mapId - 地图ID
     * @returns {Array} 地图事件列表
     */
    getMapEvents(mapId) {
        const map = this.getMapById(mapId);
        return map?.events || [];
    }

    /**
     * 计算资源采集效率
     * @param {string} resourceType - 资源类型
     * @param {Object} player - 玩家对象
     * @returns {number} 采集效率 (0-100)
     */
    calculateGatheringEfficiency(resourceType, player) {
        const attributes = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});
        
        const wisdom = attributes.wisdom || 10;
        const sense = attributes.sense_bonus || 0;
        
        const baseEfficiency = 50;
        const wisdomBonus = wisdom * 2;
        const senseBonus = sense * 1.5;
        
        return Math.min(100, Math.floor(baseEfficiency + wisdomBonus + senseBonus));
    }
}

module.exports = new MapService();
