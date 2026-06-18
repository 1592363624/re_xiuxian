<template>
  <div class="space-y-4">
    <div class="flex flex-wrap justify-between items-center gap-4 mb-4">
      <h3 class="text-lg font-bold text-white">操作日志</h3>
      <div class="flex gap-2">
        <select v-model="filter" @change="fetchLogs(1)" class="px-3 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm">
          <option value="">全部操作</option>
          <option value="time_travel">时间加速</option>
          <option value="ban_player">封禁玩家</option>
          <option value="unban_player">解封玩家</option>
          <option value="modify_player">修改玩家</option>
          <option value="give_item">发放物品</option>
          <option value="give_spirit_stones">发放灵石</option>
          <option value="add_exp">增加修为</option>
          <option value="reset_player">重置玩家</option>
          <option value="force_breakthrough">强制突破</option>
          <option value="delete_player">删除玩家</option>
          <option value="update_config">修改配置</option>
        </select>
        <button @click="fetchLogs(1)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm text-gray-300">
        <thead class="bg-gray-800 text-gray-400 uppercase">
          <tr>
            <th class="px-4 py-3 whitespace-nowrap">时间</th>
            <th class="px-4 py-3 whitespace-nowrap">管理员ID</th>
            <th class="px-4 py-3 whitespace-nowrap">操作类型</th>
            <th class="px-4 py-3 whitespace-nowrap">操作详情</th>
            <th class="px-4 py-3 whitespace-nowrap">IP地址</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700">
          <tr v-for="log in logs" :key="log.id" class="hover:bg-gray-800/50">
            <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ formatDateTime(log.createdAt) }}</td>
            <td class="px-4 py-3 whitespace-nowrap">{{ log.admin_id }}</td>
            <td class="px-4 py-3 whitespace-nowrap">
              <span class="px-2 py-0.5 rounded text-xs" :class="getActionClass(log.action)">{{ getActionName(log.action) }}</span>
            </td>
            <td class="px-4 py-3 whitespace-nowrap text-gray-400 max-w-xs truncate">{{ log.details }}</td>
            <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ log.ip || '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="flex justify-center items-center gap-4 mt-4">
      <button
        :disabled="pagination.currentPage === 1"
        @click="fetchLogs(pagination.currentPage - 1)"
        class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
      >上一页</button>
      <span class="text-gray-400">第 {{ pagination.currentPage }} / {{ pagination.totalPages }} 页</span>
      <button
        :disabled="pagination.currentPage === pagination.totalPages"
        @click="fetchLogs(pagination.currentPage + 1)"
        class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
      >下一页</button>
    </div>
  </div>
</template>

<script setup>
/**
 * 操作日志子组件
 * 负责展示管理员操作日志
 */
import { ref, reactive, onMounted } from 'vue'
import { getLogs } from '../../../api/admin'

// 日志数据
const logs = ref([])
const filter = ref('')
const pagination = reactive({
  currentPage: 1,
  totalPages: 1,
  total: 0
})

/**
 * 获取日志列表
 */
const fetchLogs = async (page = 1) => {
  try {
    const params = { page, limit: 10 }
    if (filter.value) params.action = filter.value

    const res = await getLogs(params)
    const data = res.data.data || {}
    logs.value = data.logs || []
    pagination.currentPage = data.currentPage || 1
    pagination.totalPages = data.totalPages || 1
    pagination.total = data.total || 0
  } catch (error) {
    console.error('Fetch logs error:', error)
  }
}

/**
 * 获取操作类型名称
 */
const getActionName = (action) => {
  const map = {
    time_travel: '时间加速',
    ban_player: '封禁玩家',
    unban_player: '解封玩家',
    modify_player: '修改玩家',
    give_item: '发放物品',
    give_spirit_stones: '发放灵石',
    add_exp: '增加修为',
    reset_player: '重置玩家',
    force_breakthrough: '强制突破',
    delete_player: '删除玩家',
    update_config: '修改配置',
    delete_notification: '删除通知'
  }
  return map[action] || action
}

/**
 * 获取操作类型样式类
 */
const getActionClass = (action) => {
  if (action === 'time_travel') return 'action-type-time-travel'
  if (action === 'ban_player' || action === 'delete_player' || action === 'delete_notification') return 'action-type-ban'
  if (action === 'unban_player') return 'action-type-unban'
  if (action === 'modify_player' || action === 'force_breakthrough' || action === 'reset_player') return 'action-type-modify'
  if (action && (action.startsWith('give_') || action === 'add_exp')) return 'action-type-give'
  if (action === 'update_config') return 'action-type-config'
  return 'bg-gray-700 text-gray-300'
}

/**
 * 格式化日期时间
 */
const formatDateTime = (dateStr) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

// 暴露刷新方法给父组件
defineExpose({
  fetchLogs
})

onMounted(() => {
  fetchLogs()
})
</script>

<style scoped>
.action-type-time-travel {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  color: white;
}

.action-type-ban {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: white;
}

.action-type-unban {
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  color: white;
}

.action-type-modify {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
}

.action-type-give {
  background: linear-gradient(135deg, #a855f7 0%, #9333ea 100%);
  color: white;
}

.action-type-config {
  background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
  color: white;
}
</style>
