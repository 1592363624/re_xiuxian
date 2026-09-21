/**
 * 公告配图工具的不变量（不连库、不起服务）
 *
 * 钉的是三件事：
 *   1. 只认文件头魔数 —— Content-Type 与文件名都由客户端提供，可伪造；
 *      若退化成"看后缀/看 MIME"，公告就变成了一个可上传任意文件（含 HTML/SVG 脚本）的入口。
 *   2. 图片 URL 白名单 —— 公告只允许引用本服务托管地址，挡住"外部图片泄露玩家 IP"与路径穿越。
 *   3. 删除通知时按 URL 反查磁盘文件，且反查结果必须落在托管目录内。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const configLoader = require('../modules/infrastructure/ConfigLoader');
const announcementImage = require('../utils/announcementImage');

/** 测试用的托管目录（相对 server/ 根目录，与生产配置同形状） */
const TEST_STORAGE_DIR = path.join('uploads', '__tests__', 'announcements');
const TEST_URL_PREFIX = '/api/uploads/__tests__/announcements';
const TEST_STORAGE_ABS = path.join(__dirname, '..', TEST_STORAGE_DIR);

/** 覆盖前的原始配置，用于测试结束后还原（避免污染其它用例读到临时目录） */
const ORIGINAL_CONFIG = (() => {
    try {
        return configLoader.getConfig('announcement_upload');
    } catch {
        return null;
    }
})();

/** 造一个最小 PNG：仅文件头正确即可被识别（不校验图片内容完整性） */
function fakePng(bytes = 32) {
    const header = Buffer.from('89504e470d0a1a0a', 'hex');
    return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - header.length))]);
}

