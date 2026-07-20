/**
 * 小世界服务
 *
 * 实现批次3设计文档第4.3节「小世界系统」的全部业务逻辑：
 *   1. 开辟小世界（化神期 + 灵石消耗）
 *   2. 显灵回应祈愿（消耗100香火，获得信仰+5/稳定+3/灵石回馈）
 *   3. 神迹干预（赈灾/布道，每日上限）
 *   4. GM 重置/调整等级
 *
 * 设计原则：
 *   - 所有阈值/比例从 late_stage_data.json 配置读取
 *   - 关键操作使用事务 + LOCK.UPDATE 行级锁
 *   - 人口/信仰/稳定度按时间公式计算（收割香火时结算）
 *   - 关键事件通过 WebSocketNotificationService 推送
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones/small_world_id/incense_balance）
 *   - PlayerSmallWorld: 玩家小世界表（1:1）
 *   - PlayerDivineTemple: 玩家神庙表（1:1，通过 temple_id 关联）
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
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');

/**
 * 工具函数：从消息数组中随机选一条
 * @param {Array<string>} messages - 消息数组
 * @returns {string} 选中的消息
 */
function pickRandomMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    return messages[Math.floor(Math.random() * messages.length)];
}

/**
 * 工具函数：在 [min, max] 范围内随机取整数
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number} 随机整数
 */
function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 计算人口/信仰/稳定度/香火产出的实时值
 * 基于时间差按公式计算
 * @param {Object} world - 小世界对象
 * @param {Object} worldCfg - 小世界配置
 * @param {number} templeLevel - 神庙等级（0 表示无神庙）
 * @returns {{population, faith, stability, incense_per_hour, lastUpdateTs}} 计算后的实时值
 */
function calcRealtimeStats(world, worldCfg, templeLevel = 0) {
    const now = Date.now();
    const lastHarvest = world.last_incense_harvest_time
        ? new Date(world.last_incense_harvest_time).getTime()
        : now;
    const elapsedHours = Math.max(0, (now - lastHarvest) / 3600000);

    let population = Number(world.population || 0);
    let populationMax = Number(world.population_max || 1000);
    let faith = Number(world.faith || 0);
    let stability = Number(world.stability || 100);

    // 稳定度自然衰减（每小时 -5，但 >decline_threshold 时才衰减）
    // 设计文档：稳定度 <30 时人口负增长；这里实现为稳定度<30时持续下降
    if (stability < worldCfg.stability_decline_threshold) {
        stability = Math.max(worldCfg.stability_min, stability - worldCfg.stability_decline_rate_per_hour * elapsedHours);
    }

    // 人口自然增长/负增长
    if (stability < worldCfg.population_decline_stability_threshold) {
        // 稳定度低，人口负增长
        population = Math.max(0, population - population * 0.005 * elapsedHours);
    } else {
        // 正常增长
        population = Math.min(populationMax, population + population * worldCfg.population_growth_rate_per_hour * elapsedHours);
    }
    population = Math.floor(population);

    // 信仰增长
    const faithMax = Number(world.faith_max || worldCfg.faith_max);
    if (population > 0 && stability > 0) {
        const faithGain = population * worldCfg.faith_growth_rate_per_hour * (stability / 100) * elapsedHours;
        faith = Math.min(faithMax, faith + faithGain);
    }
    faith = Math.floor(faith);

    // 香火产出（每小时）
    // 公式：population * 0.1 * (faith/faith_max) * (stability/100) * temple_multiplier
    const templeMultiplier = 1 + (templeLevel - 1) * worldCfg.incense_production_temple_multiplier_per_level;
    let incensePerHour = 0;
    if (population > 0 && faithMax > 0 && stability > 0) {
        incensePerHour = population
            * worldCfg.incense_production_base_multiplier
            * (faith / faithMax)
            * (stability / 100)
            * templeMultiplier;
    }
    // 满级神庙香火产出翻倍
    if (templeLevel >= 10) {
        incensePerHour *= 2;
    }
    incensePerHour = Math.floor(incensePerHour);

    return {
        population,
        population_max: populationMax,
        faith,
        faith_max: faithMax,
        stability: Math.floor(stability),
        incense_per_hour: incensePerHour,
        elapsed_hours: elapsedHours
    };
}

