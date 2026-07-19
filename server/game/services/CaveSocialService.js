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
     * 拜访他人洞府
     * - 校验目标玩家存在且已开辟洞府
     * - 校验不能拜访自己
     * - 校验每日拜访次数（daily_limit）
     * - 写入访客记录，保留最近 N 条
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
        try {
            // 写入访客记录
            await CaveVisitor.create({
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
            today_visited_count: todayVisitedCount + 1,
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
}

// 导出单例
module.exports = new CaveSocialService();
