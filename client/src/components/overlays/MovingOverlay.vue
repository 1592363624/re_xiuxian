/**
 * 赶路移动浮动状态条组件
 * 替代原有全屏遮罩，改为顶部浮动横幅，不遮挡游戏内容
 * 显示移动进度、剩余时间，支持展开详情和取消移动
 */
<template>
  <div v-if="show" class="relative z-30">
    <!-- 浮动状态条（始终可见） -->
    <div
      class="flex items-center gap-3 px-4 py-2.5 bg-[#1a1510]/95 border-b border-amber-900/40 backdrop-blur-sm select-none"
    >
      <!-- 左侧图标 + 标题 -->
      <div class="flex items-center gap-2.5 shrink-0">
        <div class="relative w-7 h-7 flex items-center justify-center">
          <!-- 脉冲光环 -->
          <div class="absolute inset-0 border border-amber-500/30 rounded-full animate-ping" style="animation-duration: 2s;"></div>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
        </div>
        <span class="text-sm font-bold text-amber-400 tracking-wider hidden sm:inline">正在赶路</span>
        <span class="text-sm font-bold text-amber-400 tracking-wider sm:hidden">赶路</span>
      </div>

      <!-- 中间路线信息 -->
      <div class="flex items-center gap-2 text-xs flex-1 min-w-0">
        <span class="text-stone-300 truncate">{{ fromMapName }}</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-500 shrink-0">
          <line x1="5" y1="12" x2="19" y2="12"/>
          <polyline points="12 5 19 12 12 19"/>
        </svg>
        <span class="text-amber-400 font-bold truncate">{{ toMapName }}</span>
      </div>

      <!-- 右侧进度 + 操作 -->
      <div class="flex items-center gap-3 shrink-0">
        <!-- 进度百分比（移动端隐藏） -->
        <span class="hidden sm:inline text-xs font-mono text-amber-400 w-10 text-right">{{ progressText }}</span>
        <!-- 剩余时间 -->
        <span class="text-xs font-mono text-stone-400 w-16 text-right">{{ formattedTime }}</span>
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
        <!-- 取消移动按钮 -->
        <button
          @click="cancelMoveAction"
          :disabled="cancelling"
          class="px-3 py-1 text-xs rounded border border-stone-700 text-stone-400 hover:text-stone-300 hover:border-stone-500 hover:bg-stone-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed tracking-wider"
        >
          <span v-if="cancelling">取消中...</span>
          <span v-else>取消</span>
        </button>
      </div>
    </div>

    <!-- 展开详情面板 -->
    <Transition name="moving-panel">
      <div v-if="expanded" class="absolute top-full left-0 right-0 z-40">
        <div class="bg-[#141210]/98 border-b border-amber-900/30 backdrop-blur-md px-6 py-6">
          <div class="relative z-10 max-w-lg mx-auto">
            <!-- 核心图标 -->
            <div class="flex justify-center mb-6">
              <div class="relative">
                <div class="absolute inset-0 -m-6 border border-amber-500/15 rounded-full animate-[spin_10s_linear_infinite]"></div>
                <div class="w-20 h-20 bg-gradient-to-b from-stone-900 to-black rounded-full border-2 border-amber-700/40 flex items-center justify-center shadow-[0_0_25px_rgba(180,83,9,0.2)]">
                  <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400 animate-pulse">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                </div>
              </div>
            </div>

            <!-- 标题 -->
            <div class="text-center mb-6">
              <h3 class="text-lg font-bold tracking-[0.3em] text-amber-400 mb-2">正在赶路中</h3>
              <p class="text-sm text-stone-500">请耐心等待到达目的地</p>
            </div>

            <!-- 路线信息 -->
            <div class="flex items-center justify-center gap-4 text-lg mb-6">
              <span class="text-stone-300 font-bold">{{ fromMapName }}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-500">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
              <span class="text-amber-400 font-bold">{{ toMapName }}</span>
            </div>

            <!-- 进度条 -->
            <div class="mb-6">
              <div class="relative h-5 bg-stone-900 rounded-full overflow-hidden border border-stone-700">
                <div
                  class="absolute inset-y-0 left-0 bg-gradient-to-r from-amber-700 to-amber-500 transition-all duration-1000 ease-linear rounded-full"
                  :style="{ width: progress + '%' }"
                ></div>
                <div class="absolute inset-0 flex items-center justify-center">
                  <span class="text-xs font-bold text-white drop-shadow">{{ progressText }}</span>
                </div>
              </div>
            </div>

            <!-- 剩余时间 -->
            <div class="text-center mb-6">
              <div class="text-3xl font-mono font-bold text-amber-400 mb-1">{{ formattedTime }}</div>
              <div class="text-xs text-stone-500">预计剩余时间</div>
            </div>

            <!-- 提示 + 取消按钮 -->
            <div class="pt-4 border-t border-stone-800">
              <div class="flex items-center justify-center gap-2 text-xs text-stone-500 mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 16v-4"/>
                  <path d="M12 8h.01"/>
                </svg>
                <span>移动期间无法进行其他操作</span>
              </div>
              <button
                @click="cancelMoveAction"
                :disabled="cancelling"
                class="w-full py-2.5 px-4 rounded bg-stone-800 border border-stone-700 text-stone-400 hover:bg-stone-700 hover:text-stone-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed tracking-wider"
              >
                <span v-if="cancelling">取消中...</span>
                <span v-else>取消移动</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { cancelMove } from '../../api/map'

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['complete'])

