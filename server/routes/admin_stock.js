/**
 * 股市管理路由（GM 后台）
 *
 * 提供以下接口：
 *   1. GET    /metrics                              - 股市统计指标（玩家数、持仓数、总市值、今日交易额）
 *   2. GET    /stocks                               - 所有股票列表（含管理字段）
 *   3. GET    /stocks/:stockId                      - 股票详情
 *   4. PUT    /stocks/:stockId/price                - GM 调整股价
 *   5. POST   /stocks/:stockId/halt                 - GM 暂停交易
 *   6. POST   /stocks/:stockId/resume               - GM 恢复交易
 *   7. POST   /events                                - GM 触发股价事件
 *   8. GET    /margin/list                            - 所有融资账户列表（分页）
 *   9. POST   /margin/:playerId/force-liquidate       - GM 强制平仓
 *  10. GET    /transactions                          - 全服交易流水（分页，支持 player_id/stock_id 筛选）
 *  11. POST   /dividends/distribute                  - GM 手动触发分红
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证 + admin 权限（auth + adminCheck 双层中间件）
 *   - 业务逻辑调用 StockMarketService，使用事务保证数据一致性
 *   - 所有写操作记录到 admin_logs 表，便于审计追溯
 *   - 使用 AppError + ErrorCodes 抛错，由全局 errorHandler 统一处理
 *   - 阈值（分页大小、查询上限）从 game_balance.admin 读取，不硬编码
 *
 * 路由顺序说明：
 *   静态路径（/metrics、/stocks、/events、/margin/list、/transactions、/dividends）
 *   必须定义在动态参数路由 /:stockId 之前，避免被误匹配。
 */
'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { fn, col } = require('sequelize');

// 中间件、模型与基础设施
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const Player = require('../models/player');
const Stock = require('../models/stock');
const StockHolding = require('../models/stockHolding');
const StockTransaction = require('../models/stockTransaction');
const StockMarginAccount = require('../models/stockMarginAccount');
const StockDividend = require('../models/stockDividend');
const StockEvent = require('../models/stockEvent');
const StockMarketService = require('../game/services/StockMarketService');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 通过 ConfigLoader 获取 game_balance 配置（支持热更新，避免硬编码阈值）
const configLoader = infrastructure.ConfigLoader;

/**
 * 读取 game_balance.admin 配置节
 * @returns {Object} admin 配置对象（若未加载则返回空对象，调用方使用默认值兜底）
 */
function getAdminConfig() {
    return configLoader?.getConfig('game_balance')?.admin || {};
}

/**
 * GM 权限校验中间件
 * 复用 admin_pawnshop.js 中的 adminCheck 逻辑：检查 req.player.role === 'admin'
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 写入管理员操作日志（封装，避免代码重复）
 * 日志写入失败不应阻塞主流程，仅打印警告
 * @param {Object} params - { adminId, action, targetId, detail, req }
 */
async function logAdminAction({ adminId, action, targetId = null, detail = '', req = null }) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action: action,
            target_id: targetId,
            details: JSON.stringify({ detail }),
            ip: req?.ip || req?.connection?.remoteAddress || null
        });
    } catch (e) {
        // 日志写入失败不应阻塞主流程，仅打印警告
        console.error('[admin_stock] 写入操作日志失败:', e.message);
    }
}

/**
 * BIGINT 安全转换工具
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    return BigInt(String(value));
}

/**
 * GET /api/admin/stock/metrics
 * 股市统计指标
 * 返回：玩家数、持仓数、总市值、今日交易额、活跃事件数
 */
