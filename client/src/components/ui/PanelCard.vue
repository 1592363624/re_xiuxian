<script setup>
defineProps({
  title: { type: String, default: '' },
  hint: { type: String, default: '' },
  /** 强调卡：左侧鎏金标记，用于「当前选中 / 重点提示」 */
  tone: { type: String, default: 'plain', validator: v => ['plain', 'gold', 'success', 'danger', 'muted'].includes(v) },
  padded: { type: Boolean, default: true },
})
</script>

<template>
  <div
    class="rounded-panel border bg-surface-raised"
    :class="{
      'border-line': tone === 'plain',
      'border-gold-700/60 bg-surface-tint-gold': tone === 'gold',
      'border-emerald-800/60': tone === 'success',
      'border-rose-900/70': tone === 'danger',
      'border-line-subtle opacity-80': tone === 'muted',
      'p-3': padded,
    }"
  >
    <div v-if="title || $slots.action" class="flex items-center gap-2 mb-2">
      <h3 v-if="title" class="text-[13px] font-bold text-gold-500 tracking-wide font-display">{{ title }}</h3>
      <span v-if="hint" class="text-[11px] text-fg-faint truncate">{{ hint }}</span>
      <div v-if="$slots.action" class="ms-auto shrink-0"><slot name="action" /></div>
    </div>
    <slot />
  </div>
</template>
