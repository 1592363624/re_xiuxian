<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>
    
    <div class="relative bg-[#1c1917] border border-stone-800 rounded-lg p-6 max-w-lg w-full mx-4 shadow-2xl animate-fade-in max-h-[80vh] flex flex-col">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-emerald-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2 2.5 9.5l1 10.5L12 22l8.5-2L22 10l-10-7.5z"/>
          </svg>
          历练探索
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      
      <div class="flex-1 overflow-y-auto space-y-4">
        <!-- 当前地图信息 -->
        <div v-if="currentMap" class="bg-[#292524] rounded-lg p-4 border border-stone-700">
          <div class="flex items-center gap-3 mb-2">
            <div class="text-emerald-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
            </div>
            <span class="font-bold text-stone-200">{{ currentMap.name }}</span>
            <span class="text-xs text-stone-500 bg-[#1c1917] px-2 py-0.5 rounded">{{ currentMap.environment }}</span>
          </div>
          <p class="text-sm text-stone-400">{{ currentMap.description }}</p>
        </div>
        
        <!-- 环境信息 -->
        <div class="flex gap-2 text-sm text-stone-400">
          <span class="bg-[#292524] px-3 py-1.5 rounded border border-stone-700 flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2"/><path d="M12 21v2"/><path d="M4.22 4.22l1.42 1.42"/><path d="M18.36 18.36l1.42 1.42"/><path d="M1 12h2"/><path d="M21 12h2"/><path d="M4.22 19.78l1.42-1.42"/><path d="M18.36 5.64l1.42-1.42"/></svg>
            {{ timeOfDay }}
          </span>
          <span class="bg-[#292524] px-3 py-1.5 rounded border border-stone-700 flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
            {{ weather }}
          </span>
        </div>
        
        <!-- 历练按钮 -->
        <div v-if="!isExploring" class="space-y-3">
          <button 
            @click="startExplore" 
            :disabled="isLoading"
            class="w-full py-4 px-6 bg-gradient-to-r from-emerald-900/80 to-[#064e3b] hover:from-emerald-800/80 hover:to-[#047857] border border-emerald-700 hover:border-emerald-500 text-emerald-400 hover:text-emerald-300 rounded-lg transition-all duration-300 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed group"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-hover:scale-110 transition-transform">
              <path d="M12 2 2.5 9.5l1 10.5L12 22l8.5-2L22 10l-10-7.5z"/>
            </svg>
            <span class="font-bold text-lg">开始历练</span>
          </button>
          <p class="text-xs text-stone-500 text-center">历练过程中会遭遇各种随机事件，可能获得修为、物品或触发战斗</p>
        </div>
        
        <!-- 历练中状态 -->
        <div v-else class="bg-[#292524] rounded-lg p-6 border border-stone-700 text-center space-y-4">
          <div class="flex justify-center">
            <div class="animate-spin text-emerald-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
            </div>
          </div>
          
          <div v-if="currentEvent" class="space-y-3">
            <span class="text-xs text-stone-500 uppercase tracking-wider">历练事件</span>
            <h3 class="text-lg font-bold text-amber-400">{{ currentEvent.title }}</h3>
            <p class="text-stone-300 text-sm leading-relaxed">{{ currentEvent.description }}</p>
            
            <div v-if="currentEvent.type === 'combat'" class="mt-4">
              <button 
                @click="enterCombat"
                class="w-full py-3 bg-gradient-to-r from-rose-900/80 to-[#881337] hover:from-rose-800/80 hover:to-[#9f1239] border border-rose-700 text-rose-400 rounded-lg transition-all font-bold"
              >
                进入战斗
              </button>
            </div>
            
            <div v-if="currentEvent.rewards && currentEvent.rewards.exp" class="text-sm text-emerald-400">
              预计获得: {{ currentEvent.rewards.exp }} 修为
            </div>
          </div>
          
          <button 
            @click="completeExplore"
            class="py-2 px-4 bg-[#44403c] hover:bg-[#57534e] border border-stone-600 text-stone-300 rounded-lg transition-colors"
          >
            结束历练
          </button>
        </div>
        
        <!-- AI 状态 -->
        <div v-if="aiStatus" class="bg-[#292524] rounded-lg p-3 border border-stone-700">
          <div class="flex items-center gap-2 text-sm">
            <div :class="aiStatus.available ? 'text-emerald-400' : 'text-amber-400'">
              <svg v-if="aiStatus.available" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <span class="text-stone-400">
              AI 生成: {{ aiStatus.available ? '已启用' : '使用模板' }}
            </span>
            <span v-if="aiStatus.provider" class="text-stone-500 text-xs">
              ({{ aiStatus.provider }})
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { useUIStore } from '../../stores/ui'

