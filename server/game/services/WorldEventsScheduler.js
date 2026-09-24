/**
 * 天道世界事件调度器
 * 每 interval_minutes 触发一次祥瑞/厄运并全服公告（帖：每隔 1 小时天道演化一次）
 */
'use strict';

const WorldEventsService = require('./WorldEventsService');

class WorldEventsScheduler {
    constructor() {
        this.timer = null;
    }

    getConfig() {
        const c = WorldEventsService.config().world_events || {};
        return {
            enabled: c.enabled !== false,
            interval_ms: (Number(c.interval_minutes) || 60) * 60000
        };
    }

    async runOnce() {
        const event = await WorldEventsService.trigger();
        if (event) {
            console.log(`[世界事件] 【${event.title}】${event.desc}`);
        }
        return event;
    }

    start() {
        if (this.timer) return false;
        const config = this.getConfig();
        if (!config.enabled) {
            console.log('[世界事件] 配置关闭，未启动');
            return false;
        }
        this.timer = setInterval(() => {
            this.runOnce().catch(err => console.error('[世界事件] 执行失败:', err.message));
        }, config.interval_ms);
        console.log(`[世界事件] 调度器已启动 (${config.interval_ms}ms)`);
        return true;
    }

    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = new WorldEventsScheduler();
