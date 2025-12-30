<script setup>
import { ref, onMounted, computed } from 'vue'
import axios from 'axios'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import FullMapList from './FullMapList.vue'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

const loading = ref(true)
const moving = ref(false)
const currentMap = ref(null)
const connectedMaps = ref([])
const mapConfigs = ref({})
const activeTab = ref('connected') // 'connected' 或 'all'

const mapTypeMap = {
  NOVICE: { name: '新手区', class: 'text-emerald-400', bg: 'bg-emerald-900/20', border: 'border-emerald-700/50' },
  LOW: { name: '低阶区', class: 'text-sky-400', bg: 'bg-sky-900/20', border: 'border-sky-700/50' },
  MID: { name: '中阶区', class: 'text-amber-400', bg: 'bg-amber-900/20', border: 'border-amber-700/50' },
  HIGH: { name: '高危区', class: 'text-rose-400', bg: 'bg-rose-900/20', border: 'border-rose-700/50' },
  SPECIAL: { name: '秘境', class: 'text-purple-400', bg: 'bg-purple-900/20', border: 'border-purple-700/50' },
  country: { name: '凡人国度', class: 'text-emerald-400', bg: 'bg-emerald-900/20', border: 'border-emerald-700/50' },
  sect: { name: '宗门', class: 'text-sky-400', bg: 'bg-sky-900/20', border: 'border-sky-700/50' },
  mountain: { name: '灵山', class: 'text-amber-400', bg: 'bg-amber-900/20', border: 'border-amber-700/50' },
  ocean: { name: '海域', class: 'text-cyan-400', bg: 'bg-cyan-900/20', border: 'border-cyan-700/50' },
  talent: { name: '秘境', class: 'text-purple-400', bg: 'bg-purple-900/20', border: 'border-purple-700/50' },
  world: { name: '界域', class: 'text-rose-400', bg: 'bg-rose-900/20', border: 'border-rose-700/50' }
}

const safetyLevelMap = {
  SAFE: { name: '安全', class: 'text-emerald-500' },
  LOW_RISK: { name: '低危', class: 'text-yellow-500' },
  MID_RISK: { name: '中危', class: 'text-orange-500' },
  HIGH_RISK: { name: '高危', class: 'text-rose-500' },
  EXTREME_RISK: { name: '极危', class: 'text-purple-500 font-bold' }
}

const fetchMapInfo = async () => {
  loading.value = true
  try {
    const res = await axios.get('/api/map/info')
    currentMap.value = res.data.current_map
    connectedMaps.value = res.data.connected_maps
  } catch (error) {
    console.error('Fetch map info failed:', error)
    uiStore.showToast('获取地图信息失败', 'error')
  } finally {
    loading.value = false
  }
}

const fetchMapConfigs = async () => {
  try {
    const res = await axios.get('/api/map/config')
    res.data.maps.forEach(m => {
      mapConfigs.value[m.id] = m
    })
  } catch (error) {
    console.error('Fetch map config failed:', error)
  }
}

const calculateMoveCost = (targetMap) => {
  if (!mapConfigs.value[targetMap.id] || !currentMap.value) {
    return { cost: 10, time: 60 }
  }
  const current = currentMap.value
  const target = mapConfigs.value[targetMap.id]
  
  const baseCost = 10
  const baseTime = 60
  const dangerLevel = target.danger_level || 1
  const travelTime = target.travel_time || 5
  const type = target.type || 'country'
  const environment = target.environment || 'plains'
  
  const typeMultiplier = {
    'country': 1,
    'sect': 1,
    'mountain': 1.5,
    'ocean': 2,
    'talent': 3,
    'world': 5
  }
  
  const terrainFactor = {
    'plains': 1,
    'mountain': 1.5,
    'ocean': 2,
    'cave': 1.8,
    'mixed': 1.2,
    'celestial': 1
  }
  
  let distance = 0
  let time = baseTime
  
  if (current.x !== undefined && target.x !== undefined) {
    distance = Math.sqrt(
      Math.pow(target.x - current.x, 2) + 
      Math.pow(target.y - current.y, 2)
    )
    const terrainMod = terrainFactor[environment] || 1
    const playerSpeed = playerStore.player?.attributes?.speed || 10
    time = Math.floor(baseTime + (distance * terrainMod * 10) / (playerSpeed / 10))
  } else {
    time = travelTime * 60
  }
  
  let cost = baseCost
  cost += Math.floor(distance / 10)
  cost += dangerLevel * 2
  cost += travelTime / 2
  cost *= typeMultiplier[type] || 1
  
  return { cost: Math.floor(cost), time, distance: Math.floor(distance * 100) / 100 }
}

