/**
 * 通知已读回执的不变量（不连库）
 *
 * 钉的是这次换掉的语义：
 *   1. 已读是 (玩家, 通知) 的二元关系 —— 全服公告只有一行，改行级 isRead 等于
 *      "一个人读过 → 全服都不再提示未读"，所以 markAsRead 必须写回执、绝不再改那一行；
 *   2. 未读判定（列表过滤与计数）走回执表，不再看 isRead 列；
 *   3. 列表返回给前端的 isRead 必须是"这个玩家读过没"，不是数据库里那一行共享的 isRead。
 *
 * 测试策略：mock 两张表，只验证 Sequelize 调用形状与返回值。
 */
'use strict';

const { Op } = require('sequelize');

jest.mock('../models/system_notification', () => ({
    findOne: jest.fn(),
    findAll: jest.fn(),
    count: jest.fn(),
    findAndCountAll: jest.fn()
}));

jest.mock('../models/notification_read', () => ({
    findAll: jest.fn(),
    findOrCreate: jest.fn(),
    bulkCreate: jest.fn(),
    destroy: jest.fn()
}));

const NotificationService = require('../game/services/NotificationService');
const SystemNotification = require('../models/system_notification');
const NotificationRead = require('../models/notification_read');

/** 取 where 里的 NOT EXISTS 片段（literal 对象带 val 字符串） */
function notExistsClause(where) {
    return (where[Op.and] || []).find(clause => typeof clause?.val === 'string' && clause.val.includes('NOT EXISTS'));
}

beforeEach(() => {
    jest.clearAllMocks();
    // findOrCreate 默认返回 [实例, created]：不设这个默认值，解构 undefined 会直接抛错
    NotificationRead.findOrCreate.mockResolvedValue([{ id: 1, readAt: new Date() }, true]);
    NotificationRead.bulkCreate.mockResolvedValue([]);
    NotificationRead.findAll.mockResolvedValue([]);
    NotificationRead.destroy.mockResolvedValue(0);
});

describe('markAsRead 写回执，不改共享行', () => {
    test('通知可见时写一条回执，且不调用 notification.save()', async () => {
        const save = jest.fn();
        SystemNotification.findOne.mockResolvedValue({ id: 7, save });

        const result = await NotificationService.markAsRead(7, 42);

        expect(result).toMatchObject({ created: true, exists: true });
        expect(NotificationRead.findOrCreate).toHaveBeenCalledTimes(1);
        expect(NotificationRead.findOrCreate.mock.calls[0][0].where).toEqual({ playerId: 42, notificationId: 7 });
        // 这一条是整个改动的核心：改行级 isRead 会让全服共享状态
        expect(save).not.toHaveBeenCalled();
    });

    test('通知不存在时不写回执（否则可用任意 id 往回执表灌数据）', async () => {
        SystemNotification.findOne.mockResolvedValue(null);

        const result = await NotificationService.markAsRead(9999, 42);

        expect(result).toMatchObject({ created: false, exists: false });
        expect(NotificationRead.findOrCreate).not.toHaveBeenCalled();
    });

    test('重复点已读是幂等的：走 findOrCreate 的唯一键，不产生第二条', async () => {
        SystemNotification.findOne.mockResolvedValue({ id: 7, save: jest.fn() });
        NotificationRead.findOrCreate.mockResolvedValue([{ id: 1, readAt: new Date() }, false]);

        const result = await NotificationService.markAsRead(7, 42);
        expect(result.created).toBe(false);
    });
});

describe('markAllAsRead 只补缺失的回执', () => {
    test('已读过的跳过，只为剩下的写回执', async () => {
        SystemNotification.findAll.mockResolvedValue([
            { id: 1 }, { id: 2 }, { id: 3 }
        ]);
        NotificationRead.findAll.mockResolvedValue([{ notificationId: 2 }]);

        const added = await NotificationService.markAllAsRead(42);

        expect(added).toBe(2);
        const rows = NotificationRead.bulkCreate.mock.calls[0][0];
        expect(rows.map(r => r.notificationId).sort()).toEqual([1, 3]);
        expect(rows.every(r => r.playerId === 42 && r.readAt instanceof Date)).toBe(true);
    });

    test('全部已读时一条都不写', async () => {
        SystemNotification.findAll.mockResolvedValue([{ id: 1 }]);
        NotificationRead.findAll.mockResolvedValue([{ notificationId: 1 }]);

        await expect(NotificationService.markAllAsRead(42)).resolves.toBe(0);
        expect(NotificationRead.bulkCreate).not.toHaveBeenCalled();
    });
});

describe('未读判定改走回执表', () => {
    test('getUnreadCount 用 NOT EXISTS 排除回执，不再看 isRead 列', async () => {
        SystemNotification.count.mockResolvedValue(3);
        await NotificationService.getUnreadCount(42);

        const where = SystemNotification.count.mock.calls[0][0].where;
        expect(notExistsClause(where)).toBeDefined();
        expect(notExistsClause(where).val).toContain('r.playerId = 42');
        // 旧实现靠 isRead:false，那会把别人的已读当成自己的已读
        expect(where.isRead).toBeUndefined();
    });

    test('unreadOnly 过滤同样是 NOT EXISTS，并且仍保留目标范围过滤', async () => {
        SystemNotification.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
        await NotificationService.getPlayerNotifications(42, { unreadOnly: true });

        const where = SystemNotification.findAndCountAll.mock.calls[0][0].where;
        expect(notExistsClause(where)).toBeDefined();
        expect(where[Op.or]).toEqual([{ targetPlayerId: 42 }, { targetPlayerId: null }]);
        expect(where.isRead).toBeUndefined();
    });

    test('列表回传的 isRead 取自该玩家的回执，覆盖共享行上的 isRead', async () => {
        SystemNotification.findAndCountAll.mockResolvedValue({
            count: 2,
            rows: [
                // 共享行上是未读，但 42 号玩家读过 → 前端应看到已读
                { id: 1, title: 'A', isRead: false, toJSON: () => ({ id: 1, title: 'A', isRead: false }) },
                // 反过来：共享行已读，但这位玩家没读过 → 前端应看到未读
                { id: 2, title: 'B', isRead: true, toJSON: () => ({ id: 2, title: 'B', isRead: true }) }
            ]
        });
        NotificationRead.findAll.mockResolvedValue([{ notificationId: 1 }]);

        const result = await NotificationService.getPlayerNotifications(42, {});
        const byId = Object.fromEntries(result.notifications.map(n => [n.id, n]));

        expect(byId[1].isRead).toBe(true);
        expect(byId[2].isRead).toBe(false);
    });

    test('空列表不查回执表，避免 IN () 的空查询', async () => {
        SystemNotification.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
        await NotificationService.getPlayerNotifications(42, {});
        expect(NotificationRead.findAll).not.toHaveBeenCalled();
    });
});

describe('通知删除后清理回执', () => {
    test('deleteReadReceipts 按 notificationId 批量删', async () => {
        NotificationRead.destroy.mockResolvedValue(3);
        await NotificationService.deleteReadReceipts([1, 2, 3]);

        const where = NotificationRead.destroy.mock.calls[0][0].where;
        expect(where.notificationId[Op.in]).toEqual([1, 2, 3]);
    });

    test('空数组直接跳过', async () => {
        await expect(NotificationService.deleteReadReceipts([])).resolves.toBe(0);
        await expect(NotificationService.deleteReadReceipts(undefined)).resolves.toBe(0);
        expect(NotificationRead.destroy).not.toHaveBeenCalled();
    });
});
