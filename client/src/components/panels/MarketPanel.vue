<script setup>
/**
 * 坊市（万宝楼）面板组件
 *
 * 提供坊市挂单的浏览、搜索、购买（换物）、上架、下架交互界面。
 * 万宝楼为换物系统：卖家上架物品 A，标价换取物品 B，买家用 B 换走 A。
 *
 * 设计说明：
 *   - 外壳统一走 ui/PanelShell（遮罩 / 关闭 / 右坞停靠），点击遮罩或关闭按钮 emit('close')
 *   - Tab 切换走 ui/Tabs：万宝楼（浏览挂单）/ 我的货摊（管理个人挂单）
 *   - 所有确认操作（购买/下架/上架）均使用自定义 Modal 组件，禁用浏览器原生弹窗
 *   - 业务逻辑全部通过 API 调用后端，前端只做展示与交互
 */
import { ref, computed, onMounted } from 'vue'
import apiClient from '../../api'
import { useUIStore } from '../../stores/ui'
import {
  getListings,
  searchListings,
  getMyListings,
  createListing,
  buyListing,
  cancelListing
} from '../../api/market'
import { getGameBalancePublic } from '../../api/config'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

/* ===================== 视图与列表状态 ===================== */

// 当前激活的 Tab：market=万宝楼，mine=我的货摊（key/label 契约见 ui/Tabs.vue）
const activeTab = ref('market')
const tabItems = [
  { key: 'market', label: '万宝楼' },
  { key: 'mine', label: '我的货摊' }
]
const loading = ref(false)
const submitting = ref(false)

// 万宝楼挂单列表与分页
const listings = ref([])
const marketPage = ref(1)
const marketTotalPages = ref(0)
const marketTotal = ref(0)

// 我的货摊列表与分页
const myListings = ref([])
const minePage = ref(1)
const mineTotalPages = ref(0)
const mineTotal = ref(0)

// 搜索关键词与物品类型筛选
const searchKeyword = ref('')
const filterType = ref('')

/**
 * 物品类型中文标签映射（从后端 game_balance.item_types 拉取）
 * 未拉取到时降级为空对象，typeOptions 将仅包含"全部类型"选项
 * 统一使用后端配置，避免与 InventoryPanel 出现"丹药 vs 消耗品"等文案不一致
 */
const itemTypeLabels = ref({})

/**
 * 物品类型下拉选项（基于后端配置动态生成）
 */
const typeOptions = computed(() => [
  { value: '', label: '全部类型' },
  ...Object.keys(itemTypeLabels.value).map(k => ({ value: k, label: itemTypeLabels.value[k] }))
])

/**
 * 拉取公开游戏配置（物品类型中文名映射）
 * 失败时降级为空映射，不影响面板基础功能
 */
const fetchGameConfig = async () => {
  try {
    const res = await getGameBalancePublic()
    if (res.data?.code === 200 && res.data.data?.item_types) {
      itemTypeLabels.value = res.data.data.item_types
    }
  } catch (error) {
    console.error('[MarketPanel] 拉取物品类型配置失败，使用降级默认值:', error)
  }
}

/* ===================== 弹窗状态 ===================== */

// 购买确认弹窗
const buyModal = ref({ show: false, listing: null })
// 下架确认弹窗
const cancelModal = ref({ show: false, listing: null })
// 上架表单弹窗
const createModal = ref({ show: false, loading: false })

// 上架表单数据
const createForm = ref({
  item_key: '',          // 出售物品 key（从背包选择）
  quantity: 1,           // 出售数量
  want_item_key: '',    // 换取物品 key（从全部物品配置选择）
  want_quantity: 1       // 换取数量
})

// 背包物品（上架时选择出售物品）
const inventoryItems = ref([])
// 全部物品配置（上架时选择换取物品）
const allItems = ref([])

/**
 * 当前选中出售物品的可用数量上限（用于数量校验）
 */
const selectedSellItem = computed(() => {
  return inventoryItems.value.find(i => i.item_key === createForm.value.item_key) || null
})

const maxSellQuantity = computed(() => selectedSellItem.value?.quantity || 0)

/* ===================== 数据获取 ===================== */

/**
 * 获取万宝楼挂单列表
 * - 有关键词时走 searchListings（同时匹配出售/换取物品名称）
 * - 无关键词时走 getListings（支持按物品类型筛选）
 */
