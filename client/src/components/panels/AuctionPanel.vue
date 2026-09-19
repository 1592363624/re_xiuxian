<script setup>
/**
 * 拍卖竞价面板组件（玩家侧）
 *
 * 功能说明：
 *   - 外壳统一走 ui/PanelShell（遮罩 / 关闭 / 右坞停靠），面板不再自写遮罩与外壳
 *   - 规则提示条：手续费率 / 防秒杀 / 时长范围
 *   - Tab 切换走 ui/Tabs：拍卖列表 / 创建拍卖 / 我的拍卖 / 我的竞价
 *     · 拍卖列表 Tab：全服拍卖列表（物品/数量/当前价/剩余时间/卖家），点击行查看详情 + 出价
 *     · 创建拍卖 Tab：从储物袋选物品 + 起拍价 + 时长，二次确认后创建
 *     · 我的拍卖 Tab：我发布的拍卖列表 + 撤销按钮（带二次确认）
 *     · 我的竞价 Tab：我参与的竞价（领先/得标/落标状态标记）
 *       GET /auction/my-bids 返回的是拍平的拍卖摘要，行内直接读顶层字段；
 *       该列表不下发"我出过多少"，所以这里没有「我的出价」列，出价请看详情的竞价历史
 *   - 颜色风格：玫红（rose-*）作强调色体现竞价博弈的热烈感，中性色走 surface / fg 令牌
 *   - 详情 Modal：物品信息 + 竞价历史 + 出价输入 + 二次确认
 *
 * 设计原则：
 *   - 所有业务逻辑在后端 AuctionService 处理，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - BIGINT 金额字段统一走 formatCompact 展示（hover 看精确值），避免 JS Number 精度问题
 *   - 剩余时间基于 end_at 本地 tick 递减，每秒刷新
 *   - 防秒杀延长：出价接口回传 auction.end_at 与 auction.extension_count，
 *     前端把回传的结束时间和出价前的值一比即知是否延长（服务端没有 extended/new_end_at 字段）
 *
 * 玩法文档对照：xiuxian_game_guide.md 第27节·市场、股市与资产路线
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import PanelCard from '../ui/PanelCard.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import { formatCompact } from '../../utils/format'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { getInventory } from '../../api/inventory'
import {
  getConfig,
  getList,
  getDetail,
  createAuction,
  placeBid,
  cancelAuction,
  getMyAuctions,
  getMyBids
} from '../../api/auction'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

/* ===================== 基础状态 ===================== */

// 当前激活的 Tab：list=拍卖列表，create=创建拍卖，mine=我的拍卖，bids=我的竞价
// （key/label 契约见 ui/Tabs.vue）
const activeTab = ref('list')
const tabItems = [
  { key: 'list', label: '拍卖列表' },
  { key: 'create', label: '创建拍卖' },
  { key: 'mine', label: '我的拍卖' },
  { key: 'bids', label: '我的竞价' }
]
const loading = ref(false)
const submitting = ref(false)

// 拍卖配置（从后端拉取，避免硬编码）
const config = ref(null)

// 当前本地时间 tick，用于驱动剩余时间倒计时
const now = ref(Date.now())
let tickTimer = null

/* ===================== 拍卖列表 Tab 状态 ===================== */

const auctions = ref([])
const listPage = ref(1)
const listTotal = ref(0)
const listPageSize = ref(20)
const listFilter = ref({
  status: 'open',
  quality: '',
  keyword: '',
  sort: 'end_at_asc'
})

/* ===================== 创建拍卖 Tab 状态 ===================== */

const inventoryItems = ref([])
const createForm = ref({
  item_key: '',
  quantity: 1,
  starting_price: 200,
  duration_hours: 6
})
const createConfirmModal = ref({ show: false })

/* ===================== 我的拍卖 Tab 状态 ===================== */

const myAuctions = ref([])
const cancelConfirmModal = ref({ show: false, auction: null, reason: '' })

/* ===================== 我的竞价 Tab 状态 ===================== */

const myBids = ref([])

/* ===================== 详情/出价 Modal 状态 ===================== */

const detailModal = ref({ show: false, loading: false, data: null })
const bidForm = ref({ price: 0 })
const bidConfirmModal = ref({ show: false, auction: null, price: 0 })

/* ===================== 计算属性 ===================== */

/**
 * 当前选中的物品对象（创建拍卖 Tab 用）
 */
const selectedInventoryItem = computed(() => {
  return inventoryItems.value.find(i => i.item_key === createForm.value.item_key) || null
})

/**
 * 创建拍卖数量上限：取物品持有数量与 99 的较小值
 */
const maxCreateQuantity = computed(() => {
  return Math.min(selectedInventoryItem.value?.quantity || 0, 99)
})

/**
 * 起拍价范围（从配置读取，避免硬编码）
 */
const startingPriceRange = computed(() => {
  return config.value?.starting_price || { min: 100, max: 1000000000 }
})

/**
 * 时长范围（从配置读取）
 */
const durationRange = computed(() => {
  return config.value?.duration_hours || { min: 1, max: 72, default: 6 }
})

/**
 * 列表筛选条件组合
 */
