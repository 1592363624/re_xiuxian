<template>
  <!-- 移动端/窄屏底部操作条。xl 以上导航由右坞承担，这里整体隐藏。 -->
  <div class="xl:hidden shrink-0 flex items-stretch gap-1.5 p-2 bg-[#0c0a09] border-t border-stone-800 select-none z-20 overflow-x-auto">
    <div
      v-for="action in quickActions"
      :key="action.id"
      class="relative shrink-0"
    >
      <button
        @click="handleAction(action.id)"
        class="group relative flex flex-col items-center justify-center gap-0.5 w-16 h-14 rounded-lg bg-[#1c1917] border transition-all duration-200 active:scale-95"
        :class="action.id === 'cultivate' && isBreakthroughReady
          ? 'border-purple-500/60 ring-1 ring-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.4)]'
          : 'border-stone-800'"
      >
        <span
          class="transition-transform duration-200 group-hover:scale-110"
          :class="{ 'animate-pulse drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]': action.id === 'cultivate' && isBreakthroughReady }"
          v-html="action.icon"
        ></span>
        <span class="text-[10px] text-stone-300 font-bold tracking-wider leading-none">{{ action.name }}</span>

        <!-- 闭关冷却倒计时 -->
        <span
          v-if="action.id === 'cultivate' && remainingCooldown > 0"
          class="absolute inset-0 flex items-center justify-center bg-black/70 rounded-lg z-10 cursor-not-allowed font-mono text-amber-500 text-xs"
          @click.stop
        >{{ formatCooldown(remainingCooldown) }}</span>
      </button>
    </div>

    <!-- 其余功能收进抽屉，避免这里堆成一条划不到头的长条 -->
    <button
      @click="emit('action', 'menu')"
      class="shrink-0 flex flex-col items-center justify-center gap-0.5 w-16 h-14 rounded-lg bg-[#1c1917] border border-stone-800 active:scale-95"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      <span class="text-[10px] text-stone-300 font-bold tracking-wider leading-none">更多</span>
    </button>
  </div>
</template>

<script setup>
/**
 * 移动端操作条
 *
 * 数据来自 data/actionCatalog —— 与右坞共用一份清单，避免两处漂移。
 *
 * 设计原则：后端计算，前端只渲染
 *   - 突破就绪状态：直接读取后端 player.can_breakthrough，不再前端比较 exp >= exp_next
 *   - 闭关冷却剩余：读取后端 normal_cooldown_remaining + server_time 做本地 tick 递减
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { QUICK_ACTION_IDS, resolveAction } from '../../data/actionCatalog'

const props = defineProps({
  player: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits(['action'])
const store = usePlayerStore()

const quickActions = computed(() => QUICK_ACTION_IDS.map(resolveAction).filter(Boolean))

const now = ref(Date.now())
let timer = null

/**
 * 拉取闭关状态，触发 store 更新（store 变更后 computed 自动响应）
 */
const fetchSeclusionCooldown = async () => {
  try {
    await store.fetchSeclusionStatus()
  } catch (err) {
    console.error('获取闭关冷却状态失败:', err)
  }
}

// 计算剩余冷却时间 (秒) - 直接读取 store，响应式更新
// 直接从 store.systemConfig.seclusion 读取后端权威值，socket 推送后 computed 自动重算
const remainingCooldown = computed(() => {
  const secData = store.systemConfig?.seclusion
  if (!secData) return 0
  const backendRemaining = secData.normal_cooldown_remaining ?? 0
  if (backendRemaining <= 0) return 0
  // 基于服务端时间戳计算本地流逝时间，避免时钟漂移
  const serverTime = secData.server_time || Date.now()
  const localElapsedSec = Math.floor((now.value - serverTime) / 1000)
  return Math.max(0, backendRemaining - localElapsedSec)
})

// 格式化冷却时间 (MM:SS)
const formatCooldown = (seconds) => {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h${m}m`
  }
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// 突破就绪 - 读取后端权威计算的 can_breakthrough，避免前端比较 BigInt 字符串丢精度
const isBreakthroughReady = computed(() => !!(props.player && props.player.can_breakthrough))

onMounted(() => {
  fetchSeclusionCooldown()
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const handleAction = (id) => {
  emit('action', id)
}
</script>
