/**
 * 物品品质词表单例：把服务端 `game_balance.item_qualities`（基础 + 已启用资料片的合并视图）
 * 经 GET /api/config/game-balance/public 下发的那份清单，变成前端可用的档名、颜色与排序。
 *
 * 为什么要有这个文件：品质以前没有归属，9 个玩家面板各抄一份「品质 → 中文名 + 颜色」字典，
 * 其中 6 份漏了 `mythic` —— 于是现网 45 件神话档物品（补天丹、玄天斩灵剑、有生不增丹 …）
 * 在背包 / 当铺 / 装备 / 炼器 / 世界聊天里被印成「普通」或「凡品」，而且三套叫法并存
 * （普通/非凡 vs 凡品/灵品 vs 普通/精良）。现在这些位置一律读这一份：
 * 资料片加一档品质 = 写一条数据，所有面板同时认得，前端不用改第 N 份抄写。
 *
 * 状态放在模块作用域而不是 setup：整个会话只有一份词表；每个面板各自请求一次既浪费，
 * 又必然造成"两个面板对同一档叫法不一样"（那正是本轮要清的账）。
 */
import { computed, ref } from 'vue'
import { getGameBalancePublic } from '../api/config'

/**
 * 色令牌 → Tailwind 类。**全项目只有这一处**做这个映射。
 * 服务端只发 neutral/jade/azure/violet/gold/crimson 六个语义令牌（启动期闸
 * `ContentRegistry._validateItemQualities` 就按这六个判），所以加一档品质不必动前端；
 * 要一种真正全新的颜色才在这里加一个令牌 —— 一次映射，取代九份抄写。
 * 类名一律写成完整字面量，拼字符串会让 Tailwind 的静态扫描扫不到（样式静默丢失）。
 *
 * 五种用途覆盖现网所有面板的写法（缺一种就会有人回来在面板里再抄一份字典）：
 *   text   文字色（名字、标签）
 *   border 边框色（卡片/格子的品质描边）
 *   glow   阴影（背包格子的品质光晕）
 *   solid  浅色图标底块
 *   tile   实心底块（傀儡星标 / 钓鱼图鉴那种强对比方块；最高一档是渐变，"顶级"这件事只在这里定义一次）
 *   chip   小标签（底色 + 前景 + 同色系边框，一条写完）
 */
const TONE_CLASS = {
  neutral: {
    text: 'text-fg-secondary', border: 'border-line-strong', glow: 'shadow-surface-sunken/30',
    solid: 'bg-surface-active text-fg-secondary', tile: 'bg-surface-active text-fg-secondary',
    chip: 'bg-surface-hover text-fg-secondary border-line-strong'
  },
  jade: {
    text: 'text-emerald-400', border: 'border-emerald-600', glow: 'shadow-emerald-900/40',
    solid: 'bg-emerald-900/50 text-emerald-300', tile: 'bg-emerald-800 text-emerald-200',
    chip: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
  },
  azure: {
    text: 'text-sky-400', border: 'border-sky-600', glow: 'shadow-sky-900/40',
    solid: 'bg-sky-900/50 text-sky-300', tile: 'bg-sky-800 text-sky-200',
    chip: 'bg-sky-900/40 text-sky-300 border-sky-700/50'
  },
  violet: {
    text: 'text-purple-400', border: 'border-purple-600', glow: 'shadow-purple-900/40',
    solid: 'bg-purple-900/50 text-purple-300', tile: 'bg-purple-800 text-purple-200',
    chip: 'bg-purple-900/40 text-purple-300 border-purple-700/50'
  },
  gold: {
    text: 'text-gold-400', border: 'border-gold-600', glow: 'shadow-gold-900/40',
    solid: 'bg-gold-900/50 text-gold-300', tile: 'bg-gold-700 text-gold-200',
    chip: 'bg-gold-900/40 text-gold-300 border-gold-700/50'
  },
  crimson: {
    text: 'text-rose-400', border: 'border-rose-600', glow: 'shadow-rose-900/40',
    solid: 'bg-rose-900/50 text-rose-300', tile: 'bg-gradient-to-br from-gold-500 to-rose-600 text-fg-primary',
    chip: 'bg-rose-900/40 text-rose-300 border-rose-700/50'
  }
}

/**
 * 语义色令牌 → Badge 组件的 tone（Badge 只认 neutral/gold/success/danger/info/arcane/muted）。
 * 有这张表，面板才不必为"这一档该给 Badge 什么语气"再写一串三元 —— PvpPanel 以前就是
 * `quality === 'rare' ? 'arcane' : quality === 'uncommon' ? 'success' : 'muted'`，
 * 于是 mythic/legendary 全落进 muted，标签还写着"良品"这种第四套叫法。
 */
