/**
 * 通知状态管理
 * 负责通知数据的存储和操作
 * 使用统一 Socket 服务接收实时通知
 */
import { defineStore } from 'pinia'
import {
  getNotifications,
  getUnreadCount,
  getGlobalNotifications,
  markAsRead,
  markAllAsRead
} from '../api/notification'
import { socketService } from '../services/socket'

export const useNotificationStore = defineStore('notification', {
  state: () => ({
    notifications: [],
    globalNotifications: [],
    unreadCount: 0,
    isLoading: false,
    systemAlert: null,
    liveNotifications: []
  }),

  actions: {
    /**
     * 初始化 Socket 事件监听
     * 由 playerStore 在登录时统一调用
     */
    initSocketListeners() {
      // 监听个人通知
      socketService.on('notification', (data) => {
        console.log('[NotificationStore] 收到个人通知:', data)
        this.handleRealTimeNotification(data)
      })

      // 监听全服通知
      socketService.on('notification:global', (data) => {
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
     * 获取通知列表
     */
    async fetchNotifications(options = {}) {
      this.isLoading = true
      try {
        const res = await getNotifications(options)
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
        const res = await getUnreadCount()
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
        const res = await getGlobalNotifications(limit)
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
        await markAsRead(notificationId)
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
        await markAllAsRead()
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
     * 添加临时通知到列表
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
