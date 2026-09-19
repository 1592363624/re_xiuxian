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
 * 中文大数单位表，每 4 个数量级一档（1万 / 1亿 / 1兆 / 1京 …）
 * 索引 0 对应 1e4，因此整数位数为 N 的数值落在下标 floor((N-1)/4) - 1 上
 */
const CN_NUMBER_UNITS = ['万', '亿', '兆', '京', '垓', '', '穰', '沟', '涧', '正', '载', '极']

/**
 * 把任意可识别的数值输入拆成 { sign, intPart, fracPart } 三段纯数字字符串
 *
 * 全程字符串处理，不经过 Number，因此后端下发的 BigInt 字符串
 * （exp / spirit_stones / honor / boss hp 等，见 server/models/player.js）不会丢精度。
 * 同时兼容科学计数法字符串（如 "1.23e+21"，Number 转字符串时产生的形式）。
 *
 * @returns {{sign: string, intPart: string, fracPart: string}|null} 无法识别时返回 null
 */
function splitNumberDigits(str) {
  let sign = ''
  if (str.startsWith('-')) {
    sign = '-'
    str = str.slice(1)
  } else if (str.startsWith('+')) {
    str = str.slice(1)
  }

  const sci = str.match(/^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/)
  if (sci) {
    // 移动小数点：目标位置 = 原小数点位置 + 指数
    const digits = sci[1] + (sci[2] || '')
    const pointPos = sci[1].length + Number(sci[3])
    if (pointPos <= 0) return { sign, intPart: '0', fracPart: '0'.repeat(-pointPos) + digits }
    if (pointPos >= digits.length) return { sign, intPart: digits.padEnd(pointPos, '0'), fracPart: '' }
    return { sign, intPart: digits.slice(0, pointPos), fracPart: digits.slice(pointPos) }
  }

  if (!/^\d+(\.\d+)?$/.test(str)) return null

  const dotIdx = str.indexOf('.')
  return dotIdx >= 0
    ? { sign, intPart: str.slice(0, dotIdx), fracPart: str.slice(dotIdx + 1) }
    : { sign, intPart: str, fracPart: '' }
}

/**
 * 格式化大数：超过阈值时改用中文单位，避免长数字撑破窄格子
 *
 * 修仙游戏后期数值轻易上到千万、亿级，而左侧状态栏只有 w-72（288px），
 * 千分位的 "1,212,387" 在 grid-cols-3 的属性格里会直接溢出。
 * 本函数把这类数值压成固定短串："121.2万"。
 *
 * 精度约定：
 *   - 保留 sigDigits 位有效数字（默认 4），四舍五入
 *   - 末尾无意义的 0 自动去掉：300000000 → "3亿"，不是 "3.000亿"
 *   - 未超过阈值（默认 1e4）时原样返回，因此输出里永远不需要千分位
 *   - BigInt 安全：全程字符串运算，1e30 级别也不会退化成近似值
 *
 * @param {number|string|bigint} num - 数值
 * @param {Object} [options]
 * @param {number} [options.sigDigits=4] - 有效数字位数
 * @returns {string} 如 "5872"、"12.35万"、"3亿"
 */
export function formatCompact(num, { sigDigits = 4 } = {}) {
  if (num === null || num === undefined || num === '') return '0'

  const str = (typeof num === 'bigint' ? num : String(num)).trim()
  const parts = splitNumberDigits(str)
  if (!parts) return '0'

  const { sign, fracPart } = parts
  const intPart = parts.intPart.replace(/^0+(?=\d)/, '')
  const digits = intPart.length

  // 未达压缩阈值：整数部分本身就不长，连同小数原样返回
  if (digits <= sigDigits) return sign + intPart + (fracPart ? '.' + fracPart : '')

  // 取前 sigDigits 位作尾数，按被丢弃的最高位四舍五入
  let mantissa = intPart.slice(0, sigDigits)
  if (intPart[sigDigits] >= '5') {
    mantissa = String(Number(mantissa) + 1)
  }
  // 进位可能让尾数多出一位（9999.6万 → 10000万），有效位数随之 +1
  const mantissaLen = mantissa.length
  const effectiveDigits = digits + (mantissaLen - sigDigits)

  // 中文计数每 4 位一档：档位数 = floor((有效位数-1)/4)，首档位数 = 余数 + 1
  const unitIndex = Math.floor((effectiveDigits - 1) / 4) - 1
  const intLen = ((effectiveDigits - 1) % 4) + 1

  if (unitIndex >= CN_NUMBER_UNITS.length) {
    // 超出单位表（1e48 以上），退化为最大单位
    return sign + mantissa + '0'.repeat(effectiveDigits - mantissaLen - 4 * CN_NUMBER_UNITS.length) + CN_NUMBER_UNITS[CN_NUMBER_UNITS.length - 1]
  }

  // 尾数按首档位数插小数点，不足位补 0
  let body
  if (intLen >= mantissaLen) {
    // 纯整数尾数：补的 0 是有效数位，不能当尾零削掉（1230万 ≠ 123万）
    body = mantissa + '0'.repeat(intLen - mantissaLen)
  } else {
    body = (mantissa.slice(0, intLen) + '.' + mantissa.slice(intLen)).replace(/0+$/, '').replace(/\.$/, '')
  }

  return sign + body + CN_NUMBER_UNITS[unitIndex]
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
