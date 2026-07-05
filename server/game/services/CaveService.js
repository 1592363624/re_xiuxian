/**
 * 洞府服务模块
 *
 * 处理洞府核心业务逻辑：开辟洞府、升级设施、领取灵脉灵石、查询洞府信息
 *
 * 设计说明：
 *   - 洞府配置从 cave_data.json 读取（配置中心化，支持热更新）
 *   - 灵脉按时间累计产出灵石，玩家可主动领取（计算公式：等级×基础速率×经过秒数）
 *   - 升级设施消耗灵石+材料，材料通过 InventoryService 扣除
 *   - 所有写操作使用事务 + 行级锁保证并发安全
 *   - 静室等级影响闭关收益（通过 getCaveBonus 供闭关服务调用）
 */
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const Player = require('../../models/player');
const PlayerCave = require('../../models/playerCave');
const Realm = require('../../models/realm');
const InventoryService = require('./InventoryService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// 单例库存服务实例
// 说明：InventoryService.js 已通过 module.exports = new InventoryService() 导出单例，
//       此处直接引用即可，不能再次 new（与 SectService/MarketService/GardenService 等保持一致）
const inventoryService = InventoryService;

// 设施类型常量（与 cave_data.json 的 facilities 节点对应）
const FACILITY_TYPES = ['spirit_vein', 'quiet_room', 'pill_room', 'tool_room', 'grand_formation'];

class CaveService {
    /**
     * 初始化服务，注入配置加载器
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        inventoryService.initialize(configLoader);
    }

    /**
     * 获取洞府配置（从 cave_data.json 读取）
     */
    getCaveConfig() {
        return this.configLoader?.getConfig('cave_data')?.cave || {};
    }

    /**
     * 获取指定设施的配置
     */
    getFacilityConfig(facilityType) {
        return this.getCaveConfig().facilities?.[facilityType] || null;
    }

    /**
     * 获取或创建玩家洞府记录（未开辟时返回 is_opened=false 的默认记录）
     */
    async getOrCreateCave(playerId, transaction = null) {
        const options = transaction ? { transaction } : {};
        let cave = await PlayerCave.findOne({ where: { player_id: playerId }, ...options });
        if (!cave) {
            cave = await PlayerCave.create({
                player_id: playerId,
                is_opened: false,
                garden_plots: 3
            }, options);
        }
        return cave;
    }

    /**
     * 获取玩家洞府完整信息（含灵脉待领取灵石计算）
     */
    async getCaveInfo(playerId) {
        const cave = await this.getOrCreateCave(playerId);

        if (!cave.is_opened) {
            return { is_opened: false, message: '尚未开辟洞府' };
        }

        // 计算灵脉待领取灵石（按时间累计）
        const pendingStones = await this._calculatePendingStones(cave);

        // 组装设施信息（合并静态配置 + 动态等级）
        const facilities = {};
        for (const type of FACILITY_TYPES) {
            const config = this.getFacilityConfig(type);
            const level = cave[`${type}_level`] || 0;
            facilities[type] = {
                name: config?.name || type,
                description: config?.description || '',
                level: level,
                max_level: config?.max_level || 10,
                can_upgrade: level < (config?.max_level || 10),
                upgrade_cost: level < (config?.max_level || 10) ? config.upgrade_costs[level] : null
            };
        }

        return {
            is_opened: true,
            opened_at: cave.opened_at,
            facilities: facilities,
            spirit_vein: {
                level: cave.spirit_vein_level,
                pending_stones: pendingStones,
                accumulated_stones: Number(cave.spirit_vein_accumulated || 0),
                last_collect: cave.last_spirit_vein_collect,
                produce_rate: this._getSpiritVeinRate(cave.spirit_vein_level)
            },
            garden_plots: {
                current: cave.garden_plots,
                max: this.getCaveConfig().garden?.max_plots || 9,
                unlock_cost: cave.garden_plots < 9
                    ? this.getCaveConfig().garden?.plot_unlock_costs?.find(p => p.plot_index === cave.garden_plots + 1)
                    : null
            }
        };
    }

    /**
     * 开辟洞府（消耗灵石，初始化灵脉等级为1）
     */
    async openCave(playerId) {
        const config = this.getCaveConfig();
        const requirement = config.open_requirement;

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 校验境界（优先使用 player.realm_rank 字段，避免 Realm 表数据不完整的问题）
            const playerRank = player.realm_rank || 0;
            if (playerRank < requirement.min_realm_rank) {
                throw new AppError(`开辟洞府需达到炼气1层及以上境界`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 查询或创建洞府记录（带事务）
            let cave = await PlayerCave.findOne({ where: { player_id: playerId }, transaction: t, lock: t.LOCK.UPDATE });
            if (cave && cave.is_opened) {
                throw new AppError('已开辟过洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣除灵石
            if (BigInt(player.spirit_stones || 0) < BigInt(requirement.spirit_stone_cost)) {
                throw new AppError(`灵石不足，开辟洞府需${requirement.spirit_stone_cost}灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(requirement.spirit_stone_cost);

            // 创建或更新洞府记录
            if (!cave) {
                cave = await PlayerCave.create({
                    player_id: playerId,
                    is_opened: true,
                    opened_at: new Date(),
                    spirit_vein_level: 1,  // 初始灵脉1级
                    last_spirit_vein_collect: new Date()
                }, { transaction: t });
            } else {
                cave.is_opened = true;
                cave.opened_at = new Date();
                cave.spirit_vein_level = 1;
                cave.last_spirit_vein_collect = new Date();
                await cave.save({ transaction: t });
            }

            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: '洞府开辟成功，灵脉已激活',
                spirit_stone_cost: requirement.spirit_stone_cost,
                cave: {
                    is_opened: true,
                    spirit_vein_level: 1,
                    opened_at: cave.opened_at
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 升级设施（消耗灵石+材料）
     */
    async upgradeFacility(playerId, facilityType) {
        // 校验设施类型
        if (!FACILITY_TYPES.includes(facilityType)) {
            throw new AppError(`无效的设施类型: ${facilityType}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const facilityConfig = this.getFacilityConfig(facilityType);
        if (!facilityConfig) {
            throw new AppError('设施配置不存在', 500, ErrorCodes.INTERNAL_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const cave = await this.getOrCreateCave(playerId, t);
            // 行级锁
            const lockedCave = await PlayerCave.findByPk(cave.id, { lock: t.LOCK.UPDATE, transaction: t });

            if (!lockedCave.is_opened) {
                throw new AppError('尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const currentLevel = lockedCave[`${facilityType}_level`] || 0;
            const maxLevel = facilityConfig.max_level;
            if (currentLevel >= maxLevel) {
                throw new AppError(`${facilityConfig.name}已达最高等级`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 获取升级消耗（currentLevel+1 对应数组索引）
            const upgradeCost = facilityConfig.upgrade_costs[currentLevel];
            if (!upgradeCost) {
                throw new AppError('升级配置不存在', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 行级锁玩家记录，扣除灵石
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (BigInt(player.spirit_stones || 0) < BigInt(upgradeCost.spirit_stone)) {
                throw new AppError(`灵石不足，需${upgradeCost.spirit_stone}灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(upgradeCost.spirit_stone);

            // 扣除材料（通过 InventoryService 在事务内扣减）
            if (upgradeCost.material && upgradeCost.material_count > 0) {
                const removed = await inventoryService.removeItem(playerId, upgradeCost.material, upgradeCost.material_count, t);
                if (!removed) {
                    throw new AppError(`材料不足，需${upgradeCost.material_count}个${upgradeCost.material}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            // 提升设施等级
            lockedCave[`${facilityType}_level`] = currentLevel + 1;
            await lockedCave.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `${facilityConfig.name}升级成功`,
                facility: facilityType,
                old_level: currentLevel,
                new_level: currentLevel + 1,
                cost: upgradeCost
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 领取灵脉产出的灵石
     */
    async collectSpiritStones(playerId) {
        const t = await sequelize.transaction();
        try {
            const cave = await PlayerCave.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!cave || !cave.is_opened) {
                throw new AppError('尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            if (cave.spirit_vein_level < 1) {
                throw new AppError('灵脉未激活', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算待领取灵石
            const pendingStones = await this._calculatePendingStones(cave);
            if (pendingStones <= 0) {
                throw new AppError('暂无可领取的灵石', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 玩家加灵石
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            player.spirit_stones = BigInt(player.spirit_stones || 0) + BigInt(pendingStones);

            // 重置累计
            cave.spirit_vein_accumulated = BigInt(cave.spirit_vein_accumulated || 0) + BigInt(pendingStones);
            cave.spirit_vein_pending = 0;
            cave.last_spirit_vein_collect = new Date();

            await cave.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                collected: pendingStones,
                total_spirit_stones: Number(player.spirit_stones),
                accumulated_from_vein: Number(cave.spirit_vein_accumulated)
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 解锁新的药园地块
     */
    async unlockGardenPlot(playerId) {
        const gardenConfig = this.getCaveConfig().garden;
        const t = await sequelize.transaction();
        try {
            const cave = await PlayerCave.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!cave || !cave.is_opened) {
                throw new AppError('尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            if (cave.garden_plots >= gardenConfig.max_plots) {
                throw new AppError('药园地块已达上限', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 查找解锁下一块地块的费用
            const nextPlotIndex = cave.garden_plots + 1;
            const unlockCost = gardenConfig.plot_unlock_costs.find(p => p.plot_index === nextPlotIndex);
            if (!unlockCost) {
                throw new AppError('无法解锁更多地块', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (BigInt(player.spirit_stones || 0) < BigInt(unlockCost.spirit_stone)) {
                throw new AppError(`灵石不足，需${unlockCost.spirit_stone}灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(unlockCost.spirit_stone);
            cave.garden_plots = nextPlotIndex;

            await cave.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `成功开垦第${nextPlotIndex}块药园地块`,
                new_plot_count: nextPlotIndex,
                cost: unlockCost.spirit_stone
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 获取洞府加成（供其他服务调用，如闭关收益加成）
     * @param {number} playerId
     * @returns {Object} 加成信息 { seclusion_bonus, pill_success_bonus, tool_success_bonus, defense }
     */
    async getCaveBonus(playerId) {
        try {
            const cave = await PlayerCave.findOne({ where: { player_id: playerId } });
            if (!cave || !cave.is_opened) {
                return { seclusion_bonus: 0, pill_success_bonus: 0, tool_success_bonus: 0, defense: 0 };
            }

            const quietRoomConfig = this.getFacilityConfig('quiet_room');
            const pillRoomConfig = this.getFacilityConfig('pill_room');
            const toolRoomConfig = this.getFacilityConfig('tool_room');
            const formationConfig = this.getFacilityConfig('grand_formation');

            return {
                seclusion_bonus: (cave.quiet_room_level || 0) * (quietRoomConfig?.bonus_per_level || 0),
                pill_success_bonus: (cave.pill_room_level || 0) * (pillRoomConfig?.success_bonus_per_level || 0),
                tool_success_bonus: (cave.tool_room_level || 0) * (toolRoomConfig?.success_bonus_per_level || 0),
                defense: (cave.grand_formation_level || 0) * (formationConfig?.defense_per_level || 0),
                spirit_vein_level: cave.spirit_vein_level || 0
            };
        } catch (err) {
            console.warn('[CaveService] 获取洞府加成失败:', err.message);
            return { seclusion_bonus: 0, pill_success_bonus: 0, tool_success_bonus: 0, defense: 0 };
        }
    }

    /**
     * 计算灵脉待领取灵石数（按时间累计）
     * 公式：等级 × (基础速率 + 等级×每级增量) × 经过小时数
     */
    async _calculatePendingStones(cave) {
        if (!cave.is_opened || cave.spirit_vein_level < 1) return 0;

        const lastCollect = cave.last_spirit_vein_collect || cave.opened_at || new Date();
        const now = new Date();
        const elapsedHours = Math.max(0, (now - lastCollect) / (1000 * 60 * 60));

        // 每小时产出 = 等级 × (基础速率 + (等级-1)×每级增量)
        const ratePerHour = this._getSpiritVeinRate(cave.spirit_vein_level);
        const pending = Math.floor(ratePerHour * elapsedHours);

        // 加上之前未领取的
        return pending + Number(cave.spirit_vein_pending || 0);
    }

    /**
     * 获取灵脉每小时产出速率
     */
    _getSpiritVeinRate(level) {
        if (level < 1) return 0;
        const config = this.getFacilityConfig('spirit_vein');
        const baseRate = config?.base_produce_rate || 10;
        const ratePerLevel = config?.rate_per_level || 5;
        return level * (baseRate + (level - 1) * ratePerLevel);
    }
}

// 导出单例
module.exports = new CaveService();
