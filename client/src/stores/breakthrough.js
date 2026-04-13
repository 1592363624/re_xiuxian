import { defineStore } from 'pinia'
import axios from 'axios'
import { useAuthStore } from './auth'
import { usePlayerStore } from './player'

export const useBreakthroughStore = defineStore('breakthrough', {
  actions: {
    async tryBreakthrough() {
      const authStore = useAuthStore()
      const playerStore = usePlayerStore()
      if (!authStore.token) return null

      const res = await axios.post('/api/breakthrough/try')
      try {
        await playerStore.fetchPlayer()
      } catch (e) {
        console.warn('刷新玩家数据失败:', e)
      }
      return res.data
    }
  }
})

