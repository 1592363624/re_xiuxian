<script setup>
/**
 * 可检索内容选择器（GM 后台专用）
 *
 * 交互：表单里只放一个紧凑触发器；点开后弹出**独立大面板**（Teleport 到 body），
 * 不在表单格子里内联展开 —— 之前那种做法在「编辑玩家」双列表单里会被挤成一条缝，
 * 根本没法扫境界/物品列表。
 *
 * 面板能力：关键词搜索（名称/ID/元信息）+ 列表/平铺切换 + 分组筛选。
 * 选项形状：{ value, label, meta?, group?, color? }
 */
import { computed, nextTick, ref, watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '点击选择…' },
  searchPlaceholder: { type: String, default: '搜索名称 / ID / 关键词…' },
  /** 弹层标题 */
  title: { type: String, default: '选择内容' },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  allowEmpty: { type: Boolean, default: true },
  emptyLabel: { type: String, default: '（空）' },
  /** 内容区最小高度，保证列表够高好扫 */
  listHeight: { type: Number, default: 360 },
  id: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'change', 'open', 'close'])

const open = ref(false)
const query = ref('')
const viewMode = ref('list')
const activeGroup = ref('')
const searchRef = ref(null)
const listRef = ref(null)
const highlightIndex = ref(0)

const selectedOption = computed(() =>
  props.options.find(o => String(o.value) === String(props.modelValue)) || null
)

