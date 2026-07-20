/**
 * 神庙服务
 *
 * 实现批次3设计文档第4.3.3节「神庙升级机制」与供奉兑换的全部业务逻辑：
 *   1. 升级神庙（按 10 级表消耗香火+灵石）
 *   2. 修复护界禁制（消耗灵石）
 *   3. 兑换供奉（用香火兑换灵石/神识丹/法则碎片等）
 *   4. GM 调整神庙等级
 *
 * 设计原则：
 *   - 所有阈值/比例从 late_stage_data.json 配置读取
 *   - 关键操作使用事务 + LOCK.UPDATE 行级锁
 *   - 升级时同步更新神庙等级与香火产出 multiplier
 *   - 关键事件通过 WebSocketNotificationService 推送
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones/incense_balance）
 *   - PlayerDivineTemple: 玩家神庙表（1:1）
 *   - PlayerSmallWorld: 小世界表（通过 temple_id 关联）
 *   - PlayerIncenseLog: 香火流水表（N:1）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerDivineTemple = require('../../models/playerDivineTemple');
const PlayerSmallWorld = require('../../models/playerSmallWorld');
const PlayerIncenseLog = require('../../models/playerIncenseLog');
const PlayerDivineSense = require('../../models/playerDivineSense');
const PlayerLaw = require('../../models/playerLaw');
const PlayerLawFragment = require('../../models/playerLawFragment');
const sequelize = require('../../config/database');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');

/**
 * 工具函数：检查冷却时间是否已过
 * @param {Object} model - 模型实例
 * @param {string} timeField - 上次操作时间字段
 * @param {number} cooldownSec - 冷却秒数
 * @returns {{ready: boolean, remainingSec: number}}
 */
function checkCooldown(model, timeField, cooldownSec) {
    const lastTime = model[timeField];
    if (!lastTime) return { ready: true, remainingSec: 0 };
    const lastMs = lastTime instanceof Date ? lastTime.getTime() : new Date(lastTime).getTime();
    const elapsedSec = Math.floor((Date.now() - lastMs) / 1000);
    if (elapsedSec >= cooldownSec) {
        return { ready: true, remainingSec: 0 };
    }
    return { ready: false, remainingSec: cooldownSec - elapsedSec };
}

class DivineTempleService {
    /**
     * 获取玩家神庙面板数据
     * 包含神庙等级/护界禁制/供奉池/升级表
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 面板数据
     */
    static async getProfile(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('late_stage_data');
        const templeCfg = config.divine_temple;

        const temple = await PlayerDivineTemple.findOne({ where: { player_id: playerId } });
        if (!temple) {
            return {
                success: true,
                data: {
                    has_temple: false,
                    message: '尚未创建神庙，需先开辟小世界并升级神庙'
                }
            };
        }

        // 查询当前等级对应的升级配置（下一级）
        const currentLevel = temple.temple_level;
        const nextUpgrade = templeCfg.upgrade_table.find(u => u.from_level === currentLevel);
        const isMaxLevel = currentLevel >= templeCfg.max_level;

        // 供奉池（已解锁 + 全部可选）
        const offeringPool = temple.offering_pool || [];
        const availableOfferings = templeCfg.offerings.filter(o => o.min_temple_level <= currentLevel);

        return {
            success: true,
            data: {
                has_temple: true,
                temple: {
                    id: temple.id,
                    temple_level: temple.temple_level,
                    temple_name: temple.temple_name,
                    defense_power: temple.defense_power,
                    defense_max: temple.defense_max,
                    offering_pool: offeringPool,
                    last_upgrade_time: temple.last_upgrade_time,
                    last_defense_repair_time: temple.last_defense_repair_time
                },
                upgrade_info: {
                    current_level: currentLevel,
                    is_max_level: isMaxLevel,
                    next_upgrade: isMaxLevel ? null : {
                        to_level: nextUpgrade.to_level,
                        cost_incense: nextUpgrade.cost_incense,
                        cost_spirit_stones: nextUpgrade.cost_spirit_stones,
                        unlock_feature: nextUpgrade.unlock_feature,
                        temple_bonus: nextUpgrade.temple_bonus
                    }
                },
                available_offerings: availableOfferings,
                player_incense_balance: Number(player.incense_balance || 0),
                player_spirit_stones: player.spirit_stones ? player.spirit_stones.toString() : '0'
            }
        };
    }

