<template>
  <div class="space-y-6">
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-fg-primary">通知管理</h3>
      <AppButton variant="primary" size="sm" @click="fetchNotifications(1)">刷新列表</AppButton>
    </div>

    <!-- 发送公告：整块支持 Ctrl+V 粘贴剪贴板截图（见 handlePaste 的文档级监听） -->
    <div class="bg-surface-base/50 p-4 rounded-panel border border-line">
      <div class="flex items-center justify-between mb-4">
        <h4 class="text-md font-bold text-gold-500">发送全服公告</h4>
        <span class="text-xs text-fg-faint">
          可直接 Ctrl+V 粘贴截图，最多 {{ imageConfig.maxCount }} 张
        </span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-sm text-fg-muted mb-1">公告标题</label>
          <input v-model="announcement.title" class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600" placeholder="输入公告标题">
        </div>
        <div>
          <label class="block text-sm text-fg-muted mb-1">优先级</label>
          <select v-model="announcement.priority" class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600">
            <option value="low">低</option>
            <option value="normal">普通</option>
            <option value="high">高</option>
            <option value="critical">紧急</option>
          </select>
        </div>
        <div class="md:col-span-2">
          <label class="block text-sm text-fg-muted mb-1">公告内容</label>
          <textarea v-model="announcement.content" rows="3" class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600" placeholder="输入公告内容（纯图片公告可留空）"></textarea>
        </div>

        <!-- 配图区：与编辑弹窗共用同一个上传器组件（见 AnnouncementImageUploader） -->
        <AnnouncementImageUploader ref="uploaderRef" v-model="announcement.imageUrls" />
      </div>
      <div class="mt-4 flex justify-end">
        <AppButton variant="primary" :disabled="!canSend" @click="handleSendAnnouncement">
          {{ isUploading ? '图片上传中…' : '发送公告' }}
        </AppButton>
      </div>
    </div>

    <!-- 通知列表 -->
    <div class="bg-surface-base/50 p-4 rounded-panel border border-line">
      <div class="flex items-center justify-between mb-4">
        <h4 class="text-md font-bold text-fg-primary">通知列表</h4>
        <div class="flex items-center gap-3">
          <span v-if="selectedIds.length" class="text-xs text-fg-muted num">已选 {{ selectedIds.length }} 条</span>
          <AppButton
            variant="danger"
            size="sm"
            :disabled="selectedIds.length === 0"
            @click="handleBatchDelete"
          >批量删除</AppButton>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm text-fg-secondary">
          <thead class="bg-surface-raised text-fg-muted uppercase">
            <tr>
              <th class="px-4 py-3 w-10">
                <!-- 全选仅作用于当前页，跨页选择对 GM 来说无从确认 -->
                <input
                  type="checkbox"
                  class="cursor-pointer"
                  :checked="allSelected"
                  :disabled="adminNotifications.length === 0"
                  title="全选本页"
                  @change="toggleSelectAll"
                >
              </th>
              <th class="px-4 py-3 whitespace-nowrap">ID</th>
              <th class="px-4 py-3 whitespace-nowrap">类型</th>
              <th class="px-4 py-3 whitespace-nowrap">标题</th>
              <th class="px-4 py-3 whitespace-nowrap">内容</th>
              <th class="px-4 py-3 whitespace-nowrap">配图</th>
              <th class="px-4 py-3 whitespace-nowrap">优先级</th>
              <th class="px-4 py-3 whitespace-nowrap">创建时间</th>
              <th class="px-4 py-3 whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-line-subtle">
            <tr v-for="n in adminNotifications" :key="n.id" class="hover:bg-surface-hover">
              <td class="px-4 py-3">
                <input type="checkbox" class="cursor-pointer" :value="n.id" v-model="selectedIds">
              </td>
              <td class="px-4 py-3 whitespace-nowrap num">{{ n.id }}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <span class="px-2 py-0.5 rounded text-xs" :class="getNotificationTypeClass(n.type)">{{ getNotificationTypeName(n.type) }}</span>
              </td>
              <td class="px-4 py-3 whitespace-nowrap">
                {{ n.title }}
                <!-- 撤回状态：isActive=false 的通知玩家侧已经是隐藏的，GM 必须一眼看出来 -->
                <span v-if="n.isActive === false" class="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-surface-active text-fg-muted">已撤回</span>
              </td>
              <td class="px-4 py-3 whitespace-nowrap text-fg-muted max-w-xs truncate">{{ n.content }}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <!-- 配图缩略图：点击原图查看，便于 GM 确认图是否传对 -->
                <div v-if="getImageUrls(n).length" class="flex items-center gap-1">
                  <img
                    v-for="(url, index) in getImageUrls(n)"
                    :key="url"
                    :src="url"
                    :alt="`配图 ${index + 1}`"
                    class="w-8 h-8 object-cover rounded border border-line cursor-zoom-in"
                    @click="previewImage(url)"
                  >
                </div>
                <span v-else class="text-fg-faint">-</span>
              </td>
              <td class="px-4 py-3 whitespace-nowrap">
                <span class="px-2 py-0.5 rounded text-xs" :class="getPriorityClass(n.priority)">{{ n.priority }}</span>
              </td>
              <td class="px-4 py-3 whitespace-nowrap text-fg-faint num">{{ formatDateTime(n.createdAt) }}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <div class="flex items-center gap-1">
                  <button @click="openEditModal(n)" class="text-gold-500 hover:text-gold-400 text-xs px-1">编辑</button>
                  <button
                    v-if="n.isActive === false"
                    @click="handlePublish(n)"
                    class="text-emerald-400 hover:text-emerald-300 text-xs px-1"
                  >恢复</button>
                  <button
                    v-else
                    @click="handleUnpublish(n)"
                    class="text-amber-400 hover:text-amber-300 text-xs px-1"
                  >撤回</button>
                  <button @click="handleDeleteNotification(n.id)" class="text-red-400 hover:text-red-300 text-xs px-1">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!adminNotifications.length" class="text-center py-8 text-fg-faint">暂无通知</div>
      <div class="flex justify-center items-center gap-4 mt-4">
        <AppButton
          variant="default"
          size="sm"
          :disabled="notificationPagination.currentPage === 1"
          @click="fetchNotifications(notificationPagination.currentPage - 1)"
        >上一页</AppButton>
        <span class="text-fg-muted num">第 {{ notificationPagination.currentPage }} / {{ notificationPagination.totalPages }} 页</span>
        <AppButton
          variant="default"
          size="sm"
          :disabled="notificationPagination.currentPage === notificationPagination.totalPages"
          @click="fetchNotifications(notificationPagination.currentPage + 1)"
        >下一页</AppButton>
      </div>
    </div>

    <!-- 公告配图参数：上传体积/张数上限与孤儿图回收策略，改动即时热加载 -->
    <AnnouncementConfig />

    <!-- 编辑通知弹窗：配图按"最终列表"提交，保留原地址即复用已上传的图片 -->
    <Modal :isOpen="!!editing" title="编辑通知" width="720px" @close="editing = null">
      <div v-if="editing" class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm text-fg-muted mb-1">标题</label>
            <input v-model="editing.title" class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-sm text-fg-muted mb-1">优先级</label>
            <select v-model="editing.priority" class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600">
              <option value="low">低</option>
              <option value="normal">普通</option>
              <option value="high">高</option>
              <option value="critical">紧急</option>
            </select>
          </div>
          <div class="md:col-span-2">
            <label class="block text-sm text-fg-muted mb-1">内容</label>
            <textarea v-model="editing.content" rows="3" class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-secondary focus-ring focus:border-gold-600"></textarea>
          </div>
          <!-- 与发送表单同一个上传器：粘贴/点击都能加图，移除只是把地址从数组里去掉 -->
          <AnnouncementImageUploader v-model="editing.imageUrls" label="配图（保留原图即不重新上传）" />
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="editing = null">取消</AppButton>
        <AppButton variant="primary" :loading="saving" :disabled="!canSaveEdit" @click="submitEdit">保存</AppButton>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * 通知管理子组件
 * 负责发送全服公告（支持粘贴/选择配图）和管理通知列表（支持单条与批量删除）
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { formatBeijing } from '../../../utils/time'
import { useUIStore } from '../../../stores/ui'
import {
  deleteNotification,
  batchDeleteNotifications,
  sendAnnouncement,
  updateNotification,
  unpublishNotification,
  publishNotification,
  getAdminNotifications
} from '../../../api/admin'
import { ANNOUNCEMENT_IMAGE_CONFIG } from '../../../config'
import AppButton from '../../ui/AppButton.vue'
import Modal from '../../common/Modal.vue'
import AnnouncementConfig from './AnnouncementConfig.vue'
import AnnouncementImageUploader from './AnnouncementImageUploader.vue'

