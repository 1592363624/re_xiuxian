/**
 * 闭关修炼浮动状态条组件
 * 替代原有全屏遮罩，改为顶部浮动横幅，不遮挡游戏内容
 * 支持收缩/展开两种模式，用户可随时查看进度并结束修炼
 */
<template>
  <div class="relative z-30">
    <!-- 浮动状态条（始终可见） -->
    <div
      class="flex items-center gap-3 px-4 py-2.5 bg-[#1a1510]/95 border-b border-cyan-900/40 backdrop-blur-sm select-none"
    >
      <!-- 左侧图标 + 标题 -->
      <div class="flex items-center gap-2.5 shrink-0">
        <div class="relative w-7 h-7 flex items-center justify-center">
          <!-- 旋转光环 -->
          <div class="absolute inset-0 border border-cyan-500/30 rounded-full animate-[spin_8s_linear_infinite]"></div>
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <span class="text-sm font-bold text-cyan-300 tracking-wider hidden sm:inline">闭关修炼中</span>
        <span class="text-sm font-bold text-cyan-300 tracking-wider sm:hidden">闭关</span>
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
        <!-- 修为速率（桌面端显示） -->
        <div class="hidden md:flex items-center gap-1.5 shrink-0">
          <span class="text-stone-500">速率</span>
          <span class="text-cyan-400 font-mono">{{ expRate }}/秒</span>
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
        <!-- 结束修炼按钮 -->
        <button
          @click="handleEnd"
          :disabled="loading"
          class="px-3 py-1 text-xs rounded border border-rose-800/60 text-rose-400 hover:text-rose-300 hover:border-rose-600 hover:bg-rose-950/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed tracking-wider"
        >
          <span v-if="loading">结算中...</span>
          <span v-else>结束修炼</span>
        </button>
      </div>
    </div>

    <!-- 展开详情面板 -->
    <Transition name="seclusion-panel">
      <div v-if="expanded" class="absolute top-full left-0 right-0 z-40">
        <div class="bg-[#141210]/98 border-b border-cyan-900/30 backdrop-blur-md px-6 py-6">
          <!-- 背景动画 -->
          <div class="absolute inset-0 overflow-hidden pointer-events-none">
            <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-cyan-900/5 rounded-full blur-3xl animate-pulse"></div>
          </div>

          <div class="relative z-10 max-w-lg mx-auto">
            <!-- 核心动画图标 -->
            <div class="flex justify-center mb-6">
              <div class="relative">
                <div class="absolute inset-0 -m-6 border border-cyan-500/15 rounded-full animate-[spin_10s_linear_infinite]"></div>
                <div class="absolute inset-0 -m-3 border border-cyan-500/25 rounded-full animate-[spin_15s_linear_infinite_reverse]"></div>
                <div class="w-20 h-20 bg-gradient-to-b from-stone-900 to-black rounded-full border-2 border-cyan-500/40 flex items-center justify-center shadow-[0_0_25px_rgba(6,182,212,0.25)]">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-cyan-400 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                  </svg>
                </div>
              </div>
            </div>

            <!-- 标题 -->
            <div class="text-center mb-6">
              <h3 class="text-lg font-bold tracking-[0.3em] text-white mb-2">潜心闭关中</h3>
              <div class="inline-block px-3 py-0.5 rounded-full bg-cyan-950/30 border border-cyan-900/40 text-cyan-400 text-xs tracking-widest">
                正在感悟诸天造化
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
                <div class="text-xl font-mono text-cyan-400 font-bold">+{{ expGained }}</div>
              </div>
              <div class="bg-[#1c1917] rounded-lg p-3 border border-stone-800 text-center">
                <div class="text-stone-500 text-xs mb-1.5">修为速率</div>
                <div class="text-xl font-mono text-emerald-400">{{ expRate }}/秒</div>
              </div>
            </div>

            <!-- 结束按钮（面板内也提供一个更大的按钮） -->
            <button
              @click="handleEnd"
              :disabled="loading"
              class="w-full py-2.5 bg-stone-900/80 border border-stone-700 text-rose-400 hover:text-rose-300 hover:border-rose-500/50 hover:bg-stone-800 transition-all duration-300 rounded-lg tracking-widest text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span v-if="loading">结算中...</span>
              <span v-else>结束修炼</span>
            </button>
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
// 修复：使用统一的 utils 替代组件内 formatTime 重复实现
import { formatTime } from '../../utils/format'

const store = usePlayerStore()
const uiStore = useUIStore()
const loading = ref(false)
const now = ref(Date.now())
const timer = ref(null)
const expRate = ref(0.1) // 默认修为速率
const expanded = ref(false) // 详情面板展开状态

const startTime = computed(() => {
  return store.player?.seclusion_start_time ? new Date(store.player.seclusion_start_time).getTime() : Date.now()
})

const duration = computed(() => {
  return Math.max(0, Math.floor((now.value - startTime.value) / 1000))
})

const expGained = computed(() => {
  // 使用后端返回的 exp_rate 计算实时收益显示
  return Math.floor(duration.value * expRate.value)
})

// formatTime 已从 utils/format 引入，此处删除本地实现避免重复

/**
 * 结束闭关修炼
 */
const handleEnd = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await store.endSeclusion()
    // 添加日志
    const gain = res.data?.exp_gain || (res.data?.data?.exp_gain) || expGained.value || 0
    uiStore.addLog({
      content: `结束闭关，本次修炼共获得修为 ${gain} 点。`,
      type: 'success',
      actorId: 'self'
    })
  } catch (err) {
    console.error('结束闭关失败:', err)
    const msg = err?.response?.data?.error || err?.response?.data?.message || '结束闭关失败，请重试'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  const status = await store.fetchSeclusionStatus()
  if (status && status.exp_rate) {
    expRate.value = status.exp_rate
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
