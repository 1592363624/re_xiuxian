import { defineStore } from 'pinia'

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
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        ...log
      })
      // 保持日志数量限制
      if (this.logs.length > 200) this.logs.shift()
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
