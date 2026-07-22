/**
 * 洞府社交面板组件
 *
 * 弹窗式组件，展示洞府社交玩法：拜访洞府、留言板、访客记录、景观布置、洞府商人。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格：洞府社交用青绿色系（emerald/teal），区分于洞府经营的棕色系
 *
 * Tab 结构：
 *   1. 留言板：查看自己洞府的留言 + 在他人洞府留言
 *   2. 访客录：查看自己洞府的访客记录 + 拜访他人洞府
 *   3. 景观：查看可布置的景观列表 + 布置景观
 *   4. 游商：查看洞府商人货品 + 购买商品
 *
 * 数据来源：
 *   - getMessages() / leaveMessage()：留言相关
 *   - getVisitors() / visitCave()：访客相关
 *   - getLandscapes() / setLandscape()：景观相关
 *   - getMerchantGoods() / buyMerchantItem()：商人相关
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-emerald-900/40 rounded-lg p-6 max-w-3xl w-full mx-4 shadow-2xl shadow-emerald-900/20 animate-fade-in max-h-[88vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-emerald-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
          洞府社交
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex gap-2 mb-4 border-b border-stone-700 pb-2">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="switchTab(tab.id)"
          :class="activeTab === tab.id
            ? 'text-emerald-400 border-b-2 border-emerald-400'
            : 'text-stone-400 hover:text-stone-200 border-b-2 border-transparent'"
          class="px-3 py-1 text-sm font-medium transition-colors"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- ===== Tab 1: 留言板 ===== -->
        <div v-if="activeTab === 'messages'">
          <!-- 在他人洞府留言 -->
          <div class="bg-[#292524] border border-stone-700 rounded-lg p-3 mb-3">
            <h3 class="text-sm font-bold text-emerald-300 mb-2">📝 留言给道友</h3>
            <div class="flex gap-2 mb-2">
              <input
                v-model.number="messageForm.target_player_id"
                type="number"
                placeholder="目标玩家 ID"
                class="flex-1 bg-[#1c1917] border border-stone-700 rounded px-2 py-1 text-stone-200 text-sm focus:border-emerald-600/50 focus:outline-none"
              />
            </div>
            <textarea
              v-model="messageForm.content"
              rows="2"
              maxlength="200"
              placeholder="留言内容（最多 200 字）..."
              class="w-full bg-[#1c1917] border border-stone-700 rounded px-2 py-1 text-stone-200 text-sm focus:border-emerald-600/50 focus:outline-none resize-none mb-2"
            ></textarea>
            <button
              @click="handleLeaveMessage"
              :disabled="actionLoading || !messageForm.target_player_id || !messageForm.content"
              class="px-3 py-1 text-sm bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-30"
            >
              {{ actionLoading ? '发送中...' : '发送留言' }}
            </button>
          </div>

          <!-- 我的留言板 -->
          <div>
            <h3 class="text-sm font-bold text-emerald-300 mb-2">📬 我的洞府留言</h3>
            <div v-if="messagesLoading" class="text-center text-stone-500 py-6">加载中...</div>
            <div v-else-if="messages.length === 0" class="text-center text-stone-500 py-6">
              <p>暂无留言</p>
            </div>
            <div v-else class="space-y-2">
              <div
                v-for="msg in messages"
                :key="msg.id"
                class="bg-[#292524] border border-stone-700 rounded-lg p-3"
              >
                <div class="flex items-center justify-between mb-1">
                  <span class="text-sm font-bold text-emerald-300">{{ msg.sender_nickname }}</span>
                  <span class="text-xs text-stone-500">{{ formatTime(msg.created_at) }}</span>
                </div>
                <p class="text-sm text-stone-300">{{ msg.content }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 2: 访客录 ===== -->
        <div v-else-if="activeTab === 'visitors'">
          <!-- 拜访他人洞府 -->
          <div class="bg-[#292524] border border-stone-700 rounded-lg p-3 mb-3">
            <h3 class="text-sm font-bold text-emerald-300 mb-2">🚶 拜访道友洞府</h3>
            <div class="flex gap-2">
              <input
                v-model.number="visitForm.target_player_id"
                type="number"
                placeholder="目标玩家 ID"
                class="flex-1 bg-[#1c1917] border border-stone-700 rounded px-2 py-1 text-stone-200 text-sm focus:border-emerald-600/50 focus:outline-none"
              />
              <button
                @click="handleVisit"
                :disabled="actionLoading || !visitForm.target_player_id"
                class="px-3 py-1 text-sm bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-30"
              >
                {{ actionLoading ? '拜访中...' : '前往拜访' }}
              </button>
            </div>
          </div>

          <!-- 我的访客记录 -->
          <div>
            <h3 class="text-sm font-bold text-emerald-300 mb-2">📖 访客录</h3>
            <div v-if="visitorsLoading" class="text-center text-stone-500 py-6">加载中...</div>
            <div v-else-if="visitors.length === 0" class="text-center text-stone-500 py-6">
              <p>暂无访客记录</p>
            </div>
            <div v-else class="space-y-2">
              <div
                v-for="visitor in visitors"
                :key="visitor.id"
                class="bg-[#292524] border border-stone-700 rounded-lg p-3 flex items-center justify-between"
              >
                <div>
                  <span class="text-sm font-bold text-stone-200">{{ visitor.visitor_nickname }}</span>
                  <span v-if="visitor.visitor_realm" class="text-xs text-stone-400 ml-2">{{ visitor.visitor_realm }}</span>
                </div>
                <span class="text-xs text-stone-500">{{ formatTime(visitor.visited_at) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 3: 景观 ===== -->
        <div v-else-if="activeTab === 'landscape'">
          <div v-if="landscapeLoading" class="text-center text-stone-500 py-6">加载中...</div>
          <div v-else-if="landscapes.length === 0" class="text-center text-stone-500 py-6">
            <p>暂无可布置的景观</p>
          </div>
          <div v-else class="space-y-2">
            <div class="bg-emerald-950/20 border border-emerald-800/40 rounded-lg p-2 mb-2 text-xs text-emerald-300/80">
              当前景观：<span class="font-bold">{{ currentLandscapeName || '未布置' }}</span>
            </div>
            <div
              v-for="ls in landscapes"
              :key="ls.id"
              class="bg-[#292524] border rounded-lg p-3 transition-colors"
              :class="ls.is_current ? 'border-emerald-600/50' : 'border-stone-700 hover:border-emerald-800/50'"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-sm font-bold text-stone-200">{{ ls.name }}</span>
                    <span v-if="ls.is_current" class="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-700/50">当前</span>
                    <span v-if="!ls.can_setup" class="text-xs px-1.5 py-0.5 rounded bg-stone-800 text-stone-500 border border-stone-700">境界不足</span>
                  </div>
                  <p class="text-xs text-stone-400 mb-1">{{ ls.description }}</p>
                  <div class="flex gap-3 text-xs">
                    <span class="text-amber-400">消耗：{{ ls.cost.toLocaleString() }} 灵石</span>
                    <span class="text-emerald-400">加成：{{ formatBonus(ls.bonus) }}</span>
                  </div>
                </div>
                <button
                  v-if="!ls.is_current && ls.can_setup"
                  @click="handleSetLandscape(ls)"
                  :disabled="actionLoading"
                  class="px-3 py-1 text-xs bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-50 shrink-0"
                >
                  布置
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 4: 游商 ===== -->
        <div v-else-if="activeTab === 'merchant'">
          <div v-if="merchantLoading" class="text-center text-stone-500 py-6">加载中...</div>
          <template v-else-if="merchantGoods.length > 0">
            <!-- 刷新时间 -->
            <div class="bg-emerald-950/20 border border-emerald-800/40 rounded-lg p-2 mb-3 text-xs text-emerald-300/80">
              下次刷新：{{ formatTime(merchantRefreshAt) }}
            </div>
            <!-- 商品列表 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div
                v-for="good in merchantGoods"
                :key="good.index"
                class="bg-[#292524] border border-stone-700 rounded-lg p-3"
              >
                <div class="flex items-center justify-between mb-1">
                  <span class="text-sm font-bold text-stone-200">{{ good.item_name }}</span>
                  <span v-if="good.discount_rate < 1" class="text-xs text-emerald-400">折扣 {{ (good.discount_rate * 10).toFixed(1) }}折</span>
                  <span v-else-if="good.discount_rate > 1" class="text-xs text-rose-400">溢价 +{{ Math.round((good.discount_rate - 1) * 100) }}%</span>
                </div>
                <div class="flex items-center justify-between">
                  <div>
                    <span class="text-amber-400 font-bold">{{ good.price.toLocaleString() }}</span>
                    <span class="text-xs text-stone-500 ml-1">灵石</span>
                    <span v-if="good.base_price !== good.price" class="text-xs text-stone-500 line-through ml-1">{{ good.base_price }}</span>
                    <span v-if="good.remaining < 5" class="text-xs text-rose-400 ml-2">仅剩 {{ good.remaining }}</span>
                  </div>
                  <button
                    v-if="good.remaining > 0"
                    @click="handleBuy(good)"
                    :disabled="actionLoading"
                    class="px-2 py-1 text-xs bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-50"
                  >
                    购买
                  </button>
                  <span v-else class="text-xs text-stone-500">已售罄</span>
                </div>
              </div>
            </div>
          </template>
          <div v-else class="text-center text-stone-500 py-6">
            <p>游商暂时没有货品，请稍后再来</p>
          </div>
        </div>
      </div>

      <!-- 购买确认弹窗 -->
      <Modal :isOpen="buyConfirmShow" title="购买商品" @close="buyConfirmShow = false">
        <div class="space-y-2 text-sm text-stone-300">
          <p>确认购买此商品？</p>
          <div v-if="pendingBuy" class="bg-[#292524] border border-stone-700 rounded p-3 mt-2">
            <div>商品：<span class="text-emerald-300 font-bold">{{ pendingBuy.item_name }}</span></div>
            <div>价格：<span class="text-amber-400 font-bold">{{ pendingBuy.price.toLocaleString() }}</span> 灵石</div>
          </div>
        </div>
        <template #footer>
          <button @click="buyConfirmShow = false" class="px-4 py-2 text-sm border border-stone-700 text-stone-300 rounded hover:bg-stone-800 transition-colors">取消</button>
          <button @click="confirmBuy" class="px-4 py-2 text-sm bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/60 transition-colors">确认购买</button>
        </template>
      </Modal>

      <!-- 布置景观确认弹窗 -->
      <Modal :isOpen="landscapeConfirmShow" title="布置景观" @close="landscapeConfirmShow = false">
        <div class="space-y-2 text-sm text-stone-300">
          <p>确认布置此景观？将消耗灵石并替换当前景观。</p>
          <div v-if="pendingLandscape" class="bg-[#292524] border border-stone-700 rounded p-3 mt-2">
            <div>景观：<span class="text-emerald-300 font-bold">{{ pendingLandscape.name }}</span></div>
            <div>消耗：<span class="text-amber-400 font-bold">{{ pendingLandscape.cost.toLocaleString() }}</span> 灵石</div>
            <div class="text-xs text-stone-400 mt-1">加成：{{ formatBonus(pendingLandscape.bonus) }}</div>
          </div>
        </div>
        <template #footer>
          <button @click="landscapeConfirmShow = false" class="px-4 py-2 text-sm border border-stone-700 text-stone-300 rounded hover:bg-stone-800 transition-colors">取消</button>
          <button @click="confirmSetLandscape" class="px-4 py-2 text-sm bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/60 transition-colors">确认布置</button>
        </template>
      </Modal>
    </div>
  </div>
</template>

<script setup>
/**
 * 洞府社交面板组件
 *
 * 功能模块：
 *   1. 留言板：查看自己洞府留言 + 在他人洞府留言
 *   2. 访客录：查看自己洞府访客 + 拜访他人洞府
 *   3. 景观：查看可布置景观列表 + 布置景观（含属性加成）
 *   4. 游商：查看洞府商人货品 + 购买商品
 *
 * 所有数据通过 api/caveSocial 模块调用后端，前端只做展示与接口调用。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useUIStore } from '../../stores/ui'
import Modal from '../common/Modal.vue'
import {
  getMessages,
  leaveMessage,
  getVisitors,
  visitCave,
  getLandscapes,
  setLandscape,
  getMerchantGoods,
  buyMerchantItem
} from '../../api/caveSocial'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ====== Tab 配置 ======
const tabs = [
  { id: 'messages', label: '留言板' },
  { id: 'visitors', label: '访客录' },
  { id: 'landscape', label: '景观' },
  { id: 'merchant', label: '游商' }
]
const activeTab = ref('messages')

// ====== 留言板 ======
const messagesLoading = ref(false)
const messages = ref([])
const messageForm = ref({
  target_player_id: null,
  content: ''
})

// ====== 访客录 ======
const visitorsLoading = ref(false)
const visitors = ref([])
const visitForm = ref({
  target_player_id: null
})

// ====== 景观 ======
const landscapeLoading = ref(false)
const landscapes = ref([])
const currentLandscapeId = ref(null)

// ====== 游商 ======
const merchantLoading = ref(false)
const merchantGoods = ref([])
const merchantRefreshAt = ref('')

// ====== 操作状态 ======
const actionLoading = ref(false)

// ====== 确认弹窗 ======
const buyConfirmShow = ref(false)
const pendingBuy = ref(null)
const landscapeConfirmShow = ref(false)
const pendingLandscape = ref(null)

// ====== 计算属性 ======
const currentLandscapeName = computed(() => {
  const ls = landscapes.value.find(l => l.id === currentLandscapeId.value)
  return ls?.name || null
})

// ====== 工具函数 ======
/**
 * 格式化时间
 */
