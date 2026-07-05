/**
 * 静思悟道浮动状态条组件
 *
 * 玩家在悟道中时显示的浮动状态条，参考 SeclusionOverlay 设计：
 *   - 显示悟道模式、已积累感悟值、悟道时长、剩余时间、进度条
 *   - 提供"中断悟道"按钮（带惩罚，仅完成度比例发放感悟值）
 *   - 展开后显示瓶颈进度（若处于瓶颈期）
 *
 * 数据来源：通过 GET /meditation/status 拉取，并通过本地 tick 计算实时进度
 *
 * 设计原则：
 *   - 所有展示数据由后端权威计算，前端仅做时间 tick 平滑递减
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 */
<template>
  <div class="relative z-30">
    <!-- 浮动状态条 -->
    <div
      class="flex items-center gap-3 px-4 py-2.5 bg-[#1a1510]/95 border-b backdrop-blur-sm select-none"
      :class="isDeep ? 'border-purple-900/50' : 'border-amber-900/40'"
    >
      <!-- 左侧图标 + 标题 -->
      <div class="flex items-center gap-2.5 shrink-0">
        <div class="relative w-7 h-7 flex items-center justify-center">
          <!-- 旋转光环 -->
          <div
            class="absolute inset-0 border rounded-full animate-[spin_8s_linear_infinite]"
            :class="isDeep ? 'border-purple-500/40' : 'border-amber-500/30'"
          ></div>
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            :class="isDeep ? 'text-purple-400' : 'text-amber-400'">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
        </div>
        <!-- 模式标识 -->
        <div class="flex flex-col">
          <span class="text-sm font-bold tracking-wider hidden sm:inline"
            :class="isDeep ? 'text-purple-300' : 'text-amber-300'">
            {{ modeLabel }}中
          </span>
          <span class="text-sm font-bold tracking-wider sm:hidden"
            :class="isDeep ? 'text-purple-300' : 'text-amber-300'">
            悟道
          </span>
          <span v-if="isDeep" class="text-[10px] text-purple-500/80 tracking-wider">3倍感悟</span>
        </div>
      </div>

      <!-- 中间数据区 -->
      <div class="flex items-center gap-4 text-xs text-stone-400 flex-1 min-w-0">
        <!-- 当前感悟值 -->
        <div class="flex items-center gap-1.5 shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-500">
            <path d="M12 2 4 7v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V7l-8-5z"/>
          </svg>
          <span class="text-amber-400 font-mono font-bold">{{ currentInsight }}</span>
        </div>
        <!-- 已悟道时长 -->
        <div class="flex items-center gap-1.5 shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-stone-500">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
          <span class="font-mono">{{ formatTime(elapsedSeconds) }}</span>
        </div>
        <!-- 剩余时间 -->
        <div v-if="remainingSeconds > 0" class="hidden md:flex items-center gap-1.5 shrink-0">
          <span class="text-stone-500">剩余</span>
          <span class="font-mono" :class="isDeep ? 'text-purple-300' : 'text-amber-300'">{{ formatTime(remainingSeconds) }}</span>
        </div>
        <!-- 进度条 -->
        <div class="hidden lg:flex items-center gap-1.5 shrink-0 min-w-[80px]">
          <div class="flex-1 h-1.5 bg-stone-800 rounded-full overflow-hidden">
            <div
              class="h-full transition-all duration-1000"
              :class="isDeep
                ? 'bg-gradient-to-r from-purple-700 to-purple-400'
                : 'bg-gradient-to-r from-amber-700 to-amber-400'"
              :style="{ width: `${progressPercent}%` }"
            ></div>
          </div>
          <span class="font-mono text-[10px]" :class="isDeep ? 'text-purple-400' : 'text-amber-400'">{{ progressPercent }}%</span>
        </div>
      </div>

      <!-- 右侧操作按钮 -->
      <div class="flex items-center gap-2 shrink-0">
        <!-- 展开/收起按钮 -->
        <button
          @click="expanded = !expanded"
          class="p-1.5 rounded text-stone-500 hover:text-amber-400 hover:bg-amber-950/30 transition-colors"
          :title="expanded ? '收起详情' : '展开详情'"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            :class="{ 'rotate-180': expanded }"
            class="transition-transform duration-200"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <!-- 中断悟道按钮 -->
        <button
          @click="handleInterruptClick"
          :disabled="loading"
          class="px-3 py-1 text-xs rounded border border-rose-800/60 text-rose-400 hover:text-rose-300 hover:border-rose-600 hover:bg-rose-950/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed tracking-wider"
          :title="`中断悟道将损失 ${interruptPenaltyPercent} 感悟值`"
        >
          <span v-if="loading">结算中...</span>
          <span v-else>中断悟道</span>
        </button>
      </div>
    </div>

    <!-- 展开详情面板 -->
    <Transition name="meditation-panel">
      <div v-if="expanded" class="absolute top-full left-0 right-0 z-40">
        <div
          class="bg-[#141210]/98 border-b backdrop-blur-md px-6 py-6"
          :class="isDeep ? 'border-purple-900/40' : 'border-amber-900/30'"
        >
          <!-- 背景动画 -->
          <div class="absolute inset-0 overflow-hidden pointer-events-none">
            <div
              class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full blur-3xl animate-pulse"
              :class="isDeep ? 'bg-purple-900/10' : 'bg-amber-900/5'"
            ></div>
          </div>

          <div class="relative z-10 max-w-lg mx-auto">
            <!-- 核心动画图标 -->
            <div class="flex justify-center mb-6">
              <div class="relative">
                <div
                  class="absolute inset-0 -m-6 border rounded-full animate-[spin_10s_linear_infinite]"
                  :class="isDeep ? 'border-purple-500/20' : 'border-amber-500/15'"
                ></div>
                <div
                  class="absolute inset-0 -m-3 border rounded-full animate-[spin_15s_linear_infinite_reverse]"
                  :class="isDeep ? 'border-purple-500/30' : 'border-amber-500/25'"
                ></div>
                <div
                  class="w-20 h-20 rounded-full border-2 flex items-center justify-center"
                  :class="isDeep
                    ? 'bg-gradient-to-b from-purple-950 to-black border-purple-500/50 shadow-[0_0_25px_rgba(168,85,247,0.3)]'
                    : 'bg-gradient-to-b from-stone-900 to-black border-amber-500/40 shadow-[0_0_25px_rgba(245,158,11,0.25)]'"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                    :class="isDeep ? 'text-purple-400' : 'text-amber-400'">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                </div>
              </div>
            </div>

            <!-- 标题 -->
            <div class="text-center mb-6">
              <h3 class="text-lg font-bold tracking-[0.3em] text-white mb-2">
                {{ isDeep ? '深度悟道中' : '静思悟道中' }}
              </h3>
              <div
                class="inline-block px-3 py-0.5 rounded-full text-xs tracking-widest"
                :class="isDeep
                  ? 'bg-purple-950/40 border border-purple-900/50 text-purple-400'
                  : 'bg-amber-950/30 border border-amber-900/40 text-amber-400'"
              >
                {{ isDeep ? '参悟大道至理，凝练元神' : '正在参悟天地玄机' }}
              </div>
            </div>

            <!-- 统计数据 -->
            <div class="grid grid-cols-3 gap-4 mb-6">
              <div class="bg-[#1c1917] rounded-lg p-3 border border-stone-800 text-center">
                <div class="text-stone-500 text-xs mb-1.5">悟道时长</div>
                <div class="text-xl font-mono text-white">{{ formatTime(elapsedSeconds) }}</div>
              </div>
              <div class="bg-[#1c1917] rounded-lg p-3 border border-stone-800 text-center">
                <div class="text-stone-500 text-xs mb-1.5">当前感悟</div>
                <div
                  class="text-xl font-mono font-bold"
                  :class="isDeep ? 'text-purple-400' : 'text-amber-400'"
                >{{ currentInsight }}</div>
              </div>
              <div class="bg-[#1c1917] rounded-lg p-3 border border-stone-800 text-center">
                <div class="text-stone-500 text-xs mb-1.5">剩余时间</div>
                <div class="text-xl font-mono text-emerald-400">{{ formatTime(remainingSeconds) }}</div>
              </div>
            </div>

            <!-- 进度条 -->
            <div class="mb-6">
              <div class="flex justify-between text-xs text-stone-500 mb-1.5">
                <span>悟道进度</span>
                <span>{{ progressPercent }}% / 剩余 {{ formatTime(remainingSeconds) }}</span>
              </div>
              <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                <div
                  class="h-full transition-all duration-1000"
                  :class="isDeep
                    ? 'bg-gradient-to-r from-purple-700 via-purple-500 to-purple-300'
                    : 'bg-gradient-to-r from-amber-700 via-amber-500 to-amber-300'"
                  :style="{ width: `${progressPercent}%` }"
                ></div>
              </div>
            </div>

            <!-- 瓶颈进度（若处于瓶颈期） -->
            <div v-if="bottleneckActive" class="mb-6 bg-rose-950/20 border border-rose-900/40 rounded-lg p-3">
              <div class="flex justify-between text-xs mb-1.5">
                <span class="text-rose-400">瓶颈进度</span>
                <span class="text-rose-300">{{ bottleneckInsight }} / {{ bottleneckThreshold }}</span>
              </div>
              <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                <div
                  class="h-full bg-gradient-to-r from-rose-700 to-amber-500 transition-all duration-500"
                  :style="{ width: `${bottleneckProgressPercent}%` }"
                ></div>
              </div>
              <div class="mt-1.5 text-[10px] text-rose-300/80">
                还需 {{ bottleneckThreshold - bottleneckInsight }} 点感悟破除瓶颈
              </div>
            </div>

            <!-- 中断警告 -->
            <div class="mb-4 px-3 py-2 rounded border border-rose-900/50 bg-rose-950/20 text-rose-400 text-xs">
              <svg xmlns="http://www.w3.org/2000/svg" class="inline w-3 h-3 mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              中断悟道将损失 {{ interruptPenaltyPercent }} 感悟值，仅按完成度比例发放
            </div>

            <!-- 操作按钮 -->
            <button
              @click="handleInterruptClick"
              :disabled="loading"
              class="w-full py-2.5 bg-stone-900/80 border border-rose-700/60 text-rose-400 hover:text-rose-300 hover:border-rose-500/50 hover:bg-stone-800 transition-all duration-300 rounded-lg tracking-widest text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span v-if="loading">结算中...</span>
              <span v-else>中断悟道（损失 {{ interruptPenaltyPercent }}）</span>
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 中断确认弹窗 -->
    <Modal :isOpen="confirmInterrupt" title="确认中断悟道" width="420px" @close="confirmInterrupt = false">
      <div class="space-y-3">
        <p class="text-stone-300">确定要中断当前的悟道吗？</p>
        <div class="bg-rose-950/20 border border-rose-900/40 rounded p-3 text-xs text-rose-300">
          <p>中断惩罚：</p>
          <ul class="mt-1 ml-4 list-disc space-y-0.5">
            <li>仅按完成度比例（{{ progressPercent }}%）发放感悟值</li>
            <li>损失 {{ interruptPenaltyPercent }} 感悟值</li>
            <li v-if="bottleneckActive">瓶颈进度仅按比例累加</li>
          </ul>
        </div>
      </div>
      <template #footer>
        <button @click="confirmInterrupt = false" class="px-4 py-2 text-stone-400 hover:text-white transition-colors">取消</button>
        <button @click="confirmInterruptAction" class="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded">确认中断</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useUIStore } from '../../stores/ui'
