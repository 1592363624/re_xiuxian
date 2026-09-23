<script setup>
/**
 * 全站按钮
 *
 * 此前每个面板自己发明按钮：同一层级的「确认」在坊市是 amber 实心、
 * 在当铺是 stone 描边、在股市是渐变。变体收在这里之后，
 * primary 恒为鎏金、danger 恒为血光，跨面板语义不再漂移。
 */
import { computed } from 'vue'

const props = defineProps({
  variant: { type: String, default: 'default', validator: v => ['default', 'primary', 'danger', 'ghost', 'outline'].includes(v) },
  size: { type: String, default: 'md', validator: v => ['xs', 'sm', 'md', 'lg'].includes(v) },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  block: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
  title: { type: String, default: '' },
})

const SIZE = {
  xs: 'px-2 py-1 text-[11px] gap-1',
  sm: 'px-2.5 py-1.5 text-xs gap-1.5',
  md: 'px-3.5 py-2 text-[13px] gap-2',
  lg: 'px-5 py-2.5 text-sm gap-2',
}

const VARIANT = {
  default: 'bg-surface-hover hover:bg-surface-active border border-line text-fg-secondary hover:text-fg-primary',
  primary: 'bg-gold-600 hover:bg-gold-500 border border-gold-500 text-surface-sunken font-bold shadow-md shadow-gold-900/30',
  danger: 'bg-rose-900/50 hover:bg-rose-800/70 border border-rose-800 text-rose-200 hover:text-rose-100',
  ghost: 'bg-transparent hover:bg-surface-hover border border-transparent text-fg-muted hover:text-gold-500',
  outline: 'bg-transparent hover:bg-surface-hover border border-line hover:border-line-strong text-fg-secondary hover:text-fg-primary',
}

const classes = computed(() => [
  'inline-flex items-center justify-center rounded-control transition-colors select-none whitespace-nowrap',
  // 禁用时掐掉指针事件，否则 hover 规则仍会点亮一个按不动的按钮
  'focus-ring disabled:pointer-events-none disabled:opacity-40 disabled:saturate-50',
  SIZE[props.size],
  VARIANT[props.variant],
  props.block ? 'w-full' : '',
])

const isOff = computed(() => props.disabled || props.loading)
</script>

<template>
  <button :type="type" :disabled="isOff" :class="classes" :title="title" :aria-busy="loading || undefined">
    <span
      v-if="loading"
      class="inline-block w-3 h-3 rounded-full border border-current border-t-transparent animate-spin shrink-0"
      aria-hidden="true"
    ></span>
    <slot v-else name="icon" />
    <slot />
  </button>
</template>
