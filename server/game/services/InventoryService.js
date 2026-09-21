/**
 * 背包（储物袋）服务模块
 * 处理玩家物品的查询、使用、丢弃、整理等核心业务逻辑
 *
 * 设计说明：
 *   - player_items 表仅存储 player_id + item_key + quantity（动态数据）
 *   - 物品的名称、描述、效果等静态属性从 item_data.json 读取（配置中心化）
 *   - 使用物品时，根据物品效果类型分别处理：恢复气血/灵力、突破加成、增益 buff
 *   - 丢弃/出售物品时使用事务保证数据一致性
 */
// 修复：config/database.js 直接导出 sequelize 实例，不能用解构导入（否则拿到 undefined）
const sequelize = require('../../config/database');
const { infrastructure } = require('../../modules');
const Player = require('../../models/player');
const Item = require('../../models/item');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

class InventoryService {
    constructor() {
        this.configLoader = null;
    }

    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 懒加载获取背包配置（容量上限、分类等）
     * @returns {Object} 背包配置
     */
    getInventoryConfig() {
        return this.configLoader?.getConfig('game_balance')?.inventory || {};
    }

    /**
     * 获取物品静态配置
     * @param {string} itemKey - 物品配置键名
     * @returns {Object|null} 物品配置
     */
    getItemConfig(itemKey) {
        const items = this.configLoader?.getConfig('item_data')?.items || [];
        return items.find(i => i.id === itemKey) || null;
    }