const formatTime = (seconds) => {
  if (seconds < 60) return `${seconds}秒`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}分钟`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return `${hours}小时${remainingMins}分钟`
}

const handleMove = async (targetMap) => {
  if (moving.value) return
  
  const moveInfo = calculateMoveCost(targetMap)
  if (playerStore.player.mp_current < moveInfo.cost) {
     uiStore.showToast(`灵力不足，需要 ${moveInfo.cost} 点灵力`, 'error')
     return
  }

  moving.value = true
  try {
    const res = await axios.post('/api/map/start-move', { targetMapId: targetMap.id })
    const moveData = res.data.data
    
    playerStore.setMovingState({
      from_map_id: moveData.from_map_id,
      to_map_id: moveData.to_map_id,
      from_map_name: moveData.from_map_name,
      to_map_name: moveData.to_map_name,
      start_time: moveData.start_time,
      end_time: moveData.end_time,
      total_seconds: moveData.total_seconds
    })
    
    uiStore.showToast(res.data.message, 'success')
    uiStore.addLog({
        content: `你从 ${moveData.from_map_name} 出发，前往 ${moveData.to_map_name}。`,
        type: 'movement',
        actorId: 'self'
    })
    
    if (res.data.data.mp_cost) {
      playerStore.player.mp_current = (BigInt(playerStore.player.mp_current) - BigInt(res.data.data.mp_cost)).toString()
    }
    
    await fetchMapInfo()
    emit('close')
  } catch (error) {
    const msg = error.response?.data?.error || '移动失败'
    uiStore.showToast(msg, 'error')
  } finally {
    moving.value = false
  }
}

const getMapTypeStyle = (type) => {
  return mapTypeMap[type] || { name: type, class: 'text-stone-400', bg: 'bg-stone-800', border: 'border-stone-700' }
}

const getSafetyStyle = (level) => {
  const levelMap = {
    1: { name: '安全', class: 'text-emerald-500' },
    2: { name: '低危', class: 'text-yellow-500' },
    3: { name: '中危', class: 'text-orange-500' },
    6: { name: '高危', class: 'text-rose-500' },
    8: { name: '极危', class: 'text-purple-500 font-bold' },
    10: { name: '绝境', class: 'text-red-600 font-bold' },
    15: { name: '禁区', class: 'text-red-700 font-bold' },
    20: { name: '死域', class: 'text-gray-600 font-bold' }
  }
  return levelMap[level] || { name: level, class: 'text-stone-400' }
}

onMounted(async () => {
  await fetchMapConfigs()
  await fetchMapInfo()
})
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center p-4">
    <!-- 遮罩 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>
    
    <!-- 面板 -->
    <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
      
      <!-- 标题栏 -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-500 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
          修仙界地图
        </h2>
        <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- 标签页切换 -->
      <div class="flex border-b border-stone-800 bg-[#1c1917]">
        <button 
          v-for="tab in ['connected', 'all']" 
          :key="tab"
          @click="activeTab = tab"
          class="flex-1 py-3 px-4 text-center text-sm font-medium transition-colors"
          :class="activeTab === tab 
            ? 'text-amber-500 border-b-2 border-amber-700' 
            : 'text-stone-500 hover:text-stone-300 border-b-2 border-transparent hover:border-stone-700'"
        >
          {{ tab === 'connected' ? '可行路径' : '全部地图' }}
        </button>
      </div>
      
      <!-- 内容区 -->
      <div class="flex-1 overflow-hidden flex flex-col md:flex-row">
        <!-- 左侧：当前位置信息 (仅在可行路径标签显示) -->
        <div v-if="activeTab === 'connected'" class="w-full md:w-1/3 p-6 border-b md:border-b-0 md:border-r border-stone-800 bg-[#0c0a09] flex flex-col gap-6 overflow-y-auto">
          <div v-if="loading" class="flex justify-center py-10">
            <svg class="animate-spin h-8 w-8 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          
          <div v-else-if="currentMap" class="animate-slide-in">
             <div class="mb-2 flex items-center gap-2">
                <span class="text-xs px-2 py-0.5 rounded border" 
                      :class="[getMapTypeStyle(currentMap.type).class, getMapTypeStyle(currentMap.type).bg, getMapTypeStyle(currentMap.type).border]">
                  {{ getMapTypeStyle(currentMap.type).name }}
                </span>
                <span class="text-xs px-2 py-0.5 rounded border border-stone-800 bg-stone-900" 
                      :class="getSafetyStyle(currentMap.danger_level).class">
                  {{ getSafetyStyle(currentMap.danger_level).name }}
                </span>
             </div>
             
             <h3 class="text-3xl font-bold text-stone-200 mb-4 font-serif">{{ currentMap.name }}</h3>
             
             <div class="text-stone-400 text-sm leading-relaxed mb-6 border-l-2 border-stone-800 pl-4 italic">
               {{ currentMap.description || '暂无描述' }}
             </div>

             <div class="space-y-4">
               <div>
                 <h4 class="text-xs font-bold text-stone-500 uppercase tracking-wider mb-2">环境消耗</h4>
                 <div class="text-stone-300 text-sm">
                   {{ currentMap.environment_cost > 0 ? `每小时消耗 ${currentMap.environment_cost} 点灵力` : '无灵力消耗' }}
                 </div>
               </div>

               <div>
                 <h4 class="text-xs font-bold text-stone-500 uppercase tracking-wider mb-2">境界要求</h4>
                 <div class="text-stone-300 text-sm">
                   {{ currentMap.requiredRealm || '凡人' }}
                 </div>
               </div>
               
               <!-- 资源列表 (静态展示，暂不可交互) -->
               <div v-if="currentMap.resources && currentMap.resources.length > 0">
                 <h4 class="text-xs font-bold text-stone-500 uppercase tracking-wider mb-2">主要产出</h4>
                 <div class="flex flex-wrap gap-2">
                   <span v-for="res in currentMap.resources" :key="res.name" 
                         class="px-2 py-1 bg-stone-900 border border-stone-800 rounded text-xs text-stone-400 hover:text-stone-200 transition-colors cursor-help"
                         :title="`难度: ${res.difficulty}, 刷新: ${res.cooldown/60}分`">
                     {{ res.name }}
                   </span>
                 </div>
               </div>
             </div>
          </div>
        </div>

        <!-- 右侧：地图列表 -->
        <div class="flex-1 overflow-hidden">
          <!-- 可行路径列表 -->
          <div v-if="activeTab === 'connected'" class="h-full p-6 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-stone-900/50 relative overflow-y-auto">
             <h3 class="text-lg font-bold text-stone-300 mb-4 flex items-center gap-2">
               <span>可行路径</span>
               <span class="text-xs font-normal text-stone-500">Connected Paths</span>
             </h3>

             <div v-if="loading" class="text-stone-500">加载中...</div>
             
             <div v-else-if="connectedMaps.length === 0" class="flex flex-col items-center justify-center h-64 text-stone-500">
               <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
               <p>此地似乎是一处绝地，没有出口。</p>
             </div>

             <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
               <div v-for="map in connectedMaps" :key="map.id" 
                    class="group relative bg-[#1c1917] border border-stone-800 hover:border-amber-700/50 rounded-lg p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg cursor-pointer"
                    @click="handleMove(map)">
                 
                 <!-- 连线装饰 -->
                 <div class="absolute top-1/2 -left-2 w-2 h-px bg-stone-800 group-hover:bg-amber-800/50 transition-colors hidden sm:block"></div>
                 
                 <div class="flex justify-between items-start mb-2">
                   <h4 class="text-base font-bold text-stone-200 group-hover:text-amber-500 transition-colors">{{ map.name }}</h4>
                   <span class="text-[10px] px-1.5 py-0.5 rounded border bg-stone-900/50"
                         :class="getMapTypeStyle(map.type).class + ' ' + getMapTypeStyle(map.type).border">
                     {{ getMapTypeStyle(map.type).name }}
                   </span>
                 </div>
                 
                 <p class="text-xs text-stone-500 line-clamp-2 mb-2 h-8">{{ map.description }}</p>
                 
                 <div class="flex items-center gap-2 mb-3">
                   <span class="text-[10px] px-2 py-0.5 rounded bg-amber-900/30 border border-amber-700/50 text-amber-400">
                     境界: {{ map.requiredRealm || '凡人' }}
                   </span>
                 </div>
                 
                 <div class="flex items-center justify-between text-xs mt-auto pt-2 border-t border-stone-800/50">
                   <span :class="getSafetyStyle(map.danger_level).class">{{ getSafetyStyle(map.danger_level).name }}</span>
                   <span class="text-stone-400 group-hover:text-amber-400 flex items-center gap-1">
                     <span v-if="currentMap?.type !== map.type">
                       {{ calculateMoveCost(map).cost }}灵力 · {{ formatTime(calculateMoveCost(map).time) }}
                     </span>
                     <span v-else>
                       {{ calculateMoveCost(map).cost }}灵力 · {{ formatTime(calculateMoveCost(map).time) }}
                     </span>
                     <svg v-if="moving" class="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10" stroke-width="4" class="opacity-25"/><path class="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" fill="currentColor"/></svg>
                     <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transform group-hover:translate-x-1 transition-transform"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                   </span>
                 </div>
               </div>
             </div>
          </div>
          
          <!-- 全部地图列表 -->
          <div v-else-if="activeTab === 'all'" class="h-full overflow-hidden">
            <FullMapList @close="emit('close')" />
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