function formatTime(timeStr) {
  if (!timeStr) return '-'
  const d = new Date(timeStr)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 格式化景观加成（将 bonus 对象转为可读字符串）
 * 如 { meditation_exp_bonus: 0.05, spirit_vein_bonus: 0.1 } -> "悟道经验+5%, 灵脉产出+10%"
 */
function formatBonus(bonus) {
  if (!bonus || typeof bonus !== 'object') return '无'
  const bonusMap = {
    meditation_exp_bonus: '悟道经验',
    spirit_vein_bonus: '灵脉产出',
    breakthrough_bonus: '突破概率'
  }
  const parts = []
  for (const [key, value] of Object.entries(bonus)) {
    if (typeof value === 'number' && value > 0) {
      const name = bonusMap[key] || key
      parts.push(`${name}+${(value * 100).toFixed(0)}%`)
    }
  }
  return parts.length > 0 ? parts.join(', ') : '无'
}

// ====== 数据加载 ======
/**
 * 加载留言列表
 */
async function loadMessages() {
  messagesLoading.value = true
  try {
    const res = await getMessages(50)
    messages.value = res.data.messages || []
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '加载留言失败', 'error')
  } finally {
    messagesLoading.value = false
  }
}

/**
 * 加载访客记录
 */
async function loadVisitors() {
  visitorsLoading.value = true
  try {
    const res = await getVisitors(50)
    visitors.value = res.data.visitors || []
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '加载访客记录失败', 'error')
  } finally {
    visitorsLoading.value = false
  }
}

