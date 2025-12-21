<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useUIStore } from '../../stores/ui'

const props = defineProps({
  player: {
    type: Object,
    default: () => ({ username: 'self' })
  }
})

const uiStore = useUIStore()
const filterMode = ref('all') // all, self, system
const logContainer = ref(null)

// 模拟日志生成 (用于展示功能)
let mockInterval = null

// 监听日志变化，自动滚动
watch(() => uiStore.logs.length, () => {
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
})

const getLogStyle = (type) => {
  switch (type) {
    case 'success': return 'border-emerald-800/60'
    case 'warning': return 'border-amber-800/60'
    case 'combat': return 'border-rose-800/60'
    case 'system': return 'border-purple-800/60 bg-[#161318]'
    case 'info': default: return 'border-stone-800/50'
  }
}

// 过滤逻辑
const filteredLogs = computed(() => {
  return uiStore.logs.filter(log => {
    // 强制显示重要事件 (如突破、系统公告)
    if (log.isImportant) return true
    
    if (filterMode.value === 'all') return true
    
    if (filterMode.value === 'self') {
      // 显示自己的动作
      return log.actorId === props.player?.username || log.actorId === 'self'
    }
    
    if (filterMode.value === 'system') {
      return log.type === 'system'
    }
    
    return true
  })
})

onMounted(() => {
  // 1. 欢迎信息 (如果日志为空才显示，避免重复)
  if (uiStore.logs.length === 0) {
    uiStore.addLog({
      content: '欢迎来到凡人修仙传的世界！道友请开始你的修仙之旅。',
      type: 'system',
      isImportant: true
    })
  }
})

onUnmounted(() => {
  if (mockInterval) clearInterval(mockInterval)
})
</script>

<template>
  <div class="flex-1 flex flex-col bg-[#0c0a09] overflow-hidden relative min-h-[200px] border border-stone-800/50 rounded-lg mx-2 my-1">
    <!-- 日志内容区 -->
    <div ref="logContainer" class="flex-1 overflow-y-auto font-mono text-base relative scroll-smooth bg-[#0c0a09]">
      <div class="flex flex-col gap-3 p-3 relative z-10">
        <TransitionGroup name="scroll">
          <div 
            v-for="(log, index) in filteredLogs" 
            :key="log.id" 
            class="flex flex-col p-3 rounded bg-[#111] border-l-4 border-stone-700/50 hover:bg-[#1a1a1a] transition-all duration-300 shadow-md mb-1"
            :class="getLogStyle(log.type)"
          >
            <span class="text-stone-500 text-xs mb-1 font-sans opacity-70">{{ log.time }}</span>
            <span class="text-stone-300 leading-loose break-words" :class="{'text-emerald-400': log.type === 'success', 'text-amber-400': log.type === 'warning', 'text-rose-400': log.type === 'combat', 'text-purple-400 font-bold': log.type === 'system'}">{{ log.content }}</span>
          </div>
        </TransitionGroup>
        
        <div v-if="filteredLogs.length === 0" class="text-stone-700 text-center mt-20 text-sm">
          暂无相关日志...
        </div>
      </div>
      
      <!-- 背景粒子层 -->
      <div class="absolute inset-0 pointer-events-none overflow-hidden z-0 opacity-20">
         <div class="absolute w-2 h-2 bg-emerald-500/30 rounded-full blur-[1px] animate-float top-1/4 left-1/4"></div>
         <div class="absolute w-3 h-3 bg-cyan-500/20 rounded-full blur-[2px] animate-float top-3/4 left-1/3" style="animation-duration: 8s; animation-delay: 1s;"></div>
         <div class="absolute w-1 h-1 bg-amber-500/40 rounded-full blur-[0px] animate-float top-1/2 left-2/3" style="animation-duration: 5s; animation-delay: 2s;"></div>
         <div class="absolute w-4 h-4 bg-purple-500/10 rounded-full blur-[3px] animate-float top-1/3 left-3/4" style="animation-duration: 10s; animation-delay: 0.5s;"></div>
      </div>
    </div>
    
    <!-- 过滤按钮 (右下角悬浮) -->
    <div class="absolute bottom-4 right-4 flex gap-2">
      <button 
        @click="filterMode = 'all'"
        class="w-8 h-8 rounded-full flex items-center justify-center border transition-all shadow-lg"
        :class="filterMode === 'all' ? 'bg-amber-900/80 border-amber-600 text-amber-100' : 'bg-stone-800 border-stone-700 text-stone-500 hover:text-stone-300'"
        title="全部"
      >
        全
      </button>
      <button 
        @click="filterMode = 'self'"
        class="w-8 h-8 rounded-full flex items-center justify-center border transition-all shadow-lg"
        :class="filterMode === 'self' ? 'bg-emerald-900/80 border-emerald-600 text-emerald-100' : 'bg-stone-800 border-stone-700 text-stone-500 hover:text-stone-300'"
        title="我的"
      >
        我
      </button>
      <button 
        @click="filterMode = 'system'"
        class="w-8 h-8 rounded-full flex items-center justify-center border transition-all shadow-lg"
        :class="filterMode === 'system' ? 'bg-purple-900/80 border-purple-600 text-purple-100' : 'bg-stone-800 border-stone-700 text-stone-500 hover:text-stone-300'"
        title="系统"
      >
        系
      </button>
    </div>
  </div>
</template>