const emit = defineEmits(['showConfirm'])
const uiStore = useUIStore()

// 配图相关阈值统一走配置，禁止在组件里写死
const imageConfig = ANNOUNCEMENT_IMAGE_CONFIG

// 发送表单里的上传器实例：拿它的"是否正在上传"来决定发送按钮能不能点
const uploaderRef = ref(null)

// 通知管理
const announcement = reactive({
  title: '',
  content: '',
  priority: 'high',
  imageUrls: []
})
const adminNotifications = ref([])
const notificationPagination = reactive({
  currentPage: 1,
  totalPages: 1,
  total: 0
})

// 批量删除：勾选集合（仅当前页，跨页勾选无法给 GM 明确反馈）
const selectedIds = ref([])
const allSelected = computed(() =>
  adminNotifications.value.length > 0 && selectedIds.value.length === adminNotifications.value.length
)

// 上传中状态由上传器组件自己维护，父组件只读取（避免两份状态各自漂移）
const isUploading = computed(() => !!uploaderRef.value?.isUploading)

// 标题必填；内容与配图满足其一即可（纯图公告也允许）；图片上传完之前不允许发送
const canSend = computed(() =>
  !!announcement.title.trim()
  && (!!announcement.content.trim() || announcement.imageUrls.length > 0)
  && !isUploading.value
)

