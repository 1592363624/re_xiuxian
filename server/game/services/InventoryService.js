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
        if (config.type !== 'consumable') {
            throw new AppError('该物品不可使用', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 查询玩家物品记录（加锁防并发）
            const playerItem = await Item.findOne({
                where: { player_id: playerId, item_key: itemKey },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!playerItem || playerItem.quantity < quantity) {
                throw new AppError('物品数量不足', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 查询玩家
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已陨落，无法使用物品', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 应用物品效果
            const effect = config.effect || {};
            const appliedEffects = await this._applyItemEffect(player, effect, quantity, t);

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
    async addItem(playerId, itemKey, quantity = 1, transaction = null) {
        if (quantity < 1) {
            throw new AppError('添加数量必须大于 0', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const config = this.getItemConfig(itemKey);
        if (!config) {
            throw new AppError(`物品配置不存在: ${itemKey}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 容量检查
        const capacity = this.getInventoryConfig().capacity || 100;
        const totalOwned = await Item.sum('quantity', { where: { player_id: playerId } }) || 0;
        if (totalOwned + quantity > capacity) {
            throw new AppError(`储物袋容量不足（上限 ${capacity}）`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const options = transaction ? { transaction } : {};
        // 查找已有记录，存在则累加
        const existing = await Item.findOne({
            where: { player_id: playerId, item_key: itemKey },
            ...options
        });

        if (existing) {
            existing.quantity += quantity;
            await existing.save(options);
        } else {
            await Item.create({
                player_id: playerId,
                item_key: itemKey,
                quantity: quantity
            }, options);
        }

        return {
            success: true,
            item_key: itemKey,
            item_name: config.name,
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
     * @param {Object} player - 玩家实例
     * @param {Object} effect - 物品效果配置
     * @param {number} multiplier - 数量倍率
     * @param {Object} transaction - 事务实例
     * @returns {Promise<Object>} 实际应用的效果
     */
    async _applyItemEffect(player, effect, multiplier, transaction) {
        const applied = {};
        const attrs = player.attributes;
        const hpMax = attrs.hp_max || 100;
        const mpMax = attrs.mp_max || 0;

        // 恢复气血
        if (effect.hp_restore) {
            const restore = effect.hp_restore * multiplier;
            player.hp_current = Math.min(hpMax, Number(player.hp_current) + restore);
            applied.hp_restore = restore;
        }

        // 恢复灵力
        if (effect.mp_restore) {
            const restore = effect.mp_restore * multiplier;
            player.mp_current = Math.min(mpMax, Number(player.mp_current) + restore);
            applied.mp_restore = restore;
        }

        // 增加灵石
        if (effect.spirit_stones) {
            const gain = effect.spirit_stones * multiplier;
            player.spirit_stones = BigInt(player.spirit_stones || 0) + BigInt(gain);
            applied.spirit_stones = gain;
        }

        // 增加修为
        if (effect.exp) {
            const gain = effect.exp * multiplier;
            player.exp = BigInt(player.exp || 0) + BigInt(gain);
            applied.exp = gain;
        }

        // 突破加成（仅记录，实际使用在突破流程读取）
        if (effect.breakthrough_bonus) {
            applied.breakthrough_bonus = effect.breakthrough_bonus;
        }

        return applied;
    }
}

module.exports = new InventoryService();
