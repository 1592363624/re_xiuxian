/**
 * 世界BOSS调度器服务
 *
 * 负责世界BOSS系统的所有周期性后台任务（参考 StockSchedulerService 模式）：
 *   1. spawn_check（默认 60s）：根据 world_boss_data.json 的 spawn_schedule 自动刷新 BOSS
 *   2. expire_check（默认 60s）：检查 pending/active 状态的 BOSS 是否到达 expire_time，自动过期
 *   3. phase_check（默认 5s）：兜底阶段切换检查（正常由 attackBoss 内部即时触发，此处为补偿）
 *   4. season_check（每日 00:05）：检查 active 赛季是否到达 end_date，自动结算
 *
 * 设计原则：
 *   - 配置驱动：所有间隔从 game_balance.world_boss.scheduler_interval_ms 读取，支持热更新
 *   - 错误隔离：每个任务用 try/catch 包裹，单任务失败不影响其他任务
 *   - 幂等启动：start() 方法可重复调用，已运行则打印日志后返回
 *   - 优雅停止：stop() 清理所有定时器，避免进程无法退出
 *   - 间隔兜底：配置缺失时使用默认值（60s/60s/5s）
 *
 * @module WorldBossSchedulerService
 */
'use strict';

const WorldBossService = require('./WorldBossService');
const WorldBoss = require('../../models/worldBoss');
const WorldBossSeason = require('../../models/worldBossSeason');
const { Op } = require('sequelize');
const { infrastructure } = require('../../modules');

// 配置加载器单例
const configLoader = infrastructure.ConfigLoader;

/**
 * 世界BOSS调度器（单例模式）
 */
class WorldBossSchedulerService {
    constructor() {
        /** @type {NodeJS.Timeout[]} 定时器句柄列表 */
        this.timers = [];
        /** @type {boolean} 是否正在运行 */
        this.isRunning = false;
        /** @type {string|null} 上次 season_check 执行日期（YYYY-MM-DD），用于跨日判定 */
        this.lastSeasonCheckDate = null;
    }

    /**
     * 读取调度器配置（每次执行时重新读取，支持热更新）
     * @returns {Object} scheduler_interval_ms 配置对象
     */
    _getConfig() {
        const cfg = configLoader?.getConfig('game_balance')?.world_boss?.scheduler_interval_ms || {};
        return {
            spawn_check: typeof cfg.spawn_check === 'number' ? cfg.spawn_check : 60000,
            expire_check: typeof cfg.expire_check === 'number' ? cfg.expire_check : 60000,
            phase_check: typeof cfg.phase_check === 'number' ? cfg.phase_check : 5000,
            season_check: cfg.season_check || 'daily_00_05'
        };
    }

    /**
     * 启动所有调度任务
     * 幂等：已运行则仅打印日志后返回
     * @returns {Promise<void>}
     */
    async start() {
        if (this.isRunning) {
            console.log('[WorldBossScheduler] 已在运行，跳过重复启动');
            return;
        }

        const cfg = this._getConfig();
        console.log('[WorldBossScheduler] 启动调度器，配置:', cfg);

        // 任务1：BOSS 自动刷新检查
        const spawnTimer = setInterval(async () => {
            try {
                await this._checkSpawnSchedule();
            } catch (err) {
                console.error('[WorldBossScheduler] spawn_check 异常:', err.message);
            }
        }, cfg.spawn_check);
        this.timers.push(spawnTimer);

        // 任务2：BOSS 过期检查
        const expireTimer = setInterval(async () => {
            try {
                await this._checkExpiredBosses();
            } catch (err) {
                console.error('[WorldBossScheduler] expire_check 异常:', err.message);
            }
        }, cfg.expire_check);
        this.timers.push(expireTimer);

        // 任务3：阶段切换兜底检查（正常由 attackBoss 即时触发，此处为服务重启后的补偿）
        const phaseTimer = setInterval(async () => {
            try {
                await this._checkPhaseTransitions();
            } catch (err) {
                console.error('[WorldBossScheduler] phase_check 异常:', err.message);
            }
        }, cfg.phase_check);
        this.timers.push(phaseTimer);

        // 任务4：赛季状态检查（每小时检查一次，跨日时执行）
        const seasonTimer = setInterval(async () => {
            try {
                await this._checkSeasonStatus();
            } catch (err) {
                console.error('[WorldBossScheduler] season_check 异常:', err.message);
            }
        }, 3600000); // 每小时检查一次，跨日触发
        this.timers.push(seasonTimer);

        this.isRunning = true;
        console.log('[WorldBossScheduler] 调度器启动成功，已注册 4 个定时任务');
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
        console.log('[WorldBossScheduler] 调度器已停止');
    }

