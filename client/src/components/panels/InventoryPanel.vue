<script setup>
/**
 * 储物袋（背包）面板组件
 *
 * 功能说明：
 *   - 外壳统一走 ui/PanelShell（遮罩、关闭、右坞停靠由它给），面板不再自写遮罩与外壳
 *   - 容量（已用 / 总容量）挂在 PanelShell 的 header-actions 上
 *   - 装备栏区域：展示各装备槽位（武器/护甲/饰品/靴子/法器）及装备总加成
 *   - 分类筛选 tabs 走 ui/Tabs：全部 / 丹药 / 材料 / 装备 / 其他
 *   - 物品网格列表，按品质颜色描边，展示名称、数量、描述
 *   - 点击物品卡片展开操作菜单：使用（消耗品）/ 穿戴（装备）/ 丢弃
 *   - 使用/丢弃时弹出数量选择框（自定义 Modal 组件，禁用浏览器原生 prompt）
 *   - 穿戴/卸下时弹出确认框（自定义 Modal 组件，禁用浏览器原生 confirm）
 *   - 所有业务逻辑通过 inventory/equipment API 调用后端，前端只做展示与交互
 *   - 操作成功后刷新背包/装备栏并通过 useUIStore 显示 toast 提示
 */
import { ref, computed, onMounted } from 'vue'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import StatBar from '../ui/StatBar.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import EmptyState from '../ui/EmptyState.vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { usePlayerResources } from '../../composables/usePlayerResources'
import { useStatSchema } from '../../composables/useStatSchema'
import { useItemQualities } from '../../composables/useItemQualities'
import { formatCompact } from '../../utils/format'
import { getInventory, useItem, discardItem } from '../../api/inventory'
import { getEquipped, equipItem, unequipItem, getEquipmentBonus } from '../../api/equipment'
import { getGameBalancePublic } from '../../api/config'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()
const { patchFromResponse } = usePlayerResources()
const { formatBonus } = useStatSchema()

// ====== 响应式状态 ======
const loading = ref(true)
const operating = ref(false) // 操作中状态锁，防止重复提交
const items = ref([])
const capacity = ref(0)
const totalCount = ref(0)
// 当前激活的分类 tab
const activeCategory = ref('all')
// 当前展开操作菜单的物品 item_key
const expandedItemKey = ref(null)

// ====== 装备栏相关状态 ======
// 已装备物品列表（按槽位分组：{ weapon: {...}, armor: {...}, ... }）
const equippedSlots = ref({})
// 装备总加成（{ atk, def, hp_max, ... }）
const equipmentBonus = ref({})
// 装备栏加载中状态
const equipmentLoading = ref(false)

// ====== 装备槽位配置（从后端 game_balance.equipment 拉取，未拉取到时降级为空数组） ======
// 顺序由后端 valid_slots 决定，用于在装备栏区域统一展示槽位
const equipmentSlotsConfig = ref([])
// ====== 物品类型中文名映射（从后端 game_balance.item_types 拉取） ======
const itemTypeMap = ref({})
// ====== 背包分类 tabs（从后端 game_balance.item_categories 拉取） ======
const categories = ref([
  { key: 'all', label: '全部' },
  { key: 'consumable', label: '丹药' },
  { key: 'material', label: '材料' },
  { key: 'equipment', label: '装备' },
  { key: 'other', label: '其他' }
])
// ====== 使用物品单次最大数量（从后端 game_balance.inventory.max_use_quantity 拉取） ======
const maxUseQuantity = ref(99)

// ====== 穿戴确认弹窗状态 ======
const equipConfirmModal = ref({
  show: false,
  item: null // 待穿戴的装备物品
})

// ====== 卸下确认弹窗状态 ======
const unequipConfirmModal = ref({
  show: false,
  slot: '', // 待卸下的槽位
  item: null // 待卸下的装备物品
})

// ====== 数量选择弹窗状态 ======
const quantityModal = ref({
  show: false,
  type: 'use', // 'use' | 'discard'
  item: null,
  quantity: 1
})

// ====== 确认丢弃弹窗状态 ======
const confirmModal = ref({
  show: false,
  item: null,
  quantity: 1
})

