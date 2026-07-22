<script setup lang="ts">
/**
 * 血魔剑残契面板（玩法文档第19节·法宝深线第一条）
 *
 * 功能说明：
 *   - 展示血魔剑残契完整状态：血契阶数 / 魔染 / 镇契 / 铭印 / 封鞘 / 各操作冷却
 *   - 操作按钮：祭血 / 镇契 / 雷洗（天雷竹/金雷竹二选一）/ 铭印（血契/镇契二选一）/ 封鞘
 *   - 魔染等级警示（正常 / 轻微反噬 / 中度反噬 / 严重反噬）
 *   - 战力加成展示（封鞘期间标红"未生效"）
 *   - 所有业务逻辑通过 artifactDeepLine API 调用后端，前端只做展示与交互
 *   - 所有确认操作均使用自定义 Modal 二次确认
 *   - 禁用浏览器原生 alert / confirm
 *
 * 设计原则：
 *   - 前端不处理业务逻辑，仅做展示与接口调用
 *   - 状态变化通过重新拉取状态实现（不本地计算）
 *   - 操作按钮根据状态/冷却动态启用/禁用
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import {
  getBloodSwordStatus,
  sacrificeBlood,
  suppressBloodSword,
  thunderWashBloodSword,
  imprintBloodSword,
  sheathBloodSword,
  type BloodSwordStatus,
  type BloodSwordStatusHeld,
  type ThunderWashMaterialType,
  type ImprintType
} from '../../api/artifactDeepLine'

const emit = defineEmits(['close'])

// ====== 响应式状态 ======
const loading = ref(true)
const operating = ref(false)
const status = ref<BloodSwordStatus | null>(null)
// 本地时钟 tick，用于实时刷新冷却倒计时显示
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

// 确认弹窗状态
type ConfirmAction =
  | 'sacrifice'
  | 'suppress'
  | 'thunder_tianlei'
  | 'thunder_jinlei'
  | 'imprint_blood'
  | 'imprint_suppress'
  | 'sheath'

const confirmModal = ref<{ show: boolean; action: ConfirmAction }>({
  show: false,
  action: 'sacrifice'
})

// 提示弹窗状态（用于操作结果反馈）
const toastModal = ref<{ show: boolean; message: string; isSuccess: boolean }>({
  show: false,
  message: '',
  isSuccess: true
})

// ====== 计算属性 ======

/**
 * 是否已持有血魔剑
 */
const hasBloodSword = computed(() => status.value?.has_blood_sword === true)

/**
 * 已持有时的状态对象（has_blood_sword=true 时安全访问）
 */
const heldStatus = computed<BloodSwordStatusHeld | null>(() => {
  if (status.value && status.value.has_blood_sword) {
    return status.value as BloodSwordStatusHeld
  }
  return null
})

/**
 * 祭血冷却剩余秒数（实时刷新）
 */
const sacrificeRemaining = computed(() => {
  if (!heldStatus.value) return 0
  // 服务端返回的剩余秒数是按照当时 server_time 计算的，本地用 now 推算
  // 简化处理：服务端返回的剩余秒数已足够准确，前端按秒递减
  return Math.max(0, heldStatus.value.sacrifice_cooldown_remaining)
})

/**
 * 雷洗冷却剩余秒数
 */
const thunderWashRemaining = computed(() => {
  if (!heldStatus.value) return 0
  return Math.max(0, heldStatus.value.thunder_wash_cooldown_remaining)
})

/**
 * 铭印冷却剩余秒数
 */
const imprintRemaining = computed(() => {
  if (!heldStatus.value) return 0
  return Math.max(0, heldStatus.value.imprint_cooldown_remaining)
})

/**
 * 封鞘剩余秒数
 */
const sheathRemaining = computed(() => {
  if (!heldStatus.value) return 0
  return Math.max(0, heldStatus.value.sheath_remaining_seconds)
})

/**
 * 祭血按钮是否可点击
 */
const canSacrifice = computed(() => {
  if (!heldStatus.value) return false
  return (
    !operating.value &&
    !heldStatus.value.is_sheathed &&
    heldStatus.value.blood_pact_stage < heldStatus.value.blood_pact_max_stage &&
    sacrificeRemaining.value <= 0 &&
    heldStatus.value.blood_pact_weekly_progress < heldStatus.value.blood_pact_weekly_limit
  )
})

/**
 * 镇契按钮是否可点击
 */
