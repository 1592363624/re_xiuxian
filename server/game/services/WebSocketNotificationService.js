/**
 * WebSocket 通知服务
 * 负责通过 WebSocket 实时推送通知和玩家数据更新给客户端
 * 安全要求：必须在 connection 回调内校验 JWT，禁止信任客户端传入的 playerId
 */
const jwt = require('jsonwebtoken');
const eventBus = require('../../modules/infrastructure/EventBus');
const configLoader = require('../../modules/infrastructure/ConfigLoader');
const Player = require('../../models/player');

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

        io.on('connection', async (socket) => {
            // 修复安全漏洞：必须通过 JWT 校验身份，禁止信任客户端传入的 playerId
            const token = socket.handshake.auth?.token || socket.handshake.query?.token;
            let playerId = null;

            if (token) {
                try {
                    const decoded = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
                    // 二次校验玩家存在性和 token_version（与 auth middleware 保持一致）
                    const player = await Player.findByPk(decoded.id);
                    if (player && player.token_version === decoded.v) {
                        playerId = player.id;
                    } else {
                        console.warn(`[WebSocket] 玩家 ${decoded.id} 不存在或 token_version 不一致，拒绝连接`);
                        socket.emit('auth_error', { message: '认证失败，请重新登录' });
                        socket.disconnect(true);
                        return;
                    }
                } catch (err) {
                    console.warn(`[WebSocket] JWT 校验失败: ${err.message}`);
                    socket.emit('auth_error', { message: '令牌无效或已过期' });
                    socket.disconnect(true);
                    return;
                }
            } else {
                console.warn('[WebSocket] 连接未携带 token，拒绝连接');
                socket.emit('auth_error', { message: '未提供认证令牌' });
                socket.disconnect(true);
                return;
            }

            // 绑定 playerId（来自 JWT 解码后查库结果，非客户端传入）
            this.onlineUsers.set(playerId.toString(), {
                socketId: socket.id,
                connectedAt: new Date()
            });
            console.log(`[WebSocket] 玩家 ${playerId} 已连接，SocketID: ${socket.id}`);
            socket.join(`player:${playerId}`);

            // 世界地图接入：确保出生坐标并加入同图房间（懒加载避免循环依赖）
            try {
                const WorldMovementService = require('./WorldMovementService');
                await WorldMovementService.onSocketConnect(playerId);
            } catch (err) {
                console.warn(`[WebSocket] 玩家 ${playerId} 世界房间初始化失败:`, err.message);
            }

            // 状态恢复：连接建立后主动推送玩家进行中状态快照
            // 解决"纯 Socket 重连不刷新页面无法恢复状态"的问题
            // 前端收到 state:snapshot 后可据此恢复闭关/移动/战斗/历练的 UI 状态
            try {
                const PlayerStateService = require('./PlayerStateService');
                const snapshot = await PlayerStateService.getStateSnapshot(playerId);
                socket.emit('state:snapshot', {
                    type: 'state_snapshot',
                    snapshot,
                    timestamp: new Date().toISOString()
                });
                // 快照真实形状是 states.seclusion；历史扁平字段由 PlayerStateService 兼容展开
                const s = snapshot.states || snapshot;
                console.log(`[WebSocket] 已推送状态快照给玩家 ${playerId} ` +
                    `(闭关:${s.seclusion?.is_secluded} 移动:${s.moving?.is_moving} ` +
                    `战斗:${s.battle?.in_battle} 历练:${s.adventure?.is_adventuring})`);
            } catch (err) {
                console.warn(`[WebSocket] 推送状态快照失败 玩家 ${playerId}:`, err.message);
            }

            socket.on('disconnect', () => {
                const userInfo = this.onlineUsers.get(playerId.toString());
                if (userInfo && userInfo.socketId === socket.id) {
                    this.onlineUsers.delete(playerId.toString());
                    console.log(`[WebSocket] 玩家 ${playerId} 已断开连接`);
                }
            });
        });

        console.log('[WebSocket] 通知服务初始化完成（已启用 JWT 鉴权）');
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

        // 世界动态：关键结果顺手播给其他人（白名单在 world_activity.json）
        // 懒加载，避免与 WorldActivityService 循环 require
        try {
            const WorldActivityService = require('./WorldActivityService');
            WorldActivityService.fromPlayerUpdate(playerId, updateType, changes).catch(() => {});
        } catch {
            // 动态广播失败不影响本人推送
        }
        return true;
    }

    /**
     * 广播世界动态到「修仙日志 · 全部」流（不推给操作者本人）
     * @param {Object} activity - { playerId, actorId, actorName, content, type, isImportant }
     */
    broadcastActivity(activity) {
        if (!this.io) {
            console.warn('[WebSocket] io 实例未初始化，无法广播世界动态');
            return false;
        }

        const actorId = activity?.playerId ?? activity?.actorId;
        const payload = {
            type: 'world_activity',
            actorId: actorId ?? null,
            actorName: activity?.actorName || '某位道友',
            content: activity?.content || '',
            logType: activity?.type || 'info',
            isImportant: !!activity?.isImportant,
            timestamp: activity?.timestamp || new Date().toISOString()
        };

        try {
            if (actorId !== null && actorId !== undefined) {
                // 除操作者外全服可见：自己的动作前端已写过 actorId='self'，避免重复
                this.io.except(`player:${actorId}`).emit('world:activity', payload);
            } else {
                this.io.emit('world:activity', payload);
            }
            console.log(`[WebSocket] 世界动态已广播: ${payload.actorName} ${payload.content}`);
            return true;
        } catch (error) {
            console.error('[WebSocket] 世界动态广播失败:', error);
            return false;
        }
    }

    /**
     * 向指定玩家推送任意自定义事件
     * 用于状态清理等场景需要直接 emit 特定事件名（如 move:completed），
     * 而非通过统一的 player:updated 通道。
     * @param {number|string} playerId - 玩家ID
     * @param {string} event - 事件名（如 'move:completed'）
     * @param {Object} data - 推送数据
     * @returns {boolean} 是否推送成功（玩家不在线时返回 false 但不报错）
     */
    emitToPlayer(playerId, event, data = {}) {
        if (!this.io) {
            console.warn('[WebSocket] io 实例未初始化');
            return false;
        }
        // 玩家不在线时静默返回，不视为错误（清理任务可正常完成）
        if (!this.isPlayerOnline(playerId)) {
            return false;
        }
        try {
            this.io.to(`player:${playerId}`).emit(event, data);
            return true;
        } catch (err) {
            console.warn(`[WebSocket] 推送自定义事件 ${event} 给玩家 ${playerId} 失败:`, err.message);
            return false;
        }
    }

    /**
     * 取通知携带的公告配图地址
     *
     * 兼容两种入参形状：EventBus 传来的 metadata.imageUrls（对象或 JSON 字符串），
     * 以及调用方直接挂在对象上的 imageUrls。前者是公告的正常路径，后者便于其它
     * 服务直接推送带图通知而无需手工构造 metadata。
     * @param {Object} data - 通知数据
     * @returns {string[]} 图片 URL 列表（无图时为空数组）
     */
    extractImageUrls(data) {
        if (!data) return [];
        if (Array.isArray(data.imageUrls)) return data.imageUrls;

        let metadata = data.metadata;
        if (typeof metadata === 'string') {
            try {
                metadata = JSON.parse(metadata);
            } catch {
                return [];
            }
        }
        return Array.isArray(metadata?.imageUrls) ? metadata.imageUrls : [];
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
            // 公告配图：前端 SystemAlert 直接用它渲染 <img>，无需再回查通知列表
            imageUrls: this.extractImageUrls(notificationData),
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
            imageUrls: this.extractImageUrls(notification),
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
            imageUrls: this.extractImageUrls(notification),
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
        // 走 ConfigLoader：以前 require('../../config/notification_icons.json') 会被 Node 永久缓存，
        // 热更接口改了这份配置，图标也不会变。
        const iconConfig = configLoader.getConfig('notification_icons') || {};
        const icons = iconConfig.icons || {};
        return icons[type] || icons.default;
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
