<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
    <div class="bg-gray-900 border border-gray-700 w-full max-w-4xl h-[80vh] flex flex-col rounded-lg shadow-2xl">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800">
        <h2 class="text-xl font-bold text-xiuxian-gold">GM 管理后台</h2>
        <button @click="$emit('close')" class="text-gray-400 hover:text-white">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-700 bg-gray-800/50">
        <button 
          v-for="tab in tabs" 
          :key="tab.id"
          @click="currentTab = tab.id"
          class="px-6 py-3 text-sm font-medium transition-colors relative"
          :class="currentTab === tab.id ? 'text-xiuxian-gold' : 'text-gray-400 hover:text-gray-200'"
        >
          {{ tab.name }}
          <div v-if="currentTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-xiuxian-gold"></div>
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto p-4">
        <!-- 玩家管理 -->
        <div v-if="currentTab === 'players'" class="space-y-4">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-lg font-bold text-white">玩家列表</h3>
            <button @click="fetchPlayers(1)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
          </div>
          
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm text-gray-300">
              <thead class="bg-gray-800 text-gray-400 uppercase">
                <tr>
                  <th class="px-4 py-3">ID</th>
                  <th class="px-4 py-3">账号</th>
                  <th class="px-4 py-3">昵称</th>
                  <th class="px-4 py-3">境界</th>
                  <th class="px-4 py-3">角色</th>
                  <th class="px-4 py-3">注册时间</th>
                  <th class="px-4 py-3">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-700">
                <tr v-for="p in players" :key="p.id" class="hover:bg-gray-800/50">
                  <td class="px-4 py-3">{{ p.id }}</td>
                  <td class="px-4 py-3">{{ p.username }}</td>
                  <td class="px-4 py-3">{{ p.nickname }}</td>
                  <td class="px-4 py-3">{{ p.realm }}</td>
                  <td class="px-4 py-3">
                    <span :class="p.role === 'admin' ? 'text-red-400' : 'text-gray-400'">{{ p.role }}</span>
                  </td>
                  <td class="px-4 py-3">{{ new Date(p.createdAt).toLocaleString() }}</td>
                  <td class="px-4 py-3">
                    <button @click="editPlayer(p)" class="text-blue-400 hover:text-blue-300 mr-2">编辑</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 分页 -->
          <div class="flex justify-center space-x-2 mt-4">
            <button 
              :disabled="pagination.currentPage === 1"
              @click="fetchPlayers(pagination.currentPage - 1)"
              class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50"
            >上一页</button>
            <span class="px-3 py-1 text-gray-400">第 {{ pagination.currentPage }} / {{ pagination.totalPages }} 页</span>
            <button 
              :disabled="pagination.currentPage === pagination.totalPages"
              @click="fetchPlayers(pagination.currentPage + 1)"
              class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50"
            >下一页</button>
          </div>
        </div>

        <!-- 系统配置 -->
        <div v-if="currentTab === 'config'" class="space-y-6">
          <div class="flex justify-between items-center">
             <h3 class="text-lg font-bold text-white">系统参数配置</h3>
             <button @click="fetchConfig" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <!-- 自动存档间隔 -->
            <div class="bg-gray-800 p-4 rounded border border-gray-700">
              <label class="block text-sm font-medium text-gray-400 mb-2">自动存档间隔 (毫秒)</label>
              <div class="flex space-x-2">
                <input 
                  v-model="configs.auto_save_interval" 
                  type="number" 
                  class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                >
                <button @click="saveConfig('auto_save_interval', configs.auto_save_interval, '自动存档间隔(ms)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
              </div>
              <p class="mt-1 text-xs text-gray-500">默认: 10000 (10秒)</p>
            </div>

            <!-- 闭关冷却时间 -->
            <div class="bg-gray-800 p-4 rounded border border-gray-700">
              <label class="block text-sm font-medium text-gray-400 mb-2">闭关冷却时间 (秒)</label>
              <div class="flex space-x-2">
                <input 
                  v-model="configs.seclusion_cooldown" 
                  type="number" 
                  class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                >
                <button @click="saveConfig('seclusion_cooldown', configs.seclusion_cooldown, '闭关冷却时间(秒)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
              </div>
              <p class="mt-1 text-xs text-gray-500">默认: 3600 (60分钟)</p>
            </div>

            <!-- 闭关经验倍率 -->
            <div class="bg-gray-800 p-4 rounded border border-gray-700">
              <label class="block text-sm font-medium text-gray-400 mb-2">闭关基础收益 (修为/秒)</label>
              <div class="flex space-x-2">
                <input 
                  v-model="configs.seclusion_exp_rate" 
                  type="number" 
                  step="0.01"
                  class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                >
                <button @click="saveConfig('seclusion_exp_rate', configs.seclusion_exp_rate, '闭关经验倍率(修为/秒)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
              </div>
              <p class="mt-1 text-xs text-gray-500">默认: 0.1 (每10秒1点修为)</p>
            </div>
            
            <!-- 时间控制 (GM) -->
            <div class="bg-gray-800 p-4 rounded border border-gray-700 md:col-span-2 mt-4">
              <label class="block text-sm font-medium text-amber-500 mb-2 font-bold">⏳ 时光飞逝 (时间加速)</label>
              <div class="flex items-center gap-4">
                <div class="flex items-center gap-2 flex-1">
                  <span class="text-gray-400 text-sm">加速年份:</span>
                  <input 
                    v-model="timeTravelYears" 
                    type="number" 
                    min="0.1"
                    step="0.1"
                    class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                    placeholder="输入年份，如 1 或 0.5"
                  >
                </div>
                <button 
                  @click="confirmTimeTravel" 
                  :disabled="isTimeTraveling"
                  class="px-6 py-2 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg v-if="isTimeTraveling" class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                  {{ isTimeTraveling ? '加速中...' : '执行加速' }}
                </button>
              </div>
              <p class="mt-2 text-xs text-gray-500">警告：此操作会增加全服所有玩家的寿命，可能导致寿元耗尽的玩家死亡！(24小时=1年)</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑玩家弹窗 -->
    <div v-if="editingPlayer" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div class="bg-gray-800 border border-gray-600 p-6 rounded-lg w-96 shadow-xl">
        <h3 class="text-lg font-bold text-white mb-4">编辑玩家: {{ editingPlayer.nickname }}</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm text-gray-400">修为 (Exp)</label>
            <input v-model="editingPlayer.exp" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400">灵石</label>
            <input v-model="editingPlayer.spirit_stones" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400">境界</label>
            <input v-model="editingPlayer.realm" type="text" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
             <label class="block text-sm text-gray-400">角色权限</label>
             <select v-model="editingPlayer.role" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
               <option value="user">普通用户</option>
               <option value="admin">管理员</option>
             </select>
          </div>
        </div>
        <div class="flex justify-end space-x-2 mt-6">
          <button @click="editingPlayer = null" class="px-3 py-1 bg-gray-600 rounded text-white">取消</button>
          <button @click="submitPlayerEdit" class="px-3 py-1 bg-blue-600 rounded text-white">保存</button>
        </div>
      </div>
    </div>

    <!-- Confirm Modal -->
    <Modal :isOpen="showTimeTravelConfirm" title="确认时间加速" @close="showTimeTravelConfirm = false">
      <div class="space-y-4">
        <p class="text-gray-300">
          确定要让时间加速 <span class="text-red-400 font-bold text-lg">{{ timeTravelYears }}</span> 年吗？
        </p>
        <div class="bg-red-900/30 border border-red-800 rounded p-3">
          <p class="text-red-400 text-sm">
            ⚠️ 警告：这会导致所有在线/离线玩家消耗寿元。寿元耗尽者将会死亡并掉落境界！
          </p>
        </div>
      </div>
      <template #footer>
        <button @click="showTimeTravelConfirm = false" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="triggerTimeTravel" class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded">确认执行</button>
      </template>
    </Modal>

    <!-- Death Modal -->
    <Modal :isOpen="showDeathModal" title="⚠️ 噩耗" :showClose="true" @close="showDeathModal = false">
      <div class="space-y-6 text-center py-4">
        <div class="text-6xl">🪦</div>
        <h3 class="text-2xl font-bold text-red-500">寿元已尽</h3>
        <p class="text-gray-300 text-lg">{{ deathMessage }}</p>
        <p class="text-gray-400">你的境界已跌落，请重新来过。</p>
      </div>
      <template #footer>
        <button @click="showDeathModal = false" class="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">
          黯然接受
        </button>
      </template>
    </Modal>

  </div>
