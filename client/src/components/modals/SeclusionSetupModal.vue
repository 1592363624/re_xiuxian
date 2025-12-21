<template>
  <Modal :isOpen="isOpen" title="闭关修炼" @close="close" :showClose="true">
    <div class="space-y-6">
      <p class="text-stone-400 text-sm leading-relaxed">
        闭关期间无法进行其他操作，但修为增长速度将大幅提升。请选择本次闭关的计划时长。
      </p>
      
      <div class="bg-[#0c0a09] p-4 rounded border border-stone-800">
        <div class="flex justify-between items-center mb-4">
          <span class="text-stone-300">闭关时长</span>
          <span class="text-amber-500 font-mono text-lg">{{ selectedDuration }} 分钟</span>
        </div>
        
        <input 
          type="range" 
          v-model.number="selectedDuration" 
          min="1" 
          max="60" 
          step="1"
          class="w-full h-2 bg-stone-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
        >
        <div class="flex justify-between text-xs text-stone-500 mt-2">
          <span>1分钟</span>
          <span>60分钟</span>
        </div>
      </div>

      <div class="bg-stone-800/30 p-3 rounded border border-stone-800/50">
        <h4 class="text-stone-300 text-sm font-bold mb-2">预计收益</h4>
        <div class="flex items-center gap-2 text-xs text-stone-400">
          <span>预计获得修为:</span>
          <span class="text-cyan-400 font-mono">+{{ estimatedExp }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <button 
        @click="close" 
        class="px-4 py-2 text-stone-400 hover:text-white transition-colors text-sm"
      >
        取消
      </button>
      <button 
        @click="handleStart" 
        :disabled="loading"
        class="px-6 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {{ loading ? '准备中...' : '开始闭关' }}
      </button>
    </template>
  </Modal>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import Modal from '../common/Modal.vue'
import { usePlayerStore } from '../../stores/player'

const props = defineProps({
  isOpen: Boolean
})

const emit = defineEmits(['close'])

const store = usePlayerStore()
const loading = ref(false)
const selectedDuration = ref(10) // minutes
const expRate = ref(0.1) // Default rate

// 预计收益计算
const estimatedExp = computed(() => {
  return Math.floor(selectedDuration.value * 60 * expRate.value)
})

onMounted(async () => {
  const status = await store.fetchSeclusionStatus()
  if (status && status.exp_rate) {
    expRate.value = status.exp_rate
  }
})

const close = () => {
  emit('close')
}

const handleStart = async () => {
  if (loading.value) return
  loading.value = true
  try {
    // Convert minutes to seconds
    await store.startSeclusion(selectedDuration.value * 60)
    close()
  } catch (err) {
    console.error(err)
  } finally {
    loading.value = false
  }
}
</script>
