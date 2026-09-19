<script setup>
import { ref, onMounted, computed } from 'vue'
import apiClient from './api'
import Login from './views/Login.vue'
import ToastContainer from './components/common/ToastContainer.vue'
import { usePlayerStore } from './stores/player'
import { useUIStore } from './stores/ui'
import ChangelogModal from './components/modals/ChangelogModal.vue'
import { currentVersion } from './data/changelog'
import { exchangeQQTicket } from './api/auth'
import { readQQRedirect } from './utils/qqAuth'

const playerStore = usePlayerStore()
const uiStore = useUIStore()
const showChangelog = ref(false)

// 使用计算属性响应 Pinia 中的 player 变化
const currentPlayer = computed(() => playerStore.player)

const isInitialized = ref(false)

// 原先这里每 5 秒打一次 /system/stats 测延迟，把 serverStatus / dbStatus / ping
// 三个值传给 GameLayout —— 而 GameLayout 的模板从头到尾没有渲染过它们，
// 等于每个在线玩家每 5 秒白白发一个请求。要恢复在线状态展示，
// 请连同展示位一起做，不要再留只写不读的通道。

// 监听登录成功事件
const handleLoginSuccess = async () => {
  console.log('Login success event received')
  // 登录后获取完整数据 (双重保险，如果 Login 页面已经获取过，这里会再次获取最新状态)
  await playerStore.fetchPlayer()
  console.log('Player after fetch:', playerStore.player)
}

// 关闭更新日志
const handleChangelogClose = () => {
  showChangelog.value = false
  localStorage.setItem('app_version', currentVersion)
}

/**
 * 处理 QQ 授权回跳
 *
 * 只把一次性票据换成 token，后续的玩家数据加载仍走下面原有的 token 恢复分支，
 * 使 QQ 登录与账号密码登录共用同一条初始化路径。
 * 未绑定的 QQ（qq_pending）不在这里处理，由 Login.vue 引导登录/注册后完成绑定。
 */
const handleQQRedirect = async () => {
  const qq = readQQRedirect()

  if (qq.ticket) {
    try {
      const res = await exchangeQQTicket(qq.ticket)
      playerStore.logoutReason = null
      playerStore.setToken(res.data.token)
    } catch (e) {
      uiStore.showToast('QQ 登录凭证已失效，请重新扫码', 'error')
    }
  }

  if (qq.error) {
    uiStore.showToast(qq.error, 'error')
  } else if (qq.bindResult === 'success') {
    uiStore.showToast('QQ 绑定成功，以后可直接用 QQ 登录', 'success')
  }
}

onMounted(async () => {
  // 检查版本更新
  const lastVersion = localStorage.getItem('app_version')
  if (lastVersion !== currentVersion) {
    showChangelog.value = true
  }

  await handleQQRedirect()

  // 恢复 Token 并验证
  if (playerStore.token) {
    apiClient.defaults.headers.common['Authorization'] = `Bearer ${playerStore.token}`
    try {
      await playerStore.fetchPlayer()
      if (!playerStore.player) {
         // 如果 fetchPlayer 后依然没有 player (比如后端返回空但没报错，虽然不太可能)，视为失败
         throw new Error('No player data')
      }
    } catch (e) {
      // 验证失败，清除状态
      playerStore.logout()
    }
  } else {
    // 没有 token，确保清除可能残留的 player 数据
    playerStore.logout()
  }
  
  isInitialized.value = true
})
</script>

<template>
  <!-- 全局初始化加载状态 -->
  <div v-if="!isInitialized" class="min-h-screen flex flex-col items-center justify-center bg-surface-canvas text-gold-500">
    <div class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-gold-500 mb-4"></div>
    <div class="text-lg font-display tracking-widest">正在通往修仙世界...</div>
  </div>

  <template v-else>
    <div v-if="!currentPlayer">
      <Login @login-success="handleLoginSuccess" />
    </div>
    <!-- 游戏主体由路由渲染（/ 总览，/p/<panelId> 展开中的面板）。
         两条路由指向同一个 GameLayout，所以这里不需要 <component :is>。 -->
    <RouterView v-else :player="currentPlayer" />
  </template>
  <ToastContainer />
  <ChangelogModal :isOpen="showChangelog" @close="handleChangelogClose" />
</template>
