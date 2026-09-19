<script setup>
defineProps({
  text: { type: String, default: '加载中…' },
})
</script>

<template>
  <div class="py-12 flex flex-col items-center justify-center gap-3 text-fg-muted" role="status" aria-live="polite">
    <span class="inline-block w-7 h-7 rounded-full border-2 border-line-strong border-t-gold-500 animate-spin"></span>
    <span class="text-xs tracking-wider">{{ text }}</span>
  </div>
</template>