    /**
     * 获取玩家背包列表（合并静态配置 + 动态数量）
     * @param {number} playerId - 玩家 ID
     * @returns {Promise<Object>} 背包数据（按类型分组）
     */
    async getInventory(playerId) {
        // 查询玩家所有物品记录
        const playerItems = await Item.findAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']]
        });

        // 合并静态配置
        const result = {
            items: [],
            total_count: 0,
            capacity: this.getInventoryConfig().capacity || 100
        };

        for (const record of playerItems) {
            const config = this.getItemConfig(record.item_key);
            if (!config) {
                // 配置缺失的物品仍保留，标记为未知
                result.items.push({
                    record_id: record.id,
                    item_key: record.item_key,
                    name: '未知物品',
                    type: 'unknown',
                    quality: 'common',
                    description: '物品配置已失效',
                    quantity: record.quantity,
                    usable: false
                });
            } else {
                result.items.push({
                    record_id: record.id,
                    item_key: record.item_key,
                    name: config.name,
                    type: config.type,
                    subtype: config.subtype || null,
                    quality: config.quality || 'common',
                    description: config.description || '',
                    effect: config.effect || {},
                    price: config.price || 0,
                    quantity: record.quantity,
                    usable: config.type === 'consumable'
                });
            }
            result.total_count += record.quantity;
        }

        return result;
    }

    /**
     * 使用物品（消耗品）
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品键名
     * @param {number} quantity - 使用数量
     * @returns {Promise<Object>} 使用结果
     */
    async useItem(playerId, itemKey, quantity = 1) {
        // 参数校验
        if (quantity < 1 || quantity > 99) {
            throw new AppError('使用数量必须在 1-99 之间', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const config = this.getItemConfig(itemKey);
        if (!config) {
            throw new AppError('物品不存在', 404, ErrorCodes.NOT_FOUND);
        }
        // 装备类物品走穿戴流程（延迟 require 避免与 EquipmentService 循环依赖）
        if (config.type === 'equipment') {
            const EquipmentService = require('./EquipmentService');
            return await EquipmentService.equip(playerId, itemKey);
        }
        // 丹方/图谱走学习配方流程（延迟 require 避免与 CraftingService 循环依赖）
        if (config.type === 'recipe_scroll') {
            const CraftingService = require('./CraftingService');
            return await CraftingService.learnRecipe(playerId, itemKey);
        }
        if (config.type !== 'consumable') {
            throw new AppError('该物品不可使用', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 永久属性加成丹药一次只吞一颗：multiplier 会让多次服用叠加出超出单次上限的收益，
        // 而单次上限本就无法靠堆数量突破，批量使用只会白白浪费丹药
        const AttributeMaxService = require('../core/AttributeMaxService');
        const permanentEffect = AttributeMaxService.buildPillEffectFromConfig(config.effect);
        if (permanentEffect && quantity > 1) {
            throw new AppError(
                `${config.name} 为永久属性加成丹药，每次只能使用 1 颗`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        const t = await sequelize.transaction();
        try {
            // 取锁次序按 game/persistence/lockOrder.js：players 先于 items。
            // 改造前先锁背包行再回头锁玩家行，而战斗中"使用物品"（CombatService.useItem）是 players→items ——
            // 同一个人从两个面板各点一次同一枚丹药就是标准 ABBA（谁被数据库挑掉谁看到一次失败）。
            // 查询玩家
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已陨落，无法使用物品', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 查询玩家物品记录（加锁防并发）
            const playerItem = await Item.findOne({
                where: { player_id: playerId, item_key: itemKey },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!playerItem || playerItem.quantity < quantity) {
                throw new AppError('物品数量不足', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 应用物品效果
            const effect = config.effect || {};
            // 读取库存物品携带的品质倍率（炼丹/炼器产出时写入的 effect_multiplier），无则按 1 处理
            const qualityMultiplier = Number(playerItem.metadata?.effect_multiplier) || 1;
            const appliedEffects = await this._applyItemEffect(player, effect, quantity, qualityMultiplier, t);

            // 扣减物品数量
            playerItem.quantity -= quantity;
            if (playerItem.quantity <= 0) {
                await playerItem.destroy({ transaction: t });
            } else {
                await playerItem.save({ transaction: t });
            }

            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `使用了 ${config.name} x${quantity}`,
                effects: appliedEffects,
                player: {
                    hp_current: player.hp_current,
                    mp_current: player.mp_current,
                    spirit_stones: player.spirit_stones
                }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 丢弃物品
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品键名
     * @param {number} quantity - 丢弃数量
     * @returns {Promise<Object>} 丢弃结果
     */
    async discardItem(playerId, itemKey, quantity = 1) {
        if (quantity < 1) {
            throw new AppError('丢弃数量必须大于 0', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const config = this.getItemConfig(itemKey);
        const itemName = config?.name || itemKey;

        const t = await sequelize.transaction();
        try {
            const playerItem = await Item.findOne({
                where: { player_id: playerId, item_key: itemKey },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!playerItem || playerItem.quantity < quantity) {
                throw new AppError('物品数量不足', 400, ErrorCodes.VALIDATION_ERROR);
            }

            playerItem.quantity -= quantity;
            if (playerItem.quantity <= 0) {
                await playerItem.destroy({ transaction: t });
            } else {
                await playerItem.save({ transaction: t });
            }

            await t.commit();

            return {
                success: true,
                message: `丢弃了 ${itemName} x${quantity}`
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 给玩家添加物品（供其他服务调用）
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品键名
     * @param {number} quantity - 数量
     * @param {Object} transaction - 可选的事务实例
     * @returns {Promise<Object>} 添加结果
     */
    async addItem(playerId, itemKey, quantity = 1, transaction = null, metadata = null, addOptions = {}) {
        if (quantity < 1) {
            throw new AppError('添加数量必须大于 0', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const config = this.getItemConfig(itemKey);
        if (!config) {
            // 内容被下架或资料片被关闭时，"把玩家本来就有的东西还给他"绝不能失败：
            // 背包/装备面板都能显示"未知物品"，但如果这里抛错，玩家那件装备就永久卡在槽位里
            // （卸下走 addItem），遗府/拍卖/典当行的退还同理会变成"东西没了"。
            // 所以只对"凭空发一件不存在的物品"（掉落/产出/奖励，这类引用在启动期就被
            // ContentRegistry._validateReferences 校验过）保持严格。
            if (!addOptions.allowUnknownItem) {
                throw new AppError(`物品配置不存在: ${itemKey}`, 400, ErrorCodes.VALIDATION_ERROR);
            }
            console.warn(`[InventoryService] 玩家 ${playerId} 的既有物品 ${itemKey} 配置已不在当前内容中（资料片停用或内容下架？），按原样退回背包`);
        }

        // 容量检查（必须在同一事务内查询，否则会读到旧数据导致误判容量不足）
        const options = transaction ? { transaction } : {};
        const capacity = this.getInventoryConfig().capacity || 100;
        const totalOwned = await Item.sum('quantity', {
            where: { player_id: playerId },
            ...options
        }) || 0;
        if (totalOwned + quantity > capacity) {
            throw new AppError(`储物袋容量不足（上限 ${capacity}）`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 查找已有记录，存在则累加
        // 必须在本事务内对该行加锁：战斗掉落/采集/炼制都会往同一个 item_key 上叠数量，
        // 无锁的"读数量 → 加 → 存"会让并发到账互相覆盖（玩家表现为"掉的东西不见了"）。
        const existing = await Item.findOne({
            where: { player_id: playerId, item_key: itemKey },
            ...options,
            lock: transaction ? transaction.LOCK.UPDATE : undefined
        });

        if (existing) {
            existing.quantity += quantity;
            // 累计炼制产出时，以最近一次炼制的品质倍率为准（库存模型按 player_id+item_key 聚合，不区分单件品质）
            if (metadata && typeof metadata === 'object') {
                existing.metadata = metadata;
            }
            await existing.save({ ...options, lock: undefined });
        } else {
            await Item.create({
                player_id: playerId,
                item_key: itemKey,
                quantity: quantity,
                metadata: (metadata && typeof metadata === 'object') ? metadata : null
            }, options);
        }

        return {
            success: true,
            item_key: itemKey,
            // 退还既有物品时配置可能已经不在（资料片关闭）：这里只是回给调用方一个展示名
            item_name: config?.name || '未知物品',
            quantity_added: quantity
        };
    }

    /**
     * 检查玩家是否拥有指定数量的物品
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品键名
     * @param {number} quantity - 需要的数量
     * @param {Object} [transaction=null] - 可选事务实例（事务内查询需传入以保证加锁一致性）
     * @returns {Promise<boolean>} 是否拥有
     */
    async hasItem(playerId, itemKey, quantity = 1, transaction = null) {
        const options = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
        const record = await Item.findOne({
            where: { player_id: playerId, item_key: itemKey },
            ...options
        });
        return record && record.quantity >= quantity;
    }

    /**
     * 查询玩家某物品的持有数量
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品键名
     * @returns {Promise<number>} 持有数量（不存在返回0）
     */
    async getItemQuantity(playerId, itemKey) {
        const record = await Item.findOne({
            where: { player_id: playerId, item_key: itemKey }
        });
        return record ? record.quantity : 0;
    }

    /**
     * 扣减玩家物品（内部使用，不加事务）
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品键名
     * @param {number} quantity - 数量
     * @param {Object} transaction - 事务实例
     * @returns {Promise<boolean>} 是否扣减成功
     */
    async removeItem(playerId, itemKey, quantity = 1, transaction = null) {
        const options = transaction ? { transaction } : {};
        const record = await Item.findOne({
            where: { player_id: playerId, item_key: itemKey },
            ...options,
            lock: transaction ? transaction.LOCK.UPDATE : undefined
        });

        if (!record || record.quantity < quantity) {
            return false;
        }

        record.quantity -= quantity;
        if (record.quantity <= 0) {
            await record.destroy(options);
        } else {
            await record.save(options);
        }
        return true;
    }

    /**
     * 应用物品效果（内部方法）
     * 根据 effect 字段分别处理气血恢复、灵力恢复、灵石增益等
     * 最终效果 = 配置基础值 × 数量倍率(multiplier) × 品质倍率(qualityMultiplier)
     * @param {Object} player - 玩家实例
     * @param {Object} effect - 物品效果配置
     * @param {number} multiplier - 数量倍率（使用数量）
     * @param {number} qualityMultiplier - 品质倍率（炼制品质 effect_multiplier，未携带则 1）
     * @param {Object} transaction - 事务实例
     * @returns {Promise<Object>} 实际应用的效果
     */
    async _applyItemEffect(player, effect, multiplier, qualityMultiplier, transaction) {
        const applied = {};
        // 数量倍率与品质倍率叠加（品质倍率来自炼制产出的 effect_multiplier，打通"品质→收益"断链）
        const totalMultiplier = Number(multiplier) * Number(qualityMultiplier || 1);
        const attrs = player.attributes;
        // 上限取解析后的属性。blob 里的 hp_max/mp_max 是旧管线（换境界时写入的 realm 基数）留下的
        // 输出键，不含装备/功法加成：拿它当钳制，气血 4000/5000 的玩家吃一颗 +500 的回春丹
        // 会被 Math.min(1000, 4500) "补"到 1000 —— 吃药反而掉血，而且不报任何错。
        const CombatResolver = require('../combat/CombatResolver');
        const { stats: resolvedStats } = await CombatResolver.resolveCombatStats(player);
        const capOf = (resolved, mirrored, fallback) =>
            Number(resolved) > 0 ? Number(resolved) : (Number(mirrored) || fallback);
        const hpMax = capOf(resolvedStats.hp_max, attrs.hp_max, 100);
        const mpMax = capOf(resolvedStats.mp_max, attrs.mp_max, 0);

        // 恢复气血
        if (effect.hp_restore) {
            const restore = effect.hp_restore * totalMultiplier;
            // max(当前值, …)：恢复类道具在任何内容里增量都是正的，
            // 一旦上限算低了（或气血本身高于上限），宁可少补也不许把玩家打成残血。
            player.hp_current = Math.max(Number(player.hp_current), Math.min(hpMax, Number(player.hp_current) + restore));
            applied.hp_restore = restore;
        }

        // 恢复灵力
        if (effect.mp_restore) {
            const restore = effect.mp_restore * totalMultiplier;
            player.mp_current = Math.max(Number(player.mp_current), Math.min(mpMax, Number(player.mp_current) + restore));
            applied.mp_restore = restore;
        }

        // 增加灵石
        if (effect.spirit_stones) {
            const gain = effect.spirit_stones * totalMultiplier;
            player.spirit_stones = BigInt(player.spirit_stones || 0) + BigInt(gain);
            applied.spirit_stones = gain;
        }

        // 增加修为
        if (effect.exp) {
            const gain = effect.exp * totalMultiplier;
            player.exp = BigInt(player.exp || 0) + BigInt(gain);
            applied.exp = gain;
        }

        // 突破加成（仅记录，实际使用在突破流程读取）
        if (effect.breakthrough_bonus) {
            applied.breakthrough_bonus = effect.breakthrough_bonus;
        }

        // 增加寿元上限（延寿丹）：作用于玩家持久字段 lifespan_max，与 LifespanService 衰老/死亡判定同一字段
        if (effect.longevity_add) {
            const gain = Math.floor(effect.longevity_add * totalMultiplier);
            player.lifespan_max = Number(player.lifespan_max || 0) + gain;
            applied.longevity_add = gain;
        }

        // 清除丹毒（清心丹等）：作用于玩家持久字段 toxicity，钳制到非负
        if (effect.toxicity_reduce) {
            const reduce = Math.floor(effect.toxicity_reduce * totalMultiplier);
            player.toxicity = Math.max(0, Number(player.toxicity || 0) - reduce);
            applied.toxicity_reduce = reduce;
        }

        // 永久属性上限加成（属性丹）：键名与数值由服务端配置 + 白名单 + 上限钳制决定，
        // 与 POST /api/attribute/use_pill 共用同一套解析逻辑，避免两条链路口径不一
        const AttributeMaxService = require('../core/AttributeMaxService');
        const pillEffect = AttributeMaxService.buildPillEffectFromConfig(effect);
        if (pillEffect) {
            player.attributes = AttributeMaxService.applyPillBonusToAttributes(
                attrs,
                pillEffect,
                qualityMultiplier
            );
            const granted = AttributeMaxService.diffAttributeBonuses(attrs, player.attributes);
            if (Object.keys(granted).length > 0) {
                applied.permanent_attribute_bonus = granted;
            }
        }

        return applied;
    }
}

module.exports = new InventoryService();
