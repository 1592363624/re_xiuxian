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
            
             <!-- 初始寿元 -->
             <div class="bg-gray-800 p-4 rounded border border-gray-700">
              <label class="block text-sm font-medium text-gray-400 mb-2">玩家初始最大寿元</label>
              <div class="flex space-x-2">
                <input 
                  v-model="configs.initial_lifespan" 
                  type="number" 
                  class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                >
                <button @click="saveConfig('initial_lifespan', configs.initial_lifespan, '初始寿元')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
              </div>
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

  </div>
</template>

<script setup>
import { ref, onMounted, reactive } from 'vue'
import axios from 'axios'

const emit = defineEmits(['close'])

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
  initial_lifespan: 100
})

const editingPlayer = ref(null)

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
      if (item.key === 'initial_lifespan') configs.initial_lifespan = parseInt(item.value)
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

onMounted(() => {
  fetchPlayers()
  fetchConfig()
})
</script>
