<script setup>
/**
 * 拍卖竞价面板组件（玩家侧）
 *
 * 功能说明：
 *   - 弹窗式面板，参考 PawnshopPanel / StockPanel 的设计风格
 *   - 标题区：展示拍卖规则简述（手续费率 / 防秒杀 / 时长范围）
 *   - Tab 切换：拍卖列表 / 创建拍卖 / 我的拍卖 / 我的竞价
 *     · 拍卖列表 Tab：全服拍卖列表（物品/数量/当前价/剩余时间/卖家），点击行查看详情 + 出价
 *     · 创建拍卖 Tab：从储物袋选物品 + 起拍价 + 时长，二次确认后创建
 *     · 我的拍卖 Tab：我发布的拍卖列表 + 撤销按钮（带二次确认）
 *     · 我的竞价 Tab：我参与的竞价（领先/得标/落标状态标记）
 *   - 颜色风格：玫红色系（rose-400/rose-500）体现竞价博弈的热烈感
 *   - 详情 Modal：物品信息 + 竞价历史 + 出价输入 + 二次确认
 *
 * 设计原则：
 *   - 所有业务逻辑在后端 AuctionService 处理，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - BIGINT 金额字段统一以字符串展示，避免 JS Number 精度问题
 *   - 剩余时间基于 end_at 本地 tick 递减，每秒刷新
 *   - 防秒杀延长后 end_at 会更新，前端自动反映
 *
 * 玩法文档对照：xiuxian_game_guide.md 第27节·市场、股市与资产路线
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
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
const activeTab = ref('list')
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

/* ===================== 工具函数 ===================== */

/**
 * 品质颜色与中文标签映射（与 InventoryPanel 保持一致）
 */