const fetchListings = async () => {
  loading.value = true
  try {
    const keyword = searchKeyword.value.trim()
    let res
    if (keyword) {
      // 搜索模式：模糊匹配出售与换取物品名称
      res = await searchListings(keyword, marketPage.value)
    } else {
      // 浏览模式：支持按物品类型筛选
      res = await getListings({
        page: marketPage.value,
        type: filterType.value || undefined
      })
    }
    const data = res.data.data || {}
    listings.value = data.list || []
    marketTotal.value = data.total || 0
    marketTotalPages.value = data.total_pages || 0
  } catch (error) {
    console.error('获取坊市挂单失败:', error)
    uiStore.showApiError(error, '获取坊市挂单失败')
  } finally {
    loading.value = false
  }
}

/**
 * 获取我的货摊列表
 */
const fetchMyListings = async () => {
  loading.value = true
  try {
    const res = await getMyListings(minePage.value)
    const data = res.data.data || {}
    myListings.value = data.list || []
    mineTotal.value = data.total || 0
    mineTotalPages.value = data.total_pages || 0
  } catch (error) {
    console.error('获取我的货摊失败:', error)
    uiStore.showApiError(error, '获取我的货摊失败')
  } finally {
    loading.value = false
  }
}

/**
 * 切换 Tab 时加载对应数据
 */
const switchTab = (tab) => {
  if (activeTab.value === tab) return
  activeTab.value = tab
  if (tab === 'market') {
    marketPage.value = 1
    fetchListings()
  } else {
    minePage.value = 1
    fetchMyListings()
  }
}

/* ===================== 搜索与分页 ===================== */

/**
 * 执行搜索（回车或点击搜索按钮触发）
 * 搜索激活时类型筛选不生效（search 接口不支持类型过滤）
 */
const handleSearch = () => {
  marketPage.value = 1
  fetchListings()
}

/**
 * 物品类型筛选变更
 * 切换类型时清空关键词，回到浏览模式
 */
const handleTypeChange = () => {
  searchKeyword.value = ''
  marketPage.value = 1
  fetchListings()
}

/**
 * 清除搜索条件，回到浏览模式
 */
const clearSearch = () => {
  searchKeyword.value = ''
  marketPage.value = 1
  fetchListings()
}

/**
 * 万宝楼分页翻页
 */
const changeMarketPage = (delta) => {
  const next = marketPage.value + delta
  if (next < 1 || next > marketTotalPages.value) return
  marketPage.value = next
  fetchListings()
}

/**
 * 我的货摊分页翻页
 */
const changeMinePage = (delta) => {
  const next = minePage.value + delta
  if (next < 1 || next > mineTotalPages.value) return
  minePage.value = next
  fetchMyListings()
}

/* ===================== 购买（换物）===================== */

/**
 * 打开购买确认弹窗
 */
const openBuyModal = (listing) => {
  buyModal.value = { show: true, listing }
}

/**
 * 确认购买挂单
 */
const confirmBuy = async () => {
  const listing = buyModal.value.listing
  if (!listing) return
  submitting.value = true
  try {
    const res = await buyListing(listing.id)
    uiStore.showToast(res.data.message || '换物成功', 'success')
    uiStore.addLog({
      content: `你在万宝楼以 ${listing.want_item_name} x${listing.want_quantity} 换得 ${listing.item_name} x${listing.quantity}。`,
      type: 'market',
      actorId: 'self'
    })
    buyModal.value = { show: false, listing: null }
    // 刷新万宝楼列表
    await fetchListings()
  } catch (error) {
    uiStore.showApiError(error, '换物失败')
  } finally {
    submitting.value = false
  }
}

/* ===================== 下架 ===================== */

/**
 * 打开下架确认弹窗
 */
const openCancelModal = (listing) => {
  cancelModal.value = { show: true, listing }
}

/**
 * 确认下架挂单
 */
const confirmCancel = async () => {
  const listing = cancelModal.value.listing
  if (!listing) return
  submitting.value = true
  try {
    const res = await cancelListing(listing.id)
    uiStore.showToast(res.data.message || '下架成功，物品已退回储物袋', 'success')
    cancelModal.value = { show: false, listing: null }
    // 刷新我的货摊列表
    await fetchMyListings()
  } catch (error) {
    uiStore.showApiError(error, '下架失败')
  } finally {
    submitting.value = false
  }
}

