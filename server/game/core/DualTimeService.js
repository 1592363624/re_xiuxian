/**
 * 双时间系统服务模块
 * 负责管理天道时间（世界基准时间）和红尘时间（个人行为时间）
 * 基于《凡人修仙传》设计文档中的时间系统定义
 */
const { logOnce } = require('../../utils/logOnce');

class DualTimeService {
    constructor() {
        this.configLoader = null;
        this.heavenlyTime = null; // 天道时间
    }

    /**
     * 初始化双时间系统服务
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        this.initializeTimeSystems();
    }

    /**
     * 初始化时间系统
     */
    initializeTimeSystems() {
        // 天道时间：现实1小时=游戏1个月（世界基准时间）
        this.heavenlyTime = {
            realToGameRatio: 1 / (30 * 24), // 1现实小时 = 1游戏月
            gameToRealRatio: 30 * 24,       // 1游戏月 = 720现实小时
            currentGameTime: '仙历元年一月一日',
            gameMonthsElapsed: 0,           // 自仙历元年一月一日累计的游戏月数
            lastUpdate: Date.now()
        };
        // 红尘活动的年数区间与真实等待时长改为配置驱动：config/time_system.json
    }

    /**
     * 更新天道时间
     */
    updateHeavenlyTime() {
        const now = Date.now();
        const timePassed = (now - this.heavenlyTime.lastUpdate) / (1000 * 60 * 60); // 小时
        
        if (timePassed > 0) {
            const gameTimePassed = timePassed * this.heavenlyTime.realToGameRatio; // 游戏月
            this.heavenlyTime.gameMonthsElapsed = (this.heavenlyTime.gameMonthsElapsed || 0) + gameTimePassed;
            this.heavenlyTime.currentGameTime = this.addGameTime(this.heavenlyTime.currentGameTime, gameTimePassed);
            this.heavenlyTime.lastUpdate = now;
        }
    }

    /**
     * 添加游戏时间
     * @param {string} currentTime - 当前游戏时间（格式如"仙历元年一月一日"）
     * @param {number} monthsToAdd - 要添加的月数
     * @returns {string} 新的游戏时间字符串
     */
    addGameTime(currentTime, monthsToAdd) {
        // 中文数字映射表，包含'元'作为1的特殊映射
        const chineseNumMap = {
            '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
            '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
            '十': 10, '元': 1
        };
        
        /**
         * 解析中文数字字符串为阿拉伯数字
         * @param {string} str - 中文数字字符串
         * @returns {number} 解析后的数字
         */
        const parseChineseNum = (str) => {
            if (!str) return 1;
            // 如果已经是阿拉伯数字，直接返回
            if (/^\d+$/.test(str)) return parseInt(str);
            // 单字符直接查表
            if (chineseNumMap[str] !== undefined) return chineseNumMap[str];
            // 默认返回1
            return 1;
        };
        
        // 解析时间字符串，如"仙历元年一月一日"
        // 匹配格式：{纪元}年{年份}月{月份}日{日期}
        const eraMatch = currentTime.match(/(.+?)年(.+?)月(.+?)日/);
        if (!eraMatch) return currentTime;
        
        const era = eraMatch[1];
        const year = parseChineseNum(eraMatch[2]);
        const month = parseChineseNum(eraMatch[3]);
        const day = parseChineseNum(eraMatch[4]);
        
        // 计算总月数并求新年月
        let totalMonths = (year * 12) + (month - 1) + Math.floor(monthsToAdd);
        const newYear = Math.floor(totalMonths / 12);
        const newMonth = (totalMonths % 12) + 1;
        
        // 将数字转回中文（简化版，只处理0-99）
        const toChineseNumber = (num) => {
            const chineseDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
            if (num < 10) return chineseDigits[num];
            if (num < 20) return '十' + (num % 10 === 0 ? '' : chineseDigits[num % 10]);
            if (num < 100) {
                const tens = Math.floor(num / 10);
                const ones = num % 10;
                return chineseDigits[tens] + '十' + (ones === 0 ? '' : chineseDigits[ones]);
            }
            return num.toString();
        };
        
        // 返回格式：{纪元}{年份}年{月份}月{日期}日（修复了原来双'年'字的bug）
        return `${era}${toChineseNumber(newYear)}年${toChineseNumber(newMonth)}月${toChineseNumber(day)}日`;
    }

