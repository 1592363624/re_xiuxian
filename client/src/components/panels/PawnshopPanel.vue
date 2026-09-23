<script setup>
/**
 * 聚宝当铺面板组件（玩家侧）
 *
 * 功能说明：
 *   - 外壳统一走 ui/PanelShell（遮罩 / 关闭 / 右坞停靠），面板不再自写遮罩与外壳
 *   - 标题区：当铺信用额度与加成挂在 PanelShell 的 header-actions 上
 *   - 状态条：当前灵石、今日典当次数、活跃当票数
 *   - Tab 切换走 ui/Tabs：典当 / 我的当票 / 历史
 *     · 典当 Tab：物品选择下拉框（从储物袋拉取，仅显示可典当物品）、数量输入框、估值预览、确认典当按钮（带二次确认 Modal）
 *     · 我的当票 Tab：当票列表、赎回按钮（带二次确认 Modal）、剩余赎回时间倒计时
 *     · 历史 Tab：分页历史记录列表
 *   - 颜色风格：鎏金令牌（gold-* / surface-tint-gold）体现金银当铺主题
 *
 * 设计原则：
 *   - 所有业务逻辑在后端 PawnshopService 处理，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - BIGINT 金额字段统一走 formatCompact 展示（hover 看精确值），避免 JS Number 精度问题
 *   - 倒计时基于 pawned_at + redeem_deadline 本地 tick 递减，每秒刷新
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { formatBeijing } from '../../utils/time'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import StatBar from '../ui/StatBar.vue'
import PanelCard from '../ui/PanelCard.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { formatTime, formatCompact } from '../../utils/format'
import { useItemQualities } from '../../composables/useItemQualities'
import { getInventory } from '../../api/inventory'
import {
  getStatus,
  appraise,
  pawn,
  redeem,
  getList,
  getHistory
} from '../../api/pawnshop'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

/* ===================== 基础状态 ===================== */

// 当前激活的 Tab：pawn=典当，listings=我的当票，history=历史（key/label 契约见 ui/Tabs.vue）
const activeTab = ref('pawn')
const tabItems = [
  { key: 'pawn', label: '典当' },
  { key: 'listings', label: '我的当票' },
  { key: 'history', label: '历史记录' }
]
const loading = ref(false)
const submitting = ref(false)
// 估值预览加载状态（独立于主 loading，避免阻塞 UI）
const appraiseLoading = ref(false)

// 当铺状态数据（信用/今日次数/活跃当票/最近历史/配置）
const status = ref(null)

// 当前本地时间 tick，用于驱动倒计时显示
const now = ref(Date.now())
let tickTimer = null

/* ===================== 典当 Tab 状态 ===================== */

// 储物袋物品列表（用于典当时选择物品）
const inventoryItems = ref([])
// 典当表单：物品 key + 数量
const pawnForm = ref({
  item_key: '',
  quantity: 1
})
// 估值预览结果
const appraiseResult = ref(null)
// 典当确认弹窗
const pawnConfirmModal = ref({ show: false })

/* ===================== 我的当票 Tab 状态 ===================== */

// 当票列表与分页
const listings = ref([])
const listingsPage = ref(1)
const listingsTotalPages = ref(0)
const listingsTotal = ref(0)
const listingsFilter = ref('active') // all/active/redeemed/overdue
// 赎回确认弹窗
const redeemConfirmModal = ref({ show: false, listing: null })

/* ===================== 历史 Tab 状态 ===================== */

const history = ref([])
const historyPage = ref(1)
const historyTotalPages = ref(0)
const historyTotal = ref(0)

/* ===================== 计算属性 ===================== */

/**
 * 当前选中的物品对象（典当 Tab 用）
 */
const selectedInventoryItem = computed(() => {
  return inventoryItems.value.find(i => i.item_key === pawnForm.value.item_key) || null
})

/**
 * 典当数量上限：取物品持有数量与配置单次典当上限的较小值
 */
const maxPawnQuantity = computed(() => {
  const owned = selectedInventoryItem.value?.quantity || 0
  const cfg = status.value?.config?.max_pawn_quantity_per_transaction || 99
  return Math.min(owned, cfg)
})

/**
 * 今日剩余典当次数
 */
const dailyPawnRemaining = computed(() => {
  if (!status.value) return 0
  const used = status.value.daily_pawn_count || 0
  const limit = status.value.daily_pawn_limit || 0
  return Math.max(0, limit - used)
})

/**
 * 剩余活跃当票槽位
 */
const activeListingsRemaining = computed(() => {
  if (!status.value) return 0
  const used = status.value.active_listings_count || 0
  const limit = status.value.max_active_listings || 0
  return Math.max(0, limit - used)
})

/**
 * 信用加成百分比文案
 */
