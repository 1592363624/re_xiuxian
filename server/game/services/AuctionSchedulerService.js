/**
 * 拍卖系统调度器服务
 *
 * 设计依据：xiuxian_game_guide.md 第27节·市场、股市与资产路线
 *   `.拍卖`  查看拍卖列表
 *
 * 系统定位：
 *   拍卖系统的后台自动结算调度器，独立于 HTTP 请求周期运行。
 *   每隔 N 毫秒（默认 30s，由 auction_data.json.scheduler.settle_check_interval_ms 配置）
 *   批量查询所有 status=open 且 end_at <= now 的拍卖，逐个独立事务结算。
 *
 * 核心职责：
 *   1. 周期性扫描到期拍卖，调用 AuctionService.settleExpiredAuctions()
 *   2. 单例模式：整个应用生命周期内仅运行一个调度器实例
 *   3. 容错：单次调度失败不影响下次调度（try-catch 包裹）
 *   4. 优雅停止：stop() 方法清除定时器，支持测试与重启
 *
 * 架构原则：
 *   - 调度器只负责"触发"，业务逻辑全部下沉到 AuctionService
 *   - 配置驱动：调度周期通过 configLoader 热加载，无需改代码
 *   - 日志可控：仅在发生结算或异常时输出日志，避免无谓刷屏
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const AuctionService = require('./AuctionService');

class AuctionSchedulerService {
    constructor() {
        this.timer = null;          // setInterval 句柄
        this.running = false;       // 是否正在执行结算（防止重入）
        this.configLoader = null;   // 配置加载器引用
    }

    /**
     * 获取调度器配置
     * @returns {Object} 调度器配置子集
     * @private
     */
    _getSchedulerConfig() {
        const cfg = this.configLoader?.getConfig('auction_data') || {};
        return cfg.scheduler || { settle_check_interval_ms: 30000, batch_size: 50 };
    }

    /**
     * 启动调度器
     * 幂等：重复调用 start() 不会启动多个定时器
     * @param {Object} [configLoader] - 可选的配置加载器（若未传入则使用 AuctionService 内部已初始化的引用）
     * @returns {Promise<boolean>} 是否启动成功
     */
    async start(configLoader) {
        // 幂等保护：已启动则直接返回
        if (this.timer) {
            console.log('[AuctionScheduler] 调度器已在运行，跳过重复启动');
            return true;
        }

        // 注入配置加载器（优先使用传入参数，回退到 AuctionService 持有的引用）
        if (configLoader) {
            this.configLoader = configLoader;
        }

        // 首次启动前先跑一次结算，避免服务重启后遗留的到期拍卖等待 30 秒
        try {
            const initResult = await AuctionService.settleExpiredAuctions();
            if (initResult.settled > 0 || initResult.failed > 0) {
                console.log(`[AuctionScheduler] 启动时结算：成功 ${initResult.settled} 个，失败 ${initResult.failed} 个`);
            }
        } catch (err) {
            console.error('[AuctionScheduler] 启动时结算失败:', err.message);
        }

        // 读取调度周期（支持热更新：每次 tick 时重新读取，但 interval 本身不变更；如需动态调整周期需 stop+start）
        const schedulerCfg = this._getSchedulerConfig();
        const intervalMs = schedulerCfg.settle_check_interval_ms || 30000;

        this.timer = setInterval(async () => {
            await this._tick();
        }, intervalMs);

        console.log(`[AuctionScheduler] 调度器已启动，结算检查间隔 ${intervalMs}ms`);
        return true;
    }

    /**
     * 单次调度执行（内部方法）
     * 使用 running 标志位防止重入：若上一轮结算尚未完成，本轮跳过
     * @returns {Promise<void>}
     * @private
     */
    async _tick() {
        // 重入保护：上一轮还没跑完则跳过本次
        if (this.running) {
            return;
        }
        this.running = true;
        try {
            const result = await AuctionService.settleExpiredAuctions();
            // 仅在有结算动作时输出日志，避免无谓刷屏
            if (result.settled > 0 || result.failed > 0) {
                console.log(`[AuctionScheduler] 本轮结算：成功 ${result.settled}，失败 ${result.failed}`);
                // 失败明细输出到 error 级别，便于排查
                for (const detail of result.details) {
                    if (detail.status === 'error') {
                        console.error(`[AuctionScheduler] 拍卖 ${detail.auction_id} 结算失败: ${detail.message}`);
                    }
                }
            }
        } catch (err) {
            console.error('[AuctionScheduler] 调度执行异常:', err.message);
        } finally {
            this.running = false;
        }
    }

    /**
     * 停止调度器
     * 清除定时器，等待当前 tick 完成（非阻塞）
     * @returns {void}
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            console.log('[AuctionScheduler] 调度器已停止');
        }
    }

    /**
     * 获取调度器状态（供 GM/调试使用）
     * @returns {Object} 状态对象
     */
    getStatus() {
        return {
            running: this.timer !== null,
            busy: this.running,
            interval_ms: this._getSchedulerConfig().settle_check_interval_ms || 30000
        };
    }
}

// 单例导出：整个应用生命周期内共享同一调度器实例
module.exports = new AuctionSchedulerService();
