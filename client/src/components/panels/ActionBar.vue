<template>
  <div class="shrink-0 flex flex-col p-4 bg-[#0c0a09] border-t border-stone-800 select-none z-20">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div 
        class="relative"
        @mouseenter="showCultivateMenu = true"
        @mouseleave="showCultivateMenu = false"
      >
        <button 
          @click="handleAction('cultivate')"
          class="group relative flex flex-col items-center justify-center p-2 rounded-lg bg-[#1c1917] border border-stone-800 transition-all duration-300
                 hover:border-stone-600 hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] hover:-translate-y-0.5 active:scale-95 active:shadow-inner w-full"
          :class="{
            'bg-gradient-to-r from-stone-900 to-[#1c1917]': true,
            'animate-shake ring-1 ring-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.4)]': isBreakthroughReady
          }"
        >
          <div 
             class="mb-1 transition-transform duration-300 group-hover:scale-110" 
             :class="{'animate-pulse drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]': isBreakthroughReady}"
             v-html="cultivateIcon"
          ></div>
          <span class="text-stone-300 font-bold tracking-widest text-sm group-hover:text-amber-500 transition-colors">修炼</span>
          
          <!-- 冷却倒计时 -->
          <div
            v-if="remainingCooldown > 0"
            class="absolute inset-0 flex items-center justify-center bg-black/60 rounded-lg z-10 pointer-events-auto cursor-not-allowed"
            @click.stop
          >
            <span class="text-amber-500 font-mono font-bold">{{ formatCooldown(remainingCooldown) }}</span>
          </div>

          <!-- 悬停光效 -->
          <div class="absolute inset-0 rounded-lg bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
        </button>
      </div>

      <button 
        v-for="action in refinedActions" 
        :key="action.id"
        @click="handleAction(action.id)"
        class="group relative flex flex-col items-center justify-center p-2 rounded-lg bg-[#1c1917] border border-stone-800 transition-all duration-300
               hover:border-stone-600 hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] hover:-translate-y-0.5 active:scale-95 active:shadow-inner"
      >
        <div 
           class="mb-1 transition-transform duration-300 group-hover:scale-110" 
           v-html="action.icon"
        ></div>
        <span class="text-stone-300 font-bold tracking-widest text-sm group-hover:text-amber-500 transition-colors">{{ action.name }}</span>

        <!-- 悬停光效 -->
        <div class="absolute inset-0 rounded-lg bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
      </button>
    </div>
  </div>
</template>

<script setup>
/**
 * 操作栏组件
 * 显示修炼、历练等操作按钮
 *
 * 设计原则：后端计算，前端只渲染
 *   - 突破就绪状态：直接读取后端 player.can_breakthrough，不再前端比较 exp >= exp_next
 *   - 闭关冷却剩余：读取后端 normal_cooldown_remaining + server_time 做本地 tick 递减
 *   - 不再硬编码冷却时长 3600 秒
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/player'

const props = defineProps({
  player: {
    type: Object,
    default: () => ({})
  }
})

const store = usePlayerStore()
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
// 设计说明：直接从 store.systemConfig.seclusion 读取后端权威值，
// 当 socket 推送触发 store.fetchSeclusionStatus() 时，computed 自动重算，无需手动同步
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

onMounted(() => {
  fetchSeclusionCooldown()
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// 判断是否可以突破 - 直接读取后端权威计算的 can_breakthrough 字段
// 避免前端用 exp >= exp_next 比较大整数（BigInt 字符串）导致精度问题
const isBreakthroughReady = computed(() => {
  return !!(props.player && props.player.can_breakthrough)
})

// 修炼按钮图标
const cultivateIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-400"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`

// 其他操作按钮列表
const refinedActions = [
  {
    id: 'explore',
    name: '历练',
    // Emerald for adventure/explore
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400"><path d="M12 2 2.5 9.5l1 10.5L12 22l8.5-2L22 10l-10-7.5z"/><path d="M12 12 12 22"/><path d="M12 12 22 12"/></svg>`,
    desc: '历练探索 随机事件'
  },
  {
    id: 'inventory',
    name: '背包',
    // Amber for wealth/items
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
    desc: '查看物品 整理行囊'
  },
  {
    id: 'sect',
    name: '宗门',
    // Violet for mystery/sect
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-violet-400"><path d="M3 21h18"/><path d="M5 21V7l8-4 8 4v14"/><path d="M17 21v-8H7v8"/></svg>`,
    desc: '宗门任务 兑换贡献'
  },
  {
    id: 'market',
    name: '坊市',
    // Rose for trade/market
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-rose-400"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>`,
    desc: '买卖物品 互通有无'
  },
]

const emit = defineEmits(['action'])

const handleAction = (id) => {
  emit('action', id)
}
</script>

<style scoped>
</style>