const creditBonusText = computed(() => {
  if (!status.value) return '+0%'
  const credit = status.value.credit || 0
  const perPoint = status.value.config?.credit_discount_bonus_per_point || 0
  const bonus = Math.min(0.10, credit * perPoint)
  return `+${(bonus * 100).toFixed(1)}%`
})

/* ===================== 工具函数 ===================== */

/**
 * 品质文字色与中文标签：一律取服务端 game_balance.item_qualities（见 composables/useItemQualities.js）。
 * 这里以前照着 InventoryPanel 抄了一份六键字典（同样没有 mythic）—— 抄写就是要漏档，
 * 神话档在当铺里只能退成中性的"未知"，玩家看不出这件该留着还是该当掉。
 */
const { styleOf: getQualityStyle } = useItemQualities()

/**
 * 格式化时间为 MM-DD HH:mm
 * @param {string} timeStr - ISO 时间字符串
 */
const formatDateTime = (timeStr) => {
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(timeStr, { dateStyle: 'short', seconds: false, fallback: '-' })
}

/**
 * 计算当票剩余赎回时间（毫秒）
 * 基于当票 redeem_deadline 与当前 now 时间差
 * @param {Object} listing - 当票对象
 */
const getRemainingMs = (listing) => {
  if (!listing || !listing.redeem_deadline) return 0
  const deadline = new Date(listing.redeem_deadline).getTime()
  if (isNaN(deadline)) return 0
  return Math.max(0, deadline - now.value)
}

/**
 * 格式化剩余时间（基于毫秒，转换为人类可读字符串）
 * @param {number} ms - 毫秒数
 */
const formatRemaining = (ms) => {
  if (ms <= 0) return '已逾期'
  const sec = Math.floor(ms / 1000)
  return formatTime(sec)
}

/**
 * 判断当票是否已逾期（前端预判，最终以后端为准）
 * @param {Object} listing - 当票对象
 */
const isOverdue = (listing) => {
  if (!listing || listing.status !== 'active') return false
  return getRemainingMs(listing) <= 0
}

/**
 * 当票状态标签文案
 * @param {string} status - 当票状态
 */
const listingStatusLabel = (status) => {
  switch (status) {
    case 'active': return '典当中'
    case 'redeemed': return '已赎回'
    case 'overdue': return '已逾期'
    case 'auctioned': return '已拍卖'
    default: return status
  }
}

/**
 * 当票状态标签色（典当中金/已赎回绿/已逾期红/已拍卖灰），取值契约见 ui/Badge.vue
 * @param {string} status - 当票状态
 */
const listingStatusTone = (status) => {
  switch (status) {
    case 'active': return 'gold'
    case 'redeemed': return 'success'
    case 'overdue': return 'danger'
    case 'auctioned': return 'muted'
    default: return 'neutral'
  }
}

/**
 * 历史记录操作类型文案
 * @param {string} actionType - 操作类型
 */
const actionTypeLabel = (actionType) => {
  switch (actionType) {
    case 'pawn': return '典当'
    case 'redeem': return '赎回'
    case 'overdue': return '逾期'
    case 'auction': return '拍卖'
    default: return actionType
  }
}

/**
 * 历史记录操作类型色（典当金/赎回绿/逾期红/拍卖灰），取值契约见 ui/Badge.vue
 * @param {string} actionType - 操作类型
 */
const actionTypeTone = (actionType) => {
  switch (actionType) {
    case 'pawn': return 'gold'
    case 'redeem': return 'success'
    case 'overdue': return 'danger'
    case 'auction': return 'muted'
    default: return 'neutral'
  }
}

/* ===================== 数据获取 ===================== */

/**
 * 拉取当铺状态（信用/今日次数/活跃当票/最近历史/配置）
 */
const fetchStatus = async () => {
  loading.value = true
  try {
    const res = await getStatus()
    status.value = res.data?.data || res.data || null
  } catch (error) {
    console.error('[PawnshopPanel] 获取当铺状态失败:', error)
    uiStore.showApiError(error, '获取当铺状态失败')
  } finally {
    loading.value = false
  }
}

/**
 * 拉取储物袋物品列表（典当 Tab 选择物品用）
 */
const fetchInventory = async () => {
  try {
    const res = await getInventory()
    const data = res.data?.data || res.data || {}
    inventoryItems.value = data.items || []
  } catch (error) {
    console.error('[PawnshopPanel] 获取储物袋失败:', error)
    uiStore.showApiError(error, '[PawnshopPanel] 获取储物袋失败')
  }
}

/**
 * 拉取我的当票列表
 */
