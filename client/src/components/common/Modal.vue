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
              class="focus-ring grid place-items-center w-7 h-7 rounded-control text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors"
              aria-label="关闭对话框"
              title="关闭（Esc）"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
          
          <!-- Body -->
          <div class="scroll-thin p-6 overflow-y-auto">
            <slot></slot>
          </div>
          
          <!-- Footer -->
          <div v-if="$slots.footer" class="px-6 py-4 border-t border-line-subtle bg-surface-base/50 rounded-b-panel flex justify-end gap-3 flex-wrap">
            <slot name="footer"></slot>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'

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
  if (!props.closeOnBackdrop) return
  close()
}

const onKey = (e) => {
  if (e.key === 'Escape' && props.isOpen) {
    e.preventDefault()
    close()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
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
