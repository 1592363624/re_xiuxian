import { defineStore } from 'pinia'
import axios from 'axios'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('token') || null,
    logoutReason: null
  }),

  actions: {
    setToken(token) {
      this.token = token
      localStorage.setItem('token', token)
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`
    },

    clearToken() {
      this.token = null
      localStorage.removeItem('token')
      delete axios.defaults.headers.common['Authorization']
    },

    logout(reason = null) {
      this.logoutReason = reason
      this.clearToken()
      localStorage.removeItem('player')
    }
  }
})

