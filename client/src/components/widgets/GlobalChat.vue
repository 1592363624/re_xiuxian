<script setup>
/**
 * 全局聊天组件
 *
 * 功能：
 *   1. 聊天消息：使用统一 API 层和 Socket 服务进行聊天交互
 *   2. 红包玩法：发送红包、领取红包、查看红包详情
 *
 * 红包交互流程：
 *   - 点击输入框旁红包图标 → 打开发红包弹窗
 *   - 填写金额/个数/类型/留言 → 发送 → Socket 广播红包卡片
 *   - 点击红包卡片 → 查询详情 → 未领取则领取，已领取则查看记录
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal
 *   - 红包卡片使用红色/金色主题，区分于普通消息
 */
import { ref, nextTick, watch, onMounted, onUnmounted, reactive, computed } from 'vue'
import { getChatHistory, sendMessage, getUnreadCount, markRead, sendRedPacket, claimRedPacket, getRedPacketDetail, showItem } from '../../api/chat'
import { getInventory } from '../../api/inventory'
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

/* ============================================================
 * 红包相关状态
 * ============================================================ */

// 发红包弹窗
const redPacketModal = reactive({
  visible: false,
  amount: '',
  count: '',
  type: 'lucky', // lucky=拼手气, equal=普通均分
  message: '',
  sending: false
})

// 红包详情弹窗
const redPacketDetail = reactive({
  visible: false,
  loading: false,
  data: null, // RedPacketDetail
  claiming: false
})

/* ============================================================
 * 物品展示相关状态
 * ============================================================ */

// 品质颜色映射（复用 InventoryPanel.vue 的 qualityColorMap 配置）
// common 白 / uncommon 绿 / rare 蓝 / epic 紫 / legendary 橙
const qualityColorMap = {
  common: { border: 'border-stone-600', text: 'text-stone-300', label: '普通' },
  uncommon: { border: 'border-emerald-600', text: 'text-emerald-400', label: '非凡' },
  rare: { border: 'border-blue-600', text: 'text-blue-400', label: '稀有' },
  epic: { border: 'border-purple-600', text: 'text-purple-400', label: '史诗' },
  legendary: { border: 'border-amber-600', text: 'text-amber-400', label: '传说' },
  unknown: { border: 'border-stone-700', text: 'text-stone-500', label: '未知' }
}

// 物品类型中文名映射
const itemTypeLabelMap = {
  consumable: '消耗品',
  material: '材料',
  equipment: '装备',
  recipe_scroll: '图谱',
  unknown: '物品'
}

// 物品选择弹窗（从背包选择要展示的物品）
const itemSelectModal = reactive({
  visible: false,
  loading: false,
  items: [],      // 背包物品列表
  sending: false  // 发送中状态锁
})

// 物品详情弹窗（点击聊天中的物品卡片查看详情）
const itemDetailModal = reactive({
  visible: false,
  data: null  // ItemShowMessageContent
})

/**
 * 发红包总消耗预览（金额本身，无手续费）
 */
const redPacketPreview = computed(() => {
  const amt = Number(redPacketModal.amount) || 0
  return amt
})

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
 * 解析红包消息 content（type='red_packet' 时 content 为 JSON 字符串）
 * @param {string} content - 消息内容
 * @returns {Object|null} 红包元信息，解析失败返回 null
 */
function parseRedPacketContent(content) {
  try {
    const data = JSON.parse(content)
    if (data && data.red_packet_id) return data
  } catch (e) {
    // 非 JSON 或解析失败
  }
  return null
}

/**
 * 获取聊天历史
 */
