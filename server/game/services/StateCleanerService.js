/**
 * 统一状态清理调度器服务（插件式架构版本）
 *
 * 设计目的：
 *   修仙游戏存在多种"进行中"临时状态（闭关/战斗/历练/封禁），
 *   玩家非正常退出（关浏览器/断网/服务重启）会导致状态卡死在数据库里。
 *   本服务作为"自愈机制"，定期扫描过期状态并自动结算/清理。
 *
 * 架构演进：
 *   v1（硬编码版）：在 StateCleanerService 中写死 4 种状态的清理逻辑，每新增玩法都要改本文件
 *   v2（插件式版，当前）：通过 StateRegistry 遍历所有已注册的状态处理器，调用其 cleanExpired
 *                        新增玩法只需在 registrations/ 下新增注册文件，本文件无需修改
 *
 * 监控指标：
 *   - lastRunAt: 上次执行时间
 *   - lastRunDurationMs: 上次执行耗时
 *   - lastRunStats: 上次执行各状态清理统计
 *   - totalRuns: 累计执行次数
 *   - totalErrors: 累计错误次数
 *   - errorRate: 错误率（totalErrors / totalRuns）
 *   通过 getMetrics() 方法暴露，由 /api/admin/state-cleaner/metrics 接口查询
 *
 * 设计原则：
 *   1. 配置驱动：清理间隔和批量大小从 game_balance.json 读取
 *   2. 容错隔离：单个 handler 抛错不影响其他 handler
 *   3. 可观测性：收集监控指标，便于运维排查
 *   4. 开闭原则：新增玩法无需修改本文件
 */
'use strict';

const { infrastructure } = require('../../modules');
const StateRegistry = require('../state/StateRegistry');

const configLoader = infrastructure.ConfigLoader;

/**
 * 读取状态清理配置
 */
function getStateCleanerConfig() {
    return configLoader.getConfig('game_balance')?.state_cleaner || {};
}

/**
 * 读取清理间隔配置
 */
function getCleanerIntervalMs() {
    return configLoader.getConfig('game_balance')?.time_intervals?.state_cleaner_interval_ms || 60000;
}

class StateCleanerService {
    /**
     * 监控指标存储（内存中，服务重启后清零）
     * @type {Object}
     */
    static metrics = {
        lastRunAt: null,           // 上次执行时间 ISO
        lastRunDurationMs: 0,      // 上次执行耗时
        lastRunStats: {},          // 上次执行各状态清理统计
        totalRuns: 0,              // 累计执行次数
        totalErrors: 0,            // 累计错误次数（任一 handler 失败计 1）
        totalItemsCleaned: 0,      // 累计清理项数
        startedAt: new Date().toISOString()  // 服务启动时间
    };

    /**
     * 各状态类型的上次清理时间戳（用于 per-state interval 调度）
     * key: stateType, value: Date ISO string
     * @type {Object}
     */
    static lastCleanedAt = {};

    /**
     * 获取指定状态的清理间隔（毫秒）
     * 优先从 state_cleaner[stateType].interval_ms 读取，未配置则回退到主调度间隔
     * @param {string} stateType - 状态类型
     * @returns {number} 间隔毫秒
     */
    static getStateIntervalMs(stateType) {
        const config = getStateCleanerConfig();
        const stateConfig = config[stateType] || {};
        // 状态级 interval_ms 优先
        if (typeof stateConfig.interval_ms === 'number' && stateConfig.interval_ms > 0) {
            return stateConfig.interval_ms;
        }
        // 回退到主调度间隔
        return getCleanerIntervalMs();
    }

    /**
     * 计算所有状态中最小的清理间隔，作为主调度 tick 间隔
     * 这样高频状态（如移动 5s）能被及时调度，低频状态（如闭关 60s）通过 lastCleanedAt 跳过
     * @returns {number} 主调度间隔毫秒
     */
    static getMasterTickIntervalMs() {
        const states = StateRegistry.list();
        if (states.length === 0) {
            return getCleanerIntervalMs();
        }
        const intervals = states.map(s => this.getStateIntervalMs(s.stateType));
        const minInterval = Math.min(...intervals);
        // 兜底：最小间隔不小于 1s，防止配置错误导致 CPU 空转
        return Math.max(1000, minInterval);
    }

    /**
     * 判断指定状态是否到达本次调度的清理时间
     * @param {string} stateType - 状态类型
     * @returns {boolean} 是否应该在本轮调度中执行清理
     */
    static shouldCleanNow(stateType) {
        const intervalMs = this.getStateIntervalMs(stateType);
        const lastAt = this.lastCleanedAt[stateType];
        if (!lastAt) return true;  // 首次执行
        const elapsed = Date.now() - new Date(lastAt).getTime();
        return elapsed >= intervalMs;
    }

