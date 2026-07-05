/**
 * 当铺（聚宝当铺）业务服务模块
 *
 * 处理玩家在当铺的典当、赎回、估值、逾期清理等核心业务逻辑
 *
 * 设计说明：
 *   - 估值模型：base_price × quality_ratio × (1 + credit_bonus)
 *       base_price 来自 item_data.json 的 price 字段
 *       quality_ratio 来自配置 valuation_ratios[quality]
 *       credit_bonus = pawnshop_credit × credit_discount_bonus_per_point（最高 +10%）
 *       估值上限 max_valuation_per_item
 *   - 赎回价：pawn_amount × (1 + daily_rate × days)，days 从典当到赎回的天数向上取整
 *   - 所有写操作使用事务（transaction）+ 行级锁（LOCK.UPDATE）保证并发安全
 *   - 配置项（每日次数、活跃上限、利率等）从 game_balance.pawnshop 读取，禁止硬编码
 *   - 物品静态属性从 item_data.json 读取（配置中心化）
 *   - 业务错误统一使用 AppError + ErrorCodes 抛出，由全局 errorHandler 处理
 *   - 通过 WebSocketNotificationService 推送 pawnshop:pawn / pawnshop:redeem 等事件
 */
'use strict';

const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const Player = require('../../models/player');
const PawnshopListing = require('../../models/pawnshopListing');
const PawnshopHistory = require('../../models/pawnshopHistory');
const InventoryService = require('./InventoryService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { infrastructure } = require('../../modules');

// 通过 ConfigLoader 获取 game_balance.pawnshop 配置（支持热更新，避免硬编码阈值）
const configLoader = infrastructure.ConfigLoader;

class PawnshopService {
    /**
     * 读取当铺配置
     * @returns {Object} 当铺配置对象（含估值比例、利率、上限等）
     */
    static getPawnshopConfig() {
        const config = configLoader.getConfig('game_balance');
        return config?.pawnshop || {};
    }

    /**
     * 获取物品静态配置（从 item_data.json 读取）
     * @param {string} itemKey - 物品配置键名
     * @returns {Object|null} 物品配置
     */
    static _getItemConfig(itemKey) {
        const items = configLoader?.getConfig('item_data')?.items || [];
        return items.find(i => i.id === itemKey) || null;
    }

    /**
     * 估值计算：base_price × quality_ratio × (1 + credit_bonus)
     * - base_price 来自 item_data.json 的 price 字段
     * - quality_ratio 来自配置 valuation_ratios[quality]
     * - credit_bonus = pawnshop_credit × credit_discount_bonus_per_point（最高 +10%）
     * - 估值上限 max_valuation_per_item
     * @param {Object} itemConfig - 物品静态配置
     * @param {number} playerCredit - 玩家当铺信用额度
     * @returns {Object} { base_price, quality_ratio, credit_bonus, valuation }
     */
    static _calculateValuation(itemConfig, playerCredit) {
        const cfg = this.getPawnshopConfig();
        const basePrice = Number(itemConfig?.price || 0);
        const quality = itemConfig?.quality || 'common';
        const valuationRatios = cfg.valuation_ratios || {};
        const qualityRatio = valuationRatios[quality] ?? valuationRatios['common'] ?? 0.6;

        // 信用加成：每点信用增加 credit_discount_bonus_per_point 的估值比例，最高 10%
        const creditBonusPerPoint = cfg.credit_discount_bonus_per_point || 0.001;
        const creditMax = cfg.credit_max || 100;
        const effectiveCredit = Math.min(playerCredit || 0, creditMax);
        // 信用加成上限 10%
        const creditBonus = Math.min(0.10, effectiveCredit * creditBonusPerPoint);

        // 单件估值
        const maxValuationPerItem = cfg.max_valuation_per_item || 100000;
        let valuation = Math.floor(basePrice * qualityRatio * (1 + creditBonus));
        // 单件估值上限
        if (valuation > maxValuationPerItem) valuation = maxValuationPerItem;

        return {
            base_price: basePrice,
            quality_ratio: qualityRatio,
            credit_bonus: creditBonus,
            valuation
        };
    }

    /**
     * 赎回价计算：pawn_amount × (1 + daily_rate × days)
     * - daily_rate = redeem_daily_interest_rate
     * - days = 从典当到赎回的天数（向上取整）
     * @param {number} pawnAmount - 典当时获得的灵石数（估值 × 数量）
     * @param {number} daysElapsed - 距典当日过去的天数（向上取整）
     * @returns {number} 赎回价（含利息）
     */
    static _calculateRedeemAmount(pawnAmount, daysElapsed) {
        const cfg = this.getPawnshopConfig();
        const dailyRate = cfg.redeem_daily_interest_rate || 0.02;
        const days = Math.max(1, Math.ceil(daysElapsed || 1));
        // 赎回价 = 典当额 × (1 + 日利率 × 天数)
        return Math.floor(Number(pawnAmount) * (1 + dailyRate * days));
    }

    /**
     * 校验物品是否可典当（不在 non_pawnable_categories 内）
     * non_pawnable_categories 包括：quest_item / badge / bound / artifact_with_spirit /
     * sect_contribution / cultivation_xp / stock 等不可典当分类
     * @param {Object} itemConfig - 物品静态配置
     * @returns {boolean} 是否可典当
     */
    static _isPawnable(itemConfig) {
        if (!itemConfig) return false;
        const cfg = this.getPawnshopConfig();
        const nonPawnable = cfg.non_pawnable_categories || [];
        // 物品 subtype 作为分类标识（与 item_data.json 的 subtype 字段对应）
        const subtype = itemConfig.subtype || '';
        const type = itemConfig.type || '';
        // type 或 subtype 命中黑名单均视为不可典当
        if (nonPawnable.includes(subtype) || nonPawnable.includes(type)) {
            return false;
        }
        // 物品必须有 price 字段且大于 0
        if (!itemConfig.price || Number(itemConfig.price) <= 0) {
            return false;
        }
        return true;
    }

    /**
     * 计算当票当前赎回价（基于已过去的天数）
     * @param {Object} listing - 当票记录
     * @returns {number} 当前赎回价
     */
    static _calcCurrentRedeemAmount(listing) {
        const pawnedAt = new Date(listing.pawned_at);
        const now = new Date();
        const daysElapsed = (now - pawnedAt) / (1000 * 60 * 60 * 24);
        return this._calculateRedeemAmount(listing.pawn_amount, daysElapsed);
    }

    /**
     * 获取当铺状态（前端展示用）
     * 返回：{ active_listings, history, credit, daily_pawn_count, config }
     * @param {number} playerId - 玩家 ID
     * @returns {Promise<Object>} 状态对象
     */
    static async getStatus(playerId) {
        // 校验玩家存在
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const cfg = this.getPawnshopConfig();
        const today = new Date().toISOString().slice(0, 10);

        // 统计今日典当次数（基于 pawnshop_histories 当日 action_type='pawn' 记录数）
        const dailyPawnCount = await PawnshopHistory.count({
            where: {
                player_id: playerId,
                action_type: 'pawn',
                created_at: { [Op.gte]: new Date(`${today}T00:00:00`) }
            }
        });

        // 查询活跃当票数
        const activeCount = await PawnshopListing.count({
            where: { player_id: playerId, status: 'active' }
        });

        // 拉取最近 5 条活跃当票
        const activeListings = await PawnshopListing.findAll({
            where: { player_id: playerId, status: 'active' },
            order: [['pawned_at', 'DESC']],
            limit: 5,
            raw: true
        });

        // 拉取最近 5 条历史记录
        const histories = await PawnshopHistory.findAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: 5,
            raw: true
        });

        // 公开配置（前端展示用）
        const publicConfig = {
            enabled: cfg.enabled !== false,
            max_pawn_quantity_per_transaction: cfg.max_pawn_quantity_per_transaction || 99,
            daily_pawn_limit: cfg.daily_pawn_limit || 20,
            max_active_listings: cfg.max_active_listings || 50,
            redeem_period_days: cfg.redeem_period_days || 7,
            redeem_daily_interest_rate: cfg.redeem_daily_interest_rate || 0.02,
            overdue_grace_hours: cfg.overdue_grace_hours || 24,
            pawn_fee_rate: cfg.pawn_fee_rate || 0.05,
            credit_max: cfg.credit_max || 100,
            credit_discount_bonus_per_point: cfg.credit_discount_bonus_per_point || 0.001
        };

        return {
            credit: player.pawnshop_credit || 0,
            spirit_stones: player.spirit_stones !== undefined ? player.spirit_stones.toString() : '0',
            daily_pawn_count: dailyPawnCount,
            daily_pawn_limit: publicConfig.daily_pawn_limit,
            active_listings_count: activeCount,
            max_active_listings: publicConfig.max_active_listings,
            active_listings: activeListings,
            history: histories,
            config: publicConfig
        };
    }

    /**
     * 估值接口（不实际典当，仅返回估值）
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品 key
     * @param {number} quantity - 典当数量
     * @returns {Promise<Object>} 估值结果
     */
    static async appraise(playerId, itemKey, quantity) {
        // 参数校验
        if (!itemKey) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const cfg = this.getPawnshopConfig();
        const maxQty = cfg.max_pawn_quantity_per_transaction || 99;
        const qty = parseInt(quantity);
        if (isNaN(qty) || qty < 1 || qty > maxQty) {
            throw new AppError(`典当数量必须为 1-${maxQty} 之间的整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验玩家存在
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (player.is_dead) {
            throw new AppError('已陨落，无法典当', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验物品配置
        const itemConfig = this._getItemConfig(itemKey);
        if (!itemConfig) {
            throw new AppError(`物品配置不存在: ${itemKey}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验可典当
        if (!this._isPawnable(itemConfig)) {
            throw new AppError(`【${itemConfig.name}】为不可典当物品`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 计算估值
        const valuationResult = this._calculateValuation(itemConfig, player.pawnshop_credit || 0);
        const totalValuation = valuationResult.valuation * qty;

        // 实得灵石 = 估值 × (1 - 手续费率)
        const pawnFeeRate = cfg.pawn_fee_rate || 0.05;
        const pawnFee = Math.floor(totalValuation * pawnFeeRate);
        const pawnAmount = totalValuation - pawnFee;

        // 预估 7 天后的赎回价（赎回价基于 pawn_amount 计算，与实际赎回保持一致）
        const redeemAmount7d = this._calculateRedeemAmount(pawnAmount, 7);

        return {
            item_info: {
                item_key: itemConfig.id,
                name: itemConfig.name,
                type: itemConfig.type,
                subtype: itemConfig.subtype || null,
                quality: itemConfig.quality || 'common',
                description: itemConfig.description || ''
            },
            base_price: valuationResult.base_price,
            quality_ratio: valuationResult.quality_ratio,
            credit_bonus: valuationResult.credit_bonus,
            valuation_per_item: valuationResult.valuation,
            quantity: qty,
            total_valuation: totalValuation,
            pawn_amount: pawnAmount,
            pawn_fee: pawnFee,
            pawn_fee_rate: pawnFeeRate,
            redeem_amount_7d: redeemAmount7d
        };
    }

    /**
     * 典当物品
     * 校验：物品存在、可典当、数量合法、每日次数、活跃当票上限
     * 操作：
     *   - 调用 InventoryService.removeItem 扣减物品
     *   - 创建 pawnshop_listings 记录（status='active'）
     *   - 增加玩家 spirit_stones（pawn_amount - pawn_fee）
     *   - 创建 pawnshop_histories 记录（action_type='pawn'）
     *   - WebSocket 推送 pawnshop:pawn 事件
     * @param {number} playerId - 玩家 ID
     * @param {string} itemKey - 物品 key
     * @param {number} quantity - 典当数量
     * @returns {Promise<Object>} 典当结果
     */
    static async pawn(playerId, itemKey, quantity) {
        // 参数校验
        if (!itemKey) {
            throw new AppError('物品 key 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const cfg = this.getPawnshopConfig();
        if (cfg.enabled === false) {
            throw new AppError('当铺系统已关闭', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const maxQty = cfg.max_pawn_quantity_per_transaction || 99;
        const qty = parseInt(quantity);
        if (isNaN(qty) || qty < 1 || qty > maxQty) {
            throw new AppError(`典当数量必须为 1-${maxQty} 之间的整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验物品配置
        const itemConfig = this._getItemConfig(itemKey);
        if (!itemConfig) {
            throw new AppError(`物品配置不存在: ${itemKey}`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!this._isPawnable(itemConfig)) {
            throw new AppError(`【${itemConfig.name}】为不可典当物品`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已陨落，无法典当', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 跨日重置：基于今日已记 pawn 历史数判定每日次数
            const today = new Date().toISOString().slice(0, 10);
            const dailyPawnCount = await PawnshopHistory.count({
                where: {
                    player_id: playerId,
                    action_type: 'pawn',
                    created_at: { [Op.gte]: new Date(`${today}T00:00:00`) }
                },
                transaction: t
            });
            const dailyLimit = cfg.daily_pawn_limit || 20;
            if (dailyPawnCount >= dailyLimit) {
                throw new AppError(`今日典当次数已达上限（${dailyLimit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 活跃当票上限校验
            const activeCount = await PawnshopListing.count({
                where: { player_id: playerId, status: 'active' },
                transaction: t
            });
            const maxActive = cfg.max_active_listings || 50;
            if (activeCount >= maxActive) {
                throw new AppError(`活跃当票已达上限（${maxActive} 张）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算估值与典当额
            const valuationResult = this._calculateValuation(itemConfig, player.pawnshop_credit || 0);
            const totalValuation = valuationResult.valuation * qty;
            const pawnFeeRate = cfg.pawn_fee_rate || 0.05;
            const pawnFee = Math.floor(totalValuation * pawnFeeRate);
            const pawnAmount = totalValuation - pawnFee;

            // 赎回价：典当额 × (1 + 日利率 × 赎回期天数)
            // 计算时 days 取配置的 redeem_period_days（用于记录初始 redeem_amount）
            // 赎回价基于 pawn_amount 计算（玩家实际拿到的钱 + 利息），与实际赎回时计算口径一致
            const redeemPeriodDays = cfg.redeem_period_days || 7;
            const initialRedeemAmount = this._calculateRedeemAmount(pawnAmount, redeemPeriodDays);

            // 扣减玩家物品（InventoryService.removeItem 内部加锁）
            const removeOk = await InventoryService.removeItem(playerId, itemKey, qty, t);
            if (!removeOk) {
                throw new AppError('物品数量不足，无法典当', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 增加玩家灵石（pawn_amount - pawn_fee 已扣手续费）
            player.spirit_stones = BigInt(player.spirit_stones || 0) + BigInt(pawnAmount);
            await player.save({ transaction: t });

            // 创建当票记录
            const now = new Date();
            const redeemDeadline = new Date(now.getTime() + redeemPeriodDays * 24 * 60 * 60 * 1000);
            const listing = await PawnshopListing.create({
                player_id: playerId,
                item_key: itemKey,
                item_name: itemConfig.name,
                item_quality: itemConfig.quality || 'common',
                quantity: qty,
                base_price: valuationResult.base_price,
                valuation: totalValuation,
                pawn_amount: pawnAmount,
                redeem_amount: initialRedeemAmount,
                pawn_fee: pawnFee,
                pawned_at: now,
                redeem_deadline: redeemDeadline,
                status: 'active'
            }, { transaction: t });

            // 创建历史记录
            await PawnshopHistory.create({
                player_id: playerId,
                listing_id: listing.id,
                action_type: 'pawn',
                item_key: itemKey,
                item_name: itemConfig.name,
                quantity: qty,
                amount: pawnAmount,
                detail: JSON.stringify({
                    pawn_fee: pawnFee,
                    pawn_fee_rate: pawnFeeRate,
                    valuation_per_item: valuationResult.valuation,
                    base_price: valuationResult.base_price,
                    quality_ratio: valuationResult.quality_ratio,
                    redeem_deadline: redeemDeadline.toISOString()
                })
            }, { transaction: t });

            await t.commit();

            // WebSocket 推送典当事件（异步，不阻塞主流程）
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'pawnshop:pawn', {
                    listing_id: listing.id,
                    item_key: itemKey,
                    item_name: itemConfig.name,
                    quantity: qty,
                    pawn_amount: pawnAmount,
                    pawn_fee: pawnFee,
                    redeem_deadline: redeemDeadline.toISOString()
                });
                // 通知玩家数据更新（刷新灵石、背包）
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'pawnshop_pawn', {
                    spirit_stones: player.spirit_stones.toString(),
                    pawn_amount: pawnAmount
                });
            } catch (e) {
                console.warn('[PawnshopService] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: `成功典当 ${itemConfig.name} x${qty}，获得灵石 ${pawnAmount}`,
                listing_id: listing.id,
                item_key: itemKey,
                item_name: itemConfig.name,
                quantity: qty,
                pawn_amount: pawnAmount,
                pawn_fee: pawnFee,
                redeem_amount_initial: initialRedeemAmount,
                redeem_deadline: redeemDeadline.toISOString(),
                spirit_stones_after: player.spirit_stones.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 赎回物品
     * 校验：当票存在且 status='active'、未过期、玩家灵石足够
     * 操作：
     *   - 扣减玩家 spirit_stones（redeem_amount）
     *   - 调用 InventoryService.addItem 添加物品回背包
     *   - 更新 pawnshop_listings.status='redeemed'、redeemed_at、redeemed_by
     *   - 增加 pawnshop_credit（+1，上限 credit_max）
     *   - 创建 pawnshop_histories 记录（action_type='redeem'）
     *   - WebSocket 推送 pawnshop:redeem 事件
     * @param {number} playerId - 玩家 ID
     * @param {number} listingId - 当票 ID
     * @returns {Promise<Object>} 赎回结果
     */
    static async redeem(playerId, listingId) {
        if (!listingId) {
            throw new AppError('当票 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询当票
            const listing = await PawnshopListing.findOne({
                where: { id: listingId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!listing) {
                throw new AppError('当票不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (listing.player_id !== playerId) {
                throw new AppError('只能赎回自己的当票', 403, ErrorCodes.UNAUTHORIZED);
            }
            if (listing.status !== 'active') {
                throw new AppError('该当票已赎回或已逾期', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁查询玩家
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已陨落，无法赎回', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算当前赎回价（基于已过天数）
            const currentRedeemAmount = this._calcCurrentRedeemAmount(listing);

            // 校验灵石充足
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < BigInt(currentRedeemAmount)) {
                throw new AppError(
                    `灵石不足，赎回需要 ${currentRedeemAmount}，当前持有 ${playerStones.toString()}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 扣减灵石
            player.spirit_stones = playerStones - BigInt(currentRedeemAmount);

            // 增加信用额度（+1，上限 credit_max）
            const cfg = this.getPawnshopConfig();
            const creditMax = cfg.credit_max || 100;
            const creditBonus = cfg.credit_bonus_per_redeem || 1;
            const oldCredit = player.pawnshop_credit || 0;
            const newCredit = Math.min(creditMax, oldCredit + creditBonus);
            player.pawnshop_credit = newCredit;

            await player.save({ transaction: t });

            // 物品归还玩家背包
            await InventoryService.addItem(playerId, listing.item_key, listing.quantity, t);

            // 更新当票状态
            listing.status = 'redeemed';
            listing.redeemed_at = new Date();
            listing.redeem_amount = currentRedeemAmount;
            // 普通玩家赎回时 redeemed_by 留空（GM 代赎时记录管理员 ID）
            await listing.save({ transaction: t });

            // 创建历史记录
            await PawnshopHistory.create({
                player_id: playerId,
                listing_id: listing.id,
                action_type: 'redeem',
                item_key: listing.item_key,
                item_name: listing.item_name,
                quantity: listing.quantity,
                amount: currentRedeemAmount,
                detail: JSON.stringify({
                    pawn_amount: Number(listing.pawn_amount),
                    interest_paid: currentRedeemAmount - Number(listing.pawn_amount),
                    credit_before: oldCredit,
                    credit_after: newCredit
                })
            }, { transaction: t });

            await t.commit();

            // WebSocket 推送赎回事件
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'pawnshop:redeem', {
                    listing_id: listing.id,
                    item_key: listing.item_key,
                    item_name: listing.item_name,
                    quantity: listing.quantity,
                    redeem_amount: currentRedeemAmount,
                    credit_after: newCredit
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'pawnshop_redeem', {
                    spirit_stones: player.spirit_stones.toString(),
                    pawnshop_credit: newCredit
                });
            } catch (e) {
                console.warn('[PawnshopService] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: `成功赎回 ${listing.item_name} x${listing.quantity}，消耗灵石 ${currentRedeemAmount}`,
                listing_id: listing.id,
                item_key: listing.item_key,
                item_name: listing.item_name,
                quantity: listing.quantity,
                redeem_amount: currentRedeemAmount,
                credit_after: newCredit,
                spirit_stones_after: player.spirit_stones.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 获取当票列表（分页）
     * 支持 filter=all/active/redeemed/overdue
     * @param {number} playerId - 玩家 ID
     * @param {Object} params - { page, limit, filter }
     * @returns {Promise<Object>} 分页结果
     */
    static async getList(playerId, { page = 1, limit = 10, filter = 'all' } = {}) {
        const cfg = this.getPawnshopConfig();
        const maxLimit = cfg.history_page_size || 50;
        const pageSize = Math.min(parseInt(limit) || 10, maxLimit);
        const offset = (Math.max(1, parseInt(page)) - 1) * pageSize;

        // 构造查询条件
        const where = { player_id: playerId };
        if (filter === 'active') where.status = 'active';
        else if (filter === 'redeemed') where.status = 'redeemed';
        else if (filter === 'overdue') where.status = 'overdue';

        const { count, rows } = await PawnshopListing.findAndCountAll({
            where,
            order: [['pawned_at', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        // 为活跃当票计算当前赎回价与剩余赎回时间
        const now = Date.now();
        const list = rows.map(r => {
            const item = { ...r };
            // 金额字段统一转字符串（BIGINT 兼容）
            item.base_price = Number(r.base_price);
            item.valuation = Number(r.valuation);
            item.pawn_amount = Number(r.pawn_amount);
            item.redeem_amount = Number(r.redeem_amount);
            item.pawn_fee = Number(r.pawn_fee);
            if (r.status === 'active') {
                // 计算当前赎回价（含利息）
                const currentRedeem = this._calcCurrentRedeemAmount(r);
                item.current_redeem_amount = currentRedeem;
                // 剩余赎回时间（毫秒）
                const deadlineMs = new Date(r.redeem_deadline).getTime();
                item.remaining_ms = Math.max(0, deadlineMs - now);
            }
            return item;
        });

        return {
            list,
            total: count,
            page: Math.max(1, parseInt(page)),
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize)
        };
    }

    /**
     * 获取历史记录（分页）
     * @param {number} playerId - 玩家 ID
     * @param {Object} params - { page, limit }
     * @returns {Promise<Object>} 分页结果
     */
    static async getHistory(playerId, { page = 1, limit = 10 } = {}) {
        const cfg = this.getPawnshopConfig();
        const maxLimit = cfg.history_page_size || 50;
        const pageSize = Math.min(parseInt(limit) || 10, maxLimit);
        const offset = (Math.max(1, parseInt(page)) - 1) * pageSize;

        const { count, rows } = await PawnshopHistory.findAndCountAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        // 金额字段统一转字符串（BIGINT 兼容）
        const list = rows.map(r => ({
            ...r,
            amount: Number(r.amount)
        }));

        return {
            list,
            total: count,
            page: Math.max(1, parseInt(page)),
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize)
        };
    }

    /**
     * 清理过期当票（供 StateCleanerService 或定时任务调用）
     * 超过 redeem_deadline + overdue_grace_hours 的当票标记为 status='overdue'
     * 创建 pawnshop_histories 记录（action_type='overdue'）
     * @param {Object} options - { batchSize, notify }
     * @returns {Promise<Object>} { overdue_count, processed_count }
     */
    static async cleanOverdueListings({ batchSize = 100, notify = true } = {}) {
        const cfg = this.getPawnshopConfig();
        const graceHours = cfg.overdue_grace_hours || 24;
        const now = new Date();
        // 截止时间 = 当前时间 - 宽限小时数
        const cutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);

        // 查询已超期但状态仍为 active 的当票
        const overdueListings = await PawnshopListing.findAll({
            where: {
                status: 'active',
                redeem_deadline: { [Op.lt]: cutoff }
            },
            limit: batchSize,
            raw: false
        });

        let processedCount = 0;
        const t = await sequelize.transaction();
        try {
            for (const listing of overdueListings) {
                // 标记为逾期
                listing.status = 'overdue';
                await listing.save({ transaction: t });

                // 创建逾期历史记录
                await PawnshopHistory.create({
                    player_id: listing.player_id,
                    listing_id: listing.id,
                    action_type: 'overdue',
                    item_key: listing.item_key,
                    item_name: listing.item_name,
                    quantity: listing.quantity,
                    amount: Number(listing.pawn_amount),
                    detail: JSON.stringify({
                        pawn_amount: Number(listing.pawn_amount),
                        redeem_deadline: listing.redeem_deadline,
                        grace_hours: graceHours,
                        processed_at: now.toISOString()
                    })
                }, { transaction: t });

                processedCount++;

                // WebSocket 通知玩家当票逾期
                if (notify) {
                    try {
                        WebSocketNotificationService.emitToPlayer(listing.player_id, 'pawnshop:overdue', {
                            listing_id: listing.id,
                            item_key: listing.item_key,
                            item_name: listing.item_name,
                            quantity: listing.quantity,
                            pawn_amount: Number(listing.pawn_amount)
                        });
                    } catch (e) {
                        console.warn('[PawnshopService] 逾期通知推送失败:', e.message);
                    }
                }
            }
            await t.commit();
            return { overdue_count: processedCount, processed_count: processedCount };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * GM 强制赎回（GM 代玩家赎回，不扣玩家灵石）
     * 用于处理玩家申诉或异常情况，由 GM 操作把当票标记为已赎回并归还物品
     * @param {number} adminId - 操作管理员 ID
     * @param {number} playerId - 玩家 ID
     * @param {number} listingId - 当票 ID
     * @param {string} reason - 操作原因（记录到日志）
     * @returns {Promise<Object>} 操作结果
     */
    static async gmForceRedeem(adminId, playerId, listingId, reason) {
        if (!listingId) {
            throw new AppError('当票 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!playerId) {
            throw new AppError('玩家 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询当票
            const listing = await PawnshopListing.findOne({
                where: { id: listingId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!listing) {
                throw new AppError('当票不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (listing.player_id !== playerId) {
                throw new AppError('当票与玩家不匹配', 400, ErrorCodes.VALIDATION_ERROR);
            }
            if (listing.status !== 'active') {
                throw new AppError('该当票已赎回或已逾期', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验玩家存在
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 物品归还玩家背包（不扣灵石）
            await InventoryService.addItem(playerId, listing.item_key, listing.quantity, t);

            // 更新当票状态（GM 代赎不扣玩家灵石，但记录 redeemed_by）
            listing.status = 'redeemed';
            listing.redeemed_at = new Date();
            listing.redeemed_by = adminId;
            await listing.save({ transaction: t });

            // 创建历史记录
            await PawnshopHistory.create({
                player_id: playerId,
                listing_id: listing.id,
                action_type: 'redeem',
                item_key: listing.item_key,
                item_name: listing.item_name,
                quantity: listing.quantity,
                amount: 0, // GM 代赎不扣灵石
                detail: JSON.stringify({
                    gm_action: true,
                    admin_id: adminId,
                    reason: reason || '',
                    pawn_amount: Number(listing.pawn_amount)
                })
            }, { transaction: t });

            await t.commit();

            // WebSocket 通知玩家
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'pawnshop:gm_redeem', {
                    listing_id: listing.id,
                    item_key: listing.item_key,
                    item_name: listing.item_name,
                    quantity: listing.quantity,
                    admin_id: adminId,
                    reason: reason || ''
                });
            } catch (e) {
                console.warn('[PawnshopService] GM 赎回通知推送失败:', e.message);
            }

            return {
                success: true,
                message: `GM 已代赎当票 #${listing.id}，物品已归还玩家 ${player.nickname}`,
                listing_id: listing.id,
                player_id: playerId,
                admin_id: adminId,
                reason: reason || ''
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * GM 强制取消当票（物品直接归还玩家，不扣灵石）
     * 与 gmForceRedeem 区别：cancel 适用于误操作回滚，不增加信用额度，状态标记为 cancelled
     * @param {number} adminId - 操作管理员 ID
     * @param {number} listingId - 当票 ID
     * @param {string} reason - 操作原因（记录到日志）
     * @returns {Promise<Object>} 操作结果
     */
    static async gmCancelListing(adminId, listingId, reason) {
        if (!listingId) {
            throw new AppError('当票 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询当票
            const listing = await PawnshopListing.findOne({
                where: { id: listingId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!listing) {
                throw new AppError('当票不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (listing.status !== 'active') {
                throw new AppError('该当票已赎回或已逾期', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验玩家存在
            const player = await Player.findByPk(listing.player_id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 物品归还玩家背包（不扣灵石，不退还 GM 已发的灵石）
            await InventoryService.addItem(listing.player_id, listing.item_key, listing.quantity, t);

            // 更新当票状态为 cancelled（数据库字段 status 兼容 cancelled，但模型枚举仅 4 类，
            // 故复用 'overdue' 状态避免破坏 schema；通过 detail 区分 cancelled）
            listing.status = 'overdue';
            listing.redeemed_at = new Date();
            listing.redeemed_by = adminId;
            await listing.save({ transaction: t });

            // 创建历史记录（使用 action_type='overdue' + detail 标记为 GM 取消）
            await PawnshopHistory.create({
                player_id: listing.player_id,
                listing_id: listing.id,
                action_type: 'overdue',
                item_key: listing.item_key,
                item_name: listing.item_name,
                quantity: listing.quantity,
                amount: 0,
                detail: JSON.stringify({
                    gm_action: 'cancel',
                    admin_id: adminId,
                    reason: reason || '',
                    item_returned: true,
                    pawn_amount_kept: Number(listing.pawn_amount)
                })
            }, { transaction: t });

            await t.commit();

            // WebSocket 通知玩家
            try {
                WebSocketNotificationService.emitToPlayer(listing.player_id, 'pawnshop:gm_cancel', {
                    listing_id: listing.id,
                    item_key: listing.item_key,
                    item_name: listing.item_name,
                    quantity: listing.quantity,
                    admin_id: adminId,
                    reason: reason || ''
                });
            } catch (e) {
                console.warn('[PawnshopService] GM 取消通知推送失败:', e.message);
            }

            return {
                success: true,
                message: `GM 已取消当票 #${listing.id}，物品已归还玩家 ${player.nickname}`,
                listing_id: listing.id,
                player_id: listing.player_id,
                admin_id: adminId,
                reason: reason || ''
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * GM 调整当铺信用额度
     * @param {number} adminId - 操作管理员 ID
     * @param {number} playerId - 玩家 ID
     * @param {number} credit - 新的信用额度值（0 - credit_max）
     * @param {string} reason - 操作原因（记录到日志）
     * @returns {Promise<Object>} 操作结果
     */
    static async gmUpdateCredit(adminId, playerId, credit, reason) {
        if (!playerId) {
            throw new AppError('玩家 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const cfg = this.getPawnshopConfig();
        const creditMax = cfg.credit_max || 100;
        const newCredit = parseInt(credit);
        if (isNaN(newCredit) || newCredit < 0 || newCredit > creditMax) {
            throw new AppError(`信用额度必须为 0-${creditMax} 之间的整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const oldCredit = player.pawnshop_credit || 0;
            player.pawnshop_credit = newCredit;
            await player.save({ transaction: t });

            await t.commit();

            // WebSocket 通知玩家信用额度变更
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'pawnshop:credit_update', {
                    old_credit: oldCredit,
                    new_credit: newCredit,
                    admin_id: adminId,
                    reason: reason || ''
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'pawnshop_credit', {
                    pawnshop_credit: newCredit
                });
            } catch (e) {
                console.warn('[PawnshopService] GM 调整信用通知推送失败:', e.message);
            }

            return {
                success: true,
                message: `玩家 ${player.nickname} 的当铺信用额度已从 ${oldCredit} 调整为 ${newCredit}`,
                player_id: playerId,
                old_credit: oldCredit,
                new_credit: newCredit,
                admin_id: adminId,
                reason: reason || ''
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }
}

module.exports = PawnshopService;
