/**
 * 阵法系统面板组件
 *
 * 阵法玩法综合面板，包含以下功能模块：
 *   1. 阵法图鉴：展示所有阵法（10大阵法，4类×4品阶），可学习
 *   2. 我的阵法：展示已学阵法列表，可布阵激活/撤阵
 *   3. 当前激活：展示激活阵法详情、剩余时间、实际效果
 *   4. 状态总览：境界、已学数量、激活状态、撤阵冷却
 *
 * 设计原则：
 *   - 所有状态从后端 GET /formation/status 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 未学习/未达境界的阵法展示锁定状态与解锁条件
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-stone-800 rounded-lg p-6 max-w-5xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-amber-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 2v20"/>
            <path d="M2 12h20"/>
            <circle cx="12" cy="12" r="4"/>
          </svg>
          阵法堂
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 状态总览栏 -->
      <div v-if="status" class="bg-[#292524] border border-stone-700 rounded-lg p-3 mb-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <div class="text-stone-500">当前境界</div>
          <div class="text-amber-300 font-bold">{{ status.realm_name }}</div>
        </div>
        <div>
          <div class="text-stone-500">已学阵法</div>
          <div class="text-cyan-300 font-bold">{{ status.learned_count }} 部</div>
        </div>
        <div>
          <div class="text-stone-500">激活状态</div>
          <div class="font-bold" :class="status.active_formation ? 'text-emerald-400' : 'text-stone-400'">
            {{ status.active_formation ? status.active_formation.name : '未激活' }}
          </div>
        </div>
        <div>
          <div class="text-stone-500">撤阵冷却</div>
          <div class="font-bold" :class="status.deactivate_cooldown_ready ? 'text-emerald-400' : 'text-amber-400'">
            {{ status.deactivate_cooldown_ready ? '就绪' : `${formatTime(status.deactivate_cooldown_remaining_sec)}` }}
          </div>
        </div>
      </div>

      <!-- 未解锁提示 -->
      <div v-if="status && !status.unlocked" class="bg-amber-950/30 border border-amber-800/50 rounded-lg p-4 mb-4 text-amber-300 text-sm text-center">
        境界不足，需达到更高境界方可研习阵法之道
      </div>

      <!-- 标签页切换 -->
      <div v-if="status?.unlocked" class="flex gap-2 mb-4 border-b border-stone-800 pb-2">
        <button v-for="tab in tabs" :key="tab.id"
          @click="switchView(tab.id)"
          :class="['px-4 py-1.5 rounded text-sm transition-colors',
            view === tab.id ? 'bg-amber-900/40 text-amber-300 border border-amber-700' : 'text-stone-400 hover:text-stone-200']">
          {{ tab.name }}
        </button>
      </div>

      <!-- 内容区（可滚动） -->
      <div class="flex-1 overflow-y-auto pr-2 -mr-2">
        <!-- 视图1：阵法图鉴 -->
        <div v-if="view === 'atlas' && config" class="space-y-3">
          <div class="text-stone-400 text-xs mb-2">
            共 {{ config.formations.length }} 部阵法 · 4类（攻杀/护身/辅助/奇门） · 4品阶（凡/灵/仙/圣）
          </div>

          <div v-for="formation in config.formations" :key="formation.id"
            class="bg-[#292524] border border-stone-700 rounded-lg p-4 hover:border-stone-600 transition-colors">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1 flex-wrap">
                  <span class="text-amber-300 font-bold">{{ formation.name }}</span>
                  <span :class="['text-xs px-1.5 py-0.5 rounded border', getCategoryClass(formation.category)]">
                    {{ formation.category_display }}
                  </span>
                  <span :class="['text-xs px-1.5 py-0.5 rounded border', getGradeClass(formation.grade)]">
                    {{ formation.grade_display }}
                  </span>
                  <span v-if="isLearned(formation.id)" class="text-xs px-1.5 py-0.5 rounded bg-emerald-950/40 border border-emerald-700 text-emerald-300">
                    已学
                  </span>
                  <span v-if="status?.active_formation?.formation_id === formation.id" class="text-xs px-1.5 py-0.5 rounded bg-cyan-950/40 border border-cyan-700 text-cyan-300">
                    激活中
                  </span>
                </div>
                <div class="text-stone-400 text-xs mb-2">{{ formation.description }}</div>
                <div class="text-stone-500 text-xs italic mb-2">「{{ formation.lore }}」</div>

                <!-- 效果展示 -->
                <div class="flex flex-wrap gap-2 mb-2">
                  <span v-for="(value, key) in formation.effects" :key="key"
                    class="text-xs px-2 py-0.5 rounded bg-stone-900/50 border border-stone-700 text-stone-300">
                    {{ getEffectLabel(key) }} +{{ (value * 100).toFixed(0) }}%
                  </span>
                </div>

                <!-- 学习条件 -->
                <div class="text-xs text-stone-500 grid grid-cols-2 md:grid-cols-3 gap-2">
                  <div>境界：<span :class="status?.realm_rank >= formation.min_realm_rank ? 'text-emerald-400' : 'text-rose-400'">{{ formation.recommended_realm }}</span></div>
                  <div>学习消耗：<span class="text-amber-300">{{ formation.learn_cost_spirit_stones }} 灵石</span></div>
                  <div>布阵消耗：<span class="text-amber-300">{{ formation.activate_cost_spirit_stones }} 灵石</span></div>
                  <div v-if="formation.prerequisite_formation_id" class="md:col-span-3">
                    前置阵法：<span :class="isLearned(formation.prerequisite_formation_id) ? 'text-emerald-400' : 'text-rose-400'">
                      {{ getFormationName(formation.prerequisite_formation_id) }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- 操作按钮 -->
              <div class="flex flex-col gap-2 shrink-0">
                <button v-if="!isLearned(formation.id)"
                  @click="confirmLearn(formation)"
                  :disabled="loading"
                  :class="['px-3 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap',
                    canLearn(formation) ? 'bg-amber-900/40 border border-amber-700 text-amber-300 hover:bg-amber-800/40' : 'bg-stone-900/50 border border-stone-700 text-stone-600 cursor-not-allowed']">
                  学习
                </button>
                <button v-else-if="!status?.active_formation || status.active_formation.formation_id !== formation.id"
                  @click="confirmActivate(formation)"
                  :disabled="loading"
                  class="px-3 py-1.5 rounded text-xs font-medium bg-emerald-950/40 border border-emerald-700 text-emerald-300 hover:bg-emerald-800/40 transition-colors whitespace-nowrap">
                  布阵
                </button>
                <span v-else class="text-xs text-cyan-400 px-3 py-1.5">激活中</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 视图2：我的阵法 -->
        <div v-else-if="view === 'mine' && status" class="space-y-3">
          <div v-if="status.learned_formations.length === 0" class="text-center text-stone-500 py-12">
            尚未学习任何阵法，请前往「阵法图鉴」研习
          </div>

          <div v-for="lf in status.learned_formations" :key="lf.formation_id"
            class="bg-[#292524] border border-stone-700 rounded-lg p-4"
            :class="{ 'border-cyan-700/50 bg-cyan-950/10': status.active_formation?.formation_id === lf.formation_id }">
            <div class="flex items-start justify-between gap-3 mb-2">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-amber-300 font-bold">{{ lf.name }}</span>
                <span v-if="lf.category_display" :class="['text-xs px-1.5 py-0.5 rounded border', getCategoryClass(lf.category)]">
                  {{ lf.category_display }}
                </span>
                <span v-if="lf.grade_display" :class="['text-xs px-1.5 py-0.5 rounded border', getGradeClass(lf.grade)]">
                  {{ lf.grade_display }}
                </span>
              </div>
              <div class="flex gap-2">
                <button v-if="status.active_formation?.formation_id !== lf.formation_id"
                  @click="confirmActivate({ id: lf.formation_id, name: lf.name })"
                  :disabled="loading"
                  class="px-3 py-1 rounded text-xs bg-emerald-950/40 border border-emerald-700 text-emerald-300 hover:bg-emerald-800/40 transition-colors">
                  布阵
                </button>
                <span v-else class="text-xs text-cyan-400 px-3 py-1">激活中</span>
              </div>
            </div>

            <!-- 熟练度进度条 -->
            <div class="mb-2">
              <div class="flex justify-between text-xs text-stone-400 mb-1">
                <span>熟练度 {{ lf.proficiency }} / {{ lf.proficiency_max }}</span>
                <span class="text-amber-400">效果加成 +{{ getProficiencyBonus(lf.proficiency) }}%</span>
              </div>
              <div class="h-1.5 bg-stone-800 rounded overflow-hidden">
                <div class="h-full bg-gradient-to-r from-amber-600 to-amber-400 transition-all"
                  :style="{ width: `${(lf.proficiency / lf.proficiency_max) * 100}%` }"></div>
              </div>
            </div>

            <!-- 实际效果 -->
            <div v-if="lf.effects" class="flex flex-wrap gap-2">
              <span v-for="(value, key) in getDisplayableEffects(lf.effects)" :key="key"
                class="text-xs px-2 py-0.5 rounded bg-stone-900/50 border border-stone-700 text-stone-300">
                {{ getEffectLabel(key) }} +{{ (value * 100).toFixed(1) }}%
              </span>
            </div>
          </div>
        </div>

        <!-- 视图3：当前激活 -->
        <div v-else-if="view === 'active' && status" class="space-y-3">
          <div v-if="!status.active_formation" class="text-center text-stone-500 py-12">
            <div class="mb-3">当前无激活阵法</div>
            <div class="text-xs">布阵后可获得属性加成，增强战力</div>
          </div>

          <div v-else class="bg-gradient-to-br from-cyan-950/30 to-amber-950/20 border border-cyan-700/50 rounded-lg p-5">
            <div class="flex items-center gap-3 mb-3 flex-wrap">
              <span class="text-2xl text-amber-300 font-bold">{{ status.active_formation.name }}</span>
              <span :class="['text-xs px-2 py-0.5 rounded border', getCategoryClass(status.active_formation.category)]">
                {{ status.active_formation.category_display }}
              </span>
              <span :class="['text-xs px-2 py-0.5 rounded border', getGradeClass(status.active_formation.grade)]">
                {{ status.active_formation.grade_display }}
              </span>
              <span class="text-xs px-2 py-0.5 rounded bg-cyan-950/40 border border-cyan-700 text-cyan-300">
                熟练度 {{ status.active_formation.proficiency }}
              </span>
            </div>

            <div class="text-stone-400 text-sm mb-3">{{ status.active_formation.description }}</div>

            <!-- 剩余时间 -->
            <div class="bg-stone-900/50 rounded p-3 mb-3">
              <div class="flex justify-between text-xs mb-1">
                <span class="text-stone-400">剩余持续时间</span>
                <span class="text-amber-300 font-bold">{{ formatTime(status.active_formation.remaining_seconds) }}</span>
              </div>
              <div class="h-2 bg-stone-800 rounded overflow-hidden">
                <div class="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all"
                  :style="{ width: `${(status.active_formation.remaining_seconds / status.active_formation.duration_seconds) * 100}%` }"></div>
              </div>
            </div>

            <!-- 实际效果 -->
            <div class="mb-3">
              <div class="text-xs text-stone-400 mb-2">当前实际效果（含熟练度加成）</div>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
                <div v-for="(value, key) in getDisplayableEffects(status.active_formation.effects)" :key="key"
                  class="bg-stone-900/50 rounded p-2 text-center">
                  <div class="text-xs text-stone-500">{{ getEffectLabel(key) }}</div>
                  <div class="text-emerald-400 font-bold">+{{ (value * 100).toFixed(1) }}%</div>
                </div>
              </div>
            </div>

            <!-- 撤阵按钮 -->
            <button @click="confirmDeactivate"
              :disabled="loading"
              class="w-full px-4 py-2 rounded bg-rose-950/40 border border-rose-700 text-rose-300 hover:bg-rose-900/40 transition-colors text-sm">
              撤阵（进入 {{ formatTime(status.active_duration_seconds === 0 ? 0 : (status.deactivate_cooldown_remaining_sec || 1800)) }} 冷却）
            </button>
          </div>
        </div>
      </div>

      <!-- 加载遮罩 -->
      <div v-if="loading" class="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg">
        <div class="text-amber-300 text-sm">处理中...</div>
      </div>
    </div>

    <!-- 二次确认弹窗 -->
    <Modal v-if="confirmModal.show" :title="confirmModal.title" :message="confirmModal.message"
      :confirmText="confirmModal.confirmText" :cancelText="confirmModal.cancelText"
      :type="confirmModal.type" @confirm="confirmModal.onConfirm" @cancel="closeConfirm" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { formatTime } from '../../utils/format'
import Modal from '../common/Modal.vue'
import {
  getConfig,
  getStatus,
  learnFormation,
  activateFormation,
  deactivateFormation
} from '../../api/formation'

const uiStore = useUIStore()

/** 标签页定义 */
const tabs = [
  { id: 'atlas', name: '阵法图鉴' },
  { id: 'mine', name: '我的阵法' },
  { id: 'active', name: '当前激活' }
]

