import { defineStore } from 'pinia'
import axios from 'axios'
import { useAuthStore } from './auth'
import { usePlayerStore } from './player'

export const useSeclusionStore = defineStore('seclusion', {
  state: () => ({
    systemConfig: {}
  }),

  actions: {
    async fetchStatus() {
      const authStore = useAuthStore()
      const playerStore = usePlayerStore()
      if (!authStore.token) return null

      try {
        const res = await axios.get('/api/seclusion/status')
        if (res.data) {
          if (playerStore.player) {
            playerStore.player.is_secluded = res.data.is_secluded
            playerStore.player.seclusion_start_time = res.data.seclusion_start_time
            playerStore.player.seclusion_duration = res.data.seclusion_duration
          }
          this.systemConfig.cultivate_interval = res.data.cultivate_interval
          this.systemConfig.deep_seclusion_exp_rate = res.data.deep_seclusion_exp_rate
          this.systemConfig.deep_seclusion_interval = res.data.deep_seclusion_interval
          return res.data
        }
      } catch (error) {
        console.error('获取闭关状态失败:', error)
      }

      return null
    },

    async start(duration) {
      const authStore = useAuthStore()
      const playerStore = usePlayerStore()
      if (!authStore.token) return null

      const res = await axios.post('/api/seclusion/start', { duration })
      if (playerStore.player) {
        playerStore.player.is_secluded = true
        playerStore.player.seclusion_start_time = res.data.data.seclusion_start_time
        playerStore.player.seclusion_duration = res.data.data.seclusion_duration
      }
      return res.data
    },

    async end() {
      const authStore = useAuthStore()
      const playerStore = usePlayerStore()
      if (!authStore.token) return null

      const res = await axios.post('/api/seclusion/end')
      if (playerStore.player) {
        playerStore.player.is_secluded = false
        playerStore.player.seclusion_start_time = null
        playerStore.player.seclusion_duration = 0
        if (res.data.data.player) {
          playerStore.player.exp = res.data.data.player.exp
          if (res.data.data.player.last_seclusion_time) {
            playerStore.player.last_seclusion_time = res.data.data.player.last_seclusion_time
          }
        }
      }
      return res.data
    }
  }
})

