/**
 * 地图样式映射工具
 *
 * 设计依据：参考 project-architecture-design skill 第六章"前后端分离规范"
 *   - 中文名（数据）由后端 game_balance.map_types / safety_levels 提供
 *   - Tailwind 样式（展示层关注点）保留在前端，避免样式耦合到后端配置
 *   - MapPanel.vue 与 FullMapList.vue 共用本工具，消除重复代码
 *
 * 用法：
 *   import { getMapTypeStyle, getSafetyStyle, buildMapTypeNameMap, buildSafetyLevelNameMap } from '@/utils/mapStyles'
 */

/**
 * 地图类型样式映射（仅 Tailwind 类名，不含中文名）
 * 中文名由后端配置提供，运行时通过 buildMapTypeNameMap 合并
 *
 * hex 是给 canvas 用的同一份颜色：大世界地图用 ctx.fillStyle 绘制，
 * 拿不到 Tailwind 类名。之前 DOM 一份类名、WorldMapPanel 里另抄一份十六进制，
 * 同一个"宗门"两种绿，改一边忘一边。现在两种表示并排声明，只有一个来源。
 */
const mapTypeStyleMap = {
  country: { class: 'text-emerald-400', bg: 'bg-emerald-900/20', border: 'border-emerald-700/50', hex: '#34d399' },
  sect: { class: 'text-sky-400', bg: 'bg-sky-900/20', border: 'border-sky-700/50', hex: '#38bdf8' },
  mountain: { class: 'text-amber-400', bg: 'bg-amber-900/20', border: 'border-amber-700/50', hex: '#fbbf24' },
  ocean: { class: 'text-cyan-400', bg: 'bg-cyan-900/20', border: 'border-cyan-700/50', hex: '#22d3ee' },
  talent: { class: 'text-purple-400', bg: 'bg-purple-900/20', border: 'border-purple-700/50', hex: '#c084fc' },
  world: { class: 'text-rose-400', bg: 'bg-rose-900/20', border: 'border-rose-700/50', hex: '#fb7185' }
}

/**
 * 危险等级样式映射（仅 Tailwind 类名，不含中文名）
 * key 为数字字符串，与后端 safety_levels 配置对齐
 */
const safetyLevelStyleMap = {
  1: { class: 'text-emerald-500' },
  2: { class: 'text-yellow-500' },
  3: { class: 'text-orange-500' },
  6: { class: 'text-rose-500' },
  8: { class: 'text-purple-500 font-bold' },
  // 危险等级越高，字要越亮才对。原来是 red-600 → red-700 → gray-600，
  // 越危险越暗：等级 20 的禁地在 #0c0a09 上对比度只有约 2.5:1，
  // 玩家读到的是"这块地图没渲染出来"，而不是"这里会死"。
  10: { class: 'text-red-500 font-bold' },
  15: { class: 'text-red-400 font-bold' },
  20: { class: 'text-rose-300 font-bold' },
}

/**
 * 默认样式（未匹配到已知类型/等级时使用）
 * 走令牌而不是 stone-*，这样主题一改，兜底色也跟着走。
 */
const defaultMapTypeStyle = { class: 'text-fg-muted', bg: 'bg-surface-hover', border: 'border-line' }
const defaultSafetyStyle = { class: 'text-fg-muted' }

/**
 * 构建地图类型名称映射（合并后端中文名 + 前端样式）
 * @param typeNames - 后端 map_types 配置（如 { country: '凡人国度', sect: '宗门' }）
 * @returns 合并后的映射，如 { country: { name: '凡人国度', class, bg, border }, ... }
 */
export const buildMapTypeNameMap = (typeNames = {}) => {
  const result = {}
  // 遍历后端配置，确保所有后端定义的类型都有中文名
  Object.keys(typeNames).forEach(type => {
    result[type] = {
      name: typeNames[type],
      ...(mapTypeStyleMap[type] || defaultMapTypeStyle)
    }
  })
  // 兜底：前端样式表中有但后端配置缺失的类型，使用 type 作为 name
  Object.keys(mapTypeStyleMap).forEach(type => {
    if (!result[type]) {
      result[type] = { name: type, ...mapTypeStyleMap[type] }
    }
  })
  return result
}