/** 组件状态 */
const view = ref('atlas')
const config = ref(null)
const status = ref(null)
const loading = ref(false)

/** 二次确认弹窗状态 */
const confirmModal = ref({
  show: false,
  title: '',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
  type: 'warning',
  onConfirm: () => {}
})

/**
 * 是否已学习某阵法
 */
const isLearned = (formationId) => {
  return status.value?.learned_formations?.some(lf => lf.formation_id === formationId) || false
}

/**
 * 是否可学习（境界+前置+灵石够）
 */
const canLearn = (formation) => {
  if (!status.value) return false
  if (status.value.realm_rank < formation.min_realm_rank) return false
  if (formation.prerequisite_formation_id && !isLearned(formation.prerequisite_formation_id)) return false
  return true
}

/**
 * 获取阵法名称（通过ID）
 */
const getFormationName = (formationId) => {
  return config.value?.formations?.find(f => f.id === formationId)?.name || formationId
}

/**
 * 获取熟练度加成百分比
 */
const getProficiencyBonus = (proficiency) => {
  if (!status.value) return 0
  const step = status.value.proficiency_effect_step || 100
  const ratio = status.value.proficiency_effect_bonus_ratio || 0.05
  return Math.floor(proficiency / step) * ratio * 100
}

/**
 * 过滤掉内部字段（_ 开头）的效果
 */
