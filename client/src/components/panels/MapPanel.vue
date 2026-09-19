<script setup>
import { ref, onMounted, computed } from 'vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import FullMapList from './FullMapList.vue'
import WorldMapPanel from './WorldMapPanel.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import EmptyState from '../ui/EmptyState.vue'
import { getMapInfo, getMapConfig, startMove } from '../../api/map'
import { getGameBalancePublic } from '../../api/config'
import { buildMapTypeNameMap, buildSafetyLevelNameMap, getMapTypeStyle as getMapTypeStyleUtil, getSafetyStyle as getSafetyStyleUtil } from '../../utils/mapStyles'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

const loading = ref(true)
const moving = ref(false)
const currentMap = ref(null)
const connectedMaps = ref([])
const mapConfigs = ref({})
const activeTab = ref('connected') // 'connected' 或 'all'

/** 页签定义（key/label 契约见 ui/Tabs.vue） */
const tabItems = [
  { key: 'connected', label: '可行路径' },
  { key: 'all', label: '全部地图' },
  { key: 'world', label: '大世界' }
]

// ====== 地图类型与危险等级映射（从后端拉取中文名，样式由 utils/mapStyles 提供） ======
// 后端配置：game_balance.map_types / safety_levels
const mapTypeNames = ref({})
const safetyLevelNames = ref({})

// 合并后的映射（中文名 + Tailwind 样式），供 getMapTypeStyle / getSafetyStyle 使用
const mapTypeNameMap = computed(() => buildMapTypeNameMap(mapTypeNames.value))
const safetyLevelNameMap = computed(() => buildSafetyLevelNameMap(safetyLevelNames.value))

/**
 * 拉取公开游戏配置（地图类型、危险等级中文名）
 * 失败时降级为空映射，utils/mapStyles 会兜底使用前端样式表
 */
const fetchGameConfig = async () => {
  try {
    const res = await getGameBalancePublic()
    if (res.data?.code === 200 && res.data.data) {
      if (res.data.data.map_types) mapTypeNames.value = res.data.data.map_types
      if (res.data.data.safety_levels) safetyLevelNames.value = res.data.data.safety_levels
    }
  } catch (error) {
    console.error('[MapPanel] 拉取地图配置失败，使用降级默认值:', error)
  }
}

const fetchMapInfo = async () => {
  loading.value = true
  try {
    const res = await getMapInfo()
    currentMap.value = res.data.data?.current_map
    connectedMaps.value = res.data.data?.connected_maps
  } catch (error) {
    console.error('Fetch map info failed:', error)
    uiStore.showApiError(error, 'Fetch map info failed')
  } finally {
    loading.value = false
  }
}

const fetchMapConfigs = async () => {
  try {
    const res = await getMapConfig()
    const maps = res.data.data?.maps || res.data.maps || []
    maps.forEach(m => {
      mapConfigs.value[m.id] = m
    })
  } catch (error) {
    console.error('Fetch map config failed:', error)
  }
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
  
  // 使用后端返回的 move_cost 进行校验
  if (targetMap.move_cost && Number(playerStore.player.mp_current) < targetMap.move_cost) {
     uiStore.showToast(`灵力不足，需要 ${targetMap.move_cost} 点灵力`, 'error')
     return
  }

  moving.value = true
  try {
    const res = await startMove(targetMap.id)
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
    
    // 刷新地图信息以获取最新数据
    await fetchMapInfo()
    emit('close')
  } catch (error) {
    uiStore.showApiError(error, '移动失败')
  } finally {
    moving.value = false
  }
}

/**
 * 获取地图类型样式（中文名从后端配置，样式从 utils/mapStyles）
 * @param type - 地图类型 key
 */
const getMapTypeStyle = (type) => {
  return getMapTypeStyleUtil(type, mapTypeNameMap.value)
}

/**
 * 获取危险等级样式（中文名从后端配置，样式从 utils/mapStyles）
 * @param level - 危险等级数字
 */
const getSafetyStyle = (level) => {
  return getSafetyStyleUtil(level, safetyLevelNameMap.value)
}

onMounted(async () => {
  // 并行拉取地图配置、地图信息和游戏配置
  await Promise.all([fetchMapConfigs(), fetchMapInfo(), fetchGameConfig()])
})
</script>

