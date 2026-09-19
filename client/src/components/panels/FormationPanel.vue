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
  <PanelShell
    title="阵法堂"
    size="xl"
    @close="$emit('close')"
  >
    <!-- 状态总览栏 -->
    <div v-if="status" class="bg-surface-raised border border-line rounded-panel p-3 mb-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
      <div>
        <div class="text-fg-muted">当前境界</div>
        <div class="text-gold-400 font-bold">{{ status.realm_name }}</div>
      </div>
      <div>
        <div class="text-fg-muted">已学阵法</div>
        <div class="text-state-info font-bold num">{{ status.learned_count }} 部</div>
      </div>
      <div>
        <div class="text-fg-muted">激活状态</div>
        <div class="font-bold" :class="status.active_formation ? 'text-state-success' : 'text-fg-secondary'">
          {{ status.active_formation ? status.active_formation.name : '未激活' }}
        </div>
      </div>
      <div>
        <div class="text-fg-muted">撤阵冷却</div>
        <div class="font-bold num" :class="status.deactivate_cooldown_ready ? 'text-state-success' : 'text-gold-400'">
          {{ status.deactivate_cooldown_ready ? '就绪' : `${formatTime(status.deactivate_cooldown_remaining_sec)}` }}
        </div>
      </div>
    </div>

    <!-- 未解锁提示 -->
    <div v-if="status && !status.unlocked" class="bg-surface-tint-gold border border-gold-800/50 rounded-panel p-4 mb-4 text-gold-300 text-sm text-center">
      境界不足，需达到更高境界方可研习阵法之道
    </div>

    <!-- 标签页切换 -->
    <Tabs
      v-if="status?.unlocked"
      :model-value="view"
      :items="tabs"
      @update:model-value="switchView"
    />

    <!-- 内容区 -->
    <div class="pt-4 space-y-3">
      <!-- 视图1：阵法图鉴 -->
      <div v-if="view === 'atlas' && config" class="space-y-3">
        <div class="text-fg-secondary text-xs mb-2">
          共 <span class="num">{{ config.formations.length }}</span> 部阵法 · 4类（攻杀/护身/辅助/奇门） · 4品阶（凡/灵/仙/圣）
        </div>

        <div v-for="formation in config.formations" :key="formation.id"
          class="bg-surface-raised border border-line rounded-panel p-4 hover:border-line-strong transition-colors">
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1 flex-wrap">
                <span class="text-gold-400 font-bold font-display">{{ formation.name }}</span>
                <span :class="['text-xs px-1.5 py-0.5 rounded border', getCategoryClass(formation.category)]">
                  {{ formation.category_display }}
                </span>
                <span :class="['text-xs px-1.5 py-0.5 rounded border', getGradeClass(formation.grade)]">
                  {{ formation.grade_display }}
                </span>
                <Badge v-if="isLearned(formation.id)" tone="success">已学</Badge>
                <Badge v-if="status?.active_formation?.formation_id === formation.id" tone="info" solid>激活中</Badge>
              </div>
              <div class="text-fg-secondary text-xs mb-2 wrap-cjk">{{ formation.description }}</div>
              <div class="text-fg-faint text-xs italic mb-2 wrap-cjk">「{{ formation.lore }}」</div>

              <!-- 效果展示 -->
              <div class="flex flex-wrap gap-2 mb-2">
                <span v-for="(value, key) in formation.effects" :key="key"
                  class="text-xs px-2 py-0.5 rounded bg-surface-sunken border border-line text-fg-secondary num">
                  {{ getEffectLabel(key) }} +{{ (value * 100).toFixed(0) }}%
                </span>
              </div>

              <!-- 学习条件 -->
              <div class="text-xs text-fg-muted grid grid-cols-2 md:grid-cols-3 gap-2">
                <div>境界：<span :class="status?.realm_rank >= formation.min_realm_rank ? 'text-state-success' : 'text-state-danger'">{{ formation.recommended_realm }}</span></div>
                <div>学习消耗：<span class="text-gold-400 num">{{ formatCompact(formation.learn_cost_spirit_stones) }} 灵石</span></div>
                <div>布阵消耗：<span class="text-gold-400 num">{{ formatCompact(formation.activate_cost_spirit_stones) }} 灵石</span></div>
                <div v-if="formation.prerequisite_formation_id" class="md:col-span-3">
                  前置阵法：<span :class="isLearned(formation.prerequisite_formation_id) ? 'text-state-success' : 'text-state-danger'">
                    {{ getFormationName(formation.prerequisite_formation_id) }}
                  </span>
                </div>
              </div>
            </div>

            <!-- 操作按钮 -->
            <div class="flex flex-col gap-2 shrink-0">
              <AppButton v-if="!isLearned(formation.id)" size="sm" variant="primary" :disabled="loading" @click="confirmLearn(formation)">
                学习
              </AppButton>
              <AppButton v-else-if="!status?.active_formation || status.active_formation.formation_id !== formation.id"
                size="sm" variant="outline" :disabled="loading" @click="confirmActivate(formation)">
                布阵
              </AppButton>
              <span v-else class="text-xs text-state-info px-3 py-1.5">激活中</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 视图2：我的阵法 -->
      <div v-else-if="view === 'mine' && status" class="space-y-3">
        <EmptyState
          v-if="status.learned_formations.length === 0"
          text="尚未学习任何阵法"
          hint="请前往「阵法图鉴」研习"
        />

        <div v-for="lf in status.learned_formations" :key="lf.formation_id"
          class="bg-surface-raised border border-line rounded-panel p-4"
          :class="{ 'border-state-info/50 bg-surface-tint-arcane': status.active_formation?.formation_id === lf.formation_id }">
          <div class="flex items-start justify-between gap-3 mb-2">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-gold-400 font-bold font-display">{{ lf.name }}</span>
              <span v-if="lf.category_display" :class="['text-xs px-1.5 py-0.5 rounded border', getCategoryClass(lf.category)]">
                {{ lf.category_display }}
              </span>
              <span v-if="lf.grade_display" :class="['text-xs px-1.5 py-0.5 rounded border', getGradeClass(lf.grade)]">
                {{ lf.grade_display }}
              </span>
            </div>
            <div class="flex gap-2 shrink-0">
              <AppButton v-if="status.active_formation?.formation_id !== lf.formation_id"
                size="xs" variant="outline" :disabled="loading"
                @click="confirmActivate({ id: lf.formation_id, name: lf.name })">
                布阵
              </AppButton>
              <span v-else class="text-xs text-state-info px-3 py-1">激活中</span>
            </div>
          </div>

          <!-- 熟练度进度条 -->
          <div class="mb-2">
            <div class="flex justify-between text-xs text-fg-secondary mb-1">
              <span class="num">熟练度 {{ lf.proficiency }} / {{ lf.proficiency_max }}</span>
              <span class="text-gold-400 num">效果加成 +{{ getProficiencyBonus(lf.proficiency) }}%</span>
            </div>
            <StatBar :value="lf.proficiency" :max="lf.proficiency_max" tone="gold" :show-value="false" />
          </div>

          <!-- 实际效果 -->
          <div v-if="lf.effects" class="flex flex-wrap gap-2">
            <span v-for="(value, key) in getDisplayableEffects(lf.effects)" :key="key"
              class="text-xs px-2 py-0.5 rounded bg-surface-sunken border border-line text-fg-secondary num">
              {{ getEffectLabel(key) }} +{{ (value * 100).toFixed(1) }}%
            </span>
          </div>
        </div>
      </div>

      <!-- 视图3：当前激活 -->
      <div v-else-if="view === 'active' && status" class="space-y-3">
        <EmptyState
          v-if="!status.active_formation"
          text="当前无激活阵法"
          hint="布阵后可获得属性加成，增强战力"
        />

        <div v-else class="bg-surface-tint-gold border border-state-info/40 rounded-panel p-5">
          <div class="flex items-center gap-3 mb-3 flex-wrap">
            <span class="text-xl text-gold-400 font-bold font-display">{{ status.active_formation.name }}</span>
            <span :class="['text-xs px-2 py-0.5 rounded border', getCategoryClass(status.active_formation.category)]">
              {{ status.active_formation.category_display }}
            </span>
            <span :class="['text-xs px-2 py-0.5 rounded border', getGradeClass(status.active_formation.grade)]">
              {{ status.active_formation.grade_display }}
            </span>
            <span class="text-xs px-2 py-0.5 rounded bg-surface-sunken border border-line text-state-info num">
              熟练度 {{ status.active_formation.proficiency }}
            </span>
          </div>

          <div class="text-fg-secondary text-sm mb-3 wrap-cjk">{{ status.active_formation.description }}</div>

          <!-- 剩余时间 -->
          <div class="bg-surface-sunken rounded-panel p-3 mb-3">
            <div class="flex justify-between text-xs mb-1">
              <span class="text-fg-secondary">剩余持续时间</span>
              <span class="text-gold-400 font-bold num">{{ formatTime(status.active_formation.remaining_seconds) }}</span>
            </div>
            <StatBar
              :value="status.active_formation.remaining_seconds"
              :max="status.active_formation.duration_seconds"
              tone="jade"
              :show-value="false"
              height="h-2"
            />
          </div>

          <!-- 实际效果 -->
          <div class="mb-3">
            <div class="text-xs text-fg-secondary mb-2">当前实际效果（含熟练度加成）</div>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
              <div v-for="(value, key) in getDisplayableEffects(status.active_formation.effects)" :key="key"
                class="bg-surface-sunken rounded-control p-2 text-center border border-line-subtle">
                <div class="text-xs text-fg-muted">{{ getEffectLabel(key) }}</div>
                <div class="text-state-success font-bold num">+{{ (value * 100).toFixed(1) }}%</div>
              </div>
            </div>
          </div>

          <!-- 撤阵按钮 -->
          <AppButton block variant="danger" :disabled="loading" @click="confirmDeactivate">
            撤阵（进入 {{ formatTime(status.active_duration_seconds === 0 ? 0 : (status.deactivate_cooldown_remaining_sec || 1800)) }} 冷却）
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 二次确认弹窗 -->
    <!-- 二次确认弹窗。Modal 的开关属性是 isOpen，正文走默认插槽、按钮走 #footer，
         它没有 message/confirmText/cancelText/type 这几个 prop；之前当确认框用，
         渲染出来只有标题和 ✕，布阵/拆阵的确认按钮不存在，流程走不到。 -->
    <Modal :is-open="confirmModal.show" :title="confirmModal.title" @close="closeConfirm">
      <p class="text-sm leading-relaxed whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <AppButton variant="outline" @click="closeConfirm">{{ confirmModal.cancelText }}</AppButton>
        <AppButton
          :variant="confirmModal.type === 'danger' || confirmModal.type === 'error' ? 'danger' : 'primary'"
          @click="confirmModal.onConfirm"
        >{{ confirmModal.confirmText }}</AppButton>
      </template>
    </Modal>

    <!-- 处理遮罩：absolute 定位到 PanelShell 的 .panel-body，盖住整块面板 -->
    <div v-if="loading" class="absolute inset-0 z-10 grid place-items-center bg-black/55 backdrop-blur-[1px]">
      <div class="flex items-center gap-2 text-[13px] text-gold-300">
        <span class="inline-block w-4 h-4 rounded-full border-2 border-gold-700 border-t-gold-400 animate-spin"></span>
        处理中…
      </div>
    </div>
  </PanelShell>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { formatTime, formatCompact } from '../../utils/format'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import StatBar from '../ui/StatBar.vue'
