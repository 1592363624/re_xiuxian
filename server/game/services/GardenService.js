/**
 * 药园服务模块
 *
 * 处理药园种植业务逻辑：播种、采收、查询药园状态
 *
 * 设计说明：
 *   - 种子配置从 cave_data.json 的 garden.seeds 读取（配置中心化）
 *   - 种植后记录成熟时间，到期后地块状态自动变更为 mature
 *   - 采收时根据灵脉等级计算产量加成，品质按概率随机
 *   - 所有写操作使用事务 + 行级锁保证并发安全
 *   - 成熟检测由 GardenService.harvest 接口主动触发，避免额外定时任务
 */
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const Player = require('../../models/player');
const PlayerCave = require('../../models/playerCave');
const PlayerGarden = require('../../models/playerGarden');
const InventoryService = require('./InventoryService');
const CaveService = require('./CaveService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// 单例库存服务实例
// 说明：InventoryService.js 已通过 module.exports = new InventoryService() 导出单例，
//       此处直接引用即可，不能再次 new（与 SectService/MarketService 等保持一致）
const inventoryService = InventoryService;

class GardenService {
    /**
     * 初始化服务，注入配置加载器
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        inventoryService.initialize(configLoader);
        CaveService.initialize(configLoader);
    }

    /**
     * 获取药园配置
     */
    getGardenConfig() {
        return this.configLoader?.getConfig('cave_data')?.cave?.garden || {};
    }

    /**
     * 获取种子配置
     */
    getSeedConfig(seedId) {
        const seeds = this.getGardenConfig().seeds || [];
        return seeds.find(s => s.seed_id === seedId) || null;
    }

    /**
     * 获取或初始化玩家所有地块记录
     * 确保玩家的每个地块都有一条记录（即使空地）
     */
    async getOrCreatePlots(playerId, plotCount, transaction = null) {
        const options = transaction ? { transaction } : {};
        const existingPlots = await PlayerGarden.findAll({
            where: { player_id: playerId },
            ...options
        });

        // 检查缺失的地块并创建空记录
        const existingIndices = new Set(existingPlots.map(p => p.plot_index));
        const missingIndices = [];
        for (let i = 1; i <= plotCount; i++) {
            if (!existingIndices.has(i)) {
                missingIndices.push(i);
            }
        }

        if (missingIndices.length > 0) {
            const newPlots = missingIndices.map(idx => ({
                player_id: playerId,
                plot_index: idx,
                status: 'empty'
            }));
            await PlayerGarden.bulkCreate(newPlots, { ...options, validate: false });
            // 重新查询
            return await PlayerGarden.findAll({
                where: { player_id: playerId },
                order: [['plot_index', 'ASC']],
                ...options
            });
        }

        return existingPlots.sort((a, b) => a.plot_index - b.plot_index);
    }

    /**
     * 获取药园完整状态（含成熟状态刷新）
     */
    async getGardenStatus(playerId) {
        const cave = await PlayerCave.findOne({ where: { player_id: playerId } });
        if (!cave || !cave.is_opened) {
            return { is_opened: false, message: '尚未开辟洞府' };
        }

        // 刷新成熟状态（将已到期但状态仍为 planted 的地块标记为 mature）
        await this._refreshMatureStatus(playerId);

        const plots = await this.getOrCreatePlots(playerId, cave.garden_plots);
        const now = new Date();

        const plotInfos = plots.map(plot => {
            const seedConfig = plot.seed_id ? this.getSeedConfig(plot.seed_id) : null;
            const isMature = plot.status === 'mature';
            const isPlanted = plot.status === 'planted';
            const remainingSeconds = isPlanted && plot.mature_at
                ? Math.max(0, Math.floor((new Date(plot.mature_at) - now) / 1000))
                : 0;

            return {
                plot_index: plot.plot_index,
                status: plot.status,
                seed: seedConfig ? {
                    seed_id: seedConfig.seed_id,
                    name: seedConfig.name,
                    produce_name: seedConfig.produce_name,
                    grow_time_seconds: seedConfig.grow_time_seconds
                } : null,
                planted_at: plot.planted_at,
                mature_at: plot.mature_at,
                remaining_seconds: remainingSeconds,
                can_harvest: isMature
            };
        });

        // 获取可种植的种子列表
        const allSeeds = (this.getGardenConfig().seeds || []).filter(s => cave.spirit_vein_level >= s.min_cave_level);

        return {
            is_opened: true,
            plot_count: cave.garden_plots,
            max_plots: this.getGardenConfig().max_plots || 9,
            plots: plotInfos,
            available_seeds: allSeeds.map(s => ({
                seed_id: s.seed_id,
                name: s.name,
                produce_name: s.produce_name,
                grow_time_seconds: s.grow_time_seconds,
                base_yield: s.base_yield,
                min_cave_level: s.min_cave_level
            }))
        };
    }

    /**
     * 播种（消耗种子，开始种植）
     */
    async plant(playerId, plotIndex, seedId) {
        const seedConfig = this.getSeedConfig(seedId);
        if (!seedConfig) {
            throw new AppError(`种子不存在: ${seedId}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

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

            // 校验灵脉等级
            if (cave.spirit_vein_level < seedConfig.min_cave_level) {
                throw new AppError(`灵脉等级不足，种植${seedConfig.name}需灵脉${seedConfig.min_cave_level}级`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验地块序号
            if (plotIndex < 1 || plotIndex > cave.garden_plots) {
                throw new AppError(`地块序号无效（1-${cave.garden_plots}）`, 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 获取地块记录（行级锁）
            const plots = await this.getOrCreatePlots(playerId, cave.garden_plots, t);
            const plot = plots.find(p => p.plot_index === plotIndex);
            if (!plot) {
                throw new AppError('地块不存在', 400, ErrorCodes.NOT_FOUND);
            }

            const lockedPlot = await PlayerGarden.findByPk(plot.id, { lock: t.LOCK.UPDATE, transaction: t });

            // 校验地块状态
            if (lockedPlot.status !== 'empty') {
                throw new AppError('该地块已有作物，请先采收', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣除种子（通过 InventoryService）
            const removed = await inventoryService.removeItem(playerId, seedId, 1, t);
            if (!removed) {
                throw new AppError(`种子不足，需1个${seedConfig.name}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算成熟时间
            const now = new Date();
            const matureAt = new Date(now.getTime() + seedConfig.grow_time_seconds * 1000);

            // 计算基础产量（记录到地块上，避免配置变更影响）
            const baseYield = this._calculateYield(seedConfig, cave.spirit_vein_level);

            // 更新地块
            lockedPlot.seed_id = seedId;
            lockedPlot.produce_item_id = seedConfig.produce_item_id;
            lockedPlot.planted_at = now;
            lockedPlot.mature_at = matureAt;
            lockedPlot.status = 'planted';
            lockedPlot.base_yield = baseYield;
            await lockedPlot.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `${seedConfig.name}播种成功`,
                plot_index: plotIndex,
                seed: seedConfig.name,
                planted_at: now,
                mature_at: matureAt,
                grow_time_seconds: seedConfig.grow_time_seconds,
                base_yield: baseYield
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 采收成熟作物（获得物品）
     */
    async harvest(playerId, plotIndex) {
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

            // 获取地块（行级锁）
            const plot = await PlayerGarden.findOne({
                where: { player_id: playerId, plot_index: plotIndex },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!plot) {
                throw new AppError('地块不存在', 400, ErrorCodes.NOT_FOUND);
            }

            // 校验成熟状态
            if (plot.status === 'empty') {
                throw new AppError('该地块为空地，无可采收作物', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 如果还在种植中，检查是否已到期
            if (plot.status === 'planted') {
                const now = new Date();
                if (new Date(plot.mature_at) > now) {
                    throw new AppError('作物尚未成熟', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                // 已到期，更新为成熟状态
                plot.status = 'mature';
            }

            if (plot.status !== 'mature') {
                throw new AppError('作物状态异常', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算最终产量（基础产量 + 品质加成）
            const seedConfig = this.getSeedConfig(plot.seed_id);
            const finalYield = this._rollFinalYield(plot.base_yield);
            const quality = this._rollQuality(seedConfig);

            // 添加产出物品到背包
            await inventoryService.addItem(playerId, plot.produce_item_id, finalYield, t);

            // 清空地块
            plot.seed_id = null;
            plot.produce_item_id = null;
            plot.planted_at = null;
            plot.mature_at = null;
            plot.status = 'empty';
            plot.base_yield = 0;
            await plot.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: '采收成功',
                plot_index: plotIndex,
                produce_item_id: plot.produce_item_id || seedConfig?.produce_item_id,
                produce_name: seedConfig?.produce_name,
                yield: finalYield,
                quality: quality
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 一键采收所有成熟作物
     */
    async harvestAll(playerId) {
        // 先刷新成熟状态
        await this._refreshMatureStatus(playerId);

        const plots = await PlayerGarden.findAll({
            where: { player_id: playerId, status: 'mature' }
        });

        if (plots.length === 0) {
            return { success: true, message: '暂无成熟作物可采收', harvested: [] };
        }

        const results = [];
        for (const plot of plots) {
            try {
                const result = await this.harvest(playerId, plot.plot_index);
                results.push(result);
            } catch (err) {
                console.error(`[GardenService] 采收地块 ${plot.plot_index} 失败:`, err.message);
            }
        }

        return {
            success: true,
            message: `采收完成，共采收${results.length}块地块`,
            harvested: results,
            total_count: results.length
        };
    }

    /**
     * 刷新成熟状态（将到期地块标记为 mature）
     */
    async _refreshMatureStatus(playerId) {
        const now = new Date();
        await PlayerGarden.update(
            { status: 'mature' },
            {
                where: {
                    player_id: playerId,
                    status: 'planted',
                    mature_at: { [Op.lte]: now }
                }
            }
        );
    }

    /**
     * 计算基础产量（受灵脉等级影响）
     */
    _calculateYield(seedConfig, spiritVeinLevel) {
        const base = seedConfig.base_yield || 1;
        const bonus = Math.floor((spiritVeinLevel - seedConfig.min_cave_level) * (seedConfig.yield_per_level || 0));
        return Math.max(1, base + Math.max(0, bonus));
    }

    /**
     * 随机最终产量（基础产量 ±20% 浮动）
     */
    _rollFinalYield(baseYield) {
        const variance = Math.floor(baseYield * 0.2);
        const offset = Math.floor(Math.random() * (variance * 2 + 1)) - variance;
        return Math.max(1, baseYield + offset);
    }

    /**
     * 随机品质（按配置概率）
     */
    _rollQuality(seedConfig) {
        const rates = seedConfig?.quality_rates || { common: 1 };
        const rand = Math.random();
        let cumulative = 0;
        for (const [quality, rate] of Object.entries(rates)) {
            cumulative += rate;
            if (rand < cumulative) {
                return quality;
            }
        }
        return 'common';
    }
}

// 导出单例
module.exports = new GardenService();
