/**
 * 聊天系统路由（玩家端）
 *
 * 提供聊天频道、红包玩法和物品展示的 HTTP 接口：
 *
 * 聊天消息：
 *   1. GET  /api/chat/history：获取聊天历史记录（最近50条）
 *   2. POST /api/chat/send：发送普通文字消息
 *   3. GET  /api/chat/unread-count：获取未读消息数量
 *   4. POST /api/chat/mark-read：标记已读
 *
 * 红包玩法：
 *   5. POST /api/chat/red-packet/send：发送红包（拼手气/普通均分）
 *   6. POST /api/chat/red-packet/:id/claim：领取红包
 *   7. GET  /api/chat/red-packet/:id：查询红包详情（含领取记录）
 *   8. GET  /api/chat/red-packet/active：获取频道内可领取红包列表
 *
 * 物品展示：
 *   9. POST /api/chat/show-item：在聊天中展示背包物品（防伪造，需校验持有）
 *
 * 设计原则：
 * - 路由层仅做参数校验与调用 Service，业务逻辑在 RedPacketService / InventoryService 中
 * - 统一响应格式：{ code: 200, message, data }
 * - 所有接口均需 auth 中间件鉴权
 * - XSS 防护：消息内容转义 HTML 标签
 * - 红包/物品消息通过 Socket.IO 广播，前端收到后展示卡片
 */
'use strict';

const express = require('express');
const router = express.Router();
const Chat = require('../models/chat');
const authenticateToken = require('../middleware/auth');
const RedPacketService = require('../game/services/RedPacketService');
const InventoryService = require('../game/services/InventoryService');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

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

/* ============================================================
 * 聊天消息接口
 * ============================================================ */

/**
 * GET /api/chat/history
 * 获取聊天历史记录（最近50条，含红包消息）
 */
