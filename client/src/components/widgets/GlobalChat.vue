<script setup>
/**
 * 全局聊天组件
 * 使用统一 API 层和 Socket 服务进行聊天交互
 */
import { ref, nextTick, watch, onMounted, onUnmounted, reactive } from 'vue'
import { getChatHistory, sendMessage, getUnreadCount, markRead } from '../../api/chat'
import { socketService } from '../../services/socket'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'

const isOpen = ref(false)
const newMessage = ref('')
const messages = ref([])
const messagesContainer = ref(null)
const playerStore = usePlayerStore()
const uiStore = useUIStore()
let unsubscribe = null // Socket 事件取消监听函数

// 新消息提醒相关
const unreadCount = ref(0)
const lastReadTime = ref(localStorage.getItem('chatLastReadTime') || null)
const topNotification = ref({
  visible: false,
  content: ''
})
let notificationTimer = null

/**
 * 获取未读消息数量
 */
const fetchUnreadCount = async () => {
  try {
    const res = await getUnreadCount(lastReadTime.value)
    unreadCount.value = res.data.count
  } catch (error) {
    console.error('获取未读消息数量失败', error)
  }
}

/**
 * 标记消息已读
 */
const markMessagesRead = async () => {
  lastReadTime.value = new Date().toISOString()
  localStorage.setItem('chatLastReadTime', lastReadTime.value)
  unreadCount.value = 0
  
  try {
    await markRead()
  } catch (error) {
    console.error('标记已读失败', error)
  }
}

// 拖拽相关状态
const isDragging = ref(false)
const chatPosition = reactive(JSON.parse(localStorage.getItem('chatPosition')) || { bottom: 120, right: 20 })
const dragOffset = reactive({ x: 0, y: 0 })
// 拖拽阈值，区分点击和拖拽
const DRAG_THRESHOLD = 5

const onMouseDown = (e) => {
  isDragging.value = false
  dragOffset.x = e.clientX
  dragOffset.y = e.clientY
  
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

const onMouseMove = (e) => {
  // 计算移动距离，超过阈值才认为是拖拽
  const dx = Math.abs(e.clientX - dragOffset.x)
  const dy = Math.abs(e.clientY - dragOffset.y)
  
  if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
    isDragging.value = true
  }
  
  if (isDragging.value) {
    const moveX = e.clientX - dragOffset.x
    const moveY = e.clientY - dragOffset.y
    
    chatPosition.bottom -= moveY
    chatPosition.right -= moveX
    
    dragOffset.x = e.clientX
    dragOffset.y = e.clientY
  }
}

const onMouseUp = () => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  
  if (isDragging.value) {
    // 拖拽结束，保存位置
    localStorage.setItem('chatPosition', JSON.stringify(chatPosition))
    // 延迟重置，防止触发点击事件
    setTimeout(() => {
      isDragging.value = false
    }, 0)
  }
}

/**
 * 获取聊天历史
 */
const fetchMessages = async () => {
  try {
    const res = await getChatHistory()
    messages.value = (res.data.data || []).map(msg => ({
      id: msg.id,
      sender: msg.sender,
      content: msg.content,
      type: msg.type === 'system' ? 'system' : (msg.sender === playerStore.player?.nickname ? 'self' : 'player'),
      createdAt: new Date(msg.createdAt)
    }))
  } catch (error) {
    console.error('获取聊天历史失败', error)
  }
}

const toggleChat = () => {
  // 如果刚刚拖拽结束，不触发点击
  if (isDragging.value) return
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    scrollToBottom()
    fetchMessages()
    markMessagesRead()
  }
}

/**
 * 发送消息
 */
const sendMessageAction = async () => {
  if (!newMessage.value.trim()) return
  
  const content = newMessage.value
  newMessage.value = ''
  
  try {
    const res = await sendMessage(content)
    // 立即将新消息添加到本地列表，确保UI即时响应
    if (res.data) {
      const message = {
        id: res.data.id,
        sender: res.data.sender,
        content: res.data.content,
        type: 'self', // 自己发送的消息
        createdAt: new Date(res.data.createdAt)
      }
      messages.value.push(message)
    }
    scrollToBottom()
  } catch (error) {
    console.error('发送消息失败', error)
    newMessage.value = content
    const errorMsg = error.response?.data?.message || error.message || '未知错误'
    uiStore.showToast('发送失败: ' + errorMsg, 'error')
  }
}

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// 监听新消息以自动滚动
watch(messages, (newVal, oldVal) => {
  if (isOpen.value && newVal.length > oldVal.length) {
    scrollToBottom()
  }
}, { deep: true })

onMounted(() => {
  fetchMessages()
  fetchUnreadCount()
  
  // 使用统一 Socket 服务监听新消息
  unsubscribe = socketService.on('new_message', (msg) => {
    // 检查消息是否已存在，避免重复添加
    const exists = messages.value.some(m => m.id === msg.id)
    if (exists) return
    
    const message = {
      id: msg.id,
      sender: msg.sender,
      content: msg.content,
      type: msg.type === 'system' ? 'system' : (msg.sender === playerStore.player?.nickname ? 'self' : 'player'),
      createdAt: new Date(msg.createdAt)
    }
    messages.value.push(message)
    
    if (isOpen.value) {
      scrollToBottom()
      if (message.type !== 'self') {
        markMessagesRead()
      }
    } else {
      if (message.type !== 'self') {
        unreadCount.value++
      }
    }
    
    // 显示顶部通知（非自己发送的消息）
    if (message.type !== 'self') {
      if (notificationTimer) {
        clearTimeout(notificationTimer)
      }
      
      topNotification.value = {
        visible: true,
        content: `${message.sender}: ${message.content}`
      }
      
      notificationTimer = setTimeout(() => {
        topNotification.value.visible = false
      }, 5000)
    }
  })
})

