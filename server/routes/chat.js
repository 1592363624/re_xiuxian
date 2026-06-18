const express = require('express');
const router = express.Router();
const Chat = require('../models/chat');
const authenticateToken = require('../middleware/auth');

/**
 * 获取聊天历史记录
 * GET /api/chat/history
 */
router.get('/history', authenticateToken, async (req, res) => {
    try {
        const messages = await Chat.findAll({
            limit: 50,
            order: [['createdAt', 'DESC']]
        });
        // 倒序返回，方便前端展示
        res.json({ code: 200, data: messages.reverse() });
    } catch (error) {
        res.status(500).json({ code: 500, message: '获取聊天记录失败', error: error.message });
    }
});

/**
 * 简单 XSS 过滤：转义 HTML 标签，防止存储型 XSS
 * @param {string} str - 原始字符串
 * @returns {string} 过滤后的安全字符串
 */
function sanitizeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

/**
 * 发送消息
 * POST /api/chat/send
 */
router.post('/send', authenticateToken, async (req, res) => {
    try {
        const { content } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ code: 400, message: '消息内容不能为空' });
        }

        // XSS 过滤：转义 HTML 标签
        const safeContent = sanitizeHtml(content.trim());

        const message = await Chat.create({
            sender: req.player.nickname || req.player.username,
            content: safeContent,
            type: 'player'
        });

        // 通过 Socket.IO 广播新消息
        const io = req.app.get('io');
        if (io) {
            io.emit('new_message', {
                id: message.id,
                sender: message.sender,
                content: message.content,
                type: message.type,
                createdAt: message.createdAt
            });
        }

        res.status(201).json({ code: 201, data: message });
    } catch (error) {
        res.status(500).json({ code: 500, message: '发送消息失败', error: error.message });
    }
});

/**
 * 获取聊天未读消息数量
 * GET /api/chat/unread-count
 */
router.get('/unread-count', authenticateToken, async (req, res) => {
    try {
        const lastReadTime = req.query.lastReadTime ? new Date(req.query.lastReadTime) : null;
        
        let count = 0;
        
        if (lastReadTime) {
            // 计算指定时间之后的未读消息数量（全局聊天，不按玩家过滤）
            count = await Chat.count({
                where: {
                    createdAt: {
                        [require('sequelize').Op.gt]: lastReadTime
                    }
                }
            });
        } else {
            // 获取所有未读的聊天消息（通过前端传入的 lastReadTime 来判断）
            count = 0;
        }
        
        res.json({ code: 200, count });
    } catch (error) {
        res.status(500).json({ code: 500, message: '获取未读消息数量失败', error: error.message });
    }
});

/**
 * 更新最后阅读时间
 * POST /api/chat/mark-read
 */
router.post('/mark-read', authenticateToken, async (req, res) => {
    try {
        const lastReadTime = new Date();
        
        res.json({ code: 200, success: true, lastReadTime: lastReadTime.toISOString() });
    } catch (error) {
        res.status(500).json({ code: 500, message: '标记已读失败', error: error.message });
    }
});

module.exports = router;
