<template>
  <div class="space-y-4">
    <div class="flex flex-wrap justify-between items-center gap-4 mb-4">
      <h3 class="text-lg font-bold text-fg-primary">操作日志</h3>
      <div class="flex gap-2">
        <select v-model="filter" @change="fetchLogs(1)" class="px-3 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary text-sm focus-ring focus:border-gold-600">
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
          <option value="update_cultivation_seclusion">修炼配置-闭关</option>
          <option value="update_cultivation_adventure">修炼配置-历练</option>
        </select>
        <AppButton variant="primary" size="sm" @click="fetchLogs(1)">刷新</AppButton>
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm text-fg-secondary">
        <thead class="bg-surface-raised text-fg-muted uppercase">
          <tr>
            <th class="px-4 py-3 whitespace-nowrap">时间</th>
            <th class="px-4 py-3 whitespace-nowrap">管理员ID</th>
            <th class="px-4 py-3 whitespace-nowrap">操作类型</th>
            <th class="px-4 py-3 whitespace-nowrap">操作详情</th>
            <th class="px-4 py-3 whitespace-nowrap">IP地址</th>
            <th class="px-4 py-3 whitespace-nowrap">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line-subtle">
          <tr v-for="log in logs" :key="log.id" class="hover:bg-surface-hover">
            <td class="px-4 py-3 whitespace-nowrap text-fg-faint num">{{ formatDateTime(log.createdAt) }}</td>
            <td class="px-4 py-3 whitespace-nowrap num">{{ log.admin_id }}</td>
            <td class="px-4 py-3 whitespace-nowrap">
              <span class="px-2 py-0.5 rounded text-xs" :class="getActionClass(log.action)">{{ getActionName(log.action) }}</span>
            </td>
            <td class="px-4 py-3 text-fg-muted max-w-md truncate">{{ formatDetailsPreview(log) }}</td>
            <td class="px-4 py-3 whitespace-nowrap text-fg-faint num">{{ log.ip || '-' }}</td>
            <td class="px-4 py-3 whitespace-nowrap">
              <!-- 修炼配置变更日志提供"查看 diff"按钮 -->
              <button
                v-if="isCultivationConfigAction(log.action)"
                type="button"
                @click="openDiff(log)"
                class="focus-ring px-2 py-1 text-xs bg-cyan-700 hover:bg-cyan-600 text-fg-primary rounded-control transition-colors"
              >查看 diff</button>
              <!-- 其他日志显示原始 JSON（可展开） -->
              <AppButton
                v-else
                variant="default"
                size="xs"
                @click="toggleRaw(log.id)"
              >{{ expandedRawIds.has(log.id) ? '收起' : '详情' }}</AppButton>
            </td>
          </tr>
          <!-- 原始 JSON 展开行（非修炼配置日志） -->
          <tr v-if="expandedRawIds.has(log.id)" v-for="log in logs" :key="`raw-${log.id}`" class="bg-surface-sunken/50">
            <td colspan="6" class="px-4 py-3">
              <pre class="text-xs text-fg-muted whitespace-pre-wrap break-all font-mono wrap-cjk">{{ formatRawDetails(log.details) }}</pre>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="flex justify-center items-center gap-4 mt-4">
      <AppButton
        variant="default"
        size="sm"
        :disabled="pagination.currentPage === 1"
        @click="fetchLogs(pagination.currentPage - 1)"
      >上一页</AppButton>
      <span class="text-fg-muted num">第 {{ pagination.currentPage }} / {{ pagination.totalPages }} 页</span>
      <AppButton
        variant="default"
        size="sm"
        :disabled="pagination.currentPage === pagination.totalPages"
        @click="fetchLogs(pagination.currentPage + 1)"
      >下一页</AppButton>
    </div>

    <!-- 修炼配置变更 diff 抽屉 -->
    <div v-if="diffDrawer.visible" class="fixed inset-0 z-[70] flex justify-end">
      <div class="absolute inset-0 bg-black/70 backdrop-blur-sm" @click="closeDiff"></div>
      <div class="relative w-full max-w-3xl h-full bg-surface-raised border-l border-line-strong shadow-2xl overflow-y-auto animate-slide-in-right">
        <!-- 头部 -->
        <div class="sticky top-0 bg-surface-canvas border-b border-line-subtle px-5 py-4 flex justify-between items-center z-10">
          <div>
            <h3 class="text-base font-bold text-cyan-400">修炼配置变更详情</h3>
            <p class="text-xs text-fg-faint mt-1 num">
              {{ getActionName(diffDrawer.log?.action) }} · {{ formatDateTime(diffDrawer.log?.createdAt) }} · 管理员ID: {{ diffDrawer.log?.admin_id }}
            </p>
          </div>
          <button type="button" @click="closeDiff" class="focus-ring text-fg-faint hover:text-fg-primary transition-colors" aria-label="关闭 diff 抽屉">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <!-- 内容 -->
        <div class="p-5 space-y-4">
          <!-- 加载中骨架：后端正在计算 diff -->
          <div v-if="diffLoading" class="flex items-center justify-center py-12 text-fg-muted">
            <svg class="animate-spin h-5 w-5 mr-3 text-cyan-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span class="text-sm">正在请求后端计算 diff...</span>
          </div>

          <!-- 错误提示：后端业务错误或网络异常 -->
          <div v-else-if="diffError" class="bg-rose-950/40 border border-rose-800/60 rounded p-4 text-sm">
            <div class="text-rose-400 font-bold mb-1">获取 diff 失败</div>
            <div class="text-rose-300 text-xs break-all">{{ diffError }}</div>
            <button type="button" @click="openDiff(diffDrawer.log)" class="focus-ring mt-3 px-3 py-1 text-xs bg-rose-800 hover:bg-rose-700 text-fg-primary rounded-control transition-colors">重试</button>
          </div>

          <!-- 正常展示 diff 结果 -->
          <template v-else>
            <!-- 备份文件路径 -->
            <div v-if="diffData.backup" class="bg-emerald-950/30 border border-emerald-800/50 rounded p-3 text-xs">
              <div class="text-emerald-400 font-bold mb-1">备份文件</div>
              <div class="text-emerald-300 font-mono break-all">{{ diffData.backup }}</div>
            </div>

            <!-- 修改目标 -->
            <div v-if="diffData.target" class="text-xs text-fg-muted">
              修改目标：<span class="text-amber-400 font-mono">{{ diffData.target }}</span>
            </div>

            <!-- 字段级 diff 表格 -->
            <div v-if="diffData.fields.length > 0">
              <h4 class="text-sm font-bold text-fg-secondary mb-2">字段级变更对比（{{ diffData.fields.length }} 项）</h4>
              <div class="overflow-x-auto border border-line-strong rounded">
                <table class="w-full text-xs">
                  <thead class="bg-surface-raised text-fg-muted">
                    <tr>
                      <th class="px-3 py-2 text-left">字段</th>
                      <th class="px-3 py-2 text-left">修改前</th>
                      <th class="px-3 py-2 text-left">修改后</th>
                      <th class="px-3 py-2 text-left">变化</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-line-subtle">
                    <tr v-for="field in diffData.fields" :key="field.path" class="hover:bg-surface-hover">
                      <td class="px-3 py-2 text-fg-secondary font-mono whitespace-nowrap">{{ field.path }}</td>
                      <td class="px-3 py-2 text-rose-400 font-mono num">{{ formatValue(field.before) }}</td>
                      <td class="px-3 py-2 text-emerald-400 font-mono num">{{ formatValue(field.after) }}</td>
                      <td class="px-3 py-2">
                        <span v-if="field.changeType === 'added'" class="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-400 text-[10px]">新增</span>
                        <span v-else-if="field.changeType === 'removed'" class="px-1.5 py-0.5 rounded bg-rose-950/60 text-rose-400 text-[10px]">删除</span>
                        <span v-else-if="field.changeType === 'modified'" class="px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-400 text-[10px]">修改</span>
                        <span v-else class="px-1.5 py-0.5 rounded bg-surface-hover text-fg-faint text-[10px]">未变</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 空数据提示：后端计算完成但无变化字段 -->
            <div v-else class="text-center py-8 text-fg-faint text-sm">
              该日志无字段变化
            </div>

            <!-- 原始 JSON 折叠区 -->
            <details class="mt-4">
              <summary class="cursor-pointer text-xs text-fg-faint hover:text-fg-secondary">查看原始 JSON</summary>
              <pre class="mt-2 text-xs text-fg-faint bg-surface-sunken/50 p-3 rounded overflow-x-auto font-mono">{{ formatRawDetails(diffDrawer.log?.details) }}</pre>
            </details>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 操作日志子组件
 * 负责展示管理员操作日志，支持修炼配置变更的字段级 diff 可视化
 *
 * 重构说明（业务计算下沉后端）：
 *   - diff 算法已从前端移除，改由后端 GET /api/admin/cultivation/logs/:logId/diff 计算
 *   - 前端只负责：调用接口 + 渲染返回的 fields 数组
 *   - 防止前端伪造 diff 结果（如篡改 before/after 值）
 *   - formatDetailsPreview 中递归 countChanges 也已移除，改用简洁文案展示
 */
