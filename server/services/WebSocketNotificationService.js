/**
 * WebSocket 通知服务
 * 负责通过 WebSocket 实时推送通知和玩家数据更新给客户端
 */
const eventBus = require('../modules/infrastructure/EventBus');

class WebSocketNotificationService {
    constructor() {
        this.io = null;
        this.onlineUsers = new Map();
        this.setupEventListeners();
    }

    /**
     * 初始化 WebSocket 服务
     * @param {Object} io - Socket.IO 实例
     */
    initialize(io) {
        this.io = io;

        io.on('connection', (socket) => {
            const playerId = socket.handshake.query.playerId || socket.handshake.auth.playerId;
            if (playerId) {
                this.onlineUsers.set(playerId.toString(), {
                    socketId: socket.id,
                    connectedAt: new Date()
                });
                console.log(`[WebSocket] 玩家 ${playerId} 已连接，SocketID: ${socket.id}`);

                socket.join(`player:${playerId}`);
            }

            socket.on('disconnect', () => {
                if (playerId) {
                    const userInfo = this.onlineUsers.get(playerId.toString());
                    if (userInfo && userInfo.socketId === socket.id) {
                        this.onlineUsers.delete(playerId.toString());
                        console.log(`[WebSocket] 玩家 ${playerId} 已断开连接`);
                    }
                }
            });
        });

        console.log('[WebSocket] 通知服务初始化完成');
    }

    /**
     * 设置事件监听
     */
    setupEventListeners() {
        eventBus.subscribe('notification:created', async (event) => {
            await this.broadcastNotification(event.data);
        });

        eventBus.subscribe('player:updated', async (event) => {
            await this.broadcastPlayerUpdate(event.data);
        });
    }

    /**
     * 广播玩家数据更新事件
     * @param {Object} data - 更新数据，包含 playerId
     */
    async broadcastPlayerUpdate(data) {
        if (!this.io) {
            console.warn('[WebSocket] io 实例未初始化，无法推送玩家数据更新');
            return;
        }

        const { playerId, updateType, changes } = data;

        if (!playerId) {
            console.warn('[WebSocket] 玩家数据更新缺少 playerId');
            return;
        }

        const payload = {
            type: 'player_update',
            updateType,
            changes,
            timestamp: new Date().toISOString()
        };

        try {
            this.io.to(`player:${playerId}`).emit('player:updated', payload);
            console.log(`[WebSocket] 玩家数据更新已推送给玩家 ${playerId}: ${updateType}`);
        } catch (error) {
            console.error('[WebSocket] 玩家数据更新推送失败:', error);
        }
    }

    /**
     * 推送玩家数据更新给单个玩家
     * @param {number|string} playerId - 玩家ID
     * @param {string} updateType - 更新类型
     * @param {Object} changes - 变更内容
     */
    notifyPlayerUpdate(playerId, updateType, changes = {}) {
        if (!this.io) {
            console.warn('[WebSocket] io 实例未初始化');
            return false;
        }

        const payload = {
            type: 'player_update',
            updateType,
            changes,
            timestamp: new Date().toISOString()
        };

        this.io.to(`player:${playerId}`).emit('player:updated', payload);
        console.log(`[WebSocket] 玩家 ${playerId} 收到数据更新通知: ${updateType}`);
        return true;
    }

    /**
     * 广播通知给特定玩家或全服
     * @param {Object} notificationData - 通知数据
     */
    async broadcastNotification(notificationData) {
        if (!this.io) {
            console.warn('[WebSocket] io 实例未初始化，无法推送通知');
            return;
        }

        const { targetPlayerId, type, title, content, priority, actorNickname } = notificationData;
        const icon = this.getNotificationIcon(type);

        const notificationPayload = {
            id: Date.now(),
            type,
            title,
            content,
            priority,
            actorNickname,
            icon,
            timestamp: new Date().toISOString()
        };

        try {
            if (targetPlayerId) {
                this.io.to(`player:${targetPlayerId}`).emit('notification', notificationPayload);
                console.log(`[WebSocket] 通知已推送给玩家 ${targetPlayerId}: ${title}`);
            } else {
                this.io.emit('notification:global', notificationPayload);
                console.log(`[WebSocket] 全服通知已推送: ${title}`);
            }
        } catch (error) {
            console.error('[WebSocket] 通知推送失败:', error);
        }
    }

    /**
     * 推送通知给单个玩家
     * @param {number|string} playerId - 玩家ID
     * @param {Object} notification - 通知对象
     */
    sendToPlayer(playerId, notification) {
        if (!this.io) {
            console.warn('[WebSocket] io 实例未初始化');
            return false;
        }

        const icon = this.getNotificationIcon(notification.type);
        const payload = {
            id: Date.now(),
            ...notification,
            icon,
            timestamp: new Date().toISOString()
        };

        this.io.to(`player:${playerId}`).emit('notification', payload);
        console.log(`[WebSocket] 通知已推送给玩家 ${playerId}`);
        return true;
    }

    /**
     * 推送全服公告
     * @param {Object} notification - 通知对象
     */
    sendGlobalAnnouncement(notification) {
        if (!this.io) {
            console.warn('[WebSocket] io 实例未初始化');
            return false;
        }

        const icon = this.getNotificationIcon('announcement');
        const payload = {
            id: Date.now(),
            ...notification,
            type: 'announcement',
            icon,
            timestamp: new Date().toISOString()
        };

        this.io.emit('notification:global', payload);
        console.log(`[WebSocket] 全服公告已推送: ${notification.title}`);
        return true;
    }

    /**
     * 获取通知图标
     * @param {string} type - 通知类型
     * @returns {string} 图标标识
     */
    getNotificationIcon(type) {
        const iconConfig = require('../config/notification_icons.json');
        return iconConfig.icons[type] || iconConfig.icons.default;
    }

    /**
     * 获取在线用户数
     * @returns {number} 在线用户数
     */
    getOnlineCount() {
        return this.onlineUsers.size;
    }

    /**
     * 检查玩家是否在线
     * @param {string} playerId - 玩家ID
     * @returns {boolean} 是否在线
     */
    isPlayerOnline(playerId) {
        return this.onlineUsers.has(playerId.toString());
    }
}

module.exports = new WebSocketNotificationService();
