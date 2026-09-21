<template>
  <!--
    公告消息面板（玩家侧）
    这里是全服公告的唯一"长期存档"入口：实时弹窗（SystemAlert）关掉就不再出现，
    而弹窗又有自动消失时间，带图片的公告错过一次就找不回来了 —— 本面板按时间倒序列出全部，
    包括当时附带的配图。
  -->
  <PanelShell title="公告消息" :hint="`共 ${total} 条`" size="lg" @close="$emit('close')">
    <template #header-actions>
      <AppButton
        v-if="hasUnread"
        size="xs"
        variant="default"
        :loading="markingAll"
        @click="handleMarkAllRead"
      >全部已读</AppButton>
      <AppButton size="xs" variant="default" :loading="loading" @click="fetchList(page)">刷新</AppButton>
    </template>

    <div class="space-y-3">
      <Tabs v-model="activeTab" :items="tabs" />

      <!-- 页签栏之内的加载/空/错误状态：交给 PanelShell 会把页签一起藏掉 -->
      <LoadingBlock v-if="loading" text="正在读取公告…" />
      <EmptyState
        v-else-if="error"
        icon="⚠️"
        :text="error"
        hint="稍后再试，或联系管理员"
      />
      <EmptyState
        v-else-if="items.length === 0"
        icon="📢"
        :text="activeTab === 'announcement' ? '暂无全服公告' : '暂无消息'"
        :hint="activeTab === 'announcement' ? '管理员发布后台 announcement 会显示在这里' : '全服公告与你的个人通知会出现在这里'"
      />
      <template v-else>
        <PanelCard v-for="item in items" :key="item.id" :padded="true" :tone="cardTone(item)">
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="px-2 py-0.5 rounded text-[11px]" :class="typeClass(item.type)">{{ typeName(item.type) }}</span>
              <span class="px-2 py-0.5 rounded text-[11px]" :class="priorityClass(item.priority)">{{ priorityName(item.priority) }}</span>
              <span v-if="canMarkRead(item)" class="w-2 h-2 rounded-full bg-rose-400" title="未读"></span>
            </div>
            <span class="text-[11px] text-fg-faint num shrink-0">{{ formatTime(item.createdAt) }}</span>
          </div>

          <h4 class="mt-2 text-[13px] font-bold text-fg-primary leading-snug">{{ item.title }}</h4>
          <p v-if="item.content" class="mt-1 text-xs text-fg-secondary leading-relaxed whitespace-pre-line">{{ item.content }}</p>

          <!-- 配图：缩略自适应，点击在新窗口看原图 -->
          <div
            v-if="imageUrlsOf(item).length"
            class="mt-2 grid gap-2"
            :class="imageUrlsOf(item).length > 1 ? 'grid-cols-2' : 'grid-cols-1'"
          >
            <img
              v-for="(url, index) in imageUrlsOf(item)"
              :key="url"
              :src="url"
              :alt="`配图 ${index + 1}`"
              class="w-full max-h-56 object-contain rounded border border-line cursor-zoom-in"
              @click="openImage(url)"
            >
          </div>

          <div v-if="canMarkRead(item)" class="mt-2 flex justify-end">
            <AppButton size="xs" variant="default" @click="handleMarkRead(item)">标记已读</AppButton>
          </div>
        </PanelCard>

        <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 pt-1">
          <AppButton size="xs" variant="default" :disabled="page <= 1" @click="fetchList(page - 1)">上一页</AppButton>
          <span class="text-xs text-fg-faint num">{{ page }} / {{ totalPages }}</span>
          <AppButton size="xs" variant="default" :disabled="page >= totalPages" @click="fetchList(page + 1)">下一页</AppButton>
        </div>
      </template>
    </div>
  </PanelShell>
</template>

<script setup>
/**
 * 公告消息面板（玩家侧）
 *
 * 数据来自 GET /api/notifications，后端已把"发给本人"与"全服"两类合并好并按
 * 优先级 + 时间倒序返回（见 NotificationService.getPlayerNotifications）。
 *
 * 已读：自 2026-09-22 起按 (玩家, 通知) 回执记录（notification_reads 表），
 * 因此全服公告也能各读各的 —— 旧实现里 isRead 是行级共享的，一个人点已读全服都不再提示。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { getNotifications, markAsRead, markAllAsRead } from '../../api/notification'
import { formatBeijing } from '../../utils/time'
import { UI_CONFIG } from '../../config'
import { useUIStore } from '../../stores/ui'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import EmptyState from '../ui/EmptyState.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'

defineEmits(['close'])

const uiStore = useUIStore()

// 页签：全部 / 只看全服公告
const tabs = [
  { key: 'all', label: '全部' },
  { key: 'announcement', label: '全服公告' }
]
const activeTab = ref('all')

const loading = ref(false)
const markingAll = ref(false)
const error = ref('')
const items = ref([])
const total = ref(0)
const page = ref(1)
const totalPages = ref(1)

/** 当前页是否还有未读，用于决定"全部已读"按钮是否出现 */
const hasUnread = computed(() => items.value.some(item => !item.isRead))

