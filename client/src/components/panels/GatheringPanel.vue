<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

const loading = ref(true)
const gathering = ref(false)
const resources = ref([])
const stats = ref(null)
const currentMap = ref(null)
const currentMapId = ref(null)
const countdownIntervals = ref({})

const fetchData = async () => {
  loading.value = true
  try {
    const [mapRes, resourcesRes, statsRes] = await Promise.all([
      axios.get('/api/map/info'),
      axios.get('/api/gather/resources'),
      axios.get('/api/gather/stats')
    ])
    
    currentMap.value = mapRes.data.current_map
    currentMapId.value = mapRes.data.current_map?.id
    resources.value = resourcesRes.data.resources || []
    stats.value = statsRes.data
    
    startCountdowns()
  } catch (error) {
    console.error('Failed to fetch gathering data:', error)
    if (error.response?.status === 404) {
      uiStore.showToast('当前地图暂无可采集资源', 'info')
      resources.value = []
    } else {
      uiStore.showToast('获取采集数据失败', 'error')
    }
  } finally {
    loading.value = false
  }
}

const startCountdowns = () => {
  Object.keys(countdownIntervals.value).forEach(key => {
    clearInterval(countdownIntervals.value[key])
  })
  
  resources.value.forEach(resource => {
    if (!resource.can_gather && resource.next_available_time) {
      const key = resource.resource_id
      countdownIntervals.value[key] = setInterval(() => {
        const now = new Date()
        const nextTime = new Date(resource.next_available_time)
        const diff = nextTime - now
        
        if (diff <= 0) {
          resource.can_gather = true
          resource.countdown = null
          clearInterval(countdownIntervals.value[key])
        } else {
          const mins = Math.floor(diff / 60000)
          const secs = Math.floor((diff % 60000) / 1000)
          resource.countdown = `${mins}:${secs.toString().padStart(2, '0')}`
        }
      }, 1000)
    }
  })
}

const handleGather = async (resource) => {
  if (gathering.value || !resource.can_gather) return
  
  if (playerStore.player.mp_current < resource.mp_cost) {
    uiStore.showToast(`灵力不足，需要 ${resource.mp_cost} 点灵力`, 'error')
    return
  }

  gathering.value = true
  try {
    const res = await axios.post('/api/gather/collect', { resourceId: resource.resource_id })
    
    const result = res.data
    uiStore.showToast(`采集成功！获得 ${result.quantity} 个 ${resource.name}${result.is_crit ? '（暴击）' : ''}`, 'success')
    
    uiStore.addLog({
      content: `你在 ${currentMap.value?.name || '未知地点'} 采集了 ${result.quantity} 个 ${resource.name}。`,
      type: 'gather',
      actorId: 'self'
    })
    
    if (result.mp_remaining) {
      playerStore.player.mp_current = result.mp_remaining
    }
    
    await refreshResource(resource.resource_id)
    await fetchStats()
  } catch (error) {
    const msg = error.response?.data?.error || '采集失败'
    uiStore.showToast(msg, 'error')
  } finally {
    gathering.value = false
  }
}

const refreshResource = async (resourceId) => {
  try {
    const res = await axios.get('/api/gather/resources')
    const updatedResources = res.data.resources || []
    const updated = updatedResources.find(r => r.resource_id === resourceId)
    if (updated) {
      const index = resources.value.findIndex(r => r.resource_id === resourceId)
      if (index !== -1) {
        resources.value[index] = updated
      }
    }
    startCountdowns()
  } catch (error) {
    console.error('Failed to refresh resource:', error)
  }
}

const fetchStats = async () => {
  try {
    const res = await axios.get('/api/gather/stats')
    stats.value = res.data
  } catch (error) {
    console.error('Failed to fetch stats:', error)
  }
}

const getDifficultyColor = (difficulty) => {
  if (difficulty <= 2) return 'text-emerald-400'
  if (difficulty <= 5) return 'text-yellow-400'
  if (difficulty <= 8) return 'text-orange-400'
  return 'text-red-400'
}

const getProficiencyPercent = (resource) => {
  const exp = resource.player_proficiency?.exp || 0
  const level = resource.player_proficiency?.level || 1
  const expToNext = getExpToNextLevel(level)
  if (expToNext <= 0) return 100
  return Math.min(100, (exp / expToNext) * 100)
}

const getExpToNextLevel = (level) => {
  if (level >= 100) return 0
  return Math.floor(100 * Math.pow(1.5, level - 1))
}

const getLevelName = (level) => {
  if (level < 10) return '入门'
  if (level < 30) return '熟练'
  if (level < 50) return '精通'
  if (level < 70) return '专家'
  if (level < 90) return '大师'
  return '宗师'
}

const totalGatherCount = computed(() => {
  return stats.value?.total_gather_count || 0
})

const highestLevel = computed(() => {
  return stats.value?.highest_proficiency_level || 0
})

const resourcesCollected = computed(() => {
  return stats.value?.resources_collected || 0
})

onMounted(() => {
  fetchData()
})

