/**
 * 界面层体检脚本 —— npm run ui:check
 *
 * 这一轮重构里反复用到、但只存在于临时目录的几项检查，收成一个常驻门禁。
 * 前端没有测试可跑，vue-tsc 又带着 131 个历史错误当不了红绿灯，
 * 所以「面板还在不在契约上」这类问题只能靠脚本盯。
 *
 * 检查项（都是静态的，不依赖浏览器，也不写 dist）：
 *   1. 停靠契约  注册表里每个面板都必须用 PanelShell、转发 close、
 *                且不再自己定义 .panel-body / .panel-overlay（会和
 *                style.css 的全局停靠规则抢样式）
 *   2. 组件契约  给 Modal / PanelShell 传了它们没声明的属性，
 *                模板里拼错 prop 编译期不报错，运行期静默失效
 *                （:show 之于 isOpen 就废掉过 7 个弹窗）
 *   3. 主题令牌  硬编码十六进制、冷灰 gray-*、废弃的 xiuxian-* 别名、
 *                font-serif、各自复写的滚动条
 *   5. 文案字典  面板里再抄一份"键→中文名"的模块级字典：这类数据后端已经随
 *                schema / variable_meta 一起下发，抄的那份只会过期和漏项
 *   6. 内容清单  把后端内容的主键清单（副本 key、BOSS key…）抄成前端字面量数组：
 *                资料片加一条，界面上就没有它，而且两端都不报错
 *   7. 裸物品键  玩家可见界面把 item_key / item_id 直接印出来：服务端已按 item_data
 *                在载荷里补了 item_name，抄一份物品典或干脆印键名都只会让新物品一进内容就露馅
 *   11. 奖励露头  成就面板必须渲染服务端 ACHIEVEMENT_REWARD_KEYS 名单里的每一项：
 *                服务端发得出而界面不显示，等于玩家白拿一次奖励（配了但看不见的客户端那一半）
 *
 * 有未登记项时只警告不失败的东西用 ⚠ 标出，返回码只反映真正的破坏。
 */
import fs from 'node:fs'
import path from 'node:path'

// 这份脚本现在挂在 npm run build 前面（start-prod.bat 走的也是 build）。
// 一个体检脚本不该有能力弄坏生产构建，所以 @vue/compiler-sfc 取不到时
// 只跳过"能否解析"这一项，其余检查照常跑、照常给结论。
let parse = null
try {
  ;({ parse } = await import('@vue/compiler-sfc'))
} catch {
  console.log('(提示: 未找到 @vue/compiler-sfc，跳过 SFC 可解析性检查)')
}

const CLIENT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(CLIENT, 'src')

const filesOf = (dir, ext = '.vue') => {
  const out = []
  ;(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(ext)) out.push(p)
    }
  })(dir)
  return out
}
const rel = p => path.relative(SRC, p).replace(/\\/g, '/')
const relClient = p => path.relative(CLIENT, p).replace(/\\/g, '/')

/* ───────────────────────── 1. 停靠契约 ───────────────────────── */

