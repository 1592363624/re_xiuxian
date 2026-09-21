/**
 * 通知服务
 * 处理系统通知的创建、查询和管理
 *
 * 已读状态以 notification_reads（(玩家, 通知) 回执）为准，不再改 system_notifications.isRead：
 * 那一列是行级的，全服公告在库里只有一行，任何人点已读都会让全服都不再提示未读。
 * 该列现在仅供历史数据兼容，读写均已迁移到回执表。
 */
const { Op, literal } = require('sequelize');
const SystemNotification = require('../../models/system_notification');
const NotificationRead = require('../../models/notification_read');
const eventBus = require('../../modules/infrastructure/EventBus');

/**
 * "该玩家还没读过这条通知"的 SQL 片段
 *
 * 用 NOT EXISTS 而不是先查回执 ID 再拼 Op.notIn：
 * 回执会随时间累积，把几千个 ID 塞进 IN() 会让列表和计数一起变慢；
 * 反查交给数据库，一次扫描到位。
 * @param {number} playerId
 * @returns {*} Sequelize literal
 */
function notReadBy(playerId) {
    // 数字强转后再内联：literal 不参与参数绑定，playerId 必须是安全的整数
    const safeId = Number.parseInt(playerId, 10);
    if (!Number.isInteger(safeId)) {
        throw new Error(`[NotificationService] playerId 必须是整数，收到：${playerId}`);
    }
    return literal(
        'NOT EXISTS (SELECT 1 FROM notification_reads r '
        + 'WHERE r.notificationId = `SystemNotification`.`id` AND r.playerId = ' + safeId + ')'
    );
}

/**
 * 该玩家可见的通知范围（发给本人 或 全服），并且未过期
 * @param {number} playerId
 * @returns {Object} Sequelize where 片段
 */