onUnmounted(() => {
  Object.values(countdownIntervals.value).forEach(interval => {
    clearInterval(interval)
  })
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>
    
    <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-500 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg>
          资源采集
        </h2>
        <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="flex-1 overflow-hidden flex">
        <div class="w-2/3 overflow-y-auto p-6">
          <div v-if="loading" class="flex justify-center items-center h-64">
            <svg class="animate-spin h-10 w-10 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>

          <div v-else-if="!currentMap" class="flex flex-col items-center justify-center h-64 text-stone-500">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            <p>无法获取当前地图信息</p>
          </div>

          <div v-else-if="resources.length === 0" class="flex flex-col items-center justify-center h-64 text-stone-500">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/></svg>
            <p>{{ currentMap.name }} 暂无可采集资源</p>
          </div>

          <div v-else class="space-y-4">
            <div class="mb-4">
              <h3 class="text-lg font-bold text-stone-300 mb-1">{{ currentMap.name }}</h3>
              <p class="text-sm text-stone-500">{{ currentMap.description }}</p>
            </div>

            <div 
              v-for="resource in resources" 
              :key="resource.resource_id"
              class="bg-[#1c1917] border border-stone-800 rounded-lg p-4 transition-all"
              :class="{ 'opacity-60': !resource.can_gather }"
            >
              <div class="flex justify-between items-start mb-3">
                <div>
                  <h4 class="text-lg font-bold text-stone-200 flex items-center gap-2">
                    {{ resource.name }}
                    <span class="text-xs px-2 py-0.5 rounded bg-stone-900 border border-stone-700" :class="getDifficultyColor(resource.difficulty)">
                      难度 {{ resource.difficulty }}
                    </span>
                  </h4>
                  <p class="text-xs text-stone-500 mt-1">{{ resource.description }}</p>
                </div>
                <div class="text-right">
                  <div class="text-xs text-stone-500">消耗灵力</div>
                  <div class="text-sm font-bold text-cyan-400">{{ resource.mp_cost }}</div>
                </div>
              </div>

              <div class="flex items-center gap-4 mb-3">
                <div class="flex-1">
                  <div class="flex justify-between text-xs text-stone-500 mb-1">
                    <span>熟练度 Lv.{{ resource.player_proficiency?.level || 1 }} {{ getLevelName(resource.player_proficiency?.level || 1) }}</span>
                    <span>{{ resource.player_proficiency?.exp || 0 }} / {{ getExpToNextLevel(resource.player_proficiency?.level || 1) }}</span>
                  </div>
                  <div class="h-2 bg-stone-900 rounded-full overflow-hidden">
                    <div 
                      class="h-full bg-gradient-to-r from-amber-600 to-amber-400 transition-all duration-500"
                      :style="{ width: getProficiencyPercent(resource) + '%' }"
                    ></div>
                  </div>
                </div>
                <div class="text-xs text-stone-500 whitespace-nowrap">
                  总计: {{ resource.player_proficiency?.total_count || 0 }} 次
                </div>
              </div>

              <div class="flex items-center justify-between">
                <div class="text-xs">
                  <span v-if="resource.can_gather" class="text-emerald-400">可采集</span>
                  <span v-else class="text-orange-400">冷却中 {{ resource.countdown }}</span>
                </div>
                <button 
                  @click="handleGather(resource)"
                  :disabled="gathering || !resource.can_gather || playerStore.player.mp_current < resource.mp_cost"
                  class="px-4 py-1.5 rounded bg-emerald-900/30 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span v-if="gathering">采集中...</span>
                  <span v-else-if="!resource.can_gather">等待冷却</span>
                  <span v-else-if="playerStore.player.mp_current < resource.mp_cost">灵力不足</span>
                  <span v-else>采集</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="w-1/3 border-l border-stone-800 bg-[#0c0a09] p-4 overflow-y-auto">
          <h3 class="text-sm font-bold text-stone-400 mb-4 uppercase tracking-wider">采集统计</h3>
          
          <div class="space-y-4">
            <div class="bg-[#1c1917] rounded-lg p-4 border border-stone-800">
              <div class="text-2xl font-bold text-amber-500">{{ totalGatherCount }}</div>
              <div class="text-xs text-stone-500">总采集次数</div>
            </div>
            
            <div class="bg-[#1c1917] rounded-lg p-4 border border-stone-800">
              <div class="text-2xl font-bold text-cyan-400">{{ resourcesCollected }}</div>
              <div class="text-xs text-stone-500">已探索资源</div>
            </div>
            
            <div class="bg-[#1c1917] rounded-lg p-4 border border-stone-800">
              <div class="text-2xl font-bold text-purple-400">{{ highestLevel }}</div>
              <div class="text-xs text-stone-500">最高熟练度</div>
            </div>
          </div>

          <div class="mt-6">
            <h4 class="text-xs font-bold text-stone-500 mb-3 uppercase tracking-wider">熟练度等级</h4>
            <div class="space-y-2 text-xs">
              <div class="flex justify-between text-stone-400">
                <span>1-9</span>
                <span>入门</span>
              </div>
              <div class="flex justify-between text-stone-400">
                <span>10-29</span>
                <span>熟练</span>
              </div>
              <div class="flex justify-between text-stone-400">
                <span>30-49</span>
                <span>精通</span>
              </div>
              <div class="flex justify-between text-stone-400">
                <span>50-69</span>
                <span>专家</span>
              </div>
              <div class="flex justify-between text-stone-400">
                <span>70-89</span>
                <span>大师</span>
              </div>
              <div class="flex justify-between text-amber-400">
                <span>90+</span>
                <span>宗师</span>
              </div>
            </div>
          </div>

          <div class="mt-6 p-3 bg-stone-900/50 rounded border border-stone-800">
            <p class="text-xs text-stone-500 leading-relaxed">
              采集时可获得熟练度经验，熟练度越高，获得的产出越多。采集也有一定概率触发暴击，获得双倍产出。
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
</style>
