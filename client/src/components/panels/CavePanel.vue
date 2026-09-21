<script setup lang="ts">
/**
 * 洞府系统面板组件
 *
 * 功能说明：
 *   - 外壳统一走 ui/PanelShell（遮罩 / 标题栏 / 关闭 / 右坞停靠契约），emits('close') 关闭面板
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
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import EmptyState from '../ui/EmptyState.vue'
import ErrorState from '../ui/ErrorState.vue'
import { formatCompact } from '../../utils/format'
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

// 各类型确认弹窗的 payload 结构（取代 any，提升类型安全，避免模板内联 as 断言）
interface UpgradePayload {
  facility: FacilityType
  info: FacilityInfo
}
interface PlantPayload {
  plotIndex: number
  seed: AvailableSeed
}
// 采收 payload 复用 api 中的 PlotInfo；其余类型 payload 为 null
type ConfirmPayload = UpgradePayload | PlantPayload | PlotInfo | null

const confirmModal = ref<{
  show: boolean
  type: ConfirmType
  // 升级时存 { facility, info }，播种时存 { plotIndex, seed }，采收时存 PlotInfo，其余为 null
  payload: ConfirmPayload
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
 * 类型收窄辅助：将联合类型 payload 按 type 安全取出对应结构，避免模板内联 as 断言
 * （vue-tsc 模板编译器无法解析 {{ }} 中的 as 语法，故在 script 中收窄后供模板使用）
 */
const confirmUpgrade = computed<UpgradePayload | null>(() =>
  confirmModal.value.type === 'upgrade' && confirmModal.value.payload && 'info' in confirmModal.value.payload
    ? (confirmModal.value.payload as UpgradePayload)
    : null
)
const confirmPlant = computed<PlantPayload | null>(() =>
  confirmModal.value.type === 'plant' && confirmModal.value.payload && 'seed' in confirmModal.value.payload
    ? (confirmModal.value.payload as PlantPayload)
    : null
)
const confirmHarvest = computed<PlotInfo | null>(() =>
  confirmModal.value.type === 'harvest' && confirmModal.value.payload && 'plot_index' in confirmModal.value.payload
    ? (confirmModal.value.payload as PlotInfo)
    : null
)

/**
 * 是否已开辟洞府
 */
const isOpened = computed(() => !!caveInfo.value?.is_opened)

/**
 * 设施列表：顺序与条目都取自服务端返回的 facilities（内容声明顺序）
 */