const listQueryParams = computed(() => {
  const params = {
    page: listPage.value,
    page_size: listPageSize.value,
    sort: listFilter.value.sort
  }
  if (listFilter.value.status) params.status = listFilter.value.status
  if (listFilter.value.quality) params.quality = listFilter.value.quality
  if (listFilter.value.keyword) params.keyword = listFilter.value.keyword
  return params
})

/**
 * 列表总页数
 */
const listTotalPages = computed(() => {
  return Math.ceil(listTotal.value / listPageSize.value) || 1
})

/**
 * 规则提示条能否展示
 * GET /auction/config 在配置未加载就绪时回吐的是空对象（服务端 getAuctionConfig 的 `|| {}`），
 * 此时直接读 fee_rate / anti_snipe 会在渲染里印出 NaN% 甚至抛 TypeError 拖垮整个面板，
 * 所以缺任何一段就整条不显示，而不是印半截规则
 */
const rulesReady = computed(() => {
  const c = config.value
  return !!(c && typeof c.fee_rate === 'number' && c.anti_snipe && c.duration_hours && c.starting_price)
})

/**
 * 我自己的玩家 ID（未登录 / 玩家信息尚未拉到时为 null）
 * 拍卖服务端只在详情的 bids 里带上 bidder_id，前端靠它认出哪些竞价是我出的
 */
const myPlayerId = computed(() => {
  const id = Number(playerStore.player?.id)
  return Number.isFinite(id) && id > 0 ? id : null
})

/**
 * 我在「当前打开的这拍」里的最近一次出价，取不到时为 null
 *
 * 服务端没有 my_bid_price / my_bid_at 这类字段，能依据的只有详情接口的 bids
 * （最近 20 条、按时间倒序）与 bidder_id。取不到（我没出价，或出价记录已掉出
 * 最近 20 条）就整行不显示，绝不印 0 或 undefined 冒充一个出价金额。
 */
const myDetailBid = computed(() => {
  const bids = detailModal.value.data?.bids
  if (myPlayerId.value === null || !Array.isArray(bids)) return null
  return bids.find(b => Number(b.bidder_id) === myPlayerId.value) || null
})

/* ===================== 工具函数 ===================== */

/**
 * 品质颜色与中文标签映射（与 InventoryPanel 保持一致）
 * 说明：品阶是玩法信息，色相跨度（绿/蓝/紫/金/玫红）刻意保留，只把中性灰换成 fg 令牌
 */
const qualityStyleMap = {
  common: { color: 'text-fg-secondary', label: '普通' },
  uncommon: { color: 'text-emerald-400', label: '非凡' },
  rare: { color: 'text-sky-400', label: '稀有' },
  epic: { color: 'text-purple-400', label: '史诗' },
  legendary: { color: 'text-gold-400', label: '传说' },
  mythic: { color: 'text-rose-400', label: '神话' },
  unknown: { color: 'text-fg-faint', label: '未知' }
}

/**
 * 获取品质样式
 * @param {string} quality - 品质 key
 */
const getQualityStyle = (quality) => {
  return qualityStyleMap[quality] || qualityStyleMap.unknown
}

/**
 * 拍卖状态标签：文案 + 色（tone 契约见 ui/Badge.vue）
 * @param {string} status - 拍卖状态
 */
const auctionStatusLabel = (status) => (
  { open: '进行中', closed: '已结束', cancelled: '已撤销' }[status] || status
)
const auctionStatusTone = (status) => (
  { open: 'success', cancelled: 'danger' }[status] || 'muted'
)

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
 * 格式化剩余时间（基于毫秒）
 * @param {number} ms - 毫秒数
 */
const formatRemaining = (ms) => {
  if (ms <= 0) return '已结束'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${sec % 60}秒`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}时${min % 60}分`
  const day = Math.floor(hr / 24)
  return `${day}天${hr % 24}时`
}

/**
 * 计算拍卖剩余时间（毫秒）
 * @param {Object} auction - 拍卖对象
 */
const getRemainingMs = (auction) => {
  if (!auction || !auction.end_at) return 0
  const endAt = new Date(auction.end_at).getTime()
  if (isNaN(endAt)) return 0
  return endAt - now.value
}

/**
 * 灵石金额展示
 * 大数走 formatCompact（万/亿、4 位有效数字），精确值由调用点挂在 title 上供 hover 查看；
 * 不可解析的值原样返回，避免把后端下发的异常字符串吞成 0。
 * @param {string|number} amount - 金额
 */
const formatStones = (amount) => {
  if (amount === null || amount === undefined) return '-'
  const num = typeof amount === 'string' ? Number(amount) : amount
  if (!Number.isFinite(num)) return amount
  return formatCompact(amount)
}

/**
 * 判断这一手是否触发了防秒杀延长，返回延长后的结束时间
 *
 * 依据是出价接口真实回传的 auction.end_at（服务端 placeBid 在延长后会写回并返回）：
 * 比出价前更晚就是延长了。任一侧时间取不到/不可解析时返回 null —— 那是「无从判断」，
 * 不能当成「没有延长」，也不能凭空宣告玩家拍卖被延长过。
 * @param {string} beforeEndAt - 出价前详情里的结束时间
 * @param {Object} bidResult - placeBid 返回的 data 载荷
 */
