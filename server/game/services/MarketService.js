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

class MarketService {
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
            list: rows,
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
            list: rows,
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
                message: `成功上架 ${sellConfig.name} x${quantity}，换取 ${wantConfig.name} x${wantQuantity}`,
                listing_id: listing.id
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
     * 流程：扣买家换取物品 → 加卖家换取物品 → 加买家上架物品 → 扣卖家上架物品 → 更新挂单状态为 sold（事务）
     * @param {number} playerId - 买家玩家 ID
     * @param {number} listingId - 挂单 ID
     * @returns {Promise<Object>} 购买结果
     */
    async buyListing(playerId, listingId) {
        const t = await sequelize.transaction();
        try {
            // 查询挂单（加锁防并发购买）
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

            // 校验买家是否拥有足够的换取物品
            const buyerWantItem = await Item.findOne({
                where: { player_id: playerId, item_key: listing.want_item_key },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!buyerWantItem || buyerWantItem.quantity < listing.want_quantity) {
                throw new AppError(`换取物品不足，需要 ${listing.want_item_name} x${listing.want_quantity}`, 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 校验买家存在且未死亡
            const buyer = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!buyer) {
                throw new AppError('买家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (buyer.is_dead) {
                throw new AppError('已陨落，无法购买', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 1. 扣减买家换取物品
            const removeOk = await InventoryService.removeItem(
                playerId,
                listing.want_item_key,
                listing.want_quantity,
                t
            );
            if (!removeOk) {
                throw new AppError('扣减换取物品失败', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 2. 给卖家添加换取物品
            await InventoryService.addItem(
                listing.seller_id,
                listing.want_item_key,
                listing.want_quantity,
                t
            );

            // 3. 给买家添加上架物品
            await InventoryService.addItem(
                playerId,
                listing.item_key,
                listing.quantity,
                t
            );

            // 4. 扣减卖家上架物品（上架时已扣减，此处无需再扣）

            // 5. 更新挂单状态为已售出
            listing.status = 'sold';
            listing.buyer_id = playerId;
            listing.sold_at = new Date();
            await listing.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `成功换得 ${listing.item_name} x${listing.quantity}`,
                listing_id: listing.id
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
                t
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