const fetchListings = async () => {
  loading.value = true
  try {
    const res = await getList({
      page: listingsPage.value,
      limit: 10,
      filter: listingsFilter.value
    })
    const data = res.data?.data || {}
    listings.value = data.list || []
    listingsTotal.value = data.total || 0
    listingsTotalPages.value = data.total_pages || 0
  } catch (error) {
    console.error('[PawnshopPanel] 获取当票列表失败:', error)
    uiStore.showApiError(error, '获取当票列表失败')
  } finally {
    loading.value = false
  }
}

/**
 * 拉取历史记录
 */
const fetchHistory = async () => {
  loading.value = true
  try {
    const res = await getHistory({
      page: historyPage.value,
      limit: 10
    })
    const data = res.data?.data || {}
    history.value = data.list || []
    historyTotal.value = data.total || 0
    historyTotalPages.value = data.total_pages || 0
  } catch (error) {
    console.error('[PawnshopPanel] 获取历史记录失败:', error)
    uiStore.showApiError(error, '获取历史记录失败')
  } finally {
    loading.value = false
  }
}

/* ===================== Tab 切换 ===================== */

/**
 * 切换 Tab 并按需加载对应数据
 * @param {string} tab - pawn/listings/history
 */
const switchTab = (tab) => {
  if (activeTab.value === tab) return
  activeTab.value = tab
  if (tab === 'pawn') {
    // 典当 Tab：拉取储物袋（若未拉取）+ 重置表单
    if (inventoryItems.value.length === 0) {
      fetchInventory()
    }
    appraiseResult.value = null
  } else if (tab === 'listings') {
    listingsPage.value = 1
    fetchListings()
  } else if (tab === 'history') {
    historyPage.value = 1
    fetchHistory()
  }
}

/* ===================== 典当交互 ===================== */

/**
 * 物品选择变更时重置数量并自动触发估值预览
 */
const handleItemChange = () => {
  // 重置数量为 1（不超过上限）
  pawnForm.value.quantity = 1
  // 自动触发估值预览
  handleAppraise()
}

/**
 * 数量增减（限制在 1 ~ maxPawnQuantity 之间）
 * @param {number} delta - 变化量
 */
const changeQuantity = (delta) => {
  let next = pawnForm.value.quantity + delta
  if (next < 1) next = 1
  if (maxPawnQuantity.value && next > maxPawnQuantity.value) {
    next = maxPawnQuantity.value
  }
  pawnForm.value.quantity = next
  // 数量变化后重新估值
  handleAppraise()
}

/**
 * 数量输入框失焦/回车时校验并重新估值
 */
const handleQuantityInput = () => {
  let q = parseInt(pawnForm.value.quantity)
  if (isNaN(q) || q < 1) q = 1
  if (maxPawnQuantity.value && q > maxPawnQuantity.value) {
    q = maxPawnQuantity.value
  }
  pawnForm.value.quantity = q
  handleAppraise()
}

/**
 * 触发估值预览（调用后端 /pawnshop/appraise）
 * 防抖由 appraiseLoading 状态锁简易实现
 */
const handleAppraise = async () => {
  if (!pawnForm.value.item_key) {
    appraiseResult.value = null
    return
  }
  if (appraiseLoading.value) return
  appraiseLoading.value = true
  try {
    const res = await appraise(pawnForm.value.item_key, pawnForm.value.quantity)
    appraiseResult.value = res.data?.data || res.data || null
  } catch (error) {
    console.error('[PawnshopPanel] 估值预览失败:', error)
    // 估值失败不弹 toast，仅在控制台记录，避免打扰玩家
    appraiseResult.value = null
  } finally {
    appraiseLoading.value = false
  }
}

/**
 * 打开典当确认弹窗（二次确认）
 */
const openPawnConfirmModal = () => {
  // 前端基础校验
  if (!pawnForm.value.item_key) {
    uiStore.showToast('请先选择要典当的物品', 'warning')
    return
  }
  if (!pawnForm.value.quantity || pawnForm.value.quantity < 1) {
    uiStore.showToast('数量必须大于 0', 'warning')
    return
  }
  if (dailyPawnRemaining.value <= 0) {
    uiStore.showToast('今日典当次数已用尽', 'warning')
    return
  }
  if (activeListingsRemaining.value <= 0) {
    uiStore.showToast('活跃当票已达上限，请先赎回或等待逾期', 'warning')
    return
  }
  // 若未估值或估值物品与当前选择不一致，先估值
  if (!appraiseResult.value || appraiseResult.value.item_info?.item_key !== pawnForm.value.item_key) {
    uiStore.showToast('估值数据已变更，正在重新估值...', 'info')
    return
  }
  pawnConfirmModal.value.show = true
}

/**
 * 关闭典当确认弹窗
 */
const closePawnConfirmModal = () => {
  pawnConfirmModal.value.show = false
}

