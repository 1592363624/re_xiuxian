import { defineStore } from 'pinia'
import { UI_CONFIG } from '../config'
import { formatTimeOfDay } from '../utils/format'
import { apiErrorMessage } from '../utils/apiError'

let toastSeq = 0

/* ─────────────── 日志留档 ───────────────
 *
 * 文游的主界面就是日志栏。以前它只活在内存里：F5 一下、或玩家切出去回来看一眼，
 * 整栏字就没了，只剩一句硬编码的"欢迎来到凡人修仙传的世界"。
 * 而面板开关是有 hash 路由的（刷新后停在原面板），日志却没有，
 * 于是"刷新后界面还在、故事没了"，玩家不知道自己上一步练成了什么。
 *
 * 这里按玩家分栏存进 localStorage，只保留最近 maxLogs 条。
 * 写盘做节流：一次战斗能刷出几十条，逐条 JSON.stringify 会把主线程吃掉。
 */
const LOG_STORAGE_PREFIX = 'game_logs_v1:'
const LOG_DIVIDER = '── 以上是上次登录的记录，以下为新的一天 ──'

/** @returns {string} 当前玩家的日志键；未登录时用匿名键，登录后第一次写入会自然迁走 */
function logStorageKey() {
  try {
    const raw = localStorage.getItem('player')
    const id = raw ? (JSON.parse(raw)?.id ?? null) : null
    return `${LOG_STORAGE_PREFIX}${id ?? 'anon'}`
  } catch {
    return `${LOG_STORAGE_PREFIX}anon`
  }
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

/** 读回上次会话的日志；解析失败就当没有，不能让玩家开不了游戏 */
function restoreLogs() {
  try {
    const raw = localStorage.getItem(logStorageKey())
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const kept = parsed
      .filter(l => l && typeof l.content === 'string' && l.content)
      .slice(-UI_CONFIG.maxLogs)
      .map(l => ({ ...l, restored: true }))
    if (!kept.length) return []
    // 隔了一天以上才补分隔线：同一天内刷新，时间戳本身就接着，不需要多余的一行字
    const newest = kept[kept.length - 1]
    const then = new Date(Number(newest.at) || NaN)
    const now = new Date()
    if (!Number.isNaN(then.getTime()) && !isSameLocalDay(then, now)) {
      kept.push({
        id: `divider-${now.getTime()}`,
        time: formatTimeOfDay(now),
        type: 'system',
        content: LOG_DIVIDER,
        divider: true,
      })
    }
    return kept
  } catch {
    return []
  }
}

let saveTimer = null
function schedulePersist(logs) {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(logStorageKey(), JSON.stringify(logs.slice(-UI_CONFIG.maxLogs)))
    } catch {
      // 配额满了就退化成只留最近一半，别把异常抛给玩家
      try { localStorage.setItem(logStorageKey(), JSON.stringify(logs.slice(-Math.ceil(UI_CONFIG.maxLogs / 2)))) } catch {}
    }
  }, 500)
}

export const useUIStore = defineStore('ui', {
  state: () => ({
    toasts: [], // { id, type, message, duration }
    modals: [],  // Stack of active modals if needed, but for now we might just use local state for modals
    logs: restoreLogs() // 全局游戏日志（跨刷新留档）
  }),

  actions: {
    addLog(log) {
      const now = new Date()
      this.logs.push({
        id: Date.now() + Math.random(),
        time: formatTimeOfDay(now),
        at: now.getTime(),
        ...log
      })
      // 日志上限从配置读取，避免硬编码
      if (this.logs.length > UI_CONFIG.maxLogs) this.logs.shift()
      schedulePersist(this.logs)
    },

    /** 登出时清空：换号登录不该看见上一个号的修仙史 */
    clearLogs() {
      this.logs = []
      try { localStorage.removeItem(logStorageKey()) } catch {}
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