const getExtendedEndAt = (beforeEndAt, bidResult) => {
  const afterEndAt = bidResult?.auction?.end_at
  if (!afterEndAt || !beforeEndAt) return null
  const beforeMs = new Date(beforeEndAt).getTime()
  const afterMs = new Date(afterEndAt).getTime()
  if (isNaN(beforeMs) || isNaN(afterMs)) return null
  return afterMs > beforeMs ? afterEndAt : null
}

/* ===================== 数据加载 ===================== */

/**
 * 加载拍卖配置
 */
const loadConfig = async () => {
  try {
    const res = await getConfig()
    config.value = res.data.data || null
  } catch (error) {
    console.error('[AuctionPanel] 获取配置失败:', error)
    uiStore.showApiError(error, '[AuctionPanel] 获取配置失败')
  }
}

/**
 * 加载拍卖列表
 */
const loadList = async () => {
  loading.value = true
  try {
    const res = await getList(listQueryParams.value)
    auctions.value = res.data.data?.auctions || []
    listTotal.value = res.data.data?.total || 0
  } catch (error) {
    console.error('[AuctionPanel] 获取拍卖列表失败:', error)
    uiStore.showApiError(error, '[AuctionPanel] 获取拍卖列表失败')
  } finally {
    loading.value = false
  }
}

/**
 * 加载储物袋（创建拍卖 Tab 用）
 */
const loadInventory = async () => {
  try {
    const res = await getInventory()
    // 仅展示数量 > 0 的物品，排除装备/配方（这些不宜拍卖）
    inventoryItems.value = (res.data.data?.items || []).filter(i => i.quantity > 0 && i.usable !== false)
  } catch (error) {
    console.error('[AuctionPanel] 获取储物袋失败:', error)
    uiStore.showApiError(error, '[AuctionPanel] 获取储物袋失败')
  }
}

/**
 * 加载我的拍卖
 */
const loadMyAuctions = async () => {
  loading.value = true
  try {
    const res = await getMyAuctions()
    myAuctions.value = res.data.data?.auctions || []
  } catch (error) {
    console.error('[AuctionPanel] 获取我的拍卖失败:', error)
    uiStore.showApiError(error, '[AuctionPanel] 获取我的拍卖失败')
  } finally {
    loading.value = false
  }
}

/**
 * 加载我的竞价
 */
const loadMyBids = async () => {
  loading.value = true
  try {
    const res = await getMyBids()
    myBids.value = res.data.data?.bids || []
  } catch (error) {
    console.error('[AuctionPanel] 获取我的竞价失败:', error)
    uiStore.showApiError(error, '[AuctionPanel] 获取我的竞价失败')
  } finally {
    loading.value = false
  }
}

/* ===================== 业务操作 ===================== */

/**
 * 切换 Tab
 * @param {string} tab - 目标 Tab
 */
const switchTab = async (tab) => {
  activeTab.value = tab
  if (tab === 'list') {
    await loadList()
  } else if (tab === 'create') {
    await loadInventory()
  } else if (tab === 'mine') {
    await loadMyAuctions()
  } else if (tab === 'bids') {
    await loadMyBids()
  }
}

/**
 * 打开拍卖详情 Modal
 * @param {number} auctionId - 拍卖 ID
 */
const openDetail = async (auctionId) => {
  detailModal.value = { show: true, loading: true, data: null }
  try {
    const res = await getDetail(auctionId)
    detailModal.value.data = res.data.data || null
    // 出价默认填入最小下一手价
    bidForm.value.price = res.data.data?.min_next_bid || 0
  } catch (error) {
    console.error('[AuctionPanel] 获取详情失败:', error)
    uiStore.showApiError(error, '获取详情失败')
    detailModal.value.show = false
  } finally {
    detailModal.value.loading = false
  }
}

/**
 * 关闭详情 Modal
 */
const closeDetail = () => {
  detailModal.value = { show: false, loading: false, data: null }
}

/**
 * 打开出价确认 Modal
 */
const openBidConfirm = () => {
  const data = detailModal.value.data
  if (!data) return
  const price = parseInt(bidForm.value.price, 10)
  if (!price || price < data.min_next_bid) {
    uiStore.showToast(`出价至少需要 ${data.min_next_bid} 灵石`, 'error')
    return
  }
  bidConfirmModal.value = { show: true, auction: data, price }
}

/**
 * 确认出价
 */
const confirmBid = async () => {
  const { auction, price } = bidConfirmModal.value
  if (!auction) return
  submitting.value = true
  try {
    const res = await placeBid(auction.id, price)
    const message = res.data.message || '出价成功'
    // 防秒杀是否延长，只认服务端真实回传的 auction.end_at：比出价前更晚才算延长；
    // 拿不到就只报接口原文案，没有服务端数据支撑的"已延长"不说出口
    const extendedTo = getExtendedEndAt(auction.end_at, res.data.data)
    uiStore.showToast(
      extendedTo ? `${message}，触发防秒杀：结束时间延长至 ${formatDateTime(extendedTo)}` : message,
      'success'
    )
    bidConfirmModal.value.show = false
    // 刷新详情
    await openDetail(auction.id)
    // 刷新列表
    if (activeTab.value === 'list') await loadList()
    if (activeTab.value === 'bids') await loadMyBids()
    // 刷新玩家灵石
    await playerStore.fetchPlayer()
  } catch (error) {
    console.error('[AuctionPanel] 出价失败:', error)
    uiStore.showApiError(error, '出价失败')
  } finally {
    submitting.value = false
  }
}

