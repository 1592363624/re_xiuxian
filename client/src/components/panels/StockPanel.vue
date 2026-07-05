<script setup>
/**
 * 聚宝股市面板组件（玩家侧）
 *
 * 功能说明：
 *   - 弹窗式面板，参考 PawnshopPanel.vue 的设计风格
 *   - 标题区：展示账户余额、总资产、持仓市值、负债、保证金率
 *   - Tab 切换：行情 / 持仓 / 交易 / 融资
 *     · 行情 Tab：账户状态卡 + 12 只股票行情表（涨绿跌红，中国习惯）+ 点击行展开详情 Modal（K线区 + 事件 + 买卖按钮）
 *     · 持仓 Tab：持仓列表（股票/数量/可用/成本/现价/市值/浮动盈亏）+ 买入更多/卖出按钮
 *     · 交易 Tab：资金转入口 + 融资账户入口 + 交易历史表 + 分红历史表
 *     · 融资 Tab：融资账户详情 + 偿还操作 + 风险提示
 *   - 颜色风格：青色系（cyan-400/cyan-500）体现股市主题，涨绿跌红
 *
 * 设计原则：
 *   - 所有业务逻辑在后端 StockMarketService 处理，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - BIGINT 金额字段统一以字符串展示，避免 JS Number 精度问题
 *   - 所有手续费/印花税/市值由后端计算返回，前端不做任何业务计算
 *   - WebSocket 监听 stock:* 事件，实时刷新行情与持仓
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { socketService } from '../../services/socket'
import {
  getStatus,
  getStockList,
  getStockDetail,
  getHoldings,
  getTransactions,
  getDividends,
  getMarginAccount,
  openMarginAccount,
  repayMargin,
  buy,
  sell,
  deposit,
  withdraw
} from '../../api/stock'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

/* ===================== 基础状态 ===================== */

// 当前激活的 Tab：market=行情，holdings=持仓，trade=交易，margin=融资
const activeTab = ref('market')
const loading = ref(false)
const submitting = ref(false)

// 玩家股市状态
const status = ref(null)
// 股票行情列表
const stockList = ref([])
// 持仓列表
const holdings = ref([])

/* ===================== 行情 Tab 状态 ===================== */

// 当前查看详情的股票
const detailStock = ref(null)
// 详情加载状态
const detailLoading = ref(false)

/* ===================== 持仓 Tab 状态 ===================== */

// 持仓加载状态（独立于主 loading）
const holdingsLoading = ref(false)

/* ===================== 交易 Tab 状态 ===================== */

// 交易历史
const transactions = ref([])
const txPage = ref(1)
const txTotalPages = ref(0)
const txTotal = ref(0)
// 分红历史
const dividends = ref([])
const divPage = ref(1)
const divTotalPages = ref(0)
const divTotal = ref(0)

/* ===================== 融资 Tab 状态 ===================== */

// 融资账户详情
const marginAccount = ref(null)

/* ===================== 买卖 Modal 状态 ===================== */

// 买卖弹窗状态
const tradeModal = ref({
  show: false,
  type: 'buy', // buy/sell
  stock: null,
  quantity: 1,
  useMargin: false
})

// 买卖确认弹窗
const tradeConfirmModal = ref({ show: false })

/* ===================== 资金转入/转出 Modal ===================== */

const transferModal = ref({
  show: false,
  type: 'deposit', // deposit/withdraw
  amount: 0
})
const transferConfirmModal = ref({ show: false })

/* ===================== 融资 Modal ===================== */

// 开通融资确认弹窗
const openMarginConfirmModal = ref({ show: false })
// 偿还融资弹窗
const repayModal = ref({
  show: false,
  amount: 0
})
const repayConfirmModal = ref({ show: false })

/* ===================== 计算属性 ===================== */

/**
 * 保证金率百分比文案（带颜色）
 */
const marginRatioText = computed(() => {
  if (!status.value) return '0%'
  const ratio = status.value.margin_ratio || 0
  return `${(ratio * 100).toFixed(2)}%`
})

/**
 * 保证金率颜色：低于 50% 红色，低于维持率（30%）深红，否则绿色
 */
const marginRatioClass = computed(() => {
  if (!status.value) return 'text-stone-300'
  const ratio = status.value.margin_ratio || 0
  if (ratio < 0.3) return 'text-red-500 font-bold'
  if (ratio < 0.5) return 'text-rose-400'
  return 'text-emerald-400'
})

/**
 * 当前选中股票的预估成交金额（仅展示用，实际以后端为准）
 * 注意：前端不计算手续费/印花税，仅展示数量 × 当前价作为参考
 */
const estimatedAmount = computed(() => {
  const stock = tradeModal.value.stock
  const qty = tradeModal.value.quantity || 0
  if (!stock || !qty) return '0'
  // 当前价为字符串大数，用 Number 转换展示（金额不大时安全）
  const price = Number(stock.current_price || 0)
  return Math.floor(price * qty).toString()
})

/* ===================== 工具函数 ===================== */

/**
 * 涨跌幅颜色：绿涨红跌（中国习惯）
 * @param {number} pct - 涨跌幅小数
 */
const changeColorClass = (pct) => {
  if (pct > 0) return 'text-emerald-400'
  if (pct < 0) return 'text-rose-400'
  return 'text-stone-400'
}

/**
 * 涨跌幅文案
 * @param {number} pct - 涨跌幅小数
 */
const changeText = (pct) => {
  const sign = pct > 0 ? '+' : ''
  return `${sign}${(pct * 100).toFixed(2)}%`
}

/**
 * 浮动盈亏颜色
 * @param {string} profit - 盈亏字符串大数
 */
const profitColorClass = (profit) => {
  const n = Number(profit || 0)
  if (n > 0) return 'text-emerald-400'
  if (n < 0) return 'text-rose-400'
  return 'text-stone-400'
}

/**
 * 股票分类中文标签
 * @param {string} category - 分类
 */
const categoryLabel = (category) => {
  const map = {
    sect: '宗门',
    mine: '灵矿',
    dungeon: '秘境',
    event: '事件'
  }
  return map[category] || category
}

/**
 * 交易类型中文标签
 * @param {string} type - 交易类型
 */
const tradeTypeLabel = (type) => {
  return type === 'buy' ? '买入' : '卖出'
}

/**
 * 交易类型样式类
 * @param {string} type - 交易类型
 */
const tradeTypeClass = (type) => {
  return type === 'buy' ? 'text-emerald-400' : 'text-rose-400'
}

/**
 * 分红类型中文标签
 * @param {string} type - 分红类型
 */
