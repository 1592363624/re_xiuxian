/**
 * 股市系统服务（聚宝股市）
 *
 * 处理玩家在股市的行情查询、买卖交易、融资融券、分红派息等核心业务逻辑
 *
 * 设计说明：
 *   - 行情模型：基础波动 + 事件影响 + 随机扰动，受 single_update_limit（单次 ±5%）
 *     与 daily_price_limit_up（日内 ±15%）双重限制
 *   - 熔断机制：日内涨跌幅绝对值 >= circuit_breaker_threshold（10%）触发熔断
 *     标记 is_trading_halted=true、halt_until=now+60min，到期自动恢复
 *   - T+1 结算：买入 quantity 增加但 available_quantity 不增加，由开盘任务批量解冻
 *   - 融资融券：max_leverage（2 倍）控制最大融资额度，维持保证金率 < 30% 触发强平
 *   - 交易成本：买入收 trading_fee_buy（0.3%）、卖出收 trading_fee_sell（0.3%）+ 印花税 stamp_tax_sell（0.1%）
 *   - 所有金额字段使用 BIGINT 存储，序列化为字符串避免 JS Number 精度问题
 *   - 所有写操作使用事务（transaction）+ 行级锁（LOCK.UPDATE）保证并发安全
 *   - 配置项（阈值、比例、间隔）从 game_balance.stock_market 读取，禁止硬编码
 *   - 静态股票定义存于 server/config/stock_data.json，启动时同步至 stocks 表
 *   - 业务错误统一使用 AppError + ErrorCodes 抛出，由全局 errorHandler 处理
 *   - 通过 WebSocketNotificationService 推送 stock:buy / stock:sell / stock:dividend 等事件
 */
'use strict';

const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const Player = require('../../models/player');
const Stock = require('../../models/stock');
const StockHolding = require('../../models/stockHolding');
const StockTransaction = require('../../models/stockTransaction');
const StockMarketHistory = require('../../models/stockMarketHistory');
const StockEvent = require('../../models/stockEvent');
const StockMarginAccount = require('../../models/stockMarginAccount');
const StockDividend = require('../../models/stockDividend');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { infrastructure } = require('../../modules');

// 通过 ConfigLoader 获取配置（支持热更新，避免硬编码阈值）
const configLoader = infrastructure.ConfigLoader;

