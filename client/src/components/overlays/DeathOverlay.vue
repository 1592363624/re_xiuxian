<script setup>
/**
 * 死亡遮罩组件（DeathOverlay）
 *
 * 功能：
 * 1. 玩家死亡（is_dead=true）时全屏显示死亡画面
 * 2. 显示死亡原因、修为损失、死亡时间
 * 3. 提供"轮回重生"按钮，调用后端 /api/player/reincarnate 接口
 * 4. 死亡期间禁用所有游戏操作（覆盖在 GameLayout 之上）
 *
 * 触发场景：
 * - 寿元耗尽（LifespanService.handleLifespanEnd）
 * - 战斗失败且触发真正死亡（未来扩展）
 * - 突破失败导致死亡（未来扩展）
 *
 * 修复 B4：之前死亡不推送通知，前端无 UI 反馈，玩家完全无感知
 */
import { computed, ref, onMounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import apiClient from '../../api'
import { formatNumber } from '../../utils/format'

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const isReincarnating = ref(false)
const reincarnateResult = ref(null)

// 玩家是否已死亡
const isDead = computed(() => !!playerStore.player?.is_dead)

// 死亡原因
const deathReason = computed(() => playerStore.player?.death_reason || '寿元耗尽')

// 死亡时间
const deathTime = computed(() => {
  const t = playerStore.player?.death_time
  if (!t) return null
  return new Date(t)
})

// 当前修为（损失后）
const currentExp = computed(() => playerStore.player?.exp || '0')

/**
 * 轮回重生
 *
 * 设计思路（修仙题材）：
 * - 寿元耗尽的玩家可"轮回重生"，重置境界为"凡人"，保留部分修为记忆
 * - 重置 lifespan_current 为初始值，lifespan_max 重置为凡人上限
 * - 清空 is_dead / death_reason / death_time
 * - 保留 username / nickname / spirit_roots（灵根是天生的）
 * - 损失 90% 修为（保留 10% 作为"前世记忆"加成）
 *
 * 注意：当前为最小化实现，只清理死亡状态。完整轮回系统将在后续批次实现。
 */
const handleReincarnate = async () => {
  if (isReincarnating.value) return
  isReincarnating.value = true
  reincarnateResult.value = null

  try {
    const res = await apiClient.post('/player/reincarnate')
    if (res.data?.code === 200) {
      reincarnateResult.value = {
        success: true,
        message: res.data.message || '轮回成功，重入轮回道'
      }
      // 刷新玩家数据，触发 is_dead=false 后界面自动隐藏
      await playerStore.fetchPlayer()
      uiStore.showToast('轮回重生成功', 'success')
    } else {
      reincarnateResult.value = {
        success: false,
        message: res.data?.message || '轮回失败'
      }
      uiStore.showToast(res.data?.message || '轮回失败', 'error')
    }
  } catch (err) {
    console.error('轮回失败:', err)
    const msg = err?.response?.data?.message || '轮回失败，请稍后重试'
    reincarnateResult.value = { success: false, message: msg }
    uiStore.showToast(msg, 'error')
  } finally {
    isReincarnating.value = false
  }
}

/**
 * 退出登录
 * 玩家可选择不立即轮回，退出登录后下次进入仍处于死亡状态
 */
const handleLogout = () => {
  playerStore.logout('道友已陨落，期待来日再会')
}
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-700"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-500"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="isDead"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md"
    >
      <!-- 死亡画面背景：暗红色血雾 + 飘落花瓣 -->
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <div class="absolute inset-0 bg-gradient-to-b from-red-950/30 via-black to-black"></div>
        <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-red-900/20 rounded-full blur-3xl animate-pulse"></div>
        <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-rose-900/20 rounded-full blur-3xl animate-pulse" style="animation-delay: 1s"></div>
      </div>

      <!-- 死亡信息卡片 -->
      <div class="relative z-10 max-w-md w-full mx-4 bg-gradient-to-b from-stone-900/95 to-black/95 border-2 border-red-900/50 rounded-2xl p-8 shadow-2xl shadow-red-900/30">
        <!-- 骷髅图标 -->
        <div class="flex justify-center mb-6">
          <div class="w-24 h-24 rounded-full bg-red-950/50 border-2 border-red-700/50 flex items-center justify-center shadow-lg shadow-red-900/50 animate-pulse">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-red-400">
              <circle cx="9" cy="12" r="1"/>
              <circle cx="15" cy="12" r="1"/>
              <path d="M8 20v2h8v-2"/>
              <path d="m12.5 17-.5-1-.5 1h1z"/>
              <path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/>
            </svg>
          </div>
        </div>

        <!-- 标题 -->
        <h1 class="text-center text-3xl font-serif font-bold text-red-500 tracking-widest mb-2 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]">
          身死道消
        </h1>
        <p class="text-center text-stone-500 text-sm mb-6 italic">大道无情，寿元有尽</p>

        <!-- 死亡信息 -->
        <div class="space-y-3 mb-8 bg-black/40 rounded-lg p-4 border border-stone-800">
          <div class="flex justify-between text-sm">
            <span class="text-stone-500">死亡原因</span>
            <span class="text-red-400 font-medium">{{ deathReason }}</span>
          </div>
          <div v-if="deathTime" class="flex justify-between text-sm">
            <span class="text-stone-500">陨落时刻</span>
            <span class="text-stone-300 font-mono">{{ deathTime.toLocaleString('zh-CN') }}</span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-stone-500">剩余修为</span>
            <span class="text-amber-400 font-mono">{{ formatNumber(currentExp) }}</span>
          </div>
          <div class="border-t border-stone-800 pt-3 mt-3">
            <p class="text-xs text-stone-500 leading-relaxed">
              道友寿元已尽，魂归天地。可选择<span class="text-cyan-400">轮回重生</span>，重入修仙之道；
              或<span class="text-stone-400">退出登录</span>，他日再来。
            </p>
          </div>
        </div>

        <!-- 轮回结果反馈 -->
        <div v-if="reincarnateResult" class="mb-4 p-3 rounded-lg text-sm" :class="reincarnateResult.success ? 'bg-emerald-900/30 text-emerald-300 border border-emerald-700/50' : 'bg-red-900/30 text-red-300 border border-red-700/50'">
          {{ reincarnateResult.message }}
        </div>

        <!-- 按钮组 -->
        <div class="space-y-3">
          <button
            @click="handleReincarnate"
            :disabled="isReincarnating"
            class="w-full py-3 rounded-lg bg-gradient-to-r from-cyan-700 to-blue-700 hover:from-cyan-600 hover:to-blue-600 text-white font-bold tracking-wider transition-all shadow-lg shadow-cyan-900/50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <svg v-if="isReincarnating" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.24 7.76 2.83-2.83"/><path d="M18 12h4"/><path d="m16.24 16.24 2.83 2.83"/><path d="M12 18v4"/><path d="m4.93 19.07 2.83-2.83"/><path d="M2 12h4"/><path d="m4.93 4.93 2.83 2.83"/></svg>
            {{ isReincarnating ? '轮回中...' : '轮回重生' }}
          </button>
          <button
            @click="handleLogout"
            :disabled="isReincarnating"
            class="w-full py-2.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-400 hover:text-stone-200 text-sm transition-all border border-stone-700 disabled:opacity-50"
          >
            退出登录
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
