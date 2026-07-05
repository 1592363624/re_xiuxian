<script setup lang="ts">
/**
 * 法宝管理面板组件
 *
 * 功能说明：
 *   - 全屏遮罩 + 居中弹窗布局，emits('close') 关闭面板
 *   - 展示玩家所有已装备物品，含法宝深度系统字段（耐久/祭炼/本命/祭出）
 *   - 操作按钮：祭炼 / 修理 / 本命 / 散念 / 祭出 / 收回 / 调序
 *   - 底部：一键修理所有装备
 *   - 所有业务逻辑通过 equipment API 调用后端，前端只做展示与交互
 *   - 所有确认操作均使用自定义 Modal 二次确认
 *   - 禁用浏览器原生 alert / confirm
 *
 * 设计原则：
 *   - 前端不处理业务逻辑，仅做展示与接口调用
 *   - 状态变化通过重新拉取列表实现（不本地计算）
 *   - 操作按钮根据装备状态动态启用/禁用
 */
import { ref, computed, onMounted } from 'vue'
import Modal from '../common/Modal.vue'
import {
  getEquipped,
  refineItem,
  setBenming,
  summonTreasure,
  recallTreasure,
  adjustOrder,
  disperseSpirit,
  repairItem,
  repairAll,
  type EquippedItem
} from '../../api/equipment'
import { useUIStore } from '../../stores/ui'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ====== 响应式状态 ======
const loading = ref(true)
const operating = ref(false)
const slots = ref<Record<string, any>>({})
const count = ref(0)

// 确认弹窗状态
type ConfirmAction = 'refine' | 'benming' | 'summon' | 'recall' | 'disperse' | 'repair' | 'repairAll' | 'order'
const confirmModal = ref<{
  show: boolean
  action: ConfirmAction
  slot: string
  newOrder: number
}>({
  show: false,
  action: 'refine',
  slot: '',
  newOrder: 0
})

// 提示弹窗状态（用于操作结果反馈）
const toastModal = ref<{ show: boolean; message: string; isSuccess: boolean }>({
  show: false,
  message: '',
  isSuccess: true
})

// ====== 计算属性 ======

/**
 * 装备列表（按 slot 顺序排列）
 */
const equipmentList = computed(() => {
  const order = ['weapon', 'armor', 'accessory', 'boots', 'dharma']
  const result: any[] = []
  for (const slot of order) {
    if (slots.value[slot]) {
      result.push({ ...slots.value[slot], slot })
    }
  }
  // 加上其他未在固定顺序中的槽位
  for (const [slot, item] of Object.entries(slots.value)) {
    if (!order.includes(slot)) {
      result.push({ ...(item as any), slot })
    }
  }
  return result
})

/**
 * 本命法器列表
 */
const benmingList = computed(() => equipmentList.value.filter(e => e.is_benming))

/**
 * 是否有需要修理的装备
 */
const hasRepairable = computed(() =>
  equipmentList.value.some(e => e.durability < e.max_durability)
)

// ====== 方法 ======

/**
 * 拉取装备列表
 */
async function fetchEquipment() {
  loading.value = true
  try {
    const res = await getEquipped()
    const data = res.data?.data || res.data
    slots.value = data.slots || {}
    count.value = data.count || 0
  } catch (e: any) {
    showToast(e.message || '加载装备失败', false)
  } finally {
    loading.value = false
  }
}

/**
 * 显示提示消息
 */
function showToast(message: string, isSuccess: boolean = true) {
  toastModal.value = { show: true, message, isSuccess }
}

/**
 * 打开确认弹窗
 */
function openConfirm(action: ConfirmAction, slot: string = '', newOrder: number = 0) {
  confirmModal.value = { show: true, action, slot, newOrder }
}

/**
 * 确认弹窗标题
 */
const confirmTitle = computed(() => {
  const map: Record<ConfirmAction, string> = {
    refine: '祭炼确认',
    benming: '炼制本命确认',
    summon: '祭出法器确认',
    recall: '收回法器确认',
    disperse: '散念确认',
    repair: '修理确认',
    repairAll: '一键修理确认',
    order: '调整排序确认'
  }
  return map[confirmModal.value.action]
})

/**
 * 确认弹窗内容
 */
