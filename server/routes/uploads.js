/**
 * 上传路由
 * 提供 GM 后台公告配图的直传接口（原始二进制上传，非 multipart / base64）
 *
 * 为什么走原始二进制而不是 base64 塞进 JSON：
 *   base64 会让体积膨胀约 33%，而公告图常见为整屏截图（几百 KB ~ 数 MB），
 *   既会撑爆 express.json 的默认 100KB 限制，也会让请求体白白变大。
 *   前端直接把 Blob 作为 body 发送，Content-Type 用图片 MIME，服务端用 express.raw 承接。
 *
 * 鉴权与权限与其它 GM 接口一致：JWT + admin 角色。
 */
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const interfaceGateway = require('../modules/application/InterfaceGateway');
const requireAdmin = interfaceGateway.requireRole('admin');
const announcementImage = require('../utils/announcementImage');

/**
 * 按当前配置构造"原始图片二进制"解析器
 *
 * 为什么每次请求都构造：limit 与 MIME 白名单都来自可热更的 announcement_upload 配置，
 * 而 express.raw 的选项在构造那一刻就固定了。模块加载时构造一次的话，后台调大体积上限
 * 必须重启进程才生效。（body-parser 允许在请求内构造中间件，只有 express-rate-limit 禁止。）
 * @type {import('express').RequestHandler}
 */
function parseRawImage(req, res, next) {
    const { upload } = announcementImage.getImageConfig();
    const limitMb = Math.round(upload.max_file_size_bytes / 1024 / 1024);

    const parser = express.raw({
        // 白名单内的 MIME 才解析；其它 Content-Type 会跳过解析，落到下面的"未接收到图片数据"
        type: upload.allowed_types.map(t => t.mime),
        limit: upload.max_file_size_bytes
    });

    parser(req, res, (err) => {
        if (!err) return next();

        const tooLarge = err.type === 'entity.too.large' || err.status === 413;
        return next(new AppError(
            tooLarge
                ? `图片体积超过限制（最大 ${limitMb}MB）`
                : `图片解析失败：${err.message}`,
            tooLarge ? 413 : 400,
            ErrorCodes.VALIDATION_ERROR
        ));
    });
}

/**
 * 上传公告配图（GM）
 * POST /api/uploads/announcement-image
 *
 * 请求：body 为图片原始二进制，Content-Type 为允许的图片 MIME
 * 响应：{ code, message, data: { url, fileName, size, mimeType } }
 *   前端拿到 data.url 后，随发送公告接口的 imageUrls 一起提交即可
 */
router.post('/announcement-image', authenticateToken, requireAdmin, parseRawImage, async (req, res, next) => {
    try {
        const buffer = req.body;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            throw new AppError(
                '未接收到图片数据，请确认 Content-Type 为支持的图片类型',
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 只认文件头魔数：Content-Type 与文件名都由客户端提供，不可信
        const imageType = announcementImage.detectImageType(buffer);
        if (!imageType) {
            throw new AppError(
                '图片格式不受支持，仅允许 PNG / JPG / GIF / WEBP',
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        const saved = announcementImage.saveAnnouncementImage(buffer, imageType);
        res.json({
            code: 200,
            message: '图片上传成功',
            data: saved
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
