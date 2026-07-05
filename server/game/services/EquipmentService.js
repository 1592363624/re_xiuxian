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
            // 合并静态配置 + 动态记录（含法宝深度系统字段）
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
                equipped_at: record.equipped_at,
                // 法宝深度系统字段
                durability: record.durability,
                max_durability: record.max_durability,
                refine_level: record.refine_level,
                is_benming: record.is_benming,
                benming_slot: record.benming_slot,
                spirit_power: record.spirit_power,
                sort_order: record.sort_order,
                is_summoned: record.is_summoned,
                // 派生字段：是否已破碎（耐久<=0）
                is_broken: record.durability <= 0
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
            // 初始化耐久度（从配置读取 initial_max，默认 100）
            const durabilityConfig = equipmentConfig.durability || {};
            const initialDurability = durabilityConfig.initial_max ?? 100;

            await PlayerEquipment.create({
                player_id: playerId,
                slot,
                item_key: itemKey,
                equipped_at: new Date(),
                // 法宝深度系统字段初始化
                durability: initialDurability,
                max_durability: initialDurability,
                refine_level: 0,
                is_benming: false,
                benming_slot: null,
                spirit_power: 0,
                sort_order: 0,
                is_summoned: false
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
     * 同时叠加祭炼（refine_level）加成：
     *   - 每级祭炼按 bonus_per_level[属性] 比例提升基础 effect
     *   - 例如 atk=5, refine_level=10, bonus_per_level.atk=0.05 → atk *= (1 + 10*0.05) = 7.5
     * 耐久为 0 的装备（已破碎）不提供任何加成
     * @param {number} playerId - 玩家 ID
     * @returns {Promise<Object>} 装备总加成 { atk, def, hp_max, mp_max, speed, sense, luck, ... }
     */
    async getEquipmentBonus(playerId) {
        // 查询玩家所有装备记录
        const equipments = await PlayerEquipment.findAll({
            where: { player_id: playerId }
        });

        const equipmentConfig = this.getEquipmentConfig();
        const refineConfig = equipmentConfig.refine || {};
        const bonusPerLevel = refineConfig.bonus_per_level || {};

        // 累加所有装备的 effect 字段（含祭炼加成）
        const bonus = {};
        for (const record of equipments) {
            // 耐久为 0 的装备已破碎，不提供加成
            if (record.durability <= 0) continue;

            const config = this.getItemConfig(record.item_key);
            const effect = config?.effect || {};
            const refineLevel = record.refine_level || 0;

            for (const [key, value] of Object.entries(effect)) {
                // 仅累加数值型属性
                if (typeof value !== 'number') continue;

                // 计算祭炼加成系数（如 bonus_per_level.atk = 0.05，10级则加成 1+0.5=1.5 倍）
                const ratePerLevel = bonusPerLevel[key] || 0;
                const multiplier = 1 + refineLevel * ratePerLevel;
                const finalValue = Math.floor(value * multiplier);

                bonus[key] = (bonus[key] || 0) + finalValue;
            }
        }

        return bonus;
    }

    // ========================================
    // 法宝深度系统方法（v1.2 新增）
    // ========================================

    /**
     * 祭炼（精炼）装备
     * 业务流程：
     *   1. 校验槽位合法且有装备
     *   2. 校验耐久 > 0（破碎装备不可祭炼）
     *   3. 校验祭炼等级未达上限
     *   4. 计算并扣除消耗（灵石 + 材料）
     *   5. 按成功率随机成功/失败，失败可能降级
     *   6. 更新 refine_level
     * @param {number} playerId - 玩家 ID
     * @param {string} slot - 装备槽位
     * @returns {Promise<Object>} 祭炼结果
     */
    async refineItem(playerId, slot) {
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const equipmentConfig = this.getEquipmentConfig();
        const refineConfig = equipmentConfig.refine || {};
        const maxLevel = refineConfig.max_level ?? 15;

        const t = await sequelize.transaction();
        try {
            // 查询玩家（加锁）
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法祭炼', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            // 查询装备记录（加锁）
            const equipment = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!equipment) throw new AppError('该槽位没有装备', 400, ErrorCodes.VALIDATION_ERROR);

            // 校验耐久
            if (equipment.durability <= 0) {
                throw new AppError('装备已破碎，无法祭炼', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验祭炼等级上限
            if (equipment.refine_level >= maxLevel) {
                throw new AppError(`祭炼等级已达上限 ${maxLevel}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算消耗
            const currentLevel = equipment.refine_level;
            const stoneCost = (refineConfig.spirit_stone_cost_base ?? 100) + currentLevel * (refineConfig.spirit_stone_cost_per_level ?? 50);
            const materialCost = (refineConfig.material_cost_base ?? 1) + currentLevel * (refineConfig.material_cost_per_level ?? 1);
            const materialId = refineConfig.material_id || 'spirit_coral';

            // 校验灵石
            if (player.spirit_stones < stoneCost) {
                throw new AppError(`灵石不足，祭炼需要 ${stoneCost} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验材料（通过 InventoryService 查询）
            const hasMaterial = await InventoryService.hasItem(playerId, materialId, materialCost, t);
            if (!hasMaterial) {
                throw new AppError(`材料不足，需要 ${materialCost} 个 ${materialId}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣除灵石
            player.spirit_stones -= stoneCost;
            await player.save({ transaction: t });

            // 扣除材料
            const removed = await InventoryService.removeItem(playerId, materialId, materialCost, t);
            if (!removed) {
                throw new AppError('材料扣减失败', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 计算成功率
            const baseRate = refineConfig.base_success_rate ?? 0.9;
            const decrease = refineConfig.rate_per_level_decrease ?? 0.05;
            const minRate = refineConfig.min_success_rate ?? 0.1;
            const successRate = Math.max(minRate, baseRate - currentLevel * decrease);

            // 随机结果
            const isSuccess = Math.random() < successRate;
            const oldLevel = equipment.refine_level;

            if (isSuccess) {
                equipment.refine_level = currentLevel + 1;
            } else {
                // 失败按概率降级
                const downgradeRate = refineConfig.fail_downgrade_rate ?? 0.3;
                const breakRate = refineConfig.fail_break_rate ?? 0;
                const rand = Math.random();
                if (rand < breakRate) {
                    // 失败破碎（罕见配置，默认为 0）
                    equipment.durability = 0;
                } else if (rand < breakRate + downgradeRate && currentLevel > 0) {
                    equipment.refine_level = currentLevel - 1;
                }
                // 否则保持原级
            }

            await equipment.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: isSuccess ? `祭炼成功！等级 ${oldLevel} → ${equipment.refine_level}` : `祭炼失败，当前等级 ${equipment.refine_level}`,
                slot,
                refine_level: equipment.refine_level,
                is_success: isSuccess,
                cost: {
                    spirit_stones: stoneCost,
                    material: { id: materialId, quantity: materialCost }
                }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 设置本命法器
     * 业务流程：
     *   1. 校验槽位合法且有装备
     *   2. 校验耐久 > 0
     *   3. 校验境界要求（min_realm_rank）
     *   4. 校验本命槽位未达上限（max_slots）
     *   5. 扣除灵石 + 材料
     *   6. 分配 benming_slot（取未占用的最小槽位号 1~max_slots）
     *   7. 标记 is_benming=true
     * @param {number} playerId - 玩家 ID
     * @param {string} slot - 装备槽位
     * @returns {Promise<Object>} 设置结果
     */
    async setBenming(playerId, slot) {
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const equipmentConfig = this.getEquipmentConfig();
        const benmingConfig = equipmentConfig.benming || {};
        const minRealmRank = benmingConfig.min_realm_rank ?? 3;
        const maxSlots = benmingConfig.max_slots ?? 3;
        const stoneCost = benmingConfig.spirit_stone_cost ?? 5000;
        const materialId = benmingConfig.material_id || 'soul_banner_fragment';
        const materialCost = benmingConfig.material_cost ?? 5;
        const spiritPowerMax = benmingConfig.spirit_power_max ?? 1000;

        const t = await sequelize.transaction();
        try {
            // 查询玩家（加锁）
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法炼制本命', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            // 校验境界
            const playerRank = player.realm_rank || 0;
            if (playerRank < minRealmRank) {
                throw new AppError(`境界不足，炼制本命法器需境界排名 ${minRealmRank} 及以上`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 查询装备记录（加锁）
            const equipment = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!equipment) throw new AppError('该槽位没有装备', 400, ErrorCodes.VALIDATION_ERROR);

            // 校验耐久
            if (equipment.durability <= 0) {
                throw new AppError('装备已破碎，无法炼制本命', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验是否已本命
            if (equipment.is_benming) {
                throw new AppError('该装备已是本命法器', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 查询玩家已本命数量，校验上限
            const benmingCount = await PlayerEquipment.count({
                where: { player_id: playerId, is_benming: true },
                transaction: t
            });
            if (benmingCount >= maxSlots) {
                throw new AppError(`本命槽位已满（${maxSlots}/${maxSlots}）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算下一个可用 benming_slot（1~max_slots 中最小未占用的）
            const occupiedSlots = await PlayerEquipment.findAll({
                where: { player_id: playerId, is_benming: true },
                attributes: ['benming_slot'],
                transaction: t
            });
            const occupiedSet = new Set(occupiedSlots.map(r => r.benming_slot));
            let nextSlot = null;
            for (let i = 1; i <= maxSlots; i++) {
                if (!occupiedSet.has(i)) { nextSlot = i; break; }
            }
            if (nextSlot === null) {
                throw new AppError('无可用本命槽位', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 校验灵石
            if (player.spirit_stones < stoneCost) {
                throw new AppError(`灵石不足，炼制本命需要 ${stoneCost} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验材料
            const hasMaterial = await InventoryService.hasItem(playerId, materialId, materialCost, t);
            if (!hasMaterial) {
                throw new AppError(`材料不足，需要 ${materialCost} 个 ${materialId}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣除灵石
            player.spirit_stones -= stoneCost;
            await player.save({ transaction: t });

            // 扣除材料
            const removed = await InventoryService.removeItem(playerId, materialId, materialCost, t);
            if (!removed) {
                throw new AppError('材料扣减失败', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 标记本命
            equipment.is_benming = true;
            equipment.benming_slot = nextSlot;
            equipment.spirit_power = spiritPowerMax; // 初始满法力
            await equipment.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `成功炼制本命法器，本命槽位 #${nextSlot}`,
                slot,
                benming_slot: nextSlot,
                spirit_power: spiritPowerMax,
                cost: {
                    spirit_stones: stoneCost,
                    material: { id: materialId, quantity: materialCost }
                }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 祭出本命法器
     * 业务流程：
     *   1. 校验槽位合法且有装备
     *   2. 校验是本命法器
     *   3. 校验未祭出
     *   4. 校验场景限制（闭关/移动中不允许祭出）
     *   5. 校验已祭出数量未达上限
     *   6. 标记 is_summoned=true
     * @param {number} playerId - 玩家 ID
     * @param {string} slot - 装备槽位
     * @returns {Promise<Object>} 祭出结果
     */
    async summonTreasure(playerId, slot) {
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const equipmentConfig = this.getEquipmentConfig();
        const summonConfig = equipmentConfig.summon || {};
        const maxActive = summonConfig.max_active_treasures ?? 1;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法祭出法器', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            // 场景限制
            if (player.is_secluded && !summonConfig.allowed_in_seclusion) {
                throw new AppError('闭关中无法祭出法器', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (player.is_moving && !summonConfig.allowed_in_moving) {
                throw new AppError('移动中无法祭出法器', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const equipment = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!equipment) throw new AppError('该槽位没有装备', 400, ErrorCodes.VALIDATION_ERROR);

            if (!equipment.is_benming) {
                throw new AppError('非本命法器，无法祭出', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (equipment.durability <= 0) {
                throw new AppError('装备已破碎，无法祭出', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (equipment.is_summoned) {
                throw new AppError('法器已祭出', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验祭出数量上限
            const activeCount = await PlayerEquipment.count({
                where: { player_id: playerId, is_summoned: true },
                transaction: t
            });
            if (activeCount >= maxActive) {
                throw new AppError(`祭出法器数已达上限（${maxActive}）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            equipment.is_summoned = true;
            await equipment.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: '法器已祭出',
                slot,
                is_summoned: true
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 收回本命法器
     * @param {number} playerId - 玩家 ID
     * @param {string} slot - 装备槽位
     * @returns {Promise<Object>} 收回结果
     */
    async recallTreasure(playerId, slot) {
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

            const equipment = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!equipment) throw new AppError('该槽位没有装备', 400, ErrorCodes.VALIDATION_ERROR);

            if (!equipment.is_benming) {
                throw new AppError('非本命法器，无需收回', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (!equipment.is_summoned) {
                throw new AppError('法器未祭出', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            equipment.is_summoned = false;
            await equipment.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: '法器已收回',
                slot,
                is_summoned: false
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 调整装备排序
     * @param {number} playerId - 玩家 ID
     * @param {string} slot - 装备槽位
     * @param {number} newOrder - 新的排序值（0~99）
     * @returns {Promise<Object>} 调整结果
     */
    async adjustOrder(playerId, slot, newOrder) {
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (typeof newOrder !== 'number' || newOrder < 0 || newOrder > 99) {
            throw new AppError('排序值必须为 0~99 之间的整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

            const equipment = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!equipment) throw new AppError('该槽位没有装备', 400, ErrorCodes.VALIDATION_ERROR);

            const oldOrder = equipment.sort_order;
            equipment.sort_order = newOrder;
            await equipment.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: '排序已调整',
                slot,
                old_order: oldOrder,
                new_order: newOrder
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 散念（解除本命法器）
     * 业务流程：
     *   1. 校验是本命法器
     *   2. 收回（若已祭出）
     *   3. 回收部分材料（按 50% 回收，可配置化）
     *   4. 清除本命标记
     * @param {number} playerId - 玩家 ID
     * @param {string} slot - 装备槽位
     * @returns {Promise<Object>} 散念结果
     */
    async disperseSpirit(playerId, slot) {
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const equipmentConfig = this.getEquipmentConfig();
        const benmingConfig = equipmentConfig.benming || {};
        const materialId = benmingConfig.material_id || 'soul_banner_fragment';
        const materialCost = benmingConfig.material_cost ?? 5;
        // 散念回收比例（可配置化，默认 0.5）
        const recoverRate = benmingConfig.disperse_recover_rate ?? 0.5;
        const recoverMaterial = Math.floor(materialCost * recoverRate);

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法散念', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!equipment) throw new AppError('该槽位没有装备', 400, ErrorCodes.VALIDATION_ERROR);

            if (!equipment.is_benming) {
                throw new AppError('非本命法器，无需散念', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 清除本命标记
            equipment.is_benming = false;
            equipment.benming_slot = null;
            equipment.spirit_power = 0;
            equipment.is_summoned = false;
            await equipment.save({ transaction: t });

            // 回收部分材料
            if (recoverMaterial > 0) {
                await InventoryService.addItem(playerId, materialId, recoverMaterial, t);
            }

            await t.commit();

            return {
                success: true,
                message: `散念成功，回收 ${recoverMaterial} 个 ${materialId}`,
                slot,
                recovered_material: { id: materialId, quantity: recoverMaterial }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 修理单件装备
     * 业务流程：
     *   1. 校验槽位合法且有装备
     *   2. 校验耐久 < 最大耐久（无需修理）
     *   3. 校验最大耐久 > 阈值（无法继续修理）
     *   4. 计算需要修理的点数 = max_durability - durability
     *   5. 计算灵石消耗 = 点数 * spirit_stone_cost_per_point
     *   6. 扣除灵石，恢复耐久至 max_durability
     *   7. 扣减 max_durability（每次修理扣 max_durability_loss_per_repair）
     * @param {number} playerId - 玩家 ID
     * @param {string} slot - 装备槽位
     * @returns {Promise<Object>} 修理结果
     */
    async repair(playerId, slot) {
        if (!slot) {
            throw new AppError('槽位不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const equipmentConfig = this.getEquipmentConfig();
        const repairConfig = equipmentConfig.repair || {};
        const costPerPoint = repairConfig.spirit_stone_cost_per_point ?? 1;
        const maxDurabilityLoss = repairConfig.max_durability_loss_per_repair ?? 1;
        const maxDurabilityThreshold = repairConfig.max_durability_threshold ?? 10;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法修理', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await PlayerEquipment.findOne({
                where: { player_id: playerId, slot },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!equipment) throw new AppError('该槽位没有装备', 400, ErrorCodes.VALIDATION_ERROR);

            // 校验最大耐久阈值
            if (equipment.max_durability <= maxDurabilityThreshold) {
                throw new AppError(`装备最大耐久已降至阈值 ${maxDurabilityThreshold}，无法继续修理，需通过祭炼或其他方式恢复`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算修理点数
            const repairPoints = equipment.max_durability - equipment.durability;
            if (repairPoints <= 0) {
                throw new AppError('装备耐久已满，无需修理', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算灵石消耗
            const stoneCost = repairPoints * costPerPoint;
            if (player.spirit_stones < stoneCost) {
                throw new AppError(`灵石不足，修理需要 ${stoneCost} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣除灵石
            player.spirit_stones -= stoneCost;
            await player.save({ transaction: t });

            // 恢复耐久至 max_durability
            const oldDurability = equipment.durability;
            equipment.durability = equipment.max_durability;

            // 扣减最大耐久（每次修理扣固定点数）
            equipment.max_durability = Math.max(maxDurabilityThreshold, equipment.max_durability - maxDurabilityLoss);
            // 如果扣减后 durability > max_durability，同步下调
            if (equipment.durability > equipment.max_durability) {
                equipment.durability = equipment.max_durability;
            }

            await equipment.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `修理成功，耐久 ${oldDurability} → ${equipment.durability}`,
                slot,
                durability: equipment.durability,
                max_durability: equipment.max_durability,
                cost: { spirit_stones: stoneCost, max_durability_loss: maxDurabilityLoss }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 一键修理所有装备
     * 遍历玩家所有装备，对需要修理的逐个调用 repair
     * 注意：每个 repair 内部独立事务，避免单个失败导致全部回滚
     * @param {number} playerId - 玩家 ID
     * @returns {Promise<Object>} 一键修理结果汇总
     */
    async repairAll(playerId) {
        // 查询所有装备（无需加锁，repair 内部会加锁）
        const equipments = await PlayerEquipment.findAll({
            where: { player_id: playerId }
        });

        const results = [];
        let totalRepaired = 0;
        let totalCost = 0;
        const errors = [];

        for (const equipment of equipments) {
            try {
                // 仅修理耐久不满的装备
                if (equipment.durability >= equipment.max_durability) {
                    results.push({
                        slot: equipment.slot,
                        skipped: true,
                        message: '耐久已满，跳过'
                    });
                    continue;
                }

                const result = await this.repair(playerId, equipment.slot);
                results.push({
                    slot: equipment.slot,
                    success: true,
                    durability: result.durability,
                    max_durability: result.max_durability,
                    cost: result.cost.spirit_stones
                });
                totalRepaired += 1;
                totalCost += result.cost.spirit_stones;
            } catch (error) {
                results.push({
                    slot: equipment.slot,
                    success: false,
                    message: error.message
                });
                errors.push({ slot: equipment.slot, message: error.message });
            }
        }

        return {
            success: errors.length === 0,
            message: `修理完成：成功 ${totalRepaired} 件，消耗 ${totalCost} 灵石${errors.length > 0 ? `，失败 ${errors.length} 件` : ''}`,
            total_repaired: totalRepaired,
            total_cost: totalCost,
            details: results
        };
    }
}

// 单例模式导出，确保全局只有一个 EquipmentService 实例
module.exports = new EquipmentService();
