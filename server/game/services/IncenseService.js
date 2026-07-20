/**
 * 香火服务
 *
 * 实现批次3设计文档第4.3.2节「小世界资源产出机制」中香火相关的全部业务逻辑：
 *   1. 收割香火（按公式计算产出，更新 last_incense_harvest_time）
 *   2. 香火流水分页查询
 *   3. GM 发放香火
 *
 * 香火产出公式（每小时）：
 *   population * 0.1 * (faith / faith_max) * (stability / 100) * temple_level_multiplier
 *   temple_level_multiplier = 1 + (temple_level - 1) * 0.1
 *   满级神庙（10级）香火产出翻倍
 *
 * 设计原则：
 *   - 所有阈值/比例从 late_stage_data.json 配置读取
 *   - 收割操作使用事务 + LOCK.UPDATE 行级锁，保证香火余额原子更新
 *   - 收割时同步结算小世界的人口/信仰/稳定度变化（基于时间差）
 *   - 关键事件通过 WebSocketNotificationService 推送
 *
 * 数据模型：
 *   - Player: 玩家主表（incense_balance）
 *   - PlayerSmallWorld: 小世界表（last_incense_harvest_time）
 *   - PlayerDivineTemple: 神庙表（temple_level）
 *   - PlayerIncenseLog: 香火流水表（N:1）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerSmallWorld = require('../../models/playerSmallWorld');
const PlayerDivineTemple = require('../../models/playerDivineTemple');
const PlayerIncenseLog = require('../../models/playerIncenseLog');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');

class IncenseService {
    /**
     * 收割香火
     * 按公式计算自上次收割以来的累计产出，更新玩家 incense_balance
     * 同时结算小世界的人口/信仰/稳定度
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async harvest(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const world = await PlayerSmallWorld.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!world) {
                await t.rollback();
                return { success: false, message: '尚未开辟小世界，无法收割香火' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const worldCfg = config.small_world;
            const incenseCfg = config.incense;

            // 查询神庙等级
            const temple = await PlayerDivineTemple.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            const templeLevel = temple ? Number(temple.temple_level || 1) : 0;

            // 计算时间差（小时）
            const now = new Date();
            const lastHarvest = world.last_incense_harvest_time
                ? new Date(world.last_incense_harvest_time)
                : now;
            const elapsedMs = Math.max(0, now.getTime() - lastHarvest.getTime());
            const elapsedHours = elapsedMs / 3600000;

            // 累计上限校验（24 小时）
            const maxAccumulationHours = incenseCfg.harvest_max_accumulation_hours;
            const effectiveHours = Math.min(elapsedHours, maxAccumulationHours);

            // 按公式计算香火产出
            const population = Number(world.population || 0);
            const faith = Number(world.faith || 0);
            const faithMax = Number(world.faith_max || worldCfg.faith_max);
            const stability = Number(world.stability || 0);
            const templeMultiplier = 1 + (templeLevel - 1) * worldCfg.incense_production_temple_multiplier_per_level;

            let incenseProduced = 0;
            if (population > 0 && faithMax > 0 && stability > 0) {
                incenseProduced = population
                    * worldCfg.incense_production_base_multiplier
                    * (faith / faithMax)
                    * (stability / 100)
                    * templeMultiplier
                    * effectiveHours;
            }
            // 满级神庙香火产出翻倍
            if (templeLevel >= 10) {
                incenseProduced *= 2;
            }
            incenseProduced = Math.floor(incenseProduced);

            if (incenseProduced <= 0) {
                await t.rollback();
                return {
                    success: false,
                    message: '当前香火产出为 0，需提升人口/信仰/稳定度后再收割'
                };
            }

            // 同步结算小世界的人口/信仰/稳定度变化
            // 人口自然增长
            let newPopulation = population;
            const populationMax = Number(world.population_max || 1000);
            if (stability < worldCfg.population_decline_stability_threshold) {
                newPopulation = Math.max(0, population - population * 0.005 * effectiveHours);
            } else {
                newPopulation = Math.min(populationMax, population + population * worldCfg.population_growth_rate_per_hour * effectiveHours);
            }
            world.population = Math.floor(newPopulation);

            // 信仰增长
            const faithGain = population * worldCfg.faith_growth_rate_per_hour * (stability / 100) * effectiveHours;
            world.faith = Math.min(faithMax, Math.floor(faith + faithGain));

            // 稳定度衰减（<30 时持续下降）
            if (stability < worldCfg.stability_decline_threshold) {
                world.stability = Math.max(worldCfg.stability_min, Math.floor(stability - worldCfg.stability_decline_rate_per_hour * effectiveHours));
            }

            // 更新玩家香火余额
            const oldIncense = Number(player.incense_balance || 0);
            const newIncense = oldIncense + incenseProduced;
            player.incense_balance = newIncense;

            // 更新收割时间
            world.last_incense_harvest_time = now;

            // 写入香火流水
            await PlayerIncenseLog.create({
                player_id: playerId,
                change_type: 'harvest',
                change_amount: incenseProduced,
                balance_after: newIncense,
                reason: `收割香火（${effectiveHours.toFixed(2)} 小时累计，人口 ${population}，信仰 ${faith}/${faithMax}，稳定度 ${stability}，神庙 ${templeLevel} 级）`
            }, { transaction: t });

            await player.save({ transaction: t });
            await world.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'incense_harvested', {
                    harvested_amount: incenseProduced,
                    new_balance: newIncense,
                    elapsed_hours: Number(effectiveHours.toFixed(2)),
                    world_population: world.population,
                    world_faith: world.faith,
                    world_stability: world.stability,
                    temple_level: templeLevel
                });
            } catch (e) {
                console.warn('[IncenseService] 推送收割通知失败:', e.message);
            }

            return {
                success: true,
                message: `收割香火成功！获得 ${incenseProduced} 香火（累计 ${effectiveHours.toFixed(2)} 小时）`,
                data: {
                    harvested_amount: incenseProduced,
                    new_balance: newIncense,
                    elapsed_hours: Number(effectiveHours.toFixed(2)),
                    world: {
                        population: world.population,
                        population_max: populationMax,
                        faith: world.faith,
                        faith_max: faithMax,
                        stability: world.stability
                    },
                    temple_level: templeLevel,
                    harvested_at: now.toISOString()
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[IncenseService] harvest 异常:', err);
            throw err;
        }
    }

    /**
     * 分页查询香火流水
     * @param {number} playerId - 玩家ID
     * @param {number} page - 页码（1-based）
     * @param {number} pageSize - 每页条数
     * @returns {Promise<Object>} { success, data }
     */
    static async getLogs(playerId, page = 1, pageSize = 10) {
        const config = configLoader.getConfig('late_stage_data');
        const incenseCfg = config.incense;

        // 参数校验
        if (!Number.isInteger(page) || page < 1) {
            return { success: false, message: 'page 必须 >=1', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > incenseCfg.log_max_page_size) {
            return {
                success: false,
                message: `page_size 必须为 1-${incenseCfg.log_max_page_size} 之间的整数`,
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const offset = (page - 1) * pageSize;
        const { rows, count } = await PlayerIncenseLog.findAndCountAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset: offset,
            distinct: true
        });

        return {
            success: true,
            data: {
                list: rows.map(r => ({
                    id: r.id,
                    change_type: r.change_type,
                    change_type_name: incenseCfg.change_types[r.change_type] || r.change_type,
                    change_amount: r.change_amount,
                    balance_after: r.balance_after,
                    reason: r.reason,
                    created_at: r.created_at
                })),
                total: count,
                page,
                page_size: pageSize,
                total_pages: Math.ceil(count / pageSize)
            }
        };
    }

    /**
     * GM 发放香火
     * @param {number} playerId - 玩家ID
     * @param {number} amount - 数量（正数增加，负数扣减）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmGrant(playerId, amount) {
        if (!Number.isInteger(amount) || amount === 0) {
            return { success: false, message: 'amount 必须为非零整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (amount < -1000000 || amount > 1000000) {
            return { success: false, message: 'amount 范围必须在 -1000000 到 1000000 之间', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const oldBalance = Number(player.incense_balance || 0);
            const newBalance = Math.max(0, oldBalance + amount);
            const actualChange = newBalance - oldBalance;

            if (actualChange === 0) {
                await t.rollback();
                return { success: false, message: '玩家香火已为 0，无法扣减' };
            }

            player.incense_balance = newBalance;
            await player.save({ transaction: t });

            // 写入流水
            await PlayerIncenseLog.create({
                player_id: playerId,
                change_type: 'gm_grant',
                change_amount: actualChange,
                balance_after: newBalance,
                reason: `GM 发放香火 ${actualChange > 0 ? '+' : ''}${actualChange}`
            }, { transaction: t });

            await t.commit();

            return {
                success: true,
                message: `香火 ${actualChange > 0 ? '发放' : '扣减'} ${Math.abs(actualChange)}（${oldBalance} → ${newBalance}）`,
                data: {
                    old_balance: oldBalance,
                    new_balance: newBalance,
                    change: actualChange
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[IncenseService] gmGrant 异常:', err);
            throw err;
        }
    }
}

module.exports = IncenseService;
