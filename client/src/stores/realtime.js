import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { useAuthStore } from './auth'
import { usePlayerStore } from './player'

export const useRealtimeStore = defineStore('realtime', {
  state: () => ({
    socket: null,
    isSocketConnected: false,
    movingState: {
      isMoving: false,
      fromMapId: null,
      toMapId: null,
      fromMapName: '',
      toMapName: '',
      startTime: null,
      endTime: null,
      totalSeconds: 0,
      remainingSeconds: 0
    }
  }),

  actions: {
    connect(playerId) {
      const authStore = useAuthStore()
      if (!authStore.token) return
      if (!playerId) return

      if (this.socket) {
        this.socket.disconnect()
      }

      this.socket = io('/', {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        auth: {
          playerId: playerId
        }
      })

      this.socket.on('connect', () => {
        this.isSocketConnected = true
      })

      this.socket.on('disconnect', () => {
        this.isSocketConnected = false
      })

      this.socket.on('connect_error', () => {
        this.isSocketConnected = false
      })

      this.socket.on('player:updated', async (data) => {
        const playerStore = usePlayerStore()
        const authStore = useAuthStore()

        if (data.updateType === 'gm_delete') {
          authStore.logout('您的账号已被管理员删除')
          playerStore.clear()
          this.disconnect()
          return
        }

        if (data.updateType === 'gm_ban') {
          authStore.logout(`您已被管理员封禁，原因：${data.reason || '未说明'}`)
          playerStore.clear()
          this.disconnect()
          return
        }

        await playerStore.fetchPlayer()
      })

      this.socket.on('move:completed', async () => {
        const playerStore = usePlayerStore()
        this.clearMovingState()
        await playerStore.fetchPlayer()
      })
    },

    disconnect() {
      if (this.socket) {
        this.socket.disconnect()
        this.socket = null
      }
      this.isSocketConnected = false
    },

    setMovingState(state) {
      this.movingState = {
        isMoving: true,
        fromMapId: state.from_map_id,
        toMapId: state.to_map_id,
        fromMapName: state.from_map_name,
        toMapName: state.to_map_name,
        startTime: state.start_time,
        endTime: state.end_time,
        totalSeconds: state.total_seconds,
        remainingSeconds: state.total_seconds
      }
    },

    updateRemainingTime(remainingSeconds) {
      this.movingState.remainingSeconds = remainingSeconds
    },

    clearMovingState() {
      this.movingState = {
        isMoving: false,
        fromMapId: null,
        toMapId: null,
        fromMapName: '',
        toMapName: '',
        startTime: null,
        endTime: null,
        totalSeconds: 0,
        remainingSeconds: 0
      }
    }
  }
})

