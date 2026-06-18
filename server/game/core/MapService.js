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