// ====== 分类配置已迁移至上方响应式变量（从后端拉取） ======
// 此处保留分类下拉选项的 computed 包装，便于模板直接遍历
// （categories 为 ref，模板中需 .value，此处不再额外包装 computed）

/**
 * 品质边框 / 光晕 / 文字色与中文标签：一律取服务端 game_balance.item_qualities
 * （见 composables/useItemQualities.js）。这里以前自己抄了一份五档 + unknown 的字典，
 * mythic 压根不在表里 —— 神话档物品在背包里只能退成中性色的"未知"，
 * 而另外几份抄写漏同一档时干脆印成"普通"；资料片加一档也全都不会跟着变。
 */
const { styleOf: getQualityStyle } = useItemQualities()

// ====== 类型中文名映射已迁移至上方响应式变量 itemTypeMap（从后端拉取） ======

/**
 * 获取物品类型中文名
 * 优先使用后端配置的 itemTypeMap，未匹配时返回"其他"
 * @param type - 物品类型
 */
const getTypeName = (type) => {
  return itemTypeMap.value[type] || '其他'
}

/**
 * 已知物品类型列表（基于后端 item_types 配置动态生成）
 * 用于"其他"分类筛选：不属于已知类型的物品归入"其他"
 */
const knownItemTypes = computed(() => Object.keys(itemTypeMap.value))

/**
 * 判断物品是否属于当前选中的分类
 * 当选中 other 时，匹配不在已知类型列表中的物品
 */
const filteredItems = computed(() => {
  if (activeCategory.value === 'all') {
    return items.value
  }
  if (activeCategory.value === 'other') {
    // 其他：不属于后端已知类型的物品
    return items.value.filter(item => !knownItemTypes.value.includes(item.type))
  }
  return items.value.filter(item => item.type === activeCategory.value)
})

/**
 * 获取背包数据
 * 调用后端 GET /inventory 接口
 */
const fetchInventory = async () => {
  loading.value = true
  try {
    const res = await getInventory()
    // 后端返回 { code, data: { items, total_count, capacity } }
    const data = res.data?.data || res.data || {}
    items.value = data.items || []
    totalCount.value = data.total_count || 0
    capacity.value = data.capacity || 0
  } catch (error) {
    console.error('获取背包数据失败:', error)
    uiStore.showApiError(error, '获取背包数据失败')
  } finally {
    loading.value = false
  }
}

/**
 * 切换物品操作菜单展开状态
 * @param item - 物品对象
 */
const toggleItemMenu = (item) => {
  if (expandedItemKey.value === item.item_key) {
    expandedItemKey.value = null
  } else {
    expandedItemKey.value = item.item_key
  }
}

/**
 * 这张卡点开会给出哪些操作 —— 与下面操作菜单里三个按钮的 v-if 条件严格一致。
 * 判定只写在这一处，卡面提示和真按钮不会各说一套。
 * @param {Object} item
 * @returns {string[]}
 */
const itemActionLabels = (item) => {
  const labels = []
  if (item.usable) labels.push('使用')
  if (item.type === 'equipment') labels.push('穿戴')
  labels.push('丢弃')
  return labels
}

/**
 * 打开数量选择弹窗（使用物品）
 * @param item - 物品对象
 */
const openUseModal = (item) => {
  if (!item.usable) {
    uiStore.showToast('该物品不可使用', 'info')
    return
  }
  quantityModal.value = {
    show: true,
    type: 'use',
    item,
    quantity: 1
  }
}

/**
 * 打开数量选择弹窗（丢弃物品）
 * @param item - 物品对象
 */
const openDiscardModal = (item) => {
  quantityModal.value = {
    show: true,
    type: 'discard',
    item,
    quantity: 1
  }
}

/**
 * 关闭数量选择弹窗
 */
const closeQuantityModal = () => {
  quantityModal.value.show = false
  quantityModal.value.item = null
  quantityModal.value.quantity = 1
}

/**
 * 数量增减（限制在 1 ~ 物品持有数量之间）
 * @param delta - 变化量
 */