router.get('/history', authenticateToken, async (req, res, next) => {
    try {
        const messages = await Chat.findAll({
            limit: 50,
            order: [['createdAt', 'DESC']]
        });
        // 倒序返回，方便前端按时间正序展示
        res.json({ code: 200, data: messages.reverse() });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/chat/send
 * 发送普通文字消息
 * body: { content: string }
 */
router.post('/send', authenticateToken, async (req, res, next) => {
    try {
        const { content } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '消息内容不能为空'
            });
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
        next(error);
    }
});

/**
 * GET /api/chat/unread-count
 * 获取未读消息数量
 * query: { lastReadTime?: ISOString }
 */
router.get('/unread-count', authenticateToken, async (req, res, next) => {
    try {
        const lastReadTime = req.query.lastReadTime ? new Date(req.query.lastReadTime) : null;

        let count = 0;
        if (lastReadTime) {
            // 计算指定时间之后的未读消息数量（全局聊天）
            const { Op } = require('sequelize');
            count = await Chat.count({
                where: {
                    createdAt: { [Op.gt]: lastReadTime }
                }
            });
        }

        res.json({ code: 200, count });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/chat/mark-read
 * 标记已读（更新前端最后阅读时间）
 */
router.post('/mark-read', authenticateToken, async (req, res, next) => {
    try {
        const lastReadTime = new Date();
        res.json({ code: 200, success: true, lastReadTime: lastReadTime.toISOString() });
    } catch (error) {
        next(error);
    }
});

/* ============================================================
 * 红包玩法接口
 * ============================================================ */

/**
 * POST /api/chat/red-packet/send
 * 发送红包
 *
 * body: {
 *   total_amount: number,   // 红包总金额（灵石）
 *   total_count: number,    // 红包个数
 *   packet_type?: string,   // 红包类型：lucky(拼手气,默认) / equal(普通均分)
 *   message?: string        // 红包附言（可选，最多100字）
 * }
 */
router.post('/red-packet/send', authenticateToken, async (req, res, next) => {
    try {
        const { total_amount, total_count, packet_type, message } = req.body;

        // 参数校验：total_amount
        if (total_amount === undefined || total_amount === null) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'total_amount 参数不能为空'
            });
        }
        const amountNum = Number(total_amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'total_amount 必须为正数'
            });
        }

        // 参数校验：total_count
        if (total_count === undefined || total_count === null) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'total_count 参数不能为空'
            });
        }
        const countNum = parseInt(total_count);
        if (!Number.isFinite(countNum) || countNum <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'total_count 必须为正整数'
            });
        }

        // 参数校验：packet_type（可选，默认 lucky）
        const pType = packet_type || 'lucky';
        if (!['lucky', 'equal'].includes(pType)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'packet_type 仅支持 lucky(拼手气) 或 equal(普通均分)'
            });
        }

        const result = await RedPacketService.sendRedPacket(
            req.player.id,
            amountNum,
            countNum,
            pType,
            message
        );

        // 通过 Socket.IO 广播红包消息
        const io = req.app.get('io');
        if (io) {
            io.emit('new_message', {
                id: result.chat_message_id,
                sender: result.sender.nickname,
                content: JSON.stringify({
                    red_packet_id: result.red_packet_id,
                    total_amount: result.total_amount,
                    total_count: result.total_count,
                    packet_type: result.packet_type,
                    message: result.message || ''
                }),
                type: 'red_packet',
                createdAt: new Date()
            });
        }

        res.status(201).json({
            code: 201,
            message: '红包发送成功',
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * POST /api/chat/red-packet/:id/claim
 * 领取红包
 * 路径参数：id - 红包ID
 */
router.post('/red-packet/:id/claim', authenticateToken, async (req, res, next) => {
    try {
        const redPacketId = parseInt(req.params.id);
        if (!Number.isFinite(redPacketId) || redPacketId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '红包ID参数无效'
            });
        }

        const result = await RedPacketService.claimRedPacket(req.player.id, redPacketId);

        // 推送领取成功事件给领取者
        try {
            WebSocketNotificationService.notifyPlayerUpdate(req.player.id, 'red_packet_claim_success', {
                red_packet_id: redPacketId,
                amount: result.amount,
                is_lucky_king: result.is_lucky_king,
                sender_nickname: result.sender_nickname
            });
        } catch (e) {
            console.warn('[Chat] 推送红包领取事件失败:', e.message);
        }

        res.json({
            code: 200,
            message: result.is_lucky_king ? '领取成功，恭喜获得手气最佳！' : '领取成功',
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/chat/red-packet/active
 * 获取频道内可领取的活跃红包列表
 *
 * 注意：此路由必须定义在 /red-packet/:id 之前，
 * 否则 Express 会将 "active" 误匹配为 :id 参数
 */
router.get('/red-packet/active', authenticateToken, async (req, res, next) => {
    try {
        const result = await RedPacketService.getActiveRedPackets('world', 20);
        res.json({ code: 200, data: result });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/chat/red-packet/:id
 * 查询红包详情（含领取记录列表）
 * 路径参数：id - 红包ID
 */
router.get('/red-packet/:id', authenticateToken, async (req, res, next) => {
    try {
        const redPacketId = parseInt(req.params.id);
        if (!Number.isFinite(redPacketId) || redPacketId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '红包ID参数无效'
            });
        }

        const result = await RedPacketService.getRedPacketDetail(redPacketId, req.player.id);
        res.json({ code: 200, data: result });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/* ============================================================
 * 物品展示接口
 * ============================================================ */

/**
 * POST /api/chat/show-item
 * 在聊天中展示背包物品（多人社交互动·炫耀装备/分享收获）
 *
 * 业务流程：
 *   1. 参数校验：item_key 非空字符串
 *   2. 安全校验：查询玩家背包，确认玩家确实持有该物品（防伪造）
 *   3. 查询物品静态配置（name/quality/type/description/price）
 *   4. 创建 type='item_show' 的聊天消息，content 存储 JSON
 *   5. Socket.IO 广播物品展示消息
 *
 * 安全设计：
 *   - 必须校验玩家持有该物品，防止伪造展示不存在/未拥有的物品
 *   - content 中不存储敏感字段（effect 中的具体数值不展示，仅展示基础信息）
 *   - item_key 走白名单校验（必须存在于 item_data.json 配置中）
 *
 * body: { item_key: string }
 */
router.post('/show-item', authenticateToken, async (req, res, next) => {
    try {
        const { item_key } = req.body;

        // 参数校验
        if (!item_key || typeof item_key !== 'string' || !item_key.trim()) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'item_key 参数不能为空'
            });
        }

        const itemKey = item_key.trim();

        // 安全校验：查询玩家背包，确认持有该物品（防伪造）
        const inventoryData = await InventoryService.getInventory(req.player.id);
        const playerItem = inventoryData.items.find(i => i.item_key === itemKey);
        if (!playerItem) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.BUSINESS_LOGIC_ERROR,
                message: '你未拥有该物品，无法展示'
            });
        }

        // 构造物品展示信息（仅基础信息，不含 effect 具体数值避免泄露）
        const itemShowContent = {
            item_key: playerItem.item_key,
            item_name: playerItem.name,
            quality: playerItem.quality,
            type: playerItem.type,
            subtype: playerItem.subtype,
            description: playerItem.description,
            price: playerItem.price,
            quantity: playerItem.quantity
        };

        // 创建 type='item_show' 的聊天消息，content 存储 JSON
        const message = await Chat.create({
            sender: req.player.nickname || req.player.username,
            content: JSON.stringify(itemShowContent),
            type: 'item_show'
        });

        // 通过 Socket.IO 广播物品展示消息
        const io = req.app.get('io');
        if (io) {
            io.emit('new_message', {
                id: message.id,
                sender: message.sender,
                content: message.content,
                type: 'item_show',
                createdAt: message.createdAt
            });
        }

        res.status(201).json({
            code: 201,
            message: '物品展示成功',
            data: {
                chat_message_id: message.id,
                item_show: itemShowContent
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