    /**
     * 执行一次清理扫描
     * 通过 StateRegistry 遍历所有已注册的状态处理器，调用其 cleanExpired
     * @param {Object} options - 选项
     * @param {boolean} options.forceAll - 强制所有状态执行（忽略 per-state interval），用于 GM 手动触发
     * @returns {Object} 清理统计 { stateType: { scanned, cleaned, failed }, ... }
     */
    static async runCleanup({ forceAll = false } = {}) {
        const config = getStateCleanerConfig();
        if (config.enable === false) {
            return { skipped: true, reason: 'state_cleaner disabled' };
        }

        const startTime = Date.now();
        const batchSize = config.batch_size || 100;
        const allStats = {};
        const executedStates = [];  // 记录本轮实际执行的状态类型

        // 通过注册中心遍历所有状态处理器，调用 cleanExpired
        // notify 回调用于让各 handler 推送状态变更给在线玩家
        const results = await StateRegistry.mapAll(async (stateType, handler) => {
            // 读取该状态在配置中的子配置（如 seclusion.enable / battle.enable）
            const stateConfig = config[stateType] || {};
            if (stateConfig.enable === false) {
                return { skipped: true, reason: `${stateType} disabled` };
            }

            // per-state interval 检查：非强制模式下，未到清理时间的状态跳过
            if (!forceAll && !this.shouldCleanNow(stateType)) {
                return { skipped: true, reason: 'interval_not_reached' };
            }

            // 构造清理上下文，传递给 handler
            const ctx = {
                batchSize,
                logEach: stateConfig.log_each === true,
                autoComplete: stateConfig.auto_complete === true,
                autoSettle: stateConfig.auto_settle !== false,
                notify: (playerId, event, data) => {
                    try {
                        const WebSocketNotificationService = require('./WebSocketNotificationService');
                        WebSocketNotificationService.notifyPlayerUpdate(playerId, event, data);
                    } catch (e) {
                        // 推送失败不影响清理
                    }
                }
            };

            return await handler.cleanExpired(ctx);
        });

        // 整理统计
        let totalErrors = 0;
        for (const result of results) {
            allStats[result.stateType] = result.result;
            // 记录本轮实际执行的状态（非跳过的）
            if (!result.result?.skipped) {
                executedStates.push(result.stateType);
                // 更新该状态的最后清理时间
                this.lastCleanedAt[result.stateType] = new Date().toISOString();
            }
            if (!result.success) {
                totalErrors += 1;
            }
        }

        // 只在至少有一个状态实际执行时才更新监控指标
        // 避免 5s 主 tick 频繁刷新指标导致 lastRunAt 频繁变化
        if (executedStates.length > 0) {
            const durationMs = Date.now() - startTime;
            this.metrics.lastRunAt = new Date().toISOString();
            this.metrics.lastRunDurationMs = durationMs;
            // 只记录本轮实际执行的状态统计
            this.metrics.lastRunStats = {};
            for (const stateType of executedStates) {
                this.metrics.lastRunStats[stateType] = allStats[stateType];
            }
            this.metrics.totalRuns += 1;
            this.metrics.totalErrors += totalErrors;

            // 累计清理项数（取各 handler 的 settled/cleaned/marked/unbanned 之和）
            let itemsThisRun = 0;
            for (const stateType of executedStates) {
                const stat = allStats[stateType];
                if (!stat || typeof stat !== 'object') continue;
                itemsThisRun += (stat.settled || 0) + (stat.cleaned || 0) + (stat.marked || 0) + (stat.unbanned || 0) + (stat.arrived || 0);
            }
            this.metrics.totalItemsCleaned += itemsThisRun;

            // 输出统计日志
            const summary = executedStates
                .map(type => {
                    const stat = allStats[type];
                    if (!stat) return `${type}:null`;
                    if (stat.skipped) return `${type}:skip`;
                    const cleaned = stat.settled || stat.cleaned || stat.marked || stat.unbanned || stat.arrived || 0;
                    return `${type}:${cleaned}/${stat.scanned || 0}`;
                })
                .join(', ');
            console.log(`[StateCleaner] 清理完成 (${durationMs}ms): ${summary}`);
        }

        return allStats;
    }

    /**
     * 获取监控指标
     * 供 /api/admin/state-cleaner/metrics 接口查询
     * @returns {Object} 监控指标快照
     */
    static getMetrics() {
        const errorRate = this.metrics.totalRuns > 0
            ? this.metrics.totalErrors / this.metrics.totalRuns
            : 0;

        return {
            ...this.metrics,
            errorRate: parseFloat(errorRate.toFixed(4)),
            registeredStates: StateRegistry.list().map(s => ({
                stateType: s.stateType,
                displayName: s.handler.metadata?.displayName,
                stateEnum: s.handler.metadata?.stateEnum,
                exclusive: s.handler.metadata?.exclusive !== false,
                intervalMs: this.getStateIntervalMs(s.stateType),
                lastCleanedAt: this.lastCleanedAt[s.stateType] || null
            })),
            intervalMs: getCleanerIntervalMs(),
            masterTickMs: this.getMasterTickIntervalMs(),
            enabled: getStateCleanerConfig().enable !== false
        };
    }

    /**
     * 启动定时清理调度器
     * 主调度间隔取所有状态中最小的 interval_ms（如移动 5s），
     * 低频状态（如闭关 60s）通过 lastCleanedAt 跳过未到时间的清理。
     * 在 server/index.js 启动时调用
     * @returns {Object} timer 句柄（用于测试时手动停止）
     */
    static start() {
        const masterTickMs = this.getMasterTickIntervalMs();
        console.log(`[StateCleaner] 状态清理调度器已启动 (主调度间隔 ${masterTickMs / 1000}s)`);
        // 输出各状态的清理间隔，便于运维确认配置生效
        const states = StateRegistry.list();
        for (const s of states) {
            const interval = this.getStateIntervalMs(s.stateType);
            console.log(`[StateCleaner]   - ${s.stateType}: 间隔 ${interval / 1000}s`);
        }

        const timer = setInterval(async () => {
            try {
                await this.runCleanup();
            } catch (err) {
                console.error('[StateCleaner] 调度器执行异常:', err.message);
                this.metrics.totalErrors += 1;
            }
        }, masterTickMs);

        // 启动时立即执行一次（不等待第一个 tick），快速清理服务重启遗留的状态
        setTimeout(async () => {
            try {
                console.log('[StateCleaner] 启动时首次清理扫描');
                await this.runCleanup({ forceAll: true });
            } catch (err) {
                console.error('[StateCleaner] 启动首次清理失败:', err.message);
            }
        }, 0);

        return timer;
    }
}

module.exports = StateCleanerService;
