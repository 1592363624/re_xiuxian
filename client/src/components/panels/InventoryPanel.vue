<script setup>
/**
 * 储物袋（背包）面板组件
 *
 * 功能说明：
 *   - 全屏遮罩 + 居中弹窗布局，参考 GatheringPanel 的 close 事件机制
 *   - 顶部标题与容量显示（已用 / 总容量）
 *   - 装备栏区域：展示 5 个装备槽位（武器/护甲/饰品/靴子/法器）及装备总加成
 *   - 分类筛选 tabs：全部 / 丹药 / 材料 / 装备 / 其他
 *   - 物品网格列表，按品质颜色描边，展示名称、数量、描述
 *   - 点击物品卡片展开操作菜单：使用（消耗品）/ 穿戴（装备）/ 丢弃
 *   - 使用/丢弃时弹出数量选择框（自定义 Modal 组件，禁用浏览器原生 prompt）
 *   - 穿戴/卸下时弹出确认框（自定义 Modal 组件，禁用浏览器原生 confirm）
 *   - 所有业务逻辑通过 inventory/equipment API 调用后端，前端只做展示与交互
 *   - 操作成功后刷新背包/装备栏并通过 useUIStore 显示 toast 提示
 */
import { ref, computed, onMounted } from 'vue'
import Modal from '../common/Modal.vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { getInventory, useItem, discardItem } from '../../api/inventory'
import { getEquipped, equipItem, unequipItem, getEquipmentBonus } from '../../api/equipment'
import { getGameBalancePublic } from '../../api/config'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

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

// ====== 品质颜色映射 ======
// common 白 / uncommon 绿 / rare 蓝 / epic 紫 / legendary 橙
const qualityColorMap = {
  common: {
    border: 'border-stone-600',
    text: 'text-stone-300',
    glow: 'shadow-stone-900/30',
    label: '普通'
  },
  uncommon: {
    border: 'border-emerald-600',
    text: 'text-emerald-400',
    glow: 'shadow-emerald-900/40',
    label: '非凡'
  },
  rare: {
    border: 'border-blue-600',
    text: 'text-blue-400',
    glow: 'shadow-blue-900/40',
    label: '稀有'
  },
  epic: {
    border: 'border-purple-600',
    text: 'text-purple-400',
    glow: 'shadow-purple-900/40',
    label: '史诗'
  },
  legendary: {
    border: 'border-amber-600',
    text: 'text-amber-400',
    glow: 'shadow-amber-900/50',
    label: '传说'
  },
  unknown: {
    border: 'border-stone-700',
    text: 'text-stone-500',
    glow: 'shadow-stone-900/30',
    label: '未知'
  }
}

// ====== 类型中文名映射已迁移至上方响应式变量 itemTypeMap（从后端拉取） ======

/**
 * 获取品质对应的样式配置
 * @param quality - 品质 key
 */
const getQualityStyle = (quality) => {
  return qualityColorMap[quality] || qualityColorMap.unknown
}

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
 * 容量使用百分比（用于容量条展示）
 */
