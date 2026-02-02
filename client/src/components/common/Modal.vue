<template>
  <Teleport to="body">
    <transition name="modal">
      <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black bg-opacity-75" @click="handleBackdropClick"></div>
        
        <!-- Modal Content -->
        <div 
          class="relative bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full transform transition-all flex flex-col max-h-[90vh]"
          :class="[width ? '' : 'max-w-lg']"
          :style="width ? { width: width, maxWidth: '95vw' } : {}"
        >
          
          <!-- Header -->
          <div v-if="title" class="px-6 py-4 border-b border-gray-800 flex justify-between items-center">
            <h3 class="text-lg font-bold text-gray-100">{{ title }}</h3>
            <button v-if="showClose" @click="close" class="text-gray-400 hover:text-white transition-colors">
              ✕
            </button>
          </div>
          
          <!-- Body -->
          <div class="p-6 overflow-y-auto custom-scrollbar">
            <slot></slot>
          </div>
          
          <!-- Footer -->
          <div v-if="$slots.footer" class="px-6 py-4 border-t border-gray-800 bg-gray-900/50 rounded-b-lg flex justify-end gap-3">
            <slot name="footer"></slot>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup>
defineProps({
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
  // We can pass a prop to disable backdrop click
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

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: #1f2937;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #4b5563;
  border-radius: 3px;
}
</style>