    /**
     * 升级神庙
     * 按 10 级表消耗香火+灵石
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async upgrade(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const temple = await PlayerDivineTemple.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!temple) {
                await t.rollback();
                return { success: false, message: '尚未创建神庙' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const templeCfg = config.divine_temple;

            // 满级校验
            if (temple.temple_level >= templeCfg.max_level) {
                await t.rollback();
                return { success: false, message: `神庙已达最高等级 ${templeCfg.max_level}` };
            }

            // 获取下一级升级配置
            const currentLevel = temple.temple_level;
            const upgradeCfg = templeCfg.upgrade_table.find(u => u.from_level === currentLevel);
            if (!upgradeCfg) {
                await t.rollback();
                return { success: false, message: `等级 ${currentLevel} 升级配置不存在` };
            }

            // 香火消耗校验
            const currentIncense = Number(player.incense_balance || 0);
            if (currentIncense < upgradeCfg.cost_incense) {
                await t.rollback();
                return {
                    success: false,
                    message: `香火不足，需要 ${upgradeCfg.cost_incense}，当前 ${currentIncense}`
                };
            }

            // 灵石消耗校验
            const costStones = BigInt(upgradeCfg.cost_spirit_stones);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                };
            }

            // 扣减资源
            const newIncenseBalance = currentIncense - upgradeCfg.cost_incense;
            player.incense_balance = newIncenseBalance;
            player.spirit_stones = (playerStones - costStones).toString();

            // 升级神庙
            const oldLevel = temple.temple_level;
            temple.temple_level = upgradeCfg.to_level;
            // 满级时禁制上限翻倍
            temple.defense_max = templeCfg.defense_max_base * (1 + (temple.temple_level - 1) * 0.5);
            temple.last_upgrade_time = new Date();

            // 解锁供奉池：将新解锁的供奉加入 offering_pool
            const newOfferings = templeCfg.offerings.filter(o =>
                o.min_temple_level === upgradeCfg.to_level
            );
            const currentPool = temple.offering_pool || [];
            for (const offering of newOfferings) {
                if (!currentPool.includes(offering.offering_id)) {
                    currentPool.push(offering.offering_id);
                }
            }
            temple.offering_pool = currentPool;

            // 写入香火流水
            await PlayerIncenseLog.create({
                player_id: playerId,
                change_type: 'temple_upgrade',
                change_amount: -upgradeCfg.cost_incense,
                balance_after: newIncenseBalance,
                reason: `神庙升级 ${oldLevel} → ${upgradeCfg.to_level}，解锁：${upgradeCfg.unlock_feature}`
            }, { transaction: t });

            await player.save({ transaction: t });
            await temple.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'divine_temple_upgraded', {
                    old_level: oldLevel,
                    new_level: temple.temple_level,
                    unlock_feature: upgradeCfg.unlock_feature,
                    temple_bonus: upgradeCfg.temple_bonus,
                    cost_incense: upgradeCfg.cost_incense,
                    cost_spirit_stones: costStones.toString()
                });
            } catch (e) {
                console.warn('[DivineTempleService] 推送升级通知失败:', e.message);
            }

            return {
                success: true,
                message: `神庙升级成功！${oldLevel} → ${temple.temple_level}，解锁：${upgradeCfg.unlock_feature}`,
                data: {
                    old_level: oldLevel,
                    new_level: temple.temple_level,
                    unlock_feature: upgradeCfg.unlock_feature,
                    temple_bonus: upgradeCfg.temple_bonus,
                    defense_max: temple.defense_max,
                    cost_incense: upgradeCfg.cost_incense,
                    cost_spirit_stones: costStones.toString(),
                    current_incense: newIncenseBalance,
                    current_spirit_stones: player.spirit_stones.toString()
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineTempleService] upgrade 异常:', err);
            throw err;
        }
    }

    /**
     * 修复护界禁制
     * 消耗灵石修复 100 点禁制
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async repairDefense(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const temple = await PlayerDivineTemple.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!temple) {
                await t.rollback();
                return { success: false, message: '尚未创建神庙' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const templeCfg = config.divine_temple;

            // 冷却校验
            const cd = checkCooldown(temple, 'last_defense_repair_time', templeCfg.repair_defense_cooldown_seconds);
            if (!cd.ready) {
                await t.rollback();
                return {
                    success: false,
                    message: `禁制修复冷却中，剩余 ${Math.floor(cd.remainingSec / 60)} 分钟`
                };
            }

            // 已满拦截
            if (temple.defense_power >= temple.defense_max) {
                await t.rollback();
                return { success: false, message: '护界禁制已满，无需修复' };
            }

            // 灵石消耗校验
            const totalCost = BigInt(templeCfg.repair_defense_cost_per_point) * BigInt(templeCfg.repair_defense_batch_points);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < totalCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${totalCost.toString()}，当前 ${playerStones.toString()}`
                };
            }

            // 扣减灵石，增加禁制
            player.spirit_stones = (playerStones - totalCost).toString();
            const oldDefense = temple.defense_power;
            temple.defense_power = Math.min(temple.defense_max, temple.defense_power + templeCfg.repair_defense_batch_points);
            temple.last_defense_repair_time = new Date();
            const actualRepaired = temple.defense_power - oldDefense;

            await player.save({ transaction: t });
            await temple.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'divine_temple_defense_repaired', {
                    repaired_amount: actualRepaired,
                    new_defense_power: temple.defense_power,
                    defense_max: temple.defense_max,
                    cost_spirit_stones: totalCost.toString()
                });
            } catch (e) {
                console.warn('[DivineTempleService] 推送修复禁制通知失败:', e.message);
            }

            return {
                success: true,
                message: `护界禁制修复 +${actualRepaired}，消耗灵石 ${totalCost.toString()}`,
                data: {
                    repaired_amount: actualRepaired,
                    new_defense_power: temple.defense_power,
                    defense_max: temple.defense_max,
                    cost_spirit_stones: totalCost.toString()
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineTempleService] repairDefense 异常:', err);
            throw err;
        }
    }

    /**
     * 兑换供奉
     * 用香火兑换灵石/神识丹/法则碎片等
     * @param {number} playerId - 玩家ID
     * @param {string} offeringId - 供奉ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async exchangeOffering(playerId, offeringId) {
        if (!offeringId || typeof offeringId !== 'string') {
            return { success: false, message: 'offering_id 必填且必须为字符串', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const temple = await PlayerDivineTemple.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!temple) {
                await t.rollback();
                return { success: false, message: '尚未创建神庙' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const templeCfg = config.divine_temple;

            // 查找供奉配置
            const offeringCfg = templeCfg.offerings.find(o => o.offering_id === offeringId);
            if (!offeringCfg) {
                await t.rollback();
                return { success: false, message: `供奉 ${offeringId} 不存在` };
            }

            // 神庙等级校验
            if (temple.temple_level < offeringCfg.min_temple_level) {
                await t.rollback();
                return {
                    success: false,
                    message: `神庙等级不足，需要 ${offeringCfg.min_temple_level} 级，当前 ${temple.temple_level} 级`
                };
            }

            // 香火消耗校验
            const currentIncense = Number(player.incense_balance || 0);
            if (currentIncense < offeringCfg.cost_incense) {
                await t.rollback();
                return {
                    success: false,
                    message: `香火不足，需要 ${offeringCfg.cost_incense}，当前 ${currentIncense}`
                };
            }

            // 扣减香火
            const newIncenseBalance = currentIncense - offeringCfg.cost_incense;
            player.incense_balance = newIncenseBalance;

            // 发放奖励
            let rewardDesc = '';
            switch (offeringCfg.reward_type) {
                case 'spirit_stones': {
                    const currentStones = BigInt(player.spirit_stones || 0);
                    player.spirit_stones = (currentStones + BigInt(offeringCfg.reward_amount)).toString();
                    rewardDesc = `灵石 +${offeringCfg.reward_amount}`;
                    break;
                }
                case 'divine_sense': {
                    // 增加神识余额与 player_divine_sense 表
                    player.divine_sense_balance = Number(player.divine_sense_balance || 0) + offeringCfg.reward_amount;
                    // 同步到 player_divine_sense 表
                    let senseRecord = await PlayerDivineSense.findOne({
                        where: { player_id: playerId },
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });
                    if (!senseRecord) {
                        senseRecord = await PlayerDivineSense.create({
                            player_id: playerId,
                            divine_sense_max: 100,
                            divine_sense_current: 0,
                            regen_rate_per_hour: 10,
                            total_quenched: 0,
                            total_consumed: 0
                        }, { transaction: t });
                    }
                    senseRecord.divine_sense_current = Math.min(
                        senseRecord.divine_sense_max,
                        senseRecord.divine_sense_current + offeringCfg.reward_amount
                    );
                    senseRecord.total_quenched += offeringCfg.reward_amount;
                    await senseRecord.save({ transaction: t });
                    rewardDesc = `神识 +${offeringCfg.reward_amount}`;
                    break;
                }
                case 'law_fragment': {
                    // 增加空间法则碎片
                    let lawRecord = await PlayerLaw.findOne({
                        where: { player_id: playerId },
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });
                    if (!lawRecord) {
                        lawRecord = await PlayerLaw.create({
                            player_id: playerId,
                            law_points: 0,
                            law_fragments_space: 0,
                            law_fragments_time: 0,
                            law_fragments_five_elements: 0,
                            law_fragments_soul: 0,
                            law_fragments_karma: 0
                        }, { transaction: t });
                    }
                    const oldCount = lawRecord.law_fragments_space;
                    lawRecord.law_fragments_space = oldCount + offeringCfg.reward_amount;
                    await lawRecord.save({ transaction: t });

                    // 写入碎片流水
                    await PlayerLawFragment.create({
                        player_id: playerId,
                        fragment_type: 'space',
                        change_amount: offeringCfg.reward_amount,
                        source: 'offering_exchange',
                        balance_after: lawRecord.law_fragments_space
                    }, { transaction: t });

                    rewardDesc = `空间法则碎片 +${offeringCfg.reward_amount}`;
                    break;
                }
                default:
                    await t.rollback();
                    return { success: false, message: `未知奖励类型：${offeringCfg.reward_type}` };
            }

            // 写入香火流水
            await PlayerIncenseLog.create({
                player_id: playerId,
                change_type: 'offering_exchange',
                change_amount: -offeringCfg.cost_incense,
                balance_after: newIncenseBalance,
                reason: `兑换供奉「${offeringCfg.name}」：${rewardDesc}`
            }, { transaction: t });

            await player.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'divine_temple_offering_exchanged', {
                    offering_id: offeringId,
                    offering_name: offeringCfg.name,
                    cost_incense: offeringCfg.cost_incense,
                    reward_description: rewardDesc,
                    current_incense: newIncenseBalance
                });
            } catch (e) {
                console.warn('[DivineTempleService] 推送兑换通知失败:', e.message);
            }

            return {
                success: true,
                message: `兑换「${offeringCfg.name}」成功！${rewardDesc}`,
                data: {
                    offering_id: offeringId,
                    offering_name: offeringCfg.name,
                    cost_incense: offeringCfg.cost_incense,
                    reward_description: rewardDesc,
                    current_incense: newIncenseBalance
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineTempleService] exchangeOffering 异常:', err);
            throw err;
        }
    }

    /**
     * GM 调整神庙等级
     * @param {number} playerId - 玩家ID
     * @param {number} level - 目标等级（1-10）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmSetLevel(playerId, level) {
        if (!Number.isInteger(level) || level < 1 || level > 10) {
            return { success: false, message: '神庙等级必须为 1-10 之间的整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const temple = await PlayerDivineTemple.findOne({ where: { player_id: playerId } });
        if (!temple) {
            return { success: false, message: '玩家尚未创建神庙' };
        }

        const config = configLoader.getConfig('late_stage_data');
        const templeCfg = config.divine_temple;

        const oldLevel = temple.temple_level;
        temple.temple_level = level;
        temple.defense_max = templeCfg.defense_max_base * (1 + (level - 1) * 0.5);
        // 同步解锁供奉池
        const unlockedOfferings = templeCfg.offerings
            .filter(o => o.min_temple_level <= level)
            .map(o => o.offering_id);
        temple.offering_pool = unlockedOfferings;

        await temple.save();

        return {
            success: true,
            message: `神庙等级已从 ${oldLevel} 调整为 ${level}`,
            data: {
                temple_id: temple.id,
                old_level: oldLevel,
                new_level: level,
                defense_max: temple.defense_max,
                offering_pool: temple.offering_pool
            }
        };
    }
}

module.exports = DivineTempleService;
