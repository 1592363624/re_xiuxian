<script setup>
/**
 * 全站按钮
 *
 * 此前每个面板自己发明按钮：同一层级的「确认」在坊市是 amber 实心、
 * 在当铺是 stone 描边、在股市是渐变。变体收在这里之后，
 * primary 恒为鎏金、danger 恒为血光，跨面板语义不再漂移。
 *
 * hint：禁用原因 / 操作说明写在按钮下方，不要塞进 CTA 文案
 * （长句会把底栏主按钮撑成一行小作文，扫一眼找不到「点哪里」）。
 */
import { computed, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  variant: { type: String, default: 'default', validator: v => ['default', 'primary', 'danger', 'ghost', 'outline', 'cyan', 'purple'].includes(v) },
  size: { type: String, default: 'md', validator: v => ['xs', 'sm', 'md'].includes(v) },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  block: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
  title: { type: String, default: '' },
  /** 操作说明 / 禁用原因，渲染在按钮下方一行 */
  hint: { type: String, default: '' },
})

const emit = defineEmits(['click'])
const attrs = useAttrs()

const SIZE = {
  xs: 'px-2 py-1 text-[11px] gap-1',
  sm: 'px-2.5 py-1.5 text-xs gap-1.5',
  md: 'px-3.5 py-2 text-[13px] gap-2',
}

const VARIANT = {
  default: 'bg-surface-hover hover:bg-surface-active border border-line text-fg-secondary hover:text-fg-primary',
  primary: 'bg-gold-600 hover:bg-gold-500 border border-gold-500 text-surface-sunken font-bold shadow-md shadow-gold-900/30',
  danger: 'bg-rose-900/50 hover:bg-rose-800/70 border border-rose-800 text-rose-200 hover:text-rose-100',
  ghost: 'bg-transparent hover:bg-surface-hover border border-transparent text-fg-muted hover:text-gold-500',
  outline: 'bg-transparent hover:bg-surface-hover border border-line hover:border-line-strong text-fg-secondary hover:text-fg-primary',
  cyan: 'bg-cyan-950/40 hover:bg-cyan-900/40 border border-cyan-700 text-cyan-300 hover:border-cyan-500',
  purple: 'bg-purple-950/40 hover:bg-purple-900/40 border border-purple-700 text-purple-300 hover:border-purple-500',
}

const classes = computed(() => [
  'inline-flex items-center justify-center rounded-control transition-colors select-none whitespace-nowrap',
  'focus-ring disabled:pointer-events-none disabled:opacity-40 disabled:saturate-50',
  SIZE[props.size],
  VARIANT[props.variant] || VARIANT.default,
  props.block ? 'w-full' : '',
])

const isOff = computed(() => props.disabled || props.loading)

/** class 留在容器上（flex-1 / 外边距）；onClick 不进 attrs，避免 emit 与透传双触发 */
const wrapperClass = computed(() => [attrs.class, props.block ? 'w-full' : ''])
const buttonAttrs = computed(() => {
  const { class: _c, onClick: _oc, ...rest } = attrs
  return rest
})

const onClick = (e) => {
  if (isOff.value) return
  emit('click', e)
}
</script>

<template>
  <div class="inline-flex flex-col gap-1 min-w-0" :class="wrapperClass">
    <button
      :type="type"
      :disabled="isOff"
      :class="classes"
      :title="title || hint || undefined"
      :aria-busy="loading || undefined"
      v-bind="buttonAttrs"
      @click="onClick"
    >
      <span
        v-if="loading"
        class="inline-block w-3 h-3 rounded-full border border-current border-t-transparent animate-spin shrink-0"
        aria-hidden="true"
      ></span>
      <slot v-else name="icon" />
      <slot />
    </button>
    <p
      v-if="hint"
      class="text-[11px] leading-snug text-fg-faint"
      :class="block ? 'text-center px-1' : ''"
      aria-live="polite"
    >{{ hint }}</p>
  </div>
</template>
