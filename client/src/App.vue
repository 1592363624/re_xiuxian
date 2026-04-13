<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import axios from 'axios'
import GameLayout from './components/layout/GameLayout.vue'
import Login from './views/Login.vue'
import ToastContainer from './components/common/ToastContainer.vue'
import MovingOverlay from './components/overlays/MovingOverlay.vue'
import { usePlayerStore } from './stores/player'
import { useAuthStore } from './stores/auth'
import { useUIStore } from './stores/ui'
import { useConfigStore } from './stores/config'
import { useRealtimeStore } from './stores/realtime'
import ChangelogModal from './components/modals/ChangelogModal.vue'
import { currentVersion } from './data/changelog'

const serverStatus = ref('正在连接...')
const dbStatus = ref('检查中...')
const ping = ref(0)
const authStore = useAuthStore()
const playerStore = usePlayerStore()
const uiStore = useUIStore()
const configStore = useConfigStore()
const realtimeStore = useRealtimeStore()
const showChangelog = ref(false)

// 使用计算属性响应 Pinia 中的 player 变化
const currentPlayer = computed(() => playerStore.player)
const movingState = computed(() => realtimeStore.movingState)

const isInitialized = ref(false)

const checkStatus = async () => {
  const start = performance.now()
  try {
    // 添加时间戳防止缓存
    const res = await axios.get(`/api/status?t=${Date.now()}`)
    const end = performance.now()
    ping.value = Math.round(end - start)
    serverStatus.value = res.data.message
    dbStatus.value = '连接正常'
  } catch (error) {
    serverStatus.value = '连接失败'
    dbStatus.value = error.message
    ping.value = -1
  }
}

// 监听登录成功事件
const handleLoginSuccess = async () => {
  console.log('Login success event received')
  await configStore.fetchConfigs()
  // 登录后获取完整数据 (双重保险，如果 Login 页面已经获取过，这里会再次获取最新状态)
  await playerStore.fetchPlayer()
  realtimeStore.connect(playerStore.player?.id)
  console.log('Player after fetch:', playerStore.player)
}

// 移动完成处理
const handleMoveComplete = async () => {
  realtimeStore.clearMovingState()
  uiStore.showToast('已到达目的地', 'success')
  await playerStore.fetchPlayer()
}

// 关闭更新日志
const handleChangelogClose = () => {
  showChangelog.value = false
  localStorage.setItem('app_version', currentVersion)
}

let pingInterval

onMounted(async () => {
  checkStatus()
  // 每5秒检查一次状态和延迟
  pingInterval = setInterval(checkStatus, 5000)
  
  // 检查版本更新
  const lastVersion = localStorage.getItem('app_version')
  if (lastVersion !== currentVersion) {
    showChangelog.value = true
  }

  // 恢复 Token 并验证
  if (authStore.token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${authStore.token}`
    try {
      await configStore.fetchConfigs()
      await playerStore.fetchPlayer()
      if (!playerStore.player) {
         // 如果 fetchPlayer 后依然没有 player (比如后端返回空但没报错，虽然不太可能)，视为失败
         throw new Error('No player data')
      }
      realtimeStore.connect(playerStore.player?.id)
    } catch (e) {
      // 验证失败，清除状态
      authStore.logout()
      playerStore.clear()
      realtimeStore.disconnect()
    }
  } else {
    // 没有 token，确保清除可能残留的 player 数据
    authStore.logout()
    playerStore.clear()
    realtimeStore.disconnect()
  }
  
  isInitialized.value = true
})

onUnmounted(() => {
  if (pingInterval) clearInterval(pingInterval)
})
</script>

<template>
  <!-- 全局初始化加载状态 -->
  <div v-if="!isInitialized" class="min-h-screen flex flex-col items-center justify-center bg-xiuxian-dark text-xiuxian-gold">
    <div class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-xiuxian-gold mb-4"></div>
    <div class="text-lg font-serif tracking-widest">正在通往修仙世界...</div>
  </div>

  <template v-else>
    <div v-if="!currentPlayer">
      <Login @login-success="handleLoginSuccess" />
    </div>
    <GameLayout 
      v-else
      :serverStatus="serverStatus" 
      :dbStatus="dbStatus"
      :ping="ping"
      :player="currentPlayer"
    />
  </template>
  <ToastContainer />
  <MovingOverlay 
    :show="movingState.isMoving" 
    @complete="handleMoveComplete"
  />
  <ChangelogModal :isOpen="showChangelog" @close="handleChangelogClose" />
</template>
