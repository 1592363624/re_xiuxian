/**
 * 地图服务
 * 核心逻辑层 - 处理地图移动相关的核心算法
 *
 * 抽取自 routes/map.js，将业务算法（移动消耗计算、时间格式化）下沉到 Service 层
 * 路由层只负责参数校验、事务编排和响应
 */
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

class MapService {
    /**
     * 计算移动到目标地图的消耗
     * 算法参数从 game_balance 配置读取，避免硬编码
     * @param {Object} targetMap - 目标地图配置
     * @param {Object} player - 玩家对象
     * @param {Object|null} currentMap - 当前地图配置（可选）
     * @returns {Object} { cost, time, distance }
     */
    static calculateTravelCost(targetMap, player, currentMap = null) {
        const gameBalance = configLoader.getConfig('game_balance') || {};
        const travelConfig = gameBalance.map?.travel || {};
        const typeMultiplier = gameBalance.map?.type_multiplier || {};
        const terrainFactor = gameBalance.map?.terrain_factor || {};

        const baseCost = travelConfig.base_cost ?? 10;
        const baseTime = travelConfig.base_time ?? 60;
        const distanceDivisor = travelConfig.distance_divisor ?? 10;
        const dangerLevelMultiplier = travelConfig.danger_level_multiplier ?? 2;
        const travelTimeDivisor = travelConfig.travel_time_divisor ?? 2;
        const speedDivisor = travelConfig.speed_divisor ?? 10;
        const terrainMultiplier = travelConfig.terrain_multiplier ?? 10;

        const dangerLevel = targetMap.danger_level ?? 1;
        const travelTime = targetMap.travel_time ?? 5;
        const type = targetMap.type || 'country';
        const environment = targetMap.environment || 'plains';

        let distance = 0;
        let time = baseTime;

        if (currentMap && currentMap.x !== undefined && targetMap.x !== undefined) {
            distance = Math.sqrt(
                Math.pow(targetMap.x - currentMap.x, 2) +
                Math.pow(targetMap.y - currentMap.y, 2)
            );
            const terrainMod = terrainFactor[environment] ?? 1;
            const playerSpeed = player.attributes?.speed ?? 10;
            time = Math.floor(baseTime + (distance * terrainMod * terrainMultiplier) / (playerSpeed / speedDivisor));
        } else {
            time = travelTime * baseTime;
        }

        let cost = baseCost;
        cost += Math.floor(distance / distanceDivisor);
        cost += dangerLevel * dangerLevelMultiplier;
        cost += travelTime / travelTimeDivisor;
        cost *= typeMultiplier[type] ?? 1;

        return {
            cost: Math.floor(cost),
            time: time,
            distance: Math.floor(distance * 100) / 100
        };
    }

    /**
     * 格式化时间（秒转人类可读字符串）
     * @param {number} seconds - 秒数
     * @returns {string} 格式化后的时间字符串
     */
    static formatTime(seconds) {
        if (seconds < 60) return `${seconds}秒`;
        const mins = Math.floor(seconds / 60);
        if (mins < 60) return `${mins}分钟`;
        const hours = Math.floor(mins / 60);
        const remainingMins = mins % 60;
        if (hours < 24) return `${hours}小时${remainingMins}分钟`;
        const days = Math.floor(hours / 24);
        return `${days}天${hours % 24}小时`;
    }
}

module.exports = MapService;