</template>

<script setup>
import { ref, onMounted, reactive } from 'vue'
import axios from 'axios'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import Modal from '../common/Modal.vue'

const emit = defineEmits(['close'])
const playerStore = usePlayerStore()
const uiStore = useUIStore()

const tabs = [
  { id: 'players', name: '玩家数据' },
  { id: 'config', name: '系统配置' },
  // { id: 'events', name: '事件管理' }
]
const currentTab = ref('players')

// 玩家数据
const players = ref([])
const pagination = reactive({
  currentPage: 1,
  totalPages: 1,
  total: 0
})

// 系统配置
const configs = reactive({
  auto_save_interval: 10000,
  seclusion_cooldown: 3600,
  seclusion_exp_rate: 0.1
})

const editingPlayer = ref(null)

// 时间加速
const timeTravelYears = ref(1)
const isTimeTraveling = ref(false)
const showTimeTravelConfirm = ref(false)
const showDeathModal = ref(false)
const deathMessage = ref('')

const confirmTimeTravel = () => {
  if (!timeTravelYears.value || timeTravelYears.value <= 0) {
    uiStore.showToast('请输入有效的年数', 'warning')
    return
  }
  showTimeTravelConfirm.value = true
}

// 获取玩家列表
const fetchPlayers = async (page = 1) => {
  try {
    const res = await axios.get('/api/admin/players', {
      params: { page, limit: 10 }
    })
    players.value = res.data.players
    pagination.currentPage = res.data.currentPage
    pagination.totalPages = res.data.totalPages
    pagination.total = res.data.total
  } catch (error) {
    console.error('Fetch players error:', error)
    alert('获取玩家列表失败')
  }
}