router.get('/metrics', auth, adminCheck, async (req, res, next) => {
    try {
        // 活跃股票数
        const activeStockCount = await Stock.count({ where: { is_active: true } });
        // 熔断中股票数
        const haltedCount = await Stock.count({ where: { is_trading_halted: true } });
        // 持仓玩家数（去重）
        const holdersCount = await StockHolding.count({
            distinct: true,
            col: 'player_id',
            where: { quantity: { [Op.gt]: 0 } }
        });
        // 总持仓市值（用 SQL 聚合）
        const holdingsSum = await StockHolding.findAll({
            attributes: [[fn('SUM', col('market_value')), 'total']],
            raw: true
        });
        const totalHoldingsValue = safeBigInt(holdingsSum[0]?.total);

        // 今日交易额
        const today = new Date().toISOString().slice(0, 10);
        const todayTx = await StockTransaction.findAll({
            where: { created_at: { [Op.gte]: new Date(`${today}T00:00:00`) } },
            attributes: ['amount', 'trade_type'],
            raw: true
        });
        const todayBuyAmount = todayTx.filter(t => t.trade_type === 'buy').reduce((s, t) => s + safeBigInt(t.amount), 0n);
        const todaySellAmount = todayTx.filter(t => t.trade_type === 'sell').reduce((s, t) => s + safeBigInt(t.amount), 0n);
        const todayTxCount = todayTx.length;

        // 融资账户统计
        const marginAccountsCount = await StockMarginAccount.count();
        const liquidatedCount = await StockMarginAccount.count({ where: { is_liquidated: true } });
        const debtSum = await StockMarginAccount.findAll({
            attributes: [[fn('SUM', col('debt')), 'total']],
            raw: true
        });
        const totalDebt = safeBigInt(debtSum[0]?.total);

        // 活跃事件数
        const now = new Date();
        const activeEventsCount = await StockEvent.count({
            where: { is_active: true, expire_at: { [Op.gt]: now } }
        });

        res.json({
            code: 200,
            message: 'success',
            data: {
                stocks: {
                    active: activeStockCount,
                    halted: haltedCount
                },
                holders_count: holdersCount,
                total_holdings_value: totalHoldingsValue.toString(),
                today_transactions: {
                    count: todayTxCount,
                    buy_amount: todayBuyAmount.toString(),
                    sell_amount: todaySellAmount.toString()
                },
                margin: {
                    accounts_count: marginAccountsCount,
                    liquidated_count: liquidatedCount,
                    total_debt: totalDebt.toString()
                },
                active_events_count: activeEventsCount
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/stock/stocks
 * 所有股票列表（含管理字段）
 * query: { page, limit, category }
 * 返回：{ list, total, page, page_size, total_pages }
 */
router.get('/stocks', auth, adminCheck, async (req, res, next) => {
    try {
        const adminConfig = getAdminConfig();
        const pageSize = Math.min(
            parseInt(req.query.limit) || adminConfig.cave_list_page_size || 20,
            adminConfig.cave_list_max_page_size || 100
        );
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const offset = (page - 1) * pageSize;

        const where = {};
        if (req.query.category) {
            const allowedCategories = ['sect', 'mine', 'dungeon', 'event'];
            if (allowedCategories.includes(req.query.category)) {
                where.category = req.query.category;
            }
        }

        const { count, rows } = await Stock.findAndCountAll({
            where,
            order: [['id', 'ASC']],
            limit: pageSize,
            offset,
            raw: true
        });

        const list = rows.map(r => ({
            id: r.id,
            code: r.code,
            name: r.name,
            category: r.category,
            current_price: safeBigInt(r.current_price).toString(),
            open_price: safeBigInt(r.open_price).toString(),
            yesterday_close_price: safeBigInt(r.yesterday_close_price).toString(),
            daily_change_pct: Number(r.daily_change_pct),
            daily_volume: safeBigInt(r.daily_volume).toString(),
            total_shares: safeBigInt(r.total_shares).toString(),
            float_shares: safeBigInt(r.float_shares).toString(),
            base_volatility: Number(r.base_volatility),
            is_trading_halted: !!r.is_trading_halted,
            halt_until: r.halt_until,
            description: r.description,
            is_active: !!r.is_active,
            last_price_update: r.last_price_update,
            created_at: r.created_at,
            updated_at: r.updated_at
        }));

        res.json({
            code: 200,
            message: 'success',
            data: {
                list,
                total: count,
                page,
                page_size: pageSize,
                total_pages: Math.ceil(count / pageSize)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/stock/transactions
 * 全服交易流水（分页，支持 player_id/stock_id 筛选）
 * query: { page, limit, player_id, stock_id, trade_type }
 */
router.get('/transactions', auth, adminCheck, async (req, res, next) => {
    try {
        const adminConfig = getAdminConfig();
        const pageSize = Math.min(
            parseInt(req.query.limit) || adminConfig.cave_list_page_size || 20,
            adminConfig.cave_list_max_page_size || 100
        );
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const offset = (page - 1) * pageSize;

        const where = {};
        if (req.query.player_id) {
            const pid = parseInt(req.query.player_id);
            if (!isNaN(pid) && pid > 0) where.player_id = pid;
        }
        if (req.query.stock_id) {
            const sid = parseInt(req.query.stock_id);
            if (!isNaN(sid) && sid > 0) where.stock_id = sid;
        }
        // 交易类型白名单校验
        const allowedTypes = ['buy', 'sell'];
        if (req.query.trade_type && allowedTypes.includes(req.query.trade_type)) {
            where.trade_type = req.query.trade_type;
        }

        const { count, rows } = await StockTransaction.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        // 批量查询玩家和股票信息
        const playerIds = [...new Set(rows.map(r => r.player_id))];
        const stockIds = [...new Set(rows.map(r => r.stock_id))];
        let playerMap = new Map();
        let stockMap = new Map();
        if (playerIds.length > 0) {
            const players = await Player.findAll({
                attributes: ['id', 'nickname', 'realm'],
                where: { id: playerIds }
            });
            playerMap = new Map(players.map(p => [p.id, p]));
        }
        if (stockIds.length > 0) {
            const stocks = await Stock.findAll({
                attributes: ['id', 'code', 'name'],
                where: { id: stockIds }
            });
            stockMap = new Map(stocks.map(s => [s.id, s]));
        }

        const list = rows.map(r => {
            const player = playerMap.get(r.player_id);
            const stock = stockMap.get(r.stock_id);
            return {
                id: r.id,
                player_id: r.player_id,
                player_nickname: player?.nickname || '未知道友',
                player_realm: player?.realm || '凡人',
                stock_id: r.stock_id,
                stock_code: stock?.code || '',
                stock_name: stock?.name || '',
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

        res.json({
            code: 200,
            message: 'success',
            data: {
                list,
                total: count,
                page,
                page_size: pageSize,
                total_pages: Math.ceil(count / pageSize)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/stock/margin/list
 * 所有融资账户列表（分页）
 * query: { page, limit, is_liquidated }
 */
router.get('/margin/list', auth, adminCheck, async (req, res, next) => {
    try {
        const adminConfig = getAdminConfig();
        const pageSize = Math.min(
            parseInt(req.query.limit) || adminConfig.cave_list_page_size || 20,
            adminConfig.cave_list_max_page_size || 100
        );
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const offset = (page - 1) * pageSize;

        const where = {};
        if (req.query.is_liquidated === 'true') where.is_liquidated = true;
        else if (req.query.is_liquidated === 'false') where.is_liquidated = false;

        const { count, rows } = await StockMarginAccount.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        // 批量查询玩家信息
        const playerIds = [...new Set(rows.map(r => r.player_id))];
        let playerMap = new Map();
        if (playerIds.length > 0) {
            const players = await Player.findAll({
                attributes: ['id', 'nickname', 'realm', 'stock_account_balance', 'stock_margin_debt'],
                where: { id: playerIds }
            });
            playerMap = new Map(players.map(p => [p.id, p]));
        }

        const list = rows.map(r => {
            const player = playerMap.get(r.player_id);
            return {
                id: r.id,
                player_id: r.player_id,
                player_nickname: player?.nickname || '未知道友',
                player_realm: player?.realm || '凡人',
                total_assets: safeBigInt(r.total_assets).toString(),
                debt: safeBigInt(r.debt).toString(),
                margin_ratio: Number(r.margin_ratio),
                is_liquidated: !!r.is_liquidated,
                last_liquidation_check: r.last_liquidation_check,
                // 实时数据来自 player 表
                player_stock_account_balance: player ? safeBigInt(player.stock_account_balance).toString() : '0',
                player_stock_margin_debt: player ? safeBigInt(player.stock_margin_debt).toString() : '0',
                created_at: r.created_at
            };
        });

        res.json({
            code: 200,
            message: 'success',
            data: {
                list,
                total: count,
                page,
                page_size: pageSize,
                total_pages: Math.ceil(count / pageSize)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/stock/stocks/:stockId
 * 股票详情
 */
router.get('/stocks/:stockId', auth, adminCheck, async (req, res, next) => {
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
 * PUT /api/admin/stock/stocks/:stockId/price
 * GM 调整股价
 * body: { new_price, reason }
 */
router.put('/stocks/:stockId/price', auth, adminCheck, async (req, res, next) => {
    try {
        const stockId = parseInt(req.params.stockId);
        if (isNaN(stockId) || stockId <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const { new_price, reason } = req.body;
        if (new_price === undefined || new_price === null) {
            throw new AppError('新价格不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await StockMarketService.gmAdjustPrice(
            req.player.id,
            stockId,
            new_price,
            reason
        );
        await logAdminAction({
            adminId: req.player.id,
            action: 'stock_adjust_price',
            targetId: stockId,
            detail: `GM 调整股票 #${stockId} 价格：${result.old_price} -> ${result.new_price}，原因: ${reason || ''}`,
            req
        });
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/stock/stocks/:stockId/halt
 * GM 暂停交易
 * body: { duration_minutes, reason }
 */
router.post('/stocks/:stockId/halt', auth, adminCheck, async (req, res, next) => {
    try {
        const stockId = parseInt(req.params.stockId);
        if (isNaN(stockId) || stockId <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const { duration_minutes, reason } = req.body;
        const result = await StockMarketService.gmHaltStock(
            req.player.id,
            stockId,
            duration_minutes,
            reason
        );
        await logAdminAction({
            adminId: req.player.id,
            action: 'stock_halt',
            targetId: stockId,
            detail: `GM 暂停股票 #${stockId} 交易 ${duration_minutes} 分钟，原因: ${reason || ''}`,
            req
        });
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/stock/stocks/:stockId/resume
 * GM 恢复交易
 * body: { reason }
 */
router.post('/stocks/:stockId/resume', auth, adminCheck, async (req, res, next) => {
    try {
        const stockId = parseInt(req.params.stockId);
        if (isNaN(stockId) || stockId <= 0) {
            throw new AppError('股票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const { reason } = req.body;
        const result = await StockMarketService.gmResumeStock(
            req.player.id,
            stockId,
            reason
        );
        await logAdminAction({
            adminId: req.player.id,
            action: 'stock_resume',
            targetId: stockId,
            detail: `GM 恢复股票 #${stockId} 交易，原因: ${reason || ''}`,
            req
        });
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/stock/events
 * GM 触发股价事件
 * body: { stock_id, event_type, impact_pct, duration_hours, description }
 */
router.post('/events', auth, adminCheck, async (req, res, next) => {
    try {
        const result = await StockMarketService.gmTriggerEvent(req.player.id, req.body);
        await logAdminAction({
            adminId: req.player.id,
            action: 'stock_trigger_event',
            targetId: req.body.stock_id ? parseInt(req.body.stock_id) : null,
            detail: `GM 触发股价事件：${req.body.event_type}，影响 ${req.body.impact_pct}，持续 ${req.body.duration_hours || 24} 小时，原因: ${req.body.description || ''}`,
            req
        });
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/stock/margin/:playerId/force-liquidate
 * GM 强制平仓
 * body: { reason }
 */
router.post('/margin/:playerId/force-liquidate', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId);
        if (isNaN(playerId) || playerId <= 0) {
            throw new AppError('玩家 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const { reason } = req.body;
        const result = await StockMarketService.gmForceLiquidate(
            req.player.id,
            playerId,
            reason
        );
        await logAdminAction({
            adminId: req.player.id,
            action: 'stock_force_liquidate',
            targetId: playerId,
            detail: `GM 强制平仓玩家 ${playerId}，卖出所得 ${result.total_proceeds}，偿还负债 ${result.repay_amount}，原因: ${reason || ''}`,
            req
        });
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/stock/dividends/distribute
 * GM 手动触发分红
 * body: { stock_id, reason }
 */
router.post('/dividends/distribute', auth, adminCheck, async (req, res, next) => {
    try {
        const { stock_id, reason } = req.body;
        if (!stock_id) {
            throw new AppError('股票 ID 不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await StockMarketService.gmDistributeDividend(
            req.player.id,
            stock_id,
            reason
        );
        await logAdminAction({
            adminId: req.player.id,
            action: 'stock_distribute_dividend',
            targetId: parseInt(stock_id),
            detail: `GM 触发股票 #${stock_id} 分红：派发 ${result.distributed_count} 笔，总金额 ${result.total_dividend}，原因: ${reason || ''}`,
            req
        });
        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