/* ===================== 上架（创建挂单）===================== */

/**
 * 打开上架弹窗：并行加载背包与全部物品配置
 */
const openCreateModal = async () => {
  // 重置表单
  createForm.value = { item_key: '', quantity: 1, want_item_key: '', want_quantity: 1 }
  createModal.value = { show: true, loading: true }
  try {
    // 并行获取背包（选择出售物品）与物品配置（选择换取物品）
    const [invRes, itemsRes] = await Promise.all([
      apiClient.get('/inventory'),
      apiClient.get('/config/data/items')
    ])
    inventoryItems.value = invRes.data.data?.items || []
    allItems.value = itemsRes.data.data?.items || []
  } catch (error) {
    console.error('获取背包/物品配置失败:', error)
    uiStore.showApiError(error, '获取背包/物品配置失败')
    createModal.value.show = false
  } finally {
    createModal.value.loading = false
  }
}

/**
 * 出售物品变更时，重置数量为 1 并不超过上限
 */
const handleSellItemChange = () => {
  if (maxSellQuantity.value && createForm.value.quantity > maxSellQuantity.value) {
    createForm.value.quantity = maxSellQuantity.value
  }
  if (createForm.value.quantity < 1) createForm.value.quantity = 1
}

/**
 * 确认上架挂单
 * 前端做基本参数校验，最终校验由后端 MarketService 完成
 */
const confirmCreate = async () => {
  const { item_key, quantity, want_item_key, want_quantity } = createForm.value
  // 基本参数校验
  if (!item_key) {
    uiStore.showToast('请选择出售物品', 'warning')
    return
  }
  if (!want_item_key) {
    uiStore.showToast('请选择换取物品', 'warning')
    return
  }
  if (quantity < 1 || want_quantity < 1) {
    uiStore.showToast('数量必须大于 0', 'warning')
    return
  }
  if (maxSellQuantity.value && quantity > maxSellQuantity.value) {
    uiStore.showToast(`数量超出持有上限（${maxSellQuantity.value}）`, 'warning')
    return
  }

  submitting.value = true
  try {
    const res = await createListing({
      item_key,
      quantity: Number(quantity),
      want_item_key,
      want_quantity: Number(want_quantity)
    })
    uiStore.showToast(res.data.message || '上架成功', 'success')
    createModal.value.show = false
    // 上架后切换到我的货摊并刷新
    activeTab.value = 'mine'
    minePage.value = 1
    await fetchMyListings()
  } catch (error) {
    uiStore.showApiError(error, '上架失败')
  } finally {
    submitting.value = false
  }
}

/* ===================== 展示辅助方法 ===================== */

/**
 * 获取物品类型中文标签
 * 优先使用后端配置的 itemTypeLabels，未匹配时返回"未知"
 */
const getItemTypeLabel = (type) => {
  return itemTypeLabels.value[type] || '未知'
}

/**
 * 挂单状态标签文案
 */
const statusLabel = (status) => {
  switch (status) {
    case 'active': return '上架中'
    case 'sold': return '已售出'
    case 'cancelled': return '已下架'
    default: return status
  }
}

/**
 * 挂单状态标签色（active绿/sold灰/cancelled红），取值契约见 ui/Badge.vue
 */
const statusTone = (status) => {
  switch (status) {
    case 'active': return 'success'
    case 'sold': return 'muted'
    case 'cancelled': return 'danger'
    default: return 'neutral'
  }
}

/**
 * 格式化时间显示
 */