/**
 * 从通知记录里取配图地址
 * metadata 在库里是 JSON 字符串，某些接口可能已经反序列化成对象，两种都要兼容
 * @param {Object} item - 通知
 * @returns {string[]}
 */
const imageUrlsOf = (item) => {
  let metadata = item?.metadata
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
 * 新窗口打开原图（面板内图被等比缩放，细节要看原图）
 */
const openImage = (url) => {
  window.open(url, '_blank', 'noopener')
}

/**
 * 是否需要"标记已读"
 * isRead 由后端按当前玩家的回执回填，全服公告也各读各的
 * @param {Object} item
 */
const canMarkRead = (item) => !item?.isRead

/**
 * 加载列表
 * @param {number} targetPage - 目标页码
 */
const fetchList = async (targetPage = 1) => {
  loading.value = true
  error.value = ''
  try {
    const res = await getNotifications({
      page: targetPage,
      limit: UI_CONFIG.defaultPageSize,
      includeGlobal: true,
      // 'all' 页签下要看到全部类型，只有切到公告页签才用 type 过滤
      type: activeTab.value === 'announcement' ? 'announcement' : undefined
    })
    const data = res.data || {}
    items.value = data.notifications || []
    total.value = data.total || 0
    page.value = data.page || targetPage
    totalPages.value = data.totalPages || 1
  } catch (err) {
    console.error('获取公告失败:', err)
    error.value = '获取公告失败'
  } finally {
    loading.value = false
  }
}

/**
 * 标记单条已读
 *
 * 就地改 item.isRead 而不是整表刷新：本面板常用于边看边点，
 * 一次刷新会把滚动位置和当前页都重置掉。
 */
const handleMarkRead = async (item) => {
  try {
    await markAsRead(item.id)
    item.isRead = true
  } catch (err) {
    console.error('标记已读失败:', err)
  }
}

/**
 * 全部已读（含全服公告：已读按玩家记回执，不影响其他玩家）
 */
const handleMarkAllRead = async () => {
  markingAll.value = true
  try {
    await markAllAsRead()
    items.value.forEach(item => { item.isRead = true })
    uiStore.showToast('已全部标记为已读', 'success')
  } catch (err) {
    uiStore.showApiError(err, '标记全部已读失败')
  } finally {
    markingAll.value = false
  }
}

// 紧凑日期：列表里不需要秒
const formatTime = (value) => formatBeijing(value, { dateStyle: 'short', seconds: false, fallback: '-' })

const TYPE_MAP = computed(() => ({
  breakthrough: '突破',
  death: '死亡',
  achievement: '成就',
  event: '事件',
  announcement: '公告',
  warning: '警告',
  milestone: '里程碑'
}))
const typeName = (type) => TYPE_MAP.value[type] || type

/** 类型配色与 GM 后台保持一致，避免同一条消息两处长得不一样 */
const typeClass = (type) => ({
  breakthrough: 'bg-yellow-900 text-yellow-200',
  death: 'bg-surface-active text-fg-secondary',
  achievement: 'bg-orange-900 text-orange-200',
  event: 'bg-purple-900 text-purple-200',
  announcement: 'bg-red-900 text-red-200',
  warning: 'bg-orange-900 text-orange-200',
  milestone: 'bg-green-900 text-green-200'
}[type] || 'bg-surface-active text-fg-secondary')

const priorityName = (priority) => ({ low: '低', normal: '普通', high: '高', critical: '紧急' }[priority] || priority)

const priorityClass = (priority) => ({
  low: 'bg-surface-active text-fg-muted',
  normal: 'bg-blue-900 text-blue-200',
  high: 'bg-orange-900 text-orange-200',
  critical: 'bg-red-900 text-red-200'
}[priority] || 'bg-surface-active text-fg-muted')

/** 未读且高优先级用金色描边提醒，其余保持朴素 */
const cardTone = (item) => {
  if (item.priority === 'critical') return 'danger'
  if (canMarkRead(item) || item.type === 'announcement') return 'gold'
  return 'plain'
}

watch(activeTab, () => fetchList(1))
onMounted(() => fetchList(1))
</script>
