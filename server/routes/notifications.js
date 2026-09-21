/**
 * 通知路由
 * 提供通知查询和管理接口
 * 修复：使用 requireRole 中间件替换 4 处内联权限校验，统一错误处理为 next(error) + AppError
 */
const express = require('express');
const router = express.Router();
const NotificationService = require('../game/services/NotificationService');
const authenticateToken = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 修复：复用 InterfaceGateway 的 requireRole 中间件，替换内联权限校验
const interfaceGateway = require('../modules/application/InterfaceGateway');
const requireAdmin = interfaceGateway.requireRole('admin');

// 公告配图地址白名单校验（只认本服务 /api/uploads/announcements/ 下已落盘的文件）
const { sanitizeImageUrls } = require('../utils/announcementImage');

/**
 * 获取当前用户的所有通知
 * GET /api/notifications
 */
router.get('/', authenticateToken, async (req, res, next) => {
    try {
        const playerId = req.user.id;
        const options = {
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 20,
            type: req.query.type || null,
            unreadOnly: req.query.unreadOnly === 'true',
            includeGlobal: req.query.includeGlobal !== 'false',
            // 只有管理员能看见已撤回（isActive=false）的通知：
            // GM 后台靠它列出被撤回的公告以便恢复，玩家侧永远看不到这一批。
            includeInactive: req.query.includeInactive === 'true' && req.player?.role === 'admin'
        };

        const result = await NotificationService.getPlayerNotifications(playerId, options);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * 获取未读通知数量
 * GET /api/notifications/unread-count
 */
router.get('/unread-count', authenticateToken, async (req, res, next) => {
    try {
        const playerId = req.user.id;
        const count = await NotificationService.getUnreadCount(playerId);
        res.json({ count });
    } catch (error) {
        next(error);
    }
});

/**
 * 获取全服重要通知（新玩家登录时显示）
 * GET /api/notifications/global
 */
router.get('/global', authenticateToken, async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const notifications = await NotificationService.getGlobalNotifications(limit);
        res.json({ notifications });
    } catch (error) {
        next(error);
    }
});

/**
 * 标记单条通知为已读
 * POST /api/notifications/:id/read
 */
router.post('/:id/read', authenticateToken, async (req, res, next) => {
    try {
        const playerId = req.user.id;
        const notificationId = req.params.id;

        await NotificationService.markAsRead(notificationId, playerId);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

/**
 * 标记所有通知为已读
 * POST /api/notifications/read-all
 */
router.post('/read-all', authenticateToken, async (req, res, next) => {
    try {
        const playerId = req.user.id;
        await NotificationService.markAllAsRead(playerId);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

/**
 * 发送全服公告（GM 功能）
 * POST /api/notifications/announcement
 *
 * imageUrls 可选：必须是本服务 /api/uploads/announcements/ 下已上传的图片地址
 * （先调 POST /api/uploads/announcement-image 上传，再把返回的 url 填进来）。
 * 只放行本服务托管地址，避免公告被用来引用外部图片——那会把玩家 IP 泄露给第三方，
 * 也给了钓鱼图片一个合法的展示位置。
 */
router.post('/announcement', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const { title, content, priority, imageUrls } = req.body;

        // 非法的图片地址直接拒绝而不是静默丢弃：GM 需要立刻知道这条公告的图没带上
        const { urls: safeImageUrls, rejected } = sanitizeImageUrls(imageUrls);
        if (rejected.length > 0) {
            throw new AppError(
                '存在不合法的图片地址，请先通过公告配图上传接口获取地址',
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 纯图片公告也允许发送，因此"内容"与"配图"满足其一即可
        if (!title || (!content && safeImageUrls.length === 0)) {
            throw new AppError('标题和内容不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        await NotificationService.sendAnnouncement(
            title,
            content || '',
            priority || 'high',
            { imageUrls: safeImageUrls }
        );
        res.json({ code: 200, message: '公告已发送' });
    } catch (error) {
        next(error);
    }
});

/**
 * 发送玩家事件通知
 * POST /api/notifications/event
 */
router.post('/event', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const { eventName, content, priority } = req.body;

        if (!eventName || !content) {
            throw new AppError('事件名称和内容不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        await NotificationService.sendEventNotification(eventName, content, priority || 'high');
        res.json({ code: 200, message: '事件通知已发送' });
    } catch (error) {
        next(error);
    }
});

/**
 * 测试：发送突破通知
 * POST /api/notifications/test/breakthrough
 */
router.post('/test/breakthrough', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const { nickname, oldRealm, newRealm } = req.body;
        await NotificationService.sendBreakthroughNotification(
            { id: req.user.id, nickname: nickname || req.user.nickname || '测试玩家' },
            oldRealm || '炼气期',
            newRealm || '筑基期'
        );
        res.json({ code: 200, message: '突破通知已发送' });
    } catch (error) {
        next(error);
    }
});

/**
 * 测试：发送死亡通知
 * POST /api/notifications/test/death
 */
router.post('/test/death', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const { nickname, reason } = req.body;
        await NotificationService.sendDeathNotification(
            { id: req.user.id, nickname: nickname || req.user.nickname || '测试玩家' },
            reason || '寿元耗尽'
        );
        res.json({ code: 200, message: '死亡通知已发送' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