/**
 * 打开创建拍卖确认 Modal
 */
const openCreateConfirm = () => {
  if (!createForm.value.item_key) {
    uiStore.showToast('请选择拍卖物品', 'error')
    return
  }
  const qty = parseInt(createForm.value.quantity, 10)
  if (!qty || qty < 1 || qty > maxCreateQuantity.value) {
    uiStore.showToast(`数量需在 1 ~ ${maxCreateQuantity.value} 之间`, 'error')
    return
  }
  const price = parseInt(createForm.value.starting_price, 10)
  if (!price || price < startingPriceRange.value.min) {
    uiStore.showToast(`起拍价不能低于 ${startingPriceRange.value.min} 灵石`, 'error')
    return
  }
  const duration = parseFloat(createForm.value.duration_hours)
  if (!duration || duration < durationRange.value.min || duration > durationRange.value.max) {
    uiStore.showToast(`时长需在 ${durationRange.value.min} ~ ${durationRange.value.max} 小时之间`, 'error')
    return
  }
  createConfirmModal.value.show = true
}

/**
 * 确认创建拍卖
 */
const confirmCreate = async () => {
  submitting.value = true
  try {
    const res = await createAuction({
      item_key: createForm.value.item_key,
      quantity: parseInt(createForm.value.quantity, 10),
      starting_price: parseInt(createForm.value.starting_price, 10),
      duration_hours: parseFloat(createForm.value.duration_hours)
    })
    uiStore.showToast(res.data.message || '拍卖已发布', 'success')
    createConfirmModal.value.show = false
    // 重置表单
    createForm.value = { item_key: '', quantity: 1, starting_price: 200, duration_hours: 6 }
    // 切换到我的拍卖 Tab 查看刚创建的
    await switchTab('mine')
    // 刷新储物袋
    await playerStore.fetchPlayer()
  } catch (error) {
    console.error('[AuctionPanel] 创建拍卖失败:', error)
    uiStore.showApiError(error, '创建拍卖失败')
  } finally {
    submitting.value = false
  }
}

/**
 * 打开撤销拍卖确认 Modal
 * @param {Object} auction - 拍卖对象
 */
const openCancelConfirm = (auction) => {
  cancelConfirmModal.value = { show: true, auction, reason: '' }
}

/**
 * 确认撤销拍卖
 */
const confirmCancel = async () => {
  const { auction } = cancelConfirmModal.value
  if (!auction) return
  submitting.value = true
  try {
    const res = await cancelAuction(auction.id, cancelConfirmModal.value.reason)
    uiStore.showToast(res.data.message || '拍卖已撤销', 'success')
    cancelConfirmModal.value.show = false
    await loadMyAuctions()
    await playerStore.fetchPlayer()
  } catch (error) {
    console.error('[AuctionPanel] 撤销拍卖失败:', error)
    uiStore.showApiError(error, '撤销拍卖失败')
  } finally {
    submitting.value = false
  }
}

/**
 * 翻页
 * @param {number} delta - 页码增量（+1/-1）
 */
const changePage = async (delta) => {
  const newPage = listPage.value + delta
  if (newPage < 1 || newPage > listTotalPages.value) return
  listPage.value = newPage
  await loadList()
}

/**
 * 应用筛选
 */
const applyFilter = async () => {
  listPage.value = 1
  await loadList()
}

/* ===================== 生命周期 ===================== */

onMounted(async () => {
  // 启动倒计时 tick
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)

  await loadConfig()
  await loadList()
})

onUnmounted(() => {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
})
</script>