import { formatTime } from '../../utils/format'
import Modal from '../common/Modal.vue'
import { getStatus, interruptMeditation } from '../../api/meditation'

const uiStore = useUIStore()
const loading = ref(false)
const expanded = ref(false)
const now = ref(Date.now())
const timer = ref(null)

// 拉取的状态数据
const status = ref(null)
// 配置（用于查询时长与中断惩罚率）
const config = ref(null)
// 中断确认弹窗
const confirmInterrupt = ref(false)

/**
 * 是否深度悟道
 */
const isDeep = computed(() => {
  return status.value?.meditation_mode === 'deep'
})

/**
 * 模式标签
 */
const modeLabel = computed(() => {
  const mode = status.value?.meditation_mode
  if (mode === 'deep') return '深度悟道'
  if (mode === 'long') return '闭关参悟'
  if (mode === 'medium') return '凝神悟道'
  if (mode === 'short') return '静思一刻'
  return '悟道'
})

/**
 * 悟道开始时间戳（毫秒）
 */
const startTimeMs = computed(() => {
  if (!status.value?.meditation_start_time) return Date.now()
  return new Date(status.value.meditation_start_time).getTime()
})

/**
 * 悟道结束时间戳（毫秒）
 */
const endTimeMs = computed(() => {
  if (!status.value?.meditation_end_time) return 0
  return new Date(status.value.meditation_end_time).getTime()
})

