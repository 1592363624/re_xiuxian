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
 *
 * 修复 B11（2026-07-19）：
 *   旧实现 `Number(num).toLocaleString('zh-CN')` 对大数会精度丢失。
 *   后端 BigInt 字段（exp/spirit_stones/honor 等）序列化为字符串后，
 *   `Number("99999999999999999")` = `100000000000000000`（精度损失）。
 *   高境界玩家修为超过 2^53 时显示数值错误。
 *
 *   新实现用字符串处理千分位，完全避免 Number 转换，保留任意精度。
 *   支持负数、BigInt 字符串、普通数字、科学计数法字符串。
 *
 * @param {number|string|bigint} num - 数字或数字字符串
 * @returns {string} 格式化后的数字字符串（千分位分隔）
 */
export function formatNumber(num) {
  if (num === null || num === undefined || num === '') return '0'

  // 统一转字符串，避免 Number 精度丢失
  let str = typeof num === 'bigint' ? num.toString() : String(num).trim()
  if (!str) return '0'

  // 处理科学计数法（如 1.23e+21）：转 BigInt 后再格式化
  // 注意：仅对整数部分处理，浮点数保留原 toLocaleString 行为
  const isSci = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(str)
  if (isSci) {
    // 科学计数法通常对应大整数，用 BigInt 解析（截断小数）
    try {
      const bi = BigInt(Math.trunc(Number(str)))
      str = bi.toString()
    } catch (e) {
      // 解析失败则保留原值
    }
  }

  // 处理负号
  let sign = ''
  if (str.startsWith('-')) {
    sign = '-'
    str = str.slice(1)
  } else if (str.startsWith('+')) {
    str = str.slice(1)
  }

  // 拆分整数与小数部分
  const dotIdx = str.indexOf('.')
  let intPart = dotIdx >= 0 ? str.slice(0, dotIdx) : str
  const fracPart = dotIdx >= 0 ? str.slice(dotIdx) : ''

  // 整数部分加千分位（仅对纯数字字符串生效；含非数字字符则原样返回）
  if (!/^\d+$/.test(intPart)) {
    // 非纯数字（如 undefined 字符串），尝试 toLocaleString 兜底
    const fallbackNum = Number(num)
    return isNaN(fallbackNum) ? '0' : fallbackNum.toLocaleString('zh-CN')
  }

  // 千分位正则替换
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  return sign + intPart + fracPart
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
