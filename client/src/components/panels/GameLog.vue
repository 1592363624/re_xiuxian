<script setup>
/**
 * 游戏日志流
 *
 * 文游的主界面就是这一栏字。此前它用 font-mono 排版，而 mono 字体没有
 * CJK 字形，中文逐字回退到宋体，整栏字距忽宽忽窄；类型样式还散在两份
 * switch 里（一份管边框、一份管字色），没登记过的类型静默掉回普通灰字。
 *
 * 现在正文走 UI 字体 + 中文换行策略，类型样式统一由 data/logTypes.js 给。
 */
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useUIStore } from '../../stores/ui'
import { resolveLogKind, LOG_LABELLED } from '../../data/logTypes'

const uiStore = useUIStore()

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'self', label: '我的' },
  { key: 'system', label: '系统' },
]

const filterMode = ref('all')
const logContainer = ref(null)

// 玩家往上翻记录时暂停跟随，避免新日志把阅读位置强行拽回底部
const atBottom = ref(true)
const hasNewBelow = ref(false)

const onLogScroll = (e) => {
  const el = e.currentTarget
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  if (atBottom.value) hasNewBelow.value = false
}

const jumpToLatest = () => {
  const el = logContainer.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  atBottom.value = true
  hasNewBelow.value = false
}

watch(() => uiStore.logs.length, () => {
  if (!atBottom.value) {
    hasNewBelow.value = true
    return
  }
  nextTick(jumpToLatest)
})

// 「全部」= 我的动作 + 其他道友的世界动态 + 系统播报
// 「我的」只看自己发起的动作（前端以 actorId='self' 标记）
// 「系统」同时收 system 与 notice，两者都是全服播报
// 他人动态（source='world'）只进「全部」，不靠 isImportant 闯进「我的」
const filteredLogs = computed(() =>
  uiStore.logs.filter(log => {
    if (filterMode.value === 'all') return true
    if (log.source === 'world') return false
    if (log.isImportant) return true
    if (filterMode.value === 'self') return log.actorId === 'self'
    if (filterMode.value === 'system') return log.type === 'system' || log.type === 'notice'
    return true
  })
)

const styleOf = (type) => resolveLogKind(type)
const labelled = (type) => LOG_LABELLED.has(type)

/** 他人世界动态：暗淡 + 「道友」前缀；自己的动作保持类型高亮 */
const isOther = (log) => log.source === 'world'

onMounted(() => {
  if (uiStore.logs.length === 0) {
    uiStore.addLog({
      content: '欢迎来到凡人修仙传的世界！道友请开始你的修仙之旅。',
      type: 'system',
      isImportant: true
    })
  }
  nextTick(jumpToLatest)
})
</script>

<template>
  <!-- 窄阅读栏：限宽并贴左锚定，避免一行字横跨整个视口 -->
  <div class="flex-1 w-full max-w-[680px] mr-2 ml-0 md:ml-2 my-1 flex flex-col bg-surface-canvas overflow-hidden relative min-h-[200px] border border-line-subtle rounded-panel">
    <div
      ref="logContainer"
      @scroll="onLogScroll"
      class="scroll-thin flex-1 overflow-y-auto relative scroll-smooth"
      role="log"
      aria-live="polite"
      aria-label="修仙日志"
    >
      <div class="flex flex-col gap-0.5 px-2 py-2 relative z-10">
        <TransitionGroup name="scroll">
          <div
            v-for="log in filteredLogs"
            :key="log.id"
            class="group flex items-start gap-2 px-2 py-1 rounded-control border-l-2 wrap-cjk transition-colors"
            :class="[
              isOther(log) ? 'border-l-stone-700/50 hover:bg-surface-base/40' : [styleOf(log.type).accent, 'hover:bg-surface-base'],
              isOther(log) ? 'opacity-70' : ''
            ]"
          >
            <span class="text-fg-faint text-[10px] mt-[3px] num shrink-0 opacity-70 group-hover:opacity-100">{{ log.time }}</span>

            <!-- 他人动态固定「道友」前缀，一眼和自己的亮色日志分开 -->
            <span
              v-if="isOther(log)"
              class="shrink-0 mt-[1px] px-1 rounded text-[10px] leading-[16px] border border-stone-700/60 text-stone-400 bg-stone-900/40"
            >道友</span>

            <!-- 只在关键类型前行首打标签，普通叙述满屏徽标反而读不动；他人动态已用「道友」占位，不再叠类型徽标 -->
            <span
              v-if="labelled(log.type) && !isOther(log)"
              class="shrink-0 mt-[1px] px-1 rounded text-[10px] leading-[16px] border"
              :class="[styleOf(log.type).text, styleOf(log.type).accent]"
            >{{ styleOf(log.type).label }}</span>

            <!-- 他人：道号 + 正文整体压暗；自己：类型色全亮 -->
            <span
              v-if="isOther(log)"
              class="text-[13px] leading-[1.7] min-w-0 text-stone-400/90"
              :class="log.isImportant ? 'font-medium' : ''"
            >
              <span class="text-stone-300/80">{{ log.actorName || '某位道友' }}</span>
              <span class="text-stone-500/80 mx-0.5">·</span>
              <span>{{ log.content }}</span>
            </span>
            <span
              v-else
              class="text-[13px] leading-[1.7] min-w-0"
              :class="[
                styleOf(log.type).text,
                log.isImportant ? 'font-bold' : '',
                log.divider ? 'text-fg-faint italic text-[11px]' : ''
              ]"
            >{{ log.content }}</span>
          </div>
        </TransitionGroup>

        <div v-if="filteredLogs.length === 0" class="text-fg-faint text-center mt-20 text-[13px]">
          暂无相关日志
        </div>
      </div>
    </div>

    <!-- 上翻阅读时提示有新日志，点击回到底部 -->
    <button
      v-if="hasNewBelow"
      @click="jumpToLatest"
      class="focus-ring absolute bottom-4 left-3 z-nav px-3 py-1.5 rounded-full bg-gold-900/90 border border-gold-700 text-gold-200 text-xs shadow-lg hover:bg-gold-800 transition-colors"
    >
      有新日志 · 回到底部
    </button>

    <!-- 阅读过滤器：浮在右下角，不占正文行高 -->
    <div class="absolute bottom-3 right-3 z-nav flex items-center gap-0.5 p-0.5 rounded-full bg-surface-base/90 border border-line-subtle backdrop-blur-sm">
      <button
        v-for="f in FILTERS"
        :key="f.key"
        @click="filterMode = f.key"
        class="focus-ring px-2.5 py-1 rounded-full text-[11px] tracking-wide transition-colors"
        :class="filterMode === f.key
          ? 'bg-gold-800/80 text-gold-100 font-bold'
          : 'text-fg-muted hover:text-fg-secondary'"
        :aria-pressed="filterMode === f.key"
      >{{ f.label }}</button>
    </div>
  </div>
</template>
