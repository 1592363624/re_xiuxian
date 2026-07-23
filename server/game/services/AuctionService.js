/**
 * 拍卖服务模块
 *
 * 处理拍卖系统业务逻辑：创建拍卖、竞价、撤销、查询、自动结算。
 *
 * 设计说明：
 *   - 拍卖配置从 auction_data.json 读取（配置中心化，支持热更新）
 *   - 物品真实转移：创建拍卖时从卖家背包扣除物品，结算时给得标者
 *   - 灵石冻结机制：竞价时扣除竞价者灵石（冻结），被超越时退还
 *   - 防秒杀机制：拍卖结束前1分钟内有人竞价，自动延长1分钟（最多3次）
 *   - 手续费快照：创建拍卖时快照当前手续费率，避免后续配置变更影响在拍拍卖
 *   - 自动结算：调度器每30秒检查到期拍卖，独立事务结算，失败不影响其他拍卖
 *   - 所有写操作使用事务 + 行级锁保证并发安全
 *
 * 多人交互设计：
 *   - 与万宝楼"标价直购"差异化：拍卖是"竞价博弈"，多人竞争 + 倒计时 + 防秒杀
 *   - WebSocket 实时推送：新竞价通知卖家、被超越通知前竞价者、结算通知双方
 *   - 形成完整经济闭环：直购（万宝楼）+ 典当（当铺）+ 竞价（拍卖）+ 股票（股市）
 */
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const Player = require('../../models/player');
const Auction = require('../../models/auction');
const AuctionBid = require('../../models/auctionBid');
const InventoryService = require('./InventoryService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// 单例库存服务实例（与 CaveSocialService 等保持一致的引用方式）
const inventoryService = InventoryService;

class AuctionService {
    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        inventoryService.initialize(configLoader);
        console.log('[AuctionService] 拍卖服务初始化完成');
    }

    /**
     * 获取拍卖配置（auction_data.json 顶层）
     * @returns {Object} 拍卖配置对象
     */
    getAuctionConfig() {
        return this.configLoader?.getConfig('auction_data') || {};
    }

    /**
     * 创建拍卖（玩家上架物品 + 起拍价 + 时长）
     *
     * 校验链：
     *   1. 功能开启  2. 物品存在且可拍卖  3. 数量合法  4. 起拍价在范围内
     *   5. 时长在范围内  6. 玩家境界达标  7. 玩家同时拍卖数未达上限  8. 玩家持有该物品
     *
     * 物品转移：创建拍卖时从卖家背包真实扣除物品（防伪造/复制）
     *
     * @param {number} playerId - 拍卖者玩家ID
     * @param {string} itemKey - 物品配置键名
     * @param {number} quantity - 拍卖数量
     * @param {number} startingPrice - 起拍价（灵石）
     * @param {number} durationHours - 拍卖时长（小时）
     * @returns {Promise<Object>} 拍卖创建结果
     */
    async createAuction(playerId, itemKey, quantity, startingPrice, durationHours) {
        const cfg = this.getAuctionConfig();
        if (!cfg.enabled) {
            throw new AppError('拍卖功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // ===== 参数校验 =====
        if (!itemKey || typeof itemKey !== 'string') {
            throw new AppError('物品ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
            throw new AppError('拍卖数量必须在 1-999 之间', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const priceCfg = cfg.starting_price || {};
        const minPrice = priceCfg.min || 100;
        const maxPrice = priceCfg.max || 1000000000;
        if (!Number.isInteger(startingPrice) || startingPrice < minPrice || startingPrice > maxPrice) {
            throw new AppError(`起拍价必须在 ${minPrice}-${maxPrice} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        const durCfg = cfg.duration_hours || {};
        const minDur = durCfg.min || 1;
        const maxDur = durCfg.max || 72;
        if (!Number.isInteger(durationHours) || durationHours < minDur || durationHours > maxDur) {
            throw new AppError(`拍卖时长必须在 ${minDur}-${maxDur} 小时之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // ===== 物品配置校验 =====
        const itemCfg = inventoryService.getItemConfig(itemKey);
        if (!itemCfg) {
            throw new AppError('物品不存在', 404, ErrorCodes.NOT_FOUND);
        }
        // 任务物品、绑定物品不可拍卖（防止破坏剧情进度）
        const nonTradableTypes = ['quest', 'binding', 'badge'];
        if (nonTradableTypes.includes(itemCfg.type) || nonTradableTypes.includes(itemCfg.subtype)) {
            throw new AppError(`物品【${itemCfg.name}】为不可交易物品，无法拍卖`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // ===== 玩家校验（行级锁） =====
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已死亡玩家无法发起拍卖', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const sellerCfg = cfg.seller || {};
            const minLevelRank = sellerCfg.min_level_rank || 1;
            if ((player.realm_rank || 0) < minLevelRank) {
                throw new AppError('境界不足，无法发起拍卖', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // ===== 同时拍卖数校验 =====
            const maxConcurrent = sellerCfg.max_concurrent_auctions || 5;
            const activeCount = await Auction.count({
                where: { seller_id: playerId, status: 'open' },
                transaction: t
            });
            if (activeCount >= maxConcurrent) {
                throw new AppError(`同时进行的拍卖数量已达上限（${maxConcurrent} 个）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // ===== 物品持有校验 + 扣除 =====
            const hasItem = await inventoryService.hasItem(playerId, itemKey, quantity, t);
            if (!hasItem) {
                throw new AppError(`储物袋中【${itemCfg.name}】数量不足`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 从卖家背包扣除物品（防伪造/复制）
            const removeOk = await inventoryService.removeItem(playerId, itemKey, quantity, t);
            if (!removeOk) {
                throw new AppError('物品扣除失败，请稍后重试', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // ===== 创建拍卖记录 =====
            const now = new Date();
            const endAt = new Date(now.getTime() + durationHours * 3600 * 1000);
            // 手续费率快照（避免后续配置变更影响在拍拍卖）
            const feeRate = cfg.fee_rate || 0.05;

            const auction = await Auction.create({
                seller_id: playerId,
                item_key: itemKey,
                item_name: itemCfg.name,
                item_quality: itemCfg.quality || 'common',
                quantity,
                starting_price: startingPrice,
                current_price: startingPrice, // 初始当前价等于起拍价
                current_bidder_id: null,
                status: 'open',
                start_at: now,
                end_at: endAt,
                fee_rate: feeRate,
                extension_count: 0
            }, { transaction: t });

            await t.commit();

            return {
                success: true,
                message: `拍卖创建成功：${itemCfg.name} x${quantity}，起拍价 ${startingPrice.toLocaleString()} 灵石`,
                auction: {
                    id: auction.id,
                    item_key: auction.item_key,
                    item_name: auction.item_name,
                    item_quality: auction.item_quality,
                    quantity: auction.quantity,
                    starting_price: auction.starting_price.toString(),
                    current_price: auction.current_price.toString(),
                    status: auction.status,
                    end_at: auction.end_at,
                    fee_rate: Number(auction.fee_rate)
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 获取拍卖列表（分页 + 筛选）
     *
     * @param {Object} filters - 筛选条件
     *   - page: 页码（默认1）
     *   - page_size: 每页条数（默认20）
     *   - status: 状态筛选（默认仅返回 open）
     *   - quality: 品质筛选
     *   - keyword: 物品名关键词搜索
     * @returns {Promise<Object>} 拍卖列表 + 总数
     */
    async listAuctions(filters = {}) {
        const cfg = this.getAuctionConfig();
        const listCfg = cfg.list || {};
        const pageSize = Math.min(filters.page_size || listCfg.default_page_size || 20, listCfg.max_page_size || 100);
        const page = Math.max(1, filters.page || 1);
        const offset = (page - 1) * pageSize;

        // 构建查询条件
        const where = {};
        // 默认仅返回进行中的拍卖（玩家最关心的是可竞拍的）
        where.status = filters.status || 'open';
        if (filters.quality) {
            where.item_quality = filters.quality;
        }
        if (filters.keyword) {
            where.item_name = { [Op.like]: `%${filters.keyword}%` };
        }

        const { rows, count } = await Auction.findAndCountAll({
            where,
            order: [['end_at', 'ASC']], // 按结束时间升序（最快到期的在前）
            limit: pageSize,
            offset
        });

        // 批量查询卖家昵称（避免使用 Sequelize 关联，项目约定手动查询）
        const sellerIds = [...new Set(rows.map(a => a.seller_id))];
        const sellerMap = new Map();
        if (sellerIds.length > 0) {
            const sellers = await Player.findAll({
                where: { id: { [Op.in]: sellerIds } },
                attributes: ['id', 'nickname', 'realm']
            });
            for (const s of sellers) {
                sellerMap.set(s.id, s);
            }
        }
        // 附加 seller 信息到拍卖记录上（_formatAuctionSummary 会读取 auction.seller）
        for (const a of rows) {
            a.seller = sellerMap.get(a.seller_id) || null;
        }

        return {
            auctions: rows.map(a => this._formatAuctionSummary(a)),
            total: count,
            page,
            page_size: pageSize
        };
    }

    /**
     * 获取拍卖详情（含竞价历史）
     *
     * @param {number} auctionId - 拍卖ID
     * @param {number} viewerId - 查看者玩家ID（用于判断是否为卖家/当前竞价者）
     * @returns {Promise<Object>} 拍卖详情
     */
    async getAuctionDetail(auctionId, viewerId = null) {
        if (!Number.isInteger(auctionId) || auctionId < 1) {
            throw new AppError('拍卖ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const auction = await Auction.findByPk(auctionId);
        if (!auction) {
            throw new AppError('拍卖不存在', 404, ErrorCodes.NOT_FOUND);
        }
        // 手动查询卖家信息（项目约定不使用 Sequelize 关联）
        auction.seller = await Player.findByPk(auction.seller_id, {
            attributes: ['id', 'nickname', 'realm']
        });

        // 查询最近 20 条竞价历史
        const bids = await AuctionBid.findAll({
            where: { auction_id: auctionId },
            order: [['created_at', 'DESC']],
            limit: 20
        });
        // 批量查询竞价者昵称
        const bidderIds = [...new Set(bids.map(b => b.bidder_id))];
        const bidderMap = new Map();
        if (bidderIds.length > 0) {
            const bidders = await Player.findAll({
                where: { id: { [Op.in]: bidderIds } },
                attributes: ['id', 'nickname']
            });
            for (const b of bidders) {
                bidderMap.set(b.id, b);
            }
        }
        for (const bid of bids) {
            bid.bidder = bidderMap.get(bid.bidder_id) || null;
        }

        // 计算最小加价幅度（前端用于提示）
        const cfg = this.getAuctionConfig();
        const bidCfg = cfg.bid || {};
        const minIncrementRate = bidCfg.min_increment_rate || 0.05;
        const minIncrementAbs = bidCfg.min_increment_absolute || 10;
        const currentPriceNum = Number(auction.current_price);
        const minNextBid = currentPriceNum + Math.max(
            Math.floor(currentPriceNum * minIncrementRate),
            minIncrementAbs
        );

        return {
            ...this._formatAuctionSummary(auction),
            seller: auction.seller ? {
                player_id: auction.seller.id,
                nickname: auction.seller.nickname,
                realm: auction.seller.realm
            } : null,
            is_seller: viewerId !== null && Number(auction.seller_id) === Number(viewerId),
            is_current_bidder: viewerId !== null && auction.current_bidder_id !== null
                && Number(auction.current_bidder_id) === Number(viewerId),
            min_next_bid: minNextBid,
            bid_count: bids.length,
            bids: bids.map(b => ({
                id: b.id,
                bidder_id: b.bidder_id,
                bidder_nickname: b.bidder?.nickname || '未知修士',
                bid_price: b.bid_price.toString(),
                created_at: b.created_at
            }))
        };
    }

    /**
     * 竞价（玩家对拍卖出价）
     *
     * 校验链：
     *   1. 拍卖状态 open  2. 拍卖未到期  3. 竞价者不是卖家  4. 竞价者境界达标
     *   5. 出价 >= 当前价 + 最小加价幅度  6. 竞价者灵石足够
     *
     * 灵石操作：
     *   - 扣除竞价者本次出价灵石（冻结）
     *   - 如果存在前一个最高竞价者，退还其冻结灵石
     *
     * 防秒杀：
     *   - 拍卖结束前 trigger_threshold_seconds 秒内有人竞价，自动延长 extension_seconds 秒
     *   - 最多延长 max_extensions 次
     *
     * @param {number} bidderId - 竞价者玩家ID
     * @param {number} auctionId - 拍卖ID
     * @param {number} bidPrice - 出价
     * @returns {Promise<Object>} 竞价结果
     */
    async placeBid(bidderId, auctionId, bidPrice) {
        const cfg = this.getAuctionConfig();
        if (!cfg.enabled) {
            throw new AppError('拍卖功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (!Number.isInteger(auctionId) || auctionId < 1) {
            throw new AppError('拍卖ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!Number.isInteger(bidPrice) || bidPrice < 1) {
            throw new AppError('出价必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // ===== 行级锁拍卖记录 =====
            const auction = await Auction.findByPk(auctionId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!auction) {
                throw new AppError('拍卖不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (auction.status !== 'open') {
                throw new AppError('拍卖已结束，无法竞价', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (new Date(auction.end_at) <= new Date()) {
                throw new AppError('拍卖已到期，无法竞价', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // ===== 竞价者校验 =====
            if (Number(auction.seller_id) === Number(bidderId)) {
                throw new AppError('不能竞拍自己的拍卖', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 当前最高竞价者重复竞价允许（加价），但需要满足加价幅度

            const bidder = await Player.findByPk(bidderId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!bidder) {
                throw new AppError('竞价者不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (bidder.is_dead) {
                throw new AppError('已死亡玩家无法参与竞价', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const bidderCfg = cfg.bidder || {};
            const minLevelRank = bidderCfg.min_level_rank || 1;
            if ((bidder.realm_rank || 0) < minLevelRank) {
                throw new AppError('境界不足，无法参与竞价', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // ===== 出价校验 =====
            const currentPriceNum = Number(auction.current_price);
            const bidCfg = cfg.bid || {};
            const minIncrementRate = bidCfg.min_increment_rate || 0.05;
            const minIncrementAbs = bidCfg.min_increment_absolute || 10;
            const minIncrement = Math.max(
                Math.floor(currentPriceNum * minIncrementRate),
                minIncrementAbs
            );
            const minNextBid = currentPriceNum + minIncrement;
            if (bidPrice < minNextBid) {
                throw new AppError(
                    `出价需至少 ${minNextBid.toLocaleString()} 灵石（当前价 ${currentPriceNum.toLocaleString()} + 最小加价 ${minIncrement.toLocaleString()}）`,
                    400, ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // ===== 灵石校验 + 扣除（冻结） =====
            const bidderBalance = BigInt(bidder.spirit_stone || 0);
            const bidAmount = BigInt(bidPrice);
            if (bidderBalance < bidAmount) {
                throw new AppError(
                    `灵石不足（当前 ${bidderBalance.toString()}，需要 ${bidPrice.toLocaleString()}）`,
                    400, ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            // 扣除竞价者灵石（冻结）
            bidder.spirit_stone = bidderBalance - bidAmount;
            await bidder.save({ transaction: t });

            // ===== 退还前一个最高竞价者的冻结灵石 =====
            let previousBidder = null;
            if (auction.current_bidder_id !== null) {
                previousBidder = await Player.findByPk(auction.current_bidder_id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (previousBidder) {
                    // 退还前一个竞价者的冻结灵石
                    previousBidder.spirit_stone = BigInt(previousBidder.spirit_stone || 0)
                        + BigInt(auction.current_price);
                    await previousBidder.save({ transaction: t });
                }
            }

            // ===== 更新拍卖记录 =====
            auction.current_price = bidPrice;
            auction.current_bidder_id = bidderId;

            // ===== 防秒杀延长 =====
            const antiSnipeCfg = cfg.anti_snipe || {};
            if (antiSnipeCfg.enabled) {
                const thresholdMs = (antiSnipeCfg.trigger_threshold_seconds || 60) * 1000;
                const extensionMs = (antiSnipeCfg.extension_seconds || 60) * 1000;
                const maxExtensions = antiSnipeCfg.max_extensions || 3;
                const now = Date.now();
                const endAtMs = new Date(auction.end_at).getTime();
                // 拍卖将在 thresholdMs 内结束，且未达延长上限，自动延长
                if (endAtMs - now < thresholdMs && auction.extension_count < maxExtensions) {
                    const newEndAt = new Date(endAtMs + extensionMs);
                    auction.end_at = newEndAt;
                    auction.extension_count += 1;
                }
            }

            // ===== 写入竞价历史 =====
            const bidRecord = await AuctionBid.create({
                auction_id: auctionId,
                bidder_id: bidderId,
                bid_price: bidPrice
            }, { transaction: t });

            await auction.save({ transaction: t });
            await t.commit();

            // ===== WebSocket 推送（commit 后推送，失败不影响主流程） =====
            try {
                const webSocketService = require('./WebSocketNotificationService');
                const events = cfg.websocket?.events || {};
                // 1. 通知卖家有新竞价
                if (typeof webSocketService.notifyPlayerUpdate === 'function') {
                    webSocketService.notifyPlayerUpdate(auction.seller_id, events.auction_new_bid, {
                        auction_id: auctionId,
                        item_name: auction.item_name,
                        bidder_id: bidderId,
                        bidder_nickname: bidder.nickname,
                        bid_price: bidPrice,
                        current_price: bidPrice,
                        end_at: auction.end_at
                    });
                }
                // 2. 通知前一个竞价者被超越
                if (previousBidder && typeof webSocketService.notifyPlayerUpdate === 'function') {
                    webSocketService.notifyPlayerUpdate(previousBidder.id, events.auction_outbid, {
                        auction_id: auctionId,
                        item_name: auction.item_name,
                        outbid_by: bidder.nickname,
                        new_price: bidPrice,
                        refunded: auction.current_price === bidPrice ? 0 : Number(auction.current_price)
                    });
                }
            } catch (notifyErr) {
                console.warn('[AuctionService] 竞价通知推送失败:', notifyErr.message);
            }

            return {
                success: true,
                message: `竞价成功：${auction.item_name} x${auction.quantity}，出价 ${bidPrice.toLocaleString()} 灵石`,
                bid: {
                    id: bidRecord.id,
                    auction_id: auctionId,
                    bid_price: bidPrice.toString(),
                    created_at: bidRecord.created_at
                },
                auction: {
                    id: auction.id,
                    current_price: auction.current_price.toString(),
                    current_bidder_id: auction.current_bidder_id,
                    end_at: auction.end_at,
                    extension_count: auction.extension_count
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 撤销拍卖（仅卖家可撤销）
     *
     * 撤销规则：
     *   - 无人竞价：免费撤销，物品退回卖家
     *   - 有人竞价：扣卖家 cancel_fee_when_bidded 比例的灵石作为补偿给最高竞价者，物品退回卖家
     *
     * @param {number} playerId - 调用者玩家ID
     * @param {number} auctionId - 拍卖ID
     * @param {string} reason - 撤销原因（可选）
     * @returns {Promise<Object>} 撤销结果
     */
    async cancelAuction(playerId, auctionId, reason = '') {
        const cfg = this.getAuctionConfig();
        if (!Number.isInteger(auctionId) || auctionId < 1) {
            throw new AppError('拍卖ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const auction = await Auction.findByPk(auctionId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!auction) {
                throw new AppError('拍卖不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (Number(auction.seller_id) !== Number(playerId)) {
                throw new AppError('无权撤销他人的拍卖', 403, ErrorCodes.FORBIDDEN);
            }
            if (auction.status !== 'open') {
                throw new AppError('拍卖已结束，无法撤销', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 退还物品给卖家（无论是否有人竞价）
            const addOk = await inventoryService.addItem(
                playerId, auction.item_key, auction.quantity, t
            );
            if (!addOk.success) {
                throw new AppError('物品退还失败（储物袋可能已满）', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 处理已竞价情况：退还冻结灵石给最高竞价者 + 扣卖家补偿费
            let compensFee = 0;
            if (auction.current_bidder_id !== null) {
                const bidder = await Player.findByPk(auction.current_bidder_id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (bidder) {
                    // 退还冻结灵石
                    bidder.spirit_stone = BigInt(bidder.spirit_stone || 0)
                        + BigInt(auction.current_price);
                    await bidder.save({ transaction: t });
                }
                // 扣卖家补偿费（补偿给竞价者）
                const seller = await Player.findByPk(playerId, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (seller) {
                    const sellerCfg = cfg.seller || {};
                    const cancelFeeRate = sellerCfg.cancel_fee_when_bidded || 0.02;
                    compensFee = Math.floor(Number(auction.current_price) * cancelFeeRate);
                    if (compensFee > 0) {
                        const sellerBalance = BigInt(seller.spirit_stone || 0);
                        const feeAmount = BigInt(compensFee);
                        if (sellerBalance < feeAmount) {
                            // 灵石不足时扣到 0（不阻塞撤销流程）
                            seller.spirit_stone = 0n;
                        } else {
                            seller.spirit_stone = sellerBalance - feeAmount;
                        }
                        await seller.save({ transaction: t });
                        // 补偿费加给竞价者
                        if (bidder) {
                            bidder.spirit_stone = BigInt(bidder.spirit_stone || 0) + feeAmount;
                            await bidder.save({ transaction: t });
                        }
                    }
                }
            }

            // 更新拍卖状态
            auction.status = 'cancelled';
            auction.cancel_reason = (reason || '').slice(0, 120) || '卖家主动撤销';
            auction.settled_at = new Date();
            await auction.save({ transaction: t });

            await t.commit();

            // WebSocket 通知被超越的竞价者
            if (auction.current_bidder_id !== null) {
                try {
                    const webSocketService = require('./WebSocketNotificationService');
                    const events = cfg.websocket?.events || {};
                    if (typeof webSocketService.notifyPlayerUpdate === 'function') {
                        webSocketService.notifyPlayerUpdate(auction.current_bidder_id, events.auction_cancelled, {
                            auction_id: auctionId,
                            item_name: auction.item_name,
                            reason: auction.cancel_reason,
                            refunded: Number(auction.current_price),
                            compensation: compensFee
                        });
                    }
                } catch (notifyErr) {
                    console.warn('[AuctionService] 撤销通知推送失败:', notifyErr.message);
                }
            }

            return {
                success: true,
                message: '拍卖已撤销，物品已退回储物袋',
                auction_id: auctionId,
                compensation_fee: compensFee
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 查询我的拍卖（卖家视角）
     *
     * @param {number} playerId - 玩家ID
     * @param {string} status - 状态筛选（默认全部）
     * @returns {Promise<Object>} 我的拍卖列表
     */
    async getMyAuctions(playerId, status = null) {
        const where = { seller_id: playerId };
        if (status) {
            where.status = status;
        }
        const auctions = await Auction.findAll({
            where,
            order: [['created_at', 'DESC']],
            limit: 100
        });
        return {
            auctions: auctions.map(a => this._formatAuctionSummary(a)),
            total: auctions.length
        };
    }

    /**
     * 查询我的竞价（竞价者视角）
     *
     * 返回我参与过竞价的拍卖列表（每拍卖取最新一条竞价），含当前状态。
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 我的竞价列表
     */
    async getMyBids(playerId) {
        // 查询我参与过的所有 auction_id（去重）
        const myBidAuctionIds = await AuctionBid.findAll({
            where: { bidder_id: playerId },
            attributes: ['auction_id'],
            group: ['auction_id'],
            raw: true
        });
        const auctionIds = myBidAuctionIds.map(r => r.auction_id);
        if (auctionIds.length === 0) {
            return { bids: [], total: 0 };
        }

        // 查询这些拍卖的详情
        const auctions = await Auction.findAll({
            where: { id: { [Op.in]: auctionIds } },
            order: [['end_at', 'DESC']]
        });

        // 为每个拍卖标记我是否为当前最高竞价者 + 是否得标
        const result = auctions.map(a => {
            const summary = this._formatAuctionSummary(a);
            const isCurrentBidder = a.current_bidder_id !== null
                && Number(a.current_bidder_id) === Number(playerId);
            const isWinner = a.winner_id !== null
                && Number(a.winner_id) === Number(playerId);
            return {
                ...summary,
                is_current_bidder: isCurrentBidder,
                is_winner: isWinner,
                // 拍卖进行中且我是当前最高竞价者 → 当前领先
                leading: a.status === 'open' && isCurrentBidder,
                // 拍卖已结算且我得标 → 赢得拍卖
                won: a.status === 'closed' && isWinner,
                // 拍卖已结算但我未得标 → 已出局
                lost: a.status === 'closed' && !isWinner
            };
        });

        return {
            bids: result,
            total: result.length
        };
    }

    /**
     * 结算到期拍卖（调度器调用）
     *
     * 流程：
     *   1. 查询所有 status=open 且 end_at <= now 的拍卖（批量）
     *   2. 对每个拍卖独立事务结算（失败不影响其他拍卖）
     *   3. 有人竞价：物品给最高竞价者，灵石给卖家（扣手续费）
     *   4. 无人竞价：物品退回卖家
     *   5. WebSocket 通知双方
     *
     * @returns {Promise<Object>} 结算结果（成功数、失败数、明细）
     */
    async settleExpiredAuctions() {
        const cfg = this.getAuctionConfig();
        if (!cfg.enabled) {
            return { settled: 0, failed: 0, details: [] };
        }

        const schedulerCfg = cfg.scheduler || {};
        const batchSize = schedulerCfg.batch_size || 50;
        const now = new Date();

        // 查询到期的拍卖
        const expiredAuctions = await Auction.findAll({
            where: {
                status: 'open',
                end_at: { [Op.lte]: now }
            },
            limit: batchSize,
            order: [['end_at', 'ASC']]
        });

        let settled = 0;
        let failed = 0;
        const details = [];

        for (const auction of expiredAuctions) {
            try {
                const result = await this._settleOneAuction(auction.id);
                settled++;
                details.push({ auction_id: auction.id, status: 'ok', result });
            } catch (err) {
                failed++;
                details.push({ auction_id: auction.id, status: 'error', message: err.message });
                console.error(`[AuctionService] 拍卖 ${auction.id} 结算失败:`, err.message);
            }
        }

        if (settled > 0 || failed > 0) {
            console.log(`[AuctionService] 拍卖结算完成：成功 ${settled} 个，失败 ${failed} 个`);
        }

        return { settled, failed, details };
    }

    /**
     * 结算单个拍卖（内部方法，独立事务）
     *
     * @param {number} auctionId - 拍卖ID
     * @returns {Promise<Object>} 结算结果
     * @private
     */
    async _settleOneAuction(auctionId) {
        const cfg = this.getAuctionConfig();
        const t = await sequelize.transaction();
        try {
            const auction = await Auction.findByPk(auctionId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!auction) {
                throw new Error(`拍卖 ${auctionId} 不存在`);
            }
            if (auction.status !== 'open') {
                // 已被其他流程处理（如手动撤销），跳过
                await t.rollback();
                return { auction_id: auctionId, skipped: true, reason: '已处理' };
            }

            const finalPrice = Number(auction.current_price);

            if (auction.current_bidder_id !== null) {
                // ===== 有人竞价：成交 =====
                // 1. 物品给得标者（已从卖家扣除，无需再扣）
                const addOk = await inventoryService.addItem(
                    auction.current_bidder_id,
                    auction.item_key,
                    auction.quantity,
                    t
                );
                if (!addOk.success) {
                    throw new Error('得标者储物袋已满，物品发放失败');
                }

                // 2. 灵石给卖家（扣手续费）
                const feeRate = Number(auction.fee_rate) || 0;
                const fee = Math.floor(finalPrice * feeRate);
                const sellerProceeds = finalPrice - fee;
                const seller = await Player.findByPk(auction.seller_id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (seller) {
                    seller.spirit_stone = BigInt(seller.spirit_stone || 0) + BigInt(sellerProceeds);
                    await seller.save({ transaction: t });
                }

                // 3. 更新拍卖状态
                auction.status = 'closed';
                auction.winner_id = auction.current_bidder_id;
                auction.final_price = auction.current_price;
                auction.settled_at = new Date();
                await auction.save({ transaction: t });

                await t.commit();

                // WebSocket 通知双方
                try {
                    const webSocketService = require('./WebSocketNotificationService');
                    const events = cfg.websocket?.events || {};
                    if (typeof webSocketService.notifyPlayerUpdate === 'function') {
                        // 通知得标者
                        webSocketService.notifyPlayerUpdate(auction.current_bidder_id, events.auction_won, {
                            auction_id: auctionId,
                            item_name: auction.item_name,
                            quantity: auction.quantity,
                            final_price: finalPrice
                        });
                        // 通知卖家
                        webSocketService.notifyPlayerUpdate(auction.seller_id, events.auction_settled, {
                            auction_id: auctionId,
                            item_name: auction.item_name,
                            final_price: finalPrice,
                            fee,
                            proceeds: sellerProceeds
                        });
                    }
                } catch (notifyErr) {
                    console.warn('[AuctionService] 结算通知推送失败:', notifyErr.message);
                }

                return {
                    auction_id: auctionId,
                    outcome: 'sold',
                    winner_id: auction.current_bidder_id,
                    final_price: finalPrice,
                    fee,
                    seller_proceeds: sellerProceeds
                };
            } else {
                // ===== 无人竞价：流拍，物品退回卖家 =====
                const addOk = await inventoryService.addItem(
                    auction.seller_id,
                    auction.item_key,
                    auction.quantity,
                    t
                );
                if (!addOk.success) {
                    throw new Error('卖家储物袋已满，物品退还失败');
                }

                auction.status = 'closed';
                auction.winner_id = null;
                auction.final_price = null;
                auction.settled_at = new Date();
                await auction.save({ transaction: t });

                await t.commit();

                // WebSocket 通知卖家流拍
                try {
                    const webSocketService = require('./WebSocketNotificationService');
                    const events = cfg.websocket?.events || {};
                    if (typeof webSocketService.notifyPlayerUpdate === 'function') {
                        webSocketService.notifyPlayerUpdate(auction.seller_id, events.auction_settled, {
                            auction_id: auctionId,
                            item_name: auction.item_name,
                            outcome: 'unsold',
                            message: '拍卖到期无人竞价，物品已退回储物袋'
                        });
                    }
                } catch (notifyErr) {
                    console.warn('[AuctionService] 流拍通知推送失败:', notifyErr.message);
                }

                return {
                    auction_id: auctionId,
                    outcome: 'unsold',
                    message: '无人竞价，物品退回卖家'
                };
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 格式化拍卖摘要（列表/详情通用）
     * @param {Object} auction - 拍卖记录
     * @returns {Object} 格式化后的拍卖摘要
     * @private
     */
    _formatAuctionSummary(auction) {
        const now = new Date();
        const endAt = new Date(auction.end_at);
        const remainMs = endAt.getTime() - now.getTime();
        return {
            id: auction.id,
            seller_id: auction.seller_id,
            seller_nickname: auction.seller?.nickname || null,
            item_key: auction.item_key,
            item_name: auction.item_name,
            item_quality: auction.item_quality,
            quantity: auction.quantity,
            starting_price: auction.starting_price.toString(),
            current_price: auction.current_price.toString(),
            current_bidder_id: auction.current_bidder_id,
            status: auction.status,
            start_at: auction.start_at,
            end_at: auction.end_at,
            winner_id: auction.winner_id,
            final_price: auction.final_price !== null ? auction.final_price.toString() : null,
            fee_rate: Number(auction.fee_rate),
            extension_count: auction.extension_count,
            // 剩余时间（毫秒，负值表示已过期）
            remaining_ms: remainMs,
            // 是否即将结束（剩余时间 < 60秒）
            ending_soon: remainMs > 0 && remainMs < 60000,
            created_at: auction.created_at,
            settled_at: auction.settled_at
        };
    }
}

// 导出单例（与项目其他 Service 保持一致）
module.exports = new AuctionService();
