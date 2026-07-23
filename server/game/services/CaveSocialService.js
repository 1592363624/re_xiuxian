/**
 * 洞府社交服务模块
 *
 * 处理洞府社交玩法业务逻辑：拜访、留言、查看访客、布置景观、洞府商人
 *
 * 设计说明：
 *   - 社交配置从 cave_data.json 的 social 节点读取（配置中心化，支持热更新）
 *   - 拜访记录写入 cave_visitors 表，保留最近 N 条（可配置）
 *   - 留言记录写入 cave_messages 表，保留最近 N 条（可配置）
 *   - 景观布置写入 player_caves.landscape_id，提供修炼/突破/灵脉加成
 *   - 洞府商人货品基于"玩家ID+刷新时间戳"种子确定性生成，无需持久化货品列表
 *     购买记录写入 cave_merchant_purchases 表，用于校验单批已购数量
 *   - 所有写操作使用事务 + 行级锁保证并发安全
 */
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const Player = require('../../models/player');
const PlayerCave = require('../../models/playerCave');
const CaveMessage = require('../../models/caveMessage');
const CaveVisitor = require('../../models/caveVisitor');
const InventoryService = require('./InventoryService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// 单例库存服务实例（与 CaveService/CraftingService 等保持一致的引用方式）
const inventoryService = InventoryService;

class CaveSocialService {
    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        inventoryService.initialize(configLoader);
        console.log('[CaveSocialService] 洞府社交服务初始化完成');
    }

    /**
     * 获取洞府社交配置（cave_data.json 的 social 节点）
     * @returns {Object} 社交配置对象
     */
    getSocialConfig() {
        return this.configLoader?.getConfig('cave_data')?.cave?.social || {};
    }

    /**
     * 获取拜访配置
     */
    getVisitConfig() {
        return this.getSocialConfig().visit || {};
    }

    /**
     * 获取景观配置列表
     */
    getLandscapesConfig() {
        return this.getSocialConfig().landscapes || [];
    }

    /**
     * 获取商人配置
     */
    getMerchantConfig() {
        return this.getSocialConfig().merchant || {};
    }

    /**
     * 获取拜访奇遇配置
     * @returns {Object} 奇遇配置对象（含 enabled/trigger_chance/daily_encounter_limit/encounters 数组）
     */
    getEncounterConfig() {
        return this.getSocialConfig().visit_encounters || {};
    }

    /**
     * 拜访他人洞府
     * - 校验目标玩家存在且已开辟洞府
     * - 校验不能拜访自己
     * - 校验每日拜访次数（daily_limit）
     * - 写入访客记录，保留最近 N 条
     * - 触发拜访奇遇（概率触发，每日奇遇次数独立限制）
     *
     * @param {number} playerId - 拜访者玩家ID
     * @param {number} targetPlayerId - 目标洞府主人玩家ID
     * @returns {Promise<Object>} 拜访结果（含目标洞府基本信息）
     */
    async visitCave(playerId, targetPlayerId) {
        // 参数校验：不能拜访自己
        if (Number(playerId) === Number(targetPlayerId)) {
            throw new AppError('不能拜访自己的洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询目标玩家
        const targetPlayer = await Player.findByPk(targetPlayerId);
        if (!targetPlayer) {
            throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询目标洞府
        const targetCave = await PlayerCave.findOne({ where: { player_id: targetPlayerId } });
        if (!targetCave || !targetCave.is_opened) {
            throw new AppError('对方尚未开辟洞府，无法拜访', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验每日拜访次数限制（按当前自然日计算）
        const visitConfig = this.getVisitConfig();
        const dailyLimit = visitConfig.daily_limit || 10;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayVisitedCount = await CaveVisitor.count({
            where: {
                visitor_id: playerId,
                visited_at: { [Op.gte]: todayStart }
            }
        });
        if (todayVisitedCount >= dailyLimit) {
            throw new AppError(`今日拜访次数已达上限（${dailyLimit}次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        let encounterResult = null;
        try {
            // 写入访客记录
            const visitorRecord = await CaveVisitor.create({
                cave_owner_id: targetPlayerId,
                visitor_id: playerId,
                visited_at: new Date()
            }, { transaction: t });

            // 清理过期访客记录：保留最近 max_recent_visitors 条
            const maxVisitors = visitConfig.max_recent_visitors || 50;
            const totalCount = await CaveVisitor.count({
                where: { cave_owner_id: targetPlayerId },
                transaction: t
            });
            if (totalCount > maxVisitors) {
                // 查询需要删除的旧记录（按时间正序，删除多出来的部分）
                const excess = totalCount - maxVisitors;
                const oldRecords = await CaveVisitor.findAll({
                    where: { cave_owner_id: targetPlayerId },
                    order: [['visited_at', 'ASC']],
                    limit: excess,
                    transaction: t
                });
                const oldIds = oldRecords.map(r => r.id);
                await CaveVisitor.destroy({
                    where: { id: { [Op.in]: oldIds } },
                    transaction: t
                });
            }

            // ===== 触发拜访奇遇 =====
            // 奇遇在事务内执行：奖励发放与访客记录更新原子性提交
            encounterResult = await this._triggerVisitEncounter(playerId, visitorRecord, targetCave, t);
            // 若触发了奇遇，更新访客记录的奇遇字段
            if (encounterResult && encounterResult.triggered) {
                visitorRecord.encounter_type = encounterResult.encounter_id;
                visitorRecord.encounter_reward = encounterResult.rewards;
                await visitorRecord.save({ transaction: t });
            }

            await t.commit();
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }

        // 组装目标洞府基本信息（不含敏感字段）
        const landscapeConfig = targetCave.landscape_id
            ? this.getLandscapesConfig().find(l => l.id === targetCave.landscape_id)
            : null;

        return {
            success: true,
            message: `成功拜访 ${targetPlayer.nickname} 的洞府`,
            target: {
                player_id: targetPlayer.id,
                nickname: targetPlayer.nickname,
                realm_rank: targetPlayer.realm_rank
            },
            cave: {
                is_opened: true,
                opened_at: targetCave.opened_at,
                spirit_vein_level: targetCave.spirit_vein_level,
                quiet_room_level: targetCave.quiet_room_level,
                pill_room_level: targetCave.pill_room_level,
                tool_room_level: targetCave.tool_room_level,
                grand_formation_level: targetCave.grand_formation_level,
                garden_plots: targetCave.garden_plots,
                landscape: landscapeConfig ? {
                    id: landscapeConfig.id,
                    name: landscapeConfig.name,
                    description: landscapeConfig.description
                } : null
            },
            // 拜访奇遇结果（triggered=false 表示未触发奇遇）
            encounter: encounterResult,
            today_visited_count: todayVisitedCount + 1,
            daily_limit: dailyLimit
        };
    }

    /**
     * 触发拜访奇遇
     *
     * 奇遇流程：
     *   1. 检查奇遇功能是否开启
     *   2. 检查今日奇遇次数是否已达上限
     *   3. 按 trigger_chance 概率决定是否触发
     *   4. 若触发，按权重随机选择奇遇类型
     *   5. 根据奇遇类型发放奖励（物品/经验/灵石/陷阱）
     *
     * @param {number} playerId - 拜访者玩家ID
     * @param {Object} visitorRecord - 访客记录对象（用于后续更新奇遇字段）
     * @param {Object} targetCave - 目标洞府对象（用于读取灵脉等级等影响奖励的因素）
     * @param {Object} transaction - 数据库事务
     * @returns {Promise<Object>} 奇遇结果 { triggered, encounter_id, name, description, rewards }
     * @private
     */
    async _triggerVisitEncounter(playerId, visitorRecord, targetCave, transaction) {
        const encounterCfg = this.getEncounterConfig();

        // 功能未开启：返回未触发
        if (!encounterCfg.enabled) {
            return { triggered: false, reason: 'encounter_disabled' };
        }

        // 检查今日奇遇次数
        const dailyLimit = encounterCfg.daily_encounter_limit ?? 5;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEncounterCount = await CaveVisitor.count({
            where: {
                visitor_id: playerId,
                visited_at: { [Op.gte]: todayStart },
                encounter_type: { [Op.ne]: null }
            },
            transaction
        });
        if (todayEncounterCount >= dailyLimit) {
            return { triggered: false, reason: 'daily_limit_reached', today_encounters: todayEncounterCount, daily_limit: dailyLimit };
        }

        // 按 trigger_chance 概率决定是否触发
        const triggerChance = encounterCfg.trigger_chance ?? 0.4;
        if (Math.random() > triggerChance) {
            return { triggered: false, reason: 'random_miss' };
        }

        // 按权重随机选择奇遇
        const encounters = encounterCfg.encounters || [];
        if (encounters.length === 0) {
            return { triggered: false, reason: 'no_encounters_configured' };
        }
        const totalWeight = encounters.reduce((sum, e) => sum + (e.weight || 0), 0);
        let roll = Math.random() * totalWeight;
        let selected = encounters[0];
        for (const enc of encounters) {
            roll -= (enc.weight || 0);
            if (roll <= 0) {
                selected = enc;
                break;
            }
        }

        // 根据奇遇类型发放奖励
        const rewards = {};
        const player = await Player.findByPk(playerId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!player) {
            return { triggered: false, reason: 'player_not_found' };
        }

        // 目标洞府灵脉等级影响奖励倍率（灵脉等级越高，残留灵气越浓）
        const spiritVeinMultiplier = 1 + (targetCave.spirit_vein_level || 0) * 0.1;

        if (selected.type === 'item') {
            // 物品奖励：从物品池随机选择
            const pool = selected.rewards?.item_pool || [];
            const itemCount = selected.rewards?.item_count || 1;
            if (pool.length > 0) {
                const itemId = pool[Math.floor(Math.random() * pool.length)];
                await inventoryService.addItem(playerId, itemId, itemCount, transaction);
                rewards.item_id = itemId;
                rewards.item_count = itemCount;
                // 查找物品名称用于展示
                const itemData = this.configLoader?.getConfig('item_data');
                const itemDef = itemData?.items?.find(it => it.id === itemId);
                rewards.item_name = itemDef?.name || itemId;
            }
        } else if (selected.type === 'exp') {
            // 经验奖励：随机范围内取值，乘以灵脉倍率
            const expMin = selected.rewards?.exp_min || 50;
            const expMax = selected.rewards?.exp_max || 200;
            const baseExp = Math.floor(expMin + Math.random() * (expMax - expMin));
            const finalExp = Math.floor(baseExp * spiritVeinMultiplier);
            // 使用 BigInt 安全加经验
            const currentExp = player.exp || 0n;
            player.exp = BigInt(currentExp) + BigInt(finalExp);
            await player.save({ transaction });
            rewards.exp = finalExp;
        } else if (selected.type === 'spirit_stone') {
            // 灵石奖励：随机范围内取值，乘以灵脉倍率
            const ssMin = selected.rewards?.spirit_stone_min || 50;
            const ssMax = selected.rewards?.spirit_stone_max || 150;
            const baseSS = Math.floor(ssMin + Math.random() * (ssMax - ssMin));
            const finalSS = Math.floor(baseSS * spiritVeinMultiplier);
            const currentSS = player.spirit_stone || 0n;
            player.spirit_stone = BigInt(currentSS) + BigInt(finalSS);
            await player.save({ transaction });
            rewards.spirit_stone = finalSS;
        } else if (selected.type === 'trap') {
            // 陷阱：损失少量气血，获得灵石补偿
            const ssMin = selected.rewards?.spirit_stone_min || 20;
            const ssMax = selected.rewards?.spirit_stone_max || 100;
            const finalSS = Math.floor(ssMin + Math.random() * (ssMax - ssMin));
            const currentSS = player.spirit_stone || 0n;
            player.spirit_stone = BigInt(currentSS) + BigInt(finalSS);
            // HP 损失（百分比，最低保留1点）
            const hpLossPercent = selected.rewards?.hp_loss_percent || 5;
            const hpMax = Number(player.hp_max) || 100;
            const hpLoss = Math.floor(hpMax * hpLossPercent / 100);
            const currentHp = Number(player.hp_current) || hpMax;
            player.hp_current = Math.max(1, currentHp - hpLoss);
            await player.save({ transaction });
            rewards.spirit_stone = finalSS;
            rewards.hp_loss = hpLoss;
        }
        // type === 'nothing' 时不发放任何奖励

        return {
            triggered: true,
            encounter_id: selected.id,
            name: selected.name,
            description: selected.description,
            type: selected.type,
            rewards,
            today_encounters: todayEncounterCount + 1,
            daily_limit: dailyLimit
        };
    }

    /**
     * 在他人洞府留言
     * - 校验目标玩家存在且已开辟洞府
     * - 校验留言长度（message_max_length）
     * - 写入留言记录，保留最近 N 条
     *
     * @param {number} playerId - 留言者玩家ID
     * @param {number} targetPlayerId - 目标洞府主人玩家ID
     * @param {string} content - 留言内容
     * @returns {Promise<Object>} 留言结果
     */
    async leaveMessage(playerId, targetPlayerId, content) {
        // 参数校验
        if (!content || typeof content !== 'string') {
            throw new AppError('留言内容不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const trimmed = content.trim();
        if (trimmed.length === 0) {
            throw new AppError('留言内容不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const visitConfig = this.getVisitConfig();
        const maxLength = visitConfig.message_max_length || 200;
        if (trimmed.length > maxLength) {
            throw new AppError(`留言内容过长（上限${maxLength}字）`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 不能给自己留言（社交属性弱化，避免刷屏）
        if (Number(playerId) === Number(targetPlayerId)) {
            throw new AppError('不能在自己的洞府留言', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验目标玩家存在
        const targetPlayer = await Player.findByPk(targetPlayerId);
        if (!targetPlayer) {
            throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 校验目标洞府已开辟
        const targetCave = await PlayerCave.findOne({ where: { player_id: targetPlayerId } });
        if (!targetCave || !targetCave.is_opened) {
            throw new AppError('对方尚未开辟洞府，无法留言', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 写入留言
            await CaveMessage.create({
                cave_owner_id: targetPlayerId,
                visitor_id: playerId,
                content: trimmed
            }, { transaction: t });

            // 清理过期留言：保留最近 max_messages 条
            const maxMessages = visitConfig.max_messages || 100;
            const totalCount = await CaveMessage.count({
                where: { cave_owner_id: targetPlayerId },
                transaction: t
            });
            if (totalCount > maxMessages) {
                const excess = totalCount - maxMessages;
                const oldRecords = await CaveMessage.findAll({
                    where: { cave_owner_id: targetPlayerId },
                    order: [['created_at', 'ASC']],
                    limit: excess,
                    transaction: t
                });
                const oldIds = oldRecords.map(r => r.id);
                await CaveMessage.destroy({
                    where: { id: { [Op.in]: oldIds } },
                    transaction: t
                });
            }

            await t.commit();
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }

        return {
            success: true,
            message: `成功在 ${targetPlayer.nickname} 的洞府留言`,
            content: trimmed
        };
    }

    /**
     * 查看自己洞府的留言列表
     * @param {number} playerId - 洞府主人玩家ID
     * @param {number} limit - 返回条数上限
     * @returns {Promise<Object>} 留言列表
     */
    async getMessages(playerId, limit = 50) {
        const cave = await PlayerCave.findOne({ where: { player_id: playerId } });
        if (!cave || !cave.is_opened) {
            throw new AppError('尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 限制最大查询条数，防止拉取过多
        const safeLimit = Math.min(Math.max(1, limit), 200);

        const messages = await CaveMessage.findAll({
            where: { cave_owner_id: playerId },
            order: [['created_at', 'DESC']],
            limit: safeLimit
        });

        // 批量查询留言者昵称
        const visitorIds = [...new Set(messages.map(m => m.visitor_id))];
        const visitors = visitorIds.length > 0
            ? await Player.findAll({
                where: { id: { [Op.in]: visitorIds } },
                attributes: ['id', 'nickname', 'realm_rank']
            })
            : [];
        const visitorMap = new Map(visitors.map(v => [v.id, v]));

        return {
            messages: messages.map(m => {
                const visitor = visitorMap.get(m.visitor_id);
                return {
                    id: m.id,
                    visitor_id: m.visitor_id,
                    visitor_nickname: visitor?.nickname || '未知修士',
                    visitor_realm_rank: visitor?.realm_rank || 0,
                    content: m.content,
                    created_at: m.created_at
                };
            }),
            total: messages.length
        };
    }

    /**
     * 查看自己洞府的访客记录
     * @param {number} playerId - 洞府主人玩家ID
     * @param {number} limit - 返回条数上限
     * @returns {Promise<Object>} 访客列表
     */
    async getVisitors(playerId, limit = 50) {
        const cave = await PlayerCave.findOne({ where: { player_id: playerId } });
        if (!cave || !cave.is_opened) {
            throw new AppError('尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const safeLimit = Math.min(Math.max(1, limit), 200);

        const visitors = await CaveVisitor.findAll({
            where: { cave_owner_id: playerId },
            order: [['visited_at', 'DESC']],
            limit: safeLimit
        });

        // 批量查询访客昵称
        const visitorIds = [...new Set(visitors.map(v => v.visitor_id))];
        const players = visitorIds.length > 0
            ? await Player.findAll({
                where: { id: { [Op.in]: visitorIds } },
                attributes: ['id', 'nickname', 'realm_rank']
            })
            : [];
        const playerMap = new Map(players.map(p => [p.id, p]));

        return {
            visitors: visitors.map(v => {
                const visitor = playerMap.get(v.visitor_id);
                return {
                    id: v.id,
                    visitor_id: v.visitor_id,
                    visitor_nickname: visitor?.nickname || '未知修士',
                    visitor_realm_rank: visitor?.realm_rank || 0,
                    visited_at: v.visited_at
                };
            }),
            total: visitors.length
        };
    }

    /**
     * 布置洞府景观
     * - 校验景观ID存在
     * - 校验境界要求
     * - 扣除灵石
     * - 更新 player_caves.landscape_id
     * - 已有景观可替换（扣新景观费用）
     *
     * @param {number} playerId - 玩家ID
     * @param {string} landscapeId - 景观ID
     * @returns {Promise<Object>} 布置结果（含加成信息）
     */
    async setLandscape(playerId, landscapeId) {
        if (!landscapeId) {
            throw new AppError('景观ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const landscapes = this.getLandscapesConfig();
        const landscapeConfig = landscapes.find(l => l.id === landscapeId);
        if (!landscapeConfig) {
            throw new AppError(`景观不存在: ${landscapeId}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁洞府记录
            const cave = await PlayerCave.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!cave || !cave.is_opened) {
                throw new AppError('尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 校验境界要求
            const playerRank = player.realm_rank || 0;
            if (playerRank < landscapeConfig.required_realm_rank) {
                throw new AppError(
                    `布置「${landscapeConfig.name}」需境界达到${landscapeConfig.required_realm_rank}层`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 扣除灵石
            const cost = landscapeConfig.cost || 0;
            if (BigInt(player.spirit_stones || 0) < BigInt(cost)) {
                throw new AppError(`灵石不足，布置「${landscapeConfig.name}」需${cost}灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(cost);

            // 更新景观ID
            const oldLandscapeId = cave.landscape_id;
            cave.landscape_id = landscapeId;

            await cave.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `成功布置景观「${landscapeConfig.name}」`,
                landscape: {
                    id: landscapeConfig.id,
                    name: landscapeConfig.name,
                    description: landscapeConfig.description,
                    bonus: landscapeConfig.bonus
                },
                cost: cost,
                old_landscape_id: oldLandscapeId,
                remaining_spirit_stones: Number(player.spirit_stones)
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 查看洞府商人货品
     * - 检查刷新时间，必要时更新 merchant_refresh_at（开始新一批货品）
     * - 基于玩家ID+刷新时间戳种子确定性生成货品列表
     * - 查询购买记录，计算每件商品剩余可购数量
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 货品列表
     */
    async getMerchantGoods(playerId) {
        const cave = await PlayerCave.findOne({ where: { player_id: playerId } });
        if (!cave || !cave.is_opened) {
            throw new AppError('尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const merchantConfig = this.getMerchantConfig();
        const refreshIntervalHours = merchantConfig.refresh_interval_hours || 6;
        const refreshIntervalMs = refreshIntervalHours * 60 * 60 * 1000;

        // 检查是否需要刷新货品
        const now = new Date();
        let needRefresh = false;
        if (!cave.merchant_refresh_at) {
            needRefresh = true;
        } else {
            const elapsed = now - new Date(cave.merchant_refresh_at);
            if (elapsed >= refreshIntervalMs) {
                needRefresh = true;
            }
        }

        if (needRefresh) {
            // 更新刷新时间（开启新一批货品）
            await cave.update({ merchant_refresh_at: now });
            cave.merchant_refresh_at = now;
        }

        const refreshBatch = this._getRefreshBatchId(cave.merchant_refresh_at);
        const goods = this._generateGoods(playerId, cave.merchant_refresh_at, merchantConfig);

        // 查询本批次购买记录，计算剩余可购数量
        const maxBuyPerItem = merchantConfig.max_buy_per_item || 10;
        const purchases = await sequelize.models.cave_merchant_purchase
            ? sequelize.models.cave_merchant_purchase.findAll({
                where: { player_id: playerId, refresh_batch: refreshBatch }
            })
            : [];

        // 如果模型未注册，用原始查询
        let purchaseMap = new Map();
        if (purchases.length > 0) {
            purchaseMap = new Map(purchases.map(p => [p.item_key, p.quantity]));
        } else {
            // 兜底：直接查表（模型可能未在 index.js 注册）
            try {
                const [rows] = await sequelize.query(
                    'SELECT item_key, SUM(quantity) as total FROM cave_merchant_purchases WHERE player_id = ? AND refresh_batch = ? GROUP BY item_key',
                    { replacements: [playerId, refreshBatch] }
                );
                for (const row of rows) {
                    purchaseMap.set(row.item_key, Number(row.total));
                }
            } catch (e) {
                // 表可能未创建，忽略错误
            }
        }

        // 组装货品列表（含剩余可购数量）
        const goodsList = goods.map((g, index) => {
            const bought = purchaseMap.get(g.item_key) || 0;
            return {
                index: index + 1,
                item_key: g.item_key,
                item_name: g.item_name,
                base_price: g.base_price,
                price: g.price,
                discount_rate: g.discount_rate,
                max_buy: maxBuyPerItem,
                bought: bought,
                remaining: Math.max(0, maxBuyPerItem - bought)
            };
        });

        return {
            refresh_batch: refreshBatch,
            refresh_at: cave.merchant_refresh_at,
            next_refresh_at: new Date(new Date(cave.merchant_refresh_at).getTime() + refreshIntervalMs),
            items: goodsList
        };
    }

    /**
     * 购买洞府商人商品
     * - 校验商品编号有效
     * - 校验数量合法（1-max_buy_per_item）
     * - 校验本批次剩余可购数量
     * - 扣灵石、加物品、记录购买
     *
     * @param {number} playerId - 玩家ID
     * @param {number} itemIndex - 商品编号（1-based）
     * @param {number} quantity - 购买数量
     * @returns {Promise<Object>} 购买结果
     */
    async buyMerchantItem(playerId, itemIndex, quantity = 1) {
        // 参数校验
        if (!Number.isInteger(itemIndex) || itemIndex < 1) {
            throw new AppError('商品编号必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new AppError('购买数量必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const merchantConfig = this.getMerchantConfig();
        const maxBuyPerItem = merchantConfig.max_buy_per_item || 10;
        if (quantity > maxBuyPerItem) {
            throw new AppError(`单次购买数量上限为${maxBuyPerItem}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁洞府记录
            const cave = await PlayerCave.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!cave || !cave.is_opened) {
                throw new AppError('尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 确保货品已刷新（如果没有刷新时间，先刷新一次）
            const now = new Date();
            const refreshIntervalHours = merchantConfig.refresh_interval_hours || 6;
            const refreshIntervalMs = refreshIntervalHours * 60 * 60 * 1000;
            if (!cave.merchant_refresh_at) {
                cave.merchant_refresh_at = now;
                await cave.save({ transaction: t });
            } else if (now - new Date(cave.merchant_refresh_at) >= refreshIntervalMs) {
                cave.merchant_refresh_at = now;
                await cave.save({ transaction: t });
            }

            // 生成当前批次货品列表
            const goods = this._generateGoods(playerId, cave.merchant_refresh_at, merchantConfig);
            if (itemIndex > goods.length) {
                throw new AppError('商品编号无效', 400, ErrorCodes.VALIDATION_ERROR);
            }

            const targetGood = goods[itemIndex - 1];
            const refreshBatch = this._getRefreshBatchId(cave.merchant_refresh_at);

            // 查询本批次该商品已购数量
            const [purchaseRows] = await sequelize.query(
                'SELECT SUM(quantity) as total FROM cave_merchant_purchases WHERE player_id = ? AND refresh_batch = ? AND item_key = ? GROUP BY item_key',
                { replacements: [playerId, refreshBatch, targetGood.item_key], transaction: t }
            );
            const alreadyBought = purchaseRows.length > 0 ? Number(purchaseRows[0].total) : 0;
            if (alreadyBought + quantity > maxBuyPerItem) {
                throw new AppError(
                    `本批次「${targetGood.item_name}」已购${alreadyBought}件，剩余可购${maxBuyPerItem - alreadyBought}件`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 计算总价
            const totalPrice = BigInt(targetGood.price) * BigInt(quantity);

            // 行级锁玩家记录，扣灵石
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (BigInt(player.spirit_stones || 0) < totalPrice) {
                throw new AppError(`灵石不足，需${totalPrice}灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            player.spirit_stones = BigInt(player.spirit_stones || 0) - totalPrice;

            // 加物品（通过 InventoryService 在事务内添加）
            await inventoryService.addItem(playerId, targetGood.item_key, quantity, t);

            // 记录购买
            await sequelize.query(
                'INSERT INTO cave_merchant_purchases (player_id, item_key, quantity, total_price, refresh_batch, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
                { replacements: [playerId, targetGood.item_key, quantity, Number(totalPrice), refreshBatch], transaction: t }
            );

            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `成功购买 ${quantity} 个「${targetGood.item_name}」`,
                purchase: {
                    item_key: targetGood.item_key,
                    item_name: targetGood.item_name,
                    quantity: quantity,
                    unit_price: targetGood.price,
                    total_price: Number(totalPrice),
                    refresh_batch: refreshBatch
                },
                remaining_spirit_stones: Number(player.spirit_stones),
                remaining_can_buy: maxBuyPerItem - alreadyBought - quantity
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 生成刷新批次ID（用于标识同批货品）
     * 注意：MySQL DATETIME 类型不存储毫秒，必须截断到秒级，
     * 否则 GET /merchant（用 JS Date 毫秒）和 POST /merchant/buy（用数据库读取的秒精度）会产生不同的 batch ID
     * @param {Date} refreshAt - 刷新时间
     * @returns {string} 批次ID
     */
    _getRefreshBatchId(refreshAt) {
        const d = new Date(refreshAt);
        // 截断到秒级（Math.floor 去掉毫秒），与 MySQL DATETIME 存储精度一致
        const secondsTimestamp = Math.floor(d.getTime() / 1000);
        return `batch_${secondsTimestamp}`;
    }

    /**
     * 基于玩家ID+刷新时间戳种子确定性生成货品列表
     * 同一批次（相同 merchant_refresh_at）每次生成结果相同，保证玩家查看和购买时数据一致
     *
     * @param {number} playerId - 玩家ID
     * @param {Date} refreshAt - 刷新时间
     * @param {Object} merchantConfig - 商人配置
     * @returns {Array} 货品列表（含 item_key, item_name, base_price, price, discount_rate）
     */
    _generateGoods(playerId, refreshAt, merchantConfig) {
        const itemCount = merchantConfig.item_count_per_refresh || 6;
        const allItems = merchantConfig.items || [];
        const discountRange = merchantConfig.price_discount_range || [0.8, 1.2];

        // 构造种子：玩家ID + 刷新时间戳（截断到秒级，与 MySQL DATETIME 存储精度一致）
        const refreshTimeMs = Math.floor(new Date(refreshAt).getTime() / 1000) * 1000;
        const seed = Number(playerId) * 7919 + refreshTimeMs;
        const random = this._createSeededRandom(seed);

        // 基于权重选择 itemCount 个不重复商品
        const selectedItems = [];
        const remainingItems = [...allItems];
        for (let i = 0; i < itemCount && remainingItems.length > 0; i++) {
            // 加权随机选择
            const totalWeight = remainingItems.reduce((sum, item) => sum + (item.weight || 1), 0);
            let r = random() * totalWeight;
            let selectedIndex = 0;
            for (let j = 0; j < remainingItems.length; j++) {
                r -= (remainingItems[j].weight || 1);
                if (r <= 0) {
                    selectedIndex = j;
                    break;
                }
            }
            selectedItems.push(remainingItems[selectedIndex]);
            remainingItems.splice(selectedIndex, 1);
        }

        // 为每个商品生成折扣价格
        const inventoryServiceRef = inventoryService;
        return selectedItems.map(item => {
            const itemConfig = inventoryServiceRef.getItemConfig(item.item_key);
            const discountRate = discountRange[0] + random() * (discountRange[1] - discountRange[0]);
            const price = Math.max(1, Math.round(item.base_price * discountRate));
            return {
                item_key: item.item_key,
                item_name: itemConfig?.name || item.item_key,
                base_price: item.base_price,
                price: price,
                discount_rate: Number(discountRate.toFixed(2))
            };
        });
    }

    /**
     * 创建种子化伪随机数生成器（线性同余法）
     * 保证相同种子产生相同序列，用于确定性生成货品列表
     *
     * @param {number} seed - 随机种子
     * @returns {Function} 返回 [0,1) 之间随机数的函数
     */
    _createSeededRandom(seed) {
        let state = Math.abs(Math.floor(seed)) % 233280 || 1;
        return function() {
            // LCG 参数：a=9301, c=49297, m=233280
            state = (state * 9301 + 49297) % 233280;
            return state / 233280;
        };
    }

    // ==================== 洞天寻宝系统 ====================

    /**
     * 获取洞天寻宝配置
     * @returns {Object} 寻宝配置对象
     */
    getTreasureHuntConfig() {
        return this.getSocialConfig().treasure_hunt || {};
    }

    /**
     * 洞天寻宝
     *
     * 核心多人交互玩法：拜访他人洞府后主动探索地块寻宝
     *   - 寻宝成功：从洞府主人灵石中"借取"一部分（真实资源转移）+ 修为/物品奖励
     *   - 寻宝失败：触发陷阱（HP损失/灵石损失）或遭遇护阵（灵石损失）
     *   - 被发现机制：寻宝失败时按概率被洞府主人发现，主人收到通知
     *
     * 数值设计（全部从 cave_data.json treasure_hunt 配置读取）：
     *   - 基础成功率 35% + 境界差修正（每差1 rank ±3%）- 大阵防御（每级 -5%）
     *   - 宝物：灵石借取率 5-15%（从主人灵石中扣除给寻宝者）+ 修为 100-500 + 30%概率物品
     *   - 陷阱：HP损失 5-15% + 灵石损失 50-200
     *   - 遭遇护阵：灵石损失 20-80
     *   - 被发现率：寻宝失败时 30%
     *   - 冷却：同洞府 24h / 每日 5 次
     *
     * @param {number} hunterId - 寻宝者玩家ID
     * @param {number} targetPlayerId - 目标洞府主人玩家ID
     * @param {number} plotNumber - 地块编号（1-9）
     * @returns {Promise<Object>} 寻宝结果
     */
    async treasureHunt(hunterId, targetPlayerId, plotNumber) {
        const thConfig = this.getTreasureHuntConfig();

        // 功能开关校验
        if (!thConfig.enabled) {
            throw new AppError('洞天寻宝功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验：地块编号
        const plotCount = thConfig.plot_count || 9;
        if (!Number.isInteger(plotNumber) || plotNumber < 1 || plotNumber > plotCount) {
            throw new AppError(`地块编号必须为 1-${plotCount} 的整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 不能寻宝自己洞府
        if (Number(hunterId) === Number(targetPlayerId)) {
            throw new AppError('不能在自己的洞府寻宝', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询目标玩家和洞府
        const targetPlayer = await Player.findByPk(targetPlayerId);
        if (!targetPlayer) {
            throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        const targetCave = await PlayerCave.findOne({ where: { player_id: targetPlayerId } });
        if (!targetCave || !targetCave.is_opened) {
            throw new AppError('对方尚未开辟洞府，无法寻宝', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验每日寻宝次数
        const dailyLimit = thConfig.daily_limit || 5;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const CaveTreasureLog = require('../../models/caveTreasureLog');
        const todayCount = await CaveTreasureLog.count({
            where: { hunter_id: hunterId, created_at: { [Op.gte]: todayStart } }
        });
        if (todayCount >= dailyLimit) {
            throw new AppError(`今日寻宝次数已达上限（${dailyLimit}次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验同洞府冷却（24h）
        const cooldownSeconds = thConfig.cooldown_seconds || 86400;
        const cooldownStart = new Date(Date.now() - cooldownSeconds * 1000);
        const recentHunt = await CaveTreasureLog.findOne({
            where: {
                hunter_id: hunterId,
                cave_owner_id: targetPlayerId,
                created_at: { [Op.gte]: cooldownStart }
            },
            order: [['created_at', 'DESC']]
        });
        if (recentHunt) {
            const remainingMs = cooldownSeconds * 1000 - (Date.now() - new Date(recentHunt.created_at).getTime());
            const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
            throw new AppError(`该洞府寻宝冷却中，还需约 ${remainingHours} 小时`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // ===== 接待/驱逐访客系统集成：检查驱逐封锁和接待背叛 =====
        const vrConfig = this.getVisitorReceptionConfig();
        let isBetraying = false; // 是否在接待期间寻宝（背叛信任）
        if (vrConfig.enabled) {
            // 查询最近的访客记录（hunter 拜访 target 的记录）
            const recentVisit = await CaveVisitor.findOne({
                where: {
                    cave_owner_id: targetPlayerId,
                    visitor_id: hunterId
                },
                order: [['visited_at', 'DESC']]
            });

            if (recentVisit) {
                // 驱逐封锁检查
                if (recentVisit.reception_status === 'expelled' && recentVisit.reception_at) {
                    const blockHours = vrConfig.expel_block_hours || 24;
                    const blockUntil = new Date(new Date(recentVisit.reception_at).getTime() + blockHours * 3600 * 1000);
                    if (new Date() < blockUntil) {
                        const remainingMs = blockUntil.getTime() - Date.now();
                        const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
                        throw new AppError(`你已被洞府主人驱逐，${remainingHours} 小时内无法寻宝此洞府`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                    }
                }

                // 接待背叛标记：若在接待buff有效期内寻宝，被发现率增加
                if (recentVisit.reception_status === 'received' && recentVisit.reception_buff_until) {
                    if (new Date() < new Date(recentVisit.reception_buff_until)) {
                        isBetraying = true;
                    }
                }
            }
        }

        const cost = thConfig.cost_spirit_stones || 100;
        const t = await sequelize.transaction();
        try {
            // 行级锁寻宝者
            const hunter = await Player.findByPk(hunterId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!hunter) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            // 校验灵石足够
            if (BigInt(hunter.spirit_stones || 0) < BigInt(cost)) {
                throw new AppError(`灵石不足，寻宝需 ${cost} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 扣除寻宝费
            hunter.spirit_stones = BigInt(hunter.spirit_stones || 0) - BigInt(cost);

            // ===== 计算寻宝成功率 =====
            const baseRate = thConfig.base_success_rate ?? 0.35;
            const realmDiffMod = thConfig.realm_diff_modifier ?? 0.03;
            const formationMod = thConfig.formation_defense_per_level ?? 0.05;
            // 境界差：寻宝者境界高于洞府主人时成功率增加，反之降低
            const realmDiff = (hunter.realm_rank || 0) - (targetPlayer.realm_rank || 0);
            // 大阵等级降低成功率
            const formationLevel = targetCave.grand_formation_level || 0;
            let successRate = baseRate + realmDiff * realmDiffMod - formationLevel * formationMod;

            // ===== 万宝阁展品联动（财富外露 + 珍宝护体）=====
            // 展品越多越显眼，被寻宝成功率上升；传说级以上展品自带灵气护体，提升大阵防御
            const exhibitBonus = await this.calculateExhibitTreasureHuntBonus(targetPlayerId);
            successRate = successRate + exhibitBonus.success_rate_bonus - exhibitBonus.formation_defense_bonus;

            successRate = Math.max(0.05, Math.min(0.85, successRate)); // 限制在 5%-85%

            // 决定是否寻宝成功
            const isSuccess = Math.random() < successRate;

            // 按结果类型选择
            const results = thConfig.results || {};
            let resultType;
            if (isSuccess) {
                // 成功：按权重选 treasure 或 empty
                resultType = this._weightedSelect([
                    { key: 'treasure', weight: results.treasure?.weight || 40 },
                    { key: 'empty', weight: results.empty?.weight || 25 }
                ]);
            } else {
                // 失败：按权重选 trap 或 encounter
                resultType = this._weightedSelect([
                    { key: 'trap', weight: results.trap?.weight || 20 },
                    { key: 'encounter', weight: results.encounter?.weight || 15 }
                ]);
            }

            const resultCfg = results[resultType] || {};
            const rewards = {};
            let discovered = false;

            if (resultType === 'treasure') {
                // ===== 寻得宝物：从洞府主人灵石中借取 + 修为 + 物品 =====
                const stealRateMin = resultCfg.spirit_stone_steal_rate?.[0] ?? 0.05;
                const stealRateMax = resultCfg.spirit_stone_steal_rate?.[1] ?? 0.15;
                const stealRate = stealRateMin + Math.random() * (stealRateMax - stealRateMin);
                // 行级锁洞府主人，扣除灵石给寻宝者
                const owner = await Player.findByPk(targetPlayerId, { lock: t.LOCK.UPDATE, transaction: t });
                if (owner) {
                    const ownerStones = BigInt(owner.spirit_stones || 0);
                    // 借取量 = 主人灵石 × 借取率，但有上限（不超过主人灵石的 15%）
                    const stolen = ownerStones > 0n
                        ? ownerStones * BigInt(Math.floor(stealRate * 1000)) / 1000n
                        : 0n;
                    if (stolen > 0n) {
                        owner.spirit_stones = ownerStones - stolen;
                        hunter.spirit_stones = BigInt(hunter.spirit_stones || 0) + stolen;
                        rewards.spirit_stones = Number(stolen);
                        await owner.save({ transaction: t });
                    }
                }
                // 修为奖励
                const expMin = resultCfg.exp_min || 100;
                const expMax = resultCfg.exp_max || 500;
                const expGain = Math.floor(expMin + Math.random() * (expMax - expMin));
                hunter.exp = BigInt(hunter.exp || 0) + BigInt(expGain);
                rewards.exp = expGain;
                // 物品奖励（按概率）
                const itemChance = resultCfg.item_chance ?? 0.3;
                if (Math.random() < itemChance) {
                    const pool = resultCfg.item_pool || [];
                    if (pool.length > 0) {
                        const itemId = pool[Math.floor(Math.random() * pool.length)];
                        await inventoryService.addItem(hunterId, itemId, 1, t);
                        const itemData = this.configLoader?.getConfig('item_data');
                        const itemDef = itemData?.items?.find(it => it.id === itemId);
                        rewards.item_id = itemId;
                        rewards.item_name = itemDef?.name || itemId;
                    }
                }
            } else if (resultType === 'trap') {
                // ===== 触发陷阱：HP损失 + 灵石损失 =====
                const hpLossMin = resultCfg.hp_loss_percent_min || 5;
                const hpLossMax = resultCfg.hp_loss_percent_max || 15;
                const hpLossPercent = hpLossMin + Math.random() * (hpLossMax - hpLossMin);
                const hpMax = Number(hunter.hp_max) || 100;
                const hpLoss = Math.floor(hpMax * hpLossPercent / 100);
                const currentHp = Number(hunter.hp_current) || hpMax;
                hunter.hp_current = Math.max(1, currentHp - hpLoss);
                rewards.hp_loss = hpLoss;
                // 额外灵石损失（寻宝费之外的额外损失）
                const ssLossMin = resultCfg.spirit_stone_loss_min || 50;
                const ssLossMax = resultCfg.spirit_stone_loss_max || 200;
                const ssLoss = Math.floor(ssLossMin + Math.random() * (ssLossMax - ssLossMin));
                const currentStones = BigInt(hunter.spirit_stones || 0);
                if (currentStones > BigInt(ssLoss)) {
                    hunter.spirit_stones = currentStones - BigInt(ssLoss);
                    rewards.spirit_stone_loss = ssLoss;
                } else {
                    rewards.spirit_stone_loss = Number(currentStones);
                    hunter.spirit_stones = 0n;
                }
            } else if (resultType === 'encounter') {
                // ===== 遭遇护阵：灵石损失（较轻） =====
                const ssLossMin = resultCfg.spirit_stone_loss_min || 20;
                const ssLossMax = resultCfg.spirit_stone_loss_max || 80;
                const ssLoss = Math.floor(ssLossMin + Math.random() * (ssLossMax - ssLossMin));
                const currentStones = BigInt(hunter.spirit_stones || 0);
                if (currentStones > BigInt(ssLoss)) {
                    hunter.spirit_stones = currentStones - BigInt(ssLoss);
                    rewards.spirit_stone_loss = ssLoss;
                } else {
                    rewards.spirit_stone_loss = Number(currentStones);
                    hunter.spirit_stones = 0n;
                }
            }
            // resultType === 'empty' 时不发放任何奖励

            // ===== 被发现判定（仅寻宝失败时） =====
            if (!isSuccess) {
                let discoveredRate = thConfig.discovered_rate_on_fail ?? 0.30;
                // 接待背叛惩罚：在接待buff有效期内寻宝，被发现率额外增加
                if (isBetraying) {
                    const betrayalBonus = vrConfig.betrayal_discovery_bonus ?? 0.5;
                    discoveredRate = Math.min(0.95, discoveredRate + betrayalBonus);
                }
                if (Math.random() < discoveredRate) {
                    discovered = true;
                }
            }

            await hunter.save({ transaction: t });

            // 写入寻宝日志
            const logRecord = await CaveTreasureLog.create({
                hunter_id: hunterId,
                cave_owner_id: targetPlayerId,
                plot_number: plotNumber,
                result_type: resultType,
                rewards: rewards,
                is_discovered: discovered
            }, { transaction: t });

            await t.commit();

            // ===== commit 后推送 WebSocket 通知 =====
            // 被发现时通知洞府主人
            if (discovered) {
                try {
                    const WebSocketNotificationService = require('./WebSocketNotificationService');
                    WebSocketNotificationService.notifyPlayerUpdate(targetPlayerId, 'cave_treasure_discovered', {
                        message: thConfig.discovered_penalty?.owner_message || '有修士在你的洞府寻宝被你发现了！',
                        hunter_id: hunterId,
                        hunter_nickname: hunter.nickname,
                        plot_number: plotNumber
                    });
                } catch (e) {
                    console.warn('[CaveSocialService] 推送寻宝被发现通知失败:', e.message);
                }
            }

            return {
                success: true,
                message: resultCfg.description || '寻宝完成',
                result_type: resultType,
                result_name: resultCfg.name || resultType,
                rewards,
                is_discovered: discovered,
                success_rate: Number(successRate.toFixed(4)),
                plot_number: plotNumber,
                target: {
                    player_id: targetPlayer.id,
                    nickname: targetPlayer.nickname
                },
                // 万宝阁展品对寻宝成功率的影响明细（财富外露+珍宝护体）
                exhibit_bonus: exhibitBonus,
                today_count: todayCount + 1,
                daily_limit: dailyLimit,
                cost: cost,
                remaining_spirit_stones: Number(hunter.spirit_stones)
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 按权重随机选择
     * @param {Array<{key: string, weight: number}>} items - 选项列表
     * @returns {string} 选中的 key
     * @private
     */
    _weightedSelect(items) {
        const totalWeight = items.reduce((sum, item) => sum + (item.weight || 0), 0);
        let roll = Math.random() * totalWeight;
        for (const item of items) {
            roll -= (item.weight || 0);
            if (roll <= 0) return item.key;
        }
        return items[items.length - 1].key;
    }

    /**
     * 查询寻宝日志
     * @param {number} playerId - 玩家ID
     * @param {string} role - 角色：hunter（寻宝者）/ owner（洞府主人被寻宝）
     * @param {number} limit - 返回条数上限
     * @returns {Promise<Object>} 寻宝日志列表
     */
    async getTreasureLogs(playerId, role = 'hunter', limit = 50) {
        const CaveTreasureLog = require('../../models/caveTreasureLog');
        const safeLimit = Math.min(Math.max(1, limit), 200);

        const whereClause = role === 'owner'
            ? { cave_owner_id: playerId }
            : { hunter_id: playerId };

        const logs = await CaveTreasureLog.findAll({
            where: whereClause,
            order: [['created_at', 'DESC']],
            limit: safeLimit
        });

        // 批量查询关联玩家昵称
        const playerIds = [...new Set([
            ...logs.map(l => l.hunter_id),
            ...logs.map(l => l.cave_owner_id)
        ])];
        const players = playerIds.length > 0
            ? await Player.findAll({
                where: { id: { [Op.in]: playerIds } },
                attributes: ['id', 'nickname', 'realm_rank']
            })
            : [];
        const playerMap = new Map(players.map(p => [p.id, p]));

        return {
            role,
            logs: logs.map(l => {
                const hunter = playerMap.get(l.hunter_id);
                const owner = playerMap.get(l.cave_owner_id);
                return {
                    id: l.id,
                    hunter_id: l.hunter_id,
                    hunter_nickname: hunter?.nickname || '未知修士',
                    cave_owner_id: l.cave_owner_id,
                    cave_owner_nickname: owner?.nickname || '未知修士',
                    plot_number: l.plot_number,
                    result_type: l.result_type,
                    rewards: l.rewards,
                    is_discovered: l.is_discovered,
                    created_at: l.created_at
                };
            }),
            total: logs.length
        };
    }

    // ==================== 接待/驱逐访客系统 ====================

    /**
     * 获取接待/驱逐访客配置
     * @returns {Object} 接待配置
     */
    getVisitorReceptionConfig() {
        // 复用 getSocialConfig() 统一配置路径（cave_data.json → cave.social）
        return this.getSocialConfig().visitor_reception || { enabled: false };
    }

    /**
     * 获取待处理的访客列表（洞府主人视角）
     *
     * 返回 reception_status='pending' 的访客记录，按拜访时间倒序
     * 同时返回已接待/已驱逐的最近记录供主人查看
     *
     * @param {number} ownerId - 洞府主人玩家ID
     * @param {number} limit - 返回条数
     * @returns {Promise<Object>} { pending, recent, total_pending }
     */
    async getVisitorReceptionList(ownerId, limit = 20) {
        const vrConfig = this.getVisitorReceptionConfig();
        if (!vrConfig.enabled) {
            throw new AppError('接待访客功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询待处理访客
        const pending = await CaveVisitor.findAll({
            where: {
                cave_owner_id: ownerId,
                reception_status: 'pending'
            },
            order: [['visited_at', 'DESC']],
            limit: limit
        });

        // 查询最近已处理的访客记录（供主人查看处理结果）
        const recent = await CaveVisitor.findAll({
            where: {
                cave_owner_id: ownerId,
                reception_status: { [Op.ne]: 'pending' }
            },
            order: [['reception_at', 'DESC']],
            limit: 10
        });

        // 批量查询访客昵称
        const visitorIds = [...pending, ...recent].map(v => v.visitor_id);
        const visitors = visitorIds.length > 0
            ? await Player.findAll({ where: { id: visitorIds }, attributes: ['id', 'nickname', 'realm'] })
            : [];
        const visitorMap = new Map(visitors.map(p => [p.id, p]));

        const formatVisitor = (v) => ({
            id: v.id,
            visitor_id: v.visitor_id,
            visitor_nickname: visitorMap.get(v.visitor_id)?.nickname || '未知修士',
            visitor_realm: visitorMap.get(v.visitor_id)?.realm || '',
            visited_at: v.visited_at,
            encounter_type: v.encounter_type,
            encounter_reward: v.encounter_reward,
            reception_status: v.reception_status,
            reception_at: v.reception_at,
            reception_buff_until: v.reception_buff_until,
            // 接待buff是否仍有效
            buff_active: v.reception_status === 'received' && v.reception_buff_until
                ? new Date() < new Date(v.reception_buff_until)
                : false,
            // 驱逐封锁是否仍有效
            block_active: v.reception_status === 'expelled' && v.reception_at
                ? new Date() < new Date(new Date(v.reception_at).getTime() + (vrConfig.expel_block_hours || 24) * 3600 * 1000)
                : false
        });

        return {
            pending: pending.map(formatVisitor),
            recent: recent.map(formatVisitor),
            total_pending: pending.length
        };
    }

    /**
     * 接待访客
     *
     * 洞府主人接待访客，消耗灵石，访客获得临时增益buff：
     *   - 静思悟道经验加成 buff_meditation_bonus（如 +10%）
     *   - 洞府游商折扣 buff_merchant_discount（如 10% off）
     *   - 接待期间访客若寻宝此洞府，被发现率额外 +50%（背叛信任惩罚）
     *
     * @param {number} ownerId - 洞府主人玩家ID
     * @param {number} visitorRecordId - 访客记录ID
     * @returns {Promise<Object>} 接待结果
     */
    async receiveVisitor(ownerId, visitorRecordId) {
        const vrConfig = this.getVisitorReceptionConfig();
        if (!vrConfig.enabled) {
            throw new AppError('接待访客功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询主人
            const owner = await Player.findByPk(ownerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!owner) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 查询访客记录
            const record = await CaveVisitor.findByPk(visitorRecordId, { transaction: t });
            if (!record) {
                throw new AppError('访客记录不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (Number(record.cave_owner_id) !== Number(ownerId)) {
                throw new AppError('无权处理此访客记录', 403, ErrorCodes.FORBIDDEN);
            }
            if (record.reception_status !== 'pending') {
                throw new AppError(`该访客已处理过（状态: ${record.reception_status}）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验灵石
            const cost = vrConfig.receive_cost || 100;
            if (BigInt(owner.spirit_stones || 0) < BigInt(cost)) {
                throw new AppError(`灵石不足，接待需 ${cost} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣除灵石
            owner.spirit_stones = BigInt(owner.spirit_stones || 0) - BigInt(cost);
            await owner.save({ transaction: t });

            // 更新访客记录
            const buffHours = vrConfig.buff_duration_hours || 2;
            const buffUntil = new Date(Date.now() + buffHours * 3600 * 1000);
            record.reception_status = 'received';
            record.reception_at = new Date();
            record.reception_buff_until = buffUntil;
            await record.save({ transaction: t });

            await t.commit();

            // 查询访客信息
            const visitor = await Player.findByPk(record.visitor_id, { attributes: ['id', 'nickname', 'realm'] });

            // 通过 WebSocket 通知访客被接待
            try {
                const io = require('../../config/socket').getIO();
                if (io) {
                    io.to(`user_${record.visitor_id}`).emit('cave_visitor_received', {
                        owner_id: ownerId,
                        owner_nickname: owner.nickname,
                        buff_until: buffUntil,
                        meditation_bonus: vrConfig.buff_meditation_bonus || 0,
                        merchant_discount: vrConfig.buff_merchant_discount || 0,
                        message: `${owner.nickname} 接待了你，获得 ${buffHours} 小时修炼增益`
                    });
                }
            } catch (e) {
                // WebSocket 推送失败不影响主流程
            }

            return {
                success: true,
                message: `已接待访客 ${visitor?.nickname || '未知'}，消耗 ${cost} 灵石`,
                visitor: {
                    player_id: record.visitor_id,
                    nickname: visitor?.nickname || '未知修士',
                    realm: visitor?.realm || ''
                },
                cost: cost,
                buff_until: buffUntil,
                buff_meditation_bonus: vrConfig.buff_meditation_bonus || 0,
                buff_merchant_discount: vrConfig.buff_merchant_discount || 0,
                remaining_spirit_stones: Number(owner.spirit_stones)
            };
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    /**
     * 驱逐访客
     *
     * 洞府主人驱逐访客，封锁访客在 expel_block_hours 内无法拜访和寻宝此洞府
     * 不消耗灵石，纯防御操作
     *
     * @param {number} ownerId - 洞府主人玩家ID
     * @param {number} visitorRecordId - 访客记录ID
     * @returns {Promise<Object>} 驱逐结果
     */
    async expelVisitor(ownerId, visitorRecordId) {
        const vrConfig = this.getVisitorReceptionConfig();
        if (!vrConfig.enabled) {
            throw new AppError('接待访客功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询访客记录
        const record = await CaveVisitor.findByPk(visitorRecordId);
        if (!record) {
            throw new AppError('访客记录不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (Number(record.cave_owner_id) !== Number(ownerId)) {
            throw new AppError('无权处理此访客记录', 403, ErrorCodes.FORBIDDEN);
        }
        if (record.reception_status !== 'pending') {
            throw new AppError(`该访客已处理过（状态: ${record.reception_status}）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 更新访客记录
        const blockHours = vrConfig.expel_block_hours || 24;
        const blockUntil = new Date(Date.now() + blockHours * 3600 * 1000);
        record.reception_status = 'expelled';
        record.reception_at = new Date();
        await record.save();

        // 查询访客信息
        const visitor = await Player.findByPk(record.visitor_id, { attributes: ['id', 'nickname', 'realm'] });

        // 通过 WebSocket 通知访客被驱逐
        try {
            const io = require('../../config/socket').getIO();
            if (io) {
                io.to(`user_${record.visitor_id}`).emit('cave_visitor_expelled', {
                    owner_id: ownerId,
                    block_until: blockUntil,
                    message: `你被洞府主人驱逐，${blockHours} 小时内无法拜访和寻宝此洞府`
                });
            }
        } catch (e) {
            // WebSocket 推送失败不影响主流程
        }

        return {
            success: true,
            message: `已驱逐访客 ${visitor?.nickname || '未知'}，${blockHours} 小时内无法拜访和寻宝`,
            visitor: {
                player_id: record.visitor_id,
                nickname: visitor?.nickname || '未知修士',
                realm: visitor?.realm || ''
            },
            block_until: blockUntil,
            block_hours: blockHours
        };
    }

    /**
     * 忽略访客（不予理睬）
     *
     * 主人选择忽略访客记录，不影响访客任何行为
     * 用于清理待处理列表但不做任何操作
     *
     * @param {number} ownerId - 洞府主人玩家ID
     * @param {number} visitorRecordId - 访客记录ID
     * @returns {Promise<Object>} 忽略结果
     */
    async ignoreVisitor(ownerId, visitorRecordId) {
        const record = await CaveVisitor.findByPk(visitorRecordId);
        if (!record) {
            throw new AppError('访客记录不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (Number(record.cave_owner_id) !== Number(ownerId)) {
            throw new AppError('无权处理此访客记录', 403, ErrorCodes.FORBIDDEN);
        }
        if (record.reception_status !== 'pending') {
            throw new AppError(`该访客已处理过（状态: ${record.reception_status}）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        record.reception_status = 'ignored';
        record.reception_at = new Date();
        await record.save();

        return {
            success: true,
            message: '已忽略该访客记录'
        };
    }

    // ==================== 万宝阁展品系统 ====================

    /**
     * 获取万宝阁展品系统配置
     * @returns {Object} 万宝阁配置对象
     */
    getTreasurePavilionConfig() {
        return this.getSocialConfig().treasure_pavilion || { enabled: false };
    }

    /**
     * 获取品质等级数值（用于比较与奖励计算）
     * @param {string} quality - 品质名（common/uncommon/rare/epic/legendary/mythic）
     * @returns {number} 品质等级（0-5），未知品质返回 0
     */
    _getQualityRank(quality) {
        const tpConfig = this.getTreasurePavilionConfig();
        const order = tpConfig.quality_order || ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
        const idx = order.indexOf(quality);
        return idx >= 0 ? idx : 0;
    }

    /**
     * 获取我的万宝阁展品列表
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 展品列表与统计
     */
    async getMyExhibits(playerId) {
        const tpConfig = this.getTreasurePavilionConfig();
        if (!tpConfig.enabled) {
            throw new AppError('万宝阁展品功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const CaveExhibit = require('../../models/caveExhibit');
        const exhibits = await CaveExhibit.findAll({
            where: { player_id: playerId },
            order: [['exhibit_slot', 'ASC']]
        });

        // 合并物品配置详情（描述、效果等）
        const itemData = this.configLoader?.getConfig('item_data');
        const items = itemData?.items || [];
        const itemMap = new Map(items.map(i => [i.id, i]));

        return {
            exhibits: exhibits.map(e => {
                const config = itemMap.get(e.item_key);
                return {
                    id: e.id,
                    item_key: e.item_key,
                    item_name: e.item_name,
                    quality: e.quality,
                    description: config?.description || '',
                    effect: config?.effect || {},
                    price: config?.price || 0,
                    type: config?.type || 'unknown',
                    exhibit_slot: e.exhibit_slot,
                    heat_count: e.heat_count,
                    created_at: e.created_at
                };
            }),
            total: exhibits.length,
            max_exhibits: tpConfig.max_exhibits || 6,
            min_quality: tpConfig.min_quality || 'uncommon'
        };
    }

    /**
     * 上架展品至万宝阁
     *
     * 流程：
     *   1. 校验功能开启、物品存在、品质达标
     *   2. 校验展位未满（max_exhibits）
     *   3. 校验同一物品未重复上架（避免同一物品占多展位）
     *   4. 从背包扣除 1 件物品（InventoryService.removeItem）
     *   5. 分配展位编号（从 1 开始找空位）
     *   6. 写入 cave_exhibits 表
     *
     * @param {number} playerId - 玩家ID
     * @param {string} itemKey - 物品配置键名
     * @returns {Promise<Object>} 上架结果
     */
    async listExhibit(playerId, itemKey) {
        const tpConfig = this.getTreasurePavilionConfig();
        if (!tpConfig.enabled) {
            throw new AppError('万宝阁展品功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        if (!itemKey || typeof itemKey !== 'string') {
            throw new AppError('物品ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 查询物品配置
        const itemConfig = inventoryService.getItemConfig(itemKey);
        if (!itemConfig) {
            throw new AppError(`物品不存在: ${itemKey}`, 404, ErrorCodes.NOT_FOUND);
        }

        // 校验品质达标
        const minQualityRank = this._getQualityRank(tpConfig.min_quality || 'uncommon');
        const itemQualityRank = this._getQualityRank(itemConfig.quality || 'common');
        if (itemQualityRank < minQualityRank) {
            throw new AppError(
                `物品品质需达到「${tpConfig.min_quality}」以上方可上架万宝阁`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        const t = await sequelize.transaction();
        try {
            const CaveExhibit = require('../../models/caveExhibit');

            // 行级锁查询已有展品
            const existingExhibits = await CaveExhibit.findAll({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            const maxExhibits = tpConfig.max_exhibits || 6;
            if (existingExhibits.length >= maxExhibits) {
                throw new AppError(`万宝阁展位已满（上限 ${maxExhibits} 件），请先取下部分展品`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验同一物品未重复上架
            const duplicate = existingExhibits.find(e => e.item_key === itemKey);
            if (duplicate) {
                throw new AppError('该物品已上架至万宝阁，不可重复上架', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验背包拥有该物品（至少 1 件）
            const hasItem = await inventoryService.hasItem(playerId, itemKey, 1);
            if (!hasItem) {
                throw new AppError(`背包中没有「${itemConfig.name}」或数量不足`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 从背包扣除 1 件
            await inventoryService.removeItem(playerId, itemKey, 1, t);

            // 分配展位编号（找最小空位）
            const usedSlots = new Set(existingExhibits.map(e => e.exhibit_slot));
            let slot = 1;
            while (usedSlots.has(slot)) slot++;

            // 写入展品记录
            const exhibit = await CaveExhibit.create({
                player_id: playerId,
                item_key: itemKey,
                item_name: itemConfig.name,
                quality: itemConfig.quality || 'common',
                exhibit_slot: slot,
                heat_count: 0
            }, { transaction: t });

            await t.commit();

            return {
                success: true,
                message: `成功将「${itemConfig.name}」上架至万宝阁第 ${slot} 展位`,
                exhibit: {
                    id: exhibit.id,
                    item_key: exhibit.item_key,
                    item_name: exhibit.item_name,
                    quality: exhibit.quality,
                    exhibit_slot: exhibit.exhibit_slot,
                    heat_count: 0,
                    created_at: exhibit.created_at
                },
                total_exhibits: existingExhibits.length + 1,
                max_exhibits: maxExhibits
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 从万宝阁取下展品
     *
     * 流程：
     *   1. 校验展品存在且属于该玩家
     *   2. 删除 cave_exhibits 记录
     *   3. 物品归还背包（InventoryService.addItem）
     *   4. 注意：取下后该展品的热度值清零，不可恢复
     *
     * @param {number} playerId - 玩家ID
     * @param {number} exhibitId - 展品ID
     * @returns {Promise<Object>} 取下结果
     */
    async unlistExhibit(playerId, exhibitId) {
        if (!Number.isInteger(exhibitId) || exhibitId < 1) {
            throw new AppError('展品ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const CaveExhibit = require('../../models/caveExhibit');

            // 行级锁查询展品
            const exhibit = await CaveExhibit.findByPk(exhibitId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!exhibit) {
                throw new AppError('展品不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (Number(exhibit.player_id) !== Number(playerId)) {
                throw new AppError('无权取下他人洞府的展品', 403, ErrorCodes.FORBIDDEN);
            }

            // 删除展品记录
            await exhibit.destroy({ transaction: t });

            // 物品归还背包
            await inventoryService.addItem(playerId, exhibit.item_key, 1, t);

            await t.commit();

            return {
                success: true,
                message: `已将「${exhibit.item_name}」从万宝阁取下，物品已归还背包`,
                returned_item: {
                    item_key: exhibit.item_key,
                    item_name: exhibit.item_name,
                    quantity: 1
                },
                cleared_heat: exhibit.heat_count
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 查看他人洞府的展品（供鉴赏）
     *
     * 拜访者视角：查看目标洞府的万宝阁展品列表，标注哪些今日已鉴赏过
     *
     * @param {number} viewerId - 查看者玩家ID
     * @param {number} targetPlayerId - 目标洞府主人玩家ID
     * @returns {Promise<Object>} 展品列表（含今日已鉴赏标记）
     */
    async viewPlayerExhibits(viewerId, targetPlayerId) {
        const tpConfig = this.getTreasurePavilionConfig();
        if (!tpConfig.enabled) {
            throw new AppError('万宝阁展品功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询目标洞府
        const targetCave = await PlayerCave.findOne({ where: { player_id: targetPlayerId } });
        if (!targetCave || !targetCave.is_opened) {
            throw new AppError('对方尚未开辟洞府', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const CaveExhibit = require('../../models/caveExhibit');
        const CaveExhibitAppreciation = require('../../models/caveExhibitAppreciation');

        const exhibits = await CaveExhibit.findAll({
            where: { player_id: targetPlayerId },
            order: [['exhibit_slot', 'ASC']]
        });

        if (exhibits.length === 0) {
            return {
                target_player_id: targetPlayerId,
                exhibits: [],
                total: 0,
                message: '对方洞府万宝阁暂无展品'
            };
        }

        // 查询今日已鉴赏的展品ID列表（防止重复鉴赏）
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayAppreciations = await CaveExhibitAppreciation.findAll({
            where: {
                appreciator_id: viewerId,
                created_at: { [Op.gte]: todayStart }
            },
            attributes: ['exhibit_id'],
            transaction: null
        });
        const appreciatedToday = new Set(todayAppreciations.map(a => a.appreciator_id && a.exhibit_id).filter(Boolean));

        // 查询今日鉴赏次数（用于显示剩余次数）
        const appreciateCfg = tpConfig.appreciate || {};
        const dailyLimit = appreciateCfg.daily_limit || 3;
        const todayCount = todayAppreciations.length;

        // 合并物品配置详情
        const itemData = this.configLoader?.getConfig('item_data');
        const items = itemData?.items || [];
        const itemMap = new Map(items.map(i => [i.id, i]));

        // 查询目标玩家昵称
        const targetPlayer = await Player.findByPk(targetPlayerId, { attributes: ['id', 'nickname', 'realm'] });

        return {
            target_player_id: targetPlayerId,
            target_nickname: targetPlayer?.nickname || '未知修士',
            target_realm: targetPlayer?.realm || '',
            exhibits: exhibits.map(e => {
                const config = itemMap.get(e.item_key);
                return {
                    id: e.id,
                    item_key: e.item_key,
                    item_name: e.item_name,
                    quality: e.quality,
                    description: config?.description || '',
                    effect: config?.effect || {},
                    price: config?.price || 0,
                    type: config?.type || 'unknown',
                    exhibit_slot: e.exhibit_slot,
                    heat_count: e.heat_count,
                    created_at: e.created_at,
                    appreciated_today: appreciatedToday.has(e.id)
                };
            }),
            total: exhibits.length,
            today_appreciated_count: todayCount,
            daily_limit: dailyLimit,
            remaining_appreciations: Math.max(0, dailyLimit - todayCount)
        };
    }

    /**
     * 鉴赏展品
     *
     * 核心多人正向交互：拜访者鉴赏他人洞府展品，获得修为灵感
     *   1. 校验功能开启、展品存在、不能鉴赏自己的展品
     *   2. 校验每日鉴赏次数（daily_limit）
     *   3. 校验同一展品今日未鉴赏过（防刷）
     *   4. 计算基础修为奖励 = exp_base + exp_per_quality × qualityRank
     *   5. 按 enlighten_chance 概率触发顿悟：修为 × multiplier + 临时修炼buff
     *   6. 展品热度 +1，若品质达标则主人的 honor（声望）+N（实时发放）
     *   7. 通过 WebSocket 通知主人有人鉴赏其展品
     *
     * @param {number} appreciatorId - 鉴赏者玩家ID
     * @param {number} exhibitId - 展品ID
     * @returns {Promise<Object>} 鉴赏结果
     */
    async appreciateExhibit(appreciatorId, exhibitId) {
        const tpConfig = this.getTreasurePavilionConfig();
        if (!tpConfig.enabled) {
            throw new AppError('万宝阁展品功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        if (!Number.isInteger(exhibitId) || exhibitId < 1) {
            throw new AppError('展品ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const appreciateCfg = tpConfig.appreciate || {};
        const heatCfg = tpConfig.heat || {};

        const t = await sequelize.transaction();
        try {
            const CaveExhibit = require('../../models/caveExhibit');
            const CaveExhibitAppreciation = require('../../models/caveExhibitAppreciation');

            // 行级锁查询展品
            const exhibit = await CaveExhibit.findByPk(exhibitId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!exhibit) {
                throw new AppError('展品不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 不能鉴赏自己的展品
            if (Number(exhibit.player_id) === Number(appreciatorId)) {
                throw new AppError('不能鉴赏自己洞府的展品', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验每日鉴赏次数
            const dailyLimit = appreciateCfg.daily_limit || 3;
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayCount = await CaveExhibitAppreciation.count({
                where: {
                    appreciator_id: appreciatorId,
                    created_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            if (todayCount >= dailyLimit) {
                throw new AppError(`今日鉴赏次数已达上限（${dailyLimit}次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验同一展品今日未鉴赏过
            const alreadyAppreciated = await CaveExhibitAppreciation.findOne({
                where: {
                    exhibit_id: exhibitId,
                    appreciator_id: appreciatorId,
                    created_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            if (alreadyAppreciated) {
                throw new AppError('今日已鉴赏过此展品，明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // ===== 计算修为奖励 =====
            const expBase = appreciateCfg.exp_base || 50;
            const expPerQuality = appreciateCfg.exp_per_quality || 30;
            const qualityRank = this._getQualityRank(exhibit.quality);
            const baseExp = expBase + expPerQuality * qualityRank;

            // 顿悟判定
            const enlightenChance = appreciateCfg.enlighten_chance || 0.15;
            const isEnlightened = Math.random() < enlightenChance;
            const enlightenMultiplier = appreciateCfg.enlighten_exp_multiplier || 3;
            const expGained = isEnlightened ? Math.floor(baseExp * enlightenMultiplier) : baseExp;

            // 行级锁鉴赏者，发放修为
            const appreciator = await Player.findByPk(appreciatorId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!appreciator) {
                throw new AppError('鉴赏者不存在', 404, ErrorCodes.NOT_FOUND);
            }
            appreciator.exp = BigInt(appreciator.exp || 0) + BigInt(expGained);
            await appreciator.save({ transaction: t });

            // 更新展品热度
            exhibit.heat_count = (exhibit.heat_count || 0) + 1;
            await exhibit.save({ transaction: t });

            // 写入鉴赏记录
            const appreciationRecord = await CaveExhibitAppreciation.create({
                exhibit_id: exhibitId,
                appreciator_id: appreciatorId,
                is_enlightened: isEnlightened,
                exp_gained: expGained
            }, { transaction: t });

            // ===== 声望奖励给展品主人（实时发放） =====
            let ownerHonorGained = 0;
            const honorPerAppreciation = heatCfg.honor_per_appreciation || 1;
            const honorMinQualityRank = this._getQualityRank(heatCfg.honor_min_quality || 'rare');
            const honorBonusPerHigherQuality = heatCfg.honor_bonus_per_higher_quality || 2;

            if (qualityRank >= honorMinQualityRank) {
                // 基础声望 + 高品质额外奖励
                const extraLevels = qualityRank - honorMinQualityRank;
                ownerHonorGained = honorPerAppreciation + extraLevels * honorBonusPerHigherQuality;

                // 行级锁主人，发放声望（honor 是 BIGINT）
                const owner = await Player.findByPk(exhibit.player_id, {
                    lock: t.LOCK.UPDATE,
                    transaction: t
                });
                if (owner) {
                    owner.honor = BigInt(owner.honor || 0) + BigInt(ownerHonorGained);
                    await owner.save({ transaction: t });
                }
            }

            await t.commit();

            // ===== commit 后推送 WebSocket 通知 =====
            // 1. 通知展品主人：有人鉴赏其展品
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(exhibit.player_id, 'cave_exhibit_appreciated', {
                    message: `${appreciator.nickname} 鉴赏了你的展品「${exhibit.item_name}」`,
                    exhibit_id: exhibitId,
                    exhibit_name: exhibit.item_name,
                    appreciator_id: appreciatorId,
                    appreciator_nickname: appreciator.nickname,
                    is_enlightened: isEnlightened,
                    honor_gained: ownerHonorGained,
                    new_heat: exhibit.heat_count
                });
            } catch (e) {
                console.warn('[CaveSocialService] 推送展品鉴赏通知失败:', e.message);
            }

            // 2. 顿悟时额外通知鉴赏者（前端展示顿悟特效）
            let enlightenBuffUntil = null;
            if (isEnlightened) {
                const buffHours = appreciateCfg.enlighten_buff_hours || 1;
                enlightenBuffUntil = new Date(Date.now() + buffHours * 3600 * 1000);
                try {
                    const io = require('../../config/socket').getIO();
                    if (io) {
                        io.to(`user_${appreciatorId}`).emit('cave_exhibit_enlightened', {
                            exhibit_name: exhibit.item_name,
                            buff_until: enlightenBuffUntil,
                            meditation_bonus: appreciateCfg.enlighten_buff_meditation_bonus || 0.15,
                            message: `鉴赏「${exhibit.item_name}」触发顿悟！获得 ${buffHours} 小时修炼加成`
                        });
                    }
                } catch (e) {
                    // WebSocket 推送失败不影响主流程
                }
            }

            return {
                success: true,
                message: isEnlightened
                    ? `鉴赏「${exhibit.item_name}」触发顿悟！获得 ${expGained} 修为`
                    : `鉴赏「${exhibit.item_name}」有所感悟，获得 ${expGained} 修为`,
                exhibit: {
                    id: exhibit.id,
                    item_key: exhibit.item_key,
                    item_name: exhibit.item_name,
                    quality: exhibit.quality
                },
                is_enlightened: isEnlightened,
                exp_gained: expGained,
                base_exp: baseExp,
                enlighten_multiplier: isEnlightened ? enlightenMultiplier : 1,
                enlighten_buff_until: enlightenBuffUntil,
                enlighten_buff_meditation_bonus: isEnlightened ? (appreciateCfg.enlighten_buff_meditation_bonus || 0.15) : 0,
                today_appreciated_count: todayCount + 1,
                daily_limit: dailyLimit,
                remaining_appreciations: dailyLimit - todayCount - 1,
                owner_honor_gained: ownerHonorGained,
                new_heat: exhibit.heat_count
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 获取万宝阁热度榜（全服展品热度 Top N）
     *
     * 展示全服最受关注的展品，激发玩家上架与鉴赏动力
     *
     * @param {number} limit - 返回条数上限
     * @returns {Promise<Object>} 热度榜列表
     */
    async getHeatBoard(limit = 20) {
        const tpConfig = this.getTreasurePavilionConfig();
        if (!tpConfig.enabled) {
            throw new AppError('万宝阁展品功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const safeLimit = Math.min(Math.max(1, limit), 100);
        const CaveExhibit = require('../../models/caveExhibit');

        const exhibits = await CaveExhibit.findAll({
            where: { heat_count: { [Op.gt]: 0 } },
            order: [['heat_count', 'DESC'], ['created_at', 'ASC']],
            limit: safeLimit
        });

        if (exhibits.length === 0) {
            return { board: [], total: 0, message: '暂无热度展品' };
        }

        // 批量查询主人昵称
        const ownerIds = [...new Set(exhibits.map(e => e.player_id))];
        const owners = ownerIds.length > 0
            ? await Player.findAll({
                where: { id: { [Op.in]: ownerIds } },
                attributes: ['id', 'nickname', 'realm']
            })
            : [];
        const ownerMap = new Map(owners.map(o => [o.id, o]));

        return {
            board: exhibits.map((e, index) => {
                const owner = ownerMap.get(e.player_id);
                return {
                    rank: index + 1,
                    exhibit_id: e.id,
                    item_key: e.item_key,
                    item_name: e.item_name,
                    quality: e.quality,
                    heat_count: e.heat_count,
                    owner_id: e.player_id,
                    owner_nickname: owner?.nickname || '未知修士',
                    owner_realm: owner?.realm || '',
                    created_at: e.created_at
                };
            }),
            total: exhibits.length
        };
    }

    /**
     * 计算展品对洞天寻宝成功率的影响（供 treasureHunt 方法调用）
     *
     * 联动设计：
     *   - 展品数量越多 → 财富外露 → 被寻宝成功率上升
     *   - 传说级以上展品 → 珍宝自带灵气护体 → 大阵防御加成
     *
     * @param {number} targetPlayerId - 目标洞府主人玩家ID
     * @returns {Promise<{success_rate_bonus: number, formation_defense_bonus: number, exhibit_count: number}>}
     *   success_rate_bonus：寻宝成功率加成（0-max_success_rate_bonus）
     *   formation_defense_bonus：大阵防御加成（降低寻宝成功率）
     */
    async calculateExhibitTreasureHuntBonus(targetPlayerId) {
        const tpConfig = this.getTreasurePavilionConfig();
        if (!tpConfig.enabled) {
            return { success_rate_bonus: 0, formation_defense_bonus: 0, exhibit_count: 0 };
        }

        const linkCfg = tpConfig.treasure_hunt_link || {};
        const CaveExhibit = require('../../models/caveExhibit');
        const exhibits = await CaveExhibit.findAll({
            where: { player_id: targetPlayerId },
            attributes: ['quality']
        });

        if (exhibits.length === 0) {
            return { success_rate_bonus: 0, formation_defense_bonus: 0, exhibit_count: 0 };
        }

        // 财富外露：每件展品增加寻宝成功率
        const bonusPerExhibit = linkCfg.success_rate_bonus_per_exhibit || 0.02;
        const maxBonus = linkCfg.max_success_rate_bonus || 0.15;
        const rawBonus = exhibits.length * bonusPerExhibit;
        const successRateBonus = Math.min(maxBonus, rawBonus);

        // 珍宝护体：传说级以上展品增加大阵防御
        const legendaryRank = this._getQualityRank('legendary');
        const formationBonusPerLegendary = linkCfg.formation_defense_bonus_per_legendary || 0.03;
        const legendaryCount = exhibits.filter(e => this._getQualityRank(e.quality) >= legendaryRank).length;
        const formationDefenseBonus = legendaryCount * formationBonusPerLegendary;

        return {
            success_rate_bonus: successRateBonus,
            formation_defense_bonus: formationDefenseBonus,
            exhibit_count: exhibits.length,
            legendary_count: legendaryCount
        };
    }

    // ==================== 洞天绘卷系统 ====================
    // 设计依据：xiuxian_game_guide.md 第26节 `.洞天绘卷` 查看洞府画卷
    // 系统定位：洞府全景展示 + 风貌评级排行 + 题词互动（社交竞争导向）
    //   与万宝阁差异化：万宝阁=物品展示+鉴赏获修为（个人收益），绘卷=洞府全景+评级排行+题词（社交竞争）

    /**
     * 获取洞天绘卷配置（cave_data.json social.scroll 节点）
     * @returns {Object} 绘卷配置对象
     */
    getScrollConfig() {
        return this.getSocialConfig().scroll || {};
    }

    /**
     * 根据风貌得分获取评级档次
     * @param {number} score - 风貌得分
     * @returns {{name: string, index: number}} 评级名称与档次索引（0=凡品 ... 5=仙品）
     */
    _getRatingTier(score) {
        const scrollCfg = this.getScrollConfig();
        // 评级档次默认值（与 cave_data.json scroll.rating.tiers 一致）
        const tiers = scrollCfg.rating?.tiers || [
            { name: '凡品', min_score: 0 },
            { name: '灵品', min_score: 21 },
            { name: '玄品', min_score: 41 },
            { name: '地品', min_score: 61 },
            { name: '天品', min_score: 81 },
            { name: '仙品', min_score: 101 }
        ];
        let result = { name: tiers[0]?.name || '凡品', index: 0 };
        for (let i = 0; i < tiers.length; i++) {
            // 取得分 >= min_score 的最高档次
            if (score >= (tiers[i].min_score || 0)) {
                result = { name: tiers[i].name, index: i };
            }
        }
        return result;
    }

    /**
     * 计算洞府风貌得分（综合设施/景观/展品/人气）
     *
     * 评分维度（均为配置驱动，可热更新）：
     *   1. 设施分：5项设施等级之和 × facility_weight（0-50 × 2 = 0-100）
     *   2. 景观分：已布置景观 +landscape_score（+5）
     *   3. 展品分：展品数 × exhibit_score_per + 最高品质加分（rare+2/epic+4/legendary+6/mythic+10）
     *   4. 人气分：访客数×权重 + 留言数×权重 + 展品总热度×权重
     *
     * @param {Object} cave - PlayerCave 实例
     * @param {Object} exhibitStats - 展品统计 {count, top_quality, total_heat}
     * @param {Object} popularityStats - 人气统计 {visitor_count, message_count}
     * @returns {number} 风貌得分（向下取整）
     */
    _calculateScrollScore(cave, exhibitStats, popularityStats) {
        const scrollCfg = this.getScrollConfig();
        const ratingCfg = scrollCfg.rating || {};
        let score = 0;

        // 1. 设施分：5项设施等级之和 × facility_weight
        const facilityWeight = ratingCfg.facility_weight ?? 2;
        const facilityTotal = (cave.spirit_vein_level || 0) + (cave.quiet_room_level || 0)
            + (cave.pill_room_level || 0) + (cave.tool_room_level || 0)
            + (cave.grand_formation_level || 0);
        score += facilityTotal * facilityWeight;

        // 2. 景观分：有景观 +landscape_score
        if (cave.landscape_id) {
            score += ratingCfg.landscape_score ?? 5;
        }

        // 3. 展品分：展品数 × exhibit_score_per + 最高品质加分
        const exhibitCount = exhibitStats?.count || 0;
        score += exhibitCount * (ratingCfg.exhibit_score_per ?? 3);
        const qualityBonus = ratingCfg.exhibit_quality_bonus || {};
        const topQuality = exhibitStats?.top_quality;
        if (topQuality && qualityBonus[topQuality]) {
            score += qualityBonus[topQuality];
        }

        // 4. 人气分：访客/留言/展品热度（体现洞府社交活跃度）
        score += (popularityStats?.visitor_count || 0) * (ratingCfg.popularity_visitor_weight ?? 0.5);
        score += (popularityStats?.message_count || 0) * (ratingCfg.popularity_message_weight ?? 0.5);
        score += (exhibitStats?.total_heat || 0) * (ratingCfg.popularity_heat_weight ?? 0.2);

        return Math.floor(score);
    }

    /**
     * 查询洞府的展品统计（数量/最高品质/总热度）
     * @param {number} playerId - 洞府主人ID
     * @returns {Promise<{count: number, top_quality: string|null, total_heat: number}>}
     */
    async _getExhibitStats(playerId) {
        const CaveExhibit = require('../../models/caveExhibit');
        const exhibits = await CaveExhibit.findAll({
            where: { player_id: playerId },
            attributes: ['quality', 'heat_count']
        });
        if (exhibits.length === 0) {
            return { count: 0, top_quality: null, total_heat: 0 };
        }
        let topRank = -1;
        let topQuality = null;
        let totalHeat = 0;
        for (const e of exhibits) {
            const r = this._getQualityRank(e.quality);
            if (r > topRank) {
                topRank = r;
                topQuality = e.quality;
            }
            totalHeat += (e.heat_count || 0);
        }
        return { count: exhibits.length, top_quality: topQuality, total_heat: totalHeat };
    }

    /**
     * 查询洞府的人气统计（访客数/留言数）
     * @param {number} playerId - 洞府主人ID
     * @returns {Promise<{visitor_count: number, message_count: number}>}
     */
    async _getPopularityStats(playerId) {
        const visitorCount = await CaveVisitor.count({ where: { cave_owner_id: playerId } });
        const messageCount = await CaveMessage.count({ where: { cave_owner_id: playerId } });
        return { visitor_count: visitorCount, message_count: messageCount };
    }

    /**
     * 构建完整绘卷数据（含评级+全景+题词列表）
     *
     * 并行查询展品/人气/题词数据，计算风貌评级，组装绘卷结构。
     *
     * @param {Object} player - 玩家实例（含 id/nickname/realm/realm_rank）
     * @param {Object} cave - PlayerCave 实例
     * @param {number|null} viewerId - 查看者ID（null=自己查看；他人查看时补充今日题词状态）
     * @returns {Promise<Object>} 绘卷数据
     */
    async _buildScrollData(player, cave, viewerId = null) {
        const CaveScrollInscription = require('../../models/caveScrollInscription');

        // 并行查询展品统计、人气统计、题词列表（提升查询效率）
        const [exhibitStats, popularityStats, inscriptions] = await Promise.all([
            this._getExhibitStats(player.id),
            this._getPopularityStats(player.id),
            CaveScrollInscription.findAll({
                where: { target_player_id: player.id },
                order: [['created_at', 'DESC']],
                limit: 20
            })
        ]);

        // 计算风貌得分与评级
        const score = this._calculateScrollScore(cave, exhibitStats, popularityStats);
        const tier = this._getRatingTier(score);

        // 查询题词者昵称（批量）
        const inscriberIds = [...new Set(inscriptions.map(i => i.inscriber_id))];
        const inscribers = inscriberIds.length > 0
            ? await Player.findAll({
                where: { id: { [Op.in]: inscriberIds } },
                attributes: ['id', 'nickname']
            })
            : [];
        const inscriberMap = new Map(inscribers.map(p => [p.id, p]));

        // 查询展品精选（前3件热度最高的展品，展示洞府珍宝）
        const CaveExhibit = require('../../models/caveExhibit');
        const topExhibits = await CaveExhibit.findAll({
            where: { player_id: player.id },
            order: [['heat_count', 'DESC'], ['created_at', 'ASC']],
            limit: 3,
            attributes: ['id', 'item_name', 'quality', 'heat_count']
        });

        // 景观信息（从配置查名称与描述）
        let landscape = null;
        if (cave.landscape_id) {
            const landscapes = this.getLandscapesConfig();
            const lsCfg = landscapes.find(l => l.id === cave.landscape_id);
            if (lsCfg) {
                landscape = { id: lsCfg.id, name: lsCfg.name, description: lsCfg.description };
            }
        }

        const scrollCfg = this.getScrollConfig();
        const result = {
            owner: {
                player_id: player.id,
                nickname: player.nickname,
                realm: player.realm,
                realm_rank: player.realm_rank || 0
            },
            cave: {
                is_opened: cave.is_opened,
                opened_at: cave.opened_at,
                facilities: {
                    spirit_vein: cave.spirit_vein_level || 0,
                    quiet_room: cave.quiet_room_level || 0,
                    pill_room: cave.pill_room_level || 0,
                    tool_room: cave.tool_room_level || 0,
                    grand_formation: cave.grand_formation_level || 0
                },
                facility_total_level: (cave.spirit_vein_level || 0) + (cave.quiet_room_level || 0)
                    + (cave.pill_room_level || 0) + (cave.tool_room_level || 0) + (cave.grand_formation_level || 0),
                landscape,
                garden_plots: cave.garden_plots || 3
            },
            exhibits: {
                count: exhibitStats.count,
                top_quality: exhibitStats.top_quality,
                total_heat: exhibitStats.total_heat,
                top_exhibits: topExhibits.map(e => ({
                    item_name: e.item_name,
                    quality: e.quality,
                    heat_count: e.heat_count
                }))
            },
            popularity: popularityStats,
            rating: {
                score,
                tier_name: tier.name,
                tier_index: tier.index
            },
            inscriptions: inscriptions.map(i => ({
                id: i.id,
                inscriber_id: i.inscriber_id,
                inscriber_nickname: inscriberMap.get(i.inscriber_id)?.nickname || '未知修士',
                content: i.content,
                created_at: i.created_at
            })),
            inscription_count: inscriptions.length
        };

        // 他人查看时，补充今日题词状态（前端用于控制题词按钮可否点击）
        if (viewerId !== null && Number(viewerId) !== Number(player.id)) {
            const inscribeCfg = scrollCfg.inscribe || {};
            const dailyLimit = inscribeCfg.daily_limit || 5;
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const [todayInscribed, todayCount] = await Promise.all([
                CaveScrollInscription.findOne({
                    where: { target_player_id: player.id, inscriber_id: viewerId, created_at: { [Op.gte]: todayStart } }
                }),
                CaveScrollInscription.count({
                    where: { inscriber_id: viewerId, created_at: { [Op.gte]: todayStart } }
                })
            ]);
            result.today_inscribed = !!todayInscribed;
            result.inscribe_today_count = todayCount;
            result.inscribe_daily_limit = dailyLimit;
            result.can_inscribe = !todayInscribed && todayCount < dailyLimit;
        }

        return result;
    }

    /**
     * 查看自己的洞天绘卷
     * GET /api/cave-social/scroll/me
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 自己的洞天绘卷数据
     */
    async getMyScroll(playerId) {
        const scrollCfg = this.getScrollConfig();
        if (!scrollCfg.enabled) {
            throw new AppError('洞天绘卷功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        const PlayerCaveModel = require('../../models/playerCave');
        const cave = await PlayerCaveModel.findOne({ where: { player_id: playerId } });
        // 未开辟洞府时返回空绘卷骨架（前端据此提示开辟洞府）
        if (!cave || !cave.is_opened) {
            return {
                owner: { player_id: player.id, nickname: player.nickname, realm: player.realm, realm_rank: player.realm_rank || 0 },
                cave: { is_opened: false, opened_at: null, facilities: {}, facility_total_level: 0, landscape: null, garden_plots: 3 },
                exhibits: { count: 0, top_quality: null, total_heat: 0, top_exhibits: [] },
                popularity: { visitor_count: 0, message_count: 0 },
                rating: { score: 0, tier_name: '凡品', tier_index: 0 },
                inscriptions: [],
                inscription_count: 0,
                message: '尚未开辟洞府，无法生成绘卷'
            };
        }
        return await this._buildScrollData(player, cave, null);
    }

    /**
     * 查看他人洞天绘卷（含今日题词状态）
     * GET /api/cave-social/scroll/player/:playerId
     * @param {number} viewerId - 查看者玩家ID
     * @param {number} targetPlayerId - 目标洞府主人玩家ID
     * @returns {Promise<Object>} 他人洞天绘卷数据
     */
    async viewPlayerScroll(viewerId, targetPlayerId) {
        const scrollCfg = this.getScrollConfig();
        if (!scrollCfg.enabled) {
            throw new AppError('洞天绘卷功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (!Number.isInteger(targetPlayerId) || targetPlayerId < 1) {
            throw new AppError('目标玩家ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const player = await Player.findByPk(targetPlayerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        if (!player) {
            throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        const PlayerCaveModel = require('../../models/playerCave');
        const cave = await PlayerCaveModel.findOne({ where: { player_id: targetPlayerId } });
        if (!cave || !cave.is_opened) {
            return {
                owner: { player_id: player.id, nickname: player.nickname, realm: player.realm, realm_rank: player.realm_rank || 0 },
                cave: { is_opened: false, opened_at: null },
                rating: { score: 0, tier_name: '凡品', tier_index: 0 },
                message: '该道友尚未开辟洞府，无绘卷可赏'
            };
        }
        return await this._buildScrollData(player, cave, viewerId);
    }

    /**
     * 题词（为他人洞天绘卷留下诗意评价，被题词者获声望）
     * POST /api/cave-social/scroll/:playerId/inscribe
     *
     * 校验链：
     *   1. 功能开启  2. 不能给自己题词  3. 内容长度 1-max_content_length
     *   4. 目标洞府已开辟  5. 每日题词次数上限  6. 同一洞府每日仅可题词一次
     *
     * 奖励：被题词者获 honor_per_inscription 声望，受 honor_daily_cap 每日上限约束
     * 清理：洞府题词数超过 keep_recent 时自动删除最旧记录
     *
     * @param {number} inscriberId - 题词者玩家ID
     * @param {number} targetPlayerId - 被题词的洞府主人玩家ID
     * @param {string} content - 题词内容（诗意评价）
     * @returns {Promise<Object>} 题词结果
     */
    async inscribeScroll(inscriberId, targetPlayerId, content) {
        const scrollCfg = this.getScrollConfig();
        if (!scrollCfg.enabled) {
            throw new AppError('洞天绘卷功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const inscribeCfg = scrollCfg.inscribe || {};

        // 参数校验
        if (!Number.isInteger(targetPlayerId) || targetPlayerId < 1) {
            throw new AppError('目标玩家ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 不能给自己题词（社交互动需面向他人）
        if (inscribeCfg.self_inscribe_forbidden !== false && Number(inscriberId) === Number(targetPlayerId)) {
            throw new AppError('不可为自己的绘卷题词', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        // 内容长度校验
        const maxLen = inscribeCfg.max_content_length || 20;
        if (!content || typeof content !== 'string' || content.trim().length < 1 || content.trim().length > maxLen) {
            throw new AppError(`题词内容需为1-${maxLen}字`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        const trimmedContent = content.trim();

        // 目标玩家与洞府校验
        const target = await Player.findByPk(targetPlayerId, { attributes: ['id', 'nickname', 'realm'] });
        if (!target) {
            throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        const PlayerCaveModel = require('../../models/playerCave');
        const cave = await PlayerCaveModel.findOne({ where: { player_id: targetPlayerId } });
        if (!cave || !cave.is_opened) {
            throw new AppError('该道友尚未开辟洞府，无法题词', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const CaveScrollInscription = require('../../models/caveScrollInscription');
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const t = await sequelize.transaction();
        try {
            // 校验每日题词次数上限
            const dailyLimit = inscribeCfg.daily_limit || 5;
            const todayCount = await CaveScrollInscription.count({
                where: { inscriber_id: inscriberId, created_at: { [Op.gte]: todayStart } },
                transaction: t
            });
            if (todayCount >= dailyLimit) {
                throw new AppError(`今日题词次数已达上限（${dailyLimit}次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 校验同一洞府今日未题词（防刷屏）
            const alreadyInscribed = await CaveScrollInscription.findOne({
                where: { target_player_id: targetPlayerId, inscriber_id: inscriberId, created_at: { [Op.gte]: todayStart } },
                transaction: t
            });
            if (alreadyInscribed) {
                throw new AppError('今日已为该道友绘卷题词，明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 写入题词记录
            const inscription = await CaveScrollInscription.create({
                target_player_id: targetPlayerId,
                inscriber_id: inscriberId,
                content: trimmedContent
            }, { transaction: t });

            // 被题词者声望奖励（受 honor_daily_cap 每日上限约束）
            let honorGained = 0;
            const honorPerInscription = inscribeCfg.honor_per_inscription || 2;
            const honorDailyCap = inscribeCfg.honor_daily_cap || 20;
            // 查询今日该洞府主人被题词次数（含本次），计算今日已获声望
            const todayReceivedCount = await CaveScrollInscription.count({
                where: { target_player_id: targetPlayerId, created_at: { [Op.gte]: todayStart } },
                transaction: t
            });
            const todayHonor = todayReceivedCount * honorPerInscription;
            if (todayHonor <= honorDailyCap) {
                honorGained = Math.min(honorPerInscription, honorDailyCap - (todayHonor - honorPerInscription));
                honorGained = Math.max(0, honorGained);
                if (honorGained > 0) {
                    // 行级锁主人，发放声望（honor 是 BIGINT，需 BigInt 运算）
                    const owner = await Player.findByPk(targetPlayerId, { lock: t.LOCK.UPDATE, transaction: t });
                    if (owner) {
                        owner.honor = BigInt(owner.honor || 0) + BigInt(honorGained);
                        await owner.save({ transaction: t });
                    }
                }
            }

            // 清理超量题词：洞府题词数超过 keep_recent 时删除最旧记录
            const keepRecent = inscribeCfg.keep_recent || 20;
            const totalCount = await CaveScrollInscription.count({
                where: { target_player_id: targetPlayerId },
                transaction: t
            });
            if (totalCount > keepRecent) {
                const toDelete = await CaveScrollInscription.findAll({
                    where: { target_player_id: targetPlayerId },
                    order: [['created_at', 'DESC']],
                    offset: keepRecent,
                    limit: totalCount - keepRecent,
                    attributes: ['id'],
                    transaction: t
                });
                if (toDelete.length > 0) {
                    await CaveScrollInscription.destroy({
                        where: { id: { [Op.in]: toDelete.map(r => r.id) } },
                        transaction: t
                    });
                }
            }

            await t.commit();

            // commit 后推送 WebSocket 通知（通知被题词者，失败不影响主流程）
            try {
                const webSocketNotificationService = require('./WebSocketNotificationService');
                if (typeof webSocketNotificationService.notifyPlayerUpdate === 'function') {
                    const inscriber = await Player.findByPk(inscriberId, { attributes: ['nickname'] });
                    webSocketNotificationService.notifyPlayerUpdate(targetPlayerId, 'cave_scroll_inscribed', {
                        inscriber_id: inscriberId,
                        inscriber_nickname: inscriber?.nickname || '未知修士',
                        content: trimmedContent,
                        honor_gained: honorGained
                    });
                }
            } catch (notifyErr) {
                console.warn('[CaveSocialService] 题词通知推送失败:', notifyErr.message);
            }

            return {
                success: true,
                message: '题词成功',
                inscription: {
                    id: inscription.id,
                    content: trimmedContent,
                    created_at: inscription.created_at
                },
                target: { player_id: target.id, nickname: target.nickname, realm: target.realm },
                honor_gained: honorGained,
                today_inscribe_count: todayCount + 1,
                daily_limit: inscribeCfg.daily_limit || 5
            };
        } catch (error) {
            // 事务回滚（确保题词记录与声望发放原子性）
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 绘卷风貌排行榜（全服洞府按风貌得分降序）
     * GET /api/cave-social/scroll/ranking
     *
     * 批量查询所有已开辟洞府的展品/访客/留言统计，计算得分排序，返回 top N。
     *
     * @param {number} limit - 返回条数（默认 20，上限受 ranking.limit 配置约束）
     * @returns {Promise<Object>} 排行榜 {ranking: [...], total}
     */
    async getScrollRanking(limit = 20) {
        const scrollCfg = this.getScrollConfig();
        if (!scrollCfg.enabled) {
            throw new AppError('洞天绘卷功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const safeLimit = Math.min(Math.max(1, limit), scrollCfg.ranking?.limit || 20);

        // 查询所有已开辟洞府（排行榜仅含已开辟洞府）
        const PlayerCaveModel = require('../../models/playerCave');
        const caves = await PlayerCaveModel.findAll({
            where: { is_opened: true },
            attributes: ['player_id', 'spirit_vein_level', 'quiet_room_level', 'pill_room_level', 'tool_room_level', 'grand_formation_level', 'landscape_id', 'garden_plots', 'opened_at']
        });

        if (caves.length === 0) {
            return { ranking: [], total: 0, message: '暂无已开辟洞府' };
        }

        // 批量查询玩家信息
        const playerIds = caves.map(c => c.player_id);
        const players = await Player.findAll({
            where: { id: { [Op.in]: playerIds } },
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        const playerMap = new Map(players.map(p => [p.id, p]));

        // 批量查询展品统计（一次查询所有洞府展品，内存分组统计）
        const CaveExhibit = require('../../models/caveExhibit');
        const exhibitRows = await CaveExhibit.findAll({
            where: { player_id: { [Op.in]: playerIds } },
            attributes: ['player_id', 'quality', 'heat_count']
        });
        const exhibitStatsMap = new Map(); // player_id -> {count, top_quality, top_rank, total_heat}
        for (const row of exhibitRows) {
            let stat = exhibitStatsMap.get(row.player_id);
            if (!stat) {
                stat = { count: 0, top_quality: null, top_rank: -1, total_heat: 0 };
                exhibitStatsMap.set(row.player_id, stat);
            }
            stat.count++;
            const r = this._getQualityRank(row.quality);
            if (r > stat.top_rank) {
                stat.top_rank = r;
                stat.top_quality = row.quality;
            }
            stat.total_heat += (row.heat_count || 0);
        }

        // 批量查询访客数（group by 统计）
        const visitorCounts = await CaveVisitor.count({
            where: { cave_owner_id: { [Op.in]: playerIds } },
            group: ['cave_owner_id']
        });
        const visitorMap = new Map();
        for (const v of visitorCounts) {
            visitorMap.set(v.cave_owner_id, v.count);
        }

        // 批量查询留言数（group by 统计）
        const messageCounts = await CaveMessage.count({
            where: { cave_owner_id: { [Op.in]: playerIds } },
            group: ['cave_owner_id']
        });
        const messageMap = new Map();
        for (const m of messageCounts) {
            messageMap.set(m.cave_owner_id, m.count);
        }

        // 计算每个洞府风貌得分
        const entries = caves.map(cave => {
            const exhibitStats = exhibitStatsMap.get(cave.player_id) || { count: 0, top_quality: null, total_heat: 0 };
            const popularityStats = {
                visitor_count: visitorMap.get(cave.player_id) || 0,
                message_count: messageMap.get(cave.player_id) || 0
            };
            const score = this._calculateScrollScore(cave, exhibitStats, popularityStats);
            const tier = this._getRatingTier(score);
            return { cave, exhibitStats, popularityStats, score, tier };
        });

        // 按得分降序排序
        entries.sort((a, b) => b.score - a.score);

        // 取 top N
        const top = entries.slice(0, safeLimit);

        return {
            ranking: top.map((entry, index) => {
                const player = playerMap.get(entry.cave.player_id);
                return {
                    rank: index + 1,
                    player_id: entry.cave.player_id,
                    nickname: player?.nickname || '未知修士',
                    realm: player?.realm || '',
                    realm_rank: player?.realm_rank || 0,
                    facility_total_level: (entry.cave.spirit_vein_level || 0) + (entry.cave.quiet_room_level || 0)
                        + (entry.cave.pill_room_level || 0) + (entry.cave.tool_room_level || 0) + (entry.cave.grand_formation_level || 0),
                    exhibit_count: entry.exhibitStats.count,
                    visitor_count: entry.popularityStats.visitor_count,
                    message_count: entry.popularityStats.message_count,
                    score: entry.score,
                    tier_name: entry.tier.name,
                    tier_index: entry.tier.index
                };
            }),
            total: entries.length
        };
    }
}

// 导出单例
module.exports = new CaveSocialService();
