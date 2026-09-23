<template>
  <div class="space-y-3">
    <!-- 提醒条：可突破 / 战斗未结束，出现时排最前 -->
    <div
      v-if="player?.can_breakthrough"
      @click="$emit('action', 'cultivate')"
      class="flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer border animate-pulse
             bg-purple-900/25 border-purple-600/50 text-purple-200 hover:bg-purple-900/40"
    >
      <span class="text-sm font-bold tracking-wider">修为已满，可尝试突破境界</span>
    </div>

    <!-- 状态卡：闭关 / 悟道 / 历练进度条由 GameLayout 通过 slot 注入 -->
    <section v-if="hasStatus" class="rounded-lg border border-line-subtle bg-surface-raised overflow-hidden">
      <h3 class="px-3 py-1.5 text-[11px] text-fg-faint tracking-[0.2em] border-b border-line-subtle/70 font-display">当前状态</h3>
      <slot name="status" />
    </section>

    <!-- 地图卡：常驻当前位置与相邻快传，不必再开合全屏地图面板 -->
    <section class="rounded-lg border border-line-subtle bg-surface-raised overflow-hidden">
      <div class="flex items-center justify-between px-3 py-1.5 border-b border-line-subtle/70">
        <h3 class="text-[11px] text-fg-faint tracking-[0.2em] font-display">所在区域</h3>
        <button
          @click="$emit('action', 'map')"
          class="text-[11px] text-fg-faint hover:text-gold-500 transition-colors"
        >查看全图 ›</button>
      </div>

      <div class="p-3">
        <div class="flex items-baseline gap-2 mb-2.5">
          <span class="text-base font-bold text-emerald-400 tracking-wider">{{ currentMapName }}</span>
          <span v-if="mapLoading" class="text-[11px] text-fg-faint">载入中…</span>
        </div>

        <div v-if="connectedMaps.length" class="grid grid-cols-2 gap-1.5">
          <button
            v-for="map in connectedMaps"
            :key="map.id"
            @click="handleMove(map)"
            :disabled="moving"
            class="group flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border border-line-subtle bg-surface-base
                   text-left transition-colors hover:border-line-strong hover:bg-surface-hover disabled:opacity-40"
          >
            <span class="min-w-0">
              <span class="block text-[12px] text-fg-secondary group-hover:text-gold-500 truncate transition-colors">{{ map.name }}</span>
              <span class="block text-[10px] text-fg-faint">{{ formatCost(map.move_cost) }}</span>
            </span>
            <span class="shrink-0 text-[10px] px-1.5 py-0.5 rounded" :class="safetyClass(map)">{{ safetyLabel(map) }}</span>
          </button>
        </div>
        <div v-else-if="!mapLoading" class="text-[11px] text-fg-faint py-1">此处暂无可直达的相邻区域。</div>
      </div>
    </section>

    <!-- 快捷入口：高频 12 项，卡片带名称与说明 -->
    <section class="rounded-lg border border-line-subtle bg-surface-raised overflow-hidden">
      <h3 class="px-3 py-1.5 text-[11px] text-fg-faint tracking-[0.2em] border-b border-line-subtle/70 font-display">快捷入口</h3>
      <div class="grid grid-cols-3 lg:grid-cols-4 gap-1.5 p-2.5">
        <button
          v-for="entry in quickEntries"
          :key="entry.id"
          @click="$emit('action', entry.id)"
          class="group flex items-center gap-2 px-2.5 py-2 rounded border border-line-subtle bg-surface-base
                 transition-colors hover:border-line-strong hover:bg-surface-hover"
          :title="entry.desc"
        >
          <span class="shrink-0 transition-transform duration-200 group-hover:scale-110" v-html="entry.icon"></span>
          <span class="min-w-0 text-left">
            <span class="block text-[12px] text-fg-secondary group-hover:text-gold-500 tracking-wide transition-colors truncate">{{ entry.name }}</span>
            <!-- 说明文字：原来是 text-line-strong（一个描边用的令牌当文字色），
                 在浅底上几乎看不见，还叠了 truncate 把"闭关修炼 突破境界"砍成"闭关修炼 突破…"。
                 换成正文字色 + 允许两行，玩家才真能靠它认功能。 -->
            <span class="block text-[10px] text-fg-faint leading-snug line-clamp-2">{{ entry.desc }}</span>
          </span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