// 编辑弹窗：{ id, title, content, priority, imageUrls }
const editing = ref(null)
const saving = ref(false)
const canSaveEdit = computed(() =>
  !!editing.value?.title?.trim()
  && (!!editing.value?.content?.trim() || (editing.value?.imageUrls?.length ?? 0) > 0)
)

/**
 * 从通知记录里取配图地址
 * metadata 在库里是 JSON 字符串（TEXT），直接 toJSON 也可能带出来，两种形状都要兼容
 * @param {Object} notification
 * @returns {string[]}
 */
const getImageUrls = (notification) => {
  let metadata = notification?.metadata
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata)
    } catch {
      return []
    }
  }
  return Array.isArray(metadata?.imageUrls) ? metadata.imageUrls : []
}

/**
 * 新窗口打开原图（公告弹窗里图片是缩略展示，GM 需要能看清细节）
 */
const previewImage = (url) => {
  window.open(url, '_blank', 'noopener')
}

/**
 * 获取通知列表
 */
const fetchNotifications = async (page = 1) => {
  try {
    // includeInactive：撤回后的公告仍要列出来，否则"恢复"没有入口
    const res = await getAdminNotifications({ page, limit: 10, includeGlobal: 'true', includeInactive: 'true' })
    adminNotifications.value = res.data.notifications || res.data.data?.notifications || []
    notificationPagination.currentPage = res.data.page || res.data.data?.page || 1
    notificationPagination.totalPages = res.data.totalPages || res.data.data?.totalPages || 1
    notificationPagination.total = res.data.total || res.data.data?.total || 0

    // 刷新后丢弃已不存在的勾选项，否则"批量删除"会把已删过的 ID 再提交一遍
    const existingIds = new Set(adminNotifications.value.map(n => String(n.id)))
    selectedIds.value = selectedIds.value.filter(id => existingIds.has(String(id)))
  } catch (error) {
    console.error('获取通知列表失败:', error)
    uiStore.showApiError(error, '获取通知列表失败')
  }
}

/**
 * 打开编辑弹窗
 * 配图直接回填现有地址：上传器会拿它们当预览，不动这些地址就等于复用原图
 * @param {Object} notification - 列表里的通知
 */
const openEditModal = (notification) => {
  editing.value = {
    id: notification.id,
    title: notification.title || '',
    content: notification.content || '',
    priority: notification.priority || 'normal',
    imageUrls: [...getImageUrls(notification)]
  }
}

/**
 * 提交编辑
 */
const submitEdit = async () => {
  if (!editing.value || !canSaveEdit.value) return

  saving.value = true
  try {
    await updateNotification(editing.value.id, {
      title: editing.value.title.trim(),
      content: editing.value.content,
      priority: editing.value.priority,
      // 传最终列表：保留的地址即复用，删掉的地址由孤儿图回收任务按保留窗口处理
      imageUrls: [...editing.value.imageUrls]
    })
    uiStore.showToast('通知已更新', 'success')
    editing.value = null
    fetchNotifications(notificationPagination.currentPage)
  } catch (error) {
    uiStore.showApiError(error, '更新失败')
  } finally {
    saving.value = false
  }
}

/**
 * 撤回通知（下架，保留记录与配图）
 */