const registry = fs.readFileSync(path.join(SRC, 'components/panels/registry.js'), 'utf8')
// 注册表里的 import 路径是相对 components/panels/ 的（CharacterModal 在 ../modals/），
// 必须按这个基准解析，否则全部指向不存在的位置
const docked = new Map(
  [...registry.matchAll(/^\s+([a-z_]+): \(\) => import\('([^']+)'\)/gm)]
    .map(([, id, p]) => [id, path.resolve(path.join(SRC, 'components/panels'), p)])
)

const dockingFailures = []
const chromeDup = []
for (const [id, file] of docked) {
  if (!fs.existsSync(file)) { dockingFailures.push(`${relClient(file)}  ← 注册表指向的文件不存在 (${id})`); continue }
  const s = fs.readFileSync(file, 'utf8')
  const tag = (() => { const i = s.indexOf('<PanelShell'); if (i < 0) return null; const g = s.indexOf('>', i); return s.slice(i, g + 1) })()
  if (!tag) { dockingFailures.push(`${rel(file)}  没有用 <PanelShell>，不会停靠进右坞 (${id})`); continue }
  if (!/@close\b|v-on=/.test(tag)) dockingFailures.push(`${rel(file)}  <PanelShell> 没转发 close，✕ 点了没反应 (${id})`)
  if (/\.panel-body\s*\{|\.panel-overlay\s*\{/.test(s)) chromeDup.push(`${rel(file)}  自己又定义了 .panel-body/.panel-overlay，会和全局停靠规则冲突`)
}

/* ───────────────────────── 2. 组件 props 契约 ───────────────────────── */

const declaredProps = file => {
  const s = fs.readFileSync(file, 'utf8')
  const m = s.match(/defineProps\s*\(\s*\{([\s\S]*?)\n\s*\}\s*\)/)
  if (!m) return null
  const set = new Set([...m[1].matchAll(/^\s{2}([A-Za-z_]\w*)\s*:/gm)].map(x => x[1]))
  for (const k of [...set]) set.add(k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()))
  for (const k of ['key', 'ref', 'class', 'style', 'id', 'role']) set.add(k)
  return set
}
const CONTRACTS = {
  Modal: declaredProps(path.join(SRC, 'components/common/Modal.vue')),
  PanelShell: declaredProps(path.join(SRC, 'components/ui/PanelShell.vue')),
}
const propViolations = []
for (const f of [...filesOf(path.join(SRC, 'components')), ...filesOf(path.join(SRC, 'views'))]) {
  const s = fs.readFileSync(f, 'utf8')
  for (const [comp, allowed] of Object.entries(CONTRACTS)) {
    if (!allowed) continue
    for (const m of s.matchAll(new RegExp(`<${comp}((?:\\s[^>]*)?)>`, 'g'))) {
      for (const a of m[1].matchAll(/(^|\s)(@|:|v-bind:|v-on:)?([A-Za-z][\w-]*)=/g)) {
        const [, , modifier, name] = a
        if (modifier === '@' || modifier === 'v-on:') continue
        // v-if / v-show / v-for 这类指令不是 prop，别当成拼错的属性报出来
        if (!modifier && /^v-/.test(name)) continue
        if (/^(aria-|data-|role|tabindex|on[A-Z])/.test(name)) continue
        if (!allowed.has(name)) propViolations.push(`${rel(f)}  <${comp} ${name}=…>  该组件没有声明这个 prop，会静默失效`)
      }
    }
  }
}

/* ───────────────────────── 3. 主题令牌残留 ───────────────────────── */

// 允许留字面量的少数情况：品牌色、canvas 取色、以及靠拼 alpha 后缀工作的兜底色
const LITERAL_OK = [/12b7f5/i, /1a1030|0a0518|0c1a2e|050a14/, /#78716c/]
const palette = []
for (const f of filesOf(SRC)) {
  const s = fs.readFileSync(f, 'utf8')
  const name = rel(f)
  const hexes = (s.match(/#[0-9a-fA-F]{6}\b/g) || []).filter(h => !LITERAL_OK.some(r => r.test(h)))
  const gray = s.match(/(?:bg|text|border|from|to|divide|ring|placeholder|shadow)(?:-[a-z]+)?-gray-\d+/g) || []
  const legacy = s.match(/xiuxian-(?:gold|dark|text)/g) || []
  const serif = s.match(/font-serif/g) || []
  const scrollbar = /-webkit-scrollbar/.test(s)
  if (hexes.length || gray.length || legacy.length || serif.length || scrollbar) {
    const bits = []
    if (hexes.length) bits.push(`字面色×${hexes.length}`)
    if (gray.length) bits.push(`冷灰 gray-*×${gray.length}`)
    if (legacy.length) bits.push(`xiuxian-*×${legacy.length}`)
    if (serif.length) bits.push(`font-serif×${serif.length}`)
    if (scrollbar) bits.push('本地滚动条')
    palette.push(`${name}  ${bits.join('  ')}`)
  }
}

/* ───────────────────────── 4. SFC 可编译性 ───────────────────────── */

const uncompilable = []
if (parse) {
  for (const f of filesOf(SRC)) {
    const s = fs.readFileSync(f, 'utf8')
    const { descriptor, errors } = parse(s, { filename: f })
    if (errors.length) { uncompilable.push(`${rel(f)}  ${errors[0].message}`); continue }
    if (descriptor.template) {
      const r = parse(`<template>${descriptor.template.content}</template>`, { filename: f })
      if (r.errors.length) uncompilable.push(`${rel(f)}  ${r.errors[0].message}`)
    }
  }
}

/* ──────────────────── 5. 模块级文案字典（服务端才是来源） ──────────────────── */

/**
 * 盯的形状：面板里抄一份 "键 → 中文名" 的模块级字典。
 * 多人副本面板就这么抄过一份 15 条的变量名字典和 9 条的归属字典，而后端 /status
 * 早就按内容（multi_dungeon_data 的 variable_labels + 各副本 instance_vars/member_vars）
 * 生成 40 个变量的 variable_meta —— 抄的那份既少（25 个键只能走兜底）又新（两处文案已经和内容对不上），
 * 于是"加一个副本变量"要改两个地方，漏掉的那半表现为面板里凭空少一行。
 * 只判**模块级**、条目 ≥5 的 `Record<string, string>`：函数内部的局部映射（枚举→显示名）不算，
 * 那类是组件自己的展示逻辑，服务端没有对应数据。
 */
const labelDicts = []
for (const dir of [path.join(SRC, 'components'), path.join(SRC, 'composables')]) {
  if (!fs.existsSync(dir)) continue
  for (const f of [...filesOf(dir), ...filesOf(dir, '.ts')]) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      const m = line.match(/^const\s+(\w+)\s*:\s*Record<\s*string\s*,\s*string\s*>\s*=\s*\{/)
      if (!m) return
      let entries = 0
      for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j]); j++) {
        if (/^\s+[\w'"]+\s*:/.test(lines[j])) entries += 1
      }
      if (entries >= 5) labelDicts.push(`${rel(f)}:${i + 1}  ${m[1]}（${entries} 条）`)
    })
  }
}

/* ───────────────────────── 6. 内容主键不许在客户端枚举 ───────────────────────── */

/**
 * 盯的形状：`const X = ['yanyue','duanwu',…]` —— 把后端内容的主键清单抄一份在前端。
 * 抄过的两处：奖励池子页签（4 个副本，内容里有 10 个 → 另外 6 个副本的奖励表在界面上进不去）、
 * 世界 BOSS 的 GM 下拉（3 只 → 资料片新加的 BOSS 在后台根本刷不出来，尽管服务端按内容认）。
 * 键集直接读服务端的 DATASET_SPECS，两边最多漂一次；读不到就跳过这一项（和 compiler-sfc 一样，
 * 体检脚本不该有能力弄坏生产构建）。
 */
const contentEnums = []
{
  // 这些数据集的键名出现在前端字面量里是正常写法（五行元素名、道具 id 等展示引用），与服务端那道闸的豁免一致
  const EXEMPT = new Set([
    'item_data', 'resource_data', 'stat_definitions', 'combat_formulas', 'effect_vocabulary',
    'talents', 'titles', 'achievement_data', 'drop_data', 'artifact_deep_lines', 'taoism_gate_data'
  ])
  const KEY_FIELDS = ['id', 'key', 'type_key', 'beast_key', 'boss_key', 'item_id', 'code', 'name',
    'concubine_key', 'level', 'floor', 'stage', 'tier']
  const sets = []
  try {
    const { createRequire } = await import('node:module')
    const nodeRequire = createRequire(import.meta.url)
    const serverDir = path.resolve(CLIENT, '..', 'server')
    const { DATASET_SPECS } = nodeRequire(path.join(serverDir, 'game/content/ContentRegistry.js'))
    const at = (obj, name) => name.split('.').reduce((c, seg) => (c && typeof c === 'object' ? c[seg] : undefined), obj)
    for (const [dataset, spec] of Object.entries(DATASET_SPECS)) {
      if (EXEMPT.has(dataset)) continue
      let data
      try {
        data = JSON.parse(fs.readFileSync(path.join(serverDir, 'config', `${dataset}.json`), 'utf8'))
      } catch { continue }
      const keys = new Set()
      for (const [name, collection] of Object.entries(spec.collections || {})) {
        const raw = collection.root ? data : at(data, name)
        if (Array.isArray(raw)) {
          const keyField = collection.key
            || KEY_FIELDS.find(f => raw.every(x => x && typeof x === 'object' && x[f] !== undefined))
          for (const entry of raw) {
            if (entry && typeof entry === 'object' && entry[keyField] !== undefined) keys.add(String(entry[keyField]))
          }
        } else if (raw && typeof raw === 'object') {
          Object.keys(raw).forEach(k => keys.add(k))
        }
      }
      if (keys.size >= 3) sets.push([dataset, keys])
    }
  } catch (e) {
    // 这道闸没有清单就等于没跑；宁可让它响，也不要悄悄变成空转的门禁
    contentEnums.push(`读不到服务端内容清单（../server），第 6 项无法执行：${e.message}`)
  }
  if (!sets.length && !contentEnums.length) contentEnums.push('内容清单一份都没读到（DATASET_SPECS 为空？），第 6 项无法执行')
  if (sets.length) {
    /**
     * 已知豁免：`文件|数据集` → 必须写清理由。
     * 和后端 OPTIONAL_ITEM_REFS 同一套纪律 —— 豁免要能被 grep 到、要写原因，
     * 而且一旦这一处不再命中（文件改了/修好了），下面会反过来报"豁免已过期"，不许悄悄留着。
     * 2026-09-21：ArtifactSpiritPanel 的器灵类型清单改成内容下发了
     * （GET /artifact-spirit/list 的 spirit_types，文案由服务端按内容数值拼），豁免清零。
     * 空表是正常状态；出现条目就要问"为什么不是内容给"。
     */
    const CONTENT_ENUM_EXEMPTIONS = new Map([
        // 2026-09-23：这条豁免已经按它自己写的"到期条件"过期并删掉了 —— 灵兽稀有度现在由内容下发
        // （GET /config/content/keys/spirit_beast_data?collection=rarity_config + 行数据带 rarity_name/rarity_color），
        // GM 后台那个下拉不再抄档位名，也不再按键名硬编颜色。
    ])
    const matchedExemptions = new Set()
    const literalList = /\[\s*(?:'[^'\n]+'|"[^"\n]+")(?:\s*,\s*(?:'[^'\n]+'|"[^"\n]+")){2,}\s*\]/g
    // 另一种常见形状：`const TABS = [{ key: 'yanyue', label: '掩月抢亲' }, …]` —— 抄的是对象数组，
    // 奖励池子页签就是这么写死的（4 个副本，内容里 10 个），所以整块数组里的字符串都要算进来。
    const arrayBlock = /\bconst\s+\w+[^=\n]*=\s*\[[\s\S]*?\n\]/g
    for (const f of [...filesOf(SRC), ...filesOf(SRC, '.ts')]) {
      const text = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, '')
      const reported = new Set()
      for (const match of [...text.matchAll(literalList), ...text.matchAll(arrayBlock)]) {
        // 对象数组（`{ key: 'yanyue', label: '掩月抢亲' }`）只数键位上的字符串，
        // 否则中文标签会把"整份清单都是内容主键"这个判据稀释掉 —— 奖励池那份就是这么漏掉的。
        const keyed = [...match[0].matchAll(/\b(?:key|value|id|code|boss_key|dungeon_key)\s*:\s*['"]([^'"\n]+)['"]/g)].map(m => m[1])
        const all = [...match[0].matchAll(/['"]([^'"\n]+)['"]/g)].map(m => m[1])
        const tokens = [...new Set(keyed.length ? keyed : all)]
        if (tokens.length < 3) continue
        for (const [dataset, keys] of sets) {
          const inside = tokens.filter(t => keys.has(t))
          if (inside.length < 3 || tokens.length - inside.length > 1) continue
          const line = (text.slice(0, match.index).match(/\n/g) || []).length + 1
          const dedupe = `${line}|${dataset}`
          if (reported.has(dedupe)) continue
          reported.add(dedupe)
          const exemptKey = `${rel(f)}|${dataset}`
          if (CONTENT_ENUM_EXEMPTIONS.has(exemptKey)) { matchedExemptions.add(exemptKey); continue }
          contentEnums.push(`${rel(f)}:${line}  ${dataset} 的 ${inside.length} 个主键：${inside.slice(0, 5).join(', ')}${inside.length > 5 ? '…' : ''}`)
        }
      }
    }
    for (const key of CONTENT_ENUM_EXEMPTIONS.keys()) {
      if (!matchedExemptions.has(key)) {
        contentEnums.push(`豁免已过期，这一处不再命中内容主键清单，请把它删掉：${key}`)
      }
    }
  }
}

/* ─────────────── 7. 玩家可见界面不许把物品键直接印出来（名字服务端已下发） ─────────────── */
// 掉落/奖励/收集物在内容里只是引用（item_key / item_id）。服务端在返回前会按 item_data 补上
// item_name（server/game/items/itemNaming.js，一条链只解析一次），界面却常常直接把引用印出去：
// 战斗日志里的 "获得物品: wild_herb x3"、副本进度里的 "jade_core ×2" 就是这么来的。
// 资料片加一件新物品，这种地方立刻露馅，而玩家能看懂的只能是名字。
// GM 后台（components/admin）要按键排查问题，故意不在射程内。
const rawItemKeys = []
const ITEM_NAME_EXEMPTIONS = new Set([])
// 只有"当成文字印出去"才算问题，"当成标识用"不算：
//   :key="`${a}-${item.item_id}`" 是 Vue 的绑定值，屏幕上看不到；
//   getSelectedItemName(form.item_key, list, 'item_key') 是本地查名字（列表里的 name 也是服务端给的）。
// 属性绑定用引号包住，模板插值只可能落在 ="..." 里（绑定）或标签之间的文本里（印出去），按区间分辨。
// 注意 :title="item.item_id" 这类悬停提示也会被判成绑定而漏掉——实测全项目 0 处，别把"绑定"当成绝对安全。
const boundAttrRanges = line => [...line.matchAll(/="[^"]*"/g)].map(m => [m.index + 1, m.index + m[0].length - 1])
for (const file of [...filesOf(path.join(SRC, 'components/panels')), ...filesOf(path.join(SRC, 'components/modals'))]) {
  const rel = path.relative(SRC, file).split(path.sep).join('/')
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, idx) => {
    const ranges = boundAttrRanges(line)
    const spots = [
      ...[...line.matchAll(/\{\{([^}]*)\}\}/g)].map(m => ({ text: m[1], bound: false })),
      ...[...line.matchAll(/\$\{[^{}]*item_(?:key|id)[^{}]*\}/g)]
        .map(m => ({ text: m[0], bound: ranges.some(([s, e]) => m.index > s && m.index < e) }))
    ]
    for (const spot of spots) {
      if (spot.bound) continue
      if (!/\.(item_key|item_id)\b/.test(spot.text)) continue
      if (/_name/.test(spot.text)) continue
      if (/[A-Za-z_$][A-Za-z0-9_$]*Name\s*\(/.test(spot.text)) continue
      const key = `${rel}:${line.trim().slice(0, 60)}`
      if (ITEM_NAME_EXEMPTIONS.has(key)) { ITEM_NAME_EXEMPTIONS.delete(key); continue }
      rawItemKeys.push(`${rel}:${idx + 1} 把物品键直接印给玩家（该用服务端下发的 item_name）：${line.trim().slice(0, 70)}`)
    }
  })
}
for (const stale of ITEM_NAME_EXEMPTIONS) {
  rawItemKeys.push(`豁免已过期，这一处不再命中裸键，请删掉它：${stale}`)
}

/* ───────────────────────── 8. 面板可达性（入口 → 分类 → 注册表 → 文件） ───────────────────────── */

/**
 * 一个面板要能被玩家点开，得同时满足四件事：
 *   actionCatalog.ACTIONS 里有这条 id（有名字和图标）
 *   → 它出现在 DOCK_TABS 某个分类或 QUICK_ACTION_IDS 里（坞里看得见）
 *   → panels/registry.js 用同一个 id 登记了组件（点得开）
 *   → 那个组件文件真的存在并且是本面板（不是抄错的同名文件）
 * 任何一环漏掉都没有编译期错误：registry.js 的文档里就写着"漏掉 if 链就是卡片在但点不开"，
 * 那是改造前的老形状；改造后链条只是换了地方，同样的漏法依旧只剩运行时 console.warn。
 * 更要紧的是资料片模式：以后加玩法应当就是"补三步"，而每一步都可能只做一半。
 * 所以这里把四环两头都对照一遍，认不出的必须写理由登记。
 */
const catalogText = fs.readFileSync(path.join(SRC, 'data/actionCatalog.js'), 'utf8')
const balancedBlock = (text, marker) => {
  const start = text.indexOf(marker)
  if (start < 0) throw new Error(`actionCatalog 里找不到 ${marker}（目录形状变了，本项检查要跟着改）`)
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  throw new Error(`${marker} 的括号没闭合`)
}
const actionIds = new Set([...balancedBlock(catalogText, 'export const ACTIONS')
  .matchAll(/^\s{2}([a-z_][a-z0-9_]*)\s*:/gm)].map(m => m[1]))
const dockTabsStart = catalogText.indexOf('export const DOCK_TABS')
const groupedIds = new Set([...catalogText.slice(dockTabsStart).matchAll(/ids:\s*\[([^\]]*)\]/g)]
  .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])))
