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

            // 玩家侧的写入已经在 _applyItemEffect 里由 PlayerStateStore 键级落库（含 state_version 自增），
            // 这里不再 player.save()：那一次整块写回正是"旧快照覆盖新快照"的入口
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
        // 与 useItem 同口径：禁止 NaN/负数/超大值（路由层再钳一次）
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
            throw new AppError('丢弃数量必须在 1-99 之间', 400, ErrorCodes.VALIDATION_ERROR);
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
     * 批量查询多个物品的持有数量
     *
     * 配方列表这类「一页材料」场景不要在循环里逐条 getItemQuantity：
     * 每种材料两次查询，配方一多就串行打成百次 DB。一次 IN 查回后建 map。
     * 同一 item_key 若存在多行（带 metadata 的装备实例），数量求和——
     * 持有量语义是「背包里一共有几件」，不是「第一行有几件」。
     *
     * @param {number} playerId - 玩家 ID
     * @param {string[]} itemKeys - 物品键名列表
     * @returns {Promise<Map<string, number>>} item_key -> 持有数量（缺失键不在 map 中）
     */
    async getItemQuantities(playerId, itemKeys) {
        const map = new Map();
        const keys = [...new Set((itemKeys || []).filter(Boolean))];
        if (keys.length === 0) return map;

        const records = await Item.findAll({
            where: { player_id: playerId, item_key: keys },
            attributes: ['item_key', 'quantity']
        });
        for (const record of records) {
            const key = String(record.item_key);
            map.set(key, (map.get(key) || 0) + (Number(record.quantity) || 0));
        }
        return map;
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
     * 把一份物品效果算成"要写什么"（键级补丁）+ "回执报什么"。**纯函数**：不查库、不写库。
     *
     * 为什么切成两半：落库那半（读锁内那份 → patchPlayerState → 镜像回实例）只有连库才断得出来，
     * 而"效果 → 增量 → 钳制 → 回执"这半算法是这套系统里最容易随内容漂移的部分（新增一类丹药就新增一个分支）。
     * 混在一个函数里，不连库的测试就只能整块跳过它（原来那三条就是靠改实例才跑得起来的），
     * 于是被内容改到的调用点没有执行型断言 —— 这正是 §26 那类事故的形状。
     * 现在：算法在 tests/AttributePillAndReset.test.js 里直接喂 `fresh` 跑；
     * "回执报的每一项真的进了库、且没顺手抹掉同坨别的键"由 scripts/smoke_write_crossflow.js 的 P1–P4 在真库上断。
     *
     * @param {Object} options
     * @param {Object} options.fresh            锁内读出的那一行（钳制与增量都以它为准）
     * @param {Object} options.effect           物品效果配置
     * @param {number} options.multiplier       数量倍率
     * @param {number} options.qualityMultiplier 品质倍率（炼制产出的 effect_multiplier）
     * @param {Object} options.resolvedStats    属性解析层的最终 hp_max/mp_max
     * @returns {{columns: Object, amounts: Object, blobPatch: Object, applied: Object}}
     */
    _planItemEffect({ fresh, effect, multiplier, qualityMultiplier, resolvedStats }) {
        const applied = {};
        // 数量倍率与品质倍率叠加（品质倍率来自炼制产出的 effect_multiplier，打通"品质→收益"断链）
        const totalMultiplier = Number(multiplier) * Number(qualityMultiplier || 1);
        const attrs = fresh.attributes || {};
        const columns = {};      // 需要"按上限钳制"的两列（血/蓝），绝对值但由 store 写并自增版本
        const amounts = {};      // 纯增减的钱与修为（列上原子加，不读旧值）
        const blobPatch = {};    // attributes 的键级补丁（属性丹的 *_bonus），$add 在锁内那份上算
        // 上限取解析后的属性。blob 里的 hp_max/mp_max 是旧管线（换境界时写入的 realm 基数）留下的
        // 输出键，不含装备/功法加成：拿它当钳制，气血 4000/5000 的玩家吃一颗 +500 的回春丹
        // 会被 Math.min(1000, 4500) "补"到 1000 —— 吃药反而掉血，而且不报任何错。
        const capOf = (resolved, mirrored, fallback) =>
            Number(resolved) > 0 ? Number(resolved) : (Number(mirrored) || fallback);
        const hpMax = capOf(resolvedStats.hp_max, attrs.hp_max, 100);
        const mpMax = capOf(resolvedStats.mp_max, attrs.mp_max, 0);

        // 恢复气血
        if (effect.hp_restore) {
            const restore = effect.hp_restore * totalMultiplier;
            // max(当前值, …)：恢复类道具在任何内容里增量都是正的，
            // 一旦上限算低了（或气血本身高于上限），宁可少补也不许把玩家打成残血。
            columns.hp_current = Math.max(Number(fresh.hp_current), Math.min(hpMax, Number(fresh.hp_current) + restore));
            applied.hp_restore = restore;
        }

        // 恢复灵力
        if (effect.mp_restore) {
            const restore = effect.mp_restore * totalMultiplier;
            columns.mp_current = Math.max(Number(fresh.mp_current), Math.min(mpMax, Number(fresh.mp_current) + restore));
            applied.mp_restore = restore;
        }

        // 增加灵石
        if (effect.spirit_stones) {
            const gain = effect.spirit_stones * totalMultiplier;
            amounts.spirit_stones = BigInt(gain);
            applied.spirit_stones = gain;
        }

        // 增加修为
        if (effect.exp) {
            const gain = effect.exp * totalMultiplier;
            amounts.exp = BigInt(gain);
            applied.exp = gain;
        }

        // 「突破加成」→ 一次性待突破池（2026-09-23 业主拍板：一次性 / 上限 80 / 0.1 就是 0.1 点）。
        // 不写永久 attributes.breakthrough_bonus（那是 LawService 法则点那一支的语义，可反复堆）；
        // 写 pending_breakthrough_bonus，由 RealmService.resolveBreakthroughBonus 叠加进本次突破概率，
        // 突破尝试结束（成或败）后清零。化龙脉石 0.1 与筑基丹 15 同一单位（百分点），不换算。
        if (effect.breakthrough_bonus) {
            const gain = Number(effect.breakthrough_bonus) * totalMultiplier;
            if (Number.isFinite(gain) && gain !== 0) {
                // 上限 80：注册表 breakthrough_bonus.max=80（原 30，现网 11 件配值超过 30）
                blobPatch.pending_breakthrough_bonus = { $add: gain, $max: 80, $min: 0 };
                applied.breakthrough_bonus = gain;
            }
        }

        // 增加寿元上限（延寿丹）：作用于玩家持久字段 lifespan_max，与 LifespanService 衰老/死亡判定同一字段
        if (effect.longevity_add) {
            const gain = Math.floor(effect.longevity_add * totalMultiplier);
            // lifespan_max 走"锁内读 + 绝对值"，不是原子加：它不在 PlayerStateStore 的增减白名单里
            // （WALLET_COLUMNS 收的是钱/修为/寿元**当前值**这类，而 lifespan_max 同时被"按境界整值重设"
            // 与"丹药累加"两种写法使用）。把它加进白名单会让前面那些合法整值重设被写回守卫拦下 ——
            // 那是另一件事，要单独量过再改（见 docs/待业主拍板清单.md 里本轮那条）。
            columns.lifespan_max = Number(fresh.lifespan_max || 0) + gain;
            applied.longevity_add = gain;
        }

        // 清除丹毒（清心丹等）：作用于玩家持久字段 toxicity，钳制到非负
        if (effect.toxicity_reduce) {
            const reduce = Math.floor(effect.toxicity_reduce * totalMultiplier);
            amounts.toxicity = -reduce;          // patchPlayerState 在行锁内夹到 0，不会扣成负数
            applied.toxicity_reduce = reduce;
        }

        // 永久属性上限加成（属性丹）：键名与数值由服务端配置 + 白名单 + 上限钳制决定，
        // 与 POST /api/attribute/use_pill 共用同一套解析逻辑，避免两条链路口径不一
        const AttributeMaxService = require('../core/AttributeMaxService');
        const pillEffect = AttributeMaxService.buildPillEffectFromConfig(effect);
        if (pillEffect) {
            // applyPillBonusToAttributes 返回新对象（不改动入参），所以这里只算差分、不碰实例那份 blob
            const nextAttributes = AttributeMaxService.applyPillBonusToAttributes(attrs, pillEffect, qualityMultiplier);
            const granted = AttributeMaxService.diffAttributeBonuses(attrs, nextAttributes);
            for (const [bonusKey, delta] of Object.entries(granted)) {
                blobPatch[bonusKey] = { $add: delta };
            }
            if (Object.keys(granted).length > 0) {
                applied.permanent_attribute_bonus = granted;
            }
        }

        return { columns, amounts, blobPatch, applied };
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
        const PlayerStateStore = require('../persistence/PlayerStateStore');
        // 钳制与增量都以**锁内那一份**为准：调用方手上的实例可能是请求开始时读的，
        // 而这一函数以前是"改那份实例 + 最后整块 save()"，同一时间别的链写的键会被盖掉。
        const fresh = transaction
            ? await PlayerStateStore.readForUpdate(player.id, { transaction })
            : await Player.findByPk(player.id);
        if (!fresh) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        // 上限取解析后的属性（装备/功法/丹药都算进来），所以恢复类效果不会"吃药反而掉血"
        const CombatResolver = require('../combat/CombatResolver');
        const { stats: resolvedStats } = await CombatResolver.resolveCombatStats(player);
        const { columns, amounts, blobPatch, applied } = this._planItemEffect({
            fresh, effect, multiplier, qualityMultiplier, resolvedStats
        });

        // 一次落库：标量按增量、血蓝按钳制后的绝对值、属性走 $add —— 全都在这一个事务里、
        // 由 patchPlayerState 自己 FOR UPDATE + state_version 自增（以前是外面 player.save() 整块写回）
        if (Object.keys(columns).length || Object.keys(amounts).length || Object.keys(blobPatch).length) {
            const updated = await PlayerStateStore.patchPlayerState(
                player.id,
                { columns, amounts, attributes: blobPatch },
                { transaction }
            );
            // 把落库结果镜像回调用方手上那份实例（**不标脏**）：useItem 的回执要报新值，
            // 但它之后不该再有任何一份整块写回参与这一行
            PlayerStateStore.mirrorPatchedBlob(player, updated);
            for (const column of ['hp_current', 'mp_current', 'spirit_stones', 'exp', 'lifespan_max', 'toxicity']) {
                if (columns[column] !== undefined || amounts[column] !== undefined) {
                    player.setDataValue(column, updated.getDataValue(column));
                }
            }
        }

        return applied;
    }
}

module.exports = new InventoryService();
