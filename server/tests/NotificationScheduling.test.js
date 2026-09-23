/**
 * 通知定时与重提示的不变量（不连库、不起服务）
 *
 * 钉的四件事：
 *   1. 预约发布的公告在到点前**不可见、不计未读、也不广播**（提前推弹窗 = 直接泄露未发布内容）；
 *   2. 自动下架要与已读回执清理挂钩 —— 回执表是本仓库唯一只涨不落的表，不设回收口子必然膨胀；
 *      但 GM 手动撤回**不能**动回执（撤回可恢复，删了玩家得重读一遍）；
 *   3. 调度器只负责"该弹的那一下"，可见性由查询条件保证，所以停摆也不会出现"该看见却看不见"；
 *   4. 重提示走"重置回执"而不是给每个读者插一行通知（后者会让通知表按人数膨胀）。
 *
 * 测试策略：mock 两张表 + EventBus + WebSocket 服务，只验证调用形状与返回值。
 */
'use strict';

const { Op } = require('sequelize');

jest.mock('../models/system_notification', () => ({
    create: jest.fn(),
    findOne: jest.fn(),
    findAll: jest.fn(),
    findByPk: jest.fn(),
    count: jest.fn(),
    findAndCountAll: jest.fn(),
    update: jest.fn()
}));

jest.mock('../models/notification_read', () => ({
    findAll: jest.fn(),
    findOrCreate: jest.fn(),
    bulkCreate: jest.fn(),
    destroy: jest.fn()
}));

jest.mock('../modules/infrastructure/EventBus', () => ({
    publish: jest.fn(),
    subscribe: jest.fn()
}));

jest.mock('../game/services/WebSocketNotificationService', () => ({
    sendToPlayer: jest.fn(),
    sendGlobalAnnouncement: jest.fn()
}));

const configLoader = require('../modules/infrastructure/ConfigLoader');
const NotificationService = require('../game/services/NotificationService');
const NotificationSchedulerService = require('../game/services/NotificationSchedulerService');
const SystemNotification = require('../models/system_notification');
const NotificationRead = require('../models/notification_read');
const eventBus = require('../modules/infrastructure/EventBus');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');

const ORIGINAL_POLICY = (() => {
    try {
        return configLoader.getConfig('notification_policy');
    } catch {
        return null;
    }
})();

