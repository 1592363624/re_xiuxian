<script setup>
defineProps({
  text: { type: String, default: '暂无数据' },
  hint: { type: String, default: '' },
  icon: { type: String, default: '' },
})
</script>

<template>
  <div class="py-12 px-4 flex flex-col items-center justify-center gap-2 text-center">
    <svg
      v-if="!icon"
      xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"
      class="text-line-strong" aria-hidden="true"
    ><path d="M20 12.1A8.1 8.1 0 0 0 12 4a8.1 8.1 0 0 0-8 8.1"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
    <span v-else class="text-2xl leading-none opacity-50" aria-hidden="true">{{ icon }}</span>
    <p class="text-[13px] text-fg-muted">{{ text }}</p>
    <p v-if="hint" class="text-[11px] text-fg-faint max-w-[32ch]">{{ hint }}</p>
    <div v-if="$slots.default" class="mt-2">
      <slot />
    </div>
  </div>
</template>
