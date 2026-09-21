/**
 * 北京时间（UTC+8）格式化工具
 *
 * 为什么不直接用 `toLocaleString('zh-CN')`：
 *   它跟随**运行环境**的时区。后端/无头浏览器/海外机器常为 UTC，
 *   同一条数据在不同机器上会显示成相差 8 小时的两个时间，
 *   排查线上问题时无法与数据库、日志对齐。
 *   本模块固定按 UTC+8 计算，保证全项目展示口径一致。
 *
 * 实现方式：把时间戳整体加 8 小时后，用 `getUTC*` 系列读取"墙上时间"字段，
 * 不依赖 `Intl` 的时区数据库（老浏览器/精简容器里可能缺失），也不受系统时区影响。
 */

/** 北京时间相对 UTC 的偏移（毫秒） */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 带时区标记的字符串（如 2026-09-21T15:42:11Z、+08:00） */
const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i
/** 无时区标记的日期时间（如 2026-09-21 15:42:11 / 2026-09-21T15:42:11） */
const NO_ZONE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/
/** 纯日期（如 2026-09-21） */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 把任意时间输入解析为 Date
 *
 * 特殊处理两类"无时区"字符串，按**北京时间**解读：
 *   - "2026-09-21"          → 北京时间当天 00:00
 *   - "2026-09-21 15:42:11" → 北京时间该时刻（MySQL DATETIME 常见形态）
 * 若不处理，`new Date()` 会按浏览器本地时区解读，导致整体偏移。
 *
 * @param {Date|number|string|null|undefined} value - 时间输入
 * @returns {Date|null} 解析失败返回 null
 */
export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value

  if (typeof value === 'number') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }

  const str = String(value).trim()
  if (!str) return null

  if (DATE_ONLY_RE.test(str)) {
    const d = new Date(`${str}T00:00:00+08:00`)
    return isNaN(d.getTime()) ? null : d
  }

  if (!HAS_ZONE_RE.test(str) && NO_ZONE_DATETIME_RE.test(str)) {
    const d = new Date(str.replace(' ', 'T') + '+08:00')
    return isNaN(d.getTime()) ? null : d
  }

  const d = new Date(str)
  return isNaN(d.getTime()) ? null : d
}

/** 两位补零 */
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 取得"北京时间的墙上时间"日期对象
 *
 * 返回值是平移后的 Date：请始终用 getUTC* 读取字段（见下面的 formatBeijing）。
 * 之所以不提供本地 getter，是因为本地 getter 又会受系统时区影响。
 *
 * @param {Date|number|string} value - 时间输入
 * @returns {Date|null}
 */
export function toBeijingDate(value) {
  const parsed = parseTime(value)
  if (!parsed) return null
  return new Date(parsed.getTime() + BEIJING_OFFSET_MS)
}

/**
 * 格式化为北京时间字符串（默认 `YYYY-MM-DD HH:mm:ss`）
 *
 * @param {Date|number|string} value - 时间输入
 * @param {Object} [options]
 * @param {boolean} [options.seconds=true] - 是否输出秒
 * @param {boolean} [options.showDate=true] - 是否输出日期段
 * @param {boolean} [options.showTime=true] - 是否输出时间段
 * @param {'full'|'short'} [options.dateStyle='full'] - full: YYYY-MM-DD；short: MM-DD（列表紧凑展示）
 * @param {string}  [options.fallback=''] - 解析失败时的占位文本
 * @returns {string} 例："2026-09-21 23:42:11" / "2026-09-21" / "09-21 23:42"
 */
export function formatBeijing(value, options = {}) {
  const {
    seconds = true,
    showDate = true,
    showTime = true,
    dateStyle = 'full',
    fallback = ''
  } = options

  const d = toBeijingDate(value)
  if (!d) return fallback

  const datePart = dateStyle === 'short'
    ? `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    : `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  const timePart = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` + (seconds ? `:${pad2(d.getUTCSeconds())}` : '')

  if (showDate && showTime) return `${datePart} ${timePart}`
  if (showDate) return datePart
  if (showTime) return timePart
  return ''
}

/**
 * 仅日期：`YYYY-MM-DD`
 * @param {Date|number|string} value - 时间输入
 * @param {string} [fallback=''] - 解析失败占位
 * @returns {string}
 */
export function formatBeijingDate(value, fallback = '') {
  return formatBeijing(value, { showTime: false, fallback })
}

/**
 * 仅时刻：默认 `HH:mm`，`seconds: true` 时输出 `HH:mm:ss`
 * @param {Date|number|string} value - 时间输入
 * @param {Object} [options]
 * @param {boolean} [options.seconds=false] - 是否输出秒
 * @param {string}  [options.fallback=''] - 解析失败占位
 * @returns {string}
 */
export function formatBeijingClock(value, options = {}) {
  const { seconds = false, fallback = '' } = options
  return formatBeijing(value, { showDate: false, seconds, fallback })
}

/**
 * 当前北京时间字符串
 * @param {Object} [options] - 同 formatBeijing
 * @returns {string}
 */
export function nowBeijing(options = {}) {
  return formatBeijing(new Date(), options)
}
