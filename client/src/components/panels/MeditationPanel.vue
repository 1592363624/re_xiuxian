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
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-stone-800 rounded-lg p-6 max-w-2xl w-full mx-4 shadow-2xl animate-fade-in max-h-[85vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-amber-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
          静思悟道
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- 瓶颈状态展示（仅在处于瓶颈期时显示） -->
        <div v-if="bottleneckActive" class="bg-rose-950/30 border border-rose-800/50 rounded-lg p-4">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span class="text-rose-300 font-bold">瓶颈期</span>
            </div>
            <span class="text-xs text-rose-400">感悟 {{ bottleneckInsight }} / {{ bottleneckThreshold }}</span>
          </div>
          <!-- 瓶颈进度条 -->
          <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
            <div
              class="h-full bg-gradient-to-r from-rose-700 to-amber-500 transition-all duration-500"
              :style="{ width: `${bottleneckProgress}%` }"
            ></div>
          </div>
          <div class="mt-2 text-xs text-rose-300/80">
            需积累 {{ bottleneckThreshold - bottleneckInsight }} 点感悟方可破除瓶颈
          </div>
        </div>

        <!-- 今日次数总览 -->
        <div class="grid grid-cols-2 gap-3 bg-[#292524] rounded-lg p-3 border border-stone-700">
          <div class="flex items-center justify-between">
            <div class="text-xs text-stone-400">常规悟道</div>
            <div class="flex items-center gap-2">
              <div class="text-xs text-stone-500">今日剩余</div>
              <div class="px-2 py-0.5 rounded text-xs font-bold"
                :class="normalRemaining > 0
                  ? 'bg-emerald-950/50 border border-emerald-800/60 text-emerald-400'
                  : 'bg-rose-950/50 border border-rose-800/60 text-rose-400'">
                {{ normalRemaining }} / {{ config?.daily_normal_limit || 10 }}
              </div>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <div class="text-xs text-stone-400">深度悟道</div>
            <div class="flex items-center gap-2">
              <div class="text-xs text-stone-500">今日剩余</div>
              <div class="px-2 py-0.5 rounded text-xs font-bold"
                :class="deepRemaining > 0
                  ? 'bg-emerald-950/50 border border-emerald-800/60 text-emerald-400'
                  : 'bg-rose-950/50 border border-rose-800/60 text-rose-400'">
                {{ deepRemaining }} / {{ config?.daily_deep_limit || 2 }}
              </div>
            </div>
          </div>
        </div>

        <!-- 冷却中提示 -->
        <div v-if="cooldownRemainingText" class="bg-amber-950/30 border border-amber-800/50 rounded-lg p-2.5 text-xs text-amber-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          <span>悟道冷却中：{{ cooldownRemainingText }}</span>
        </div>

        <!-- 时长类型选择卡片 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            v-for="(item, key) in durationTypeList"
            :key="key"
            @click="selectType(key)"
            :disabled="loading || !isTypeAvailable(key)"
            class="text-left bg-[#292524] hover:bg-[#332b27] border rounded-lg p-4 transition-all duration-300 relative disabled:opacity-60 disabled:cursor-not-allowed"
            :class="selectedType === key
              ? 'border-amber-600 ring-1 ring-amber-600/30'
              : 'border-stone-700 hover:border-amber-700'"
          >
            <!-- 锁标：今日已用尽 -->
            <div v-if="!isTypeAvailable(key)" class="absolute top-2 right-2 px-2 py-0.5 rounded bg-rose-950/60 border border-rose-800/60 text-rose-400 text-[10px] font-bold">
              {{ getTypeLockReason(key) }}
            </div>
            <!-- 名称行 -->
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <div class="w-8 h-8 rounded-full flex items-center justify-center"
                  :class="key === 'deep' ? 'bg-purple-950/40 border border-purple-700/40' : 'bg-amber-950/30 border border-amber-700/30'">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4"
                    :class="key === 'deep' ? 'text-purple-400' : 'text-amber-400'"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-bold"
                    :class="key === 'deep' ? 'text-purple-300' : 'text-amber-300'">
                    {{ item.label }}
                  </div>
                  <div class="text-[10px] text-stone-500">{{ formatDuration(item.duration) }}</div>
                </div>
              </div>
              <div v-if="selectedType === key" class="w-5 h-5 rounded-full bg-amber-600 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
            </div>
            <!-- 参数列表 -->
            <ul class="text-xs text-stone-400 space-y-1">
              <li class="flex items-center gap-2">
                <span class="text-stone-500">基础感悟：</span>
                <span class="text-stone-200">{{ item.insight_base }} + {{ item.insight_random }}</span>
              </li>
              <li class="flex items-center gap-2">
                <span class="text-stone-500">修为奖励：</span>
                <span class="text-stone-200">{{ (item.exp_reward_rate * 100).toFixed(1) }}% 当前修为</span>
              </li>
              <li v-if="key === 'deep'" class="flex items-center gap-2">
                <span class="text-stone-500">深度悟道：</span>
                <span class="text-purple-400">瓶颈期可用，3倍感悟加成</span>
              </li>
            </ul>
          </button>
        </div>

        <!-- 深度悟道说明 -->
        <div v-if="selectedType === 'deep'" class="bg-purple-950/20 border border-purple-900/40 rounded-lg p-3 text-xs text-purple-300">
          <svg xmlns="http://www.w3.org/2000/svg" class="inline w-4 h-4 mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          深度悟道为高阶玩法，需筑基期以上且处于瓶颈期方可进行；中断时损失 50% 感悟值，请确保有完整时间。
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="mt-4 flex gap-2">
        <button
          @click="$emit('close')"
          class="px-4 py-2.5 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors"
        >
          取消
        </button>
        <button
          @click="handleStart"
          :disabled="loading || !selectedType || !isTypeAvailable(selectedType)"
          class="flex-1 py-2.5 rounded-lg font-bold tracking-widest text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-amber-950/40 border border-amber-700 text-amber-300 hover:bg-amber-900/40 hover:border-amber-500"
        >
          <span v-if="loading">正在进入...</span>
          <span v-else-if="!selectedType">请选择时长类型</span>
          <span v-else-if="!isTypeAvailable(selectedType)">{{ getTypeLockReason(selectedType) }}</span>
          <span v-else>开始悟道</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { formatTime } from '../../utils/format'
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
 * 瓶颈进度百分比
 */
const bottleneckProgress = computed(() => {
  const threshold = bottleneckThreshold.value || 100
  const insight = bottleneckInsight.value || 0
  return Math.min(100, Math.floor((insight / threshold) * 100))
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
    const msg = error?.response?.data?.message || '开始悟道失败'
    uiStore.showToast(msg, 'error')
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

<style scoped>
.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}
.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}
.overflow-y-auto::-webkit-scrollbar-thumb {
  background: #44403c;
  border-radius: 2px;
}
.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: #57534e;
}
</style>
