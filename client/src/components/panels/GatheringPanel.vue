<script setup>
/**
 * 资源采集面板
 *
 * 玩法：按当前地图产出可采集资源，消耗灵力采集入包，积累熟练度提升产出。
 * 数据来源：GET /gather/resources（资源清单 + 玩家熟练度）、GET /gather/stats（采集统计）。
 *
 * 契约：本面板已登记进 panels/registry.js（id=gather），必须走统一外壳 PanelShell，
 *       否则会脱离右坞停靠（ui-check 第 1 项会直接判失败）。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import apiClient from '../../api'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { usePlayerResources } from '../../composables/usePlayerResources'
import PanelShell from '../ui/PanelShell.vue'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()
const { patchFromResponse } = usePlayerResources()

const loading = ref(true)
const gathering = ref(false)
const resources = ref([])
const stats = ref(null)
const currentMap = ref(null)
const currentMapId = ref(null)
const countdownIntervals = ref({})
// UI-only 标记集合：记录本地倒计时已归零的资源ID
// 设计说明：倒计时归零后不直接改写 resource.can_gather（业务状态应由后端权威返回），
// 仅在本地标记，允许用户点击采集按钮尝试；后端会做最终校验，若仍在冷却则返回错误并触发刷新
const countdownEnded = ref(new Set())

const fetchData = async () => {
  loading.value = true
  try {
    const [mapRes, resourcesRes, statsRes] = await Promise.all([
      apiClient.get('/map/info'),
      apiClient.get('/gather/resources'),
      apiClient.get('/gather/stats')
    ])

    // 响应拦截器返回的是原始 axios 响应（见 api/index.ts 的 response 用例），
    // 后端体统一为 { code, data: {...} }，因此真实数据在 .data.data。
    // 旧代码只取 .data.current_map，拿到的是 undefined，面板才一直显示"无法获取当前地图信息"。
    // 这里保留 .data 兜底，兼容后端某天直接展开返回的情况。
    const mapData = mapRes.data?.data || mapRes.data || {}
    currentMap.value = mapData.current_map || null
    currentMapId.value = mapData.current_map?.id || null
    const resourcesData = resourcesRes.data?.data || resourcesRes.data || {}
    resources.value = resourcesData.resources || []
    stats.value = statsRes.data?.data || statsRes.data || null

    startCountdowns()
  } catch (error) {
    console.error('Failed to fetch gathering data:', error)
    if (error.response?.status === 404) {
      uiStore.showToast('当前地图暂无可采集资源', 'info')
      resources.value = []
    } else {
      uiStore.showApiError(error, '操作失败')
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
          // 倒计时归零：不直接改写后端权威的 can_gather，仅标记本地 UI 状态
          // 实际 can_gather 状态由后端下次拉取或采集请求校验后返回
          countdownEnded.value.add(key)
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

/**
 * 判断资源是否可采集（后端权威 can_gather 或本地倒计时已归零）
 * 后端返回的 can_gather 为权威值；本地 countdownEnded 仅用于倒计时归零后允许尝试点击，
 * 最终校验仍由后端完成，避免前端写死业务状态
 * @param {Object} resource - 资源对象
 * @returns {boolean} 是否可尝试采集
 */
const isResourceGatherable = (resource) => {
  return resource.can_gather || countdownEnded.value.has(resource.resource_id)
}

const handleGather = async (resource) => {
  if (gathering.value || !isResourceGatherable(resource)) return

  // 灵力校验由后端处理，前端仅做快速反馈提示
  if (playerStore.player.mp_current < resource.mp_cost) {
    uiStore.showToast(`灵力不足，需要 ${resource.mp_cost} 点灵力`, 'error')
    return
  }

  gathering.value = true
  try {
    const res = await apiClient.post('/gather/collect', { resourceId: resource.resource_id })

    const result = res.data
    uiStore.showToast(`采集成功！获得 ${result.quantity} 个 ${resource.name}${result.is_crit ? '（暴击）' : ''}`, 'success')

    uiStore.addLog({
      content: `你在 ${currentMap.value?.name || '未知地点'} 采集了 ${result.quantity} 个 ${resource.name}。`,
      type: 'gather',
      actorId: 'self'
    })

    // 使用后端返回的剩余灵力更新（走统一契约，mp_remaining → mp_current）
    patchFromResponse(result)

    // 采集成功后清除本地倒计时标记，由后端刷新的 can_gather 权威值接管
    countdownEnded.value.delete(resource.resource_id)
    await refreshResource(resource.resource_id)
    await fetchStats()
  } catch (error) {
    uiStore.showApiError(error, '采集失败')
    // 采集失败时（如仍在冷却），刷新资源状态以同步后端权威值
    if (error.response?.status === 400) {
      countdownEnded.value.delete(resource.resource_id)
      await refreshResource(resource.resource_id)
    }
  } finally {
    gathering.value = false
  }
}