/**
 * 总时长（秒）
 */
const totalSeconds = computed(() => {
  if (!endTimeMs.value || !startTimeMs.value) return 0
  return Math.max(1, Math.floor((endTimeMs.value - startTimeMs.value) / 1000))
})

/**
 * 已悟道时长（秒）
 */
const elapsedSeconds = computed(() => {
  return Math.max(0, Math.floor((now.value - startTimeMs.value) / 1000))
})

/**
 * 剩余时间（秒）
 */
const remainingSeconds = computed(() => {
  if (!endTimeMs.value) return 0
  return Math.max(0, Math.floor((endTimeMs.value - now.value) / 1000))
})

/**
 * 进度百分比（0-100）
 */
const progressPercent = computed(() => {
  if (totalSeconds.value <= 0) return 0
  const pct = Math.floor((elapsedSeconds.value / totalSeconds.value) * 100)
  return Math.min(100, Math.max(0, pct))
})

/**
 * 当前感悟值
 * 后端在 _settleMeditation 时计算最终感悟，前端实时展示已积累的感悟值
 */
const currentInsight = computed(() => {
  return status.value?.meditation_insight || 0
})

/**
 * 中断惩罚百分比文案
 * 普通悟道 30%，深度悟道 50%
 */
const interruptPenaltyPercent = computed(() => {
  const rate = isDeep.value ? 0.5 : 0.3
  return `${Math.round(rate * 100)}%`
})