class SmallWorldService {
    /**
     * 获取玩家小世界面板数据
     * 包含小世界状态、神庙、香火、神识、法则汇总
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 面板数据
     */
    static async getProfile(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('late_stage_data');
        const worldCfg = config.small_world;

        const world = await PlayerSmallWorld.findOne({ where: { player_id: playerId } });
        if (!world) {
            return {
                success: true,
                data: {
                    has_small_world: false,
                    can_create: RealmService.meetsRealmRequirement(player, worldCfg.min_realm_name).met,
                    create_cost: {
                        spirit_stones: worldCfg.create_cost_spirit_stones,
                        realm_required: worldCfg.min_realm_name
                    }
                }
            };
        }

        // 查询关联神庙
        const temple = await PlayerDivineTemple.findOne({ where: { player_id: playerId } });
        const templeLevel = temple ? Number(temple.temple_level || 1) : 0;

        // 计算实时数值
        const stats = calcRealtimeStats(world, worldCfg, templeLevel);

        return {
            success: true,
            data: {
                has_small_world: true,
                world: {
                    id: world.id,
                    world_name: world.world_name,
                    world_level: world.world_level,
                    world_type: world.world_type,
                    population: stats.population,
                    population_max: stats.population_max,
                    faith: stats.faith,
                    faith_max: stats.faith_max,
                    stability: stats.stability,
                    incense_production_rate: stats.incense_per_hour,
                    last_incense_harvest_time: world.last_incense_harvest_time,
                    temple_id: world.temple_id,
                    created_at: world.created_at
                },
                temple: temple ? {
                    id: temple.id,
                    temple_level: temple.temple_level,
                    temple_name: temple.temple_name,
                    defense_power: temple.defense_power,
                    defense_max: temple.defense_max,
                    last_upgrade_time: temple.last_upgrade_time
                } : null,
                player: {
                    incense_balance: Number(player.incense_balance || 0),
                    divine_sense_balance: Number(player.divine_sense_balance || 0),
                    law_points: Number(player.law_points || 0)
                }
            }
        };
    }