import { ref, reactive, onMounted } from 'vue'
import { formatBeijing } from '../../../utils/time'
import { getLogs } from '../../../api/admin'
import { getConfigDiff } from '../../../api/admin_cultivation'
import AppButton from '../../ui/AppButton.vue'

// 日志数据
const logs = ref([])
const filter = ref('')
const pagination = reactive({
  currentPage: 1,
  totalPages: 1,
  total: 0
})

// 原始 JSON 展开状态（非修炼配置日志用）
const expandedRawIds = ref(new Set())

// diff 抽屉状态
const diffDrawer = reactive({
  visible: false,
  log: null
})

// 解析后的 diff 数据（由后端权威计算后返回）
const diffData = reactive({
  target: '',
  backup: '',
  fields: []
})

// diff 加载状态：调用后端接口期间展示骨架
const diffLoading = ref(false)
// diff 调用错误信息（后端返回或网络异常）
const diffError = ref('')

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
 * 判断是否为修炼配置变更操作
 */
const isCultivationConfigAction = (action) => {
  return action === 'update_cultivation_seclusion' || action === 'update_cultivation_adventure'
}

/**
 * 打开 diff 抽屉并请求后端计算字段级 diff
 *
 * 业务计算下沉后端的核心体现：
 *   前端不再递归遍历 before/after 对象，而是请求后端 /logs/:logId/diff
 *   后端负责：查询日志、校验类型、解析 JSON、递归 diff、返回 fields 数组
 */
