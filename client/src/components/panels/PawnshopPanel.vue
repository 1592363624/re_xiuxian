<script setup>
/**
 * 聚宝当铺面板组件（玩家侧）
 *
 * 功能说明：
 *   - 弹窗式面板，参考 MeditationPanel / MarketPanel 的设计风格
 *   - 标题区：展示玩家当铺信用额度、当前灵石、今日典当次数、活跃当票数
 *   - Tab 切换：典当 / 我的当票 / 历史
 *     · 典当 Tab：物品选择下拉框（从储物袋拉取，仅显示可典当物品）、数量输入框、估值预览、确认典当按钮（带二次确认 Modal）
 *     · 我的当票 Tab：当票列表、赎回按钮（带二次确认 Modal）、剩余赎回时间倒计时
 *     · 历史 Tab：分页历史记录列表
 *   - 颜色风格：黄色系（amber-400/amber-500/amber-600）体现金银当铺主题
 *
 * 设计原则：
 *   - 所有业务逻辑在后端 PawnshopService 处理，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - BIGINT 金额字段统一以字符串展示，避免 JS Number 精度问题
 *   - 倒计时基于 pawned_at + redeem_deadline 本地 tick 递减，每秒刷新
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { formatTime } from '../../utils/format'
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

// 当前激活的 Tab：pawn=典当，listings=我的当票，history=历史
const activeTab = ref('pawn')
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
 * 信用进度百分比（用于进度条展示）
 */