const getDisplayableEffects = (effects) => {
  if (!effects) return {}
  const result = {}
  for (const [key, value] of Object.entries(effects)) {
    if (!key.startsWith('_')) {
      result[key] = value
    }
  }
  return result
}

/**
 * 效果字段中文标签
 */
const getEffectLabel = (key) => {
  const labels = {
    atk_ratio: '攻击',
    def_ratio: '防御',
    hp_max_ratio: '气血',
    mp_max_ratio: '灵力',
    speed_ratio: '速度',
    sense_ratio: '神识'
  }
  return labels[key] || key
}

/**
 * 阵法分类样式
 */
const getCategoryClass = (category) => {
  const classes = {
    attack: 'bg-rose-950/40 border-rose-700 text-rose-300',
    defense: 'bg-blue-950/40 border-blue-700 text-blue-300',
    support: 'bg-emerald-950/40 border-emerald-700 text-emerald-300',
    special: 'bg-purple-950/40 border-purple-700 text-purple-300'
  }
  return classes[category] || 'bg-stone-950/40 border-stone-700 text-stone-300'
}

/**
 * 阵法品阶样式
 */
const getGradeClass = (grade) => {
  const classes = {
    mortal: 'bg-stone-800/50 border-stone-600 text-stone-300',
    spirit: 'bg-cyan-950/40 border-cyan-700 text-cyan-300',
    immortal: 'bg-amber-950/40 border-amber-700 text-amber-300',
    saint: 'bg-purple-950/40 border-purple-600 text-purple-300'
  }
  return classes[grade] || 'bg-stone-800/50 border-stone-600 text-stone-300'
}

