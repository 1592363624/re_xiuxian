import { defineStore } from 'pinia'
import { UI_CONFIG } from '../config'
import { formatTimeOfDay } from '../utils/format'
import { apiErrorMessage } from '../utils/apiError'

let toastSeq = 0

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
      // id 必须唯一。原先用 Date.now()，而拦截器和组件的 catch 常在
      // 同一毫秒各弹一条，两条 toast 就拿到同一个 id：
      // 列表按 id 做 key 会错乱复用节点，点掉一条会收起另一条。
      // 旁边 addLog 早就用了 Date.now() + Math.random()，这里补齐。
      const id = `${Date.now()}-${++toastSeq}`
      this.toasts.push({ id, message, type, duration })

      if (duration > 0) {
        setTimeout(() => {
          this.removeToast(id)
        }, duration)
      }
    },

    /**
     * 接口失败的统一播报口径
     *
     * 组件的 catch 一律调这个，不要再各自 showToast(err.message + '失败')：
     *   - 文案取后端给的规范字段 message（见 utils/apiError）
     *   - 传输层/401/403/404/500 已由 api 拦截器播报过（打了 __uiNotified），
     *     这里不再重复，否则玩家同屏看到两条互相矛盾的红字
     *   - console 始终记一条，排查用的原文不被吞掉
     *
     * @returns {string} 实际使用的文案，方便调用方写进日志
     */
    showApiError(err, fallback = '操作失败', type = 'error') {
      const message = apiErrorMessage(err, fallback)
      console.error(`${fallback}:`, err)
      if (!err?.__uiNotified) this.showToast(message, type)
      return message
    },

    removeToast(id) {
      const index = this.toasts.findIndex(t => t.id === id)
      if (index !== -1) {
        this.toasts.splice(index, 1)
      }
    }
  }
})