const confirmMessage = computed(() => {
  const item = equipmentList.value.find(e => e.slot === confirmModal.value.slot)
  const name = item?.name || item?.item_key || ''
  switch (confirmModal.value.action) {
    case 'refine':
      return `确认祭炼 ${name}？将消耗灵石与材料，成功提升祭炼等级，失败可能降级。`
    case 'benming':
      return `确认将 ${name} 炼制为本命法器？将消耗大量灵石与材料，绑定后无法直接卸下。`
    case 'summon':
      return `确认祭出 ${name}？祭出后用于战斗。`
    case 'recall':
      return `确认收回 ${name}？`
    case 'disperse':
      return `确认散念 ${name}？将解除本命绑定，回收部分材料。`
    case 'repair':
      return `确认修理 ${name}？将消耗灵石恢复耐久，并扣减最大耐久上限。`
    case 'repairAll':
      return '确认一键修理所有装备？将消耗灵石修理所有需要修理的装备。'
    case 'order':
      return `确认将 ${name} 排序调整为 ${confirmModal.value.newOrder}？`
    default:
      return ''
  }
})

/**
 * 执行确认操作
 */
async function handleConfirm() {
  const { action, slot, newOrder } = confirmModal.value
  confirmModal.value.show = false
  operating.value = true
  try {
    let res: any
    switch (action) {
      case 'refine':
        res = await refineItem(slot)
        break
      case 'benming':
        res = await setBenming(slot)
        break
      case 'summon':
        res = await summonTreasure(slot)
        break
      case 'recall':
        res = await recallTreasure(slot)
        break
      case 'disperse':
        res = await disperseSpirit(slot)
        break
      case 'repair':
        res = await repairItem(slot)
        break
      case 'repairAll':
        res = await repairAll()
        break
      case 'order':
        res = await adjustOrder(slot, newOrder)
        break
    }
    const data = res.data?.data || res.data
    const message = data?.message || res.data?.message || '操作成功'
    const isSuccess = data?.success !== false
    showToast(message, isSuccess)
    // 重新拉取装备列表
    await fetchEquipment()
  } catch (e: any) {
    showToast(e.message || '操作失败', false)
  } finally {
    operating.value = false
  }
}

/**
 * 耐久度颜色（根据百分比）
 */
function durabilityColor(durability: number, max: number): string {
  const pct = max > 0 ? durability / max : 0
  if (pct >= 0.7) return 'bg-green-500'
  if (pct >= 0.3) return 'bg-yellow-500'
  return 'bg-red-500'
}

/**
 * 品质颜色
 */
function qualityColor(quality: string): string {
  const map: Record<string, string> = {
    common: 'text-gray-300 border-gray-500',
    uncommon: 'text-green-300 border-green-500',
    rare: 'text-blue-300 border-blue-500',
    epic: 'text-purple-300 border-purple-500',
    legendary: 'text-orange-300 border-orange-500'
  }
  return map[quality] || map.common
}

onMounted(() => {
  fetchEquipment()
})
</script>