/**
 * BigInt 安全转换工具
 * 防御场景：数据库 BIGINT 字段可能返回 string/null/undefined/number/bigint
 * 直接 BigInt(null) 会抛 TypeError: Cannot convert null to a BigInt，导致接口 500
 * @param {string|number|bigint|null|undefined} value - 待转换的值
 * @returns {bigint} 转换后的 BigInt，null/undefined 返回 0n
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    // 统一转字符串再转 BigInt，避免 number 精度丢失
    return BigInt(String(value));
}

class StockMarketService {
    /**
     * 读取股市配置（game_balance.stock_market）
     * @returns {Object} 股市配置对象
     */
    static _getStockMarketConfig() {
        const config = configLoader.getConfig('game_balance');
        return config?.stock_market || {};
    }

    /**
     * 读取股票静态配置（stock_data.json）
     * @param {string} stockCode - 股票代码（如 ZM01）
     * @returns {Object|null} 股票静态配置
     */
    static _getStockConfig(stockCode) {
        const stocks = configLoader?.getConfig('stock_data')?.stocks || [];
        return stocks.find(s => s.code === stockCode) || null;
    }

    /**
     * 计算单只持仓市值（数量 × 当前价）
     * @param {Object} holding - 持仓实例
     * @param {bigint|number} currentPrice - 当前价
     * @returns {bigint} 持仓市值
     */
    static _calculateHoldingMarketValue(holding, currentPrice) {
        const qty = safeBigInt(holding.quantity);
        const price = safeBigInt(currentPrice);
        return qty * price;
    }

    /**
     * 计算玩家持仓总市值
     * @param {number} playerId - 玩家ID
     * @param {Object} [t] - 事务实例（可选）
     * @returns {Promise<bigint>} 持仓总市值
     */
    static async _calculatePlayerHoldingsValue(playerId, t) {
        const holdings = await StockHolding.findAll({
            where: { player_id: playerId, quantity: { [Op.gt]: 0 } },
            ...(t ? { transaction: t } : {}),
            raw: true
        });
        if (holdings.length === 0) return 0n;
        // 批量查询当前价，避免 N+1
        const stockIds = [...new Set(holdings.map(h => h.stock_id))];
        const stocks = await Stock.findAll({
            where: { id: stockIds },
            attributes: ['id', 'current_price'],
            ...(t ? { transaction: t } : {}),
            raw: true
        });
        const priceMap = new Map(stocks.map(s => [s.id, safeBigInt(s.current_price)]));
        return holdings.reduce((sum, h) => {
            const price = priceMap.get(h.stock_id) || 0n;
            return sum + safeBigInt(h.quantity) * price;
        }, 0n);
    }

    /**
     * 计算玩家总资产（持仓市值 + 股市账户余额）
     * @param {number} playerId - 玩家ID
     * @param {Object} [t] - 事务实例（可选）
     * @returns {Promise<bigint>} 总资产
     */
    static async _calculatePlayerTotalAssets(playerId, t) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'stock_account_balance'],
            ...(t ? { transaction: t, lock: t.LOCK.UPDATE } : {}),
            raw: true
        });
        const balance = safeBigInt(player?.stock_account_balance);
        const holdingsValue = await this._calculatePlayerHoldingsValue(playerId, t);
        return balance + holdingsValue;
    }

    /**
     * 计算玩家负债（取 stock_margin_debt 与 stock_margin_accounts.debt 中较大值）
     * @param {number} playerId - 玩家ID
     * @param {Object} [t] - 事务实例（可选）
     * @returns {Promise<bigint>} 负债金额
     */
    static async _calculatePlayerDebt(playerId, t) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'stock_margin_debt'],
            ...(t ? { transaction: t, lock: t.LOCK.UPDATE } : {}),
            raw: true
        });
        const playerDebt = safeBigInt(player?.stock_margin_debt);
        // 同步 stock_margin_accounts 表的 debt 字段（若存在融资账户）
        const marginAccount = await StockMarginAccount.findOne({
            where: { player_id: playerId },
            ...(t ? { transaction: t } : {}),
            raw: true
        });
        const accountDebt = safeBigInt(marginAccount?.debt);
        // 取较大值，避免两表数据不一致时低估负债
        return playerDebt > accountDebt ? playerDebt : accountDebt;
    }

    /**
     * 应用价格变动 + 熔断检测
     * 校验：单次更新不超过 single_update_limit、日内涨跌幅不超过 daily_price_limit_up
     * 若日内涨跌幅超 circuit_breaker_threshold 则触发熔断 60 分钟
     * @param {Object} stock - 股票实例
     * @param {number} changePct - 变动百分比（如 0.02 表示 +2%）
     * @param {string} reason - 变动原因（用于日志）
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} { new_price, halted, daily_change_pct }
     */
    static async _applyPriceImpact(stock, changePct, reason, t) {
        const cfg = this._getStockMarketConfig();
        // 单次更新限制（防止单笔交易推动价格剧烈波动）
        const singleLimit = cfg.single_update_limit || 0.05;
        let pct = Math.max(-singleLimit, Math.min(singleLimit, changePct));

        // 计算新价格（BigInt 整数运算，单位为灵石）
        const oldPrice = safeBigInt(stock.current_price);
        // pct 为小数，需要乘以 10000 后转 BigInt 做整数运算
        const pctScaled = Math.round(pct * 10000);
        const delta = (oldPrice * BigInt(pctScaled)) / 10000n;
        let newPrice = oldPrice + delta;
        if (newPrice < 1n) newPrice = 1n; // 价格下限保护

        // 计算日内涨跌幅（基于昨收价）
        const yesterdayClose = safeBigInt(stock.yesterday_close_price);
        let dailyChangePct = 0;
        if (yesterdayClose > 0n) {
            dailyChangePct = Number((newPrice - yesterdayClose) * 10000n / yesterdayClose) / 10000;
        }

        // 日内涨跌幅限制（|daily| <= daily_price_limit_up）
        const dailyLimit = cfg.daily_price_limit_up || 0.15;
        let halted = false;
        const threshold = cfg.circuit_breaker_threshold || 0.10;
        const pauseMinutes = cfg.circuit_breaker_pause_minutes || 60;

        // 熔断检测：日内涨跌幅绝对值超阈值则触发熔断
        if (Math.abs(dailyChangePct) >= threshold) {
            halted = true;
            stock.is_trading_halted = true;
            stock.halt_until = new Date(Date.now() + pauseMinutes * 60 * 1000);
        }

        // 更新股票价格与涨跌幅
        stock.current_price = newPrice;
        stock.daily_change_pct = dailyChangePct;
        stock.last_price_update = new Date();
        await stock.save({ transaction: t });

        return {
            new_price: newPrice.toString(),
            halted,
            daily_change_pct: dailyChangePct
        };
    }

    /**
     * 启动时若 stocks 表为空则从 stock_data.json 初始化 12 只股票
     * 幂等：若表已有数据则跳过
     * @returns {Promise<number>} 初始化的股票数量（0 表示已存在数据）
     */
    static async _initializeStocksIfEmpty() {
        const count = await Stock.count();
        if (count > 0) {
            console.log(`[StockMarket] 已存在 ${count} 只股票，跳过初始化`);
            return 0;
        }
        const stocksConfig = configLoader?.getConfig('stock_data')?.stocks || [];
        if (stocksConfig.length === 0) {
            console.warn('[StockMarket] stock_data.json 中无股票配置，跳过初始化');
            return 0;
        }
        const t = await sequelize.transaction();
        try {
            const now = new Date();
            for (const s of stocksConfig) {
                await Stock.create({
                    code: s.code,
                    name: s.name,
                    category: s.category || 'sect',
                    current_price: s.base_price,
                    open_price: s.base_price,
                    yesterday_close_price: s.base_price,
                    daily_change_pct: 0,
                    daily_volume: 0,
                    total_shares: s.total_shares,
                    float_shares: s.total_shares,
                    base_volatility: 0.0300,
                    is_trading_halted: false,
                    halt_until: null,
                    description: s.description || '',
                    is_active: true,
                    last_price_update: now
                }, { transaction: t });
            }
            await t.commit();
            console.log(`[StockMarket] 初始化完成，已创建 ${stocksConfig.length} 只股票`);
            return stocksConfig.length;
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            console.error('[StockMarket] 初始化股票失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取玩家股市状态（账户余额、持仓市值、总资产、负债、保证金率、是否锁定）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 状态快照
     */
    static async getStatus(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        const cfg = this._getStockMarketConfig();

        // 持仓总市值
        const holdingsValue = await this._calculatePlayerHoldingsValue(playerId);
        const balance = safeBigInt(player.stock_account_balance);
        const debt = safeBigInt(player.stock_margin_debt);
        const totalAssets = balance + holdingsValue;
        // 维持保证金率 = (总资产 - 负债) / 总资产（防除零）
        const marginRatio = totalAssets > 0n
            ? Number((totalAssets - debt) * 10000n / totalAssets) / 10000
            : 0;

        // 持仓数量
        const holdingsCount = await StockHolding.count({
            where: { player_id: playerId, quantity: { [Op.gt]: 0 } }
        });

        // 是否有融资账户
        const marginAccount = await StockMarginAccount.findOne({
            where: { player_id: playerId },
            raw: true
        });

        // 最大融资额度 = max_leverage × (余额 + 持仓市值)
        const maxLeverage = cfg.max_leverage || 2;
        const maxCredit = BigInt(maxLeverage) * totalAssets;

        return {
            balance: balance.toString(),
            holdings_value: holdingsValue.toString(),
            total_assets: totalAssets.toString(),
            debt: debt.toString(),
            margin_ratio: marginRatio,
            is_trading_locked: !!player.is_stock_trading_locked,
            holdings_count: holdingsCount,
            has_margin_account: !!marginAccount,
            margin_account_status: marginAccount ? {
                is_liquidated: !!marginAccount.is_liquidated,
                last_check: marginAccount.last_liquidation_check
            } : null,
            max_credit: maxCredit.toString(),
            config: {
                trading_fee_buy: cfg.trading_fee_buy,
                trading_fee_sell: cfg.trading_fee_sell,
                stamp_tax_sell: cfg.stamp_tax_sell,
                max_leverage: maxLeverage,
                min_trade_quantity: cfg.min_trade_quantity || 1,
                max_trade_quantity: cfg.max_trade_quantity || 1000,
                daily_trade_limit: cfg.daily_trade_limit || 50,
                t_plus_1_settlement: cfg.t_plus_1_settlement !== false
            }
        };
    }

    /**
     * 获取所有股票行情列表（含当前价、涨跌幅、成交量、是否熔断）
     * @returns {Promise<Array>} 股票列表
     */
    static async getStockList() {
        const stocks = await Stock.findAll({
            where: { is_active: true },
            raw: true
        });

        // 批量查询活跃事件
        const stockIds = stocks.map(s => s.id);
        const now = new Date();
        const events = await StockEvent.findAll({
            where: {
                stock_id: { [Op.in]: stockIds },
                is_active: true,
                expire_at: { [Op.gt]: now }
            },
            raw: true
        });
        // 按 stock_id 分组（NULL 表示全市场事件）
        const eventMap = new Map();
        for (const e of events) {
            const key = e.stock_id === null ? 'global' : String(e.stock_id);
            if (!eventMap.has(key)) eventMap.set(key, []);
            eventMap.get(key).push({
                event_type: e.event_type,
                impact_pct: Number(e.impact_pct),
                description: e.description,
                expire_at: e.expire_at
            });
        }

        return stocks.map(s => {
            const stockEvents = eventMap.get(String(s.id)) || [];
            const globalEvents = eventMap.get('global') || [];
            return {
                id: s.id,
                code: s.code,
                name: s.name,
                category: s.category,
                current_price: safeBigInt(s.current_price).toString(),
                open_price: safeBigInt(s.open_price).toString(),
                yesterday_close_price: safeBigInt(s.yesterday_close_price).toString(),
                daily_change_pct: Number(s.daily_change_pct),
                daily_volume: safeBigInt(s.daily_volume).toString(),
                total_shares: safeBigInt(s.total_shares).toString(),
                float_shares: safeBigInt(s.float_shares).toString(),
                is_trading_halted: !!s.is_trading_halted,
                halt_until: s.halt_until,
                description: s.description,
                active_events: [...stockEvents, ...globalEvents]
            };
        });
    }

    /**
     * 获取单只股票详情（含基本信息、近期K线、活跃事件）
     * @param {number} stockId - 股票ID
     * @returns {Promise<Object>} 股票详情
     */
    static async getStockDetail(stockId) {
        const stock = await Stock.findByPk(stockId, { raw: true });
        if (!stock) {
            throw new AppError('股票不存在', 404, ErrorCodes.NOT_FOUND);
        }
        // 拉取近 30 条 1h K线
        const klines = await StockMarketHistory.findAll({
            where: { stock_id: stockId, period: '1h' },
            order: [['period_start', 'DESC']],
            limit: 30,
            raw: true
        });
        // 拉取活跃事件
        const now = new Date();
        const events = await StockEvent.findAll({
            where: {
                [Op.and]: [
                    { is_active: true },
                    { expire_at: { [Op.gt]: now } },
                    {
                        [Op.or]: [
                            { stock_id: stockId },
                            { stock_id: null }
                        ]
                    }
                ]
            },
            order: [['expire_at', 'ASC']],
            raw: true
        });
        return {
            id: stock.id,
            code: stock.code,
            name: stock.name,
            category: stock.category,
            current_price: safeBigInt(stock.current_price).toString(),
            open_price: safeBigInt(stock.open_price).toString(),
            yesterday_close_price: safeBigInt(stock.yesterday_close_price).toString(),
            daily_change_pct: Number(stock.daily_change_pct),
            daily_volume: safeBigInt(stock.daily_volume).toString(),
            total_shares: safeBigInt(stock.total_shares).toString(),
            float_shares: safeBigInt(stock.float_shares).toString(),
            is_trading_halted: !!stock.is_trading_halted,
            halt_until: stock.halt_until,
            description: stock.description,
            last_price_update: stock.last_price_update,
            klines: klines.map(k => ({
                open: safeBigInt(k.open_price).toString(),
                close: safeBigInt(k.close_price).toString(),
                high: safeBigInt(k.high_price).toString(),
                low: safeBigInt(k.low_price).toString(),
                volume: safeBigInt(k.volume).toString(),
                period_start: k.period_start,
                period_end: k.period_end
            })),
            active_events: events.map(e => ({
                id: e.id,
                event_type: e.event_type,
                impact_pct: Number(e.impact_pct),
                description: e.description,
                expire_at: e.expire_at
            }))
        };
    }

    /**
     * 获取K线数据（1h/1d/1w）
     * @param {number} stockId - 股票ID
     * @param {string} period - 周期：1h/1d/1w
     * @param {number} limit - 返回条数
     * @returns {Promise<Array>} K线数据
     */
    static async getKline(stockId, period = '1h', limit = 30) {
        // 参数校验
        const allowedPeriods = ['1h', '1d', '1w'];
        if (!allowedPeriods.includes(period)) {
            throw new AppError(`周期参数非法，必须为 ${allowedPeriods.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        const maxLimit = 200;
        const pageSize = Math.min(Math.max(parseInt(limit) || 30, 1), maxLimit);

        const klines = await StockMarketHistory.findAll({
            where: { stock_id: stockId, period },
            order: [['period_start', 'DESC']],
            limit: pageSize,
            raw: true
        });
        return klines.map(k => ({
            open: safeBigInt(k.open_price).toString(),
            close: safeBigInt(k.close_price).toString(),
            high: safeBigInt(k.high_price).toString(),
            low: safeBigInt(k.low_price).toString(),
            volume: safeBigInt(k.volume).toString(),
            period_start: k.period_start,
            period_end: k.period_end
        }));
    }

    /**
     * 获取玩家持仓列表（含市值、浮动盈亏、可用数量）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Array>} 持仓列表
     */
    static async getMyHoldings(playerId) {
        const holdings = await StockHolding.findAll({
            where: { player_id: playerId, quantity: { [Op.gt]: 0 } },
            raw: true
        });
        if (holdings.length === 0) return [];

        // 批量查询股票当前价
        const stockIds = [...new Set(holdings.map(h => h.stock_id))];
        const stocks = await Stock.findAll({
            where: { id: stockIds },
            raw: true
        });
        const stockMap = new Map(stocks.map(s => [s.id, s]));

        return holdings.map(h => {
            const stock = stockMap.get(h.stock_id);
            if (!stock) return null;
            const currentPrice = safeBigInt(stock.current_price);
            const avgCost = safeBigInt(h.average_cost);
            const qty = safeBigInt(h.quantity);
            const availableQty = safeBigInt(h.available_quantity);
            const marketValue = qty * currentPrice;
            const totalCost = safeBigInt(h.total_cost);
            const profit = marketValue - totalCost;
            // 浮动盈亏率 = (市值 - 总成本) / 总成本（防除零）
            const profitPct = totalCost > 0n
                ? Number((marketValue - totalCost) * 10000n / totalCost) / 10000
                : 0;
            return {
                id: h.id,
                stock_id: h.stock_id,
                code: stock.code,
                name: stock.name,
                category: stock.category,
                quantity: qty.toString(),
                available_quantity: availableQty.toString(),
                average_cost: avgCost.toString(),
                total_cost: totalCost.toString(),
                current_price: currentPrice.toString(),
                market_value: marketValue.toString(),
                profit: profit.toString(),
                profit_pct: profitPct,
                is_trading_halted: !!stock.is_trading_halted
            };
        }).filter(Boolean);
    }

    /**
     * 获取玩家交易历史（分页）
     * @param {number} playerId - 玩家ID
     * @param {Object} params - { page, limit }
     * @returns {Promise<Object>} 分页结果
     */
    static async getMyTransactions(playerId, { page = 1, limit = 10 } = {}) {
        const cfg = this._getStockMarketConfig();
        const maxLimit = cfg.history_page_size || 50;
        const pageSize = Math.min(parseInt(limit) || 10, maxLimit);
        const offset = (Math.max(1, parseInt(page)) - 1) * pageSize;

        const { count, rows } = await StockTransaction.findAndCountAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        // 批量查询股票信息
        const stockIds = [...new Set(rows.map(r => r.stock_id))];
        let stockMap = new Map();
        if (stockIds.length > 0) {
            const stocks = await Stock.findAll({
                attributes: ['id', 'code', 'name'],
                where: { id: stockIds },
                raw: true
            });
            stockMap = new Map(stocks.map(s => [s.id, s]));
        }

        const list = rows.map(r => {
            const stock = stockMap.get(r.stock_id);
            return {
                id: r.id,
                stock_id: r.stock_id,
                code: stock?.code || '',
                name: stock?.name || '',
                trade_type: r.trade_type,
                quantity: safeBigInt(r.quantity).toString(),
                price: safeBigInt(r.price).toString(),
                amount: safeBigInt(r.amount).toString(),
                fee: safeBigInt(r.fee).toString(),
                tax: safeBigInt(r.tax).toString(),
                is_margin: !!r.is_margin,
                status: r.status,
                created_at: r.created_at
            };
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
     * 获取玩家分红历史（分页）
     * @param {number} playerId - 玩家ID
     * @param {Object} params - { page, limit }
     * @returns {Promise<Object>} 分页结果
     */
    static async getMyDividends(playerId, { page = 1, limit = 10 } = {}) {
        const cfg = this._getStockMarketConfig();
        const maxLimit = cfg.history_page_size || 50;
        const pageSize = Math.min(parseInt(limit) || 10, maxLimit);
        const offset = (Math.max(1, parseInt(page)) - 1) * pageSize;

        const { count, rows } = await StockDividend.findAndCountAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        // 批量查询股票信息
        const stockIds = [...new Set(rows.map(r => r.stock_id))];
        let stockMap = new Map();
        if (stockIds.length > 0) {
            const stocks = await Stock.findAll({
                attributes: ['id', 'code', 'name'],
                where: { id: stockIds },
                raw: true
            });
            stockMap = new Map(stocks.map(s => [s.id, s]));
        }

        const list = rows.map(r => {
            const stock = stockMap.get(r.stock_id);
            return {
                id: r.id,
                stock_id: r.stock_id,
                code: stock?.code || '',
                name: stock?.name || '',
                quantity: safeBigInt(r.quantity).toString(),
                dividend_per_share: safeBigInt(r.dividend_per_share).toString(),
                total_dividend: safeBigInt(r.total_dividend).toString(),
                dividend_type: r.dividend_type,
                created_at: r.created_at
            };
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
     * 获取融资账户详情（含维持保证金率、是否爆仓）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 融资账户详情
     */
    static async getMyMarginAccount(playerId) {
        const marginAccount = await StockMarginAccount.findOne({
            where: { player_id: playerId },
            raw: true
        });
        if (!marginAccount) {
            return {
                has_margin_account: false,
                message: '尚未开通融资账户，请先调用 POST /api/stock/margin/open 开通'
            };
        }
        const player = await Player.findByPk(playerId, { raw: true });
        const balance = safeBigInt(player?.stock_account_balance);
        const holdingsValue = await this._calculatePlayerHoldingsValue(playerId);
        const totalAssets = balance + holdingsValue;
        const debt = safeBigInt(marginAccount.debt);
        // 维持保证金率 = (总资产 - 负债) / 总资产
        const marginRatio = totalAssets > 0n
            ? Number((totalAssets - debt) * 10000n / totalAssets) / 10000
            : 0;
        const cfg = this._getStockMarketConfig();
        const maintenanceRate = cfg.maintenance_margin_rate || 0.3;
        const maxLeverage = cfg.max_leverage || 2;
        const maxCredit = BigInt(maxLeverage) * totalAssets;

        return {
            has_margin_account: true,
            id: marginAccount.id,
            total_assets: totalAssets.toString(),
            balance: balance.toString(),
            holdings_value: holdingsValue.toString(),
            debt: debt.toString(),
            margin_ratio: marginRatio,
            is_liquidated: !!marginAccount.is_liquidated,
            last_liquidation_check: marginAccount.last_liquidation_check,
            maintenance_margin_rate: maintenanceRate,
            is_danger: marginRatio < maintenanceRate,
            max_credit: maxCredit.toString(),
            available_credit: (maxCredit - debt > 0n ? maxCredit - debt : 0n).toString()
        };
    }

    /**
     * 校验股票是否可交易（存在、未熔断、未停牌）
     * @param {Object} stock - 股票实例
     * @param {Object} cfg - 配置
     */
    static _validateStockTradeable(stock, cfg) {
        if (!stock.is_active) {
            throw new AppError(`股票【${stock.name}】已停牌`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (stock.is_trading_halted) {
            const haltUntil = stock.halt_until ? new Date(stock.halt_until) : null;
            // 熔断未到期则拒绝交易
            if (haltUntil && haltUntil > new Date()) {
                throw new AppError(
                    `股票【${stock.name}】已触发熔断，暂停交易至 ${haltUntil.toLocaleString()}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            // 熔断已过期，自动解除（此处不持久化，由价格更新任务统一清理）
        }
    }

    /**
     * 买入股票
     * 校验：股票存在且未熔断、玩家未锁定交易、数量合法、当日交易次数未超限
     * 计算：成交金额 = price × quantity、手续费 = max(amount × trading_fee_buy, min_fee_per_trade)
     * 普通买入：扣减余额、增加持仓（available_quantity 因 T+1 不增加）
     * 融资买入：增加 stock_margin_debt、增加持仓
     * @param {number} playerId - 玩家ID
     * @param {number} stockId - 股票ID
     * @param {number} quantity - 买入数量
     * @param {Object} options - { useMargin }
     * @returns {Promise<Object>} 交易结果
     */
    static async buy(playerId, stockId, quantity, { useMargin = false } = {}) {
        // 参数校验
        const stockIdNum = parseInt(stockId);
        if (isNaN(stockIdNum) || stockIdNum <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const cfg = this._getStockMarketConfig();
        if (cfg.enabled === false) {
            throw new AppError('股市系统已关闭', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const minQty = cfg.min_trade_quantity || 1;
        const maxQty = cfg.max_trade_quantity || 1000;
        const qtyNum = parseInt(quantity);
        if (isNaN(qtyNum) || qtyNum < minQty || qtyNum > maxQty) {
            throw new AppError(`买入数量必须为 ${minQty}-${maxQty} 之间的整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        const useMarginBool = !!useMargin;

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
                throw new AppError('已陨落，无法交易', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (player.is_stock_trading_locked) {
                throw new AppError('股市交易已被锁定，请联系 GM 解锁', 403, ErrorCodes.UNAUTHORIZED);
            }

            // 行级锁查询股票
            const stock = await Stock.findByPk(stockIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!stock) {
                throw new AppError('股票不存在', 404, ErrorCodes.NOT_FOUND);
            }
            this._validateStockTradeable(stock, cfg);

            // 当日交易次数校验（基于今日买卖流水数）
            const today = new Date().toISOString().slice(0, 10);
            const todayCount = await StockTransaction.count({
                where: {
                    player_id: playerId,
                    created_at: { [Op.gte]: new Date(`${today}T00:00:00`) }
                },
                transaction: t
            });
            const dailyLimit = cfg.daily_trade_limit || 50;
            if (todayCount >= dailyLimit) {
                throw new AppError(`今日交易次数已达上限（${dailyLimit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算成交金额与手续费
            const price = safeBigInt(stock.current_price);
            const qty = BigInt(qtyNum);
            const amount = price * qty;
            const feeRate = useMarginBool
                ? (cfg.margin_trading_fee || 0.005)
                : (cfg.trading_fee_buy || 0.003);
            const minFee = BigInt(cfg.min_fee_per_trade || 5);
            // 手续费 = max(amount × feeRate, minFee)
            const feeScaled = (amount * BigInt(Math.round(feeRate * 10000))) / 10000n;
            const fee = feeScaled > minFee ? feeScaled : minFee;

            // 总成本 = 成交金额 + 手续费
            const totalCost = amount + fee;

            // 持仓查询或初始化
            let holding = await StockHolding.findOne({
                where: { player_id: playerId, stock_id: stockIdNum },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (useMarginBool) {
                // 融资买入：检查融资额度
                const balance = safeBigInt(player.stock_account_balance);
                const holdingsValue = await this._calculatePlayerHoldingsValue(playerId, t);
                const totalAssets = balance + holdingsValue;
                const maxLeverage = cfg.max_leverage || 2;
                const maxCredit = BigInt(maxLeverage) * totalAssets;
                const currentDebt = safeBigInt(player.stock_margin_debt);
                // 可用融资 = maxCredit - currentDebt
                const availableCredit = maxCredit - currentDebt;
                if (totalCost > availableCredit) {
                    throw new AppError(
                        `融资额度不足，需要 ${totalCost.toString()}，可用 ${availableCredit.toString()}`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
                // 增加融资负债
                player.stock_margin_debt = currentDebt + totalCost;

                // 同步 stock_margin_accounts 表
                let marginAccount = await StockMarginAccount.findOne({
                    where: { player_id: playerId },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!marginAccount) {
                    throw new AppError('尚未开通融资账户，请先调用 POST /api/stock/margin/open 开通', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                if (marginAccount.is_liquidated) {
                    throw new AppError('融资账户已爆仓，无法继续融资买入', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                marginAccount.debt = safeBigInt(marginAccount.debt) + totalCost;
                await marginAccount.save({ transaction: t });
            } else {
                // 普通买入：扣减余额
                const balance = safeBigInt(player.stock_account_balance);
                if (balance < totalCost) {
                    throw new AppError(
                        `账户余额不足，需要 ${totalCost.toString()}，当前余额 ${balance.toString()}`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
                player.stock_account_balance = balance - totalCost;
            }
            await player.save({ transaction: t });

            // 更新持仓（T+1：quantity 增加但 available_quantity 不增加）
            if (!holding) {
                holding = await StockHolding.create({
                    player_id: playerId,
                    stock_id: stockIdNum,
                    quantity: qty,
                    available_quantity: 0n, // T+1：当日买入不可卖
                    average_cost: price,
                    total_cost: amount,
                    market_value: amount
                }, { transaction: t });
            } else {
                const oldQty = safeBigInt(holding.quantity);
                const oldTotalCost = safeBigInt(holding.total_cost);
                const newQty = oldQty + qty;
                const newTotalCost = oldTotalCost + amount;
                // 平均成本 = 总成本 / 总数量（向下取整）
                const newAvgCost = newQty > 0n ? newTotalCost / newQty : 0n;
                holding.quantity = newQty;
                // available_quantity 不变（T+1 结算）
                holding.average_cost = newAvgCost;
                holding.total_cost = newTotalCost;
                // 市值缓存由价格更新任务刷新，此处仅按当前价粗略计算
                holding.market_value = newQty * price;
                await holding.save({ transaction: t });
            }

            // 创建交易流水
            const tx = await StockTransaction.create({
                player_id: playerId,
                stock_id: stockIdNum,
                trade_type: 'buy',
                quantity: qty,
                price: price,
                amount: amount,
                fee: fee,
                tax: 0n, // 买入不收印花税
                is_margin: useMarginBool,
                status: 'completed'
            }, { transaction: t });

            // 更新当日成交量
            stock.daily_volume = safeBigInt(stock.daily_volume) + qty;
            await stock.save({ transaction: t });

            await t.commit();

            // 买入后小幅推动价格上涨 0.5%
            try {
                const t2 = await sequelize.transaction();
                try {
                    const stockForImpact = await Stock.findByPk(stockIdNum, {
                        transaction: t2,
                        lock: t2.LOCK.UPDATE
                    });
                    if (stockForImpact) {
                        await this._applyPriceImpact(stockForImpact, 0.005, 'buy_impact', t2);
                    }
                    await t2.commit();
                } catch (e) {
                    if (t2 && !t2.finished) await t2.rollback();
                    console.warn('[StockMarket] 买入价格影响应用失败:', e.message);
                }
            } catch (e) {
                console.warn('[StockMarket] 买入价格影响异常:', e.message);
            }

            // WebSocket 推送买入事件
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'stock:buy', {
                    transaction_id: tx.id,
                    stock_id: stockIdNum,
                    stock_code: stock.code,
                    stock_name: stock.name,
                    quantity: qty.toString(),
                    price: price.toString(),
                    amount: amount.toString(),
                    fee: fee.toString(),
                    is_margin: useMarginBool,
                    stock_account_balance: player.stock_account_balance.toString(),
                    stock_margin_debt: player.stock_margin_debt.toString()
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'stock_buy', {
                    stock_account_balance: player.stock_account_balance.toString(),
                    stock_margin_debt: player.stock_margin_debt.toString()
                });
            } catch (e) {
                console.warn('[StockMarket] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: `成功买入【${stock.name}】${qtyNum} 股，成交金额 ${amount.toString()} 灵石`,
                transaction_id: tx.id,
                stock_id: stockIdNum,
                stock_code: stock.code,
                stock_name: stock.name,
                quantity: qty.toString(),
                price: price.toString(),
                amount: amount.toString(),
                fee: fee.toString(),
                is_margin: useMarginBool,
                stock_account_balance: player.stock_account_balance.toString(),
                stock_margin_debt: player.stock_margin_debt.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 卖出股票
     * 校验：持仓充足、available_quantity 充足（T+1 限制）
     * 计算：成交金额、手续费、印花税 = amount × stamp_tax_sell
     * 融资持仓卖出优先偿还负债
     * @param {number} playerId - 玩家ID
     * @param {number} stockId - 股票ID
     * @param {number} quantity - 卖出数量
     * @returns {Promise<Object>} 交易结果
     */
    static async sell(playerId, stockId, quantity) {
        // 参数校验
        const stockIdNum = parseInt(stockId);
        if (isNaN(stockIdNum) || stockIdNum <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const cfg = this._getStockMarketConfig();
        if (cfg.enabled === false) {
            throw new AppError('股市系统已关闭', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const minQty = cfg.min_trade_quantity || 1;
        const maxQty = cfg.max_trade_quantity || 1000;
        const qtyNum = parseInt(quantity);
        if (isNaN(qtyNum) || qtyNum < minQty || qtyNum > maxQty) {
            throw new AppError(`卖出数量必须为 ${minQty}-${maxQty} 之间的整数`, 400, ErrorCodes.VALIDATION_ERROR);
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
                throw new AppError('已陨落，无法交易', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (player.is_stock_trading_locked) {
                throw new AppError('股市交易已被锁定，请联系 GM 解锁', 403, ErrorCodes.UNAUTHORIZED);
            }

            // 行级锁查询持仓
            const holding = await StockHolding.findOne({
                where: { player_id: playerId, stock_id: stockIdNum },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!holding) {
                throw new AppError('未持有该股票，无法卖出', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const availableQty = safeBigInt(holding.available_quantity);
            if (availableQty < BigInt(qtyNum)) {
                throw new AppError(
                    `可用数量不足（T+1 限制），当前可用 ${availableQty.toString()} 股`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 行级锁查询股票
            const stock = await Stock.findByPk(stockIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!stock) {
                throw new AppError('股票不存在', 404, ErrorCodes.NOT_FOUND);
            }
            this._validateStockTradeable(stock, cfg);

            // 当日交易次数校验
            const today = new Date().toISOString().slice(0, 10);
            const todayCount = await StockTransaction.count({
                where: {
                    player_id: playerId,
                    created_at: { [Op.gte]: new Date(`${today}T00:00:00`) }
                },
                transaction: t
            });
            const dailyLimit = cfg.daily_trade_limit || 50;
            if (todayCount >= dailyLimit) {
                throw new AppError(`今日交易次数已达上限（${dailyLimit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算成交金额、手续费、印花税
            const price = safeBigInt(stock.current_price);
            const qty = BigInt(qtyNum);
            const amount = price * qty;
            const feeRate = cfg.trading_fee_sell || 0.003;
            const minFee = BigInt(cfg.min_fee_per_trade || 5);
            const feeScaled = (amount * BigInt(Math.round(feeRate * 10000))) / 10000n;
            const fee = feeScaled > minFee ? feeScaled : minFee;
            // 印花税 = amount × stamp_tax_sell（仅在卖出时收取）
            const taxRate = cfg.stamp_tax_sell || 0.001;
            const tax = (amount * BigInt(Math.round(taxRate * 10000))) / 10000n;

            // 实得金额 = 成交金额 - 手续费 - 印花税
            const netAmount = amount - fee - tax;

            // 更新持仓（average_cost 不变，total_cost 按比例减少）
            const oldQty = safeBigInt(holding.quantity);
            const oldAvailable = safeBigInt(holding.available_quantity);
            const oldTotalCost = safeBigInt(holding.total_cost);
            const newQty = oldQty - qty;
            const newAvailable = oldAvailable - qty;
            // 新总成本按比例减少 = oldTotalCost × (newQty / oldQty)
            const newTotalCost = oldQty > 0n
                ? (oldTotalCost * newQty) / oldQty
                : 0n;
            holding.quantity = newQty;
            holding.available_quantity = newAvailable;
            holding.total_cost = newTotalCost;
            holding.market_value = newQty * price;
            await holding.save({ transaction: t });

            // 判断是否为融资持仓（简化：若玩家有负债则优先偿还）
            const currentDebt = safeBigInt(player.stock_margin_debt);
            let repayAmount = 0n;
            let addToBalance = netAmount;
            if (currentDebt > 0n) {
                // 优先偿还负债（最多偿还至负债清零）
                repayAmount = currentDebt > netAmount ? netAmount : currentDebt;
                player.stock_margin_debt = currentDebt - repayAmount;
                addToBalance = netAmount - repayAmount;
                // 同步 stock_margin_accounts 表
                const marginAccount = await StockMarginAccount.findOne({
                    where: { player_id: playerId },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (marginAccount) {
                    const accountDebt = safeBigInt(marginAccount.debt);
                    marginAccount.debt = accountDebt > repayAmount ? accountDebt - repayAmount : 0n;
                    await marginAccount.save({ transaction: t });
                }
            }
            // 增加账户余额
            player.stock_account_balance = safeBigInt(player.stock_account_balance) + addToBalance;
            await player.save({ transaction: t });

            // 创建交易流水
            const tx = await StockTransaction.create({
                player_id: playerId,
                stock_id: stockIdNum,
                trade_type: 'sell',
                quantity: qty,
                price: price,
                amount: amount,
                fee: fee,
                tax: tax,
                is_margin: repayAmount > 0n,
                status: 'completed'
            }, { transaction: t });

            // 更新当日成交量
            stock.daily_volume = safeBigInt(stock.daily_volume) + qty;
            await stock.save({ transaction: t });

            await t.commit();

            // 卖出后小幅推动价格下跌 0.5%
            try {
                const t2 = await sequelize.transaction();
                try {
                    const stockForImpact = await Stock.findByPk(stockIdNum, {
                        transaction: t2,
                        lock: t2.LOCK.UPDATE
                    });
                    if (stockForImpact) {
                        await this._applyPriceImpact(stockForImpact, -0.005, 'sell_impact', t2);
                    }
                    await t2.commit();
                } catch (e) {
                    if (t2 && !t2.finished) await t2.rollback();
                    console.warn('[StockMarket] 卖出价格影响应用失败:', e.message);
                }
            } catch (e) {
                console.warn('[StockMarket] 卖出价格影响异常:', e.message);
            }

            // WebSocket 推送卖出事件
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'stock:sell', {
                    transaction_id: tx.id,
                    stock_id: stockIdNum,
                    stock_code: stock.code,
                    stock_name: stock.name,
                    quantity: qty.toString(),
                    price: price.toString(),
                    amount: amount.toString(),
                    fee: fee.toString(),
                    tax: tax.toString(),
                    net_amount: netAmount.toString(),
                    repay_debt: repayAmount.toString(),
                    stock_account_balance: player.stock_account_balance.toString(),
                    stock_margin_debt: player.stock_margin_debt.toString()
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'stock_sell', {
                    stock_account_balance: player.stock_account_balance.toString(),
                    stock_margin_debt: player.stock_margin_debt.toString()
                });
            } catch (e) {
                console.warn('[StockMarket] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: `成功卖出【${stock.name}】${qtyNum} 股，实得 ${netAmount.toString()} 灵石`,
                transaction_id: tx.id,
                stock_id: stockIdNum,
                stock_code: stock.code,
                stock_name: stock.name,
                quantity: qty.toString(),
                price: price.toString(),
                amount: amount.toString(),
                fee: fee.toString(),
                tax: tax.toString(),
                net_amount: netAmount.toString(),
                repay_debt: repayAmount.toString(),
                stock_account_balance: player.stock_account_balance.toString(),
                stock_margin_debt: player.stock_margin_debt.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 开通融资账户（创建 stock_margin_accounts 记录）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 开通结果
     */
    static async openMarginAccount(playerId) {
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
            // 校验是否已开通
            const existing = await StockMarginAccount.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            if (existing) {
                throw new AppError('已开通融资账户，无需重复开通', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 创建融资账户
            const account = await StockMarginAccount.create({
                player_id: playerId,
                total_assets: 0,
                debt: 0,
                margin_ratio: 0,
                is_liquidated: false,
                last_liquidation_check: new Date()
            }, { transaction: t });
            await t.commit();

            // WebSocket 推送开通事件
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'stock:margin_opened', {
                    account_id: account.id,
                    message: '融资账户已开通，可使用 max_leverage × 总资产 的融资额度进行融资买入'
                });
            } catch (e) {
                console.warn('[StockMarket] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: '融资账户已开通',
                account_id: account.id
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 偿还融资负债（从 stock_account_balance 扣减）
     * @param {number} playerId - 玩家ID
     * @param {number} amount - 偿还金额
     * @returns {Promise<Object>} 偿还结果
     */
    static async repayMargin(playerId, amount) {
        const cfg = this._getStockMarketConfig();
        const repayAmount = safeBigInt(amount);
        if (repayAmount <= 0n) {
            throw new AppError('偿还金额必须大于 0', 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 最小偿还金额校验
        const minRepay = BigInt(cfg.min_margin_fee || 10);
        if (repayAmount < minRepay) {
            throw new AppError(`偿还金额不能小于 ${minRepay.toString()} 灵石`, 400, ErrorCodes.VALIDATION_ERROR);
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
            const balance = safeBigInt(player.stock_account_balance);
            if (balance < repayAmount) {
                throw new AppError(
                    `账户余额不足，需要 ${repayAmount.toString()}，当前余额 ${balance.toString()}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            const currentDebt = safeBigInt(player.stock_margin_debt);
            if (currentDebt <= 0n) {
                throw new AppError('当前无融资负债，无需偿还', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 实际偿还金额不超过负债
            const actualRepay = currentDebt > repayAmount ? repayAmount : currentDebt;
            player.stock_account_balance = balance - actualRepay;
            player.stock_margin_debt = currentDebt - actualRepay;
            await player.save({ transaction: t });

            // 同步 stock_margin_accounts 表
            const marginAccount = await StockMarginAccount.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (marginAccount) {
                const accountDebt = safeBigInt(marginAccount.debt);
                marginAccount.debt = accountDebt > actualRepay ? accountDebt - actualRepay : 0n;
                await marginAccount.save({ transaction: t });
            }

            await t.commit();

            // WebSocket 推送偿还事件
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'stock:margin_repay', {
                    repay_amount: actualRepay.toString(),
                    remaining_debt: player.stock_margin_debt.toString(),
                    stock_account_balance: player.stock_account_balance.toString()
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'stock_repay', {
                    stock_account_balance: player.stock_account_balance.toString(),
                    stock_margin_debt: player.stock_margin_debt.toString()
                });
            } catch (e) {
                console.warn('[StockMarket] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: `成功偿还融资负债 ${actualRepay.toString()} 灵石`,
                repay_amount: actualRepay.toString(),
                remaining_debt: player.stock_margin_debt.toString(),
                stock_account_balance: player.stock_account_balance.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 从灵石转入股市账户
     * 校验：玩家 spirit_stones 充足
     * 操作：player.spirit_stones 减少，stock_account_balance 增加
     * @param {number} playerId - 玩家ID
     * @param {number} amount - 转入金额
     * @returns {Promise<Object>} 转入结果
     */
    static async deposit(playerId, amount) {
        const depositAmount = safeBigInt(amount);
        if (depositAmount <= 0n) {
            throw new AppError('转入金额必须大于 0', 400, ErrorCodes.VALIDATION_ERROR);
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
                throw new AppError('已陨落，无法操作', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const spiritStones = safeBigInt(player.spirit_stones);
            if (spiritStones < depositAmount) {
                throw new AppError(
                    `灵石不足，需要 ${depositAmount.toString()}，当前持有 ${spiritStones.toString()}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            player.spirit_stones = spiritStones - depositAmount;
            player.stock_account_balance = safeBigInt(player.stock_account_balance) + depositAmount;
            await player.save({ transaction: t });
            await t.commit();

            // WebSocket 推送转入事件
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'stock:deposit', {
                    amount: depositAmount.toString(),
                    spirit_stones: player.spirit_stones.toString(),
                    stock_account_balance: player.stock_account_balance.toString()
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'stock_deposit', {
                    spirit_stones: player.spirit_stones.toString(),
                    stock_account_balance: player.stock_account_balance.toString()
                });
            } catch (e) {
                console.warn('[StockMarket] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: `成功转入 ${depositAmount.toString()} 灵石至股市账户`,
                amount: depositAmount.toString(),
                spirit_stones: player.spirit_stones.toString(),
                stock_account_balance: player.stock_account_balance.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 从股市账户转出灵石
     * 校验：stock_account_balance 充足、负债率不能过高（避免套现逃跑）
     * 操作：stock_account_balance 减少，player.spirit_stones 增加
     * @param {number} playerId - 玩家ID
     * @param {number} amount - 转出金额
     * @returns {Promise<Object>} 转出结果
     */
    static async withdraw(playerId, amount) {
        const withdrawAmount = safeBigInt(amount);
        if (withdrawAmount <= 0n) {
            throw new AppError('转出金额必须大于 0', 400, ErrorCodes.VALIDATION_ERROR);
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
                throw new AppError('已陨落，无法操作', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const balance = safeBigInt(player.stock_account_balance);
            if (balance < withdrawAmount) {
                throw new AppError(
                    `股市账户余额不足，需要 ${withdrawAmount.toString()}，当前余额 ${balance.toString()}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            // 负债率校验：转出后剩余余额不能为负，且若负债则剩余余额需占总资产 >= 30%
            const holdingsValue = await this._calculatePlayerHoldingsValue(playerId, t);
            const totalAssets = balance + holdingsValue;
            const debt = safeBigInt(player.stock_margin_debt);
            const newBalance = balance - withdrawAmount;
            const newTotalAssets = newBalance + holdingsValue;
            // 转出后维持保证金率 = (新总资产 - 负债) / 新总资产
            const newMarginRatio = newTotalAssets > 0n
                ? Number((newTotalAssets - debt) * 10000n / newTotalAssets) / 10000
                : 0;
            const cfg = this._getStockMarketConfig();
            const maintenanceRate = cfg.maintenance_margin_rate || 0.3;
            // 若有负债，转出后保证金率不得低于维持保证金率
            if (debt > 0n && newMarginRatio < maintenanceRate) {
                throw new AppError(
                    `转出后维持保证金率（${(newMarginRatio * 100).toFixed(2)}%）低于维持保证金率（${(maintenanceRate * 100).toFixed(2)}%），请先偿还融资负债`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            player.stock_account_balance = newBalance;
            player.spirit_stones = safeBigInt(player.spirit_stones) + withdrawAmount;
            await player.save({ transaction: t });
            await t.commit();

            // WebSocket 推送转出事件
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'stock:withdraw', {
                    amount: withdrawAmount.toString(),
                    spirit_stones: player.spirit_stones.toString(),
                    stock_account_balance: player.stock_account_balance.toString()
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'stock_withdraw', {
                    spirit_stones: player.spirit_stones.toString(),
                    stock_account_balance: player.stock_account_balance.toString()
                });
            } catch (e) {
                console.warn('[StockMarket] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: `成功从股市账户转出 ${withdrawAmount.toString()} 灵石`,
                amount: withdrawAmount.toString(),
                spirit_stones: player.spirit_stones.toString(),
                stock_account_balance: player.stock_account_balance.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 价格更新任务（每 price_update_interval_minutes 分钟执行）
     * 对每只股票：基础波动 + 活跃事件影响 + 随机扰动
     * 熔断检测：日内涨跌幅 >= circuit_breaker_threshold 则标记熔断
     * 熔断到期自动恢复
     * 写入 stock_market_history（1h 周期 K线）
     * 更新所有持仓的 market_value 缓存
     * @returns {Promise<Object>} { updated_count, halted_count, kline_count }
     */
    static async updateStockPrices() {
        const cfg = this._getStockMarketConfig();
        if (cfg.enabled === false) {
            return { updated_count: 0, halted_count: 0, kline_count: 0, message: '股市系统已关闭' };
        }

        const t = await sequelize.transaction();
        try {
            // 查询所有活跃股票（行级锁）
            const stocks = await Stock.findAll({
                where: { is_active: true },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            const now = new Date();
            const volatilityRange = cfg.base_volatility_range || [-0.03, 0.03];
            const singleLimit = cfg.single_update_limit || 0.05;
            const threshold = cfg.circuit_breaker_threshold || 0.10;
            const pauseMinutes = cfg.circuit_breaker_pause_minutes || 60;

            // 批量查询所有活跃事件
            const stockIds = stocks.map(s => s.id);
            const events = await StockEvent.findAll({
                where: {
                    [Op.and]: [
                        { is_active: true },
                        { expire_at: { [Op.gt]: now } },
                        {
                            [Op.or]: [
                                { stock_id: { [Op.in]: stockIds } },
                                { stock_id: null }
                            ]
                        }
                    ]
                },
                transaction: t,
                raw: true
            });
            // 按 stock_id 分组事件
            const eventMap = new Map();
            const globalEvents = [];
            for (const e of events) {
                if (e.stock_id === null) {
                    globalEvents.push(e);
                } else {
                    const key = String(e.stock_id);
                    if (!eventMap.has(key)) eventMap.set(key, []);
                    eventMap.get(key).push(e);
                }
            }

            let updatedCount = 0;
            let haltedCount = 0;
            const klines = [];

            for (const stock of stocks) {
                // 熔断到期自动恢复
                if (stock.is_trading_halted && stock.halt_until) {
                    if (new Date(stock.halt_until) <= now) {
                        stock.is_trading_halted = false;
                        stock.halt_until = null;
                    } else {
                        // 仍在熔断期内，跳过价格更新
                        continue;
                    }
                }

                // 计算事件影响（累加 impact_pct）
                const stockEvents = eventMap.get(String(stock.id)) || [];
                const allEvents = [...stockEvents, ...globalEvents];
                let eventImpact = 0;
                for (const e of allEvents) {
                    eventImpact += Number(e.impact_pct) || 0;
                }

                // 基础波动 + 随机扰动
                const baseVolatility = Number(stock.base_volatility) || 0.03;
                const minV = volatilityRange[0] || -0.03;
                const maxV = volatilityRange[1] || 0.03;
                const randomPct = minV + Math.random() * (maxV - minV);
                // 总变动 = 基础波动 + 事件影响
                let changePct = randomPct + eventImpact * 0.5;
                // 单次更新限制（±singleLimit）
                changePct = Math.max(-singleLimit, Math.min(singleLimit, changePct));

                // 计算新价格
                const oldPrice = safeBigInt(stock.current_price);
                const pctScaled = Math.round(changePct * 10000);
                const delta = (oldPrice * BigInt(pctScaled)) / 10000n;
                let newPrice = oldPrice + delta;
                if (newPrice < 1n) newPrice = 1n;

                // 计算日内涨跌幅
                const yesterdayClose = safeBigInt(stock.yesterday_close_price);
                let dailyChangePct = 0;
                if (yesterdayClose > 0n) {
                    dailyChangePct = Number((newPrice - yesterdayClose) * 10000n / yesterdayClose) / 10000;
                }

                // 熔断检测
                let halted = false;
                if (Math.abs(dailyChangePct) >= threshold) {
                    halted = true;
                    stock.is_trading_halted = true;
                    stock.halt_until = new Date(now.getTime() + pauseMinutes * 60 * 1000);
                    haltedCount++;
                }

                // 更新股票价格
                stock.current_price = newPrice;
                stock.daily_change_pct = dailyChangePct;
                stock.last_price_update = now;
                await stock.save({ transaction: t });

                // 写入 K线（1h 周期）
                // 简化实现：每次更新都生成一条 K线记录
                klines.push({
                    stock_id: stock.id,
                    period: '1h',
                    open_price: oldPrice,
                    close_price: newPrice,
                    high_price: oldPrice > newPrice ? oldPrice : newPrice,
                    low_price: oldPrice < newPrice ? oldPrice : newPrice,
                    volume: safeBigInt(stock.daily_volume),
                    period_start: new Date(now.getTime() - (cfg.price_update_interval_minutes || 60) * 60 * 1000),
                    period_end: now
                });

                updatedCount++;
            }

            // 批量写入 K线
            if (klines.length > 0) {
                await StockMarketHistory.bulkCreate(klines, { transaction: t });
            }

            await t.commit();

            // 异步刷新所有持仓的 market_value 缓存（独立事务，避免阻塞）
            try {
                await this._refreshAllHoldingsMarketValue();
            } catch (e) {
                console.warn('[StockMarket] 刷新持仓市值缓存失败:', e.message);
            }

            // 异步清理过期事件
            try {
                await StockEvent.update(
                    { is_active: false },
                    { where: { is_active: true, expire_at: { [Op.lte]: now } } }
                );
            } catch (e) {
                console.warn('[StockMarket] 清理过期事件失败:', e.message);
            }

            console.log(`[StockMarket] 价格更新完成：更新 ${updatedCount} 只股票，触发熔断 ${haltedCount} 只，写入 ${klines.length} 条 K线`);
            return {
                updated_count: updatedCount,
                halted_count: haltedCount,
                kline_count: klines.length
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            console.error('[StockMarket] 价格更新任务失败:', error.message);
            throw error;
        }
    }

    /**
     * 刷新所有持仓的 market_value 缓存（独立事务）
     * @returns {Promise<number>} 更新的持仓数
     */
    static async _refreshAllHoldingsMarketValue() {
        const t = await sequelize.transaction();
        try {
            // 查询所有非零持仓
            const holdings = await StockHolding.findAll({
                where: { quantity: { [Op.gt]: 0 } },
                transaction: t,
                lock: t.LOCK.UPDATE,
                raw: true
            });
            if (holdings.length === 0) {
                await t.commit();
                return 0;
            }
            // 批量查询股票当前价
            const stockIds = [...new Set(holdings.map(h => h.stock_id))];
            const stocks = await Stock.findAll({
                where: { id: stockIds },
                attributes: ['id', 'current_price'],
                transaction: t,
                raw: true
            });
            const priceMap = new Map(stocks.map(s => [s.id, safeBigInt(s.current_price)]));

            // 逐条更新持仓市值（批量 UPDATE 优化为单条事务）
            let updated = 0;
            for (const h of holdings) {
                const price = priceMap.get(h.stock_id) || 0n;
                const marketValue = safeBigInt(h.quantity) * price;
                // 仅在市值变化时更新，减少无意义写入
                if (safeBigInt(h.market_value).toString() !== marketValue.toString()) {
                    await StockHolding.update(
                        { market_value: marketValue },
                        { where: { id: h.id }, transaction: t }
                    );
                    updated++;
                }
            }
            await t.commit();
            return updated;
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            console.warn('[StockMarket] 刷新持仓市值缓存失败:', error.message);
            return 0;
        }
    }

    /**
     * 强平检查任务（每 force_liquidation_check_interval_ms 毫秒执行）
     * 计算每个融资账户的总资产 = 持仓市值 + 现金余额
     * 维持保证金率 = (总资产 - 负债) / 总资产
     * 若 < maintenance_margin_rate（0.3）则触发强平：市价卖出全部持仓偿还负债、记录 is_liquidated=true
     * @returns {Promise<Object>} { checked_count, liquidated_count }
     */
    static async checkMarginAccounts() {
        const cfg = this._getStockMarketConfig();
        const maintenanceRate = cfg.maintenance_margin_rate || 0.3;

        // 查询所有未爆仓的融资账户
        const accounts = await StockMarginAccount.findAll({
            where: { is_liquidated: false },
            raw: true
        });

        let checkedCount = 0;
        let liquidatedCount = 0;

        for (const account of accounts) {
            checkedCount++;
            const t = await sequelize.transaction();
            try {
                // 行级锁查询账户
                const acc = await StockMarginAccount.findByPk(account.id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!acc || acc.is_liquidated) {
                    await t.commit();
                    continue;
                }

                const player = await Player.findByPk(account.player_id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!player) {
                    await t.commit();
                    continue;
                }

                const balance = safeBigInt(player.stock_account_balance);
                const holdingsValue = await this._calculatePlayerHoldingsValue(account.player_id, t);
                const totalAssets = balance + holdingsValue;
                const debt = safeBigInt(acc.debt);

                // 维持保证金率 = (总资产 - 负债) / 总资产
                const marginRatio = totalAssets > 0n
                    ? Number((totalAssets - debt) * 10000n / totalAssets) / 10000
                    : 0;

                // 更新账户快照
                acc.total_assets = totalAssets;
                acc.margin_ratio = marginRatio;
                acc.last_liquidation_check = new Date();

                // 触发强平：保证金率低于维持保证金率
                if (marginRatio < maintenanceRate && debt > 0n) {
                    acc.is_liquidated = true;
                    // 市价卖出全部持仓偿还负债
                    const holdings = await StockHolding.findAll({
                        where: { player_id: account.player_id, quantity: { [Op.gt]: 0 } },
                        transaction: t,
                        lock: t.LOCK.UPDATE,
                        raw: true
                    });
                    let totalProceeds = 0n;
                    for (const h of holdings) {
                        const stock = await Stock.findByPk(h.stock_id, { transaction: t, lock: t.LOCK.UPDATE });
                        if (!stock) continue;
                        const price = safeBigInt(stock.current_price);
                        const qty = safeBigInt(h.quantity);
                        const proceeds = price * qty;
                        totalProceeds += proceeds;
                        // 清空持仓
                        await StockHolding.update(
                            { quantity: 0n, available_quantity: 0n, total_cost: 0n, market_value: 0n },
                            { where: { id: h.id }, transaction: t }
                        );
                        // 创建强平卖出流水
                        await StockTransaction.create({
                            player_id: account.player_id,
                            stock_id: h.stock_id,
                            trade_type: 'sell',
                            quantity: qty,
                            price: price,
                            amount: proceeds,
                            fee: 0n,
                            tax: 0n,
                            is_margin: true,
                            status: 'completed'
                        }, { transaction: t });
                        // 更新当日成交量
                        stock.daily_volume = safeBigInt(stock.daily_volume) + qty;
                        await stock.save({ transaction: t });
                    }
                    // 偿还负债：现金 + 卖出所得 → 负债
                    const totalAvailable = balance + totalProceeds;
                    const actualRepay = totalAvailable > debt ? debt : totalAvailable;
                    const remainingDebt = debt - actualRepay;
                    // 优先用卖出所得偿还
                    let remainingProceeds = totalProceeds;
                    if (remainingProceeds >= actualRepay) {
                        remainingProceeds -= actualRepay;
                        // 剩余卖出所得转入余额
                        player.stock_account_balance = balance + remainingProceeds;
                        player.stock_margin_debt = 0n;
                    } else {
                        // 卖出所得全部偿还，剩余从余额扣
                        const repayFromBalance = actualRepay - remainingProceeds;
                        player.stock_account_balance = balance - repayFromBalance;
                        player.stock_margin_debt = remainingDebt;
                    }
                    await player.save({ transaction: t });
                    acc.debt = remainingDebt;
                    liquidatedCount++;

                    console.warn(`[StockMarket] 玩家 ${account.player_id} 触发强平：保证金率 ${(marginRatio * 100).toFixed(2)}%，卖出全部持仓偿还负债`);

                    // WebSocket 推送强平事件
                    try {
                        WebSocketNotificationService.emitToPlayer(account.player_id, 'stock:liquidation', {
                            margin_ratio: marginRatio,
                            maintenance_margin_rate: maintenanceRate,
                            total_assets: totalAssets.toString(),
                            debt: debt.toString(),
                            repay_amount: actualRepay.toString(),
                            remaining_debt: remainingDebt.toString(),
                            message: `融资账户触发强平，已市价卖出全部持仓偿还负债 ${actualRepay.toString()} 灵石`
                        });
                        WebSocketNotificationService.notifyPlayerUpdate(account.player_id, 'stock_liquidation', {
                            stock_account_balance: player.stock_account_balance.toString(),
                            stock_margin_debt: player.stock_margin_debt.toString()
                        });
                    } catch (e) {
                        console.warn('[StockMarket] WebSocket 推送失败:', e.message);
                    }
                }

                await acc.save({ transaction: t });
                await t.commit();
            } catch (error) {
                if (t && !t.finished) await t.rollback();
                console.error(`[StockMarket] 强平检查玩家 ${account.player_id} 失败:`, error.message);
            }
        }

        if (liquidatedCount > 0) {
            console.log(`[StockMarket] 强平检查完成：检查 ${checkedCount} 个账户，触发强平 ${liquidatedCount} 个`);
        }
        return { checked_count: checkedCount, liquidated_count: liquidatedCount };
    }

    /**
     * 融资利息任务（每 margin_interest_check_interval_ms 毫秒执行）
     * 对每个有负债的玩家：interest = debt × margin_daily_interest_rate（0.001）
     * 增加负债、推送通知
     * @returns {Promise<Object>} { charged_count, total_interest }
     */
    static async chargeMarginInterest() {
        const cfg = this._getStockMarketConfig();
        const dailyRate = cfg.margin_daily_interest_rate || 0.001;

        // 查询所有有负债的玩家
        const players = await Player.findAll({
            where: { stock_margin_debt: { [Op.gt]: 0 } },
            raw: true
        });

        let chargedCount = 0;
        let totalInterest = 0n;

        for (const p of players) {
            const t = await sequelize.transaction();
            try {
                const player = await Player.findByPk(p.id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!player) {
                    await t.commit();
                    continue;
                }
                const debt = safeBigInt(player.stock_margin_debt);
                if (debt <= 0n) {
                    await t.commit();
                    continue;
                }
                // 利息 = debt × dailyRate
                const interest = (debt * BigInt(Math.round(dailyRate * 10000))) / 10000n;
                if (interest <= 0n) {
                    await t.commit();
                    continue;
                }
                player.stock_margin_debt = debt + interest;
                await player.save({ transaction: t });

                // 同步 stock_margin_accounts 表
                const marginAccount = await StockMarginAccount.findOne({
                    where: { player_id: p.id },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (marginAccount) {
                    marginAccount.debt = safeBigInt(marginAccount.debt) + interest;
                    await marginAccount.save({ transaction: t });
                }

                await t.commit();
                chargedCount++;
                totalInterest += interest;

                // WebSocket 推送利息收取事件
                try {
                    WebSocketNotificationService.emitToPlayer(p.id, 'stock:margin_interest', {
                        interest: interest.toString(),
                        new_debt: player.stock_margin_debt.toString(),
                        message: `融资账户收取日利息 ${interest.toString()} 灵石`
                    });
                    WebSocketNotificationService.notifyPlayerUpdate(p.id, 'stock_interest', {
                        stock_margin_debt: player.stock_margin_debt.toString()
                    });
                } catch (e) {
                    console.warn('[StockMarket] WebSocket 推送失败:', e.message);
                }
            } catch (error) {
                if (t && !t.finished) await t.rollback();
                console.error(`[StockMarket] 收取玩家 ${p.id} 利息失败:`, error.message);
            }
        }

        if (chargedCount > 0) {
            console.log(`[StockMarket] 利息收取完成：${chargedCount} 个账户，总利息 ${totalInterest.toString()}`);
        }
        return { charged_count: chargedCount, total_interest: totalInterest.toString() };
    }

    /**
     * 分红任务（每日检查）
     * 根据 dividend_schedules：sect_stock 90天/ratio 0.10、mine_stock 30天/ratio 0.15
     * 对每只股票按周期派息：dividend_per_share = current_price × ratio
     * 对每个持仓玩家：total_dividend = quantity × dividend_per_share，增加 stock_account_balance
     * @returns {Promise<Object>} { distributed_count, total_dividend }
     */
    static async processDividends() {
        const cfg = this._getStockMarketConfig();
        const schedules = cfg.dividend_schedules || {};

        // 查询所有活跃股票
        const stocks = await Stock.findAll({
            where: { is_active: true },
            raw: true
        });

        let distributedCount = 0;
        let totalDividend = 0n;
        const now = new Date();

        for (const stock of stocks) {
            // 根据股票类别确定分红配置
            let scheduleKey = null;
            let dividendType = 'monthly';
            if (stock.category === 'sect') {
                scheduleKey = 'sect_stock';
                dividendType = 'quarterly';
            } else if (stock.category === 'mine') {
                scheduleKey = 'mine_stock';
                dividendType = 'monthly';
            } else if (stock.category === 'dungeon') {
                scheduleKey = 'dungeon_stock';
                dividendType = 'event';
            } else if (stock.category === 'event') {
                scheduleKey = 'event_stock';
                dividendType = 'event';
            }
            const schedule = scheduleKey ? schedules[scheduleKey] : null;
            // 仅周期型分红（dungeon/event 触发型不在此处处理）
            if (!schedule || !schedule.period_days || schedule.trigger) continue;

            // 检查上次分红时间：取该股票最近一次分红时间，判断是否满周期
            const lastDividend = await StockDividend.findOne({
                where: { stock_id: stock.id },
                order: [['created_at', 'DESC']],
                raw: true
            });
            const lastTime = lastDividend ? new Date(lastDividend.created_at) : new Date(0);
            const periodMs = schedule.period_days * 24 * 60 * 60 * 1000;
            if (now - lastTime < periodMs) continue;

            // 计算每股分红 = current_price × ratio
            const currentPrice = safeBigInt(stock.current_price);
            const ratio = schedule.ratio || 0.10;
            const dividendPerShare = (currentPrice * BigInt(Math.round(ratio * 10000))) / 10000n;
            if (dividendPerShare <= 0n) continue;

            // 查询所有持仓玩家
            const holdings = await StockHolding.findAll({
                where: { stock_id: stock.id, quantity: { [Op.gt]: 0 } },
                raw: true
            });
            if (holdings.length === 0) continue;

            // 批量派息
            const t = await sequelize.transaction();
            try {
                for (const h of holdings) {
                    const qty = safeBigInt(h.quantity);
                    const totalDividendAmount = qty * dividendPerShare;
                    if (totalDividendAmount <= 0n) continue;

                    // 行级锁更新玩家余额
                    const player = await Player.findByPk(h.player_id, {
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });
                    if (!player || player.is_dead) continue;

                    player.stock_account_balance = safeBigInt(player.stock_account_balance) + totalDividendAmount;
                    await player.save({ transaction: t });

                    // 创建分红记录
                    await StockDividend.create({
                        player_id: h.player_id,
                        stock_id: stock.id,
                        quantity: qty,
                        dividend_per_share: dividendPerShare,
                        total_dividend: totalDividendAmount,
                        dividend_type: dividendType
                    }, { transaction: t });

                    distributedCount++;
                    totalDividend += totalDividendAmount;

                    // WebSocket 推送分红事件
                    try {
                        WebSocketNotificationService.emitToPlayer(h.player_id, 'stock:dividend', {
                            stock_id: stock.id,
                            stock_code: stock.code,
                            stock_name: stock.name,
                            quantity: qty.toString(),
                            dividend_per_share: dividendPerShare.toString(),
                            total_dividend: totalDividendAmount.toString(),
                            dividend_type: dividendType,
                            stock_account_balance: player.stock_account_balance.toString(),
                            message: `获得【${stock.name}】分红 ${totalDividendAmount.toString()} 灵石`
                        });
                        WebSocketNotificationService.notifyPlayerUpdate(h.player_id, 'stock_dividend', {
                            stock_account_balance: player.stock_account_balance.toString()
                        });
                    } catch (e) {
                        console.warn('[StockMarket] WebSocket 推送失败:', e.message);
                    }
                }
                await t.commit();
            } catch (error) {
                if (t && !t.finished) await t.rollback();
                console.error(`[StockMarket] 股票 ${stock.code} 分红失败:`, error.message);
            }
        }

        if (distributedCount > 0) {
            console.log(`[StockMarket] 分红完成：派发 ${distributedCount} 笔，总金额 ${totalDividend.toString()}`);
        }
        return { distributed_count: distributedCount, total_dividend: totalDividend.toString() };
    }

    // ===== GM 管理接口 =====

    /**
     * GM 调整股价（直接设置 new_price）
     * @param {number} adminId - 管理员ID
     * @param {number} stockId - 股票ID
     * @param {number} newPrice - 新价格
     * @param {string} reason - 操作原因
     * @returns {Promise<Object>} 调整结果
     */
    static async gmAdjustPrice(adminId, stockId, newPrice, reason) {
        const stockIdNum = parseInt(stockId);
        if (isNaN(stockIdNum) || stockIdNum <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const newPriceBig = safeBigInt(newPrice);
        if (newPriceBig <= 0n) {
            throw new AppError('新价格必须大于 0', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const stock = await Stock.findByPk(stockIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!stock) {
                throw new AppError('股票不存在', 404, ErrorCodes.NOT_FOUND);
            }
            const oldPrice = safeBigInt(stock.current_price);
            stock.current_price = newPriceBig;
            // 重算日内涨跌幅
            const yesterdayClose = safeBigInt(stock.yesterday_close_price);
            if (yesterdayClose > 0n) {
                stock.daily_change_pct = Number((newPriceBig - yesterdayClose) * 10000n / yesterdayClose) / 10000;
            }
            await stock.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `GM 调整股票【${stock.name}】价格：${oldPrice.toString()} → ${newPriceBig.toString()}`,
                stock_id: stockIdNum,
                stock_code: stock.code,
                stock_name: stock.name,
                old_price: oldPrice.toString(),
                new_price: newPriceBig.toString(),
                admin_id: adminId,
                reason: reason || ''
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * GM 暂停股票交易
     * @param {number} adminId - 管理员ID
     * @param {number} stockId - 股票ID
     * @param {number} durationMinutes - 暂停时长（分钟）
     * @param {string} reason - 操作原因
     * @returns {Promise<Object>} 暂停结果
     */
    static async gmHaltStock(adminId, stockId, durationMinutes, reason) {
        const stockIdNum = parseInt(stockId);
        if (isNaN(stockIdNum) || stockIdNum <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const duration = parseInt(durationMinutes) || 60;
        if (duration < 1 || duration > 1440) {
            throw new AppError('暂停时长必须在 1-1440 分钟之间', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const stock = await Stock.findByPk(stockIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!stock) {
                throw new AppError('股票不存在', 404, ErrorCodes.NOT_FOUND);
            }
            stock.is_trading_halted = true;
            stock.halt_until = new Date(Date.now() + duration * 60 * 1000);
            await stock.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `GM 暂停股票【${stock.name}】交易 ${duration} 分钟`,
                stock_id: stockIdNum,
                stock_code: stock.code,
                stock_name: stock.name,
                halt_until: stock.halt_until,
                admin_id: adminId,
                reason: reason || ''
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * GM 恢复股票交易
     * @param {number} adminId - 管理员ID
     * @param {number} stockId - 股票ID
     * @param {string} reason - 操作原因
     * @returns {Promise<Object>} 恢复结果
     */
    static async gmResumeStock(adminId, stockId, reason) {
        const stockIdNum = parseInt(stockId);
        if (isNaN(stockIdNum) || stockIdNum <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const stock = await Stock.findByPk(stockIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!stock) {
                throw new AppError('股票不存在', 404, ErrorCodes.NOT_FOUND);
            }
            stock.is_trading_halted = false;
            stock.halt_until = null;
            await stock.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `GM 恢复股票【${stock.name}】交易`,
                stock_id: stockIdNum,
                stock_code: stock.code,
                stock_name: stock.name,
                admin_id: adminId,
                reason: reason || ''
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * GM 触发股价事件
     * @param {number} adminId - 管理员ID
     * @param {Object} params - { stock_id, event_type, impact_pct, duration_hours, description }
     * @returns {Promise<Object>} 创建结果
     */
    static async gmTriggerEvent(adminId, params) {
        const { stock_id, event_type, impact_pct, duration_hours = 24, description = '' } = params;
        if (!event_type) {
            throw new AppError('事件类型不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const impactPct = Number(impact_pct);
        if (isNaN(impactPct) || Math.abs(impactPct) > 0.5) {
            throw new AppError('影响百分比必须在 -0.5 ~ 0.5 之间', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const duration = parseInt(duration_hours);
        if (isNaN(duration) || duration < 1 || duration > 720) {
            throw new AppError('持续时间必须在 1-720 小时之间', 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 校验股票（NULL 表示全市场事件）
        if (stock_id) {
            const stockIdNum = parseInt(stock_id);
            if (isNaN(stockIdNum) || stockIdNum <= 0) {
                throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
            }
            const stock = await Stock.findByPk(stockIdNum);
            if (!stock) {
                throw new AppError('股票不存在', 404, ErrorCodes.NOT_FOUND);
            }
        }

        const now = new Date();
        const event = await StockEvent.create({
            stock_id: stock_id ? parseInt(stock_id) : null,
            event_type,
            impact_pct: impactPct,
            duration_hours: duration,
            triggered_at: now,
            expire_at: new Date(now.getTime() + duration * 60 * 60 * 1000),
            description,
            is_active: true
        });

        return {
            success: true,
            message: `GM 触发股价事件：${event_type}，影响 ${impactPct * 100}%，持续 ${duration} 小时`,
            event_id: event.id,
            admin_id: adminId
        };
    }

    /**
     * GM 强制平仓（指定玩家）
     * @param {number} adminId - 管理员ID
     * @param {number} playerId - 玩家ID
     * @param {string} reason - 操作原因
     * @returns {Promise<Object>} 强平结果
     */
    static async gmForceLiquidate(adminId, playerId, reason) {
        if (!playerId) {
            throw new AppError('玩家 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
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
            // 市价卖出全部持仓
            const holdings = await StockHolding.findAll({
                where: { player_id: playerId, quantity: { [Op.gt]: 0 } },
                transaction: t,
                lock: t.LOCK.UPDATE,
                raw: true
            });
            let totalProceeds = 0n;
            for (const h of holdings) {
                const stock = await Stock.findByPk(h.stock_id, { transaction: t, lock: t.LOCK.UPDATE });
                if (!stock) continue;
                const price = safeBigInt(stock.current_price);
                const qty = safeBigInt(h.quantity);
                const proceeds = price * qty;
                totalProceeds += proceeds;
                await StockHolding.update(
                    { quantity: 0n, available_quantity: 0n, total_cost: 0n, market_value: 0n },
                    { where: { id: h.id }, transaction: t }
                );
                await StockTransaction.create({
                    player_id: playerId,
                    stock_id: h.stock_id,
                    trade_type: 'sell',
                    quantity: qty,
                    price: price,
                    amount: proceeds,
                    fee: 0n,
                    tax: 0n,
                    is_margin: true,
                    status: 'completed'
                }, { transaction: t });
                stock.daily_volume = safeBigInt(stock.daily_volume) + qty;
                await stock.save({ transaction: t });
            }
            // 偿还负债
            const debt = safeBigInt(player.stock_margin_debt);
            const balance = safeBigInt(player.stock_account_balance);
            const totalAvailable = balance + totalProceeds;
            const actualRepay = totalAvailable > debt ? debt : totalAvailable;
            const remainingDebt = debt - actualRepay;
            // 优先用卖出所得偿还
            let remainingProceeds = totalProceeds;
            if (remainingProceeds >= actualRepay) {
                remainingProceeds -= actualRepay;
                player.stock_account_balance = balance + remainingProceeds;
                player.stock_margin_debt = 0n;
            } else {
                const repayFromBalance = actualRepay - remainingProceeds;
                player.stock_account_balance = balance - repayFromBalance;
                player.stock_margin_debt = remainingDebt;
            }
            await player.save({ transaction: t });

            // 更新融资账户
            const marginAccount = await StockMarginAccount.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (marginAccount) {
                marginAccount.debt = remainingDebt;
                marginAccount.is_liquidated = true;
                marginAccount.last_liquidation_check = new Date();
                await marginAccount.save({ transaction: t });
            }
            await t.commit();

            // WebSocket 推送 GM 强平事件
            try {
                WebSocketNotificationService.emitToPlayer(playerId, 'stock:gm_liquidation', {
                    total_proceeds: totalProceeds.toString(),
                    repay_amount: actualRepay.toString(),
                    remaining_debt: remainingDebt.toString(),
                    stock_account_balance: player.stock_account_balance.toString(),
                    admin_id: adminId,
                    reason: reason || '',
                    message: `GM 强制平仓，已卖出全部持仓偿还负债 ${actualRepay.toString()} 灵石`
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'stock_gm_liquidation', {
                    stock_account_balance: player.stock_account_balance.toString(),
                    stock_margin_debt: player.stock_margin_debt.toString()
                });
            } catch (e) {
                console.warn('[StockMarket] WebSocket 推送失败:', e.message);
            }

            return {
                success: true,
                message: `GM 强制平仓玩家 ${player.nickname}，卖出所得 ${totalProceeds.toString()} 灵石，偿还负债 ${actualRepay.toString()} 灵石`,
                player_id: playerId,
                player_nickname: player.nickname,
                total_proceeds: totalProceeds.toString(),
                repay_amount: actualRepay.toString(),
                remaining_debt: remainingDebt.toString(),
                stock_account_balance: player.stock_account_balance.toString(),
                admin_id: adminId,
                reason: reason || ''
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * GM 手动触发指定股票分红
     * @param {number} adminId - 管理员ID
     * @param {number} stockId - 股票ID
     * @param {string} reason - 操作原因
     * @returns {Promise<Object>} 分红结果
     */
    static async gmDistributeDividend(adminId, stockId, reason) {
        const stockIdNum = parseInt(stockId);
        if (isNaN(stockIdNum) || stockIdNum <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const cfg = this._getStockMarketConfig();
        const schedules = cfg.dividend_schedules || {};

        const stock = await Stock.findByPk(stockIdNum, { raw: true });
        if (!stock) {
            throw new AppError('股票不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 根据股票类别确定分红比例
        let scheduleKey = null;
        if (stock.category === 'sect') scheduleKey = 'sect_stock';
        else if (stock.category === 'mine') scheduleKey = 'mine_stock';
        else if (stock.category === 'dungeon') scheduleKey = 'dungeon_stock';
        else if (stock.category === 'event') scheduleKey = 'event_stock';
        const schedule = scheduleKey ? schedules[scheduleKey] : null;
        const ratio = schedule?.ratio || 0.10;

        const currentPrice = safeBigInt(stock.current_price);
        const dividendPerShare = (currentPrice * BigInt(Math.round(ratio * 10000))) / 10000n;
        if (dividendPerShare <= 0n) {
            throw new AppError('每股分红金额为 0，无法派息', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询所有持仓玩家
        const holdings = await StockHolding.findAll({
            where: { stock_id: stockIdNum, quantity: { [Op.gt]: 0 } },
            raw: true
        });

        let distributedCount = 0;
        let totalDividend = 0n;
        const t = await sequelize.transaction();
        try {
            for (const h of holdings) {
                const qty = safeBigInt(h.quantity);
                const totalDividendAmount = qty * dividendPerShare;
                if (totalDividendAmount <= 0n) continue;

                const player = await Player.findByPk(h.player_id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!player || player.is_dead) continue;

                player.stock_account_balance = safeBigInt(player.stock_account_balance) + totalDividendAmount;
                await player.save({ transaction: t });

                await StockDividend.create({
                    player_id: h.player_id,
                    stock_id: stockIdNum,
                    quantity: qty,
                    dividend_per_share: dividendPerShare,
                    total_dividend: totalDividendAmount,
                    dividend_type: 'event'
                }, { transaction: t });

                distributedCount++;
                totalDividend += totalDividendAmount;

                try {
                    WebSocketNotificationService.emitToPlayer(h.player_id, 'stock:dividend', {
                        stock_id: stockIdNum,
                        stock_code: stock.code,
                        stock_name: stock.name,
                        quantity: qty.toString(),
                        dividend_per_share: dividendPerShare.toString(),
                        total_dividend: totalDividendAmount.toString(),
                        dividend_type: 'event',
                        stock_account_balance: player.stock_account_balance.toString(),
                        message: `GM 触发分红：获得【${stock.name}】分红 ${totalDividendAmount.toString()} 灵石`
                    });
                    WebSocketNotificationService.notifyPlayerUpdate(h.player_id, 'stock_dividend', {
                        stock_account_balance: player.stock_account_balance.toString()
                    });
                } catch (e) {
                    console.warn('[StockMarket] WebSocket 推送失败:', e.message);
                }
            }
            await t.commit();
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }

        return {
            success: true,
            message: `GM 触发股票【${stock.name}】分红完成：派发 ${distributedCount} 笔，总金额 ${totalDividend.toString()} 灵石`,
            stock_id: stockIdNum,
            stock_code: stock.code,
            stock_name: stock.name,
            dividend_per_share: dividendPerShare.toString(),
            distributed_count: distributedCount,
            total_dividend: totalDividend.toString(),
            admin_id: adminId,
            reason: reason || ''
        };
    }
}

module.exports = StockMarketService;
