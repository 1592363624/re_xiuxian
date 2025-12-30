/**
 * 地图配置加载器
 * 
 * 从 map_data.json 加载静态地图配置，提供只读查询接口
 * 采用单例模式，加载后缓存在内存中
 */
const path = require('path');
const fs = require('fs');

class MapConfigLoader {
    constructor() {
        this.configPath = path.join(__dirname, '../config/map_data.json');
        this.mapsCache = null;
        this.idToMap = new Map();
        this.initialized = false;
    }

    /**
     * 初始化加载配置
     */
    load() {
        if (this.initialized) {
            return;
        }

        if (!fs.existsSync(this.configPath)) {
            throw new Error(`地图配置文件不存在: ${this.configPath}`);
        }

        const content = fs.readFileSync(this.configPath, 'utf-8');
        const config = JSON.parse(content);

        if (!config.maps || !Array.isArray(config.maps)) {
            throw new Error('地图配置格式错误: maps 必须是数组');
        }

        this.mapsCache = config.maps;
        
        // 构建 ID 到地图的索引
        for (const map of this.mapsCache) {
            this.idToMap.set(map.id, map);
        }

        this.initialized = true;
        console.log(`[MapConfigLoader] 已加载 ${this.mapsCache.length} 个地图配置`);
    }

    /**
     * 获取所有地图配置
     * @returns {Array} 地图配置数组
     */
    getAllMaps() {
        this.load();
        return this.mapsCache;
    }

    /**
     * 根据 ID 获取地图配置
     * @param {number} mapId 地图ID
     * @returns {Object|null} 地图配置，不存在则返回 null
     */
    getMap(mapId) {
        this.load();
        return this.idToMap.get(parseInt(mapId)) || null;
    }

    /**
     * 获取地图连接关系
     * @param {number} mapId 地图ID
     * @returns {Array} 连接的地图ID数组
     */
    getConnections(mapId) {
        const map = this.getMap(mapId);
        return map ? (map.connections || []) : [];
    }

    /**
     * 获取指定地图的所有连接地图配置
     * @param {number} mapId 地图ID
     * @returns {Array} 连接地图的配置数组
     */
    getConnectedMaps(mapId) {
        const connections = this.getConnections(mapId);
        return connections.map(id => this.getMap(id)).filter(Boolean);
    }

    /**
     * 检查两个地图是否连接
     * @param {number} mapId1 地图1 ID
     * @param {number} mapId2 地图2 ID
     * @returns {boolean} 是否连接
     */
    isConnected(mapId1, mapId2) {
        const connections = this.getConnections(mapId1);
        return connections.includes(parseInt(mapId2));
    }

    /**
     * 根据类型获取所有地图
     * @param {string} type 地图类型 (country, sect, mountain, ocean, talent, world)
     * @returns {Array} 该类型的地图配置数组
     */
    getMapsByType(type) {
        this.load();
        return this.mapsCache.filter(map => map.type === type);
    }

    /**
     * 获取默认地图（用于新玩家出生点）
     * @returns {Object} 默认地图配置
     */
    getDefaultMap() {
        const countryMaps = this.getMapsByType('country');
        return countryMaps.length > 0 ? countryMaps[0] : this.mapsCache[0];
    }

    /**
     * 获取指定境界可进入的地图
     * @param {string} realm 玩家境界名称
     * @returns {Array} 可进入的地图配置数组
     */
    getAccessibleMaps(realm) {
        this.load();
        // TODO: 需要结合 realm 配置判断境界等级
        // 暂时返回所有地图，由前端/后端进一步判断
        return this.mapsCache.filter(map => {
            return this.canEnter(map, realm);
        });
    }

    /**
     * 检查玩家是否能进入指定地图
     * @param {Object} map 地图配置
     * @param {string} playerRealm 玩家境界名称
     * @returns {boolean} 能否进入
     */
    canEnter(map, playerRealm) {
        const requiredRealm = map.requiredRealm || '凡人';
        // 境界判断逻辑，后续结合 Realm 配置完善
        const realmOrder = [
            '凡人', '炼气1层', '炼气2层', '炼气3层', '炼气4层', '炼气5层',
            '炼气6层', '炼气7层', '炼气8层', '炼气9层', '炼气10层',
            '炼气11层', '炼气12层', '炼气13层', '炼气圆满',
            '筑基期', '筑基初期', '筑基中期', '筑基后期', '筑基圆满',
            '金丹期', '金丹初期', '金丹中期', '金丹后期', '金丹圆满',
            '元婴期', '元婴初期', '元婴中期', '元婴后期', '元婴圆满',
            '化神期', '炼虚期', '合体期', '大乘期', '渡劫期', '真仙'
        ];
        
        const requiredIdx = realmOrder.indexOf(requiredRealm);
        const playerIdx = realmOrder.indexOf(playerRealm);
        
        return playerIdx >= requiredIdx;
    }

    /**
     * 获取地图资源列表
     * @param {number} mapId 地图ID
     * @returns {Array} 资源配置数组
     */
    getResources(mapId) {
        const map = this.getMap(mapId);
        return map ? (map.resources || []) : [];
    }

    /**
     * 获取地图怪物列表
     * @param {number} mapId 地图ID
     * @returns {Array} 怪物配置数组
     */
    getMonsters(mapId) {
        const map = this.getMap(mapId);
        return map ? (map.monsters || []) : [];
    }

    /**
     * 获取地图 NPC 列表
     * @param {number} mapId 地图ID
     * @returns {Array} NPC 配置数组
     */
    getNpcs(mapId) {
        const map = this.getMap(mapId);
        return map ? (map.npcs || []) : [];
    }

    /**
     * 验证配置完整性
     * @returns {Object} 验证结果 { valid: boolean, errors: string[] }
     */
    validate() {
        this.load();
        const errors = [];
        
        for (const map of this.mapsCache) {
            if (!map.id) errors.push(`地图缺少 ID`);
            if (!map.name) errors.push(`地图 ID=${map.id} 缺少名称`);
            if (!map.type) errors.push(`地图 ID=${map.id} 缺少类型`);
            if (!map.description) errors.push(`地图 ID=${map.id} 缺少描述`);
            
            // 验证连接关系
            if (map.connections) {
                for (const connId of map.connections) {
                    if (!this.getMap(connId)) {
                        errors.push(`地图 ID=${map.id} 引用了不存在的连接地图 ID=${connId}`);
                    }
                }
            }
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
}

// 导出单例
const mapConfigLoader = new MapConfigLoader();
module.exports = mapConfigLoader;