const countdown = ref(0)
const progress = ref(0)
const intervalId = ref(null)
const cancelling = ref(false)
const expanded = ref(false) // 详情面板展开状态

const movingState = computed(() => playerStore.movingState)

const fromMapName = computed(() => movingState.value.fromMapName || '起点')
const toMapName = computed(() => movingState.value.toMapName || '终点')

/**
 * 格式化剩余时间为可读字符串
 */
const formattedTime = computed(() => {
  // 防止负数时间显示
  const safeCountdown = Math.max(0, countdown.value)
  const mins = Math.floor(safeCountdown / 60)
  const secs = safeCountdown % 60
  if (mins > 0) {
    return `${mins}分${secs.toString().padStart(2, '0')}秒`
  }
  return `${secs}秒`
})

/**
 * 计算进度百分比文本
 */
const progressText = computed(() => {
  const total = movingState.value.totalSeconds || 1
  // 防止 countdown 大于 total 时出现负数进度
  const percent = Math.max(0, Math.min(100, Math.round((1 - countdown.value / total) * 100)))
  return `${percent}%`
})

/**
 * 启动倒计时
 */
const startCountdown = () => {
  if (intervalId.value) {
    clearInterval(intervalId.value)
  }

  // 确保 totalSeconds 已正确设置，避免使用默认值 0
  const total = movingState.value.totalSeconds || 0
  if (total <= 0) {
    console.warn('MovingOverlay: totalSeconds 未就绪，等待 store 更新')
    return
  }

  countdown.value = movingState.value.remainingSeconds || total
  progress.value = 0

  intervalId.value = setInterval(() => {
    if (countdown.value > 0) {
      countdown.value--
      playerStore.updateRemainingTime(countdown.value)

      const totalSeconds = movingState.value.totalSeconds || 1
      // 边界保护：防止负数或超过 100%
      progress.value = Math.max(0, Math.min(100, Math.round((1 - countdown.value / totalSeconds) * 100)))
    } else {
      clearInterval(intervalId.value)
      handleComplete()
    }
  }, 1000)
}

/**
 * 移动完成回调
 */
const handleComplete = () => {
  emit('complete')
}

/**
 * 取消移动操作
 */
const cancelMoveAction = async () => {
  if (cancelling.value) return

  cancelling.value = true
  try {
    // 在清空 store 之前保存地图名称，避免日志显示为 fallback 值
    const savedFromMapName = fromMapName.value
    await cancelMove()
    playerStore.clearMovingState()
    uiStore.addLog({
      content: `你取消了移动，返回了 ${savedFromMapName}。`,
      type: 'movement',
      actorId: 'self'
    })
    emit('complete')
  } catch (error) {
    uiStore.showToast(error.response?.data?.message || '取消失败', 'error')
  } finally {
    cancelling.value = false
  }
}

onMounted(() => {
  if (props.show && movingState.value.isMoving) {
    startCountdown()
  }
})

onUnmounted(() => {
  if (intervalId.value) {
    clearInterval(intervalId.value)
  }
})

watch(() => props.show, (newVal) => {
  if (newVal && movingState.value.isMoving) {
    startCountdown()
  }
})

watch(() => movingState.value.isMoving, (newVal) => {
  if (!newVal && props.show) {
    handleComplete()
  }
})

// 监听 totalSeconds 变化，确保 store 数据就绪后启动倒计时
watch(() => movingState.value.totalSeconds, (newVal) => {
  if (newVal > 0 && props.show && movingState.value.isMoving && !intervalId.value) {
    startCountdown()
  }
})
</script>

<style scoped>
/* 详情面板展开/收起动画 */
.moving-panel-enter-active,
.moving-panel-leave-active {
  transition: all 0.3s ease;
}

.moving-panel-enter-from,
.moving-panel-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
