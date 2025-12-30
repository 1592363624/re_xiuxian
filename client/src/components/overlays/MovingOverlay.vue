<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['complete'])

const countdown = ref(0)
const progress = ref(0)
const intervalId = ref(null)
const cancelling = ref(false)

const movingState = computed(() => playerStore.movingState)

const fromMapName = computed(() => movingState.value.fromMapName || '起点')
const toMapName = computed(() => movingState.value.toMapName || '终点')

const formattedTime = computed(() => {
  const mins = Math.floor(countdown.value / 60)
  const secs = countdown.value % 60
  if (mins > 0) {
    return `${mins}分${secs.toString().padStart(2, '0')}秒`
  }
  return `${secs}秒`
})

const progressText = computed(() => {
  const total = movingState.value.totalSeconds || 1
  const percent = Math.round((1 - countdown.value / total) * 100)
  return `${percent}%`
})

const startCountdown = () => {
  if (intervalId.value) {
    clearInterval(intervalId.value)
  }
  
  countdown.value = movingState.value.remainingSeconds || movingState.value.totalSeconds || 0
  progress.value = 0
  
  intervalId.value = setInterval(() => {
    if (countdown.value > 0) {
      countdown.value--
      playerStore.updateRemainingTime(countdown.value)
      
      const total = movingState.value.totalSeconds || 1
      progress.value = Math.round((1 - countdown.value / total) * 100)
    } else {
      clearInterval(intervalId.value)
      handleComplete()
    }
  }, 1000)
}

const handleComplete = () => {
  emit('complete')
}

const cancelMove = async () => {
  if (cancelling.value) return
  
  cancelling.value = true
  try {
    await axios.post('/api/map/cancel-move')
    playerStore.clearMovingState()
    uiStore.addLog({
      content: `你取消了移动，返回了 ${fromMapName.value}。`,
      type: 'movement',
      actorId: 'self'
    })
    emit('complete')
  } catch (error) {
    uiStore.showToast(error.response?.data?.message || '取消失败', 'error')
  } finally {
    cancelling.value = false
  }
}

onMounted(() => {
  if (props.show && movingState.value.isMoving) {
    startCountdown()
  }
})

onUnmounted(() => {
  if (intervalId.value) {
    clearInterval(intervalId.value)
  }
})

watch(() => props.show, (newVal) => {
  if (newVal && movingState.value.isMoving) {
    startCountdown()
  }
})

watch(() => movingState.value.isMoving, (newVal) => {
  if (!newVal && props.show) {
    handleComplete()
  }
})
</script>

<template>
  <Transition name="moving">
    <div v-if="show && movingState.isMoving" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm"></div>
      
      <div class="relative bg-[#141210] border border-amber-700/50 rounded-lg p-8 max-w-md w-full mx-4 shadow-2xl shadow-amber-900/20">
        <div class="text-center">
          <div class="mb-6">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-900/30 border border-amber-700/50 mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400 animate-pulse">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 6v6l4 2"/>
              </svg>
            </div>
            <h2 class="text-xl font-bold text-amber-500 mb-2">正在赶路中</h2>
            <p class="text-sm text-stone-500">请耐心等待到达目的地</p>
          </div>

          <div class="mb-6">
            <div class="flex items-center justify-center gap-4 text-lg mb-4">
              <span class="text-stone-300">{{ fromMapName }}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-500">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
              <span class="text-amber-400 font-bold">{{ toMapName }}</span>
            </div>
          </div>

          <div class="mb-6">
            <div class="relative h-4 bg-stone-900 rounded-full overflow-hidden border border-stone-700">
              <div 
                class="absolute inset-y-0 left-0 bg-gradient-to-r from-amber-700 to-amber-500 transition-all duration-1000 ease-linear"
                :style="{ width: progress + '%' }"
              ></div>
              <div class="absolute inset-0 flex items-center justify-center">
                <span class="text-xs font-bold text-white drop-shadow">{{ progressText }}</span>
              </div>
            </div>
          </div>

          <div class="text-center">
            <div class="text-3xl font-mono font-bold text-amber-400 mb-1">{{ formattedTime }}</div>
            <div class="text-xs text-stone-500">预计剩余时间</div>
          </div>

          <div class="mt-6 pt-4 border-t border-stone-800">
            <div class="flex items-center justify-center gap-2 text-xs text-stone-500 mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
              <span>移动期间无法进行其他操作</span>
            </div>
            <button 
              @click="cancelMove"
              :disabled="cancelling"
              class="w-full py-2 px-4 rounded bg-stone-800 border border-stone-700 text-stone-400 hover:bg-stone-700 hover:text-stone-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span v-if="cancelling">取消中...</span>
              <span v-else>取消移动</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.moving-enter-active,
.moving-leave-active {
  transition: opacity 0.3s ease;
}

.moving-enter-from,
.moving-leave-to {
  opacity: 0;
}

.moving-enter-active .relative,
.moving-leave-active .relative {
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: scale(0.9) translateY(-20px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
</style>