/**
 * 确认典当（调用后端 /pawnshop/pawn）
 */
const confirmPawn = async () => {
  if (submitting.value) return
  submitting.value = true
  try {
    const res = await pawn(pawnForm.value.item_key, pawnForm.value.quantity)
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '典当成功，灵石已入账', 'success')
    // 写入游戏日志
    uiStore.addLog({
      content: `你于聚宝当铺典当 ${data.item_name || pawnForm.value.item_key} x${data.quantity || pawnForm.value.quantity}，得灵石 ${data.pawn_amount} 枚。`,
      type: 'info',
      actorId: 'self'
    })
    // 关闭弹窗
    closePawnConfirmModal()
    // 重置表单
    pawnForm.value = { item_key: '', quantity: 1 }
    appraiseResult.value = null
    // 刷新状态、储物袋、玩家信息
    await Promise.all([fetchStatus(), fetchInventory()])
    if (playerStore.fetchPlayer) {
      playerStore.fetchPlayer()
    }
  } catch (error) {
    console.error('[PawnshopPanel] 典当失败:', error)
    uiStore.showApiError(error, '典当失败')
  } finally {
    submitting.value = false
  }
}

/* ===================== 赎回交互 ===================== */

/**
 * 打开赎回确认弹窗（二次确认）
 * @param {Object} listing - 当票对象
 */
const openRedeemConfirmModal = (listing) => {
  if (!listing || listing.status !== 'active') return
  redeemConfirmModal.value = { show: true, listing }
}

/**
 * 关闭赎回确认弹窗
 */
const closeRedeemConfirmModal = () => {
  redeemConfirmModal.value = { show: false, listing: null }
}

/**
 * 确认赎回（调用后端 /pawnshop/redeem）
 */
const confirmRedeem = async () => {
  const listing = redeemConfirmModal.value.listing
  if (!listing) return
  if (submitting.value) return
  submitting.value = true
  try {
    const res = await redeem(listing.id)
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '赎回成功，物品已归还储物袋', 'success')
    // 写入游戏日志
    uiStore.addLog({
      content: `你赎回了 ${data.item_name || listing.item_name} x${data.quantity || listing.quantity}，花费灵石 ${data.redeem_amount} 枚，信用额度 +1。`,
      type: 'info',
      actorId: 'self'
    })
    // 关闭弹窗
    closeRedeemConfirmModal()
    // 刷新当票列表、状态、玩家信息
    await Promise.all([fetchListings(), fetchStatus()])
    if (playerStore.fetchPlayer) {
      playerStore.fetchPlayer()
    }
  } catch (error) {
    console.error('[PawnshopPanel] 赎回失败:', error)
    uiStore.showApiError(error, '赎回失败')
  } finally {
    submitting.value = false
  }
}

/* ===================== 分页 ===================== */

/**
 * 当票列表筛选变更
 */
const handleListingsFilterChange = () => {
  listingsPage.value = 1
  fetchListings()
}

/**
 * 当票列表翻页
 * @param {number} delta - 变化量（-1 上一页，1 下一页）
 */
const changeListingsPage = (delta) => {
  const next = listingsPage.value + delta
  if (next < 1 || next > listingsTotalPages.value) return
  listingsPage.value = next
  fetchListings()
}

/**
 * 历史记录翻页
 * @param {number} delta - 变化量
 */
const changeHistoryPage = (delta) => {
  const next = historyPage.value + delta
  if (next < 1 || next > historyTotalPages.value) return
  historyPage.value = next
  fetchHistory()
}

/* ===================== 生命周期 ===================== */

onMounted(async () => {
  // 并行拉取状态与储物袋，减少首屏等待
  await Promise.all([fetchStatus(), fetchInventory()])
  // 启动每秒 tick，驱动倒计时显示
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
})
</script>

