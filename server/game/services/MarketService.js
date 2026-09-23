/**
 * 坊市（万宝楼）业务服务模块
 *
 * 处理玩家在坊市的挂单上架、搜索、购买（换物）、下架等核心业务逻辑
 *
 * 设计说明：
 *   - 万宝楼为换物系统：卖家上架物品 A，标价换取物品 B，买家用 B 换走 A
 *   - 所有写操作使用事务（transaction）保证数据一致性
 *   - 事务回滚前检查 t.finished，避免对已提交/回滚的事务重复操作
 *   - 配置项（挂单上限、分页大小等）从 game_balance.market 读取，禁止硬编码
 *   - 物品静态属性从 item_data.json 读取（配置中心化）
 *   - 业务错误统一使用 AppError + ErrorCodes 抛出，由全局 errorHandler 处理
 */
// 修复：config/database.js 直接导出 sequelize 实例（module.exports = sequelize），
// 不能用解构导入 const { sequelize } = require(...)，否则会拿到 undefined
// 旧代码导致 createListing 调用 sequelize.transaction() 时抛出
// "Cannot read properties of undefined (reading 'transaction')" 500 错误
const sequelize = require('../../config/database');
const InventoryService = require('./InventoryService');
const Player = require('../../models/player');
const MarketListing = require('../../models/marketListing');
const Item = require('../../models/item');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
// 退还/转交玩家本来就有的东西：内容下架或资料片关闭时也不能失败（见 InventoryService.addItem 的 allowUnknownItem 说明）
const RETURNED = { allowUnknownItem: true };

/** game_balance.market.max_price_ratio 缺失时的兜底折价倍数 */
const DEFAULT_MAX_PRICE_RATIO = 5;
/** 溢价禁令：单价超过天道估值的倍数即拦截（帖：坊市铁律 10 倍） */
const DEFAULT_MAX_PREMIUM_RATIO = 10;

class MarketService {
    constructor() {
        this.configLoader = null;
    }

    /**
     * 给挂单行补上卖家昵称。
     *
     * 坊市列表原本只带 seller_id，界面只能印成「卖家 #1」—— 玩家在一个
     * 社交向的换物系统里看不到跟谁交易，只能自己记 ID。
     * 名字不进库、只在出参层现算（与 item_name / material_name 同一口径），
     * 卖家改名后列表自然跟着变。
     *
     * @param {Array<Object>} rows - raw 查询出来的挂单行
     * @returns {Promise<Array<Object>>} 每行多出 seller_name（查不到时留空，由界面兜底）
     */
    async _withSellerNames(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return rows || [];
        const ids = [...new Set(rows.map(r => Number(r.seller_id)).filter(id => id > 0))];
        if (ids.length === 0) return rows;
        const players = await Player.findAll({
            where: { id: ids },
            attributes: ['id', 'nickname'],
            raw: true
        });
        const nameById = new Map(players.map(p => [Number(p.id), p.nickname || '']));
        return rows.map(r => ({
        ...r,
        seller_name: nameById.get(Number(r.seller_id)) || '',
        is_bundle: this.isBundleListing(r.quantity, r.want_quantity)
    }));
    }

    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 懒加载获取坊市配置
     * 从 game_balance.market 读取挂单上限、分页大小等可调参数
     * @returns {Object} 坊市配置对象
     */
    getMarketConfig() {
        return this.configLoader?.getConfig('game_balance')?.market || {};
    }

    /**
     * 懒加载获取物品静态配置
     * 从 item_data.json 中按 itemKey 查找物品定义
     * @param {string} itemKey - 物品配置键名
     * @returns {Object|null} 物品配置，未找到返回 null
     */
    getItemConfig(itemKey) {
        const items = this.configLoader?.getConfig('item_data')?.items || [];
        return items.find(i => i.id === itemKey) || null;
    }

