import { defineStore } from 'pinia'
import axios from 'axios'
import { useUIStore } from './ui'

export const usePlayerStore = defineStore('player', {
  state: () => ({
    token: localStorage.getItem('token') || null,
    player: JSON.parse(localStorage.getItem('player')) || null,
    saveStatus: 'idle', // 'idle' | 'saving' | 'success' | 'error'
    autoSaveInterval: null,
    logoutReason: null,
    systemConfig: {}
  }),
  
  actions: {
    setToken(token) {
      this.token = token
      localStorage.setItem('token', token)
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`
    },
    
    setPlayer(player) {
      this.player = player
      localStorage.setItem('player', JSON.stringify(player))
    },

    async fetchPlayer() {
      if (!this.token) return
      try {
        const res = await axios.get('/api/player/me')
        this.setPlayer(res.data.data)
      } catch (error) {
        if (error.response) {
          // 处理互踢逻辑
          if (error.response.data && error.response.data.code === 'SESSION_EXPIRED') {
             this.logout('您的账号已在其他设备登录，当前会话已失效');
             return;
          }

          if (error.response.status === 401) {
            console.warn('登录凭证已过期，请重新登录')
            this.logout('登录已过期，请重新登录')
            return
          } else if (error.response.status === 404) {
            console.warn('玩家数据不存在，请重新登录')
            this.logout('玩家数据不存在')
            return
          }
        }
        console.error('获取玩家信息失败:', error)
      }
    },

    async fetchSeclusionStatus() {
      if (!this.token) return
      try {
        const res = await axios.get('/api/seclusion/status')
        if (res.data) {
             // If we have player data, update it
             if (this.player) {
                 this.player.is_secluded = res.data.is_secluded
                 this.player.seclusion_start_time = res.data.seclusion_start_time
                 this.player.seclusion_duration = res.data.seclusion_duration
             }
             return res.data // Return full data including rate
        }
      } catch (error) {
        console.error('获取闭关状态失败:', error)
      }
      return null
    },

    async startSeclusion(duration) {
      if (!this.token) return
      try {
        const res = await axios.post('/api/seclusion/start', { duration })
        if (this.player) {
          this.player.is_secluded = true
          this.player.seclusion_start_time = res.data.data.seclusion_start_time
          this.player.seclusion_duration = res.data.data.seclusion_duration
        }
        return res.data
      } catch (error) {
        console.error('开始闭关失败:', error)
        throw error
      }
    },

    async endSeclusion() {
      if (!this.token) return
      try {
        const res = await axios.post('/api/seclusion/end')
        if (this.player) {
            this.player.is_secluded = false
            this.player.seclusion_start_time = null
            this.player.seclusion_duration = 0
            // Update other stats if returned
            if (res.data.data.player) {
                this.player.exp = res.data.data.player.exp
                if (res.data.data.player.last_seclusion_time) {
                    this.player.last_seclusion_time = res.data.data.player.last_seclusion_time
                }
            }
        }
        return res.data
      } catch (error) {
        console.error('结束闭关失败:', error)
        throw error
      }
    },

    async tryBreakthrough() {
      if (!this.token) return null
      const res = await axios.post('/api/breakthrough/try')
      try {
        await this.fetchPlayer()
      } catch (e) {
        console.warn('刷新玩家数据失败:', e)
      }
      return res.data
    },

    async savePlayer(retryCount = 0) {
      if (!this.player || !this.token) return
      
      // 仅在首次尝试时设置状态，避免重试时UI闪烁
      if (retryCount === 0) {
        this.saveStatus = 'saving'
      }

      try {
        await axios.put('/api/player/me', this.player)
        
        this.saveStatus = 'success'
        // 3秒后自动恢复为空闲状态
        setTimeout(() => {
          if (this.saveStatus === 'success') {
            this.saveStatus = 'idle'
          }
        }, 3000)
      } catch (error) {
        if (error.response) {
          // 处理互踢逻辑
          if (error.response.data && error.response.data.code === 'SESSION_EXPIRED') {
             this.logout('您的账号已在其他设备登录，当前会话已失效');
             return;
          }

          if (error.response.status === 401 || error.response.status === 404) {
            console.warn('保存失败：认证无效或玩家不存在')
            this.saveStatus = 'error'
            this.logout('认证失败')
            return
          }
        }

        console.error(`自动保存失败 (尝试 ${retryCount + 1}/3):`, error)
        
        // 重试逻辑：最多重试2次（共3次请求）
        if (retryCount < 2) {
          // 指数退避：1s, 2s
          const delay = 1000 * Math.pow(2, retryCount)
          await new Promise(resolve => setTimeout(resolve, delay))
          return this.savePlayer(retryCount + 1)
        }

        this.saveStatus = 'error'
        // 出错后保留错误状态一段时间
        setTimeout(() => {
          if (this.saveStatus === 'error') {
            this.saveStatus = 'idle'
          }
        }, 5000)
      }
    },

    async fetchSystemConfig() {
      if (!this.token) return;
      try {
        const res = await axios.get('/api/system/config');
        this.systemConfig = res.data;
      } catch (error) {
        console.warn('获取系统配置失败，使用默认值:', error);
      }
    },

    async startAutoSave() {
      if (this.autoSaveInterval) clearInterval(this.autoSaveInterval)
      
      // 获取配置，优先使用配置的间隔
      if (Object.keys(this.systemConfig).length === 0) {
        await this.fetchSystemConfig();
      }
      
      const interval = this.systemConfig.auto_save_interval || 10000;
      console.log(`启动自动存档，间隔: ${interval}ms`);

      this.autoSaveInterval = setInterval(() => {
        this.savePlayer()
      }, interval)
    },

    stopAutoSave() {
      if (this.autoSaveInterval) {
        clearInterval(this.autoSaveInterval)
        this.autoSaveInterval = null
      }
    },
    
    logout(reason = null) {
      this.stopAutoSave()
      this.token = null
      this.player = null
      this.logoutReason = reason // 记录登出原因供UI展示
      localStorage.removeItem('token')
      localStorage.removeItem('player')
      delete axios.defaults.headers.common['Authorization']
    }
  }
})
