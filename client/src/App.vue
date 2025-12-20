<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import axios from 'axios'
import GameLayout from './components/layout/GameLayout.vue'
import Login from './views/Login.vue'
import { usePlayerStore } from './stores/player'

const serverStatus = ref('正在连接...')
const dbStatus = ref('检查中...')
const ping = ref(0)
const playerStore = usePlayerStore()

// 使用计算属性响应 Pinia 中的 player 变化
const currentPlayer = computed(() => playerStore.player)

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

  // 监听登录成功事件 (虽然 Pinia 已经处理了，但为了 Login 组件的 emit 兼容性)
  const handleLoginSuccess = async (player) => {
    playerStore.setPlayer(player)
    // 登录后获取完整数据
    await playerStore.fetchPlayer()
  }

  let pingInterval

  onMounted(async () => {
    checkStatus()
    // 每5秒检查一次状态和延迟
    pingInterval = setInterval(checkStatus, 5000)
    
    // 恢复 Token 并验证
    if (playerStore.token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${playerStore.token}`
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

onUnmounted(() => {
  if (pingInterval) clearInterval(pingInterval)
})
</script>

<template>
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