<template>
  <!-- 拍卖竞价面板：玫红作为面板强调色，正文色统一走令牌 -->
  <PanelShell
    title="拍卖竞价阁"
    hint="全服竞价 · 防秒杀"
    size="xl"
    scoped-scroll
    @close="emit('close')"
  >
    <div class="h-full flex flex-col min-h-0">
      <!-- ===== 规则提示条（配置缺段时整条不显示，见 rulesReady） ===== -->
      <div v-if="rulesReady" class="shrink-0 px-4 py-2 bg-surface-canvas border-b border-line-subtle text-xs text-fg-muted flex flex-wrap gap-x-4 gap-y-1">
        <span>手续费率: <span class="num text-rose-300">{{ (config.fee_rate * 100).toFixed(1) }}%</span></span>
        <span>防秒杀: 剩余 <span class="num">{{ config.anti_snipe.trigger_threshold_seconds }}s</span> 内出价延长 <span class="num">{{ config.anti_snipe.extension_seconds }}s</span>（最多 <span class="num">{{ config.anti_snipe.max_extensions }}</span> 次）</span>
        <span>时长: <span class="num">{{ config.duration_hours.min }} ~ {{ config.duration_hours.max }}</span> 小时</span>
        <span>起拍价: <span class="num text-rose-300">{{ formatStones(config.starting_price.min) }} ~ {{ formatStones(config.starting_price.max) }}</span> 灵石</span>
      </div>

      <!-- ===== Tab 切换：切换时仍由 switchTab 拉取对应数据 ===== -->
      <Tabs :model-value="activeTab" :items="tabItems" class="shrink-0" @update:model-value="switchTab" />

      <!-- ===== 内容区 ===== -->
      <div class="flex-1 min-h-0 overflow-y-auto p-4">

        <!-- ===== 拍卖列表 Tab ===== -->
        <div v-if="activeTab === 'list'">
          <!-- 筛选条 -->
          <div class="flex flex-wrap items-center gap-2 mb-3 text-xs">
            <select v-model="listFilter.status" class="bg-surface-canvas border border-line rounded-control px-2 py-1 text-fg-primary focus:outline-none focus:border-rose-700" @change="applyFilter">
              <option value="open">进行中</option>
              <option value="closed">已结束</option>
              <option value="cancelled">已撤销</option>
            </select>
            <select v-model="listFilter.quality" class="bg-surface-canvas border border-line rounded-control px-2 py-1 text-fg-primary focus:outline-none focus:border-rose-700" @change="applyFilter">
              <option value="">全部品质</option>
              <option value="common">普通</option>
              <option value="uncommon">非凡</option>
              <option value="rare">稀有</option>
              <option value="epic">史诗</option>
              <option value="legendary">传说</option>
              <option value="mythic">神话</option>
            </select>
            <input v-model="listFilter.keyword" placeholder="搜索物品名" class="bg-surface-canvas border border-line rounded-control px-2 py-1 text-fg-primary w-32 placeholder-fg-faint focus:outline-none focus:border-rose-700" @keyup.enter="applyFilter" />
            <AppButton size="sm" variant="outline" @click="applyFilter">筛选</AppButton>
            <AppButton class="ms-auto" size="sm" variant="default" @click="loadList">刷新</AppButton>
          </div>

          <!-- 列表 -->
          <LoadingBlock v-if="loading" />
          <EmptyState
            v-else-if="auctions.length === 0"
            text="暂无拍卖"
            hint="切到「创建拍卖」页签，把闲置物品挂上竞价台"
          />
          <div v-else class="space-y-2">
            <div
              v-for="auction in auctions"
              :key="auction.id"
              class="bg-surface-raised border border-line-subtle rounded-panel p-3 hover:border-rose-900 cursor-pointer transition-colors"
              @click="openDetail(auction.id)"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <span :class="getQualityStyle(auction.item_quality).color" class="font-medium">{{ auction.item_name }}</span>
                  <span class="text-xs text-fg-faint">x{{ auction.quantity }}</span>
                  <Badge v-if="auction.ending_soon" tone="danger">即将结束</Badge>
                  <Badge v-if="auction.extension_count > 0" tone="gold">延期{{ auction.extension_count }}次</Badge>
                </div>
                <div class="flex items-center gap-3 text-xs">
                  <div class="text-right">
                    <div class="text-rose-300 font-bold num" :title="auction.current_price">{{ formatStones(auction.current_price) }}</div>
                    <div class="text-fg-faint">灵石</div>
                  </div>
                  <div class="text-right w-20">
                    <div class="num" :class="getRemainingMs(auction) <= 0 ? 'text-fg-faint' : 'text-fg-secondary'">{{ formatRemaining(getRemainingMs(auction)) }}</div>
                    <div class="text-fg-faint truncate">{{ auction.seller_nickname || '未知' }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 分页 -->
            <div v-if="listTotalPages > 1" class="flex items-center justify-center gap-3 pt-3 text-sm">
              <AppButton size="sm" variant="default" :disabled="listPage <= 1" @click="changePage(-1)">上一页</AppButton>
              <span class="text-fg-muted num">{{ listPage }} / {{ listTotalPages }}</span>
              <AppButton size="sm" variant="default" :disabled="listPage >= listTotalPages" @click="changePage(1)">下一页</AppButton>
            </div>
          </div>
        </div>

        <!-- ===== 创建拍卖 Tab ===== -->
        <div v-if="activeTab === 'create'">
          <div class="space-y-4 max-w-xl mx-auto">
            <!-- 物品选择 -->
            <div>
              <label class="block text-sm text-fg-muted mb-1">选择物品</label>
              <select v-model="createForm.item_key" class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-fg-primary focus:outline-none focus:border-rose-700">
                <option value="">请选择物品</option>
                <option v-for="item in inventoryItems" :key="item.item_key" :value="item.item_key">
                  {{ item.name }} x{{ item.quantity }} ({{ getQualityStyle(item.quality).label }})
                </option>
              </select>
            </div>

            <!-- 数量 -->
            <div>
              <label class="block text-sm text-fg-muted mb-1">数量 (最大 {{ maxCreateQuantity }})</label>
              <input v-model.number="createForm.quantity" type="number" :min="1" :max="maxCreateQuantity" class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-fg-primary num focus:outline-none focus:border-rose-700" />
            </div>

            <!-- 起拍价 -->
            <div>
              <label class="block text-sm text-fg-muted mb-1">起拍价 (灵石，范围 {{ formatStones(startingPriceRange.min) }} ~ {{ formatStones(startingPriceRange.max) }})</label>
              <input v-model.number="createForm.starting_price" type="number" :min="startingPriceRange.min" :max="startingPriceRange.max" class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-fg-primary num focus:outline-none focus:border-rose-700" />
            </div>

            <!-- 时长 -->
            <div>
              <label class="block text-sm text-fg-muted mb-1">拍卖时长 (小时，范围 {{ durationRange.min }} ~ {{ durationRange.max }})</label>
              <input v-model.number="createForm.duration_hours" type="number" :min="durationRange.min" :max="durationRange.max" step="0.5" class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-fg-primary num focus:outline-none focus:border-rose-700" />
            </div>

            <!-- 预览 -->
            <PanelCard v-if="selectedInventoryItem" title="拍卖预览" padded>
              <div class="text-sm text-fg-secondary">
                <div>{{ selectedInventoryItem.name }} x{{ createForm.quantity }}，起拍价 <span class="num text-rose-300">{{ formatStones(createForm.starting_price) }}</span> 灵石</div>
                <div class="text-xs text-fg-faint mt-1">成交后扣除 {{ (config?.fee_rate || 0.05) * 100 }}% 手续费</div>
              </div>
            </PanelCard>

            <!-- 提交按钮 -->
            <AppButton
              variant="primary"
              block
              :disabled="submitting || !createForm.item_key"
              @click="openCreateConfirm"
            >{{ submitting ? '处理中…' : '发布拍卖' }}</AppButton>
          </div>
        </div>

        <!-- ===== 我的拍卖 Tab ===== -->
        <div v-if="activeTab === 'mine'">
          <div class="flex justify-end mb-2">
            <AppButton size="sm" variant="default" @click="loadMyAuctions">刷新</AppButton>
          </div>
          <LoadingBlock v-if="loading" />
          <EmptyState v-else-if="myAuctions.length === 0" text="你还没有发布过拍卖" hint="切到「创建拍卖」页签挂出第一件" />
          <div v-else class="space-y-2">
            <div
              v-for="auction in myAuctions"
              :key="auction.id"
              class="bg-surface-raised border border-line-subtle rounded-panel p-3"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer" @click="openDetail(auction.id)">
                  <span :class="getQualityStyle(auction.item_quality).color" class="font-medium">{{ auction.item_name }}</span>
                  <span class="text-xs text-fg-faint">x{{ auction.quantity }}</span>
                  <Badge :tone="auctionStatusTone(auction.status)">{{ auctionStatusLabel(auction.status) }}</Badge>
                </div>
                <AppButton
                  v-if="auction.status === 'open'"
                  size="xs"
                  variant="danger"
                  @click="openCancelConfirm(auction)"
                >撤销</AppButton>
              </div>
              <div class="flex items-center justify-between mt-2 text-xs text-fg-muted">
                <span>当前价: <span class="text-rose-300 num" :title="auction.current_price">{{ formatStones(auction.current_price) }}</span> 灵石</span>
                <span v-if="auction.status === 'open'" class="num">剩余: {{ formatRemaining(getRemainingMs(auction)) }}</span>
                <span v-else-if="auction.status === 'closed' && auction.final_price" class="num">成交价: {{ formatStones(auction.final_price) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== 我的竞价 Tab ===== -->
        <div v-if="activeTab === 'bids'">
          <div class="flex justify-end mb-2">
            <AppButton size="sm" variant="default" @click="loadMyBids">刷新</AppButton>
          </div>
          <div class="text-xs text-fg-faint mb-2">服务端「我的竞价」只下发当前价与领先 / 得标 / 落标状态，你出过的金额请在详情的竞价历史里查看。</div>
          <LoadingBlock v-if="loading" />
          <EmptyState v-else-if="myBids.length === 0" text="你还没有参与过竞价" hint="在「拍卖列表」点一行即可出价" />
          <div v-else class="space-y-2">
            <div
              v-for="bid in myBids"
              :key="bid.id"
              class="bg-surface-raised border border-line-subtle rounded-panel p-3 cursor-pointer hover:border-rose-900"
              @click="openDetail(bid.id)"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <span :class="getQualityStyle(bid.item_quality).color" class="font-medium">{{ bid.item_name }}</span>
                  <span class="text-xs text-fg-faint">x{{ bid.quantity }}</span>
                  <!-- 状态标记：leading / won / lost 由 GET /auction/my-bids 逐条算好下发 -->
                  <Badge v-if="bid.leading" tone="success" solid>领先</Badge>
                  <Badge v-else-if="bid.won" tone="gold" solid>得标</Badge>
                  <Badge v-else-if="bid.lost" tone="muted">落标</Badge>
                  <!-- 已撤销的拍卖三个标记全为 false，补一个状态徽标，避免这一行没有标记 -->
                  <Badge v-else :tone="auctionStatusTone(bid.status)">{{ auctionStatusLabel(bid.status) }}</Badge>
                </div>
              </div>
              <div class="flex items-center justify-between mt-2 text-xs text-fg-muted">
                <span>当前价: <span class="text-rose-300 num" :title="bid.current_price">{{ formatStones(bid.current_price) }}</span> 灵石</span>
                <span v-if="bid.final_price" class="num">成交价: <span class="text-rose-300 num" :title="bid.final_price">{{ formatStones(bid.final_price) }}</span></span>
                <span v-else-if="bid.status === 'open'" class="num">剩余: {{ formatRemaining(getRemainingMs(bid)) }}</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ===== 拍卖详情 Modal ===== -->
    <Modal :is-open="detailModal.show" @close="closeDetail" width="600px">
      <div class="p-4">
        <LoadingBlock v-if="detailModal.loading" />
        <template v-else-if="detailModal.data">
          <h3 class="text-lg font-bold text-rose-200 mb-3">{{ detailModal.data.item_name }} <span class="text-sm text-fg-muted">x{{ detailModal.data.quantity }}</span></h3>

          <!-- 物品信息 -->
          <div class="bg-surface-raised rounded-control p-3 mb-3 text-sm space-y-1">
            <div class="flex justify-between"><span class="text-fg-muted">品质</span><span :class="getQualityStyle(detailModal.data.item_quality).color">{{ getQualityStyle(detailModal.data.item_quality).label }}</span></div>
            <div class="flex justify-between"><span class="text-fg-muted">卖家</span><span class="text-fg-primary">{{ detailModal.data.seller?.nickname || '未知' }} ({{ detailModal.data.seller?.realm || '-' }})</span></div>
            <div class="flex justify-between"><span class="text-fg-muted">起拍价</span><span class="text-fg-primary num" :title="detailModal.data.starting_price">{{ formatStones(detailModal.data.starting_price) }} 灵石</span></div>
            <div class="flex justify-between"><span class="text-fg-muted">当前价</span><span class="text-rose-300 font-bold num" :title="detailModal.data.current_price">{{ formatStones(detailModal.data.current_price) }} 灵石</span></div>
            <div class="flex justify-between"><span class="text-fg-muted">手续费率</span><span class="text-fg-primary num">{{ (detailModal.data.fee_rate * 100).toFixed(1) }}%</span></div>
            <div class="flex justify-between">
              <span class="text-fg-muted">结束时间</span>
              <span class="num" :class="getRemainingMs(detailModal.data) <= 0 ? 'text-fg-faint' : 'text-fg-primary'">
                {{ formatDateTime(detailModal.data.end_at) }} ({{ formatRemaining(getRemainingMs(detailModal.data)) }})
              </span>
            </div>
            <div v-if="detailModal.data.extension_count > 0" class="flex justify-between">
              <span class="text-fg-muted">防秒杀延长</span><span class="text-gold-300 num">{{ detailModal.data.extension_count }} 次</span>
            </div>
            <div class="flex justify-between"><span class="text-fg-muted">竞价数</span><span class="text-fg-primary num">{{ detailModal.data.bid_count }}</span></div>
            <div v-if="detailModal.data.status === 'open' && detailModal.data.is_current_bidder" class="flex justify-between">
              <span class="text-fg-muted">竞价状态</span><span class="text-emerald-400">你是当前最高竞价者</span>
            </div>
            <!-- 我的出价：服务端没有 my_bid_price / my_bid_at，只从详情 bids 里按 bidder_id 认；认不出整行不显示 -->
            <div v-if="myDetailBid" class="flex justify-between">
              <span class="text-fg-muted">我的出价</span>
              <span class="text-rose-300 num" :title="myDetailBid.bid_price">
                {{ formatStones(myDetailBid.bid_price) }} 灵石
                <span class="text-fg-faint">{{ formatDateTime(myDetailBid.created_at) }}</span>
              </span>
            </div>
          </div>

          <!-- 竞价历史 -->
          <div v-if="detailModal.data.bids && detailModal.data.bids.length > 0" class="mb-3">
            <div class="text-sm text-fg-muted mb-1">竞价历史（最近 {{ detailModal.data.bids.length }} 条）</div>
            <div class="bg-surface-sunken rounded-control p-2 max-h-32 overflow-y-auto text-xs space-y-1">
              <div v-for="bid in detailModal.data.bids" :key="bid.id" class="flex justify-between">
                <span class="text-fg-secondary">{{ bid.bidder_nickname || '未知修士' }}<span v-if="myPlayerId !== null && Number(bid.bidder_id) === myPlayerId" class="text-rose-300">（我）</span></span>
                <span class="text-rose-300 num" :title="bid.bid_price">{{ formatStones(bid.bid_price) }} 灵石</span>
                <span class="text-fg-faint num">{{ formatDateTime(bid.created_at) }}</span>
              </div>
            </div>
          </div>

          <!-- 出价区（仅进行中且非卖家） -->
          <div v-if="detailModal.data.status === 'open' && !detailModal.data.is_seller" class="bg-surface-tint-gold border border-line-subtle rounded-control p-3">
            <div class="text-sm text-rose-300 mb-2">出价（最低 <span class="num" :title="detailModal.data.min_next_bid">{{ formatStones(detailModal.data.min_next_bid) }}</span> 灵石）</div>
            <div class="flex gap-2">
              <input v-model.number="bidForm.price" type="number" :min="detailModal.data.min_next_bid" class="flex-1 bg-surface-canvas border border-line rounded-control px-3 py-2 text-fg-primary num focus:outline-none focus:border-rose-700" />
              <AppButton variant="primary" @click="openBidConfirm">出价</AppButton>
            </div>
          </div>

          <!-- 卖家提示 -->
          <div v-if="detailModal.data.is_seller && detailModal.data.status === 'open'" class="bg-surface-tint-gold border border-gold-800 rounded-control p-2 text-xs text-gold-300">
            这是你的拍卖，不能竞拍自己的物品。可在"我的拍卖"中撤销。
          </div>

          <AppButton variant="default" block class="mt-3" @click="closeDetail">关闭</AppButton>
        </template>
      </div>
    </Modal>

    <!-- ===== 出价确认 Modal ===== -->
    <Modal :is-open="bidConfirmModal.show" @close="bidConfirmModal.show = false" width="400px">
      <div class="p-4">
        <h3 class="text-lg font-bold text-rose-200 mb-3">确认出价</h3>
        <div class="text-sm text-fg-secondary space-y-1 mb-4">
          <div>物品: <span class="text-fg-primary">{{ bidConfirmModal.auction?.item_name }}</span></div>
          <div>出价: <span class="text-rose-300 font-bold num" :title="bidConfirmModal.price">{{ formatStones(bidConfirmModal.price) }}</span> 灵石</div>
          <div class="text-xs text-fg-faint mt-2">出价后灵石将被冻结，被他人超越时退还。防秒杀机制可能延长结束时间。</div>
        </div>
        <div class="flex gap-2">
          <AppButton class="flex-1" variant="default" @click="bidConfirmModal.show = false">取消</AppButton>
          <AppButton class="flex-1" variant="primary" :disabled="submitting" @click="confirmBid">{{ submitting ? '处理中…' : '确认出价' }}</AppButton>
        </div>
      </div>
    </Modal>

    <!-- ===== 创建拍卖确认 Modal ===== -->
    <Modal :is-open="createConfirmModal.show" @close="createConfirmModal.show = false" width="400px">
      <div class="p-4">
        <h3 class="text-lg font-bold text-rose-200 mb-3">确认发布拍卖</h3>
        <div class="text-sm text-fg-secondary space-y-1 mb-4">
          <div>物品: <span class="text-fg-primary">{{ selectedInventoryItem?.name }} x{{ createForm.quantity }}</span></div>
          <div>起拍价: <span class="text-rose-300 font-bold num" :title="createForm.starting_price">{{ formatStones(createForm.starting_price) }}</span> 灵石</div>
          <div>时长: <span class="text-fg-primary num">{{ createForm.duration_hours }} 小时</span></div>
          <div>手续费率: <span class="text-fg-primary num">{{ (config?.fee_rate || 0.05) * 100 }}%</span></div>
          <div class="text-xs text-fg-faint mt-2">物品将立即从储物袋扣除。无人竞价时到期退回；有人竞价时到期成交，灵石扣除手续费后入账。</div>
        </div>
        <div class="flex gap-2">
          <AppButton class="flex-1" variant="default" @click="createConfirmModal.show = false">取消</AppButton>
          <AppButton class="flex-1" variant="primary" :disabled="submitting" @click="confirmCreate">{{ submitting ? '处理中…' : '确认发布' }}</AppButton>
        </div>
      </div>
    </Modal>

    <!-- ===== 撤销拍卖确认 Modal ===== -->
    <Modal :is-open="cancelConfirmModal.show" @close="cancelConfirmModal.show = false" width="400px">
      <div class="p-4">
        <h3 class="text-lg font-bold text-rose-200 mb-3">确认撤销拍卖</h3>
        <div class="text-sm text-fg-secondary space-y-1 mb-3">
          <div>物品: <span class="text-fg-primary">{{ cancelConfirmModal.auction?.item_name }}</span></div>
          <div>当前价: <span class="text-rose-300 num" :title="cancelConfirmModal.auction?.current_price">{{ formatStones(cancelConfirmModal.auction?.current_price) }}</span> 灵石</div>
          <div class="text-xs text-gold-400 mt-2">若已有人竞价，撤销需支付补偿费（按当前价 {{ (config?.seller?.cancel_fee_when_bidded || 0.02) * 100 }}% 计算）</div>
        </div>
        <div class="mb-3">
          <label class="block text-sm text-fg-muted mb-1">撤销原因（可选）</label>
          <input v-model="cancelConfirmModal.reason" class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-fg-primary text-sm placeholder-fg-faint focus:outline-none focus:border-rose-700" placeholder="便于审计" />
        </div>
        <div class="flex gap-2">
          <AppButton class="flex-1" variant="default" @click="cancelConfirmModal.show = false">取消</AppButton>
          <AppButton class="flex-1" variant="danger" :disabled="submitting" @click="confirmCancel">{{ submitting ? '处理中…' : '确认撤销' }}</AppButton>
        </div>
      </div>
    </Modal>
  </PanelShell>
</template>
