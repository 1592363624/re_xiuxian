<script setup>
defineProps({
  message: { type: String, default: '加载失败' },
})
defineEmits(['retry'])
</script>

<template>
  <div class="py-12 px-4 flex flex-col items-center justify-center gap-3 text-center">
    <svg
      xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
      class="text-state-danger/70" aria-hidden="true"
    ><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
    <p class="text-[13px] text-fg-muted">{{ message }}</p>
    <button
      type="button"
      @click="$emit('retry')"
      class="focus-ring px-3 py-1.5 rounded-control text-xs border border-line text-fg-secondary hover:bg-surface-hover transition-colors"
    >重试</button>
  </div>
</template>
