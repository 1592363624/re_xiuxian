import { defineStore } from 'pinia'
import axios from 'axios'

export const usePlayerStore = defineStore('player', {
  state: () => ({
    token: localStorage.getItem('token') || null,
    player: JSON.parse(localStorage.getItem('player')) || null,
    saveStatus: 'idle', // 'idle' | 'saving' | 'success' | 'error'
    autoSaveInterval: null
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
        this.setPlayer(res.data)
      } catch (error) {
        if (error.response && error.response.status === 401) {
          console.warn('登录凭证已过期，请重新登录')
          this.logout()
        } else {
          console.error('获取玩家信息失败:', error)
        }
      }
    },

    async savePlayer() {
      if (!this.player || !this.token) return
      
      this.saveStatus = 'saving'
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
        console.error('自动保存失败:', error)
        this.saveStatus = 'error'
        // 出错后保留错误状态一段时间
        setTimeout(() => {
          if (this.saveStatus === 'error') {
            this.saveStatus = 'idle'
          }
        }, 5000)
      }
    },

    startAutoSave() {
      if (this.autoSaveInterval) clearInterval(this.autoSaveInterval)
      // 30秒自动保存一次
      this.autoSaveInterval = setInterval(() => {
        this.savePlayer()
      }, 30000)
    },

    stopAutoSave() {
      if (this.autoSaveInterval) {
        clearInterval(this.autoSaveInterval)
        this.autoSaveInterval = null
      }
    },
    
    logout() {
      this.stopAutoSave()
      this.token = null
      this.player = null
      localStorage.removeItem('token')
      localStorage.removeItem('player')
      delete axios.defaults.headers.common['Authorization']
    }
  }
})
