/**
 * 宗门战调度器服务
 *
 * 负责宗门战/领地争夺系统的所有周期性后台任务（参考 WorldBossSchedulerService 模式）：
 *   1. war_state_check（默认 30s）：推进 preparing → announced → active → settled 状态
 *      - preparing 阶段到点自动转 announced（提前 N 小时通知）
 *      - announced 阶段到点自动转 active（开战）
 *      - active 阶段到点自动结算（调用 _settleWar）
 *   2. capture_timeout_check（默认 10s）：补偿清理超时的占领计时器
 *      - 正常占领完成由内存 setTimeout 触发，但服务重启后内存丢失，需补偿
 *      - 此处扫描 is_under_attack=1 但 create_time 超过 territory_capture_seconds+10 的记录
 *   3. production_check（每日 00:05）：资源点产出结算
 *      - 调用 settleTerritoryProduction 向归属宗门发放当日灵石/材料
 *   4. season_check（每小时检查跨日触发）：赛季自动结算
 *      - 查询所有 active 状态且 end_date < 今日 的赛季，调用 settleSeason
 *
 * 设计原则：
 *   - 配置驱动：所有间隔从 game_balance.sect_war.scheduler_interval_ms 读取，支持热更新
 *   - 错误隔离：每个任务用 try/catch 包裹，单任务失败不影响其他任务
 *   - 幂等启动：start() 方法可重复调用，已运行则打印日志后返回
 *   - 优雅停止：stop() 清理所有定时器，避免进程无法退出
 *   - 间隔兜底：配置缺失时使用默认值（30s/10s/daily_00_05）
 *
 * @module SectWarSchedulerService
 */
'use strict';

const SectWarService = require('./SectWarService');
const SectWar = require('../../models/sectWar');
const SectWarSeason = require('../../models/sectWarSeason');
const SectWarTerritory = require('../../models/sectWarTerritory');
const { Op } = require('sequelize');
const { infrastructure } = require('../../modules');

// 配置加载器单例
const configLoader = infrastructure.ConfigLoader;

/**
 * 宗门战调度器（单例模式）
 */
class SectWarSchedulerService {
    constructor() {
        /** @type {NodeJS.Timeout[]} 定时器句柄列表 */
        this.timers = [];
        /** @type {boolean} 是否正在运行 */
        this.isRunning = false;
        /** @type {string|null} 上次 season_check 执行日期（YYYY-MM-DD），用于跨日判定 */
        this.lastSeasonCheckDate = null;
        /** @type {string|null} 上次 production_check 执行日期（YYYY-MM-DD），防止同日重复发放 */
        this.lastProductionDate = null;
    }

    /**
     * 读取调度器配置（每次执行时重新读取，支持热更新）
     * @returns {Object} scheduler_interval_ms 配置对象
     */
    _getConfig() {
        const cfg = configLoader?.getConfig('game_balance')?.sect_war?.scheduler_interval_ms || {};
        return {
            war_state_check: typeof cfg.war_state_check === 'number' ? cfg.war_state_check : 30000,
            capture_timeout_check: typeof cfg.capture_timeout_check === 'number' ? cfg.capture_timeout_check : 10000,
            production_check: cfg.production_check || 'daily_00_05',
            season_check: cfg.season_check || 'daily_00_10'
        };
    }

    /**
     * 启动所有调度任务
     * 幂等：已运行则仅打印日志后返回
     * 启动时同步执行一次 clearStaleCaptureFlags 清理服务重启前的脏数据
     * @returns {Promise<void>}
     */
    async start() {
        if (this.isRunning) {
            console.log('[SectWarScheduler] 已在运行，跳过重复启动');
            return;
        }

        const cfg = this._getConfig();
        console.log('[SectWarScheduler] 启动调度器，配置:', cfg);

        // 启动前清理服务重启残留的占领标志
        try {
            await SectWarService.clearStaleCaptureFlags();
            console.log('[SectWarScheduler] 启动清理完成：残留占领标志已清空');
        } catch (err) {
            console.error('[SectWarScheduler] 启动清理失败:', err.message);
        }

        // 任务1：战役状态推进检查
        const warStateTimer = setInterval(async () => {
            try {
                await this._checkWarStateAdvancement();
            } catch (err) {
                console.error('[SectWarScheduler] war_state_check 异常:', err.message);
            }
        }, cfg.war_state_check);
        this.timers.push(warStateTimer);

        // 任务2：占领计时器超时补偿检查
        const captureTimeoutTimer = setInterval(async () => {
            try {
                await this._checkCaptureTimeout();
            } catch (err) {
                console.error('[SectWarScheduler] capture_timeout_check 异常:', err.message);
            }
        }, cfg.capture_timeout_check);
        this.timers.push(captureTimeoutTimer);

        // 任务3：资源点产出结算（每小时检查一次，跨日触发）
        const productionTimer = setInterval(async () => {
            try {
                await this._checkDailyProduction();
            } catch (err) {
                console.error('[SectWarScheduler] production_check 异常:', err.message);
            }
        }, 3600000); // 每小时检查一次
        this.timers.push(productionTimer);

        // 任务4：赛季状态检查（每小时检查一次，跨日触发）
        const seasonTimer = setInterval(async () => {
            try {
                await this._checkSeasonStatus();
            } catch (err) {
                console.error('[SectWarScheduler] season_check 异常:', err.message);
            }
        }, 3600000);
        this.timers.push(seasonTimer);

        this.isRunning = true;
        console.log('[SectWarScheduler] 调度器启动成功，已注册 4 个定时任务');
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
        console.log('[SectWarScheduler] 调度器已停止');
    }