const refreshResource = async (resourceId) => {
  try {
    const res = await apiClient.get('/gather/resources')
    const updatedResources = res.data.data?.resources || res.data.resources || []
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
    const res = await apiClient.get('/gather/stats')
    // 与 fetchData 同理：真实统计在 .data.data
    stats.value = res.data?.data || res.data || null
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
  const expToNext = resource.player_proficiency?.exp_to_next_level || 0
  if (expToNext <= 0) return 100
  return Math.min(100, (exp / expToNext) * 100)
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
  <PanelShell
    title="资源采集"
    size="lg"
    :hint="currentMap?.name || ''"
    :loading="loading"
    fill
    scoped-scroll
    @close="emit('close')"
  >
    <div class="flex h-full min-h-0">
      <!-- 左栏：当前地图的可采集资源 -->
      <div class="w-2/3 overflow-y-auto p-6">
        <div v-if="!currentMap" class="flex flex-col items-center justify-center h-64 text-fg-faint">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
          <p>无法获取当前地图信息</p>
        </div>

        <div v-else-if="resources.length === 0" class="flex flex-col items-center justify-center h-64 text-fg-faint">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/></svg>
          <p>{{ currentMap.name }} 暂无可采集资源</p>
        </div>

        <div v-else class="space-y-4">
          <div class="mb-4">
            <h3 class="text-lg font-bold text-fg-secondary mb-1">{{ currentMap.name }}</h3>
            <p class="text-sm text-fg-faint">{{ currentMap.description }}</p>
          </div>

          <div
            v-for="resource in resources"
            :key="resource.resource_id"
            class="bg-surface-raised border border-line-subtle rounded-lg p-4 transition-all"
            :class="{ 'opacity-60': !isResourceGatherable(resource) }"
          >
            <div class="flex justify-between items-start mb-3">
              <div>
                <h4 class="text-lg font-bold text-fg-secondary flex items-center gap-2">
                  {{ resource.name }}
                  <span class="text-xs px-2 py-0.5 rounded bg-surface-raised border border-line" :class="getDifficultyColor(resource.difficulty)">
                    难度 {{ resource.difficulty }}
                  </span>
                </h4>
                <p class="text-xs text-fg-faint mt-1">{{ resource.description }}</p>
              </div>
              <div class="text-right">
                <div class="text-xs text-fg-faint">消耗灵力</div>
                <div class="text-sm font-bold text-cyan-400">{{ resource.mp_cost }}</div>
              </div>
            </div>

            <div class="flex items-center gap-4 mb-3">
              <div class="flex-1">
                <div class="flex justify-between text-xs text-fg-faint mb-1">
                  <span>熟练度 Lv.{{ resource.player_proficiency?.level || 1 }} {{ resource.player_proficiency?.level_name || '入门' }}</span>
                  <span>{{ resource.player_proficiency?.exp || 0 }} / {{ resource.player_proficiency?.exp_to_next_level || 0 }}</span>
                </div>
                <div class="h-2 bg-surface-raised rounded-full overflow-hidden">
                  <div
                    class="h-full bg-gradient-to-r from-gold-600 to-gold-400 transition-all duration-500"
                    :style="{ width: getProficiencyPercent(resource) + '%' }"
                  ></div>
                </div>
              </div>
              <div class="text-xs text-fg-faint whitespace-nowrap">
                总计: {{ resource.player_proficiency?.total_count || 0 }} 次
              </div>
            </div>

            <div class="flex items-center justify-between">
              <div class="text-xs">
                <span v-if="isResourceGatherable(resource)" class="text-emerald-400">可采集</span>
                <span v-else class="text-orange-400">冷却中 {{ resource.countdown }}</span>
              </div>
              <button
                @click="handleGather(resource)"
                :disabled="gathering || !isResourceGatherable(resource) || playerStore.player.mp_current < resource.mp_cost"
                class="px-4 py-1.5 rounded bg-emerald-900/30 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span v-if="gathering">采集中...</span>
                <span v-else-if="!isResourceGatherable(resource)">等待冷却</span>
                <span v-else-if="playerStore.player.mp_current < resource.mp_cost">灵力不足</span>
                <span v-else>采集</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 右栏：采集统计与熟练度说明 -->
      <div class="w-1/3 border-l border-line-subtle bg-surface-canvas p-4 overflow-y-auto">
        <h3 class="text-sm font-bold text-fg-muted mb-4 uppercase tracking-wider">采集统计</h3>

        <div class="space-y-4">
          <div class="bg-surface-raised rounded-lg p-4 border border-line-subtle">
            <div class="text-2xl font-bold text-gold-500">{{ totalGatherCount }}</div>
            <div class="text-xs text-fg-faint">总采集次数</div>
          </div>

          <div class="bg-surface-raised rounded-lg p-4 border border-line-subtle">
            <div class="text-2xl font-bold text-cyan-400">{{ resourcesCollected }}</div>
            <div class="text-xs text-fg-faint">已探索资源</div>
          </div>

          <div class="bg-surface-raised rounded-lg p-4 border border-line-subtle">
            <div class="text-2xl font-bold text-purple-400">{{ highestLevel }}</div>
            <div class="text-xs text-fg-faint">最高熟练度</div>
          </div>
        </div>

        <div class="mt-6">
          <h4 class="text-xs font-bold text-fg-faint mb-3 uppercase tracking-wider">熟练度等级</h4>
          <div class="space-y-2 text-xs">
            <div class="flex justify-between text-fg-muted">
              <span>1-9</span>
              <span>入门</span>
            </div>
            <div class="flex justify-between text-fg-muted">
              <span>10-29</span>
              <span>熟练</span>
            </div>
            <div class="flex justify-between text-fg-muted">
              <span>30-49</span>
              <span>精通</span>
            </div>
            <div class="flex justify-between text-fg-muted">
              <span>50-69</span>
              <span>专家</span>
            </div>
            <div class="flex justify-between text-fg-muted">
              <span>70-89</span>
              <span>大师</span>
            </div>
            <div class="flex justify-between text-gold-400">
              <span>90+</span>
              <span>宗师</span>
            </div>
          </div>
        </div>

        <div class="mt-6 p-3 bg-surface-raised/50 rounded border border-line-subtle">
          <p class="text-xs text-fg-faint leading-relaxed">
            采集时可获得熟练度经验，熟练度越高，获得的产出越多。采集也有一定概率触发暴击，获得双倍产出。
          </p>
        </div>
      </div>
    </div>
  </PanelShell>
</template>