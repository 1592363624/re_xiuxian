/**
 * 玩家状态管理
 * 负责玩家数据的存储和基础操作
 * 业务逻辑已移至后端，前端只负责数据展示和 API 调用
 */
import { defineStore } from 'pinia'
import { getPlayer } from '../api/player'
import { getStatus as getSeclusionStatus, start as startSeclusionApi, end as endSeclusionApi, forceEnd as forceEndSeclusionApi } from '../api/seclusion'
import { getConfig as getSystemConfig } from '../api/system'
import { tryBreakthrough as tryBreakthroughApi } from '../api/breakthrough'
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
      // 初始化 Socket 连接（携带 JWT 供服务端鉴权）
      socketService.connect({ token, playerId: this.player?.id })
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

      // 监听 WebSocket 鉴权失败：服务端 JWT 校验失败时强制登出
      socketService.on('auth_error', (data) => {
        console.warn('[PlayerStore] 收到鉴权失败事件:', data)
        this.logout(data?.message || 'WebSocket 鉴权失败，请重新登录')
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
     * 重构后支持常规/深度闭关双模式，含进度、每日剩余次数、配置信息
     */
    async fetchSeclusionStatus() {
      if (!this.token) return null
      try {
        const res = await getSeclusionStatus()
        // 后端返回格式: { code: 200, data: { is_secluded, seclusion_mode, ... } }
        const data = res.data?.data || res.data
        if (data) {
             if (this.player) {
                 // 更新闭关相关状态（含模式）
                 this.player.is_secluded = data.is_secluded
                 this.player.seclusion_mode = data.seclusion_mode || 'normal'
                 this.player.seclusion_start_time = data.seclusion_start_time
                 this.player.seclusion_duration = data.seclusion_duration
                 this.player.seclusion_end_time = data.seclusion_end_time
                 // 同步更新 localStorage，确保数据一致性
                 localStorage.setItem('player', JSON.stringify(this.player))
             }
             // 缓存闭关配置信息，供前端展示与模式选择使用
             this.systemConfig.seclusion = {
                normal: data.normal_config,
                deep: data.deep_config,
                normal_remaining: data.normal_remaining,
                deep_remaining: data.deep_remaining,
                exp_rate: data.exp_rate,
                exp_gained: data.exp_gained,
                current_duration: data.current_duration,
                remaining_time: data.remaining_time,
                progress: data.progress
             }
             // 兼容旧字段
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
     * @param {string} mode - 闭关模式 normal|deep（默认 normal）
     * @param {number} duration - 期望闭关时长（秒），可选
     */
    async startSeclusion(mode = 'normal', duration) {
      if (!this.token) {
        console.warn('开始闭关失败: 未登录或token不存在')
        return
      }
      try {
        const res = await startSeclusionApi(mode, duration)
        // 立即更新本地状态，确保UI即时响应
        if (res.data && this.player) {
          const data = res.data.data || {}
          this.player.is_secluded = true
          this.player.seclusion_mode = data.seclusion_mode || mode
          this.player.seclusion_start_time = data.seclusion_start_time || new Date()
          this.player.seclusion_end_time = data.seclusion_end_time || null
          this.player.seclusion_duration = data.seclusion_duration || 0
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
     * 结束闭关（正常结算）
     * 深度闭关未达最短时长时按强行出关处理，损失 forced_penalty 比例收益
     */
    async endSeclusion() {
      if (!this.token) return
      try {
        const res = await endSeclusionApi()
        // 立即更新本地状态，确保UI即时响应
        if (res.data && this.player) {
          this.player.is_secluded = false
          this.player.seclusion_mode = 'normal'
          this.player.seclusion_start_time = null
          this.player.seclusion_end_time = null
          // 修复：后端返回的数据在 res.data.data.player 中
          this.player.exp = res.data.data?.player?.exp || this.player.exp
          this.player.last_seclusion_time = res.data.data?.player?.last_seclusion_time || new Date()
          localStorage.setItem('player', JSON.stringify(this.player))
        }
        return res.data
      } catch (error) {
        console.error('结束闭关失败:', error.response?.data || error.message || error)
        throw error
      }
    },

    /**
     * 强行出关（深度闭关专用快捷接口）
     * 逻辑等同 endSeclusion，仅作为语义上的快捷入口
     */
    async forceEndSeclusion() {
      if (!this.token) return
      try {
        const res = await forceEndSeclusionApi()
        if (res.data && this.player) {
          this.player.is_secluded = false
          this.player.seclusion_mode = 'normal'
          this.player.seclusion_start_time = null
          this.player.seclusion_end_time = null
          this.player.exp = res.data.data?.player?.exp || this.player.exp
          this.player.last_seclusion_time = res.data.data?.player?.last_seclusion_time || new Date()
          localStorage.setItem('player', JSON.stringify(this.player))
        }
        return res.data
      } catch (error) {
        console.error('强行出关失败:', error.response?.data || error.message || error)
        throw error
      }
    },

    /**
     * 尝试突破
     */
    async tryBreakthrough() {
      if (!this.token) return null
      try {
        // 修复：使用统一封装的 breakthrough API 替代动态 import，避免循环依赖警告
        const res = await tryBreakthroughApi()
        // 无论突破成功或失败，都需要刷新玩家数据（失败时后端会扣除修为），确保 UI 及时更新
        await this.fetchPlayer()
        return res.data
      } catch (error) {
        // 即使接口返回错误（如修为不足），也刷新数据以保持 UI 同步
        await this.fetchPlayer()
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
