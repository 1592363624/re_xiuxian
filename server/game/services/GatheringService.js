/**
 * 采集服务
 * 
 * 处理资源采集逻辑
 */
const sequelize = require('../../config/database');
const PlayerGathering = require('../../models/playerGathering');
const Item = require('../../models/item');
const Player = require('../../models/player');
const ResourceLoader = require('./ResourceLoader');
const MapConfigLoader = require('./MapConfigLoader');
// 引入宗门服务（导出单例实例），用于获取采集加成
const SectService = require('./SectService');
// 引入背包服务：采集产物通过统一的 addItem 方法入包（正确累加数量）
// 修复关键Bug：此前使用 Item.upsert 会替换已有物品数量而非累加
const InventoryService = require('./InventoryService');

class GatheringService {
    /**
     * 获取当前地图可采集资源列表
     */
    static async getMapResources(playerId, mapId) {
        const mapConfig = MapConfigLoader.getMap(mapId);
        if (!mapConfig || !mapConfig.resources) {
            return [];
        }

        const resources = [];
        for (const res of mapConfig.resources) {
            const resourceConfig = ResourceLoader.getResource(res.id);
            if (resourceConfig) {
                const playerGather = await PlayerGathering.findOne({
                    where: { player_id: playerId, resource_id: res.id }
                });

                const lastGather = playerGather?.last_gather_time || null;
                const now = new Date();
                const cooldownEnd = lastGather 
                    ? new Date(lastGather.getTime() + resourceConfig.cooldown_seconds * 1000)
                    : null;
                const canGather = !cooldownEnd || now >= cooldownEnd;

                // 计算升级所需经验和等级名称（由后端返回，避免前端硬编码）
                const proficiencyLevel = playerGather?.proficiency_level || 1;
                const proficiencyExp = playerGather?.proficiency_exp || 0;
                const expToNextLevel = this._getExpToNextLevel(proficiencyLevel);
                const levelName = this._getLevelName(proficiencyLevel);

                resources.push({
                    resource_id: res.id,
                    name: resourceConfig.name,
                    item_id: resourceConfig.item_id,
                    difficulty: res.difficulty,
                    description: `采集${resourceConfig.name}获得${resourceConfig.item_id}`,
                    mp_cost: resourceConfig.base_mp_cost,
                    cooldown_seconds: resourceConfig.cooldown_seconds,
                    can_gather: canGather,
                    next_available_time: canGather ? null : cooldownEnd.toISOString(),
                    player_proficiency: {
                        level: proficiencyLevel,
                        exp: proficiencyExp,
                        total_count: playerGather?.total_gather_count || 0,
                        exp_to_next_level: expToNextLevel,
                        level_name: levelName
                    }
                });
            }
        }

        return resources;
    }

    /**
     * 计算升级所需经验
     * @param {number} level 当前等级
     * @returns {number} 升级所需经验
     */
    static _getExpToNextLevel(level) {
        if (level >= 100) return 0;
        return Math.floor(100 * Math.pow(1.5, level - 1));
    }

    /**
     * 获取等级名称
     * @param {number} level 等级
     * @returns {string} 等级名称
     */
    static _getLevelName(level) {
        if (level < 10) return '入门';
        if (level < 30) return '熟练';
        if (level < 50) return '精通';
        if (level < 70) return '专家';
        if (level < 90) return '大师';
        return '宗师';
    }

    /**
     * 执行采集
     */
    static async collect(playerId, resourceId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new Error('玩家不存在');
        }

        // 获取宗门采集加成（如落云宗 +15% 采集产出）
        // 使用 try-catch 包裹，宗门加成获取失败不应阻断采集主流程
        let gatherBonus = 0;
        try {
            const sectInfo = await SectService.getPlayerSectBonus(playerId);
            // gather_bonus 配置为小数增量（如 0.15 表示 +15%）
            gatherBonus = sectInfo.bonus?.gather_bonus || 0;
        } catch (e) {
            // 宗门加成获取失败时按无加成处理，保证采集流程正常进行
            gatherBonus = 0;
        }

        const mapConfig = MapConfigLoader.getMap(player.current_map_id);
        if (!mapConfig) {
            throw new Error('当前地图配置不存在');
        }

        const mapResource = mapConfig.resources?.find(r => r.id === resourceId);
        if (!mapResource) {
            throw new Error('该资源在当前地图中不存在');
        }

        const resourceConfig = ResourceLoader.getResource(resourceId);
        if (!resourceConfig) {
            throw new Error('资源配置不存在');
        }

        const mpCost = resourceConfig.base_mp_cost;
        if (player.mp_current < mpCost) {
            throw new Error(`灵力不足，需要 ${mpCost} 点灵力`);
        }

        const playerGather = await PlayerGathering.findOne({
            where: { player_id: playerId, resource_id: resourceId }
        });

        if (playerGather?.last_gather_time) {
            const cooldownEnd = new Date(
                playerGather.last_gather_time.getTime() + resourceConfig.cooldown_seconds * 1000
            );
            if (new Date() < cooldownEnd) {
                const remaining = Math.ceil((cooldownEnd - new Date()) / 1000);
                throw new Error(`采集冷却中，请等待 ${remaining} 秒`);
            }
        }