onUnmounted(() => {
  // 取消 Socket 监听
  if (unsubscribe) {
    unsubscribe()
  }
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})
</script>

<template>
  <!-- 顶部通知组件 -->
  <div 
    v-if="topNotification.visible" 
    class="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-black/80 text-amber-400 border border-amber-500/30 px-4 py-2 rounded-lg shadow-lg transition-all duration-300 animate-fade-in-down"
    style="max-width: 60%; text-align: center;"
  >
    {{ topNotification.content }}
  </div>

  <div 
    class="fixed z-50 flex flex-col items-end"
    :style="{ bottom: chatPosition.bottom + 'px', right: chatPosition.right + 'px' }"
  >
    <!-- Chat Window -->
    <div 
      v-if="isOpen"
      class="mb-4 w-80 h-96 bg-[#14100d] border border-amber-500/40 rounded-2xl shadow-[0_0_25px_rgba(180,119,37,0.35)] flex flex-col backdrop-blur-sm overflow-hidden transition-all duration-300 origin-bottom-right animate-fade-in-up select-none"
    >
      <!-- Header -->
      <div class="h-12 bg-[#14100d] border-b border-amber-500/20 flex items-center justify-between px-4 shrink-0 cursor-move" @mousedown="onMouseDown">
        <div class="flex items-center gap-2 text-amber-300 font-semibold tracking-widest pointer-events-none">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"><path d="M13 10V3a1 1 0 0 0-2 0v7"></path><path d="M18 10a6 6 0 0 0-12 0v4"></path><path d="M4 19h16"></path><path d="M9 22h6"></path></svg>
          <span>千里传音</span>
        </div>
        <div class="text-xs text-amber-900/70 flex items-center gap-1 pointer-events-none">
          在线参与中
        </div>
      </div>

      <!-- Messages -->
      <div ref="messagesContainer" class="flex-1 overflow-y-auto px-4 py-3 space-y-4 custom-scrollbar bg-[#0f0b08]">
        <!-- 顶部分割线 -->
        <div class="w-full h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent mx-auto"></div>
        
        <!-- 欢迎词，放在消息列表顶部 -->
        <div class="flex items-center justify-center">
          <div class="bg-[#1c130d] text-amber-500 border border-amber-500/20 px-4 py-2 rounded-full text-sm font-serif">
            ✨ 欢迎来到修仙世界！ ✨
          </div>
        </div>
        
        <!-- 底部分割线 -->
        <div class="w-full h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent mx-auto"></div>
        
        <!-- 消息列表 -->
        <div 
          v-for="msg in messages" 
          :key="msg.id" 
          class="flex flex-col"
          :class="msg.type === 'self' ? 'items-end' : (msg.type === 'system' ? 'items-center' : 'items-start')"
        >
          <!-- 发送者信息，包含名字和时间 -->
          <div v-if="msg.type !== 'system'" class="flex items-center gap-2 text-[10px] text-gray-500 mb-0.5 px-1">
            <span v-if="msg.type !== 'self'">
              {{ msg.sender }}
            </span>
            <span 
              :class="msg.type === 'self' ? 'order-first' : ''"
            >
              {{ new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
            </span>
          </div>
          
          <!-- 消息内容 -->
          <div 
            class="text-sm tracking-wide max-w-[90%] px-3 py-1.5 rounded break-words"
            :class="{
              'text-amber-300 font-serif text-center': msg.type === 'system',
              'bg-[#1c130d] text-amber-50 border border-amber-500/20': msg.type === 'player',
              'bg-[#1b2516] text-emerald-50 border border-emerald-500/25': msg.type === 'self'
            }"
          >
            {{ msg.content }}
          </div>
          
          <!-- 系统消息显示时间 -->
          <span v-if="msg.type === 'system'" class="text-[10px] text-gray-500 mt-0.5 px-1">
            {{ new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
          </span>
          
          <!-- Divider for system msgs -->
          <div v-if="msg.type === 'system'" class="w-16 h-px bg-gradient-to-r from-transparent via-amber-700/60 to-transparent mx-auto mt-2"></div>
        </div>
      </div>

      <!-- Input -->
      <div class="p-3 bg-[#14100d] border-t border-amber-500/20 shrink-0">
        <div class="relative rounded-2xl border border-amber-500/30 bg-[#130f0b] px-3 py-1.5 flex items-center">
          <input
            v-model="newMessage"
            @keyup.enter="sendMessageAction"
            type="text"
            placeholder="切磋武艺，交流感悟..."
            class="flex-1 bg-transparent outline-none border-none text-sm text-amber-50 placeholder-amber-900/60"
          >
          <button
            @click="sendMessageAction"
            class="ml-2 w-8 h-8 rounded-full flex items-center justify-center bg-amber-500 text-[#130f0b] shadow-[0_0_14px_rgba(251,191,36,0.65)] hover:bg-amber-400 active:scale-95 transition-transform transition-colors"
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
      class="w-12 h-12 rounded-full bg-[#14100d] border border-amber-500/70 text-amber-300 hover:text-amber-100 hover:border-amber-400 flex items-center justify-center shadow-[0_0_18px_rgba(251,191,36,0.45)] transition-all relative group active:scale-95 cursor-move"
      :class="{'ring-2 ring-amber-500/70': isDragging}"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      
      <!-- Notification Dot -->
      <span v-if="!isOpen && unreadCount > 0" class="absolute top-0 right-0 w-3 h-3 bg-red-600 rounded-full border-2 border-gray-900"></span>
      
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

@keyframes fade-in-down {
  from {
    opacity: 0;
    transform: translateY(-10px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
.animate-fade-in-down {
  animation: fade-in-down 0.2s ease-out forwards;
}
</style>