/**
 * 总览页：把玩家每次上线都要看的东西（进度提醒 / 当前状态 / 位置 / 高频入口）
 * 常驻在这里，而不是每次都开一个全屏面板再关掉。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { QUICK_ACTION_IDS, resolveAction } from '../../data/actionCatalog'
import { getMapInfo, startMove } from '../../api/map'
import { getGameBalancePublic } from '../../api/config'
import { buildSafetyLevelNameMap, getSafetyStyle } from '../../utils/mapStyles'

const props = defineProps({
  player: { type: Object, default: null }
})
defineEmits(['action'])

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const quickEntries = computed(() => QUICK_ACTION_IDS.map(resolveAction).filter(Boolean))

const hasStatus = computed(() => {
  const p = props.player
  return !!(p?.is_secluded || p?.is_meditating || playerStore.adventureStatus?.is_adventuring)
})

/* ── 地图卡 ── */
const mapLoading = ref(false)
const moving = ref(false)
const currentMap = ref(null)
const connectedMaps = ref([])
// 危险等级中文名由后端 game_balance 下发，前端只出样式（与 MapPanel 同一约定）
const safetyLevelNameMap = ref({})
let pollTimer = null

const fetchSafetyLevelNames = async () => {
  try {
    const res = await getGameBalancePublic()
    const levelNames = res.data?.data?.safety_levels
    if (levelNames) safetyLevelNameMap.value = buildSafetyLevelNameMap(levelNames)
  } catch (error) {
    console.warn('[OverviewPane] 拉取危险等级配置失败，使用降级默认值:', error)
  }
}

const currentMapName = computed(() => currentMap.value?.name || props.player?.current_map?.name || '未知区域')

const fetchMap = async () => {
  try {
    const res = await getMapInfo()
    currentMap.value = res.data.data?.current_map ?? null
    connectedMaps.value = res.data.data?.connected_maps ?? []
  } catch (error) {
    // 静默：总览只是快捷视图，失败时保留上一次数据
    console.warn('[OverviewPane] 拉取地图信息失败:', error)
  } finally {
    mapLoading.value = false
  }
}

const formatCost = (cost) => {
  if (!cost) return '无需灵力'
  return `灵力 ${cost}`
}

const safetyStyle = (map) => getSafetyStyle(map.safety_level, safetyLevelNameMap.value)
const safetyLabel = (map) => safetyStyle(map).name ?? '未知'
const safetyClass = (map) => safetyStyle(map).class ?? 'text-fg-muted'

const handleMove = async (targetMap) => {
  if (moving.value) return
  if (targetMap.move_cost && Number(props.player?.mp_current ?? 0) < targetMap.move_cost) {
    uiStore.showToast(`灵力不足，前往${targetMap.name}需要 ${targetMap.move_cost} 点灵力`, 'error')
    return
  }
  moving.value = true
  try {
    const res = await startMove(targetMap.id)
    const data = res.data.data
    playerStore.setMovingState({
      from_map_id: data.from_map_id,
      to_map_id: data.to_map_id,
      from_map_name: data.from_map_name,
      to_map_name: data.to_map_name,
      start_time: data.start_time,
      end_time: data.end_time,
      total_seconds: data.total_seconds
    })
    await fetchMap()
  } catch (error) {
    console.error('[OverviewPane] 赶路失败:', error)
    uiStore.showApiError(error, '赶路失败')
  } finally {
    moving.value = false
  }
}

onMounted(() => {
  mapLoading.value = true
  fetchSafetyLevelNames()
  fetchMap()
  // 赶路完成后当前位置会变，这里低频轮询保持总览不撒谎
  pollTimer = setInterval(fetchMap, 20000)
})
onUnmounted(() => clearInterval(pollTimer))
</script>
