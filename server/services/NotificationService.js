/**
 * 通知服务
 * 处理系统通知的创建、查询和管理
 */
const SystemNotification = require('../models/system_notification');
const eventBus = require('../modules/infrastructure/EventBus');

class NotificationService {
    /**
     * 创建新通知
     * @param {Object} params - 通知参数
     */
    async createNotification({
        type,
        title,
        content,
        priority = 'normal',
        targetPlayerId = null,
        actorPlayerId = null,
        actorNickname = null,
        metadata = {},
        expiresAt = null
    }) {
        try {
            const notification = await SystemNotification.create({
                type,
                title,
                content,
                priority,
                targetPlayerId,
                actorPlayerId,
                actorNickname,
                metadata: JSON.stringify(metadata),
                expiresAt
            });

            // 通过事件总线广播通知
            eventBus.publish('notification:created', {
                notificationId: notification.id,
                type,
                title,
                content,
                priority,
                targetPlayerId,
                actorNickname
            }, {
                from: 'NotificationService'
            });

            return notification;
        } catch (error) {
            console.error('创建通知失败:', error);
            throw error;
        }
    }

    /**
     * 发送全服公告
     * @param {string} title - 标题
     * @param {string} content - 内容
     * @param {string} priority - 优先级
     */
    async sendAnnouncement(title, content, priority = 'high') {
        return this.createNotification({
            type: 'announcement',
            title,
            content,
            priority,
            targetPlayerId: null
        });
    }

    /**
     * 发送突破通知
     * @param {Object} player - 玩家信息
     * @param {string} oldRealm - 原境界
     * @param {string} newRealm - 新境界
     */
    async sendBreakthroughNotification(player, oldRealm, newRealm) {
        const content = `恭喜【${player.nickname}】成功突破！从【${oldRealm}】晋升为【${newRealm}】！`;
        
        const notification = await this.createNotification({
            type: 'breakthrough',
            title: '境界突破',
            content,
            priority: 'high',
            actorPlayerId: player.id,
            actorNickname: player.nickname,
            metadata: { oldRealm, newRealm, playerId: player.id }
        });

        // 发送全服通知
        await this.sendAnnouncement('境界突破', content, 'high');
        
        return notification;
    }

    /**
     * 发送死亡通知
     * @param {Object} player - 玩家信息
     * @param {string} reason - 死亡原因
     */
    async sendDeathNotification(player, reason) {
        const content = `【${player.nickname}】因${reason}，兵解轮回，修为尽失`;
        
        return this.createNotification({
            type: 'death',
            title: '兵解轮回',
            content,
            priority: 'normal',
            targetPlayerId: player.id,
            actorPlayerId: player.id,
            actorNickname: player.nickname,
            metadata: { reason, playerId: player.id }
        });
    }

    /**
     * 发送成就通知
     * @param {Object} player - 玩家信息
     * @param {string} achievementName - 成就名称
     */
    async sendAchievementNotification(player, achievementName) {
        const content = `【${player.nickname}】达成了成就：【${achievementName}】`;
        
        return this.createNotification({
            type: 'achievement',
            title: '成就达成',
            content,
            priority: 'normal',
            actorPlayerId: player.id,
            actorNickname: player.nickname,
            metadata: { achievementName, playerId: player.id }
        });
    }

    /**
     * 发送里程碑通知
     * @param {Object} player - 玩家信息
     * @param {string} milestone - 里程碑描述
     */
    async sendMilestoneNotification(player, milestone) {
        const content = `【${player.nickname}】${milestone}`;
        
        return this.createNotification({
            type: 'milestone',
            title: '里程碑',
            content,
            priority: 'normal',
            actorPlayerId: player.id,
            actorNickname: player.nickname,
            metadata: { milestone, playerId: player.id }
        });
    }

