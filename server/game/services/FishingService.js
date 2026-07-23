/**
 * 灵溪垂钓服务
 *
 * 实现玩法文档第21节·经济与博彩补充的全部业务逻辑：
 *   1. 钓竿系统（4级：青竹/银竹/金竹/金雷竹，LDC购买+法则碎片·雷+天雷竹升级）
 *   2. 鱼饵系统（4种：蚯蚓/灵虫饵/天灵饵/自制灵饵，购买+制饵）
 *   3. 鱼塘系统（4个：青云溪/碧波潭/灵泉湖/乱星海礁，按钓术熟练度解锁）
 *   4. 钓鱼流程（异步：抛竿→等待鱼讯→试探咬饵→提竿/收竿）
 *   5. 钓术熟练度（0-100级，降低空竿/升珍稀/缩短等鱼/延长提竿窗口）
 *   6. 剖鱼系统（灵鱼肉/灵鱼鳞/水草团，灵石/修为有日上限，LDC极小概率）
 *   7. 烹鱼/制饵/炼鳞符（灵鱼肉换修为/材料制饵/灵鱼鳞炼符换3竿增益）
 *   8. 伴生物品（功能道具池+稀有材料池，全服每日保底1-2件）
 *   9. 鱼篓/鱼谱/排行榜（鱼获记录/图鉴/4类排行）
 *
 * 多人交互设计：
 *   - 剖鱼产出的灵鱼肉/灵鱼鳞/水草团可在万宝楼/拍卖行流通
 *   - LDC产出全服每日保底2-3，鱼腹小概率开出1/2/3 LDC
 *   - 功能道具：煞气小刀可攻击其他玩家，劫镖令可劫红包
 *   - 稀有材料：天雷竹/灵眼木髓碎片流入傀儡工坊/灵树系统
 *   - 排行榜：钓术熟练度/最大鱼获/最稀有/总钓获四类竞争
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones BIGINT / ldc INT）
 *   - PlayerFishing: 钓鱼状态（1:1，钓竿/熟练度/日竿数/会话/统计）
 *   - PlayerFishCatch: 鱼获记录（N，本体不可流转，剖鱼后标记）
 *   - PlayerFishAlbum: 鱼谱图鉴（N，每种鱼一条记录）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerFishing = require('../../models/playerFishing');
const PlayerFishCatch = require('../../models/playerFishCatch');
const PlayerFishAlbum = require('../../models/playerFishAlbum');
const sequelize = require('../../config/database');
const InventoryService = require('./InventoryService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { Op } = require('sequelize');
const { ErrorCodes } = require('../../middleware/errorHandler');

class FishingService {
    static _initialized = false;
    static _config = null;

    /**
     * 初始化服务（从 ConfigLoader 读取 fishing_data 配置）
     * @param {Object} configLoaderInstance - ConfigLoader 实例
     */
    static initialize(configLoaderInstance) {
        this._config = configLoaderInstance.getConfig('fishing_data');
        if (!this._config) {
            console.warn('[FishingService] fishing_data 配置未加载');
            return;
        }
        this._initialized = true;
        console.log('[FishingService] 灵溪垂钓服务初始化完成');
    }

    /**
     * 获取配置（供路由层使用）
     * @returns {Object} 灵溪垂钓配置
     */
    static getConfig() {
        return this._config;
    }

    /**
     * 获取或创建玩家钓鱼记录（1:1 与 players 表）
     * @param {number} playerId - 玩家ID
     * @param {Object} [transaction] - 事务
     * @returns {Promise<Object>} PlayerFishing 实例
     */
    static async _getOrCreateFishing(playerId, transaction = null) {
        let fishing = await PlayerFishing.findOne({
            where: { player_id: playerId },
            transaction
        });
        if (!fishing) {
            fishing = await PlayerFishing.create({
                player_id: playerId,
                rod_tier: 0,
                skill_level: 0,
                skill_exp: 0,
                daily_casts: 0,
                daily_reset_date: new Date().toISOString().split('T')[0]
            }, { transaction });
        }
        return fishing;
    }

    /**
     * 日重置检查（跨日重置竿数和日上限）
     * @param {Object} fishing - PlayerFishing 实例
     * @param {Object} [transaction] - 事务
     * @returns {Promise<Object>} 更新后的 fishing
     */
    static async _checkDailyReset(fishing, transaction = null) {
        const today = new Date().toISOString().split('T')[0];
        if (fishing.daily_reset_date !== today) {
            fishing.daily_casts = 0;
            fishing.daily_stone_earned = 0;
            fishing.daily_cultivation_earned = 0;
            fishing.daily_reset_date = today;
            await fishing.save({ transaction });
        }
        return fishing;
    }

    /**
     * 计算熟练度效果
     * @param {number} skillLevel - 熟练度等级
     * @returns {Object} { emptyReduction, rareBonus, waitReductionSec, reelWindowBonusSec, weightBonus }
     */
    static _calcSkillEffects(skillLevel) {
        const e = this._config.skill.effects;
        return {
            emptyReduction: skillLevel * e.empty_reduction_per_level,
            rareBonus: skillLevel * e.rare_bonus_per_level,
            waitReductionSec: skillLevel * e.wait_reduction_per_level_sec,
            reelWindowBonusSec: skillLevel * e.reel_window_bonus_per_level_sec,
            weightBonus: skillLevel * e.fish_weight_bonus_per_level
        };
    }

    /**
     * 1. 获取玩家钓鱼档案
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getProfile(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const fishing = await this._getOrCreateFishing(playerId);
        await this._checkDailyReset(fishing);

        const rodTier = fishing.rod_tier;
        const rodKey = rodTier === 0 ? null : ['qing_zhu', 'yin_zhu', 'jin_zhu', 'jinlei_zhu'][rodTier - 1];
        const rodConfig = rodKey ? this._config.rods[rodKey] : null;

        // 计算升级信息
        let upgradeInfo = null;
        if (rodConfig && rodConfig.upgrade_cost) {
            upgradeInfo = {
                cost: rodConfig.upgrade_cost,
                next_rod: rodTier < 4 ? this._config.rods[['yin_zhu', 'jin_zhu', 'jinlei_zhu'][rodTier - 1]] : null
            };
        } else if (rodTier === 0) {
            upgradeInfo = {
                cost: null,
                next_rod: this._config.rods.qing_zhu,
                purchase_ldc: this._config.rods.qing_zhu.purchase_cost_ldc
            };
        }

        // 计算熟练度信息
        const skillEffects = this._calcSkillEffects(fishing.skill_level);
        const nextLevelExp = this._config.skill.level_exp_base + (fishing.skill_level * this._config.skill.level_exp_growth);

        return {
            success: true,
            data: {
                enabled: this._config.enabled,
                rod_tier: rodTier,
                rod_name: rodConfig ? rodConfig.name : '无钓竿',
                rod_config: rodConfig,
                upgrade_info: upgradeInfo,
                skill_level: fishing.skill_level,
                skill_exp: fishing.skill_exp,
                next_level_exp: nextLevelExp,
                skill_effects: skillEffects,
                daily_casts: fishing.daily_casts,
                daily_limit: rodConfig ? rodConfig.daily_limit : 0,
                daily_stone_earned: fishing.daily_stone_earned.toString(),
                daily_stone_limit: this._config.daily_limits.spirit_stone,
                daily_cultivation_earned: fishing.daily_cultivation_earned.toString(),
                daily_cultivation_limit: this._config.daily_limits.cultivation,
                buff_casts_remaining: fishing.buff_casts_remaining,
                buff_luck_bonus: parseFloat(fishing.buff_luck_bonus),
                has_active_session: !!fishing.active_session,
                total_catches: fishing.total_catches,
                total_success: fishing.total_success,
                success_rate: fishing.total_catches > 0 ? (fishing.total_success / fishing.total_catches) : 0,
                biggest_catch_kg: parseFloat(fishing.biggest_catch_kg),
                rarest_catch_quality: fishing.rarest_catch_quality,
                ldc_balance: player.ldc || 0
            }
        };
    }

    /**
     * 2. 渔具铺（查看今日天象、鱼饵和鱼塘）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getShop(playerId) {
        const fishing = await this._getOrCreateFishing(playerId);
        await this._checkDailyReset(fishing);

        const skillLevel = fishing.skill_level;
        const ponds = Object.entries(this._config.ponds).map(([key, pond]) => ({
            key,
            name: pond.name,
            description: pond.description,
            required_skill_level: pond.required_skill_level,
            required_bait: pond.required_bait,
            is_unlocked: skillLevel >= pond.required_skill_level,
            is_advanced: pond.is_advanced,
            has_rare_material: !!pond.rare_material_pool
        }));

        const baits = Object.entries(this._config.baits).map(([key, bait]) => ({
            key,
            name: bait.name,
            description: bait.description,
            price: bait.price,
            craftable: bait.craftable,
            craft_cost: bait.craft_cost
        }));

        // 今日天象（随机种子用日期，保证全服同一天看到相同天象）
        const today = new Date();
        const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
        const weathers = ['风和日丽，鱼群活跃', '微雨绵绵，灵鱼浮现', '雷云密布，深海鱼躁动', '薄雾轻笼，珍稀鱼出没', '狂风大作，钓鱼艰难'];
        const todayWeather = weathers[seed % weathers.length];
        const luckModifier = ((seed % 7) - 3) * 0.02; // -6% ~ +6% 幸运修正

        return {
            success: true,
            data: {
                today_weather: todayWeather,
                luck_modifier: luckModifier,
                ponds,
                baits,
                skill_level: skillLevel,
                rod_tier: fishing.rod_tier
            }
        };
    }

    /**
     * 3. 购买青竹钓竿（30 LDC）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async buyRod(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const fishing = await this._getOrCreateFishing(playerId, t);
            if (fishing.rod_tier > 0) {
                await t.rollback();
                return { success: false, message: '你已有钓竿，请使用升级功能' };
            }

            const cost = this._config.rods.qing_zhu.purchase_cost_ldc;
            const playerLdc = parseInt(player.ldc || 0);
            if (playerLdc < cost) {
                await t.rollback();
                return { success: false, message: `LDC不足，购买青竹钓竿需要 ${cost} LDC，当前 ${playerLdc} LDC` };
            }

            player.ldc = playerLdc - cost;
            fishing.rod_tier = 1;
            await player.save({ transaction: t });
            await fishing.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'fishing_rod_acquired',
                    message: `购买青竹钓竿成功，消耗 ${cost} LDC，每日5竿`,
                    data: { rod_tier: 1, rod_name: '青竹钓竿' }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `购买青竹钓竿成功，消耗 ${cost} LDC`,
                data: { rod_tier: 1, rod_name: '青竹钓竿', ldc_after: player.ldc }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.buyRod] 错误:', err);
            return { success: false, message: '购买钓竿失败：服务器内部错误' };
        }
    }

    /**
     * 4. 升级钓竿（消耗法则碎片·雷+天雷竹等）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async upgradeRod(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const fishing = await this._getOrCreateFishing(playerId, t);
            const currentTier = fishing.rod_tier;
            if (currentTier === 0) {
                await t.rollback();
                return { success: false, message: '请先购买青竹钓竿' };
            }
            if (currentTier >= 4) {
                await t.rollback();
                return { success: false, message: '钓竿已达最高等级（金雷竹钓竿）' };
            }

            const rodKeys = ['qing_zhu', 'yin_zhu', 'jin_zhu', 'jinlei_zhu'];
            const currentRod = this._config.rods[rodKeys[currentTier - 1]];
            const nextRod = this._config.rods[rodKeys[currentTier]];
            const cost = currentRod.upgrade_cost;
            if (!cost) {
                await t.rollback();
                return { success: false, message: '当前钓竿无法升级' };
            }

            // 校验材料
            for (const [matKey, matQty] of Object.entries(cost)) {
                const has = await InventoryService.hasItem(playerId, matKey, matQty, t);
                if (!has) {
                    await t.rollback();
                    return { success: false, message: `材料不足：${matKey} 需要 ${matQty}` };
                }
            }

            // 扣材料
            for (const [matKey, matQty] of Object.entries(cost)) {
                await InventoryService.removeItem(playerId, matKey, matQty, t);
            }

            fishing.rod_tier = currentTier + 1;
            await fishing.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'fishing_rod_upgraded',
                    message: `钓竿升级成功：${currentRod.name} → ${nextRod.name}，每日${nextRod.daily_limit}竿`,
                    data: { rod_tier: currentTier + 1, rod_name: nextRod.name }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `钓竿升级成功：${currentRod.name} → ${nextRod.name}`,
                data: { rod_tier: currentTier + 1, rod_name: nextRod.name, daily_limit: nextRod.daily_limit }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.upgradeRod] 错误:', err);
            return { success: false, message: '升级钓竿失败：服务器内部错误' };
        }
    }

    /**
     * 5. 购买鱼饵
     * @param {number} playerId - 玩家ID
     * @param {string} baitKey - 鱼饵key
     * @param {number} quantity - 数量
     * @returns {Promise<Object>} { success, message, data }
     */
    static async buyBait(playerId, baitKey, quantity) {
        const baitConfig = this._config.baits[baitKey];
        if (!baitConfig) {
            return { success: false, message: '鱼饵不存在' };
        }
        if (baitConfig.craftable) {
            return { success: false, message: `${baitConfig.name} 无法购买，请使用制饵制作` };
        }
        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999) {
            return { success: false, message: '购买数量无效（1-999）' };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const cost = BigInt(baitConfig.price) * BigInt(quantity);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < cost) {
                await t.rollback();
                return { success: false, message: `灵石不足，需要 ${cost.toString()}，当前 ${playerStones.toString()}` };
            }

            player.spirit_stones = (playerStones - cost).toString();
            await InventoryService.addItem(playerId, baitKey, quantity, t);
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `购买 ${baitConfig.name} ×${quantity} 成功，消耗 ${cost.toString()} 灵石`,
                data: { bait_key: baitKey, quantity, cost: cost.toString(), spirit_stones_after: player.spirit_stones }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.buyBait] 错误:', err);
            return { success: false, message: '购买鱼饵失败：服务器内部错误' };
        }
    }

    /**
     * 6. 制饵（自制灵饵，消耗灵鱼肉/灵鱼鳞/水草团）
     * @param {number} playerId - 玩家ID
     * @param {string} baitKey - 鱼饵key（目前仅 handmade 可制作）
     * @param {number} batches - 批数
     * @returns {Promise<Object>} { success, message, data }
     */
    static async craftBait(playerId, baitKey, batches) {
        const baitConfig = this._config.baits[baitKey];
        if (!baitConfig || !baitConfig.craftable) {
            return { success: false, message: '该鱼饵无法制作' };
        }
        if (!Number.isInteger(batches) || batches <= 0 || batches > 100) {
            return { success: false, message: '制作批数无效（1-100）' };
        }

        const t = await sequelize.transaction();
        try {
            const craftCost = baitConfig.craft_cost;
            const craftBatch = baitConfig.craft_batch; // 每批产出数量
            const totalYield = craftBatch * batches;

            // 校验并扣除材料（每批消耗一份 craft_cost）
            for (const [matKey, matQty] of Object.entries(craftCost)) {
                const totalNeed = matQty * batches;
                const has = await InventoryService.hasItem(playerId, matKey, totalNeed, t);
                if (!has) {
                    await t.rollback();
                    return { success: false, message: `材料不足：${matKey} 需要 ${totalNeed}（每批 ${matQty} × ${batches} 批）` };
                }
            }
            for (const [matKey, matQty] of Object.entries(craftCost)) {
                await InventoryService.removeItem(playerId, matKey, matQty * batches, t);
            }

            await InventoryService.addItem(playerId, baitKey, totalYield, t);
            await t.commit();

            return {
                success: true,
                message: `制作 ${baitConfig.name} 成功：${batches} 批，产出 ${totalYield} 个`,
                data: { bait_key: baitKey, batches, total_yield: totalYield }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.craftBait] 错误:', err);
            return { success: false, message: '制饵失败：服务器内部错误' };
        }
    }

    /**
     * 7. 炼鳞符（灵鱼鳞×5 → 3竿钓鱼增益）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async craftScaleTalisman(playerId) {
        const t = await sequelize.transaction();
        try {
            const cost = this._config.scale_talisman.craft_cost;
            for (const [matKey, matQty] of Object.entries(cost)) {
                const has = await InventoryService.hasItem(playerId, matKey, matQty, t);
                if (!has) {
                    await t.rollback();
                    return { success: false, message: `材料不足：${matKey} 需要 ${matQty}` };
                }
            }
            for (const [matKey, matQty] of Object.entries(cost)) {
                await InventoryService.removeItem(playerId, matKey, matQty, t);
            }

            const fishing = await this._getOrCreateFishing(playerId, t);
            fishing.buff_casts_remaining += this._config.scale_talisman.buff_casts;
            fishing.buff_luck_bonus = this._config.scale_talisman.buff_luck_bonus;
            await fishing.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `炼鳞符炼制成功，获得 ${this._config.scale_talisman.buff_casts} 竿钓鱼增益（幸运+${(this._config.scale_talisman.buff_luck_bonus * 100).toFixed(0)}%）`,
                data: {
                    buff_casts_remaining: fishing.buff_casts_remaining,
                    buff_luck_bonus: parseFloat(fishing.buff_luck_bonus)
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.craftScaleTalisman] 错误:', err);
            return { success: false, message: '炼鳞符失败：服务器内部错误' };
        }
    }

    /**
     * 8. 抛竿（创建活跃会话，扣日竿数+鱼饵）
     * @param {number} playerId - 玩家ID
     * @param {string} pondId - 鱼塘ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async cast(playerId, pondId) {
        const pondConfig = this._config.ponds[pondId];
        if (!pondConfig) {
            return { success: false, message: '鱼塘不存在' };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const fishing = await this._getOrCreateFishing(playerId, t);
            await this._checkDailyReset(fishing, t);

            // 校验钓竿
            if (fishing.rod_tier === 0) {
                await t.rollback();
                return { success: false, message: '你还没有钓竿，请先购买青竹钓竿' };
            }

            // 校验活跃会话
            if (fishing.active_session) {
                await t.rollback();
                return { success: false, message: '你已有活跃的钓鱼会话，请先提竿或收竿' };
            }

            // 校验日竿数
            const rodKey = ['qing_zhu', 'yin_zhu', 'jin_zhu', 'jinlei_zhu'][fishing.rod_tier - 1];
            const rodConfig = this._config.rods[rodKey];
            if (fishing.daily_casts >= rodConfig.daily_limit) {
                await t.rollback();
                return { success: false, message: `今日竿数已用完（${rodConfig.daily_limit}竿），明天再来` };
            }

            // 校验鱼塘解锁
            if (fishing.skill_level < pondConfig.required_skill_level) {
                await t.rollback();
                return { success: false, message: `钓术熟练度不足，${pondConfig.name}需要熟练度 ${pondConfig.required_skill_level}，当前 ${fishing.skill_level}` };
            }

            // 校验鱼饵
            const baitKey = pondConfig.required_bait;
            const hasBait = await InventoryService.hasItem(playerId, baitKey, 1, t);
            if (!hasBait) {
                await t.rollback();
                return { success: false, message: `鱼饵不足：需要 ${this._config.baits[baitKey].name} ×1` };
            }

            // 扣除日竿数 + 鱼饵
            fishing.daily_casts += 1;
            fishing.total_catches += 1;
            await InventoryService.removeItem(playerId, baitKey, 1, t);

            // 计算等鱼时间
            const skillEffects = this._calcSkillEffects(fishing.skill_level);
            const baseWait = rodConfig.wait_time_min_sec + Math.random() * (rodConfig.wait_time_max_sec - rodConfig.wait_time_min_sec);
            const waitTime = Math.max(15, Math.floor(baseWait - skillEffects.waitReductionSec));

            // 预选鱼（在抛竿时就确定，但玩家不知道）
            const preSelectedFish = this._rollFish(pondConfig.fish_pool, fishing.skill_level, 0, fishing.rod_tier, parseFloat(fishing.buff_luck_bonus));

            // 创建活跃会话
            const now = Date.now();
            const nibbleAt = now + waitTime * 1000;
            const reelWindow = rodConfig.reel_window_sec + skillEffects.reelWindowBonusSec;
            const reelDeadline = nibbleAt + reelWindow * 1000;

            fishing.active_session = {
                pond_id: pondId,
                pond_name: pondConfig.name,
                bait_key: baitKey,
                cast_at: now,
                nibble_at: nibbleAt,
                reel_deadline: reelDeadline,
                nibble_count: 0,
                pre_selected_fish: preSelectedFish,
                status: 'waiting',
                buff_active: fishing.buff_casts_remaining > 0
            };

            // 消耗炼鳞符增益
            if (fishing.buff_casts_remaining > 0) {
                fishing.buff_casts_remaining -= 1;
                if (fishing.buff_casts_remaining === 0) {
                    fishing.buff_luck_bonus = 0;
                }
            }

            await fishing.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'fishing_cast',
                    message: `抛竿成功：${pondConfig.name}，鱼讯预计 ${waitTime} 秒后到来`,
                    data: { pond_id: pondId, wait_sec: waitTime }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `抛竿成功：${pondConfig.name}，鱼讯预计 ${waitTime} 秒后到来`,
                data: {
                    pond_id: pondId,
                    pond_name: pondConfig.name,
                    wait_sec: waitTime,
                    nibble_at: nibbleAt,
                    daily_casts: fishing.daily_casts,
                    daily_limit: rodConfig.daily_limit,
                    buff_active: fishing.buff_casts_remaining > 0
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.cast] 错误:', err);
            return { success: false, message: '抛竿失败：服务器内部错误' };
        }
    }

    /**
     * 9. 查看钓鱼状态（进度/鱼讯/试探次数）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getStatus(playerId) {
        const fishing = await this._getOrCreateFishing(playerId);
        await this._checkDailyReset(fishing);

        if (!fishing.active_session) {
            return {
                success: true,
                data: { has_active_session: false, message: '当前没有活跃的钓鱼会话' }
            };
        }

        const session = fishing.active_session;
        const now = Date.now();

        // 状态判定
        let status = session.status;
        let remainingSec = 0;
        let message = '';

        if (now < session.nibble_at) {
            // 等待鱼讯
            status = 'waiting';
            remainingSec = Math.ceil((session.nibble_at - now) / 1000);
            message = `等待鱼讯到来，还需 ${remainingSec} 秒`;
        } else if (now >= session.nibble_at && now < session.reel_deadline) {
            // 鱼讯中，可提竿
            if (status === 'waiting') {
                status = 'biting';
                session.status = 'biting';
                await fishing.save();
            }
            remainingSec = Math.ceil((session.reel_deadline - now) / 1000);
            message = `鱼讯到来！可试探咬饵或提竿，剩余 ${remainingSec} 秒`;
        } else {
            // 提竿窗口已过，自动空竿
            status = 'expired';
            message = '提竿窗口已过，鱼跑了';
            // 清除会话
            fishing.active_session = null;
            await fishing.save();
        }

        return {
            success: true,
            data: {
                has_active_session: status !== 'expired',
                status,
                message,
                remaining_sec: remainingSec,
                pond_id: session.pond_id,
                pond_name: session.pond_name,
                nibble_count: session.nibble_count,
                max_nibble: this._config.nibble.max_attempts,
                cast_at: session.cast_at,
                nibble_at: session.nibble_at,
                reel_deadline: session.reel_deadline
            }
        };
    }

    /**
     * 10. 试探咬饵（小幅提高品质与稀有权重，但贪口可能空竿）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async nibble(playerId) {
        const t = await sequelize.transaction();
        try {
            const fishing = await this._getOrCreateFishing(playerId, t);
            if (!fishing.active_session) {
                await t.rollback();
                return { success: false, message: '没有活跃的钓鱼会话' };
            }

            const session = fishing.active_session;
            const now = Date.now();

            // 校验鱼讯状态
            if (now < session.nibble_at) {
                await t.rollback();
                return { success: false, message: '鱼讯还未到来，请耐心等待' };
            }
            if (now >= session.reel_deadline) {
                // 窗口已过，自动空竿
                fishing.active_session = null;
                await fishing.save({ transaction: t });
                await t.commit();
                return { success: false, message: '提竿窗口已过，鱼跑了' };
            }

            // 校验试探次数
            if (session.nibble_count >= this._config.nibble.max_attempts) {
                await t.rollback();
                return { success: false, message: `已达最大试探次数（${this._config.nibble.max_attempts}次）` };
            }

            session.nibble_count += 1;

            // 重新选鱼（基于试探次数提高品质和稀有度）
            const pondConfig = this._config.ponds[session.pond_id];
            const newFish = this._rollFish(
                pondConfig.fish_pool,
                fishing.skill_level,
                session.nibble_count,
                fishing.rod_tier,
                parseFloat(fishing.buff_luck_bonus)
            );
            session.pre_selected_fish = newFish;

            // 试探空竿风险
            const emptyRisk = session.nibble_count * this._config.nibble.empty_risk_per_attempt;
            const skillEffects = this._calcSkillEffects(fishing.skill_level);
            const finalEmptyRisk = Math.max(0, emptyRisk - skillEffects.emptyReduction);

            if (Math.random() < finalEmptyRisk) {
                // 试探导致空竿
                fishing.active_session = null;
                await this._addSkillExp(fishing, this._config.skill.exp_per_fail, t);
                await fishing.save({ transaction: t });
                await t.commit();

                return {
                    success: true,
                    message: `第 ${session.nibble_count} 次试探：贪口了！鱼被吓跑了（空竿率 ${(finalEmptyRisk * 100).toFixed(0)}%）`,
                    data: { nibble_count: session.nibble_count, result: 'empty', skill_exp_gained: this._config.skill.exp_per_fail }
                };
            }

            fishing.active_session = session;
            await fishing.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `第 ${session.nibble_count} 次试探：感觉有鱼在咬钩，品质可能提升了（剩余试探 ${this._config.nibble.max_attempts - session.nibble_count} 次）`,
                data: {
                    nibble_count: session.nibble_count,
                    max_nibble: this._config.nibble.max_attempts,
                    remaining_nibble: this._config.nibble.max_attempts - session.nibble_count,
                    result: 'continue'
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.nibble] 错误:', err);
            return { success: false, message: '试探失败：服务器内部错误' };
        }
    }

    /**
     * 11. 提竿结算（成功获得鱼获或空竿）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async reel(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const fishing = await this._getOrCreateFishing(playerId, t);
            if (!fishing.active_session) {
                await t.rollback();
                return { success: false, message: '没有活跃的钓鱼会话' };
            }

            const session = fishing.active_session;
            const now = Date.now();

            // 校验鱼讯状态
            if (now < session.nibble_at) {
                await t.rollback();
                return { success: false, message: '鱼讯还未到来，请耐心等待' };
            }
            if (now >= session.reel_deadline) {
                // 窗口已过，空竿
                fishing.active_session = null;
                await this._addSkillExp(fishing, this._config.skill.exp_per_fail, t);
                await fishing.save({ transaction: t });
                await t.commit();
                return { success: false, message: '提竿太晚了，鱼跑了' };
            }

            const pondConfig = this._config.ponds[session.pond_id];
            const preSelected = session.pre_selected_fish;

            // 判定空竿
            const poolConfig = this._config.fish_pools[pondConfig.fish_pool];
            let emptyRate = poolConfig.empty_weight / 100;
            const skillEffects = this._calcSkillEffects(fishing.skill_level);
            emptyRate = Math.max(0, emptyRate - skillEffects.emptyReduction);
            // 试探会降低空竿（因为试探已经承担了空竿风险）
            const nibbleReduction = session.nibble_count * 0.03;
            emptyRate = Math.max(0, emptyRate - nibbleReduction);

            const isEmpty = Math.random() < emptyRate;

            if (isEmpty) {
                // 空竿
                fishing.active_session = null;
                fishing.total_success += 0; // 空竿不计入成功
                await this._addSkillExp(fishing, this._config.skill.exp_per_fail, t);
                await fishing.save({ transaction: t });
                await t.commit();

                return {
                    success: true,
                    message: `提竿...空竿了！（空竿率 ${(emptyRate * 100).toFixed(0)}%）`,
                    data: { result: 'empty', skill_exp_gained: this._config.skill.exp_per_fail }
                };
            }

            // 成功钓获
            const fish = preSelected;
            // 计算鱼重（含试探加成 + 熟练度加成）
            const weightBonus = 1 + (session.nibble_count * this._config.nibble.weight_bonus_per_attempt) + skillEffects.weightBonus;
            const baseWeight = fish.min_kg + Math.random() * (fish.max_kg - fish.min_kg);
            const finalWeight = parseFloat((baseWeight * weightBonus).toFixed(2));

            // 伴生物品判定
            const bonusItems = this._rollBonusItems(pondConfig, fishing.skill_level);

            // LDC 判定
            let ldcGained = 0;
            if (Math.random() < this._config.daily_limits.ldc_fish_chance) {
                const ldcAmounts = this._config.daily_limits.ldc_amounts;
                ldcGained = ldcAmounts[Math.floor(Math.random() * ldcAmounts.length)];
                player.ldc = parseInt(player.ldc || 0) + ldcGained;
            }

            // 奖励（灵石/修为，有日上限）
            const stoneLimit = this._config.daily_limits.spirit_stone;
            const cultLimit = this._config.daily_limits.cultivation;
            const stoneEarned = Math.min(fish.stone_reward, stoneLimit - parseInt(fishing.daily_stone_earned));
            const cultEarned = Math.min(fish.cultivation_reward, cultLimit - parseInt(fishing.daily_cultivation_earned));

            if (stoneEarned > 0) {
                player.spirit_stones = (BigInt(player.spirit_stones || 0) + BigInt(stoneEarned)).toString();
                fishing.daily_stone_earned = parseInt(fishing.daily_stone_earned) + stoneEarned;
            }
            if (cultEarned > 0) {
                player.exp = BigInt(player.exp || 0) + BigInt(cultEarned);
                fishing.daily_cultivation_earned = parseInt(fishing.daily_cultivation_earned) + cultEarned;
            }

            // 创建鱼获记录
            const catchRecord = await PlayerFishCatch.create({
                player_id: playerId,
                fish_id: fish.id,
                fish_name: fish.name,
                quality: fish.quality,
                weight_kg: finalWeight,
                pond_id: session.pond_id,
                is_filleted: 0,
                bonus_items: bonusItems
            }, { transaction: t });

            // 更新图鉴
            await this._updateAlbum(playerId, fish, finalWeight, t);

            // 更新统计
            fishing.active_session = null;
            fishing.total_success += 1;
            if (finalWeight > parseFloat(fishing.biggest_catch_kg)) {
                fishing.biggest_catch_kg = finalWeight;
            }
            const qualityOrder = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
            if (qualityOrder.indexOf(fish.quality) > qualityOrder.indexOf(fishing.rarest_catch_quality)) {
                fishing.rarest_catch_quality = fish.quality;
            }

            // 增加熟练度经验
            await this._addSkillExp(fishing, this._config.skill.exp_per_success, t);

            await player.save({ transaction: t });
            await fishing.save({ transaction: t });
            await t.commit();

            // 推送通知
            try {
                if (fish.quality === 'legendary' || fish.quality === 'mythic') {
                    WebSocketNotificationService.notifyPlayer(playerId, {
                        type: 'fishing_rare_caught',
                        message: `钓到珍稀鱼获！${fish.name}（${fish.quality}）重 ${finalWeight}kg`,
                        data: { fish_id: fish.id, fish_name: fish.name, quality: fish.quality, weight_kg: finalWeight }
                    });
                }
                if (ldcGained > 0) {
                    WebSocketNotificationService.notifyPlayer(playerId, {
                        type: 'fishing_ldc_caught',
                        message: `鱼腹开出 ${ldcGained} LDC！`,
                        data: { ldc: ldcGained }
                    });
                }
                if (bonusItems) {
                    WebSocketNotificationService.notifyPlayer(playerId, {
                        type: 'fishing_material_caught',
                        message: `伴生物品：${bonusItems.name}`,
                        data: bonusItems
                    });
                }
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `提竿成功！钓到 ${fish.name}（${fish.quality}）重 ${finalWeight}kg`,
                data: {
                    result: 'success',
                    catch_id: catchRecord.id,
                    fish_id: fish.id,
                    fish_name: fish.name,
                    quality: fish.quality,
                    weight_kg: finalWeight,
                    pond_name: session.pond_name,
                    nibble_count: session.nibble_count,
                    stone_earned: stoneEarned,
                    cultivation_earned: cultEarned,
                    ldc_earned: ldcGained,
                    bonus_items: bonusItems,
                    skill_exp_gained: this._config.skill.exp_per_success,
                    spirit_stones_after: player.spirit_stones,
                    ldc_after: player.ldc
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.reel] 错误:', err);
            return { success: false, message: '提竿失败：服务器内部错误' };
        }
    }

    /**
     * 12. 收竿放弃（清除活跃会话，不获得奖励）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message }
     */
    static async giveUp(playerId) {
        const t = await sequelize.transaction();
        try {
            const fishing = await this._getOrCreateFishing(playerId, t);
            if (!fishing.active_session) {
                await t.rollback();
                return { success: false, message: '没有活跃的钓鱼会话' };
            }
            fishing.active_session = null;
            await fishing.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: '收竿放弃，本次钓鱼结束',
                data: { result: 'give_up' }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.giveUp] 错误:', err);
            return { success: false, message: '收竿失败：服务器内部错误' };
        }
    }

    /**
     * 13. 鱼篓（查看鱼获列表，分页）
     * @param {number} playerId - 玩家ID
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @param {string} filter - 过滤：all/unfilleted/filleted
     * @returns {Promise<Object>} { success, data }
     */
    static async getCreel(playerId, page = 1, pageSize = 20, filter = 'all') {
        const where = { player_id: playerId };
        if (filter === 'unfilleted') {
            where.is_filleted = 0;
        } else if (filter === 'filleted') {
            where.is_filleted = 1;
        }

        const offset = (page - 1) * pageSize;
        const { count, rows } = await PlayerFishCatch.findAndCountAll({
            where,
            order: [['caught_at', 'DESC']],
            limit: pageSize,
            offset
        });

        return {
            success: true,
            data: {
                total: count,
                page,
                page_size: pageSize,
                total_pages: Math.ceil(count / pageSize),
                filter,
                catches: rows.map(c => ({
                    id: c.id,
                    fish_id: c.fish_id,
                    fish_name: c.fish_name,
                    quality: c.quality,
                    weight_kg: parseFloat(c.weight_kg),
                    pond_id: c.pond_id,
                    is_filleted: c.is_filleted,
                    bonus_items: c.bonus_items,
                    caught_at: c.caught_at
                }))
            }
        };
    }

    /**
     * 14. 鱼谱（图鉴）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getAlbum(playerId) {
        const albums = await PlayerFishAlbum.findAll({
            where: { player_id: playerId },
            order: [['quality', 'ASC'], ['first_caught_at', 'DESC']]
        });

        // 所有鱼类配置（用于计算发现率）
        const allFishIds = new Set();
        Object.values(this._config.fish_pools).forEach(pool => {
            pool.fishes.forEach(f => allFishIds.add(f.id));
        });

        return {
            success: true,
            data: {
                total_species: allFishIds.size,
                discovered: albums.length,
                discovery_rate: allFishIds.size > 0 ? (albums.length / allFishIds.size) : 0,
                album: albums.map(a => ({
                    fish_id: a.fish_id,
                    fish_name: a.fish_name,
                    quality: a.quality,
                    first_caught_at: a.first_caught_at,
                    total_caught: a.total_caught,
                    biggest_kg: parseFloat(a.biggest_kg)
                }))
            }
        };
    }

    /**
     * 15. 剖鱼（取机缘：灵鱼肉/灵鱼鳞/水草团 + 灵石/修为/LDC）
     * @param {number} playerId - 玩家ID
     * @param {number} catchId - 鱼获记录ID
     * @param {number} quantity - 剖鱼数量
     * @returns {Promise<Object>} { success, message, data }
     */
    static async fillet(playerId, catchId, quantity = 1) {
        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100) {
            return { success: false, message: '剖鱼数量无效（1-100）' };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const fishing = await this._getOrCreateFishing(playerId, t);
            await this._checkDailyReset(fishing, t);

            // 查找指定鱼获（同一种鱼可以批量剖）
            const catchRecord = await PlayerFishCatch.findOne({
                where: { id: catchId, player_id: playerId, is_filleted: 0 },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!catchRecord) {
                await t.rollback();
                return { success: false, message: '鱼获不存在或已剖' };
            }

            // 查找同种未剖鱼获的数量
            const sameFishCount = await PlayerFishCatch.count({
                where: { player_id: playerId, fish_id: catchRecord.fish_id, is_filleted: 0 },
                transaction: t
            });
            const actualQuantity = Math.min(quantity, sameFishCount);

            // 查找鱼类配置
            let fishConfig = null;
            for (const pool of Object.values(this._config.fish_pools)) {
                const found = pool.fishes.find(f => f.id === catchRecord.fish_id);
                if (found) { fishConfig = found; break; }
            }
            if (!fishConfig) {
                await t.rollback();
                return { success: false, message: '鱼类配置缺失' };
            }

            // 计算产出
            const totalFilet = fishConfig.filet_yield * actualQuantity;
            const totalScale = fishConfig.scale_yield * actualQuantity;
            const totalGrass = fishConfig.grass_yield * actualQuantity;

            // 灵石/修为奖励（有日上限）
            const stoneLimit = this._config.daily_limits.spirit_stone;
            const cultLimit = this._config.daily_limits.cultivation;
            const stonePerFish = Math.floor(fishConfig.stone_reward * 0.3); // 剖鱼只给30%灵石
            const cultPerFish = Math.floor(fishConfig.cultivation_reward * 0.3);
            const stoneEarned = Math.min(stonePerFish * actualQuantity, stoneLimit - parseInt(fishing.daily_stone_earned));
            const cultEarned = Math.min(cultPerFish * actualQuantity, cultLimit - parseInt(fishing.daily_cultivation_earned));

            if (stoneEarned > 0) {
                player.spirit_stones = (BigInt(player.spirit_stones || 0) + BigInt(stoneEarned)).toString();
                fishing.daily_stone_earned = parseInt(fishing.daily_stone_earned) + stoneEarned;
            }
            if (cultEarned > 0) {
                player.exp = BigInt(player.exp || 0) + BigInt(cultEarned);
                fishing.daily_cultivation_earned = parseInt(fishing.daily_cultivation_earned) + cultEarned;
            }

            // 添加材料到背包
            if (totalFilet > 0) await InventoryService.addItem(playerId, 'ling_yu_rou', totalFilet, t);
            if (totalScale > 0) await InventoryService.addItem(playerId, 'ling_yu_lin', totalScale, t);
            if (totalGrass > 0) await InventoryService.addItem(playerId, 'shui_cao_tuan', totalGrass, t);

            // 标记鱼获为已剖（批量）
            await PlayerFishCatch.update(
                { is_filleted: 1 },
                {
                    where: {
                        player_id: playerId,
                        fish_id: catchRecord.fish_id,
                        is_filleted: 0
                    },
                    transaction: t,
                    limit: actualQuantity
                }
            );

            await player.save({ transaction: t });
            await fishing.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `剖鱼成功：${catchRecord.fish_name} ×${actualQuantity}`,
                data: {
                    fish_name: catchRecord.fish_name,
                    quantity: actualQuantity,
                    filet_gained: totalFilet,
                    scale_gained: totalScale,
                    grass_gained: totalGrass,
                    stone_earned: stoneEarned,
                    cultivation_earned: cultEarned,
                    spirit_stones_after: player.spirit_stones
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.fillet] 错误:', err);
            return { success: false, message: '剖鱼失败：服务器内部错误' };
        }
    }

    /**
     * 16. 烹鱼（灵鱼肉换修为）
     * @param {number} playerId - 玩家ID
     * @param {number} quantity - 烹鱼数量
     * @returns {Promise<Object>} { success, message, data }
     */
    static async cook(playerId, quantity) {
        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > this._config.cooking.max_filet_per_cook) {
            return { success: false, message: `烹鱼数量无效（1-${this._config.cooking.max_filet_per_cook}）` };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const has = await InventoryService.hasItem(playerId, 'ling_yu_rou', quantity, t);
            if (!has) {
                await t.rollback();
                return { success: false, message: `灵鱼肉不足，需要 ${quantity}` };
            }

            await InventoryService.removeItem(playerId, 'ling_yu_rou', quantity, t);

            const expGained = this._config.cooking.exp_per_filet * quantity;
            player.exp = BigInt(player.exp || 0) + BigInt(expGained);
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `烹鱼成功：消耗灵鱼肉 ×${quantity}，获得修为 ${expGained}`,
                data: { filet_used: quantity, cultivation_gained: expGained }
            };
        } catch (err) {
            await t.rollback();
            console.error('[FishingService.cook] 错误:', err);
            return { success: false, message: '烹鱼失败：服务器内部错误' };
        }
    }

    /**
     * 17. 排行榜（4类：熟练度/最大鱼获/最稀有/总钓获）
     * @param {string} category - 排行类别
     * @returns {Promise<Object>} { success, data }
     */
    static async getRanking(category = 'skill_level') {
        const validCategories = ['skill_level', 'biggest_catch_kg', 'rarest_catch_quality', 'total_success'];
        if (!validCategories.includes(category)) {
            return { success: false, message: '排行类别无效' };
        }

        const maxEntries = this._config.ranking.max_entries;
        let order;
        if (category === 'rarest_catch_quality') {
            // 品质排行需要用 FIELD 函数
            const qualityOrder = "'mythic','legendary','epic','rare','uncommon','common'";
            const [rows] = await sequelize.query(`
                SELECT f.player_id, f.rarest_catch_quality, f.total_success, f.biggest_catch_kg, f.skill_level,
                       p.nickname
                FROM player_fishing f
                LEFT JOIN players p ON f.player_id = p.id
                WHERE f.rarest_catch_quality != ''
                ORDER BY FIELD(f.rarest_catch_quality, ${qualityOrder}) DESC
                LIMIT ?
            `, { replacements: [maxEntries] });

            return {
                success: true,
                data: {
                    category,
                    entries: rows.map((r, i) => ({
                        rank: i + 1,
                        player_id: r.player_id,
                        nickname: r.nickname,
                        value: r.rarest_catch_quality,
                        display: r.rarest_catch_quality
                    }))
                }
            };
        } else {
            order = [[category, 'DESC']];
        }

        const entries = await PlayerFishing.findAll({
            where: { [category]: { [Op.gt]: 0 } },
            order,
            limit: maxEntries
        });

        // 批量查询玩家昵称
        const playerIds = entries.map(e => e.player_id);
        const players = await Player.findAll({
            where: { id: playerIds },
            attributes: ['id', 'nickname']
        });
        const playerMap = new Map(players.map(p => [p.id, p.nickname]));

        return {
            success: true,
            data: {
                category,
                entries: entries.map((e, i) => ({
                    rank: i + 1,
                    player_id: e.player_id,
                    nickname: playerMap.get(e.player_id) || '未知',
                    value: category === 'biggest_catch_kg' ? parseFloat(e.biggest_catch_kg) : e[category],
                    display: category === 'biggest_catch_kg' ? parseFloat(e.biggest_catch_kg).toFixed(2) + 'kg' :
                             category === 'skill_level' ? 'Lv.' + e.skill_level :
                             e[category]
                }))
            }
        };
    }

    // ============================================================
    // 辅助方法
    // ============================================================

    /**
     * 随机选鱼（基于权重 + 熟练度 + 试探次数 + 钓竿加成 + 幸运加成）
     * @param {string} poolKey - 鱼池key
     * @param {number} skillLevel - 熟练度
     * @param {number} nibbleCount - 试探次数
     * @param {number} rodTier - 钓竿等级
     * @param {number} luckBonus - 幸运加成
     * @returns {Object} 选中的鱼类配置
     */
    static _rollFish(poolKey, skillLevel, nibbleCount, rodTier, luckBonus) {
        const pool = this._config.fish_pools[poolKey];
        if (!pool || !pool.fishes || pool.fishes.length === 0) {
            return null;
        }

        const skillEffects = this._calcSkillEffects(skillLevel);
        const rodKey = rodTier > 0 ? ['qing_zhu', 'yin_zhu', 'jin_zhu', 'jinlei_zhu'][rodTier - 1] : null;
        const rodConfig = rodKey ? this._config.rods[rodKey] : null;

        // 计算每条鱼的最终权重
        const qualityOrder = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
        const weightedFishes = pool.fishes.map(fish => {
            let weight = fish.weight;
            // 熟练度提升珍稀鱼权重
            const fishQualityIndex = qualityOrder.indexOf(fish.quality);
            if (fishQualityIndex >= 2) { // rare 以上
                weight *= (1 + skillEffects.rareBonus);
            }
            // 钓竿珍稀鱼加成
            if (rodConfig && fishQualityIndex >= 2) {
                weight *= (1 + rodConfig.rare_bonus);
            }
            // 试探提升品质权重
            if (fishQualityIndex >= 2 && nibbleCount > 0) {
                weight *= (1 + nibbleCount * this._config.nibble.rare_bonus_per_attempt);
            }
            // 幸运加成
            if (fishQualityIndex >= 2) {
                weight *= (1 + luckBonus);
            }
            return { fish, weight };
        });

        // 加权随机
        const totalWeight = weightedFishes.reduce((sum, wf) => sum + wf.weight, 0);
        let rand = Math.random() * totalWeight;
        for (const wf of weightedFishes) {
            rand -= wf.weight;
            if (rand <= 0) {
                return wf.fish;
            }
        }
        return weightedFishes[0].fish; // 兜底
    }

    /**
     * 更新鱼谱图鉴
     * @param {number} playerId - 玩家ID
     * @param {Object} fish - 鱼类配置
     * @param {number} weightKg - 鱼获重量
     * @param {Object} transaction - 事务
     */
    static async _updateAlbum(playerId, fish, weightKg, transaction) {
        const existing = await PlayerFishAlbum.findOne({
            where: { player_id: playerId, fish_id: fish.id },
            transaction
        });

        if (existing) {
            existing.total_caught += 1;
            if (weightKg > parseFloat(existing.biggest_kg)) {
                existing.biggest_kg = weightKg;
            }
            await existing.save({ transaction });
        } else {
            await PlayerFishAlbum.create({
                player_id: playerId,
                fish_id: fish.id,
                fish_name: fish.name,
                quality: fish.quality,
                total_caught: 1,
                biggest_kg: weightKg
            }, { transaction });
        }
    }

    /**
     * 增加熟练度经验
     * @param {Object} fishing - PlayerFishing 实例
     * @param {number} exp - 经验值
     * @param {Object} transaction - 事务
     */
    static async _addSkillExp(fishing, exp, transaction) {
        fishing.skill_exp += exp;
        const maxLevel = this._config.skill.max_level;

        while (fishing.skill_level < maxLevel) {
            const needExp = this._config.skill.level_exp_base + (fishing.skill_level * this._config.skill.level_exp_growth);
            if (fishing.skill_exp >= needExp) {
                fishing.skill_exp -= needExp;
                fishing.skill_level += 1;
            } else {
                break;
            }
        }

        if (fishing.skill_level >= maxLevel) {
            fishing.skill_level = maxLevel;
            fishing.skill_exp = 0;
        }
    }

    /**
     * 伴生物品判定
     * @param {Object} pondConfig - 鱼塘配置
     * @param {number} skillLevel - 熟练度（暂未使用，预留扩展）
     * @returns {Object|null} 伴生物品信息或 null
     */
    static _rollBonusItems(pondConfig, skillLevel) {
        // 功能道具池（所有鱼塘通用）
        if (Math.random() < this._config.function_item_pools.chance_per_success) {
            const items = this._config.function_item_pools.items;
            const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
            let rand = Math.random() * totalWeight;
            for (const item of items) {
                rand -= item.weight;
                if (rand <= 0) {
                    return { type: 'function_item', id: item.id, name: item.name };
                }
            }
        }

        // 稀有材料池（仅高级鱼塘）
        if (pondConfig.rare_material_pool) {
            const materialPool = this._config.rare_material_pools[pondConfig.rare_material_pool];
            if (materialPool && Math.random() < materialPool.chance_per_success) {
                const items = materialPool.items;
                const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
                let rand = Math.random() * totalWeight;
                for (const item of items) {
                    rand -= item.weight;
                    if (rand <= 0) {
                        return { type: 'rare_material', id: item.id, name: item.name };
                    }
                }
            }
        }

        return null;
    }
}

module.exports = FishingService;