const changeQuantity = (delta) => {
  const max = quantityModal.value.item?.quantity || 1
  let next = quantityModal.value.quantity + delta
  if (next < 1) next = 1
  if (next > max) next = max
  // 使用物品后端限制 1 ~ maxUseQuantity（从后端 inventory.max_use_quantity 拉取）
  if (quantityModal.value.type === 'use' && next > maxUseQuantity.value) next = maxUseQuantity.value
  quantityModal.value.quantity = next
}

/**
 * 数量弹窗确认回调：
 *   - 使用物品：直接调用后端接口
 *   - 丢弃物品：先弹出确认框（避免误操作）
 */
const confirmQuantity = () => {
  const { type, item, quantity } = quantityModal.value
  if (!item) return

  if (type === 'use') {
    // 使用物品直接执行
    closeQuantityModal()
    handleUse(item, quantity)
  } else {
    // 丢弃物品需要二次确认，避免误删珍贵物品
    const pendingItem = item
    const pendingQty = quantity
    closeQuantityModal()
    confirmModal.value = {
      show: true,
      item: pendingItem,
      quantity: pendingQty
    }
  }
}

/**
 * 关闭确认弹窗
 */
const closeConfirmModal = () => {
  confirmModal.value.show = false
  confirmModal.value.item = null
  confirmModal.value.quantity = 1
}

/**
 * 执行使用物品操作
 * 调用后端 POST /inventory/use，成功后刷新背包与玩家状态
 * @param item - 物品对象
 * @param quantity - 使用数量
 */
const handleUse = async (item, quantity) => {
  if (operating.value) return
  operating.value = true
  try {
    const res = await useItem(item.item_key, quantity)
    const result = res.data || {}
    uiStore.showToast(result.message || `使用了 ${item.name} x${quantity}`, 'success')

    // 同步更新玩家状态（气血/灵力/灵石）——走统一契约，别名由 patchFromResponse 归一
    patchFromResponse(result)

    // 写入游戏日志
    uiStore.addLog({
      content: `你使用了 ${item.name} x${quantity}。`,
      type: 'item',
      actorId: 'self'
    })

    // 收起操作菜单并刷新背包
    expandedItemKey.value = null
    await fetchInventory()
  } catch (error) {
    uiStore.showApiError(error, '使用失败')
  } finally {
    operating.value = false
  }
}

/**
 * 执行丢弃物品操作
 * 调用后端 POST /inventory/discard，成功后刷新背包
 */
const handleDiscard = async () => {
  const { item, quantity } = confirmModal.value
  if (!item) return
  if (operating.value) return
  operating.value = true
  try {
    const res = await discardItem(item.item_key, quantity)
    const result = res.data || {}
    uiStore.showToast(result.message || `丢弃了 ${item.name} x${quantity}`, 'success')

    uiStore.addLog({
      content: `你丢弃了 ${item.name} x${quantity}。`,
      type: 'item',
      actorId: 'self'
    })

    closeConfirmModal()
    expandedItemKey.value = null
    await fetchInventory()
  } catch (error) {
    uiStore.showApiError(error, '丢弃失败')
  } finally {
    operating.value = false
  }
}

/**
 * 拼接物品效果描述文本（用于卡片底部展示）
 * 兼容消耗品效果（hp_restore/mp_restore 等）和装备属性（atk/def/hp_max 等）
 *
 * 标签与后缀一律来自服务端词表（属性注册表 + 物品效果词表，含资料片），
 * 这里不再抄一份"键名→中文"的映射：以前资料片给武器加个剑意，卡片上就会露出原始键名。
 * @param effect - 物品效果对象
 */
const formatEffectText = (effect) => {
  if (!effect || Object.keys(effect).length === 0) return ''
  const parts = []
  for (const [key, value] of Object.entries(effect)) {
    // 仅处理数值型属性，跳过非数值字段
    if (typeof value !== 'number') continue
    parts.push(formatBonus(key, value))
  }
  return parts.join('  ')
}

// ====== 装备栏相关函数 ======

/**
 * 装备栏展示列表（合并槽位配置与已装备物品，便于模板遍历）
 * 每个元素包含 slot/label/item，item 为 null 时表示空槽位
 */
