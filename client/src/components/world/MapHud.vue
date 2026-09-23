<script setup>
/**
 * 顶栏位置 HUD（L1：任何断点都不可省「我在哪」）
 */
import { computed } from 'vue'

const props = defineProps({
  regionName: { type: String, default: '' },
  zoneName: { type: String, default: '—' },
  cellX: { type: Number, default: 0 },
  cellY: { type: Number, default: 0 },
  visionR: { type: Number, default: 3 },
  moving: { type: Boolean, default: false },
  moveSeconds: { type: Number, default: 0 },
  moveSteps: { type: Number, default: 0 },
  online: { type: Number, default: 0 },
})
const emit = defineEmits(['stop', 'center', 'toggle-log'])

const crumb = computed(() => {
  const parts = [props.regionName || '未知疆域', props.zoneName || '—']
  return parts
})
</script>

<template>
  <div class="h-12 shrink-0 border-b border-line-subtle bg-surface-raised flex items-center gap-2 px-3 text-[12px]">
    <!-- 面包屑 -->
    <div class="flex items-center gap-1.5 min-w-0 text-fg-secondary">
      <span class="text-gold-500 font-bold shrink-0">大地图</span>
      <span class="text-fg-faint">›</span>
      <span class="truncate">{{ crumb[0] }}</span>
      <span class="text-fg-faint">›</span>
      <span class="truncate text-emerald-400">{{ crumb[1] }}</span>
      <span class="text-fg-faint">›</span>
      <span class="num font-bold text-gold-300 shrink-0">({{ cellX }}, {{ cellY }})</span>
    </div>

    <div class="flex-1" />

    <!-- 视野 -->
    <span class="hidden sm:inline px-2 py-0.5 rounded border border-line-subtle text-fg-muted shrink-0">
      神识视野 R={{ visionR }}
    </span>

    <!-- 赶路 -->
    <span
      v-if="moving"
      class="px-2 py-0.5 rounded bg-sky-900/40 border border-sky-700/50 text-sky-300 shrink-0 flex items-center gap-2"
    >
      步行中 · {{ moveSteps }} 格 · 余 {{ moveSeconds }}s
      <button class="px-1.5 py-0.5 rounded bg-surface-hover text-[11px] hover:text-rose-400" @click="emit('stop')">停下</button>
    </span>

    <span class="hidden md:inline text-sky-400 shrink-0">同图 {{ online }} 人</span>

    <button
      class="px-2 py-1 rounded border border-line-subtle text-fg-muted hover:text-gold-500 shrink-0"
      title="镜头回中"
      @click="emit('center')"
    >回中</button>
    <button
      class="px-2 py-1 rounded border border-line-subtle text-fg-muted hover:text-gold-500 shrink-0"
      title="开关修仙录竖条"
      @click="emit('toggle-log')"
    >日志</button>
  </div>
</template>
