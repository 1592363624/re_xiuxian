import { defineStore } from 'pinia'
import axios from 'axios'
import { io } from 'socket.io-client'

export const useNotificationStore = defineStore('notification', {
  state: () => ({
    notifications: [],
    globalNotifications: [],
    unreadCount: 0,
    isLoading: false,
    systemAlert: null,
    socket: null,
    isConnected: false,
    liveNotifications: []
  }),

  actions: {
    /**
     * 初始化 WebSocket 连接
     * @param {Object} options - 连接选项
     */
    initSocket(options = {}) {
      const playerId = options.playerId || this.playerId
      if (!playerId) {
        console.warn('[NotificationStore] 无法初始化WebSocket：缺少playerId')
        return
      }

      if (this.socket?.connected) {
        console.log('[NotificationStore] WebSocket 已连接，跳过初始化')
        return
      }

      const serverUrl = options.serverUrl || window.location.origin
      this.socket = io(serverUrl, {
        query: { playerId },
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
      })

      this.socket.on('connect', () => {
        this.isConnected = true
        console.log('[NotificationStore] WebSocket 已连接')
      })

      this.socket.on('disconnect', () => {
        this.isConnected = false
        console.log('[NotificationStore] WebSocket 已断开')
      })

      this.socket.on('connect_error', (error) => {
        console.error('[NotificationStore] WebSocket 连接错误:', error)
      })

      this.socket.on('notification', (data) => {
        console.log('[NotificationStore] 收到个人通知:', data)
        this.handleRealTimeNotification(data)
      })

      this.socket.on('notification:global', (data) => {
        console.log('[NotificationStore] 收到全服通知:', data)
        this.handleRealTimeNotification(data)
        this.showSystemAlert({
          title: data.title,
          message: data.content,
          type: data.type === 'announcement' ? 'info' : 'warning'
        })
      })
    },

    /**
     * 处理实时通知
     * @param {Object} notification - 通知数据
     */
    handleRealTimeNotification(notification) {
      this.liveNotifications.unshift({
        ...notification,
        isRead: false,
        createdAt: notification.timestamp || new Date().toISOString()
      })
      this.unreadCount++
      this.notifications.unshift(this.liveNotifications[0])

      if (this.liveNotifications.length > 10) {
        this.liveNotifications.pop()
      }
    },

    /**
     * 断开 WebSocket 连接
     */
    disconnectSocket() {
      if (this.socket) {
        this.socket.disconnect()
        this.socket = null
        this.isConnected = false
        console.log('[NotificationStore] WebSocket 已断开')
      }
    },
    /**
     * 获取通知列表
     */
    async fetchNotifications(options = {}) {
      this.isLoading = true
      try {
        const params = new URLSearchParams()
        if (options.page) params.append('page', options.page)
        if (options.limit) params.append('limit', options.limit)
        if (options.type) params.append('type', options.type)
        if (options.unreadOnly) params.append('unreadOnly', 'true')

        const res = await axios.get(`/api/notifications?${params}`)
        if (res.data.notifications) {
          this.notifications = res.data.notifications
        }
        return res.data
      } catch (error) {
        console.error('获取通知列表失败:', error)
        throw error
      } finally {
        this.isLoading = false
      }
    },

    /**
     * 获取未读通知数量
     */
    async fetchUnreadCount() {
      try {
        const res = await axios.get('/api/notifications/unread-count')
        this.unreadCount = res.data.count
        return this.unreadCount
      } catch (error) {
        console.error('获取未读数量失败:', error)
        throw error
      }
    },

    /**
     * 获取全服重要通知
     */
    async fetchGlobalNotifications(limit = 10) {
      try {
        const res = await axios.get(`/api/notifications/global?limit=${limit}`)
        this.globalNotifications = res.data.notifications || []
        return this.globalNotifications
      } catch (error) {
        console.error('获取全服通知失败:', error)
        throw error
      }
    },

    /**
     * 标记通知为已读
     */
    async markAsRead(notificationId) {
      try {
        await axios.post(`/api/notifications/${notificationId}/read`)
        const notification = this.notifications.find(n => n.id === notificationId)
        if (notification) {
          notification.isRead = true
        }
        if (this.unreadCount > 0) {
          this.unreadCount--
        }
      } catch (error) {
        console.error('标记已读失败:', error)
        throw error
      }
    },

    /**
     * 标记所有通知为已读
     */
    async markAllAsRead() {
      try {
        await axios.post('/api/notifications/read-all')
        this.notifications.forEach(n => {
          n.isRead = true
        })
        this.unreadCount = 0
      } catch (error) {
        console.error('标记全部已读失败:', error)
        throw error
      }
    },

    /**
     * 显示系统警告（弹窗通知）
     * @param {Object} alert - 警告信息 { title, message, type }
     */
    showSystemAlert(alert) {
      this.systemAlert = {
        id: Date.now(),
        ...alert,
        visible: true
      }
    },

    /**
     * 关闭系统警告
     */
    dismissSystemAlert() {
      this.systemAlert = null
    },

    /**
     * 添加临时通知到列表（用于实时推送）
     */
    addTemporaryNotification(notification) {
      this.notifications.unshift({
        id: Date.now(),
        ...notification,
        createdAt: new Date().toISOString(),
        isRead: false
      })
      this.unreadCount++
    }
  }
})
