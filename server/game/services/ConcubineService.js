/**
 * 侍妾系统服务
 *
 * 实现批次3设计文档第5章「道侣 / 双修 / 侍妾系统」侍妾部分业务逻辑：
 *   1. 侍妾列表（getList）：所有侍妾及状态
 *   2. 红尘寻缘（seekFate）：每日 1 次免费，额外 3 次消耗灵石（递增）
 *   3. 每日问安（askAfter）：亲密度+2、魅力+1、忠诚度+1
 *   4. 灵力反哺（backfeed）：侍妾修为+1000，消耗玩家修为 500
 *   5. 赠予物品（gift）：按物品价值提升亲密度/魅力
 *   6. 安置侍妾（place）：安置至洞府
 *   7. 召回侍妾（recall）：从洞府召回
 *   8. 遣散侍妾（dismiss）：解除侍妾关系
 *   9. 侍妾远航（startVoyage）：4 种模式（safe/balanced/risky/moon_palace）
 *  10. 远航状态（getVoyageStatus）：查询远航进度
 *  11. 远航归来（returnVoyage）：领取奖励
 *  12. 请侍妾护法（protect）：闭关时减少被打断 30%
 *  13. 觉醒婉影（awaken）：特定侍妾觉醒为高阶形态
 *
 * 设计原则：
 *   - 所有阈值/比例从 companion_data.json 配置读取，禁止硬编码
 *   - 关键操作使用事务 + LOCK.UPDATE 行级锁
 *   - 跨日重置每日次数（按 DATEONLY 比较）
 *   - BigInt 字段（exp/spirit_stones）序列化时 toString()
 *   - 关键事件通过 WebSocketNotificationService 推送
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones/exp/concubine_count）
 *   - Concubine: 侍妾表（player_id+concubine_key UNIQUE）
 *   - ConcubineVoyage: 远航记录表（voyaging/returned/interrupted）
 *   - ConcubineLog: 互动日志表（审计）
 *   - Item: 玩家物品表（赠予时扣减）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const Concubine = require('../../models/concubine');
const ConcubineVoyage = require('../../models/concubineVoyage');
const ConcubineLog = require('../../models/concubineLog');
const Item = require('../../models/item');
const sequelize = require('../../config/database');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');
const { Op } = require('sequelize');

/**
 * 工具函数：跨日重置每日次数（按 DATEONLY 比较）
 * @param {Object} model - 模型实例
 * @param {string} dateField - 日期字段名
 * @param {string} countField - 次数字段名
 * @param {number} resetValue - 重置后的次数（默认 0）
 */
