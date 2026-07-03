<template>
  <div class="space-y-4">
    <div class="flex flex-wrap justify-between items-center gap-4 mb-4">
      <h3 class="text-lg font-bold text-white">玩家列表</h3>
      <div class="flex gap-2">
        <input
          v-model="search"
          @keyup.enter="handleSearch"
          placeholder="搜索账号/昵称"
          class="px-3 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm"
        >
        <select v-model="filter" @change="handleSearch" class="px-3 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm">
          <option value="">全部状态</option>
          <option value="active">正常玩家</option>
          <option value="banned">已封禁</option>
          <option value="dead">已死亡</option>
        </select>
        <button @click="handleSearch" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">搜索</button>
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm text-gray-300">
        <thead class="bg-gray-800 text-gray-400 uppercase">
          <tr>
            <th @click="handleSort('id')" class="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white select-none group">
              ID <span v-if="sortBy === 'id'" class="text-xiuxian-gold">{{ sortOrder === 'ASC' ? '↑' : '↓' }}</span>
              <span v-else class="text-gray-600 opacity-0 group-hover:opacity-100">↕</span>
            </th>
            <th @click="handleSort('username')" class="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white select-none group">
              账号 <span v-if="sortBy === 'username'" class="text-xiuxian-gold">{{ sortOrder === 'ASC' ? '↑' : '↓' }}</span>
              <span v-else class="text-gray-600 opacity-0 group-hover:opacity-100">↕</span>
            </th>
            <th @click="handleSort('nickname')" class="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white select-none group">
              昵称 <span v-if="sortBy === 'nickname'" class="text-xiuxian-gold">{{ sortOrder === 'ASC' ? '↑' : '↓' }}</span>
              <span v-else class="text-gray-600 opacity-0 group-hover:opacity-100">↕</span>
            </th>
            <th @click="handleSort('realm')" class="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white select-none group">
              境界 <span v-if="sortBy === 'realm'" class="text-xiuxian-gold">{{ sortOrder === 'ASC' ? '↑' : '↓' }}</span>
              <span v-else class="text-gray-600 opacity-0 group-hover:opacity-100">↕</span>
            </th>
            <th @click="handleSort('lifespan_current')" class="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white select-none group">
              寿元 <span v-if="sortBy === 'lifespan_current'" class="text-xiuxian-gold">{{ sortOrder === 'ASC' ? '↑' : '↓' }}</span>
              <span v-else class="text-gray-600 opacity-0 group-hover:opacity-100">↕</span>
            </th>
            <th class="px-4 py-3 whitespace-nowrap">状态</th>
            <th @click="handleSort('createdAt')" class="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white select-none group">
              注册时间 <span v-if="sortBy === 'createdAt'" class="text-xiuxian-gold">{{ sortOrder === 'ASC' ? '↑' : '↓' }}</span>
              <span v-else class="text-gray-600 opacity-0 group-hover:opacity-100">↕</span>
            </th>
            <th @click="handleSort('last_online')" class="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white select-none group">
              最后在线 <span v-if="sortBy === 'last_online'" class="text-xiuxian-gold">{{ sortOrder === 'ASC' ? '↑' : '↓' }}</span>
              <span v-else class="text-gray-600 opacity-0 group-hover:opacity-100">↕</span>
            </th>
            <th @click="handleSort('total_online_time')" class="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white select-none group">
              在线时长 <span v-if="sortBy === 'total_online_time'" class="text-xiuxian-gold">{{ sortOrder === 'ASC' ? '↑' : '↓' }}</span>
              <span v-else class="text-gray-600 opacity-0 group-hover:opacity-100">↕</span>
            </th>
            <th class="px-4 py-3 whitespace-nowrap">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700">
          <tr v-for="p in players" :key="p.id" class="hover:bg-gray-800/50">
            <td class="px-4 py-3 whitespace-nowrap" :class="{'text-green-400': isOnline(p)}">{{ p.id }}</td>
            <td class="px-4 py-3 whitespace-nowrap">{{ p.username }}</td>
            <td class="px-4 py-3 whitespace-nowrap">{{ p.nickname }}</td>
            <td class="px-4 py-3 whitespace-nowrap">{{ p.realm }}</td>
            <td class="px-4 py-3 whitespace-nowrap">
              <span :class="getLifespanClass(p)">{{ p.lifespan_current }}/{{ p.lifespan_max }}</span>
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              <span v-if="p.role === 'admin'" class="text-red-400">管理员</span>
              <span v-else-if="p.role === 'banned'" class="text-orange-400">已封禁</span>
              <span v-else-if="p.is_dead" class="text-gray-500">已死亡</span>
              <span v-else class="text-green-400">正常</span>
            </td>
            <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ formatDate(p.createdAt) }}</td>
            <td class="px-4 py-3 whitespace-nowrap" :class="isOnline(p) ? 'text-green-400' : 'text-gray-500'">{{ formatDate(p.last_online) }}</td>
            <td class="px-4 py-3 whitespace-nowrap" :class="isOnline(p) ? 'text-green-400' : 'text-gray-500'">{{ formatDuration(p.total_online_time) }}</td>
            <td class="px-4 py-3 whitespace-nowrap">
              <div class="flex gap-1 flex-wrap">
                <button @click="$emit('editPlayer', p)" class="text-blue-400 hover:text-blue-300 text-xs px-1">编辑</button>
                <button v-if="p.role !== 'admin' && p.role !== 'banned'" @click="$emit('banPlayer', p)" class="text-orange-400 hover:text-orange-300 text-xs px-1">封禁</button>
                <button v-if="p.role === 'banned'" @click="$emit('unbanPlayer', p)" class="text-green-400 hover:text-green-300 text-xs px-1">解封</button>
                <button v-if="p.role !== 'admin'" @click="$emit('givePlayer', p)" class="text-purple-400 hover:text-purple-300 text-xs px-1">发放</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div class="flex justify-center items-center gap-4 mt-4">
      <button
        :disabled="pagination.currentPage === 1"
        @click="fetchPlayers(pagination.currentPage - 1)"
        class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
      >上一页</button>
      <span class="text-gray-400">第 {{ pagination.currentPage }} / {{ pagination.totalPages }} 页 (共{{ pagination.total }}条)</span>
      <button
        :disabled="pagination.currentPage === pagination.totalPages"
        @click="fetchPlayers(pagination.currentPage + 1)"
        class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
      >下一页</button>
    </div>
  </div>
