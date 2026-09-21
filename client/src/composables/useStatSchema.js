/**
 * 属性 / 物品效果词表单例：拉取 GET /api/attribute/panel，把服务端属性注册表
 * （基础定义 + 已启用资料片）变成前端可用的标签、后缀与显示位置。
 *
 * 为什么要有这个文件：给一件武器加一个新属性，过去要同时改
 *   InventoryPanel 的 attrNameMap、TechniquePanel 的 labels、
 *   PlayerStatus 的 6 个属性格、api/attribute.ts 的字面量联合类型。
 * 现在这些位置一律从这份 schema 推导 —— 加属性只改数据，前端不动。
 *
 * 状态放在模块作用域而不是 setup 里：整个会话只有一份词表，
 * 每个面板各自请求一次既浪费，也会造成"两个面板对同一个属性叫法不一样"。
 */
import { computed, ref } from 'vue'
import { getPanelSchema } from '../api/attribute'
import { formatCompact, formatNumber } from '../utils/format'

const statEntries = ref([])
const effectEntries = ref([])
const loaded = ref(false)
let inflight = null

/**
 * 接口还没回来（或挂了）时的兜底：至少让左栏显示四大战斗属性，
 * 而不是整块空白。键名与 stat_definitions.json 保持一致。
 */
const FALLBACK_SIDEBAR = [
  { key: 'atk', label: '攻击' },
  { key: 'def', label: '防御' },
  { key: 'speed', label: '速度' },
  { key: 'sense', label: '神识' }
]

/** 请求失败不该弹 toast 打断玩家：词表缺失只是标签退化，静默降级即可 */
function load({ force = false } = {}) {
  if (inflight) return inflight
  if (loaded.value && !force) return Promise.resolve()
  inflight = getPanelSchema()
    .then((res) => {
      statEntries.value = res.data?.data?.stats || []
      effectEntries.value = res.data?.data?.effects || []
      loaded.value = true
    })
    .catch((error) => {
      console.warn('[useStatSchema] 属性面板定义获取失败，使用兜底标签:', error?.message || error)
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useStatSchema() {
  // 谁第一次用到谁触发拉取，调用方不必各自记得在 onMounted 里 load
  load()

  /** 规范键 + 全部别名 → 属性字段定义 */
  const statsByKey = computed(() => {
    const map = {}
    for (const entry of statEntries.value) {
      map[entry.key] = entry
      for (const alias of entry.aliases || []) {
        // 别名不覆盖规范键：crit_rate 本身存在时，crit 只作为补充入口
        if (!map[alias]) map[alias] = entry
      }
    }
    return map
  })

  /** 非属性类物品效果（气血恢复 / 灵石 / 突破加成…）→ 展示定义 */
  const effectsByKey = computed(() => {
    const map = {}
    for (const entry of effectEntries.value) map[entry.id] = entry
    return map
  })

  /** 该键是否是一个已注册的属性 */
  const isStat = (key) => Boolean(statsByKey.value[key])

  const definition = (key) => statsByKey.value[key] || null

  /** 展示名：先查属性（含别名），再查物品效果词表；都没有返回空串，由调用方兜底 */
  const labelOf = (key) => {
    const stat = statsByKey.value[key]
    if (stat) return stat.shortLabel || stat.label
    return effectsByKey.value[key]?.label || ''
  }

  const suffixOf = (key) => statsByKey.value[key]?.suffix || ''

  /**
   * 一条加成文案，如「攻击+12」「暴击率+5%」「突破加成+5.0%」。
   * 百分比属性存的是"百分点"，倍率型效果（format: ratio_pct）存的是 0.05，按定义换算。
   * 未注册的键原样输出键名 —— 宁可显示得丑，也不要把配错的效果藏起来。
   */
  const formatBonus = (key, value) => {
    const num = Number(value) || 0
    const sign = num > 0 ? '+' : ''
    const stat = statsByKey.value[key]
    if (stat) return `${stat.shortLabel || stat.label}${sign}${num}${stat.suffix || ''}`
    const effect = effectsByKey.value[key]
    if (!effect) return `${key}${sign}${num}`
    const amount = effect.format === 'ratio_pct' ? `${(num * 100).toFixed(1)}%` : `${sign}${num}`
    return `${effect.label}${amount}`
  }

  /** 左栏常驻属性格（按 order 排序）；定义未到先用兜底 */
  const sidebarStats = computed(() => {
    const picked = statEntries.value.filter(s => s.spot === 'sidebar')
    return picked.length ? picked : FALLBACK_SIDEBAR
  })

  /** 属性详情/悬浮层用的完整清单 */
  const detailStats = computed(() => statEntries.value.filter(s => s.spot !== 'sidebar'))

  /**
   * 左栏一格：短格式上屏、精确值给 title、百分比带后缀。
   * 侧栏宽度是量出来的（w-72 三列，格内 px-1/text-base），所以整数属性统一走 formatCompact。
   */
  const gridCell = (entry, rawValue) => {
    const num = Number(rawValue) || 0
    const suffix = entry.suffix || ''
    return {
      key: entry.key,
      label: entry.shortLabel || entry.label,
      description: entry.description || '',
      cls: 'text-fg-primary',
      shown: suffix ? `${num}${suffix}` : formatCompact(num),
      exact: suffix ? `${num}${suffix}` : formatNumber(num)
    }
  }

  return {
    statEntries,
    effectEntries,
    loaded,
    load,
    isStat,
    definition,
    labelOf,
    suffixOf,
    formatBonus,
    sidebarStats,
    detailStats,
    gridCell
  }
}