<template>
  <!-- 全屏遮罩 -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" @click.self="emit('close')">
    <!-- 主面板 -->
    <div class="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-700">
        <h2 class="text-xl font-bold text-amber-300">法宝管理</h2>
        <button
          class="text-gray-400 hover:text-white text-2xl leading-none"
          @click="emit('close')"
          aria-label="关闭"
        >×</button>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto p-6">
        <div v-if="loading" class="text-center text-gray-400 py-12">加载中...</div>

        <div v-else-if="equipmentList.length === 0" class="text-center text-gray-400 py-12">
          暂无装备，请先穿戴装备
        </div>

        <div v-else class="space-y-4">
          <!-- 装备卡片 -->
          <div
            v-for="item in equipmentList"
            :key="item.slot"
            class="border rounded-lg p-4 bg-gray-800/50"
            :class="qualityColor(item.quality)"
          >
            <div class="flex items-start justify-between mb-3">
              <div>
                <div class="flex items-center gap-2">
                  <span class="text-lg font-bold">{{ item.name }}</span>
                  <span class="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300">{{ item.slot_name }}</span>
                  <span v-if="item.is_benming" class="text-xs px-2 py-0.5 rounded bg-amber-700 text-amber-100">
                    本命 #{{ item.benming_slot }}
                  </span>
                  <span v-if="item.is_summoned" class="text-xs px-2 py-0.5 rounded bg-blue-700 text-blue-100">
                    已祭出
                  </span>
                  <span v-if="item.is_broken" class="text-xs px-2 py-0.5 rounded bg-red-700 text-red-100">
                    已破碎
                  </span>
                </div>
                <div class="text-xs text-gray-400 mt-1">{{ item.description }}</div>
                <div v-if="item.effect && Object.keys(item.effect).length > 0" class="text-xs text-gray-300 mt-1">
                  <span v-for="(val, key) in item.effect" :key="key" class="mr-3">
                    {{ key }}: +{{ val }}
                  </span>
                </div>
              </div>
              <div class="text-right">
                <div class="text-xs text-gray-400">祭炼等级</div>
                <div class="text-lg font-bold text-amber-300">+{{ item.refine_level }}</div>
              </div>
            </div>

            <!-- 耐久度进度条 -->
            <div class="mb-3">
              <div class="flex justify-between text-xs text-gray-400 mb-1">
                <span>耐久度</span>
                <span>{{ item.durability }} / {{ item.max_durability }}</span>
              </div>
              <div class="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  class="h-full transition-all"
                  :class="durabilityColor(item.durability, item.max_durability)"
                  :style="{ width: `${Math.max(0, Math.min(100, (item.durability / Math.max(1, item.max_durability)) * 100))}%` }"
                ></div>
              </div>
            </div>

            <!-- 本命法力值（仅本命显示） -->
            <div v-if="item.is_benming" class="mb-3">
              <div class="flex justify-between text-xs text-gray-400 mb-1">
                <span>法力值</span>
                <span>{{ item.spirit_power }}</span>
              </div>
            </div>

            <!-- 操作按钮组 -->
            <div class="flex flex-wrap gap-2">
              <button
                class="px-3 py-1 text-xs rounded bg-amber-700 hover:bg-amber-600 text-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="operating || item.is_broken"
                @click="openConfirm('refine', item.slot)"
              >祭炼</button>

              <button
                class="px-3 py-1 text-xs rounded bg-blue-700 hover:bg-blue-600 text-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="operating || item.durability >= item.max_durability"
                @click="openConfirm('repair', item.slot)"
              >修理</button>

              <button
                v-if="!item.is_benming"
                class="px-3 py-1 text-xs rounded bg-purple-700 hover:bg-purple-600 text-purple-100 disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="operating || item.is_broken"
                @click="openConfirm('benming', item.slot)"
              >炼制本命</button>

              <button
                v-else
                class="px-3 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-red-100 disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="operating"
                @click="openConfirm('disperse', item.slot)"
              >散念</button>

              <button
                v-if="item.is_benming && !item.is_summoned"
                class="px-3 py-1 text-xs rounded bg-cyan-700 hover:bg-cyan-600 text-cyan-100 disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="operating || item.is_broken"
                @click="openConfirm('summon', item.slot)"
              >祭出</button>

              <button
                v-if="item.is_benming && item.is_summoned"
                class="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="operating"
                @click="openConfirm('recall', item.slot)"
              >收回</button>

              <!-- 调整排序：使用数字输入框 + 按钮 -->
              <div class="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="99"
                  class="w-12 px-1 py-1 text-xs rounded bg-gray-700 text-white border border-gray-600"
                  v-model.number="(item as any)._newOrder"
                  :placeholder="item.sort_order"
                />
                <button
                  class="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="operating"
                  @click="openConfirm('order', item.slot, (item as any)._newOrder ?? item.sort_order)"
                >排序</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="px-6 py-4 border-t border-gray-700 flex justify-between items-center">
        <div class="text-sm text-gray-400">
          共 {{ count }} 件装备{{ benmingList.length > 0 ? `，本命法器 ${benmingList.length} 件` : '' }}
        </div>
        <button
          class="px-4 py-2 text-sm rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="operating || !hasRepairable"
          @click="openConfirm('repairAll')"
        >一键修理</button>
      </div>
    </div>

    <!-- 确认弹窗 -->
    <Modal :show="confirmModal.show" :title="confirmTitle" @close="confirmModal.show = false">
      <div class="text-gray-200">{{ confirmMessage }}</div>
      <template #footer>
        <button
          class="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white mr-2"
          @click="confirmModal.show = false"
        >取消</button>
        <button
          class="px-4 py-2 text-sm rounded bg-amber-700 hover:bg-amber-600 text-white"
          @click="handleConfirm"
        >确认</button>
      </template>
    </Modal>

    <!-- 提示弹窗 -->
    <Modal :show="toastModal.show" title="操作结果" @close="toastModal.show = false">
      <div :class="toastModal.isSuccess ? 'text-green-300' : 'text-red-300'">
        {{ toastModal.message }}
      </div>
      <template #footer>
        <button
          class="px-4 py-2 text-sm rounded bg-amber-700 hover:bg-amber-600 text-white"
          @click="toastModal.show = false"
        >确定</button>
      </template>
    </Modal>
  </div>
</template>
