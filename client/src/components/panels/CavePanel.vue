<script setup lang="ts">
/**
 * 洞府系统面板组件
 *
 * 功能说明：
 *   - 全屏遮罩 + 居中弹窗布局，emits('close') 关闭面板
 *   - 顶部 Tab 切换：洞府经营（设施升级 / 灵脉领取 / 地块解锁）/ 小药园（播种 / 采收）
 *   - 洞府经营：未开辟时显示开辟入口（炼气期 + 1000 灵石）；已开辟时展示五大设施卡片
 *   - 小药园：3 列地块网格，支持播种（种子选择弹窗）、采收、一键采收
 *   - 所有业务逻辑通过 cave / garden API 调用后端，前端只做展示与交互
 *   - 所有确认操作（开辟 / 升级 / 领取 / 解锁 / 播种 / 采收）均使用自定义 Modal 二次确认
 *   - 禁用浏览器原生 alert / confirm，统一使用自定义 Modal 组件
 *   - 倒计时使用 setInterval 每秒更新，基于后端 mature_at 时间戳本地递减展示
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import {
  getCaveInfo,
  openCave,
  upgradeFacility,
  collectStones,
  unlockPlot,
  type CaveInfo,
  type FacilityType,
  type FacilityInfo
} from '../../api/cave'
import {
  getGardenStatus,
  plantSeed,
  harvestPlot,
  harvestAll,
  type GardenStatus,
  type PlotInfo,
  type AvailableSeed
} from '../../api/garden'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

// ====== 响应式状态 ======
const loading = ref(true)                        // 整体加载状态
const operating = ref(false)                     // 操作中状态锁，防止重复提交
const activeTab = ref<'cave' | 'garden'>('cave') // 当前激活的 Tab
const caveInfo = ref<CaveInfo | null>(null)      // 洞府完整信息
const gardenStatus = ref<GardenStatus | null>(null) // 药园完整状态
// 当前时间戳，每秒更新一次用于驱动种植倒计时刷新
const currentTime = ref(Date.now())
let timer: number | null = null

// ====== 确认弹窗状态（统一管理 开辟 / 升级 / 领取 / 解锁 / 播种 / 采收 / 一键采收 七类确认） ======
type ConfirmType = 'open' | 'upgrade' | 'collect' | 'unlock' | 'plant' | 'harvest' | 'harvestAll'
const confirmModal = ref<{
  show: boolean
  type: ConfirmType
  // 升级时存 { facility, info }，播种时存 { plotIndex, seed }，采收时存 PlotInfo，其余为 null
  payload: any
}>({
  show: false,
  type: 'open',
  payload: null
})

// ====== 种子选择弹窗状态 ======
const seedModal = ref<{ show: boolean; plotIndex: number }>({
  show: false,
  plotIndex: -1
})

// ====== 计算属性 ======

/**
 * 是否已开辟洞府
 */
const isOpened = computed(() => !!caveInfo.value?.is_opened)

/**
 * 设施列表（按固定顺序展示：灵脉 / 静室 / 丹房 / 器室 / 大阵）
 */
const facilityList = computed<{ type: FacilityType; info: FacilityInfo }[]>(() => {
  if (!caveInfo.value?.facilities) return []
  // 固定展示顺序，便于玩家按核心度浏览
  const order: FacilityType[] = ['spirit_vein', 'quiet_room', 'pill_room', 'tool_room', 'grand_formation']
  return order
    .map(type => ({ type, info: caveInfo.value!.facilities![type] }))
    .filter(item => !!item.info)
})

/**
 * 是否有成熟作物可一键采收
 */
const hasMaturePlot = computed(() => {
  return (gardenStatus.value?.plots || []).some(p => p.status === 'mature' && p.can_harvest)
})

/**
 * 药园地块是否已达上限（用于隐藏解锁按钮）
 */
const isPlotMaxed = computed(() => {
  const plots = caveInfo.value?.garden_plots
  if (!plots) return true
  return plots.current >= plots.max
})

// ====== 数据加载 ======

/**
 * 初始化加载：并行获取洞府信息与药园状态，减少首屏等待
 */
