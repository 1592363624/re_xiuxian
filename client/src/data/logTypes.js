/**
 * 游戏日志类型登记处
 *
 * 日志是文游的主界面，但在此之前 kinds 散在 GameLog 的两份 switch 里：
 * 一份决定左边框颜色，一份决定文字颜色，各自 10 个 case，
 * 面板里 addLog 出来的类型只要不在那 10 个里，就静默变成最普通的灰字——
 * 「神识受创」「渡劫失败」这种关键行和「你看了看四周」长得一样。
 *
 * 现在一种类型一处定义。新增玩法要发新类型日志，只改这个文件。
 * 未登记的类型会走 fallback 并带上 plain 标记，不再冒充 info。
 */

/** @typedef {{ label: string, accent: string, text: string, tone: 'calm'|'good'|'warn'|'bad'|'special' }} LogKind */

/** @type {Record<string, LogKind>} */
export const LOG_KINDS = {
  /* 中性叙述 */
  info:         { label: '',      accent: 'border-line-subtle', text: 'text-fg-secondary', tone: 'calm' },
  system:       { label: '天道',  accent: 'border-purple-800/70', text: 'text-purple-300', tone: 'special' },
  notice:       { label: '公告',  accent: 'border-purple-800/70', text: 'text-purple-300', tone: 'special' },

  /* 修行进展 */
  success:      { label: '',      accent: 'border-emerald-800/60', text: 'text-emerald-300', tone: 'good' },
  exp:          { label: '',      accent: 'border-cyan-800/60',   text: 'text-cyan-300',    tone: 'good' },
  technique:    { label: '功法',  accent: 'border-sky-800/60',    text: 'text-sky-300',     tone: 'good' },
  breakthrough: { label: '突破',  accent: 'border-amber-700/70',  text: 'text-amber-200',   tone: 'special' },
  levelup:      { label: '进阶',  accent: 'border-amber-700/70',  text: 'text-amber-200',   tone: 'special' },
  unlock:       { label: '解锁',  accent: 'border-amber-700/70',  text: 'text-amber-200',   tone: 'special' },

  /* 战斗 */
  combat:       { label: '战斗',  accent: 'border-rose-800/60',   text: 'text-rose-300',    tone: 'bad' },
  combat_damage:{ label: '',      accent: 'border-red-900/70',    text: 'text-red-300',     tone: 'bad' },
  combat_heal:  { label: '',      accent: 'border-green-900/70',  text: 'text-green-300',   tone: 'good' },
  death:        { label: '陨落',  accent: 'border-rose-700/80',   text: 'text-rose-200',    tone: 'bad' },

  /* 资源与获得 */
  item:         { label: '',      accent: 'border-amber-700/60',  text: 'text-amber-300',   tone: 'good' },
  loot:         { label: '',      accent: 'border-amber-700/60',  text: 'text-amber-300',   tone: 'good' },
  gather:       { label: '',      accent: 'border-lime-700/60',   text: 'text-lime-300',    tone: 'good' },
  spirit_stone: { label: '',      accent: 'border-yellow-800/60', text: 'text-yellow-300',  tone: 'good' },
  market:       { label: '坊市',  accent: 'border-rose-800/60',   text: 'text-rose-300',    tone: 'calm' },
  lucky:        { label: '机缘',  accent: 'border-amber-600/70',  text: 'text-amber-200',   tone: 'special' },

  /* 阵法（后端按具体动作分别下发，不是一种类型） */
  formation_activate:   { label: '阵法', accent: 'border-indigo-800/60', text: 'text-indigo-300', tone: 'good' },
  formation_deactivate: { label: '阵法', accent: 'border-indigo-900/50', text: 'text-indigo-400', tone: 'calm' },
  formation_learn:      { label: '阵法', accent: 'border-indigo-700/60', text: 'text-indigo-200', tone: 'special' },

  /* 提醒与失败 */
  warning:      { label: '',      accent: 'border-amber-800/60',  text: 'text-amber-300',   tone: 'warn' },
  error:        { label: '',      accent: 'border-rose-800/70',   text: 'text-rose-300',    tone: 'bad' },
  fail:         { label: '',      accent: 'border-rose-800/70',   text: 'text-rose-300',    tone: 'bad' },

  /* 社交与移动 */
  movement:     { label: '',      accent: 'border-teal-800/60',   text: 'text-teal-300',    tone: 'calm' },
  chat:         { label: '',      accent: 'border-sky-800/60',    text: 'text-sky-300',     tone: 'calm' },
  join:         { label: '',      accent: 'border-emerald-800/60', text: 'text-emerald-300', tone: 'calm' },
  leave:        { label: '',      accent: 'border-stone-700/60',  text: 'text-fg-muted',    tone: 'calm' },
}

/** 未登记类型的兜底：plain 语气，不与 info 争「这就是普通叙述」的语义 */
export const LOG_FALLBACK = { label: '', accent: 'border-line-subtle', text: 'text-fg-secondary', tone: 'calm' }

/** 值得在行首打标签的类型；其余只靠颜色区分，避免整屏都是徽标 */
export const LOG_LABELLED = new Set(['system', 'notice', 'breakthrough', 'levelup', 'unlock', 'lucky', 'combat', 'death', 'market', 'technique'])

/**
 * 取一行日志的呈现样式。
 * 面板里写了没登记的类型时告警一次，免得颜色悄悄掉回默认值没人发现。
 */
const warned = new Set()
export function resolveLogKind(type) {
  const kind = LOG_KINDS[type]
  if (kind) return kind
  if (type && type !== 'info' && !warned.has(type)) {
    warned.add(type)
    console.warn(`[logTypes] 未登记的日志类型「${type}」，已按普通叙述渲染。请在 data/logTypes.js 补一条。`)
  }
  return LOG_FALLBACK
}