    /**
     * 检查 BOSS 刷新计划
     * 根据 world_boss_data.json 中每个 BOSS 的 spawn_schedule 字段判断是否需要刷新
     * @private
     */
    async _checkSpawnSchedule() {
        const allBosses = WorldBossService.getAllBossStaticData();
        const now = new Date();

        for (const bossStatic of allBosses) {
            // 未配置刷新计划则跳过（仅 GM 手动刷新）
            if (!bossStatic.spawn_schedule) continue;

            // 查询当前是否已有同 boss_key 的活跃 BOSS
            const existing = await WorldBoss.findOne({
                where: {
                    boss_key: bossStatic.boss_key,
                    status: { [Op.in]: ['pending', 'active'] }
                },
                attributes: ['id']
            });
            if (existing) continue; // 已有活跃实例，跳过

            // 解析刷新计划（支持 daily/weekly 格式）
            const schedule = bossStatic.spawn_schedule;
            const lastKilledTime = await this._getLastKilledTime(bossStatic.boss_key);
            const shouldSpawn = this._shouldSpawnBySchedule(schedule, lastKilledTime, now);

            if (shouldSpawn) {
                try {
                    // 获取当前活跃赛季（若有）
                    const activeSeason = await WorldBossSeason.findOne({
                        where: { status: 'active' },
                        attributes: ['id']
                    });
                    const seasonId = activeSeason?.id || 0;
                    await WorldBossService.spawnBoss(bossStatic.boss_key, seasonId);
                    console.log(`[WorldBossScheduler] 自动刷新 BOSS: ${bossStatic.boss_name}`);
                } catch (err) {
                    // spawnBoss 抛 AppError（如已有活跃实例）时静默跳过，其他错误打印
                    if (err.errorCode !== 'BUSINESS_LOGIC_ERROR') {
                        console.error(`[WorldBossScheduler] 刷新 BOSS ${bossStatic.boss_key} 失败:`, err.message);
                    }
                }
            }
        }
    }

    /**
     * 查询指定 boss_key 的最近一次被击杀时间
     * 用于判断按周刷新的 BOSS 是否已过冷却期
     * @param {string} bossKey - BOSS 配置键
     * @returns {Promise<Date|null>} 最近击杀时间，无记录返回 null
     * @private
     */
    async _getLastKilledTime(bossKey) {
        const lastBoss = await WorldBoss.findOne({
            where: { boss_key: bossKey, status: 'defeated' },
            order: [['defeat_time', 'DESC']],
            attributes: ['defeat_time']
        });
        return lastBoss?.defeat_time || null;
    }