    /**
     * 计算玩家剩余寿命
     * 修复：年龄存于 player.lifespan_current 独立列（attributes.lifespan_current 已废弃），
     * 旧实现读嵌套字段恒为 undefined，导致剩余寿命恒等于满值
     * @param {Object} player - 玩家对象
     * @returns {number} 剩余寿命（年）
     */
    calculateRemainingLifespan(player) {
        if (!player) return 0;

        const currentAge = Number(player.lifespan_current) || 0;
        const maxLifespan = Number(player.lifespan_max) || 0;

        return Math.max(0, maxLifespan - currentAge);
    }

    /**
     * 汇总玩家双时间状态（供 /api/time/status 直接下发）
     * @param {Object} player - 玩家对象
     * @returns {Object} { total_age, heavenly_age, mortal_age, max_lifespan, remaining_lifespan, lifespan_percentage }
     */
    getLifespanSummary(player) {
        const currentAge = Number(player?.lifespan_current) || 0;
        const maxLifespan = Number(player?.lifespan_max) || 0;
        const remainingLifespan = this.calculateRemainingLifespan(player);

        return {
            total_age: currentAge,
            heavenly_age: Number(player?.heavenly_age) || 0,
            mortal_age: Number(player?.mortal_age) || 0,
            max_lifespan: maxLifespan,
            remaining_lifespan: remainingLifespan,
            lifespan_percentage: maxLifespan > 0
                ? Number(((remainingLifespan / maxLifespan) * 100).toFixed(1))
                : 0
        };
    }

    /**
     * 读取双时间配置（config/time_system.json）
     * 配置未加载时 ConfigLoader 会抛错，这里兜底为空配置（活动不可用，fail-closed）
     * @returns {Object} 时间系统配置
     */
    getTimeSystemConfig() {
        try {
            return this.configLoader?.getConfig('time_system') || {};
        } catch (e) {
            logOnce('DualTimeService.getTimeSystemConfig', 'time_system 配置读取失败，双时间系统按"未配置"兜底（活动不可用）: ' + e.message);
            return {};
        }
    }

    /**
     * 玩家当前进行中的红尘活动列表
     * @param {Object} player - 玩家对象
     * @returns {Array} 活动记录
     */
    getPendingActivities(player) {
        const pending = player?.time_system_data?.pending_activities;
        return Array.isArray(pending) ? pending : [];
    }

