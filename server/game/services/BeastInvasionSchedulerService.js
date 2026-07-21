/**
 * 妖兽入侵调度器服务
 *
 * 负责妖兽入侵系统的所有周期性后台任务（参考 WorldBossSchedulerService 模式）：
 *   1. expire_check（默认 5s）：检查 active 状态的妖兽入侵事件是否到达阶段超时
 *      - 捐献阶段超时未达标 → status=expired（妖兽自行散去）
 *      - 战斗阶段超时未击杀 → status=escaped（妖兽破阵逃脱）
 *   2. phase_check（默认 5s）：兜底阶段切换检查（正常由 contribute 内部即时触发，此处为服务重启后补偿）
 *
 * 设计原则：
 *   - 配置驱动：所有间隔从 game_balance.beast_invasion.state_cleaner_interval_ms 读取，支持热更新
 *   - 错误隔离：每个任务用 try/catch 包裹，单任务失败不影响其他任务
 *   - 幂等启动：start() 方法可重复调用，已运行则打印日志后返回
 *   - 优雅停止：stop() 清理所有定时器，避免进程无法退出
 *   - 间隔兜底：配置缺失时使用默认值（5s）
 *
 * 与 WorldBossSchedulerService 的差异：
 *   - 妖兽入侵无 spawn_schedule 自动刷新机制（避免与已运行事件冲突），刷新由 GM 调用 spawnInvasion
 *   - 妖兽入侵无赛季概念（用 season_id=0 占位），故无 season_check 任务
 *   - 调度间隔统一使用 state_cleaner_interval_ms，与项目状态清理规范一致
 *
 * @module BeastInvasionSchedulerService
 */
'use strict';

const BeastInvasionService = require('./BeastInvasionService');
const { infrastructure } = require('../../modules');

// 配置加载器单例
const configLoader = infrastructure.ConfigLoader;

/**
 * 妖兽入侵调度器（单例模式）
 */
class BeastInvasionSchedulerService {
    constructor() {
        /** @type {NodeJS.Timeout[]} 定时器句柄列表 */
        this.timers = [];
        /** @type {boolean} 是否正在运行 */
        this.isRunning = false;
    }

    /**
     * 读取调度器配置（每次执行时重新读取，支持热更新）
     * @returns {Object} 调度间隔配置
     */
    _getConfig() {
        const cfg = configLoader?.getConfig('game_balance')?.beast_invasion || {};
        // 统一使用 state_cleaner_interval_ms 作为调度间隔（默认 5 秒）
        // 与项目状态清理规范一致（项目记忆：所有状态清理间隔统一为 5 秒）
        const interval = typeof cfg.state_cleaner_interval_ms === 'number'
            ? cfg.state_cleaner_interval_ms
            : 5000;
        return {
            expire_check: interval,
            phase_check: interval
        };
    }

    /**
     * 启动所有调度任务
     * 幂等：已运行则仅打印日志后返回
     * @returns {Promise<void>}
     */
    async start() {
        if (this.isRunning) {
            console.log('[BeastInvasionScheduler] 已在运行，跳过重复启动');
            return;
        }

        const cfg = this._getConfig();
        console.log('[BeastInvasionScheduler] 启动调度器，配置:', cfg);

        // 任务1：阶段超时检查（捐献阶段超时 / 战斗阶段超时）
        const expireTimer = setInterval(async () => {
            try {
                await this._checkExpiredInvasions();
            } catch (err) {
                console.error('[BeastInvasionScheduler] expire_check 异常:', err.message);
            }
        }, cfg.expire_check);
        this.timers.push(expireTimer);

        // 任务2：兜底阶段切换检查（正常由 contribute 即时触发，此处为服务重启后的补偿）
        const phaseTimer = setInterval(async () => {
            try {
                await this._checkPhaseTransitions();
            } catch (err) {
                console.error('[BeastInvasionScheduler] phase_check 异常:', err.message);
            }
        }, cfg.phase_check);
        this.timers.push(phaseTimer);

        this.isRunning = true;
        console.log('[BeastInvasionScheduler] 调度器启动成功，已注册 2 个定时任务');
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
        console.log('[BeastInvasionScheduler] 调度器已停止');
    }

    /**
     * 检查过期的妖兽入侵事件
     * 调用 BeastInvasionService.checkExpired 处理：
     *   - 捐献阶段超时未达标 → status=expired
     *   - 战斗阶段超时未击杀 → status=escaped
     * @private
     */
    async _checkExpiredInvasions() {
        const result = await BeastInvasionService.checkExpired();
        if (result.expired_count > 0 || result.escaped_count > 0) {
            console.log(`[BeastInvasionScheduler] 阶段超时处理：${result.expired_count} 个事件散去，${result.escaped_count} 个事件逃脱`);
        }
    }

    /**
     * 兜底阶段切换检查
     * 正常情况下阶段切换由 contribute 内部即时触发；
     * 此处用于服务重启后或调度遗漏场景下的补偿检查
     * 实际检查逻辑由 BeastInvasionService.checkExpired 内部处理（已达标但 phase 仍为 donation 的情况）
     * 此处仅作为调度框架占位，便于后续扩展
     * @private
     */
    async _checkPhaseTransitions() {
        // 当前实现仅依赖 checkExpired 内部的 _switchToBattlePhase 兜底
        // 此处保留方法占位，避免后续扩展时修改 start() 结构
    }
}

// 导出单例
module.exports = new BeastInvasionSchedulerService();