const fetchMessages = async () => {
  try {
    const res = await getChatHistory()
    messages.value = (res.data.data || []).map(msg => {
      // red_packet 类型消息解析 content 为红包元信息
      if (msg.type === 'red_packet') {
        const rpInfo = parseRedPacketContent(msg.content)
        return {
          id: msg.id,
          sender: msg.sender,
          content: msg.content,
          type: msg.sender === playerStore.player?.nickname ? 'self' : 'player',
          messageType: 'red_packet',
          redPacketInfo: rpInfo,
          createdAt: new Date(msg.createdAt)
        }
      }
      // item_show 类型消息解析 content 为物品展示信息
      if (msg.type === 'item_show') {
        const itemInfo = parseItemShowContent(msg.content)
        return {
          id: msg.id,
          sender: msg.sender,
          content: msg.content,
          type: msg.sender === playerStore.player?.nickname ? 'self' : 'player',
          messageType: 'item_show',
          itemShowInfo: itemInfo,
          createdAt: new Date(msg.createdAt)
        }
      }
      return {
        id: msg.id,
        sender: msg.sender,
        content: msg.content,
        type: msg.type === 'system' ? 'system' : (msg.sender === playerStore.player?.nickname ? 'self' : 'player'),
        messageType: msg.type,
        createdAt: new Date(msg.createdAt)
      }
    })
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
        type: 'self',
        messageType: 'player',
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

/* ============================================================
 * 红包操作方法
 * ============================================================ */

/**
 * 打开发红包弹窗
 */
const openRedPacketModal = () => {
  redPacketModal.visible = true
  redPacketModal.amount = ''
  redPacketModal.count = ''
  redPacketModal.type = 'lucky'
  redPacketModal.message = ''
}

/**
 * 关闭发红包弹窗
 */
const closeRedPacketModal = () => {
  if (redPacketModal.sending) return
  redPacketModal.visible = false
}

/**
 * 确认发送红包
 */
const confirmSendRedPacket = async () => {
  const amount = Number(redPacketModal.amount)
  const count = parseInt(redPacketModal.count)

  // 参数校验
  if (!Number.isFinite(amount) || amount < 10) {
    uiStore.showToast('红包总金额至少 10 灵石', 'error')
    return
  }
  if (!Number.isFinite(count) || count < 1) {
    uiStore.showToast('红包个数至少 1 个', 'error')
    return
  }
  if (amount < count) {
    uiStore.showToast('金额不足，每人至少需 1 灵石', 'error')
    return
  }
  if (redPacketModal.message.length > 100) {
    uiStore.showToast('红包附言不能超过 100 字', 'error')
    return
  }

  redPacketModal.sending = true
  try {
    const res = await sendRedPacket(amount, count, redPacketModal.type, redPacketModal.message || undefined)
    const data = res.data.data || res.data
    uiStore.showToast(`红包发送成功，消耗 ${amount} 灵石`, 'success')
    redPacketModal.visible = false

    // 立即将红包消息添加到本地列表（Socket 也会广播，但本地先显示避免延迟）
    const message = {
      id: data.chat_message_id,
      sender: data.sender.nickname,
      content: JSON.stringify({
        red_packet_id: data.red_packet_id,
        total_amount: data.total_amount,
        total_count: data.total_count,
        packet_type: data.packet_type,
        message: data.message || ''
      }),
      type: 'self',
      messageType: 'red_packet',
      redPacketInfo: {
        red_packet_id: data.red_packet_id,
        total_amount: data.total_amount,
        total_count: data.total_count,
        packet_type: data.packet_type,
        message: data.message || ''
      },
      createdAt: new Date(data.created_at)
    }
    // 避免重复（Socket 可能在 API 返回前已推送）
    const exists = messages.value.some(m => m.id === message.id)
    if (!exists) {
      messages.value.push(message)
      scrollToBottom()
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message || '未知错误'
    uiStore.showToast('红包发送失败: ' + errorMsg, 'error')
  } finally {
    redPacketModal.sending = false
  }
}

/**
 * 点击红包卡片
 * 查询红包详情，判断是否可领取
 * @param {Object} redPacketInfo - 红包元信息（从消息 content 解析）
 */
const handleRedPacketClick = async (redPacketInfo) => {
  if (!redPacketInfo || !redPacketInfo.red_packet_id) return

  redPacketDetail.visible = true
  redPacketDetail.loading = true
  redPacketDetail.data = null
  redPacketDetail.claiming = false

  try {
    const res = await getRedPacketDetail(redPacketInfo.red_packet_id)
    redPacketDetail.data = res.data.data || res.data
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message || '未知错误'
    uiStore.showToast('查询红包失败: ' + errorMsg, 'error')
    redPacketDetail.visible = false
  } finally {
    redPacketDetail.loading = false
  }
}

/**
 * 领取红包
 */
const handleClaimRedPacket = async () => {
  if (!redPacketDetail.data || redPacketDetail.claiming) return

  redPacketDetail.claiming = true
  try {
    const res = await claimRedPacket(redPacketDetail.data.red_packet_id)
    const result = res.data.data || res.data

    // 领取成功提示
    if (result.is_lucky_king) {
      uiStore.showToast(`手气最佳！获得 ${result.amount} 灵石`, 'success')
    } else {
      uiStore.showToast(`领取成功，获得 ${result.amount} 灵石`, 'success')
    }

    // 刷新红包详情
    const detailRes = await getRedPacketDetail(redPacketDetail.data.red_packet_id)
    redPacketDetail.data = detailRes.data.data || detailRes.data
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message || '未知错误'
    uiStore.showToast('领取失败: ' + errorMsg, 'error')
  } finally {
    redPacketDetail.claiming = false
  }
}

/**
 * 关闭红包详情弹窗
 */
const closeRedPacketDetail = () => {
  if (redPacketDetail.claiming) return
  redPacketDetail.visible = false
}

/**
 * 红包类型显示文本
 */
const redPacketTypeLabel = (type) => {
  return type === 'lucky' ? '拼手气' : '普通均分'
}

/**
 * 红包状态显示文本
 */
const redPacketStatusLabel = (status) => {
  const map = {
    active: '可领取',
    exhausted: '已被领完',
    expired: '已过期',
    refunded: '已过期退款'
  }
  return map[status] || status
}

/* ============================================================
 * 物品展示操作方法
 * ============================================================ */

/**
 * 解析物品展示消息 content（type='item_show' 时 content 为 JSON 字符串）
 * @param {string} content - 消息内容
 * @returns {Object|null} 物品展示信息，解析失败返回 null
 */
function parseItemShowContent(content) {
  try {
    const data = JSON.parse(content)
    if (data && data.item_key && data.item_name) return data
  } catch (e) {
    // 非 JSON 或解析失败
  }
  return null
}

/**
 * 获取品质对应的样式配置
 * @param {string} quality - 品质 key
 * @returns {Object} 品质样式对象
 */
const getQualityStyle = (quality) => {
  return qualityColorMap[quality] || qualityColorMap.unknown
}

/**
 * 获取物品类型中文名
 * @param {string} type - 类型 key
 * @returns {string} 中文名
 */
const getItemTypeLabel = (type) => {
  return itemTypeLabelMap[type] || '物品'
}

/**
 * 打开物品选择弹窗
 * 从后端拉取玩家背包物品列表，展示在弹窗中供选择
 */
const openItemSelectModal = async () => {
  itemSelectModal.visible = true
  itemSelectModal.loading = true
  itemSelectModal.items = []
  itemSelectModal.sending = false

  try {
    const res = await getInventory()
    itemSelectModal.items = res.data?.data?.items || []
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message || '未知错误'
    uiStore.showToast('获取背包失败: ' + errorMsg, 'error')
    itemSelectModal.visible = false
  } finally {
    itemSelectModal.loading = false
  }
}

/**
 * 关闭物品选择弹窗
 */
const closeItemSelectModal = () => {
  if (itemSelectModal.sending) return
  itemSelectModal.visible = false
}

/**
 * 确认展示物品
 * 调用后端 POST /chat/show-item，展示成功后关闭弹窗
 * @param {Object} item - 背包物品对象（InventoryItem）
 */
const confirmShowItem = async (item) => {
  if (itemSelectModal.sending) return

  itemSelectModal.sending = true
  try {
    const res = await showItem(item.item_key)
    const data = res.data?.data || res.data
    uiStore.showToast(`已展示【${item.name}】`, 'success')
    itemSelectModal.visible = false

    // 立即将物品展示消息添加到本地列表（Socket 也会广播，但本地先显示避免延迟）
    const message = {
      id: data.chat_message_id,
      sender: playerStore.player?.nickname || '我',
      content: JSON.stringify(data.item_show),
      type: 'self',
      messageType: 'item_show',
      itemShowInfo: data.item_show,
      createdAt: new Date()
    }
    // 避免重复（Socket 可能在 API 返回前已推送）
    const exists = messages.value.some(m => m.id === message.id)
    if (!exists) {
      messages.value.push(message)
      scrollToBottom()
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message || '未知错误'
    uiStore.showToast('展示失败: ' + errorMsg, 'error')
  } finally {
    itemSelectModal.sending = false
  }
}

/**
 * 点击聊天中的物品卡片
 * 打开物品详情弹窗查看完整信息
 * @param {Object} itemShowInfo - 物品展示信息（从消息 content 解析）
 */
const handleItemClick = (itemShowInfo) => {
  if (!itemShowInfo) return
  itemDetailModal.visible = true
  itemDetailModal.data = itemShowInfo
}

/**
 * 关闭物品详情弹窗
 */
const closeItemDetail = () => {
  itemDetailModal.visible = false
  itemDetailModal.data = null
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

    // red_packet 类型消息解析 content
    if (msg.type === 'red_packet') {
      const rpInfo = parseRedPacketContent(msg.content)
      const message = {
        id: msg.id,
        sender: msg.sender,
        content: msg.content,
        type: msg.sender === playerStore.player?.nickname ? 'self' : 'player',
        messageType: 'red_packet',
        redPacketInfo: rpInfo,
        createdAt: new Date(msg.createdAt)
      }
      messages.value.push(message)
    } else if (msg.type === 'item_show') {
      // item_show 类型消息解析 content 为物品展示信息
      const itemInfo = parseItemShowContent(msg.content)
      const message = {
        id: msg.id,
        sender: msg.sender,
        content: msg.content,
        type: msg.sender === playerStore.player?.nickname ? 'self' : 'player',
        messageType: 'item_show',
        itemShowInfo: itemInfo,
        createdAt: new Date(msg.createdAt)
      }
      messages.value.push(message)
    } else {
      const message = {
        id: msg.id,
        sender: msg.sender,
        content: msg.content,
        type: msg.type === 'system' ? 'system' : (msg.sender === playerStore.player?.nickname ? 'self' : 'player'),
        messageType: msg.type,
        createdAt: new Date(msg.createdAt)
      }
      messages.value.push(message)
    }

    if (isOpen.value) {
      scrollToBottom()
      // 非自己发送的消息标记已读
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg.type !== 'self') {
        markMessagesRead()
      }
    } else {
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg.type !== 'self') {
        unreadCount.value++
      }
    }

    // 显示顶部通知（非自己发送的消息）
    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg.type !== 'self') {
      if (notificationTimer) {
        clearTimeout(notificationTimer)
      }

      // 红包/物品消息特殊通知文案
      let notifyContent
      if (lastMsg.messageType === 'red_packet') {
        notifyContent = `${lastMsg.sender} 发了一个红包！`
      } else if (lastMsg.messageType === 'item_show' && lastMsg.itemShowInfo) {
        notifyContent = `${lastMsg.sender} 展示了【${lastMsg.itemShowInfo.item_name}】`
      } else {
        notifyContent = `${lastMsg.sender}: ${lastMsg.content}`
      }

      topNotification.value = {
        visible: true,
        content: notifyContent
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

          <!-- 红包消息卡片 -->
          <div
            v-if="msg.messageType === 'red_packet' && msg.redPacketInfo"
            @click="handleRedPacketClick(msg.redPacketInfo)"
            class="w-[90%] max-w-[260px] cursor-pointer rounded-lg overflow-hidden border border-red-500/40 hover:border-red-400/70 transition-all hover:shadow-[0_0_15px_rgba(239,68,68,0.35)] active:scale-[0.98]"
          >
            <!-- 红包顶部红色区域 -->
            <div class="bg-gradient-to-r from-red-900/80 to-amber-900/80 px-3 py-2.5 flex items-center gap-2.5">
              <!-- 红包图标 -->
              <div class="w-8 h-8 rounded-full bg-red-500/30 border border-red-400/50 flex items-center justify-center shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-300">
                  <rect x="2" y="5" width="20" height="14" rx="2"/>
                  <path d="M2 10h20"/>
                  <path d="M12 5v14"/>
                </svg>
              </div>
              <!-- 红包信息 -->
              <div class="flex-1 min-w-0">
                <div class="text-xs font-bold text-amber-200 truncate">
                  {{ msg.redPacketInfo.message || '仙友发了一个红包' }}
                </div>
                <div class="text-[10px] text-amber-400/70 mt-0.5">
                  {{ redPacketTypeLabel(msg.redPacketInfo.packet_type) }} · {{ msg.redPacketInfo.total_count }}个
                </div>
              </div>
            </div>
            <!-- 红包底部提示 -->
            <div class="bg-[#1c130d] px-3 py-1 text-[10px] text-amber-500/60 text-center">
              点击领取红包
            </div>
          </div>

          <!-- 物品展示消息卡片 -->
          <div
            v-else-if="msg.messageType === 'item_show' && msg.itemShowInfo"
            @click="handleItemClick(msg.itemShowInfo)"
            class="w-[90%] max-w-[260px] cursor-pointer rounded-lg overflow-hidden border transition-all hover:shadow-lg active:scale-[0.98]"
            :class="getQualityStyle(msg.itemShowInfo.quality).border"
          >
            <!-- 物品顶部区域（品质色背景） -->
            <div class="bg-gradient-to-r from-[#1c130d] to-[#292014] px-3 py-2.5 flex items-center gap-2.5">
              <!-- 物品图标（包裹图标，品质色边框） -->
              <div
                class="w-8 h-8 rounded flex items-center justify-center shrink-0 border"
                :class="getQualityStyle(msg.itemShowInfo.quality).border"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="getQualityStyle(msg.itemShowInfo.quality).text">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  <path d="M3.27 6.96 12 12.01l8.73-5.05"/>
                  <path d="M12 22.08V12"/>
                </svg>
              </div>
              <!-- 物品信息 -->
              <div class="flex-1 min-w-0">
                <div class="text-xs font-bold truncate" :class="getQualityStyle(msg.itemShowInfo.quality).text">
                  {{ msg.itemShowInfo.item_name }}
                </div>
                <div class="text-[10px] text-stone-400 mt-0.5 flex items-center gap-1">
                  <span class="px-1 rounded border" :class="getQualityStyle(msg.itemShowInfo.quality).border">
                    {{ getQualityStyle(msg.itemShowInfo.quality).label }}
                  </span>
                  <span>{{ getItemTypeLabel(msg.itemShowInfo.type) }}</span>
                  <span v-if="msg.itemShowInfo.quantity > 1" class="text-amber-500/70">×{{ msg.itemShowInfo.quantity }}</span>
                </div>
              </div>
            </div>
            <!-- 物品底部提示 -->
            <div class="bg-[#1c130d] px-3 py-1 text-[10px] text-stone-500 text-center">
              点击查看详情
            </div>
          </div>

          <!-- 普通消息内容 -->
          <div
            v-else
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
        <div class="relative rounded-2xl border border-amber-500/30 bg-[#130f0b] px-3 py-1.5 flex items-center gap-2">
          <!-- 红包按钮 -->
          <button
            @click="openRedPacketModal"
            class="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-red-900/40 text-red-300 border border-red-700/40 hover:bg-red-800/50 hover:text-red-200 transition-colors active:scale-95"
            title="发红包"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2"/>
              <path d="M2 10h20"/>
              <path d="M12 5v14"/>
            </svg>
          </button>
          <!-- 展示物品按钮 -->
          <button
            @click="openItemSelectModal"
            class="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-amber-900/40 text-amber-300 border border-amber-700/40 hover:bg-amber-800/50 hover:text-amber-200 transition-colors active:scale-95"
            title="展示物品"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <path d="M3.27 6.96 12 12.01l8.73-5.05"/>
              <path d="M12 22.08V12"/>
            </svg>
          </button>
          <input
            v-model="newMessage"
            @keyup.enter="sendMessageAction"
            type="text"
            placeholder="切磋武艺，交流感悟..."
            class="flex-1 bg-transparent outline-none border-none text-sm text-amber-50 placeholder-amber-900/60 min-w-0"
          >
          <button
            @click="sendMessageAction"
            class="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-amber-500 text-[#130f0b] shadow-[0_0_14px_rgba(251,191,36,0.65)] hover:bg-amber-400 active:scale-95 transition-transform transition-colors"
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

    <!-- ============================================================ -->
    <!-- 发红包弹窗 -->
    <!-- ============================================================ -->
    <div
      v-if="redPacketModal.visible"
      class="fixed inset-0 z-[60] flex items-center justify-center"
    >
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="closeRedPacketModal"></div>
      <div class="relative bg-[#1c130d] border border-red-500/40 rounded-lg p-5 w-72 mx-4 shadow-2xl shadow-red-900/20 animate-fade-in-up">
        <!-- 标题 -->
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-base font-bold text-red-300 flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2"/>
              <path d="M2 10h20"/>
              <path d="M12 5v14"/>
            </svg>
            发放红包
          </h3>
          <button @click="closeRedPacketModal" class="text-stone-500 hover:text-white transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <!-- 红包类型切换 -->
        <div class="flex gap-1.5 mb-3">
          <button
            @click="redPacketModal.type = 'lucky'"
            :class="redPacketModal.type === 'lucky'
              ? 'bg-red-900/50 text-red-200 border-red-500/60'
              : 'bg-[#292524] text-stone-400 border-stone-700 hover:text-stone-200'"
            class="flex-1 px-2 py-1.5 text-xs rounded border transition-colors"
          >
            🎊 拼手气
          </button>
          <button
            @click="redPacketModal.type = 'equal'"
            :class="redPacketModal.type === 'equal'
              ? 'bg-red-900/50 text-red-200 border-red-500/60'
              : 'bg-[#292524] text-stone-400 border-stone-700 hover:text-stone-200'"
            class="flex-1 px-2 py-1.5 text-xs rounded border transition-colors"
          >
            📦 普通均分
          </button>
        </div>

        <!-- 金额输入 -->
        <div class="mb-3">
          <label class="text-xs text-stone-400 mb-1 block">总金额（灵石）</label>
          <input
            v-model="redPacketModal.amount"
            type="number"
            min="10"
            placeholder="至少 10 灵石"
            class="w-full bg-[#130f0b] border border-red-500/30 rounded px-3 py-2 text-sm text-amber-50 outline-none focus:border-red-400/60"
          >
        </div>

        <!-- 个数输入 -->
        <div class="mb-3">
          <label class="text-xs text-stone-400 mb-1 block">红包个数</label>
          <input
            v-model="redPacketModal.count"
            type="number"
            min="1"
            max="100"
            placeholder="1 ~ 100"
            class="w-full bg-[#130f0b] border border-red-500/30 rounded px-3 py-2 text-sm text-amber-50 outline-none focus:border-red-400/60"
          >
        </div>

        <!-- 留言输入 -->
        <div class="mb-3">
          <label class="text-xs text-stone-400 mb-1 block">附言（可选）</label>
          <input
            v-model="redPacketModal.message"
            type="text"
            maxlength="100"
            placeholder="仙道昌隆，广结善缘"
            class="w-full bg-[#130f0b] border border-red-500/30 rounded px-3 py-2 text-sm text-amber-50 outline-none focus:border-red-400/60"
          >
        </div>

        <!-- 消耗预览 -->
        <div class="text-xs text-stone-500 mb-3 text-center">
          消耗 <span class="text-red-300 font-bold">{{ redPacketPreview.toLocaleString() }}</span> 灵石
        </div>

        <!-- 发送按钮 -->
        <button
          @click="confirmSendRedPacket"
          :disabled="redPacketModal.sending"
          class="w-full py-2 rounded bg-gradient-to-r from-red-700 to-amber-700 text-amber-50 font-bold text-sm hover:from-red-600 hover:to-amber-600 transition-all disabled:opacity-50 active:scale-[0.98]"
        >
          {{ redPacketModal.sending ? '发送中...' : '发送红包' }}
        </button>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- 红包详情弹窗 -->
    <!-- ============================================================ -->
    <div
      v-if="redPacketDetail.visible"
      class="fixed inset-0 z-[60] flex items-center justify-center"
    >
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="closeRedPacketDetail"></div>
      <div class="relative bg-[#1c130d] border border-red-500/40 rounded-lg p-5 w-80 mx-4 shadow-2xl shadow-red-900/20 animate-fade-in-up max-h-[80vh] flex flex-col">
        <!-- 标题 -->
        <div class="flex items-center justify-between mb-3 shrink-0">
          <h3 class="text-base font-bold text-red-300">红包详情</h3>
          <button @click="closeRedPacketDetail" class="text-stone-500 hover:text-white transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <!-- 加载中 -->
        <div v-if="redPacketDetail.loading" class="text-center text-stone-500 py-10">
          正在查阅红包...
        </div>

        <!-- 红包详情内容 -->
        <div v-else-if="redPacketDetail.data" class="flex-1 overflow-y-auto">
          <!-- 红包概览 -->
          <div class="bg-gradient-to-r from-red-900/50 to-amber-900/50 rounded-lg p-3 mb-3 border border-red-500/30">
            <div class="flex items-center gap-2 mb-2">
              <div class="w-10 h-10 rounded-full bg-red-500/30 border border-red-400/50 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-300">
                  <rect x="2" y="5" width="20" height="14" rx="2"/>
                  <path d="M2 10h20"/>
                  <path d="M12 5v14"/>
                </svg>
              </div>
              <div class="flex-1">
                <div class="text-sm font-bold text-amber-200">{{ redPacketDetail.data.sender.nickname }}</div>
                <div class="text-[10px] text-amber-400/70">
                  {{ redPacketTypeLabel(redPacketDetail.data.packet_type) }} ·
                  {{ redPacketStatusLabel(redPacketDetail.data.status) }}
                </div>
              </div>
            </div>
            <div v-if="redPacketDetail.data.message" class="text-xs text-amber-300/80 italic mb-1">
              "{{ redPacketDetail.data.message }}"
            </div>
            <div class="text-2xl font-bold text-amber-300 text-center py-1">
              {{ redPacketDetail.data.total_amount.toLocaleString() }}
              <span class="text-xs text-amber-500/60">灵石 / {{ redPacketDetail.data.total_count }}个</span>
            </div>
            <!-- 我的领取信息 -->
            <div v-if="redPacketDetail.data.my_claim" class="text-center text-xs text-emerald-300 mt-1">
              你已领取 {{ redPacketDetail.data.my_claim.amount.toLocaleString() }} 灵石
              <span v-if="redPacketDetail.data.my_claim.is_lucky_king" class="text-amber-300 font-bold ml-1">👑 手气最佳</span>
            </div>
          </div>

          <!-- 领取按钮（未领取且红包可领取状态） -->
          <button
            v-if="!redPacketDetail.data.my_claim && redPacketDetail.data.status === 'active' && redPacketDetail.data.remain_count > 0"
            @click="handleClaimRedPacket"
            :disabled="redPacketDetail.claiming"
            class="w-full py-2 mb-3 rounded bg-gradient-to-r from-red-700 to-amber-700 text-amber-50 font-bold text-sm hover:from-red-600 hover:to-amber-600 transition-all disabled:opacity-50 active:scale-[0.98] shrink-0"
          >
            {{ redPacketDetail.claiming ? '领取中...' : '🧧 领取红包' }}
          </button>

          <!-- 已领完/过期提示 -->
          <div
            v-if="redPacketDetail.data.status !== 'active' || (redPacketDetail.data.remain_count === 0 && !redPacketDetail.data.my_claim)"
            class="text-center text-xs text-stone-500 mb-3"
          >
            {{ redPacketStatusLabel(redPacketDetail.data.status) }}
          </div>

          <!-- 领取记录列表 -->
          <div v-if="redPacketDetail.data.claims && redPacketDetail.data.claims.length > 0">
            <div class="text-xs text-stone-400 mb-2 flex items-center justify-between">
              <span>领取记录</span>
              <span class="text-stone-500">{{ redPacketDetail.data.claims.length }}/{{ redPacketDetail.data.total_count }}</span>
            </div>
            <div class="space-y-1.5">
              <div
                v-for="(claim, idx) in redPacketDetail.data.claims"
                :key="idx"
                class="flex items-center justify-between bg-[#292524] rounded px-2.5 py-1.5 border border-stone-700"
              >
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-xs text-stone-300 truncate">{{ claim.receiver.nickname }}</span>
                  <span v-if="claim.is_lucky_king" class="text-[10px] text-amber-400">👑</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="text-xs text-amber-300 font-bold">{{ claim.amount.toLocaleString() }}</span>
                  <span class="text-[10px] text-stone-500">{{ new Date(claim.claimed_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 无领取记录 -->
          <div v-else-if="redPacketDetail.data.status === 'active'" class="text-center text-xs text-stone-500 py-2">
            暂无人领取，快抢头彩！
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- 物品选择弹窗（从背包选择要展示的物品） -->
    <!-- ============================================================ -->
    <div
      v-if="itemSelectModal.visible"
      class="fixed inset-0 z-[60] flex items-center justify-center"
    >
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="closeItemSelectModal"></div>
      <div class="relative bg-[#1c130d] border border-amber-500/40 rounded-lg p-5 w-80 mx-4 shadow-2xl shadow-amber-900/20 animate-fade-in-up max-h-[80vh] flex flex-col">
        <!-- 标题 -->
        <div class="flex items-center justify-between mb-3 shrink-0">
          <h3 class="text-base font-bold text-amber-300 flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <path d="M3.27 6.96 12 12.01l8.73-5.05"/>
              <path d="M12 22.08V12"/>
            </svg>
            展示物品
          </h3>
          <button @click="closeItemSelectModal" class="text-stone-500 hover:text-white transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <!-- 加载中 -->
        <div v-if="itemSelectModal.loading" class="text-center text-stone-500 py-10">
          正在查阅储物袋...
        </div>

        <!-- 物品列表 -->
        <div v-else class="flex-1 overflow-y-auto custom-scrollbar">
          <!-- 空背包 -->
          <div v-if="itemSelectModal.items.length === 0" class="text-center text-stone-500 py-8 text-sm">
            储物袋空空如也
          </div>

          <!-- 物品网格（2列布局） -->
          <div v-else class="grid grid-cols-2 gap-2">
            <button
              v-for="item in itemSelectModal.items"
              :key="item.record_id"
              @click="confirmShowItem(item)"
              :disabled="itemSelectModal.sending"
              class="text-left rounded p-2 border transition-all hover:shadow-lg active:scale-[0.98] disabled:opacity-50"
              :class="getQualityStyle(item.quality).border"
            >
              <!-- 物品名称 -->
              <div class="text-xs font-bold truncate mb-0.5" :class="getQualityStyle(item.quality).text">
                {{ item.name }}
              </div>
              <!-- 品质+类型 -->
              <div class="text-[10px] text-stone-400 flex items-center gap-1 mb-0.5">
                <span :class="getQualityStyle(item.quality).text">{{ getQualityStyle(item.quality).label }}</span>
                <span>· {{ getItemTypeLabel(item.type) }}</span>
              </div>
              <!-- 数量 -->
              <div class="text-[10px] text-amber-500/70">
                ×{{ item.quantity }}
              </div>
            </button>
          </div>
        </div>

        <!-- 底部提示 -->
        <div class="mt-3 text-center text-[10px] text-stone-500 shrink-0">
          选择物品展示到聊天频道
        </div>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- 物品详情弹窗（点击聊天中的物品卡片查看） -->
    <!-- ============================================================ -->
    <div
      v-if="itemDetailModal.visible && itemDetailModal.data"
      class="fixed inset-0 z-[60] flex items-center justify-center"
    >
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="closeItemDetail"></div>
      <div class="relative bg-[#1c130d] border rounded-lg p-5 w-72 mx-4 shadow-2xl animate-fade-in-up" :class="getQualityStyle(itemDetailModal.data.quality).border">
        <!-- 关闭按钮 -->
        <button @click="closeItemDetail" class="absolute top-3 right-3 text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>

        <!-- 物品图标 -->
        <div class="flex justify-center mb-3">
          <div
            class="w-14 h-14 rounded-lg flex items-center justify-center border-2"
            :class="getQualityStyle(itemDetailModal.data.quality).border"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="getQualityStyle(itemDetailModal.data.quality).text">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <path d="M3.27 6.96 12 12.01l8.73-5.05"/>
              <path d="M12 22.08V12"/>
            </svg>
          </div>
        </div>

        <!-- 物品名称 -->
        <div class="text-center text-lg font-bold mb-1" :class="getQualityStyle(itemDetailModal.data.quality).text">
          {{ itemDetailModal.data.item_name }}
        </div>

        <!-- 品质+类型徽章 -->
        <div class="flex justify-center gap-1.5 mb-3">
          <span class="text-xs px-2 py-0.5 rounded border" :class="getQualityStyle(itemDetailModal.data.quality).border + ' ' + getQualityStyle(itemDetailModal.data.quality).text">
            {{ getQualityStyle(itemDetailModal.data.quality).label }}
          </span>
          <span class="text-xs px-2 py-0.5 rounded border border-stone-700 text-stone-400">
            {{ getItemTypeLabel(itemDetailModal.data.type) }}
          </span>
        </div>

        <!-- 物品描述 -->
        <div class="bg-[#0f0b08] rounded p-2.5 border border-stone-800 mb-3">
          <div class="text-[10px] text-stone-500 mb-1">物品描述</div>
          <div class="text-xs text-stone-300 leading-relaxed">
            {{ itemDetailModal.data.description || '暂无描述' }}
          </div>
        </div>

        <!-- 物品属性 -->
        <div class="grid grid-cols-2 gap-2 mb-3">
          <div class="bg-[#0f0b08] rounded p-2 border border-stone-800 text-center">
            <div class="text-[10px] text-stone-500 mb-0.5">售价</div>
            <div class="text-xs font-bold text-amber-400">{{ itemDetailModal.data.price || 0 }} 灵石</div>
          </div>
          <div class="bg-[#0f0b08] rounded p-2 border border-stone-800 text-center">
            <div class="text-[10px] text-stone-500 mb-0.5">展示时持有</div>
            <div class="text-xs font-bold text-amber-400">×{{ itemDetailModal.data.quantity || 1 }}</div>
          </div>
        </div>

        <!-- 底部说明 -->
        <div class="text-center text-[10px] text-stone-500">
          此物品由仙友在聊天中展示
        </div>
      </div>
    </div>
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