    /**
     * 开辟小世界
     * 校验境界≥化神期、消耗灵石
     * @param {number} playerId - 玩家ID
     * @param {string} worldName - 小世界名称
     * @returns {Promise<Object>} { success, message, data }
     */
    static async create(playerId, worldName) {
        if (!worldName || typeof worldName !== 'string' || worldName.trim().length === 0) {
            return { success: false, message: '小世界名称不能为空', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (worldName.length > 50) {
            return { success: false, message: '小世界名称不能超过 50 个字符', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const worldCfg = config.small_world;

            // 境界校验
            const realmCheck = RealmService.meetsRealmRequirement(player, worldCfg.min_realm_name);
            if (!realmCheck.met) {
                await t.rollback();
                return {
                    success: false,
                    message: `需达到${worldCfg.min_realm_name}才能开辟小世界（当前 ${player.realm}）`
                };
            }

            // 重复开辟校验
            const existing = await PlayerSmallWorld.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (existing) {
                await t.rollback();
                return { success: false, message: '已开辟过小世界，无法重复开辟' };
            }

            // 灵石消耗校验
            const costStones = BigInt(worldCfg.create_cost_spirit_stones);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                };
            }

            // 扣减灵石
            player.spirit_stones = (playerStones - costStones).toString();

            // 创建小世界
            const newWorld = await PlayerSmallWorld.create({
                player_id: playerId,
                world_name: worldName.trim(),
                world_level: worldCfg.init_world_level,
                world_type: 'mortal',
                population: worldCfg.init_population,
                population_max: worldCfg.population_max_formula_base * worldCfg.init_world_level,
                faith: 0,
                faith_max: worldCfg.faith_max,
                stability: worldCfg.init_stability,
                incense_production_rate: worldCfg.init_incense_production_rate,
                last_incense_harvest_time: new Date(),
                temple_id: null
            }, { transaction: t });

            // 自动创建初始神庙（资源闭环关键：神庙是小世界香火产出的核心设施）
            // 神庙初始 1 级，护界禁制 100/1000，无供奉池解锁
            // 注意：offering_pool 字段在 Model 中已配置 getter/setter 自动处理 JSON 序列化，这里直接传数组
            const templeCfg = config.divine_temple;
            const newTemple = await PlayerDivineTemple.create({
                player_id: playerId,
                small_world_id: newWorld.id,
                temple_level: 1,
                temple_name: `${worldName.trim()}的神庙`,
                defense_power: templeCfg.defense_max_base,
                defense_max: templeCfg.defense_max_base,
                offering_pool: [],
                last_upgrade_time: null,
                last_defense_repair_time: null
            }, { transaction: t });

            // 反向关联：小世界记录 temple_id，便于后续香火产出查询
            newWorld.temple_id = newTemple.id;
            await newWorld.save({ transaction: t });

            // 更新玩家 small_world_id
            player.small_world_id = newWorld.id;
            await player.save({ transaction: t });

            await t.commit();

            const message = pickRandomMessage(worldCfg.create_success_messages);

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'small_world_created', {
                    message,
                    world_id: newWorld.id,
                    world_name: newWorld.world_name,
                    world_level: newWorld.world_level
                });
            } catch (e) {
                console.warn('[SmallWorldService] 推送开辟成功通知失败:', e.message);
            }

            return {
                success: true,
                message,
                data: {
                    world_id: newWorld.id,
                    world_name: newWorld.world_name,
                    world_level: newWorld.world_level,
                    population: newWorld.population,
                    population_max: newWorld.population_max,
                    faith: newWorld.faith,
                    stability: newWorld.stability,
                    incense_production_rate: newWorld.incense_production_rate
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[SmallWorldService] create 异常:', err);
            throw err;
        }
    }

    /**
     * 显灵回应祈愿
     * 消耗 100 香火，获得信仰 +5、稳定度 +3、灵石回馈（50-200）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async manifest(playerId) {
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
                return { success: false, message: '尚未开辟小世界' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const worldCfg = config.small_world;
            const manifestCfg = worldCfg.manifest;

            // 香火余额校验
            const currentIncense = Number(player.incense_balance || 0);
            if (currentIncense < manifestCfg.cost_incense) {
                await t.rollback();
                return {
                    success: false,
                    message: `香火不足，需要 ${manifestCfg.cost_incense}，当前 ${currentIncense}`
                };
            }

            // 扣减香火
            const newIncenseBalance = currentIncense - manifestCfg.cost_incense;
            player.incense_balance = newIncenseBalance;

            // 增加信仰与稳定度
            world.faith = Math.min(Number(world.faith_max || worldCfg.faith_max), Number(world.faith || 0) + manifestCfg.faith_gain);
            world.stability = Math.min(worldCfg.stability_max, Number(world.stability || 0) + manifestCfg.stability_gain);

            // 灵石回馈（祈愿供品）
            const spiritStoneReward = randomInt(manifestCfg.spirit_stone_reward_min, manifestCfg.spirit_stone_reward_max);
            const currentStones = BigInt(player.spirit_stones || 0);
            player.spirit_stones = (currentStones + BigInt(spiritStoneReward)).toString();

            // 写入香火流水
            await PlayerIncenseLog.create({
                player_id: playerId,
                change_type: 'manifest',
                change_amount: -manifestCfg.cost_incense,
                balance_after: newIncenseBalance,
                reason: `显灵回应祈愿，获得信仰 +${manifestCfg.faith_gain}、稳定度 +${manifestCfg.stability_gain}、灵石 +${spiritStoneReward}`
            }, { transaction: t });

            await player.save({ transaction: t });
            await world.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'small_world_manifest', {
                    cost_incense: manifestCfg.cost_incense,
                    faith_gain: manifestCfg.faith_gain,
                    stability_gain: manifestCfg.stability_gain,
                    spirit_stone_reward: spiritStoneReward,
                    current_incense: newIncenseBalance,
                    current_faith: world.faith,
                    current_stability: world.stability
                });
            } catch (e) {
                console.warn('[SmallWorldService] 推送显灵通知失败:', e.message);
            }

            return {
                success: true,
                message: `显灵回应祈愿成功！信仰 +${manifestCfg.faith_gain}，稳定度 +${manifestCfg.stability_gain}，获得灵石 ${spiritStoneReward}`,
                data: {
                    cost_incense: manifestCfg.cost_incense,
                    faith_gain: manifestCfg.faith_gain,
                    stability_gain: manifestCfg.stability_gain,
                    spirit_stone_reward: spiritStoneReward,
                    current_incense: newIncenseBalance,
                    current_faith: world.faith,
                    current_stability: world.stability,
                    current_spirit_stones: player.spirit_stones.toString()
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[SmallWorldService] manifest 异常:', err);
            throw err;
        }
    }

    /**
     * 神迹干预（赈灾/布道）
     * 赈灾：消耗灵石 100/单位，提升稳定度 +5/次，每日上限 5 次
     * 布道：消耗修为 1000/单位，提升信仰 +10/次，每日上限 3 次
     * @param {number} playerId - 玩家ID
     * @param {string} type - 干预类型（relieve_disaster/preach）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async miracle(playerId, type) {
        if (!['relieve_disaster', 'preach'].includes(type)) {
            return {
                success: false,
                message: '神迹类型无效，支持：relieve_disaster(赈灾)/preach(布道)',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

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
                return { success: false, message: '尚未开辟小世界' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const worldCfg = config.small_world;
            const miracleCfg = worldCfg.miracle[type];

            // 跨日重置每日次数（使用 world.updatedAt 兜底；此处用 world.last_incense_harvest_time 截断日期比较）
            // 简化处理：通过查询今日香火流水统计次数
            const today = new Date().toISOString().slice(0, 10);
            const todayStart = new Date(`${today}T00:00:00`);
            const todayLogs = await PlayerIncenseLog.findAll({
                where: {
                    player_id: playerId,
                    change_type: 'divine_miracle',
                    created_at: { [require('sequelize').Op.gte]: todayStart }
                },
                transaction: t
            });
            const todayCount = todayLogs.length;
            if (todayCount >= miracleCfg.daily_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日${miracleCfg.display_name}次数已用完（${todayCount}/${miracleCfg.daily_limit}）`
                };
            }

            // 资源消耗校验与扣减
            let costDesc = '';
            let changeAmount = 0;
            if (type === 'relieve_disaster') {
                // 灵石消耗
                const costStones = BigInt(miracleCfg.cost_spirit_stones_per_unit);
                const playerStones = BigInt(player.spirit_stones || 0);
                if (playerStones < costStones) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                    };
                }
                player.spirit_stones = (playerStones - costStones).toString();
                costDesc = `灵石 -${costStones.toString()}`;
                changeAmount = -Number(costStones);

                // 提升稳定度
                world.stability = Math.min(worldCfg.stability_max, Number(world.stability || 0) + miracleCfg.stability_gain_per_unit);
            } else {
                // 修为消耗
                const costExp = BigInt(miracleCfg.cost_exp_per_unit);
                const playerExp = BigInt(player.exp || 0);
                if (playerExp < costExp) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `修为不足，需要 ${costExp.toString()}，当前 ${playerExp.toString()}`
                    };
                }
                player.exp = (playerExp - costExp).toString();
                costDesc = `修为 -${costExp.toString()}`;
                changeAmount = -Number(costExp);

                // 提升信仰
                world.faith = Math.min(Number(world.faith_max || worldCfg.faith_max), Number(world.faith || 0) + miracleCfg.faith_gain_per_unit);
            }

            // 写入香火流水（神迹干预记录，不消耗香火但记录流水）
            await PlayerIncenseLog.create({
                player_id: playerId,
                change_type: 'divine_miracle',
                change_amount: 0,
                balance_after: Number(player.incense_balance || 0),
                reason: `${miracleCfg.display_name}（${costDesc}），今日第 ${todayCount + 1} 次`
            }, { transaction: t });

            await player.save({ transaction: t });
            await world.save({ transaction: t });
            await t.commit();

            const effectDesc = type === 'relieve_disaster'
                ? `稳定度 +${miracleCfg.stability_gain_per_unit}`
                : `信仰 +${miracleCfg.faith_gain_per_unit}`;

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'small_world_miracle', {
                    type,
                    type_name: miracleCfg.display_name,
                    cost_description: costDesc,
                    effect_description: effectDesc,
                    daily_count: todayCount + 1,
                    daily_limit: miracleCfg.daily_limit,
                    current_faith: world.faith,
                    current_stability: world.stability
                });
            } catch (e) {
                console.warn('[SmallWorldService] 推送神迹通知失败:', e.message);
            }

            return {
                success: true,
                message: `${miracleCfg.display_name}成功！${costDesc}，${effectDesc}`,
                data: {
                    type,
                    type_name: miracleCfg.display_name,
                    cost_description: costDesc,
                    effect_description: effectDesc,
                    daily_count: todayCount + 1,
                    daily_limit: miracleCfg.daily_limit,
                    current_faith: world.faith,
                    current_stability: world.stability
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[SmallWorldService] miracle 异常:', err);
            throw err;
        }
    }

    /**
     * GM 重置小世界
     * 删除小世界与神庙记录，玩家可重新开辟
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmReset(playerId) {
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
                return { success: false, message: '玩家尚未开辟小世界' };
            }

            // 删除神庙
            await PlayerDivineTemple.destroy({
                where: { player_id: playerId },
                transaction: t
            });

            // 删除小世界
            const worldId = world.id;
            const worldName = world.world_name;
            await world.destroy({ transaction: t });

            // 清空玩家 small_world_id
            player.small_world_id = null;
            await player.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `小世界「${worldName}」已重置（ID: ${worldId}）`,
                data: {
                    reset_world_id: worldId,
                    reset_world_name: worldName
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[SmallWorldService] gmReset 异常:', err);
            throw err;
        }
    }

    /**
     * GM 调整小世界等级
     * @param {number} playerId - 玩家ID
     * @param {number} level - 目标等级（1-10）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmSetLevel(playerId, level) {
        if (!Number.isInteger(level) || level < 1 || level > 10) {
            return { success: false, message: '小世界等级必须为 1-10 之间的整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const world = await PlayerSmallWorld.findOne({ where: { player_id: playerId } });
        if (!world) {
            return { success: false, message: '玩家尚未开辟小世界' };
        }

        const config = configLoader.getConfig('late_stage_data');
        const worldCfg = config.small_world;

        const oldLevel = world.world_level;
        world.world_level = level;
        // 同步更新人口上限
        world.population_max = worldCfg.population_max_formula_base * level;

        await world.save();

        return {
            success: true,
            message: `小世界「${world.world_name}」等级已从 ${oldLevel} 调整为 ${level}`,
            data: {
                world_id: world.id,
                world_name: world.world_name,
                old_level: oldLevel,
                new_level: level,
                population_max: world.population_max
            }
        };
    }
}

module.exports = SmallWorldService;
