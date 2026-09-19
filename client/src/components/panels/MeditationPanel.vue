/**
 * 静思悟道选择面板组件
 *
 * 弹窗式组件，让玩家在开始悟道前选择时长类型：
 *   - short：静思一刻（60秒），每日多次
 *   - medium：凝神悟道（5分钟），每日多次
 *   - long：闭关参悟（30分钟），每日多次
 *   - deep：深度悟道（1小时），仅瓶颈期可用，需筑基期以上
 *
 * 同时展示：
 *   - 今日剩余次数（常规 / 深度）
 *   - 冷却倒计时
 *   - 瓶颈进度（若处于瓶颈期）
 *   - 当前悟道感悟值
 *
 * 设计原则：
 *   - 所有配置从后端 GET /meditation/config 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 */
<template>
  <PanelShell
    title="静思悟道"
    hint="积累感悟 · 破除瓶颈 · 每日次数与冷却"
    size="md"
    @close="emit('close')"
  >
    <div class="space-y-4">
      <!-- 瓶颈状态展示（仅在处于瓶颈期时显示） -->
      <PanelCard v-if="bottleneckActive" tone="danger" :padded="false" class="px-3.5 py-3">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span class="text-rose-300 font-bold">瓶颈期</span>
          </div>
          <Badge tone="danger">感悟 {{ bottleneckInsight }} / {{ bottleneckThreshold }}</Badge>
        </div>
        <!-- 瓶颈进度 -->
        <StatBar :value="bottleneckInsight" :max="bottleneckThreshold" tone="blood" :show-value="false" height="h-2" />
        <div class="mt-2 text-xs text-rose-300/80">
          需积累 {{ bottleneckThreshold - bottleneckInsight }} 点感悟方可破除瓶颈
        </div>
      </PanelCard>

      <!-- 今日次数总览 -->
      <PanelCard>
        <div class="grid grid-cols-2 gap-3">
          <div class="flex items-center justify-between">
            <div class="text-xs text-fg-muted">常规悟道</div>
            <div class="flex items-center gap-2">
              <div class="text-xs text-fg-faint">今日剩余</div>
              <Badge :tone="normalRemaining > 0 ? 'success' : 'danger'">
                {{ normalRemaining }} / {{ config?.daily_normal_limit || 10 }}
              </Badge>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <div class="text-xs text-fg-muted">深度悟道</div>
            <div class="flex items-center gap-2">
              <div class="text-xs text-fg-faint">今日剩余</div>
              <Badge :tone="deepRemaining > 0 ? 'success' : 'danger'">
                {{ deepRemaining }} / {{ config?.daily_deep_limit || 2 }}
              </Badge>
            </div>
          </div>
        </div>
      </PanelCard>

      <!-- 冷却中提示 -->
      <PanelCard v-if="cooldownRemainingText" tone="gold" :padded="false" class="flex items-center gap-2 px-3 py-2.5 text-xs text-gold-300">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span>悟道冷却中：{{ cooldownRemainingText }}</span>
      </PanelCard>

      <!-- 时长类型选择卡片 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          v-for="(item, key) in durationTypeList"
          :key="key"
          @click="selectType(key)"
          :disabled="loading || !isTypeAvailable(key)"
          class="text-left bg-surface-hover hover:bg-surface-active border rounded-panel p-4 transition-all duration-300 relative disabled:opacity-60 disabled:cursor-not-allowed"
          :class="selectedType === key
            ? 'border-gold-600 ring-1 ring-gold-600/30'
            : 'border-line hover:border-gold-700'"
        >
          <!-- 锁标：今日已用尽 / 冷却中 / 需在瓶颈期 -->
          <Badge v-if="!isTypeAvailable(key)" tone="danger" class="absolute top-2 right-2">
            {{ getTypeLockReason(key) }}
          </Badge>
          <!-- 名称行 -->
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full flex items-center justify-center"
                :class="key === 'deep' ? 'bg-purple-950/40 border border-purple-700/40' : 'bg-amber-950/30 border border-gold-700/30'">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4"
                  :class="key === 'deep' ? 'text-purple-400' : 'text-gold-400'"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 6v6l4 2"/>
                </svg>
              </div>
              <div>
                <div class="text-sm font-bold"
                  :class="key === 'deep' ? 'text-purple-300' : 'text-gold-300'">
                  {{ item.label }}
                </div>
                <div class="text-[10px] text-fg-faint">{{ formatDuration(item.duration) }}</div>
              </div>
            </div>
            <div v-if="selectedType === key" class="w-5 h-5 rounded-full bg-gold-600 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 text-fg-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
          </div>
          <!-- 参数列表 -->
          <ul class="text-xs text-fg-muted space-y-1">
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">基础感悟：</span>
              <span class="text-fg-primary">{{ item.insight_base }} + {{ item.insight_random }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">修为奖励：</span>
              <span class="text-fg-primary">{{ (item.exp_reward_rate * 100).toFixed(1) }}% 当前修为</span>
            </li>
            <li v-if="key === 'deep'" class="flex items-center gap-2">
              <span class="text-fg-faint">深度悟道：</span>
              <span class="text-purple-400">瓶颈期可用，3倍感悟加成</span>
            </li>
          </ul>
        </button>
      </div>

      <!-- 深度悟道说明（紫调信息块，保留原有色相） -->
      <div v-if="selectedType === 'deep'" class="bg-purple-950/20 border border-purple-900/40 rounded-panel p-3 text-xs text-purple-300 flex items-start gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <span>深度悟道为高阶玩法，需筑基期以上且处于瓶颈期方可进行；中断时损失 50% 感悟值，请确保有完整时间。</span>
      </div>
    </div>

    <!-- 底部操作栏 -->
    <template #footer>
      <AppButton variant="outline" @click="emit('close')">取消</AppButton>
      <button
        @click="handleStart"
        :disabled="loading || !selectedType || !isTypeAvailable(selectedType)"
        class="flex-1 min-h-9 rounded-control font-bold tracking-widest text-sm transition-colors disabled:opacity-50 disabled:pointer-events-none bg-amber-950/40 border border-gold-700 text-gold-300 hover:bg-gold-900/40 hover:border-gold-500"
      >
        <span v-if="loading">正在进入...</span>
        <span v-else-if="!selectedType">请选择时长类型</span>
        <span v-else-if="!isTypeAvailable(selectedType)">{{ getTypeLockReason(selectedType) }}</span>
        <span v-else>开始悟道</span>
      </button>
    </template>
  </PanelShell>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { formatTime } from '../../utils/format'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import StatBar from '../ui/StatBar.vue'
import {
  getStatus,
  getConfig,
  startMeditation
} from '../../api/meditation'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

const loading = ref(false)
const selectedType = ref('')
const status = ref(null)
const config = ref(null)
// 当前时间 tick（每秒更新一次，用于驱动冷却倒计时显示）
const now = ref(Date.now())
let tickTimer = null

/**
 * 时长类型列表（按 short/medium/long/deep 顺序展示）
 * 直接从后端 config 拉取，禁止硬编码
 */
const durationTypeList = computed(() => {
  if (!config.value) return {}
  const list = { ...config.value.duration_types }
  // 深度悟道单独加入（仅在瓶颈期时可选）
  if (config.value.deep?.enabled) {
    list.deep = config.value.deep
  }
  return list
})

/**
 * 今日剩余常规悟道次数
 */
const normalRemaining = computed(() => {
  if (!status.value || !config.value) return config.value?.daily_normal_limit ?? 10
  return Math.max(0, config.value.daily_normal_limit - (status.value.daily_meditation_count || 0))
})

/**
 * 今日剩余深度悟道次数
 */
const deepRemaining = computed(() => {
  if (!status.value || !config.value) return config.value?.daily_deep_limit ?? 2
  return Math.max(0, config.value.daily_deep_limit - (status.value.daily_deep_meditation_count || 0))
})

/**
 * 冷却剩余秒数（基于后端权威值 + 本地 tick 递减）
 */
const cooldownRemaining = computed(() => {
  if (!status.value) return 0
  const backendRemaining = status.value.cooldown_remaining || 0
  if (backendRemaining <= 0) return 0
  const serverTime = status.value.server_time || Date.now()
  const localElapsedSec = Math.floor((now.value - serverTime) / 1000)
  return Math.max(0, backendRemaining - localElapsedSec)
})

/**
 * 冷却剩余文案
 */
const cooldownRemainingText = computed(() => {
  const sec = cooldownRemaining.value
  if (sec <= 0) return ''
  return `还需 ${formatTime(sec)}`
})

/**
 * 是否处于瓶颈期
 */
const bottleneckActive = computed(() => {
  return status.value?.bottleneck?.state === 'active'
})

/**
 * 瓶颈当前感悟值
 */
const bottleneckInsight = computed(() => {
  return status.value?.bottleneck?.insight || 0
})

/**
 * 瓶颈阈值
 */
const bottleneckThreshold = computed(() => {
  return status.value?.bottleneck?.threshold || 100
})

/**
 * 判断指定时长类型是否可用
 * - short/medium/long：检查剩余次数 + 冷却
 * - deep：检查剩余次数 + 冷却 + 境界要求 + 瓶颈期
 */
const isTypeAvailable = (typeKey) => {
  if (!typeKey) return false
  if (cooldownRemaining.value > 0) return false
  if (typeKey === 'deep') {
    if (deepRemaining.value <= 0) return false
    // 深度悟道需要处于瓶颈期
    if (!bottleneckActive.value) return false
    // 深度悟道境界要求由后端校验，前端仅做提示
  } else {
    if (normalRemaining.value <= 0) return false
  }
  return true
}

/**
 * 获取时长类型的不可用原因文案
 */
const getTypeLockReason = (typeKey) => {
  if (cooldownRemaining.value > 0) return '冷却中'
  if (typeKey === 'deep') {
    if (deepRemaining.value <= 0) return '今日已用尽'
    if (!bottleneckActive.value) return '需在瓶颈期'
  } else {
    if (normalRemaining.value <= 0) return '今日已用尽'
  }
  return ''
}

/**
 * 选择时长类型
 */
const selectType = (typeKey) => {
  if (!isTypeAvailable(typeKey)) {
    uiStore.showToast(getTypeLockReason(typeKey) || '当前不可用', 'warning')
    return
  }
  selectedType.value = typeKey
}

/**
 * 格式化时长（秒 → 中文）
 */
const formatDuration = (seconds) => {
  return formatTime(seconds || 0)
}

/**
 * 开始悟道
 */
const handleStart = async () => {
  if (loading.value) return
  if (!selectedType.value || !isTypeAvailable(selectedType.value)) {
    uiStore.showToast('请选择可用的时长类型', 'warning')
    return
  }
  loading.value = true
  try {
    const res = await startMeditation(selectedType.value)
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '已进入静思悟道状态', 'success')
    uiStore.addLog({
      content: `开始静思悟道（${durationTypeList.value[selectedType.value]?.label || selectedType.value}），摒除杂念，参悟天地至理。`,
      type: 'info',
      actorId: 'self'
    })
    emit('close')
  } catch (error) {
    console.error('开始悟道失败:', error)
    uiStore.showApiError(error, '开始悟道失败')
  } finally {
    loading.value = false
  }
}

/**
 * 拉取悟道状态
 */
const fetchStatus = async () => {
  try {
    const res = await getStatus()
    status.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取悟道状态失败:', err)
  }
}

/**
 * 拉取悟道配置
 */
const fetchConfig = async () => {
  try {
    const res = await getConfig()
    config.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取悟道配置失败:', err)
  }
}

onMounted(async () => {
  await Promise.all([fetchStatus(), fetchConfig()])
  // 默认选择 medium
  if (isTypeAvailable('medium')) {
    selectedType.value = 'medium'
  } else if (isTypeAvailable('short')) {
    selectedType.value = 'short'
  }
  // 启动每秒 tick
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
})
</script>
