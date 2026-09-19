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
section('3. 主题令牌残留（冷灰/字面色/废弃别名；不判失败，逐项确认后再清）', [...chromeDup, ...palette], false)

console.log(fail ? `\n✗ ${fail} 项破坏性检查未通过` : '\n✓ 破坏性检查全部通过')
process.exit(fail ? 1 : 0)
