/**
 * 切磋木人调度器服务
 *
 * 负责切磋木人系统的周期性后台任务（参考 SectWarSchedulerService 模式）：
 *   1. daily_ranking_settle（每小时检查一次，跨日触发）：
 *      - 在配置的 ranking_settle_hour:ranking_settle_minute（默认 00:05）之后执行
 *      - 调用 SparringService.settleDailyRanking() 结算"昨日"排行榜奖励
 *      - 通过 lastSettleDate 防止同日重复结算
 *      - settled_at 字段 + Service 内部防重入 = 双重幂等保证
 *
 * 设计原则：
 *   - 配置驱动：结算时间从 sparring_woodman.json 读取（ranking_settle_hour/minute）
 *   - 错误隔离：try/catch 包裹调度逻辑，单次失败不影响下次执行
 *   - 幂等启动：start() 方法可重复调用，已运行则打印日志后返回
 *   - 优雅停止：stop() 清理所有定时器，避免进程无法退出
 *   - 失败重试：结算失败时重置 lastSettleDate 允许下次重试
 *
 * 与 SectWarSchedulerService 的差异：
 *   - 仅 1 个定时任务（每小时检查一次跨日触发）
 *   - 不依赖 game_balance 配置，直接读取 sparring_woodman.json
 *   - 结算目标为"昨日"全部 win 记录（非当日）
 *
 * 玩法文档对照：xiuxian_game_guide.md 第17节·战力与阵法
 *   "排行榜按分数降序，前 10 名有额外奖励（每日 00:05 结算）"
 *
 * @module SparringSchedulerService
 */
'use strict';

const SparringService = require('./SparringService');

/**
 * 切磋木人调度器（单例模式）
 */
class SparringSchedulerService {
    constructor() {
        /** @type {NodeJS.Timeout[]} 定时器句柄列表 */
        this.timers = [];
        /** @type {boolean} 是否正在运行 */
        this.isRunning = false;
        /** @type {string|null} 上次成功结算的日期（YYYY-MM-DD，指"昨日"日期），防止同日重复结算 */
        this.lastSettleDate = null;
        /** @type {number} 调度检查间隔（毫秒），默认 1 小时 */
        this.checkIntervalMs = 3600000;
    }

    /**
     * 读取切磋木人配置中的结算时间配置
     * 每次执行时重新读取，支持热更新
     * @returns {Object} { settleHour, settleMinute }
     */
    _getSettleTimeConfig() {
        try {
            const config = require('../../config/sparring_woodman.json');
            return {
                settleHour: Number(config?.global?.ranking_settle_hour) || 0,
                settleMinute: Number(config?.global?.ranking_settle_minute) || 5
            };
        } catch (e) {
            console.warn('[SparringScheduler] 读取 sparring_woodman.json 失败，使用默认 00:05:', e.message);
            return { settleHour: 0, settleMinute: 5 };
        }
    }

    /**
     * 启动调度任务
     * 幂等：已运行则仅打印日志后返回
     * @returns {Promise<void>}
     */
    async start() {
        if (this.isRunning) {
            console.log('[SparringScheduler] 已在运行，跳过重复启动');
            return;
        }

        const { settleHour, settleMinute } = this._getSettleTimeConfig();
        console.log(`[SparringScheduler] 启动调度器，每日结算时间 ${String(settleHour).padStart(2, '0')}:${String(settleMinute).padStart(2, '0')}，检查间隔 ${this.checkIntervalMs}ms`);

        // 任务1：每小时检查一次，到达结算时间后触发每日排行榜结算
        const settleTimer = setInterval(async () => {
            try {
                await this._checkDailySettle();
            } catch (err) {
                console.error('[SparringScheduler] daily_ranking_settle 异常:', err.message);
            }
        }, this.checkIntervalMs);
        this.timers.push(settleTimer);

        this.isRunning = true;
        console.log('[SparringScheduler] 调度器启动成功，已注册 1 个定时任务');
    }

    /**
     * 停止所有调度任务
     * 清理所有定时器句柄，允许进程优雅退出
     */
    stop() {
        if (!this.isRunning) return;
        for (const timer of this.timers) {
            clearInterval(timer);
        }
        this.timers = [];
        this.isRunning = false;
        console.log('[SparringScheduler] 调度器已停止');
    }

    /**
     * 每日排行榜结算检查
     *
     * 触发条件（同时满足）：
     *   1. 当前时间 ≥ 配置的结算时间（ranking_settle_hour:ranking_settle_minute）
     *   2. 今日尚未成功结算（lastSettleDate !== today）
     *
     * 防重复机制（双重幂等）：
     *   - 调度器层：lastSettleDate 标记今日已触发
     *   - Service 层：PlayerSparring.settled_at 字段防重入（即使调度器误触发，Service 也会跳过）
     *
     * 失败处理：
     *   - 结算失败时重置 lastSettleDate=null，允许下一轮检查重试
     *   - 但 Service 层的防重入机制保证不会重复发放奖励
     *
     * @private
     */
    async _checkDailySettle() {
        const now = new Date();
        const today = now.toISOString().slice(0, 10); // YYYY-MM-DD（UTC）
        // 使用本地时间判定结算时刻（与配置 ranking_settle_hour 一致，配置为本地时间）
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        const { settleHour, settleMinute } = this._getSettleTimeConfig();

        // 检查是否已到达结算时间（小时>settleHour 或 小时==settleHour 且 分钟>=settleMinute）
        const reachedSettleTime = (currentHour > settleHour) ||
            (currentHour === settleHour && currentMinute >= settleMinute);
        if (!reachedSettleTime) {
            return; // 未到结算时间，跳过
        }

        // 今日已成功结算：跳过
        // 说明：lastSettleDate 存储的是"触发结算的今日日期"，与 Service 内部结算的"昨日记录"不冲突
        if (this.lastSettleDate === today) {
            return;
        }

        console.log(`[SparringScheduler] 触发每日排行榜结算，目标日期：昨日，当前时间 ${now.toLocaleString('zh-CN')}`);
        this.lastSettleDate = today;

        try {
            const result = await SparringService.settleDailyRanking();
            console.log(`[SparringScheduler] 每日排行榜结算完成：${result.message}`);
        } catch (err) {
            // 失败则重置标志，允许下一轮检查重试
            // Service 层的 settled_at 防重入机制会保证不会重复发放奖励
            this.lastSettleDate = null;
            console.error('[SparringScheduler] 每日排行榜结算失败，将在下次检查时重试:', err.message);
        }
    }
}

// 导出单例
module.exports = new SparringSchedulerService();