import EmptyState from '../ui/EmptyState.vue'
import {
  getConfig,
  getStatus,
  learnFormation,
  activateFormation,
  deactivateFormation
} from '../../api/formation'

const uiStore = useUIStore()

/** 标签页定义（key/label 契约见 ui/Tabs.vue） */
const tabs = [
  { key: 'atlas', label: '阵法图鉴' },
  { key: 'mine', label: '我的阵法' },
  { key: 'active', label: '当前激活' }
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
 * 阵法分类样式（分类色沿用 state-* 语义色，中性档走 surface / line / fg 令牌）
 */
const getCategoryClass = (category) => {
  const classes = {
    attack: 'bg-rose-950/40 border-rose-700 text-rose-300',
    defense: 'bg-blue-950/40 border-blue-700 text-blue-300',
    support: 'bg-emerald-950/40 border-emerald-700 text-emerald-300',
    special: 'bg-purple-950/40 border-purple-700 text-purple-300'
  }
  return classes[category] || 'bg-surface-sunken border-line text-fg-secondary'
}

/**
 * 阵法品阶样式（凡/灵/仙/圣）
 */
const getGradeClass = (grade) => {
  const classes = {
    mortal: 'bg-surface-active border-line-strong text-fg-secondary',
    spirit: 'bg-cyan-950/40 border-cyan-700 text-cyan-300',
    immortal: 'bg-surface-tint-gold border-gold-700 text-gold-300',
    saint: 'bg-purple-950/40 border-purple-600 text-purple-300'
  }
  return classes[grade] || 'bg-surface-active border-line-strong text-fg-secondary'
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
    uiStore.showApiError(err, '获取阵法配置失败')
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
    uiStore.showApiError(err, '获取阵法状态失败')
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
    uiStore.showApiError(err, '学习阵法失败')
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
    uiStore.showApiError(err, '布阵失败')
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
    uiStore.showApiError(err, '撤阵失败')
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
