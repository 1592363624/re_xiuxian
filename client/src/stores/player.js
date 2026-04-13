import { defineStore } from 'pinia'
import axios from 'axios'
import { useAuthStore } from './auth'

export const usePlayerStore = defineStore('player', {
  state: () => ({
    player: JSON.parse(localStorage.getItem('player')) || null,
    saveStatus: 'idle', // 'idle' | 'saving' | 'success' | 'error'
    autoSaveInterval: null
  }),
  
  actions: {
    setPlayer(player) {
      this.player = player
      localStorage.setItem('player', JSON.stringify(player))
    },

    clear() {
      this.player = null
      localStorage.removeItem('player')
    },

    async fetchPlayer() {
      const authStore = useAuthStore()
      if (!authStore.token) return
      try {
        const res = await axios.get('/api/player/me')
        this.setPlayer(res.data.data)
      } catch (error) {
        if (error.response) {
          // 处理互踢逻辑
          if (error.response.data && error.response.data.code === 'SESSION_EXPIRED') {
             authStore.logout('您的账号已在其他设备登录，当前会话已失效')
             this.clear()
             return;
          }

          if (error.response.status === 401) {
            console.warn('登录凭证已过期，请重新登录')
            authStore.logout('登录已过期，请重新登录')
            this.clear()
            return
          } else if (error.response.status === 404) {
            console.warn('玩家数据不存在，请重新登录')
            authStore.logout('玩家数据不存在')
            this.clear()
            return
          }
        }
        console.error('获取玩家信息失败:', error)
      }
    },

    async savePlayer(retryCount = 0) {
      const authStore = useAuthStore()
      if (!this.player || !authStore.token) return
      
      // 仅在首次尝试时设置状态，避免重试时UI闪烁
      if (retryCount === 0) {
        this.saveStatus = 'saving'
      }

      try {
        await axios.put('/api/player/me', { nickname: this.player.nickname })
        
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
             authStore.logout('您的账号已在其他设备登录，当前会话已失效')
             this.clear()
             return;
          }

          if (error.response.status === 401 || error.response.status === 404) {
            console.warn('保存失败：认证无效或玩家不存在')
            this.saveStatus = 'error'
            authStore.logout('认证失败')
            this.clear()
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

    async startAutoSave() {
      if (this.autoSaveInterval) clearInterval(this.autoSaveInterval)

      let interval = 10000
      try {
        const res = await axios.get('/api/config/data/system')
        const value = res.data?.data?.settings?.auto_save_interval?.value
        if (typeof value === 'number') interval = value
      } catch (error) {
        console.warn('获取自动存档间隔失败，使用默认值:', error)
      }

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
  }
})