</template>

<script setup>
/**
 * 玩家管理子组件
 * 负责玩家列表展示、搜索、排序、分页
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import { getPlayers } from '../../../api/admin'

const emit = defineEmits(['editPlayer', 'banPlayer', 'unbanPlayer', 'givePlayer'])
const uiStore = useUIStore()

// 搜索和筛选
const search = ref('')
const filter = ref('')
const sortBy = ref('last_online')
const sortOrder = ref('DESC')

// 玩家数据
const players = ref([])
const pagination = reactive({
  currentPage: 1,
  totalPages: 1,
  total: 0
})

/**
 * 获取玩家列表
 */
const fetchPlayers = async (page = 1) => {
  try {
    const params = { page, limit: 10 }
    if (search.value) params.search = search.value
    if (filter.value) params.status = filter.value
    params.sortBy = sortBy.value
    params.sortOrder = sortOrder.value

    const res = await getPlayers(params)
    players.value = res.data.players
    pagination.currentPage = res.data.currentPage
    pagination.totalPages = res.data.totalPages
    pagination.total = res.data.total
  } catch (error) {
    console.error('Fetch players error:', error)
    uiStore.showToast('获取玩家列表失败', 'error')
  }
}

/**
 * 处理搜索
 */
const handleSearch = () => {
  fetchPlayers(1)
}

/**
 * 处理排序
 */
const handleSort = (field) => {
  if (sortBy.value === field) {
    sortOrder.value = sortOrder.value === 'ASC' ? 'DESC' : 'ASC'
  } else {
    sortBy.value = field
    sortOrder.value = 'DESC'
  }
  fetchPlayers(1)
}

/**
 * 获取寿元样式类
 */
const getLifespanClass = (player) => {
  if (!player || !player.lifespan_max) return 'text-gray-500'
  const ratio = player.lifespan_current / player.lifespan_max
  if (ratio <= 0.2) return 'text-red-400 font-bold'
  if (ratio <= 0.5) return 'text-orange-400'
  return 'text-green-400'
}

/**
 * 判断玩家是否在线
 * 直接读取后端权威返回的 is_online 字段（基于 WebSocket 连接表）
 * 避免前端用"5 分钟阈值"猜测在线状态导致误判
 */
const isOnline = (player) => {
  return !!(player && player.is_online)
}

/**
 * 格式化日期
 */
const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * 格式化时长
 */
const formatDuration = (ms) => {
  if (!ms) return '0秒'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}天${hours % 24}小时`
  if (hours > 0) return `${hours}小时${minutes % 60}分`
  if (minutes > 0) return `${minutes}分${seconds % 60}秒`
  return `${seconds}秒`
}

// 暴露刷新方法给父组件
defineExpose({
  fetchPlayers,
  pagination
})

onMounted(() => {
  fetchPlayers()
})
</script>