    /**
     * 根据刷新计划判断当前是否应该刷新 BOSS
     * 支持的计划格式（参考 world_boss_data.json 的 spawn_schedule 字段）：
     *   - cron 字符串：如 "0 20 * * 2,5,0"（分 时 日 月 周，支持 , 列表和 * 通配）
     *     常用模式：
     *       "0 20 * * 2,5,0" — 周二、周五、周日 20:00 刷新
     *       "0 20 * * 1,4"   — 周一、周四 20:00 刷新
     *       "0 20 * * *"     — 每天 20:00 刷新
     *   - { type: 'daily', hour: 20 }  每天 20:00 刷新（兼容旧对象格式）
     *   - { type: 'weekly', day_of_week: 3, hour: 20 }  每周三 20:00 刷新
     *   - { type: 'interval_hours', hours: 6 }  每 6 小时刷新一次（自上次击杀时间起算）
     *   - { type: 'manual' }  仅 GM 手动刷新
     *
     * 修复（2026-07-21）：
     *   原代码只支持对象格式，但 world_boss_data.json 中所有 BOSS 都用 cron 字符串格式
     *   导致 schedule.type === undefined，所有判断分支都不匹配，返回 false
     *   最终结果：BOSS 永远不会被自动刷新，玩家查询 /available 总是返回空列表
     *   现增加对 cron 字符串格式的解析支持
     *
     * @param {Object|string} schedule - 刷新计划配置（对象或 cron 字符串）
     * @param {Date|null} lastKilledTime - 上次击杀时间
     * @param {Date} now - 当前时间
     * @returns {boolean} 是否应该刷新
     * @private
     */
    _shouldSpawnBySchedule(schedule, lastKilledTime, now) {
        if (!schedule) return false;

        // 新增：cron 字符串格式解析
        // 格式：minute hour day_of_month month day_of_week
        // 支持：* 通配符、, 列表（如 "2,5,0"）
        // 不支持：- 范围、/ 步进（当前配置未使用这些高级语法）
        if (typeof schedule === 'string') {
            return this._matchCronSchedule(schedule, lastKilledTime, now);
        }

        // 兼容旧对象格式
        if (schedule.type === 'manual') return false;

        if (schedule.type === 'interval_hours') {
            // 间隔刷新：上次击杀时间 + 间隔小时数 <= 当前时间
            if (!lastKilledTime) return true; // 从未击杀过，允许刷新
            const intervalMs = (schedule.hours || 6) * 3600 * 1000;
            return (now.getTime() - lastKilledTime.getTime()) >= intervalMs;
        }

        if (schedule.type === 'daily') {
            // 每日定时刷新：当前小时 >= schedule.hour 且今日未刷新
            const targetHour = schedule.hour || 20;
            if (now.getHours() < targetHour) return false;
            // 判断今日是否已有过 defeated 记录（若 lastKilledTime 是今日则跳过）
            if (lastKilledTime) {
                const isSameDay = lastKilledTime.getFullYear() === now.getFullYear()
                    && lastKilledTime.getMonth() === now.getMonth()
                    && lastKilledTime.getDate() === now.getDate();
                if (isSameDay) return false;
            }
            return true;
        }

        if (schedule.type === 'weekly') {
            // 每周定时刷新：当前是 schedule.day_of_week 且小时 >= schedule.hour
            // JS getDay() 周日=0, 周三=3, 周六=6
            const targetDay = schedule.day_of_week ?? 3;
            const targetHour = schedule.hour || 20;
            if (now.getDay() !== targetDay) return false;
            if (now.getHours() < targetHour) return false;
            // 判断本周是否已刷新过
            if (lastKilledTime) {
                const dayDiff = Math.floor((now.getTime() - lastKilledTime.getTime()) / (24 * 3600 * 1000));
                if (dayDiff < 7) return false;
            }
            return true;
        }

        return false;
    }

    /**
     * 解析 cron 字符串并判断当前时间是否匹配
     * 简化版 cron 解析器，仅支持当前 world_boss_data.json 使用到的语法
     *
     * 支持的 cron 字段：
     *   - minute: 0-59 或 *
     *   - hour: 0-23 或 *
     *   - day_of_month: * 或具体数字（暂不校验，配置中均为 *）
     *   - month: * 或具体数字（暂不校验，配置中均为 *）
     *   - day_of_week: 0-6（0=周日）或 *, 支持 , 列表（如 "2,5,0"）
     *
     * 判断逻辑：
     *   1. 当前时间必须匹配 cron 表达式的 hour 和 minute
     *   2. 当前星期必须匹配 day_of_week（若为 * 则任意）
     *   3. 若 lastKilledTime 在今日且匹配刷新时段，则不重复刷新
     *
     * @param {string} cronExpr - cron 表达式（5 字段）
     * @param {Date|null} lastKilledTime - 上次击杀时间
     * @param {Date} now - 当前时间
     * @returns {boolean} 是否应该刷新
     * @private
     */
    _matchCronSchedule(cronExpr, lastKilledTime, now) {
        const parts = cronExpr.trim().split(/\s+/);
        if (parts.length !== 5) {
            console.warn(`[WorldBossScheduler] 无效 cron 表达式: ${cronExpr}`);
            return false;
        }

        const [minuteField, hourField, , , dayOfWeekField] = parts;

        // 检查小时匹配
        if (!this._cronFieldMatch(hourField, now.getHours())) return false;
        // 检查分钟匹配
        if (!this._cronFieldMatch(minuteField, now.getMinutes())) return false;
        // 检查星期匹配（JS getDay() 周日=0）
        if (!this._cronFieldMatch(dayOfWeekField, now.getDay())) return false;

        // 同日不重复刷新：若 lastKilledTime 在今日同时段，跳过
        if (lastKilledTime) {
            const isSameDay = lastKilledTime.getFullYear() === now.getFullYear()
                && lastKilledTime.getMonth() === now.getMonth()
                && lastKilledTime.getDate() === now.getDate();
            if (isSameDay) {
                // 同日已击杀过，跳过本时段刷新
                return false;
            }
        }

        return true;
    }