const TONE_BADGE = {
  neutral: 'muted', jade: 'success', azure: 'info', violet: 'arcane', gold: 'gold', crimson: 'danger'
}

/**
 * 接口还没回来（或挂了）时的兜底 —— 与 game_balance.item_qualities 同步，**六档齐全**。
 * 兜底名单里漏一档（就是本轮之前的现场）会让那一档在界面上退成最低档的样子。
 */
export const FALLBACK_QUALITIES = [
  { key: 'common', label: '普通', tone: 'neutral', order: 1 },
  { key: 'uncommon', label: '非凡', tone: 'jade', order: 2 },
  { key: 'rare', label: '稀有', tone: 'azure', order: 3 },
  { key: 'epic', label: '史诗', tone: 'violet', order: 4 },
  { key: 'legendary', label: '传说', tone: 'gold', order: 5 },
  { key: 'mythic', label: '神话', tone: 'crimson', order: 6 }
]

/** 词表里查不到 / 物品根本没标品质时的说法：不许冒充任何一档 */
const UNKNOWN_LABEL = '未标品质'

const qualityEntries = ref(FALLBACK_QUALITIES)
const loaded = ref(false)
let inflight = null

/** 请求失败不该弹 toast 打断玩家：词表缺失只是标签退化，静默降级即可 */
function load({ force = false } = {}) {
  if (inflight && !force) return inflight
  if (loaded.value && !force) return Promise.resolve()
  inflight = getGameBalancePublic()
    .then((res) => {
      const list = res.data?.data?.item_qualities
      if (Array.isArray(list) && list.length) {
        qualityEntries.value = list
        loaded.value = true
      }
    })
    .catch((error) => {
      console.warn('[useItemQualities] 品质词表获取失败，使用兜底档名:', error?.message || error)
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useItemQualities() {
  // 谁第一次用到谁触发拉取，调用方不必各自记得在 onMounted 里 load
  load()

  const byKey = computed(() => {
    const map = {}
    for (const entry of qualityEntries.value) map[String(entry.key)] = entry
    return map
  })

  /** 由低到高排好序的下拉选项（筛选器 / GM 表单都读这一份，不再各列一遍 <option>） */
  const options = computed(() => qualityEntries.value.map(q => ({ value: String(q.key), label: q.label })))

  const entryOf = (quality) => {
    if (quality === undefined || quality === null || quality === '') return null
    return byKey.value[String(quality)] || null
  }

  const labelOf = (quality) => entryOf(quality)?.label || UNKNOWN_LABEL

  const toneOf = (quality) => {
    const tone = entryOf(quality)?.tone
    return TONE_CLASS[tone] ? tone : 'neutral'
  }

  /** 一次性拿全：面板里 `:class="styleOf(item.quality).text"` 这种写法就够，不必再查表 */
  const styleOf = (quality) => {
    const tone = toneOf(quality)
    return {
      key: entryOf(quality) ? String(quality) : null,
      label: labelOf(quality),
      tone,
      badgeTone: TONE_BADGE[tone] || 'muted',
      order: Number(entryOf(quality)?.order) || 0,
      // color 是 text 的别名：老面板普遍写的是 `.color`，改名会让九个文件同时改调用点，
      // 留一个别名的代价远小于把 40 多处模板调用逐个改错（改错的表现正是本轮要修的"颜色丢了"）
      color: TONE_CLASS[tone].text,
      ...TONE_CLASS[tone]
    }
  }

  const textClass = quality => styleOf(quality).text
  const borderClass = quality => styleOf(quality).border
  const glowClass = quality => styleOf(quality).glow
  const solidClass = quality => styleOf(quality).solid
  const tileClass = quality => styleOf(quality).tile
  const chipClass = quality => styleOf(quality).chip
  const badgeTone = quality => styleOf(quality).badgeTone

  /** 品质档位比较：排序 / "至少某档" 的筛选都用它，词表顺序就是唯一依据 */
  const rankOf = quality => Number(entryOf(quality)?.order) || 0
  const compareQuality = (a, b) => rankOf(a) - rankOf(b)

  return {
    qualities: qualityEntries,
    loaded,
    reload: load,
    options,
    entryOf,
    labelOf,
    toneOf,
    styleOf,
    textClass,
    borderClass,
    glowClass,
    solidClass,
    tileClass,
    chipClass,
    badgeTone,
    rankOf,
    compareQuality,
    UNKNOWN_LABEL
  }
}