const formatTime = (timeStr) => {
  if (!timeStr) return '-'
  const d = new Date(timeStr)
  if (isNaN(d.getTime())) return '-'
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 根据 key 从物品列表中查询物品名称（用于上架预览展示）
 * @param key 物品键名
 * @param list 物品列表
 * @param keyField 列表中作为键的字段名（背包为 item_key，物品配置为 id）
 */
const getSelectedItemName = (key, list, keyField) => {
  const item = list.find(i => i[keyField] === key)
  return item ? item.name : key
}

onMounted(() => {
  // 并行拉取挂单列表与游戏配置，减少首屏等待时间
  Promise.all([fetchListings(), fetchGameConfig()])
})
</script>

<template>
  <PanelShell
    title="万宝楼"
    hint="挂单 · 换物 · 货摊"
    size="xl"
    scoped-scroll
    @close="emit('close')"
  >
    <div class="h-full flex flex-col min-h-0">
      <!-- Tab 切换：切换时仍由 switchTab 拉取对应列表 -->
      <Tabs :model-value="activeTab" :items="tabItems" class="shrink-0" @update:model-value="switchTab" />

      <!-- 内容区 -->
      <div class="flex-1 min-h-0 overflow-y-auto p-4">
        <LoadingBlock v-if="loading" />

        <template v-else>
          <!-- ========== 万宝楼视图 ========== -->
          <div v-if="activeTab === 'market'">
            <!-- 搜索与筛选栏 -->
            <div class="flex flex-wrap items-center gap-2 mb-4">
              <div class="flex-1 min-w-[200px] relative">
                <input
                  v-model="searchKeyword"
                  type="text"
                  placeholder="按物品名称搜索（出售或换取物品）"
                  class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 pl-9 text-sm text-fg-primary placeholder-fg-faint focus:outline-none focus:border-gold-700"
                  @keyup.enter="handleSearch"
                />
                <svg class="absolute left-2.5 top-2.5 w-4 h-4 text-fg-faint" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </div>
              <select
                v-model="filterType"
                @change="handleTypeChange"
                :disabled="!!searchKeyword.trim()"
                class="bg-surface-canvas border border-line rounded-control px-3 py-2 text-sm text-fg-primary focus:outline-none focus:border-gold-700 disabled:opacity-50"
              >
                <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
              <AppButton variant="primary" @click="handleSearch">搜索</AppButton>
              <AppButton v-if="searchKeyword.trim()" variant="default" @click="clearSearch">清除</AppButton>
            </div>

            <!-- 搜索模式提示 -->
            <div v-if="searchKeyword.trim()" class="mb-3 text-xs text-fg-faint">
              搜索模式：匹配「{{ searchKeyword }}」，物品类型筛选已禁用
            </div>

            <!-- 空状态 -->
            <EmptyState
              v-if="listings.length === 0"
              text="坊市暂无挂单"
              hint="换个关键词或物品类型再筛一次，也可以去「我的货摊」上架第一件"
            />

            <!-- 挂单列表 -->
            <div v-else class="space-y-3">
              <div
                v-for="listing in listings"
                :key="listing.id"
                class="bg-surface-raised border border-line-subtle rounded-panel p-4 hover:border-line transition-colors"
              >
                <div class="flex items-start justify-between gap-3">
                  <!-- 出售物品信息 -->
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-base font-bold text-gold-300">{{ listing.item_name }}</span>
                      <Badge tone="gold">出售</Badge>
                      <span class="text-xs text-fg-faint">x{{ listing.quantity }}</span>
                    </div>
                    <!-- 换取物品 -->
                    <div class="flex items-center gap-2 text-sm">
                      <svg class="w-3.5 h-3.5 text-fg-faint" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                      <span class="text-cyan-300">{{ listing.want_item_name }}</span>
                      <span class="text-xs text-fg-faint">x{{ listing.want_quantity }}</span>
                    </div>
                    <!-- 卖家与时间 -->
                    <div class="text-xs text-fg-faint mt-2 flex items-center gap-3">
                      <span>卖家 #{{ listing.seller_id }}</span>
                      <span>挂单时间 {{ formatTime(listing.createdAt) }}</span>
                    </div>
                  </div>
                  <!-- 操作区 -->
                  <div class="flex flex-col items-end gap-2">
                    <Badge :tone="statusTone(listing.status)">{{ statusLabel(listing.status) }}</Badge>
                    <button
                      v-if="listing.status === 'active'"
                      @click="openBuyModal(listing)"
                      :disabled="submitting"
                      class="px-4 py-1.5 rounded-control bg-emerald-900/30 border border-emerald-800 text-emerald-300 hover:bg-emerald-800/50 hover:text-emerald-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
                    >
                      换物
                    </button>
                  </div>
                </div>
              </div>

              <!-- 分页 -->
              <div class="flex items-center justify-between pt-2">
                <span class="text-xs text-fg-faint">共 {{ marketTotal }} 条</span>
                <div class="flex items-center gap-2">
                  <AppButton size="sm" variant="default" :disabled="marketPage <= 1" @click="changeMarketPage(-1)">
                    上一页
                  </AppButton>
                  <span class="text-xs text-fg-muted num">{{ marketPage }} / {{ marketTotalPages }}</span>
                  <AppButton size="sm" variant="default" :disabled="marketPage >= marketTotalPages" @click="changeMarketPage(1)">
                    下一页
                  </AppButton>
                </div>
              </div>
            </div>
          </div>

          <!-- ========== 我的货摊视图 ========== -->
          <div v-else>
            <!-- 顶部操作栏 -->
            <div class="flex items-center justify-between mb-4">
              <div class="text-sm text-fg-faint">管理你的坊市挂单</div>
              <AppButton variant="primary" @click="openCreateModal">
                <template #icon>
                  <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </template>
                上架物品
              </AppButton>
            </div>

            <!-- 空状态 -->
            <EmptyState
              v-if="myListings.length === 0"
              text="你的货摊空空如也"
              hint="点击「上架物品」摆出第一件，换回真正需要的东西"
            />

            <!-- 我的挂单列表 -->
            <div v-else class="space-y-3">
              <div
                v-for="listing in myListings"
                :key="listing.id"
                class="bg-surface-raised border border-line-subtle rounded-panel p-4"
              >
                <div class="flex items-start justify-between gap-3">
                  <!-- 物品信息 -->
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-base font-bold text-gold-300">{{ listing.item_name }}</span>
                      <span class="text-xs text-fg-faint">x{{ listing.quantity }}</span>
                    </div>
                    <div class="flex items-center gap-2 text-sm">
                      <span class="text-xs text-fg-faint">换取</span>
                      <span class="text-cyan-300">{{ listing.want_item_name }}</span>
                      <span class="text-xs text-fg-faint">x{{ listing.want_quantity }}</span>
                    </div>
                    <div class="text-xs text-fg-faint mt-2 flex items-center gap-3">
                      <span v-if="listing.status === 'sold'">买家 #{{ listing.buyer_id }}</span>
                      <span>{{ listing.status === 'sold' ? '成交' : '挂单' }}时间 {{ formatTime(listing.status === 'sold' ? listing.sold_at : listing.createdAt) }}</span>
                    </div>
                  </div>
                  <!-- 操作区 -->
                  <div class="flex flex-col items-end gap-2">
                    <Badge :tone="statusTone(listing.status)">{{ statusLabel(listing.status) }}</Badge>
                    <AppButton
                      v-if="listing.status === 'active'"
                      size="sm"
                      variant="danger"
                      :disabled="submitting"
                      @click="openCancelModal(listing)"
                    >
                      下架
                    </AppButton>
                  </div>
                </div>
              </div>

              <!-- 分页 -->
              <div class="flex items-center justify-between pt-2">
                <span class="text-xs text-fg-faint">共 {{ mineTotal }} 条</span>
                <div class="flex items-center gap-2">
                  <AppButton size="sm" variant="default" :disabled="minePage <= 1" @click="changeMinePage(-1)">
                    上一页
                  </AppButton>
                  <span class="text-xs text-fg-muted num">{{ minePage }} / {{ mineTotalPages }}</span>
                  <AppButton size="sm" variant="default" :disabled="minePage >= mineTotalPages" @click="changeMinePage(1)">
                    下一页
                  </AppButton>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- ========== 购买确认弹窗 ========== -->
    <Modal :isOpen="buyModal.show" title="确认换物" width="480px" @close="buyModal.show = false">
      <div v-if="buyModal.listing" class="space-y-3">
        <p class="text-sm text-fg-secondary">即将与卖家完成换物交易：</p>
        <div class="bg-surface-canvas border border-line-subtle rounded-control p-3 space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span class="text-fg-faint">你将付出</span>
            <span class="text-cyan-300 font-bold">{{ buyModal.listing.want_item_name }} x{{ buyModal.listing.want_quantity }}</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-fg-faint">你将获得</span>
            <span class="text-gold-300 font-bold">{{ buyModal.listing.item_name }} x{{ buyModal.listing.quantity }}</span>
          </div>
        </div>
        <p class="text-xs text-fg-faint">提示：换物后物品即时到账，请确认你的储物袋中有足够的换取物品。</p>
      </div>
      <template #footer>
        <AppButton variant="default" @click="buyModal.show = false">取消</AppButton>
        <AppButton variant="primary" :disabled="submitting" @click="confirmBuy">
          {{ submitting ? '处理中…' : '确认换物' }}
        </AppButton>
      </template>
    </Modal>

    <!-- ========== 下架确认弹窗 ========== -->
    <Modal :isOpen="cancelModal.show" title="确认下架" width="480px" @close="cancelModal.show = false">
      <div v-if="cancelModal.listing" class="space-y-3">
        <p class="text-sm text-fg-secondary">确认下架该挂单？下架后物品将退回你的储物袋。</p>
        <div class="bg-surface-canvas border border-line-subtle rounded-control p-3">
          <div class="text-sm">
            <span class="text-gold-300 font-bold">{{ cancelModal.listing.item_name }}</span>
            <span class="text-fg-faint"> x{{ cancelModal.listing.quantity }}</span>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" @click="cancelModal.show = false">取消</AppButton>
        <AppButton variant="danger" :disabled="submitting" @click="confirmCancel">
          {{ submitting ? '处理中…' : '确认下架' }}
        </AppButton>
      </template>
    </Modal>

    <!-- ========== 上架弹窗 ========== -->
    <Modal :isOpen="createModal.show" title="上架物品" width="540px" @close="createModal.show = false">
      <LoadingBlock v-if="createModal.loading" />
      <div v-else class="space-y-4">
        <!-- 出售物品 -->
        <div>
          <label class="block text-xs font-bold text-fg-muted mb-2 uppercase tracking-wider">出售物品</label>
          <select
            v-model="createForm.item_key"
            @change="handleSellItemChange"
            class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-sm text-fg-primary focus:outline-none focus:border-gold-700"
          >
            <option value="">请选择储物袋中的物品</option>
            <option v-for="item in inventoryItems" :key="item.item_key" :value="item.item_key">
              {{ item.name }} x{{ item.quantity }}（{{ getItemTypeLabel(item.type) }}）
            </option>
          </select>
          <p v-if="selectedSellItem" class="text-xs text-fg-faint mt-1">持有数量：{{ maxSellQuantity }}</p>
        </div>

        <!-- 出售数量 -->
        <div>
          <label class="block text-xs font-bold text-fg-muted mb-2 uppercase tracking-wider">出售数量</label>
          <input
            v-model.number="createForm.quantity"
            type="number"
            min="1"
            :max="maxSellQuantity || undefined"
            class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-sm text-fg-primary focus:outline-none focus:border-gold-700"
          />
        </div>

        <!-- 换取物品 -->
        <div>
          <label class="block text-xs font-bold text-fg-muted mb-2 uppercase tracking-wider">换取物品</label>
          <select
            v-model="createForm.want_item_key"
            class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-sm text-fg-primary focus:outline-none focus:border-gold-700"
          >
            <option value="">请选择想换取的物品</option>
            <option v-for="item in allItems" :key="item.id" :value="item.id">
              {{ item.name }}（{{ getItemTypeLabel(item.type) }}）
            </option>
          </select>
        </div>

        <!-- 换取数量 -->
        <div>
          <label class="block text-xs font-bold text-fg-muted mb-2 uppercase tracking-wider">换取数量</label>
          <input
            v-model.number="createForm.want_quantity"
            type="number"
            min="1"
            class="w-full bg-surface-canvas border border-line rounded-control px-3 py-2 text-sm text-fg-primary focus:outline-none focus:border-gold-700"
          />
        </div>

        <!-- 预览 -->
        <div v-if="createForm.item_key && createForm.want_item_key" class="bg-surface-canvas border border-line-subtle rounded-control p-3">
          <div class="text-xs text-fg-faint mb-1">交易预览</div>
          <div class="flex items-center gap-3 text-sm">
            <div>
              <span class="text-gold-300 font-bold">{{ getSelectedItemName(createForm.item_key, inventoryItems, 'item_key') }}</span>
              <span class="text-fg-faint"> x{{ createForm.quantity }}</span>
            </div>
            <svg class="w-4 h-4 text-fg-faint" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            <div>
              <span class="text-cyan-300 font-bold">{{ getSelectedItemName(createForm.want_item_key, allItems, 'id') }}</span>
              <span class="text-fg-faint"> x{{ createForm.want_quantity }}</span>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" @click="createModal.show = false">取消</AppButton>
        <AppButton variant="primary" :disabled="submitting" @click="confirmCreate">
          {{ submitting ? '处理中…' : '确认上架' }}
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>