        const expPerGather = ResourceLoader.getExpPerGather();
        const expGain = expPerGather;

        let yieldRange = ResourceLoader.getYield(resourceId, playerGather?.proficiency_level || 1);
        let quantity = Math.floor(Math.random() * (yieldRange[1] - yieldRange[0] + 1)) + yieldRange[0];

        // 应用宗门采集加成（百分比加成，向上取整避免小数导致产量缩水）
        // 加成作用于基础产量，暴击时暴击倍率会进一步放大加成后产量
        if (gatherBonus > 0) {
            quantity = Math.ceil(quantity * (1 + gatherBonus));
        }

        let isCrit = false;
        if (Math.random() < ResourceLoader.getCritChance(resourceId)) {
            quantity *= ResourceLoader.getCritMultiplier(resourceId);
            isCrit = true;
        }

        const t = await sequelize.transaction();
        try {
            player.mp_current = BigInt(player.mp_current) - BigInt(mpCost);
            await player.save({ transaction: t });

            // 修复关键Bug：使用 InventoryService.addItem 正确累加物品数量
            // 此前 Item.upsert 会替换已有数量（如已有10个+采集5个→变为5个而非15个）
            await InventoryService.addItem(playerId, resourceConfig.item_id, quantity, t);

            if (playerGather) {
                const newExp = playerGather.proficiency_exp + expGain;
                const expToNext = ResourceLoader.getProficiencyExpToNextLevel(playerGather.proficiency_level);
                
                let newLevel = playerGather.proficiency_level;
                let remainingExp = newExp;

                while (remainingExp >= expToNext && newLevel < 100) {
                    remainingExp -= expToNext;
                    newLevel++;
                }

                playerGather.total_gather_count += 1;
                playerGather.proficiency_exp = remainingExp;
                playerGather.proficiency_level = newLevel;
                playerGather.last_gather_time = new Date();
                await playerGather.save({ transaction: t });
            } else {
                await PlayerGathering.create({
                    player_id: playerId,
                    resource_id: resourceId,
                    map_id: player.current_map_id,
                    total_gather_count: 1,
                    proficiency_level: 1,
                    proficiency_exp: expGain,
                    last_gather_time: new Date()
                }, { transaction: t });
            }

            await t.commit();

            return {
                success: true,
                resource_id: resourceId,
                resource_name: resourceConfig.name,
                item_id: resourceConfig.item_id,
                quantity: quantity,
                is_crit: isCrit,
                mp_cost: mpCost,
                mp_remaining: player.mp_current.toString(),
                exp_gained: expGain,
                // 标识本次采集是否应用了宗门加成，便于前端展示宗门福利
                sect_bonus_applied: gatherBonus > 0,
                new_proficiency: playerGather ? {
                    level: playerGather.proficiency_level,
                    exp: playerGather.proficiency_exp,
                    next_level_exp: ResourceLoader.getProficiencyExpToNextLevel(playerGather.proficiency_level)
                } : null
            };
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    /**
     * 获取玩家采集统计
     */
    static async getPlayerStats(playerId) {
        const gathers = await PlayerGathering.findAll({
            where: { player_id: playerId },
            order: [['total_gather_count', 'DESC']]
        });

        const totalGatherCount = gathers.reduce((sum, g) => sum + g.total_gather_count, 0);
        const highestLevel = Math.max(...gathers.map(g => g.proficiency_level), 0);

        return {
            total_gather_count: totalGatherCount,
            resources_collected: gathers.length,
            highest_proficiency_level: highestLevel,
            details: gathers.map(g => ({
                resource_id: g.resource_id,
                level: g.proficiency_level,
                exp: g.proficiency_exp,
                total_count: g.total_gather_count
            }))
        };
    }

    /**
     * 批量采集（一次采集多个同类资源）
     * 业务逻辑下沉到 Service 层，路由仅做参数校验和响应
     * @param {number} playerId - 玩家 ID
     * @param {string} resourceId - 资源 ID
     * @param {number} count - 期望采集次数
     * @param {number} maxAllowed - 配置允许的最大次数（由路由传入，避免 Service 读配置耦合）
     * @returns {Object} 批量采集结果
     */
    static async batchCollect(playerId, resourceId, count, maxAllowed) {
        // 批量上限由路由层从配置读取后传入，Service 层不直接读配置
        const actualCount = Math.min(count || 1, maxAllowed);
        const results = [];
        let totalMpUsed = 0;
        const totalItems = {};

        for (let i = 0; i < actualCount; i++) {
            try {
                const result = await this.collect(playerId, resourceId);
                results.push({
                    success: true,
                    quantity: result.quantity,
                    is_crit: result.is_crit
                });

                totalMpUsed += result.mp_cost;
                totalItems[result.item_id] = (totalItems[result.item_id] || 0) + result.quantity;
            } catch (e) {
                // 任一次失败则停止后续采集（如灵力不足、冷却未到）
                results.push({
                    success: false,
                    error: e.message
                });
                break;
            }
        }

        return {
            total_attempts: results.length,
            total_success: results.filter(r => r.success).length,
            total_mp_used: totalMpUsed,
            total_items: totalItems,
            details: results
        };
    }
}

module.exports = GatheringService;