describe('公告配图工具', () => {
    beforeAll(() => {
        configLoader.setMergedConfig('announcement_upload', {
            upload: {
                storage_dir: TEST_STORAGE_DIR.split(path.sep).join('/'),
                url_prefix: TEST_URL_PREFIX,
                max_file_size_bytes: 5 * 1024 * 1024,
                max_images_per_announcement: 2,
                file_name_prefix: 'test',
                delete_file_when_notification_removed: true,
                allowed_types: [
                    { mime: 'image/png', ext: 'png', magic: [{ offset: 0, hex: '89504e470d0a1a0a' }] },
                    { mime: 'image/jpeg', ext: 'jpg', magic: [{ offset: 0, hex: 'ffd8ff' }] },
                    { mime: 'image/gif', ext: 'gif', magic: [{ offset: 0, hex: '47494638' }] },
                    {
                        mime: 'image/webp', ext: 'webp',
                        magic: [{ offset: 0, hex: '52494646' }, { offset: 8, hex: '57454250' }]
                    }
                ]
            },
            batch_delete: { max_ids_per_request: 3 }
        });
    });

    afterAll(() => {
        if (ORIGINAL_CONFIG) configLoader.setMergedConfig('announcement_upload', ORIGINAL_CONFIG);
        else configLoader.configCache.delete('announcement_upload');

        fs.rmSync(path.join(__dirname, '..', 'uploads', '__tests__'), { recursive: true, force: true });
    });

    test('按文件头识别真实格式，伪造后缀/MIME 一律拒绝', () => {
        expect(announcementImage.detectImageType(fakePng())).toEqual({ mime: 'image/png', ext: 'png' });
        expect(announcementImage.detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
        expect(announcementImage.detectImageType(Buffer.from('GIF89a...'))).toEqual({ mime: 'image/gif', ext: 'gif' });

        // WEBP 需要 RIFF + 偏移 8 处的 WEBP 两段同时命中，只写 RIFF 的容器不算
        const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
        expect(announcementImage.detectImageType(webp)).toEqual({ mime: 'image/webp', ext: 'webp' });
        expect(announcementImage.detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBe(null);

        // 伪装成图片的脚本 / SVG / 空数据
        expect(announcementImage.detectImageType(Buffer.from('<script>alert(1)</script>'))).toBe(null);
        expect(announcementImage.detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(null);
        expect(announcementImage.detectImageType(Buffer.alloc(0))).toBe(null);
        expect(announcementImage.detectImageType('not a buffer')).toBe(null);
    });

    test('图片 URL 白名单挡得住外部地址与路径穿越', () => {
        expect(announcementImage.isManagedImageUrl(`${TEST_URL_PREFIX}/test_1_ab.png`)).toBe(true);

        // 外部地址：会把玩家 IP 泄露给第三方，也可能成为钓鱼图的展示位
        expect(announcementImage.isManagedImageUrl('https://evil.example.com/x.png')).toBe(false);
        // 前缀不同（例如别人的目录）
        expect(announcementImage.isManagedImageUrl('/api/uploads/announcements/x.png')).toBe(false);
        // 路径穿越与子目录
        expect(announcementImage.isManagedImageUrl(`${TEST_URL_PREFIX}/../../config/game_balance.json`)).toBe(false);
        expect(announcementImage.isManagedImageUrl(`${TEST_URL_PREFIX}/../secret.png`)).toBe(false);
        // 非图片后缀 / 缺文件名
        expect(announcementImage.isManagedImageUrl(`${TEST_URL_PREFIX}/payload.html`)).toBe(false);
        expect(announcementImage.isManagedImageUrl(`${TEST_URL_PREFIX}/`)).toBe(false);

        // 反查磁盘路径同样只接受托管目录内的文件
        expect(announcementImage.resolveImageFile(`${TEST_URL_PREFIX}/test_1_ab.png`))
            .toBe(path.join(TEST_STORAGE_ABS, 'test_1_ab.png'));
        expect(announcementImage.resolveImageFile(`${TEST_URL_PREFIX}/../../index.js`)).toBe(null);
    });

    test('落盘取随机名并可被删除；非法地址不产生文件操作', () => {
        const saved = announcementImage.saveAnnouncementImage(fakePng());
        expect(saved.url.startsWith(`${TEST_URL_PREFIX}/`)).toBe(true);
        expect(saved.mimeType).toBe('image/png');
        expect(fs.existsSync(path.join(TEST_STORAGE_ABS, saved.fileName))).toBe(true);

        expect(announcementImage.deleteAnnouncementImage(saved.url)).toBe(true);
        expect(fs.existsSync(path.join(TEST_STORAGE_ABS, saved.fileName))).toBe(false);
        // 幂等：重复删除不该抛错，也不该误伤其它文件
        expect(announcementImage.deleteAnnouncementImage(saved.url)).toBe(false);
        expect(announcementImage.deleteAnnouncementImage('https://evil.example.com/x.png')).toBe(false);

        // 非图片数据必须直接拒绝，且不落盘
        expect(() => announcementImage.saveAnnouncementImage(Buffer.from('nope'))).toThrow('UNSUPPORTED_IMAGE_TYPE');
    });

    test('入库地址做去重与数量截断，非法地址单独回报', () => {
        const valid = `${TEST_URL_PREFIX}/test_1_ab.png`;
        const other = `${TEST_URL_PREFIX}/test_2_cd.jpg`;

        const result = announcementImage.sanitizeImageUrls([valid, valid, other, other, other]);
        expect(result.rejected).toEqual([]);
        // 上限 2 张（来自测试配置 max_images_per_announcement），且去重
        expect(result.urls).toEqual([valid, other]);

        const mixed = announcementImage.sanitizeImageUrls([valid, 'https://evil.example.com/x.png']);
        expect(mixed.urls).toEqual([valid]);
        expect(mixed.rejected).toEqual(['https://evil.example.com/x.png']);

        // 非数组入参（例如前端漏传）不该抛错，按"没有配图"处理
        expect(announcementImage.sanitizeImageUrls(undefined)).toEqual({ urls: [], rejected: [] });
    });

    test('从通知记录里取配图：兼容 JSON 字符串与对象两种 metadata', () => {
        const url = `${TEST_URL_PREFIX}/test_1_ab.png`;
        expect(announcementImage.extractImageUrls({ metadata: JSON.stringify({ imageUrls: [url] }) })).toEqual([url]);
        expect(announcementImage.extractImageUrls({ metadata: { imageUrls: [url] } })).toEqual([url]);
        // 坏 JSON / 缺字段 / 外链一律丢弃，不让脏数据流到前端渲染
        expect(announcementImage.extractImageUrls({ metadata: '{oops' })).toEqual([]);
        expect(announcementImage.extractImageUrls({ metadata: '{}' })).toEqual([]);
        expect(announcementImage.extractImageUrls({ metadata: { imageUrls: ['https://evil.example.com/x.png'] } })).toEqual([]);
        expect(announcementImage.extractImageUrls(null)).toEqual([]);

        // 批量清理接口按记录列表删文件
        const saved = announcementImage.saveAnnouncementImage(fakePng());
        const removed = announcementImage.deleteImagesOfNotifications([
            { metadata: JSON.stringify({ imageUrls: [saved.url] }) }
        ]);
        expect(removed).toBe(1);
    });
});