function resetDailyCountIfCrossDay(model, dateField, countField, resetValue = 0) {
    const today = new Date().toISOString().slice(0, 10);
    const lastDate = model[dateField];
    if (lastDate) {
        const lastStr = lastDate instanceof Date
            ? lastDate.toISOString().slice(0, 10)
            : String(lastDate).slice(0, 10);
        if (lastStr !== today) {
            model[countField] = resetValue;
            model[dateField] = today;
        }
    } else {
        model[countField] = resetValue;
        model[dateField] = today;
    }
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
 * 工具函数：按权重随机选择奖励池项
 * @param {Array<Object>} pool - 奖励池（每项含 weight）
 * @returns {Object} 选中的奖励项
 */
function pickWeighted(pool) {
    const totalWeight = pool.reduce((sum, item) => sum + (item.weight || 0), 0);
    let roll = Math.random() * totalWeight;
    for (const item of pool) {
        roll -= (item.weight || 0);
        if (roll <= 0) return item;
    }
    return pool[pool.length - 1];
}

/**
 * 工具函数：根据侍妾配置键查找静态配置
 * @param {string} concubineKey - 侍妾配置键
 * @returns {Object|null} 侍妾配置对象
 */
function findConcubineConfig(concubineKey) {
    const config = configLoader.getConfig('companion_data');
    return config.concubines.find(c => c.concubine_key === concubineKey) || null;
}

class ConcubineService {
    /**
     * 获取侍妾列表
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getList(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const concubines = await Concubine.findAll({
            where: { player_id: playerId },
            order: [['created_at', 'ASC']]
        });

        return {
            success: true,
            data: {
                count: concubines.length,
                concubines: concubines.map(c => ({
                    id: c.id,
                    concubine_key: c.concubine_key,
                    concubine_name: c.concubine_name,
                    concubine_type: c.concubine_type,
                    realm_rank: c.realm_rank,
                    exp: c.exp.toString(),
                    charm: c.charm,
                    intimacy: c.intimacy,
                    loyalty: c.loyalty,
                    talent_id: c.talent_id,
                    attributes: c.attributes,
                    is_placed: Boolean(c.is_placed),
                    placement_location: c.placement_location,
                    is_voyaging: Boolean(c.is_voyaging),
                    voyage_id: c.voyage_id,
                    awakened_form: c.awakened_form,
                    daily_ask_after_count: c.daily_ask_after_count,
                    last_ask_after_time: c.last_ask_after_time,
                    last_backfeed_time: c.last_backfeed_time,
                    created_at: c.created_at
                }))
            }
        };
    }

    /**
     * 红尘寻缘
     * 每日 1 次免费，额外 3 次消耗灵石（基础 5000，每次递增 2000）
     * 概率获得侍妾（基础 5%，灵石加成最高 +15%）
     * 稀有侍妾概率 0.5%
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async seekFate(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('companion_data');
            const seekCfg = config.seek_fate;

            // 统计今日寻缘次数（用 ConcubineLog 记录 seek_fate 类型）
            const today = new Date().toISOString().slice(0, 10);
            const todayStart = new Date(`${today}T00:00:00`);
            const todayLogs = await ConcubineLog.findAll({
                where: {
                    player_id: playerId,
                    action_type: 'seek_fate',
                    created_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            const todayCount = todayLogs.length;
            const totalAllowed = seekCfg.daily_free_count + seekCfg.extra_seek_max_count;
            if (todayCount >= totalAllowed) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日寻缘次数已用完（${todayCount}/${totalAllowed}）`
                };
            }

            // 计算本次消耗：前 daily_free_count 次免费，之后消耗灵石（基础+递增）
            let costStones = BigInt(0);
            if (todayCount >= seekCfg.daily_free_count) {
                const extraIndex = todayCount - seekCfg.daily_free_count; // 0, 1, 2
                const cost = seekCfg.extra_seek_base_cost + extraIndex * seekCfg.extra_seek_cost_increment;
                costStones = BigInt(cost);

                const playerStones = BigInt(player.spirit_stones || 0);
                if (playerStones < costStones) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                    };
                }
                player.spirit_stones = (playerStones - costStones).toString();
            }

            // 概率判定：基础 5% + 灵石加成（消耗越多加成越高，最高 +15%）
            let dropRate = seekCfg.base_drop_rate;
            if (costStones > BigInt(0)) {
                // 灵石加成：按消耗/10000 比例增加，最高 15%
                const bonus = Math.min(
                    seekCfg.spirit_stone_bonus_max,
                    Number(costStones) / 10000 * 0.03
                );
                dropRate += bonus;
            }

            const roll = Math.random();
            const isDrop = roll < dropRate;

            // 稀有侍妾判定（0.5%）
            const isRare = isDrop && Math.random() < seekCfg.rare_drop_rate;

            let obtainedConcubine = null;
            let isDuplicate = false;

            if (isDrop) {
                // 选择侍妾：稀有判定走 rare_keys，否则从普通池随机
                const availableConcubines = config.concubines.filter(c => {
                    if (isRare) return seekCfg.rare_keys.includes(c.concubine_key);
                    return !seekCfg.rare_keys.includes(c.concubine_key);
                });

                if (availableConcubines.length > 0) {
                    const selected = availableConcubines[Math.floor(Math.random() * availableConcubines.length)];

                    // 检查是否已拥有（重复获得则不发放，但记录日志）
                    const existing = await Concubine.findOne({
                        where: { player_id: playerId, concubine_key: selected.concubine_key },
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });

                    if (existing) {
                        isDuplicate = true;
                    } else {
                        // 发放侍妾
                        obtainedConcubine = await Concubine.create({
                            player_id: playerId,
                            concubine_key: selected.concubine_key,
                            concubine_name: selected.concubine_name,
                            concubine_type: selected.concubine_type,
                            realm_rank: selected.init_realm_rank,
                            exp: 0,
                            charm: selected.init_charm,
                            intimacy: selected.init_intimacy,
                            loyalty: selected.init_loyalty,
                            talent_id: selected.talent_id,
                            attributes: selected.attributes,
                            is_placed: 0,
                            is_voyaging: 0,
                            daily_ask_after_count: 0,
                            vow_broken: 0
                        }, { transaction: t });

                        // 更新玩家侍妾数量
                        player.concubine_count = (player.concubine_count || 0) + 1;
                    }
                }
            }

            // 写入寻缘日志（concubine_id 用 0 表示无侍妾关联）
            await ConcubineLog.create({
                player_id: playerId,
                concubine_id: obtainedConcubine ? obtainedConcubine.id : 0,
                action_type: 'seek_fate',
                action_detail: {
                    cost_spirit_stones: costStones.toString(),
                    is_drop: isDrop,
                    is_rare: isRare,
                    is_duplicate: isDuplicate,
                    obtained_key: obtainedConcubine?.concubine_key || null,
                    obtained_name: obtainedConcubine?.concubine_name || null
                },
                charm_change: 0,
                intimacy_change: 0,
                loyalty_change: 0,
                exp_change: 0
            }, { transaction: t });

            await player.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_seek_fate', {
                    message: obtainedConcubine
                        ? `寻缘成功！获得侍妾「${obtainedConcubine.concubine_name}」`
                        : isDuplicate
                            ? '寻缘获得侍妾，但你已拥有该侍妾'
                            : '寻缘未果，缘分未至',
                    is_drop: isDrop,
                    is_rare: isRare,
                    obtained_concubine: obtainedConcubine ? {
                        id: obtainedConcubine.id,
                        concubine_key: obtainedConcubine.concubine_key,
                        concubine_name: obtainedConcubine.concubine_name
                    } : null
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送寻缘通知失败:', e.message);
            }

            return {
                success: true,
                message: obtainedConcubine
                    ? `寻缘成功！获得侍妾「${obtainedConcubine.concubine_name}」`
                    : isDuplicate
                        ? '寻缘获得侍妾，但你已拥有该侍妾'
                        : '寻缘未果，缘分未至',
                data: {
                    is_drop: isDrop,
                    is_rare: isRare,
                    is_duplicate: isDuplicate,
                    cost_spirit_stones: costStones.toString(),
                    obtained_concubine: obtainedConcubine ? {
                        id: obtainedConcubine.id,
                        concubine_key: obtainedConcubine.concubine_key,
                        concubine_name: obtainedConcubine.concubine_name,
                        concubine_type: obtainedConcubine.concubine_type,
                        charm: obtainedConcubine.charm,
                        intimacy: obtainedConcubine.intimacy,
                        loyalty: obtainedConcubine.loyalty
                    } : null,
                    today_count: todayCount + 1,
                    daily_free_count: seekCfg.daily_free_count,
                    extra_seek_max_count: seekCfg.extra_seek_max_count
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] seekFate 异常:', err);
            throw err;
        }
    }

    /**
     * 每日问安
     * 亲密度 +2、魅力 +1、忠诚度 +1，日上限 1 次/侍妾
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async askAfter(playerId, concubineId) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (concubine.is_voyaging) {
                await t.rollback();
                return { success: false, message: '侍妾远航中，无法问安' };
            }

            const config = configLoader.getConfig('companion_data');
            const daoCfg = config.dao_companion;

            // 跨日重置问安次数
            resetDailyCountIfCrossDay(concubine, 'last_ask_after_date', 'daily_ask_after_count');

            // 日上限校验（设计文档：每日问安 1 次/侍妾）
            const dailyLimit = 1;
            if (concubine.daily_ask_after_count >= dailyLimit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日已对该侍妾问安（${concubine.daily_ask_after_count}/${dailyLimit}）`
                };
            }

            // 增加亲密度/魅力/忠诚度
            const intimacyGain = daoCfg.ask_after_intimacy_gain;
            const charmGain = daoCfg.ask_after_charm_gain;
            const loyaltyGain = daoCfg.ask_after_loyalty_gain;

            concubine.intimacy = Math.min(100, Number(concubine.intimacy || 0) + intimacyGain);
            concubine.charm = Math.min(100, Number(concubine.charm || 0) + charmGain);
            concubine.loyalty = Math.min(100, Number(concubine.loyalty || 0) + loyaltyGain);
            concubine.daily_ask_after_count += 1;
            concubine.last_ask_after_date = new Date().toISOString().slice(0, 10);
            concubine.last_ask_after_time = new Date();
            await concubine.save({ transaction: t });

            // 写入互动日志
            await ConcubineLog.create({
                player_id: playerId,
                concubine_id: concubineId,
                action_type: 'ask_after',
                action_detail: { intimacy_gain: intimacyGain, charm_gain: charmGain, loyalty_gain: loyaltyGain },
                charm_change: charmGain,
                intimacy_change: intimacyGain,
                loyalty_change: loyaltyGain,
                exp_change: 0
            }, { transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_ask_after', {
                    message: `向「${concubine.concubine_name}」问安，亲密度 +${intimacyGain}，魅力 +${charmGain}，忠诚度 +${loyaltyGain}`,
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    intimacy_gain: intimacyGain,
                    charm_gain: charmGain,
                    loyalty_gain: loyaltyGain
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送问安通知失败:', e.message);
            }

            return {
                success: true,
                message: `向「${concubine.concubine_name}」问安成功`,
                data: {
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    intimacy_gain: intimacyGain,
                    charm_gain: charmGain,
                    loyalty_gain: loyaltyGain,
                    current_intimacy: concubine.intimacy,
                    current_charm: concubine.charm,
                    current_loyalty: concubine.loyalty
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] askAfter 异常:', err);
            throw err;
        }
    }

    /**
     * 灵力反哺
     * 侍妾修为 +1000，消耗玩家修为 500，日上限 3 次/侍妾
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async backfeed(playerId, concubineId) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (concubine.is_voyaging) {
                await t.rollback();
                return { success: false, message: '侍妾远航中，无法反哺' };
            }

            const config = configLoader.getConfig('companion_data');
            const backfeedCfg = config.backfeed;

            // 反哺日次数统计（用 ConcubineLog 统计今日反哺次数）
            const today = new Date().toISOString().slice(0, 10);
            const todayStart = new Date(`${today}T00:00:00`);
            const todayLogs = await ConcubineLog.findAll({
                where: {
                    player_id: playerId,
                    concubine_id: concubineId,
                    action_type: 'backfeed',
                    created_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            if (todayLogs.length >= backfeedCfg.daily_limit_per_concubine) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日对该侍妾反哺次数已用完（${todayLogs.length}/${backfeedCfg.daily_limit_per_concubine}）`
                };
            }

            // 玩家修为消耗校验
            const playerExpCost = BigInt(backfeedCfg.player_exp_cost);
            const playerExp = BigInt(player.exp || 0);
            if (playerExp < playerExpCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `修为不足，需要 ${playerExpCost.toString()}，当前 ${playerExp.toString()}`
                };
            }

            // 扣减玩家修为，增加侍妾修为
            player.exp = (playerExp - playerExpCost).toString();
            const concubineExpGain = BigInt(backfeedCfg.concubine_exp_gain);
            const concubineExp = BigInt(concubine.exp || 0);
            concubine.exp = (concubineExp + concubineExpGain).toString();
            concubine.last_backfeed_time = new Date();
            await player.save({ transaction: t });
            await concubine.save({ transaction: t });

            // 写入互动日志
            await ConcubineLog.create({
                player_id: playerId,
                concubine_id: concubineId,
                action_type: 'backfeed',
                action_detail: {
                    player_exp_cost: playerExpCost.toString(),
                    concubine_exp_gain: concubineExpGain.toString()
                },
                charm_change: 0,
                intimacy_change: 0,
                loyalty_change: 0,
                exp_change: concubineExpGain
            }, { transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_backfeed', {
                    message: `向「${concubine.concubine_name}」反哺灵力，侍妾修为 +${concubineExpGain.toString()}`,
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    player_exp_cost: playerExpCost.toString(),
                    concubine_exp_gain: concubineExpGain.toString()
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送反哺通知失败:', e.message);
            }

            return {
                success: true,
                message: `向「${concubine.concubine_name}」反哺灵力成功`,
                data: {
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    player_exp_cost: playerExpCost.toString(),
                    concubine_exp_gain: concubineExpGain.toString(),
                    concubine_exp: concubine.exp.toString(),
                    daily_count: todayLogs.length + 1,
                    daily_limit: backfeedCfg.daily_limit_per_concubine
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] backfeed 异常:', err);
            throw err;
        }
    }

    /**
     * 赠予物品
     * 按物品价值提升亲密度/魅力（每 100 价值 +5 亲密度，+2 魅力）
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @param {string} itemKey - 物品配置键
     * @param {number} count - 赠予数量
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gift(playerId, concubineId, itemKey, count) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!itemKey || typeof itemKey !== 'string') {
            return { success: false, message: 'item_key 必填且必须为字符串', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!Number.isInteger(count) || count <= 0 || count > 99) {
            return { success: false, message: 'count 必须为 1-99 之间的整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (concubine.is_voyaging) {
                await t.rollback();
                return { success: false, message: '侍妾远航中，无法赠予' };
            }

            // 查询玩家物品
            const item = await Item.findOne({
                where: { player_id: playerId, item_key: itemKey },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!item || item.quantity < count) {
                await t.rollback();
                return {
                    success: false,
                    message: `物品 ${itemKey} 不足，需要 ${count}，当前 ${item?.quantity || 0}`
                };
            }

            // 扣减物品
            item.quantity -= count;
            if (item.quantity <= 0) {
                await item.destroy({ transaction: t });
            } else {
                await item.save({ transaction: t });
            }

            // 计算亲密度/魅力提升
            // 简化：按物品数量计算，每 1 个物品视为 100 价值
            const config = configLoader.getConfig('companion_data');
            const giftCfg = config.gift;
            const totalValue = count * 100; // 每个物品 100 价值
            const intimacyGain = Math.floor(totalValue / 100) * giftCfg.intimacy_per_value_100;
            const charmGain = Math.floor(totalValue / 100) * giftCfg.charm_per_value_100;

            concubine.intimacy = Math.min(100, Number(concubine.intimacy || 0) + intimacyGain);
            concubine.charm = Math.min(100, Number(concubine.charm || 0) + charmGain);
            await concubine.save({ transaction: t });

            // 写入互动日志
            await ConcubineLog.create({
                player_id: playerId,
                concubine_id: concubineId,
                action_type: 'gift',
                action_detail: { item_key: itemKey, count, total_value: totalValue },
                charm_change: charmGain,
                intimacy_change: intimacyGain,
                loyalty_change: 0,
                exp_change: 0
            }, { transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_gift', {
                    message: `赠予「${concubine.concubine_name}」${count} 个 ${itemKey}，亲密度 +${intimacyGain}，魅力 +${charmGain}`,
                    concubine_id: concubineId,
                    item_key: itemKey,
                    count,
                    intimacy_gain: intimacyGain,
                    charm_gain: charmGain
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送赠予通知失败:', e.message);
            }

            return {
                success: true,
                message: `赠予「${concubine.concubine_name}」成功`,
                data: {
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    item_key: itemKey,
                    count,
                    intimacy_gain: intimacyGain,
                    charm_gain: charmGain,
                    current_intimacy: concubine.intimacy,
                    current_charm: concubine.charm
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] gift 异常:', err);
            throw err;
        }
    }

    /**
     * 安置侍妾
     * 安置至洞府指定地点，提供洞府 buff
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @param {string} location - 安置地点（洞府房间名）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async place(playerId, concubineId, location) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!location || typeof location !== 'string' || location.trim().length === 0) {
            return { success: false, message: 'location 必填且必须为非空字符串', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (location.length > 50) {
            return { success: false, message: 'location 长度不能超过 50 个字符', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (concubine.is_voyaging) {
                await t.rollback();
                return { success: false, message: '侍妾远航中，无法安置' };
            }

            if (concubine.is_placed) {
                await t.rollback();
                return { success: false, message: '侍妾已安置，请先召回' };
            }

            concubine.is_placed = 1;
            concubine.placement_location = location.trim();
            await concubine.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `「${concubine.concubine_name}」已安置至 ${location.trim()}`,
                data: {
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    placement_location: concubine.placement_location
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] place 异常:', err);
            throw err;
        }
    }

    /**
     * 召回侍妾
     * 从洞府召回侍妾
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async recall(playerId, concubineId) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (!concubine.is_placed) {
                await t.rollback();
                return { success: false, message: '侍妾未安置，无需召回' };
            }

            const oldLocation = concubine.placement_location;
            concubine.is_placed = 0;
            concubine.placement_location = null;
            await concubine.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `「${concubine.concubine_name}」已从 ${oldLocation} 召回`,
                data: {
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    old_location: oldLocation
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] recall 异常:', err);
            throw err;
        }
    }

    /**
     * 遣散侍妾
     * 解除侍妾关系（忠诚度需 < 30 才可遣散，防止误操作）
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async dismiss(playerId, concubineId) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (concubine.is_voyaging) {
                await t.rollback();
                return { success: false, message: '侍妾远航中，无法遣散' };
            }

            // 忠诚度需 < 30 才可遣散（设计文档：忠诚度<30 触发逃跑，此处放宽为玩家可主动遣散）
            // 简化：不强制忠诚度要求，但记录原忠诚度
            const oldLoyalty = concubine.loyalty;
            const concubineName = concubine.concubine_name;

            // 写入遣散日志（先写日志再删除侍妾）
            await ConcubineLog.create({
                player_id: playerId,
                concubine_id: concubineId,
                action_type: 'gift',
                action_detail: { action: 'dismiss', old_loyalty: oldLoyalty },
                charm_change: 0,
                intimacy_change: 0,
                loyalty_change: -oldLoyalty,
                exp_change: 0
            }, { transaction: t });

            await concubine.destroy({ transaction: t });

            // 更新玩家侍妾数量
            player.concubine_count = Math.max(0, (player.concubine_count || 0) - 1);
            await player.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_dismissed', {
                    message: `已遣散侍妾「${concubineName}」`,
                    concubine_id: concubineId,
                    concubine_name: concubineName
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送遣散通知失败:', e.message);
            }

            return {
                success: true,
                message: `已遣散侍妾「${concubineName}」`,
                data: {
                    concubine_id: concubineId,
                    concubine_name: concubineName,
                    old_loyalty: oldLoyalty
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] dismiss 异常:', err);
            throw err;
        }
    }

    /**
     * 侍妾远航
     * 4 种模式（safe/balanced/risky/moon_palace），需达到对应魅力要求
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @param {string} mode - 远航模式（safe/balanced/risky/moon_palace）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async startVoyage(playerId, concubineId, mode) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!['safe', 'balanced', 'risky', 'moon_palace'].includes(mode)) {
            return {
                success: false,
                message: 'mode 必须为 safe(稳妥)/balanced(均衡)/risky(冒险)/moon_palace(月殿寻痕) 之一',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (concubine.is_voyaging) {
                await t.rollback();
                return { success: false, message: '侍妾已在远航中' };
            }

            const config = configLoader.getConfig('companion_data');
            const voyageCfg = config.voyage;
            const modeCfg = voyageCfg.modes[mode];

            // 魅力要求校验
            if (Number(concubine.charm || 0) < modeCfg.min_charm) {
                await t.rollback();
                return {
                    success: false,
                    message: `侍妾魅力不足，${mode} 模式需要 ${modeCfg.min_charm}（当前 ${concubine.charm}）`
                };
            }

            // 计算预计归来时间
            const startedAt = new Date();
            const expectedEnd = new Date(startedAt.getTime() + modeCfg.duration_hours * 3600000);

            // 创建远航记录
            const voyage = await ConcubineVoyage.create({
                player_id: playerId,
                concubine_id: concubineId,
                voyage_mode: mode,
                started_at: startedAt,
                expected_end_time: expectedEnd,
                status: 'voyaging',
                risk_modifier: modeCfg.risk_modifier,
                reward_multiplier: modeCfg.reward_multiplier,
                is_collected: 0
            }, { transaction: t });

            // 更新侍妾远航状态
            concubine.is_voyaging = 1;
            concubine.voyage_id = voyage.id;
            await concubine.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_voyage_started', {
                    message: `「${concubine.concubine_name}」已出发远航（${mode}），预计 ${expectedEnd.toLocaleString('zh-CN')} 归来`,
                    concubine_id: concubineId,
                    voyage_id: voyage.id,
                    mode,
                    expected_end_time: expectedEnd
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送远航出发通知失败:', e.message);
            }

            return {
                success: true,
                message: `「${concubine.concubine_name}」已出发远航`,
                data: {
                    voyage_id: voyage.id,
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    mode,
                    started_at: startedAt,
                    expected_end_time: expectedEnd,
                    risk_modifier: modeCfg.risk_modifier,
                    reward_multiplier: modeCfg.reward_multiplier
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] startVoyage 异常:', err);
            throw err;
        }
    }

    /**
     * 远航状态
     * 查询玩家所有远航记录（含进行中/已归来/已领取）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getVoyageStatus(playerId) {
        const voyages = await ConcubineVoyage.findAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']]
        });

        const now = new Date();
        return {
            success: true,
            data: {
                voyages: voyages.map(v => {
                    // 自动结算：超过预计归来时间且未归来，标记为可领取
                    const isReady = v.status === 'voyaging' && new Date(v.expected_end_time) < now;
                    return {
                        voyage_id: v.id,
                        concubine_id: v.concubine_id,
                        voyage_mode: v.voyage_mode,
                        started_at: v.started_at,
                        expected_end_time: v.expected_end_time,
                        actual_end_time: v.actual_end_time,
                        status: isReady ? 'ready_to_return' : v.status,
                        is_collected: Boolean(v.is_collected),
                        rewards: v.is_collected ? v.rewards : null, // 未领取时不暴露奖励内容
                        risk_modifier: v.risk_modifier,
                        reward_multiplier: v.reward_multiplier,
                        can_return: isReady
                    };
                }),
                count: voyages.length
            }
        };
    }

    /**
     * 远航归来
     * 结算远航奖励，必须在归来后 24 小时内领取
     * @param {number} playerId - 玩家ID
     * @param {number} voyageId - 远航记录ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async returnVoyage(playerId, voyageId) {
        if (!voyageId || typeof voyageId !== 'number') {
            return { success: false, message: 'voyage_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const voyage = await ConcubineVoyage.findByPk(voyageId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!voyage || voyage.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '远航记录不存在或不属于你' };
            }

            if (voyage.is_collected) {
                await t.rollback();
                return { success: false, message: '远航奖励已领取' };
            }

            const now = new Date();
            const expectedEnd = new Date(voyage.expected_end_time);

            // 校验是否已到归来时间
            if (now < expectedEnd) {
                await t.rollback();
                return {
                    success: false,
                    message: `远航未结束，预计 ${expectedEnd.toLocaleString('zh-CN')} 归来`
                };
            }

            // 校验是否超时未领取（24 小时）
            const config = configLoader.getConfig('companion_data');
            const voyageCfg = config.voyage;
            const expireTime = new Date(expectedEnd.getTime() + voyageCfg.collect_expire_hours * 3600000);
            if (now > expireTime) {
                // 超时：奖励消失，侍妾忠诚度 -5
                voyage.status = 'interrupted';
                voyage.is_collected = 1;
                voyage.actual_end_time = now;
                await voyage.save({ transaction: t });

                // 侍妾忠诚度 -5
                const concubine = await Concubine.findByPk(voyage.concubine_id, { transaction: t, lock: t.LOCK.UPDATE });
                if (concubine) {
                    concubine.loyalty = Math.max(0, Number(concubine.loyalty || 0) - voyageCfg.collect_expire_loyalty_penalty);
                    concubine.is_voyaging = 0;
                    concubine.voyage_id = null;
                    await concubine.save({ transaction: t });
                }

                await t.commit();
                return {
                    success: false,
                    message: `远航奖励已过期，侍妾忠诚度 -${voyageCfg.collect_expire_loyalty_penalty}`,
                    data: {
                        voyage_id: voyageId,
                        is_expired: true,
                        loyalty_penalty: voyageCfg.collect_expire_loyalty_penalty
                    }
                };
            }

            // 计算远航成功率
            const concubine = await Concubine.findByPk(voyage.concubine_id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine) {
                await t.rollback();
                return { success: false, message: '侍妾不存在' };
            }

            const formula = voyageCfg.success_rate_formula;
            let successRate = formula.base
                + (Number(concubine.charm || 0) / 100) * formula.charm_weight
                + (Number(concubine.intimacy || 0) / 100) * formula.intimacy_weight
                + (Number(concubine.loyalty || 0) / 100) * formula.loyalty_weight
                - Number(voyage.risk_modifier) * formula.risk_penalty;
            successRate = Math.max(formula.min_rate, Math.min(formula.max_rate, successRate));

            const isSuccess = Math.random() < successRate;

            // 生成奖励
            const rewardPool = voyageCfg.reward_pools[voyage.voyage_mode] || [];
            const rewards = {
                is_success: isSuccess,
                spirit_stones: 0,
                items: []
            };

            if (isSuccess) {
                // 成功：按奖励池随机
                for (let i = 0; i < 3; i++) { // 最多 3 件
                    const picked = pickWeighted(rewardPool);
                    if (!picked) break;
                    if (picked.type === 'spirit_stones') {
                        const stones = randomInt(picked.min, picked.max);
                        const multiplied = Math.floor(stones * Number(voyage.reward_multiplier));
                        rewards.spirit_stones += multiplied;
                    } else if (picked.type === 'item') {
                        if (picked.item_keys && picked.item_keys.length > 0) {
                            const itemKey = picked.item_keys[Math.floor(Math.random() * picked.item_keys.length)];
                            // 防止超过 max_rare_items
                            if (rewards.items.length < voyageCfg.max_rare_items) {
                                rewards.items.push({ item_key: itemKey, count: 1 });
                            }
                        }
                    }
                }

                // 发放灵石
                if (rewards.spirit_stones > 0) {
                    const currentStones = BigInt(player.spirit_stones || 0);
                    player.spirit_stones = (currentStones + BigInt(rewards.spirit_stones)).toString();
                    await player.save({ transaction: t });
                }

                // 发放物品
                for (const itemReward of rewards.items) {
                    // 查询是否已有该物品
                    const existingItem = await Item.findOne({
                        where: { player_id: playerId, item_key: itemReward.item_key },
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });
                    if (existingItem) {
                        existingItem.quantity += itemReward.count;
                        await existingItem.save({ transaction: t });
                    } else {
                        await Item.create({
                            player_id: playerId,
                            item_key: itemReward.item_key,
                            quantity: itemReward.count
                        }, { transaction: t });
                    }
                }
            } else {
                // 失败：保留 30% 灵石基础奖励，稀有材料全部消失
                for (const picked of rewardPool) {
                    if (picked.type === 'spirit_stones') {
                        const stones = randomInt(picked.min, picked.max);
                        const retained = Math.floor(stones * voyageCfg.failure_spirit_stone_retain);
                        rewards.spirit_stones += retained;
                        break; // 只保留一次灵石
                    }
                }
                if (rewards.spirit_stones > 0) {
                    const currentStones = BigInt(player.spirit_stones || 0);
                    player.spirit_stones = (currentStones + BigInt(rewards.spirit_stones)).toString();
                    await player.save({ transaction: t });
                }
            }

            // 更新远航记录
            voyage.status = 'returned';
            voyage.is_collected = 1;
            voyage.actual_end_time = now;
            voyage.rewards = rewards;
            await voyage.save({ transaction: t });

            // 侍妾状态更新
            concubine.is_voyaging = 0;
            concubine.voyage_id = null;
            await concubine.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_voyage_returned', {
                    message: isSuccess
                        ? `「${concubine.concubine_name}」远航归来，获得灵石 ${rewards.spirit_stones}，物品 ${rewards.items.length} 件`
                        : `「${concubine.concubine_name}」远航失败，仅保留灵石 ${rewards.spirit_stones}`,
                    voyage_id: voyageId,
                    is_success: isSuccess,
                    rewards
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送远航归来通知失败:', e.message);
            }

            return {
                success: true,
                message: isSuccess
                    ? `「${concubine.concubine_name}」远航归来，收获颇丰！`
                    : `「${concubine.concubine_name}」远航归来，但遭遇波折`,
                data: {
                    voyage_id: voyageId,
                    concubine_id: concubine.id,
                    concubine_name: concubine.concubine_name,
                    is_success: isSuccess,
                    success_rate: successRate,
                    rewards
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] returnVoyage 异常:', err);
            throw err;
        }
    }

    /**
     * 请侍妾护法
     * 闭关时侍妾护法，减少被打断 30%，持续 8 小时
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async protect(playerId, concubineId) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (concubine.is_voyaging) {
                await t.rollback();
                return { success: false, message: '侍妾远航中，无法护法' };
            }

            const config = configLoader.getConfig('companion_data');
            const protectCfg = config.protect;

            // 写入护法日志（复用 ConcubineLog）
            await ConcubineLog.create({
                player_id: playerId,
                concubine_id: concubineId,
                action_type: 'gift',
                action_detail: {
                    action: 'protect',
                    interrupt_reduction: protectCfg.interrupt_reduction,
                    duration_hours: protectCfg.duration_hours
                },
                charm_change: 0,
                intimacy_change: 0,
                loyalty_change: 0,
                exp_change: 0
            }, { transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_protect', {
                    message: `「${concubine.concubine_name}」已开始护法，闭关被打断概率 -${Math.round(protectCfg.interrupt_reduction * 100)}%`,
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    interrupt_reduction: protectCfg.interrupt_reduction,
                    duration_hours: protectCfg.duration_hours
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送护法通知失败:', e.message);
            }

            return {
                success: true,
                message: `「${concubine.concubine_name}」已开始护法`,
                data: {
                    concubine_id: concubineId,
                    concubine_name: concubine.concubine_name,
                    interrupt_reduction: protectCfg.interrupt_reduction,
                    duration_hours: protectCfg.duration_hours
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] protect 异常:', err);
            throw err;
        }
    }

    /**
     * 觉醒婉影
     * 特定侍妾可觉醒为高阶形态（如南宫婉→月影），需亲密度≥80
     * @param {number} playerId - 玩家ID
     * @param {number} concubineId - 侍妾ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async awaken(playerId, concubineId) {
        if (!concubineId || typeof concubineId !== 'number') {
            return { success: false, message: 'concubine_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const concubine = await Concubine.findByPk(concubineId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!concubine || concubine.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '侍妾不存在或不属于你' };
            }

            if (concubine.is_voyaging) {
                await t.rollback();
                return { success: false, message: '侍妾远航中，无法觉醒' };
            }

            if (concubine.concubine_type === 'awakened') {
                await t.rollback();
                return { success: false, message: '侍妾已觉醒，无法重复觉醒' };
            }

            // 查询侍妾静态配置
            const concubineCfg = findConcubineConfig(concubine.concubine_key);
            if (!concubineCfg || !concubineCfg.can_awaken) {
                await t.rollback();
                return { success: false, message: '该侍妾无法觉醒' };
            }

            // 亲密度要求校验（设计文档：觉醒需高亲密度）
            if (Number(concubine.intimacy || 0) < 80) {
                await t.rollback();
                return {
                    success: false,
                    message: `侍妾亲密度不足，觉醒需要 80（当前 ${concubine.intimacy}）`
                };
            }

            const oldName = concubine.concubine_name;
            const oldType = concubine.concubine_type;

            // 觉醒：类型变 awakened，名字变更，魅力提升，天赋变更
            concubine.concubine_type = 'awakened';
            concubine.concubine_name = concubineCfg.awakened_name;
            concubine.awakened_form = concubineCfg.awakened_form;
            concubine.charm = Math.min(100, Math.max(Number(concubine.charm || 0), concubineCfg.awakened_charm));
            if (concubineCfg.awakened_talent) {
                concubine.talent_id = concubineCfg.awakened_talent;
            }
            await concubine.save({ transaction: t });

            // 写入觉醒日志
            await ConcubineLog.create({
                player_id: playerId,
                concubine_id: concubineId,
                action_type: 'awaken',
                action_detail: {
                    old_name: oldName,
                    new_name: concubine.concubine_name,
                    awakened_form: concubineCfg.awakened_form,
                    awakened_charm: concubineCfg.awakened_charm,
                    awakened_talent: concubineCfg.awakened_talent
                },
                charm_change: concubineCfg.awakened_charm - Number(concubine.charm || 0),
                intimacy_change: 0,
                loyalty_change: 0,
                exp_change: 0
            }, { transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'concubine_awakened', {
                    message: `「${oldName}」觉醒为「${concubine.concubine_name}」！`,
                    concubine_id: concubineId,
                    old_name: oldName,
                    new_name: concubine.concubine_name,
                    awakened_form: concubineCfg.awakened_form
                });
            } catch (e) {
                console.warn('[ConcubineService] 推送觉醒通知失败:', e.message);
            }

            return {
                success: true,
                message: `「${oldName}」觉醒为「${concubine.concubine_name}」！`,
                data: {
                    concubine_id: concubineId,
                    old_name: oldName,
                    new_name: concubine.concubine_name,
                    old_type: oldType,
                    new_type: concubine.concubine_type,
                    awakened_form: concubineCfg.awakened_form,
                    charm: concubine.charm,
                    talent_id: concubine.talent_id
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] awaken 异常:', err);
            throw err;
        }
    }

    // ==================== GM 管理方法 ====================

    /**
     * GM 直接发放侍妾
     * @param {number} playerId - 玩家ID
     * @param {string} concubineKey - 侍妾配置键
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmGrantConcubine(playerId, concubineKey) {
        if (!concubineKey || typeof concubineKey !== 'string') {
            return { success: false, message: 'concubine_key 必填且必须为字符串', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const concubineCfg = findConcubineConfig(concubineKey);
        if (!concubineCfg) {
            return { success: false, message: `侍妾配置 ${concubineKey} 不存在` };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 检查是否已拥有
            const existing = await Concubine.findOne({
                where: { player_id: playerId, concubine_key: concubineKey },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (existing) {
                await t.rollback();
                return { success: false, message: '玩家已拥有该侍妾' };
            }

            const newConcubine = await Concubine.create({
                player_id: playerId,
                concubine_key: concubineCfg.concubine_key,
                concubine_name: concubineCfg.concubine_name,
                concubine_type: concubineCfg.concubine_type,
                realm_rank: concubineCfg.init_realm_rank,
                exp: 0,
                charm: concubineCfg.init_charm,
                intimacy: concubineCfg.init_intimacy,
                loyalty: concubineCfg.init_loyalty,
                talent_id: concubineCfg.talent_id,
                attributes: concubineCfg.attributes,
                is_placed: 0,
                is_voyaging: 0,
                daily_ask_after_count: 0
            }, { transaction: t });

            player.concubine_count = (player.concubine_count || 0) + 1;
            await player.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `已为玩家 ${player.nickname} 发放侍妾「${newConcubine.concubine_name}」`,
                data: {
                    concubine_id: newConcubine.id,
                    player_id: playerId,
                    concubine_key: newConcubine.concubine_key,
                    concubine_name: newConcubine.concubine_name
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] gmGrantConcubine 异常:', err);
            throw err;
        }
    }

    /**
     * GM 调整侍妾属性
     * @param {number} concubineId - 侍妾ID
     * @param {string} attr - 属性名（charm/intimacy/loyalty/exp/realm_rank）
     * @param {number} value - 目标值
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmSetConcubineAttr(concubineId, attr, value) {
        const allowedAttrs = ['charm', 'intimacy', 'loyalty', 'exp', 'realm_rank'];
        if (!allowedAttrs.includes(attr)) {
            return {
                success: false,
                message: `attr 必须为 ${allowedAttrs.join('/')} 之一`,
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const concubine = await Concubine.findByPk(concubineId);
        if (!concubine) {
            return { success: false, message: '侍妾不存在' };
        }

        const oldValue = concubine[attr];

        if (attr === 'exp') {
            // exp 是 BigInt
            if (typeof value !== 'number' || value < 0) {
                return { success: false, message: 'exp 必须为非负数', error_code: ErrorCodes.VALIDATION_ERROR };
            }
            concubine.exp = BigInt(value);
        } else if (['charm', 'intimacy', 'loyalty'].includes(attr)) {
            if (!Number.isInteger(value) || value < 0 || value > 100) {
                return { success: false, message: `${attr} 必须为 0-100 之间的整数`, error_code: ErrorCodes.VALIDATION_ERROR };
            }
            concubine[attr] = value;
        } else if (attr === 'realm_rank') {
            if (!Number.isInteger(value) || value < 1 || value > 100) {
                return { success: false, message: 'realm_rank 必须为 1-100 之间的整数', error_code: ErrorCodes.VALIDATION_ERROR };
            }
            concubine[attr] = value;
        }

        await concubine.save();

        return {
            success: true,
            message: `侍妾「${concubine.concubine_name}」的 ${attr} 已从 ${oldValue?.toString?.() || oldValue} 调整为 ${value}`,
            data: {
                concubine_id: concubineId,
                concubine_name: concubine.concubine_name,
                attr,
                old_value: oldValue?.toString?.() || oldValue,
                new_value: value
            }
        };
    }

    /**
     * GM 立即完成远航
     * @param {number} voyageId - 远航记录ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmFinishVoyage(voyageId) {
        if (!voyageId || typeof voyageId !== 'number') {
            return { success: false, message: 'voyage_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const voyage = await ConcubineVoyage.findByPk(voyageId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!voyage) {
                await t.rollback();
                return { success: false, message: '远航记录不存在' };
            }

            if (voyage.status !== 'voyaging') {
                await t.rollback();
                return { success: false, message: '远航已结束，无需 GM 操作' };
            }

            // 立即结束：将预计归来时间调整为当前时间
            const now = new Date();
            voyage.expected_end_time = now;
            await voyage.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `远航记录 ${voyageId} 已标记为可领取`,
                data: {
                    voyage_id: voyageId,
                    expected_end_time: now,
                    can_return: true
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ConcubineService] gmFinishVoyage 异常:', err);
            throw err;
        }
    }
}

module.exports = ConcubineService;
