/**
 * 股市系统玩家端路由（聚宝股市）
 *
 * 提供玩家在股市的行情查询、买卖交易、融资融券、分红查询、资金转入转出接口
 * 业务逻辑全部下沉到 StockMarketService，路由层仅做参数校验和响应封装
 * 所有接口均使用 auth 中间件鉴权，错误统一通过 next(error) 交给全局 errorHandler
 *
 * 路由清单：
 *   1. GET    /status                  - 获取玩家股市状态（账户余额、持仓市值、总资产、负债、保证金率）
 *   2. GET    /stocks                  - 获取所有股票行情列表（含当前价、涨跌幅、成交量、是否熔断）
 *   3. GET    /stocks/:stockId          - 获取股票详情（含 K线、活跃事件）
 *   4. GET    /stocks/:stockId/kline    - 获取 K线数据（1h/1d/1w）
 *   5. GET    /holdings                - 获取玩家持仓列表
 *   6. GET    /transactions             - 获取交易历史（分页）
 *   7. GET    /dividends                - 获取分红历史（分页）
 *   8. GET    /margin                   - 获取融资账户详情
 *   9. POST   /margin/open              - 开通融资账户
 *  10. POST   /margin/repay             - 偿还融资负债
 *  11. POST   /buy                      - 买入股票（支持融资买入）
 *  12. POST   /sell                     - 卖出股票
 *  13. POST   /deposit                  - 从灵石转入股市账户
 *  14. POST   /withdraw                 - 从股市账户转出灵石
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证（auth 中间件）
 *   - 业务错误统一使用 AppError + ErrorCodes 抛出
 *   - 参数校验在路由层完成，业务校验在 Service 层完成
 *   - 灵石金额使用 BIGINT 存储，序列化为字符串避免 JS Number 精度问题
 *   - T+1 结算：买入当日 quantity 增加但 available_quantity 不增加（次日开盘批量解冻）
 *   - 熔断机制：日内涨跌幅超 10% 触发熔断，暂停交易 60 分钟
 *   - 强平机制：维持保证金率低于 30% 触发强平
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const StockMarketService = require('../game/services/StockMarketService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * GET /api/stock/status
 * 获取玩家股市状态
 * 返回：{ balance, holdings_value, total_assets, debt, margin_ratio, is_trading_locked, ... }
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const data = await StockMarketService.getStatus(req.user.id);
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/stock/stocks
 * 获取所有股票行情列表
 * 返回：[{ id, code, name, category, current_price, daily_change_pct, daily_volume, is_trading_halted, ... }]
 */
router.get('/stocks', auth, async (req, res, next) => {
    try {
        const data = await StockMarketService.getStockList();
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/stock/stocks/:stockId
 * 获取股票详情（含 K线、活跃事件）
 * query: period - K线周期（1h/1d/1w），默认 1h
 * 返回：{ id, code, name, current_price, klines, active_events, ... }
 */
router.get('/stocks/:stockId', auth, async (req, res, next) => {
    try {
        const stockId = parseInt(req.params.stockId);
        if (isNaN(stockId) || stockId <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const data = await StockMarketService.getStockDetail(stockId);
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/stock/stocks/:stockId/kline
 * 获取 K线数据
 * query: period - 周期（1h/1d/1w），默认 1h
 * query: limit - 返回条数，默认 30
 * 返回：[{ open, close, high, low, volume, period_start, period_end }]
 */
router.get('/stocks/:stockId/kline', auth, async (req, res, next) => {
    try {
        const stockId = parseInt(req.params.stockId);
        if (isNaN(stockId) || stockId <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const period = req.query.period || '1h';
        const limit = parseInt(req.query.limit) || 30;
        const data = await StockMarketService.getKline(stockId, period, limit);
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/stock/holdings
 * 获取玩家持仓列表（含市值、浮动盈亏、可用数量）
 * 返回：[{ id, stock_id, code, name, quantity, available_quantity, average_cost, market_value, profit, profit_pct, ... }]
 */
router.get('/holdings', auth, async (req, res, next) => {
    try {
        const data = await StockMarketService.getMyHoldings(req.user.id);
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/stock/transactions
 * 获取交易历史（分页）
 * query: { page, limit }
 * 返回：{ list, total, page, page_size, total_pages }
 */
router.get('/transactions', auth, async (req, res, next) => {
    try {
        const data = await StockMarketService.getMyTransactions(req.user.id, {
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 10
        });
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/stock/dividends
 * 获取分红历史（分页）
 * query: { page, limit }
 * 返回：{ list, total, page, page_size, total_pages }
 */
router.get('/dividends', auth, async (req, res, next) => {
    try {
        const data = await StockMarketService.getMyDividends(req.user.id, {
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 10
        });
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/stock/margin
 * 获取融资账户详情
 * 返回：{ has_margin_account, total_assets, balance, holdings_value, debt, margin_ratio, is_liquidated, ... }
 */
router.get('/margin', auth, async (req, res, next) => {
    try {
        const data = await StockMarketService.getMyMarginAccount(req.user.id);
        res.json({ code: 200, message: 'success', data });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/stock/margin/open
 * 开通融资账户
 * 返回：{ success, message, account_id }
 */
router.post('/margin/open', auth, async (req, res, next) => {
    try {
        const result = await StockMarketService.openMarginAccount(req.user.id);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/stock/margin/repay
 * 偿还融资负债
 * body: { amount }
 * 返回：{ success, message, repay_amount, remaining_debt, stock_account_balance }
 */
router.post('/margin/repay', auth, async (req, res, next) => {
    try {
        const { amount } = req.body;
        if (amount === undefined || amount === null) {
            throw new AppError('偿还金额不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await StockMarketService.repayMargin(req.user.id, amount);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/stock/buy
 * 买入股票（支持融资买入）
 * body: { stock_id, quantity, use_margin }
 * 返回：{ success, message, transaction_id, stock_id, quantity, price, amount, fee, ... }
 */
router.post('/buy', auth, async (req, res, next) => {
    try {
        const { stock_id, quantity, use_margin } = req.body;
        if (!stock_id) {
            throw new AppError('股票 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!quantity) {
            throw new AppError('买入数量不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await StockMarketService.buy(
            req.user.id,
            stock_id,
            quantity,
            { useMargin: !!use_margin }
        );
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/stock/sell
 * 卖出股票
 * body: { stock_id, quantity }
 * 返回：{ success, message, transaction_id, stock_id, quantity, price, amount, fee, tax, net_amount, ... }
 */
router.post('/sell', auth, async (req, res, next) => {
    try {
        const { stock_id, quantity } = req.body;
        if (!stock_id) {
            throw new AppError('股票 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!quantity) {
            throw new AppError('卖出数量不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await StockMarketService.sell(
            req.user.id,
            stock_id,
            quantity
        );
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/stock/deposit
 * 从灵石转入股市账户
 * body: { amount }
 * 返回：{ success, message, amount, spirit_stones, stock_account_balance }
 */
router.post('/deposit', auth, async (req, res, next) => {
    try {
        const { amount } = req.body;
        if (amount === undefined || amount === null) {
            throw new AppError('转入金额不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await StockMarketService.deposit(req.user.id, amount);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/stock/withdraw
 * 从股市账户转出灵石
 * body: { amount }
 * 返回：{ success, message, amount, spirit_stones, stock_account_balance }
 */
router.post('/withdraw', auth, async (req, res, next) => {
    try {
        const { amount } = req.body;
        if (amount === undefined || amount === null) {
            throw new AppError('转出金额不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await StockMarketService.withdraw(req.user.id, amount);
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
