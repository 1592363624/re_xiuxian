<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'

const emit = defineEmits(['close', 'mapChanged'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

const loading = ref(true)
const allMaps = ref([])
const currentMapId = ref(null)
const playerRealm = ref('凡人')
const playerSpeed = ref(10)
const moving = ref(false)
const filterType = ref('all')
const filterRealm = ref('all')
const searchKeyword = ref('')

const mapTypeMap = {
  country: { name: '凡人国度', class: 'text-emerald-400', bg: 'bg-emerald-900/20', border: 'border-emerald-700/50' },
  sect: { name: '宗门', class: 'text-sky-400', bg: 'bg-sky-900/20', border: 'border-sky-700/50' },
  mountain: { name: '灵山', class: 'text-amber-400', bg: 'bg-amber-900/20', border: 'border-amber-700/50' },
  ocean: { name: '海域', class: 'text-cyan-400', bg: 'bg-cyan-900/20', border: 'border-cyan-700/50' },
  talent: { name: '秘境', class: 'text-purple-400', bg: 'bg-purple-900/20', border: 'border-purple-700/50' },
  world: { name: '界域', class: 'text-rose-400', bg: 'bg-rose-900/20', border: 'border-rose-700/50' }
}

const realmOrder = [
  '凡人', '炼气1层', '炼气2层', '炼气3层', '炼气4层', '炼气5层',
  '炼气6层', '炼气7层', '炼气8层', '炼气9层', '炼气10层',
  '筑基期', '筑基初期', '筑基中期', '筑基后期', '筑基圆满',
  '金丹期', '金丹初期', '金丹中期', '金丹后期', '金丹圆满',
  '元婴期', '元婴初期', '元婴中期', '元婴后期', '元婴圆满',
  '化神期', '炼虚期', '合体期', '大乘期', '渡劫期', '真仙'
]

const fetchData = async () => {
  loading.value = true
  try {
    const [configRes, infoRes] = await Promise.all([
      axios.get('/api/map/config'),
      axios.get('/api/map/info')
    ])
    
    allMaps.value = configRes.data.maps
    currentMapId.value = infoRes.data.current_map?.id
    playerRealm.value = playerStore.player?.realm || '凡人'
    playerSpeed.value = playerStore.player?.attributes?.speed || 10
  } catch (error) {
    console.error('Failed to fetch map data:', error)
    uiStore.showToast('获取地图数据失败', 'error')
  } finally {
    loading.value = false
  }
}

const getRealmRank = (realmName) => {
  return realmOrder.indexOf(realmName)
}

const canEnter = (map) => {
  const playerRank = getRealmRank(playerRealm.value)
  const requiredRank = getRealmRank(map.required_realm || '凡人')
  return playerRank >= requiredRank
}

const calculateDistance = (targetMap) => {
  const currentMap = allMaps.value.find(m => m.id === currentMapId.value)
  if (!currentMap || currentMap.x === undefined || targetMap.x === undefined) {
    return 0
  }
  return Math.sqrt(
    Math.pow(targetMap.x - currentMap.x, 2) + 
    Math.pow(targetMap.y - currentMap.y, 2)
  )
}

const calculateMoveCost = (targetMap) => {
  if (targetMap.id === currentMapId.value) {
    return { cost: 0, time: 0, distance: 0 }
  }

  const distance = calculateDistance(targetMap)
  const baseCost = 10
  const dangerLevel = targetMap.danger_level || 1
  const travelTime = targetMap.travel_time || 5
  const type = targetMap.type || 'country'

  const typeMultiplier = {
    'country': 1,
    'sect': 1,
    'mountain': 1.5,
    'ocean': 2,
    'talent': 3,
    'world': 5
  }

  let cost = baseCost
  cost += Math.floor(distance / 10)
  cost += dangerLevel * 2
  cost += travelTime / 2
  cost *= typeMultiplier[type] || 1

  const terrainFactor = {
    'plains': 1,
    'mountain': 1.5,
    'ocean': 2,
    'cave': 1.8,
    'mixed': 1.2,
    'celestial': 1
  }
  
  const terrainMod = terrainFactor[targetMap.environment] || 1
  const time = Math.floor(60 + (distance * terrainMod * 10) / (playerSpeed.value / 10))

  return { cost: Math.floor(cost), time, distance: Math.floor(distance * 100) / 100 }
}

const formatTime = (seconds) => {
  if (seconds <= 0) return '瞬移'
  if (seconds < 60) return `${seconds}秒`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}分钟`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return `${hours}小时${remainingMins}分钟`
}

const formatDistance = (distance) => {
  if (distance < 1) return `${Math.floor(distance * 100)}尺`
  if (distance < 10) return `${distance.toFixed(1)}里`
  return `${Math.floor(distance)}里`
}

const filteredMaps = computed(() => {
  return allMaps.value.filter(map => {
    if (map.id === currentMapId.value) return false
    if (filterType.value !== 'all' && map.type !== filterType.value) return false
    if (filterRealm.value !== 'all') {
      const requiredRank = getRealmRank(map.requiredRealm || '凡人')
      if (filterRealm.value === 'low' && requiredRank > 10) return false
      if (filterRealm.value === 'mid' && (requiredRank <= 10 || requiredRank > 25)) return false
      if (filterRealm.value === 'high' && requiredRank <= 25) return false
    }
    if (searchKeyword.value && !map.name.includes(searchKeyword.value) && !map.description.includes(searchKeyword.value)) {
      return false
    }
    return true
  })
})

const getEnterStatus = (map) => {
  const playerRank = getRealmRank(playerRealm.value)
  const requiredRank = getRealmRank(map.requiredRealm || '凡人')
  const diff = requiredRank - playerRank
  
  if (diff <= 0) return { canEnter: true, reason: null }
  if (diff <= 5) return { canEnter: false, reason: `需提升 ${diff} 个境界` }
  return { canEnter: false, reason: null }
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
    const currentMap = allMaps.value.find(m => m.id === currentMapId.value)
    const res = await axios.post('/api/map/start-move', { targetMapId: targetMap.id })
    
    if (res.data.success) {
      const movingState = {
        isMoving: true,
        fromMapId: currentMapId.value,
        toMapId: targetMap.id,
        fromMapName: currentMap?.name || '未知地点',
        toMapName: targetMap.name,
        startTime: res.data.start_time,
        endTime: res.data.end_time,
        totalSeconds: res.data.total_seconds,
        remainingSeconds: res.data.total_seconds
      }
      playerStore.setMovingState(movingState)
      
      uiStore.addLog({
        content: `你从 ${currentMap?.name || '未知地点'} 出发，前往 ${targetMap.name}，预计 ${formatTime(res.data.total_seconds)} 后到达。`,
        type: 'movement',
        actorId: 'self'
      })
      
      emit('close')
    } else {
      uiStore.showToast(res.data.message || '移动失败', 'error')
    }
  } catch (error) {
    const msg = error.response?.data?.message || error.response?.data?.error || '移动失败'
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

const getAccessibilityStatus = (map) => {
  const requiredRank = getRealmRank(map.required_realm || '凡人')
  const playerRank = getRealmRank(playerRealm.value)
  const diff = requiredRank - playerRank
  
  if (diff <= 0) return { visible: true, disabled: false, reason: null }
  if (diff <= 5) return { visible: true, disabled: true, reason: `需提升 ${diff} 个境界` }
  return { visible: false, disabled: true, reason: null }
}

onMounted(() => {
  fetchData()
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>
    
    <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-5xl h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-500 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          修仙界全图
        </h2>
        <div class="flex items-center gap-4">
          <div class="text-xs text-stone-500">
            当前境界: <span class="text-amber-400">{{ playerRealm }}</span> | 
            速度: <span class="text-cyan-400">{{ playerSpeed }}</span>
          </div>
          <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <div class="p-4 border-b border-stone-800 bg-[#0c0a09]">
        <div class="flex flex-wrap gap-4 items-center">
          <input 
            v-model="searchKeyword" 
            type="text" 
            placeholder="搜索地图名称..." 
            class="px-3 py-1.5 bg-stone-900 border border-stone-700 rounded text-sm text-stone-200 placeholder-stone-500 focus:outline-none focus:border-amber-600"
          />
          <select v-model="filterType" class="px-3 py-1.5 bg-stone-900 border border-stone-700 rounded text-sm text-stone-200 focus:outline-none focus:border-amber-600">
            <option value="all">全部类型</option>
            <option v-for="(info, type) in mapTypeMap" :key="type" :value="type">{{ info.name }}</option>
          </select>
          <select v-model="filterRealm" class="px-3 py-1.5 bg-stone-900 border border-stone-700 rounded text-sm text-stone-200 focus:outline-none focus:border-amber-600">
            <option value="all">全部境界</option>
            <option value="low">低阶地图</option>
            <option value="mid">中阶地图</option>
            <option value="high">高阶地图</option>
          </select>
          <div class="text-xs text-stone-500 ml-auto">
            共 <span class="text-amber-400">{{ filteredMaps.length }}</span> 个地图
          </div>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-6 bg-[#0a0908]">
        <div v-if="loading" class="flex justify-center items-center h-64">
          <svg class="animate-spin h-10 w-10 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>

        <div v-else-if="filteredMaps.length === 0" class="flex flex-col items-center justify-center h-64 text-stone-500">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50"><circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          <p>暂无符合条件的可到达地图</p>
        </div>

        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div 
            v-for="map in filteredMaps" 
            :key="map.id"
            class="group relative bg-[#1c1917] border rounded-lg p-4 transition-all duration-300"
            :class="[
              getEnterStatus(map).canEnter 
                ? 'border-stone-800 hover:border-amber-700/50' 
                : 'border-stone-900 bg-[#151412] opacity-75',
              moving ? 'opacity-50' : ''
            ]"
          >
            <div class="flex justify-between items-start mb-2">
              <div class="flex items-center gap-2">
                <h4 class="text-lg font-bold transition-colors"
                    :class="getEnterStatus(map).canEnter 
                      ? 'text-stone-200 group-hover:text-amber-500' 
                      : 'text-stone-500'">
                  {{ map.name }}
                </h4>
                <span class="text-[10px] px-1.5 py-0.5 rounded border"
                      :class="[getMapTypeStyle(map.type).class, getMapTypeStyle(map.type).bg, getMapTypeStyle(map.type).border]">
                  {{ getMapTypeStyle(map.type).name }}
                </span>
                <svg v-if="!getEnterStatus(map).canEnter" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-stone-600">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </div>
              <span class="text-[10px] px-1.5 py-0.5 rounded border border-stone-800 bg-stone-900"
                    :class="getSafetyStyle(map.danger_level).class">
                {{ getSafetyStyle(map.danger_level).name }}
              </span>
            </div>
            
            <p class="text-xs text-stone-500 line-clamp-2 mb-3">{{ map.description }}</p>
            
            <div class="flex flex-wrap gap-2 mb-3">
              <span class="text-[10px] px-2 py-0.5 rounded bg-stone-900 border border-stone-800"
                    :class="getEnterStatus(map).canEnter ? 'text-stone-400' : 'text-stone-500'">
                境界: {{ map.requiredRealm || '凡人' }}
              </span>
              <span class="text-[10px] px-2 py-0.5 rounded bg-stone-900 border border-stone-800 text-stone-400">
                危险: {{ map.danger_level }}
              </span>
            </div>

            <div v-if="map.x !== undefined" class="text-xs text-stone-500 mb-3">
              距离: <span class="text-cyan-400">{{ formatDistance(calculateDistance(map)) }}</span>
            </div>

            <div class="flex items-center justify-between text-xs mt-auto pt-2 border-t border-stone-800/50">
              <div v-if="getEnterStatus(map).canEnter" class="text-stone-400">
                {{ calculateMoveCost(map).cost }} 灵力 · {{ formatTime(calculateMoveCost(map).time) }}
              </div>
              <div v-else class="text-stone-500">
                {{ calculateMoveCost(map).cost }} 灵力 · {{ formatTime(calculateMoveCost(map).time) }}
                <span v-if="getEnterStatus(map).reason" class="text-amber-600 ml-2">
                  {{ getEnterStatus(map).reason }}
                </span>
              </div>
              <button 
                v-if="getEnterStatus(map).canEnter"
                @click="handleMove(map)"
                :disabled="moving || playerStore.player.mp_current < calculateMoveCost(map).cost"
                class="px-3 py-1 rounded bg-amber-900/30 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 hover:text-amber-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span v-if="moving">移动中...</span>
                <span v-else>前往</span>
              </button>
              <div v-else class="text-xs text-stone-600 px-3 py-1">
                {{ getEnterStatus(map).reason || '境界不足' }}
              </div>
            </div>
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