    /**
     * 获取天道时间全局状态（世界年 + 即将发生的世界事件）
     * @returns {Object} { heavenly_time: { current_year, current_time, next_events }, time_ratios }
     */
    getTimeSystemStatus() {
        this.updateHeavenlyTime();

        const config = this.getTimeSystemConfig();
        const currentYear = this.getCurrentHeavenlyYear();
        const previewCount = Number(config?.limits?.next_events_preview_count) || 3;
        const events = (Array.isArray(config.heavenly_events) ? config.heavenly_events : [])
            .map(event => {
                const interval = Number(event.interval_years);
                if (!Number.isFinite(interval) || interval <= 0) return null;

                let nextYear = Number(event.first_year) || 0;
                while (nextYear <= currentYear) nextYear += interval;

                return {
                    event: String(event.key),
                    name: String(event.name || event.key),
                    next_year: nextYear,
                    next_occurrence: `仙历${nextYear}年`,
                    years_until: nextYear - currentYear
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.years_until - b.years_until)
            .slice(0, previewCount);

        return {
            heavenly_time: {
                current_year: currentYear,
                current_time: this.heavenlyTime.currentGameTime,
                next_events: events
            },
            time_ratios: {
                real_to_game: this.heavenlyTime.realToGameRatio,
                game_to_real: this.heavenlyTime.gameToRealRatio
            }
        };
    }

    /**
     * 当前天道纪年（仙历年份，元年为 1）
     * @returns {number} 年份
     */
    getCurrentHeavenlyYear() {
        const monthsElapsed = Number(this.heavenlyTime?.gameMonthsElapsed) || 0;
        return 1 + Math.floor(monthsElapsed / 12);
    }

    /**
     * 获取单个红尘活动的服务端配置，数值字段逐个兜底
     * @param {string} activityType - 活动类型
     * @returns {Object|null} 活动配置，未配置返回 null
     */
    getActivityConfig(activityType) {
        const activities = this.getTimeSystemConfig().mortal_activities || {};
        // hasOwnProperty 判定：避免 '__proto__' / 'constructor' 等键取到原型对象而被当成合法活动
        if (typeof activityType !== 'string' || !Object.prototype.hasOwnProperty.call(activities, activityType)) {
            return null;
        }
        const activity = activities[activityType];
        if (!activity || typeof activity !== 'object') return null;

        const num = (value, fallback) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        const minYears = num(activity.min_years, 0.5);
        const maxYears = Math.max(minYears, num(activity.max_years, 1));

        return {
            type: String(activityType),
            name: String(activity.name || activityType),
            min_years: minYears,
            max_years: maxYears,
            default_years: Math.min(maxYears, Math.max(minYears, num(activity.default_years, minYears))),
            real_seconds_per_year: num(activity.real_seconds_per_year, 60)
        };
    }

    /**
     * 获取玩家当前可开始的红尘活动类型
     * 同名活动不可叠加，且进行中活动数受 max_pending_activities 约束
     * @param {Object} player - 玩家对象
     * @returns {Array<string>} 可用活动类型
     */
    getAvailableActivities(player) {
        const activities = this.getTimeSystemConfig().mortal_activities || {};
        const pending = this.getPendingActivities(player);
        const maxPending = Number(this.getTimeSystemConfig()?.limits?.max_pending_activities) || 3;

        if (pending.length >= maxPending) return [];

        const pendingTypes = new Set(pending.map(activity => activity?.activity_type));
        return Object.keys(activities).filter(type => !pendingTypes.has(type));
    }

    /**
     * 计算红尘活动的时间消耗
     *
     * 安全约束：活动类型与年数区间全部来自服务端配置，客户端传入的年数只能被钳制，
     * 无法放大单次消耗，也无法伪造完成时点（completion_time 由服务器时钟生成）。
     *
     * @param {Object} player - 玩家对象
     * @param {string} activityType - 活动类型
     * @param {number} [requestedYears] - 客户端期望消耗年数（可选）
     * @returns {Object|null} 消耗结果，活动未配置返回 null
     */
    processMortalTimeConsumption(player, activityType, requestedYears = null) {
        const activityConfig = this.getActivityConfig(activityType);
        if (!activityConfig) return null;

        const requested = Number(requestedYears);
        const years = (Number.isFinite(requested) && requested > 0)
            ? Math.min(Math.max(requested, activityConfig.min_years), activityConfig.max_years)
            : activityConfig.default_years;

        const waitSeconds = Math.round(years * activityConfig.real_seconds_per_year);

        return {
            activity_type: activityConfig.type,
            name: activityConfig.name,
            time_cost_years: years,
            age_increase: years,
            wait_seconds: waitSeconds,
            completion_time: new Date(Date.now() + waitSeconds * 1000).toISOString(),
            heavenly_time_elapsed: years
        };
    }

    /**
     * 结算红尘活动：只累加红尘年龄与寿元消耗
     *
     * 说明：修为/物品等奖益由各玩法自己的结算接口负责，时间系统不再重复发放，
     * 避免形成第二条可被刷的奖励通道。寿元耗尽时复用 LifespanService 的死亡流程。
     *
     * @param {Object} player - 玩家对象
     * @param {Object} activity - 活动记录（来自 player.time_system_data，服务端写入）
     * @returns {Promise<Object>} 结算结果
     */
    async processActivityCompletion(player, activity) {
        const years = Number(activity?.time_cost_years);
        if (!Number.isFinite(years) || years <= 0) {
            throw new Error('活动记录缺少有效的寿元消耗');
        }

        const LifespanService = require('./LifespanService');

        player.mortal_age = (Number(player.mortal_age) || 0) + years;
        player.lifespan_current = Math.min(
            (Number(player.lifespan_current) || 0) + years,
            Number(player.lifespan_max) || 0
        );
        await player.save();

        const lifespan = this.getLifespanSummary(player);
        const exhausted = lifespan.remaining_lifespan <= 0;
        const death = exhausted ? await LifespanService.handleLifespanEnd(player) : null;

        return {
            activity_type: activity.activity_type,
            time_cost_years: years,
            mortal_age: player.mortal_age,
            lifespan: lifespan,
            lifespan_exhausted: exhausted,
            death: death
        };
    }

    /**
     * 处理离线时间
     *
     * 修复（2026-07-20）：
     *   1. 原代码调用 processAttributeRecovery 后未保存返回值到 player 对象，
     *      导致离线 HP/MP 恢复完全失效（玩家 MP 耗尽后永远为 0）。
     *      现在将恢复结果写回 player.hp_current / player.mp_current。
     *   2. 原代码错误地更新 player.attributes.lifespan_current（JSON 内嵌字段），
     *      但实际年龄字段是 player.lifespan_current（独立列），导致年龄也不增长。
     *      现在直接更新 player.lifespan_current。
     *   3. 限制单次最大恢复时长为 24 小时，避免长期未登录玩家恢复过量。
     *
     * @param {Object} player - 玩家对象
     * @param {number} offlineDuration - 离线时长（秒），上限 86400 秒（24小时）
     * @returns {Object} 恢复结果 { hp_recovered, mp_recovered, age_increased }
     */
    /**
     * 时间推进带来的恢复量（纯计算，不碰数据库）
     *
     * 拆开是为了让"算多少"可以被单测直接验证，而"怎么落库"只有一处实现。
     * 注意传入的 player 必须已经是锁内新鲜读出的那一行，否则这里算出来的
     * hp/mp 是基于旧快照的，写回就会覆盖掉这段时间内别的流程的改动。
     *
     * @param {Object} player - 玩家实例或行数据
     * @param {number} durationSeconds - 本次推进的秒数
     * @param {number} capSeconds - 单次上限（离线 24 小时 / 在线 1 小时）
     */
    computeTimeRecovery(player, durationSeconds, capSeconds) {
        const cappedDuration = Math.min(durationSeconds, capSeconds);
        // 1 现实小时 = 1 游戏天，365 游戏天 = 1 岁
        const ageIncreased = (cappedDuration / 3600) / 365;

        const before = typeof player.lifespan_current === 'number'
            ? player.lifespan_current : Number(player.lifespan_current) || 0;

        const attributeService = require('./AttributeMaxService');
        const maxValues = attributeService.calculateAttributeMaxValues(player, {});
        const recovery = attributeService.processAttributeRecovery(
            player, maxValues, 'natural', cappedDuration / 60
        );

        return {
            lifespan_current: before + ageIncreased,
            hp_current: recovery.hp_current,
            mp_current: recovery.mp_current,
            recovered: recovery.recovered,
            age_increased: ageIncreased,
            capped_duration: cappedDuration
        };
    }

    /**
     * 离线期间的时间推进与 HP/MP 恢复
     *
     * 落库走 PlayerStateStore.mutatePlayer：行锁内重新读一行再算再写。
     * 旧实现直接改登录时那个无锁实例上的 attributes 整块，再由 issueLoginToken 的
     * player.save() 回写 —— 于是每次登录都会把这段时间内别处写进 attributes 的键
     * （宗门战防御标记、刚吃的丹药加成、加点账本）一起抹掉。
     *
     * @param {Object} player - 玩家对象（只取 id 与日志用的字段，不参与写库基准）
     * @param {number} offlineDuration - 离线时长（秒），上限 86400 秒（24小时）
     * @returns {Promise<Object>} 恢复结果 { hp_recovered, mp_recovered, age_increased }
     */
    async processOfflineTime(player, offlineDuration) {
        if (!player) return { hp_recovered: 0, mp_recovered: 0, age_increased: 0 };

        const result = await this.applyTimeRecovery(player, offlineDuration, 86400);
        return result;
    }

    /**
     * 处理在线时间
     *
     * 与离线路径共用 applyTimeRecovery，只是单次上限 1 小时。
     * @param {Object} player - 玩家对象
     * @param {number} onlineDuration - 在线时长（秒）
     */
    async processOnlineTime(player, onlineDuration) {
        if (!player) return { hp_recovered: 0, mp_recovered: 0, age_increased: 0 };

        return this.applyTimeRecovery(player, onlineDuration, 3600);
    }

    /** 恢复落库的唯一入口：锁内读 → 算 → 补丁写 */
    async applyTimeRecovery(player, durationSeconds, capSeconds) {
        const PlayerStateStore = require('../persistence/PlayerStateStore');
        const attributeService = require('./AttributeMaxService');

        let outcome = null;
        await PlayerStateStore.mutatePlayer(player.id, (fresh) => {
            const computed = this.computeTimeRecovery(fresh, durationSeconds, capSeconds);
            outcome = computed;
            return {
                columns: {
                    lifespan_current: computed.lifespan_current,
                    hp_current: BigInt(computed.hp_current),
                    mp_current: BigInt(computed.mp_current)
                },
                // 只写恢复结算时点这一个键，不再整块回写 attributes
                attributes: attributeService.buildRecoveryWatermarkPatch()
            };
        });

        return {
            hp_recovered: outcome.recovered.hp,
            mp_recovered: outcome.recovered.mp,
            age_increased: outcome.age_increased
        };
    }
}

module.exports = new DualTimeService();
