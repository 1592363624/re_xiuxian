/**
 * 通知路由
 * 提供通知查询和管理接口
 */
const express = require('express');
const router = express.Router();
const NotificationService = require('../services/NotificationService');
const authenticateToken = require('../middleware/auth');

/**
 * 获取当前用户的所有通知
 * GET /api/notifications
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.id;
        const options = {
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 20,
            type: req.query.type || null,
            unreadOnly: req.query.unreadOnly === 'true',
            includeGlobal: req.query.includeGlobal !== 'false'
        };

        const result = await NotificationService.getPlayerNotifications(playerId, options);
        res.json(result);
    } catch (error) {
        console.error('获取通知列表失败:', error);
        res.status(500).json({ error: '获取通知列表失败' });
    }
});

/**
 * 获取未读通知数量
 * GET /api/notifications/unread-count
 */
router.get('/unread-count', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.id;
        const count = await NotificationService.getUnreadCount(playerId);
        res.json({ count });
    } catch (error) {
        console.error('获取未读数量失败:', error);
        res.status(500).json({ error: '获取未读数量失败' });
    }
});

/**
 * 获取全服重要通知（新玩家登录时显示）
 * GET /api/notifications/global
 */
router.get('/global', authenticateToken, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const notifications = await NotificationService.getGlobalNotifications(limit);
        res.json({ notifications });
    } catch (error) {
        console.error('获取全服通知失败:', error);
        res.status(500).json({ error: '获取全服通知失败' });
    }
});

/**
 * 标记单条通知为已读
 * POST /api/notifications/:id/read
 */
router.post('/:id/read', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.playerId;
        const notificationId = req.params.id;
        
        await NotificationService.markAsRead(notificationId, playerId);
        res.json({ success: true });
    } catch (error) {
        console.error('标记已读失败:', error);
        res.status(500).json({ error: '标记已读失败' });
    }
});

/**
 * 标记所有通知为已读
 * POST /api/notifications/read-all
 */
router.post('/read-all', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.playerId;
        await NotificationService.markAllAsRead(playerId);
        res.json({ success: true });
    } catch (error) {
        console.error('标记全部已读失败:', error);
        res.status(500).json({ error: '标记全部已读失败' });
    }
});

/**
 * 发送全服公告（GM功能）
 * POST /api/notifications/announcement
 */
router.post('/announcement', authenticateToken, async (req, res) => {
    try {
        if (!req.player || req.player.role !== 'admin') {
            return res.status(403).json({ error: '权限不足' });
        }

        const { title, content, priority } = req.body;
        
        if (!title || !content) {
            return res.status(400).json({ error: '标题和内容不能为空' });
        }

        await NotificationService.sendAnnouncement(title, content, priority || 'high');
        res.json({ success: true, message: '公告已发送' });
    } catch (error) {
        console.error('发送公告失败:', error);
        res.status(500).json({ error: '发送公告失败' });
    }
});

/**
 * 发送玩家事件通知
 * POST /api/notifications/event
 */
router.post('/event', authenticateToken, async (req, res) => {
    try {
        if (!req.player || req.player.role !== 'admin') {
            return res.status(403).json({ error: '权限不足' });
        }

        const { eventName, content, priority } = req.body;
        
        if (!eventName || !content) {
            return res.status(400).json({ error: '事件名称和内容不能为空' });
        }

        await NotificationService.sendEventNotification(eventName, content, priority || 'high');
        res.json({ success: true, message: '事件通知已发送' });
    } catch (error) {
        console.error('发送事件通知失败:', error);
        res.status(500).json({ error: '发送事件通知失败' });
    }
});

/**
 * 测试：发送突破通知
 * POST /api/notifications/test/breakthrough
 */
router.post('/test/breakthrough', authenticateToken, async (req, res) => {
    try {
        if (!req.player || req.player.role !== 'admin') {
            return res.status(403).json({ error: '权限不足' });
        }

        const { nickname, oldRealm, newRealm } = req.body;
        await NotificationService.sendBreakthroughNotification(
            { id: req.player.id, nickname: nickname || req.player.nickname || '测试玩家' },
            oldRealm || '炼气期',
            newRealm || '筑基期'
        );
        res.json({ success: true, message: '突破通知已发送' });
    } catch (error) {
        console.error('发送测试突破通知失败:', error);
        res.status(500).json({ error: '发送测试通知失败' });
    }
});

/**
 * 测试：发送死亡通知
 * POST /api/notifications/test/death
 */
router.post('/test/death', authenticateToken, async (req, res) => {
    try {
        if (!req.player || req.player.role !== 'admin') {
            return res.status(403).json({ error: '权限不足' });
        }

        const { nickname, reason } = req.body;
        await NotificationService.sendDeathNotification(
            { id: req.player.id, nickname: nickname || req.player.nickname || '测试玩家' },
            reason || '寿元耗尽'
        );
        res.json({ success: true, message: '死亡通知已发送' });
    } catch (error) {
        console.error('发送测试死亡通知失败:', error);
        res.status(500).json({ error: '发送测试通知失败' });
    }
});

module.exports = router;
