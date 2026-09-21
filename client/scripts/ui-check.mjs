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
    const CONTENT_ENUM_EXEMPTIONS = new Map()
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
section('3. 主题令牌残留（冷灰/字面色/废弃别名；不判失败，逐项确认后再清）', [...chromeDup, ...palette], false)

console.log(fail ? `\n✗ ${fail} 项破坏性检查未通过` : '\n✓ 破坏性检查全部通过')
process.exit(fail ? 1 : 0)