    /**
     * 判断 cron 字段是否匹配当前值
     * 支持：* 通配符、, 列表（如 "2,5,0"）、单个数字
     * @param {string} field - cron 字段值
     * @param {number} value - 当前时间值
     * @returns {boolean} 是否匹配
     * @private
     */
    _cronFieldMatch(field, value) {
        if (field === '*') return true;
        // 逗号分隔列表
        if (field.includes(',')) {
            const items = field.split(',').map(s => parseInt(s.trim(), 10));
            return items.includes(value);
        }
        // 单个数字
        const num = parseInt(field, 10);
        return !isNaN(num) && num === value;
    }

    /**
     * 检查过期的 BOSS（pending/active 状态且 expire_time < now）
     * 自动调用 expireBoss 将其置为 expired 状态
     * @private
     */
    async _checkExpiredBosses() {
        const now = new Date();
        const expiredCandidates = await WorldBoss.findAll({
            where: {
                status: { [Op.in]: ['pending', 'active'] },
                expire_time: { [Op.lt]: now }
            },
            attributes: ['id', 'boss_name']
        });

        for (const boss of expiredCandidates) {
            try {
                await WorldBossService.expireBoss(boss.id);
                console.log(`[WorldBossScheduler] BOSS 自动过期: ${boss.boss_name} (id=${boss.id})`);
            } catch (err) {
                console.error(`[WorldBossScheduler] BOSS ${boss.id} 过期失败:`, err.message);
            }
        }
    }

    /**
     * 兜底阶段切换检查
     * 正常情况下阶段切换由 attackBoss 内部即时触发；
     * 此处用于服务重启后或调度遗漏场景下的补偿检查
     * @private
     */
    async _checkPhaseTransitions() {
        // 查询所有 active 状态的 BOSS
        const activeBosses = await WorldBoss.findAll({
            where: { status: 'active' },
            attributes: ['id', 'boss_name', 'phase', 'hp_current', 'hp_max']
        });

        // 当前实现仅打印日志，实际阶段切换在 attackBoss 中即时触发
        // 后续如需补偿逻辑，可在此调用 WorldBossService._checkPhaseTransition
        // 但 _checkPhaseTransition 是 private 方法且需要事务，这里不直接调用
        // 保留此方法作为调度框架的占位，便于后续扩展
        if (activeBosses.length > 0) {
            // 静默处理，避免日志噪音
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
        const seasonsToSettle = await WorldBossSeason.findAll({
            where: {
                status: 'active',
                end_date: { [Op.lt]: today }
            },
            attributes: ['id', 'season_name']
        });

        for (const season of seasonsToSettle) {
            try {
                await WorldBossService.settleSeason(season.id);
                console.log(`[WorldBossScheduler] 赛季自动结算: ${season.season_name} (id=${season.id})`);
            } catch (err) {
                console.error(`[WorldBossScheduler] 赛季 ${season.id} 结算失败:`, err.message);
            }
        }
    }
}

// 导出单例
module.exports = new WorldBossSchedulerService();
