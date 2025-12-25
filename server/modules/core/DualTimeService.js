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
     * @param {string} currentTime - 当前游戏时间
     * @param {number} monthsToAdd - 要添加的月数
     */
    addGameTime(currentTime, monthsToAdd) {
        // 简化实现：只更新年份和月份
        const [era, yearMonthDay] = currentTime.split('年');
        const [year, month, day] = yearMonthDay.split(/[月日]/).map(Number);
        
        let totalMonths = (parseInt(year) * 12) + month - 1 + monthsToAdd;
        const newYear = Math.floor(totalMonths / 12);
        const newMonth = (totalMonths % 12) + 1;
        
        return `${era}年${newYear}年${newMonth}月${day}日`;
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
     * @param {Object} player - 玩家对象
     * @param {number} offlineDuration - 离线时长（秒）
     */
    processOfflineTime(player, offlineDuration) {
        if (!player.attributes) return;

        const hoursOffline = offlineDuration / 3600;
        const gameDaysPassed = hoursOffline; // 1现实小时=1游戏天（离线时）
        
        // 更新玩家年龄
        player.attributes.lifespan_current += gameDaysPassed / 365; // 转换为年
        
        // 应用属性恢复
        const attributeService = require('./AttributeMaxService');
        attributeService.applyAttributeRecovery(player, offlineDuration);
    }

    /**
     * 处理在线时间
     * @param {Object} player - 玩家对象
     * @param {number} onlineDuration - 在线时长（秒）
     */
    processOnlineTime(player, onlineDuration) {
        if (!player.attributes) return;

        const gameDaysPassed = onlineDuration / (60 * 60); // 1现实分钟=1游戏天（在线时）
        
        // 更新玩家年龄
        player.attributes.lifespan_current += gameDaysPassed / 365; // 转换为年
        
        // 应用属性恢复
        const attributeService = require('./AttributeMaxService');
        attributeService.applyAttributeRecovery(player, onlineDuration);
    }
}

module.exports = new DualTimeService();