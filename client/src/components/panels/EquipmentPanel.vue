<script setup lang="ts">
/**
 * 法宝管理面板组件
 *
 * 功能说明：
 *   - 外壳统一走 ui/PanelShell（遮罩 / 标题栏 / 关闭 / 右坞停靠契约），emits('close') 关闭面板
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
import PanelShell from '../ui/PanelShell.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import StatBar from '../ui/StatBar.vue'
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
 * 耐久度进度条色调（根据百分比，取值见 ui/StatBar.vue 的 tone 契约）
 */
function durabilityTone(durability: number, max: number): 'jade' | 'gold' | 'blood' {
  const pct = max > 0 ? durability / max : 0
  if (pct >= 0.7) return 'jade'
  if (pct >= 0.3) return 'gold'
  return 'blood'
}

/**
 * 品质颜色（暖色主题下不再用冷 gray/blue，一律取 fg / state / gold 令牌）
 */
function qualityColor(quality: string): string {
  const map: Record<string, string> = {
    common: 'text-fg-secondary border-line',
    uncommon: 'text-state-success border-state-success/50',
    rare: 'text-state-info border-state-info/50',
    epic: 'text-state-arcane border-state-arcane/50',
    legendary: 'text-gold-300 border-gold-600'
  }
  return map[quality] || map.common
}

onMounted(() => {
  fetchEquipment()
})
</script>

<template>
  <PanelShell
    title="法宝管理"
    size="lg"
    :loading="loading"
    :empty="!loading && equipmentList.length === 0"
    empty-text="暂无装备，请先穿戴装备"
    @close="emit('close')"
  >
    <!-- 装备卡片 -->
    <div class="space-y-4">
      <div
        v-for="item in equipmentList"
        :key="item.slot"
        class="border rounded-panel p-4 bg-surface-raised"
        :class="qualityColor(item.quality)"
      >
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[15px] font-bold font-display text-fg-primary">{{ item.name }}</span>
              <Badge tone="neutral">{{ item.slot_name }}</Badge>
              <Badge v-if="item.is_benming" tone="gold" solid>本命 #{{ item.benming_slot }}</Badge>
              <Badge v-if="item.is_summoned" tone="info" solid>已祭出</Badge>
              <Badge v-if="item.is_broken" tone="danger" solid>已破碎</Badge>
              <Badge v-if="item.attr_multiplier && item.attr_multiplier > 1" tone="success">炼制 ×{{ item.attr_multiplier.toFixed(2) }}</Badge>
            </div>
            <div class="text-xs text-fg-muted mt-1 wrap-cjk">{{ item.description }}</div>
            <div v-if="item.effect && Object.keys(item.effect).length > 0" class="text-xs text-fg-secondary mt-1">
              <span v-for="(val, key) in item.effect" :key="key" class="mr-3">
                {{ key }}: <span class="num">+{{ val }}</span>
              </span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-xs text-fg-muted">祭炼等级</div>
            <div class="text-lg font-bold text-gold-400 num">+{{ item.refine_level }}</div>
          </div>
        </div>

        <!-- 耐久度进度条 -->
        <StatBar
          class="mb-3"
          label="耐久度"
          :value="item.durability"
          :max="item.max_durability"
          :tone="durabilityTone(item.durability, item.max_durability)"
          height="h-2"
        />

        <!-- 本命法力值（仅本命显示） -->
        <div v-if="item.is_benming" class="mb-3">
          <div class="flex justify-between text-xs text-fg-muted mb-1">
            <span>法力值</span>
            <span class="num">{{ item.spirit_power }}</span>
          </div>
        </div>

        <!-- 操作按钮组 -->
        <div class="flex flex-wrap items-center gap-2">
          <AppButton size="xs" variant="primary" :disabled="operating || item.is_broken" @click="openConfirm('refine', item.slot)">
            祭炼
          </AppButton>

          <AppButton size="xs" variant="default" :disabled="operating || item.durability >= item.max_durability" @click="openConfirm('repair', item.slot)">
            修理
          </AppButton>

          <AppButton v-if="!item.is_benming" size="xs" variant="outline" :disabled="operating || item.is_broken" @click="openConfirm('benming', item.slot)">
            炼制本命
          </AppButton>

          <AppButton v-else size="xs" variant="danger" :disabled="operating" @click="openConfirm('disperse', item.slot)">
            散念
          </AppButton>

          <AppButton v-if="item.is_benming && !item.is_summoned" size="xs" variant="default" :disabled="operating || item.is_broken" @click="openConfirm('summon', item.slot)">
            祭出
          </AppButton>

          <AppButton v-if="item.is_benming && item.is_summoned" size="xs" variant="default" :disabled="operating" @click="openConfirm('recall', item.slot)">
            收回
          </AppButton>

          <!-- 调整排序：使用数字输入框 + 按钮 -->
          <div class="flex items-center gap-1">
            <input
              type="number"
              min="0"
              max="99"
              class="num w-12 px-1 py-1 text-xs rounded-control bg-surface-sunken text-fg-primary border border-line focus-ring"
              v-model.number="(item as any)._newOrder"
              :placeholder="item.sort_order"
            />
            <AppButton
              size="xs"
              variant="default"
              :disabled="operating"
              @click="openConfirm('order', item.slot, (item as any)._newOrder ?? item.sort_order)"
            >排序</AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部操作栏 -->
    <template #footer>
      <div class="text-sm text-fg-muted">
        共 <span class="num">{{ count }}</span> 件装备{{ benmingList.length > 0 ? `，本命法器 ${benmingList.length} 件` : '' }}
      </div>
      <AppButton
        class="ms-auto"
        variant="primary"
        :disabled="operating || !hasRepairable"
        @click="openConfirm('repairAll')"
      >
        一键修理
      </AppButton>
    </template>
  </PanelShell>

  <!-- 确认弹窗 -->
  <Modal :is-open="confirmModal.show" :title="confirmTitle" @close="confirmModal.show = false">
    <div class="text-fg-primary">{{ confirmMessage }}</div>
    <template #footer>
      <AppButton variant="default" @click="confirmModal.show = false">取消</AppButton>
      <AppButton variant="primary" @click="handleConfirm">确认</AppButton>
    </template>
  </Modal>

  <!-- 提示弹窗 -->
  <Modal :is-open="toastModal.show" title="操作结果" @close="toastModal.show = false">
    <div :class="toastModal.isSuccess ? 'text-state-success' : 'text-state-danger'">
      {{ toastModal.message }}
    </div>
    <template #footer>
      <AppButton variant="primary" @click="toastModal.show = false">确定</AppButton>
    </template>
  </Modal>
</template>