const slotDisplayList = computed(() => {
  return equipmentSlotsConfig.value.map(config => ({
    ...config,
    item: equippedSlots.value[config.slot] || null
  }))
})

/**
 * 获取已装备物品列表
 * 调用后端 GET /equipment 接口，更新装备栏槽位数据
 */
const fetchEquipped = async () => {
  equipmentLoading.value = true
  try {
    const res = await getEquipped()
    // 后端返回 { code, data: { slots, count } }
    const data = res.data?.data || res.data || {}
    equippedSlots.value = data.slots || {}
  } catch (error) {
    console.error('获取装备栏数据失败:', error)
    uiStore.showApiError(error, '获取装备栏数据失败')
  } finally {
    equipmentLoading.value = false
  }
}

/**
 * 获取装备总加成
 * 调用后端 GET /equipment/bonus 接口
 */
const fetchEquipmentBonus = async () => {
  try {
    const res = await getEquipmentBonus()
    const data = res.data?.data || res.data || {}
    equipmentBonus.value = data || {}
  } catch (error) {
    console.error('获取装备加成失败:', error)
  }
}

/**
 * 打开穿戴确认弹窗
 * @param item - 待穿戴的装备物品
 */
const openEquipConfirmModal = (item) => {
  equipConfirmModal.value = {
    show: true,
    item
  }
}

/**
 * 关闭穿戴确认弹窗
 */
const closeEquipConfirmModal = () => {
  equipConfirmModal.value.show = false
  equipConfirmModal.value.item = null
}

/**
 * 执行穿戴装备操作
 * 调用后端 POST /equipment/equip，成功后刷新背包、装备栏和装备加成
 * 业务说明：若该槽位已有装备，后端会自动卸下旧装备并归还背包
 */
const handleEquip = async () => {
  const { item } = equipConfirmModal.value
  if (!item) return
  if (operating.value) return
  operating.value = true
  try {
    const res = await equipItem(item.item_key)
    const result = res.data || {}
    uiStore.showToast(result.message || `成功穿戴 ${item.name}`, 'success')

    // 若替换了旧装备，额外提示玩家
    if (result.unequipped) {
      uiStore.showToast(`已自动卸下 ${result.unequipped.name}`, 'info', 3000)
    }

    // 写入游戏日志
    uiStore.addLog({
      content: `你穿戴了 ${item.name}（${result.slot_name || ''}）。`,
      type: 'item',
      actorId: 'self'
    })

    // 收起操作菜单并刷新背包、装备栏、加成和玩家属性
    closeEquipConfirmModal()
    expandedItemKey.value = null
    await Promise.all([fetchInventory(), fetchEquipped(), fetchEquipmentBonus(), playerStore.scheduleFetchPlayer(0)])
  } catch (error) {
    uiStore.showApiError(error, '穿戴失败')
  } finally {
    operating.value = false
  }
}

/**
 * 打开卸下确认弹窗
 * @param slot - 待卸下的槽位标识
 */
const openUnequipConfirmModal = (slot) => {
  const item = equippedSlots.value[slot]
  if (!item) return
  unequipConfirmModal.value = {
    show: true,
    slot,
    item
  }
}

/**
 * 关闭卸下确认弹窗
 */
const closeUnequipConfirmModal = () => {
  unequipConfirmModal.value.show = false
  unequipConfirmModal.value.slot = ''
  unequipConfirmModal.value.item = null
}

/**
 * 执行卸下装备操作
 * 调用后端 POST /equipment/unequip，成功后刷新背包、装备栏和装备加成
 * 业务说明：卸下后装备归还背包，若背包容量不足后端会返回错误
 */
const handleUnequip = async () => {
  const { slot, item } = unequipConfirmModal.value
  if (!slot || !item) return
  if (operating.value) return
  operating.value = true
  try {
    const res = await unequipItem(slot)
    const result = res.data || {}
    uiStore.showToast(result.message || `已卸下 ${item.name}`, 'success')

    // 写入游戏日志
    uiStore.addLog({
      content: `你卸下了 ${item.name}（${result.slot_name || ''}）。`,
      type: 'item',
      actorId: 'self'
    })

    // 关闭弹窗并刷新背包、装备栏、加成和玩家属性
    closeUnequipConfirmModal()
    await Promise.all([fetchInventory(), fetchEquipped(), fetchEquipmentBonus(), playerStore.scheduleFetchPlayer(0)])
  } catch (error) {
    uiStore.showApiError(error, '卸下失败')
  } finally {
    operating.value = false
  }
}

