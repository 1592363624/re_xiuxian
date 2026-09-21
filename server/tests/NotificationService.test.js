/**
 * 通知服务单元测试
 *
 * 覆盖范围（玩家侧消息面板上线前的必要修复）：
 *   - getPlayerNotifications 的可见范围：只能看到"发给自己的"和"全服的"
 *   - 过期条件必须与目标范围 AND —— 以前被并进同一个 Op.or，
 *     而绝大多数通知 expiresAt 为 NULL，那个恒真分支会让 targetPlayerId 形同虚设，
 *     玩家能从列表接口拉到别人的死亡/突破通知。这次是是两头都对上的回归点：
 *     接口侧不出 commit 就没人知道漏了，UI 侧没列表就没人看见泄漏。
 *   - sendAnnouncement 的配图地址要落进 metadata.imageUrls（Socket 推送靠它取图）
 *
 * 测试策略：mock SystemNotification，不连 MySQL。
 */
'use strict';

const { Op } = require('sequelize');

jest.mock('../models/system_notification', () => ({
    create: jest.fn(),
    findAndCountAll: jest.fn()
}));

const NotificationService = require('../game/services/NotificationService');
const SystemNotification = require('../models/system_notification');

/** 取最近一次查询的 where 条件 */
async function captureWhere(options = {}) {
    await NotificationService.getPlayerNotifications(42, options);
    return SystemNotification.findAndCountAll.mock.calls[0][0].where;
}

beforeEach(() => {
    jest.clearAllMocks();
    SystemNotification.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
    SystemNotification.create.mockResolvedValue({ id: 1 });
});

describe('getPlayerNotifications 的可见范围', () => {
    test('默认同时包含"发给本人"与"全服"通知', async () => {
        const where = await captureWhere();
        expect(where[Op.or]).toEqual([{ targetPlayerId: 42 }, { targetPlayerId: null }]);
        expect(where.isActive).toBe(true);
    });

    test('includeGlobal=false 时只锁本人，不再产生 Op.or', async () => {
        const where = await captureWhere({ includeGlobal: false });
        expect(where.targetPlayerId).toBe(42);
        expect(where[Op.or]).toBeUndefined();
    });

    test('过期条件走 Op.and，绝不混进目标范围的 Op.or', async () => {
        const where = await captureWhere();
        expect(where[Op.and]).toHaveLength(1);

        const clause = where[Op.and][0];
        expect(clause[Op.or]).toHaveLength(2);
        expect(clause[Op.or][0]).toEqual({ expiresAt: null });
        expect(Object.keys(clause[Op.or][1])).toEqual(['expiresAt']);
        expect(clause[Op.or][1].expiresAt[Op.gt]).toBeInstanceOf(Date);

        // 这条是整个用例的关键：一旦 Op.or 里出现 expiresAt，targetPlayerId 就失效了
        const targetKeys = where[Op.or].flatMap(cond => Object.keys(cond));
        expect(targetKeys).toEqual(['targetPlayerId', 'targetPlayerId']);
    });

    test('includeInactive 只给 GM 视角开：默认仍然只返回激活的通知', async () => {
        const activeOnly = await captureWhere();
        expect(activeOnly.isActive).toBe(true);

        // 撤回（isActive=false）后记录必须还能被 GM 列出来，否则"恢复"没有入口
        SystemNotification.findAndCountAll.mockClear();
        const withInactive = await captureWhere({ includeInactive: true });
        expect(withInactive.isActive).toBeUndefined();
        // 放开激活状态不该顺带放开目标范围过滤
        expect(withInactive[Op.or]).toEqual([{ targetPlayerId: 42 }, { targetPlayerId: null }]);
    });

    test('type 作为附加过滤条件生效；unreadOnly 改走已读回执表', async () => {
        const where = await captureWhere({ type: 'announcement', unreadOnly: true });
        expect(where.type).toBe('announcement');
        // 未读不再是 isRead 列：那是行级共享状态，已读语义见 tests/NotificationReadReceipt.test.js
        expect(where.isRead).toBeUndefined();
        expect(where[Op.and].some(clause => typeof clause?.val === 'string' && clause.val.includes('NOT EXISTS'))).toBe(true);
    });
});

describe('sendAnnouncement 的配图', () => {
    test('imageUrls 写进 metadata，供 Socket 推送与列表渲染取用', async () => {
        const imageUrls = ['/api/uploads/announcements/ann_1_ab.png'];
        await NotificationService.sendAnnouncement('维护公告', '今晚停机', 'high', { imageUrls });

        const payload = SystemNotification.create.mock.calls[0][0];
        expect(payload.type).toBe('announcement');
        expect(payload.targetPlayerId).toBe(null);
        // metadata 列是 TEXT，服务层写入前会 JSON.stringify（前端解析时要反解）
        expect(JSON.parse(payload.metadata)).toEqual({ imageUrls });
    });

    test('不带配图时 metadata 为空对象，不产出 undefined', async () => {
        await NotificationService.sendAnnouncement('维护公告', '今晚停机');
        expect(JSON.parse(SystemNotification.create.mock.calls[0][0].metadata)).toEqual({});
    });
});
