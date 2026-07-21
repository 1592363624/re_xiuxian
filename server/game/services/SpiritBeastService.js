/**
 * 灵兽系统服务
 *
 * 实现灵兽系统完整业务逻辑：
 *   1. 灵兽图鉴（getBeastTypes）：返回所有灵兽种类静态配置
 *   2. 我的灵兽（getMyBeasts）：玩家拥有的灵兽列表
 *   3. 灵兽详情（getBeastDetail）：单只灵兽完整信息 + 战力 + 元素相克
 *   4. 寻觅捕获（catchBeast）：按 catch_chance 概率捕获，消耗灵力，每日次数限制
 *   5. 喂养（feedBeast）：消耗灵石，增加经验/忠诚度，1 小时冷却
 *   6. 互动（interactBeast）：增加忠诚度+经验，10 分钟冷却
 *   7. 设置出战（setActiveBeast）：同时仅 1 只出战
 *   8. 放生（releaseBeast）：返还部分灵石
 *   9. 战力计算（calculateCombatPower）：综合属性评估
 *  10. 元素相克（getElementMultiplier）：五行相生相克倍率
 *  11. 今日状态（getDailyStatus）：今日捕获次数/上限
 *
 * 设计原则：
 *   - 所有阈值/比例从 spirit_beast_data.json 配置读取，禁止硬编码
 *   - 关键操作使用事务 + LOCK.UPDATE 行级锁
 *   - BigInt 字段（exp/hp_max/spirit_stones/mp_current）序列化时 toString()
 *   - 关键事件通过 WebSocketNotificationService 推送
 *   - 每日次数通过 spirit_beasts.caught_at 统计（避免改 Player 表）
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones/mp_current/realm/realm_rank）
 *   - SpiritBeast: 灵兽实例表（player_id/beast_key/element/level/star_level...）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const SpiritBeast = require('../../models/spiritBeast');
const sequelize = require('../../config/database');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');
const { Op } = require('sequelize');

/**
 * 工具函数：获取今日零点时间
 * 用于跨日重置每日捕获次数统计
 * @returns {Date} 今日零点 Date 对象
 */
function getTodayStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/**
 * 工具函数：计算灵兽当前等级所需经验上限
 * 公式：level_up_exp_base * (level ^ level_up_exp_growth)
 * @param {number} level - 当前等级
 * @param {Object} settings - 配置 settings 节
 * @returns {number} 升级所需经验
 */
function calcExpCap(level, settings) {
    const base = Number(settings.level_up_exp_base) || 100;
    const growth = Number(settings.level_up_exp_growth) || 1.5;
    return Math.floor(base * Math.pow(level, growth));
}

/**
 * 工具函数：根据配置基础值和灵兽等级/星级计算实际属性
 * 公式：base * (1 + (level-1)*0.1) * star_level
 * @param {number} baseValue - 配置中的基础值
 * @param {number} level - 灵兽等级
 * @param {number} starLevel - 星级
 * @returns {number} 计算后的属性值
 */
function calcAttr(baseValue, level, starLevel) {
    const levelFactor = 1 + (level - 1) * 0.1;
    return Math.floor(Number(baseValue) * levelFactor * starLevel);
}

