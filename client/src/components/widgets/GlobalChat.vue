<script setup>
import { ref, nextTick, watch, onMounted, onUnmounted, reactive } from 'vue'
import axios from 'axios'
import { io } from 'socket.io-client'
import { usePlayerStore } from '../../stores/player'

const isOpen = ref(false)
const newMessage = ref('')
const messages = ref([])
const messagesContainer = ref(null)
const playerStore = usePlayerStore()
let socket = null

// 拖拽相关状态
const isDragging = ref(false)
const chatPosition = reactive(JSON.parse(localStorage.getItem('chatPosition')) || { bottom: 120, right: 20 })
const dragOffset = reactive({ x: 0, y: 0 })

const onMouseDown = (e) => {
  isDragging.value = true
  // 记录点击位置相对于按钮中心的偏移，或者简单点，记录点击位置相对于按钮左上角的偏移
  // 这里我们采用基于视口坐标的计算
  // 由于我们使用 bottom/right 定位，计算稍微复杂一点，或者改为 top/left 定位会更直观
  // 为了简单起见，我们转为 top/left 定位模式，或者在拖拽时计算 delta
  
  // 记录鼠标初始位置
  dragOffset.x = e.clientX
  dragOffset.y = e.clientY
  
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

const onMouseMove = (e) => {
  if (!isDragging.value) return
  
  // 计算鼠标移动距离 (Delta)
  const dx = e.clientX - dragOffset.x
  const dy = e.clientY - dragOffset.y
  
  // 更新位置 (注意：我们用的是 bottom/right，鼠标向下(dy>0)意味着 bottom 减小，鼠标向右(dx>0)意味着 right 减小)
  chatPosition.bottom -= dy
  chatPosition.right -= dx
  
  // 更新鼠标位置
  dragOffset.x = e.clientX
  dragOffset.y = e.clientY
}

const onMouseUp = () => {
  isDragging.value = false
  localStorage.setItem('chatPosition', JSON.stringify(chatPosition))
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

const fetchMessages = async () => {
  try {
    const res = await axios.get('/api/chat/history')
    // Process messages to determine type
    messages.value = res.data.map(msg => ({
      id: msg.id,
      sender: msg.sender,
      content: msg.content,
      type: msg.type === 'system' ? 'system' : (msg.sender === playerStore.player?.nickname ? 'self' : 'player')
    }))
  } catch (error) {
    console.error('Failed to fetch chat history', error)
  }
}

const toggleChat = () => {
  if (isDragging.value) return // 防止拖拽结束时误触发点击
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    scrollToBottom()
    // Start polling when open
    fetchMessages()
  }
}

const sendMessage = async () => {
  if (!newMessage.value.trim()) return
  
  const content = newMessage.value
  newMessage.value = '' // Clear immediately for UX
  
  try {
    await axios.post('/api/chat/send', { content })
    // 不再需要 fetchMessages，因为 Socket.IO 会广播新消息
    scrollToBottom()
  } catch (error) {
    console.error('Failed to send message', error)
    // Restore message on failure
    newMessage.value = content
    alert('发送失败: ' + (error.response?.data?.message || error.message))
  }
}

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// Watch for new messages to scroll
watch(messages, (newVal, oldVal) => {
  if (isOpen.value && newVal.length > oldVal.length) {
    scrollToBottom()
  }
}, { deep: true })

onMounted(() => {
  fetchMessages()
  
  // 初始化 Socket.IO 连接
  // 在开发环境下，后端在 3000 端口，前端在 5173 端口，需要指定后端地址
  // 在生产环境下，由于是同域部署，可以直接不传地址或传空字符串
  const socketUrl = import.meta.env.DEV ? 'http://localhost:3000' : ''
  socket = io(socketUrl)
  
  // 监听新消息事件
  socket.on('new_message', (msg) => {
    messages.value.push({
      id: msg.id,
      sender: msg.sender,
      content: msg.content,
      type: msg.type === 'system' ? 'system' : (msg.sender === playerStore.player?.nickname ? 'self' : 'player')
    })
    
    // 如果聊天窗口打开，滚动到底部
    if (isOpen.value) {
      scrollToBottom()
    }
  })
})

onUnmounted(() => {
  if (socket) {
    socket.disconnect()
  }
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})
</script>

<template>
  <div 
    class="fixed z-50 flex flex-col items-end"
    :style="{ bottom: chatPosition.bottom + 'px', right: chatPosition.right + 'px' }"
  >
    <!-- Chat Window -->
    <div 
      v-if="isOpen"
      class="mb-4 w-80 h-96 bg-gray-900/95 border border-amber-600/30 rounded-lg shadow-2xl flex flex-col backdrop-blur-sm overflow-hidden transition-all duration-300 origin-bottom-right animate-fade-in-up select-none"
    >
      <!-- Header -->
      <div class="h-12 bg-gray-800/80 border-b border-gray-700 flex items-center justify-between px-4 shrink-0 cursor-move" @mousedown="onMouseDown">
        <div class="flex items-center gap-2 text-amber-500 font-bold pointer-events-none">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H18a2.5 2.5 0 0 1 0 5H16.5"></path><path d="M4 22h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2z"></path></svg>
          千里传音
        </div>
        <div class="text-xs text-gray-500 flex items-center gap-1 pointer-events-none">
          在线参与中
        </div>
      </div>

      <!-- Messages -->
      <div ref="messagesContainer" class="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        <div 
          v-for="msg in messages" 
          :key="msg.id" 
          class="flex flex-col"
          :class="msg.type === 'self' ? 'items-end' : (msg.type === 'system' ? 'items-center' : 'items-start')"
        >
          <span v-if="msg.type !== 'system' && msg.type !== 'self'" class="text-[10px] text-gray-500 mb-0.5 px-1">
            {{ msg.sender }}
          </span>
          
          <div 
            class="text-sm tracking-wide max-w-[90%] px-3 py-1.5 rounded break-words"
            :class="{
              'text-amber-500/80 italic font-serif text-center': msg.type === 'system',
              'bg-gray-800 text-gray-300': msg.type === 'player',
              'bg-emerald-900/50 text-emerald-100 border border-emerald-500/20': msg.type === 'self'
            }"
          >
            {{ msg.content }}
          </div>
          
          <!-- Divider for system msgs -->
          <div v-if="msg.type === 'system'" class="w-16 h-px bg-gradient-to-r from-transparent via-amber-900/50 to-transparent mx-auto mt-2"></div>
        </div>
        
        <div v-if="messages.length === 0" class="text-center text-gray-600 text-xs py-4">
          暂无消息
        </div>
      </div>

      <!-- Input -->
      <div class="p-3 bg-gray-800/30 border-t border-gray-700 shrink-0">
        <div class="relative">
          <input 
            v-model="newMessage"
            @keyup.enter="sendMessage"
            type="text" 
            placeholder="切磋武艺，交流感悟..." 
            class="w-full bg-transparent border border-gray-600 rounded-full py-2 pl-4 pr-10 text-sm text-gray-200 focus:outline-none focus:border-amber-500/50 transition-colors placeholder-gray-600"
          >
          <button 
            @click="sendMessage"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 text-amber-600 hover:text-amber-500 p-1 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Toggle Button -->
    <button 
      @mousedown="onMouseDown"
      @click="toggleChat"
      class="w-12 h-12 rounded-full bg-gray-800 border border-gray-600 text-gray-400 hover:text-amber-500 hover:border-amber-500/50 flex items-center justify-center shadow-lg transition-all relative group active:scale-95 cursor-move"
      :class="{'ring-2 ring-amber-500/50': isDragging}"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      
      <!-- Notification Dot (Optional logic could be added) -->
      <!-- <span v-if="!isOpen" class="absolute top-0 right-0 w-3 h-3 bg-red-600 rounded-full border-2 border-gray-900"></span> -->
      
      <!-- Tooltip -->
      <div v-if="!isDragging" class="absolute right-full mr-3 top-1/2 -translate-y-1/2 px-2 py-1 bg-black/80 text-xs text-amber-500 rounded border border-amber-900/30 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
        千里传音
      </div>
    </button>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(180, 83, 9, 0.2);
  border-radius: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(180, 83, 9, 0.4);
}

@keyframes fade-in-up {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
.animate-fade-in-up {
  animation: fade-in-up 0.2s ease-out forwards;
}
</style>
