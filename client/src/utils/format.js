/**
 * 前端通用格式化工具函数
 * 抽取自 SeclusionOverlay.vue、PlayerStatus.vue、CombatPanel.vue 中重复实现的时间/数字格式化
 */

/**
 * 格式化秒数为人类可读字符串
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时间字符串（如 "5分钟"、"2小时30分钟"）
 */
export function formatTime(seconds) {
  if (seconds < 60) return `${seconds}秒`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}分钟`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  if (hours < 24) return `${hours}小时${remainingMins}分钟`
  const days = Math.floor(hours / 24)
  return `${days}天${hours % 24}小时`
}

/**
 * 格式化时长（基于毫秒）
 * @param {number} ms - 毫秒数
 * @returns {string} 格式化后的时长字符串
 */
export function formatDuration(ms) {
  return formatTime(Math.floor(ms / 1000))
}

/**
 * 格式化数字（千分位分隔）
 * @param {number|string} num - 数字
 * @returns {string} 格式化后的数字字符串
 */
export function formatNumber(num) {
  if (num === null || num === undefined) return '0'
  const n = Number(num)
  if (isNaN(n)) return '0'
  return n.toLocaleString('zh-CN')
}

/**
 * 格式化时间为 HH:MM:SS
 * @param {Date|number|string} time - 时间对象/时间戳/时间字符串
 * @returns {string} 格式化后的时间字符串
 */
export function formatTimeOfDay(time) {
  const date = new Date(time)
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}
