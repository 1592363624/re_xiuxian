/**
 * 通知调度服务
 *
 * 两件事，都是公告"按时生效"所必需的：
 *   1. 预约发布：publishAt 到点的公告推给在线玩家。
 *      注意可见性其实由查询条件（visibleWhere）保证，调度器不负责"让公告可见"，
 *      它只负责"该弹的那一下"—— 所以调度器停摆也不会出现"公告该看见却看不见"。
 *   2. 自动下架：expiresAt 到期的公告置 isActive=false 并清理其已读回执
 *      （回执表与通知的存活周期挂钩，见 NotificationService.cleanupExpiredNotifications）。
 *
 * 反复启动是幂等的（start() 有 timer 保护），便于在 index.js 里与其它调度器并列摆放。
 */
'use strict';

const configLoader = require('../../modules/infrastructure/ConfigLoader');
const NotificationService = require('./NotificationService');

/** 配置未就绪时的兜底值 */
const FALLBACK_SCHEDULER = { enabled: true, interval_ms: 60000, batch_size: 200 };

class NotificationSchedulerService {
    constructor() {
        this.timer = null;
        this.running = false;
    }

    /**
     * 读取调度配置（每次现读，热更新即时生效）
     * @returns {{enabled: boolean, interval_ms: number, batch_size: number}}
     */
    getConfig() {
        const configured = configLoader.peekConfig('notification_policy')?.scheduler || {};
        return { ...FALLBACK_SCHEDULER, ...configured };
    }

    /**
     * 执行一轮：先推预约公告，再下架过期公告
     *
     * 顺序有意为之：下架会把过期公告的可见性彻底关掉，若先下架，
     * 一条"预约时间与过期时间都落在同一轮"的畸形公告会连推都推不出去。
     * @returns {Promise<{pushed: number, expired: number, receiptsRemoved: number, skipped: boolean}>}
     */
    async runOnce() {
        const config = this.getConfig();
        if (!config.enabled) {
            return { pushed: 0, expired: 0, receiptsRemoved: 0, skipped: true };
        }

        // 上一轮还没跑完就跳过：两轮叠在一起会对同一条公告重复广播
        if (this.running) {
            return { pushed: 0, expired: 0, receiptsRemoved: 0, skipped: true };
        }
        this.running = true;

        try {
            const pushed = await this.publishDue(config.batch_size);
            const { expired, receiptsRemoved } = await NotificationService.cleanupExpiredNotifications(config.batch_size);

            if (pushed > 0 || expired > 0) {
                console.log(`[通知调度] 推送预约公告 ${pushed} 条，自动下架 ${expired} 条，清理回执 ${receiptsRemoved} 条`);
            }

            return { pushed, expired, receiptsRemoved, skipped: false };
        } finally {
            this.running = false;
        }
    }

    /**
     * 推送到点的预约公告
     * @param {number} batchSize
     * @returns {Promise<number>} 实际推送条数
     */
    async publishDue(batchSize) {
        const due = await NotificationService.getDueScheduledNotifications(batchSize);
        if (due.length === 0) return 0;

        // 懒加载：WebSocketNotificationService 在模块加载时会读图标配置，
        // 顶层 require 会让本服务在配置就绪前被 require 时直接抛错
        const WebSocketNotificationService = require('./WebSocketNotificationService');

        let pushed = 0;
        for (const notification of due) {
            try {
                const json = notification.toJSON();
                WebSocketNotificationService.sendGlobalAnnouncement({
                    id: json.id,
                    type: json.type,
                    title: json.title,
                    content: json.content,
                    priority: json.priority,
                    imageUrls: this.extractImageUrls(json)
                });
                await NotificationService.markAsPushed(notification);
                pushed += 1;
                console.log(`[通知调度] 预约公告已推送: #${json.id} ${json.title}`);
            } catch (error) {
                // 单条失败不影响同批其它公告；下一轮会重试（notice_pushed 尚未写入）
                console.error(`[通知调度] 推送预约公告 #${notification.id} 失败:`, error.message);
            }
        }

        return pushed;
    }

    /**
     * 取通知携带的配图地址
     * @param {Object} notificationJson - toJSON() 结果
     * @returns {string[]}
     */
    extractImageUrls(notificationJson) {
        try {
            const metadata = JSON.parse(notificationJson?.metadata || '{}') || {};
            return Array.isArray(metadata.imageUrls) ? metadata.imageUrls : [];
        } catch {
            return [];
        }
    }

    /**
     * 启动定时调度
     * @returns {boolean} 是否真的启动了（已启动或配置关闭时返回 false）
     */
    start() {
        if (this.timer) return false;

        const config = this.getConfig();
        if (!config.enabled) {
            console.log('[通知调度] 配置关闭，未启动');
            return false;
        }

        this.timer = setInterval(() => {
            this.runOnce().catch(err => console.error('[通知调度] 执行失败:', err.message));
        }, config.interval_ms);

        // 首轮不等一个间隔：进程重启后把停机期间到点的公告补推
        setImmediate(() => {
            this.runOnce().catch(err => console.error('[通知调度] 首轮执行失败:', err.message));
        });

        console.log(`[通知调度] 已启动 (${config.interval_ms}ms)`);
        return true;
    }

    /**
     * 停止调度（便于测试与优雅停机）
     */
    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = new NotificationSchedulerService();
