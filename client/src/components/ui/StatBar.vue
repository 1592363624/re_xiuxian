<script setup>
/**
 * 进度/数值条
 *
 * 修为、寿元、瓶颈、耐久、熟练度在几十个面板里各画了一份 div 套 div，
 * 高度从 4px 到 10px、圆角从 rounded 到 rounded-full 都有。
 * 数字统一走 formatCompact（见 utils/format 的既有约定）。
 */
import { computed } from 'vue'
import { formatCompact } from '../../utils/format'

const props = defineProps({
  value: { type: [Number, String], default: 0 },
  max: { type: [Number, String], default: 100 },
  label: { type: String, default: '' },
  tone: { type: String, default: 'gold', validator: v => ['gold', 'jade', 'blood', 'azure', 'arcane'].includes(v) },
  /** 数值动画：闭关/战斗轮询时数字跳动不该闪 */
  smooth: { type: Boolean, default: true },
  showValue: { type: Boolean, default: true },
  /** 自定义右侧文案；不传则显示 值 / 上限 */
  text: { type: String, default: '' },
  height: { type: String, default: 'h-1.5' },
})

const TONE = {
  gold: 'bg-gold-500',
  jade: 'bg-emerald-500',
  blood: 'bg-rose-500',
  azure: 'bg-sky-500',
  arcane: 'bg-purple-500',
}

const percent = computed(() => {
  const v = Number(props.value) || 0
  const m = Number(props.max) || 0
  if (m <= 0) return 0
  return Math.max(0, Math.min(100, (v / m) * 100))
})

const display = computed(() => props.text || `${formatCompact(props.value)} / ${formatCompact(props.max)}`)
</script>

<template>
  <div class="w-full">
    <div v-if="label || showValue" class="flex items-baseline justify-between gap-2 mb-1">
      <span v-if="label" class="text-[11px] text-fg-muted truncate">{{ label }}</span>
      <span v-if="showValue" class="text-[11px] text-fg-secondary num shrink-0">{{ display }}</span>
    </div>
    <div
      class="w-full overflow-hidden rounded-full bg-surface-sunken border border-line-subtle"
      :class="height"
      role="progressbar"
      :aria-valuenow="Math.round(percent)"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="label || '进度'"
    >
      <div
        class="h-full rounded-full"
        :class="[TONE[tone], smooth ? 'transition-[width] duration-500 ease-out' : '', percent > 0 && percent < 100 ? 'progress-flow' : '']"
        :style="{ width: percent + '%' }"
      ></div>
    </div>
  </div>
</template>