const capacityPercent = computed(() => {
  if (capacity.value <= 0) return 0
  return Math.min(100, Math.round((totalCount.value / capacity.value) * 100))
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
    uiStore.showToast('获取储物袋数据失败', 'error')
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

    // 同步更新玩家状态（气血/灵力/灵石）
    if (result.player) {
      if (result.player.hp_current !== undefined) {
        playerStore.player.hp_current = result.player.hp_current
      }
      if (result.player.mp_current !== undefined) {
        playerStore.player.mp_current = result.player.mp_current
      }
      if (result.player.spirit_stones !== undefined) {
        playerStore.player.spirit_stones = result.player.spirit_stones
      }
    }

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
    const msg = error.response?.data?.error || error.response?.data?.message || '使用失败'
    uiStore.showToast(msg, 'error')
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
    const msg = error.response?.data?.error || error.response?.data?.message || '丢弃失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 拼接物品效果描述文本（用于卡片底部展示）
 * 兼容消耗品效果（hp_restore/mp_restore 等）和装备属性（atk/def/hp_max 等）
 * @param effect - 物品效果对象
 */
const formatEffectText = (effect) => {
  if (!effect || Object.keys(effect).length === 0) return ''
  // 属性中文名映射（覆盖消耗品与装备所有属性）
  const attrNameMap = {
    atk: '攻击',
    def: '防御',
    hp_max: '气血上限',
    mp_max: '灵力上限',
    speed: '身法',
    sense: '感知',
    luck: '气运',
    cultivate_speed: '修炼速度',
    hp_restore: '气血恢复',
    mp_restore: '灵力恢复',
    spirit_stones: '灵石',
    exp: '修为',
    breakthrough_bonus: '突破加成'
  }
  const parts = []
  for (const [key, value] of Object.entries(effect)) {
    // 仅处理数值型属性，跳过非数值字段
    if (typeof value !== 'number') continue
    const name = attrNameMap[key] || key
    // 突破加成为百分比形式
    if (key === 'breakthrough_bonus') {
      parts.push(`${name}+${(value * 100).toFixed(1)}%`)
    } else {
      parts.push(`${name}+${value}`)
    }
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
    uiStore.showToast('获取装备栏数据失败', 'error')
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

    // 收起操作菜单并刷新背包、装备栏和加成
    closeEquipConfirmModal()
    expandedItemKey.value = null
    await Promise.all([fetchInventory(), fetchEquipped(), fetchEquipmentBonus()])
  } catch (error) {
    const msg = error.response?.data?.error || error.response?.data?.message || '穿戴失败'
    uiStore.showToast(msg, 'error')
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

    // 关闭弹窗并刷新背包、装备栏和加成
    closeUnequipConfirmModal()
    await Promise.all([fetchInventory(), fetchEquipped(), fetchEquipmentBonus()])
  } catch (error) {
    const msg = error.response?.data?.error || error.response?.data?.message || '卸下失败'
    uiStore.showToast(msg, 'error')
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
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- 遮罩层：点击关闭面板 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>

    <!-- 主容器 -->
    <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
      <!-- 顶部标题栏 -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-500 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
            <path d="M3 6h18"/>
            <path d="M16 10a4 4 0 0 1-8 0"/>
          </svg>
          储物袋
        </h2>
        <div class="flex items-center gap-4">
          <!-- 容量显示 -->
          <div class="flex items-center gap-2">
            <div class="w-32 h-2 bg-stone-900 rounded-full overflow-hidden">
              <div
                class="h-full bg-gradient-to-r from-amber-600 to-amber-400 transition-all duration-500"
                :style="{ width: capacityPercent + '%' }"
              ></div>
            </div>
            <span class="text-xs text-stone-400 whitespace-nowrap">
              {{ totalCount }} / {{ capacity }}
            </span>
          </div>
          <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <!-- 分类筛选 tabs -->
      <div class="flex items-center gap-1 p-3 border-b border-stone-800 bg-[#0c0a09] overflow-x-auto">
        <button
          v-for="cat in categories"
          :key="cat.key"
          @click="activeCategory = cat.key"
          class="px-4 py-1.5 rounded text-sm whitespace-nowrap transition-colors"
          :class="activeCategory === cat.key
            ? 'bg-amber-900/30 text-amber-400 border border-amber-700/50'
            : 'text-stone-500 hover:text-stone-300 border border-transparent'"
        >
          {{ cat.label }}
        </button>
      </div>

      <!-- 装备栏区域：展示 5 个装备槽位及装备总加成 -->
      <div class="border-b border-stone-800 bg-[#1c1917] p-3">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-bold text-amber-500 flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            装备栏
          </h3>
          <!-- 装备总加成（可选展示，有加成时才显示） -->
          <div v-if="formatEffectText(equipmentBonus)" class="text-[10px] text-cyan-400">
            总加成：{{ formatEffectText(equipmentBonus) }}
          </div>
        </div>
        <!-- 5 个装备槽位 -->
        <div class="grid grid-cols-5 gap-2">
          <div
            v-for="slotInfo in slotDisplayList"
            :key="slotInfo.slot"
            class="bg-[#0c0a09] border rounded p-2 transition-all"
            :class="slotInfo.item
              ? [getQualityStyle(slotInfo.item.quality).border, getQualityStyle(slotInfo.item.quality).glow]
              : 'border-stone-800'"
          >
            <!-- 槽位名称 -->
            <div class="text-[10px] text-stone-500 mb-1 text-center">{{ slotInfo.label }}</div>
            <!-- 已装备物品 -->
            <div v-if="slotInfo.item" class="text-center">
              <div class="text-xs font-bold truncate" :class="getQualityStyle(slotInfo.item.quality).text" :title="slotInfo.item.name">
                {{ slotInfo.item.name }}
              </div>
              <div class="text-[9px] text-cyan-400 mt-0.5 line-clamp-1" :title="formatEffectText(slotInfo.item.effect)">
                {{ formatEffectText(slotInfo.item.effect) }}
              </div>
              <button
                @click="openUnequipConfirmModal(slotInfo.slot)"
                :disabled="operating"
                class="mt-1 w-full px-2 py-0.5 rounded text-[10px] bg-red-900/30 border border-red-700/50 text-red-400 hover:bg-red-800/50 hover:text-red-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                卸下
              </button>
            </div>
            <!-- 空槽位 -->
            <div v-else class="text-center py-2">
              <span class="text-xs text-stone-600">无</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 物品列表区域 -->
      <div class="flex-1 overflow-y-auto p-4">
        <!-- 加载中 -->
        <div v-if="loading" class="flex justify-center items-center h-64">
          <svg class="animate-spin h-10 w-10 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>

        <!-- 空状态 -->
        <div v-else-if="filteredItems.length === 0" class="flex flex-col items-center justify-center h-64 text-stone-500">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
            <path d="M3 6h18"/>
          </svg>
          <p v-if="activeCategory === 'all'">储物袋空空如也</p>
          <p v-else>该分类下暂无物品</p>
        </div>

        <!-- 物品网格 -->
        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <div
            v-for="item in filteredItems"
            :key="item.item_key"
            class="bg-[#1c1917] border rounded-lg overflow-hidden transition-all hover:shadow-lg"
            :class="[
              getQualityStyle(item.quality).border,
              getQualityStyle(item.quality).glow,
              expandedItemKey === item.item_key ? 'ring-1 ring-amber-700/50' : ''
            ]"
          >
            <!-- 物品卡片头部 -->
            <div
              class="p-3 cursor-pointer"
              @click="toggleItemMenu(item)"
            >
              <div class="flex justify-between items-start mb-2">
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-bold truncate" :class="getQualityStyle(item.quality).text">
                    {{ item.name }}
                  </h4>
                  <div class="flex items-center gap-2 mt-1">
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-stone-900 border border-stone-700 text-stone-400">
                      {{ getTypeName(item.type) }}
                    </span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded border" :class="getQualityStyle(item.quality).text + ' border-current'">
                      {{ getQualityStyle(item.quality).label }}
                    </span>
                  </div>
                </div>
                <div class="text-right ml-2">
                  <div class="text-lg font-bold text-amber-400">x{{ item.quantity }}</div>
                  <div class="text-[10px] text-stone-600">{{ item.price }} 灵石</div>
                </div>
              </div>
              <!-- 物品描述 -->
              <p class="text-xs text-stone-500 line-clamp-2 leading-relaxed">{{ item.description }}</p>
              <!-- 物品效果 -->
              <p v-if="formatEffectText(item.effect)" class="text-[11px] text-cyan-400 mt-1.5">
                {{ formatEffectText(item.effect) }}
              </p>
            </div>

            <!-- 操作菜单（点击展开） -->
            <div
              v-if="expandedItemKey === item.item_key"
              class="px-3 py-2 border-t border-stone-800 bg-[#0c0a09] flex gap-2 animate-fade-in"
            >
              <button
                v-if="item.usable"
                @click.stop="openUseModal(item)"
                :disabled="operating"
                class="flex-1 px-3 py-1.5 rounded text-xs bg-emerald-900/30 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                使用
              </button>
              <!-- 装备物品显示"穿戴"按钮（替代"使用"） -->
              <button
                v-if="item.type === 'equipment'"
                @click.stop="openEquipConfirmModal(item)"
                :disabled="operating"
                class="flex-1 px-3 py-1.5 rounded text-xs bg-amber-900/30 border border-amber-700/50 text-amber-400 hover:bg-amber-800/50 hover:text-amber-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                穿戴
              </button>
              <button
                @click.stop="openDiscardModal(item)"
                :disabled="operating"
                class="flex-1 px-3 py-1.5 rounded text-xs bg-red-900/30 border border-red-700/50 text-red-400 hover:bg-red-800/50 hover:text-red-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
        <p class="text-stone-300">
          {{ quantityModal.type === 'use' ? '请选择要使用的数量' : '请选择要丢弃的数量' }}
        </p>
        <div class="flex items-center gap-3 bg-[#1c1917] p-3 rounded border border-stone-800">
          <div class="flex-1">
            <div class="text-sm font-bold" :class="getQualityStyle(quantityModal.item.quality).text">
              {{ quantityModal.item.name }}
            </div>
            <div class="text-xs text-stone-500 mt-0.5">持有 {{ quantityModal.item.quantity }} 个</div>
          </div>
        </div>
        <!-- 数量调节器 -->
        <div class="flex items-center justify-center gap-4">
          <button
            @click="changeQuantity(-1)"
            class="w-10 h-10 rounded bg-stone-800 hover:bg-stone-700 text-stone-300 text-xl font-bold transition-colors"
          >-</button>
          <input
            v-model.number="quantityModal.quantity"
            type="number"
            min="1"
            :max="quantityModal.type === 'use' ? Math.min(maxUseQuantity, quantityModal.item.quantity) : quantityModal.item.quantity"
            class="w-24 text-center bg-stone-900 border border-stone-700 rounded py-2 text-amber-400 font-bold text-lg focus:outline-none focus:border-amber-600"
          />
          <button
            @click="changeQuantity(1)"
            class="w-10 h-10 rounded bg-stone-800 hover:bg-stone-700 text-stone-300 text-xl font-bold transition-colors"
          >+</button>
        </div>
        <!-- 快捷按钮 -->
        <div class="flex justify-center gap-2">
          <button
            @click="quantityModal.quantity = 1"
            class="px-3 py-1 text-xs rounded bg-stone-800 hover:bg-stone-700 text-stone-400 transition-colors"
          >最小</button>
          <button
            @click="quantityModal.quantity = quantityModal.type === 'use' ? Math.min(maxUseQuantity, quantityModal.item.quantity) : quantityModal.item.quantity"
            class="px-3 py-1 text-xs rounded bg-stone-800 hover:bg-stone-700 text-stone-400 transition-colors"
          >最大</button>
        </div>
      </div>
      <template #footer>
        <button
          @click="closeQuantityModal"
          class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
        >取消</button>
        <button
          @click="confirmQuantity"
          :disabled="operating"
          class="px-4 py-2 rounded text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :class="quantityModal.type === 'use'
            ? 'bg-emerald-600 hover:bg-emerald-500'
            : 'bg-red-600 hover:bg-red-500'"
        >
          {{ operating ? '处理中...' : '确认' }}
        </button>
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
        <div class="flex items-center gap-3 text-red-400">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <p class="text-lg font-bold">丢弃后无法恢复</p>
        </div>
        <p class="text-stone-300">
          确定要丢弃
          <span class="font-bold" :class="getQualityStyle(confirmModal.item.quality).text">
            {{ confirmModal.item.name }}
          </span>
          x{{ confirmModal.quantity }} 吗？
        </p>
        <p class="text-xs text-stone-500">提示：珍贵的物品请谨慎丢弃，丢弃后无法找回。</p>
      </div>
      <template #footer>
        <button
          @click="closeConfirmModal"
          class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
        >取消</button>
        <button
          @click="handleDiscard"
          :disabled="operating"
          class="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ operating ? '丢弃中...' : '确认丢弃' }}
        </button>
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
        <p class="text-stone-300">确定要穿戴以下装备吗？</p>
        <!-- 待穿戴装备信息 -->
        <div class="flex items-center gap-3 bg-[#1c1917] p-3 rounded border border-stone-800">
          <div class="flex-1">
            <div class="text-sm font-bold" :class="getQualityStyle(equipConfirmModal.item.quality).text">
              {{ equipConfirmModal.item.name }}
            </div>
            <div v-if="formatEffectText(equipConfirmModal.item.effect)" class="text-xs text-cyan-400 mt-1">
              {{ formatEffectText(equipConfirmModal.item.effect) }}
            </div>
          </div>
        </div>
        <!-- 提示：若该槽位已有装备，将被自动替换 -->
        <p class="text-xs text-stone-500">
          提示：若对应槽位已有装备，将自动卸下旧装备并归还储物袋。
        </p>
      </div>
      <template #footer>
        <button
          @click="closeEquipConfirmModal"
          class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
        >取消</button>
        <button
          @click="handleEquip"
          :disabled="operating"
          class="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ operating ? '穿戴中...' : '确认穿戴' }}
        </button>
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
        <p class="text-stone-300">确定要卸下以下装备吗？</p>
        <!-- 待卸下装备信息 -->
        <div class="flex items-center gap-3 bg-[#1c1917] p-3 rounded border border-stone-800">
          <div class="flex-1">
            <div class="text-sm font-bold" :class="getQualityStyle(unequipConfirmModal.item.quality).text">
              {{ unequipConfirmModal.item.name }}
            </div>
            <div class="text-xs text-stone-500 mt-0.5">
              槽位：{{ unequipConfirmModal.item.slot_name || unequipConfirmModal.slot }}
            </div>
            <div v-if="formatEffectText(unequipConfirmModal.item.effect)" class="text-xs text-cyan-400 mt-1">
              {{ formatEffectText(unequipConfirmModal.item.effect) }}
            </div>
          </div>
        </div>
        <!-- 提示：卸下后装备归还背包，需保证背包有剩余容量 -->
        <p class="text-xs text-stone-500">
          提示：卸下后装备将归还储物袋，请确保储物袋有剩余容量。
        </p>
      </div>
      <template #footer>
        <button
          @click="closeUnequipConfirmModal"
          class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
        >取消</button>
        <button
          @click="handleUnequip"
          :disabled="operating"
          class="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ operating ? '卸下中...' : '确认卸下' }}
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