<template>
  <PanelShell
    title="聚宝当铺"
    hint="典当 · 赎回 · 信用"
    size="xl"
    scoped-scroll
    @close="emit('close')"
  >
    <!-- 当铺信用：原先挤在标题行，现收进外壳的 header-actions -->
    <template #header-actions>
      <div v-if="status" class="flex items-center gap-2">
        <div class="hidden sm:block w-24">
          <StatBar
            :value="status.credit"
            :max="status.config?.credit_max || 100"
            tone="gold"
            height="h-1.5"
            :show-value="false"
          />
        </div>
        <Badge tone="gold">信用 {{ status.credit }} / {{ status.config?.credit_max || 100 }}</Badge>
        <Badge tone="success">{{ creditBonusText }}</Badge>
      </div>
    </template>

    <div class="h-full flex flex-col min-h-0">
      <!-- 状态信息条：今日次数 / 活跃当票 / 灵石余额 -->
      <div v-if="status" class="shrink-0 grid grid-cols-3 gap-2 px-3 py-2.5 border-b border-line-subtle bg-surface-canvas">
        <div class="bg-surface-raised border border-line-subtle rounded-control px-2 py-2 text-center">
          <div class="text-[10px] text-fg-faint">今日典当</div>
          <div class="text-sm font-bold num" :class="dailyPawnRemaining > 0 ? 'text-gold-400' : 'text-fg-faint'">
            {{ dailyPawnRemaining }} / {{ status.daily_pawn_limit }}
          </div>
        </div>
        <div class="bg-surface-raised border border-line-subtle rounded-control px-2 py-2 text-center">
          <div class="text-[10px] text-fg-faint">活跃当票</div>
          <div class="text-sm font-bold num" :class="activeListingsRemaining > 0 ? 'text-gold-400' : 'text-rose-400'">
            {{ status.active_listings_count }} / {{ status.max_active_listings }}
          </div>
        </div>
        <div class="bg-surface-raised border border-line-subtle rounded-control px-2 py-2 text-center">
          <div class="text-[10px] text-fg-faint">灵石余额</div>
          <div class="text-sm font-bold text-gold-300 num" :title="status.spirit_stones">{{ formatCompact(status.spirit_stones) }}</div>
        </div>
      </div>

      <!-- Tab 切换：切换时仍由 switchTab 拉取对应数据 -->
      <Tabs :model-value="activeTab" :items="tabItems" class="shrink-0" @update:model-value="switchTab" />

      <!-- 内容滚动区 -->
      <div class="flex-1 min-h-0 overflow-y-auto p-4 scroll-thin">
        <LoadingBlock v-if="loading" />

        <template v-else>
          <!-- ===================== 典当 Tab ===================== -->
          <div v-if="activeTab === 'pawn'">
            <!-- 物品选择 -->
            <div class="space-y-4">
              <div>
                <label class="block text-xs font-bold text-fg-muted mb-2 uppercase tracking-wider">选择典当物品</label>
                <select
                  v-model="pawnForm.item_key"
                  @change="handleItemChange"
                  class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-sm text-fg-primary focus:outline-none focus:border-gold-700"
                >
                  <option value="">请选择储物袋中的物品</option>
                  <option
                    v-for="item in inventoryItems"
                    :key="item.item_key"
                    :value="item.item_key"
                  >
                    {{ item.name }} x{{ item.quantity }}（{{ getQualityStyle(item.quality).label }}）
                  </option>
                </select>
                <p v-if="selectedInventoryItem" class="text-xs text-fg-faint mt-1">
                  持有数量：{{ selectedInventoryItem.quantity }} · 单次最多典当 {{ status?.config?.max_pawn_quantity_per_transaction || 99 }} 个
                </p>
              </div>

              <!-- 数量输入 -->
              <div v-if="pawnForm.item_key">
                <label class="block text-xs font-bold text-fg-muted mb-2 uppercase tracking-wider">典当数量</label>
                <div class="flex items-center gap-3">
                  <button
                    @click="changeQuantity(-1)"
                    :disabled="pawnForm.quantity <= 1"
                    class="w-10 h-10 rounded-control bg-surface-hover hover:bg-surface-active text-fg-secondary text-xl font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >-</button>
                  <input
                    v-model.number="pawnForm.quantity"
                    type="number"
                    min="1"
                    :max="maxPawnQuantity"
                    @blur="handleQuantityInput"
                    @keyup.enter="handleQuantityInput"
                    class="w-24 text-center bg-surface-sunken border border-line rounded-control py-2 text-gold-400 font-bold text-lg num focus:outline-none focus:border-gold-700"
                  />
                  <button
                    @click="changeQuantity(1)"
                    :disabled="pawnForm.quantity >= maxPawnQuantity"
                    class="w-10 h-10 rounded-control bg-surface-hover hover:bg-surface-active text-fg-secondary text-xl font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >+</button>
                  <AppButton
                    size="sm"
                    variant="default"
                    @click="pawnForm.quantity = maxPawnQuantity; handleAppraise()"
                  >最大</AppButton>
                </div>
              </div>

              <!-- 估值预览 -->
              <div v-if="appraiseLoading" class="flex items-center gap-2 text-xs text-fg-faint">
                <span class="inline-block w-3.5 h-3.5 rounded-full border-2 border-line-strong border-t-gold-500 animate-spin"></span>
                <span>正在估价…</span>
              </div>
              <PanelCard v-else-if="appraiseResult" tone="gold" padded>
                <div class="space-y-2">
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-fg-muted">物品</span>
                    <span class="text-gold-300 font-bold">{{ appraiseResult.item_info.name }}</span>
                  </div>
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-fg-muted">基础价值</span>
                    <span class="text-fg-primary num" :title="appraiseResult.base_price">{{ formatCompact(appraiseResult.base_price) }} 灵石</span>
                  </div>
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-fg-muted">品质折扣</span>
                    <span class="text-fg-primary num">x{{ appraiseResult.quality_ratio.toFixed(2) }}</span>
                  </div>
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-fg-muted">信用加成</span>
                    <span class="text-emerald-400 num">+{{ (appraiseResult.credit_bonus * 100).toFixed(1) }}%</span>
                  </div>
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-fg-muted">单件估值</span>
                    <span class="text-fg-primary num" :title="appraiseResult.valuation_per_item">{{ formatCompact(appraiseResult.valuation_per_item) }} 灵石</span>
                  </div>
                  <div class="border-t border-gold-800/50 pt-2 flex items-center justify-between">
                    <span class="text-sm text-fg-muted">总估值（{{ appraiseResult.quantity }} 件）</span>
                    <span class="text-lg font-bold text-gold-400 num" :title="appraiseResult.total_valuation">{{ formatCompact(appraiseResult.total_valuation) }} 灵石</span>
                  </div>
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-fg-muted">手续费（{{ (appraiseResult.pawn_fee_rate * 100).toFixed(1) }}%）</span>
                    <span class="text-rose-400 num" :title="appraiseResult.pawn_fee">-{{ formatCompact(appraiseResult.pawn_fee) }} 灵石</span>
                  </div>
                  <div class="bg-surface-tint-gold-strong rounded-control px-2 py-2 flex items-center justify-between">
                    <span class="text-sm font-bold text-gold-300">实得灵石</span>
                    <span class="text-xl font-bold text-gold-400 num" :title="appraiseResult.pawn_amount">{{ formatCompact(appraiseResult.pawn_amount) }} 灵石</span>
                  </div>
                  <div class="flex items-center justify-between text-xs text-fg-faint">
                    <span>{{ status?.config?.redeem_period_days || 7 }} 天后赎回价预估</span>
                    <span class="text-rose-400 num" :title="appraiseResult.redeem_amount_7d">{{ formatCompact(appraiseResult.redeem_amount_7d) }} 灵石</span>
                  </div>
                </div>
              </PanelCard>

              <!-- 当铺说明 -->
              <PanelCard v-if="!pawnForm.item_key" tone="muted">
                <div class="text-xs text-fg-muted space-y-2">
                  <p class="font-bold text-fg-secondary">当铺规则：</p>
                  <p>· 典当物品可立即获得灵石（扣除手续费），{{ status?.config?.redeem_period_days || 7 }} 天内可赎回</p>
                  <p>· 赎回需支付本金 + 利息（每日 {{ ((status?.config?.redeem_daily_interest_rate || 0) * 100).toFixed(1) }}%）</p>
                  <p>· 按时赎回可增加当铺信用额度，最高 +10% 估值加成</p>
                  <p>· 逾期未赎回的物品将归当铺所有</p>
                </div>
              </PanelCard>

              <!-- 典当按钮 -->
              <AppButton
                v-if="pawnForm.item_key && appraiseResult"
                variant="primary"
                block
                :disabled="submitting || dailyPawnRemaining <= 0 || activeListingsRemaining <= 0"
                @click="openPawnConfirmModal"
              >
                <span v-if="dailyPawnRemaining <= 0">今日典当次数已用尽</span>
                <span v-else-if="activeListingsRemaining <= 0">活跃当票已达上限</span>
                <span v-else>确认典当</span>
              </AppButton>
            </div>
          </div>

          <!-- ===================== 我的当票 Tab ===================== -->
          <div v-else-if="activeTab === 'listings'">
            <!-- 筛选 -->
            <div class="flex items-center gap-2 mb-3">
              <button
                v-for="opt in [
                  { value: 'active', label: '典当中' },
                  { value: 'redeemed', label: '已赎回' },
                  { value: 'overdue', label: '已逾期' },
                  { value: 'all', label: '全部' }
                ]"
                :key="opt.value"
                @click="listingsFilter = opt.value; handleListingsFilterChange()"
                class="px-3 py-1 rounded-control text-xs border transition-colors"
                :class="listingsFilter === opt.value
                  ? 'bg-surface-tint-gold text-gold-400 border-gold-700/60'
                  : 'bg-transparent text-fg-faint hover:text-fg-secondary border-transparent'"
              >
                {{ opt.label }}
              </button>
            </div>

            <!-- 空状态 -->
            <EmptyState v-if="listings.length === 0" text="暂无当票记录" hint="切换到「典当」页签，把闲置物品换成灵石" />

            <!-- 当票列表 -->
            <div v-else class="space-y-3">
              <div
                v-for="listing in listings"
                :key="listing.id"
                class="bg-surface-raised border border-line-subtle rounded-panel p-4 hover:border-gold-800 transition-colors"
                :class="isOverdue(listing) ? 'border-rose-900/70' : ''"
              >
                <div class="flex items-start justify-between gap-3">
                  <!-- 物品信息 -->
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-base font-bold" :class="getQualityStyle(listing.item_quality).color">
                        {{ listing.item_name }}
                      </span>
                      <span class="text-xs text-fg-faint">x{{ listing.quantity }}</span>
                      <Badge :tone="listingStatusTone(isOverdue(listing) ? 'overdue' : listing.status)">
                        {{ isOverdue(listing) ? '已逾期' : listingStatusLabel(listing.status) }}
                      </Badge>
                    </div>
                    <!-- 典当金额信息 -->
                    <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-2">
                      <div class="flex items-center justify-between">
                        <span class="text-fg-faint">典当所得</span>
                        <span class="text-gold-300 font-bold num" :title="listing.pawn_amount">{{ formatCompact(listing.pawn_amount) }} 灵石</span>
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-fg-faint">手续费</span>
                        <span class="text-rose-400 num" :title="listing.pawn_fee">{{ formatCompact(listing.pawn_fee) }} 灵石</span>
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-fg-faint">原赎回价</span>
                        <span class="text-fg-secondary num" :title="listing.redeem_amount">{{ formatCompact(listing.redeem_amount) }} 灵石</span>
                      </div>
                      <div v-if="listing.status === 'active'" class="flex items-center justify-between">
                        <span class="text-fg-faint">当前赎回价</span>
                        <span class="text-gold-400 font-bold num" :title="listing.current_redeem_amount || listing.redeem_amount">
                          {{ formatCompact(listing.current_redeem_amount || listing.redeem_amount) }} 灵石
                        </span>
                      </div>
                    </div>
                    <!-- 时间信息 -->
                    <div class="text-xs text-fg-faint mt-2 flex items-center gap-3 flex-wrap">
                      <span>典当 {{ formatDateTime(listing.pawned_at) }}</span>
                      <span v-if="listing.status === 'active'">
                        剩余 <span :class="isOverdue(listing) ? 'text-rose-400 font-bold' : 'text-gold-400'">
                          {{ formatRemaining(getRemainingMs(listing)) }}
                        </span>
                      </span>
                      <span v-else-if="listing.redeemed_at">赎回 {{ formatDateTime(listing.redeemed_at) }}</span>
                    </div>
                  </div>
                  <!-- 操作区 -->
                  <div class="flex flex-col items-end gap-2">
                    <button
                      v-if="listing.status === 'active' && !isOverdue(listing)"
                      @click="openRedeemConfirmModal(listing)"
                      :disabled="submitting"
                      class="px-4 py-1.5 rounded-control bg-emerald-900/30 border border-emerald-800 text-emerald-300 hover:bg-emerald-800/50 hover:text-emerald-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
                    >
                      赎回
                    </button>
                  </div>
                </div>
              </div>

              <!-- 分页 -->
              <div class="flex items-center justify-between pt-2">
                <span class="text-xs text-fg-faint">共 {{ listingsTotal }} 条</span>
                <div class="flex items-center gap-2">
                  <AppButton size="sm" variant="default" :disabled="listingsPage <= 1" @click="changeListingsPage(-1)">
                    上一页
                  </AppButton>
                  <span class="text-xs text-fg-muted num">{{ listingsPage }} / {{ listingsTotalPages }}</span>
                  <AppButton size="sm" variant="default" :disabled="listingsPage >= listingsTotalPages" @click="changeListingsPage(1)">
                    下一页
                  </AppButton>
                </div>
              </div>
            </div>
          </div>

          <!-- ===================== 历史 Tab ===================== -->
          <div v-else>
            <!-- 空状态 -->
            <EmptyState v-if="history.length === 0" text="暂无历史记录" hint="典当与赎回成交后都会留档在此" />

            <!-- 历史列表 -->
            <div v-else class="space-y-2">
              <div
                v-for="item in history"
                :key="item.id"
                class="bg-surface-raised border border-line-subtle rounded-panel p-3 flex items-center justify-between gap-3"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <Badge :tone="actionTypeTone(item.action_type)">{{ actionTypeLabel(item.action_type) }}</Badge>
                    <span class="text-sm text-fg-primary truncate">{{ item.item_name }}</span>
                    <span class="text-xs text-fg-faint">x{{ item.quantity }}</span>
                  </div>
                  <div class="text-xs text-fg-faint">{{ formatDateTime(item.created_at) }}</div>
                </div>
                <div class="text-right">
                  <div class="text-sm font-bold num" :class="item.action_type === 'pawn' ? 'text-gold-400' : 'text-emerald-400'" :title="item.amount">
                    {{ item.action_type === 'pawn' ? '+' : '-' }}{{ formatCompact(item.amount) }} 灵石
                  </div>
                </div>
              </div>

              <!-- 分页 -->
              <div class="flex items-center justify-between pt-2">
                <span class="text-xs text-fg-faint">共 {{ historyTotal }} 条</span>
                <div class="flex items-center gap-2">
                  <AppButton size="sm" variant="default" :disabled="historyPage <= 1" @click="changeHistoryPage(-1)">
                    上一页
                  </AppButton>
                  <span class="text-xs text-fg-muted num">{{ historyPage }} / {{ historyTotalPages }}</span>
                  <AppButton size="sm" variant="default" :disabled="historyPage >= historyTotalPages" @click="changeHistoryPage(1)">
                    下一页
                  </AppButton>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- ========== 典当确认弹窗 ========== -->
    <Modal :isOpen="pawnConfirmModal.show" title="确认典当" width="480px" @close="closePawnConfirmModal">
      <div v-if="appraiseResult" class="space-y-3">
        <p class="text-sm text-fg-secondary">即将典当以下物品，请确认：</p>
        <div class="bg-surface-canvas border border-line-subtle rounded-control p-3 space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span class="text-fg-faint">物品</span>
            <span class="text-gold-300 font-bold">{{ appraiseResult.item_info.name }} x{{ appraiseResult.quantity }}</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-fg-faint">总估值</span>
            <span class="text-fg-primary num" :title="appraiseResult.total_valuation">{{ formatCompact(appraiseResult.total_valuation) }} 灵石</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-fg-faint">手续费</span>
            <span class="text-rose-400 num" :title="appraiseResult.pawn_fee">-{{ formatCompact(appraiseResult.pawn_fee) }} 灵石</span>
          </div>
          <div class="border-t border-line-subtle pt-2 flex items-center justify-between">
            <span class="text-sm font-bold text-gold-300">实得灵石</span>
            <span class="text-lg font-bold text-gold-400 num" :title="appraiseResult.pawn_amount">{{ formatCompact(appraiseResult.pawn_amount) }} 灵石</span>
          </div>
        </div>
        <p class="text-xs text-fg-faint">
          提示：典当后 {{ status?.config?.redeem_period_days || 7 }} 天内可赎回，赎回需支付本金 + 利息。逾期未赎回的物品将归当铺所有。
        </p>
      </div>
      <template #footer>
        <AppButton variant="default" @click="closePawnConfirmModal">取消</AppButton>
        <AppButton variant="primary" :disabled="submitting" @click="confirmPawn">
          {{ submitting ? '处理中…' : '确认典当' }}
        </AppButton>
      </template>
    </Modal>

    <!-- ========== 赎回确认弹窗 ========== -->
    <Modal :isOpen="redeemConfirmModal.show" title="确认赎回" width="480px" @close="closeRedeemConfirmModal">
      <div v-if="redeemConfirmModal.listing" class="space-y-3">
        <p class="text-sm text-fg-secondary">即将赎回以下当票，请确认：</p>
        <div class="bg-surface-canvas border border-line-subtle rounded-control p-3 space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span class="text-fg-faint">物品</span>
            <span class="text-gold-300 font-bold">
              {{ redeemConfirmModal.listing.item_name }} x{{ redeemConfirmModal.listing.quantity }}
            </span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-fg-faint">原典当所得</span>
            <span class="text-fg-primary num" :title="redeemConfirmModal.listing.pawn_amount">{{ formatCompact(redeemConfirmModal.listing.pawn_amount) }} 灵石</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-fg-faint">当前赎回价</span>
            <span class="text-rose-400 font-bold num" :title="redeemConfirmModal.listing.current_redeem_amount || redeemConfirmModal.listing.redeem_amount">
              {{ formatCompact(redeemConfirmModal.listing.current_redeem_amount || redeemConfirmModal.listing.redeem_amount) }} 灵石
            </span>
          </div>
        </div>
        <p class="text-xs text-fg-faint">
          提示：赎回后物品将归还储物袋，当铺信用额度 +1（影响估值加成）。
        </p>
      </div>
      <template #footer>
        <AppButton variant="default" @click="closeRedeemConfirmModal">取消</AppButton>
        <AppButton variant="primary" :disabled="submitting" @click="confirmRedeem">
          {{ submitting ? '处理中…' : '确认赎回' }}
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<style scoped>
/* 隐藏 number 输入框的箭头 */
input[type=number]::-webkit-inner-spin-button,
input[type=number]::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type=number] {
  -moz-appearance: textfield;
}
</style>
