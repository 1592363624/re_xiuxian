/**
 * 玩家状态管理
 * 负责玩家数据的存储和基础操作
 * 业务逻辑已移至后端，前端只负责数据展示和 API 调用
 */
import { defineStore } from 'pinia'
import { getPlayer } from '../api/player'
import { getStatus as getSeclusionStatus, start as startSeclusionApi, end as endSeclusionApi } from '../api/seclusion'
import { getConfig as getSystemConfig } from '../api/system'
import { socketService } from '../services/socket'

export const usePlayerStore = defineStore('player', {
  state: () => ({
    token: localStorage.getItem('token') || null,
    player: JSON.parse(localStorage.getItem('player')) || null,
    logoutReason: null,
    systemConfig: {},
    isSocketConnected: false,
    movingState: {
      isMoving: false,
      fromMapId: null,
      toMapId: null,
      fromMapName: '',
      toMapName: '',
      startTime: null,
      endTime: null,
      totalSeconds: 0,
      remainingSeconds: 0
    }
  }),
  
  actions: {
    setToken(token) {
      this.token = token
      localStorage.setItem('token', token)
      // 初始化 Socket 连接
      socketService.connect({ playerId: this.player?.id })
      this.setupSocketListeners()
    },
    
    setPlayer(player) {
      this.player = player
      localStorage.setItem('player', JSON.stringify(player))
    },

    /**
     * 设置 Socket 事件监听
     * 统一处理后端推送的数据更新
     */
    setupSocketListeners() {
      // 监听连接状态
      socketService.on('connected', () => {
        this.isSocketConnected = true
      })

      socketService.on('disconnected', () => {
        this.isSocketConnected = false
      })

      // 监听玩家数据更新
      socketService.on('player:updated', async (data) => {
        console.log('[PlayerStore] 收到玩家数据更新:', data)
        
        if (data.updateType === 'gm_delete') {
          this.logout('您的账号已被管理员删除')
          return
        }

        if (data.updateType === 'gm_ban') {
          this.logout(`您已被管理员封禁，原因：${data.reason || '未说明'}`)
          return
        }

        // 重新获取玩家数据
        await this.fetchPlayer()
      })

      // 监听移动完成
      socketService.on('move:completed', async () => {
        this.clearMovingState()
        await this.fetchPlayer()
      })
    },

    /**
     * 断开 Socket 连接
     */
    disconnectSocket() {
      socketService.disconnect()
      this.isSocketConnected = false
    },

    /**
     * 获取玩家信息
     */
    async fetchPlayer() {
      if (!this.token) return
      try {
        const res = await getPlayer()
        this.setPlayer(res.data.data)
      } catch (error) {
        if (error.response) {
          // 处理互踢逻辑
          if (error.response.data?.code === 'SESSION_EXPIRED') {
             this.logout('您的账号已在其他设备登录，当前会话已失效')
             return
          }

          if (error.response.status === 401) {
            this.logout('登录已过期，请重新登录')
            return
          } else if (error.response.status === 404) {
            this.logout('玩家数据不存在')
            return
          }
        }
        console.error('获取玩家信息失败:', error)
      }
    },

    /**
     * 获取闭关状态
     */
    async fetchSeclusionStatus() {
      if (!this.token) return null
      try {
        const res = await getSeclusionStatus()
        // 后端返回格式: { code: 200, data: { is_secluded, ... } }
        const data = res.data?.data || res.data
        if (data) {
             if (this.player) {
                 // 更新闭关相关状态
                 this.player.is_secluded = data.is_secluded
                 this.player.seclusion_start_time = data.seclusion_start_time
                 this.player.seclusion_duration = data.seclusion_duration
                 // 同步更新 localStorage，确保数据一致性
                 localStorage.setItem('player', JSON.stringify(this.player))
             }
             this.systemConfig.cultivate_interval = data.cultivate_interval
             this.systemConfig.deep_seclusion_exp_rate = data.deep_seclusion_exp_rate
             this.systemConfig.deep_seclusion_interval = data.deep_seclusion_interval
             return data
        }
      } catch (error) {
        console.error('获取闭关状态失败:', error)
      }
      return null
    },

    /**
     * 开始闭关
     * 业务逻辑由后端处理，前端调用API后立即更新本地状态
     */
    async startSeclusion(duration) {
      if (!this.token) {
        console.warn('开始闭关失败: 未登录或token不存在')
        return
      }
      try {
        const res = await startSeclusionApi(duration)
        // 立即更新本地状态，确保UI即时响应
        if (res.data && this.player) {
          this.player.is_secluded = true
          this.player.seclusion_start_time = res.data.data?.seclusion_start_time || new Date()
          localStorage.setItem('player', JSON.stringify(this.player))
        }
        return res.data
      } catch (error) {
        console.error('开始闭关失败:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status
        })
        // 直接抛出原始错误，保留 response 结构供上层处理
        throw error
      }
    },

    /**
     * 结束闭关
     * 业务逻辑由后端处理，前端调用API后立即更新本地状态
     */
    async endSeclusion() {
      if (!this.token) return
      try {
        const res = await endSeclusionApi()
        // 立即更新本地状态，确保UI即时响应
        if (res.data && this.player) {
          this.player.is_secluded = false
          this.player.exp = res.data.data?.exp || this.player.exp
          this.player.last_seclusion_time = res.data.data?.last_seclusion_time || new Date()
          localStorage.setItem('player', JSON.stringify(this.player))
        }
        return res.data
      } catch (error) {
        console.error('结束闭关失败:', error.response?.data || error.message || error)
        throw error
      }
    },

    /**
     * 尝试突破
     */
    async tryBreakthrough() {
      if (!this.token) return null
      try {
        const apiClient = (await import('../api/index')).default
        const res = await apiClient.post('/breakthrough/try')
        // 等待 Socket.IO 推送更新
        return res.data
      } catch (error) {
        console.error('尝试突破失败:', error.response?.data || error.message || error)
        throw error
      }
    },

    /**
     * 获取系统配置
     */
    async fetchSystemConfig() {
      if (!this.token) return
      try {
        const res = await getSystemConfig()
        this.systemConfig = res.data
      } catch (error) {
        console.warn('获取系统配置失败，使用默认值:', error)
      }
    },

    /**
     * 设置移动状态
     */
    setMovingState(state) {
      this.movingState = {
        isMoving: true,
        fromMapId: state.from_map_id,
        toMapId: state.to_map_id,
        fromMapName: state.from_map_name,
        toMapName: state.to_map_name,
        startTime: state.start_time,
        endTime: state.end_time,
        totalSeconds: state.total_seconds,
        remainingSeconds: state.total_seconds
      }
    },

    /**
     * 更新剩余时间
     */
    updateRemainingTime(remainingSeconds) {
      this.movingState.remainingSeconds = remainingSeconds
    },

    /**
     * 清除移动状态
     */
    clearMovingState() {
      this.movingState = {
        isMoving: false,
        fromMapId: null,
        toMapId: null,
        fromMapName: '',
        toMapName: '',
        startTime: null,
        endTime: null,
        totalSeconds: 0,
        remainingSeconds: 0
      }
    },
    
    /**
     * 登出
     */
    logout(reason = null) {
      this.disconnectSocket()
      this.token = null
      this.player = null
      this.logoutReason = reason
      localStorage.removeItem('token')
      localStorage.removeItem('player')
    }
  }
})
