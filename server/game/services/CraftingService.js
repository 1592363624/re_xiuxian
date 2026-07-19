/**
 * 炼制系统服务模块
 * 处理玩家炼丹/炼器的核心业务逻辑
 *
 * 设计说明：
 *   - 配方静态配置从 crafting_data.json 读取（配置中心化）
 *   - 玩家已学配方存储在 player_recipes 表
 *   - 炼制成功率 = 基础成功率 + 技能等级加成 - 境界差距惩罚
 *   - 炼制失败消耗材料但不产出物品，仍有少量技能经验
 *   - 所有材料扣减和产物添加通过事务保证数据一致性
 *   - learn_source 为 "default" 的配方在首次访问时自动学习
 *
 * 核心流程：
 *   1. 查询已学配方列表（未学默认配方自动学习）
 *   2. 学习新配方（通过丹方/图谱物品）
 *   3. 炼制物品（校验境界/技能/材料/冷却 -> 扣材料 -> 判定成功 -> 加产物/加经验 -> 更新冷却）
 */
const sequelize = require('../../config/database');
const PlayerRecipe = require('../../models/playerRecipe');
const Player = require('../../models/player');
const InventoryService = require('./InventoryService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

class CraftingService {
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
     * 获取炼制配置（所有配方 + 技能等级表）
     * @returns {Object} 炼制配置
     */
    getCraftingConfig() {
        return this.configLoader?.getConfig('crafting_data') || {};
    }

    /**
     * 获取 game_balance 中的炼制配置（冷却倍率、失败经验比例等）
     * @returns {Object} 炼制平衡配置
     */
    getBalanceConfig() {
        return this.configLoader?.getConfig('game_balance')?.crafting || {};
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
     * 获取所有配方列表（合并炼丹+炼器）
     * @returns {Array} 所有配方
     */
    getAllRecipes() {
        const config = this.getCraftingConfig();
        return [
            ...(config.alchemy_recipes || []),
            ...(config.refining_recipes || [])
        ];
    }

    /**
     * 按 ID 查找配方
     * @param {string} recipeId - 配方ID
     * @returns {Object|null} 配方配置
     */
    findRecipe(recipeId) {
        return this.getAllRecipes().find(r => r.id === recipeId) || null;
    }

    /**
     * 获取技能等级配置
     * @param {number} level - 技能等级
     * @returns {Object} 等级配置（含经验需求和成功率加成）
     */
    getSkillLevelConfig(level) {
        const levels = this.getCraftingConfig().skill_levels || [];
        return levels.find(l => l.level === level) || levels[0] || { level: 1, exp_required: 0, success_bonus: 0, title: '炼制学徒' };
    }

    /**
     * 确保玩家已学习默认配方（首次访问时自动学习 learn_source=default 的配方）
     * @param {number} playerId - 玩家ID
     * @param {Object} transaction - 事务实例
     */
    async _ensureDefaultRecipes(playerId, transaction = null) {
        const defaultRecipes = this.getAllRecipes().filter(r => r.learn_source === 'default');
        for (const recipe of defaultRecipes) {
            // 检查是否已学
            const existing = await PlayerRecipe.findOne({
                where: { player_id: playerId, recipe_id: recipe.id },
                transaction,
                lock: transaction ? transaction.LOCK.UPDATE : undefined
            });
            if (!existing) {
                // 自动学习默认配方
                await PlayerRecipe.create({
                    player_id: playerId,
                    recipe_id: recipe.id,
                    craft_type: recipe.type,
                    craft_count: 0,
                    skill_exp: 0,
                    skill_level: 1,
                    last_craft_at: null
                }, { transaction });
            }
        }
    }

    /**
     * 获取玩家已学配方列表（含配置详情和炼制状态）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 已学配方列表 + 技能信息
     */
    async getLearnedRecipes(playerId) {
        // 确保默认配方已学习
        await this._ensureDefaultRecipes(playerId);

        // 查询玩家所有配方记录
        const playerRecipes = await PlayerRecipe.findAll({
            where: { player_id: playerId },
            order: [['craft_type', 'ASC'], ['created_at', 'ASC']]
        });

        // 合并静态配置，计算实时状态
        const result = {
            alchemy: [],
            refining: [],
            skill_info: this._buildSkillInfo(playerRecipes)
        };

        const now = new Date();
        for (const record of playerRecipes) {
            const recipeConfig = this.findRecipe(record.recipe_id);
            if (!recipeConfig) continue; // 配方配置已失效

            // 计算冷却剩余时间
            let cooldownRemaining = 0;
            if (record.last_craft_at) {
                const elapsed = Math.floor((now - record.last_craft_at) / 1000);
                cooldownRemaining = Math.max(0, recipeConfig.cooldown_sec - elapsed);
            }

            // 计算实际成功率（基础 + 技能加成）
            const skillConfig = this.getSkillLevelConfig(record.skill_level);
            const actualSuccessRate = Math.min(0.99, recipeConfig.base_success_rate + skillConfig.success_bonus);

            // 构建材料信息（含玩家持有数量）
            const materials = [];
            for (const mat of recipeConfig.materials) {
                const itemConfig = this.getItemConfig(mat.item_key);
                const hasItem = await InventoryService.hasItem(playerId, mat.item_key, 1);
                const owned = await InventoryService.getItemQuantity(playerId, mat.item_key);
                materials.push({
                    item_key: mat.item_key,
                    name: itemConfig?.name || '未知材料',
                    required: mat.quantity,
                    owned: owned || 0,
                    sufficient: (owned || 0) >= mat.quantity
                });
            }

            // 产物信息
            const productConfig = this.getItemConfig(recipeConfig.product.item_key);

            const recipeData = {
                record_id: record.id,
                recipe_id: record.recipe_id,
                name: recipeConfig.name,
                type: recipeConfig.type,
                description: recipeConfig.description,
                product: {
                    item_key: recipeConfig.product.item_key,
                    name: productConfig?.name || '未知物品',
                    quantity: recipeConfig.product.quantity,
                    quality: productConfig?.quality || 'common'
                },
                materials,
                required_realm_rank: recipeConfig.required_realm_rank,
                required_skill_level: recipeConfig.required_skill_level,
                base_success_rate: recipeConfig.base_success_rate,
                actual_success_rate: actualSuccessRate,
                skill_exp: recipeConfig.skill_exp,
                cooldown_sec: recipeConfig.cooldown_sec,
                cooldown_remaining: cooldownRemaining,
                craft_count: record.craft_count,
                can_craft: cooldownRemaining === 0 && materials.every(m => m.sufficient)
            };

            if (recipeConfig.type === 'alchemy') {
                result.alchemy.push(recipeData);
            } else {
                result.refining.push(recipeData);
            }
        }

        return result;
    }

    /**
     * 构建技能信息（从玩家配方记录中取最高等级）
     * @param {Array} playerRecipes - 玩家配方记录列表
     * @returns {Object} 技能信息
     */
    _buildSkillInfo(playerRecipes) {
        if (playerRecipes.length === 0) {
            return { level: 1, exp: 0, title: '炼制学徒', next_level_exp: 50 };
        }
        // 所有配方共享同一技能等级，取第一条记录的等级和经验
        const first = playerRecipes[0];
        const skillConfig = this.getSkillLevelConfig(first.skill_level);
        const nextLevel = this.getSkillLevelConfig(first.skill_level + 1);
        return {
            level: first.skill_level,
            exp: first.skill_exp,
            title: skillConfig.title,
            success_bonus: skillConfig.success_bonus,
            next_level_exp: nextLevel ? nextLevel.exp_required : null,
            max_level: (this.getCraftingConfig().skill_levels || []).length
        };
    }

    /**
     * 学习配方（通过丹方/图谱物品）
     * @param {number} playerId - 玩家ID
     * @param {string} scrollItemKey - 丹方/图谱物品的 item_key
     * @returns {Promise<Object>} 学习结果
     */
    async learnRecipe(playerId, scrollItemKey) {
        // 获取物品配置，确认是配方卷轴
        const itemConfig = this.getItemConfig(scrollItemKey);
        if (!itemConfig || itemConfig.type !== 'recipe_scroll') {
            throw new AppError('该物品不是丹方或图谱', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 获取要学习的配方ID
        const recipeId = itemConfig.effect?.learn_recipe;
        if (!recipeId) {
            throw new AppError('该丹方/图谱未关联配方', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 确认配方存在
        const recipeConfig = this.findRecipe(recipeId);
        if (!recipeConfig) {
            throw new AppError('配方配置不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 检查是否已学习
        const existing = await PlayerRecipe.findOne({
            where: { player_id: playerId, recipe_id: recipeId }
        });
        if (existing) {
            throw new AppError(`已学会${recipeConfig.name}，无需重复学习`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 检查玩家是否拥有该丹方/图谱
        const hasScroll = await InventoryService.hasItem(playerId, scrollItemKey, 1);
        if (!hasScroll) {
            throw new AppError('储物袋中没有该丹方/图谱', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 事务：消耗丹方 + 创建配方记录
        const t = await sequelize.transaction();
        try {
            // 消耗丹方/图谱
            const removed = await InventoryService.removeItem(playerId, scrollItemKey, 1, t);
            if (!removed) {
                throw new AppError('消耗丹方/图谱失败', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 获取玩家当前技能等级（从已有配方记录中取）
            const existingRecipe = await PlayerRecipe.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            const currentSkillExp = existingRecipe?.skill_exp || 0;
            const currentSkillLevel = existingRecipe?.skill_level || 1;

            // 创建配方记录（继承当前技能等级和经验）
            await PlayerRecipe.create({
                player_id: playerId,
                recipe_id: recipeId,
                craft_type: recipeConfig.type,
                craft_count: 0,
                skill_exp: currentSkillExp,
                skill_level: currentSkillLevel,
                last_craft_at: null
            }, { transaction: t });

            await t.commit();
            return {
                success: true,
                message: `成功学会${recipeConfig.name}！`,
                recipe_name: recipeConfig.name,
                recipe_id: recipeId
            };
        } catch (error) {
            // 事务回滚检查（避免重复回滚崩溃）
            if (!t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 炼制物品
     * @param {number} playerId - 玩家ID
     * @param {string} recipeId - 配方ID
     * @param {number} quantity - 炼制次数（1~10）
     * @returns {Promise<Object>} 炼制结果
     */
    async craft(playerId, recipeId, quantity = 1) {
        // 参数校验
        if (quantity < 1 || quantity > 10) {
            throw new AppError('炼制次数必须在 1-10 之间', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 查找配方配置
        const recipeConfig = this.findRecipe(recipeId);
        if (!recipeConfig) {
            throw new AppError('配方不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查找玩家配方记录（确认已学习）
        const playerRecipe = await PlayerRecipe.findOne({
            where: { player_id: playerId, recipe_id: recipeId }
        });
        if (!playerRecipe) {
            throw new AppError(`尚未学会${recipeConfig.name}，请先学习`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 检查冷却时间
        if (playerRecipe.last_craft_at) {
            const elapsed = Math.floor((new Date() - playerRecipe.last_craft_at) / 1000);
            const remaining = recipeConfig.cooldown_sec - elapsed;
            if (remaining > 0) {
                throw new AppError(`${recipeConfig.name}冷却中，剩余 ${remaining} 秒`, 400, ErrorCodes.VALIDATION_ERROR);
            }
        }

        // 查询玩家信息（境界检查）
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 境界检查
        const playerRealmRank = player.realm_rank || 0;
        if (playerRealmRank < recipeConfig.required_realm_rank) {
            throw new AppError(`境界不足，需要境界等级 ${recipeConfig.required_realm_rank} 以上`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 技能等级检查
        if (playerRecipe.skill_level < recipeConfig.required_skill_level) {
            throw new AppError(`炼制技能等级不足，需要 ${recipeConfig.required_skill_level} 级`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 计算实际成功率
        const skillConfig = this.getSkillLevelConfig(playerRecipe.skill_level);
        const successRate = Math.min(0.99, recipeConfig.base_success_rate + skillConfig.success_bonus);

        // 计算总材料需求
        const totalMaterials = recipeConfig.materials.map(m => ({
            item_key: m.item_key,
            quantity: m.quantity * quantity
        }));

        // 事务：扣材料 -> 判定成功 -> 加产物 -> 加经验 -> 更新冷却
        const t = await sequelize.transaction();
        try {
            // 检查并扣减所有材料
            for (const mat of totalMaterials) {
                const hasEnough = await InventoryService.hasItem(playerId, mat.item_key, mat.quantity, t);
                if (!hasEnough) {
                    const itemConfig = this.getItemConfig(mat.item_key);
                    throw new AppError(`${itemConfig?.name || mat.item_key}数量不足，需要 ${mat.quantity} 个`, 400, ErrorCodes.VALIDATION_ERROR);
                }
                const removed = await InventoryService.removeItem(playerId, mat.item_key, mat.quantity, t);
                if (!removed) {
                    throw new AppError('材料扣减失败', 500, ErrorCodes.INTERNAL_ERROR);
                }
            }

            // 逐次判定成功
            let successCount = 0;
            let failCount = 0;
            const balanceConfig = this.getBalanceConfig();
            const failExpRatio = balanceConfig.fail_exp_ratio || 0.2; // 失败经验比例为20%

            for (let i = 0; i < quantity; i++) {
                if (Math.random() < successRate) {
                    successCount++;
                } else {
                    failCount++;
                }
            }

            // 添加产物（成功的次数）
            if (successCount > 0) {
                const productQty = recipeConfig.product.quantity * successCount;
                await InventoryService.addItem(playerId, recipeConfig.product.item_key, productQty, t);
            }

            // 计算获得的经验（成功全额 + 失败部分）
            const totalExp = Math.floor(
                recipeConfig.skill_exp * successCount +
                recipeConfig.skill_exp * failCount * failExpRatio
            );

            // 更新配方记录（经验、等级、次数、冷却）
            const newExp = playerRecipe.skill_exp + totalExp;
            const newLevel = this._calculateSkillLevel(newExp);
            playerRecipe.skill_exp = newExp;
            playerRecipe.skill_level = newLevel;
            playerRecipe.craft_count += quantity;
            playerRecipe.last_craft_at = new Date();
            await playerRecipe.save({ transaction: t });

            // 同步更新玩家所有配方的技能等级和经验（共享技能）
            await PlayerRecipe.update(
                { skill_exp: newExp, skill_level: newLevel },
                { where: { player_id: playerId }, transaction: t }
            );

            await t.commit();

            // 构建返回结果
            const productConfig = this.getItemConfig(recipeConfig.product.item_key);
            const result = {
                success: true,
                recipe_name: recipeConfig.name,
                total_attempts: quantity,
                success_count: successCount,
                fail_count: failCount,
                product: {
                    item_key: recipeConfig.product.item_key,
                    name: productConfig?.name || '未知物品',
                    quantity: recipeConfig.product.quantity * successCount
                },
                skill_exp_gained: totalExp,
                skill_level: newLevel,
                skill_level_up: newLevel > playerRecipe.skill_level,
                message: successCount > 0
                    ? `炼制成功 ${successCount} 次，获得${productConfig?.name || '产物'} ${recipeConfig.product.quantity * successCount} 个`
                    : '炼制全部失败，材料已消耗'
            };

            if (failCount > 0 && successCount > 0) {
                result.message = `炼制完成：成功 ${successCount} 次，失败 ${failCount} 次`;
            }

            return result;
        } catch (error) {
            // 事务回滚检查（避免重复回滚崩溃）
            if (!t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 根据累计经验计算技能等级
     * @param {number} exp - 累计经验值
     * @returns {number} 技能等级
     */
    _calculateSkillLevel(exp) {
        const levels = this.getCraftingConfig().skill_levels || [];
        let currentLevel = 1;
        for (const levelConfig of levels) {
            if (exp >= levelConfig.exp_required) {
                currentLevel = levelConfig.level;
            } else {
                break;
            }
        }
        return currentLevel;
    }

    /**
     * 获取所有可学习的配方列表（含学习状态）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 可学习配方列表
     */
    async getAvailableRecipes(playerId) {
        // 确保默认配方已学习
        await this._ensureDefaultRecipes(playerId);

        // 查询已学配方ID列表
        const learned = await PlayerRecipe.findAll({
            where: { player_id: playerId },
            attributes: ['recipe_id']
        });
        const learnedIds = new Set(learned.map(r => r.recipe_id));

        // 构建所有配方列表，标记学习状态
        const allRecipes = this.getAllRecipes();
        const result = {
            alchemy: [],
            refining: []
        };

        for (const recipe of allRecipes) {
            const productConfig = this.getItemConfig(recipe.product.item_key);
            const recipeData = {
                recipe_id: recipe.id,
                name: recipe.name,
                type: recipe.type,
                description: recipe.description,
                product: {
                    item_key: recipe.product.item_key,
                    name: productConfig?.name || '未知物品',
                    quantity: recipe.product.quantity
                },
                required_realm_rank: recipe.required_realm_rank,
                required_skill_level: recipe.required_skill_level,
                base_success_rate: recipe.base_success_rate,
                learn_source: recipe.learn_source,
                learned: learnedIds.has(recipe.id)
            };

            if (recipe.type === 'alchemy') {
                result.alchemy.push(recipeData);
            } else {
                result.refining.push(recipeData);
            }
        }

        return result;
    }
}

module.exports = new CraftingService();
