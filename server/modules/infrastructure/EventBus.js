/**
 * 事件总线模块
 * 提供模块间异步事件通信机制
 * 基础设施层的核心通信组件
 */
const EventEmitter = require('events');

class EventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
        this.eventHistory = [];
        this.maxHistorySize = 1000;
        this.eventFilters = new Map();
    }

    /**
     * 发布事件
     * @param {string} eventId - 事件ID
     * @param {object} data - 事件数据
     * @param {object} metadata - 元数据
     */
    publish(eventId, data, metadata = {}) {
        const event = {
            eventId,
            data,
            metadata: {
                ...metadata,
                timestamp: Date.now(),
                from: metadata.from || 'unknown'
            }
        };

        this.eventHistory.push(event);
        if (this.eventHistory.length > this.maxHistorySize) {
            this.eventHistory.shift();
        }

        this.emit(eventId, event);
        
        return event;
    }

    /**
     * 订阅事件
     * @param {string} eventId - 事件ID
     * @param {Function} callback - 回调函数
     * @param {object} options - 选项
     */
    subscribe(eventId, callback, options = {}) {
        const handler = (event) => {
            if (options.filter && !options.filter(event)) {
                return;
            }
            callback(event);
        };

        this.on(eventId, handler);

        return {
            unsubscribe: () => {
                this.off(eventId, handler);
            }
        };
    }

    /**
     * 订阅一次性事件
     * @param {string} eventId - 事件ID
     * @param {Function} callback - 回调函数
     */
    subscribeOnce(eventId, callback) {
        this.once(eventId, callback);
    }

    /**
     * 批量订阅事件
     * @param {object} subscriptions - 事件订阅映射
     */
    subscribeBatch(subscriptions) {
        const unsubscribers = [];
        
        for (const [eventId, callback] of Object.entries(subscriptions)) {
            const unsubscribe = this.subscribe(eventId, callback);
            unsubscribers.push(unsubscribe);
        }

        return {
            unsubscribeAll: () => {
                unsubscribers.forEach(unsub => unsub.unsubscribe());
            }
        };
    }

    /**
     * 获取事件历史
     * @param {object} filter - 过滤条件
     */
    getEventHistory(filter = {}) {
        let history = [...this.eventHistory];

        if (filter.eventId) {
            history = history.filter(e => e.eventId === filter.eventId);
        }
        if (filter.from) {
            history = history.filter(e => e.metadata.from === filter.from);
        }
        if (filter.startTime) {
            history = history.filter(e => e.metadata.timestamp >= filter.startTime);
        }
        if (filter.endTime) {
            history = history.filter(e => e.metadata.timestamp <= filter.endTime);
        }

        return history;
    }

    /**
     * 清空事件历史
     */
    clearHistory() {
        this.eventHistory = [];
    }

    /**
     * 获取事件统计信息
     */
    getStats() {
        const stats = {};
        for (const event of this.eventHistory) {
            stats[event.eventId] = (stats[event.eventId] || 0) + 1;
        }
        return stats;
    }
}

module.exports = new EventBus();
