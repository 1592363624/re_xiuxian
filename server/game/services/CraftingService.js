/**
 * 炼制系统服务模块
 * 处理玩家炼丹/炼器的核心业务逻辑
 *
 * 设计说明：
 *   - 配方静态配置从 crafting_data.json 读取（配置中心化）
 *   - 玩家已学配方存储在 player_recipes 表
 *   - 炼制失败消耗材料但不产出物品，仍有少量技能经验
 *   - 所有材料扣减和产物添加通过事务保证数据一致性
 *   - learn_source 为 "default" 的配方在首次访问时自动学习
 *
 * 成功率公式（各项均来自配置，见 game_balance.json -> crafting）：
 *   successRate = clamp(
 *       base_success_rate
 *     + skill.success_bonus            // 技能等级加成
 *     + realmModifier                  // 境界差修正（高于要求得加成，收益递减且封顶）
 *     + caveBonus                      // 洞府丹房/器室等级加成（接通 CaveService）
 *     + heatModifier                   // 火候控制修正（完美加成 / 偏差惩罚 / auto 模式惩罚）
 *   , success_rate_floor, success_rate_cap)
 *
 * 火候控制玩法：
 *   - craftStart 创建炼制会话并生成各阶段目标火候（服务端保存，不下发答案）
 *   - craftHeat 逐阶段提交玩家选择的火候档位，累积偏差
 *   - craftFinish 结算：偏差 -> 成功率修正 + 品质档位浮动
 *   - 亦保留 auto 模式一键炼制（承担固定成功率惩罚），兼容旧客户端
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
        /**
         * 火候炼制会话表 Map<playerIdStr, session>
         * 会话为短时态（默认 5 分钟），放内存即可，无需落库；
         * 服务重启后会话丢失属可接受损失（材料尚未扣减）。
         */
        this._heatSessions = new Map();
        this._sweepTimer = null;
    }

    /**
     * 启动过期会话清理定时器
     *
     * 玩家开炉后若直接关页面，会话会滞留在 Map 中造成内存泄漏，
     * 因此按会话超时时长周期性清扫。使用 unref 避免阻塞进程退出。
     */
    _startSessionSweeper() {
        if (this._sweepTimer) return;
        const timeoutSec = this.getBalanceConfig()?.heat_control?.session_timeout_sec ?? 300;
        this._sweepTimer = setInterval(() => {
            const now = Date.now();
            for (const [key, session] of this._heatSessions) {
                if (now > session.expiresAt) {
                    this._heatSessions.delete(key);
                }
            }
        }, timeoutSec * 1000);
        // 定时器不应阻止 Node 进程正常退出（测试环境尤其重要）
        if (typeof this._sweepTimer.unref === 'function') {
            this._sweepTimer.unref();
        }
    }

    /**
     * 停止清理定时器（供测试与优雅关闭调用）
     */
    stopSessionSweeper() {
        if (this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = null;
        }
    }

    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        // 配置就绪后再启动清扫器，以便读取到正确的超时时长
        this._startSessionSweeper();
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
        // ConfigLoader 在配置未加载时会抛异常，此处兜底为空对象，
        // 使各计算函数回退到内置默认值而非中断炼制流程
        try {
            return this.configLoader?.getConfig('game_balance')?.crafting || {};
        } catch (err) {
            return {};
        }
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
     * 将成功率钳制在配置的上下限内
     *
     * 保留下限可避免高阶配方低境界时成功率归零导致材料黑洞；
     * 保留上限可避免堆加成后必定成功，维持策略权衡。
     *
     * @param {number} rate - 原始成功率
     * @returns {number} 钳制后的成功率
     */
    _clampRate(rate) {
        const cfg = this.getBalanceConfig();
        const floor = cfg.success_rate_floor ?? 0.05;
        const cap = cfg.success_rate_cap ?? 0.95;
        // 仅 NaN 兜底为下限，防止脏配置导致 Math.random() 比较恒为 false。
        // Infinity 需交由下方 Math.min 正常钳制到上限，不能与 NaN 混为一谈。
        if (Number.isNaN(Number(rate)) || typeof rate !== 'number') return floor;
        return Math.min(cap, Math.max(floor, rate));
    }

    /**
     * 计算境界差对成功率的修正
     *
     * 低于配方要求的情况已由 craft() 的硬门槛拦截，此处的负修正仅作为
     * 防御性兜底（例如后台调整配方要求导致玩家境界回落时）。
     * 正差值给予熟练加成，但按配置封顶，避免高境界玩家无脑必成。
     *
     * @param {number} playerRealmRank - 玩家境界等级
     * @param {number} requiredRealmRank - 配方要求境界等级
     * @returns {number} 成功率修正值（可正可负）
     */
    calcRealmModifier(playerRealmRank, requiredRealmRank) {
        const cfg = this.getBalanceConfig().realm_diff || {};
        // 兜底默认值，保证配置缺失时公式仍可运行
        const bonusPer = cfg.bonus_per_rank ?? 0.02;
        const maxBonus = cfg.max_bonus ?? 0.12;
        const penaltyPer = cfg.penalty_per_rank ?? 0.08;
        const maxPenalty = cfg.max_penalty ?? 0.4;

        const diff = (playerRealmRank || 0) - (requiredRealmRank || 0);
        if (diff >= 0) {
            return Math.min(diff * bonusPer, maxBonus);
        }
        // 负差值取绝对值计算惩罚，再以负号返回
        return -Math.min(Math.abs(diff) * penaltyPer, maxPenalty);
    }

    /**
     * 获取洞府设施对炼制成功率的加成
     *
     * 修复历史断链：cave_data.json 中 pill_room/tool_room 的
     * success_bonus_per_level 此前从未被炼制流程读取，导致玩家升级
     * 丹房/器室对成功率无任何影响。此处按炼制类型接入对应设施。
     *
     * @param {number} playerId - 玩家ID
     * @param {string} craftType - 炼制类型 alchemy|refining
     * @returns {Promise<number>} 成功率加成（0 表示无加成或功能关闭）
     */
    async calcCaveBonus(playerId, craftType) {
        const caveCfg = this.getBalanceConfig().cave_bonus || {};
        if (caveCfg.enabled === false) return 0;

        try {
            // 延迟 require 避免与 CaveService 形成循环依赖
            const CaveService = require('./CaveService');
            const bonuses = await CaveService.getCaveBonus(playerId);
            if (!bonuses) return 0;

            const raw = craftType === 'alchemy'
                ? (bonuses.pill_success_bonus || 0)
                : (bonuses.tool_success_bonus || 0);
            const cap = craftType === 'alchemy'
                ? (caveCfg.max_alchemy_bonus ?? 0.3)
                : (caveCfg.max_refining_bonus ?? 0.3);

            return Math.min(raw, cap);
        } catch (err) {
            // 洞府数据异常不应阻断炼制主流程，降级为无加成
            console.warn(`[CraftingService] 获取洞府加成失败 playerId=${playerId}:`, err.message);
            return 0;
        }
    }

    /**
     * 将累计火候偏差换算为成功率修正
     * @param {number} totalDeviation - 各阶段偏差之和（已扣除技能容错）
     * @param {number} stages - 实际参与的阶段数
     * @returns {number} 成功率修正值
     */
    calcHeatModifier(totalDeviation, stages) {
        const heatCfg = this.getBalanceConfig().heat_control || {};
        const perfectBonus = heatCfg.perfect_bonus_per_stage ?? 0.04;
        const penaltyPer = heatCfg.deviation_penalty_per_point ?? 0.05;

        // 零偏差视为全程完美，按阶段数给予正向加成
        if (totalDeviation <= 0) {
            return perfectBonus * (stages || 0);
        }
        return -(totalDeviation * penaltyPer);
    }

    /**
     * 根据火候偏差确定成品品质档位
     *
     * 偏差越小品质越高。技能等级提供偏差容错（老练炼丹师手抖也无妨）。
     * tiers 按 max_deviation 升序匹配第一个满足条件的档位。
     *
     * @param {number} totalDeviation - 累计偏差
     * @param {number} skillLevel - 炼制技能等级
     * @param {string} baseQuality - 配方产物基准品质
     * @returns {Object} { name, quality, effect_multiplier, deviation }
     */
    calcQualityTier(totalDeviation, skillLevel, baseQuality) {
        const qCfg = this.getBalanceConfig().quality_float || {};
        const order = qCfg.quality_order || ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
        const tiers = qCfg.tiers || [];

        // 功能关闭时保持原样返回基准品质，保证向后兼容
        if (qCfg.enabled === false || tiers.length === 0) {
            return { name: '', quality: baseQuality, effect_multiplier: 1, deviation: totalDeviation };
        }

        // 技能等级抵消部分偏差，最低为 0
        const forgiveness = (qCfg.skill_level_deviation_forgiveness ?? 0) * (skillLevel || 0);
        const effective = Math.max(0, totalDeviation - forgiveness);

        // 按 max_deviation 升序排列后取第一个能容纳当前偏差的档位
        const sorted = [...tiers].sort((a, b) => a.max_deviation - b.max_deviation);
        const tier = sorted.find(t => effective <= t.max_deviation) || sorted[sorted.length - 1];

        // 依据 upgrade 在品质序列上平移，并钳制在合法范围内
        const baseIdx = Math.max(0, order.indexOf(baseQuality));
        const newIdx = Math.min(order.length - 1, Math.max(0, baseIdx + (tier.upgrade || 0)));

        return {
            name: tier.name || '',
            quality: order[newIdx],
            effect_multiplier: tier.effect_multiplier ?? 1,
            deviation: Number(effective.toFixed(2))
        };
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
     *
     * @param {number} playerId - 玩家ID
     * @param {string} recipeId - 配方ID
     * @param {number} quantity - 炼制次数（上限取配置 max_craft_quantity）
     * @param {Object} [heatContext] - 火候上下文，由 craftFinish 传入
     * @param {number} heatContext.deviation - 累计火候偏差
     * @param {number} heatContext.stages - 参与的阶段数
     * @param {boolean} heatContext.auto - 是否为 auto 一键模式
     * @returns {Promise<Object>} 炼制结果
     */
    async craft(playerId, recipeId, quantity = 1, heatContext = null) {
        // 数量上限改为读取配置，避免与 game_balance.max_craft_quantity 双头维护
        const maxQty = this.getBalanceConfig().max_craft_quantity ?? 10;
        // 显式拦截非整数/NaN，防止 Number 型脏数据进入循环导致次数异常
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQty) {
            throw new AppError(`炼制次数必须为 1-${maxQty} 之间的整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 解析火候修正：无火候上下文时按 auto 模式处理（兼容旧客户端直接调用）
        const heatCfg = this.getBalanceConfig().heat_control || {};
        let heatModifier = 0;
        let heatDeviation = 0;
        if (heatContext && heatContext.auto !== true) {
            heatDeviation = heatContext.deviation || 0;
            heatModifier = this.calcHeatModifier(heatDeviation, heatContext.stages || 0);
        } else if (heatCfg.enabled !== false) {
            // auto 模式：跳过火候交互，承担固定成功率惩罚
            heatModifier = heatCfg.auto_mode_success_modifier ?? -0.05;
            // 以中位偏差参与品质计算，使 auto 模式稳定产出中档品质
            heatDeviation = ((heatCfg.heat_max ?? 5) - (heatCfg.heat_min ?? 1)) / 2;
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

        // 计算实际成功率（基础 + 技能 + 境界差 + 洞府设施 + 火候修正）
        const skillConfig = this.getSkillLevelConfig(playerRecipe.skill_level);
        const realmModifier = this.calcRealmModifier(playerRealmRank, recipeConfig.required_realm_rank);
        const caveBonus = await this.calcCaveBonus(playerId, recipeConfig.type);
        const successRate = this._clampRate(
            recipeConfig.base_success_rate
            + skillConfig.success_bonus
            + realmModifier
            + caveBonus
            + heatModifier
        );

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

            // 依据火候偏差计算成品品质档位（丹药品质浮动）
            const baseProductConfig = this.getItemConfig(recipeConfig.product.item_key);
            const qualityTier = this.calcQualityTier(
                heatDeviation,
                playerRecipe.skill_level,
                baseProductConfig?.quality || 'common'
            );

            // 添加产物（成功的次数）
            if (successCount > 0) {
                const productQty = recipeConfig.product.quantity * successCount;
                // 将本次品质档位写入库存物品元数据
                // - 丹药(alchemy)：effect_multiplier 供服用端放大恢复/修为效果（见 InventoryService）
                // - 装备(refining)：attr_multiplier 供装备属性计算浮动（炼器复用同一品质框架）
                const isAlchemy = recipeConfig.type === 'alchemy';
                const productMetadata = {
                    quality: qualityTier.quality,
                    quality_tier: qualityTier.name,
                    effect_multiplier: isAlchemy ? qualityTier.effect_multiplier : 1,
                    attr_multiplier: isAlchemy ? 1 : qualityTier.effect_multiplier
                };
                await InventoryService.addItem(playerId, recipeConfig.product.item_key, productQty, t, productMetadata);
            }

            // 计算获得的经验（成功全额 + 失败部分）
            const totalExp = Math.floor(
                recipeConfig.skill_exp * successCount +
                recipeConfig.skill_exp * failCount * failExpRatio
            );

            // 更新配方记录（经验、等级、次数、冷却）
            // 先留存旧等级：下方会覆写 playerRecipe.skill_level，
            // 若在覆写后再比较将恒为 false（历史缺陷，升级提示永不触发）
            const previousLevel = playerRecipe.skill_level;
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
                // 配方类型（alchemy/refining），供前端区分丹药效果倍率与装备属性倍率展示
                recipe_type: recipeConfig.type,
                total_attempts: quantity,
                success_count: successCount,
                fail_count: failCount,
                product: {
                    item_key: recipeConfig.product.item_key,
                    name: productConfig?.name || '未知物品',
                    quantity: recipeConfig.product.quantity * successCount,
                    quality: qualityTier.quality,
                    quality_tier: qualityTier.name,
                    effect_multiplier: qualityTier.effect_multiplier,
                    // 炼器产物返回属性浮动倍率，供前端展示（丹药恒为 1）
                    // 此处与大括号内 isAlchemy 不在同一作用域，直接按配方类型判断
                    attr_multiplier: recipeConfig.type === 'alchemy' ? 1 : qualityTier.effect_multiplier
                },
                // 成功率构成明细，便于前端展示与数值调试
                rate_detail: {
                    base: recipeConfig.base_success_rate,
                    skill_bonus: skillConfig.success_bonus,
                    realm_modifier: Number(realmModifier.toFixed(4)),
                    cave_bonus: Number(caveBonus.toFixed(4)),
                    heat_modifier: Number(heatModifier.toFixed(4)),
                    final: Number(successRate.toFixed(4))
                },
                heat_deviation: qualityTier.deviation,
                skill_exp_gained: totalExp,
                skill_level: newLevel,
                skill_level_up: newLevel > previousLevel,
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

    // ==================== 火候控制玩法 ====================

    /**
     * 开启一次火候炼制会话
     *
     * 服务端生成各阶段目标火候并保存在内存会话中，**不下发答案**，
     * 仅下发每阶段的提示（灵火状态描述），玩家据此推断该给多大火。
     * 会话与 playerId+recipeId 绑定，同一玩家同时只保留一个会话，
     * 防止玩家开多个会话择优提交（反作弊）。
     *
     * @param {number} playerId - 玩家ID
     * @param {string} recipeId - 配方ID
     * @param {number} quantity - 炼制次数
     * @returns {Promise<Object>} 会话信息（含首阶段提示）
     */
    async craftStart(playerId, recipeId, quantity = 1) {
        const heatCfg = this.getBalanceConfig().heat_control || {};
        if (heatCfg.enabled === false) {
            throw new AppError('火候控制玩法未开启', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const recipeConfig = this.findRecipe(recipeId);
        if (!recipeConfig) {
            throw new AppError('配方不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 复用 craft 的前置校验（境界/技能/材料/冷却），避免玩家空跑火候流程后才失败
        await this._validateCraftable(playerId, recipeConfig, quantity);

        const stages = heatCfg.stages ?? 3;
        const heatMin = heatCfg.heat_min ?? 1;
        const heatMax = heatCfg.heat_max ?? 5;

        // 随机生成每阶段目标火候
        const targets = [];
        for (let i = 0; i < stages; i++) {
            targets.push(heatMin + Math.floor(Math.random() * (heatMax - heatMin + 1)));
        }

        const session = {
            playerId,
            recipeId,
            quantity,
            targets,
            choices: [],
            currentStage: 0,
            deviation: 0,
            createdAt: Date.now(),
            expiresAt: Date.now() + (heatCfg.session_timeout_sec ?? 300) * 1000
        };
        this._heatSessions.set(this._sessionKey(playerId), session);

        return {
            success: true,
            recipe_id: recipeId,
            recipe_name: recipeConfig.name,
            quantity,
            total_stages: stages,
            current_stage: 1,
            heat_min: heatMin,
            heat_max: heatMax,
            hint: this._buildHeatHint(targets[0], heatMin, heatMax),
            expires_at: session.expiresAt,
            message: `开始炼制${recipeConfig.name}，请把控第 1 / ${stages} 阶段火候`
        };
    }

    /**
     * 提交某一阶段的火候选择
     *
     * @param {number} playerId - 玩家ID
     * @param {number} heat - 玩家选择的火候档位
     * @returns {Promise<Object>} 阶段反馈（偏差方向提示，不泄露具体目标值）
     */
    async craftHeat(playerId, heat) {
        const session = this._getActiveSession(playerId);
        const heatCfg = this.getBalanceConfig().heat_control || {};
        const heatMin = heatCfg.heat_min ?? 1;
        const heatMax = heatCfg.heat_max ?? 5;

        // 严格校验档位，杜绝越界数值刷完美品质
        if (!Number.isInteger(heat) || heat < heatMin || heat > heatMax) {
            throw new AppError(`火候档位必须为 ${heatMin}-${heatMax} 之间的整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const target = session.targets[session.currentStage];
        const diff = Math.abs(heat - target);
        session.choices.push(heat);
        session.deviation += diff;
        session.currentStage++;

        const isLast = session.currentStage >= session.targets.length;

        return {
            success: true,
            stage_result: diff === 0 ? 'perfect' : (heat > target ? 'too_hot' : 'too_cold'),
            stage_message: diff === 0
                ? '火候恰到好处，丹液莹润'
                : (heat > target ? '火势过猛，丹炉微颤' : '火力不足，药力未化'),
            current_stage: isLast ? session.targets.length : session.currentStage + 1,
            total_stages: session.targets.length,
            finished: isLast,
            hint: isLast ? null : this._buildHeatHint(session.targets[session.currentStage], heatMin, heatMax),
            message: isLast ? '火候把控完毕，可以开炉了' : '继续把控下一阶段火候'
        };
    }

    /**
     * 结算火候炼制会话，执行真正的炼制
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 炼制结果
     */
    async craftFinish(playerId) {
        const session = this._getActiveSession(playerId);
        if (session.currentStage < session.targets.length) {
            throw new AppError(
                `火候尚未把控完毕（${session.currentStage}/${session.targets.length}）`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 先移除会话再执行炼制，防止并发重复提交同一会话导致多次扣料/多次产出
        this._heatSessions.delete(this._sessionKey(playerId));

        return await this.craft(playerId, session.recipeId, session.quantity, {
            deviation: session.deviation,
            stages: session.targets.length,
            auto: false
        });
    }

    /**
     * 主动放弃当前火候会话
     * @param {number} playerId - 玩家ID
     * @returns {Object} 操作结果
     */
    craftCancel(playerId) {
        const existed = this._heatSessions.delete(this._sessionKey(playerId));
        return { success: true, cancelled: existed, message: existed ? '已停火散炉' : '当前没有进行中的炼制' };
    }

    /**
     * 查询当前火候会话状态（断线重连用）
     * @param {number} playerId - 玩家ID
     * @returns {Object|null} 会话状态
     */
    getHeatSession(playerId) {
        const session = this._heatSessions.get(this._sessionKey(playerId));
        if (!session || Date.now() > session.expiresAt) return null;

        const heatCfg = this.getBalanceConfig().heat_control || {};
        const heatMin = heatCfg.heat_min ?? 1;
        const heatMax = heatCfg.heat_max ?? 5;
        const finished = session.currentStage >= session.targets.length;

        return {
            recipe_id: session.recipeId,
            quantity: session.quantity,
            current_stage: finished ? session.targets.length : session.currentStage + 1,
            total_stages: session.targets.length,
            finished,
            heat_min: heatMin,
            heat_max: heatMax,
            hint: finished ? null : this._buildHeatHint(session.targets[session.currentStage], heatMin, heatMax),
            expires_at: session.expiresAt
        };
    }

    /**
     * 生成火候提示文案
     *
     * 只给模糊的区间描述而非精确数值，保留玩家判断空间；
     * 目标值映射为「灵火征兆」，玩家需据此选择档位。
     *
     * @param {number} target - 目标火候
     * @param {number} min - 最小档位
     * @param {number} max - 最大档位
     * @returns {Object} 提示对象
     */
    _buildHeatHint(target, min, max) {
        // 归一化到 0~1，划分为三档模糊提示
        const ratio = (target - min) / Math.max(1, max - min);
        let level, text;
        if (ratio <= 0.34) {
            level = 'low';
            text = '药材娇嫩，丹炉青烟袅袅——宜文火慢炖';
        } else if (ratio <= 0.67) {
            level = 'mid';
            text = '药力渐融，炉身温热泛红——宜中火匀调';
        } else {
            level = 'high';
            text = '药性刚烈，炉中灵光暴涨——宜武火猛攻';
        }
        return { level, text };
    }

    /**
     * 获取有效会话，并处理过期清理
     * @param {number} playerId - 玩家ID
     * @returns {Object} 会话对象
     */
    _getActiveSession(playerId) {
        const key = this._sessionKey(playerId);
        const session = this._heatSessions.get(key);
        if (!session) {
            throw new AppError('没有进行中的炼制，请先开炉', 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 超时会话视为炸炉，直接清理
        if (Date.now() > session.expiresAt) {
            this._heatSessions.delete(key);
            throw new AppError('炼制超时，丹炉已冷却，请重新开炉', 400, ErrorCodes.VALIDATION_ERROR);
        }
        return session;
    }

    /**
     * 生成会话键（统一 key 类型，避免数字/字符串 ID 混用导致取不到会话）
     * @param {number|string} playerId - 玩家ID
     * @returns {string} 会话键
     */
    _sessionKey(playerId) {
        return String(playerId);
    }

    /**
     * 炼制前置校验（供 craftStart 复用，避免玩家走完火候流程才发现材料不足）
     *
     * @param {number} playerId - 玩家ID
     * @param {Object} recipeConfig - 配方配置
     * @param {number} quantity - 炼制次数
     */
    async _validateCraftable(playerId, recipeConfig, quantity) {
        const playerRecipe = await PlayerRecipe.findOne({
            where: { player_id: playerId, recipe_id: recipeConfig.id }
        });
        if (!playerRecipe) {
            throw new AppError(`尚未学会${recipeConfig.name}，请先学习`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 冷却校验
        if (playerRecipe.last_craft_at) {
            const elapsed = Math.floor((new Date() - playerRecipe.last_craft_at) / 1000);
            const remaining = recipeConfig.cooldown_sec - elapsed;
            if (remaining > 0) {
                throw new AppError(`${recipeConfig.name}冷却中，剩余 ${remaining} 秒`, 400, ErrorCodes.VALIDATION_ERROR);
            }
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if ((player.realm_rank || 0) < recipeConfig.required_realm_rank) {
            throw new AppError(`境界不足，需要境界等级 ${recipeConfig.required_realm_rank} 以上`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (playerRecipe.skill_level < recipeConfig.required_skill_level) {
            throw new AppError(`炼制技能等级不足，需要 ${recipeConfig.required_skill_level} 级`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 材料预检（此处只读不扣，真正扣减在 craft 事务内再次校验）
        for (const m of recipeConfig.materials) {
            const need = m.quantity * quantity;
            const hasEnough = await InventoryService.hasItem(playerId, m.item_key, need);
            if (!hasEnough) {
                const itemConfig = this.getItemConfig(m.item_key);
                throw new AppError(`${itemConfig?.name || m.item_key}数量不足，需要 ${need} 个`, 400, ErrorCodes.VALIDATION_ERROR);
            }
        }
    }
}

module.exports = new CraftingService();