/**
 * 是否处于瓶颈期
 */
const bottleneckActive = computed(() => {
  return status.value?.bottleneck?.state === 'active'
})

/**
 * 瓶颈感悟值
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
const bottleneckProgressPercent = computed(() => {
  const threshold = bottleneckThreshold.value || 100
  const insight = bottleneckInsight.value || 0
  return Math.min(100, Math.floor((insight / threshold) * 100))
})

/**
 * 点击中断按钮
 */
const handleInterruptClick = () => {
  if (loading.value) return
  confirmInterrupt.value = true
}

/**
 * 确认中断悟道
 */
const confirmInterruptAction = async () => {
  if (loading.value) return
  loading.value = true
  confirmInterrupt.value = false
  try {
    const res = await interruptMeditation()
    const data = res.data?.data || res.data
    uiStore.addLog({
      content: `中断悟道，完成度 ${Math.floor((data?.completion_rate || 0) * 100)}%，获得感悟 ${data?.insight_gain || 0} 点，修为 ${data?.exp_gain || 0} 点。`,
      type: 'warning',
      actorId: 'self'
    })
    uiStore.showToast(data?.message || '悟道已中断', 'warning')
    // 重新拉取最新状态
    await fetchStatus()
  } catch (err) {
    console.error('中断悟道失败:', err)
    const msg = err?.response?.data?.message || '中断悟道失败'
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

onMounted(async () => {
  await fetchStatus()
  // 每秒 tick，每 5 秒同步后端权威数据
  let syncCounter = 0
  timer.value = setInterval(() => {
    now.value = Date.now()
    syncCounter++
    if (syncCounter >= 5) {
      syncCounter = 0
      fetchStatus()
    }
  }, 1000)
})

onUnmounted(() => {
  if (timer.value) clearInterval(timer.value)
})
</script>

<style scoped>
.meditation-panel-enter-active,
.meditation-panel-leave-active {
  transition: all 0.3s ease;
}

.meditation-panel-enter-from,
.meditation-panel-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