/**
 * 切换视图
 */
const switchView = (newView) => {
  view.value = newView
}

/**
 * 拉取阵法配置
 */
const fetchConfig = async () => {
  try {
    const res = await getConfig()
    config.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取阵法配置失败:', err)
    uiStore.showToast('获取阵法配置失败', 'error')
  }
}

/**
 * 拉取玩家阵法状态
 */
const fetchStatus = async () => {
  try {
    const res = await getStatus()
    status.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取阵法状态失败:', err)
    uiStore.showToast('获取阵法状态失败', 'error')
  }
}

/**
 * 确认学习阵法
 */
const confirmLearn = (formation) => {
  if (!canLearn(formation)) {
    uiStore.showToast('不满足学习条件（境界/前置阵法）', 'warning')
    return
  }
  confirmModal.value = {
    show: true,
    title: '研习阵法',
    message: `确认研习「${formation.name}」？\n将消耗 ${formation.learn_cost_spirit_stones} 灵石`,
    confirmText: '研习',
    cancelText: '取消',
    type: 'warning',
    onConfirm: async () => {
      closeConfirm()
      await doLearn(formation.id)
    }
  }
}

/**
 * 执行学习
 */
const doLearn = async (formationId) => {
  loading.value = true
  try {
    const res = await learnFormation(formationId)
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '学习失败', 'warning')
      return
    }
    uiStore.showToast(payload.message || '研习成功', 'success')
    uiStore.addLog({
      type: 'formation_learn',
      content: `研习阵法：${payload.data?.formation_name || formationId}`
    })
    await fetchStatus()
  } catch (err) {
    console.error('学习阵法失败:', err)
    uiStore.showToast('学习阵法失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 确认布阵激活
 */
const confirmActivate = (formation) => {
  confirmModal.value = {
    show: true,
    title: '布阵激活',
    message: `确认布阵「${formation.name}」？\n激活后持续 4 小时，期间无法切换其他阵法\n布阵将消耗灵石并 +1 熟练度`,
    confirmText: '布阵',
    cancelText: '取消',
    type: 'warning',
    onConfirm: async () => {
      closeConfirm()
      await doActivate(formation.id)
    }
  }
}

/**
 * 执行布阵
 */
const doActivate = async (formationId) => {
  loading.value = true
  try {
    const res = await activateFormation(formationId)
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '布阵失败', 'warning')
      return
    }
    uiStore.showToast(payload.message || '布阵成功', 'success')
    uiStore.addLog({
      type: 'formation_activate',
      content: `布阵：${payload.data?.formation_name || formationId}（熟练度 ${payload.data?.proficiency || 0}）`
    })
    await fetchStatus()
    view.value = 'active'
  } catch (err) {
    console.error('布阵失败:', err)
    uiStore.showToast('布阵失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 确认撤阵
 */
const confirmDeactivate = () => {
  confirmModal.value = {
    show: true,
    title: '撤阵',
    message: '确认撤阵？\n撤阵后将进入 30 分钟冷却，期间无法再次布阵',
    confirmText: '撤阵',
    cancelText: '取消',
    type: 'warning',
    onConfirm: async () => {
      closeConfirm()
      await doDeactivate()
    }
  }
}

/**
 * 执行撤阵
 */
const doDeactivate = async () => {
  loading.value = true
  try {
    const res = await deactivateFormation()
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '撤阵失败', 'warning')
      return
    }
    uiStore.showToast(payload.message || '撤阵成功', 'success')
    uiStore.addLog({
      type: 'formation_deactivate',
      content: `撤阵：${payload.data?.deactivated_formation_name || ''}`
    })
    await fetchStatus()
  } catch (err) {
    console.error('撤阵失败:', err)
    uiStore.showToast('撤阵失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 关闭确认弹窗
 */
const closeConfirm = () => {
  confirmModal.value.show = false
}

/** 组件挂载时拉取数据 */
onMounted(async () => {
  await Promise.all([fetchConfig(), fetchStatus()])
})

/** 暴露事件 */
defineEmits(['close'])
</script>