const canSuppress = computed(() => {
  if (!heldStatus.value) return false
  return (
    !operating.value &&
    !heldStatus.value.is_sheathed &&
    heldStatus.value.corruption > 0
  )
})

/**
 * 雷洗按钮是否可点击（天雷竹）
 */
const canThunderTianlei = computed(() => {
  if (!heldStatus.value) return false
  return (
    !operating.value &&
    !heldStatus.value.is_sheathed &&
    thunderWashRemaining.value <= 0 &&
    heldStatus.value.corruption > 0
  )
})

/**
 * 雷洗按钮是否可点击（金雷竹）
 */
const canThunderJinlei = computed(() => {
  if (!heldStatus.value) return false
  return (
    !operating.value &&
    !heldStatus.value.is_sheathed &&
    thunderWashRemaining.value <= 0 &&
    heldStatus.value.corruption > 0
  )
})

/**
 * 铭印按钮是否可点击（血契）
 */
const canImprintBlood = computed(() => {
  if (!heldStatus.value) return false
  return (
    !operating.value &&
    !heldStatus.value.is_sheathed &&
    heldStatus.value.blood_pact_stage >= 1 &&
    imprintRemaining.value <= 0 &&
    heldStatus.value.imprint_type !== 'blood'
  )
})

/**
 * 铭印按钮是否可点击（镇契）
 */
const canImprintSuppress = computed(() => {
  if (!heldStatus.value) return false
  return (
    !operating.value &&
    !heldStatus.value.is_sheathed &&
    heldStatus.value.blood_pact_stage >= 1 &&
    imprintRemaining.value <= 0 &&
    heldStatus.value.imprint_type !== 'suppress'
  )
})

/**
 * 封鞘按钮是否可点击
 */
const canSheath = computed(() => {
  if (!heldStatus.value) return false
  return (
    !operating.value &&
    !heldStatus.value.is_sheathed &&
    heldStatus.value.blood_pact_stage >= 1
  )
})

/**
 * 魔染等级颜色
 */
const corruptionLevelColor = computed(() => {
  if (!heldStatus.value) return 'text-gray-300'
  const level = heldStatus.value.corruption_level
  if (level === '正常') return 'text-green-300'
  if (level === '轻微反噬') return 'text-yellow-300'
  if (level === '中度反噬') return 'text-orange-300'
  if (level === '严重反噬') return 'text-red-400'
  return 'text-gray-300'
})

/**
 * 魔染进度条颜色
 */
const corruptionBarColor = computed(() => {
  if (!heldStatus.value) return 'bg-green-500'
  const corruption = heldStatus.value.corruption
  if (corruption >= 81) return 'bg-red-600'
  if (corruption >= 51) return 'bg-orange-500'
  if (corruption >= 31) return 'bg-yellow-500'
  return 'bg-green-500'
})

/**
 * 镇契进度条颜色（越高越好）
 */
const suppressionBarColor = computed(() => {
  if (!heldStatus.value) return 'bg-blue-500'
  const sup = heldStatus.value.suppression
  if (sup >= 50) return 'bg-cyan-400'
  return 'bg-blue-500'
})

// ====== 方法 ======

/**
 * 拉取血魔剑状态
 */