const openDiff = async (log) => {
  diffDrawer.log = log
  diffDrawer.visible = true
  // 重置状态
  diffData.target = ''
  diffData.backup = ''
  diffData.fields = []
  diffError.value = ''
  diffLoading.value = true

  try {
    const res = await getConfigDiff(log.id)
    const data = res.data?.data || {}
    diffData.target = data.target || ''
    diffData.backup = data.backup || ''
    diffData.fields = Array.isArray(data.fields) ? data.fields : []
  } catch (error) {
    console.error('Fetch diff error:', error)
    // 后端返回的业务错误（如日志类型不支持）或网络错误
    diffError.value = error?.response?.data?.message || error?.message || '获取 diff 失败'
  } finally {
    diffLoading.value = false
  }
}

/**
 * 关闭 diff 抽屉
 */
const closeDiff = () => {
  diffDrawer.visible = false
  diffDrawer.log = null
  diffData.target = ''
  diffData.backup = ''
  diffData.fields = []
  diffError.value = ''
  diffLoading.value = false
}

/**
 * 切换原始 JSON 展开状态
 */
const toggleRaw = (id) => {
  if (expandedRawIds.value.has(id)) {
    expandedRawIds.value.delete(id)
  } else {
    expandedRawIds.value.add(id)
  }
}

/**
 * 格式化值用于 diff 表格显示（纯展示用途，无业务计算）
 */
const formatValue = (val) => {
  if (val === undefined) return '-'
  if (val === null) return 'null'
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

/**
 * 格式化操作详情预览
 *
 * 重构说明：原实现中递归 countChanges 统计变化字段数已删除，
 * 该统计属于业务计算，应由后端 diff 接口返回。列表预览仅展示目标信息。
 */
const formatDetailsPreview = (log) => {
  if (isCultivationConfigAction(log.action)) {
    // 修炼配置变更：仅显示目标文件，字段变化数由 diff 抽屉展示
    try {
      const parsed = typeof log.details === 'string' ? JSON.parse(log.details) : log.details
      const target = parsed.target || ''
      return target ? `${target} · 点击查看 diff` : '修炼配置变更'
    } catch (e) {
      return '修炼配置变更'
    }
  }
  // 其他日志：截断显示
  const detail = typeof log.details === 'string' ? log.details : JSON.stringify(log.details)
  return detail?.length > 80 ? detail.substring(0, 80) + '...' : detail
}

/**
 * 格式化原始详情 JSON
 */
const formatRawDetails = (details) => {
  if (!details) return '-'
  try {
    const parsed = typeof details === 'string' ? JSON.parse(details) : details
    return JSON.stringify(parsed, null, 2)
  } catch (e) {
    return String(details)
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
    delete_notification: '删除通知',
    update_cultivation_seclusion: '修炼配置-闭关',
    update_cultivation_adventure: '修炼配置-历练'
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
  if (action === 'update_cultivation_seclusion' || action === 'update_cultivation_adventure') return 'action-type-cultivation'
  return 'bg-surface-active text-fg-secondary'
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
  fetchLogs
})

onMounted(() => {
  fetchLogs()
})
</script>

<style scoped>
.action-type-time-travel {
  /* 鎏金渐变与令牌等值（gold-500 = #f59e0b / gold-600 = #d97706），取令牌；
   * 下面几组语义渐变的 500/600 色阶在 tokens.css 中没有等值令牌
   * （state-* 均为 400 色阶），替换会改变既有观感，故保留字面值。 */
  background: linear-gradient(135deg, rgb(var(--gold-500)) 0%, rgb(var(--gold-600)) 100%);
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

/* 修炼配置变更专用样式：青绿渐变 */
.action-type-cultivation {
  background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
  color: white;
}

/* 抽屉滑入动画 */
.animate-slide-in-right {
  animation: slideInRight 0.3s ease-out;
}

@keyframes slideInRight {
  from {
    transform: translateX(100%);
    opacity: 0.5;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
</style>
