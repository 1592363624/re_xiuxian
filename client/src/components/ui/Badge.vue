<script setup>
/**
 * 状态/品阶小标签
 *
 * 物品品阶、战斗状态、可领取标记在几十个面板里各写了一份内联样式，
 * 同一含义（可领取）在坊市是实心 amber、在成就里是描边 amber。
 * tone 的取值对应 tokens.css 的语义色，跨面板不再各挑各的。
 */
defineProps({
  tone: { type: String, default: 'neutral', validator: v => ['neutral', 'gold', 'success', 'danger', 'info', 'arcane', 'muted'].includes(v) },
  /** 实心：用于必须被看见的标记（可领取 / 进行中） */
  solid: { type: Boolean, default: false },
  dot: { type: Boolean, default: false },
})
</script>

<template>
  <span
    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] leading-4 whitespace-nowrap border"
    :class="{
      'border-line text-fg-secondary bg-surface-hover': tone === 'neutral' && !solid,
      'border-gold-500 text-fg-primary bg-gold-700': tone === 'neutral' && solid,

      'border-gold-700/60 text-gold-400 bg-surface-tint-gold': tone === 'gold' && !solid,
      'border-gold-500 text-surface-sunken bg-gold-500 font-bold': tone === 'gold' && solid,

      'border-emerald-800/70 text-emerald-300 bg-emerald-900/30': tone === 'success' && !solid,
      'border-emerald-500 text-emerald-950 bg-emerald-500 font-bold': tone === 'success' && solid,

      'border-rose-900/70 text-rose-300 bg-rose-950/40': tone === 'danger' && !solid,
      'border-rose-500 text-rose-50 bg-rose-600 font-bold': tone === 'danger' && solid,

      'border-sky-800/70 text-sky-300 bg-sky-950/40': tone === 'info' && !solid,
      'border-sky-500 text-sky-950 bg-sky-500 font-bold': tone === 'info' && solid,

      'border-purple-800/70 text-purple-300 bg-purple-950/40': tone === 'arcane' && !solid,
      'border-purple-500 text-purple-50 bg-purple-600 font-bold': tone === 'arcane' && solid,

      'border-transparent text-fg-faint bg-transparent': tone === 'muted',
    }"
  ><span v-if="dot" class="w-1.5 h-1.5 rounded-full bg-current opacity-80 shrink-0" aria-hidden="true"></span><slot /></span>
</template>