function visibleWhere(playerId) {
    const now = new Date();
    return {
        isActive: true,
        [Op.and]: [
            {
                [Op.or]: [
                    { targetPlayerId: playerId },
                    { targetPlayerId: null }
                ]
            },
            {
                [Op.or]: [
                    { expiresAt: null },
                    { expiresAt: { [Op.gt]: now } }
                ]
            }
        ]
    };
}

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
            // metadata 一并带出：公告配图地址（imageUrls）就存在这里，
            // WebSocketNotificationService 需要它才能把图片推给在线玩家
            eventBus.publish('notification:created', {
                notificationId: notification.id,
                type,
                title,
                content,
                priority,
                targetPlayerId,
                actorNickname,
                metadata
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
     * @param {Object} [metadata] - 附加数据；公告配图地址放在 metadata.imageUrls
     */
    async sendAnnouncement(title, content, priority = 'high', metadata = {}) {
        return this.createNotification({
            type: 'announcement',
            title,
            content,
            priority,
            targetPlayerId: null,
            metadata
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
            includeGlobal = true,
            includeInactive = false
        } = options;

        // includeInactive 只给 GM 后台用：撤回（isActive=false）后记录不会消失，
        // 否则 GM 一点撤回，这条公告就从列表里消失，"恢复"按钮也就永远点不到了。
        // 玩家侧必须保持只看见激活的通知，因此这里默认 false。
        const where = {};
        if (!includeInactive) {
            where.isActive = true;
        }

        // 如果包含全服通知
        if (includeGlobal) {
            where[Op.or] = [
                { targetPlayerId: playerId },
                { targetPlayerId: null }
            ];
        } else {
            where.targetPlayerId = playerId;
        }

        if (type) {
            where.type = type;
        }

        // 排除已过期的通知
        //
        // 必须与上面的"目标范围"是 AND 关系。以前的写法把过期条件也塞进同一个 Op.or：
        //   (target = 我 OR target = 全服 OR expiresAt IS NULL OR expiresAt > now)
        // 而绝大多数通知的 expiresAt 本来就是 NULL，最后一个恒真分支会让 targetPlayerId
        // 形同虚设 —— 玩家能拉到别的玩家的死亡/突破通知。
        // 玩家侧消息面板上线后这个泄漏就从"接口存在于文档里"变成了"界面上真的看得见"，必须堵上。
        const now = new Date();
        where[Op.and] = [
            {
                [Op.or]: [
                    { expiresAt: null },
                    { expiresAt: { [Op.gt]: now } }
                ]
            }
        ];

        // "只看未读"按回执表判定：行级 isRead 是全服共享的，不能拿来表达"这个玩家读过没"
        if (unreadOnly) {
            where[Op.and].push(notReadBy(playerId));
        }

        try {
            const { count, rows } = await SystemNotification.findAndCountAll({
                where,
                order: [['priority', 'DESC'], ['createdAt', 'DESC']],
                limit,
                offset: (page - 1) * limit
            });

            // 已读标记同样按回执表回填：这里覆盖掉 n.isRead，前端拿到的就是"我读了没有"
            const readSet = await this.collectReadIds(playerId, rows.map(n => n.id));

            return {
                total: count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
                notifications: rows.map(n => {
                    const json = n.toJSON();
                    return { ...json, isRead: readSet.has(String(json.id)) };
                })
            };
        } catch (error) {
            console.error('获取通知列表失败:', error);
            throw error;
        }
    }

    /**
     * 取某个玩家在给定通知里已经读过的那些
     * @param {number} playerId - 玩家ID
     * @param {Array<number>} notificationIds - 通知ID列表（为空时直接返回空集合，不查库）
     * @returns {Promise<Set<string>>} 已读的通知ID（字符串形式，避免 BIGINT 与 number 比较不一致）
     */
    async collectReadIds(playerId, notificationIds) {
        if (!Array.isArray(notificationIds) || notificationIds.length === 0) return new Set();

        const rows = await NotificationRead.findAll({
            attributes: ['notificationId'],
            where: {
                playerId,
                notificationId: { [Op.in]: notificationIds }
            },
            raw: true
        });

        return new Set(rows.map(r => String(r.notificationId)));
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
                [Op.or]: [
                    { expiresAt: null },
                    { expiresAt: { [Op.gt]: now } }
                ]
            },
            order: [['priority', 'DESC'], ['createdAt', 'DESC']],
            limit
        });
    }

    /**
     * 标记通知为已读（按玩家记回执）
     *
     * 只写 notification_reads，不再改 system_notifications.isRead：后者是行级的，
     * 一条全服公告只有一行，改它等于"一个人读过 → 全服都不再提示未读"。
     * @param {number} notificationId - 通知ID
     * @param {number} playerId - 玩家ID
     * @returns {Promise<{notificationId: number, playerId: number, created: boolean}>}
     *   created=false 表示此前已读过（重复点已读是幂等的）
     */
    async markAsRead(notificationId, playerId) {
        const notification = await SystemNotification.findOne({
            where: {
                id: notificationId,
                [Op.or]: [
                    { targetPlayerId: playerId },
                    { targetPlayerId: null }
                ]
            }
        });

        // 通知不存在（或不属于该玩家可见范围）时不写回执：
        // 否则玩家可以用任意 id 往回执表里灌数据
        if (!notification) {
            return { notificationId, playerId, created: false, exists: false };
        }

        const now = new Date();
        const [receipt, created] = await NotificationRead.findOrCreate({
            where: { playerId, notificationId },
            defaults: { playerId, notificationId, readAt: now }
        });

        // 回执已存在但 readAt 为空（历史数据）时补一次时间
        if (!created && !receipt.readAt) {
            receipt.readAt = now;
            await receipt.save();
        }

        return { notificationId, playerId, created, exists: true };
    }

    /**
     * 标记所有通知为已读（批量写回执）
     *
     * 只补"还没读过"的那些：bulkCreate 走唯一索引，重复回执会被数据库挡掉，
     * 但先查一次能少发一大半 INSERT，也让返回值能如实报"这次新增了多少条"。
     * @param {number} playerId - 玩家ID
     * @returns {Promise<number>} 本次新增的回执条数
     */
    async markAllAsRead(playerId) {
        const rows = await SystemNotification.findAll({
            attributes: ['id'],
            where: visibleWhere(playerId),
            raw: true
        });
        if (rows.length === 0) return 0;

        const ids = rows.map(r => r.id);
        const alreadyRead = await this.collectReadIds(playerId, ids);
        const missing = ids.filter(id => !alreadyRead.has(String(id)));
        if (missing.length === 0) return 0;

        const now = new Date();
        await NotificationRead.bulkCreate(
            missing.map(notificationId => ({ playerId, notificationId, readAt: now }))
        );

        return missing.length;
    }

    /**
     * 获取未读通知数量（按回执表排除已读）
     * @param {number} playerId - 玩家ID
     */
    async getUnreadCount(playerId) {
        const where = visibleWhere(playerId);
        where[Op.and].push(notReadBy(playerId));

        return SystemNotification.count({ where });
    }

    /**
     * 更新通知的可编辑字段（标题 / 内容 / 优先级 / 配图）
     *
     * 为什么放在服务层而不是直接写在路由里：routes/admin.js 同时 import 了 Item 模型，
     * 而 BlobColumnCensus 门禁按"文件里 require 了哪个模型"归属写方 ——
     * 在路由里写 `.update({ ... metadata: ... })` 会被它当成"item.metadata 又多了一个写方"
     * （实际改的是 system_notifications.metadata，一个 TEXT 列）。
     * 顺带这也让"编辑通知"的读改写集中在一处，路由只做参数校验与日志。
     *
     * @param {number} id - 通知ID
     * @param {{title: string, content: string, priority: string, imageUrls: string[]}} fields - 完整字段（非部分更新）
     * @returns {Promise<{before: Object, after: Object}|null>} null 表示通知不存在
     */
    async updateNotificationFields(id, fields) {
        const notification = await SystemNotification.findByPk(id);
        if (!notification) return null;

        // metadata 里除了 imageUrls 可能还有别的键（历史数据），合并而不是整体替换
        let metadata = {};
        try {
            metadata = JSON.parse(notification.metadata || '{}') || {};
        } catch {
            metadata = {};
        }

        const before = {
            title: notification.title,
            content: notification.content,
            priority: notification.priority,
            imageUrls: Array.isArray(metadata.imageUrls) ? metadata.imageUrls : []
        };

        await notification.update({
            title: fields.title,
            content: fields.content,
            priority: fields.priority,
            metadata: JSON.stringify({ ...metadata, imageUrls: fields.imageUrls })
        });

        return { before, after: { ...fields } };
    }

    /**
     * 删除指定通知的已读回执
     *
     * 通知被删掉后回执就成了死数据，且会让"未读计数"的 NOT EXISTS 白白多扫。
     * @param {Array<number>} notificationIds - 通知ID列表
     * @returns {Promise<number>} 删除的回执条数
     */
    async deleteReadReceipts(notificationIds) {
        if (!Array.isArray(notificationIds) || notificationIds.length === 0) return 0;

        return NotificationRead.destroy({
            where: { notificationId: { [Op.in]: notificationIds } }
        });
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
                    expiresAt: { [Op.lt]: now }
                }
            }
        );
    }
}

module.exports = new NotificationService();
