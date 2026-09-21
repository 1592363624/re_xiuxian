/**
 * 公告配图孤儿清理的判定规则（不连库、不碰磁盘）
 *
 * 钉的是两件事：
 *   1. 被引用的文件永远不删 —— 删错的代价是"历史公告的图片全部 404"，且不可回滚；
 *   2. 保留窗口内的文件不删 —— GM 刚上传、还没点发送的那张图必须活够窗口时间。
 *
 * 这两条都是"写的时候觉得不会错、写错之后只能等玩家来报"的类型，所以用纯函数锁住。
 */
'use strict';

const path = require('path');
const fs = require('fs');

jest.mock('../models/system_notification', () => ({
    findAll: jest.fn()
}));

const configLoader = require('../modules/infrastructure/ConfigLoader');
const announcementImage = require('../utils/announcementImage');
const cleanupService = require('../game/services/AnnouncementImageCleanupService');
const SystemNotification = require('../models/system_notification');

/** 测试用托管目录（相对 server/ 根目录，与生产配置同形状） */
const TEST_STORAGE_DIR = 'uploads/__tests__/cleanup';
const TEST_URL_PREFIX = '/api/uploads/__tests__/cleanup';
const TEST_STORAGE_ABS = path.join(__dirname, '..', TEST_STORAGE_DIR);

const ORIGINAL_CONFIG = (() => {
    try {
        return configLoader.getConfig('announcement_upload');
    } catch {
        return null;
    }
})();

const HOUR = 3600 * 1000;

/**
 * 应用测试配置
 * @param {Object} cleanupOverrides - 覆盖 cleanup 段（用来模拟"后台把开关关掉"）
 */
function applyConfig(cleanupOverrides = {}) {
    configLoader.setMergedConfig('announcement_upload', {
        upload: {
            storage_dir: TEST_STORAGE_DIR,
            url_prefix: TEST_URL_PREFIX,
            max_file_size_bytes: 5 * 1024 * 1024,
            max_images_per_announcement: 3,
            file_name_prefix: 'test',
            delete_file_when_notification_removed: true,
            allowed_types: [
                { mime: 'image/png', ext: 'png', magic: [{ offset: 0, hex: '89504e470d0a1a0a' }] }
            ]
        },
        cleanup: {
            enabled: true,
            interval_ms: 3600000,
            retention_hours: 24,
            log_each: false,
            ...cleanupOverrides
        }
    });
}

// 每个用例都重置一次：开关类配置会被某个用例改掉，漏重置就会污染后面所有断言
beforeEach(() => applyConfig());

afterAll(() => {
    if (ORIGINAL_CONFIG) configLoader.setMergedConfig('announcement_upload', ORIGINAL_CONFIG);
    else configLoader.configCache.delete('announcement_upload');

    fs.rmSync(path.join(__dirname, '..', 'uploads', '__tests__'), { recursive: true, force: true });
});

/** 造文件时间戳：把列表写清楚比用真实 Date 更好读失败原因 */
const file = (name, ageMs) => ({ name, mtimeMs: NOW - ageMs });
const NOW = 1700000000000;

describe('孤儿文件判定', () => {
    test('未被引用的过期文件才删；被引用的一律留下，哪怕更老', () => {
        const files = [
            file('ann_referenced_old.png', 48 * HOUR),
            file('ann_orphan_old.png', 48 * HOUR),
            file('ann_orphan_fresh.png', 2 * HOUR),
            file('ann_referenced_fresh.png', 2 * HOUR)
        ];
        const referenced = new Set(['ann_referenced_old.png', 'ann_referenced_fresh.png']);

        const orphans = cleanupService.selectOrphanFiles({
            files,
            referencedFileNames: referenced,
            nowMs: NOW,
            retentionMs: 24 * HOUR
        });

        // 只有一张"又老又没人要"的会被删：老引用留着、新孤儿还在窗口内
        expect(orphans).toEqual(['ann_orphan_old.png']);
    });

    test('保留窗口边界：刚超过窗口就删，差 1 毫秒不删', () => {
        const files = [
            file('ann_over.png', 24 * HOUR + 1),
            file('ann_under.png', 24 * HOUR - 1)
        ];
        const orphans = cleanupService.selectOrphanFiles({
            files,
            referencedFileNames: new Set(),
            nowMs: NOW,
            retentionMs: 24 * HOUR
        });
        expect(orphans).toEqual(['ann_over.png']);
    });

    test('空目录与非数组入参都不抛错', () => {
        expect(cleanupService.selectOrphanFiles({
            files: [],
            referencedFileNames: new Set(),
            nowMs: NOW,
            retentionMs: 24 * HOUR
        })).toEqual([]);

        expect(cleanupService.selectOrphanFiles({
            files: undefined,
            referencedFileNames: new Set(),
            nowMs: NOW,
            retentionMs: 24 * HOUR
        })).toEqual([]);
    });

    test('配置关闭时 run() 直接跳过，不碰文件系统', async () => {
        applyConfig({ enabled: false });

        await expect(cleanupService.run()).resolves.toMatchObject({ skipped: true, removed: 0 });
        // 关掉也没创建目录 —— 说明没有发生任何读盘动作
        expect(fs.existsSync(TEST_STORAGE_ABS)).toBe(false);
    });

    test('start / stop 幂等：不会攒出一串重复定时器', () => {
        expect(cleanupService.start()).toBe(true);
        expect(cleanupService.start()).toBe(false);
        cleanupService.stop();
        cleanupService.stop();
        expect(cleanupService.timer).toBe(null);
    });
});

describe('引用清单的口径', () => {
    test('汇总引用时不筛 isActive：撤回的公告一旦恢复，图片还得在', async () => {
        SystemNotification.findAll.mockResolvedValue([]);
        await cleanupService.collectReferencedFileNames();

        const where = SystemNotification.findAll.mock.calls[0][0].where;
        // 撤回只是暂时隐藏，若这里按"激活中"过滤，撤回满一个保留窗口图片就被回收，
        // 恢复后公告里全是 404 —— 只有记录被真正删除时才允许回收它的图
        expect(where.isActive).toBeUndefined();
        expect(where.metadata).toBeDefined();
    });
});

describe('磁盘清单只认配置允许的图片', () => {
    test('目录里的非图片文件（如 .gitignore / 文本）不参与清理', () => {
        fs.mkdirSync(TEST_STORAGE_ABS, { recursive: true });
        fs.writeFileSync(path.join(TEST_STORAGE_ABS, 'test_1_ab.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
        fs.writeFileSync(path.join(TEST_STORAGE_ABS, 'readme.txt'), 'not an image');
        fs.writeFileSync(path.join(TEST_STORAGE_ABS, '.gitkeep'), '');

        const names = cleanupService.listUploadedFiles().map(f => f.name);
        expect(names).toContain('test_1_ab.png');
        expect(names).not.toContain('readme.txt');
        expect(names).not.toContain('.gitkeep');
    });

    test('url → 文件名 的反查与 isManagedImageUrl 同一套口径', () => {
        const url = `${TEST_URL_PREFIX}/test_1_ab.png`;
        expect(announcementImage.extractImageUrls({ metadata: JSON.stringify({ imageUrls: [url] }) }))
            .toEqual([url]);
        expect(path.basename(url)).toBe('test_1_ab.png');
    });
});
