const express = require('express');
const router = express.Router();
const Chat = require('../models/chat');
const authenticateToken = require('../middleware/auth');

/**
 * 获取聊天历史记录
 * GET /api/chat/history
 */
router.get('/history', async (req, res) => {
    try {
        const messages = await Chat.findAll({
            limit: 50,
            order: [['createdAt', 'DESC']]
        });
        // 倒序返回，方便前端展示
        res.json(messages.reverse());
    } catch (error) {
        res.status(500).json({ message: '获取聊天记录失败', error: error.message });
    }
});

/**
 * 发送消息
 * POST /api/chat/send
 */
router.post('/send', authenticateToken, async (req, res) => {
    try {
        const { content } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ message: '消息内容不能为空' });
        }

        const message = await Chat.create({
            sender: req.user.nickname || req.user.username,
            content: content.trim(),
            type: 'player'
        });

        res.status(201).json(message);
    } catch (error) {
        res.status(500).json({ message: '发送消息失败', error: error.message });
    }
});

module.exports = router;
