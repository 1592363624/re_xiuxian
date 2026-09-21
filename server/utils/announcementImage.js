/**
 * 公告配图工具
 *
 * 职责：把"GM 在后台粘贴/选择的图片"落盘成可被全服玩家加载的静态资源，并负责
 *       图片来源校验、URL 白名单、以及通知删除后的孤儿文件清理。
 *
 * 为什么不用 base64 直接存进 system_notifications.content / metadata：
 *   1. metadata 是 TEXT（约 64KB），一张截图就会超限；
 *   2. 通知会经 Socket.IO 广播给全体在线玩家，base64 会让每条广播体积翻 4/3 且无法缓存；
 *   3. 落盘 + 静态托管才能让浏览器按 URL 缓存，第二次打开公告不再走网络。
 *
 * 所有阈值/白名单/目录/URL 前缀都读 config/announcement_upload.json，代码里只保留
 * "配置没加载完"时的兜底值（与 rateLimit.js 的 DEFAULT_LIMITS 同一套思路）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const configLoader = require('../modules/infrastructure/ConfigLoader');

/** server/ 根目录（本文件位于 server/utils/） */
const SERVER_ROOT = path.join(__dirname, '..');

/** 配置未就绪时的兜底值，保证上传能力不会因配置缺失而整体不可用 */
const FALLBACK_CONFIG = {
    upload: {
        storage_dir: 'uploads/announcements',
        url_prefix: '/api/uploads/announcements',
        max_file_size_bytes: 5 * 1024 * 1024,
        max_images_per_announcement: 3,
        file_name_prefix: 'ann',
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
    static: { max_age_ms: 604800000, fallthrough: false },
    batch_delete: { max_ids_per_request: 200 }
};

/**
 * 读取配图配置（每次现读，保证后台热更新后立刻生效，不缓存到模块变量里）
 * @returns {{upload: Object, static: Object, batch_delete: Object}}
 */
function getImageConfig() {
    const raw = configLoader.peekConfig('announcement_upload') || {};
    const upload = { ...FALLBACK_CONFIG.upload, ...(raw.upload || {}) };
    // 数组字段不能靠展开覆盖：配置里写成空数组时会被当成"没配"，这里显式回退
    if (!Array.isArray(upload.allowed_types) || upload.allowed_types.length === 0) {
        upload.allowed_types = FALLBACK_CONFIG.upload.allowed_types;
    }
    return {
        upload,
        static: { ...FALLBACK_CONFIG.static, ...(raw.static || {}) },
        batch_delete: { ...FALLBACK_CONFIG.batch_delete, ...(raw.batch_delete || {}) }
    };
}

/** 图片落盘的绝对目录 */
function getStorageDir() {
    return path.join(SERVER_ROOT, getImageConfig().upload.storage_dir);
}

/** 对外 URL 前缀（形如 /api/uploads/announcements） */
function getUrlPrefix() {
    return String(getImageConfig().upload.url_prefix).replace(/\/+$/, '');
}

/**
 * 通过文件头魔数识别真实图片类型
 *
 * 为什么不信任客户端的 Content-Type / 文件名后缀：两者都由客户端提供，可以随便伪造
 * （例如把 <script> 内容标成 image/png）。只认文件头，才能保证落盘的东西真的是图片。
 * @param {Buffer} buffer - 文件二进制
 * @returns {{mime: string, ext: string}|null} 命中白名单时返回类型信息，否则 null
 */
function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

    for (const type of getImageConfig().upload.allowed_types) {
        const magics = Array.isArray(type.magic) ? type.magic : [];
        if (magics.length === 0) continue;

        const matched = magics.every(({ offset = 0, hex }) => {
            const expected = Buffer.from(String(hex), 'hex');
            // 文件比签名还短 → 不可能命中，避免 Buffer.slice 越界比较
            if (buffer.length < offset + expected.length) return false;
            return buffer.slice(offset, offset + expected.length).equals(expected);
        });

        if (matched) return { mime: type.mime, ext: type.ext };
    }

    return null;
}

/**
 * 保存一张公告配图
 * @param {Buffer} buffer - 原始文件二进制
 * @param {Object} [imageType] - detectImageType 的结果（避免重复识别）
 * @returns {{url: string, fileName: string, size: number, mimeType: string}}
 */
