/**
 * 双时间系统服务模块
 * 负责管理天道时间（世界基准时间）和红尘时间（个人行为时间）
 * 基于《凡人修仙传》设计文档中的时间系统定义
 */
class DualTimeService {
    constructor() {
        this.configLoader = null;
        this.heavenlyTime = null; // 天道时间
        this.mortalTime = null;   // 红尘时间
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
            lastUpdate: Date.now()
        };

        // 红尘时间：活动时间加速
        this.mortalTime = {
            activityMultipliers: {
                seclusion: 3,    // 闭关：3年/次
                training: 1,     // 历练：1年/次
                cultivation: 0.5 // 修炼：0.5年/次
            },
            pendingActivities: []
        };
    }

    /**
     * 更新天道时间
     */
    updateHeavenlyTime() {
        const now = Date.now();
        const timePassed = (now - this.heavenlyTime.lastUpdate) / (1000 * 60 * 60); // 小时
        
        if (timePassed > 0) {
            const gameTimePassed = timePassed * this.heavenlyTime.realToGameRatio; // 游戏月
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
     * 开始红尘活动
     * @param {Object} player - 玩家对象
     * @param {string} activityType - 活动类型
     * @param {Object} activityData - 活动数据
     */
    startMortalActivity(player, activityType, activityData) {
        const multiplier = this.mortalTime.activityMultipliers[activityType] || 1;
        const activityDuration = activityData.duration || 1; // 默认1年
        
        const activity = {
            type: activityType,
            startTime: Date.now(),
            duration: activityDuration * multiplier, // 实际消耗的年数
            data: activityData,
            playerId: player.id
        };

        this.mortalTime.pendingActivities.push(activity);
        
        // 更新玩家状态
        player.is_secluded = activityType === 'seclusion';
        player.seclusion_start_time = new Date();
        player.seclusion_duration = activityDuration * 60 * 60; // 转换为秒

        return activity;
    }

    /**
     * 完成红尘活动
     * @param {Object} player - 玩家对象
     */
    completeMortalActivity(player) {
        const activityIndex = this.mortalTime.pendingActivities.findIndex(
            activity => activity.playerId === player.id
        );

        if (activityIndex === -1) return null;

        const activity = this.mortalTime.pendingActivities[activityIndex];
        
        // 应用时间消耗到玩家年龄
        if (player.attributes) {
            player.attributes.lifespan_current += activity.duration;
        }
        
        // 移除活动
        this.mortalTime.pendingActivities.splice(activityIndex, 1);
        
        // 重置玩家状态
        player.is_secluded = false;
        player.seclusion_start_time = null;
        player.seclusion_duration = 0;

        return activity;
    }

    /**
     * 计算玩家剩余寿命
     * @param {Object} player - 玩家对象
     * @returns {number} 剩余寿命（年）
     */
    calculateRemainingLifespan(player) {
        if (!player.attributes) return 0;
        
        const currentAge = player.attributes.lifespan_current || 0;
        const maxLifespan = player.attributes.lifespan_max || 60;
        
        return Math.max(0, maxLifespan - currentAge);
    }

    /**
     * 获取时间状态
     * @param {Object} player - 玩家对象
     * @returns {Object} 时间状态对象
     */
    getTimeStatus(player) {
        this.updateHeavenlyTime();
        
        const remainingLifespan = this.calculateRemainingLifespan(player);
        const playerActivities = this.mortalTime.pendingActivities.filter(
            activity => activity.playerId === player.id
        );

        return {
            heavenly_time: this.heavenlyTime.currentGameTime,
            mortal_time: {
                current_age: player.attributes?.lifespan_current || 0,
                max_lifespan: player.attributes?.lifespan_max || 60,
                remaining_lifespan: remainingLifespan,
                pending_activities: playerActivities
            },
            time_ratios: {
                real_to_game: this.heavenlyTime.realToGameRatio,
                game_to_real: this.heavenlyTime.gameToRealRatio
            }
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
    processOfflineTime(player, offlineDuration) {
        if (!player) return { hp_recovered: 0, mp_recovered: 0, age_increased: 0 };

        // 限制单次最大恢复时长为 24 小时，避免长期未登录玩家恢复过量
        const cappedDuration = Math.min(offlineDuration, 86400);
        const hoursOffline = cappedDuration / 3600;
        const gameDaysPassed = hoursOffline; // 1现实小时=1游戏天（离线时）
        const ageIncreased = gameDaysPassed / 365; // 转换为年

        // 更新玩家年龄（直接更新独立列，而非 attributes JSON 内嵌字段）
        if (typeof player.lifespan_current === 'number') {
            player.lifespan_current += ageIncreased;
        }

        // 应用属性恢复（HP/MP）
        const attributeService = require('./AttributeMaxService');
        const maxValues = attributeService.calculateAttributeMaxValues(player, {});
        const recoveryResult = attributeService.processAttributeRecovery(
            player, maxValues, 'natural', cappedDuration / 60
        );

        // 关键修复：将恢复结果写回 player 对象
        player.hp_current = BigInt(recoveryResult.hp_current);
        player.mp_current = BigInt(recoveryResult.mp_current);

        return {
            hp_recovered: recoveryResult.recovered.hp,
            mp_recovered: recoveryResult.recovered.mp,
            age_increased: ageIncreased
        };
    }

    /**
     * 处理在线时间
     *
     * 修复（2026-07-20）：
     *   同 processOfflineTime，修复返回值未保存和年龄字段路径错误的 bug。
     *
     * @param {Object} player - 玩家对象
     * @param {number} onlineDuration - 在线时长（秒），上限 3600 秒（1小时）
     * @returns {Object} 恢复结果 { hp_recovered, mp_recovered, age_increased }
     */
    processOnlineTime(player, onlineDuration) {
        if (!player) return { hp_recovered: 0, mp_recovered: 0, age_increased: 0 };

        // 限制单次最大恢复时长为 1 小时，避免定时任务累积过量恢复
        const cappedDuration = Math.min(onlineDuration, 3600);
        const gameDaysPassed = cappedDuration / (60 * 60); // 1现实小时=1游戏天（在线时）
        const ageIncreased = gameDaysPassed / 365; // 转换为年

        // 更新玩家年龄（直接更新独立列）
        if (typeof player.lifespan_current === 'number') {
            player.lifespan_current += ageIncreased;
        }

        // 应用属性恢复（HP/MP）
        const attributeService = require('./AttributeMaxService');
        const maxValues = attributeService.calculateAttributeMaxValues(player, {});
        const recoveryResult = attributeService.processAttributeRecovery(
            player, maxValues, 'natural', cappedDuration / 60
        );

        // 关键修复：将恢复结果写回 player 对象
        player.hp_current = BigInt(recoveryResult.hp_current);
        player.mp_current = BigInt(recoveryResult.mp_current);

        return {
            hp_recovered: recoveryResult.recovered.hp,
            mp_recovered: recoveryResult.recovered.mp,
            age_increased: ageIncreased
        };
    }
}

module.exports = new DualTimeService();