const groups = computed(() => {
  const set = []
  for (const opt of props.options) {
    const g = opt.group || ''
    if (g && !set.includes(g)) set.push(g)
  }
  return set
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return props.options.filter(opt => {
    if (activeGroup.value && (opt.group || '') !== activeGroup.value) return false
    if (!q) return true
    const hay = [opt.label, opt.value, opt.meta, opt.group]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
})

const displayLabel = computed(() => {
  if (selectedOption.value) return selectedOption.value.label
  if (props.modelValue) return props.modelValue
  return ''
})

const displayMeta = computed(() => selectedOption.value?.meta || (props.modelValue || ''))

function scrollHighlightIntoView() {
  nextTick(() => {
    const root = listRef.value
    if (!root) return
    const el = root.querySelector(`[data-idx="${highlightIndex.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function openPicker() {
  if (props.disabled || props.loading) return
  open.value = true
  query.value = ''
  activeGroup.value = ''
  const idx = filtered.value.findIndex(o => String(o.value) === String(props.modelValue))
  highlightIndex.value = idx >= 0 ? idx : 0
  emit('open')
  nextTick(() => {
    searchRef.value?.focus()
    scrollHighlightIntoView()
  })
}

function closePicker() {
  if (!open.value) return
  open.value = false
  emit('close')
}

function selectOption(opt) {
  emit('update:modelValue', String(opt.value))
  emit('change', opt)
  closePicker()
}

function clearValue() {
  emit('update:modelValue', '')
  emit('change', null)
}

function selectEmpty() {
  emit('update:modelValue', '')
  emit('change', null)
  closePicker()
}

function moveHighlight(delta) {
  const list = filtered.value
  if (!list.length) return
  let next = highlightIndex.value + delta
  if (next < 0) next = list.length - 1
  if (next >= list.length) next = 0
  highlightIndex.value = next
  scrollHighlightIntoView()
}

function onKeydown(e) {
  if (!open.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    closePicker()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveHighlight(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveHighlight(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const opt = filtered.value[highlightIndex.value]
    if (opt) selectOption(opt)
  }
}

function onGlobalKeydown(e) {
  if (!open.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closePicker()
  }
}

watch(filtered, () => {
  if (highlightIndex.value >= filtered.value.length) highlightIndex.value = 0
})

watch(open, (v) => {
  if (v) document.addEventListener('keydown', onGlobalKeydown, true)
  else document.removeEventListener('keydown', onGlobalKeydown, true)
})

onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKeydown, true))
</script>

<template>
  <!-- 触发器：始终单行紧凑，不撑破表单 -->
  <button
    type="button"
    :id="id"
    :disabled="disabled || loading"
    class="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-left bg-surface-sunken border rounded-control transition-colors focus-ring min-h-[34px]"
    :class="open ? 'border-gold-600' : 'border-line hover:border-line-strong focus:border-gold-600'"
    @click="openPicker"
  >
    <span v-if="loading" class="inline-block w-3 h-3 rounded-full border border-fg-muted border-t-transparent animate-spin shrink-0"></span>
    <span v-else class="flex-1 min-w-0">
      <span v-if="displayLabel" class="block truncate text-fg-secondary leading-tight">{{ displayLabel }}</span>
      <span v-else class="block truncate text-fg-faint leading-tight">{{ placeholder }}</span>
      <span v-if="displayLabel && displayMeta && displayMeta !== displayLabel" class="block truncate text-[11px] text-fg-faint num leading-tight">{{ displayMeta }}</span>
    </span>
    <span
      v-if="clearable && modelValue && !disabled && !loading"
      role="button"
      tabindex="0"
      class="shrink-0 w-5 h-5 grid place-items-center rounded text-fg-faint hover:text-fg-primary hover:bg-surface-hover"
      title="清除"
      @click.stop="clearValue"
      @keydown.enter.stop="clearValue"
    >×</span>
    <svg class="shrink-0 w-3.5 h-3.5 text-fg-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
    </svg>
  </button>

  <!-- 选择大面板：Teleport 到 body，盖住底层编辑弹窗，不跟表单抢空间 -->
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-toast flex items-center justify-center p-4"
      @keydown="onKeydown"
    >
      <div class="absolute inset-0 bg-black/75" aria-hidden="true" @click="closePicker"></div>

      <div
        class="relative w-full max-w-3xl max-h-[88vh] flex flex-col bg-surface-base border border-line rounded-panel shadow-2xl"
        role="dialog"
        :aria-label="title"
      >
        <!-- 头部 -->
        <div class="px-5 py-3.5 border-b border-line-subtle flex items-center gap-3 shrink-0">
          <h3 class="text-base font-bold text-fg-primary font-display tracking-wide flex-1 min-w-0 truncate">{{ title }}</h3>
          <span class="text-xs text-fg-faint num shrink-0">{{ filtered.length }} / {{ options.length }}</span>
          <button
            type="button"
            class="focus-ring w-8 h-8 grid place-items-center rounded text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors shrink-0"
            aria-label="关闭"
            title="关闭"
            @click="closePicker"
          >✕</button>
        </div>

        <!-- 工具栏：搜索 + 视图 + 分组 -->
        <div class="px-5 py-3 border-b border-line-subtle space-y-2.5 shrink-0">
          <input
            ref="searchRef"
            v-model="query"
            type="text"
            class="w-full px-3 py-2.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-primary placeholder:text-fg-faint focus-ring focus:border-gold-600"
            :placeholder="searchPlaceholder"
          >
          <div class="flex items-center gap-2 flex-wrap">
            <div class="flex items-center rounded-control border border-line overflow-hidden shrink-0">
              <button
                type="button"
                class="px-3 py-1.5 text-xs transition-colors"
                :class="viewMode === 'list' ? 'bg-gold-500/15 text-gold-500 font-medium' : 'text-fg-faint hover:text-fg-secondary hover:bg-surface-hover'"
                @click="viewMode = 'list'"
              >列表</button>
              <button
                type="button"
                class="px-3 py-1.5 text-xs transition-colors border-l border-line"
                :class="viewMode === 'grid' ? 'bg-gold-500/15 text-gold-500 font-medium' : 'text-fg-faint hover:text-fg-secondary hover:bg-surface-hover'"
                @click="viewMode = 'grid'"
              >平铺</button>
            </div>
            <button
              v-if="allowEmpty"
              type="button"
              class="px-2.5 py-1.5 text-xs rounded-control border border-line text-fg-faint hover:text-fg-secondary hover:bg-surface-hover transition-colors"
              @click="selectEmpty"
            >{{ emptyLabel }}</button>
            <div class="flex-1"></div>
            <span class="text-[11px] text-fg-faint">↑↓ 选择 · Enter 确定 · Esc 关闭</span>
          </div>
          <div v-if="groups.length" class="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              class="px-2.5 py-1 text-xs rounded-full border transition-colors"
              :class="!activeGroup ? 'border-gold-600 text-gold-500 bg-gold-500/10' : 'border-line text-fg-faint hover:text-fg-secondary hover:bg-surface-hover'"
              @click="activeGroup = ''"
            >全部</button>
            <button
              v-for="g in groups"
              :key="g"
              type="button"
              class="px-2.5 py-1 text-xs rounded-full border transition-colors"
              :class="activeGroup === g ? 'border-gold-600 text-gold-500 bg-gold-500/10' : 'border-line text-fg-faint hover:text-fg-secondary hover:bg-surface-hover'"
              @click="activeGroup = g"
            >{{ g }}</button>
          </div>
        </div>

        <!-- 内容区：够高、可滚，方便扫全部 -->
        <div
          ref="listRef"
          class="flex-1 min-h-0 overflow-y-auto scroll-thin"
          :style="{ minHeight: Math.min(listHeight, 420) + 'px', maxHeight: '62vh' }"
        >
          <!-- 列表 -->
          <div v-if="viewMode === 'list'">
            <button
              v-for="(opt, i) in filtered"
              :key="String(opt.value)"
              :data-idx="i"
              type="button"
              class="w-full text-left px-5 py-2.5 transition-colors border-b border-line-subtle/50 last:border-b-0 flex items-center gap-3"
              :class="[
                i === highlightIndex ? 'bg-gold-500/10' : 'hover:bg-surface-hover',
                String(opt.value) === String(modelValue) ? 'text-gold-500' : 'text-fg-secondary'
              ]"
              @mouseenter="highlightIndex = i"
              @click="selectOption(opt)"
            >
              <span
                v-if="opt.color"
                class="w-2.5 h-2.5 rounded-full shrink-0"
                :style="{ backgroundColor: opt.color }"
              ></span>
              <span class="flex-1 min-w-0">
                <span class="block text-sm leading-snug truncate">{{ opt.label }}</span>
                <span v-if="opt.meta && opt.meta !== opt.label" class="block text-xs text-fg-faint num truncate mt-0.5">{{ opt.meta }}</span>
              </span>
              <span v-if="opt.group" class="text-[11px] text-fg-faint shrink-0 px-1.5 py-0.5 rounded bg-surface-sunken">{{ opt.group }}</span>
              <span
                v-if="String(opt.value) === String(modelValue)"
                class="text-[11px] text-gold-500 shrink-0"
              >当前</span>
            </button>
          </div>

          <!-- 平铺：一眼扫完，卡片更大更好点 -->
          <div v-else class="p-3">
            <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              <button
                v-for="opt in filtered"
                :key="String(opt.value)"
                type="button"
                class="text-left px-3 py-2.5 rounded-control border transition-colors min-w-0"
                :class="String(opt.value) === String(modelValue)
                  ? 'border-gold-600 bg-gold-500/15 text-gold-500 shadow-sm'
                  : 'border-line bg-surface-sunken text-fg-secondary hover:border-line-strong hover:bg-surface-hover'"
                @click="selectOption(opt)"
              >
                <div class="flex items-center gap-1.5 min-w-0">
                  <span
                    v-if="opt.color"
                    class="w-2 h-2 rounded-full shrink-0"
                    :style="{ backgroundColor: opt.color }"
                  ></span>
                  <span class="text-sm font-medium truncate leading-snug">{{ opt.label }}</span>
                </div>
                <div class="text-[11px] text-fg-faint num truncate mt-1">{{ opt.meta || opt.value }}</div>
                <div v-if="opt.group" class="text-[10px] text-fg-faint mt-1 truncate">{{ opt.group }}</div>
              </button>
            </div>
          </div>

          <div v-if="!filtered.length" class="px-5 py-16 text-center text-sm text-fg-faint">
            无匹配内容{{ query ? `（关键词：${query}）` : '' }}
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