/**
 * 加载景观列表
 */
async function loadLandscapes() {
  landscapeLoading.value = true
  try {
    const res = await getLandscapes()
    landscapes.value = res.data.landscapes || []
    currentLandscapeId.value = res.data.current_landscape_id || null
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '加载景观列表失败', 'error')
  } finally {
    landscapeLoading.value = false
  }
}

/**
 * 加载游商货品
 */
async function loadMerchantGoods() {
  merchantLoading.value = true
  try {
    const res = await getMerchantGoods()
    merchantGoods.value = res.data.items || []
    merchantRefreshAt.value = res.data.next_refresh_at || ''
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '加载游商货品失败', 'error')
  } finally {
    merchantLoading.value = false
  }
}

// ====== Tab 切换 ======
/**
 * 切换 Tab 时自动加载对应数据
 */
function switchTab(tabId) {
  activeTab.value = tabId
  if (tabId === 'messages' && messages.value.length === 0) {
    loadMessages()
  } else if (tabId === 'visitors' && visitors.value.length === 0) {
    loadVisitors()
  } else if (tabId === 'landscape' && landscapes.value.length === 0) {
    loadLandscapes()
  } else if (tabId === 'merchant' && merchantGoods.value.length === 0) {
    loadMerchantGoods()
  }
}

