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
const configLoader = require('../../modules/infrastructure/ConfigLoader');

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
 * 该玩家可见的通知范围：发给本人或全服、已到发布时间、且未过期
 *
 * 发布时间（publishAt）写进查询条件而不是只靠定时器去"改状态"：
 * 调度器停摆、或玩家恰好在到点前后刷新，看到的结果都一致。
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
                    { publishAt: null },
                    { publishAt: { [Op.lte]: now } }
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

/**
 * 读取通知的 metadata（TEXT 列，存的是一段 JSON）
 * @param {Object} notification - SystemNotification 实例或 toJSON() 结果
 * @returns {Object} 解析失败时返回空对象，绝不抛错
 */
function parseMetadata(notification) {
    try {
        return JSON.parse(notification?.metadata || '{}') || {};
    } catch {
        return {};
    }
}

/**
 * 以"我读到的那份原值 == 库里现在的值"为条件写回 metadata（乐观并发 / CAS），撞车就重读再合。
 *
 * 为什么需要：`metadata` 是一个 TEXT 里装 JSON 的**整块列**，SQL 没法只改其中一个键，
 * 只能整块写。而它有两个互不知晓的写入方：GM 编辑公告（写 imageUrls、清 notice_pushed）
 * 与调度器打推送标记（写 notice_pushed / pushed_at）。以前的两条都是
 * "无锁读 → 内存里合并 → update 整块"，交错起来就是标准的旧快照覆盖新快照：
 *   调度器刚标完已推送，GM 那笔编辑把手上更早读到的那份写回去 → notice_pushed 丢了
 *     → 同一张公告下一轮又全服弹一次（这条代码自己注释里最怕的就是重复弹窗）；
 *   反过来 GM 先写入配图、调度器用旧的一份写回 → 玩家的公告图上凭空少一张图。
 *
 * 为什么用 CAS 而不是 FOR UPDATE：这一行玩家只读不写，但它是**全服共享**的一行，
 * 为一块 JSON 的合并把行锁跨在两次 await 上没有收益；把原值放进 where 恰好就是把
 * "我这一整块是基于库里最新那份算的"这句话写进了语句本身，数据库自己保证它成立。
 * where 里 metadata 传 null 时 Sequelize 出 `IS NULL`，与"库里还没写过 metadata"对得上。
 *
 * @param {number} id - 通知 ID
 * @param {string|undefined} expected - 调用方手上那份 metadata 原文；undefined 表示先读一次
 * @param {Object} [columns] - 与 metadata 同一条语句一起写的其它列（整块原子写）
 * @param {Function} merge - (当前解析出的对象) => 新对象
 * @returns {Promise<{metadata: Object, changed: boolean}|null>} null = 通知不存在
 */
async function mergeMetadataCas({ id, expected, columns = {}, merge }) {
    let previous = expected;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (previous === undefined) {
            const row = await SystemNotification.findByPk(id, { attributes: ['id', 'metadata'] });
            if (!row) return null;
            previous = row.metadata;
        }
        const next = merge(parseMetadata({ metadata: previous })) || {};
        const nextText = JSON.stringify(next);
        if (nextText === previous) return { metadata: next, changed: false };

        const affected = await SystemNotification.update(
            { ...columns, metadata: nextText },
            { where: { id, metadata: previous } }
        );
        if (Number(Array.isArray(affected) ? affected[0] : affected) === 1) {
            return { metadata: next, changed: true };
        }
        previous = undefined;   // 有人先写过：下一轮重读最新那份再合，绝不拿旧的硬盖
    }
    throw new Error(`公告 #${id} 的属性连续 4 轮撞车，请重试这次操作`);
}

/** 配置未就绪时的兜底策略（与其它服务同一套思路） */
const FALLBACK_POLICY = {
    scheduler: { enabled: true, interval_ms: 60000, batch_size: 200 },
    retention: { delete_receipts_on_expire: true },
    republish_notice: {
        enabled: true,
        max_recipients: 5000,
        title: '公告已更正',
        content: '你读过的公告《{title}》已被管理员更正，请留意最新内容。',
        priority: 'normal'
    }
};

