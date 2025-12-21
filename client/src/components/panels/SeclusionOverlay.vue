<template>
  <div class="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center text-stone-200 select-none">
    <!-- 背景动画效果 -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-cyan-900/10 rounded-full blur-3xl animate-pulse"></div>
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-purple-900/10 rounded-full blur-3xl animate-pulse delay-700"></div>
    </div>

    <!-- 核心内容 -->
    <div class="relative z-10 flex flex-col items-center">
      <!-- 闭关图标/动画 -->
      <div class="relative mb-12">
        <!-- 外圈光环 -->
        <div class="absolute inset-0 -m-8 border border-cyan-500/20 rounded-full animate-[spin_10s_linear_infinite]"></div>
        <div class="absolute inset-0 -m-4 border border-cyan-500/30 rounded-full animate-[spin_15s_linear_infinite_reverse]"></div>
        
        <!-- 核心图标容器 -->
        <div class="w-32 h-32 bg-gradient-to-b from-stone-900 to-black rounded-full border-2 border-cyan-500/50 flex items-center justify-center shadow-[0_0_30px_rgba(6,182,212,0.3)]">
           <svg xmlns="http://www.w3.org/2000/svg" class="w-16 h-16 text-cyan-400 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
             <path d="M12 2L2 7l10 5 10-5-10-5z"/>
             <path d="M2 17l10 5 10-5"/>
             <path d="M2 12l10 5 10-5"/>
           </svg>
        </div>
      </div>

      <!-- 标题 -->
      <h2 class="text-4xl font-bold tracking-[0.5em] text-white mb-4 text-shadow-lg">潜心闭关中</h2>
      
      <!-- 副标题 -->
      <div class="px-4 py-1 rounded-full bg-cyan-950/30 border border-cyan-900/50 text-cyan-400 text-sm mb-12 tracking-widest">
        正在感悟诸天造化
      </div>

      <!-- 统计数据 -->
      <div class="grid grid-cols-2 gap-16 mb-16 text-center">
        <div>
          <div class="text-stone-500 text-xs mb-2 tracking-wider">本次闭关时长</div>
          <div class="text-3xl font-mono text-white">
            {{ formatTime(duration) }}
          </div>
        </div>
        <div>
          <div class="text-stone-500 text-xs mb-2 tracking-wider">已获修为进益</div>
          <div class="text-3xl font-mono text-cyan-400 font-bold">
            +{{ expGained }}
          </div>
        </div>
      </div>

      <!-- 结束按钮 -->
      <button 
        @click="handleEnd" 
        :disabled="loading"
        class="px-12 py-3 bg-stone-900/80 border border-stone-700 text-rose-400 hover:text-rose-300 hover:border-rose-500/50 hover:bg-stone-800 transition-all duration-300 rounded-lg tracking-widest text-sm group"
      >
        <span v-if="loading">结算中...</span>
        <span v-else class="group-hover:scale-105 inline-block transition-transform">结束修炼</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { usePlayerStore } from '../../stores/player'

const store = usePlayerStore()
const loading = ref(false)
const now = ref(Date.now())
const timer = ref(null)
const expRate = ref(0.1) // Default

const startTime = computed(() => {
  return store.player?.seclusion_start_time ? new Date(store.player.seclusion_start_time).getTime() : Date.now()
})

const duration = computed(() => {
  return Math.max(0, Math.floor((now.value - startTime.value) / 1000))
})

const expGained = computed(() => {
  return Math.floor(duration.value * expRate.value)
})

const formatTime = (seconds) => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  
  if (h > 0) {
    return `${h}h ${m}m ${s}s`
  }
  return `${m}m ${s}s`
}

const handleEnd = async () => {
  if (loading.value) return
  loading.value = true
  try {
    await store.endSeclusion()
    // 闭关结束，组件会被销毁（因为父组件v-if会变为false）
  } catch (err) {
    console.error(err)
    loading.value = false
  }
}

onMounted(async () => {
  const status = await store.fetchSeclusionStatus()
  if (status && status.exp_rate) {
    expRate.value = status.exp_rate
  }
  
  timer.value = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer.value) clearInterval(timer.value)
})
</script>

<style scoped>
.text-shadow-lg {
  text-shadow: 0 0 20px rgba(255, 255, 255, 0.3);
}
</style>