const dividendTypeLabel = (type) => {
  return type === 'special' ? '特别分红' : '常规分红'
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
 * 格式化完整时间
 * @param {string} timeStr - ISO 时间字符串
 */
const formatFullTime = (timeStr) => {
  if (!timeStr) return '-'
  try {
    const d = new Date(timeStr)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return timeStr
  }
}

/* ===================== 数据获取 ===================== */

/**
 * 拉取玩家股市状态
 */
const fetchStatus = async () => {
  try {
    const res = await getStatus()
    status.value = res.data?.data || res.data || null
  } catch (error) {
    console.error('[StockPanel] 获取股市状态失败:', error)
    const msg = error.response?.data?.message || '获取股市状态失败'
    uiStore.showToast(msg, 'error')
  }
}

/**
 * 拉取股票行情列表
 */
const fetchStockList = async () => {
  loading.value = true
  try {
    const res = await getStockList()
    stockList.value = res.data?.data || res.data || []
  } catch (error) {
    console.error('[StockPanel] 获取行情列表失败:', error)
    const msg = error.response?.data?.message || '获取行情列表失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 拉取持仓列表
 */
const fetchHoldings = async () => {
  holdingsLoading.value = true
  try {
    const res = await getHoldings()
    holdings.value = res.data?.data || res.data || []
  } catch (error) {
    console.error('[StockPanel] 获取持仓失败:', error)
    const msg = error.response?.data?.message || '获取持仓失败'
    uiStore.showToast(msg, 'error')
  } finally {
    holdingsLoading.value = false
  }
}

/**
 * 拉取交易历史
 */
const fetchTransactions = async () => {
  try {
    const res = await getTransactions(txPage.value, 10)
    const data = res.data?.data || {}
    transactions.value = data.list || []
    txTotal.value = data.total || 0
    txTotalPages.value = data.total_pages || 0
  } catch (error) {
    console.error('[StockPanel] 获取交易历史失败:', error)
    const msg = error.response?.data?.message || '获取交易历史失败'
    uiStore.showToast(msg, 'error')
  }
}

/**
 * 拉取分红历史
 */
const fetchDividends = async () => {
  try {
    const res = await getDividends(divPage.value, 10)
    const data = res.data?.data || {}
    dividends.value = data.list || []
    divTotal.value = data.total || 0
    divTotalPages.value = data.total_pages || 0
  } catch (error) {
    console.error('[StockPanel] 获取分红历史失败:', error)
    const msg = error.response?.data?.message || '获取分红历史失败'
    uiStore.showToast(msg, 'error')
  }
}

/**
 * 拉取融资账户详情
 */
const fetchMarginAccount = async () => {
  try {
    const res = await getMarginAccount()
    marginAccount.value = res.data?.data || res.data || null
  } catch (error) {
    console.error('[StockPanel] 获取融资账户失败:', error)
    const msg = error.response?.data?.message || '获取融资账户失败'
    uiStore.showToast(msg, 'error')
  }
}

/**
 * 拉取股票详情（点击行情表行时调用）
 * @param {Object} stock - 股票对象
 */
const openStockDetail = async (stock) => {
  detailLoading.value = true
  try {
    const res = await getStockDetail(stock.id)
    detailStock.value = res.data?.data || res.data || stock
  } catch (error) {
    console.error('[StockPanel] 获取股票详情失败:', error)
    // 失败时退回使用列表项数据
    detailStock.value = stock
  } finally {
    detailLoading.value = false
  }
}

/**
 * 关闭股票详情弹窗
 */
const closeStockDetail = () => {
  detailStock.value = null
}

/* ===================== Tab 切换 ===================== */

/**
 * 切换 Tab 并按需加载对应数据
 * @param {string} tab - market/holdings/trade/margin
 */
const switchTab = (tab) => {
  if (activeTab.value === tab) return
  activeTab.value = tab
  if (tab === 'holdings') {
    fetchHoldings()
  } else if (tab === 'trade') {
    fetchTransactions()
    fetchDividends()
  } else if (tab === 'margin') {
    fetchMarginAccount()
  }
}

/* ===================== 买卖交互 ===================== */

/**
 * 打开买卖弹窗
 * @param {string} type - buy/sell
 * @param {Object} stock - 股票对象（来自行情或持仓）
 */
const openTradeModal = (type, stock) => {
  if (!stock) return
  // 熔断股票不可交易
  if (stock.is_trading_halted) {
    uiStore.showToast('该股票已熔断，暂停交易', 'warning')
    return
  }
  // 账户被锁定不可交易
  if (status.value?.is_trading_locked) {
    uiStore.showToast('账户已被锁定，请联系 GM 解锁', 'warning')
    return
  }
  // 卖出时校验可用持仓
  if (type === 'sell') {
    const holding = holdings.value.find(h => h.stock_id === stock.id)
    if (!holding || Number(holding.available_quantity) <= 0) {
      uiStore.showToast('无可用持仓（T+1 结算，买入次日方可卖出）', 'warning')
      return
    }
  }
  tradeModal.value = {
    show: true,
    type,
    stock,
    quantity: 1,
    useMargin: false
  }
}

/**
 * 关闭买卖弹窗
 */
const closeTradeModal = () => {
  tradeModal.value.show = false
}

/**
 * 数量增减
 * @param {number} delta - 变化量
 */
const changeTradeQuantity = (delta) => {
  let next = (tradeModal.value.quantity || 1) + delta
  if (next < 1) next = 1
  // 卖出时不超过可用数量
  if (tradeModal.value.type === 'sell') {
    const holding = holdings.value.find(h => h.stock_id === tradeModal.value.stock?.id)
    const max = holding ? Number(holding.available_quantity) : 0
    if (next > max) next = max
  }
  // 不超过单笔上限
  const maxQty = status.value?.config?.max_trade_quantity || 1000
  if (next > maxQty) next = maxQty
  tradeModal.value.quantity = next
}

/**
 * 数量输入框失焦校验
 */
const handleTradeQuantityInput = () => {
  let q = parseInt(tradeModal.value.quantity)
  if (isNaN(q) || q < 1) q = 1
  const minQty = status.value?.config?.min_trade_quantity || 1
  if (q < minQty) q = minQty
  if (tradeModal.value.type === 'sell') {
    const holding = holdings.value.find(h => h.stock_id === tradeModal.value.stock?.id)
    const max = holding ? Number(holding.available_quantity) : 0
    if (q > max) q = max
  }
  const maxQty = status.value?.config?.max_trade_quantity || 1000
  if (q > maxQty) q = maxQty
  tradeModal.value.quantity = q
}

/**
 * 打开买卖确认弹窗（二次确认）
 */
const openTradeConfirmModal = () => {
  if (!tradeModal.value.stock) return
  const qty = tradeModal.value.quantity
  if (!qty || qty < 1) {
    uiStore.showToast('数量必须大于 0', 'warning')
    return
  }
  const minQty = status.value?.config?.min_trade_quantity || 1
  if (qty < minQty) {
    uiStore.showToast(`数量不能少于 ${minQty}`, 'warning')
    return
  }
  // 卖出时再次校验可用数量（防止数据过期）
  if (tradeModal.value.type === 'sell') {
    const holding = holdings.value.find(h => h.stock_id === tradeModal.value.stock.id)
    if (!holding || Number(holding.available_quantity) < qty) {
      uiStore.showToast('可用持仓不足', 'warning')
      return
    }
  }
  tradeConfirmModal.value.show = true
}

/**
 * 关闭买卖确认弹窗
 */
const closeTradeConfirmModal = () => {
  tradeConfirmModal.value.show = false
}

/**
 * 确认买卖（调用后端接口）
 */
const confirmTrade = async () => {
  const { type, stock, quantity, useMargin } = tradeModal.value
  if (!stock) return
  if (submitting.value) return
  submitting.value = true
  try {
    let data
    if (type === 'buy') {
      const res = await buy(stock.id, quantity, !!useMargin)
      data = res.data?.data || res.data || {}
    } else {
      const res = await sell(stock.id, quantity)
      data = res.data?.data || res.data || {}
    }
    uiStore.showToast(data.message || (type === 'buy' ? '买入成功' : '卖出成功'), 'success')
    // 写入游戏日志
    uiStore.addLog({
      content: `你${type === 'buy' ? '买入' : '卖出'}【${data.stock_name || stock.name}】${data.quantity || quantity} 股，成交金额 ${data.amount || estimatedAmount.value} 灵石。`,
      type: 'info',
      actorId: 'self'
    })
    // 关闭弹窗
    closeTradeConfirmModal()
    closeTradeModal()
    closeStockDetail()
    // 刷新状态、行情、持仓、玩家信息
    await Promise.all([fetchStatus(), fetchStockList(), fetchHoldings()])
    if (playerStore.fetchPlayer) {
      playerStore.fetchPlayer()
    }
  } catch (error) {
    console.error('[StockPanel] 交易失败:', error)
    const msg = error.response?.data?.message || error.response?.data?.error || '交易失败'
    uiStore.showToast(msg, 'error')
  } finally {
    submitting.value = false
  }
}

/* ===================== 资金转入/转出 ===================== */

/**
 * 打开转入/转出弹窗
 * @param {string} type - deposit/withdraw
 */
const openTransferModal = (type) => {
  transferModal.value = {
    show: true,
    type,
    amount: 0
  }
}

/**
 * 关闭转入/转出弹窗
 */
const closeTransferModal = () => {
  transferModal.value.show = false
}

/**
 * 打开转入/转出确认弹窗
 */
const openTransferConfirmModal = () => {
  const amount = Number(transferModal.value.amount)
  if (!amount || amount <= 0) {
    uiStore.showToast('金额必须大于 0', 'warning')
    return
  }
  transferConfirmModal.value.show = true
}

/**
 * 关闭确认弹窗
 */
const closeTransferConfirmModal = () => {
  transferConfirmModal.value.show = false
}

/**
 * 确认转入/转出
 */
const confirmTransfer = async () => {
  const { type, amount } = transferModal.value
  if (submitting.value) return
  submitting.value = true
  try {
    let data
    if (type === 'deposit') {
      const res = await deposit(amount)
      data = res.data?.data || res.data || {}
    } else {
      const res = await withdraw(amount)
      data = res.data?.data || res.data || {}
    }
    uiStore.showToast(data.message || (type === 'deposit' ? '转入成功' : '转出成功'), 'success')
    // 写入游戏日志
    uiStore.addLog({
      content: `你${type === 'deposit' ? '转入' : '转出'}股市账户 ${data.amount || amount} 灵石。`,
      type: 'info',
      actorId: 'self'
    })
    closeTransferConfirmModal()
    closeTransferModal()
    // 刷新状态与玩家信息
    await Promise.all([fetchStatus(), fetchMarginAccount()])
    if (playerStore.fetchPlayer) {
      playerStore.fetchPlayer()
    }
  } catch (error) {
    console.error('[StockPanel] 转账失败:', error)
    const msg = error.response?.data?.message || error.response?.data?.error || '转账失败'
    uiStore.showToast(msg, 'error')
  } finally {
    submitting.value = false
  }
}

/* ===================== 融资账户 ===================== */

/**
 * 打开开通融资确认弹窗
 */
const openOpenMarginConfirm = () => {
  openMarginConfirmModal.value.show = true
}

/**
 * 确认开通融资账户
 */
const confirmOpenMargin = async () => {
  if (submitting.value) return
  submitting.value = true
  try {
    const res = await openMarginAccount()
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '融资账户已开通', 'success')
    openMarginConfirmModal.value.show = false
    await Promise.all([fetchStatus(), fetchMarginAccount()])
  } catch (error) {
    console.error('[StockPanel] 开通融资失败:', error)
    const msg = error.response?.data?.message || error.response?.data?.error || '开通融资失败'
    uiStore.showToast(msg, 'error')
  } finally {
    submitting.value = false
  }
}

/**
 * 打开偿还融资弹窗
 */
const openRepayModal = () => {
  repayModal.value = {
    show: true,
    amount: 0
  }
}

/**
 * 关闭偿还融资弹窗
 */
const closeRepayModal = () => {
  repayModal.value.show = false
}

/**
 * 打开偿还确认弹窗
 */
const openRepayConfirmModal = () => {
  const amount = Number(repayModal.value.amount)
  if (!amount || amount <= 0) {
    uiStore.showToast('偿还金额必须大于 0', 'warning')
    return
  }
  repayConfirmModal.value.show = true
}

/**
 * 确认偿还融资
 */
const confirmRepay = async () => {
  if (submitting.value) return
  submitting.value = true
  try {
    const res = await repayMargin(repayModal.value.amount)
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '偿还成功', 'success')
    uiStore.addLog({
      content: `你偿还融资负债 ${data.repay_amount || repayModal.value.amount} 灵石，剩余负债 ${data.remaining_debt || 0}。`,
      type: 'info',
      actorId: 'self'
    })
    repayConfirmModal.value.show = false
    closeRepayModal()
    await Promise.all([fetchStatus(), fetchMarginAccount()])
  } catch (error) {
    console.error('[StockPanel] 偿还融资失败:', error)
    const msg = error.response?.data?.message || error.response?.data?.error || '偿还融资失败'
    uiStore.showToast(msg, 'error')
  } finally {
    submitting.value = false
  }
}

/* ===================== 分页 ===================== */

/**
 * 交易历史翻页
 * @param {number} delta - 变化量
 */
const changeTxPage = (delta) => {
  const next = txPage.value + delta
  if (next < 1 || next > txTotalPages.value) return
  txPage.value = next
  fetchTransactions()
}

/**
 * 分红历史翻页
 * @param {number} delta - 变化量
 */
const changeDivPage = (delta) => {
  const next = divPage.value + delta
  if (next < 1 || next > divTotalPages.value) return
  divPage.value = next
  fetchDividends()
}

/* ===================== WebSocket 事件监听 ===================== */

// 保存取消监听函数，组件卸载时统一清理
let unsubscribers = []

/**
 * 注册股市相关 Socket 事件监听
 * 收到推送后刷新对应数据，保证 UI 与后端实时同步
 */
const setupSocketListeners = () => {
  // 买卖成功：刷新状态、行情、持仓
  unsubscribers.push(socketService.on('stock:buy', () => {
    Promise.all([fetchStatus(), fetchStockList(), fetchHoldings()])
  }))
  unsubscribers.push(socketService.on('stock:sell', () => {
    Promise.all([fetchStatus(), fetchStockList(), fetchHoldings()])
  }))
  // 转入/转出：刷新状态与融资账户
  unsubscribers.push(socketService.on('stock:deposit', () => {
    fetchStatus()
    if (activeTab.value === 'margin') fetchMarginAccount()
  }))
  unsubscribers.push(socketService.on('stock:withdraw', () => {
    fetchStatus()
    if (activeTab.value === 'margin') fetchMarginAccount()
  }))
  // 价格更新：刷新行情表
  unsubscribers.push(socketService.on('stock:price_update', () => {
    fetchStockList()
    if (activeTab.value === 'holdings') fetchHoldings()
  }))
  // 分红到账：提示并刷新
  unsubscribers.push(socketService.on('stock:dividend', (data) => {
    uiStore.showToast(`分红到账：${data?.stock_name || ''} 获得 ${data?.total_dividend || 0} 灵石`, 'success')
    fetchStatus()
    if (activeTab.value === 'trade') fetchDividends()
  }))
  // 强平通知：警告
  unsubscribers.push(socketService.on('stock:liquidation', (data) => {
    uiStore.showToast(data?.message || '融资账户已爆仓，持仓被强制平仓', 'error')
    Promise.all([fetchStatus(), fetchHoldings(), fetchMarginAccount()])
  }))
  // 熔断通知
  unsubscribers.push(socketService.on('stock:halt', (data) => {
    uiStore.showToast(data?.message || '股票已触发熔断，暂停交易', 'warning')
    fetchStockList()
  }))
  // 追加保证金通知
  unsubscribers.push(socketService.on('stock:margin_call', (data) => {
    uiStore.showToast(data?.message || '保证金率不足，请及时追加保证金或偿还负债', 'warning')
    fetchStatus()
    if (activeTab.value === 'margin') fetchMarginAccount()
  }))
}

/**
 * 清理所有 Socket 监听
 */
const cleanupSocketListeners = () => {
  unsubscribers.forEach(unsub => {
    try { unsub() } catch (e) { /* 忽略清理错误 */ }
  })
  unsubscribers = []
}

/* ===================== 生命周期 ===================== */

onMounted(async () => {
  // 并行拉取状态与行情
  await Promise.all([fetchStatus(), fetchStockList()])
  // 注册 Socket 监听
  setupSocketListeners()
})

onUnmounted(() => {
  cleanupSocketListeners()
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-cyan-900/40 rounded-lg w-full max-w-5xl h-[88vh] flex flex-col shadow-2xl shadow-cyan-900/20 overflow-hidden animate-fade-in">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-gradient-to-r from-cyan-950/40 to-[#1c1917]">
        <h2 class="text-xl font-bold text-cyan-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3v18h18"/>
            <path d="m19 9-5 5-4-4-3 3"/>
          </svg>
          聚宝股市
        </h2>
        <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- 账户状态条 -->
      <div v-if="status" class="grid grid-cols-3 md:grid-cols-6 gap-2 p-3 border-b border-stone-800 bg-[#0c0a09]">
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">账户余额</div>
          <div class="text-sm font-bold text-cyan-300">{{ status.balance }}</div>
        </div>
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">持仓市值</div>
          <div class="text-sm font-bold text-cyan-300">{{ status.holdings_value }}</div>
        </div>
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">总资产</div>
          <div class="text-sm font-bold text-amber-400">{{ status.total_assets }}</div>
        </div>
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">融资负债</div>
          <div class="text-sm font-bold" :class="Number(status.debt) > 0 ? 'text-rose-400' : 'text-stone-400'">{{ status.debt }}</div>
        </div>
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">保证金率</div>
          <div class="text-sm font-bold" :class="marginRatioClass">{{ marginRatioText }}</div>
        </div>
        <div class="bg-[#1c1917] border border-stone-700 rounded p-2 text-center">
          <div class="text-[10px] text-stone-500">持仓数</div>
          <div class="text-sm font-bold text-cyan-400">{{ status.holdings_count }}</div>
        </div>
      </div>

      <!-- Tab 切换 -->
      <div class="flex border-b border-stone-800 bg-[#1c1917]">
        <button
          v-for="tab in [
            { id: 'market', name: '行情' },
            { id: 'holdings', name: '持仓' },
            { id: 'trade', name: '交易' },
            { id: 'margin', name: '融资' }
          ]"
          :key="tab.id"
          @click="switchTab(tab.id)"
          class="flex-1 px-4 py-3 text-sm font-bold transition-colors relative"
          :class="activeTab === tab.id ? 'text-cyan-400' : 'text-stone-500 hover:text-stone-300'"
        >
          {{ tab.name }}
          <span v-if="activeTab === tab.id" class="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-500"></span>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto p-4 custom-scrollbar">
        <!-- 加载中 -->
        <div v-if="loading" class="flex justify-center items-center h-64">
          <svg class="animate-spin h-10 w-10 text-cyan-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>

        <template v-else>
          <!-- ===================== 行情 Tab ===================== -->
          <div v-if="activeTab === 'market'">
            <!-- 账户被锁定提示 -->
            <div v-if="status?.is_trading_locked" class="bg-rose-950/40 border border-rose-800/50 rounded-lg p-3 mb-3 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-rose-400 shrink-0">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <span class="text-sm text-rose-300">您的股市账户已被锁定，无法进行交易，请联系 GM 解锁。</span>
            </div>

            <!-- 空状态 -->
            <div v-if="stockList.length === 0" class="flex flex-col items-center justify-center h-48 text-stone-500">
              <p>暂无行情数据</p>
            </div>

            <!-- 行情表 -->
            <div v-else class="bg-[#1c1917] border border-stone-800 rounded-lg overflow-hidden">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="bg-stone-900/60 text-stone-400">
                    <tr>
                      <th class="px-3 py-2 text-left whitespace-nowrap">代码</th>
                      <th class="px-3 py-2 text-left whitespace-nowrap">名称</th>
                      <th class="px-3 py-2 text-left whitespace-nowrap">分类</th>
                      <th class="px-3 py-2 text-right whitespace-nowrap">当前价</th>
                      <th class="px-3 py-2 text-right whitespace-nowrap">涨跌幅</th>
                      <th class="px-3 py-2 text-right whitespace-nowrap">成交量</th>
                      <th class="px-3 py-2 text-center whitespace-nowrap">状态</th>
                      <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="stock in stockList"
                      :key="stock.id"
                      class="border-t border-stone-800 hover:bg-stone-900/40 transition-colors cursor-pointer"
                      @click="openStockDetail(stock)"
                    >
                      <td class="px-3 py-2 text-stone-400 font-mono">{{ stock.code }}</td>
                      <td class="px-3 py-2 text-stone-200">{{ stock.name }}</td>
                      <td class="px-3 py-2">
                        <span class="text-xs px-2 py-0.5 rounded bg-stone-800 text-stone-400">{{ categoryLabel(stock.category) }}</span>
                      </td>
                      <td class="px-3 py-2 text-right text-cyan-300 font-bold">{{ stock.current_price }}</td>
                      <td class="px-3 py-2 text-right font-bold" :class="changeColorClass(stock.daily_change_pct)">
                        {{ changeText(stock.daily_change_pct) }}
                      </td>
                      <td class="px-3 py-2 text-right text-stone-400">{{ stock.daily_volume }}</td>
                      <td class="px-3 py-2 text-center">
                        <span v-if="stock.is_trading_halted" class="text-xs px-2 py-0.5 rounded bg-rose-950/60 text-rose-400 border border-rose-800/50">熔断</span>
                        <span v-else class="text-xs px-2 py-0.5 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">交易中</span>
                      </td>
                      <td class="px-3 py-2 text-center whitespace-nowrap" @click.stop>
                        <button
                          @click="openTradeModal('buy', stock)"
                          :disabled="stock.is_trading_halted || status?.is_trading_locked"
                          class="px-2 py-1 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 text-xs mr-1 disabled:opacity-30 disabled:cursor-not-allowed"
                        >买入</button>
                        <button
                          @click="openTradeModal('sell', stock)"
                          :disabled="stock.is_trading_halted || status?.is_trading_locked"
                          class="px-2 py-1 rounded bg-rose-900/40 border border-rose-700/50 text-rose-400 hover:bg-rose-800/50 text-xs disabled:opacity-30 disabled:cursor-not-allowed"
                        >卖出</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- ===================== 持仓 Tab ===================== -->
          <div v-else-if="activeTab === 'holdings'">
            <div v-if="holdingsLoading" class="flex justify-center items-center h-48">
              <svg class="animate-spin h-8 w-8 text-cyan-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>
            <!-- 空状态 -->
            <div v-else-if="holdings.length === 0" class="flex flex-col items-center justify-center h-48 text-stone-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
                <path d="M3 3v18h18"/>
                <path d="m19 9-5 5-4-4-3 3"/>
              </svg>
              <p>暂无持仓</p>
              <p class="text-xs mt-1">前往行情 Tab 买入股票开始持仓</p>
            </div>
            <!-- 持仓列表 -->
            <div v-else class="space-y-3">
              <div
                v-for="holding in holdings"
                :key="holding.id"
                class="bg-[#1c1917] border border-stone-800 rounded-lg p-4 hover:border-cyan-800/50 transition-colors"
              >
                <div class="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-base font-bold text-stone-200">{{ holding.name }}</span>
                      <span class="text-xs text-stone-500 font-mono">{{ holding.code }}</span>
                      <span class="text-xs px-2 py-0.5 rounded bg-stone-800 text-stone-400">{{ categoryLabel(holding.category) }}</span>
                      <span v-if="holding.is_trading_halted" class="text-xs px-2 py-0.5 rounded bg-rose-950/60 text-rose-400 border border-rose-800/50">熔断</span>
                    </div>
                    <div class="text-xs text-stone-600">
                      持有 {{ holding.quantity }} · 可用 <span class="text-cyan-400">{{ holding.available_quantity }}</span>
                      <span v-if="Number(holding.quantity) > Number(holding.available_quantity)" class="text-amber-500 ml-1">(T+1 冻结中)</span>
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <button
                      @click="openTradeModal('buy', holding)"
                      :disabled="holding.is_trading_halted || status?.is_trading_locked"
                      class="px-3 py-1 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 text-xs disabled:opacity-30 disabled:cursor-not-allowed"
                    >买入更多</button>
                    <button
                      @click="openTradeModal('sell', holding)"
                      :disabled="holding.is_trading_halted || Number(holding.available_quantity) <= 0 || status?.is_trading_locked"
                      class="px-3 py-1 rounded bg-rose-900/40 border border-rose-700/50 text-rose-400 hover:bg-rose-800/50 text-xs disabled:opacity-30 disabled:cursor-not-allowed"
                    >卖出</button>
                  </div>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                  <div class="flex items-center justify-between">
                    <span class="text-stone-500">成本价</span>
                    <span class="text-stone-300">{{ holding.average_cost }}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-stone-500">现价</span>
                    <span class="text-cyan-300 font-bold">{{ holding.current_price }}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-stone-500">市值</span>
                    <span class="text-amber-400 font-bold">{{ holding.market_value }}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-stone-500">浮动盈亏</span>
                    <span class="font-bold" :class="profitColorClass(holding.profit)">
                      {{ Number(holding.profit) >= 0 ? '+' : '' }}{{ holding.profit }}
                      <span class="text-[10px] ml-1">({{ changeText(holding.profit_pct) }})</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ===================== 交易 Tab ===================== -->
          <div v-else-if="activeTab === 'trade'">
            <!-- 资金操作入口 -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
              <button
                @click="openTransferModal('deposit')"
                class="px-3 py-2 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 text-sm transition-colors"
              >转入灵石</button>
              <button
                @click="openTransferModal('withdraw')"
                class="px-3 py-2 rounded bg-amber-900/40 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 text-sm transition-colors"
              >转出灵石</button>
              <button
                @click="switchTab('margin')"
                class="px-3 py-2 rounded bg-cyan-900/40 border border-cyan-700/50 text-cyan-400 hover:bg-cyan-800/50 text-sm transition-colors"
              >融资账户</button>
              <button
                @click="fetchTransactions(); fetchDividends()"
                class="px-3 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:bg-stone-700 text-sm transition-colors"
              >刷新</button>
            </div>

            <!-- 交易历史 -->
            <div class="mb-6">
              <h3 class="text-sm font-bold text-cyan-400 mb-2">交易历史</h3>
              <div v-if="transactions.length === 0" class="text-center text-stone-500 py-6 text-sm">暂无交易记录</div>
              <div v-else class="bg-[#1c1917] border border-stone-800 rounded-lg overflow-hidden">
                <div class="overflow-x-auto">
                  <table class="w-full text-xs">
                    <thead class="bg-stone-900/60 text-stone-400">
                      <tr>
                        <th class="px-2 py-2 text-left whitespace-nowrap">时间</th>
                        <th class="px-2 py-2 text-left whitespace-nowrap">股票</th>
                        <th class="px-2 py-2 text-center whitespace-nowrap">类型</th>
                        <th class="px-2 py-2 text-right whitespace-nowrap">数量</th>
                        <th class="px-2 py-2 text-right whitespace-nowrap">价格</th>
                        <th class="px-2 py-2 text-right whitespace-nowrap">金额</th>
                        <th class="px-2 py-2 text-right whitespace-nowrap">手续费</th>
                        <th class="px-2 py-2 text-right whitespace-nowrap">印花税</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="tx in transactions" :key="tx.id" class="border-t border-stone-800">
                        <td class="px-2 py-2 text-stone-400">{{ formatDateTime(tx.created_at) }}</td>
                        <td class="px-2 py-2 text-stone-200">{{ tx.name }}</td>
                        <td class="px-2 py-2 text-center">
                          <span class="font-bold" :class="tradeTypeClass(tx.trade_type)">
                            {{ tradeTypeLabel(tx.trade_type) }}
                          </span>
                          <span v-if="tx.is_margin" class="text-[10px] text-amber-500 ml-1">融</span>
                        </td>
                        <td class="px-2 py-2 text-right text-stone-300">{{ tx.quantity }}</td>
                        <td class="px-2 py-2 text-right text-stone-300">{{ tx.price }}</td>
                        <td class="px-2 py-2 text-right text-cyan-300 font-bold">{{ tx.amount }}</td>
                        <td class="px-2 py-2 text-right text-rose-400">{{ tx.fee }}</td>
                        <td class="px-2 py-2 text-right text-rose-400">{{ tx.tax }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <!-- 分页 -->
                <div class="px-3 py-2 border-t border-stone-800 flex items-center justify-between text-xs">
                  <span class="text-stone-600">共 {{ txTotal }} 条</span>
                  <div class="flex items-center gap-2">
                    <button @click="changeTxPage(-1)" :disabled="txPage <= 1" class="px-2 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed">上一页</button>
                    <span class="text-stone-400">{{ txPage }} / {{ txTotalPages }}</span>
                    <button @click="changeTxPage(1)" :disabled="txPage >= txTotalPages" class="px-2 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed">下一页</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 分红历史 -->
            <div>
              <h3 class="text-sm font-bold text-cyan-400 mb-2">分红历史</h3>
              <div v-if="dividends.length === 0" class="text-center text-stone-500 py-6 text-sm">暂无分红记录</div>
              <div v-else class="bg-[#1c1917] border border-stone-800 rounded-lg overflow-hidden">
                <div class="overflow-x-auto">
                  <table class="w-full text-xs">
                    <thead class="bg-stone-900/60 text-stone-400">
                      <tr>
                        <th class="px-2 py-2 text-left whitespace-nowrap">时间</th>
                        <th class="px-2 py-2 text-left whitespace-nowrap">股票</th>
                        <th class="px-2 py-2 text-right whitespace-nowrap">持股</th>
                        <th class="px-2 py-2 text-right whitespace-nowrap">每股分红</th>
                        <th class="px-2 py-2 text-right whitespace-nowrap">总金额</th>
                        <th class="px-2 py-2 text-center whitespace-nowrap">类型</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="div in dividends" :key="div.id" class="border-t border-stone-800">
                        <td class="px-2 py-2 text-stone-400">{{ formatDateTime(div.created_at) }}</td>
                        <td class="px-2 py-2 text-stone-200">{{ div.name }}</td>
                        <td class="px-2 py-2 text-right text-stone-300">{{ div.quantity }}</td>
                        <td class="px-2 py-2 text-right text-stone-300">{{ div.dividend_per_share }}</td>
                        <td class="px-2 py-2 text-right text-emerald-400 font-bold">{{ div.total_dividend }}</td>
                        <td class="px-2 py-2 text-center text-stone-400 text-[10px]">{{ dividendTypeLabel(div.dividend_type) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <!-- 分页 -->
                <div class="px-3 py-2 border-t border-stone-800 flex items-center justify-between text-xs">
                  <span class="text-stone-600">共 {{ divTotal }} 条</span>
                  <div class="flex items-center gap-2">
                    <button @click="changeDivPage(-1)" :disabled="divPage <= 1" class="px-2 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed">上一页</button>
                    <span class="text-stone-400">{{ divPage }} / {{ divTotalPages }}</span>
                    <button @click="changeDivPage(1)" :disabled="divPage >= divTotalPages" class="px-2 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed">下一页</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ===================== 融资 Tab ===================== -->
          <div v-else-if="activeTab === 'margin'">
            <div v-if="!marginAccount" class="flex justify-center items-center h-48">
              <svg class="animate-spin h-8 w-8 text-cyan-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>
            <template v-else>
              <!-- 未开通融资账户 -->
              <div v-if="!marginAccount.has_margin_account" class="bg-[#1c1917] border border-stone-800 rounded-lg p-6 text-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mx-auto mb-3 text-cyan-500 opacity-70">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                <p class="text-stone-300 mb-1">尚未开通融资账户</p>
                <p class="text-xs text-stone-500 mb-4">{{ marginAccount.message || '开通融资账户后可使用杠杆放大收益' }}</p>
                <button
                  @click="openOpenMarginConfirm"
                  :disabled="submitting"
                  class="px-6 py-2 rounded bg-cyan-900/50 border border-cyan-700/50 text-cyan-300 hover:bg-cyan-800/60 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >开通融资账户</button>
              </div>

              <!-- 已开通融资账户 -->
              <div v-else class="space-y-4">
                <!-- 风险提示 -->
                <div v-if="marginAccount.is_danger" class="bg-rose-950/40 border border-rose-800/50 rounded-lg p-3 flex items-start gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-rose-400 shrink-0 mt-0.5">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  <div>
                    <p class="text-sm text-rose-300 font-bold">保证金率不足，有爆仓风险！</p>
                    <p class="text-xs text-rose-400 mt-1">请及时追加保证金（转入灵石）或偿还融资负债，否则持仓将被强制平仓。</p>
                  </div>
                </div>
                <div v-if="marginAccount.is_liquidated" class="bg-rose-950/60 border border-rose-700 rounded-lg p-3">
                  <p class="text-sm text-rose-300 font-bold">⚠️ 融资账户已爆仓</p>
                  <p class="text-xs text-rose-400 mt-1">您的持仓已被强制平仓，请偿还剩余负债后重新操作。</p>
                </div>

                <!-- 融资账户详情 -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-3">
                    <div class="text-xs text-stone-500 mb-1">总资产</div>
                    <div class="text-lg font-bold text-amber-400">{{ marginAccount.total_assets }}</div>
                  </div>
                  <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-3">
                    <div class="text-xs text-stone-500 mb-1">账户余额</div>
                    <div class="text-lg font-bold text-cyan-300">{{ marginAccount.balance }}</div>
                  </div>
                  <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-3">
                    <div class="text-xs text-stone-500 mb-1">持仓市值</div>
                    <div class="text-lg font-bold text-cyan-300">{{ marginAccount.holdings_value }}</div>
                  </div>
                  <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-3">
                    <div class="text-xs text-stone-500 mb-1">融资负债</div>
                    <div class="text-lg font-bold text-rose-400">{{ marginAccount.debt }}</div>
                  </div>
                  <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-3">
                    <div class="text-xs text-stone-500 mb-1">保证金率</div>
                    <div class="text-lg font-bold" :class="marginAccount.is_danger ? 'text-rose-500' : 'text-emerald-400'">
                      {{ ((marginAccount.margin_ratio || 0) * 100).toFixed(2) }}%
                    </div>
                    <div class="text-[10px] text-stone-600 mt-1">维持率 {{ ((marginAccount.maintenance_margin_rate || 0.3) * 100).toFixed(0) }}%</div>
                  </div>
                  <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-3">
                    <div class="text-xs text-stone-500 mb-1">最大可融额度</div>
                    <div class="text-lg font-bold text-cyan-400">{{ marginAccount.max_credit }}</div>
                  </div>
                  <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-3">
                    <div class="text-xs text-stone-500 mb-1">可用融资额度</div>
                    <div class="text-lg font-bold text-cyan-400">{{ marginAccount.available_credit }}</div>
                  </div>
                  <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-3">
                    <div class="text-xs text-stone-500 mb-1">最后检查</div>
                    <div class="text-xs text-stone-400 mt-1">{{ formatDateTime(marginAccount.last_liquidation_check) }}</div>
                  </div>
                </div>

                <!-- 偿还融资 -->
                <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-4">
                  <h4 class="text-sm font-bold text-cyan-400 mb-3">偿还融资负债</h4>
                  <div class="flex items-center gap-3">
                    <button
                      @click="openRepayModal"
                      :disabled="submitting || Number(marginAccount.debt) <= 0"
                      class="px-4 py-2 rounded bg-rose-900/40 border border-rose-700/50 text-rose-300 hover:bg-rose-800/50 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >偿还负债</button>
                    <span class="text-xs text-stone-500">当前负债 {{ marginAccount.debt }} 灵石</span>
                  </div>
                </div>

                <!-- 风险提示 -->
                <div class="bg-stone-900/40 border border-stone-800 rounded-lg p-4 text-xs text-stone-500 space-y-1">
                  <p class="font-bold text-stone-400">融资融券风险提示：</p>
                  <p>· 融资买入可放大收益，但亏损也会同步放大</p>
                  <p>· 维持保证金率低于 {{ ((marginAccount.maintenance_margin_rate || 0.3) * 100).toFixed(0) }}% 时将触发强制平仓</p>
                  <p>· 卖出融资持仓所得优先偿还负债</p>
                  <p>· 请合理控制杠杆比例，避免爆仓</p>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>

    <!-- ========== 股票详情弹窗 ========== -->
    <Modal :isOpen="!!detailStock" title="股票详情" width="640px" @close="closeStockDetail">
      <div v-if="detailStock" class="space-y-4">
        <!-- 加载中 -->
        <div v-if="detailLoading" class="flex justify-center py-8">
          <svg class="animate-spin h-8 w-8 text-cyan-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
        <template v-else>
          <!-- 基本信息 -->
          <div class="bg-[#0c0a09] border border-stone-800 rounded p-3">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-lg font-bold text-stone-200">{{ detailStock.name }}</span>
                <span class="text-xs text-stone-500 font-mono">{{ detailStock.code }}</span>
                <span class="text-xs px-2 py-0.5 rounded bg-stone-800 text-stone-400">{{ categoryLabel(detailStock.category) }}</span>
              </div>
              <span v-if="detailStock.is_trading_halted" class="text-xs px-2 py-0.5 rounded bg-rose-950/60 text-rose-400 border border-rose-800/50">已熔断</span>
              <span v-else class="text-xs px-2 py-0.5 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">交易中</span>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs">
              <div class="flex items-center justify-between">
                <span class="text-stone-500">当前价</span>
                <span class="text-cyan-300 font-bold">{{ detailStock.current_price }}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-stone-500">今开</span>
                <span class="text-stone-300">{{ detailStock.open_price }}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-stone-500">昨收</span>
                <span class="text-stone-300">{{ detailStock.yesterday_close_price }}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-stone-500">涨跌幅</span>
                <span class="font-bold" :class="changeColorClass(detailStock.daily_change_pct)">{{ changeText(detailStock.daily_change_pct) }}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-stone-500">成交量</span>
                <span class="text-stone-300">{{ detailStock.daily_volume }}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-stone-500">总股本</span>
                <span class="text-stone-300">{{ detailStock.total_shares }}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-stone-500">流通股</span>
                <span class="text-stone-300">{{ detailStock.float_shares }}</span>
              </div>
              <div v-if="detailStock.halt_until" class="flex items-center justify-between">
                <span class="text-stone-500">恢复时间</span>
                <span class="text-rose-400">{{ formatFullTime(detailStock.halt_until) }}</span>
              </div>
            </div>
            <p v-if="detailStock.description" class="text-xs text-stone-500 mt-3 pt-3 border-t border-stone-800">{{ detailStock.description }}</p>
          </div>

          <!-- K线区（简化展示，无图表库依赖） -->
          <div v-if="detailStock.klines && detailStock.klines.length > 0" class="bg-[#0c0a09] border border-stone-800 rounded p-3">
            <div class="text-xs text-stone-400 mb-2">近 {{ detailStock.klines.length }} 根 1h K线</div>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead class="text-stone-500">
                  <tr>
                    <th class="px-2 py-1 text-left">时间</th>
                    <th class="px-2 py-1 text-right">开盘</th>
                    <th class="px-2 py-1 text-right">最高</th>
                    <th class="px-2 py-1 text-right">最低</th>
                    <th class="px-2 py-1 text-right">收盘</th>
                    <th class="px-2 py-1 text-right">成交量</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(k, idx) in detailStock.klines.slice(0, 10)" :key="idx" class="text-stone-300">
                    <td class="px-2 py-1 text-stone-400">{{ formatDateTime(k.period_start) }}</td>
                    <td class="px-2 py-1 text-right">{{ k.open }}</td>
                    <td class="px-2 py-1 text-right text-emerald-400">{{ k.high }}</td>
                    <td class="px-2 py-1 text-right text-rose-400">{{ k.low }}</td>
                    <td class="px-2 py-1 text-right">{{ k.close }}</td>
                    <td class="px-2 py-1 text-right text-stone-400">{{ k.volume }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 活跃事件 -->
          <div v-if="detailStock.active_events && detailStock.active_events.length > 0" class="bg-[#0c0a09] border border-stone-800 rounded p-3">
            <div class="text-xs text-stone-400 mb-2">活跃事件</div>
            <div class="space-y-2">
              <div v-for="(evt, idx) in detailStock.active_events" :key="idx" class="flex items-center gap-2 text-xs">
                <span class="px-2 py-0.5 rounded bg-amber-950/40 text-amber-400 border border-amber-800/40">{{ evt.event_type }}</span>
                <span class="font-bold" :class="changeColorClass(evt.impact_pct)">{{ changeText(evt.impact_pct) }}</span>
                <span class="text-stone-400 flex-1">{{ evt.description }}</span>
                <span class="text-stone-600">{{ formatDateTime(evt.expire_at) }}</span>
              </div>
            </div>
          </div>

          <!-- 买卖按钮 -->
          <div class="flex gap-2">
            <button
              @click="openTradeModal('buy', detailStock)"
              :disabled="detailStock.is_trading_halted || status?.is_trading_locked"
              class="flex-1 py-2 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-300 hover:bg-emerald-800/50 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
            >买入</button>
            <button
              @click="openTradeModal('sell', detailStock)"
              :disabled="detailStock.is_trading_halted || status?.is_trading_locked"
              class="flex-1 py-2 rounded bg-rose-900/40 border border-rose-700/50 text-rose-300 hover:bg-rose-800/50 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
            >卖出</button>
          </div>
        </template>
      </div>
      <template #footer>
        <button @click="closeStockDetail" class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 text-sm">关闭</button>
      </template>
    </Modal>

    <!-- ========== 买卖弹窗 ========== -->
    <Modal :isOpen="tradeModal.show" :title="tradeModal.type === 'buy' ? '买入股票' : '卖出股票'" width="480px" @close="closeTradeModal">
      <div v-if="tradeModal.stock" class="space-y-3">
        <!-- 股票信息 -->
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-stone-200 font-bold">{{ tradeModal.stock.name }}</span>
            <span class="text-xs text-stone-500 font-mono">{{ tradeModal.stock.code }}</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-stone-500">当前价</span>
            <span class="text-cyan-300 font-bold">{{ tradeModal.stock.current_price }} 灵石</span>
          </div>
        </div>

        <!-- 数量输入 -->
        <div>
          <label class="block text-xs font-bold text-stone-400 mb-2 uppercase tracking-wider">交易数量</label>
          <div class="flex items-center gap-3">
            <button @click="changeTradeQuantity(-1)" :disabled="tradeModal.quantity <= 1" class="w-10 h-10 rounded bg-stone-800 hover:bg-stone-700 text-stone-300 text-xl font-bold disabled:opacity-30 disabled:cursor-not-allowed">-</button>
            <input
              v-model.number="tradeModal.quantity"
              type="number"
              min="1"
              @blur="handleTradeQuantityInput"
              @keyup.enter="handleTradeQuantityInput"
              class="w-24 text-center bg-stone-900 border border-stone-700 rounded py-2 text-cyan-400 font-bold text-lg focus:outline-none focus:border-cyan-600"
            />
            <button @click="changeTradeQuantity(1)" class="w-10 h-10 rounded bg-stone-800 hover:bg-stone-700 text-stone-300 text-xl font-bold">+</button>
          </div>
          <p class="text-xs text-stone-600 mt-1">
            单笔范围 {{ status?.config?.min_trade_quantity || 1 }} - {{ status?.config?.max_trade_quantity || 1000 }} 股
          </p>
        </div>

        <!-- 卖出时显示可用数量 -->
        <div v-if="tradeModal.type === 'sell'" class="text-xs text-stone-500">
          可用数量：
          <span class="text-cyan-400 font-bold">
            {{ holdings.find(h => h.stock_id === tradeModal.stock.id)?.available_quantity || 0 }}
          </span>
          股
        </div>

        <!-- 买入时显示融资开关 -->
        <div v-if="tradeModal.type === 'buy' && status?.has_margin_account" class="flex items-center justify-between bg-[#0c0a09] border border-stone-800 rounded p-3">
          <div>
            <div class="text-sm text-stone-300">使用融资买入</div>
            <div class="text-xs text-stone-500">杠杆放大收益与风险</div>
          </div>
          <button
            @click="tradeModal.useMargin = !tradeModal.useMargin"
            class="relative w-12 h-6 rounded-full transition-colors"
            :class="tradeModal.useMargin ? 'bg-cyan-600' : 'bg-stone-700'"
          >
            <span
              class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
              :class="tradeModal.useMargin ? 'translate-x-6' : ''"
            ></span>
          </button>
        </div>

        <!-- 预估金额（仅展示数量×单价，手续费以后端为准） -->
        <div class="bg-cyan-950/20 border border-cyan-800/40 rounded p-3 space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span class="text-stone-400">预估成交金额</span>
            <span class="text-cyan-400 font-bold">{{ estimatedAmount }} 灵石</span>
          </div>
          <p class="text-xs text-stone-600">实际手续费、印花税以确认为准（后端计算）</p>
        </div>
      </div>
      <template #footer>
        <button @click="closeTradeModal" class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 text-sm">取消</button>
        <button
          @click="openTradeConfirmModal"
          :disabled="submitting"
          class="px-4 py-2 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :class="tradeModal.type === 'buy'
            ? 'bg-emerald-900/50 border border-emerald-700/50 text-emerald-300 hover:bg-emerald-800/60'
            : 'bg-rose-900/50 border border-rose-700/50 text-rose-300 hover:bg-rose-800/60'"
        >确认{{ tradeModal.type === 'buy' ? '买入' : '卖出' }}</button>
      </template>
    </Modal>

    <!-- ========== 买卖确认弹窗（二次确认） ========== -->
    <Modal :isOpen="tradeConfirmModal.show" title="确认交易" width="420px" @close="closeTradeConfirmModal">
      <div v-if="tradeModal.stock" class="space-y-3 text-sm">
        <p class="text-stone-300">请确认以下交易：</p>
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-stone-500">操作</span>
            <span class="font-bold" :class="tradeModal.type === 'buy' ? 'text-emerald-400' : 'text-rose-400'">
              {{ tradeModal.type === 'buy' ? '买入' : '卖出' }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">股票</span>
            <span class="text-cyan-300 font-bold">{{ tradeModal.stock.name }} ({{ tradeModal.stock.code }})</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">数量</span>
            <span class="text-stone-200">{{ tradeModal.quantity }} 股</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">价格</span>
            <span class="text-stone-200">{{ tradeModal.stock.current_price }} 灵石</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">预估金额</span>
            <span class="text-cyan-400 font-bold">{{ estimatedAmount }} 灵石</span>
          </div>
          <div v-if="tradeModal.useMargin" class="flex items-center justify-between">
            <span class="text-stone-500">融资买入</span>
            <span class="text-amber-400">是</span>
          </div>
        </div>
        <p class="text-xs text-stone-600">
          提示：{{ tradeModal.type === 'buy'
            ? '买入后当日不可卖出（T+1 结算），手续费按 ' + ((status?.config?.trading_fee_buy || 0) * 100).toFixed(2) + '% 计算'
            : '卖出收取手续费与印花税 ' + ((status?.config?.stamp_tax_sell || 0) * 100).toFixed(2) + '%'
          }}
        </p>
      </div>
      <template #footer>
        <button @click="closeTradeConfirmModal" class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 text-sm">取消</button>
        <button
          @click="confirmTrade"
          :disabled="submitting"
          class="px-4 py-2 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :class="tradeModal.type === 'buy'
            ? 'bg-emerald-900/50 border border-emerald-700/50 text-emerald-300 hover:bg-emerald-800/60'
            : 'bg-rose-900/50 border border-rose-700/50 text-rose-300 hover:bg-rose-800/60'"
        >
          <span v-if="submitting">处理中...</span>
          <span v-else>确认{{ tradeModal.type === 'buy' ? '买入' : '卖出' }}</span>
        </button>
      </template>
    </Modal>

    <!-- ========== 资金转入/转出弹窗 ========== -->
    <Modal :isOpen="transferModal.show" :title="transferModal.type === 'deposit' ? '转入灵石' : '转出灵石'" width="480px" @close="closeTransferModal">
      <div class="space-y-3">
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3 space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <span class="text-stone-500">灵石余额</span>
            <span class="text-amber-300 font-bold">{{ playerStore.player?.spirit_stones || '0' }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">股市账户余额</span>
            <span class="text-cyan-300 font-bold">{{ status?.balance || '0' }}</span>
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold text-stone-400 mb-2 uppercase tracking-wider">
            {{ transferModal.type === 'deposit' ? '转入金额' : '转出金额' }}
          </label>
          <input
            v-model.number="transferModal.amount"
            type="number"
            min="1"
            placeholder="请输入金额"
            class="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-cyan-400 font-bold text-lg focus:outline-none focus:border-cyan-600"
          />
        </div>
        <p class="text-xs text-stone-600">
          {{ transferModal.type === 'deposit'
            ? '将从灵石余额扣除，转入股市账户用于交易'
            : '将从股市账户转出至灵石余额（负债过高时不可转出）'
          }}
        </p>
      </div>
      <template #footer>
        <button @click="closeTransferModal" class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 text-sm">取消</button>
        <button
          @click="openTransferConfirmModal"
          :disabled="submitting"
          class="px-4 py-2 rounded bg-cyan-900/50 border border-cyan-700/50 text-cyan-300 hover:bg-cyan-800/60 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >下一步</button>
      </template>
    </Modal>

    <!-- ========== 转入/转出确认弹窗 ========== -->
    <Modal :isOpen="transferConfirmModal.show" title="确认转账" width="420px" @close="closeTransferConfirmModal">
      <div class="space-y-3 text-sm">
        <p class="text-stone-300">请确认以下操作：</p>
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-stone-500">操作</span>
            <span class="font-bold" :class="transferModal.type === 'deposit' ? 'text-emerald-400' : 'text-amber-400'">
              {{ transferModal.type === 'deposit' ? '转入股市账户' : '转出至灵石' }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">金额</span>
            <span class="text-cyan-400 font-bold">{{ transferModal.amount }} 灵石</span>
          </div>
        </div>
      </div>
      <template #footer>
        <button @click="closeTransferConfirmModal" class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 text-sm">取消</button>
        <button
          @click="confirmTransfer"
          :disabled="submitting"
          class="px-4 py-2 rounded bg-cyan-900/50 border border-cyan-700/50 text-cyan-300 hover:bg-cyan-800/60 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span v-if="submitting">处理中...</span>
          <span v-else>确认</span>
        </button>
      </template>
    </Modal>

    <!-- ========== 开通融资确认弹窗 ========== -->
    <Modal :isOpen="openMarginConfirmModal.show" title="开通融资账户" width="420px" @close="openMarginConfirmModal.show = false">
      <div class="space-y-3 text-sm">
        <p class="text-stone-300">确定要开通融资账户吗？</p>
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-stone-500">最大杠杆倍数</span>
            <span class="text-cyan-400 font-bold">{{ status?.config?.max_leverage || 2 }} 倍</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">维持保证金率</span>
            <span class="text-stone-200">30%</span>
          </div>
        </div>
        <p class="text-xs text-amber-400">
          提示：融资买入可放大收益，但亏损同步放大。保证金率低于 30% 将触发强平，请谨慎操作。
        </p>
      </div>
      <template #footer>
        <button @click="openMarginConfirmModal.show = false" class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 text-sm">取消</button>
        <button
          @click="confirmOpenMargin"
          :disabled="submitting"
          class="px-4 py-2 rounded bg-cyan-900/50 border border-cyan-700/50 text-cyan-300 hover:bg-cyan-800/60 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span v-if="submitting">处理中...</span>
          <span v-else>确认开通</span>
        </button>
      </template>
    </Modal>

    <!-- ========== 偿还融资弹窗 ========== -->
    <Modal :isOpen="repayModal.show" title="偿还融资负债" width="480px" @close="closeRepayModal">
      <div v-if="marginAccount" class="space-y-3">
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3 space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <span class="text-stone-500">当前负债</span>
            <span class="text-rose-400 font-bold">{{ marginAccount.debt }} 灵石</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">账户余额</span>
            <span class="text-cyan-300 font-bold">{{ marginAccount.balance }} 灵石</span>
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold text-stone-400 mb-2 uppercase tracking-wider">偿还金额</label>
          <input
            v-model.number="repayModal.amount"
            type="number"
            min="1"
            placeholder="请输入偿还金额"
            class="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-cyan-400 font-bold text-lg focus:outline-none focus:border-cyan-600"
          />
        </div>
        <button
          @click="repayModal.amount = Number(marginAccount.debt)"
          class="text-xs text-cyan-400 hover:text-cyan-300"
        >全部偿还</button>
        <p class="text-xs text-stone-600">将从股市账户余额扣除，偿还后减少融资负债</p>
      </div>
      <template #footer>
        <button @click="closeRepayModal" class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 text-sm">取消</button>
        <button
          @click="openRepayConfirmModal"
          :disabled="submitting"
          class="px-4 py-2 rounded bg-rose-900/50 border border-rose-700/50 text-rose-300 hover:bg-rose-800/60 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >下一步</button>
      </template>
    </Modal>

    <!-- ========== 偿还确认弹窗 ========== -->
    <Modal :isOpen="repayConfirmModal.show" title="确认偿还" width="420px" @close="repayConfirmModal.show = false">
      <div class="space-y-3 text-sm">
        <p class="text-stone-300">请确认以下偿还操作：</p>
        <div class="bg-[#0c0a09] border border-stone-800 rounded p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-stone-500">偿还金额</span>
            <span class="text-rose-400 font-bold">{{ repayModal.amount }} 灵石</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">偿还后剩余负债</span>
            <span class="text-stone-200">{{ Math.max(0, Number(marginAccount?.debt || 0) - Number(repayModal.amount || 0)) }} 灵石</span>
          </div>
        </div>
      </div>
      <template #footer>
        <button @click="repayConfirmModal.show = false" class="px-4 py-2 rounded bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 text-sm">取消</button>
        <button
          @click="confirmRepay"
          :disabled="submitting"
          class="px-4 py-2 rounded bg-rose-900/50 border border-rose-700/50 text-rose-300 hover:bg-rose-800/60 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span v-if="submitting">处理中...</span>
          <span v-else>确认偿还</span>
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