const fetchAll = async () => {
  loading.value = true
  try {
    await Promise.all([fetchCaveInfo(), fetchGardenStatus()])
  } catch (error) {
    console.error('[CavePanel] 加载洞府数据失败:', error)
    uiStore.showToast('加载洞府数据失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 获取洞府完整信息（含设施等级、灵脉产出、药园地块概览）
 */
const fetchCaveInfo = async () => {
  try {
    const res = await getCaveInfo()
    caveInfo.value = res.data?.data || null
  } catch (error) {
    console.error('[CavePanel] 获取洞府信息失败:', error)
    caveInfo.value = null
  }
}

/**
 * 获取药园完整状态（含地块列表与可用种子）
 */
const fetchGardenStatus = async () => {
  try {
    const res = await getGardenStatus()
    gardenStatus.value = res.data?.data || null
  } catch (error) {
    console.error('[CavePanel] 获取药园状态失败:', error)
    gardenStatus.value = null
  }
}

// ====== 操作处理：打开确认弹窗 ======

/**
 * 点击开辟洞府按钮：打开确认弹窗
 */
const handleOpenCave = () => {
  if (operating.value) return
  confirmModal.value = { show: true, type: 'open', payload: null }
}

/**
 * 点击升级设施按钮：打开确认弹窗
 * @param facility - 设施类型
 * @param info - 设施信息
 */
const handleUpgrade = (facility: FacilityType, info: FacilityInfo) => {
  if (operating.value || !info.can_upgrade) return
  confirmModal.value = { show: true, type: 'upgrade', payload: { facility, info } }
}

/**
 * 点击领取灵石按钮：打开确认弹窗
 */
const handleCollect = () => {
  if (operating.value) return
  confirmModal.value = { show: true, type: 'collect', payload: null }
}

/**
 * 点击解锁地块按钮：打开确认弹窗
 */
const handleUnlockPlot = () => {
  if (operating.value) return
  confirmModal.value = { show: true, type: 'unlock', payload: null }
}

/**
 * 点击播种按钮：打开种子选择弹窗（选择种子后再弹二次确认）
 * @param plotIndex - 地块序号
 */
const handleOpenSeedModal = (plotIndex: number) => {
  if (operating.value) return
  seedModal.value = { show: true, plotIndex }
}

/**
 * 选中种子后：关闭种子弹窗，打开播种确认弹窗
 * @param seed - 选中的种子
 */
const handleSelectSeed = (seed: AvailableSeed) => {
  confirmModal.value = {
    show: true,
    type: 'plant',
    payload: { plotIndex: seedModal.value.plotIndex, seed }
  }
  seedModal.value.show = false
}

/**
 * 点击采收按钮：打开确认弹窗
 * @param plot - 地块信息
 */
const handleHarvest = (plot: PlotInfo) => {
  if (operating.value || !plot.can_harvest) return
  confirmModal.value = { show: true, type: 'harvest', payload: plot }
}

/**
 * 点击一键采收按钮：打开确认弹窗
 */
const handleHarvestAll = () => {
  if (operating.value) return
  confirmModal.value = { show: true, type: 'harvestAll', payload: null }
}

/**
 * 关闭确认弹窗
 */
const closeConfirmModal = () => {
  confirmModal.value.show = false
  confirmModal.value.payload = null
}

/**
 * 确认弹窗回调：根据 type 执行对应后端操作
 */
const handleConfirm = async () => {
  const { type, payload } = confirmModal.value
  // 先关闭弹窗，再执行操作（避免操作期间弹窗被多次点击）
  closeConfirmModal()

  if (type === 'open') {
    await doOpenCave()
  } else if (type === 'upgrade' && payload) {
    await doUpgrade(payload.facility as FacilityType, payload.info as FacilityInfo)
  } else if (type === 'collect') {
    await doCollect()
  } else if (type === 'unlock') {
    await doUnlockPlot()
  } else if (type === 'plant' && payload) {
    await doPlant(payload.plotIndex as number, payload.seed as AvailableSeed)
  } else if (type === 'harvest' && payload) {
    await doHarvest(payload as PlotInfo)
  } else if (type === 'harvestAll') {
    await doHarvestAll()
  }
}

// ====== 操作执行：调用后端 API ======

/**
 * 执行开辟洞府
 * 消耗灵石（具体数值由后端 cave_data.json 配置决定），同步玩家灵石余额
 */
const doOpenCave = async () => {
  operating.value = true
  try {
    const res = await openCave()
    const result = res.data
    uiStore.showToast(result.message || '洞府开辟成功', 'success')

    // 同步玩家灵石（开辟消耗灵石，后端可能返回在顶层或 data 中）
    syncPlayerStones(result)

    await fetchAll()
    uiStore.addLog({
      content: '你开辟了属于自己的洞府，自此可于灵脉之地修行积累。',
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '开辟洞府失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行升级设施
 * @param facility - 设施类型
 * @param info - 设施当前信息
 */
const doUpgrade = async (facility: FacilityType, info: FacilityInfo) => {
  operating.value = true
  try {
    const res = await upgradeFacility(facility)
    const result = res.data
    uiStore.showToast(result.message || `【${info.name}】升级成功`, 'success')

    syncPlayerStones(result)

    await fetchCaveInfo()
    uiStore.addLog({
      content: `你将洞府设施【${info.name}】升至 ${info.level + 1} 级。`,
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '升级失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行领取灵脉灵石
 */
const doCollect = async () => {
  operating.value = true
  try {
    const res = await collectStones()
    const result = res.data
    // 后端返回 amount 可能在顶层或 data 中
    const amount = result.amount ?? result.data?.amount ?? 0
    uiStore.showToast(result.message || `领取灵石 +${amount}`, 'success')

    syncPlayerStones(result)

    await fetchCaveInfo()
    uiStore.addLog({
      content: `你在洞府灵脉领取灵石 +${amount}。`,
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '领取失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行解锁药园地块
 */
const doUnlockPlot = async () => {
  operating.value = true
  try {
    const res = await unlockPlot()
    const result = res.data
    uiStore.showToast(result.message || '解锁新地块成功', 'success')

    syncPlayerStones(result)

    await fetchAll()
    uiStore.addLog({
      content: '你开辟了新的药园地块，可种植更多灵草。',
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '解锁失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行播种
 * @param plotIndex - 地块序号
 * @param seed - 选中的种子
 */
const doPlant = async (plotIndex: number, seed: AvailableSeed) => {
  operating.value = true
  try {
    const res = await plantSeed(plotIndex, seed.seed_id)
    const result = res.data
    uiStore.showToast(result.message || `播种【${seed.name}】成功`, 'success')

    syncPlayerStones(result)

    await fetchGardenStatus()
    uiStore.addLog({
      content: `你在药园地块 #${plotIndex + 1} 播种了【${seed.name}】。`,
      type: 'info',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '播种失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行采收指定地块
 * @param plot - 地块信息
 */
const doHarvest = async (plot: PlotInfo) => {
  operating.value = true
  try {
    const res = await harvestPlot(plot.plot_index)
    const result = res.data
    const data = result.data || {}
    uiStore.showToast(
      result.message || `采收【${data.produce_name || '灵草'}】 x${data.yield || 1}`,
      'success'
    )

    syncPlayerStones(result)

    await fetchGardenStatus()
    uiStore.addLog({
      content: `你采收了地块 #${plot.plot_index + 1}，获得【${data.produce_name || '灵草'}】 x${data.yield || 1}（${data.quality || '普通'}）。`,
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '采收失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行一键采收所有成熟作物
 */
const doHarvestAll = async () => {
  operating.value = true
  try {
    const res = await harvestAll()
    const result = res.data
    uiStore.showToast(result.message || '一键采收完成', 'success')

    syncPlayerStones(result)

    await fetchGardenStatus()
    uiStore.addLog({
      content: '你一键采收了所有成熟灵草。',
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '一键采收失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== 辅助方法 ======

/**
 * 同步玩家灵石余额（后端可能在顶层或 data 中返回 spirit_stones）
 * @param result - API 响应体
 */
const syncPlayerStones = (result: any) => {
  if (!playerStore.player) return
  const spiritStones = result?.spirit_stones ?? result?.data?.spirit_stones
  if (spiritStones !== undefined) {
    playerStore.player.spirit_stones = spiritStones
  }
}

/**
 * 设施类型中文名映射
 */
const facilityNameMap: Record<FacilityType, string> = {
  spirit_vein: '灵脉',
  quiet_room: '静室',
  pill_room: '丹房',
  tool_room: '器室',
  grand_formation: '大阵'
}

/**
 * 获取设施类型中文名
 * @param type - 设施类型
 */
const getFacilityName = (type: FacilityType) => facilityNameMap[type] || type

/**
 * 格式化升级消耗展示
 * @param info - 设施信息
 */
const formatUpgradeCost = (info: FacilityInfo) => {
  if (!info.upgrade_cost) return '—'
  const cost = info.upgrade_cost
  const parts: string[] = []
  if (cost.spirit_stone > 0) parts.push(`${cost.spirit_stone} 灵石`)
  if (cost.material && cost.material_count > 0) {
    parts.push(`${cost.material} x${cost.material_count}`)
  }
  return parts.length > 0 ? parts.join(' + ') : '—'
}

/**
 * 计算地块实时剩余秒数（基于后端 mature_at 时间戳 + 本地 tick 递减）
 * 设计说明：后端返回 mature_at 为成熟时间点，前端每秒基于 currentTime 计算剩余秒数
 * @param plot - 地块信息
 */
const getPlotRemainingSeconds = (plot: PlotInfo) => {
  if (plot.status !== 'planted' || !plot.mature_at) return 0
  const matureTime = new Date(plot.mature_at).getTime()
  // 本地当前时间与成熟时间点的差值即为剩余秒数
  const remaining = Math.floor((matureTime - currentTime.value) / 1000)
  return Math.max(0, remaining)
}

/**
 * 格式化种植倒计时为 Xh Xm Xs 格式
 * @param seconds - 剩余秒数
 */
const formatCountdown = (seconds: number) => {
  if (seconds <= 0) return '已成熟'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h}h ${m}m ${s}s`
}

/**
 * 格式化种子生长时间展示
 * @param seconds - 生长总秒数
 */
const formatGrowTime = (seconds: number) => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0 && m > 0) return `${h}小时${m}分`
  if (h > 0) return `${h}小时`
  if (m > 0) return `${m}分钟`
  return `${seconds}秒`
}

// ====== 生命周期 ======
onMounted(() => {
  fetchAll()
  // 每秒更新当前时间，驱动种植倒计时刷新
  timer = window.setInterval(() => {
    currentTime.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  // 组件卸载时清除定时器，避免内存泄漏
  if (timer) {
    clearInterval(timer)
    timer = null
  }
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- 遮罩层：点击关闭面板 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>

    <!-- 主容器 -->
    <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-5xl h-[88vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
      <!-- 顶部标题栏 -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-500 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12l9-9 9 9"/>
            <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/>
            <path d="M9 21v-6h6v6"/>
          </svg>
          洞府
        </h2>
        <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex items-center gap-1 p-3 border-b border-stone-800 bg-[#0c0a09]">
        <button
          @click="activeTab = 'cave'"
          class="px-4 py-1.5 rounded text-sm whitespace-nowrap transition-colors"
          :class="activeTab === 'cave'
            ? 'bg-amber-900/30 text-amber-400 border border-amber-700/50'
            : 'text-stone-500 hover:text-stone-300 border border-transparent'"
        >
          洞府经营
        </button>
        <button
          @click="activeTab = 'garden'"
          class="px-4 py-1.5 rounded text-sm whitespace-nowrap transition-colors"
          :class="activeTab === 'garden'
            ? 'bg-amber-900/30 text-amber-400 border border-amber-700/50'
            : 'text-stone-500 hover:text-stone-300 border border-transparent'"
        >
          小药园
          <span v-if="hasMaturePlot" class="ml-1 text-xs text-emerald-400">●</span>
        </button>
      </div>

      <!-- 内容区域 -->
      <div class="flex-1 overflow-y-auto p-4">
        <!-- 加载中 -->
        <div v-if="loading" class="flex justify-center items-center h-64">
          <svg class="animate-spin h-10 w-10 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>

        <!-- ====== 洞府经营视图 ====== -->
        <div v-else-if="activeTab === 'cave'" class="space-y-4">
          <!-- 未开辟洞府 -->
          <div v-if="!isOpened" class="flex flex-col items-center justify-center h-64 text-stone-500">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-3 opacity-50">
              <path d="M3 12l9-9 9 9"/>
              <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/>
            </svg>
            <p class="mb-2 text-stone-400">你尚未开辟洞府</p>
            <p class="mb-4 text-xs text-stone-600 text-center max-w-sm">
              需达 <span class="text-amber-400">炼气期</span> 且消耗
              <span class="text-yellow-500">1000 灵石</span> 方可开辟洞府，
              开辟后可获得灵脉、静室、丹房、器室、大阵五大设施与药园地块。
            </p>
            <button
              @click="handleOpenCave"
              :disabled="operating"
              class="px-6 py-2 rounded bg-amber-900/30 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 hover:text-amber-300 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              开辟洞府
            </button>
          </div>

          <!-- 已开辟洞府：展示设施与资源 -->
          <div v-else>
            <!-- 五大设施卡片网格（2 列） -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <div
                v-for="item in facilityList"
                :key="item.type"
                class="bg-[#1c1917] border border-stone-800 rounded-lg p-4 hover:border-stone-700 transition-colors"
              >
                <!-- 卡片头部：设施名 + 等级 -->
                <div class="flex justify-between items-start mb-2">
                  <div>
                    <h4 class="text-sm font-bold text-amber-400">{{ item.info.name }}</h4>
                    <p class="text-xs text-stone-500 mt-0.5 leading-relaxed">{{ item.info.description }}</p>
                  </div>
                  <span class="text-xs px-2 py-0.5 rounded border border-stone-700 text-stone-400 whitespace-nowrap">
                    Lv.{{ item.info.level }}/{{ item.info.max_level }}
                  </span>
                </div>

                <!-- 升级消耗与按钮 -->
                <div class="flex items-center justify-between mt-3 pt-3 border-t border-stone-800">
                  <div class="text-xs">
                    <span class="text-stone-500">升级消耗：</span>
                    <span v-if="item.info.can_upgrade" class="text-yellow-500">{{ formatUpgradeCost(item.info) }}</span>
                    <span v-else class="text-stone-600">已满级</span>
                  </div>
                  <button
                    v-if="item.info.can_upgrade"
                    @click="handleUpgrade(item.type, item.info)"
                    :disabled="operating"
                    class="px-3 py-1 rounded bg-amber-900/30 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 hover:text-amber-300 transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    升级
                  </button>
                  <span v-else class="text-xs text-emerald-500">已达上限</span>
                </div>
              </div>
            </div>

            <!-- 灵脉领取区 -->
            <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-4 mb-3">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yellow-500">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                  <div>
                    <div class="text-sm font-bold text-stone-200">灵脉产出</div>
                    <div class="text-xs text-stone-500 mt-0.5">
                      待领取：
                      <span class="text-yellow-500 font-bold">{{ caveInfo?.spirit_vein?.pending_stones ?? 0 }}</span>
                      灵石
                      <span v-if="caveInfo?.spirit_vein?.produce_rate" class="ml-2 text-stone-600">
                        （{{ caveInfo.spirit_vein.produce_rate }}/时）
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  @click="handleCollect"
                  :disabled="operating || (caveInfo?.spirit_vein?.pending_stones ?? 0) <= 0"
                  class="px-4 py-1.5 rounded bg-yellow-900/30 border border-yellow-700/50 text-yellow-400 hover:bg-yellow-800/50 hover:text-yellow-300 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  领取灵石
                </button>
              </div>
            </div>

            <!-- 药园地块概览 -->
            <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-4">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-500">
                    <path d="M12 2v20"/>
                    <path d="M2 12h20"/>
                    <path d="M12 2a15 15 0 0 1 0 20"/>
                    <path d="M12 2a15 15 0 0 0 0 20"/>
                  </svg>
                  <div>
                    <div class="text-sm font-bold text-stone-200">药园地块</div>
                    <div class="text-xs text-stone-500 mt-0.5">
                      当前：
                      <span class="text-emerald-400 font-bold">{{ caveInfo?.garden_plots?.current ?? 0 }}</span>
                      /
                      <span class="text-stone-400">{{ caveInfo?.garden_plots?.max ?? 0 }}</span>
                      块
                    </div>
                  </div>
                </div>
                <button
                  v-if="!isPlotMaxed"
                  @click="handleUnlockPlot"
                  :disabled="operating"
                  class="px-4 py-1.5 rounded bg-emerald-900/30 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span v-if="caveInfo?.garden_plots?.unlock_cost">
                    解锁地块（{{ caveInfo.garden_plots.unlock_cost.spirit_stone }} 灵石）
                  </span>
                  <span v-else>解锁地块</span>
                </button>
                <span v-else class="text-xs text-stone-600">已达上限</span>
              </div>
              <div class="mt-2 text-xs text-stone-600">
                切换至「小药园」Tab 可进行播种与采收
              </div>
            </div>
          </div>
        </div>

        <!-- ====== 小药园视图 ====== -->
        <div v-else-if="activeTab === 'garden'">
          <!-- 洞府未开辟时提示 -->
          <div v-if="!isOpened" class="flex flex-col items-center justify-center h-64 text-stone-500">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
              <path d="M12 2v20"/>
              <path d="M2 12h20"/>
            </svg>
            <p class="mb-4">需先开辟洞府方可使用药园</p>
            <button
              @click="activeTab = 'cave'"
              class="px-4 py-2 rounded bg-amber-900/30 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 transition-colors text-sm"
            >
              前往开辟洞府
            </button>
          </div>

          <!-- 药园未开启（后端返回 is_opened=false） -->
          <div v-else-if="gardenStatus && !gardenStatus.is_opened" class="flex flex-col items-center justify-center h-64 text-stone-500">
            <p class="mb-2">{{ gardenStatus.message || '药园暂未开启' }}</p>
          </div>

          <!-- 药园正常展示 -->
          <div v-else-if="gardenStatus">
            <!-- 顶部操作栏：一键采收 -->
            <div class="flex items-center justify-between mb-4">
              <div class="text-sm text-stone-500">
                地块：{{ gardenStatus.plot_count ?? 0 }} / {{ gardenStatus.max_plots ?? 0 }}
              </div>
              <button
                v-if="hasMaturePlot"
                @click="handleHarvestAll"
                :disabled="operating"
                class="px-4 py-2 rounded bg-emerald-900/30 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 transition-colors text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
                一键采收
              </button>
            </div>

            <!-- 地块空状态 -->
            <div v-if="(gardenStatus.plots || []).length === 0" class="flex flex-col items-center justify-center h-48 text-stone-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
                <path d="M12 2v20"/>
                <path d="M2 12h20"/>
              </svg>
              <p>暂无药园地块，请先在「洞府经营」中解锁地块</p>
            </div>

            <!-- 地块网格（3 列） -->
            <div v-else class="grid grid-cols-3 gap-3">
              <div
                v-for="plot in gardenStatus.plots"
                :key="plot.plot_index"
                class="bg-[#1c1917] border rounded-lg p-3 flex flex-col items-center text-center transition-colors"
                :class="plot.status === 'mature'
                  ? 'border-emerald-700/50 hover:border-emerald-500/80'
                  : 'border-stone-800 hover:border-stone-700'"
              >
                <!-- 地块序号 -->
                <div class="text-xs text-stone-600 mb-2">地块 #{{ plot.plot_index + 1 }}</div>

                <!-- 空地 -->
                <template v-if="plot.status === 'empty'">
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="text-stone-600 mb-2">
                    <path d="M12 2v20"/>
                    <path d="M2 12h20"/>
                  </svg>
                  <div class="text-xs text-stone-500 mb-2">空地</div>
                  <button
                    @click="handleOpenSeedModal(plot.plot_index)"
                    :disabled="operating"
                    class="px-3 py-1 rounded bg-amber-900/30 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 hover:text-amber-300 transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    播种
                  </button>
                </template>

                <!-- 种植中 -->
                <template v-else-if="plot.status === 'planted'">
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-500 mb-2">
                    <path d="M12 22V8"/>
                    <path d="M5 12c0-3 3-5 7-5s7 2 7 5"/>
                    <path d="M12 8c0-3 2-5 5-5"/>
                  </svg>
                  <div class="text-xs font-bold text-cyan-400 mb-1">{{ plot.seed?.name || '未知种子' }}</div>
                  <div class="text-xs text-stone-500 mb-2">
                    剩余：{{ formatCountdown(getPlotRemainingSeconds(plot)) }}
                  </div>
                  <div class="text-xs text-stone-600">
                    产出：{{ plot.seed?.produce_name || '—' }}
                  </div>
                </template>

                <!-- 已成熟 -->
                <template v-else-if="plot.status === 'mature'">
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-500 mb-2">
                    <path d="M12 22V8"/>
                    <path d="M5 12c0-3 3-5 7-5s7 2 7 5"/>
                    <path d="M12 8c0-3 2-5 5-5"/>
                  </svg>
                  <div class="text-xs font-bold text-emerald-400 mb-1">已成熟</div>
                  <div class="text-xs text-stone-500 mb-2">{{ plot.seed?.name || '灵草' }}</div>
                  <button
                    @click="handleHarvest(plot)"
                    :disabled="operating || !plot.can_harvest"
                    class="px-3 py-1 rounded bg-emerald-900/40 border border-emerald-600/60 text-emerald-300 hover:bg-emerald-700/50 hover:text-emerald-200 transition-colors text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    采收
                  </button>
                </template>
              </div>
            </div>
          </div>

          <!-- 数据加载失败 -->
          <div v-else class="flex flex-col items-center justify-center h-64 text-stone-500">
            <p class="mb-3">药园状态获取失败</p>
            <button
              @click="fetchGardenStatus"
              class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-amber-400 transition-colors text-sm"
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 确认弹窗（自定义 Modal 组件，替代浏览器原生 confirm） ========== -->
    <Modal
      :isOpen="confirmModal.show"
      :title="confirmModal.type === 'open' ? '确认开辟洞府'
        : confirmModal.type === 'upgrade' ? '确认升级'
        : confirmModal.type === 'collect' ? '确认领取灵石'
        : confirmModal.type === 'unlock' ? '确认解锁地块'
        : confirmModal.type === 'plant' ? '确认播种'
        : confirmModal.type === 'harvest' ? '确认采收'
        : '确认一键采收'"
      @close="closeConfirmModal"
      width="420px"
    >
      <!-- 开辟洞府 -->
      <div class="space-y-3" v-if="confirmModal.type === 'open'">
        <p class="text-stone-300">确定要开辟洞府吗？</p>
        <p class="text-xs text-stone-500 leading-relaxed">
          开辟洞府需消耗
          <span class="text-yellow-500">1000 灵石</span>，且需达到
          <span class="text-amber-400">炼气期</span>。
          开辟后将解锁灵脉、静室、丹房、器室、大阵五大设施与药园地块。
        </p>
      </div>

      <!-- 升级设施 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'upgrade' && confirmModal.payload">
        <p class="text-stone-300">
          确定要将
          <span class="font-bold text-amber-400">{{ (confirmModal.payload as { info: FacilityInfo }).info.name }}</span>
          升级至
          <span class="font-bold text-amber-400">Lv.{{ (confirmModal.payload as { info: FacilityInfo }).info.level + 1 }}</span>
          吗？
        </p>
        <p class="text-xs text-stone-500 leading-relaxed">
          升级消耗：
          <span class="text-yellow-500">{{ formatUpgradeCost((confirmModal.payload as { info: FacilityInfo }).info) }}</span>
        </p>
      </div>

      <!-- 领取灵石 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'collect'">
        <p class="text-stone-300">确定要领取灵脉产出的灵石吗？</p>
        <p class="text-xs text-stone-500 leading-relaxed">
          待领取灵石：
          <span class="text-yellow-500 font-bold">{{ caveInfo?.spirit_vein?.pending_stones ?? 0 }}</span>
          灵石
        </p>
      </div>

      <!-- 解锁地块 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'unlock'">
        <p class="text-stone-300">确定要解锁新的药园地块吗？</p>
        <p class="text-xs text-stone-500 leading-relaxed" v-if="caveInfo?.garden_plots?.unlock_cost">
          消耗灵石：
          <span class="text-yellow-500">{{ caveInfo.garden_plots.unlock_cost.spirit_stone }}</span>
        </p>
      </div>

      <!-- 播种 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'plant' && confirmModal.payload">
        <p class="text-stone-300">
          确定要在地块 #{{ (confirmModal.payload as { plotIndex: number }).plotIndex + 1 }} 播种
          <span class="font-bold text-amber-400">{{ (confirmModal.payload as { seed: AvailableSeed }).seed.name }}</span>
          吗？
        </p>
        <p class="text-xs text-stone-500 leading-relaxed">
          生长时间：
          <span class="text-cyan-400">{{ formatGrowTime((confirmModal.payload as { seed: AvailableSeed }).seed.grow_time_seconds) }}</span>，
          成熟后可采收
          <span class="text-emerald-400">{{ (confirmModal.payload as { seed: AvailableSeed }).seed.produce_name }}</span>
        </p>
      </div>

      <!-- 采收 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'harvest' && confirmModal.payload">
        <p class="text-stone-300">
          确定要采收地块 #{{ (confirmModal.payload as PlotInfo).plot_index + 1 }} 吗？
        </p>
        <p class="text-xs text-stone-500 leading-relaxed">
          作物：
          <span class="text-amber-400">{{ (confirmModal.payload as PlotInfo).seed?.name || '灵草' }}</span>
        </p>
      </div>

      <!-- 一键采收 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'harvestAll'">
        <p class="text-stone-300">确定要一键采收所有成熟作物吗？</p>
        <p class="text-xs text-stone-500 leading-relaxed">
          所有成熟灵草将一次性采收完毕，物品存入储物袋。
        </p>
      </div>

      <template #footer>
        <button
          @click="closeConfirmModal"
          class="px-4 py-2 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded transition-colors text-sm"
        >
          取消
        </button>
        <button
          @click="handleConfirm"
          :disabled="operating"
          class="px-4 py-2 rounded text-white transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :class="confirmModal.type === 'harvest' || confirmModal.type === 'harvestAll'
            ? 'bg-emerald-600 hover:bg-emerald-500'
            : 'bg-amber-600 hover:bg-amber-500'"
        >
          <span v-if="operating">处理中...</span>
          <span v-else>确认</span>
        </button>
      </template>
    </Modal>

    <!-- ========== 种子选择弹窗 ========== -->
    <Modal
      :isOpen="seedModal.show"
      title="选择种子"
      @close="seedModal.show = false"
      width="500px"
    >
      <div v-if="(gardenStatus?.available_seeds || []).length === 0" class="text-center text-stone-500 text-sm py-8">
        暂无可用种子
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="seed in gardenStatus?.available_seeds || []"
          :key="seed.seed_id"
          class="bg-[#0c0a09] border border-stone-800 rounded p-3 flex justify-between items-center hover:border-stone-700 transition-colors cursor-pointer"
          @click="handleSelectSeed(seed)"
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-sm font-bold text-amber-300">{{ seed.name }}</span>
              <span v-if="seed.min_cave_level > 0" class="text-xs px-1.5 py-0.5 rounded bg-stone-800 text-stone-400">
                需洞府 Lv.{{ seed.min_cave_level }}
              </span>
            </div>
            <div class="text-xs text-stone-500 flex gap-3">
              <span>产出：<span class="text-emerald-400">{{ seed.produce_name }}</span></span>
              <span>时间：<span class="text-cyan-400">{{ formatGrowTime(seed.grow_time_seconds) }}</span></span>
              <span>产量：<span class="text-yellow-400">x{{ seed.base_yield }}</span></span>
            </div>
          </div>
          <button
            class="ml-3 px-3 py-1.5 rounded bg-amber-900/30 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 hover:text-amber-300 transition-colors text-xs whitespace-nowrap"
          >
            播种
          </button>
        </div>
      </div>
      <template #footer>
        <button
          @click="seedModal.show = false"
          class="px-4 py-2 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded transition-colors text-sm"
        >
          取消
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* 弹窗淡入动画，与项目其他面板保持一致 */
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
</style>
