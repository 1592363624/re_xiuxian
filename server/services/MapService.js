/**
 * 地图服务
 * 处理地图相关的后台逻辑，如环境消耗、强制传送等
 */
const sequelize = require('../config/database');
const Player = require('../models/player');
const Map = require('../models/map');
const { Op } = require('sequelize');

class MapService {
    /**
     * 计算移动消耗
     * @param {number} distance 距离
     * @param {number} dangerLevel 目标地图危险等级
     * @param {number} travelTime 移动时间(分钟)
     * @param {string} mapType 地图类型
     * @param {number} playerSpeed 玩家速度
     * @returns {Object} { cost: 灵力消耗, time: 预计时间(秒) }
     */
    static calculateTravelCost(distance, dangerLevel, travelTime, mapType = 'country', playerSpeed = 10) {
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
        
        let cost = baseCost;
        cost += Math.floor(distance / 10);
        cost += dangerLevel * 2;
        cost += travelTime / 2;
        cost *= typeMultiplier[mapType] || 1;
        
        const terrainMod = terrainFactor[mapType] || 1;
        const time = Math.floor(baseTime + (distance * terrainMod * 10) / (playerSpeed / 10));
        
        return {
            cost: Math.floor(cost),
            time: time
        };
    }

    /**
     * 处理环境灵力消耗 (备用方法，现主要用calculateTravelCost)
     * @param {number} elapsedSeconds 经过的秒数
     */
    static async processEnvironmentConsumption(elapsedSeconds) {
        const hours = elapsedSeconds / 3600;
        if (hours <= 0) return;

        const t = await sequelize.transaction();
        try {
            await sequelize.query(
                `UPDATE players p 
                 INNER JOIN maps m ON p.current_map_id = m.id 
                 SET p.mp_current = p.mp_current - (m.danger_level * :hours)
                 WHERE m.danger_level > 3`,
                {
                    replacements: { hours: hours },
                    type: sequelize.QueryTypes.UPDATE,
                    transaction: t
                }
            );

            const exhaustedPlayers = await sequelize.query(
                `SELECT p.id, p.exp, p.nickname, m.name as mapName 
                 FROM players p 
                 JOIN maps m ON p.current_map_id = m.id 
                 WHERE p.mp_current <= 0 AND m.danger_level > 3`,
                {
                    type: sequelize.QueryTypes.SELECT,
                    transaction: t
                }
            );

            if (exhaustedPlayers.length > 0) {
                console.log(`[MapService] 发现 ${exhaustedPlayers.length} 名玩家在危险区域灵力耗尽。`);
                
                const safeMap = await Map.findOne({ 
                    where: { type: 'country' }, 
                    order: [['id', 'ASC']], 
                    transaction: t 
                });
                const safeMapId = safeMap ? safeMap.id : 1;

                for (const p of exhaustedPlayers) {
                    const currentExp = BigInt(p.exp);
                    const penaltyExp = currentExp * 5n / 100n;
                    const newExp = currentExp - penaltyExp;

                    await Player.update({
                        current_map_id: safeMapId,
                        exp: newExp,
                        mp_current: 0
                    }, {
                        where: { id: p.id },
                        transaction: t
                    });
                    
                    console.log(`[MapService] 玩家 ${p.nickname} (ID: ${p.id}) 被强制传送回安全区。扣除修为: ${penaltyExp}`);
                }
            }

            await t.commit();
        } catch (error) {
            try { await t.rollback(); } catch (e) {}
            console.error('[MapService] 环境消耗处理失败:', error);
        }
    }
}

module.exports = MapService;