const qualityStyleMap = {
  common: { color: 'text-stone-300', label: '普通', bg: 'bg-stone-700/40' },
  uncommon: { color: 'text-emerald-400', label: '非凡', bg: 'bg-emerald-900/30' },
  rare: { color: 'text-blue-400', label: '稀有', bg: 'bg-blue-900/30' },
  epic: { color: 'text-purple-400', label: '史诗', bg: 'bg-purple-900/30' },
  legendary: { color: 'text-amber-400', label: '传说', bg: 'bg-amber-900/30' },
  mythic: { color: 'text-rose-400', label: '神话', bg: 'bg-rose-900/30' },
  unknown: { color: 'text-stone-500', label: '未知', bg: 'bg-stone-800/40' }
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
 * 格式化灵石显示（加千分位）
 * @param {string|number} amount - 金额
 */
const formatStones = (amount) => {
  if (amount === null || amount === undefined) return '-'
  const num = typeof amount === 'string' ? parseInt(amount, 10) : amount
  if (isNaN(num)) return amount
  return num.toLocaleString('zh-CN')
}

/* ===================== 数据加载 ===================== */

/**
 * 加载拍卖配置
 */
const loadConfig = async () => {
  try {
    const res = await getConfig()
    config.value = res.data
  } catch (error) {
    console.error('[AuctionPanel] 获取配置失败:', error)
    uiStore.showToast('获取拍卖配置失败', 'error')
  }
}

/**
 * 加载拍卖列表
 */
const loadList = async () => {
  loading.value = true
  try {
    const res = await getList(listQueryParams.value)
    auctions.value = res.data.auctions || []
    listTotal.value = res.data.total || 0
  } catch (error) {
    console.error('[AuctionPanel] 获取拍卖列表失败:', error)
    uiStore.showToast('获取拍卖列表失败', 'error')
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
    inventoryItems.value = (res.data.items || []).filter(i => i.quantity > 0 && i.usable !== false)
  } catch (error) {
    console.error('[AuctionPanel] 获取储物袋失败:', error)
    uiStore.showToast('获取储物袋失败', 'error')
  }
}

/**
 * 加载我的拍卖
 */
const loadMyAuctions = async () => {
  loading.value = true
  try {
    const res = await getMyAuctions()
    myAuctions.value = res.data.auctions || []
  } catch (error) {
    console.error('[AuctionPanel] 获取我的拍卖失败:', error)
    uiStore.showToast('获取我的拍卖失败', 'error')
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
    myBids.value = res.data.bids || []
  } catch (error) {
    console.error('[AuctionPanel] 获取我的竞价失败:', error)
    uiStore.showToast('获取我的竞价失败', 'error')
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
    detailModal.value.data = res.data
    // 出价默认填入最小下一手价
    bidForm.value.price = res.data.min_next_bid || 0
  } catch (error) {
    console.error('[AuctionPanel] 获取详情失败:', error)
    uiStore.showToast(error.response?.data?.message || '获取详情失败', 'error')
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
    uiStore.showToast(`出价不能低于最小加价 ${data.min_next_bid} 灵石`, 'error')
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
    uiStore.showToast(res.data.message || '出价成功', 'success')
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
    uiStore.showToast(error.response?.data?.message || '出价失败', 'error')
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
    uiStore.showToast(error.response?.data?.message || '创建拍卖失败', 'error')
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
    uiStore.showToast(error.response?.data?.message || '撤销拍卖失败', 'error')
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
  <!-- 拍卖竞价面板：玫红色系主题，体现竞价博弈的热烈感 -->
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm" @click.self="emit('close')">
    <div class="w-full max-w-4xl max-h-[90vh] bg-stone-900 border border-rose-900/50 rounded-lg shadow-2xl flex flex-col">

      <!-- ===== 标题栏 ===== -->
      <div class="flex items-center justify-between p-4 border-b border-rose-900/50 bg-gradient-to-r from-rose-950/40 to-stone-900">
        <div class="flex items-center gap-3">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-rose-400">
            <circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94"/>
          </svg>
          <h2 class="text-xl font-bold text-rose-200">拍卖竞价阁</h2>
        </div>
        <button class="text-stone-400 hover:text-rose-300 transition-colors" @click="emit('close')">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- ===== 规则提示条 ===== -->
      <div v-if="config" class="px-4 py-2 bg-rose-950/20 border-b border-rose-900/30 text-xs text-rose-300/80 flex flex-wrap gap-x-4 gap-y-1">
        <span>手续费率: {{ (config.fee_rate * 100).toFixed(1) }}%</span>
        <span>防秒杀: 剩余 {{ config.anti_snipe.trigger_threshold_seconds }}s 内出价延长 {{ config.anti_snipe.extension_seconds }}s（最多 {{ config.anti_snipe.max_extensions }} 次）</span>
        <span>时长: {{ config.duration_hours.min }} ~ {{ config.duration_hours.max }} 小时</span>
        <span>起拍价: {{ formatStones(config.starting_price.min) }} ~ {{ formatStones(config.starting_price.max) }} 灵石</span>
      </div>

      <!-- ===== Tab 切换 ===== -->
      <div class="flex border-b border-stone-700">
        <button
          v-for="tab in [
            { id: 'list', name: '拍卖列表' },
            { id: 'create', name: '创建拍卖' },
            { id: 'mine', name: '我的拍卖' },
            { id: 'bids', name: '我的竞价' }
          ]"
          :key="tab.id"
          class="flex-1 py-3 text-sm font-medium transition-colors border-b-2"
          :class="activeTab === tab.id
            ? 'text-rose-300 border-rose-400 bg-rose-950/20'
            : 'text-stone-400 border-transparent hover:text-rose-300 hover:bg-rose-950/10'"
          @click="switchTab(tab.id)"
        >{{ tab.name }}</button>
      </div>

      <!-- ===== 内容区 ===== -->
      <div class="flex-1 overflow-y-auto p-4">

        <!-- ===== 拍卖列表 Tab ===== -->
        <div v-if="activeTab === 'list'">
          <!-- 筛选条 -->
          <div class="flex flex-wrap items-center gap-2 mb-3 text-xs">
            <select v-model="listFilter.status" class="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-stone-200" @change="applyFilter">
              <option value="open">进行中</option>
              <option value="closed">已结束</option>
              <option value="cancelled">已撤销</option>
            </select>
            <select v-model="listFilter.quality" class="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-stone-200" @change="applyFilter">
              <option value="">全部品质</option>
              <option value="common">普通</option>
              <option value="uncommon">非凡</option>
              <option value="rare">稀有</option>
              <option value="epic">史诗</option>
              <option value="legendary">传说</option>
              <option value="mythic">神话</option>
            </select>
            <input v-model="listFilter.keyword" placeholder="搜索物品名" class="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-stone-200 w-32" @keyup.enter="applyFilter" />
            <button class="px-3 py-1 bg-rose-700 hover:bg-rose-600 text-white rounded" @click="applyFilter">筛选</button>
            <button class="ml-auto px-3 py-1 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded" @click="loadList">刷新</button>
          </div>

          <!-- 列表 -->
          <div v-if="loading" class="text-center py-8 text-stone-400">加载中...</div>
          <div v-else-if="auctions.length === 0" class="text-center py-8 text-stone-500">暂无拍卖，快去创建第一个吧</div>
          <div v-else class="space-y-2">
            <div
              v-for="auction in auctions"
              :key="auction.id"
              class="bg-stone-800/60 border border-stone-700 rounded-lg p-3 hover:border-rose-700/50 cursor-pointer transition-colors"
              @click="openDetail(auction.id)"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <span :class="getQualityStyle(auction.item_quality).color" class="font-medium">{{ auction.item_name }}</span>
                  <span class="text-xs text-stone-500">x{{ auction.quantity }}</span>
                  <span v-if="auction.ending_soon" class="text-xs px-1.5 py-0.5 bg-rose-900/50 text-rose-300 rounded">即将结束</span>
                  <span v-if="auction.extension_count > 0" class="text-xs px-1.5 py-0.5 bg-amber-900/40 text-amber-300 rounded">延期{{ auction.extension_count }}次</span>
                </div>
                <div class="flex items-center gap-3 text-xs">
                  <div class="text-right">
                    <div class="text-rose-300 font-bold">{{ formatStones(auction.current_price) }}</div>
                    <div class="text-stone-500">灵石</div>
                  </div>
                  <div class="text-right w-20">
                    <div :class="getRemainingMs(auction) <= 0 ? 'text-stone-500' : 'text-stone-300'">{{ formatRemaining(getRemainingMs(auction)) }}</div>
                    <div class="text-stone-500">{{ auction.seller_nickname || '未知' }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 分页 -->
            <div v-if="listTotalPages > 1" class="flex items-center justify-center gap-3 pt-3 text-sm">
              <button class="px-3 py-1 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded disabled:opacity-40" :disabled="listPage <= 1" @click="changePage(-1)">上一页</button>
              <span class="text-stone-400">{{ listPage }} / {{ listTotalPages }}</span>
              <button class="px-3 py-1 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded disabled:opacity-40" :disabled="listPage >= listTotalPages" @click="changePage(1)">下一页</button>
            </div>
          </div>
        </div>

        <!-- ===== 创建拍卖 Tab ===== -->
        <div v-if="activeTab === 'create'">
          <div class="space-y-4 max-w-xl mx-auto">
            <!-- 物品选择 -->
            <div>
              <label class="block text-sm text-stone-400 mb-1">选择物品</label>
              <select v-model="createForm.item_key" class="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 text-stone-200">
                <option value="">请选择物品</option>
                <option v-for="item in inventoryItems" :key="item.item_key" :value="item.item_key">
                  {{ item.name }} x{{ item.quantity }} ({{ getQualityStyle(item.quality).label }})
                </option>
              </select>
            </div>

            <!-- 数量 -->
            <div>
              <label class="block text-sm text-stone-400 mb-1">数量 (最大 {{ maxCreateQuantity }})</label>
              <input v-model.number="createForm.quantity" type="number" :min="1" :max="maxCreateQuantity" class="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 text-stone-200" />
            </div>

            <!-- 起拍价 -->
            <div>
              <label class="block text-sm text-stone-400 mb-1">起拍价 (灵石，范围 {{ formatStones(startingPriceRange.min) }} ~ {{ formatStones(startingPriceRange.max) }})</label>
              <input v-model.number="createForm.starting_price" type="number" :min="startingPriceRange.min" :max="startingPriceRange.max" class="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 text-stone-200" />
            </div>

            <!-- 时长 -->
            <div>
              <label class="block text-sm text-stone-400 mb-1">拍卖时长 (小时，范围 {{ durationRange.min }} ~ {{ durationRange.max }})</label>
              <input v-model.number="createForm.duration_hours" type="number" :min="durationRange.min" :max="durationRange.max" step="0.5" class="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 text-stone-200" />
            </div>

            <!-- 预览 -->
            <div v-if="selectedInventoryItem" class="bg-stone-800/40 border border-stone-700 rounded p-3 text-sm text-stone-300">
              <div class="text-stone-400 mb-1">拍卖预览</div>
              <div>{{ selectedInventoryItem.name }} x{{ createForm.quantity }}，起拍价 {{ formatStones(createForm.starting_price) }} 灵石</div>
              <div class="text-xs text-stone-500 mt-1">成交后扣除 {{ (config?.fee_rate || 0.05) * 100 }}% 手续费</div>
            </div>

            <!-- 提交按钮 -->
            <button
              class="w-full py-2 bg-rose-700 hover:bg-rose-600 text-white rounded font-medium disabled:opacity-50"
              :disabled="submitting || !createForm.item_key"
              @click="openCreateConfirm"
            >{{ submitting ? '处理中...' : '发布拍卖' }}</button>
          </div>
        </div>

        <!-- ===== 我的拍卖 Tab ===== -->
        <div v-if="activeTab === 'mine'">
          <div class="flex justify-end mb-2">
            <button class="px-3 py-1 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded text-sm" @click="loadMyAuctions">刷新</button>
          </div>
          <div v-if="loading" class="text-center py-8 text-stone-400">加载中...</div>
          <div v-else-if="myAuctions.length === 0" class="text-center py-8 text-stone-500">你还没有发布过拍卖</div>
          <div v-else class="space-y-2">
            <div
              v-for="auction in myAuctions"
              :key="auction.id"
              class="bg-stone-800/60 border border-stone-700 rounded-lg p-3"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 flex-1 min-w-0" @click="openDetail(auction.id)" style="cursor:pointer">
                  <span :class="getQualityStyle(auction.item_quality).color" class="font-medium">{{ auction.item_name }}</span>
                  <span class="text-xs text-stone-500">x{{ auction.quantity }}</span>
                  <span class="text-xs px-1.5 py-0.5 rounded" :class="{
                    'bg-emerald-900/40 text-emerald-300': auction.status === 'open',
                    'bg-stone-700 text-stone-400': auction.status === 'closed',
                    'bg-rose-900/40 text-rose-300': auction.status === 'cancelled'
                  }">{{ { open: '进行中', closed: '已结束', cancelled: '已撤销' }[auction.status] }}</span>
                </div>
                <button
                  v-if="auction.status === 'open'"
                  class="px-2 py-1 bg-rose-800 hover:bg-rose-700 text-white rounded text-xs"
                  @click="openCancelConfirm(auction)"
                >撤销</button>
              </div>
              <div class="flex items-center justify-between mt-2 text-xs text-stone-400">
                <span>当前价: <span class="text-rose-300">{{ formatStones(auction.current_price) }}</span> 灵石</span>
                <span v-if="auction.status === 'open'">剩余: {{ formatRemaining(getRemainingMs(auction)) }}</span>
                <span v-else-if="auction.status === 'closed' && auction.final_price">成交价: {{ formatStones(auction.final_price) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== 我的竞价 Tab ===== -->
        <div v-if="activeTab === 'bids'">
          <div class="flex justify-end mb-2">
            <button class="px-3 py-1 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded text-sm" @click="loadMyBids">刷新</button>
          </div>
          <div v-if="loading" class="text-center py-8 text-stone-400">加载中...</div>
          <div v-else-if="myBids.length === 0" class="text-center py-8 text-stone-500">你还没有参与过竞价</div>
          <div v-else class="space-y-2">
            <div
              v-for="bid in myBids"
              :key="bid.auction.id"
              class="bg-stone-800/60 border border-stone-700 rounded-lg p-3 cursor-pointer hover:border-rose-700/50"
              @click="openDetail(bid.auction.id)"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <span :class="getQualityStyle(bid.auction.item_quality).color" class="font-medium">{{ bid.auction.item_name }}</span>
                  <span class="text-xs text-stone-500">x{{ bid.auction.quantity }}</span>
                  <!-- 状态标记 -->
                  <span v-if="bid.leading" class="text-xs px-1.5 py-0.5 bg-emerald-900/40 text-emerald-300 rounded">领先</span>
                  <span v-else-if="bid.won" class="text-xs px-1.5 py-0.5 bg-amber-900/40 text-amber-300 rounded">得标</span>
                  <span v-else-if="bid.lost" class="text-xs px-1.5 py-0.5 bg-stone-700 text-stone-400 rounded">落标</span>
                </div>
              </div>
              <div class="flex items-center justify-between mt-2 text-xs text-stone-400">
                <span>我的出价: <span class="text-rose-300">{{ formatStones(bid.my_bid_price) }}</span> 灵石</span>
                <span>当前价: <span class="text-rose-300">{{ formatStones(bid.auction.current_price) }}</span></span>
                <span v-if="bid.auction.status === 'open'">剩余: {{ formatRemaining(getRemainingMs(bid.auction)) }}</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ===== 拍卖详情 Modal ===== -->
    <Modal :show="detailModal.show" @close="closeDetail" max-width="600px">
      <div class="p-4">
        <div v-if="detailModal.loading" class="text-center py-8 text-stone-400">加载中...</div>
        <template v-else-if="detailModal.data">
          <h3 class="text-lg font-bold text-rose-200 mb-3">{{ detailModal.data.item_name }} <span class="text-sm text-stone-400">x{{ detailModal.data.quantity }}</span></h3>

          <!-- 物品信息 -->
          <div class="bg-stone-800/40 rounded p-3 mb-3 text-sm space-y-1">
            <div class="flex justify-between"><span class="text-stone-400">品质</span><span :class="getQualityStyle(detailModal.data.item_quality).color">{{ getQualityStyle(detailModal.data.item_quality).label }}</span></div>
            <div class="flex justify-between"><span class="text-stone-400">卖家</span><span class="text-stone-200">{{ detailModal.data.seller?.nickname || '未知' }} ({{ detailModal.data.seller?.realm || '-' }})</span></div>
            <div class="flex justify-between"><span class="text-stone-400">起拍价</span><span class="text-stone-200">{{ formatStones(detailModal.data.starting_price) }} 灵石</span></div>
            <div class="flex justify-between"><span class="text-stone-400">当前价</span><span class="text-rose-300 font-bold">{{ formatStones(detailModal.data.current_price) }} 灵石</span></div>
            <div class="flex justify-between"><span class="text-stone-400">手续费率</span><span class="text-stone-200">{{ (detailModal.data.fee_rate * 100).toFixed(1) }}%</span></div>
            <div class="flex justify-between">
              <span class="text-stone-400">结束时间</span>
              <span :class="getRemainingMs(detailModal.data) <= 0 ? 'text-stone-500' : 'text-stone-200'">
                {{ formatDateTime(detailModal.data.end_at) }} ({{ formatRemaining(getRemainingMs(detailModal.data)) }})
              </span>
            </div>
            <div v-if="detailModal.data.extension_count > 0" class="flex justify-between">
              <span class="text-stone-400">防秒杀延长</span><span class="text-amber-300">{{ detailModal.data.extension_count }} 次</span>
            </div>
            <div class="flex justify-between"><span class="text-stone-400">竞价数</span><span class="text-stone-200">{{ detailModal.data.bid_count }}</span></div>
          </div>

          <!-- 竞价历史 -->
          <div v-if="detailModal.data.bids && detailModal.data.bids.length > 0" class="mb-3">
            <div class="text-sm text-stone-400 mb-1">竞价历史（最近 {{ detailModal.data.bids.length }} 条）</div>
            <div class="bg-stone-800/40 rounded p-2 max-h-32 overflow-y-auto text-xs space-y-1">
              <div v-for="bid in detailModal.data.bids" :key="bid.id" class="flex justify-between">
                <span class="text-stone-300">{{ bid.bidder_nickname || '匿名' }}</span>
                <span class="text-rose-300">{{ formatStones(bid.bid_price) }} 灵石</span>
                <span class="text-stone-500">{{ formatDateTime(bid.created_at) }}</span>
              </div>
            </div>
          </div>

          <!-- 出价区（仅进行中且非卖家） -->
          <div v-if="detailModal.data.status === 'open' && !detailModal.data.is_seller" class="bg-rose-950/20 border border-rose-900/40 rounded p-3">
            <div class="text-sm text-rose-300 mb-2">出价（最小加价: {{ formatStones(detailModal.data.min_next_bid) }} 灵石）</div>
            <div class="flex gap-2">
              <input v-model.number="bidForm.price" type="number" :min="detailModal.data.min_next_bid" class="flex-1 bg-stone-800 border border-stone-700 rounded px-3 py-2 text-stone-200" />
              <button class="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded" @click="openBidConfirm">出价</button>
            </div>
          </div>

          <!-- 卖家提示 -->
          <div v-if="detailModal.data.is_seller && detailModal.data.status === 'open'" class="bg-amber-950/20 border border-amber-900/40 rounded p-2 text-xs text-amber-300">
            这是你的拍卖，不能竞拍自己的物品。可在"我的拍卖"中撤销。
          </div>

          <button class="w-full mt-3 py-2 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded" @click="closeDetail">关闭</button>
        </template>
      </div>
    </Modal>

    <!-- ===== 出价确认 Modal ===== -->
    <Modal :show="bidConfirmModal.show" @close="bidConfirmModal.show = false" max-width="400px">
      <div class="p-4">
        <h3 class="text-lg font-bold text-rose-200 mb-3">确认出价</h3>
        <div class="text-sm text-stone-300 space-y-1 mb-4">
          <div>物品: <span class="text-stone-200">{{ bidConfirmModal.auction?.item_name }}</span></div>
          <div>出价: <span class="text-rose-300 font-bold">{{ formatStones(bidConfirmModal.price) }} 灵石</span></div>
          <div class="text-xs text-stone-500 mt-2">出价后灵石将被冻结，被他人超越时退还。防秒杀机制可能延长结束时间。</div>
        </div>
        <div class="flex gap-2">
          <button class="flex-1 py-2 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded" @click="bidConfirmModal.show = false">取消</button>
          <button class="flex-1 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded disabled:opacity-50" :disabled="submitting" @click="confirmBid">{{ submitting ? '处理中...' : '确认出价' }}</button>
        </div>
      </div>
    </Modal>

    <!-- ===== 创建拍卖确认 Modal ===== -->
    <Modal :show="createConfirmModal.show" @close="createConfirmModal.show = false" max-width="400px">
      <div class="p-4">
        <h3 class="text-lg font-bold text-rose-200 mb-3">确认发布拍卖</h3>
        <div class="text-sm text-stone-300 space-y-1 mb-4">
          <div>物品: <span class="text-stone-200">{{ selectedInventoryItem?.name }} x{{ createForm.quantity }}</span></div>
          <div>起拍价: <span class="text-rose-300 font-bold">{{ formatStones(createForm.starting_price) }} 灵石</span></div>
          <div>时长: <span class="text-stone-200">{{ createForm.duration_hours }} 小时</span></div>
          <div>手续费率: <span class="text-stone-200">{{ (config?.fee_rate || 0.05) * 100 }}%</span></div>
          <div class="text-xs text-stone-500 mt-2">物品将立即从储物袋扣除。无人竞价时到期退回；有人竞价时到期成交，灵石扣除手续费后入账。</div>
        </div>
        <div class="flex gap-2">
          <button class="flex-1 py-2 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded" @click="createConfirmModal.show = false">取消</button>
          <button class="flex-1 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded disabled:opacity-50" :disabled="submitting" @click="confirmCreate">{{ submitting ? '处理中...' : '确认发布' }}</button>
        </div>
      </div>
    </Modal>

    <!-- ===== 撤销拍卖确认 Modal ===== -->
    <Modal :show="cancelConfirmModal.show" @close="cancelConfirmModal.show = false" max-width="400px">
      <div class="p-4">
        <h3 class="text-lg font-bold text-rose-200 mb-3">确认撤销拍卖</h3>
        <div class="text-sm text-stone-300 space-y-1 mb-3">
          <div>物品: <span class="text-stone-200">{{ cancelConfirmModal.auction?.item_name }}</span></div>
          <div>当前价: <span class="text-rose-300">{{ formatStones(cancelConfirmModal.auction?.current_price) }} 灵石</span></div>
          <div class="text-xs text-amber-400 mt-2">⚠️ 若已有人竞价，撤销需支付补偿费（按当前价 {{ (config?.seller?.cancel_fee_when_bidded || 0.02) * 100 }}% 计算）</div>
        </div>
        <div class="mb-3">
          <label class="block text-sm text-stone-400 mb-1">撤销原因（可选）</label>
          <input v-model="cancelConfirmModal.reason" class="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 text-stone-200 text-sm" placeholder="便于审计" />
        </div>
        <div class="flex gap-2">
          <button class="flex-1 py-2 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded" @click="cancelConfirmModal.show = false">取消</button>
          <button class="flex-1 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded disabled:opacity-50" :disabled="submitting" @click="confirmCancel">{{ submitting ? '处理中...' : '确认撤销' }}</button>
        </div>
      </div>
    </Modal>

  </div>
</template>
