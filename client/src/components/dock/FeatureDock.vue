<template>
  <!-- 三栏在 1280px 以下放不下（角色 288 + 日志 560 + 坞 400），
       因此 xl 起才启用右坞，更窄的屏退回底部操作条 + 全屏 modal。 -->
  <aside class="hidden xl:flex flex-col flex-1 min-w-[400px] border-l border-line-subtle bg-surface-canvas shrink-0">
    <!-- 分类标签：全部带文字，不再出现纯图标导航 -->
    <div class="shrink-0 flex flex-wrap gap-x-1 gap-y-0.5 px-2 pt-2 pb-1.5 border-b border-line-subtle bg-surface-base" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="selectTab(tab.key)"
        role="tab"
        :aria-selected="activeTab === tab.key"
        class="px-2.5 py-1 rounded text-[13px] tracking-wider transition-colors border"
        :class="activeTab === tab.key
          ? 'bg-gold-900/40 border-gold-700/60 text-gold-200 font-bold'
          : 'border-transparent text-fg-muted hover:text-gold-500 hover:bg-surface-raised'"
      >{{ tab.label }}</button>
    </div>

    <!-- 面板停靠面：42 个功能面板在桌面端定位到这一块，而不是盖住整个视口 -->
    <div ref="surfaceRef" class="dock-surface relative flex-1 min-h-0 overflow-hidden">
      <div v-show="!openPanelId" class="absolute inset-0 overflow-y-auto scroll-thin p-3">
        <!-- 坞体本身不设上限（停靠的功能面板要吃到宽度），但卡片视图自限宽避免被拉散 -->
        <div class="max-w-dock mx-auto">
        <OverviewPane
          v-if="activeTab === 'overview'"
          :player="player"
          @action="$emit('action', $event)"
        >
          <template #status><slot name="status" /></template>
        </OverviewPane>

        <div v-else>
          <h3 class="text-[11px] text-fg-faint tracking-[0.2em] mb-2.5 font-display">{{ activeTabLabel }} · 共 {{ activeEntries.length }} 项</h3>
          <div class="grid grid-cols-2 2xl:grid-cols-3 gap-2">
            <button
              v-for="entry in activeEntries"
              :key="entry.id"
              @click="$emit('action', entry.id)"
              class="group flex items-start gap-2.5 p-2.5 rounded-lg bg-surface-raised border border-line-subtle text-left transition-all duration-200
                     hover:border-line-strong hover:bg-surface-hover active:scale-[0.98]"
            >
              <span class="shrink-0 mt-0.5 transition-transform duration-200 group-hover:scale-110" v-html="entry.icon"></span>
              <span class="min-w-0">
                <span class="block text-[13px] font-bold text-fg-primary tracking-wide group-hover:text-gold-500 transition-colors truncate">{{ entry.name }}</span>
                <span class="block text-[11px] text-fg-faint leading-snug mt-0.5">{{ entry.desc }}</span>
              </span>
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
/**
 * 右坞：分类导航 + 功能卡片 + 面板停靠容器
 *
 * 面板本体仍然渲染在 GameLayout 里（保持移动端的全屏 modal 行为不变），
 * 桌面端由下面的 ResizeObserver 把停靠面矩形发布成 CSS 变量，
 * .panel-shell 在 md+ 读取这些变量改坐标 —— 因此 42 个面板只需加一个类名。
 */
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from 'vue'
import { ACTIONS, DOCK_TABS, resolveAction } from '../../data/actionCatalog'
import OverviewPane from './OverviewPane.vue'

const props = defineProps({
  player: { type: Object, default: null },
  openPanelId: { type: String, default: null }
})
defineEmits(['action'])

const tabs = [{ key: 'overview', label: '总览' }, ...DOCK_TABS]

const activeTab = ref('overview')
const activeTabLabel = computed(() => tabs.find(t => t.key === activeTab.value)?.label ?? '')
const activeEntries = computed(() => {
  const tab = DOCK_TABS.find(t => t.key === activeTab.value)
  return tab ? tab.ids.map(resolveAction).filter(Boolean) : []
})

const ungroupedActionIds = computed(() => {
  const grouped = new Set(DOCK_TABS.flatMap(t => t.ids))
  return Object.keys(ACTIONS).filter(id => !grouped.has(id))
})
// 目录里定义了却没归类的 id 会在任何导航里都看不到，这里显式告警
watchEffect(() => {
  if (ungroupedActionIds.value.length) {
    console.warn('[FeatureDock] 以下 action 已定义但未归入任何分类:', ungroupedActionIds.value)
  }
})

const surfaceRef = ref(null)
const selectTab = (key) => { activeTab.value = key }

/* ── 发布停靠面矩形给 .panel-shell ── */
const publishSurfaceRect = () => {
  const el = surfaceRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.width === 0) return
  const style = document.documentElement.style
  style.setProperty('--dock-left', `${rect.left}px`)
  style.setProperty('--dock-top', `${rect.top}px`)
  style.setProperty('--dock-width', `${rect.width}px`)
  style.setProperty('--dock-height', `${rect.height}px`)
}

let observer = null
onMounted(async () => {
  await nextTick()
  publishSurfaceRect()
  if (surfaceRef.value && 'ResizeObserver' in window) {
    observer = new ResizeObserver(publishSurfaceRect)
    observer.observe(surfaceRef.value)
  }
  window.addEventListener('resize', publishSurfaceRect)
})
onUnmounted(() => {
  observer?.disconnect()
  window.removeEventListener('resize', publishSurfaceRect)
})
watch(() => props.openPanelId, publishSurfaceRect)
</script>