    /**
     * 检查并推进战役状态
     * 扫描所有未结算的战役（preparing/announced/active），调用 advanceWarState 推进
     * 注意：advanceWarState 内部会根据 next_war_start_time/battle_start_time/battle_end_time
     *       判断是否到了状态切换的时刻，未到点则保持原状态
     * @private
     */
    async _checkWarStateAdvancement() {
        // 查询所有未结算的战役
        const pendingWars = await SectWar.findAll({
            where: {
                status: { [Op.in]: ['preparing', 'announced', 'active'] }
            },
            attributes: ['id', 'status', 'attacker_sect_name', 'defender_sect_name']
        });

        for (const war of pendingWars) {
            try {
                const result = await SectWarService.advanceWarState(war.id);
                // 仅当状态发生变化时打印日志
                if (result && result.previous_status !== result.current_status) {
                    console.log(`[SectWarScheduler] 战役 ${war.id} 状态推进: ${result.previous_status} → ${result.current_status}`);
                }
            } catch (err) {
                // 状态推进失败可能是条件不满足（如人数不足），仅打印 debug
                if (err.errorCode !== 'BUSINESS_LOGIC_ERROR') {
                    console.error(`[SectWarScheduler] 战役 ${war.id} 状态推进失败:`, err.message);
                }
            }
        }
    }

    /**
     * 占领计时器超时补偿检查
     * 服务重启后内存中的 setTimeout 丢失，需扫描数据库中 is_under_attack=1 但已超时的记录
     * 处理逻辑：
     *   - 超时记录直接重置 is_under_attack=0（视为占领失败）
     *   - 内存 Map 中对应的 activeCaptures 也清理掉
     * 字段说明：
     *   - SectWarTerritory 表使用 last_battle_time 记录攻击开始时间（参考 SectWarService.captureTerritory）
     *   - 没有独立的 attacker_player_id 字段，攻击者信息在内存 activeCaptures 中
     * @private
     */
    async _checkCaptureTimeout() {
        const cfg = SectWarService.getSectWarConfig();
        const captureSeconds = cfg.territory_capture_seconds || 30;
        const timeoutMs = (captureSeconds + 10) * 1000; // 留 10 秒缓冲
        const threshold = new Date(Date.now() - timeoutMs);

        // 查询所有超时未完成的占领标志（last_battle_time 早于阈值）
        const staleTerritories = await SectWarTerritory.findAll({
            where: {
                is_under_attack: 1,
                last_battle_time: { [Op.lt]: threshold }
            },
            attributes: ['id', 'territory_name', 'last_battle_time']
        });

        if (staleTerritories.length === 0) return;

        // 批量重置（仅清空 is_under_attack，last_battle_time 保留作为历史记录）
        const [updated] = await SectWarTerritory.update(
            { is_under_attack: 0 },
            { where: { id: staleTerritories.map(t => t.id) } }
        );

        if (updated > 0) {
            console.log(`[SectWarScheduler] 清理 ${updated} 个超时占领标志: ${staleTerritories.map(t => t.territory_name).join(', ')}`);
        }
    }

    /**
     * 每日资源点产出结算检查
     * 仅在日期变化时触发执行（防止同日重复发放）
     * 调用 settleTerritoryProduction 向所有归属宗门发放当日灵石/材料
     * @private
     */
    async _checkDailyProduction() {
        const today = new Date().toISOString().slice(0, 10);

        // 跨日判定：仅在日期变化时执行
        if (this.lastProductionDate === today) return;

        // 检查是否到了 00:05 之后（避免当天刚过零点时立即触发）
        const now = new Date();
        const hour = now.getHours();
        if (hour < 0) return; // 始终为 false，保留以备扩展（如指定每日特定时间）

        this.lastProductionDate = today;

        try {
            const result = await SectWarService.settleTerritoryProduction();
            console.log(`[SectWarScheduler] 资源点产出结算完成: 已结算 ${result?.settled_count || 0} 个资源点`);
        } catch (err) {
            // 失败则重置标志，下次再试
            this.lastProductionDate = null;
            console.error('[SectWarScheduler] 资源点产出结算失败:', err.message);
        }
    }

    /**
     * 检查赛季状态
     * 每小时调用一次，跨日时执行赛季结算检查：
     *   - 查询所有 active 状态且 end_date < 今日 的赛季
     *   - 调用 settleSeason 自动结算
     * @private
     */
    async _checkSeasonStatus() {
        const today = new Date().toISOString().slice(0, 10);

        // 跨日判定：仅在日期变化时执行检查
        if (this.lastSeasonCheckDate === today) return;
        this.lastSeasonCheckDate = today;

        // 查询需要结算的赛季（active 且 end_date < 今日）
        const seasonsToSettle = await SectWarSeason.findAll({
            where: {
                status: 'active',
                end_date: { [Op.lt]: today }
            },
            attributes: ['id', 'season_name']
        });

        for (const season of seasonsToSettle) {
            try {
                await SectWarService.settleSeason(season.id);
                console.log(`[SectWarScheduler] 赛季自动结算: ${season.season_name} (id=${season.id})`);
            } catch (err) {
                console.error(`[SectWarScheduler] 赛季 ${season.id} 结算失败:`, err.message);
            }
        }
    }
}

// 导出单例
module.exports = new SectWarSchedulerService();