/**
 * 读取通知策略配置（每次现读，热更新即时生效）
 * @returns {Object} 与 FALLBACK_POLICY 同结构
 */
function getPolicy() {
    const raw = configLoader.peekConfig('notification_policy') || {};
    return {
        scheduler: { ...FALLBACK_POLICY.scheduler, ...(raw.scheduler || {}) },
        retention: { ...FALLBACK_POLICY.retention, ...(raw.retention || {}) },
        republish_notice: { ...FALLBACK_POLICY.republish_notice, ...(raw.republish_notice || {}) }
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
        publishAt = null,
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
                publishAt,
                expiresAt
            });

            // 通过事件总线广播通知
            //
            // 预约发布的公告（publishAt 在未来）在这里**不广播**：它此刻还对玩家不可见，
            // 提前推弹窗会直接暴露未发布内容。到点由 NotificationSchedulerService 推送。
            const isScheduled = publishAt instanceof Date && publishAt.getTime() > Date.now();
            if (!isScheduled) {
                eventBus.publish('notification:created', {
                    notificationId: notification.id,
                    type,
                    title,
                    content,
                    priority,
                    targetPlayerId,
                    actorNickname,
                    // metadata 一并带出：公告配图地址（imageUrls）就存在这里，
                    // WebSocketNotificationService 需要它才能把图片推给在线玩家
                    metadata
                }, {
                    from: 'NotificationService'
                });
            }

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
     * @param {Object} [schedule] - 定时设置 { publishAt, expiresAt }（均为 Date 或 null）
     */
    async sendAnnouncement(title, content, priority = 'high', metadata = {}, schedule = {}) {
        return this.createNotification({
            type: 'announcement',
            title,
            content,
            priority,
            targetPlayerId: null,
            metadata,
            publishAt: schedule.publishAt || null,
            expiresAt: schedule.expiresAt || null
        });
    }

    /**
     * 发送突破通知
     *
     * 只写一条。以前这里写完 type='breakthrough' 的记录后又调了一次
     * sendAnnouncement('境界突破', 同样的正文)，而两条的 targetPlayerId 都是 null
     * —— getPlayerNotifications 把 null 当全服可见，于是同一条突破在每个玩家的
     * 「公告」面板里出现两遍（一条标"突破"、一条标"公告"），socket 也会弹两次。
     * 探针号跑了几十天之后公告攒到 234 条，一半是这种复读。
     *
     * @param {Object} player - 玩家信息
     * @param {string} oldRealm - 原境界
     * @param {string} newRealm - 新境界
     */
    async sendBreakthroughNotification(player, oldRealm, newRealm) {
        const content = `恭喜【${player.nickname}】成功突破！从【${oldRealm}】晋升为【${newRealm}】！`;

        // 全服播报：targetPlayerId 留空即为全服可见，不需要再补一条 announcement
        return this.createNotification({
            type: 'breakthrough',
            title: '境界突破',
            content,
            priority: 'high',
            actorPlayerId: player.id,
            actorNickname: player.nickname,
            metadata: { oldRealm, newRealm, playerId: player.id }
        });
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
                // 与 visibleWhere 同一口径：预约未到点的公告不能提前露出来
                [Op.or]: [
                    { publishAt: null },
                    { publishAt: { [Op.lte]: now } }
                ],
                [Op.and]: [
                    {
                        [Op.or]: [
                            { expiresAt: null },
                            { expiresAt: { [Op.gt]: now } }
                        ]
                    }
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
     * @param {{title: string, content: string, priority: string, imageUrls: string[],
     *          publishAt?: Date|null, expiresAt?: Date|null}} fields - 完整字段（非部分更新）
     * @returns {Promise<{before: Object, after: Object}|null>} null 表示通知不存在
     */
    async updateNotificationFields(id, fields) {
        const notification = await SystemNotification.findByPk(id);
        if (!notification) return null;

        // metadata 里除了 imageUrls 可能还有别的键（历史数据），合并而不是整体替换
        const metadata = parseMetadata(notification);

        const before = {
            title: notification.title,
            content: notification.content,
            priority: notification.priority,
            imageUrls: Array.isArray(metadata.imageUrls) ? metadata.imageUrls : [],
            publishAt: notification.publishAt,
            expiresAt: notification.expiresAt
        };

        // 时间字段只在调用方真的传了才改（undefined = 不动），这样编辑文字不会顺手把预约时间清掉
        const nextPublishAt = fields.publishAt === undefined ? notification.publishAt : fields.publishAt;
        const nextExpiresAt = fields.expiresAt === undefined ? notification.expiresAt : fields.expiresAt;

        // 改期到未来 → 清掉"已推送"标记，调度器到点会重新推一次（等价于"重新预约发布"）；
        // 改成过去时间则保留该标记：把时间往回调不该变成一次全服重复弹窗。
        // 合并与写入都交给 mergeMetadataCas：这一列是整块 JSON，两个写入方交错时
        // 拿旧快照 update 整块就会把对方的键抹掉（notice_pushed 被抹 → 重复全服弹窗）。
        const edited = await mergeMetadataCas({
            id,
            expected: notification.metadata,
            columns: {
                title: fields.title,
                content: fields.content,
                priority: fields.priority,
                publishAt: nextPublishAt,
                expiresAt: nextExpiresAt
            },
            merge: (metadata) => {
                const next = { ...metadata, imageUrls: fields.imageUrls };
                if (nextPublishAt && new Date(nextPublishAt).getTime() > Date.now()) {
                    delete next.notice_pushed;
                    delete next.pushed_at;
                }
                return next;
            }
        });
        if (!edited) return null;         // 通知在两次读之间被删掉了

        return {
            before,
            after: { ...fields, publishAt: nextPublishAt, expiresAt: nextExpiresAt }
        };
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
     * 自动下架过期通知，并清理它们的已读回执
     *
     * 回执与通知的存活周期挂钩：下架后玩家再也看不到这条通知，
     * 留着回执只会让未读计数的 NOT EXISTS 白扫——回执表会随"公告数 × 活跃玩家数"增长，
     * 不设回收口子的话它是唯一只涨不落的一张表。
     * 开关在 notification_policy.retention.delete_receipts_on_expire。
     *
     * 注意：这里只处理"到期自动下架"，GM 手动撤回（unpublish）**不动回执**——
     * 撤回随时可能恢复，回执删了玩家就要重新读一遍。
     *
     * @param {number} [limit] - 单批处理条数
     * @returns {Promise<{expired: number, receiptsRemoved: number}>}
     */
    async cleanupExpiredNotifications(limit = getPolicy().scheduler.batch_size) {
        const now = new Date();

        // 先取 ID 再更新：既要拿到准确的条数写日志，也要知道该删哪些回执
        const rows = await SystemNotification.findAll({
            attributes: ['id'],
            where: {
                isActive: true,
                expiresAt: { [Op.lt]: now }
            },
            limit,
            raw: true
        });
        if (rows.length === 0) return { expired: 0, receiptsRemoved: 0 };

        const ids = rows.map(row => row.id);
        await SystemNotification.update({ isActive: false }, { where: { id: { [Op.in]: ids } } });

        const receiptsRemoved = getPolicy().retention.delete_receipts_on_expire
            ? await this.deleteReadReceipts(ids)
            : 0;

        return { expired: ids.length, receiptsRemoved };
    }

    /**
     * 取到点需要推送的预约公告
     *
     * "是否已推送"记在 metadata.notice_pushed 而不是新开一列：
     * 它纯粹是调度器的内部标记，不参与任何业务查询，没必要为它加字段与迁移。
     * @param {number} limit - 单批条数
     * @returns {Promise<Array>}
     */
    async getDueScheduledNotifications(limit = getPolicy().scheduler.batch_size) {
        const now = new Date();
        const rows = await SystemNotification.findAll({
            where: {
                isActive: true,
                // 到了发布时间、且尚未过期（同一字段上的两个操作符按 AND 组合）
                publishAt: { [Op.ne]: null, [Op.lte]: now },
                [Op.or]: [
                    { expiresAt: null },
                    { expiresAt: { [Op.gt]: now } }
                ]
            },
            order: [['publishAt', 'ASC']],
            limit
        });

        // metadata 是 TEXT，SQL 里没法可靠地按 JSON 键过滤（MySQL 5.6 没有 JSON 函数），
        // 所以"是否已推送"在应用层判：每批至多 batch_size 条，代价可以接受
        return rows.filter(row => parseMetadata(row).notice_pushed !== true);
    }

    /**
     * 标记预约公告已推送过（避免调度器每轮重复广播）
     *
     * 调用方传的是它从库里读到的那一行；这里只取它的 id 与那份 metadata 原文，
     * 写入走 mergeMetadataCas（where 带上原值）—— 调度器读行与写标记之间隔着一整段广播，
     * 那期间 GM 完全可能编辑过同一条公告，直接 update 整块就会把新配图抹掉。
     * @param {Object|number} notification - SystemNotification 实例（或通知 ID）
     * @returns {Promise<boolean>} true = 这一次真的把标记写上了（调用方据此计数/失败重试）
     */
    async markAsPushed(notification) {
        const id = typeof notification === 'object' && notification !== null ? notification.id : notification;
        if (!id) return false;
        const expected = typeof notification === 'object' && notification !== null
            ? notification.metadata : undefined;

        let wanted = false;
        const merged = await mergeMetadataCas({
            id,
            expected,
            merge: (metadata) => {
                if (metadata.notice_pushed === true) return metadata;   // 原样返回 → 不写
                wanted = true;
                return { ...metadata, notice_pushed: true, pushed_at: new Date().toISOString() };
            }
        });
        // 返回的是"这一次真的把标记落库了吗"，不是"我想写"：两条腿同时进来时，
        // 后写的那一条 CAS 撞车 → 重读发现已标记 → 一行都没改。调用方（调度器）据此计数，
        // 报"我想写"会让它以为自己是第一个推的，同一张公告就可能被算两次广播。
        return !!merged && merged.changed === true && wanted;
    }

    /**
     * 通知"已经读过这条公告的人"：公告被更正了
     *
     * 做法是**重置他们的已读回执**（未读红点回来、未读计数 +1）而不是给每人插一行通知：
     *   - 重置能让离线玩家下次打开消息面板时就看见它重新是未读的，覆盖面比 socket 更广；
     *   - 而给几千个读者各插一行 system_notifications，会让通知表按"人数 × 公告数"膨胀，
     *     这些行本身又没有任何独立内容。
     * socket 推送只是"在线的人立刻知道"的补充，因此按 max_recipients 截断。
     *
     * @param {Object} notification - 被编辑的通知（SystemNotification 实例）
     * @returns {Promise<{readers: number, pushed: number, reset: boolean}>}
     */
    async notifyReadersOfUpdate(notification) {
        const policy = getPolicy().republish_notice;
        if (!policy.enabled) return { readers: 0, pushed: 0, reset: false };

        const rows = await NotificationRead.findAll({
            attributes: ['playerId'],
            where: { notificationId: notification.id },
            raw: true
        });
        if (rows.length === 0) return { readers: 0, pushed: 0, reset: false };

        const readerIds = rows.map(row => row.playerId);
        await this.deleteReadReceipts([notification.id]);

        // 懒加载：WebSocketNotificationService 在模块加载时会去 ConfigLoader 取图标配置，
        // 顶层引入会让本服务在配置就绪前被 require 时直接抛错
        let pushed = 0;
        try {
            const WebSocketNotificationService = require('./WebSocketNotificationService');
            const content = String(policy.content || '').replace(/\{title\}/g, notification.title || '');
            for (const playerId of readerIds.slice(0, policy.max_recipients)) {
                WebSocketNotificationService.sendToPlayer(playerId, {
                    type: 'announcement',
                    title: policy.title,
                    content,
                    priority: policy.priority,
                    targetPlayerId: playerId
                });
                pushed += 1;
            }
        } catch (error) {
            // 推送失败不该回滚"重置回执"——玩家重新看到未读才是主要目的
            console.warn('[通知] 公告更正推送失败:', error.message);
        }

        return { readers: readerIds.length, pushed, reset: true };
    }
}

module.exports = new NotificationService();