/** 应用测试策略配置；不传则用一份"全开"的默认 */
function applyPolicy(overrides = {}) {
    configLoader.setMergedConfig('notification_policy', {
        scheduler: { enabled: true, interval_ms: 60000, batch_size: 200, ...(overrides.scheduler || {}) },
        retention: { delete_receipts_on_expire: true, ...(overrides.retention || {}) },
        republish_notice: {
            enabled: true,
            max_recipients: 2,
            title: '公告已更正',
            content: '你读过的公告《{title}》已被更正。',
            priority: 'normal',
            ...(overrides.republish_notice || {})
        }
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    applyPolicy();
    NotificationRead.destroy.mockResolvedValue(0);
});

afterAll(() => {
    NotificationSchedulerService.stop();
    if (ORIGINAL_POLICY) configLoader.setMergedConfig('notification_policy', ORIGINAL_POLICY);
    else configLoader.configCache.delete('notification_policy');
});

/**
 * 取 where 里带 publishAt 的那个条件块
 *
 * 不能靠 JSON.stringify 找：Op.* 是 Symbol 键，字符串化时整块会被丢掉（表现为"永远找不到"）。
 */
function publishClause(where) {
    return (where[Op.and] || []).find(clause =>
        Array.isArray(clause?.[Op.or]) &&
        clause[Op.or].length === 2 &&
        Object.prototype.hasOwnProperty.call(clause[Op.or][0], 'publishAt')
    );
}

describe('预约发布：到点前不可见、不计未读、不广播', () => {
    test('可见范围带上 publishAt 条件（未到点等于不存在）', async () => {
        SystemNotification.count.mockResolvedValue(0);
        await NotificationService.getUnreadCount(42);

        const where = SystemNotification.count.mock.calls[0][0].where;
        const clause = publishClause(where);
        expect(clause).toBeDefined();
        expect(clause[Op.or][0]).toEqual({ publishAt: null });
        // 第二个分支是 "publishAt <= now"：断言操作符存在即可（具体时间不可比）
        expect(clause[Op.or][1].publishAt[Op.lte]).toBeInstanceOf(Date);
    });

    test('未来时间创建公告时不发广播（提前推弹窗会泄露未发布内容）', async () => {
        SystemNotification.create.mockResolvedValue({ id: 1, publishAt: new Date(Date.now() + 3600000) });

        await NotificationService.sendAnnouncement('早间公告', '内容', 'high', {}, {
            publishAt: new Date(Date.now() + 3600000)
        });

        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    test('立即发布（publishAt 为空或已过去）照旧广播', async () => {
        SystemNotification.create.mockResolvedValue({ id: 2, publishAt: null });

        await NotificationService.sendAnnouncement('即时公告', '内容');
        expect(eventBus.publish).toHaveBeenCalledTimes(1);

        eventBus.publish.mockClear();
        SystemNotification.create.mockResolvedValue({ id: 3, publishAt: new Date(Date.now() - 1000) });
        await NotificationService.sendAnnouncement('补发公告', '内容', 'high', {}, { publishAt: new Date(Date.now() - 1000) });
        expect(eventBus.publish).toHaveBeenCalledTimes(1);
    });

    test('到点待推的公告要排除"已推送"的（notice_pushed 在 metadata 里）', async () => {
        SystemNotification.findAll.mockResolvedValue([
            { id: 1, metadata: JSON.stringify({ notice_pushed: true }) },
            { id: 2, metadata: JSON.stringify({}) },
            { id: 3, metadata: 'not-json' }
        ]);

        const due = await NotificationService.getDueScheduledNotifications(10);

        // 坏 JSON 当作未推送：宁可多推一次，也别让公告永远不弹
        expect(due.map(n => n.id)).toEqual([2, 3]);
    });

    test('推送标记写回 metadata，并且不是覆盖整块（保留 imageUrls）', async () => {
        SystemNotification.update.mockResolvedValue([1]);
        const notification = {
            id: 5,
            metadata: JSON.stringify({ imageUrls: ['/api/uploads/announcements/a.png'] })
        };

        await expect(NotificationService.markAsPushed(notification)).resolves.toBe(true);

        const [payload, options] = SystemNotification.update.mock.calls[0];
        const nextMetadata = JSON.parse(payload.metadata);
        expect(nextMetadata.notice_pushed).toBe(true);
        expect(nextMetadata.imageUrls).toEqual(['/api/uploads/announcements/a.png']);
        // 关键：where 里带上"我读到的那份原值"，写不出去就是有人先写过（见下一条）
        expect(options.where).toEqual({ id: 5, metadata: notification.metadata });
    });

    /**
     * 盯的缺陷形状：调度器读行与写标记之间隔着一整段广播，那期间 GM 可能刚编辑过同一条公告。
     * 旧写法是"拿手上那份合并 → update 整块"，会把新配图抹掉；反过来则丢 notice_pushed，
     * 下一轮同一张公告又全服弹一次。现在 where 带原值：撞车就重读、在最新那份上再合一次。
     */
    test('CAS 撞车时重读最新那份再合，绝不拿旧快照盖掉 GM 刚写的配图', async () => {
        const stale = JSON.stringify({});                                     // 调度器手上那份：还没有配图
        const fresh = JSON.stringify({ imageUrls: ['/api/uploads/announcements/b.png'] });
        SystemNotification.findByPk.mockResolvedValue({ id: 7, metadata: fresh });
        SystemNotification.update
            .mockResolvedValueOnce([0])        // 第一枪：原值已经不匹配 → 0 行受影响
            .mockResolvedValueOnce([1]);       // 重读后再合：写成功

        await expect(NotificationService.markAsPushed({ id: 7, metadata: stale })).resolves.toBe(true);

        const calls = SystemNotification.update.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0][1].where.metadata).toBe(stale);
        expect(calls[1][1].where.metadata).toBe(fresh);
        expect(JSON.parse(calls[1][0].metadata)).toEqual({
            imageUrls: ['/api/uploads/announcements/b.png'],
            notice_pushed: true,
            pushed_at: expect.any(String)
        });
    });

    test('已经标过推送的公告不再写第二次', async () => {
        SystemNotification.update.mockResolvedValue([1]);
        const metadata = JSON.stringify({ notice_pushed: true, pushed_at: 'x' });

        await expect(NotificationService.markAsPushed({ id: 8, metadata })).resolves.toBe(false);
        expect(SystemNotification.update).not.toHaveBeenCalled();
    });
});

describe('自动下架：回执随通知一起回收', () => {
    test('下架的每一条都会清掉它的已读回执', async () => {
        SystemNotification.findAll.mockResolvedValue([{ id: 11 }, { id: 12 }]);
        SystemNotification.update.mockResolvedValue([2]);
        NotificationRead.destroy.mockResolvedValue(7);

        const result = await NotificationService.cleanupExpiredNotifications(50);

        expect(result).toEqual({ expired: 2, receiptsRemoved: 7 });
        expect(NotificationRead.destroy.mock.calls[0][0].where.notificationId[Op.in]).toEqual([11, 12]);
    });

    test('没有过期通知时不发 UPDATE、也不删回执', async () => {
        SystemNotification.findAll.mockResolvedValue([]);

        await expect(NotificationService.cleanupExpiredNotifications()).resolves.toEqual({ expired: 0, receiptsRemoved: 0 });
        expect(SystemNotification.update).not.toHaveBeenCalled();
        expect(NotificationRead.destroy).not.toHaveBeenCalled();
    });

    test('配置关掉回收时只下架、不回执（留给运维自己决定）', async () => {
        applyPolicy({ retention: { delete_receipts_on_expire: false } });
        SystemNotification.findAll.mockResolvedValue([{ id: 11 }]);
        SystemNotification.update.mockResolvedValue([1]);

        const result = await NotificationService.cleanupExpiredNotifications();

        expect(result.expired).toBe(1);
        expect(result.receiptsRemoved).toBe(0);
        expect(NotificationRead.destroy).not.toHaveBeenCalled();
    });
});

describe('公告更正后的重提示', () => {
    test('重置已读回执并给读者定向推送，推送量受 max_recipients 限制', async () => {
        NotificationRead.findAll.mockResolvedValue([{ playerId: 1 }, { playerId: 2 }, { playerId: 3 }]);

        const result = await NotificationService.notifyReadersOfUpdate({ id: 9, title: '维护公告' });

        expect(result).toMatchObject({ readers: 3, pushed: 2, reset: true });
        expect(NotificationRead.destroy.mock.calls[0][0].where.notificationId[Op.in]).toEqual([9]);
        expect(WebSocketNotificationService.sendToPlayer).toHaveBeenCalledTimes(2);
        expect(WebSocketNotificationService.sendToPlayer.mock.calls[0][1].content).toContain('维护公告');
    });

    test('没人读过时不写不推（避免无意义的重置）', async () => {
        NotificationRead.findAll.mockResolvedValue([]);

        await expect(NotificationService.notifyReadersOfUpdate({ id: 9, title: 'x' }))
            .resolves.toEqual({ readers: 0, pushed: 0, reset: false });
        expect(NotificationRead.destroy).not.toHaveBeenCalled();
    });

    test('配置关闭后整块跳过', async () => {
        applyPolicy({ republish_notice: { enabled: false } });
        NotificationRead.findAll.mockResolvedValue([{ playerId: 1 }]);

        await expect(NotificationService.notifyReadersOfUpdate({ id: 9, title: 'x' }))
            .resolves.toEqual({ readers: 0, pushed: 0, reset: false });
        expect(NotificationRead.findAll).not.toHaveBeenCalled();
    });
});

describe('调度器', () => {
    test('一轮里先推预约公告、再下架过期公告', async () => {
        const notification = {
            id: 21,
            toJSON: () => ({
                id: 21, type: 'announcement', title: '早间公告', content: '内容', priority: 'high',
                metadata: JSON.stringify({ imageUrls: ['/api/uploads/announcements/a.png'] })
            }),
            update: jest.fn().mockResolvedValue(true)
        };
        SystemNotification.findAll
            .mockResolvedValueOnce([notification])   // getDueScheduledNotifications
            .mockResolvedValueOnce([{ id: 22 }]);    // cleanupExpiredNotifications
        SystemNotification.update.mockResolvedValue([1]);

        const result = await NotificationSchedulerService.runOnce();

        expect(result).toMatchObject({ pushed: 1, expired: 1, skipped: false });
        expect(WebSocketNotificationService.sendGlobalAnnouncement).toHaveBeenCalledTimes(1);
        // 配图必须跟着走，否则预约到点的公告弹窗里没有图
        expect(WebSocketNotificationService.sendGlobalAnnouncement.mock.calls[0][0].imageUrls)
            .toEqual(['/api/uploads/announcements/a.png']);
    });

    test('配置关闭时整轮跳过', async () => {
        applyPolicy({ scheduler: { enabled: false } });

        await expect(NotificationSchedulerService.runOnce()).resolves.toMatchObject({ skipped: true });
        expect(SystemNotification.findAll).not.toHaveBeenCalled();
    });

    test('start / stop 幂等：不会攒出重复定时器', async () => {
        // 让 start() 内部的首轮 setImmediate 有数据可读，否则它会在用例结束后抛错刷屏
        SystemNotification.findAll.mockResolvedValue([]);

        expect(NotificationSchedulerService.start()).toBe(true);
        expect(NotificationSchedulerService.start()).toBe(false);

        await new Promise(resolve => setImmediate(resolve));

        NotificationSchedulerService.stop();
        NotificationSchedulerService.stop();
        expect(NotificationSchedulerService.timer).toBe(null);
    });
});
