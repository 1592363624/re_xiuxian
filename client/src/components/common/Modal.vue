<template>
  <Teleport to="body">
    <transition name="modal">
      <div v-if="isOpen" class="fixed inset-0 z-dialog flex items-center justify-center p-4">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/75" aria-hidden="true" @click="handleBackdropClick"></div>
        
        <!-- Modal Content -->
        <div 
          class="relative bg-surface-base border border-line rounded-panel shadow-xl w-full transform transition-all flex flex-col max-h-[90vh]"
          :class="[width ? '' : 'max-w-lg']"
          :style="width ? { width: width, maxWidth: '95vw' } : {}"
          role="dialog"
          :aria-label="title || '对话框'"
        >
          
          <!-- Header -->
          <div v-if="title" class="px-6 py-4 border-b border-line-subtle flex justify-between items-center">
            <h3 class="text-lg font-bold text-fg-primary font-display">{{ title }}</h3>
            <button
              type="button"
              v-if="showClose"
              @click="close"
              class="focus-ring rounded-control text-fg-muted hover:text-fg-primary transition-colors"
              aria-label="关闭对话框"
            >
              ✕
            </button>
          </div>
          
          <!-- Body -->
          <div class="scroll-thin p-6 overflow-y-auto">
            <slot></slot>
          </div>
          
          <!-- Footer：主操作贴内容，次操作左对齐 -->
          <div v-if="$slots.footer" class="px-4 sm:px-6 py-3 border-t border-line-subtle bg-surface-raised/95 rounded-b-panel flex items-center gap-2">
            <div class="flex items-center gap-2 min-w-0 shrink-0">
              <slot name="footer-start"></slot>
            </div>
            <div class="flex items-center gap-2 flex-1 justify-end min-w-0">
              <slot name="footer"></slot>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup>
const props = defineProps({
  isOpen: {
    type: Boolean,
    required: true
  },
  title: {
    type: String,
    default: ''
  },
  showClose: {
    type: Boolean,
    default: true
  },
  closeOnBackdrop: {
    type: Boolean,
    default: true
  },
  width: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['close'])

const close = () => {
  emit('close')
}

const handleBackdropClick = () => {
  // 有进行中的定时会话（如炼丹火候）时会传 closeOnBackdrop=false：
  // 点遮罩必须无效，否则误点一下就把会话界面关掉、进度丢失。
  if (!props.closeOnBackdrop) return
  close()
}
</script>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .transform,
.modal-leave-active .transform {
  transition: all 0.3s ease-out;
}

.modal-enter-from .transform,
.modal-leave-to .transform {
  transform: scale(0.95);
  opacity: 0;
}
</style>