    /**
     * 是否捆绑出售：总价无法被上架数量整除 → 单价算不干净，必须整包买
     * 帖：「例如 凝血散*3 换 妖丹*1」→ 捆绑
     */
    isBundleListing(sellQuantity, wantQuantity) {
        const sell = Math.floor(Number(sellQuantity) || 0);
        const want = Math.floor(Number(wantQuantity) || 0);
        if (sell <= 0 || want <= 0) return true;
        return want % sell !== 0;
    }

    /**
     * 挂单价格锚定校验
     *
     * 万宝楼为自由换物，但"1 灵石换神器"式挂单会被用于洗价值与线下交易，
     * 因此以 item_data.json 的 price 为参考价，限制换取总价值不得低于出售总价值的 1 / max_price_ratio。
     * 出售物品未配置参考价时跳过锚定（如任务道具、材料）。
     *
     * @param {Object} sellConfig - 出售物品配置
     * @param {number} sellQuantity - 出售数量
     * @param {Object} wantConfig - 换取物品配置
     * @param {number} wantQuantity - 换取数量
     * @returns {{allowed: boolean, reason?: string}} 校验结果
     */
    checkPriceAnchor(sellConfig, sellQuantity, wantConfig, wantQuantity) {
        const config = this.getMarketConfig();
        const configuredRatio = Number(config.max_price_ratio);
        const maxRatio = (Number.isFinite(configuredRatio) && configuredRatio >= 1)
            ? configuredRatio
            : DEFAULT_MAX_PRICE_RATIO;
        const configuredPremium = Number(config.max_premium_ratio);
        const maxPremium = (Number.isFinite(configuredPremium) && configuredPremium >= 1)
            ? configuredPremium
            : DEFAULT_MAX_PREMIUM_RATIO;

        const sellUnitPrice = Number(sellConfig?.price) || 0;
        if (sellUnitPrice <= 0) return { allowed: true };

        const sellValue = sellUnitPrice * sellQuantity;
        const wantValue = (Number(wantConfig?.price) || 0) * wantQuantity;

        // 折价禁令：换取价值过低（防甩卖洗钱）
        if (wantValue * maxRatio < sellValue) {
            return {
                allowed: false,
                reason: `挂单换取价值过低（出售参考 ${sellValue} 灵石，换取参考 ${wantValue} 灵石），最多允许折价 ${maxRatio} 倍`
            };
        }

        // 溢价禁令：单价超过天道估值 N 倍视为扰乱市场（帖：10 倍熔断）
        if (wantValue > sellValue * maxPremium) {
            return {
                allowed: false,
                reason: `挂单溢价超过天道估值 ${maxPremium} 倍（出售参考 ${sellValue} 灵石，索取 ${wantValue} 灵石），已触发坊市价格熔断`
            };
        }

        return { allowed: true };
    }