const facilityList = computed<{ type: FacilityType; info: FacilityInfo }[]>(() => {
  const facilities = caveInfo.value?.facilities
  if (!facilities) return []
  return Object.entries(facilities)
    .map(([type, info]) => ({ type, info }))
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

/** 顶部页签（契约见 ui/Tabs.vue）；成熟作物用角标点位提示 */
const tabItems = computed(() => [
  { key: 'cave', label: '洞府经营' },
  { key: 'garden', label: '小药园', badge: hasMaturePlot.value ? '●' : undefined }
])

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
    uiStore.showApiError(error, '[CavePanel] 加载洞府数据失败')
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
  const type = confirmModal.value.type
  // 先关闭弹窗，再执行操作（避免操作期间弹窗被多次点击）
  closeConfirmModal()

  if (type === 'open') {
    await doOpenCave()
  } else if (type === 'upgrade' && confirmUpgrade.value) {
    // 使用已类型收窄的 payload，避免运行时/模板内联 as 断言
    await doUpgrade(confirmUpgrade.value.facility, confirmUpgrade.value.info)
  } else if (type === 'collect') {
    await doCollect()
  } else if (type === 'unlock') {
    await doUnlockPlot()
  } else if (type === 'plant' && confirmPlant.value) {
    await doPlant(confirmPlant.value.plotIndex, confirmPlant.value.seed)
  } else if (type === 'harvest' && confirmHarvest.value) {
    await doHarvest(confirmHarvest.value)
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
    // 后端返回字段为 collected（collected），兼容顶层与 data 嵌套
    const amount = result.data?.collected ?? result.collected ?? 0
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
    // 名字来自服务端的 material_name（内容里的物品名）；没有才退回键名，别在客户端抄一份物品典
    parts.push(`${cost.material_name || cost.material} x${cost.material_count}`)
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
  <PanelShell
    title="洞府"
    size="xl"
    :loading="loading"
    @close="emit('close')"
  >
    <!-- Tab 切换栏 -->
    <Tabs v-model="activeTab" :items="tabItems" class="mb-4" />

    <!-- ====== 洞府经营视图 ====== -->
    <div v-if="activeTab === 'cave'" class="space-y-4">
      <!-- 未开辟洞府 -->
      <EmptyState
        v-if="!isOpened"
        text="你尚未开辟洞府"
        hint="需达炼气期且消耗 1000 灵石方可开辟；开辟后可获得灵脉、静室、丹房、器室、大阵五大设施与药园地块。"
      >
        <AppButton variant="primary" :disabled="operating" @click="handleOpenCave">开辟洞府</AppButton>
      </EmptyState>

      <!-- 已开辟洞府：展示设施与资源 -->
      <div v-else>
        <!-- 五大设施卡片网格（2 列） -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div
            v-for="item in facilityList"
            :key="item.type"
            class="bg-surface-raised border border-line rounded-panel p-4 hover:border-line-strong transition-colors"
          >
            <!-- 卡片头部：设施名 + 等级 -->
            <div class="flex justify-between items-start mb-2">
              <div class="min-w-0">
                <h4 class="text-[13px] font-bold text-gold-400 font-display">{{ item.info.name }}</h4>
                <p class="text-xs text-fg-muted mt-0.5 leading-relaxed wrap-cjk">{{ item.info.description }}</p>
              </div>
              <Badge tone="neutral">Lv.{{ item.info.level }}/{{ item.info.max_level }}</Badge>
            </div>

            <!-- 升级消耗与按钮 -->
            <div class="flex items-center justify-between mt-3 pt-3 border-t border-line-subtle">
              <div class="text-xs">
                <span class="text-fg-muted">升级消耗：</span>
                <span v-if="item.info.can_upgrade" class="text-gold-400 num">{{ formatUpgradeCost(item.info) }}</span>
                <span v-else class="text-fg-faint">已满级</span>
              </div>
              <AppButton
                v-if="item.info.can_upgrade"
                size="xs"
                variant="primary"
                :disabled="operating"
                @click="handleUpgrade(item.type, item.info)"
              >
                升级
              </AppButton>
              <span v-else class="text-xs text-state-success">已达上限</span>
            </div>
          </div>
        </div>

        <!-- 灵脉领取区 -->
        <div class="bg-surface-raised border border-line rounded-panel p-4 mb-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-[13px] font-bold text-fg-primary">灵脉产出</div>
              <div class="text-xs text-fg-muted mt-0.5">
                待领取：
                <span
                  class="text-gold-400 font-bold num"
                  :title="String(caveInfo?.spirit_vein?.pending_stones ?? 0)"
                >{{ formatCompact(caveInfo?.spirit_vein?.pending_stones ?? 0) }}</span>
                灵石
                <span v-if="caveInfo?.spirit_vein?.produce_rate" class="ml-2 text-fg-faint num">
                  （{{ formatCompact(caveInfo.spirit_vein.produce_rate) }}/时）
                </span>
              </div>
            </div>
            <AppButton
              variant="primary"
              :disabled="operating || (caveInfo?.spirit_vein?.pending_stones ?? 0) <= 0"
              @click="handleCollect"
            >
              领取灵石
            </AppButton>
          </div>
        </div>

        <!-- 药园地块概览 -->
        <div class="bg-surface-raised border border-line rounded-panel p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-[13px] font-bold text-fg-primary">药园地块</div>
              <div class="text-xs text-fg-muted mt-0.5">
                当前：
                <span class="text-state-success font-bold num">{{ caveInfo?.garden_plots?.current ?? 0 }}</span>
                /
                <span class="text-fg-secondary num">{{ caveInfo?.garden_plots?.max ?? 0 }}</span>
                块
              </div>
            </div>
            <AppButton
              v-if="!isPlotMaxed"
              variant="primary"
              :disabled="operating"
              @click="handleUnlockPlot"
            >
              <span v-if="caveInfo?.garden_plots?.unlock_cost">
                解锁地块（{{ formatCompact(caveInfo.garden_plots.unlock_cost.spirit_stone) }} 灵石）
              </span>
              <span v-else>解锁地块</span>
            </AppButton>
            <span v-else class="text-xs text-fg-faint">已达上限</span>
          </div>
          <div class="mt-2 text-xs text-fg-faint">
            切换至「小药园」Tab 可进行播种与采收
          </div>
        </div>
      </div>
    </div>

    <!-- ====== 小药园视图 ====== -->
    <div v-else-if="activeTab === 'garden'">
      <!-- 洞府未开辟时提示 -->
      <EmptyState v-if="!isOpened" text="需先开辟洞府方可使用药园">
        <AppButton variant="primary" @click="activeTab = 'cave'">前往开辟洞府</AppButton>
      </EmptyState>

      <!-- 药园未开启（后端返回 is_opened=false） -->
      <EmptyState
        v-else-if="gardenStatus && !gardenStatus.is_opened"
        :text="gardenStatus.message || '药园暂未开启'"
      />

      <!-- 药园正常展示 -->
      <div v-else-if="gardenStatus">
        <!-- 顶部操作栏：一键采收 -->
        <div class="flex items-center justify-between mb-4">
          <div class="text-sm text-fg-muted num">
            地块：{{ gardenStatus.plot_count ?? 0 }} / {{ gardenStatus.max_plots ?? 0 }}
          </div>
          <AppButton
            v-if="hasMaturePlot"
            variant="primary"
            :disabled="operating"
            @click="handleHarvestAll"
          >
            一键采收
          </AppButton>
        </div>

        <!-- 地块空状态 -->
        <EmptyState
          v-if="(gardenStatus.plots || []).length === 0"
          text="暂无药园地块"
          hint="请先在「洞府经营」中解锁地块"
        />

        <!-- 地块网格（3 列） -->
        <div v-else class="grid grid-cols-3 gap-3">
          <div
            v-for="plot in gardenStatus.plots"
            :key="plot.plot_index"
            class="bg-surface-raised border rounded-panel p-3 flex flex-col items-center text-center transition-colors"
            :class="plot.status === 'mature'
              ? 'border-state-success/50 hover:border-state-success'
              : 'border-line hover:border-line-strong'"
          >
            <!-- 地块序号 -->
            <div class="text-xs text-fg-faint mb-2 num">地块 #{{ plot.plot_index + 1 }}</div>

            <!-- 空地 -->
            <template v-if="plot.status === 'empty'">
              <div class="text-xs text-fg-muted mb-2">空地</div>
              <AppButton
                size="xs"
                variant="primary"
                :disabled="operating"
                @click="handleOpenSeedModal(plot.plot_index)"
              >
                播种
              </AppButton>
            </template>

            <!-- 种植中 -->
            <template v-else-if="plot.status === 'planted'">
              <div class="text-xs font-bold text-state-info mb-1">{{ plot.seed?.name || '未知种子' }}</div>
              <div class="text-xs text-fg-muted mb-2 num">
                剩余：{{ formatCountdown(getPlotRemainingSeconds(plot)) }}
              </div>
              <div class="text-xs text-fg-faint">
                产出：{{ plot.seed?.produce_name || '—' }}
              </div>
            </template>

            <!-- 已成熟 -->
            <template v-else-if="plot.status === 'mature'">
              <div class="text-xs font-bold text-state-success mb-1">已成熟</div>
              <div class="text-xs text-fg-muted mb-2">{{ plot.seed?.name || '灵草' }}</div>
              <AppButton
                size="xs"
                variant="primary"
                :disabled="operating || !plot.can_harvest"
                @click="handleHarvest(plot)"
              >
                采收
              </AppButton>
            </template>
          </div>
        </div>
      </div>

      <!-- 数据加载失败 -->
      <ErrorState v-else message="药园状态获取失败" @retry="fetchGardenStatus" />
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
        <p class="text-fg-secondary">确定要开辟洞府吗？</p>
        <p class="text-xs text-fg-muted leading-relaxed">
          开辟洞府需消耗
          <span class="text-gold-400">1000 灵石</span>，且需达到
          <span class="text-gold-400">炼气期</span>。
          开辟后将解锁灵脉、静室、丹房、器室、大阵五大设施与药园地块。
        </p>
      </div>

      <!-- 升级设施 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'upgrade' && confirmUpgrade">
        <p class="text-fg-secondary">
          确定要将
          <span class="font-bold text-gold-400">{{ confirmUpgrade.info.name }}</span>
          升级至
          <span class="font-bold text-gold-400">Lv.{{ confirmUpgrade.info.level + 1 }}</span>
          吗？
        </p>
        <p class="text-xs text-fg-muted leading-relaxed">
          升级消耗：
          <span class="text-gold-400">{{ formatUpgradeCost(confirmUpgrade.info) }}</span>
        </p>
      </div>

      <!-- 领取灵石 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'collect'">
        <p class="text-fg-secondary">确定要领取灵脉产出的灵石吗？</p>
        <p class="text-xs text-fg-muted leading-relaxed">
          待领取灵石：
          <span
            class="text-gold-400 font-bold num"
            :title="String(caveInfo?.spirit_vein?.pending_stones ?? 0)"
          >{{ formatCompact(caveInfo?.spirit_vein?.pending_stones ?? 0) }}</span>
          灵石
        </p>
      </div>

      <!-- 解锁地块 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'unlock'">
        <p class="text-fg-secondary">确定要解锁新的药园地块吗？</p>
        <p class="text-xs text-fg-muted leading-relaxed" v-if="caveInfo?.garden_plots?.unlock_cost">
          消耗灵石：
          <span
            class="text-gold-400 num"
            :title="String(caveInfo.garden_plots.unlock_cost.spirit_stone)"
          >{{ formatCompact(caveInfo.garden_plots.unlock_cost.spirit_stone) }}</span>
        </p>
      </div>

      <!-- 播种 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'plant' && confirmPlant">
        <p class="text-fg-secondary">
          确定要在地块 #{{ confirmPlant.plotIndex + 1 }} 播种
          <span class="font-bold text-gold-400">{{ confirmPlant.seed.name }}</span>
          吗？
        </p>
        <p class="text-xs text-fg-muted leading-relaxed">
          生长时间：
          <span class="text-state-info num">{{ formatGrowTime(confirmPlant.seed.grow_time_seconds) }}</span>，
          成熟后可采收
          <span class="text-state-success">{{ confirmPlant.seed.produce_name }}</span>
        </p>
      </div>

      <!-- 采收 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'harvest' && confirmHarvest">
        <p class="text-fg-secondary">
          确定要采收地块 #{{ confirmHarvest.plot_index + 1 }} 吗？
        </p>
        <p class="text-xs text-fg-muted leading-relaxed">
          作物：
          <span class="text-gold-400">{{ confirmHarvest.seed?.name || '灵草' }}</span>
        </p>
      </div>

      <!-- 一键采收 -->
      <div class="space-y-3" v-else-if="confirmModal.type === 'harvestAll'">
        <p class="text-fg-secondary">确定要一键采收所有成熟作物吗？</p>
        <p class="text-xs text-fg-muted leading-relaxed">
          所有成熟灵草将一次性采收完毕，物品存入储物袋。
        </p>
      </div>

      <template #footer>
        <AppButton variant="default" @click="closeConfirmModal">取消</AppButton>
        <AppButton
          variant="primary"
          :loading="operating"
          @click="handleConfirm"
        >
          {{ operating ? '处理中…' : '确认' }}
        </AppButton>
      </template>
    </Modal>

    <!-- ========== 种子选择弹窗 ========== -->
    <Modal
      :isOpen="seedModal.show"
      title="选择种子"
      @close="seedModal.show = false"
      width="500px"
    >
      <EmptyState
        v-if="(gardenStatus?.available_seeds || []).length === 0"
        text="暂无可用种子"
      />
      <div v-else class="space-y-2">
        <div
          v-for="seed in gardenStatus?.available_seeds || []"
          :key="seed.seed_id"
          class="bg-surface-canvas border border-line rounded-control p-3 flex justify-between items-center hover:border-line-strong transition-colors cursor-pointer"
          @click="handleSelectSeed(seed)"
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-sm font-bold text-gold-300">{{ seed.name }}</span>
              <Badge v-if="seed.min_cave_level > 0" tone="neutral">需洞府 Lv.{{ seed.min_cave_level }}</Badge>
            </div>
            <div class="text-xs text-fg-muted flex gap-3">
              <span>产出：<span class="text-state-success">{{ seed.produce_name }}</span></span>
              <span>时间：<span class="text-state-info num">{{ formatGrowTime(seed.grow_time_seconds) }}</span></span>
              <span>产量：<span class="text-gold-400 num">x{{ seed.base_yield }}</span></span>
            </div>
          </div>
          <AppButton size="xs" variant="primary" class="ml-3 shrink-0">播种</AppButton>
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" @click="seedModal.show = false">取消</AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>
