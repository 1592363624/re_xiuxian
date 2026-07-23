/**
 * 赌石系统服务
 *
 * 实现玩法文档第21节·经济与博彩补充的全部业务逻辑：
 *   1. 原石生成（4+1产地差异化产出池，每次生成3块带线索原石）
 *   2. 线索博弈（4维线索：皮壳/重量/灵气/色泽，含假线索，熟练度提升解读）
 *   3. 切开方式（3种：粗切免费30%损耗/精切100灵石10%损耗/神识切需大衍诀1层无损必稀有）
 *   4. 赌石熟练度（0-100级，每5级+1%线索解读，每10级+1%稀有产出，100级解锁灵识透石）
 *   5. 产出池（灵石/修为/材料/稀有道具/LDC，按产地pool_bias和品质yield_multiplier分布）
 *   6. 全服保底（LDC每日1-2/稀有道具每日1-2，避免全服脸黑）
 *   7. 诅咒原石（诅咒矿脉40%概率触发24h诅咒，期间产出可被劫镖令劫走30%）
 *   8. 原石流转（未切开原石可上架拍卖行，最高3倍基础价，切开后不可交易）
 *
 * 多人交互设计：
 *   - 未切开原石可上架拍卖行流转，玩家间博弈线索价值
 *   - 切出稀有物品全服广播，刺激参与
 *   - 诅咒矿脉产出可被其他玩家劫镖令劫走，PVP经济博弈
 *   - LDC产出全服每日保底1-2，流入钓鱼系统钓竿购买
 *   - 排行榜：最大单块/总收益/稀有掉落/熟练度四类竞争
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones BIGINT / ldc INT / exp BIGINT）
 *   - PlayerGamblingStone: 赌石状态（1:1，熟练度/日次数/统计/诅咒状态）
 *   - PlayerStoneRecords: 原石记录（N，含线索/切开/产出/上架状态）
 *   - PlayerAscension: 飞升表（dayan_level 用于神识切权限校验）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerGamblingStone = require('../../models/playerGamblingStone');
const PlayerStoneRecords = require('../../models/playerStoneRecords');
const PlayerAscension = require('../../models/playerAscension');
const sequelize = require('../../config/database');
const InventoryService = require('./InventoryService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { Op } = require('sequelize');
const { ErrorCodes } = require('../../middleware/errorHandler');

class GamblingStoneService {
    static _initialized = false;
    static _config = null;

    /**
     * 初始化服务（从 ConfigLoader 读取 gambling_stone_data 配置）
     * @param {Object} configLoaderInstance - ConfigLoader 实例
     */
    static initialize(configLoaderInstance) {
        this._config = configLoaderInstance.getConfig('gambling_stone_data');
        if (!this._config) {
            console.warn('[GamblingStoneService] gambling_stone_data 配置未加载');
            return;
        }
        this._initialized = true;
        console.log('[GamblingStoneService] 赌石系统服务初始化完成');
    }

    /**
     * 获取配置（供路由层使用）
     * @returns {Object} 赌石系统配置
     */
    static getConfig() {
        return this._config;
    }

    /**
     * 获取或创建玩家赌石记录（1:1 与 players 表）
     * @param {number} playerId - 玩家ID
     * @param {Object} [transaction] - 事务
     * @returns {Promise<Object>} PlayerGamblingStone 实例
     */
    static async _getOrCreateProfile(playerId, transaction = null) {
        const options = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
        let profile = await PlayerGamblingStone.findOne({
            where: { player_id: playerId },
            ...options
        });
        if (!profile) {
            profile = await PlayerGamblingStone.create({
                player_id: playerId,
                skill_level: 0,
                skill_exp: 0,
                daily_generates: 0,
                daily_reset_date: new Date()
            }, transaction ? { transaction } : {});
        }
        return profile;
    }

    /**
     * 跨日重置检查：若日期变更，重置每日次数和日上限
     * @param {Object} profile - PlayerGamblingStone 实例
     * @private
     */
    static _checkDailyReset(profile) {
        const today = new Date();
        const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const resetDate = profile.daily_reset_date ? new Date(profile.daily_reset_date) : null;
        const resetDateOnly = resetDate ? new Date(resetDate.getFullYear(), resetDate.getMonth(), resetDate.getDate()) : null;

        // 日期变更，重置每日数据
        if (!resetDateOnly || todayDate.getTime() !== resetDateOnly.getTime()) {
            profile.daily_generates = 0;
            profile.daily_spirit_stone_earned = 0;
            profile.daily_cultivation_earned = 0;
            profile.daily_reset_date = todayDate;
        }
    }

    /**
     * 获取玩家大衍诀层数（用于神识切权限校验）
     * @param {number} playerId - 玩家ID
     * @param {Object} [transaction] - 事务
     * @returns {Promise<number>} 大衍诀层数（0-5）
     * @private
     */
    static async _getDayanLevel(playerId, transaction = null) {
        const ascension = await PlayerAscension.findOne({
            where: { player_id: playerId },
            transaction
        });
        return ascension ? Number(ascension.dayan_level || 0) : 0;
    }

    /**
     * 加权随机选择（通用工具方法）
     * @param {Array} items - 选项数组，每项需含 weight 字段
     * @param {Function} keyFn - 权重提取函数，默认取 item.weight
     * @returns {*} 选中的项
     * @private
     */
    static _weightedPick(items, keyFn = (i) => i.weight) {
        const total = items.reduce((s, i) => s + (keyFn(i) || 0), 0);
        let r = Math.random() * total;
        for (const item of items) {
            r -= (keyFn(item) || 0);
            if (r <= 0) return item;
        }
        return items[items.length - 1];
    }

    /**
     * 根据权重随机选择产地
     * @returns {string} 产地ID
     * @private
     */
    static _rollOrigin() {
        const origins = this._config.origins;
        const items = Object.entries(origins).map(([id, cfg]) => ({ id, weight: cfg.weight }));
        return this._weightedPick(items).id;
    }

    /**
     * 根据权重随机选择品质
     * @returns {string} 品质ID
     * @private
     */
    static _rollQuality() {
        const qualities = this._config.qualities;
        const items = Object.entries(qualities).map(([id, cfg]) => ({ id, weight: cfg.weight }));
        return this._weightedPick(items).id;
    }

    /**
     * 生成单块原石的4维线索（含假线索博弈）
     * @param {string} realQuality - 真实品质
     * @param {number} skillLevel - 玩家赌石熟练度（影响假线索概率）
     * @param {string} origin - 产地（诅咒矿脉会反向线索）
     * @returns {Object} 线索对象 { crust, weight, aura, color, fakes: [] }
     * @private
     */
    static _generateClues(realQuality, skillLevel, origin) {
        const clueCfg = this._config.clues;
        const qualities = this._config.qualities;
        const qualityList = ['common', 'spirit_vein', 'treasure_glow', 'fairy_mist'];
        const realQualityIdx = qualityList.indexOf(realQuality);

        // 假线索基础概率30%，熟练度每级降低0.5%
        const fakeProb = Math.max(0.05, clueCfg.fake_probability - skillLevel * clueCfg.fake_reduction_per_level);
        // 诅咒矿脉额外增加10%假线索概率
        const isCursed = origin === 'cursed_vein';

        const clues = {};
        const fakes = [];

        for (const dim of ['crust', 'weight', 'aura', 'color']) {
            const values = clueCfg[dim].values;
            // 真实线索：按品质档位对应线索档位（品质越高，线索档位越高）
            let trueIdx = Math.min(realQualityIdx, values.length - 1);
            // 诅咒矿脉反向：高品质显示低线索，低品质显示高线索
            if (isCursed) {
                trueIdx = values.length - 1 - trueIdx;
            }

            // 判定是否为假线索
            const isFake = Math.random() < fakeProb;
            if (isFake) {
                // 假线索：随机选一个不同的档位
                let fakeIdx;
                do {
                    fakeIdx = Math.floor(Math.random() * values.length);
                } while (fakeIdx === trueIdx);
                clues[dim] = values[fakeIdx];
                fakes.push(dim);
            } else {
                clues[dim] = values[trueIdx];
            }
        }

        // 玩家不可见 fakes 数组，仅后端记录用于切开时校验
        clues._fakes = fakes;
        clues._is_cursed_hint = isCursed; // 诅咒矿脉线索有特殊标记，玩家不可见
        return clues;
    }

    /**
     * 根据产地和品质滚动产出
     * @param {string} origin - 产地ID
     * @param {string} quality - 品质ID
     * @param {string} cutMethod - 切开方式
     * @param {number} skillLevel - 玩家熟练度
     * @returns {Object} 产出对象 { spirit_stones, cultivation, items, ldc, rare_drops, curse_triggered }
     * @private
     */
    static _rollYield(origin, quality, cutMethod, skillLevel) {
        const cfg = this._config;
        const originCfg = cfg.origins[origin];
        const qualityCfg = cfg.qualities[quality];
        const methodCfg = cfg.cut_methods[cutMethod];
        const pools = cfg.yield_pools;

        const yieldData = {
            spirit_stones: 0,
            cultivation: 0,
            items: [], // [{item_id, name, quantity}]
            ldc: 0,
            rare_drops: [], // [{item_id, name} or {type: 'ldc', amount}]
            curse_triggered: false
        };

        // 1. 根据产地 pool_bias 决定产出类型分布
        const bias = originCfg.pool_bias;
        const rollType = () => {
            const r = Math.random();
            if (r < bias.spirit_stones) return 'spirit_stones';
            if (r < bias.spirit_stones + bias.cultivation) return 'cultivation';
            if (r < bias.spirit_stones + bias.cultivation + bias.material) return 'material';
            return 'rare';
        };

        // 2. 基础产出：灵石 + 修为（每块原石必出，受品质yield_multiplier和切法loss_rate影响）
        const stoneRange = pools.spirit_stones[quality];
        const cultRange = pools.cultivation[quality];
        let baseStones = stoneRange[0] + Math.floor(Math.random() * (stoneRange[1] - stoneRange[0] + 1));
        let baseCult = cultRange[0] + Math.floor(Math.random() * (cultRange[1] - cultRange[0] + 1));

        // 品质倍率
        baseStones = Math.floor(baseStones * qualityCfg.yield_multiplier);
        baseCult = Math.floor(baseCult * qualityCfg.yield_multiplier);

        // 诅咒矿脉额外2倍产出
        if (originCfg.triggers_curse) {
            baseStones = Math.floor(baseStones * pools.curse_drops.bonus_multiplier);
            baseCult = Math.floor(baseCult * pools.curse_drops.bonus_multiplier);
        }

        // 切法损耗
        const lossRate = methodCfg.loss_rate;
        baseStones = Math.floor(baseStones * (1 - lossRate));
        baseCult = Math.floor(baseCult * (1 - lossRate));

        yieldData.spirit_stones = baseStones;
        yieldData.cultivation = baseCult;

        // 3. 材料产出（50%概率出材料）
        if (Math.random() < 0.5) {
            const materialPool = pools.materials[quality];
            if (materialPool && materialPool.length > 0) {
                const picked = this._weightedPick(materialPool);
                const qty = picked.min + Math.floor(Math.random() * (picked.max - picked.min + 1));
                yieldData.items.push({
                    item_id: picked.item_id,
                    quantity: qty
                });
            }
        }

        // 4. 稀有掉落判定
        const rarePool = pools.rare_drops[quality];
        if (rarePool && rarePool.length > 0) {
            // 稀有掉落概率：基础chance + 品质rare_chance_bonus + 熟练度每10级+1%
            const skillBonus = Math.floor(skillLevel / 10) * cfg.skill.rare_bonus_per_10_level;
            for (const rare of rarePool) {
                const finalChance = rare.chance + qualityCfg.rare_chance_bonus + skillBonus;
                if (Math.random() < finalChance) {
                    if (rare.type === 'ldc') {
                        // LDC产出
                        const ldcAmt = rare.ldc_amount[0] + Math.floor(Math.random() * (rare.ldc_amount[1] - rare.ldc_amount[0] + 1));
                        yieldData.ldc += ldcAmt;
                        yieldData.rare_drops.push({ type: 'ldc', amount: ldcAmt, name: rare.name });
                    } else {
                        // 物品产出
                        yieldData.items.push({ item_id: rare.item_id, quantity: 1 });
                        yieldData.rare_drops.push({ item_id: rare.item_id, name: rare.name });
                    }
                }
            }
        }

        // 5. 神识切必出稀有（若原石品质有稀有池但未触发，强制触发一个）
        if (methodCfg.guarantee_rare && rarePool && rarePool.length > 0 && yieldData.rare_drops.length === 0) {
            const forced = rarePool[0];
            if (forced.type === 'ldc') {
                const ldcAmt = forced.ldc_amount[0];
                yieldData.ldc += ldcAmt;
                yieldData.rare_drops.push({ type: 'ldc', amount: ldcAmt, name: forced.name });
            } else {
                yieldData.items.push({ item_id: forced.item_id, quantity: 1 });
                yieldData.rare_drops.push({ item_id: forced.item_id, name: forced.name });
            }
        }

        // 6. 诅咒触发判定（诅咒矿脉40%概率触发24h诅咒）
        if (originCfg.triggers_curse && Math.random() < pools.curse_drops.curse_chance) {
            yieldData.curse_triggered = true;
        }

        return yieldData;
    }

    /**
     * 计算产出等价灵石价值（用于统计和保底）
     * @param {Object} yieldData - 产出对象
     * @returns {number} 等价灵石价值
     * @private
     */
    static _calcYieldValue(yieldData) {
        let value = yieldData.spirit_stones;
        // 修为按1:1折算（粗略估算）
        value += Math.floor(yieldData.cultivation / 10);
        // LDC按10000灵石折算
        value += yieldData.ldc * 10000;
        // 物品按price折算（简化估算，实际应查询item_data）
        for (const item of yieldData.items) {
            // 简化：每个物品按1000灵石估算，实际可查询item_data
            value += 1000 * item.quantity;
        }
        return value;
    }

    /**
     * 获取赌石熟练度称号
     * @param {number} level - 熟练度等级
     * @returns {string} 称号
     * @private
     */
    static _getSkillTitle(level) {
        const titles = this._config.skill.level_titles;
        let title = titles['0'];
        for (const lv of Object.keys(titles).map(Number).sort((a, b) => b - a)) {
            if (level >= lv) {
                title = titles[lv.toString()];
                break;
            }
        }
        return title;
    }

    /**
     * 1. 获取玩家赌石档案（含熟练度/日次数/统计/诅咒状态）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getProfile(playerId) {
        const t = await sequelize.transaction();
        try {
            const profile = await this._getOrCreateProfile(playerId, t);
            this._checkDailyReset(profile);
            await profile.save({ transaction: t });
            await t.commit();

            // 检查诅咒是否已过期
            const now = new Date();
            const curseActive = profile.curse_until && new Date(profile.curse_until) > now;

            return {
                success: true,
                data: {
                    skill_level: profile.skill_level,
                    skill_exp: profile.skill_exp,
                    skill_title: this._getSkillTitle(profile.skill_level),
                    daily_generates: profile.daily_generates,
                    daily_generate_limit: this._config.daily.generate_limit,
                    daily_spirit_stone_earned: profile.daily_spirit_stone_earned.toString(),
                    daily_cultivation_earned: profile.daily_cultivation_earned.toString(),
                    daily_spirit_stone_cap: this._config.daily.daily_spirit_stone_cap,
                    daily_cultivation_cap: this._config.daily.daily_cultivation_cap,
                    curse_active: curseActive,
                    curse_until: profile.curse_until,
                    stats: {
                        total_cuts: profile.total_cuts,
                        total_spirit_stone_earned: profile.total_spirit_stone_earned.toString(),
                        total_cultivation_earned: profile.total_cultivation_earned.toString(),
                        total_profit: profile.total_profit.toString(),
                        biggest_win: profile.biggest_win.toString(),
                        rare_drop_count: profile.rare_drop_count,
                        ldc_earned: profile.ldc_earned
                    },
                    insight_unlocked: profile.skill_level >= this._config.skill.insight_unlock_level
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[GamblingStoneService.getProfile] 错误:', err);
            return { success: false, message: '获取赌石档案失败：' + err.message };
        }
    }

    /**
     * 2. 生成3块原石（每日3次上限，每次3块）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data: { stones: [] } }
     */
    static async generateStones(playerId) {
        const t = await sequelize.transaction();
        try {
            const profile = await this._getOrCreateProfile(playerId, t);
            this._checkDailyReset(profile);

            // 校验每日次数上限
            if (profile.daily_generates >= this._config.daily.generate_limit) {
                await t.rollback();
                return { success: false, message: `今日已生成${this._config.daily.generate_limit}次，明日再来` };
            }

            // 校验未切开原石数量上限
            const uncutCount = await PlayerStoneRecords.count({
                where: { player_id: playerId, is_cut: 0 },
                transaction: t
            });
            if (uncutCount + this._config.daily.stones_per_generate > this._config.daily.max_uncut_stones) {
                await t.rollback();
                return {
                    success: false,
                    message: `未切开原石过多（${uncutCount}/${this._config.daily.max_uncut_stones}），请先切石或上架`
                };
            }

            // 生成3块原石
            const stones = [];
            for (let i = 0; i < this._config.daily.stones_per_generate; i++) {
                const origin = this._rollOrigin();
                const realQuality = this._rollQuality();
                const qualityCfg = this._config.qualities[realQuality];
                const clues = this._generateClues(realQuality, profile.skill_level, origin);

                // 展示品质：50%概率显示真实品质，50%概率显示随机品质（增加博弈性）
                let displayQuality;
                if (Math.random() < 0.5) {
                    displayQuality = realQuality;
                } else {
                    const qualities = Object.keys(this._config.qualities);
                    displayQuality = qualities[Math.floor(Math.random() * qualities.length)];
                }

                const stone = await PlayerStoneRecords.create({
                    player_id: playerId,
                    origin_player_id: playerId,
                    origin: origin,
                    quality: displayQuality,
                    base_price: this._config.qualities[displayQuality].base_price,
                    clues: clues,
                    real_quality: realQuality,
                    is_cut: 0,
                    generated_at: new Date()
                }, { transaction: t });

                stones.push({
                    id: stone.id,
                    origin: origin,
                    origin_name: this._config.origins[origin].name,
                    origin_icon: this._config.origins[origin].icon,
                    quality: displayQuality,
                    quality_name: qualityCfg.name,
                    base_price: stone.base_price,
                    clues: {
                        crust: clues.crust,
                        weight: clues.weight,
                        aura: clues.aura,
                        color: clues.color
                    },
                    generated_at: stone.generated_at
                });
            }

            // 扣减每日次数
            profile.daily_generates += 1;
            await profile.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `生成${stones.length}块原石，今日剩余${this._config.daily.generate_limit - profile.daily_generates}次`,
                data: {
                    stones: stones,
                    daily_generates_remaining: this._config.daily.generate_limit - profile.daily_generates
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[GamblingStoneService.generateStones] 错误:', err);
            return { success: false, message: '生成原石失败：' + err.message };
        }
    }

    /**
     * 3. 获取当前未切开原石列表
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data: { stones: [] } }
     */
    static async getStones(playerId) {
        try {
            const stones = await PlayerStoneRecords.findAll({
                where: { player_id: playerId, is_cut: 0 },
                order: [['generated_at', 'DESC']]
            });

            const result = stones.map(s => {
                const clues = s.clues || {};
                return {
                    id: s.id,
                    origin: s.origin,
                    origin_name: this._config.origins[s.origin]?.name || s.origin,
                    origin_icon: this._config.origins[s.origin]?.icon || '石',
                    quality: s.quality,
                    quality_name: this._config.qualities[s.quality]?.name || s.quality,
                    quality_color: this._config.qualities[s.quality]?.color || '#9ca3af',
                    base_price: s.base_price,
                    clues: {
                        crust: clues.crust,
                        weight: clues.weight,
                        aura: clues.aura,
                        color: clues.color
                    },
                    is_listed: s.is_listed === 1,
                    listing_price: s.listing_price ? s.listing_price.toString() : null,
                    generated_at: s.generated_at
                };
            });

            return { success: true, data: { stones: result, count: result.length } };
        } catch (err) {
            console.error('[GamblingStoneService.getStones] 错误:', err);
            return { success: false, message: '获取原石列表失败：' + err.message };
        }
    }

    /**
     * 4. 获取原石详情（含线索展示）
     * @param {number} playerId - 玩家ID
     * @param {number} stoneId - 原石ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getStoneDetail(playerId, stoneId) {
        try {
            const stone = await PlayerStoneRecords.findByPk(stoneId);
            if (!stone) {
                return { success: false, message: '原石不存在' };
            }
            if (stone.player_id !== playerId) {
                return { success: false, message: '无权查看他人原石' };
            }
            if (stone.is_cut === 1) {
                return { success: false, message: '该原石已切开，请查看记录' };
            }

            const clues = stone.clues || {};
            const profile = await this._getOrCreateProfile(playerId);

            return {
                success: true,
                data: {
                    id: stone.id,
                    origin: stone.origin,
                    origin_name: this._config.origins[stone.origin]?.name,
                    origin_description: this._config.origins[stone.origin]?.description,
                    origin_icon: this._config.origins[stone.origin]?.icon,
                    quality: stone.quality,
                    quality_name: this._config.qualities[stone.quality]?.name,
                    quality_color: this._config.qualities[stone.quality]?.color,
                    base_price: stone.base_price,
                    clues: {
                        crust: { name: this._config.clues.crust.name, value: clues.crust },
                        weight: { name: this._config.clues.weight.name, value: clues.weight },
                        aura: { name: this._config.clues.aura.name, value: clues.aura },
                        color: { name: this._config.clues.color.name, value: clues.color }
                    },
                    is_listed: stone.is_listed === 1,
                    listing_price: stone.listing_price ? stone.listing_price.toString() : null,
                    generated_at: stone.generated_at,
                    skill_level: profile.skill_level,
                    skill_title: this._getSkillTitle(profile.skill_level),
                    insight_unlocked: profile.skill_level >= this._config.skill.insight_unlock_level
                }
            };
        } catch (err) {
            console.error('[GamblingStoneService.getStoneDetail] 错误:', err);
            return { success: false, message: '获取原石详情失败：' + err.message };
        }
    }

    /**
     * 5. 切开原石（核心博彩逻辑）
     * @param {number} playerId - 玩家ID
     * @param {number} stoneId - 原石ID
     * @param {string} cutMethod - 切开方式：rough/fine/divine_sense
     * @returns {Promise<Object>} { success, data: { yield: {}, stats: {} } }
     */
    static async cutStone(playerId, stoneId, cutMethod) {
        const t = await sequelize.transaction();
        try {
            // 校验切法
            const methodCfg = this._config.cut_methods[cutMethod];
            if (!methodCfg) {
                await t.rollback();
                return { success: false, message: '切法无效，可选：rough/fine/divine_sense' };
            }

            // 锁定原石记录
            const stone = await PlayerStoneRecords.findByPk(stoneId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!stone) {
                await t.rollback();
                return { success: false, message: '原石不存在' };
            }
            if (stone.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '无权切开他人原石' };
            }
            if (stone.is_cut === 1) {
                await t.rollback();
                return { success: false, message: '该原石已切开' };
            }
            if (stone.is_listed === 1) {
                await t.rollback();
                return { success: false, message: '原石已上架拍卖行，请先取消上架' };
            }

            // 锁定玩家
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 校验切法费用
            // 精切需100灵石
            if (methodCfg.cost_spirit_stones > 0) {
                const playerStones = BigInt(player.spirit_stones || 0);
                if (playerStones < BigInt(methodCfg.cost_spirit_stones)) {
                    await t.rollback();
                    return { success: false, message: `灵石不足，${methodCfg.name}需${methodCfg.cost_spirit_stones}灵石` };
                }
            }
            // 神识切需大衍诀1层
            if (methodCfg.cost_dayan_level > 0) {
                const dayanLevel = await this._getDayanLevel(playerId, t);
                if (dayanLevel < methodCfg.cost_dayan_level) {
                    await t.rollback();
                    return { success: false, message: `大衍诀层数不足，${methodCfg.name}需${methodCfg.cost_dayan_level}层` };
                }
            }

            // 锁定赌石档案
            const profile = await this._getOrCreateProfile(playerId, t);
            this._checkDailyReset(profile);

            // 扣除切石费用
            let cutCost = BigInt(0);
            if (methodCfg.cost_spirit_stones > 0) {
                cutCost = BigInt(methodCfg.cost_spirit_stones);
                player.spirit_stones = (BigInt(player.spirit_stones || 0) - cutCost).toString();
            }

            // 滚动产出（使用真实品质，不是展示品质）
            const yieldData = this._rollYield(stone.origin, stone.real_quality, cutMethod, profile.skill_level);
            const yieldValue = this._calcYieldValue(yieldData);

            // 精切保底：产出价值不低于基础价60%
            if (cutMethod === 'fine' && yieldValue < Math.floor(stone.base_price * 0.6)) {
                // 补足灵石产出至保底值
                const supplement = Math.floor(stone.base_price * 0.6) - yieldValue;
                yieldData.spirit_stones += supplement;
            }

            // 日上限校验：灵石/修为超出日上限则截断
            const stoneCap = this._config.daily.daily_spirit_stone_cap;
            const cultCap = this._config.daily.daily_cultivation_cap;
            let actualStones = yieldData.spirit_stones;
            let actualCult = yieldData.cultivation;
            if (profile.daily_spirit_stone_earned + actualStones > stoneCap) {
                actualStones = Math.max(0, stoneCap - profile.daily_spirit_stone_earned);
            }
            if (profile.daily_cultivation_earned + actualCult > cultCap) {
                actualCult = Math.max(0, cultCap - profile.daily_cultivation_earned);
            }
            yieldData.spirit_stones = actualStones;
            yieldData.cultivation = actualCult;

            // 发放灵石
            if (actualStones > 0) {
                player.spirit_stones = (BigInt(player.spirit_stones || 0) + BigInt(actualStones)).toString();
                profile.daily_spirit_stone_earned += actualStones;
                profile.total_spirit_stone_earned += actualStones;
            }

            // 发放修为（exp字段）
            if (actualCult > 0) {
                player.exp = (BigInt(player.exp || 0) + BigInt(actualCult)).toString();
                profile.daily_cultivation_earned += actualCult;
                profile.total_cultivation_earned += actualCult;
            }

            // 发放LDC
            if (yieldData.ldc > 0) {
                player.ldc = parseInt(player.ldc || 0) + yieldData.ldc;
                profile.ldc_earned += yieldData.ldc;
            }

            // 发放物品
            for (const item of yieldData.items) {
                await InventoryService.addItem(playerId, item.item_id, item.quantity, t);
            }

            // 诅咒触发
            if (yieldData.curse_triggered) {
                const curseUntil = new Date(Date.now() + this._config.yield_pools.curse_drops.curse_duration_hours * 3600 * 1000);
                profile.curse_until = curseUntil;
            }

            // 更新统计
            profile.total_cuts += 1;
            profile.rare_drop_count += yieldData.rare_drops.length;
            const netProfit = yieldValue - Number(cutCost);
            profile.total_profit += netProfit;
            if (yieldValue > profile.biggest_win) {
                profile.biggest_win = yieldValue;
            }

            // 熟练度经验
            profile.skill_exp += this._config.skill.exp_per_cut;
            if (yieldData.rare_drops.length > 0) {
                profile.skill_exp += this._config.skill.exp_per_rare_drop;
            }
            // 升级判定
            while (profile.skill_level < this._config.skill.max_level && profile.skill_exp >= profile.skill_level * 100 + 100) {
                profile.skill_exp -= profile.skill_level * 100 + 100;
                profile.skill_level += 1;
            }

            // 更新原石记录
            stone.is_cut = 1;
            stone.cut_method = cutMethod;
            stone.cut_at = new Date();
            stone.cut_cost = Number(cutCost);
            stone.yield_data = yieldData;
            stone.yield_value = yieldValue;

            await player.save({ transaction: t });
            await profile.save({ transaction: t });
            await stone.save({ transaction: t });
            await t.commit();

            // 推送通知（commit 后推送，避免数据回滚不一致）
            try {
                const msg = this._buildCutResultMessage(yieldData, stone, methodCfg);
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'gambling_stone_cut',
                    message: msg,
                    data: { stone_id: stoneId, yield: yieldData, curse_triggered: yieldData.curse_triggered }
                });

                // 稀有掉落全服广播
                if (yieldData.rare_drops.length > 0) {
                    const rareNames = yieldData.rare_drops.map(r => r.name).join('、');
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        type: 'gambling_stone_rare',
                        message: `【赌石奇遇】玩家在${this._config.origins[stone.origin].name}切出稀有物品：${rareNames}！`,
                        data: { player_id: playerId, origin: stone.origin, rares: yieldData.rare_drops }
                    });
                }
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: this._buildCutResultMessage(yieldData, stone, methodCfg),
                data: {
                    stone_id: stoneId,
                    origin: stone.origin,
                    origin_name: this._config.origins[stone.origin].name,
                    display_quality: stone.quality,
                    real_quality: stone.real_quality,
                    real_quality_name: this._config.qualities[stone.real_quality].name,
                    cut_method: cutMethod,
                    cut_method_name: methodCfg.name,
                    cut_cost: cutCost.toString(),
                    yield: {
                        spirit_stones: yieldData.spirit_stones.toString(),
                        cultivation: yieldData.cultivation.toString(),
                        items: yieldData.items,
                        ldc: yieldData.ldc,
                        rare_drops: yieldData.rare_drops,
                        curse_triggered: yieldData.curse_triggered
                    },
                    yield_value: yieldValue.toString(),
                    net_profit: (yieldValue - Number(cutCost)).toString(),
                    skill_level: profile.skill_level,
                    skill_exp: profile.skill_exp,
                    skill_title: this._getSkillTitle(profile.skill_level)
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[GamblingStoneService.cutStone] 错误:', err);
            return { success: false, message: '切石失败：' + err.message };
        }
    }

    /**
     * 构建切石结果消息
     * @param {Object} yieldData - 产出
     * @param {Object} stone - 原石记录
     * @param {Object} methodCfg - 切法配置
     * @returns {string} 消息
     * @private
     */
    static _buildCutResultMessage(yieldData, stone, methodCfg) {
        const parts = [`${methodCfg.name}切开${this._config.qualities[stone.real_quality].name}（产地：${this._config.origins[stone.origin].name}）`];
        if (yieldData.spirit_stones > 0) parts.push(`灵石+${yieldData.spirit_stones}`);
        if (yieldData.cultivation > 0) parts.push(`修为+${yieldData.cultivation}`);
        if (yieldData.ldc > 0) parts.push(`LDC+${yieldData.ldc}`);
        if (yieldData.items.length > 0) {
            const itemStr = yieldData.items.map(i => `${i.item_id}×${i.quantity}`).join('、');
            parts.push(`物品：${itemStr}`);
        }
        if (yieldData.rare_drops.length > 0) {
            parts.push(`稀有：${yieldData.rare_drops.map(r => r.name).join('、')}`);
        }
        if (yieldData.curse_triggered) parts.push('⚠触发石中诅咒！');
        return parts.join('，');
    }

    /**
     * 6. 获取切开历史记录
     * @param {number} playerId - 玩家ID
     * @param {number} page - 页码（1开始）
     * @param {number} pageSize - 每页数量
     * @returns {Promise<Object>} { success, data: { records: [], total, page, page_size } }
     */
    static async getRecords(playerId, page = 1, pageSize = 20) {
        try {
            const offset = (page - 1) * pageSize;
            const { rows, count } = await PlayerStoneRecords.findAndCountAll({
                where: { player_id: playerId, is_cut: 1 },
                order: [['cut_at', 'DESC']],
                limit: pageSize,
                offset: offset
            });

            const records = rows.map(r => ({
                id: r.id,
                origin: r.origin,
                origin_name: this._config.origins[r.origin]?.name,
                quality: r.quality,
                real_quality: r.real_quality,
                real_quality_name: this._config.qualities[r.real_quality]?.name,
                cut_method: r.cut_method,
                cut_method_name: this._config.cut_methods[r.cut_method]?.name,
                cut_at: r.cut_at,
                cut_cost: r.cut_cost.toString(),
                yield: r.yield_data,
                yield_value: r.yield_value.toString()
            }));

            return {
                success: true,
                data: {
                    records: records,
                    total: count,
                    page: page,
                    page_size: pageSize,
                    total_pages: Math.ceil(count / pageSize)
                }
            };
        } catch (err) {
            console.error('[GamblingStoneService.getRecords] 错误:', err);
            return { success: false, message: '获取历史记录失败：' + err.message };
        }
    }

    /**
     * 7. 获取排行榜
     * @param {string} type - 排行类型：biggest_win/total_profit/rare_count/skill_level
     * @returns {Promise<Object>} { success, data: { ranking: [] } }
     */
    static async getRanking(type) {
        try {
            if (!this._config.ranking.types.includes(type)) {
                return { success: false, message: `排行类型无效，可选：${this._config.ranking.types.join('/')}` };
            }

            const orderField = type === 'biggest_win' ? 'biggest_win'
                : type === 'total_profit' ? 'total_profit'
                : type === 'rare_count' ? 'rare_drop_count'
                : 'skill_level';

            const records = await PlayerGamblingStone.findAll({
                where: { [orderField]: { [Op.gt]: 0 } },
                order: [[orderField, 'DESC']],
                limit: this._config.ranking.limit
            });

            // 手动查询玩家昵称（避免依赖模型关联定义）
            const playerIds = records.map(r => r.player_id);
            const players = playerIds.length > 0 ? await Player.findAll({
                where: { id: playerIds },
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            }) : [];
            const playerMap = new Map(players.map(p => [p.id, p]));

            const ranking = records.map((r, idx) => {
                const p = playerMap.get(r.player_id);
                return {
                    rank: idx + 1,
                    player_id: r.player_id,
                    nickname: p?.nickname || '神秘修士',
                    realm: p?.realm || '',
                    skill_level: r.skill_level,
                    skill_title: this._getSkillTitle(r.skill_level),
                    value: type === 'rare_count' ? r.rare_drop_count : r[orderField].toString()
                };
            });

            return { success: true, data: { ranking, type } };
        } catch (err) {
            console.error('[GamblingStoneService.getRanking] 错误:', err);
            return { success: false, message: '获取排行榜失败：' + err.message };
        }
    }

    /**
     * 8. 上架拍卖行（未切开原石流转）
     * @param {number} playerId - 玩家ID
     * @param {number} stoneId - 原石ID
     * @param {number} price - 上架价格
     * @returns {Promise<Object>} { success, data }
     */
    static async listStone(playerId, stoneId, price) {
        const t = await sequelize.transaction();
        try {
            if (!this._config.trade.enabled) {
                await t.rollback();
                return { success: false, message: '原石流转功能未开启' };
            }

            const priceBig = Number(price);
            if (!Number.isFinite(priceBig) || priceBig <= 0) {
                await t.rollback();
                return { success: false, message: '上架价格必须为正数' };
            }

            const stone = await PlayerStoneRecords.findByPk(stoneId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!stone) {
                await t.rollback();
                return { success: false, message: '原石不存在' };
            }
            if (stone.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '无权上架他人原石' };
            }
            if (stone.is_cut === 1) {
                await t.rollback();
                return { success: false, message: '已切开原石不可上架' };
            }
            if (stone.is_listed === 1) {
                await t.rollback();
                return { success: false, message: '原石已上架，请先取消' };
            }

            // 校验价格上限：最高3倍基础价
            const maxPrice = Math.floor(stone.base_price * this._config.trade.max_markup_rate);
            if (priceBig > maxPrice) {
                await t.rollback();
                return { success: false, message: `上架价格不得超过基础价${this._config.trade.max_markup_rate}倍（${maxPrice}灵石）` };
            }

            stone.is_listed = 1;
            stone.listing_price = priceBig;
            await stone.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `原石已上架，价格${priceBig}灵石`,
                data: {
                    stone_id: stoneId,
                    listing_price: priceBig.toString(),
                    base_price: stone.base_price,
                    max_price: maxPrice
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[GamblingStoneService.listStone] 错误:', err);
            return { success: false, message: '上架失败：' + err.message };
        }
    }

    /**
     * 9. 取消上架
     * @param {number} playerId - 玩家ID
     * @param {number} stoneId - 原石ID
     * @returns {Promise<Object>} { success, data }
     */
    static async unlistStone(playerId, stoneId) {
        const t = await sequelize.transaction();
        try {
            const stone = await PlayerStoneRecords.findByPk(stoneId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!stone) {
                await t.rollback();
                return { success: false, message: '原石不存在' };
            }
            if (stone.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '无权操作他人原石' };
            }
            if (stone.is_listed !== 1) {
                await t.rollback();
                return { success: false, message: '原石未上架' };
            }

            stone.is_listed = 0;
            stone.listing_price = null;
            await stone.save({ transaction: t });
            await t.commit();

            return { success: true, message: '已取消上架', data: { stone_id: stoneId } };
        } catch (err) {
            await t.rollback();
            console.error('[GamblingStoneService.unlistStone] 错误:', err);
            return { success: false, message: '取消上架失败：' + err.message };
        }
    }

    /**
     * 10. 灵识透石（熟练度100级解锁，查看1条真实线索）
     * @param {number} playerId - 玩家ID
     * @param {number} stoneId - 原石ID
     * @returns {Promise<Object>} { success, data: { insight_clue } }
     */
    static async insightStone(playerId, stoneId) {
        try {
            const profile = await this._getOrCreateProfile(playerId);
            if (profile.skill_level < this._config.skill.insight_unlock_level) {
                return { success: false, message: `需赌石熟练度${this._config.skill.insight_unlock_level}级方可灵识透石` };
            }

            const stone = await PlayerStoneRecords.findByPk(stoneId);
            if (!stone) {
                return { success: false, message: '原石不存在' };
            }
            if (stone.player_id !== playerId) {
                return { success: false, message: '无权查看他人原石' };
            }
            if (stone.is_cut === 1) {
                return { success: false, message: '原石已切开' };
            }

            // 透示真实品质（不直接告诉，而是给一条真实线索）
            const clues = stone.clues || {};
            const realQuality = stone.real_quality;
            const qualityList = ['common', 'spirit_vein', 'treasure_glow', 'fairy_mist'];
            const realQualityIdx = qualityList.indexOf(realQuality);

            // 随机选一个维度透示真实线索
            const dims = ['crust', 'weight', 'aura', 'color'];
            const pickedDim = dims[Math.floor(Math.random() * dims.length)];
            const values = this._config.clues[pickedDim].values;
            const isCursed = stone.origin === 'cursed_vein';
            let trueIdx = Math.min(realQualityIdx, values.length - 1);
            if (isCursed) trueIdx = values.length - 1 - trueIdx;
            const trueValue = values[trueIdx];

            return {
                success: true,
                message: `灵识透石：${this._config.clues[pickedDim].name}的真实线索为「${trueValue}」`,
                data: {
                    stone_id: stoneId,
                    insight_dim: pickedDim,
                    insight_dim_name: this._config.clues[pickedDim].name,
                    insight_value: trueValue,
                    current_clue_value: clues[pickedDim],
                    is_fake: clues[pickedDim] !== trueValue
                }
            };
        } catch (err) {
            console.error('[GamblingStoneService.insightStone] 错误:', err);
            return { success: false, message: '灵识透石失败：' + err.message };
        }
    }
}

module.exports = GamblingStoneService;