const quickStart = catalogText.indexOf('export const QUICK_ACTION_IDS')
const quickIds = new Set([...catalogText.slice(quickStart, catalogText.indexOf(']', quickStart))
  .matchAll(/'([^']+)'/g)].map(m => m[1]))
const loaderIds = new Set(docked.keys())
const loaderFiles = new Set([...docked.values()].map(p => path.basename(p).replace(/\.vue$/, '')))

/**
 * 不判失败的少数形状，必须写清"为什么这条链断在这里仍然算可达"。
 * 与 ITEM_NAME_EXEMPTIONS 同一套纪律：豁免一旦被 grep 不到就反过来报错，防过期豁免。
 */
const REACHABILITY_EXEMPTIONS = new Map([
  ['panel-not-in-catalog:combat', '战斗面板不是坞内入口，由战斗流程 goPanel(\'combat\') 直接打开（GameLayout.vue:308/340）'],
  // 2026-09-26：`dead-panel-file:GatheringPanel` 豁免已按其到期条件删除 ——
  // 采集面板已正式登记进 panels/registry.js（id=gather）并放进 DOCK_TABS 的「历练」页，
  // 断链不再存在，豁免留着只会反过来报"豁免已过期"。
])

const reachabilityFailures = []
const consumeExemption = (key) => {
  if (!REACHABILITY_EXEMPTIONS.has(key)) return false
  REACHABILITY_EXEMPTIONS.delete(key)
  return true
}
for (const id of [...actionIds].sort()) {
  if (!loaderIds.has(id) && !consumeExemption(`action-without-panel:${id}`)) {
    reachabilityFailures.push(`ACTIONS.${id} 有入口卡片，但 panels/registry.js 没登记 → 点了只会"暂未开放"`)
  }
  if (!groupedIds.has(id) && !quickIds.has(id) && !consumeExemption(`action-ungrouped:${id}`)) {
    reachabilityFailures.push(`ACTIONS.${id} 既不在 DOCK_TABS 也不在 QUICK_ACTION_IDS → 玩家在坞里根本看不见这个入口`)
  }
}
for (const id of [...loaderIds].sort()) {
  if (!actionIds.has(id) && !consumeExemption(`panel-not-in-catalog:${id}`)) {
    reachabilityFailures.push(`panels/registry.js 登记了 ${id}，但 ACTIONS 里没这条 → 没有名字与图标，任何地方都进不去`)
  }
}
for (const id of [...groupedIds, ...quickIds].sort()) {
  if (!actionIds.has(id) && !consumeExemption(`ghost-group-id:${id}`)) {
    reachabilityFailures.push(`DOCK_TABS/QUICK_ACTION_IDS 点名了 ${id}，ACTIONS 里却没有 → resolveAction 会静默丢掉这张卡片`)
  }
}
// 最后一种断链形状：文件在，但没有任何一条链走到它（等于已经删掉的代码）
const allSources = filesOf(SRC, '.vue').concat(filesOf(SRC, '.ts'), filesOf(SRC, '.js'))
  .map(f => ({ rel: rel(f), text: fs.readFileSync(f, 'utf8') }))
for (const file of filesOf(path.join(SRC, 'components/panels')).sort()) {
  const base = path.basename(file).replace(/\.vue$/, '')
  if (loaderFiles.has(base)) continue
  const importers = allSources.filter(s => s.rel !== rel(file) && s.text.includes(base))
  if (!importers.length && !consumeExemption(`dead-panel-file:${base}`)) {
    reachabilityFailures.push(`${rel(file)} 既没登记进 registry，也没被任何文件 import → 这个玩法对玩家完全不存在`)
  }
}
for (const stale of REACHABILITY_EXEMPTIONS.keys()) {
  reachabilityFailures.push(`豁免已过期（那条断链现在不存在了，请删掉它）：${stale}`)
}

/* ───────────────────────── 9. 把服务端下发的枚举抄成客户端字面量 ───────────────────────── */
// 形状与第 5/6 项同族，但盯的是**值清单**而不是键名清单：装备槽位、物品子类型这些词由服务端配置说了算
// （game_balance.equipment.valid_slots / item_data[].type|subtype，资料片可以加一档），
// 客户端一抄就有了第二份真相：改顺序/加一档时不报错，只是面板默默按旧的排、新的那档落在"其他"里。
// （EquipmentPanel 以前就抄过 ['weapon','armor','accessory','boots','dharma']，2026-09-22 改成读配置。）
const SERVER_VOCAB = new Set([
  'weapon', 'armor', 'accessory', 'boots', 'dharma', 'fabao', 'artifact',
  'healing', 'mana', 'consumable', 'equipment', 'material', 'quest', 'badge', 'title', 'scroll'
])
// 豁免：文件 → 理由。**豁免一旦不再命中就反过来报错**（防过期豁免）
const VOCAB_EXEMPTIONS = new Map()
/**
 * 抹掉注释再扫（同一类坑在探针那边也栽过：注释里引用了旧写法，负向断言就会自己误红）。
 * 只抹三种安全形状：块注释、整行 `//`、HTML 注释 —— 不碰行内 `//`，否则 `https://…` 会被啃掉。
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
}

const vocabCopies = []
{
  // 单双引号都要认：只认单引号的话，这条闸会在"有人换成 prettier 的双引号"时静默变成空跑
  const arrayLiteral = /\[\s*((?:["'][a-z_]+["']\s*,\s*)+["'][a-z_]+["']\s*,?)\s*\]/g
  for (const { rel: file, text: raw } of allSources) {
    const text = codeOnly(raw)
    const isScript = /(^|\/)scripts\//.test(file) || /api\//.test(file)
    for (const m of text.matchAll(arrayLiteral)) {
      const values = m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
      if (values.length < 3) continue
      if (!values.every(v => SERVER_VOCAB.has(v))) continue
      // api/*.ts 里"我预期服务端会返回这些字段"的映射表不算抄枚举（它们按服务端给的键取值）
      if (isScript) continue
      const key = `${file}:${text.slice(0, m.index).split('\n').length}`
      if (VOCAB_EXEMPTIONS.has(key)) { VOCAB_EXEMPTIONS.delete(key); continue }
      vocabCopies.push(`${key} 抄了一份服务端值清单 [${values.join(', ')}] → 改成读接口下发的顺序/全集`)
    }
  }
  for (const stale of VOCAB_EXEMPTIONS.keys()) {
    vocabCopies.push(`豁免已过期（这份抄写现在不存在了，请删掉它）：${stale}`)
  }
}

/* ───────────────────────── 10. 品质字典不许在面板里各抄一份 ───────────────────────── */
/**
 * 盯的形状：对象字面量里出现 ≥3 个品质档名当键（`common:` / `mythic:` …）。
 * 品质是内容说了算（game_balance.item_qualities，资料片可以加一档），客户端一抄就定死两件事：
 * 叫法（本轮之前同时存在"普通/非凡"、"凡品/灵品"、"普通/精良"、"良品"四套）和
 * **档位全集** —— 漏一档不会报错，只会让那一档的东西印成最低档（九份抄写里六份漏了 mythic）。
 * 唯一允许有这张表的地方是 composables/useItemQualities.js（它把服务端词表映射成 Tailwind 类）。
 * GM 后台（components/admin）按既有口径豁免：那里要按原始档名排查问题。
 */
const QUALITY_KEYS = new Set(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'])
/** 豁免：文件 → 理由（与第 6 项同纪律：不再命中就反过来报"豁免已过期"） */
const QUALITY_DICT_EXEMPTIONS = new Map([
    // 2026-09-23：原先豁免的 `api/spiritBeast.ts` 是"灵兽稀有度 → 数量"那份手打四档的载荷结构。
    // 它现在改成 `Record<string, number>`（服务端按词表逐档给，0 也给），这条豁免按它自己写的
    // 到期条件过期删掉了 —— 留着只会让下一个真的品质抄写从这条豁免里蒙过去。
])
const qualityCopies = []
{
  const OWNER = 'composables/useItemQualities.js'
  const matched = new Set()
  const objectLiteral = /\{([^{}]*?)\}/gs
  for (const { rel: file, text: raw } of allSources) {
    if (file === OWNER || /(^|\/)components\/admin\//.test(file)) continue
    const text = codeOnly(raw)
    for (const m of text.matchAll(objectLiteral)) {
      const keys = [...m[1].matchAll(/(?:^|[,{\s])["']?([a-z_]+)["']?\s*:/g)].map(x => x[1])
      const hits = keys.filter(k => QUALITY_KEYS.has(k))
      if (hits.length < 3) continue
      if (QUALITY_DICT_EXEMPTIONS.has(file)) { matched.add(file); continue }
      const line = text.slice(0, m.index).split('\n').length
      qualityCopies.push(`${file}:${line} 抄了一份品质字典（${[...new Set(hits)].join('/')}）→ 改用 useItemQualities()，档名与颜色由服务端词表下发`)
    }
  }
  for (const file of QUALITY_DICT_EXEMPTIONS.keys()) {
    if (!matched.has(file)) qualityCopies.push(`豁免已过期（这份抄写现在不存在了，请删掉它）：${file}`)
  }
}

/* ───────────────────────── 11. 成就奖励的每一项都要在界面上露头 ───────────────────────── */
// 服务端 claimReward 能发几样东西，唯一名单是 server/game/content/ContentRegistry.js 里的
// ACHIEVEMENT_REWARD_KEYS（启动期未知键当场抛）。界面只渲染其中两样时，剩下的那几样就是
// 「内容配了、服务端也真发了、玩家却看不见」—— 与第 7 项同族，只是这次盯的是奖励形状。
// 名字（item_name / title_name）由服务端按合并视图现算随载荷下发，这里只判"有没有渲染这一项"。
const rewardRenderFailures = []
{
  const registrySrc = fs.readFileSync(
    path.resolve(CLIENT, '..', 'server', 'game', 'content', 'ContentRegistry.js'), 'utf8')
  const declared = registrySrc.match(/const ACHIEVEMENT_REWARD_KEYS = \[([^\]]*)\]/)
  const keys = declared ? [...declared[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]) : []
  if (!keys.length) {
    rewardRenderFailures.push('读不到服务端的 ACHIEVEMENT_REWARD_KEYS → 这条判据失去依据，请改判据而不是删掉本项')
  } else {
    const panel = fs.readFileSync(path.join(SRC, 'components/panels/AchievementPanel.vue'), 'utf8')
    for (const key of keys) {
      if (!new RegExp(`reward\\??\\.${key}\\b`).test(panel)) {
        rewardRenderFailures.push(`成就面板没渲染 reward.${key} → 服务端发得出、玩家看不见（名单里的每一项都要有出口）`)
      }
    }
    // 同一块面板的第二条契约：分组标题必须取自服务端下发的 categories。
    // `achievement_data.categories` 已是 map 集合，资料片能自带一档分组（huangfeng_trial 的「试艺」就是），
    // 面板里若抄一份"键→中文名"字典，资料片那一档就会顶着一个裸键出现在界面上。
    if (!/categories\[\s*cat\s*\]\s*\??\.\s*name/.test(panel)) {
      rewardRenderFailures.push('成就面板的分组标题不再取自服务端下发的 categories（应写 categories[cat]?.name || cat）'
        + ' → 资料片自带的那一档分组会印成裸键，或干脆要回来改前端')
    }
  }
}

/* ───────────────────────── 12. 把业务失败当成功（`code === 200` 不是成功判定） ───────────────────────── */
/**
 * 后端 `sendServiceResult()` 的约定（routes/concubine.js、routes/dungeon.js、routes/ascension.js… 每个路由顶部一份）：
 *   成功 → { code: 200, message, data }
 *   业务失败 → HTTP 200 + { code: 200, success: false, message, error_code }
 * 于是两种路由约定在客户端混成了一件不好认的事：
 *   · 走 sendServiceResult 的接口（concubine / companion / dungeon / ascension …）—— 被拒也是 200 + code:200
 *     实测（server/scripts/smoke_companion_voyage.js V8b/C4b）"这笔远航奖励已经领过了""该心劫已处理"
 *     回来的是 200 + success:false，玩家看到的却是一条绿色"成功"提示；
 *   · 走"失败即 HTTP 400"的接口（routes/gambling_stone.js）—— 请求在拦截器里就被 reject 了，
 *     `code === 200` 只是冗余，不是假绿。
 * 这条闸分不出某个调用点属于哪一种（那要看它打的是哪个路由），所以它给的是**一份按文件计数的清单**，
 * 不是"这 149 处全是缺陷"。唯一口径 = `api/response.ts` 的 isBizOk()：新代码一律用它，存量按文件棘轮只许变小。
 */
const BIZ_OK_BASELINE = {
  'components/admin/sub/AscensionManagement.vue': 8,
  'components/admin/sub/CompanionConcubineManagement.vue': 6,
  'components/admin/sub/LateStageManagement.vue': 8,
  'components/admin/sub/MultiDungeonManagement.vue': 5,
  'components/admin/sub/StateCleanerMonitor.vue': 4,
  'components/admin/sub/StateLogViewer.vue': 1,
  'components/overlays/DeathOverlay.vue': 1,
  'components/panels/ArtifactSpiritPanel.vue': 4,
  'components/panels/AscensionPanel.vue': 11,
  'components/panels/BeastAbyssPanel.vue': 9,
  'components/panels/DayanPanel.vue': 3,
  'components/panels/DivineSenseDuelPanel.vue': 5,
  'components/panels/ExplorePanel.vue': 1,
  'components/panels/FishingPanel.vue': 17,
  'components/panels/FullMapList.vue': 1,
  'components/panels/GamblingStonePanel.vue': 4,
  'components/panels/InventoryPanel.vue': 1,
  'components/panels/MapPanel.vue': 1,
  'components/panels/MarketPanel.vue': 1,
  'components/panels/MultiDungeonPanel.vue': 6,
  'components/panels/PuppetPanel.vue': 10,
  'components/panels/SecondSoulPanel.vue': 4,
  'components/panels/SmallWorldPanel.vue': 16,
  'components/panels/SpiritBeastPanel.vue': 5,
  'components/panels/TaoismGatePanel.vue': 10,
  'components/panels/TechniquePanel.vue': 6,
  'components/panels/WorldMapPanel.vue': 1
}
const bizOkFailures = []
{
  const seen = new Map()
  for (const { rel: file, text: raw } of allSources) {
    if (file === 'api/response.ts') continue;            // 判定本身住在这里，它是唯一允许写 `code === 200` 的地方
    const n = (codeOnly(raw).match(/\.code\s*[=!]==?\s*200/g) || []).length
    if (n) seen.set(file, n)
  }
  for (const [file, n] of seen) {
    const allowed = BIZ_OK_BASELINE[file]
    if (allowed === undefined) {
      bizOkFailures.push(`${file} 有 ${n} 处按 code 判成败（基线里没有这个文件＝新引入）→ 改用 isBizOk(resp)：业务失败也是 200，只是带 success:false`)
    } else if (n > allowed) {
      bizOkFailures.push(`${file} 从 ${allowed} 处涨到 ${n} 处按 code 判成败 → 新代码一律走 isBizOk(resp)，别把这条棘轮的账再加回去`)
    }
  }
  for (const [file, allowed] of Object.entries(BIZ_OK_BASELINE)) {
    const n = seen.get(file) || 0
    if (!n) bizOkFailures.push(`基线过期：${file} 已经不按 code 判成败了，请把 ${allowed} 这条从 BIZ_OK_BASELINE 删掉`)
    else if (n < allowed) bizOkFailures.push(`基线该变小：${file} 从 ${allowed} 降到 ${n} → 请同步更新 BIZ_OK_BASELINE（棘轮只许往小改）`)
  }
}

/* ───────────────────────── 输出 ───────────────────────── */

const section = (title, items, hard) => {
  console.log(`\n${title}`)
  if (!items.length) { console.log('  ✓ 通过'); return 0 }
  for (const i of items) console.log(`  ${hard ? '✗' : '⚠'} ${i}`)
  console.log(`  ${items.length} 项`)
  return hard ? items.length : 0
}

console.log(`界面层体检 · 注册表内 ${docked.size} 个面板`)
let fail = 0
fail += section('1. 停靠契约（面板必须走 PanelShell 并转发 close）', dockingFailures, true)
fail += section('2. 组件 props 契约（拼错即静默失效）', propViolations, true)
fail += section('4. SFC 可解析', uncompilable, true)
fail += section('5. 模块级文案字典（服务端 meta/schema 才是来源）', labelDicts, true)
fail += section('6. 客户端枚举内容主键（副本/BOSS 清单应由接口给）', contentEnums, true)
fail += section('7. 玩家界面把物品键直接印出来了（名字服务端已随载荷下发）', rawItemKeys, true)
fail += section('8. 面板可达性（ACTIONS ↔ DOCK_TABS ↔ registry ↔ 文件，四环两头对照）', reachabilityFailures, true)
fail += section('9. 把服务端下发的值清单抄成客户端字面量（槽位/物品子类型）', vocabCopies, true)
fail += section('10. 品质字典各面板各抄一份（档名/颜色应由 game_balance.item_qualities 下发）', qualityCopies, true)
fail += section('11. 成就奖励每一项都要在界面露头（名单以服务端 ACHIEVEMENT_REWARD_KEYS 为准）', rewardRenderFailures, true)
fail += section('12. 按 code 判成败（业务失败也是 200 + success:false；唯一口径是 api/response.ts 的 isBizOk，棘轮只许变小）', bizOkFailures, true)
section('3. 主题令牌残留（冷灰/字面色/废弃别名；不判失败，逐项确认后再清）', [...chromeDup, ...palette], false)

console.log(fail ? `\n✗ ${fail} 项破坏性检查未通过` : '\n✓ 破坏性检查全部通过')
process.exit(fail ? 1 : 0)