// 获取配置
const fetchConfig = async () => {
  try {
    const res = await axios.get('/api/admin/config')
    res.data.forEach(item => {
      if (item.key === 'auto_save_interval') configs.auto_save_interval = parseInt(item.value)
      if (item.key === 'seclusion_cooldown') configs.seclusion_cooldown = parseInt(item.value)
      if (item.key === 'seclusion_exp_rate') configs.seclusion_exp_rate = parseFloat(item.value)
    })
  } catch (error) {
    console.error('Fetch config error:', error)
  }
}

// 保存配置
const saveConfig = async (key, value, desc) => {
  try {
    await axios.post('/api/admin/config', {
      key,
      value: value.toString(),
      description: desc
    })
    alert('配置保存成功')
  } catch (error) {
    alert('配置保存失败')
  }
}

// 编辑玩家
const editPlayer = (player) => {
  // 深拷贝防止直接修改显示
  editingPlayer.value = JSON.parse(JSON.stringify(player))
}

const submitPlayerEdit = async () => {
  if (!editingPlayer.value) return
  try {
    await axios.put(`/api/admin/players/${editingPlayer.value.id}`, editingPlayer.value)
    alert('玩家信息更新成功')
    editingPlayer.value = null
    fetchPlayers(pagination.currentPage)
  } catch (error) {
    alert('更新失败: ' + (error.response?.data?.message || error.message))
  }
}

const triggerTimeTravel = async () => {
  showTimeTravelConfirm.value = false
  isTimeTraveling.value = true
  try {
    const res = await axios.post('/api/admin/time-travel', {
      years: parseFloat(timeTravelYears.value)
    })
    
    console.log('Time travel response:', res.data)

    // 刷新玩家数据
    try {
        await playerStore.fetchPlayer()
    } catch (e) {
        console.warn('Refresh player failed:', e)
    }
    
    // 刷新管理员面板的玩家列表（如果当前在看列表）
    if (currentTab.value === 'players') {
      fetchPlayers(pagination.currentPage)
    }

    // 检查死亡通知
    if (res.data && res.data.userDied) {
       deathMessage.value = res.data.deathLog || '寿元耗尽，身死道消。'
       showDeathModal.value = true
    } else {
       const msg = res.data?.message || '操作成功'
       if (uiStore) {
           uiStore.showToast(msg, 'success')
       } else {
           alert(msg)
       }
    }

  } catch (error) {
    console.error('Time travel error object:', error)
    const errorMsg = error.response?.data?.message || '时间加速失败'
    if (uiStore) {
        uiStore.showToast(errorMsg, 'error')
    } else {
        alert(errorMsg)
    }
  } finally {
    isTimeTraveling.value = false
  }
}

onMounted(() => {
  fetchPlayers()
  fetchConfig()
})
</script>
