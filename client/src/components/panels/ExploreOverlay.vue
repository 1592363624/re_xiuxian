/**
 * 历练进行中浮动状态条组件
 *
 * 设计依据：参考 SeclusionOverlay.vue 的设计模式
 *   - 当玩家有进行中的历练时，在顶部 header 下方显示进度条
 *   - 剩余时间由后端权威计算，前端基于 server_time + remaining_seconds 本地 tick 递减
 *   - 已过期时显示"完成历练"按钮（变红提示），点击调用 completeExplore
 *   - 每 5 秒同步一次后端权威数据，避免时钟漂移
 *
 * 业务计算下沉后端的核心体现：
 *   - total_seconds / remaining_seconds / is_expired 均由后端返回
 *   - 前端只做"基于 server_time 的本地 tick 递减"展示，不做业务判断
 */
<template>
  <div class="relative z-30">
    <div
      class="flex items-center gap-3 px-4 py-2.5 bg-[#1a1510]/95 border-b backdrop-blur-sm select-none"
      :class="isExpired ? 'border-red-900/60' : 'border-emerald-900/50'"
    >
      <!-- 左侧图标 + 标题 -->
      <div class="flex items-center gap-2.5 shrink-0">
        <div class="relative w-7 h-7 flex items-center justify-center">
          <!-- 旋转光环 -->
          <div
            class="absolute inset-0 border rounded-full animate-[spin_8s_linear_infinite]"
            :class="isExpired ? 'border-red-500/40' : 'border-emerald-500/40'"
          ></div>
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4"
            :class="isExpired ? 'text-red-400' : 'text-emerald-400'"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c1 1 1 3 0 4l-9 9-9-9c-1-1-1-3 0-4l9-9 9 9z"/>
            <path d="M3.5 10l7.5 7.5"/>
          </svg>
        </div>
        <div class="flex flex-col">
          <span class="text-sm font-bold tracking-wider hidden sm:inline"
            :class="isExpired ? 'text-red-300' : 'text-emerald-300'">
            {{ isExpired ? '历练已结束' : '历练进行中' }}
          </span>
          <span class="text-sm font-bold tracking-wider sm:hidden"
            :class="isExpired ? 'text-red-300' : 'text-emerald-300'">
            {{ isExpired ? '待领取' : '历练' }}
          </span>
          <span class="text-[10px] text-emerald-500/80 tracking-wider truncate max-w-[120px]">
            {{ eventTitle }}
          </span>
        </div>
      </div>

      <!-- 中间进度条 + 剩余时间 -->
      <div class="flex-1 flex items-center gap-2 min-w-0">
        <div class="flex-1 relative h-2 bg-stone-900/80 rounded-full overflow-hidden">
          <div
            class="absolute inset-y-0 left-0 transition-all duration-500 rounded-full"
            :class="isExpired ? 'bg-gradient-to-r from-red-600 to-rose-400' : 'bg-gradient-to-r from-emerald-600 to-teal-400'"
            :style="{ width: progressPercent + '%' }"
          ></div>
        </div>
        <span class="text-xs font-mono shrink-0"
          :class="isExpired ? 'text-red-300' : 'text-emerald-300'">
          {{ remainingText }}
        </span>
      </div>

      <!-- 右侧操作按钮 -->
      <div class="flex items-center gap-2 shrink-0">
        <button
          @click="handleComplete"
          :disabled="completing"
          class="px-3 py-1.5 text-xs font-bold rounded transition-all"
          :class="isExpired
            ? 'bg-red-700 hover:bg-red-600 text-white'
            : 'bg-emerald-800 hover:bg-emerald-700 text-emerald-100'"
        >
          <span v-if="completing">结算中...</span>
          <span v-else>{{ isExpired ? '完成历练' : '提前结束' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 历练进行中浮动状态条
 *
 * 数据来源：usePlayerStore.adventureStatus（后端权威计算）
 * 本地 tick：基于 server_time + remaining_seconds 递减展示
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { completeExplore } from '../../api/explore'

const store = usePlayerStore()
const uiStore = useUIStore()

// 本地时钟 tick（每秒更新，驱动剩余时间递减）
const now = ref(Date.now())
// 结算中状态（防止重复点击）
const completing = ref(false)
// 节流计数器：每 5 秒同步一次后端权威数据
let syncCounter = 0
let timer = null

/**
 * 后端权威剩余秒数（基于 server_time 本地递减）
 * 设计同 ActionBar 的 remainingCooldown：避免时钟漂移
 */
const remainingSeconds = computed(() => {
  const status = store.adventureStatus
  if (!status || !status.is_adventuring) return 0
  const backendRemaining = status.remaining_seconds ?? 0
  if (backendRemaining <= 0) return 0
  const serverTime = status.server_time || Date.now()
  const localElapsedSec = Math.floor((now.value - serverTime) / 1000)
  return Math.max(0, backendRemaining - localElapsedSec)
})

/**
 * 进度百分比（已用时长 / 总时长）
 */
const progressPercent = computed(() => {
  const status = store.adventureStatus
  if (!status || !status.is_adventuring || !status.total_seconds) return 0
  const usedSeconds = status.total_seconds - remainingSeconds.value
  return Math.min(100, Math.max(0, (usedSeconds / status.total_seconds) * 100))
})

/**
 * 是否已过期（玩家应点击完成领取奖励）
 */
const isExpired = computed(() => {
  const status = store.adventureStatus
  if (!status || !status.is_adventuring) return false
  // 后端权威标记 + 本地剩余归零双判断
  return status.is_expired || remainingSeconds.value <= 0
})

/**
 * 剩余时间格式化（mm:ss）
 */
const remainingText = computed(() => {
  const sec = remainingSeconds.value
  if (sec <= 0) return '已结束'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
})

/**
 * 事件标题（来自后端 event_data）
 */
const eventTitle = computed(() => {
  const adv = store.adventureStatus?.adventure
  if (!adv) return '历练中'
  // event_data 是后端权威事件数据（含 title）
  const eventData = adv.event_data || {}
  return eventData.title || adv.event_type || '历练中'
})

/**
 * 完成历练（提前结束 / 正常领取）
 * 调用后端接口，成功后刷新状态
 */
const handleComplete = async () => {
  if (completing.value) return
  completing.value = true
  try {
    const res = await completeExplore()
    const rewards = res.data?.data?.rewards || {}
    let rewardText = `获得 ${rewards.exp || 0} 修为`
    if (rewards.items?.length) {
      rewardText += `，${rewards.items.map(i => i.item_key).join('、')}`
    }
    if (rewards.spirit_stones) {
      rewardText += `，${rewards.spirit_stones} 灵石`
    }
    if (rewards.early_finish) {
      rewardText += `（提前结束，仅获得 ${rewards.reward_scale} 奖励）`
    }
    if (rewards.injury) {
      rewardText += `，并因战斗受伤损失 ${rewards.injury.hp_loss || 0} 气血`
    }
    uiStore.addLog({
      content: `历练完成：${rewardText}`,
      type: rewards.injury ? 'warning' : 'success',
      actorId: 'self'
    })
    uiStore.showToast(rewards.injury ? '历练完成，但受了伤' : '历练完成！', rewards.injury ? 'warning' : 'success')
    // 刷新历练状态（应变为 is_adventuring: false）
    await store.fetchAdventureStatus()
  } catch (error) {
    const msg = error?.response?.data?.message || '完成历练失败'
    uiStore.showToast(msg, 'error')
  } finally {
    completing.value = false
  }
}

onMounted(() => {
  // 启动每秒 tick，驱动剩余时间递减与节流同步
  timer = setInterval(() => {
    now.value = Date.now()
    // 每 5 秒同步一次后端权威数据，避免时钟漂移
    syncCounter++
    if (syncCounter >= 5) {
      syncCounter = 0
      // 静默同步，不显示 loading
      store.fetchAdventureStatus().catch(() => {})
    }
  }, 1000)
})

onUnmounted(() => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
})
</script>
