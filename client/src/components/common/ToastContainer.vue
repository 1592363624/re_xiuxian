<template>
  <div class="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
    <transition-group name="toast">
      <div 
        v-for="toast in toasts" 
        :key="toast.id"
        class="pointer-events-auto min-w-[300px] max-w-md p-4 rounded shadow-lg text-white"
        :class="{
          'bg-green-600': toast.type === 'success',
          'bg-red-600': toast.type === 'error',
          'bg-blue-600': toast.type === 'info',
          'bg-yellow-600': toast.type === 'warning'
        }"
        @mouseenter="pauseAutoRemove(toast.id)"
        @mouseleave="resumeAutoRemove(toast.id)"
      >
        <div class="flex justify-between items-start">
          <p class="text-sm font-medium">{{ toast.message }}</p>
          <button @click="removeToast(toast.id)" class="ml-4 text-white hover:text-gray-200">
            ✕
          </button>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useUIStore } from '../../stores/ui'

const uiStore = useUIStore()
const toasts = computed(() => uiStore.toasts)

let timers = new Map()

const removeToast = (id) => {
  if (timers.has(id)) {
    clearTimeout(timers.get(id))
    timers.delete(id)
  }
  uiStore.removeToast(id)
}

const pauseAutoRemove = (id) => {
  if (timers.has(id)) {
    clearTimeout(timers.get(id))
  }
}

const resumeAutoRemove = (id) => {
  const toast = uiStore.toasts.find(t => t.id === id)
  if (toast && toast.duration > 0) {
    const timer = setTimeout(() => {
      removeToast(id)
    }, toast.duration)
    timers.set(id, timer)
  }
}
</script>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(30px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(30px);
}
</style>