const handleUnpublish = (notification) => {
  emit('showConfirm', '撤回通知', `确定要撤回「${notification.title}」吗？撤回后玩家侧不再显示，可随时恢复。`, async () => {
    try {
      await unpublishNotification(notification.id)
      uiStore.showToast('通知已撤回', 'success')
      fetchNotifications(notificationPagination.currentPage)
    } catch (error) {
      uiStore.showApiError(error, '撤回失败')
    }
  })
}

/**
 * 恢复已撤回的通知
 */
const handlePublish = (notification) => {
  try {
    publishNotification(notification.id).then(() => {
      uiStore.showToast('通知已重新发布', 'success')
      fetchNotifications(notificationPagination.currentPage)
    }).catch(error => uiStore.showApiError(error, '发布失败'))
  } catch (error) {
    uiStore.showApiError(error, '发布失败')
  }
}

/**
 * 发送全服公告
 */
const handleSendAnnouncement = async () => {
  try {
    await sendAnnouncement(
      announcement.title,
      announcement.content,
      announcement.priority,
      [...announcement.imageUrls]
    )
    uiStore.showToast('公告已发送', 'success')
    announcement.title = ''
    announcement.content = ''
    announcement.imageUrls = []
    selectedIds.value = []
    fetchNotifications(1)
  } catch (error) {
    uiStore.showApiError(error, '发送失败')
  }
}

/**
 * 删除单条通知
 */
const handleDeleteNotification = (id) => {
  emit('showConfirm', '删除通知', '确定要删除此通知吗？配图文件会一并删除。', async () => {
    try {
      await deleteNotification(id)
      uiStore.showToast('删除成功', 'success')
      fetchNotifications(notificationPagination.currentPage)
    } catch (error) {
      uiStore.showApiError(error, '删除失败')
    }
  })
}

/**
 * 切换"全选本页"
 */
const toggleSelectAll = (event) => {
  selectedIds.value = event.target.checked
    ? adminNotifications.value.map(n => n.id)
    : []
}

/**
 * 批量删除选中的通知
 */
const handleBatchDelete = () => {
  const idsToDelete = [...selectedIds.value]
  if (idsToDelete.length === 0) return

  if (idsToDelete.length > imageConfig.batchDeleteMax) {
    uiStore.showToast(`单次最多删除 ${imageConfig.batchDeleteMax} 条通知`, 'warning')
    return
  }

  emit(
    'showConfirm',
    '批量删除通知',
    `确定要删除选中的 ${idsToDelete.length} 条通知吗？配图文件会一并删除，且不可恢复。`,
    async () => {
      try {
        const res = await batchDeleteNotifications(idsToDelete.map(Number))
        const deleted = res.data?.data?.deleted ?? idsToDelete.length
        uiStore.showToast(`已删除 ${deleted} 条通知`, 'success')
        selectedIds.value = []

        // 整页被删空时自动回退一页，否则 GM 会停在一个空白列表上
        const page = adminNotifications.value.length <= idsToDelete.length && notificationPagination.currentPage > 1
          ? notificationPagination.currentPage - 1
          : notificationPagination.currentPage
        fetchNotifications(page)
      } catch (error) {
        uiStore.showApiError(error, '批量删除失败')
      }
    }
  )
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
    death: 'bg-surface-active text-fg-secondary',
    achievement: 'bg-orange-900 text-orange-200',
    event: 'bg-purple-900 text-purple-200',
    announcement: 'bg-red-900 text-red-200',
    warning: 'bg-orange-900 text-orange-200',
    milestone: 'bg-green-900 text-green-200'
  }
  return classMap[type] || 'bg-surface-active text-fg-secondary'
}

/**
 * 获取优先级样式类
 */
const getPriorityClass = (priority) => {
  const classMap = {
    low: 'bg-surface-active text-fg-muted',
    normal: 'bg-blue-900 text-blue-200',
    high: 'bg-orange-900 text-orange-200',
    critical: 'bg-red-900 text-red-200'
  }
  return classMap[priority] || 'bg-surface-active text-fg-muted'
}

/**
 * 格式化日期时间
 */
const formatDateTime = (dateStr) => {
  if (!dateStr) return '-'
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(dateStr, { fallback: '-' })
}

// 暴露刷新方法给父组件
defineExpose({
  fetchNotifications
})

// 粘贴监听已随上传器组件走（AnnouncementImageUploader + imagePasteBus 仲裁），
// 这里不再单独挂 document 监听，否则同一张图会被上传两遍
onMounted(() => {
  fetchNotifications()
})
</script>