/**
 * 构建危险等级名称映射（合并后端中文名 + 前端样式）
 * @param levelNames - 后端 safety_levels 配置（如 { '1': '安全', '2': '低危' }）
 * @returns 合并后的映射，如 { 1: { name: '安全', class }, ... }
 */
export const buildSafetyLevelNameMap = (levelNames = {}) => {
  const result = {}
  // 遍历后端配置
  Object.keys(levelNames).forEach(key => {
    const numKey = Number(key)
    result[numKey] = {
      name: levelNames[key],
      ...(safetyLevelStyleMap[numKey] || defaultSafetyStyle)
    }
  })
  // 兜底：前端样式表中有但后端配置缺失的等级
  Object.keys(safetyLevelStyleMap).forEach(key => {
    const numKey = Number(key)
    if (!result[numKey]) {
      result[numKey] = { name: String(key), ...safetyLevelStyleMap[key] }
    }
  })
  return result
}

/**
 * 获取地图类型样式（向后兼容：未传入 nameMap 时仅返回样式）
 * @param type - 地图类型 key（如 country/sect/mountain）
 * @param nameMap - 由 buildMapTypeNameMap 构建的合并映射；为空时返回纯样式
 */
export const getMapTypeStyle = (type, nameMap = null) => {
  if (nameMap && nameMap[type]) {
    return nameMap[type]
  }
  return mapTypeStyleMap[type] || { name: type, ...defaultMapTypeStyle }
}

/**
 * 获取危险等级样式
 * @param level - 危险等级数字（如 1/2/3/6/8/10/15/20）
 * @param levelMap - 由 buildSafetyLevelNameMap 构建的合并映射；为空时返回纯样式
 */
export const getSafetyStyle = (level, levelMap = null) => {
  if (levelMap && levelMap[level]) {
    return levelMap[level]
  }
  return safetyLevelStyleMap[level] || { name: level, ...defaultSafetyStyle }
}

/**
 * 取地图类型的 canvas 绘制色（与 DOM 类名同源，见 mapTypeStyleMap 注释）
 */
export const getMapTypeColor = (type) => mapTypeStyleMap[type]?.hex || '#a8a29e'

/**
 * 把设计令牌读成 canvas 能用的颜色串。
 *
 * tokens.css 里 --surface-canvas 这类值是 RGB 通道三元组（"12 10 9"），
 * 这里拼成 canvas fillStyle 认得的形式。这样画布跟着主题走：
 * 换主题只改 tokens.css，地图底色和文字色不用另外再找一遍硬编码。
 *
 * 地图每帧都在重绘，getComputedStyle 不能每次都调，所以按令牌名缓存；
 * 主题若是运行时可切换的，切换时调一次 resetThemeColors()。
 *
 * @param name  令牌名，不带 -- 前缀，如 'fg-muted'
 * @param alpha 可选透明度 0..1
 */
const themeColorCache = new Map()
export const themeColor = (name, alpha) => {
  const key = alpha === undefined ? name : `${name}/${alpha}`
  const hit = themeColorCache.get(key)
  if (hit) return hit
  const channels = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
  const rgb = channels ? channels.split(/\s+/) : null
  // 用逗号形式而不是 rgb(r g b / a)：canvas 的颜色解析在老 Safari 上不吃空格语法
  const out = rgb
    ? (alpha === undefined ? `rgb(${rgb.join(',')})` : `rgba(${rgb.join(',')},${alpha})`)
    : 'transparent'
  themeColorCache.set(key, out)
  return out
}

export const resetThemeColors = () => themeColorCache.clear()

/**
 * 大世界地图 canvas 的强调色。
 *
 * 中性色（背景/节点/文字）一律走 themeColor() 取令牌，画布因此跟着主题走；
 * 只有这几支是 canvas 独有的——同屏玩家标记、选中态描边、"我自己"的鎏金点——
 * DOM 侧没有对应的 Tailwind 类，放进令牌反而是假抽象，就在这里单列一份。
 */
export const MAP_CANVAS_ACCENT = {
  player: '#38bdf8',
  playerActive: '#7dd3fc',
  playerRing: '#0ea5e9',
  playerNameActive: '#e0f2fe',
  self: '#fbbf24',
  selfRing: '#f59e0b',
}