const emit = defineEmits(['close', 'combat'])

const uiStore = useUIStore()

const currentMap = ref<any>(null)
const timeOfDay = ref('')
const weather = ref('')
const aiStatus = ref<any>(null)
const isExploring = ref(false)
const currentEvent = ref<any>(null)
const isLoading = ref(false)
let autoCompleteTimer: number | null = null

const fetchExploreInfo = async () => {
  try {
    const [mapRes, aiRes] = await Promise.all([
      axios.get('/api/map/info'),
      axios.get('/api/map/explore/ai-status')
    ])
    
    if (mapRes.data?.current_map) {
      currentMap.value = mapRes.data.current_map
    }
    
    if (aiRes.data?.data) {
      aiStatus.value = aiRes.data.data
    }
  } catch (error) {
    console.error('获取历练信息失败:', error)
  }
}

const fetchEnvironment = async () => {
  try {
    const res = await axios.get('/api/map/explore/event')
    if (res.data?.data) {
      timeOfDay.value = res.data.data.time_of_day || ''
      weather.value = res.data.data.weather || ''
    }
  } catch (error) {
    console.error('获取环境信息失败:', error)
  }
}

const startExplore = async () => {
  if (isLoading.value) return
  isLoading.value = true
  
  try {
    const res = await axios.post('/api/map/explore/start', {
      duration: 90
    })
    
    if (res.data?.data?.event) {
      isExploring.value = true
      currentEvent.value = res.data.data.event
      
      uiStore.addLog({
        content: `开始历练：${res.data.data.event.title}`,
        type: 'info',
        actorId: 'self'
      })

      const duration = res.data.data.event.duration || 30
      const isCombat = res.data.data.event.type === 'combat'
      
      if (!isCombat && duration > 0) {
        autoCompleteTimer = window.setTimeout(async () => {
          await completeExplore()
        }, duration * 1000)
      }
    }
  } catch (error: any) {
    const msg = error.response?.data?.error || '历练失败'
    uiStore.showToast(msg, 'error')
  } finally {
    isLoading.value = false
  }
}

const completeExplore = async () => {
  try {
    const res = await axios.post('/api/map/explore/complete')
    
    if (res.data?.data?.rewards) {
      const rewards = res.data.data.rewards
      let rewardText = `获得 ${rewards.exp || 0} 修为`
      if (rewards.items?.length) {
        rewardText += `，${rewards.items.map((i: any) => i.item_key).join('、')}`
      }
      if (rewards.spirit_stones) {
        rewardText += `，${rewards.spirit_stones} 灵石`
      }
      
      uiStore.addLog({
        content: `历练完成：${rewardText}`,
        type: 'success',
        actorId: 'self'
      })
      
      uiStore.showToast('历练完成！', 'success')
    }
    
    isExploring.value = false
    currentEvent.value = null
    
    if (autoCompleteTimer) {
      clearTimeout(autoCompleteTimer)
      autoCompleteTimer = null
    }
    
    emit('close')
  } catch (error: any) {
    const msg = error.response?.data?.error || '完成历练失败'
    uiStore.showToast(msg, 'error')
  }
}

const enterCombat = async () => {
  try {
    const res = await axios.post('/api/map/explore/combat')
    
    if (res.data?.data?.battle_id) {
      uiStore.addLog({
        content: `战斗遭遇：${res.data.data.description || '遭遇敌人'}`,
        type: 'combat',
        actorId: 'self'
      })
      
      emit('close')
      emit('combat', res.data.data.battle_id)
    } else {
      uiStore.showToast('生成战斗失败', 'error')
    }
  } catch (error: any) {
    const msg = error.response?.data?.error || '进入战斗失败'
    uiStore.showToast(msg, 'error')
  }
}

onMounted(() => {
  fetchExploreInfo()
  fetchEnvironment()
})

onUnmounted(() => {
  if (autoCompleteTimer) {
    clearTimeout(autoCompleteTimer)
    autoCompleteTimer = null
  }
})
</script>