/**
 * 拉取公开游戏配置（装备槽位、物品类型映射、分类 tabs、使用数量上限）
 * 失败时降级使用响应式变量的默认值，不影响面板基础功能
 */
const fetchGameConfig = async () => {
  try {
    const res = await getGameBalancePublic()
    if (res.data?.code === 200 && res.data.data) {
      const cfg = res.data.data
      // 装备槽位：合并 valid_slots 顺序与 slot_names 中文名
      if (cfg.equipment?.valid_slots?.length) {
        equipmentSlotsConfig.value = cfg.equipment.valid_slots.map(slot => ({
          slot,
          label: cfg.equipment.slot_names?.[slot] || slot
        }))
      }
      // 物品类型中文名映射
      if (cfg.item_types) {
        itemTypeMap.value = cfg.item_types
      }
      // 背包分类 tabs（后端配置优先，缺失时保留默认降级值）
      if (cfg.item_categories?.length) {
        categories.value = cfg.item_categories
      }
      // 使用物品单次最大数量
      if (cfg.inventory?.max_use_quantity) {
        maxUseQuantity.value = cfg.inventory.max_use_quantity
      }
    }
  } catch (error) {
    console.error('[InventoryPanel] 拉取游戏配置失败，使用降级默认值:', error)
  }
}

onMounted(() => {
  // 并行获取背包、装备栏、装备加成、游戏配置，减少首屏等待时间
  Promise.all([
    fetchInventory(),
    fetchEquipped(),
    fetchEquipmentBonus(),
    fetchGameConfig()
  ])
})
</script>

