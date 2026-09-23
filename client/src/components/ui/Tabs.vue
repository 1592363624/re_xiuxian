<script setup>
/**
 * 面板内分段导航
 *
 * 28 个面板各自写过一份 activeTab + 一排按钮，选中态颜色、圆角、
 * 间距都不一样。这里统一：v-model 传当前 key，items 传 [{ key, label, badge }]。
 * 标签多时可横向滚动（窄屏常见），滚动条隐藏但保留滚轮/触摸。
 */
defineProps({
  modelValue: { type: String, required: true },
  items: { type: Array, required: true },
})
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div
    class="no-scrollbar -mx-1 px-1 flex items-stretch gap-1 overflow-x-auto border-b border-line-subtle"
    role="tablist"
  >
    <button
      v-for="(item, index) in items"
      :key="item.key"
      type="button"
      role="tab"
      :aria-selected="modelValue === item.key"
      @click="emit('update:modelValue', item.key)"
      @keydown.left.prevent="emit('update:modelValue', items[(index - 1 + items.length) % items.length].key)"
      @keydown.right.prevent="emit('update:modelValue', items[(index + 1) % items.length].key)"
      class="focus-ring relative shrink-0 px-3 py-2 text-[13px] tracking-wide transition-colors border-b-2 -mb-px
             flex items-center gap-1.5"
      :class="modelValue === item.key
        ? 'border-gold-500 text-gold-400 font-bold'
        : 'border-transparent text-fg-muted hover:text-fg-secondary hover:bg-surface-hover/60'"
    >
      {{ item.label }}
      <span
        v-if="item.badge !== undefined && item.badge !== null && item.badge !== 0"
        class="min-w-[18px] px-1 rounded-full text-[10px] leading-[18px] text-center bg-surface-active text-fg-secondary"
      >{{ item.badge }}</span>
    </button>
  </div>
</template>