    /**
     * 获取坊市挂单列表（分页，支持按物品类型/名称筛选）
     * @param {number} page - 页码（从 1 开始）
     * @param {Object} filter - 筛选条件 { type?: string, keyword?: string }
     * @returns {Promise<Object>} 分页挂单列表 { list, total, page, page_size, total_pages }
     */
    async getListings(page = 1, filter = {}) {
        const config = this.getMarketConfig();
        const pageSize = config.listing_page_size || 20;
        const offset = (page - 1) * pageSize;

        // 构建查询条件：仅查上架中的挂单
        const where = { status: 'active' };

        // 按物品名称模糊筛选
        if (filter.keyword) {
            where.item_name = { [require('sequelize').Op.like]: `%${filter.keyword}%` };
        }

        // 按物品类型筛选：从配置中查出该类型的所有 item_key，再用 IN 查询
        if (filter.type) {
            const items = this.configLoader?.getConfig('item_data')?.items || [];
            const keysOfType = items
                .filter(i => i.type === filter.type)
                .map(i => i.id);
            if (keysOfType.length === 0) {
                // 该类型无任何物品配置，直接返回空
                return { list: [], total: 0, page, page_size: pageSize, total_pages: 0 };
            }
            where.item_key = { [require('sequelize').Op.in]: keysOfType };
        }

        // 查询总数与分页数据
        const { count, rows } = await MarketListing.findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        return {
            list: await this._withSellerNames(rows),
            total: count,
            page,
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize)
        };
    }

    /**
     * 搜索挂单（按物品名称模糊搜索）
     * @param {string} keyword - 搜索关键词
     * @param {number} page - 页码（从 1 开始）
     * @returns {Promise<Object>} 搜索结果分页
     */
    async searchListings(keyword, page = 1) {
        const config = this.getMarketConfig();
        const pageSize = config.search_page_size || 20;
        const offset = (page - 1) * pageSize;

        // 同时搜索出售物品名称和换取物品名称
        const { Op } = require('sequelize');
        const where = {
            status: 'active',
            [Op.or]: [
                { item_name: { [Op.like]: `%${keyword}%` } },
                { want_item_name: { [Op.like]: `%${keyword}%` } }
            ]
        };

        const { count, rows } = await MarketListing.findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        return {
            list: await this._withSellerNames(rows),
            total: count,
            page,
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize)
        };
    }

    /**
     * 获取我的货摊（当前玩家的所有挂单，含已售出/已下架）
     * @param {number} playerId - 玩家 ID
     * @param {number} page - 页码
     * @returns {Promise<Object>} 分页挂单列表
     */
    async getMyListings(playerId, page = 1) {
        const config = this.getMarketConfig();
        const pageSize = config.my_listing_page_size || 20;
        const offset = (page - 1) * pageSize;

        const { count, rows } = await MarketListing.findAndCountAll({
            where: { seller_id: playerId },
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        return {
            list: rows,
            total: count,
            page,
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize)
        };
    }

    /**
     * 上架物品（创建挂单）
     * 校验：物品配置存在、玩家拥有足够数量、未超过挂单上限
     * 流程：扣减卖家物品 → 创建挂单记录（事务）
     * @param {number} playerId - 卖家玩家 ID
     * @param {string} itemKey - 出售物品键名
     * @param {number} quantity - 出售数量
     * @param {string} wantItemKey - 换取物品键名
     * @param {number} wantQuantity - 换取数量
     * @returns {Promise<Object>} 上架结果
     */
    async createListing(playerId, itemKey, quantity, wantItemKey, wantQuantity) {
        // 参数校验
        if (!itemKey || !wantItemKey) {
            throw new AppError('物品键名不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (quantity < 1 || wantQuantity < 1) {
            throw new AppError('数量必须大于 0', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验出售物品配置
        const sellConfig = this.getItemConfig(itemKey);
        if (!sellConfig) {
            throw new AppError(`出售物品配置不存在: ${itemKey}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验换取物品配置
        const wantConfig = this.getItemConfig(wantItemKey);
        if (!wantConfig) {
            throw new AppError(`换取物品配置不存在: ${wantItemKey}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 价格锚定：挂单不得以远低于参考价的比例出售，避免通过 1 灵石换神器洗价值/线下交易
        // 参考价值取 item_data.json 的 price，未配置价格的物品不参与锚定
        const priceAnchor = this.checkPriceAnchor(sellConfig, quantity, wantConfig, wantQuantity);
        if (!priceAnchor.allowed) {
            throw new AppError(priceAnchor.reason, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验玩家存在且未死亡
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (player.is_dead) {
            throw new AppError('已陨落，无法上架物品', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验挂单数量上限
        const config = this.getMarketConfig();
        const maxActive = config.max_active_listings || 20;
        const activeCount = await MarketListing.count({
            where: { seller_id: playerId, status: 'active' }
        });
        if (activeCount >= maxActive) {
            throw new AppError(`货摊已满，最多同时挂单 ${maxActive} 件`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 查询玩家物品数量（加锁防并发）
            const playerItem = await Item.findOne({
                where: { player_id: playerId, item_key: itemKey },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!playerItem || playerItem.quantity < quantity) {
                throw new AppError('物品数量不足，无法上架', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 扣减卖家物品
            playerItem.quantity -= quantity;
            if (playerItem.quantity <= 0) {
                await playerItem.destroy({ transaction: t });
            } else {
                await playerItem.save({ transaction: t });
            }

            // 创建挂单记录
            const listing = await MarketListing.create({
                seller_id: playerId,
                item_key: itemKey,
                item_name: sellConfig.name,
                quantity: quantity,
                want_item_key: wantItemKey,
                want_item_name: wantConfig.name,
                want_quantity: wantQuantity,
                status: 'active'
            }, { transaction: t });

            await t.commit();

            return {
                success: true,
                message: `成功上架 ${sellConfig.name} x${quantity}，换取 ${wantConfig.name} x${wantQuantity}`
                    + (this.isBundleListing(quantity, wantQuantity) ? '（捆绑出售，买家须整包购买）' : ''),
                listing_id: listing.id,
                is_bundle: this.isBundleListing(quantity, wantQuantity)
            };
        } catch (error) {
            // 事务回滚前检查是否已结束，避免重复回滚报错
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 购买挂单（换物交易）
     * 校验：挂单存在且 active、不能买自己的、买家拥有足够的换取物品
     * 捆绑单只能整包买；非捆绑单可按件买（buyQuantity），按整除单价折算换取物
     * 流程：扣买家换取物品 → 加卖家换取物品 → 加买家上架物品 → 扣卖家上架物品 → 更新挂单状态为 sold（事务）
     * @param {number} playerId - 买家玩家 ID
     * @param {number} listingId - 挂单 ID
     * @param {number} [buyQuantity] - 购买数量（缺省=全部；捆绑单强制全部）
     * @returns {Promise<Object>} 购买结果
     */
    async buyListing(playerId, listingId, buyQuantity = null) {
        const t = await sequelize.transaction();
        try {
            // 先无锁看一眼挂单：只有知道卖家是谁，才能按口径把"这一单涉及的两个人"的玩家行一次按主键升序锁齐。
            // 取锁次序：players（双方，id 升序）→ 挂单行 → 背包行。改造前是 挂单 → 买家背包行 → 买家 players
            // →（addItem 里）卖家背包行 → 卖家 players，而卖家自己在用同一枚物品走的是 players → items，
            // 两边各持一行互等就是跨玩家 ABBA —— 与"同一人双击"无关，两个活跃玩家同时交易就会撞。
            const peek = await MarketListing.findOne({ where: { id: listingId }, transaction: t });
            if (!peek) {
                throw new AppError('挂单不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (peek.status !== 'active') {
                throw new AppError('该挂单已交易或已下架', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (Number(peek.seller_id) === Number(playerId)) {
                throw new AppError('不能购买自己的挂单', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const lockedPlayers = await Player.findAll({
                where: { id: [Number(playerId), Number(peek.seller_id)].sort((a, b) => a - b) },
                order: [['id', 'ASC']],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            const buyer = lockedPlayers.find(p => Number(p.id) === Number(playerId));
            if (!buyer) {
                throw new AppError('买家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (buyer.is_dead) {
                throw new AppError('已陨落，无法购买', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 查询挂单（加锁防并发购买）：锁内这份才是成交依据
            const listing = await MarketListing.findOne({
                where: { id: listingId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!listing) {
                throw new AppError('挂单不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (listing.status !== 'active') {
                throw new AppError('该挂单已交易或已下架', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 不能购买自己的挂单
            if (listing.seller_id === playerId) {
                throw new AppError('不能购买自己的挂单', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 捆绑判定与购买数量：捆绑单只能整包；非捆绑按整除单价折算
            const isBundle = this.isBundleListing(listing.quantity, listing.want_quantity);
            const fullQty = Number(listing.quantity);
            let takeQty = fullQty;
            if (buyQuantity !== null && buyQuantity !== undefined) {
                takeQty = Math.floor(Number(buyQuantity));
                if (takeQty < 1) {
                    throw new AppError('购买数量无效', 400, ErrorCodes.VALIDATION_ERROR);
                }
                if (isBundle) {
                    if (takeQty !== fullQty) {
                        throw new AppError('该挂单为捆绑出售，必须一次性全部购买', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                    }
                } else if (takeQty > fullQty) {
                    throw new AppError('购买数量超过挂单库存', 400, ErrorCodes.VALIDATION_ERROR);
                }
            } else if (isBundle) {
                takeQty = fullQty;
            } else {
                // 不带数量默认买全部
                takeQty = fullQty;
            }

            // 单价换取量：非捆绑整除；捆绑只在整包时等于 want_quantity
            const takeWant = isBundle
                ? Number(listing.want_quantity)
                : Math.floor(Number(listing.want_quantity) * takeQty / fullQty);

            // 校验买家是否拥有足够的换取物品
            const buyerWantItem = await Item.findOne({
                where: { player_id: playerId, item_key: listing.want_item_key },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!buyerWantItem || buyerWantItem.quantity < takeWant) {
                throw new AppError(`换取物品不足，需要 ${listing.want_item_name} x${takeWant}`, 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 1. 扣减买家换取物品
            const removeOk = await InventoryService.removeItem(
                playerId,
                listing.want_item_key,
                takeWant,
                t
            );
            if (!removeOk) {
                throw new AppError('扣减换取物品失败', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 2. 给卖家添加换取物品
            await InventoryService.addItem(
                listing.seller_id,
                listing.want_item_key,
                takeWant,
                t,
                null,
                RETURNED
            );

            // 3. 给买家添加上架物品
            await InventoryService.addItem(
                playerId,
                listing.item_key,
                takeQty,
                t,
                null,
                RETURNED
            );

            // 4. 扣减卖家上架物品（上架时已扣减，此处无需再扣）

            // 5. 更新挂单状态：整包成交 sold，部分成交则扣减库存保持 active
            if (takeQty >= fullQty) {
                listing.status = 'sold';
                listing.buyer_id = playerId;
                listing.sold_at = new Date();
                listing.quantity = 0;
                listing.want_quantity = 0;
            } else {
                listing.quantity = fullQty - takeQty;
                listing.want_quantity = Number(listing.want_quantity) - takeWant;
            }
            await listing.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `成功换得 ${listing.item_name} x${takeQty}`,
                listing_id: listing.id,
                bought_quantity: takeQty,
                paid_quantity: takeWant,
                remaining_quantity: listing.status === 'sold' ? 0 : listing.quantity,
                is_bundle: isBundle
            };
        } catch (error) {
            // 事务回滚前检查是否已结束，避免重复回滚报错
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 下架挂单（退还物品给卖家）
     * 校验：是否本人的、是否 active
     * 流程：退还物品给卖家 → 更新挂单状态为 cancelled（事务）
     * @param {number} playerId - 玩家 ID
     * @param {number} listingId - 挂单 ID
     * @returns {Promise<Object>} 下架结果
     */
    async cancelListing(playerId, listingId) {
        const t = await sequelize.transaction();
        try {
            // 查询挂单（加锁防并发）
            const listing = await MarketListing.findOne({
                where: { id: listingId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!listing) {
                throw new AppError('挂单不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 校验是否本人的挂单
            if (listing.seller_id !== playerId) {
                throw new AppError('只能下架自己的挂单', 403, ErrorCodes.UNAUTHORIZED);
            }

            // 校验挂单是否仍在上架中
            if (listing.status !== 'active') {
                throw new AppError('该挂单已交易或已下架', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 退还物品给卖家
            await InventoryService.addItem(
                playerId,
                listing.item_key,
                listing.quantity,
                t,
                null,
                RETURNED
            );

            // 更新挂单状态为已下架
            listing.status = 'cancelled';
            await listing.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `已下架 ${listing.item_name} x${listing.quantity}，物品已退回储物袋`,
                listing_id: listing.id
            };
        } catch (error) {
            // 事务回滚前检查是否已结束，避免重复回滚报错
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }
}

module.exports = new MarketService();