<template>
  <PanelShell
    title="储物袋"
    hint="装备 · 使用 · 丢弃"
    size="xl"
    scoped-scroll
    fill
    @close="emit('close')"
  >
    <!-- 容量：原先占在标题行，现收进外壳的 header-actions -->
    <template #header-actions>
      <div class="flex items-center gap-2">
        <div class="hidden sm:block w-28">
          <StatBar :value="totalCount" :max="capacity" tone="gold" height="h-1.5" :show-value="false" />
        </div>
        <Badge tone="gold">{{ totalCount }} / {{ capacity }}</Badge>
      </div>
    </template>

    <div class="h-full flex flex-col min-h-0">
      <!-- 分类筛选 tabs -->
      <Tabs v-model="activeCategory" :items="categories" class="shrink-0" />

      <!-- 装备栏区域：展示各装备槽位及装备总加成 -->
      <div class="shrink-0 border-b border-line-subtle bg-surface-raised p-3">
        <div class="flex items-center justify-between gap-3 mb-2 flex-wrap">
          <h3 class="text-[13px] font-bold text-gold-500 tracking-wide font-display">装备栏</h3>
          <!-- 装备总加成（可选展示，有加成时才显示） -->
          <div v-if="formatEffectText(equipmentBonus)" class="text-[10px] text-sky-300">
            总加成：{{ formatEffectText(equipmentBonus) }}
          </div>
        </div>
        <!-- 装备槽位 -->
        <div class="grid grid-cols-5 gap-2">
          <div
            v-for="slotInfo in slotDisplayList"
            :key="slotInfo.slot"
            class="bg-surface-canvas border rounded-control p-2 transition-all"
            :class="slotInfo.item
              ? [getQualityStyle(slotInfo.item.quality).border, getQualityStyle(slotInfo.item.quality).glow]
              : 'border-line-subtle'"
          >
            <!-- 槽位名称 -->
            <div class="text-[10px] text-fg-faint mb-1 text-center">{{ slotInfo.label }}</div>
            <!-- 已装备物品 -->
            <div v-if="slotInfo.item" class="text-center">
              <div class="text-xs font-bold truncate" :class="getQualityStyle(slotInfo.item.quality).text" :title="slotInfo.item.name">
                {{ slotInfo.item.name }}
              </div>
              <div class="text-[9px] text-sky-300 mt-0.5 line-clamp-1" :title="formatEffectText(slotInfo.item.effect)">
                {{ formatEffectText(slotInfo.item.effect) }}
              </div>
              <button
                @click="openUnequipConfirmModal(slotInfo.slot)"
                :disabled="operating"
                class="mt-1 w-full px-2 py-0.5 rounded-control text-[10px] bg-rose-900/30 border border-rose-800 text-rose-300 hover:bg-rose-800/50 hover:text-rose-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                卸下
              </button>
            </div>
            <!-- 空槽位 -->
            <div v-else class="text-center py-2">
              <span class="text-xs text-fg-faint">无</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 物品列表区域 -->
      <div class="flex-1 min-h-0 overflow-y-auto p-4">
        <LoadingBlock v-if="loading" />

        <!-- 空状态 -->
        <EmptyState
          v-else-if="filteredItems.length === 0"
          :text="activeCategory === 'all' ? '储物袋空空如也' : '该分类下暂无物品'"
          :hint="activeCategory === 'all' ? '去历练、炼制与坊市，慢慢就攒下了' : '换个分类看看，或切回「全部」'"
        />

        <!-- 物品网格 -->
        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <div
            v-for="item in filteredItems"
            :key="item.item_key"
            class="bg-surface-raised border rounded-panel overflow-hidden transition-all hover:shadow-lg"
            :class="[
              getQualityStyle(item.quality).border,
              getQualityStyle(item.quality).glow,
              expandedItemKey === item.item_key ? 'ring-1 ring-gold-700/60' : ''
            ]"
          >
            <!-- 物品卡片头部：点击展开操作菜单。
                 原来是一个只写了 cursor-pointer 的 div —— 面板副标题明明写着
                 "装备 · 使用 · 丢弃"，卡面上却没有任何一处说这行字从哪儿来，
                 玩家只能靠猜；而 div 拿不到焦点，纯键盘玩家根本用不了物品。
                 现在补 role/tabindex/回车空格 + 一行写明"点开会得到哪些操作"。 -->
            <div
              class="p-3 cursor-pointer focus-ring rounded-t"
              role="button"
              tabindex="0"
              :aria-expanded="expandedItemKey === item.item_key ? 'true' : 'false'"
              :aria-label="`${item.name}，展开操作`"
              @click="toggleItemMenu(item)"
              @keydown.enter.prevent="toggleItemMenu(item)"
              @keydown.space.prevent="toggleItemMenu(item)"
            >
              <div class="flex justify-between items-start mb-2">
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-bold truncate" :class="getQualityStyle(item.quality).text">
                    {{ item.name }}
                  </h4>
                  <div class="flex items-center gap-2 mt-1">
                    <Badge tone="neutral">{{ getTypeName(item.type) }}</Badge>
                    <span class="text-[10px] px-1.5 py-0.5 rounded border bg-surface-sunken" :class="getQualityStyle(item.quality).text + ' border-current'">
                      {{ getQualityStyle(item.quality).label }}
                    </span>
                  </div>
                </div>
                <div class="text-right ml-2">
                  <div class="text-lg font-bold text-gold-400 num">x{{ item.quantity }}</div>
                  <div class="text-[10px] text-fg-faint num" :title="item.price">{{ formatCompact(item.price) }} 灵石</div>
                </div>
              </div>
              <!-- 物品描述 -->
              <p class="text-xs text-fg-muted line-clamp-2 leading-relaxed">{{ item.description }}</p>
              <!-- 物品效果 -->
              <p v-if="formatEffectText(item.effect)" class="text-[11px] text-sky-300 mt-1.5">
                {{ formatEffectText(item.effect) }}
              </p>
              <!-- 展开提示：把"点开会看到哪些操作"直接写在卡面上 -->
              <div class="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-line-subtle/60">
                <span class="text-[10px] text-fg-faint">{{ itemActionLabels(item).join(' · ') }}</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     class="shrink-0 text-fg-faint transition-transform duration-200"
                     :class="expandedItemKey === item.item_key ? 'rotate-180' : ''" aria-hidden="true">
                  <path d="m6 9 6 6 6-6"/>
                </svg>
              </div>
            </div>

            <!-- 操作菜单（点击展开） -->
            <div
              v-if="expandedItemKey === item.item_key"
              class="px-3 py-2 border-t border-line-subtle bg-surface-canvas flex gap-2 animate-fade-in"
            >
              <button
                v-if="item.usable"
                @click.stop="openUseModal(item)"
                :disabled="operating"
                class="flex-1 px-3 py-1.5 rounded-control text-xs bg-emerald-900/30 border border-emerald-800 text-emerald-300 hover:bg-emerald-800/50 hover:text-emerald-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                使用
              </button>
              <!-- 装备物品显示"穿戴"按钮（替代"使用"） -->
              <button
                v-if="item.type === 'equipment'"
                @click.stop="openEquipConfirmModal(item)"
                :disabled="operating"
                class="flex-1 px-3 py-1.5 rounded-control text-xs bg-gold-900/30 border border-gold-700 text-gold-400 hover:bg-gold-800/50 hover:text-gold-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                穿戴
              </button>
              <button
                @click.stop="openDiscardModal(item)"
                :disabled="operating"
                class="flex-1 px-3 py-1.5 rounded-control text-xs bg-rose-900/30 border border-rose-800 text-rose-300 hover:bg-rose-800/50 hover:text-rose-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                丢弃
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 数量选择弹窗（自定义 Modal，替代浏览器原生 prompt） -->
    <Modal
      :isOpen="quantityModal.show"
      :title="quantityModal.type === 'use' ? '使用物品' : '丢弃物品'"
      @close="closeQuantityModal"
      width="420px"
    >
      <div class="space-y-4" v-if="quantityModal.item">
        <p class="text-fg-secondary">
          {{ quantityModal.type === 'use' ? '请选择要使用的数量' : '请选择要丢弃的数量' }}
        </p>
        <div class="flex items-center gap-3 bg-surface-raised p-3 rounded-control border border-line-subtle">
          <div class="flex-1">
            <div class="text-sm font-bold" :class="getQualityStyle(quantityModal.item.quality).text">
              {{ quantityModal.item.name }}
            </div>
            <div class="text-xs text-fg-muted mt-0.5">持有 {{ quantityModal.item.quantity }} 个</div>
          </div>
        </div>
        <!-- 数量调节器 -->
        <div class="flex items-center justify-center gap-4">
          <button
            @click="changeQuantity(-1)"
            class="w-10 h-10 rounded-control bg-surface-hover hover:bg-surface-active text-fg-secondary text-xl font-bold transition-colors"
          >-</button>
          <input
            v-model.number="quantityModal.quantity"
            type="number"
            min="1"
            :max="quantityModal.type === 'use' ? Math.min(maxUseQuantity, quantityModal.item.quantity) : quantityModal.item.quantity"
            class="w-24 text-center bg-surface-sunken border border-line rounded-control py-2 text-gold-400 font-bold text-lg num focus:outline-none focus:border-gold-700"
          />
          <button
            @click="changeQuantity(1)"
            class="w-10 h-10 rounded-control bg-surface-hover hover:bg-surface-active text-fg-secondary text-xl font-bold transition-colors"
          >+</button>
        </div>
        <!-- 快捷按钮 -->
        <div class="flex justify-center gap-2">
          <AppButton size="sm" variant="default" @click="quantityModal.quantity = 1">最小</AppButton>
          <AppButton
            size="sm"
            variant="default"
            @click="quantityModal.quantity = quantityModal.type === 'use' ? Math.min(maxUseQuantity, quantityModal.item.quantity) : quantityModal.item.quantity"
          >最大</AppButton>
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" @click="closeQuantityModal">取消</AppButton>
        <AppButton
          :variant="quantityModal.type === 'use' ? 'primary' : 'danger'"
          :disabled="operating"
          @click="confirmQuantity"
        >
          {{ operating ? '处理中…' : '确认' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 确认丢弃弹窗（自定义 Modal，替代浏览器原生 confirm） -->
    <Modal
      :isOpen="confirmModal.show"
      title="确认丢弃"
      @close="closeConfirmModal"
      width="420px"
    >
      <div class="space-y-4" v-if="confirmModal.item">
        <div class="flex items-center gap-3 text-rose-300">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <p class="text-lg font-bold">丢弃后无法恢复</p>
        </div>
        <p class="text-fg-secondary">
          确定要丢弃
          <span class="font-bold" :class="getQualityStyle(confirmModal.item.quality).text">
            {{ confirmModal.item.name }}
          </span>
          x{{ confirmModal.quantity }} 吗？
        </p>
        <p class="text-xs text-fg-muted">提示：珍贵的物品请谨慎丢弃，丢弃后无法找回。</p>
      </div>
      <template #footer>
        <AppButton variant="default" @click="closeConfirmModal">取消</AppButton>
        <AppButton variant="danger" :disabled="operating" @click="handleDiscard">
          {{ operating ? '丢弃中…' : '确认丢弃' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 穿戴确认弹窗（自定义 Modal，替代浏览器原生 confirm） -->
    <Modal
      :isOpen="equipConfirmModal.show"
      title="穿戴装备"
      @close="closeEquipConfirmModal"
      width="420px"
    >
      <div class="space-y-4" v-if="equipConfirmModal.item">
        <p class="text-fg-secondary">确定要穿戴以下装备吗？</p>
        <!-- 待穿戴装备信息 -->
        <div class="flex items-center gap-3 bg-surface-raised p-3 rounded-control border border-line-subtle">
          <div class="flex-1">
            <div class="text-sm font-bold" :class="getQualityStyle(equipConfirmModal.item.quality).text">
              {{ equipConfirmModal.item.name }}
            </div>
            <div v-if="formatEffectText(equipConfirmModal.item.effect)" class="text-xs text-sky-300 mt-1">
              {{ formatEffectText(equipConfirmModal.item.effect) }}
            </div>
          </div>
        </div>
        <!-- 提示：若该槽位已有装备，将被自动替换 -->
        <p class="text-xs text-fg-muted">
          提示：若对应槽位已有装备，将自动卸下旧装备并归还储物袋。
        </p>
      </div>
      <template #footer>
        <AppButton variant="default" @click="closeEquipConfirmModal">取消</AppButton>
        <AppButton variant="primary" :disabled="operating" @click="handleEquip">
          {{ operating ? '穿戴中…' : '确认穿戴' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 卸下确认弹窗（自定义 Modal，替代浏览器原生 confirm） -->
    <Modal
      :isOpen="unequipConfirmModal.show"
      title="卸下装备"
      @close="closeUnequipConfirmModal"
      width="420px"
    >
      <div class="space-y-4" v-if="unequipConfirmModal.item">
        <p class="text-fg-secondary">确定要卸下以下装备吗？</p>
        <!-- 待卸下装备信息 -->
        <div class="flex items-center gap-3 bg-surface-raised p-3 rounded-control border border-line-subtle">
          <div class="flex-1">
            <div class="text-sm font-bold" :class="getQualityStyle(unequipConfirmModal.item.quality).text">
              {{ unequipConfirmModal.item.name }}
            </div>
            <div class="text-xs text-fg-muted mt-0.5">
              槽位：{{ unequipConfirmModal.item.slot_name || unequipConfirmModal.slot }}
            </div>
            <div v-if="formatEffectText(unequipConfirmModal.item.effect)" class="text-xs text-sky-300 mt-1">
              {{ formatEffectText(unequipConfirmModal.item.effect) }}
            </div>
          </div>
        </div>
        <!-- 提示：卸下后装备归还背包，需保证背包有剩余容量 -->
        <p class="text-xs text-fg-muted">
          提示：卸下后装备将归还储物袋，请确保储物袋有剩余容量。
        </p>
      </div>
      <template #footer>
        <AppButton variant="default" @click="closeUnequipConfirmModal">取消</AppButton>
        <AppButton variant="primary" :disabled="operating" @click="handleUnequip">
          {{ operating ? '卸下中…' : '确认卸下' }}
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
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
