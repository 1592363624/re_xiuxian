/**
 * 采集服务
 * 
 * 处理资源采集逻辑
 */
const sequelize = require('../config/database');
const PlayerGathering = require('../models/playerGathering');
const Item = require('../models/item');
const Player = require('../models/player');
const ResourceLoader = require('./ResourceLoader');
const MapConfigLoader = require('./MapConfigLoader');

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
                        level: playerGather?.proficiency_level || 1,
                        exp: playerGather?.proficiency_exp || 0,
                        total_count: playerGather?.total_gather_count || 0
                    }
                });
            }
        }

        return resources;
    }

    /**
     * 执行采集
     */
    static async collect(playerId, resourceId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new Error('玩家不存在');
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

        let isCrit = false;
        if (Math.random() < ResourceLoader.getCritChance(resourceId)) {
            quantity *= ResourceLoader.getCritMultiplier(resourceId);
            isCrit = true;
        }

        const t = await sequelize.transaction();
        try {
            player.mp_current = BigInt(player.mp_current) - BigInt(mpCost);
            await player.save({ transaction: t });

            await Item.upsert({
                player_id: playerId,
                item_key: resourceConfig.item_id,
                quantity: quantity
            }, {
                transaction: t
            });

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
}

module.exports = GatheringService;
