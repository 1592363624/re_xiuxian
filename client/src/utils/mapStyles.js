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
 */
const mapTypeStyleMap = {
  country: { class: 'text-emerald-400', bg: 'bg-emerald-900/20', border: 'border-emerald-700/50' },
  sect: { class: 'text-sky-400', bg: 'bg-sky-900/20', border: 'border-sky-700/50' },
  mountain: { class: 'text-amber-400', bg: 'bg-amber-900/20', border: 'border-amber-700/50' },
  ocean: { class: 'text-cyan-400', bg: 'bg-cyan-900/20', border: 'border-cyan-700/50' },
  talent: { class: 'text-purple-400', bg: 'bg-purple-900/20', border: 'border-purple-700/50' },
  world: { class: 'text-rose-400', bg: 'bg-rose-900/20', border: 'border-rose-700/50' }
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
  10: { class: 'text-red-600 font-bold' },
  15: { class: 'text-red-700 font-bold' },
  20: { class: 'text-gray-600 font-bold' }
}

/**
 * 默认样式（未匹配到已知类型/等级时使用）
 */
const defaultMapTypeStyle = { class: 'text-stone-400', bg: 'bg-stone-800', border: 'border-stone-700' }
const defaultSafetyStyle = { class: 'text-stone-400' }

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
