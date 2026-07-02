import { defineStore } from 'pinia'
import { UI_CONFIG } from '../config'
import { formatTimeOfDay } from '../utils/format'

export const useUIStore = defineStore('ui', {
  state: () => ({
    toasts: [], // { id, type, message, duration }
    modals: [],  // Stack of active modals if needed, but for now we might just use local state for modals
    logs: [] // 全局游戏日志
  }),

  actions: {
    addLog(log) {
      this.logs.push({
        id: Date.now() + Math.random(),
        time: formatTimeOfDay(new Date()),
        ...log
      })
      // 日志上限从配置读取，避免硬编码
      if (this.logs.length > UI_CONFIG.maxLogs) this.logs.shift()
    },

    showToast(message, type = 'info', duration = 3000) {
      const id = Date.now()
      this.toasts.push({ id, message, type, duration })

      if (duration > 0) {
        setTimeout(() => {
          this.removeToast(id)
        }, duration)
      }
    },

    removeToast(id) {
      const index = this.toasts.findIndex(t => t.id === id)
      if (index !== -1) {
        this.toasts.splice(index, 1)
      }
    }
  }
})
