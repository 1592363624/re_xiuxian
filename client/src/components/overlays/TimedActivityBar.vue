<template>
  <!-- 有进行中的计时操作时贴在 header 下方；关掉面板/切分类也一直看得见 -->
  <div
    v-if="items.length"
    class="relative z-30 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-line-subtle bg-surface-raised/90 backdrop-blur-sm select-none"
  >
    <span class="text-[10px] text-fg-faint tracking-[0.18em] font-display shrink-0">进行中</span>
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="group flex items-center gap-1.5 px-2 py-1 rounded-control border text-xs transition-colors"
      :class="item.chipClass"
      :title="item.title"
      @click="$emit('action', item.actionId)"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0" :class="item.dotClass"></span>
      <span class="font-bold tracking-wide">{{ item.label }}</span>
      <span class="num tabular-nums font-mono" :class="item.timeClass">{{ item.remainingText }}</span>
    </button>
  </div>
</template>

<script setup>
/**
 * 进行中计时操作总览条
 *
 * 闭关 / 悟道 / 历练这些「要等一会儿」的操作，原先只在右坞总览的状态卡里露出进度条，
 * 一旦打开功能面板（或切到别的分类）就被 v-show 藏掉 —— 玩家只收到
 * 「静思悟道中，无法开始此操作」，却看不见还剩多久，只能反复点。
 *
 * 这里做成 header 下方常驻的紧凑倒计时 chip：有几条显示几条，点一下直达对应面板。
 * 详细进度条仍留在总览状态卡 / 各自 Overlay，本条只解决「随时看得到还剩多久」。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { formatCountdown, formatTime } from '../../utils/format'

defineEmits(['action'])

const playerStore = usePlayerStore()
const now = ref(Date.now())
let timer = null

onMounted(() => {
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

/** 从 ISO/Date 字符串取剩余秒；无效或已结束返回 0 */
const remainFromEnd = (end) => {
  if (!end) return 0
  const endMs = new Date(end).getTime()
  if (!Number.isFinite(endMs)) return 0
  return Math.max(0, Math.floor((endMs - now.value) / 1000))
}

/** 历练剩余：后端给 remaining_seconds + server_time，本地按已流逝时间递减 */
const adventureRemain = computed(() => {
  const st = playerStore.adventureStatus
  if (!st?.is_adventuring) return 0
  const base = Number(st.remaining_seconds) || 0
  const serverTime = Number(st.server_time) || now.value
  const elapsed = Math.max(0, Math.floor((now.value - serverTime) / 1000))
  return Math.max(0, base - elapsed)
})

const items = computed(() => {
  const p = playerStore.player
  const list = []

  if (p?.is_secluded) {
    const remain = remainFromEnd(p.seclusion_end_time)
    const isDeep = p.seclusion_mode === 'deep'
    list.push({
      id: 'seclusion',
      actionId: 'cultivate',
      label: isDeep ? '深度闭关' : '闭关修炼',
      remainingText: remain > 0 ? formatCountdown(remain) : '结算中…',
      title: `闭关进行中，剩余约 ${formatTime(remain)}。点击打开闭关面板`,
      chipClass: isDeep
        ? 'border-purple-800/60 bg-purple-950/30 text-purple-200 hover:border-purple-600'
        : 'border-cyan-800/50 bg-cyan-950/25 text-cyan-200 hover:border-cyan-600',
      dotClass: isDeep ? 'bg-purple-400' : 'bg-cyan-400',
      timeClass: isDeep ? 'text-purple-300' : 'text-cyan-300',
      remain
    })
  }

  if (p?.is_meditating) {
    const remain = remainFromEnd(p.meditation_end_time)
    const isDeep = p.meditation_mode === 'deep'
    list.push({
      id: 'meditation',
      actionId: 'meditation',
      label: isDeep ? '深度悟道' : '静思悟道',
      remainingText: remain > 0 ? formatCountdown(remain) : '结算中…',
      title: `悟道进行中，剩余约 ${formatTime(remain)}。点击打开悟道面板`,
      chipClass: isDeep
        ? 'border-purple-800/60 bg-purple-950/30 text-purple-200 hover:border-purple-600'
        : 'border-amber-800/50 bg-amber-950/25 text-amber-200 hover:border-amber-600',
      dotClass: isDeep ? 'bg-purple-400' : 'bg-amber-400',
      timeClass: isDeep ? 'text-purple-300' : 'text-amber-300',
      remain
    })
  }

  const advRemain = adventureRemain.value
  if (playerStore.adventureStatus?.is_adventuring) {
    list.push({
      id: 'adventure',
      actionId: 'explore',
      label: '历练中',
      remainingText: advRemain > 0 ? formatCountdown(advRemain) : '结算中…',
      title: `历练进行中，剩余约 ${formatTime(advRemain)}。点击打开历练面板`,
      chipClass: 'border-emerald-800/50 bg-emerald-950/25 text-emerald-200 hover:border-emerald-600',
      dotClass: 'bg-emerald-400',
      timeClass: 'text-emerald-300',
      remain: advRemain
    })
  }

  return list
})

/**
 * 倒计时归零后主动对齐一次后端：状态可能已自动结算，
 * 不刷新的话 chip 会一直停在「结算中…」。
 * 只在「刚归零」那一刻拉一次，避免每秒 tick 都打接口。
 */
const settledOnce = new Set()
let settleRefreshing = false
watch(items, async (list) => {
  if (settleRefreshing) return
  const justExpired = list.filter(i => i.remain <= 0 && !settledOnce.has(i.id))
  if (justExpired.length === 0) return
  justExpired.forEach(i => settledOnce.add(i.id))
  settleRefreshing = true
  try {
    await playerStore.scheduleFetchPlayer(0)
    await playerStore.fetchSeclusionStatus()
    await playerStore.fetchAdventureStatus()
  } catch {
    // 失败则允许下次再试
    justExpired.forEach(i => settledOnce.delete(i.id))
  } finally {
    settleRefreshing = false
  }
})
</script>
