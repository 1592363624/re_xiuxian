/**
 * 寿命管理服务
 * 负责处理玩家寿命增长、死亡判定及后续逻辑
 */
const Player = require('../models/player');
const Realm = require('../models/realm');
const { Op } = require('sequelize');

class LifespanService {
    // 24小时(86400秒) = 1年
    static SECONDS_PER_YEAR = 86400;

    /**
     * 批量更新玩家寿命
     * @param {number} elapsedSeconds 距离上次更新经过的秒数
     */
    static async updateLifespan(elapsedSeconds) {
        const sequelize = require('../config/database');
        const t = await sequelize.transaction();

        try {
            const yearsToAdd = elapsedSeconds / this.SECONDS_PER_YEAR;
            console.log(`[Lifespan] Updating lifespan for all players. Elapsed: ${elapsedSeconds}s, Adding: ${yearsToAdd.toFixed(6)} years`);

            // 1. 批量更新所有玩家的 lifespan_current
            await sequelize.query(
                `UPDATE players SET lifespan_current = lifespan_current + :years`,
                {
                    replacements: { years: yearsToAdd },
                    type: sequelize.QueryTypes.UPDATE,
                    transaction: t
                }
            );

            // 2. 检测死亡 (lifespan_current >= lifespan_max)
            const deadPlayers = await Player.findAll({
                where: {
                    lifespan_current: {
                        [Op.gte]: sequelize.col('lifespan_max')
                    }
                },
                transaction: t
            });

            console.log(`[Lifespan] Dead check complete. Found: ${deadPlayers.length}`);

            if (deadPlayers.length > 0) {
                console.log(`[Lifespan] Found ${deadPlayers.length} players reached lifespan limit.`);
                for (const player of deadPlayers) {
                    await this.handleDeath(player, t);
                }
            }

            await t.commit();

            return {
                yearsAdded: yearsToAdd,
                deadCount: deadPlayers.length,
                deadPlayers: deadPlayers.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    realm: p.realm, // New realm
                    oldRealm: p._previousRealm // We need to store this if we want to show it, but for now just returning the player object is enough as it has the new state
                }))
            };

        } catch (error) {
            try {
                await t.rollback();
            } catch (rollbackError) {
                // Ignore rollback error if transaction is already finished
                if (!rollbackError.message.includes('finished')) {
                    console.error('[Lifespan] Rollback failed:', rollbackError);
                }
            }
            console.error('[Lifespan] Update failed:', error);
        }
    }

    /**
     * 处理玩家死亡逻辑
     * @param {Player} player 
     * @param {Transaction} transaction
     */
    static async handleDeath(player, transaction) {
        console.log(`[Death] Processing death for player ${player.nickname} (ID: ${player.id})`);
        
        try {
            // 1. 掉落一个大境界
            const currentRealmName = player.realm;
            const newRealm = await this.calculateDropRealm(currentRealmName);
            
            let logMessage = `寿元耗尽，身死道消！`;
            
            if (newRealm) {
                player.realm = newRealm.name;
                player.exp = 0; // 修为清空
                logMessage += ` 境界跌落至 ${newRealm.name}。`;
            } else {
                player.realm = '凡人';
                player.exp = 0;
                logMessage += ` 重新堕入凡尘。`;
            }

            // 2. 寿命重置 (重生)
            const realmData = await Realm.findByPk(player.realm, { transaction });
            player.lifespan_max = realmData ? realmData.base_lifespan : 60;
            player.lifespan_current = 16; // 重生为 16 岁少年

            logMessage += ` 随身宝物散落天地。`;

            // 4. 保存更改
            await player.save({ transaction });

            console.log(`[Death] ${player.nickname}: ${logMessage}`);

        } catch (error) {
            console.error(`[Death] Error processing death for player ${player.id}:`, error);
            // 抛出错误以触发回滚
            throw error;
        }
    }

    /**
     * 计算跌落后的境界
     * @param {string} currentRealmName 
     */
    static async calculateDropRealm(currentRealmName) {
        // 获取当前境界
        const currentRealm = await Realm.findByPk(currentRealmName);
        if (!currentRealm) return null;

        // 简单逻辑：Rank - 10 (假设每个大境界约 10-14 层)
        // 或者查找上一个大境界的初期
        // 凡人(1) -> 炼气(2-14) -> 筑基(15-18) -> 结丹(19-22) -> 元婴(23-26)
        
        // 查找比当前 Rank 小的最近的一个 "初期" 或 "第1层"
        // 这里简化为：Rank 减去一定值，或者直接降级为 "凡人" 如果是炼气期
        
        let targetRank = currentRealm.rank - 1;
        if (targetRank < 1) targetRank = 1;

        // 如果在炼气期 (Rank 2-14)，死后变凡人 (Rank 1)
        if (currentRealm.rank <= 14 && currentRealm.rank > 1) {
            return await Realm.findOne({ where: { rank: 1 } });
        }
        
        // 如果是筑基 (15-18)，死后变炼气1层? 或者掉大境界
        // 规则：直接跌落一个大境界。
        // 筑基 -> 炼气 (找炼气最高层? 或炼气1层?) -> 暂定炼气13层(Rank 14)
        // 结丹 -> 筑基大圆满 (Rank 18)
        
        // 更加通用的逻辑：找到当前境界的前一个大境界的最高层
        // 实际上表里没有明确 "大境界" 字段，只能靠名字解析或硬编码 Rank 区间
        // 简化策略：Rank - 4 (通常一个大境界4个小境界)，但炼气期特殊
        
        // 临时逻辑：Rank - 1 (掉一个小境界) 
        // 用户要求：掉一个 *大* 境界。
        
        // 筑基(15) -> 炼气
        if (currentRealm.rank >= 15 && currentRealm.rank < 19) return await Realm.findOne({ where: { name: '炼气期13层' } });
        // 结丹(19) -> 筑基
        if (currentRealm.rank >= 19 && currentRealm.rank < 23) return await Realm.findOne({ where: { name: '筑基大圆满' } });
        // 元婴(23) -> 结丹
        if (currentRealm.rank >= 23 && currentRealm.rank < 27) return await Realm.findOne({ where: { name: '结丹大圆满' } });
        // 化神(27) -> 元婴
        if (currentRealm.rank >= 27 && currentRealm.rank < 31) return await Realm.findOne({ where: { name: '元婴大圆满' } });
        
        // 默认：掉一级
        return await Realm.findOne({ where: { rank: targetRank } });
    }
}

module.exports = LifespanService;