class SpiritBeastService {
    /**
     * 获取所有灵兽种类（图鉴）
     * 返回配置中的全部灵兽种类 + 玩家已捕获标记
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getBeastTypes(playerId) {
        const config = configLoader.getConfig('spirit_beast_data');
        const beastTypes = config.beast_types || [];
        const elements = config.elements || {};
        const rarityConfig = config.rarity_config || {};

        // 查询玩家已捕获的灵兽种类（去重）
        const myBeasts = await SpiritBeast.findAll({
            where: { player_id: playerId },
            attributes: ['beast_key', 'star_level', 'level', 'is_active'],
            raw: true
        });
        const myBeastMap = new Map();
        for (const b of myBeasts) {
            const existing = myBeastMap.get(b.beast_key);
            // 保留最高星级的记录用于图鉴显示
            if (!existing || b.star_level > existing.star_level) {
                myBeastMap.set(b.beast_key, b);
            }
        }

        const list = beastTypes.map(bt => ({
            beast_key: bt.beast_key,
            name: bt.name,
            element: bt.element,
            element_name: elements[bt.element]?.name || bt.element,
            element_color: elements[bt.element]?.color || '#9ca3af',
            rarity: bt.rarity,
            rarity_name: rarityConfig[bt.rarity]?.name || bt.rarity,
            rarity_color: rarityConfig[bt.rarity]?.color || '#9ca3af',
            base_hp: bt.base_hp,
            base_atk: bt.base_atk,
            base_def: bt.base_def,
            base_speed: bt.base_speed,
            min_realm_rank: bt.min_realm_rank,
            catch_chance: bt.catch_chance,
            catch_cost_mp: bt.catch_cost_mp,
            feed_exp: bt.feed_exp,
            description: bt.description,
            // 玩家捕获情况
            caught: myBeastMap.has(bt.beast_key),
            my_best: myBeastMap.get(bt.beast_key) || null
        }));

        return {
            success: true,
            data: {
                beast_types: list,
                elements: Object.entries(elements).map(([key, val]) => ({
                    key,
                    name: val.name,
                    strong_against: val.strong_against,
                    weak_against: val.weak_against,
                    color: val.color
                })),
                rarity_config: Object.entries(rarityConfig).map(([key, val]) => ({
                    key,
                    name: val.name,
                    color: val.color
                }))
            }
        };
    }

    /**
     * 获取我的灵兽列表
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getMyBeasts(playerId) {
        const beasts = await SpiritBeast.findAll({
            where: { player_id: playerId },
            order: [['is_active', 'DESC'], ['star_level', 'DESC'], ['level', 'DESC'], ['caught_at', 'DESC']]
        });

        const config = configLoader.getConfig('spirit_beast_data');
        const beastTypeMap = new Map((config.beast_types || []).map(bt => [bt.beast_key, bt]));
        const elements = config.elements || {};
        const rarityConfig = config.rarity_config || {};

        const list = beasts.map(b => this._formatBeast(b, beastTypeMap, elements, rarityConfig));

        // 统计信息
        const stats = {
            total: beasts.length,
            max: config.settings.max_beasts_per_player,
            active_count: beasts.filter(b => b.is_active).length,
            by_rarity: {
                common: beasts.filter(b => b.rarity === 'common').length,
                rare: beasts.filter(b => b.rarity === 'rare').length,
                epic: beasts.filter(b => b.rarity === 'epic').length,
                legendary: beasts.filter(b => b.rarity === 'legendary').length
            }
        };

        return {
            success: true,
            data: {
                beasts: list,
                stats
            }
        };
    }

    /**
     * 获取灵兽详情
     * @param {number} playerId - 玩家ID
     * @param {number} beastId - 灵兽ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getBeastDetail(playerId, beastId) {
        const beast = await SpiritBeast.findOne({
            where: { id: beastId, player_id: playerId }
        });
        if (!beast) {
            return { success: false, message: '灵兽不存在或不属于您', error_code: ErrorCodes.NOT_FOUND };
        }

        const config = configLoader.getConfig('spirit_beast_data');
        const beastTypeMap = new Map((config.beast_types || []).map(bt => [bt.beast_key, bt]));
        const elements = config.elements || {};
        const rarityConfig = config.rarity_config || {};

        const formatted = this._formatBeast(beast, beastTypeMap, elements, rarityConfig);
        const combatPower = this.calculateCombatPower(beast);
        const expCap = calcExpCap(beast.level, config.settings);

        // 冷却剩余秒数
        const now = new Date();
        const feedCooldown = Number(config.settings.feed_cooldown_seconds) || 3600;
        const interactCooldown = Number(config.settings.interact_cooldown_seconds) || 600;
        const feedRemaining = beast.last_feed_time
            ? Math.max(0, feedCooldown - Math.floor((now - new Date(beast.last_feed_time)) / 1000))
            : 0;
        const interactRemaining = beast.last_interact_time
            ? Math.max(0, interactCooldown - Math.floor((now - new Date(beast.last_interact_time)) / 1000))
            : 0;

        return {
            success: true,
            data: {
                ...formatted,
                combat_power: combatPower,
                exp_cap: expCap.toString(),
                exp_percent: expCap > 0 ? Math.min(100, Math.floor(Number(beast.exp) / expCap * 100)) : 0,
                cooldown: {
                    feed_remaining_sec: feedRemaining,
                    interact_remaining_sec: interactRemaining,
                    feed_cooldown_sec: feedCooldown,
                    interact_cooldown_sec: interactCooldown
                },
                // 元素相克信息
                element_relations: this._getElementRelations(beast.element, elements)
            }
        };
    }

    /**
     * 寻觅/捕获灵兽
     * 校验境界、每日次数、灵力消耗、背包容量；按概率捕获，失败返还部分灵力
     * @param {number} playerId - 玩家ID
     * @param {string} beastKey - 灵兽种类key
     * @returns {Promise<Object>} { success, message, data }
     */
    static async catchBeast(playerId, beastKey) {
        if (!beastKey || typeof beastKey !== 'string') {
            return { success: false, message: 'beast_key 必填', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = configLoader.getConfig('spirit_beast_data');
        const beastType = (config.beast_types || []).find(bt => bt.beast_key === beastKey);
        if (!beastType) {
            return { success: false, message: `灵兽种类 ${beastKey} 不存在`, error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 境界校验：min_realm_rank 直接与 player.realm_rank 比较
            const playerRank = Number(player.realm_rank) || 0;
            const requiredRank = Number(beastType.min_realm_rank) || 1;
            if (playerRank < requiredRank) {
                await t.rollback();
                const realm = new RealmService().getRealmByRank(requiredRank);
                return {
                    success: false,
                    message: `境界不足，需达到 ${realm?.name || 'rank ' + requiredRank}（rank ${requiredRank}），当前 rank ${playerRank}`,
                    error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
                };
            }

            // 每日次数校验：通过 caught_at 统计今日捕获数
            const todayStart = getTodayStart();
            const todayCount = await SpiritBeast.count({
                where: {
                    player_id: playerId,
                    caught_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            const dailyLimit = Number(config.settings.catch_daily_limit) || 20;
            if (todayCount >= dailyLimit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日捕获次数已达上限（${dailyLimit} 次），明日再试`,
                    error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
                };
            }

            // 灵力消耗校验
            const costMp = BigInt(beastType.catch_cost_mp);
            const playerMp = BigInt(player.mp_current || 0);
            if (playerMp < costMp) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵力不足，需要 ${costMp.toString()}，当前 ${playerMp.toString()}`,
                    error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
                };
            }

            // 背包容量校验
            const currentCount = await SpiritBeast.count({
                where: { player_id: playerId },
                transaction: t
            });
            const maxBeasts = Number(config.settings.max_beasts_per_player) || 10;
            if (currentCount >= maxBeasts) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵兽背包已满（${maxBeasts} 只上限），请先放生部分灵兽`,
                    error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
                };
            }

            // 扣除灵力
            player.mp_current = (playerMp - costMp).toString();
            await player.save({ transaction: t });

            // 按 catch_chance 概率判定是否捕获成功
            const catchChance = Number(beastType.catch_chance);
            const roll = Math.random();
            const success = roll < catchChance;

            if (!success) {
                // 失败：返还部分灵力（按配置比例）
                const returnRatio = Number(config.settings.catch_fail_mp_return_ratio) || 0.3;
                const returnMp = BigInt(Math.floor(Number(costMp) * returnRatio));
                player.mp_current = (BigInt(player.mp_current) + returnMp).toString();
                await player.save({ transaction: t });
                await t.commit();

                // 推送通知
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_catch_failed', {
                    beast_key: beastKey,
                    beast_name: beastType.name,
                    cost_mp: costMp.toString(),
                    return_mp: returnMp.toString()
                });

                return {
                    success: false,
                    message: `寻觅${beastType.name}失败！${beastType.name}挣脱了禁制逃走，消耗灵力 ${costMp.toString()}（返还 ${returnMp.toString()}）`,
                    error_code: ErrorCodes.BUSINESS_LOGIC_ERROR,
                    data: {
                        caught: false,
                        beast_key: beastKey,
                        beast_name: beastType.name,
                        roll: roll.toFixed(4),
                        catch_chance: catchChance,
                        cost_mp: costMp.toString(),
                        return_mp: returnMp.toString(),
                        today_count: todayCount + 1,
                        daily_limit: dailyLimit
                    }
                };
            }

            // 成功：创建灵兽实例
            const newBeast = await SpiritBeast.create({
                player_id: playerId,
                beast_key: beastKey,
                beast_name: null,
                element: beastType.element,
                rarity: beastType.rarity,
                star_level: 1,
                level: 1,
                exp: 0,
                hp_max: beastType.base_hp,
                atk: beastType.base_atk,
                def: beastType.base_def,
                speed: beastType.base_speed,
                loyalty: 50,
                is_active: false,
                last_feed_time: null,
                last_interact_time: null,
                caught_at: new Date()
            }, { transaction: t });

            await t.commit();

            // 推送通知
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_caught', {
                beast_id: newBeast.id,
                beast_key: beastKey,
                beast_name: beastType.name,
                rarity: beastType.rarity
            });

            return {
                success: true,
                message: `成功捕获 ${beastType.name}！灵兽已收入灵兽袋`,
                data: {
                    caught: true,
                    beast_id: newBeast.id,
                    beast_key: beastKey,
                    beast_name: beastType.name,
                    element: beastType.element,
                    rarity: beastType.rarity,
                    roll: roll.toFixed(4),
                    catch_chance: catchChance,
                    cost_mp: costMp.toString(),
                    today_count: todayCount + 1,
                    daily_limit: dailyLimit
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[SpiritBeastService.catchBeast] 错误:', err);
            return { success: false, message: '服务器错误，捕获失败', error_code: ErrorCodes.INTERNAL_ERROR };
        }
    }

    /**
     * 喂养灵兽
     * 消耗灵石 = level * feed_cost_per_level，增加经验+忠诚度，1 小时冷却
     * @param {number} playerId - 玩家ID
     * @param {number} beastId - 灵兽ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async feedBeast(playerId, beastId) {
        const config = configLoader.getConfig('spirit_beast_data');
        const settings = config.settings;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const beast = await SpiritBeast.findOne({
                where: { id: beastId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!beast) {
                await t.rollback();
                return { success: false, message: '灵兽不存在或不属于你', error_code: ErrorCodes.NOT_FOUND };
            }

            // 冷却校验
            const cooldownSec = Number(settings.feed_cooldown_seconds) || 3600;
            if (beast.last_feed_time) {
                const elapsed = Math.floor((new Date() - new Date(beast.last_feed_time)) / 1000);
                if (elapsed < cooldownSec) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `喂养冷却中，剩余 ${cooldownSec - elapsed} 秒`,
                        error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
                    };
                }
            }

            // 灵石消耗 = level * feed_cost_per_level
            const costStones = BigInt(Number(beast.level) * (Number(settings.feed_cost_per_level) || 100));
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`,
                    error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
                };
            }

            // 等级上限校验
            const maxLevel = Number(settings.max_level) || 100;
            if (beast.level >= maxLevel) {
                await t.rollback();
                return { success: false, message: `灵兽已达等级上限 ${maxLevel} 级`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 扣灵石、加经验、加忠诚度
            player.spirit_stones = (playerStones - costStones).toString();
            const feedExp = BigInt(Number(settings.feed_exp) || 10);
            const newExp = BigInt(beast.exp) + feedExp;
            const loyaltyGain = Number(settings.feed_loyalty_gain) || 5;
            const maxLoyalty = Number(settings.max_loyalty) || 100;

            beast.exp = newExp.toString();
            beast.loyalty = Math.min(maxLoyalty, beast.loyalty + loyaltyGain);
            beast.last_feed_time = new Date();

            // 检查升级
            const levelUpResult = this._checkLevelUp(beast, config);
            await beast.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_fed', {
                beast_id: beast.id,
                exp_gain: feedExp.toString(),
                loyalty_gain: loyaltyGain,
                level_up: levelUpResult.level_up
            });

            return {
                success: true,
                message: `喂养成功！${levelUpResult.level_up ? `灵兽升级至 ${beast.level} 级！` : ''}消耗灵石 ${costStones.toString()}`,
                data: {
                    beast_id: beast.id,
                    cost_spirit_stones: costStones.toString(),
                    exp_gain: feedExp.toString(),
                    loyalty_gain: loyaltyGain,
                    level_up: levelUpResult.level_up,
                    new_level: beast.level,
                    new_exp: beast.exp.toString(),
                    new_loyalty: beast.loyalty
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[SpiritBeastService.feedBeast] 错误:', err);
            return { success: false, message: '服务器错误，喂养失败', error_code: ErrorCodes.INTERNAL_ERROR };
        }
    }

    /**
     * 互动灵兽
     * 增加忠诚度+经验，10 分钟冷却，无消耗
     * @param {number} playerId - 玩家ID
     * @param {number} beastId - 灵兽ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async interactBeast(playerId, beastId) {
        const config = configLoader.getConfig('spirit_beast_data');
        const settings = config.settings;

        const t = await sequelize.transaction();
        try {
            const beast = await SpiritBeast.findOne({
                where: { id: beastId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!beast) {
                await t.rollback();
                return { success: false, message: '灵兽不存在或不属于你', error_code: ErrorCodes.NOT_FOUND };
            }

            // 冷却校验
            const cooldownSec = Number(settings.interact_cooldown_seconds) || 600;
            if (beast.last_interact_time) {
                const elapsed = Math.floor((new Date() - new Date(beast.last_interact_time)) / 1000);
                if (elapsed < cooldownSec) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `互动冷却中，剩余 ${cooldownSec - elapsed} 秒`,
                        error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
                    };
                }
            }

            // 增加经验+忠诚度
            const expGain = BigInt(Number(settings.interact_exp_gain) || 5);
            const loyaltyGain = Number(settings.interact_loyalty_gain) || 2;
            const maxLoyalty = Number(settings.max_loyalty) || 100;
            const maxLevel = Number(settings.max_level) || 100;

            if (beast.level >= maxLevel) {
                // 满级后仅加忠诚度
                beast.loyalty = Math.min(maxLoyalty, beast.loyalty + loyaltyGain);
            } else {
                beast.exp = (BigInt(beast.exp) + expGain).toString();
                beast.loyalty = Math.min(maxLoyalty, beast.loyalty + loyaltyGain);
            }
            beast.last_interact_time = new Date();

            const levelUpResult = this._checkLevelUp(beast, config);
            await beast.save({ transaction: t });
            await t.commit();

            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_interacted', {
                beast_id: beast.id,
                exp_gain: expGain.toString(),
                loyalty_gain: loyaltyGain,
                level_up: levelUpResult.level_up
            });

            return {
                success: true,
                message: `互动成功！灵兽亲密度提升${levelUpResult.level_up ? `，升级至 ${beast.level} 级！` : ''}`,
                data: {
                    beast_id: beast.id,
                    exp_gain: expGain.toString(),
                    loyalty_gain: loyaltyGain,
                    level_up: levelUpResult.level_up,
                    new_level: beast.level,
                    new_exp: beast.exp.toString(),
                    new_loyalty: beast.loyalty
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[SpiritBeastService.interactBeast] 错误:', err);
            return { success: false, message: '服务器错误，互动失败', error_code: ErrorCodes.INTERNAL_ERROR };
        }
    }

    /**
     * 设置出战灵兽
     * 同时仅允许 1 只灵兽出战，先取消其他灵兽的出战状态
     * @param {number} playerId - 玩家ID
     * @param {number} beastId - 灵兽ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async setActiveBeast(playerId, beastId) {
        const t = await sequelize.transaction();
        try {
            const beast = await SpiritBeast.findOne({
                where: { id: beastId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!beast) {
                await t.rollback();
                return { success: false, message: '灵兽不存在或不属于你', error_code: ErrorCodes.NOT_FOUND };
            }

            // 取消该玩家其他灵兽的出战状态
            await SpiritBeast.update(
                { is_active: false },
                {
                    where: {
                        player_id: playerId,
                        is_active: true,
                        id: { [Op.ne]: beastId }
                    },
                    transaction: t
                }
            );

            // 设置当前灵兽出战
            beast.is_active = true;
            await beast.save({ transaction: t });
            await t.commit();

            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_set_active', {
                beast_id: beast.id,
                beast_key: beast.beast_key
            });

            return {
                success: true,
                message: '出战灵兽已设置',
                data: {
                    beast_id: beast.id,
                    beast_key: beast.beast_key,
                    is_active: true
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[SpiritBeastService.setActiveBeast] 错误:', err);
            return { success: false, message: '服务器错误，设置出战失败', error_code: ErrorCodes.INTERNAL_ERROR };
        }
    }

    /**
     * 放生灵兽
     * 返还部分灵石（按稀有度比例），删除灵兽记录
     * @param {number} playerId - 玩家ID
     * @param {number} beastId - 灵兽ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async releaseBeast(playerId, beastId) {
        const config = configLoader.getConfig('spirit_beast_data');
        const rarityConfig = config.rarity_config || {};
        const settings = config.settings;
        const beastTypeMap = new Map((config.beast_types || []).map(bt => [bt.beast_key, bt]));

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const beast = await SpiritBeast.findOne({
                where: { id: beastId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!beast) {
                await t.rollback();
                return { success: false, message: '灵兽不存在或不属于你', error_code: ErrorCodes.NOT_FOUND };
            }

            // 计算返还灵石 = (基础灵石+等级成长) * 稀有度返还比例
            const bt = beastTypeMap.get(beast.beast_key) || {};
            const baseReturn = (Number(bt.base_hp || 0) + Number(beast.level) * 50) / 10;
            const returnRatio = Number(rarityConfig[beast.rarity]?.release_return_ratio) || 0.2;
            const returnStones = BigInt(Math.floor(baseReturn * returnRatio));

            // 返还灵石
            player.spirit_stones = (BigInt(player.spirit_stones || 0) + returnStones).toString();

            // 删除灵兽
            await beast.destroy({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_released', {
                beast_id: beastId,
                beast_key: beast.beast_key,
                return_spirit_stones: returnStones.toString()
            });

            return {
                success: true,
                message: `已放生灵兽，返还灵石 ${returnStones.toString()}`,
                data: {
                    beast_id: beastId,
                    beast_key: beast.beast_key,
                    return_spirit_stones: returnStones.toString(),
                    new_spirit_stones: player.spirit_stones.toString()
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[SpiritBeastService.releaseBeast] 错误:', err);
            return { success: false, message: '服务器错误，放生失败', error_code: ErrorCodes.INTERNAL_ERROR };
        }
    }

    /**
     * 获取今日捕获状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getDailyStatus(playerId) {
        const config = configLoader.getConfig('spirit_beast_data');
        const dailyLimit = Number(config.settings.catch_daily_limit) || 20;

        const todayStart = getTodayStart();
        const todayCount = await SpiritBeast.count({
            where: {
                player_id: playerId,
                caught_at: { [Op.gte]: todayStart }
            }
        });

        const currentCount = await SpiritBeast.count({
            where: { player_id: playerId }
        });

        return {
            success: true,
            data: {
                today_count: todayCount,
                daily_limit: dailyLimit,
                remaining: Math.max(0, dailyLimit - todayCount),
                current_beast_count: currentCount,
                max_beast_count: Number(config.settings.max_beasts_per_player) || 10,
                reset_time: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 19)
            }
        };
    }

    /**
     * 计算灵兽战力
     * 综合 hp/atk/def/speed 加权求和，并考虑星级倍率
     * @param {Object} beast - 灵兽实例
     * @returns {number} 战力数值
     */
    static calculateCombatPower(beast) {
        const config = configLoader.getConfig('spirit_beast_data');
        const weight = config.settings.combat_power_weight || { hp: 0.1, atk: 2.0, def: 1.5, speed: 1.0 };
        const hp = Number(beast.hp_max || 0);
        const atk = Number(beast.atk || 0);
        const def = Number(beast.def || 0);
        const speed = Number(beast.speed || 0);
        const starBonus = 1 + (Number(beast.star_level) - 1) * 0.1;
        const base = hp * weight.hp + atk * weight.atk + def * weight.def + speed * weight.speed;
        return Math.floor(base * starBonus);
    }

    /**
     * 获取元素相克倍率
     * 强克制：1.5x，弱克制：0.75x，无相克：1.0x
     * @param {string} attackerElement - 攻击方元素
     * @param {string} defenderElement - 防守方元素
     * @returns {number} 倍率
     */
    static getElementMultiplier(attackerElement, defenderElement) {
        if (!attackerElement || !defenderElement) return 1.0;
        const config = configLoader.getConfig('spirit_beast_data');
        const elements = config.elements || {};
        const multiplier = config.element_multiplier || { strong: 1.5, weak: 0.75, normal: 1.0 };

        const attacker = elements[attackerElement];
        if (!attacker) return Number(multiplier.normal) || 1.0;

        // 强克制：攻击方的强克制元素 = 防守方
        if (attacker.strong_against === defenderElement) {
            return Number(multiplier.strong) || 1.5;
        }
        // 弱克制：攻击方的弱克制元素 = 防守方
        if (attacker.weak_against === defenderElement) {
            return Number(multiplier.weak) || 0.75;
        }
        return Number(multiplier.normal) || 1.0;
    }

    /**
     * 获取玩家出战灵兽的属性加成（用于战斗属性计算）
     *
     * 加成公式：
     *   bonus_rate = base_rate + star_level * star_rate + level * level_rate（上限 max_rate）
     *   atk_bonus = beast.atk * bonus_rate
     *   def_bonus = beast.def * bonus_rate
     *   hp_max_bonus = beast.hp_max * bonus_rate * hp_factor
     *   speed_bonus = beast.speed * bonus_rate * speed_factor
     *   sense_bonus = beast.sense * bonus_rate * sense_factor（如有）
     *
     * 设计意图：
     *   - 灵兽成为玩家战力的有机组成，鼓励玩家培养灵兽
     *   - 星级和等级影响加成比例，高星级灵兽价值更高
     *   - HP/速度加成有系数衰减，避免灵兽HP过高导致玩家变得太肉
     *   - 加成比例上限 50%，防止后期灵兽数值膨胀破坏战斗平衡
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 灵兽属性加成对象 { atk, def, hp_max, mp_max, speed, sense, beast_info }
     *   beast_info: 灵兽简要信息（用于前端展示加成来源）
     *   如无出战灵兽，返回空对象 { beast_info: null }
     */
    static async getActiveBeastBonus(playerId) {
        if (!playerId) return { beast_info: null };

        try {
            // 查询玩家出战的灵兽
            const beast = await SpiritBeast.findOne({
                where: { player_id: playerId, is_active: true }
            });

            if (!beast) {
                return { beast_info: null };
            }

            const config = configLoader.getConfig('spirit_beast_data');
            const bonusCfg = config?.settings?.combat_bonus || {};
            const baseRate = Number(bonusCfg.base_rate) || 0.1;
            const starRate = Number(bonusCfg.star_rate) || 0.05;
            const levelRate = Number(bonusCfg.level_rate) || 0.005;
            const maxRate = Number(bonusCfg.max_rate) || 0.5;
            const hpFactor = Number(bonusCfg.hp_factor) || 0.5;
            const speedFactor = Number(bonusCfg.speed_factor) || 0.3;
            const mpFactor = Number(bonusCfg.mp_factor) || 0;
            const senseFactor = Number(bonusCfg.sense_factor) || 0.2;

            // 计算加成比例：base + 星级*star_rate + 等级*level_rate，上限 max_rate
            const starLevel = Number(beast.star_level) || 1;
            const level = Number(beast.level) || 1;
            const rawRate = baseRate + starLevel * starRate + level * levelRate;
            const bonusRate = Math.min(rawRate, maxRate);

            // 计算各项属性加成
            const beastAtk = Number(beast.atk) || 0;
            const beastDef = Number(beast.def) || 0;
            const beastHp = Number(beast.hp_max) || 0;
            const beastSpeed = Number(beast.speed) || 0;

            // 解析灵兽显示名：优先使用玩家自定义昵称，否则从配置按 beast_key 读取默认名
            // 否则前端拿到的 beast_name 会是 null，无法直接展示
            let displayBeastName = beast.beast_name;
            if (!displayBeastName && beast.beast_key) {
                const beastType = (config?.beast_types || []).find(b => b.beast_key === beast.beast_key);
                displayBeastName = beastType?.name || beast.beast_key;
            }

            const bonus = {
                atk: Math.floor(beastAtk * bonusRate),
                def: Math.floor(beastDef * bonusRate),
                hp_max: Math.floor(beastHp * bonusRate * hpFactor),
                mp_max: 0, // 灵兽一般不提供MP加成，保留字段
                speed: Math.floor(beastSpeed * bonusRate * speedFactor),
                sense: 0, // 如有 sense_factor 配置，可扩展
                beast_info: {
                    beast_id: beast.id,
                    beast_key: beast.beast_key,
                    beast_name: displayBeastName,
                    element: beast.element,
                    rarity: beast.rarity,
                    star_level: starLevel,
                    level: level,
                    bonus_rate: Number((bonusRate * 100).toFixed(1)), // 百分比形式，如 25.5
                    combat_power: this.calculateCombatPower(beast)
                }
            };

            return bonus;
        } catch (err) {
            console.error('[SpiritBeastService.getActiveBeastBonus] 错误:', err);
            // 出错时返回空加成，避免阻塞战斗属性计算
            return { beast_info: null };
        }
    }

    // ==================== 内部辅助方法 ====================

    /**
     * 检查并执行灵兽升级
     * @private
     * @param {Object} beast - 灵兽实例（已更新 exp）
     * @param {Object} config - 灵兽配置
     * @returns {Object} { level_up: boolean, levels_gained: number }
     */
    static _checkLevelUp(beast, config) {
        const settings = config.settings;
        const maxLevel = Number(settings.max_level) || 100;
        let levelUp = false;
        let levelsGained = 0;

        while (beast.level < maxLevel) {
            const expCap = calcExpCap(beast.level, settings);
            const currentExp = BigInt(beast.exp);
            if (currentExp < BigInt(expCap)) break;

            // 升级
            beast.exp = (currentExp - BigInt(expCap)).toString();
            beast.level += 1;
            levelUp = true;
            levelsGained += 1;

            // 重算属性
            const beastTypeMap = new Map((config.beast_types || []).map(bt => [bt.beast_key, bt]));
            const bt = beastTypeMap.get(beast.beast_key);
            if (bt) {
                beast.hp_max = calcAttr(bt.base_hp, beast.level, beast.star_level);
                beast.atk = calcAttr(bt.base_atk, beast.level, beast.star_level);
                beast.def = calcAttr(bt.base_def, beast.level, beast.star_level);
                beast.speed = calcAttr(bt.base_speed, beast.level, beast.star_level);
            }
        }

        // 满级时清零经验
        if (beast.level >= maxLevel) {
            beast.exp = '0';
        }

        return { level_up: levelUp, levels_gained: levelsGained };
    }

    /**
     * 格式化灵兽对象为前端展示用
     * @private
     */
    static _formatBeast(beast, beastTypeMap, elements, rarityConfig) {
        const bt = beastTypeMap.get(beast.beast_key) || {};
        const elem = elements[beast.element] || {};
        const rarity = rarityConfig[beast.rarity] || {};
        return {
            id: beast.id,
            player_id: beast.player_id,
            beast_key: beast.beast_key,
            beast_name: beast.beast_name,
            display_name: beast.beast_name || bt.name || beast.beast_key,
            default_name: bt.name || beast.beast_key,
            element: beast.element,
            element_name: elem.name || beast.element,
            element_color: elem.color || '#9ca3af',
            rarity: beast.rarity,
            rarity_name: rarity.name || beast.rarity,
            rarity_color: rarity.color || '#9ca3af',
            star_level: beast.star_level,
            level: beast.level,
            exp: beast.exp?.toString() || '0',
            hp_max: beast.hp_max?.toString() || '0',
            atk: beast.atk,
            def: beast.def,
            speed: beast.speed,
            loyalty: beast.loyalty,
            is_active: Boolean(beast.is_active),
            last_feed_time: beast.last_feed_time,
            last_interact_time: beast.last_interact_time,
            caught_at: beast.caught_at,
            created_at: beast.created_at,
            description: bt.description || '',
            combat_power: this.calculateCombatPower(beast)
        };
    }

    /**
     * 获取元素相克关系（详情展示用）
     * @private
     */
    static _getElementRelations(element, elements) {
        const elem = elements[element];
        if (!elem) return null;
        const strong = elements[elem.strong_against];
        const weak = elements[elem.weak_against];
        return {
            element: element,
            element_name: elem.name,
            strong_against: {
                key: elem.strong_against,
                name: strong?.name || elem.strong_against,
                multiplier: 1.5
            },
            weak_against: {
                key: elem.weak_against,
                name: weak?.name || elem.weak_against,
                multiplier: 0.75
            }
        };
    }
}

module.exports = SpiritBeastService;