<template>
  <PanelShell
    title="修仙界地图"
    hint="可行路径 · 全部地图 · 大世界"
    size="xl"
    :loading="loading"
    scoped-scroll
    @close="emit('close')"
  >
    <div class="h-full flex flex-col">
      <!-- 标签页切换 -->
      <Tabs v-model="activeTab" :items="tabItems" class="shrink-0 bg-surface-raised" />

      <!-- 内容区：左侧当前位置 + 右侧地图列表（各自内部滚动，故外壳不再包一层） -->
      <div class="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
        <!-- 左侧：当前位置信息 (仅在可行路径标签显示) -->
        <div
          v-if="activeTab === 'connected'"
          class="w-full md:w-1/3 p-5 border-b md:border-b-0 md:border-r border-line-subtle bg-surface-canvas flex flex-col gap-5 overflow-y-auto scroll-thin"
        >
          <div v-if="currentMap" class="animate-slide-in">
            <div class="mb-2 flex items-center gap-2">
              <span
                class="text-xs px-2 py-0.5 rounded border"
                :class="[getMapTypeStyle(currentMap.type).class, getMapTypeStyle(currentMap.type).bg, getMapTypeStyle(currentMap.type).border]"
              >
                {{ getMapTypeStyle(currentMap.type).name }}
              </span>
              <span
                class="text-xs px-2 py-0.5 rounded border border-line-subtle bg-surface-raised"
                :class="getSafetyStyle(currentMap.danger_level).class"
              >
                {{ getSafetyStyle(currentMap.danger_level).name }}
              </span>
            </div>

            <h3 class="text-3xl font-bold text-fg-primary mb-4 font-display">{{ currentMap.name }}</h3>

            <div class="text-fg-muted text-sm leading-relaxed mb-6 border-l-2 border-line-subtle pl-4 italic">
              {{ currentMap.description || '暂无描述' }}
            </div>

            <div class="space-y-4">
              <div>
                <h4 class="text-xs font-bold text-fg-faint uppercase tracking-wider mb-2">环境消耗</h4>
                <div class="text-fg-secondary text-sm">
                  {{ currentMap.environment_cost > 0 ? `每小时消耗 ${currentMap.environment_cost} 点灵力` : '无灵力消耗' }}
                </div>
              </div>

              <div>
                <h4 class="text-xs font-bold text-fg-faint uppercase tracking-wider mb-2">境界要求</h4>
                <div class="text-fg-secondary text-sm">
                  {{ currentMap.requiredRealm || '凡人' }}
                </div>
              </div>

              <!-- 资源列表 (静态展示，暂不可交互) -->
              <div v-if="currentMap.resources && currentMap.resources.length > 0">
                <h4 class="text-xs font-bold text-fg-faint uppercase tracking-wider mb-2">主要产出</h4>
                <div class="flex flex-wrap gap-2">
                  <span
                    v-for="res in currentMap.resources"
                    :key="res.name"
                    class="px-2 py-1 bg-surface-raised border border-line-subtle rounded-control text-xs text-fg-muted hover:text-fg-primary transition-colors cursor-help"
                    :title="`难度: ${res.difficulty}, 刷新: ${res.cooldown / 60}分`"
                  >
                    {{ res.name }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧：地图列表 -->
        <div class="flex-1 min-h-0 overflow-hidden">
          <!-- 可行路径列表 -->
          <div
            v-if="activeTab === 'connected'"
            class="h-full p-5 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-surface-sunken/50 relative overflow-y-auto scroll-thin"
          >
            <h3 class="text-lg font-bold text-fg-secondary mb-4 flex items-center gap-2 font-display">
              <span>可行路径</span>
              <span class="text-xs font-normal text-fg-faint">Connected Paths</span>
            </h3>

            <EmptyState
              v-if="connectedMaps.length === 0"
              text="此地似乎是一处绝地，没有出口。"
              hint="换到「全部地图」查看已知疆域，或去「大世界」寻一处有去路的落脚地"
            />

            <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div
                v-for="map in connectedMaps"
                :key="map.id"
                class="group relative bg-surface-raised border border-line-subtle hover:border-gold-700/50 rounded-panel p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg cursor-pointer"
                @click="handleMove(map)"
              >
                <!-- 连线装饰 -->
                <div class="absolute top-1/2 -left-2 w-2 h-px bg-line-subtle group-hover:bg-gold-800/50 transition-colors hidden sm:block"></div>

                <div class="flex justify-between items-start mb-2">
                  <h4 class="text-base font-bold text-fg-primary group-hover:text-gold-500 transition-colors">{{ map.name }}</h4>
                  <span
                    class="text-[10px] px-1.5 py-0.5 rounded border bg-surface-sunken/50"
                    :class="getMapTypeStyle(map.type).class + ' ' + getMapTypeStyle(map.type).border"
                  >
                    {{ getMapTypeStyle(map.type).name }}
                  </span>
                </div>

                <p class="text-xs text-fg-faint line-clamp-2 mb-2 h-8">{{ map.description }}</p>

                <div class="flex items-center gap-2 mb-3">
                  <span class="text-[10px] px-2 py-0.5 rounded bg-gold-900/30 border border-gold-700/50 text-gold-400">
                    境界: {{ map.requiredRealm || '凡人' }}
                  </span>
                </div>

                <div class="flex items-center justify-between text-xs mt-auto pt-2 border-t border-line-subtle/50">
                  <span :class="getSafetyStyle(map.danger_level).class">{{ getSafetyStyle(map.danger_level).name }}</span>
                  <span class="text-fg-muted group-hover:text-gold-400 flex items-center gap-1">
                    {{ map.move_cost || 0 }}灵力 · {{ formatTime(map.move_time || 0) }}
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

          <!-- 大世界地图（World Map MVP：2D 俯视大世界 + 同图多人实时可见） -->
          <div v-else-if="activeTab === 'world'" class="h-full overflow-hidden">
            <WorldMapPanel @close="emit('close')" />
          </div>
        </div>
      </div>
    </div>
  </PanelShell>
</template>
