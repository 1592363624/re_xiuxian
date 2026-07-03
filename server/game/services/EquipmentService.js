/**
 * 装备穿戴服务模块
 * 处理玩家装备的穿戴、卸下、查询及装备加成计算等核心业务逻辑
 *
 * 设计说明：
 *   - 装备的静态属性（名称、效果、境界要求等）从 item_data.json 读取（配置中心化）
 *   - 装备槽位（slot）由物品的 subtype 字段决定：weapon/armor/accessory/boots/dharma
 *   - 一个玩家每个槽位只能装备一件物品（由 player_equipment 表唯一索引约束）
 *   - 穿戴时从背包扣减物品，卸下时归还背包，使用事务保证数据一致性
 *   - 通过延迟 require InventoryService 避免循环依赖（InventoryService.useItem 也会延迟 require 本服务）
 */
// 修复：config/database.js 直接导出 sequelize 实例，不能用解构导入（否则拿到 undefined）
const sequelize = require('../../config/database');
const PlayerEquipment = require('../../models/playerEquipment');
const Player = require('../../models/player');
const Item = require('../../models/item');
const InventoryService = require('./InventoryService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

class EquipmentService {
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
     * 获取装备相关配置（合法槽位、槽位中文名等）
     * @returns {Object} 装备配置
     */
    getEquipmentConfig() {
        return this.configLoader?.getConfig('game_balance')?.equipment || {};
    }

    /**
     * 获取物品静态配置（与 InventoryService 一致）
     * @param {string} itemKey - 物品配置键名
     * @returns {Object|null} 物品配置
     */
    getItemConfig(itemKey) {
        const items = this.configLoader?.getConfig('item_data')?.items || [];
        return items.find(i => i.id === itemKey) || null;
    }

    /**
     * 获取玩家所有已装备物品（合并静态配置返回完整信息）
     * @param {number} playerId - 玩家 ID
     * @returns {Promise<Object>} 已装备物品列表（按槽位分组）
     */
    async getEquipped(playerId) {
        // 查询玩家所有装备记录
        const equipments = await PlayerEquipment.findAll({
            where: { player_id: playerId },
            order: [['equipped_at', 'DESC']]
        });

        const equipmentConfig = this.getEquipmentConfig();
        const slotNames = equipmentConfig.slot_names || {};
        const result = {
            slots: {},
            count: 0
        };

        for (const record of equipments) {
            const config = this.getItemConfig(record.item_key);
            // 合并静态配置 + 动态记录
            result.slots[record.slot] = {
                record_id: record.id,
                slot: record.slot,
                slot_name: slotNames[record.slot] || record.slot,
                item_key: record.item_key,
                name: config?.name || '未知装备',
                type: config?.type || 'equipment',
                subtype: config?.subtype || record.slot,
                quality: config?.quality || 'common',
                description: config?.description || '',
                effect: config?.effect || {},
                price: config?.price || 0,
                required_realm_rank: config?.required_realm_rank || 0,
                equipped_at: record.equipped_at
            };
            result.count += 1;
        }

        return result;
    }

    /**
     * 穿戴装备
     * 业务流程：
     *   1. 校验物品配置存在且类型为 equipment
     *   2. 校验物品 subtype 为合法槽位
     *   3. 校验玩家境界满足装备要求
     *   4. 校验背包中拥有该物品
     *   5. 若该槽位已有装备，先卸下旧装备（归还背包）
     *   6. 从背包扣减新装备
     *   7. 创建 PlayerEquipment 记录
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品配置键名
     * @returns {Promise<Object>} 穿戴结果
     */
    async equip(playerId, itemKey) {
        // 参数校验
        if (!itemKey) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 获取物品静态配置
        const config = this.getItemConfig(itemKey);
        if (!config) {
            throw new AppError('物品不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 校验物品类型为装备
        if (config.type !== 'equipment') {
            throw new AppError('该物品不是装备，无法穿戴', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验槽位合法性（槽位由物品 subtype 决定）
        const slot = config.subtype;
        const equipmentConfig = this.getEquipmentConfig();
        const validSlots = equipmentConfig.valid_slots || [];
        if (validSlots.length > 0 && !validSlots.includes(slot)) {
            throw new AppError(`无效的装备槽位: ${slot}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 查询玩家（加锁防并发）
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已陨落，无法穿戴装备', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 校验境界要求
            const requiredRank = config.required_realm_rank || 0;
            const playerRank = player.realm_rank || 0;
            if (requiredRank > playerRank) {
                throw new AppError(
                    `境界不足，穿戴 ${config.name} 需要境界排名 ${requiredRank}，当前 ${playerRank}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 校验背包中拥有该物品
            const playerItem = await Item.findOne({
                where: { player_id: playerId, item_key: itemKey },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!playerItem || playerItem.quantity < 1) {
                throw new AppError('背包中没有该装备', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 检查该槽位是否已有装备，若有则先卸下旧装备（归还背包）
            const existingEquip = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            let unequippedItem = null;
            if (existingEquip) {
                const oldConfig = this.getItemConfig(existingEquip.item_key);
                unequippedItem = {
                    item_key: existingEquip.item_key,
                    name: oldConfig?.name || existingEquip.item_key
                };
                // 删除旧装备记录
                await existingEquip.destroy({ transaction: t });
                // 旧装备归还背包（在同一事务内，保证一致性）
                await InventoryService.addItem(playerId, existingEquip.item_key, 1, t);
            }

            // 从背包扣减新装备
            const removed = await InventoryService.removeItem(playerId, itemKey, 1, t);
            if (!removed) {
                throw new AppError('背包物品扣减失败', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 创建新装备记录
            await PlayerEquipment.create({
                player_id: playerId,
                slot,
                item_key: itemKey,
                equipped_at: new Date()
            }, { transaction: t });

            await t.commit();

            return {
                success: true,
                message: `成功穿戴 ${config.name}`,
                slot,
                slot_name: equipmentConfig.slot_names?.[slot] || slot,
                item: {
                    item_key: itemKey,
                    name: config.name,
                    quality: config.quality || 'common',
                    effect: config.effect || {}
                },
                unequipped: unequippedItem
            };
        } catch (error) {
            // 回滚前检查事务是否已完成（避免重复回滚报错）
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 卸下装备
     * 业务流程：
     *   1. 校验槽位合法性
     *   2. 校验该槽位是否有装备
     *   3. 删除 PlayerEquipment 记录
     *   4. 将物品归还背包
     * @param {number} playerId - 玩家 ID
     * @param {string} slot - 装备槽位
     * @returns {Promise<Object>} 卸下结果
     */
    async unequip(playerId, slot) {
        // 参数校验
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验槽位合法性
        const equipmentConfig = this.getEquipmentConfig();
        const validSlots = equipmentConfig.valid_slots || [];
        if (validSlots.length > 0 && !validSlots.includes(slot)) {
            throw new AppError(`无效的装备槽位: ${slot}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 查询玩家（加锁防并发）
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已陨落，无法卸下装备', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 查询该槽位的装备记录（加锁）
            const equipment = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!equipment) {
                throw new AppError(`该槽位没有装备`, 400, ErrorCodes.VALIDATION_ERROR);
            }

            const config = this.getItemConfig(equipment.item_key);
            const itemName = config?.name || equipment.item_key;

            // 删除装备记录
            await equipment.destroy({ transaction: t });

            // 将物品归还背包
            await InventoryService.addItem(playerId, equipment.item_key, 1, t);

            await t.commit();

            return {
                success: true,
                message: `已卸下 ${itemName}`,
                slot,
                slot_name: equipmentConfig.slot_names?.[slot] || slot,
                item: {
                    item_key: equipment.item_key,
                    name: itemName
                }
            };
        } catch (error) {
            // 回滚前检查事务是否已完成（避免重复回滚报错）
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 计算玩家装备总加成（供 AttributeService 调用）
     * 遍历所有已装备物品，累加 effect 字段中的属性值
     * @param {number} playerId - 玩家 ID
     * @returns {Promise<Object>} 装备总加成 { atk, def, hp_max, mp_max, speed, sense, luck, ... }
     */
    async getEquipmentBonus(playerId) {
        // 查询玩家所有装备记录
        const equipments = await PlayerEquipment.findAll({
            where: { player_id: playerId }
        });

        // 累加所有装备的 effect 字段
        const bonus = {};
        for (const record of equipments) {
            const config = this.getItemConfig(record.item_key);
            const effect = config?.effect || {};
            for (const [key, value] of Object.entries(effect)) {
                // 仅累加数值型属性
                if (typeof value === 'number') {
                    bonus[key] = (bonus[key] || 0) + value;
                }
            }
        }

        return bonus;
    }
}

// 单例模式导出，确保全局只有一个 EquipmentService 实例
module.exports = new EquipmentService();
