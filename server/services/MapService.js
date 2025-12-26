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
     * 处理环境灵力消耗
     * @param {number} elapsedSeconds 经过的秒数
     */
    static async processEnvironmentConsumption(elapsedSeconds) {
        // 转换为小时，至少消耗一点点? 不，按比例
        const hours = elapsedSeconds / 3600;
        if (hours <= 0) return;

        const t = await sequelize.transaction();
        try {
            // 1. 扣除灵力 (仅针对在有环境消耗地图的玩家)
            // 使用原生 SQL 以支持 JOIN 更新，提高效率
            // 注意：MySQL 中 BigInt 运算可能会导致溢出或错误，这里假设 mp_current 足够大
            await sequelize.query(
                `UPDATE players p 
                 INNER JOIN maps m ON p.current_map_id = m.id 
                 SET p.mp_current = p.mp_current - (m.environment_cost * :hours)
                 WHERE m.environment_cost > 0`,
                {
                    replacements: { hours: hours },
                    type: sequelize.QueryTypes.UPDATE,
                    transaction: t
                }
            );

            // 2. 处理灵力耗尽的玩家 (强制传送 + 扣除修为)
            // 查找所有在危险地图且灵力 <= 0 的玩家
            const exhaustedPlayers = await sequelize.query(
                `SELECT p.id, p.exp, p.nickname, m.name as mapName 
                 FROM players p 
                 JOIN maps m ON p.current_map_id = m.id 
                 WHERE p.mp_current <= 0 AND m.environment_cost > 0`,
                {
                    type: sequelize.QueryTypes.SELECT,
                    transaction: t
                }
            );

            if (exhaustedPlayers.length > 0) {
                console.log(`[MapService] 发现 ${exhaustedPlayers.length} 名玩家在危险区域灵力耗尽。`);
                
                // 获取安全地图 (新手村)
                const safeMap = await Map.findOne({ 
                    where: { type: 'NOVICE' }, 
                    order: [['id', 'ASC']], 
                    transaction: t 
                });
                const safeMapId = safeMap ? safeMap.id : 1;

                for (const p of exhaustedPlayers) {
                    const currentExp = BigInt(p.exp);
                    // 扣除 5% 修为
                    const penaltyExp = currentExp * 5n / 100n;
                    const newExp = currentExp - penaltyExp;

                    await Player.update({
                        current_map_id: safeMapId,
                        exp: newExp, // Sequelize 会处理 BigInt
                        mp_current: 0 // 重置为 0
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
