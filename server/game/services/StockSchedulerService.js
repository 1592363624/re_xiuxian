/**
 * 股市定时任务调度器
 *
 * 负责调度股市系统的三类定时任务：
 *   1. 价格更新任务：按 price_update_interval_minutes 周期执行，更新股价、检测熔断、生成K线
 *   2. 强平检查任务：按 force_liquidation_check_interval_ms 周期执行，检查融资账户保证金率
 *   3. 利息计算任务：按 margin_interest_check_interval_ms 周期执行，对融资负债收取日利息
 *   4. 分红派息任务：每日检查（固定每天 00:05 执行一次）
 *
 * 设计说明：
 *   - 启动时调用 StockMarketService._initializeStocksIfEmpty() 初始化股票（首次启动）
 *   - 价格更新任务用「每分钟检查 + 按配置周期执行」模式，支持热更新配置
 *   - 任务执行时打印日志，错误用 try/catch 隔离，避免单次失败影响后续调度
 *   - 提供 start() / stop() 方法，便于在 server/index.js 中统一管理
 *   - 所有阈值/间隔从 game_balance.stock_market 读取，禁止硬编码
 */
'use strict';

const StockMarketService = require('./StockMarketService');
const { infrastructure } = require('../../modules');

const configLoader = infrastructure.ConfigLoader;

class StockSchedulerService {
    constructor() {
        this.timers = [];
        this.isRunning = false;
        // 价格更新：上次执行时间戳（用于按周期执行）
        this.lastPriceUpdateAt = 0;
        // 分红：上次执行日期（YYYY-MM-DD）
        this.lastDividendDate = null;
    }

    /**
     * 读取股市配置
     * @returns {Object} 股市配置对象
     */
    _getConfig() {
        return configLoader?.getConfig('game_balance')?.stock_market || {};
    }

    /**
     * 启动调度器
     * 注册所有定时任务，幂等：重复调用不会重复启动
     */
    async start() {
        if (this.isRunning) {
            console.warn('[StockScheduler] 调度器已在运行，跳过重复启动');
            return;
        }
        this.isRunning = true;

        // 启动时初始化股票（若表为空则从 stock_data.json 初始化 12 只股票）
        try {
            await StockMarketService._initializeStocksIfEmpty();
        } catch (e) {
            console.error('[StockScheduler] 初始化股票失败:', e.message);
        }

        const cfg = this._getConfig();

        // ===== 1. 价格更新检查器（每 60 秒检查一次，按配置周期执行） =====
        // 设计：用 1 分钟轮询代替 setInterval(长间隔)，便于热更新配置
        const priceCheckInterval = 60 * 1000;
        const priceTimer = setInterval(async () => {
            try {
                const currentCfg = this._getConfig();
                if (currentCfg.enabled === false) return;
                const periodMs = (currentCfg.price_update_interval_minutes || 60) * 60 * 1000;
                const now = Date.now();
                if (now - this.lastPriceUpdateAt >= periodMs) {
                    this.lastPriceUpdateAt = now;
                    console.log('[StockScheduler] 触发价格更新任务');
                    await StockMarketService.updateStockPrices();
                }
            } catch (e) {
                console.error('[StockScheduler] 价格更新任务异常:', e.message);
            }
        }, priceCheckInterval);
        this.timers.push(priceTimer);

        // ===== 2. 强平检查任务 =====
        const liquidationInterval = cfg.force_liquidation_check_interval_ms || 60000;
        const liquidationTimer = setInterval(async () => {
            try {
                await StockMarketService.checkMarginAccounts();
            } catch (e) {
                console.error('[StockScheduler] 强平检查任务异常:', e.message);
            }
        }, liquidationInterval);
        this.timers.push(liquidationTimer);

        // ===== 3. 利息计算任务 =====
        const interestInterval = cfg.margin_interest_check_interval_ms || 86400000;
        const interestTimer = setInterval(async () => {
            try {
                await StockMarketService.chargeMarginInterest();
            } catch (e) {
                console.error('[StockScheduler] 利息计算任务异常:', e.message);
            }
        }, interestInterval);
        this.timers.push(interestTimer);

        // ===== 4. 分红派息任务（每小时检查一次，仅在跨日时执行） =====
        const dividendTimer = setInterval(async () => {
            try {
                const now = new Date();
                const today = now.toISOString().slice(0, 10);
                // 仅在跨日且时间超过 00:00 时执行（避免在 23:59 触发）
                if (this.lastDividendDate !== today && now.getHours() >= 0) {
                    this.lastDividendDate = today;
                    console.log('[StockScheduler] 触发分红派息任务');
                    await StockMarketService.processDividends();
                }
            } catch (e) {
                console.error('[StockScheduler] 分红派息任务异常:', e.message);
            }
        }, 60 * 60 * 1000); // 每小时检查一次
        this.timers.push(dividendTimer);

        // 初始化 lastDividendDate 避免启动即触发
        this.lastDividendDate = new Date().toISOString().slice(0, 10);

        console.log('[StockScheduler] 股市定时任务调度器已启动');
        console.log(`[StockScheduler]   - 价格更新周期: ${cfg.price_update_interval_minutes || 60} 分钟`);
        console.log(`[StockScheduler]   - 强平检查间隔: ${cfg.force_liquidation_check_interval_ms || 60000} ms`);
        console.log(`[StockScheduler]   - 利息计算间隔: ${cfg.margin_interest_check_interval_ms || 86400000} ms`);
        console.log('[StockScheduler]   - 分红派息: 每天 00:00 检查');
    }

    /**
     * 停止调度器
     * 清理所有定时器，幂等：重复调用安全
     */
    stop() {
        if (!this.isRunning) return;
        for (const timer of this.timers) {
            clearInterval(timer);
        }
        this.timers = [];
        this.isRunning = false;
        console.log('[StockScheduler] 股市定时任务调度器已停止');
    }
}

module.exports = new StockSchedulerService();