function saveAnnouncementImage(buffer, imageType = null) {
    const type = imageType || detectImageType(buffer);
    if (!type) {
        // 交给调用方翻译成 400，工具层只给出信号
        const err = new Error('UNSUPPORTED_IMAGE_TYPE');
        err.code = 'UNSUPPORTED_IMAGE_TYPE';
        throw err;
    }

    const { upload } = getImageConfig();
    const storageDir = getStorageDir();
    fs.mkdirSync(storageDir, { recursive: true });

    // 文件名完全由服务端生成：时间戳便于排查顺序，随机串避免被猜出其他玩家公告的图片地址
    const fileName = `${upload.file_name_prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${type.ext}`;
    fs.writeFileSync(path.join(storageDir, fileName), buffer);

    return {
        url: `${getUrlPrefix()}/${fileName}`,
        fileName,
        size: buffer.length,
        mimeType: type.mime
    };
}

/**
 * 判断 URL 是否属于本服务托管的公告配图
 * @param {string} url
 * @returns {boolean}
 */
function isManagedImageUrl(url) {
    if (typeof url !== 'string' || url.length === 0) return false;

    const prefix = getUrlPrefix();
    if (!url.startsWith(`${prefix}/`)) return false;

    const fileName = url.slice(prefix.length + 1);
    // 只允许"纯文件名"：不含任何路径分隔符，天然把 ..%2F、子目录穿越挡在外面
    if (!/^[A-Za-z0-9_.-]+$/.test(fileName)) return false;

    const exts = getImageConfig().upload.allowed_types.map(t => t.ext);
    return exts.some(ext => fileName.toLowerCase().endsWith(`.${ext}`));
}

/**
 * 把托管 URL 还原成磁盘路径
 * @param {string} url
 * @returns {string|null} 非托管/文件名非法时返回 null
 */
function resolveImageFile(url) {
    if (!isManagedImageUrl(url)) return null;

    const prefix = getUrlPrefix();
    const filePath = path.resolve(getStorageDir(), url.slice(prefix.length + 1));

    // 双保险：即使前面的字符校验被绕过，也绝不允许删到目录之外的文件
    const storageDir = path.resolve(getStorageDir());
    if (filePath !== path.join(storageDir, path.basename(filePath))) return null;
    if (!filePath.startsWith(storageDir + path.sep)) return null;

    return filePath;
}

/**
 * 过滤一批待写入公告的图片 URL
 * @param {*} input - 客户端传入的 imageUrls（预期为数组）
 * @returns {{urls: string[], rejected: *[]}} 合法的（已去重、截断到上限）与被拒绝的
 */
function sanitizeImageUrls(input) {
    if (!Array.isArray(input)) return { urls: [], rejected: [] };

    const { upload } = getImageConfig();
    const urls = [];
    const rejected = [];

    for (const item of input) {
        if (!isManagedImageUrl(item)) {
            rejected.push(item);
            continue;
        }
        if (!urls.includes(item) && urls.length < upload.max_images_per_announcement) {
            urls.push(item);
        }
    }

    return { urls, rejected };
}

/**
 * 从通知记录里取配图 URL 列表
 * @param {Object} notification - SystemNotification 实例或 toJSON() 结果
 * @returns {string[]}
 */
function extractImageUrls(notification) {
    if (!notification) return [];

    let metadata = notification.metadata;
    if (typeof metadata === 'string') {
        try {
            metadata = JSON.parse(metadata);
        } catch {
            return [];
        }
    }
    if (!metadata || !Array.isArray(metadata.imageUrls)) return [];

    return metadata.imageUrls.filter(isManagedImageUrl);
}

/**
 * 删除一条公告配图文件（文件不存在视为成功，属于幂等清理）
 * @param {string} url - 托管 URL
 * @returns {boolean} 是否真的删掉了文件
 */
function deleteAnnouncementImage(url) {
    const filePath = resolveImageFile(url);
    if (!filePath) return false;

    try {
        fs.unlinkSync(filePath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        console.warn(`[公告配图] 删除文件失败 ${filePath}: ${error.message}`);
        return false;
    }
}

/**
 * 批量清理若干通知携带的配图文件
 * @param {Array<Object>} notifications - 通知记录列表
 * @returns {number} 实际删除的文件数
 */
function deleteImagesOfNotifications(notifications) {
    if (!getImageConfig().upload.delete_file_when_notification_removed) return 0;
    if (!Array.isArray(notifications)) return 0;

    let removed = 0;
    for (const notification of notifications) {
        for (const url of extractImageUrls(notification)) {
            if (deleteAnnouncementImage(url)) removed += 1;
        }
    }
    return removed;
}

module.exports = {
    getImageConfig,
    getStorageDir,
    getUrlPrefix,
    detectImageType,
    saveAnnouncementImage,
    isManagedImageUrl,
    resolveImageFile,
    sanitizeImageUrls,
    extractImageUrls,
    deleteAnnouncementImage,
    deleteImagesOfNotifications
};