async function fetchStatus() {
  loading.value = true
  try {
    const res = await getBloodSwordStatus()
    const data = res.data?.data || res.data
    status.value = data as BloodSwordStatus
  } catch (e: any) {
    showToast(e.message || '加载血魔剑状态失败', false)
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
function openConfirm(action: ConfirmAction) {
  confirmModal.value = { show: true, action }
}

/**
 * 确认弹窗标题
 */
const confirmTitle = computed(() => {
  const map: Record<ConfirmAction, string> = {
    sacrifice: '祭血确认',
    suppress: '镇契确认',
    thunder_tianlei: '雷洗（天雷竹）确认',
    thunder_jinlei: '雷洗（金雷竹）确认',
    imprint_blood: '铭印·血契确认',
    imprint_suppress: '铭印·镇契确认',
    sheath: '封鞘确认'
  }
  return map[confirmModal.value.action]
})

/**
 * 确认弹窗内容
 */
const confirmMessage = computed(() => {
  switch (confirmModal.value.action) {
    case 'sacrifice':
      return '确认祭血推进血契阶数？将消耗当前阶数对应的材料，并增加魔染值（每周上限 36 次进度，18 小时冷却）。'
    case 'suppress':
      return '确认镇契？将消耗素女禁纹×1 + 掩月镜砂×1，降低魔染 5~10，提升镇契 5~10。无冷却。'
    case 'thunder_tianlei':
      return '确认使用天雷竹雷洗？将消耗天雷竹×1，降低魔染 20~30，提升镇契 2~5。24 小时冷却。'
    case 'thunder_jinlei':
      return '确认使用金雷竹雷洗？将消耗金雷竹×1，降低魔染 35~50，提升镇契 2~5。24 小时冷却。'
    case 'imprint_blood':
      return '确认铭印血契路线？将获得高额攻击/吸血/暴击加成，但每回合受血反噬（魔染越高反噬越重，镇契可减免）。7 天冷却。'
    case 'imprint_suppress':
      return '确认铭印镇契路线？将获得稳定攻击/防御/暴击加成，无反噬代价。7 天冷却。'
    case 'sheath':
      return '确认封鞘 24 小时？封鞘期间血魔剑不提供战力且不可祭出/祭血/镇契/雷洗/铭印。到期后自动结算：魔染 -25~35，镇契 +15~25。'
    default:
      return ''
  }
})

/**
 * 执行确认操作
 */
async function handleConfirm() {
  const action = confirmModal.value.action
  confirmModal.value.show = false
  operating.value = true
  try {
    let res: any
    switch (action) {
      case 'sacrifice':
        res = await sacrificeBlood()
        break
      case 'suppress':
        res = await suppressBloodSword()
        break
      case 'thunder_tianlei':
        res = await thunderWashBloodSword('tianlei' as ThunderWashMaterialType)
        break
      case 'thunder_jinlei':
        res = await thunderWashBloodSword('jinlei' as ThunderWashMaterialType)
        break
      case 'imprint_blood':
        res = await imprintBloodSword('blood')
        break
      case 'imprint_suppress':
        res = await imprintBloodSword('suppress')
        break
      case 'sheath':
        res = await sheathBloodSword()
        break
    }
    const data = res.data?.data || res.data
    const message = data?.message || res.data?.message || '操作成功'
    const isSuccess = data?.success !== false
    showToast(message, isSuccess)
    // 重新拉取状态
    await fetchStatus()
  } catch (e: any) {
    const msg = e?.response?.data?.message || e.message || '操作失败'
    showToast(msg, false)
  } finally {
    operating.value = false
  }
}

/**
 * 秒数格式化为 h:m:s
 */
function formatSeconds(seconds: number): string {
  if (seconds <= 0) return '0 秒'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h} 时 ${m} 分 ${s} 秒`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

/**
 * 血契阶数名（含未启血契状态）
 */
function bloodPactStageName(stage: number, stageName: string): string {
  if (stage === 0) return '未启血契'
  return `${stage} 阶 · ${stageName}`
}

// ====== 生命周期 ======
onMounted(() => {
  fetchStatus()
  // 每 5 秒刷新一次本地时钟，让冷却倒计时实时刷新（不重新拉接口，避免无谓请求）
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})
</script>

<template>
  <!-- 全屏遮罩 -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <!-- 主面板 -->
    <div class="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-700">
        <div class="flex items-center gap-3">
          <h2 class="text-xl font-bold text-red-300">血魔剑残契</h2>
          <span class="text-xs px-2 py-0.5 rounded bg-red-900/60 text-red-200 border border-red-700">
            法宝深线 · 第一条
          </span>
        </div>
        <button
          class="text-gray-400 hover:text-white text-2xl leading-none"
          @click="emit('close')"
          aria-label="关闭"
        >×</button>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto p-6">
        <!-- 加载中 -->
        <div v-if="loading" class="text-center text-gray-400 py-12">加载中...</div>

        <!-- 未持有血魔剑 -->
        <div v-else-if="!hasBloodSword || !heldStatus" class="text-center py-12 space-y-4">
          <div class="text-5xl">🗡️</div>
          <div class="text-lg text-gray-300">尚未持有血魔剑</div>
          <div class="text-sm text-gray-400 max-w-md mx-auto leading-relaxed">
            {{ (status as any)?.source_hint || '血魔剑来自掩月抢亲副本成功后的成品法宝掉落（掉率 0.1%）' }}
          </div>
          <div
            v-if="(status as any)?.meets_realm === false"
            class="text-sm text-red-300 mt-2"
          >
            装备境界要求：化神初期及以上（当前境界未达成）
          </div>
          <div v-else class="text-sm text-green-300 mt-2">
            ✓ 境界要求已达成，仅缺血魔剑
          </div>
        </div>

        <!-- 已持有血魔剑：状态展示 -->
        <div v-else class="space-y-5">
          <!-- 顶部：装备基础信息 -->
          <div class="border border-red-800/50 rounded-lg p-4 bg-red-950/20">
            <div class="flex items-start justify-between flex-wrap gap-2">
              <div>
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-lg font-bold text-red-200">{{ heldStatus.item_name }}</span>
                  <span class="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300">
                    {{ heldStatus.slot }}
                  </span>
                  <span
                    v-if="heldStatus.is_benming"
                    class="text-xs px-2 py-0.5 rounded bg-amber-700 text-amber-100"
                  >本命</span>
                  <span
                    v-if="heldStatus.is_summoned"
                    class="text-xs px-2 py-0.5 rounded bg-blue-700 text-blue-100"
                  >已祭出</span>
                  <span
                    v-if="heldStatus.is_sheathed"
                    class="text-xs px-2 py-0.5 rounded bg-purple-700 text-purple-100"
                  >封鞘中</span>
                </div>
                <div class="text-xs text-gray-400 mt-2 flex gap-4 flex-wrap">
                  <span>耐久：{{ heldStatus.durability }} / {{ heldStatus.max_durability }}</span>
                  <span>祭炼：+{{ heldStatus.refine_level }}</span>
                </div>
              </div>
              <div class="text-right">
                <div class="text-xs text-gray-400">血契阶数</div>
                <div class="text-lg font-bold text-red-300">
                  {{ bloodPactStageName(heldStatus.blood_pact_stage, heldStatus.blood_pact_stage_name) }}
                </div>
                <div class="text-xs text-gray-500 mt-1">
                  周进度：{{ heldStatus.blood_pact_weekly_progress }} / {{ heldStatus.blood_pact_weekly_limit }}
                </div>
              </div>
            </div>
            <div
              v-if="heldStatus.blood_pact_stage_description"
              class="text-xs text-gray-400 mt-2 italic"
            >
              {{ heldStatus.blood_pact_stage_description }}
            </div>
          </div>

          <!-- 中部：魔染 vs 镇契 双值博弈 -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <!-- 魔染 -->
            <div class="border border-red-700/50 rounded-lg p-4 bg-red-950/10">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-bold text-red-300">魔染</span>
                <span class="text-sm" :class="corruptionLevelColor">
                  {{ heldStatus.corruption_level }}
                </span>
              </div>
              <div class="relative h-4 bg-gray-800 rounded overflow-hidden border border-gray-700">
                <div
                  class="absolute inset-y-0 left-0 transition-all duration-300"
                  :class="corruptionBarColor"
                  :style="{ width: `${(heldStatus.corruption / heldStatus.corruption_max) * 100}%` }"
                ></div>
              </div>
              <div class="flex justify-between text-xs text-gray-400 mt-1">
                <span>{{ heldStatus.corruption }} / {{ heldStatus.corruption_max }}</span>
                <span
                  v-if="heldStatus.corruption_extra_backlash_rate > 0"
                  class="text-red-400"
                >
                  额外反噬 +{{ (heldStatus.corruption_extra_backlash_rate * 100).toFixed(0) }}%
                </span>
              </div>
              <div
                v-if="heldStatus.corruption_loss_control_chance > 0"
                class="text-xs text-red-400 mt-1"
              >
                ⚠ 失控概率 {{ (heldStatus.corruption_loss_control_chance * 100).toFixed(0) }}%
              </div>
            </div>

            <!-- 镇契 -->
            <div class="border border-blue-700/50 rounded-lg p-4 bg-blue-950/10">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-bold text-blue-300">镇契</span>
                <span
                  v-if="heldStatus.suppression >= 50"
                  class="text-xs text-cyan-300"
                >高镇契·反噬减半</span>
              </div>
              <div class="relative h-4 bg-gray-800 rounded overflow-hidden border border-gray-700">
                <div
                  class="absolute inset-y-0 left-0 transition-all duration-300"
                  :class="suppressionBarColor"
                  :style="{ width: `${(heldStatus.suppression / heldStatus.suppression_max) * 100}%` }"
                ></div>
              </div>
              <div class="flex justify-between text-xs text-gray-400 mt-1">
                <span>{{ heldStatus.suppression }} / {{ heldStatus.suppression_max }}</span>
              </div>
            </div>
          </div>

          <!-- 铭印状态 -->
          <div class="border border-gray-700 rounded-lg p-4 bg-gray-800/40">
            <div class="flex items-center justify-between flex-wrap gap-2">
              <div>
                <span class="text-sm text-gray-400">铭印路线：</span>
                <span
                  class="text-sm font-bold ml-1"
                  :class="{
                    'text-gray-400': heldStatus.imprint_type === 'none',
                    'text-red-300': heldStatus.imprint_type === 'blood',
                    'text-blue-300': heldStatus.imprint_type === 'suppress'
                  }"
                >{{ heldStatus.imprint_name }}</span>
              </div>
              <div class="text-xs text-gray-400">
                上次铭印：{{ heldStatus.last_imprint_at ? new Date(heldStatus.last_imprint_at).toLocaleString('zh-CN') : '从未铭印' }}
              </div>
            </div>
          </div>

          <!-- 战力加成 -->
          <div class="border border-amber-700/40 rounded-lg p-4 bg-amber-950/10">
            <div class="text-sm font-bold text-amber-300 mb-2">战力加成</div>
            <div v-if="!heldStatus.combat_bonus.is_active" class="text-xs text-red-400">
              {{ heldStatus.combat_bonus.reason || '当前不提供战力加成' }}
            </div>
            <div v-else class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              <div>
                <span class="text-gray-400">攻击加成：</span>
                <span class="text-green-300">+{{ (heldStatus.combat_bonus.atk_bonus_rate * 100).toFixed(1) }}%</span>
              </div>
              <div>
                <span class="text-gray-400">吸血加成：</span>
                <span class="text-green-300">+{{ (heldStatus.combat_bonus.hp_steal_bonus_rate * 100).toFixed(1) }}%</span>
              </div>
              <div v-if="heldStatus.combat_bonus.def_bonus_rate > 0">
                <span class="text-gray-400">防御加成：</span>
                <span class="text-green-300">+{{ (heldStatus.combat_bonus.def_bonus_rate * 100).toFixed(1) }}%</span>
              </div>
              <div v-if="heldStatus.combat_bonus.crit_rate_bonus > 0">
                <span class="text-gray-400">暴击率：</span>
                <span class="text-green-300">+{{ (heldStatus.combat_bonus.crit_rate_bonus * 100).toFixed(1) }}%</span>
              </div>
              <div v-if="heldStatus.combat_bonus.crit_damage_bonus > 0">
                <span class="text-gray-400">暴击伤害：</span>
                <span class="text-green-300">+{{ (heldStatus.combat_bonus.crit_damage_bonus * 100).toFixed(1) }}%</span>
              </div>
              <div v-if="heldStatus.combat_bonus.blood_backlash_hp_rate_per_round > 0">
                <span class="text-gray-400">血反（每回合）：</span>
                <span class="text-red-400">-{{ (heldStatus.combat_bonus.blood_backlash_hp_rate_per_round * 100).toFixed(1) }}%</span>
              </div>
            </div>
          </div>

          <!-- 封鞘状态提示 -->
          <div
            v-if="heldStatus.is_sheathed"
            class="border border-purple-700/50 rounded-lg p-3 bg-purple-950/20 text-sm text-purple-200"
          >
            🔒 血魔剑封鞘中，剩余 {{ formatSeconds(sheathRemaining) }}。期间不提供战力，无法祭出/祭血/镇契/雷洗/铭印。到期后自动结算 -魔染 +镇契。
          </div>

          <!-- 冷却总览 -->
          <div class="border border-gray-700 rounded-lg p-3 bg-gray-800/30 text-xs text-gray-400 grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>
              祭血冷却：
              <span :class="sacrificeRemaining > 0 ? 'text-yellow-300' : 'text-green-300'">
                {{ sacrificeRemaining > 0 ? formatSeconds(sacrificeRemaining) : '可祭血' }}
              </span>
            </div>
            <div>
              雷洗冷却：
              <span :class="thunderWashRemaining > 0 ? 'text-yellow-300' : 'text-green-300'">
                {{ thunderWashRemaining > 0 ? formatSeconds(thunderWashRemaining) : '可雷洗' }}
              </span>
            </div>
            <div>
              铭印冷却：
              <span :class="imprintRemaining > 0 ? 'text-yellow-300' : 'text-green-300'">
                {{ imprintRemaining > 0 ? formatSeconds(imprintRemaining) : '可铭印' }}
              </span>
            </div>
          </div>

          <!-- 操作按钮区 -->
          <div class="border border-gray-700 rounded-lg p-4 bg-gray-800/40 space-y-3">
            <div class="text-sm font-bold text-gray-300">操作</div>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
              <button
                class="px-3 py-2 rounded text-sm border transition-colors"
                :class="canSacrifice
                  ? 'border-red-600 bg-red-900/40 text-red-200 hover:bg-red-900/60'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'"
                :disabled="!canSacrifice"
                @click="openConfirm('sacrifice')"
              >祭血</button>
              <button
                class="px-3 py-2 rounded text-sm border transition-colors"
                :class="canSuppress
                  ? 'border-blue-600 bg-blue-900/40 text-blue-200 hover:bg-blue-900/60'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'"
                :disabled="!canSuppress"
                @click="openConfirm('suppress')"
              >镇契</button>
              <button
                class="px-3 py-2 rounded text-sm border transition-colors"
                :class="canThunderTianlei
                  ? 'border-yellow-600 bg-yellow-900/40 text-yellow-200 hover:bg-yellow-900/60'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'"
                :disabled="!canThunderTianlei"
                @click="openConfirm('thunder_tianlei')"
              >雷洗·天雷竹</button>
              <button
                class="px-3 py-2 rounded text-sm border transition-colors"
                :class="canThunderJinlei
                  ? 'border-amber-600 bg-amber-900/40 text-amber-200 hover:bg-amber-900/60'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'"
                :disabled="!canThunderJinlei"
                @click="openConfirm('thunder_jinlei')"
              >雷洗·金雷竹</button>
              <button
                class="px-3 py-2 rounded text-sm border transition-colors"
                :class="canImprintBlood
                  ? 'border-red-600 bg-red-900/40 text-red-200 hover:bg-red-900/60'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'"
                :disabled="!canImprintBlood"
                @click="openConfirm('imprint_blood')"
              >铭印·血契</button>
              <button
                class="px-3 py-2 rounded text-sm border transition-colors"
                :class="canImprintSuppress
                  ? 'border-blue-600 bg-blue-900/40 text-blue-200 hover:bg-blue-900/60'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'"
                :disabled="!canImprintSuppress"
                @click="openConfirm('imprint_suppress')"
              >铭印·镇契</button>
              <button
                class="px-3 py-2 rounded text-sm border transition-colors col-span-2 md:col-span-1"
                :class="canSheath
                  ? 'border-purple-600 bg-purple-900/40 text-purple-200 hover:bg-purple-900/60'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'"
                :disabled="!canSheath"
                @click="openConfirm('sheath')"
              >封鞘</button>
            </div>
            <div class="text-xs text-gray-500 mt-1">
              <span v-if="operating">操作中...</span>
              <span v-else>提示：祭血需消耗材料 + 18h 冷却 + 周进度上限 36；镇契无冷却但魔染为 0 时不可用；雷洗 24h 冷却；铭印 7 天冷却；封鞘 24h 期间无法操作其他。</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部 -->
      <div class="px-6 py-3 border-t border-gray-700 flex justify-end">
        <button
          class="px-4 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-800"
          @click="emit('close')"
        >关闭</button>
      </div>
    </div>
  </div>

  <!-- 确认弹窗 -->
  <Modal
    :is-open="confirmModal.show"
    :title="confirmTitle"
    @close="confirmModal.show = false"
  >
    <div class="text-sm text-gray-300 leading-relaxed">{{ confirmMessage }}</div>
    <template #footer>
      <button
        class="px-4 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-800"
        @click="confirmModal.show = false"
      >取消</button>
      <button
        class="px-4 py-1.5 text-sm rounded bg-red-700 hover:bg-red-600 text-white"
        :disabled="operating"
        @click="handleConfirm"
      >确认</button>
    </template>
  </Modal>

  <!-- 提示弹窗 -->
  <Modal
    :is-open="toastModal.show"
    :title="toastModal.isSuccess ? '操作成功' : '操作失败'"
    @close="toastModal.show = false"
  >
    <div
      class="text-sm leading-relaxed"
      :class="toastModal.isSuccess ? 'text-green-300' : 'text-red-300'"
    >{{ toastModal.message }}</div>
    <template #footer>
      <button
        class="px-4 py-1.5 text-sm rounded bg-amber-700 hover:bg-amber-600 text-white"
        @click="toastModal.show = false"
      >知道了</button>
    </template>
  </Modal>
</template>
