/**
 * 统一的 WebSocket 服务
 * 负责创建和维护单一的 Socket.IO 连接，避免多个连接造成资源浪费
 * 提供事件订阅机制，供各个 store 和组件使用
 */

import { io } from 'socket.io-client'
import { usePlayerStore } from '../stores/player'

class SocketService {
  constructor() {
    this.socket = null
    this.isConnected = false
    this.listeners = new Map() // 事件监听器映射表
  }

  /**
   * 初始化 WebSocket 连接
   * @param {Object} options - 连接选项
   * @param {number} options.playerId - 玩家ID
   * @param {string} options.serverUrl - 服务器地址（开发环境需要指定）
   */
  connect(options = {}) {
    // 如果已连接，先断开
    if (this.socket) {
      this.disconnect()
    }

    const playerStore = usePlayerStore()
    const playerId = options.playerId || playerStore.player?.id

    if (!playerId) {
      console.warn('[SocketService] 无法初始化WebSocket：缺少playerId')
      return
    }

    // 使用环境变量配置后端地址
    // 在开发环境下，通过 VITE_API_URL 指定后端地址
    // 在生产环境下，使用相对路径（同域部署）
    const serverUrl = options.serverUrl || (import.meta.env.DEV ? (import.meta.env.VITE_API_URL || 'http://localhost:5000') : '')

    this.socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      auth: {
        playerId: playerId
      }
    })

    // 连接成功事件
    this.socket.on('connect', () => {
      console.log('[SocketService] WebSocket 连接成功')
      this.isConnected = true
      this.emit('connected', { playerId })
    })

    // 连接断开事件
    this.socket.on('disconnect', () => {
      console.log('[SocketService] WebSocket 连接断开')
      this.isConnected = false
      this.emit('disconnected')
    })

    // 连接错误事件
    this.socket.on('connect_error', (error) => {
      console.warn('[SocketService] WebSocket 连接失败:', error.message)
      this.isConnected = false
      this.emit('connect_error', error)
    })

    // 转发所有服务器事件到对应的监听器
    this.setupEventForwarding()
  }

  /**
   * 设置事件转发
   * 将服务器发送的事件转发给注册的监听器
   */
  setupEventForwarding() {
    if (!this.socket) return

    // 监听所有可能的事件类型
    const events = [
      'player:updated',
      'move:completed',
      'notification',
      'notification:global',
      'new_message'
    ]

    events.forEach(event => {
      this.socket.on(event, (data) => {
        this.emit(event, data)
      })
    })
  }

  /**
   * 断开 WebSocket 连接
   */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
      this.isConnected = false
      this.listeners.clear()
      console.log('[SocketService] WebSocket 连接已断开')
    }
  }

  /**
   * 注册事件监听器
   * @param {string} event - 事件名称
   * @param {Function} callback - 回调函数
   * @returns {Function} 取消监听的函数
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event).add(callback)

    // 返回取消监听的函数
    return () => {
      this.off(event, callback)
    }
  }

  /**
   * 取消事件监听
   * @param {string} event - 事件名称
   * @param {Function} callback - 回调函数
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback)
      if (this.listeners.get(event).size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  /**
   * 触发事件
   * @param {string} event - 事件名称
   * @param {any} data - 事件数据
   */
  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => {
        try {
          callback(data)
        } catch (error) {
          console.error(`[SocketService] 事件处理器执行失败: ${event}`, error)
        }
      })
    }
  }

  /**
   * 发送事件到服务器
   * @param {string} event - 事件名称
   * @param {any} data - 事件数据
   */
  send(event, data) {
    if (this.socket && this.isConnected) {
      this.socket.emit(event, data)
    } else {
      console.warn('[SocketService] WebSocket 未连接，无法发送事件')
    }
  }
}

// 导出单例实例
export const socketService = new SocketService()