// ====== 操作处理 ======
/**
 * 发送留言
 */
async function handleLeaveMessage() {
  const { target_player_id, content } = messageForm.value
  if (!target_player_id || !content) {
    uiStore.showToast('请填写目标 ID 和留言内容', 'error')
    return
  }
  actionLoading.value = true
  try {
    const res = await leaveMessage(target_player_id, content)
    uiStore.showToast(res.data.message || '留言发送成功', 'success')
    // 清空表单
    messageForm.value = { target_player_id: null, content: '' }
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '留言失败', 'error')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 拜访他人洞府
 */
async function handleVisit() {
  const { target_player_id } = visitForm.value
  if (!target_player_id) {
    uiStore.showToast('请填写目标玩家 ID', 'error')
    return
  }
  actionLoading.value = true
  try {
    const res = await visitCave(target_player_id)
    uiStore.showToast(res.data.message || `已拜访 ${res.data.target_nickname} 的洞府`, 'success')
    // 清空表单
    visitForm.value = { target_player_id: null }
    // 刷新访客记录（自己作为访客去别人那里，但自己的访客录不变，这里不刷新）
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '拜访失败', 'error')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 点击布置景观（弹出确认）
 */
function handleSetLandscape(ls) {
  pendingLandscape.value = ls
  landscapeConfirmShow.value = true
}

/**
 * 确认布置景观
 */
async function confirmSetLandscape() {
  if (!pendingLandscape.value) return
  actionLoading.value = true
  try {
    const res = await setLandscape(pendingLandscape.value.id)
    uiStore.showToast(res.data.message || '景观布置成功', 'success')
    landscapeConfirmShow.value = false
    pendingLandscape.value = null
    // 刷新景观列表
    await loadLandscapes()
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '布置景观失败', 'error')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 点击购买商品（弹出确认）
 */
function handleBuy(good) {
  pendingBuy.value = good
  buyConfirmShow.value = true
}

/**
 * 确认购买商品
 */
async function confirmBuy() {
  if (!pendingBuy.value) return
  actionLoading.value = true
  try {
    const res = await buyMerchantItem(pendingBuy.value.index, 1)
    uiStore.showToast(res.data.message || `购买成功，获得 ${res.data.item_name}`, 'success')
    buyConfirmShow.value = false
    pendingBuy.value = null
    // 刷新游商货品（库存可能已变）
    await loadMerchantGoods()
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '购买失败', 'error')
  } finally {
    actionLoading.value = false
  }
}

// ====== 初始化 ======
onMounted(() => {
  loadMessages()
})
</script>