    /**
     * 发送警告通知
     * @param {string} content - 警告内容
     * @param {string} priority - 优先级
     */
    async sendWarning(content, priority = 'high') {
        return this.createNotification({
            type: 'warning',
            title: '系统警告',
            content,
            priority
        });
    }

    /**
     * 发送重要事件通知
     * @param {string} eventName - 事件名称
     * @param {string} content - 事件内容
     */
    async sendEventNotification(eventName, content) {
        return this.createNotification({
            type: 'event',
            title: eventName,
            content,
            priority: 'high'
        });
    }

    /**
     * 获取玩家通知列表
     * @param {number} playerId - 玩家ID
     * @param {Object} options - 查询选项
     */
    async getPlayerNotifications(playerId, options = {}) {
        const {
            page = 1,
            limit = 20,
            type = null,
            unreadOnly = false,
            includeGlobal = true
        } = options;

        const where = {
            isActive: true
        };

        // 如果包含全服通知
        if (includeGlobal) {
            where[Symbol.or] = [
                { targetPlayerId: playerId },
                { targetPlayerId: null }
            ];
        } else {
            where.targetPlayerId = playerId;
        }

        if (type) {
            where.type = type;
        }

        if (unreadOnly) {
            where.isRead = false;
        }

        // 排除已过期的通知
        const now = new Date();
        where[Symbol.or] = [
            where[Symbol.or],
            { expiresAt: null },
            { expiresAt: { [Symbol.gt]: now } }
        ];

        try {
            const { count, rows } = await SystemNotification.findAndCountAll({
                where,
                order: [['priority', 'DESC'], ['createdAt', 'DESC']],
                limit,
                offset: (page - 1) * limit
            });

            return {
                total: count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
                notifications: rows.map(n => n.toJSON())
            };
        } catch (error) {
            console.error('获取通知列表失败:', error);
            throw error;
        }
    }

    /**
     * 获取全服重要通知（用于新玩家登录时显示）
     * @param {number} limit - 获取数量
     */
    async getGlobalNotifications(limit = 10) {
        const now = new Date();
        
        return SystemNotification.findAll({
            where: {
                targetPlayerId: null,
                isActive: true,
                [Symbol.or]: [
                    { expiresAt: null },
                    { expiresAt: { [Symbol.gt]: now } }
                ]
            },
            order: [['priority', 'DESC'], ['createdAt', 'DESC']],
            limit
        });
    }

    /**
     * 标记通知为已读
     * @param {number} notificationId - 通知ID
     * @param {number} playerId - 玩家ID
     */
    async markAsRead(notificationId, playerId) {
        const notification = await SystemNotification.findOne({
            where: {
                id: notificationId,
                [Symbol.or]: [
                    { targetPlayerId: playerId },
                    { targetPlayerId: null }
                ]
            }
        });

        if (notification) {
            notification.isRead = true;
            notification.readAt = new Date();
            await notification.save();
        }

        return notification;
    }

    /**
     * 标记所有通知为已读
     * @param {number} playerId - 玩家ID
     */
    async markAllAsRead(playerId) {
        return SystemNotification.update(
            { isRead: true, readAt: new Date() },
            {
                where: {
                    targetPlayerId: playerId,
                    isRead: false
                }
            }
        );
    }

    /**
     * 获取未读通知数量
     * @param {number} playerId - 玩家ID
     */
    async getUnreadCount(playerId) {
        const count = await SystemNotification.count({
            where: {
                [Symbol.or]: [
                    { targetPlayerId: playerId },
                    { targetPlayerId: null }
                ],
                isRead: false,
                isActive: true
            }
        });

        return count;
    }

    /**
     * 删除过期通知
     */
    async cleanupExpiredNotifications() {
        const now = new Date();
        return SystemNotification.update(
            { isActive: false },
            {
                where: {
                    isActive: true,
                    expiresAt: { [Symbol.lt]: now }
                }
            }
        );
    }
}

module.exports = new NotificationService();