const creditPercent = computed(() => {
  if (!status.value) return 0
  const credit = status.value.credit || 0
  const max = status.value.config?.credit_max || 100
  if (max <= 0) return 0
  return Math.min(100, Math.floor((credit / max) * 100))
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
 * 品质颜色与中文标签映射（与 InventoryPanel 保持一致）
 */
const qualityStyleMap = {
  common: { color: 'text-stone-300', label: '普通' },
  uncommon: { color: 'text-emerald-400', label: '非凡' },
  rare: { color: 'text-blue-400', label: '稀有' },
  epic: { color: 'text-purple-400', label: '史诗' },
  legendary: { color: 'text-amber-400', label: '传说' },
  unknown: { color: 'text-stone-500', label: '未知' }
}

/**
 * 获取品质样式
 * @param {string} quality - 品质 key
 */
const getQualityStyle = (quality) => {
  return qualityStyleMap[quality] || qualityStyleMap.unknown
}

/**
 * 格式化时间为 MM-DD HH:mm
 * @param {string} timeStr - ISO 时间字符串
 */
const formatDateTime = (timeStr) => {
  if (!timeStr) return '-'
  const d = new Date(timeStr)
  if (isNaN(d.getTime())) return '-'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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
 * 当票状态标签样式类
 * @param {string} status - 当票状态
 */
const listingStatusClass = (status) => {
  switch (status) {
    case 'active': return 'bg-amber-950/40 text-amber-400 border-amber-700/50'
    case 'redeemed': return 'bg-emerald-950/40 text-emerald-400 border-emerald-700/50'
    case 'overdue': return 'bg-rose-950/40 text-rose-400 border-rose-700/50'
    case 'auctioned': return 'bg-stone-800 text-stone-400 border-stone-700'
    default: return 'bg-stone-800 text-stone-400 border-stone-700'
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
 * 历史记录操作类型样式类
 * @param {string} actionType - 操作类型
 */
const actionTypeClass = (actionType) => {
  switch (actionType) {
    case 'pawn': return 'text-amber-400'
    case 'redeem': return 'text-emerald-400'
    case 'overdue': return 'text-rose-400'
    case 'auction': return 'text-stone-400'
    default: return 'text-stone-400'
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
    const msg = error.response?.data?.message || '获取当铺状态失败'
    uiStore.showToast(msg, 'error')
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
    uiStore.showToast('获取储物袋失败', 'error')
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
    const msg = error.response?.data?.message || '获取当票列表失败'
    uiStore.showToast(msg, 'error')
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
    const msg = error.response?.data?.message || '获取历史记录失败'
    uiStore.showToast(msg, 'error')
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
    const msg = error.response?.data?.message || error.response?.data?.error || '典当失败'
    uiStore.showToast(msg, 'error')
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
    const msg = error.response?.data?.message || error.response?.data?.error || '赎回失败'
    uiStore.showToast(msg, 'error')
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
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-amber-900/40 rounded-lg w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl shadow-amber-900/20 overflow-hidden animate-fade-in">
      <!-- 标题栏：当铺名称 + 信用额度 + 关闭按钮 -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-gradient-to-r from-amber-950/40 to-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2 2 7l10 5 10-5-10-5z"/>
            <path d="m2 17 10 5 10-5"/>
            <path d="m2 12 10 5 10-5"/>
          </svg>
          聚宝当铺
        </h2>
        <div class="flex items-center gap-4">
          <!-- 信用额度展示 -->
          <div v-if="status" class="flex items-center gap-2">
            <div class="text-right">
              <div class="text-[10px] text-stone-500">当铺信用</div>
              <div class="text-sm font-bold text-amber-300">{{ status.credit }} / {{ status.config?.credit_max || 100 }}</div>
            </div>
            <div class="w-24 h-2 bg-stone-900 rounded-full overflow-hidden">
              <div
                class="h-full bg-gradient-to-r from-amber-600 to-amber-400 transition-all duration-500"
                :style="{ width: creditPercent + '%' }"
              ></div>
            </div>
            <span class="text-xs text-emerald-400 whitespace-nowrap">{{ creditBonusText }}</span>
          </div>
          <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <!-- 状态信息条：今日次数 / 活跃当票 / 灵石余额 -->
      <div v-if="status" class="grid grid-cols-3 gap-2 p-3 border-b border-stone-800 bg-[#0c0a09]">
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">今日典当</div>
          <div class="text-sm font-bold" :class="dailyPawnRemaining > 0 ? 'text-amber-400' : 'text-stone-500'">
            {{ dailyPawnRemaining }} / {{ status.daily_pawn_limit }}
          </div>
        </div>
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">活跃当票</div>
          <div class="text-sm font-bold" :class="activeListingsRemaining > 0 ? 'text-amber-400' : 'text-rose-400'">
            {{ status.active_listings_count }} / {{ status.max_active_listings }}
          </div>
        </div>
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">灵石余额</div>
          <div class="text-sm font-bold text-amber-300">{{ status.spirit_stones }}</div>
        </div>
      </div>

      <!-- Tab 切换 -->
      <div class="flex border-b border-stone-800 bg-[#1c1917]">
        <button
          @click="switchTab('pawn')"
          class="flex-1 px-4 py-3 text-sm font-bold transition-colors relative"
          :class="activeTab === 'pawn' ? 'text-amber-400' : 'text-stone-500 hover:text-stone-300'"
        >
          典当
          <span v-if="activeTab === 'pawn'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500"></span>
        </button>
        <button
          @click="switchTab('listings')"
          class="flex-1 px-4 py-3 text-sm font-bold transition-colors relative"
          :class="activeTab === 'listings' ? 'text-amber-400' : 'text-stone-500 hover:text-stone-300'"
        >
          我的当票
          <span v-if="activeTab === 'listings'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500"></span>
        </button>
        <button
          @click="switchTab('history')"
          class="flex-1 px-4 py-3 text-sm font-bold transition-colors relative"
          :class="activeTab === 'history' ? 'text-amber-400' : 'text-stone-500 hover:text-stone-300'"
        >
          历史记录
          <span v-if="activeTab === 'history'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500"></span>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto p-4 custom-scrollbar">
        <!-- 加载中 -->
        <div v-if="loading" class="flex justify-center items-center h-64">
          <svg class="animate-spin h-10 w-10 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>

        <template v-else>
          <!-- ===================== 典当 Tab ===================== -->
          <div v-if="activeTab === 'pawn'">
            <!-- 物品选择 -->
            <div class="space-y-4">
              <div>
                <label class="block text-xs font-bold text-stone-400 mb-2 uppercase tracking-wider">选择典当物品</label>
                <select
                  v-model="pawnForm.item_key"
                  @change="handleItemChange"
                  class="w-full bg-[#0c0a09] border border-stone-700 rounded px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-amber-600"
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
                <p v-if="selectedInventoryItem" class="text-xs text-stone-600 mt-1">
                  持有数量：{{ selectedInventoryItem.quantity }} · 单次最多典当 {{ status?.config?.max_pawn_quantity_per_transaction || 99 }} 个
                </p>
              </div>

              <!-- 数量输入 -->
              <div v-if="pawnForm.item_key">
                <label class="block text-xs font-bold text-stone-400 mb-2 uppercase tracking-wider">典当数量</label>
                <div class="flex items-center gap-3">
                  <button
                    @click="changeQuantity(-1)"
                    :disabled="pawnForm.quantity <= 1"
                    class="w-10 h-10 rounded bg-stone-800 hover:bg-stone-700 text-stone-300 text-xl font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >-</button>
                  <input
                    v-model.number="pawnForm.quantity"
                    type="number"
                    min="1"
                    :max="maxPawnQuantity"
                    @blur="handleQuantityInput"
                    @keyup.enter="handleQuantityInput"
                    class="w-24 text-center bg-stone-900 border border-stone-700 rounded py-2 text-amber-400 font-bold text-lg focus:outline-none focus:border-amber-600"
                  />
                  <button
                    @click="changeQuantity(1)"
                    :disabled="pawnForm.quantity >= maxPawnQuantity"
                    class="w-10 h-10 rounded bg-stone-800 hover:bg-stone-700 text-stone-300 text-xl font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >+</button>
                  <button
                    @click="pawnForm.quantity = maxPawnQuantity; handleAppraise()"
                    class="px-3 py-1 text-xs rounded bg-stone-800 hover:bg-stone-700 text-stone-400 transition-colors"
                  >最大</button>
                </div>
              </div>

              <!-- 估值预览 -->
              <div v-if="appraiseLoading" class="flex items-center gap-2 text-xs text-stone-500">
                <svg class="animate-spin h-4 w-4 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>正在估价...</span>
              </div>
              <div v-else-if="appraiseResult" class="bg-amber-950/20 border border-amber-800/40 rounded-lg p-4 space-y-2">
                <div class="flex items-center justify-between text-sm">
                  <span class="text-stone-400">物品</span>
                  <span class="text-amber-300 font-bold">{{ appraiseResult.item_info.name }}</span>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span class="text-stone-400">基础价值</span>
                  <span class="text-stone-200">{{ appraiseResult.base_price }} 灵石</span>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span class="text-stone-400">品质折扣</span>
                  <span class="text-stone-200">x{{ appraiseResult.quality_ratio.toFixed(2) }}</span>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span class="text-stone-400">信用加成</span>
                  <span class="text-emerald-400">+{{ (appraiseResult.credit_bonus * 100).toFixed(1) }}%</span>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span class="text-stone-400">单件估值</span>
                  <span class="text-stone-200">{{ appraiseResult.valuation_per_item }} 灵石</span>
                </div>
                <div class="border-t border-amber-800/40 pt-2 flex items-center justify-between">
                  <span class="text-sm text-stone-400">总估值（{{ appraiseResult.quantity }} 件）</span>
                  <span class="text-lg font-bold text-amber-400">{{ appraiseResult.total_valuation }} 灵石</span>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span class="text-stone-400">手续费（{{ (appraiseResult.pawn_fee_rate * 100).toFixed(1) }}%）</span>
                  <span class="text-rose-400">-{{ appraiseResult.pawn_fee }} 灵石</span>
                </div>
                <div class="bg-amber-900/20 rounded p-2 flex items-center justify-between">
                  <span class="text-sm font-bold text-amber-300">实得灵石</span>
                  <span class="text-xl font-bold text-amber-400">{{ appraiseResult.pawn_amount }} 灵石</span>
                </div>
                <div class="flex items-center justify-between text-xs text-stone-500">
                  <span>{{ status?.config?.redeem_period_days || 7 }} 天后赎回价预估</span>
                  <span class="text-rose-400">{{ appraiseResult.redeem_amount_7d }} 灵石</span>
                </div>
              </div>

              <!-- 当铺说明 -->
              <div v-if="!pawnForm.item_key" class="bg-stone-900/40 border border-stone-800 rounded-lg p-4 text-xs text-stone-500 space-y-2">
                <p class="font-bold text-stone-400">当铺规则：</p>
                <p>· 典当物品可立即获得灵石（扣除手续费），{{ status?.config?.redeem_period_days || 7 }} 天内可赎回</p>
                <p>· 赎回需支付本金 + 利息（每日 {{ ((status?.config?.redeem_daily_interest_rate || 0) * 100).toFixed(1) }}%）</p>
                <p>· 按时赎回可增加当铺信用额度，最高 +10% 估值加成</p>
                <p>· 逾期未赎回的物品将归当铺所有</p>
              </div>

              <!-- 典当按钮 -->
              <button
                v-if="pawnForm.item_key && appraiseResult"
                @click="openPawnConfirmModal"
                :disabled="submitting || dailyPawnRemaining <= 0 || activeListingsRemaining <= 0"
                class="w-full py-3 rounded-lg font-bold tracking-widest text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-amber-900/40 border border-amber-700 text-amber-300 hover:bg-amber-900/50 hover:border-amber-500"
              >
                <span v-if="dailyPawnRemaining <= 0">今日典当次数已用尽</span>
                <span v-else-if="activeListingsRemaining <= 0">活跃当票已达上限</span>
                <span v-else>确认典当</span>
              </button>
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
                class="px-3 py-1 rounded text-xs transition-colors"
                :class="listingsFilter === opt.value
                  ? 'bg-amber-900/30 text-amber-400 border border-amber-700/50'
                  : 'text-stone-500 hover:text-stone-300 border border-transparent'"
              >
                {{ opt.label }}
              </button>
            </div>

            <!-- 空状态 -->
            <div v-if="listings.length === 0" class="flex flex-col items-center justify-center h-48 text-stone-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
                <path d="M12 2 2 7l10 5 10-5-10-5z"/>
                <path d="m2 17 10 5 10-5"/>
                <path d="m2 12 10 5 10-5"/>
              </svg>
              <p>暂无当票记录</p>
            </div>

            <!-- 当票列表 -->
            <div v-else class="space-y-3">
              <div
                v-for="listing in listings"
                :key="listing.id"
                class="bg-[#1c1917] border border-stone-800 rounded-lg p-4 hover:border-amber-800/50 transition-colors"
                :class="isOverdue(listing) ? 'border-rose-800/50' : ''"
              >
                <div class="flex items-start justify-between gap-3">
                  <!-- 物品信息 -->
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-base font-bold" :class="getQualityStyle(listing.item_quality).color">
                        {{ listing.item_name }}
                      </span>
                      <span class="text-xs text-stone-500">x{{ listing.quantity }}</span>
                      <span class="text-xs px-2 py-0.5 rounded border" :class="listingStatusClass(isOverdue(listing) ? 'overdue' : listing.status)">
                        {{ isOverdue(listing) ? '已逾期' : listingStatusLabel(listing.status) }}
                      </span>
                    </div>
                    <!-- 典当金额信息 -->
                    <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-2">
                      <div class="flex items-center justify-between">
                        <span class="text-stone-500">典当所得</span>
                        <span class="text-amber-300 font-bold">{{ listing.pawn_amount }} 灵石</span>
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-stone-500">手续费</span>
                        <span class="text-rose-400">{{ listing.pawn_fee }} 灵石</span>
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-stone-500">原赎回价</span>
                        <span class="text-stone-300">{{ listing.redeem_amount }} 灵石</span>
                      </div>
                      <div v-if="listing.status === 'active'" class="flex items-center justify-between">
                        <span class="text-stone-500">当前赎回价</span>
                        <span class="text-amber-400 font-bold">{{ listing.current_redeem_amount || listing.redeem_amount }} 灵石</span>
                      </div>
                    </div>
                    <!-- 时间信息 -->
                    <div class="text-xs text-stone-600 mt-2 flex items-center gap-3 flex-wrap">
                      <span>典当 {{ formatDateTime(listing.pawned_at) }}</span>
                      <span v-if="listing.status === 'active'">
                        剩余 <span :class="isOverdue(listing) ? 'text-rose-400 font-bold' : 'text-amber-400'">
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
                      class="px-4 py-1.5 rounded bg-emerald-900/30 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
                    >
                      赎回
                    </button>
                  </div>
                </div>
              </div>

              <!-- 分页 -->
              <div class="flex items-center justify-between pt-2">
                <span class="text-xs text-stone-600">共 {{ listingsTotal }} 条</span>
                <div class="flex items-center gap-2">
                  <button
                    @click="changeListingsPage(-1)"
                    :disabled="listingsPage <= 1"
                    class="px-3 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-sm"
                  >上一页</button>
                  <span class="text-xs text-stone-400">{{ listingsPage }} / {{ listingsTotalPages }}</span>
                  <button
                    @click="changeListingsPage(1)"
                    :disabled="listingsPage >= listingsTotalPages"
                    class="px-3 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-sm"
                  >下一页</button>
                </div>
              </div>
            </div>
          </div>

          <!-- ===================== 历史 Tab ===================== -->
          <div v-else>
            <!-- 空状态 -->
            <div v-if="history.length === 0" class="flex flex-col items-center justify-center h-48 text-stone-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              <p>暂无历史记录</p>
            </div>

            <!-- 历史列表 -->
            <div v-else class="space-y-2">
              <div
                v-for="item in history"
                :key="item.id"
                class="bg-[#1c1917] border border-stone-800 rounded-lg p-3 flex items-center justify-between gap-3"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs px-2 py-0.5 rounded font-bold" :class="actionTypeClass(item.action_type)">
                      {{ actionTypeLabel(item.action_type) }}
                    </span>
                    <span class="text-sm text-stone-200 truncate">{{ item.item_name }}</span>
                    <span class="text-xs text-stone-500">x{{ item.quantity }}</span>
                  </div>
                  <div class="text-xs text-stone-600">{{ formatDateTime(item.created_at) }}</div>
                </div>
                <div class="text-right">
                  <div class="text-sm font-bold" :class="item.action_type === 'pawn' ? 'text-amber-400' : 'text-emerald-400'">
                    {{ item.action_type === 'pawn' ? '+' : '-' }}{{ item.amount }} 灵石
                  </div>
                </div>
              </div>

              <!-- 分页 -->
              <div class="flex items-center justify-between pt-2">
                <span class="text-xs text-stone-600">共 {{ historyTotal }} 条</span>
                <div class="flex items-center gap-2">
                  <button
                    @click="changeHistoryPage(-1)"
                    :disabled="historyPage <= 1"
                    class="px-3 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-sm"
                  >上一页</button>
                  <span class="text-xs text-stone-400">{{ historyPage }} / {{ historyTotalPages }}</span>
                  <button
                    @click="changeHistoryPage(1)"
                    :disabled="historyPage >= historyTotalPages"
                    class="px-3 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-sm"
                  >下一页</button>
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
        <p class="text-sm text-stone-300">即将典当以下物品，请确认：</p>
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3 space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span class="text-stone-500">物品</span>
            <span class="text-amber-300 font-bold">{{ appraiseResult.item_info.name }} x{{ appraiseResult.quantity }}</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-stone-500">总估值</span>
            <span class="text-stone-200">{{ appraiseResult.total_valuation }} 灵石</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-stone-500">手续费</span>
            <span class="text-rose-400">-{{ appraiseResult.pawn_fee }} 灵石</span>
          </div>
          <div class="border-t border-stone-800 pt-2 flex items-center justify-between">
            <span class="text-sm font-bold text-amber-300">实得灵石</span>
            <span class="text-lg font-bold text-amber-400">{{ appraiseResult.pawn_amount }} 灵石</span>
          </div>
        </div>
        <p class="text-xs text-stone-600">
          提示：典当后 {{ status?.config?.redeem_period_days || 7 }} 天内可赎回，赎回需支付本金 + 利息。逾期未赎回的物品将归当铺所有。
        </p>
      </div>
      <template #footer>
        <button
          @click="closePawnConfirmModal"
          class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 transition-colors text-sm"
        >取消</button>
        <button
          @click="confirmPawn"
          :disabled="submitting"
          class="px-4 py-2 rounded bg-amber-900/50 border border-amber-700/50 text-amber-300 hover:bg-amber-800/60 hover:text-amber-200 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span v-if="submitting">处理中...</span>
          <span v-else>确认典当</span>
        </button>
      </template>
    </Modal>

    <!-- ========== 赎回确认弹窗 ========== -->
    <Modal :isOpen="redeemConfirmModal.show" title="确认赎回" width="480px" @close="closeRedeemConfirmModal">
      <div v-if="redeemConfirmModal.listing" class="space-y-3">
        <p class="text-sm text-stone-300">即将赎回以下当票，请确认：</p>
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3 space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span class="text-stone-500">物品</span>
            <span class="text-amber-300 font-bold">
              {{ redeemConfirmModal.listing.item_name }} x{{ redeemConfirmModal.listing.quantity }}
            </span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-stone-500">原典当所得</span>
            <span class="text-stone-200">{{ redeemConfirmModal.listing.pawn_amount }} 灵石</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-stone-500">当前赎回价</span>
            <span class="text-rose-400 font-bold">
              {{ redeemConfirmModal.listing.current_redeem_amount || redeemConfirmModal.listing.redeem_amount }} 灵石
            </span>
          </div>
        </div>
        <p class="text-xs text-stone-600">
          提示：赎回后物品将归还储物袋，当铺信用额度 +1（影响估值加成）。
        </p>
      </div>
      <template #footer>
        <button
          @click="closeRedeemConfirmModal"
          class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 transition-colors text-sm"
        >取消</button>
        <button
          @click="confirmRedeem"
          :disabled="submitting"
          class="px-4 py-2 rounded bg-emerald-900/50 border border-emerald-700/50 text-emerald-300 hover:bg-emerald-800/60 hover:text-emerald-200 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span v-if="submitting">处理中...</span>
          <span v-else>确认赎回</span>
        </button>
      </template>
    </Modal>
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

/* 自定义滚动条 */
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #44403c;
  border-radius: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #57534e;
}

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
