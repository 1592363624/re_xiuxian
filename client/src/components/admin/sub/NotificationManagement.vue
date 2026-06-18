<template>
  <div class="space-y-6">
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white">通知管理</h3>
      <button @click="fetchNotifications(1)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新列表</button>
    </div>

    <!-- 发送公告 -->
    <div class="bg-gray-800 p-4 rounded border border-gray-700">
      <h4 class="text-md font-bold text-xiuxian-gold mb-4">发送全服公告</h4>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-sm text-gray-400 mb-1">公告标题</label>
          <input v-model="announcement.title" class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white" placeholder="输入公告标题">
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">优先级</label>
          <select v-model="announcement.priority" class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
            <option value="low">低</option>
            <option value="normal">普通</option>
            <option value="high">高</option>
            <option value="critical">紧急</option>
          </select>
        </div>
        <div class="md:col-span-2">
          <label class="block text-sm text-gray-400 mb-1">公告内容</label>
          <textarea v-model="announcement.content" rows="3" class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white" placeholder="输入公告内容"></textarea>
        </div>
      </div>
      <div class="mt-4 flex justify-end">
        <button @click="handleSendAnnouncement" :disabled="!announcement.title || !announcement.content" class="px-4 py-2 bg-red-600 hover:bg-red-500 rounded text-white text-sm disabled:opacity-50">
          发送公告
        </button>
      </div>
    </div>

    <!-- 通知列表 -->
    <div class="bg-gray-800 p-4 rounded border border-gray-700">
      <h4 class="text-md font-bold text-white mb-4">通知列表</h4>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm text-gray-300">
          <thead class="bg-gray-800 text-gray-400 uppercase">
            <tr>
              <th class="px-4 py-3 whitespace-nowrap">ID</th>
              <th class="px-4 py-3 whitespace-nowrap">类型</th>
              <th class="px-4 py-3 whitespace-nowrap">标题</th>
              <th class="px-4 py-3 whitespace-nowrap">内容</th>
              <th class="px-4 py-3 whitespace-nowrap">优先级</th>
              <th class="px-4 py-3 whitespace-nowrap">创建时间</th>
              <th class="px-4 py-3 whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-700">
            <tr v-for="n in adminNotifications" :key="n.id" class="hover:bg-gray-800/50">
              <td class="px-4 py-3 whitespace-nowrap">{{ n.id }}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <span class="px-2 py-0.5 rounded text-xs" :class="getNotificationTypeClass(n.type)">{{ getNotificationTypeName(n.type) }}</span>
              </td>
              <td class="px-4 py-3 whitespace-nowrap">{{ n.title }}</td>
              <td class="px-4 py-3 whitespace-nowrap text-gray-400 max-w-xs truncate">{{ n.content }}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <span class="px-2 py-0.5 rounded text-xs" :class="getPriorityClass(n.priority)">{{ n.priority }}</span>
              </td>
              <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ formatDateTime(n.createdAt) }}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <button @click="handleDeleteNotification(n.id)" class="text-red-400 hover:text-red-300 text-xs px-1">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!adminNotifications.length" class="text-center py-8 text-gray-500">暂无通知</div>
      <div class="flex justify-center items-center gap-4 mt-4">
        <button
          :disabled="notificationPagination.currentPage === 1"
          @click="fetchNotifications(notificationPagination.currentPage - 1)"
          class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
        >上一页</button>
        <span class="text-gray-400">第 {{ notificationPagination.currentPage }} / {{ notificationPagination.totalPages }} 页</span>
        <button
          :disabled="notificationPagination.currentPage === notificationPagination.totalPages"
          @click="fetchNotifications(notificationPagination.currentPage + 1)"
          class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
        >下一页</button>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 通知管理子组件
 * 负责发送全服公告和管理通知列表
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import { deleteNotification, sendAnnouncement, getAdminNotifications } from '../../../api/admin'

const emit = defineEmits(['showConfirm'])
const uiStore = useUIStore()

// 通知管理
const announcement = reactive({
  title: '',
  content: '',
  priority: 'high'
})
const adminNotifications = ref([])
const notificationPagination = reactive({
  currentPage: 1,
  totalPages: 1,
  total: 0
})

/**
 * 获取通知列表
 */
const fetchNotifications = async (page = 1) => {
  try {
    const res = await getAdminNotifications({ page, limit: 10, includeGlobal: 'true' })
    adminNotifications.value = res.data.notifications || res.data.data?.notifications || []
    notificationPagination.currentPage = res.data.page || res.data.data?.page || 1
    notificationPagination.totalPages = res.data.totalPages || res.data.data?.totalPages || 1
    notificationPagination.total = res.data.total || res.data.data?.total || 0
  } catch (error) {
    console.error('获取通知列表失败:', error)
    uiStore.showToast('获取通知列表失败', 'error')
  }
}

/**
 * 发送全服公告
 */
const handleSendAnnouncement = async () => {
  try {
    await sendAnnouncement(announcement.title, announcement.content, announcement.priority)
    uiStore.showToast('公告已发送', 'success')
    announcement.title = ''
    announcement.content = ''
    fetchNotifications(1)
  } catch (error) {
    uiStore.showToast('发送失败: ' + (error.response?.data?.message || error.message), 'error')
  }
}

/**
 * 删除通知
 */
const handleDeleteNotification = (id) => {
  emit('showConfirm', '删除通知', '确定要删除此通知吗？', async () => {
    try {
      await deleteNotification(id)
      uiStore.showToast('删除成功', 'success')
      fetchNotifications(notificationPagination.currentPage)
    } catch (error) {
      uiStore.showToast('删除失败: ' + (error.response?.data?.message || error.message), 'error')
    }
  })
}

/**
 * 获取通知类型名称
 */
const getNotificationTypeName = (type) => {
  const typeMap = {
    breakthrough: '突破',
    death: '死亡',
    achievement: '成就',
    event: '事件',
    announcement: '公告',
    warning: '警告',
    milestone: '里程碑'
  }
  return typeMap[type] || type
}

/**
 * 获取通知类型样式类
 */
const getNotificationTypeClass = (type) => {
  const classMap = {
    breakthrough: 'bg-yellow-900 text-yellow-200',
    death: 'bg-gray-700 text-gray-300',
    achievement: 'bg-orange-900 text-orange-200',
    event: 'bg-purple-900 text-purple-200',
    announcement: 'bg-red-900 text-red-200',
    warning: 'bg-orange-900 text-orange-200',
    milestone: 'bg-green-900 text-green-200'
  }
  return classMap[type] || 'bg-gray-700 text-gray-300'
}

/**
 * 获取优先级样式类
 */
const getPriorityClass = (priority) => {
  const classMap = {
    low: 'bg-gray-700 text-gray-400',
    normal: 'bg-blue-900 text-blue-200',
    high: 'bg-orange-900 text-orange-200',
    critical: 'bg-red-900 text-red-200'
  }
  return classMap[priority] || 'bg-gray-700 text-gray-400'
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
  fetchNotifications
})

onMounted(() => {
  fetchNotifications()
})
</script>
