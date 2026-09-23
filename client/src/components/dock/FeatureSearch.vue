<script setup>
/**
 * 功能搜索
 *
 * 为什么要有它：目录里有 48 个功能入口、分 10 个分类页签。玩家想知道"那个能切石头的
 * 玩意儿在哪"，只能一个个点分类页签翻 —— 而分类名（修行/历练/征伐/经营/养成/境界/
 * 宗门/红尘/闲趣/自身）是本项目自己的黑话，新玩家第一遍根本猜不到赌石在「闲趣」、
 * 阵法在「养成」。
 *
 * 清单只认 actionCatalog 这一份真相（ACTIONS + DOCK_TABS），这里不抄第二份：
 * 抄了就必然漂移 —— 与 ui-check 第 6/8 项盯的是同一类问题。
 * 因此新增玩法只要在目录里登记过，就自动能被搜到。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ACTIONS, DOCK_TABS } from '../../data/actionCatalog'

const emit = defineEmits(['open'])

/** id → 分类中文名，用来支持"按分类搜"（输入「经营」能列出经营下全部入口） */
const TAB_LABEL_BY_ID = (() => {
  const m = new Map()
  for (const tab of DOCK_TABS) for (const id of tab.ids) m.set(id, tab.label)
  return m
})()

const ENTRIES = Object.entries(ACTIONS).map(([id, meta]) => ({
  id,
  name: meta.name || '',
  desc: meta.desc || '',
  tab: TAB_LABEL_BY_ID.get(id) || '',
  /** 一次拼好待匹配的小写串，避免每敲一个字对 48 条各拼一遍 */
  hay: `${meta.name || ''} ${meta.desc || ''} ${TAB_LABEL_BY_ID.get(id) || ''} ${id}`.toLowerCase(),
}))

const query = ref('')
const open = ref(false)
const cursor = ref(0)
const inputEl = ref(null)
const listEl = ref(null)

/**
 * 名称命中排在说明命中前面：搜"拍卖"要先看到「拍卖」，
 * 而不是某个说明里恰好有"拍卖"两个字的功能。
 */
const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const e of ENTRIES) {
    const name = e.name.toLowerCase()
    const desc = e.desc.toLowerCase()
    const tab = e.tab.toLowerCase()
    let score = -1
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else if (tab.includes(q)) score = 3
    else if (desc.includes(q)) score = 4
    else if (e.hay.includes(q)) score = 5
    if (score >= 0) scored.push({ e, score })
  }
  return scored.sort((a, b) => a.score - b.score || a.e.name.length - b.e.name.length)
    .slice(0, 12)
    .map(x => x.e)
})

watch(results, () => { cursor.value = 0 })
watch(query, () => { open.value = !!query.value.trim() })

const pick = (entry) => {
  if (!entry) return
  emit('open', entry.id)
  query.value = ''
  open.value = false
  inputEl.value?.blur()
}

const move = (delta) => {
  if (!results.value.length) return
  cursor.value = (cursor.value + delta + results.value.length) % results.value.length
  nextTick(() => {
    const el = listEl.value?.children?.[cursor.value]
    el?.scrollIntoView({ block: 'nearest' })
  })
}

const onKeydown = (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); pick(results.value[cursor.value]) }
  else if (e.key === 'Escape') { open.value = false; query.value = ''; inputEl.value?.blur() }
}

/** 全局「/」聚焦搜索。正在输入的地方不抢焦点。 */
const onGlobalKey = (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
  const t = e.target
  const tag = t?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
  e.preventDefault()
  inputEl.value?.focus()
  if (query.value.trim()) open.value = true
}

onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

const closeLater = () => setTimeout(() => { open.value = false }, 120)
</script>

<template>
  <div class="relative shrink-0 px-2 pt-2 border-b border-line-subtle bg-surface-base">
    <div class="flex items-center gap-2">
      <div class="relative flex-1 min-w-0">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none" aria-hidden="true">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
        </svg>
        <input
          ref="inputEl"
          v-model="query"
          type="search"
          role="searchbox"
          aria-label="搜索功能"
          aria-autocomplete="list"
          aria-controls="feature-search-results"
          :aria-expanded="open ? 'true' : 'false'"
          placeholder="搜索功能…"
          @keydown="onKeydown"
          @focus="open = !!query.trim()"
          @blur="closeLater"
          class="focus-ring w-full pl-8 pr-8 py-1.5 rounded-control bg-surface-canvas border border-line-subtle text-[13px] text-fg-primary placeholder:text-fg-faint"
        />
        <kbd class="absolute right-2 top-1/2 -translate-y-1/2 px-1 rounded border border-line text-[10px] text-fg-faint pointer-events-none" aria-hidden="true">/</kbd>
      </div>
    </div>

    <ul
      v-if="open && results.length"
      id="feature-search-results"
      ref="listEl"
      role="listbox"
      aria-label="搜索结果"
      class="absolute left-2 right-2 z-panel mt-1 max-h-72 overflow-y-auto scroll-thin rounded-panel border border-line bg-surface-raised shadow-2xl shadow-black/60 py-1"
    >
      <li
        v-for="(r, i) in results"
        :key="r.id"
        role="option"
        :aria-selected="i === cursor"
        @mousedown.prevent="pick(r)"
        @mouseenter="cursor = i"
        class="px-3 py-2 cursor-pointer"
        :class="i === cursor ? 'bg-gold-900/40' : ''"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-[13px] font-bold text-fg-primary truncate">{{ r.name }}</span>
          <span class="text-[10px] text-fg-faint shrink-0">{{ r.tab || '未分类' }}</span>
        </div>
        <div v-if="r.desc" class="text-[11px] text-fg-muted leading-snug mt-0.5">{{ r.desc }}</div>
      </li>
    </ul>

    <div
      v-else-if="open && query.trim()"
      class="absolute left-2 right-2 z-panel mt-1 rounded-panel border border-line bg-surface-raised shadow-xl px-3 py-2.5 text-[12px] text-fg-muted"
    >
      没找到叫「{{ query.trim() }}」的功能。可以试试分类名：{{ DOCK_TABS.map(t => t.label).join('、') }}
    </div>
  </div>
</template>
