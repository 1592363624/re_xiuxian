/**
 * 闭关修炼浮动状态条组件（重构版）
 *
 * 重构要点：
 *   1. 区分常规闭关（normal）与深度闭关（deep）两种模式
 *   2. 显示模式标识、进度条、剩余时间、已获修为
 *   3. 深度闭关提供"强行出关"按钮（损失 50% 收益）
 *   4. 常规闭关提供"结束修炼"按钮（正常结算）
 *
 * 设计依据：参考修仙游戏指南文档第 4 节"修炼方式"
 *   常规闭关可随时结束；深度闭关未达最短时长时按强行出关处理
 */
<template>
  <div class="relative z-30">
    <!-- 浮动状态条（始终可见） -->
    <div
      class="flex items-center gap-3 px-4 py-2.5 bg-[#1a1510]/95 border-b backdrop-blur-sm select-none"
      :class="isDeep ? 'border-purple-900/50' : 'border-cyan-900/40'"
    >
      <!-- 左侧图标 + 标题 -->
      <div class="flex items-center gap-2.5 shrink-0">
        <div class="relative w-7 h-7 flex items-center justify-center">
          <!-- 旋转光环（深度闭关为紫色） -->
          <div
            class="absolute inset-0 border rounded-full animate-[spin_8s_linear_infinite]"
            :class="isDeep ? 'border-purple-500/40' : 'border-cyan-500/30'"
          ></div>
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            :class="isDeep ? 'text-purple-400' : 'text-cyan-400'">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <!-- 模式标识 -->
        <div class="flex flex-col">
          <span class="text-sm font-bold tracking-wider hidden sm:inline"
            :class="isDeep ? 'text-purple-300' : 'text-cyan-300'">
            {{ isDeep ? '深度闭关中' : '闭关修炼中' }}
          </span>
          <span class="text-sm font-bold tracking-wider sm:hidden"
            :class="isDeep ? 'text-purple-300' : 'text-cyan-300'">
            {{ isDeep ? '深闭' : '闭关' }}
          </span>
          <!-- 模式标签（深度闭关显示倍率） -->
          <span v-if="isDeep" class="text-[10px] text-purple-500/80 tracking-wider">2倍收益</span>
        </div>
      </div>

      <!-- 中间数据区 -->
      <div class="flex items-center gap-4 text-xs text-stone-400 flex-1 min-w-0">
        <!-- 已获修为（移动端优先显示） -->
        <div class="flex items-center gap-1.5 shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-500">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
            <polyline points="16 7 22 7 22 13"/>
          </svg>
          <span class="text-emerald-400 font-mono font-bold">+{{ expGained }}</span>
        </div>
        <!-- 闭关时长（桌面端显示） -->
        <div class="hidden sm:flex items-center gap-1.5 shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-stone-500">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
          <span class="font-mono">{{ formatTime(duration) }}</span>
        </div>
        <!-- 剩余时间（深度闭关优先显示） -->
        <div v-if="isDeep && remainingTime > 0" class="hidden md:flex items-center gap-1.5 shrink-0">
          <span class="text-purple-500">剩余</span>
          <span class="text-purple-300 font-mono">{{ formatTime(remainingTime) }}</span>
        </div>
        <!-- 进度条（深度闭关显示） -->
        <div v-if="isDeep" class="hidden lg:flex items-center gap-1.5 shrink-0 min-w-[80px]">
          <div class="flex-1 h-1.5 bg-stone-800 rounded-full overflow-hidden">
            <div
              class="h-full bg-gradient-to-r from-purple-700 to-purple-400 transition-all duration-1000"
              :style="{ width: `${progress}%` }"
            ></div>
          </div>
          <span class="text-purple-400 font-mono text-[10px]">{{ progress }}%</span>
        </div>
        <!-- 修为速率（桌面端显示） -->
        <div class="hidden md:flex items-center gap-1.5 shrink-0">
          <span class="text-stone-500">速率</span>
          <span
            class="font-mono"
            :class="isDeep ? 'text-purple-400' : 'text-cyan-400'"
          >{{ expRate }}/秒</span>
        </div>
      </div>

      <!-- 右侧操作按钮 -->
      <div class="flex items-center gap-2 shrink-0">
        <!-- 展开/收起按钮 -->
        <button
          @click="expanded = !expanded"
          class="p-1.5 rounded text-stone-500 hover:text-cyan-400 hover:bg-cyan-950/30 transition-colors"
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
        <!-- 强行出关按钮（深度闭关专用，未达最短时长时显示） -->
        <button
          v-if="isDeep && !reachedMinDuration"
          @click="handleForceEnd"
          :disabled="loading"
          class="px-3 py-1 text-xs rounded border border-amber-800/60 text-amber-400 hover:text-amber-300 hover:border-amber-600 hover:bg-amber-950/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed tracking-wider"
          :title="'强行出关将损失 50% 收益'"
        >
          <span v-if="loading">结算中...</span>
          <span v-else>强行出关</span>
        </button>
        <!-- 结束修炼按钮 -->
        <button
          @click="handleEnd"
          :disabled="loading"
          class="px-3 py-1 text-xs rounded border transition-all disabled:opacity-50 disabled:cursor-not-allowed tracking-wider"
          :class="isDeep
            ? 'border-rose-800/60 text-rose-400 hover:text-rose-300 hover:border-rose-600 hover:bg-rose-950/30'
            : 'border-rose-800/60 text-rose-400 hover:text-rose-300 hover:border-rose-600 hover:bg-rose-950/30'"
        >
          <span v-if="loading">结算中...</span>
          <span v-else>结束修炼</span>
        </button>
      </div>
    </div>

    <!-- 展开详情面板 -->
    <Transition name="seclusion-panel">
      <div v-if="expanded" class="absolute top-full left-0 right-0 z-40">
        <div
          class="bg-[#141210]/98 border-b backdrop-blur-md px-6 py-6"
          :class="isDeep ? 'border-purple-900/40' : 'border-cyan-900/30'"
        >
          <!-- 背景动画 -->
          <div class="absolute inset-0 overflow-hidden pointer-events-none">
            <div
              class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full blur-3xl animate-pulse"
              :class="isDeep ? 'bg-purple-900/10' : 'bg-cyan-900/5'"
            ></div>
          </div>

          <div class="relative z-10 max-w-lg mx-auto">
            <!-- 核心动画图标 -->
            <div class="flex justify-center mb-6">
              <div class="relative">
                <div
                  class="absolute inset-0 -m-6 border rounded-full animate-[spin_10s_linear_infinite]"
                  :class="isDeep ? 'border-purple-500/20' : 'border-cyan-500/15'"
                ></div>
                <div
                  class="absolute inset-0 -m-3 border rounded-full animate-[spin_15s_linear_infinite_reverse]"
                  :class="isDeep ? 'border-purple-500/30' : 'border-cyan-500/25'"
                ></div>
                <div
                  class="w-20 h-20 rounded-full border-2 flex items-center justify-center"
                  :class="[
                    isDeep
                      ? 'bg-gradient-to-b from-purple-950 to-black border-purple-500/50 shadow-[0_0_25px_rgba(168,85,247,0.3)]'
                      : 'bg-gradient-to-b from-stone-900 to-black border-cyan-500/40 shadow-[0_0_25px_rgba(6,182,212,0.25)]'
                  ]"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                    :class="isDeep ? 'text-purple-400' : 'text-cyan-400'">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                  </svg>
                </div>
              </div>
            </div>

            <!-- 标题 -->
            <div class="text-center mb-6">
              <h3 class="text-lg font-bold tracking-[0.3em] text-white mb-2">
                {{ isDeep ? '深度闭关中' : '潜心闭关中' }}
              </h3>
              <div
                class="inline-block px-3 py-0.5 rounded-full text-xs tracking-widest"
                :class="isDeep
                  ? 'bg-purple-950/40 border border-purple-900/50 text-purple-400'
                  : 'bg-cyan-950/30 border border-cyan-900/40 text-cyan-400'"
              >
                {{ isDeep ? '感悟天地至理，凝练元神' : '正在感悟诸天造化' }}
              </div>
              <!-- 强行出关警告（深度闭关未达时长） -->
              <div v-if="isDeep && !reachedMinDuration" class="mt-3 px-3 py-1.5 rounded border border-amber-900/50 bg-amber-950/20 text-amber-400 text-xs">
                <svg xmlns="http://www.w3.org/2000/svg" class="inline w-3 h-3 mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                尚未达到最短时长，提前结束将损失 50% 收益
              </div>
            </div>

            <!-- 统计数据 -->
            <div class="grid grid-cols-3 gap-4 mb-6">
              <div class="bg-[#1c1917] rounded-lg p-3 border border-stone-800 text-center">
                <div class="text-stone-500 text-xs mb-1.5">闭关时长</div>
                <div class="text-xl font-mono text-white">{{ formatTime(duration) }}</div>
              </div>
              <div class="bg-[#1c1917] rounded-lg p-3 border border-stone-800 text-center">
                <div class="text-stone-500 text-xs mb-1.5">已获修为</div>
                <div
                  class="text-xl font-mono font-bold"
                  :class="isDeep ? 'text-purple-400' : 'text-cyan-400'"
                >+{{ expGained }}</div>
              </div>
              <div class="bg-[#1c1917] rounded-lg p-3 border border-stone-800 text-center">
                <div class="text-stone-500 text-xs mb-1.5">修为速率</div>
                <div class="text-xl font-mono text-emerald-400">{{ expRate }}/秒</div>
              </div>
            </div>

            <!-- 深度闭关进度条 -->
            <div v-if="isDeep" class="mb-6">
              <div class="flex justify-between text-xs text-stone-500 mb-1.5">
                <span>修炼进度</span>
                <span>{{ progress }}% / 剩余 {{ formatTime(remainingTime) }}</span>
              </div>
              <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                <div
                  class="h-full bg-gradient-to-r from-purple-700 via-purple-500 to-purple-300 transition-all duration-1000"
                  :style="{ width: `${progress}%` }"
                ></div>
              </div>
            </div>

            <!-- 操作按钮区 -->
            <div class="flex gap-2">
              <!-- 强行出关按钮（深度闭关未达时长） -->
              <button
                v-if="isDeep && !reachedMinDuration"
                @click="handleForceEnd"
                :disabled="loading"
                class="flex-1 py-2.5 bg-amber-950/40 border border-amber-800/60 text-amber-400 hover:text-amber-300 hover:border-amber-600/60 hover:bg-amber-900/30 transition-all duration-300 rounded-lg tracking-widest text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span v-if="loading">结算中...</span>
                <span v-else>强行出关（损失50%）</span>
              </button>
              <!-- 正常结束按钮 -->
              <button
                @click="handleEnd"
                :disabled="loading"
                class="flex-1 py-2.5 bg-stone-900/80 border border-stone-700 text-rose-400 hover:text-rose-300 hover:border-rose-500/50 hover:bg-stone-800 transition-all duration-300 rounded-lg tracking-widest text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span v-if="loading">结算中...</span>
                <span v-else>{{ isDeep && !reachedMinDuration ? '正常结束（损失50%）' : '结束修炼' }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
// 使用统一的 utils 替代组件内 formatTime 重复实现
import { formatTime } from '../../utils/format'

const store = usePlayerStore()
const uiStore = useUIStore()
const loading = ref(false)
const now = ref(Date.now())
const timer = ref(null)
const expRate = ref(0.1) // 默认修为速率
const expanded = ref(false) // 详情面板展开状态

/**
 * 当前是否为深度闭关
 */
const isDeep = computed(() => {
  return store.player?.seclusion_mode === 'deep'
})

const startTime = computed(() => {
  return store.player?.seclusion_start_time ? new Date(store.player.seclusion_start_time).getTime() : Date.now()
})

const endTime = computed(() => {
  return store.player?.seclusion_end_time ? new Date(store.player.seclusion_end_time).getTime() : 0
})

/**
 * 已闭关时长（秒）
 */
const duration = computed(() => {
  return Math.max(0, Math.floor((now.value - startTime.value) / 1000))
})

/**
 * 剩余时间（秒），仅深度闭关有意义
 */
const remainingTime = computed(() => {
  if (!endTime.value) return 0
  return Math.max(0, Math.floor((endTime.value - now.value) / 1000))
})

/**
 * 已获修为（实时计算）
 */
const expGained = computed(() => {
  // 优先使用后端返回的实时已获修为
  const backendGain = store.systemConfig?.seclusion?.exp_gained
  if (backendGain !== undefined && backendGain !== null) {
    return backendGain
  }
  // 降级：使用 exp_rate 计算实时收益显示
  return Math.floor(duration.value * expRate.value)
})

/**
 * 进度百分比（深度闭关按最短时长计算）
 */
const progress = computed(() => {
  const backendProgress = store.systemConfig?.seclusion?.progress
  if (backendProgress !== undefined && backendProgress !== null) {
    return backendProgress
  }
  // 降级：本地估算
  if (!isDeep.value) return Math.min(100, Math.floor(duration.value / 1800 * 100))
  const minDuration = 14400 // 默认 4 小时
  return Math.min(100, Math.floor(duration.value / minDuration * 100))
})

/**
 * 深度闭关是否已达最短时长
 * 用于决定是否显示"强行出关"按钮（未达时长才显示）
 */
const reachedMinDuration = computed(() => {
  if (!isDeep.value) return true
  // 深度闭关最短时长 4 小时（14400 秒），从配置读取降级默认
  const minDuration = store.systemConfig?.seclusion?.deep?.min_duration || 14400
  return duration.value >= minDuration
})

/**
 * 结束闭关修炼（正常结算）
 */
const handleEnd = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await store.endSeclusion()
    // 添加日志
    const gain = res?.data?.exp_gain || res?.data?.player?.exp || expGained.value || 0
    const isForced = res?.data?.forced_end
    const modeLabel = isDeep.value ? '深度闭关' : '闭关'
    let logContent = `结束${modeLabel}，本次修炼共获得修为 ${gain} 点。`
    if (isForced) {
      logContent = `强行出关！${modeLabel}未达最短时长，损失 50% 收益，本次获得修为 ${gain} 点。`
    }
    uiStore.addLog({
      content: logContent,
      type: isForced ? 'warning' : 'success',
      actorId: 'self'
    })
  } catch (err) {
    console.error('结束闭关失败:', err)
    const msg = err?.response?.data?.message || err?.response?.data?.error || '结束闭关失败，请重试'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 强行出关（深度闭关专用快捷入口）
 * 逻辑等同结束闭关，但语义上明确告知玩家是强行出关
 */
const handleForceEnd = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await store.forceEndSeclusion()
    const gain = res?.data?.exp_gain || res?.data?.player?.exp || expGained.value || 0
    uiStore.addLog({
      content: `强行出关！深度闭关未达最短时长，损失 50% 收益，本次获得修为 ${gain} 点。`,
      type: 'warning',
      actorId: 'self'
    })
  } catch (err) {
    console.error('强行出关失败:', err)
    const msg = err?.response?.data?.message || err?.response?.data?.error || '强行出关失败，请重试'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  const status = await store.fetchSeclusionStatus()
  if (status) {
    // 根据模式设置不同的修为速率显示
    if (isDeep.value) {
      // 深度闭关 2 倍收益
      expRate.value = (status.exp_rate || 1) * 2
    } else {
      expRate.value = status.exp_rate || 0.1
    }
  }

  timer.value = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer.value) clearInterval(timer.value)
})
</script>

<style scoped>
/* 详情面板展开/收起动画 */
.seclusion-panel-enter-active,
.seclusion-panel-leave-active {
  transition: all 0.3s ease;
}

.seclusion-panel-enter-from,
.seclusion-panel-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
