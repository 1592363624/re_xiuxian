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
          <option value="update_cultivation_seclusion">修炼配置-闭关</option>
          <option value="update_cultivation_adventure">修炼配置-历练</option>
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
            <th class="px-4 py-3 whitespace-nowrap">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700">
          <tr v-for="log in logs" :key="log.id" class="hover:bg-gray-800/50">
            <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ formatDateTime(log.createdAt) }}</td>
            <td class="px-4 py-3 whitespace-nowrap">{{ log.admin_id }}</td>
            <td class="px-4 py-3 whitespace-nowrap">
              <span class="px-2 py-0.5 rounded text-xs" :class="getActionClass(log.action)">{{ getActionName(log.action) }}</span>
            </td>
            <td class="px-4 py-3 text-gray-400 max-w-md truncate">{{ formatDetailsPreview(log) }}</td>
            <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ log.ip || '-' }}</td>
            <td class="px-4 py-3 whitespace-nowrap">
              <!-- 修炼配置变更日志提供"查看 diff"按钮 -->
              <button
                v-if="isCultivationConfigAction(log.action)"
                @click="openDiff(log)"
                class="px-2 py-1 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded"
              >查看 diff</button>
              <!-- 其他日志显示原始 JSON（可展开） -->
              <button
                v-else
                @click="toggleRaw(log.id)"
                class="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"
              >{{ expandedRawIds.has(log.id) ? '收起' : '详情' }}</button>
            </td>
          </tr>
          <!-- 原始 JSON 展开行（非修炼配置日志） -->
          <tr v-if="expandedRawIds.has(log.id)" v-for="log in logs" :key="`raw-${log.id}`" class="bg-gray-900/50">
            <td colspan="6" class="px-4 py-3">
              <pre class="text-xs text-gray-400 whitespace-pre-wrap break-all font-mono">{{ formatRawDetails(log.details) }}</pre>
            </td>
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

    <!-- 修炼配置变更 diff 抽屉 -->
    <div v-if="diffDrawer.visible" class="fixed inset-0 z-[70] flex justify-end">
      <div class="absolute inset-0 bg-black/70 backdrop-blur-sm" @click="closeDiff"></div>
      <div class="relative w-full max-w-3xl h-full bg-[#1c1917] border-l border-stone-700 shadow-2xl overflow-y-auto animate-slide-in-right">
        <!-- 头部 -->
        <div class="sticky top-0 bg-[#0c0a09] border-b border-stone-800 px-5 py-4 flex justify-between items-center z-10">
          <div>
            <h3 class="text-base font-bold text-cyan-400">修炼配置变更详情</h3>
            <p class="text-xs text-stone-500 mt-1">
              {{ getActionName(diffDrawer.log?.action) }} · {{ formatDateTime(diffDrawer.log?.createdAt) }} · 管理员ID: {{ diffDrawer.log?.admin_id }}
            </p>
          </div>
          <button @click="closeDiff" class="text-stone-500 hover:text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <!-- 内容 -->
        <div class="p-5 space-y-4">
          <!-- 备份文件路径 -->
          <div v-if="diffData.backup" class="bg-emerald-950/30 border border-emerald-800/50 rounded p-3 text-xs">
            <div class="text-emerald-400 font-bold mb-1">备份文件</div>
            <div class="text-emerald-300 font-mono break-all">{{ diffData.backup }}</div>
          </div>

          <!-- 修改目标 -->
          <div v-if="diffData.target" class="text-xs text-stone-400">
            修改目标：<span class="text-amber-400 font-mono">{{ diffData.target }}</span>
          </div>

          <!-- 字段级 diff 表格 -->
          <div v-if="diffData.fields.length > 0">
            <h4 class="text-sm font-bold text-stone-300 mb-2">字段级变更对比</h4>
            <div class="overflow-x-auto border border-stone-700 rounded">
              <table class="w-full text-xs">
                <thead class="bg-stone-800 text-stone-400">
                  <tr>
                    <th class="px-3 py-2 text-left">字段</th>
                    <th class="px-3 py-2 text-left">修改前</th>
                    <th class="px-3 py-2 text-left">修改后</th>
                    <th class="px-3 py-2 text-left">变化</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-stone-800">
                  <tr v-for="field in diffData.fields" :key="field.path" class="hover:bg-stone-900/50">
                    <td class="px-3 py-2 text-stone-300 font-mono whitespace-nowrap">{{ field.path }}</td>
                    <td class="px-3 py-2 text-rose-400 font-mono">{{ formatValue(field.before) }}</td>
                    <td class="px-3 py-2 text-emerald-400 font-mono">{{ formatValue(field.after) }}</td>
                    <td class="px-3 py-2">
                      <span v-if="field.changeType === 'added'" class="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-400 text-[10px]">新增</span>
                      <span v-else-if="field.changeType === 'removed'" class="px-1.5 py-0.5 rounded bg-rose-950/60 text-rose-400 text-[10px]">删除</span>
                      <span v-else-if="field.changeType === 'modified'" class="px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-400 text-[10px]">修改</span>
                      <span v-else class="px-1.5 py-0.5 rounded bg-stone-800 text-stone-500 text-[10px]">未变</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 原始 JSON 折叠区 -->
          <details class="mt-4">
            <summary class="cursor-pointer text-xs text-stone-500 hover:text-stone-300">查看原始 JSON</summary>
            <pre class="mt-2 text-xs text-stone-500 bg-stone-900/50 p-3 rounded overflow-x-auto font-mono">{{ formatRawDetails(diffDrawer.log?.details) }}</pre>
          </details>
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
 * 重构说明：
 *   - 新增 "修炼配置-闭关/历练" 筛选选项
 *   - 修炼配置变更日志提供「查看 diff」按钮，打开抽屉展示字段级对比表
 *   - 其他日志保留原始 JSON 展开方式
 *   - diff 算法：递归对比 before/after 对象，提取所有叶子节点的变化
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

// 原始 JSON 展开状态（非修炼配置日志用）
const expandedRawIds = ref(new Set())

// diff 抽屉状态
const diffDrawer = reactive({
  visible: false,
  log: null
})

// 解析后的 diff 数据
const diffData = reactive({
  target: '',
  backup: '',
  fields: []
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
 * 判断是否为修炼配置变更操作
 */
const isCultivationConfigAction = (action) => {
  return action === 'update_cultivation_seclusion' || action === 'update_cultivation_adventure'
}

/**
 * 打开 diff 抽屉并解析字段级变化
 */
const openDiff = (log) => {
  diffDrawer.log = log
  diffDrawer.visible = true
  parseDiff(log)
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
 * 解析修炼配置变更日志，提取字段级 diff
 * 算法：递归遍历 before/after 对象，对比所有叶子节点
 */
const parseDiff = (log) => {
  diffData.target = ''
  diffData.backup = ''
  diffData.fields = []

  if (!log?.details) return

  let parsed
  try {
    parsed = typeof log.details === 'string' ? JSON.parse(log.details) : log.details
  } catch (e) {
    console.error('解析日志详情失败:', e)
    return
  }

  diffData.target = parsed.target || ''
  diffData.backup = parsed.backup || ''

  const before = parsed.before || {}
  const after = parsed.after || {}

  // 递归对比，提取所有叶子节点的变化
  const fields = []
  const collectDiff = (beforeObj, afterObj, prefix = '') => {
    // 收集所有 key（before 和 after 的并集）
    const allKeys = new Set([...Object.keys(beforeObj || {}), ...Object.keys(afterObj || {})])

    for (const key of allKeys) {
      const path = prefix ? `${prefix}.${key}` : key
      const beforeVal = beforeObj?.[key]
      const afterVal = afterObj?.[key]

      // 两者都是对象（非 null、非数组），递归
      if (
        beforeVal && typeof beforeVal === 'object' && !Array.isArray(beforeVal) &&
        afterVal && typeof afterVal === 'object' && !Array.isArray(afterVal)
      ) {
        collectDiff(beforeVal, afterVal, path)
      } else {
        // 叶子节点，对比值
        let changeType = 'unchanged'
        if (beforeVal === undefined) changeType = 'added'
        else if (afterVal === undefined) changeType = 'removed'
        else if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) changeType = 'modified'

        // 只展示有变化的字段（避免表格过长）
        if (changeType !== 'unchanged') {
          fields.push({
            path,
            before: beforeVal,
            after: afterVal,
            changeType
          })
        }
      }
    }
  }

  collectDiff(before, after)
  diffData.fields = fields
}

/**
 * 格式化值用于 diff 表格显示
 */
const formatValue = (val) => {
  if (val === undefined) return '-'
  if (val === null) return 'null'
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

/**
 * 格式化操作详情预览（截断长字符串）
 */
const formatDetailsPreview = (log) => {
  if (isCultivationConfigAction(log.action)) {
    // 修炼配置变更：显示简洁摘要
    try {
      const parsed = typeof log.details === 'string' ? JSON.parse(log.details) : log.details
      const target = parsed.target || ''
      const before = parsed.before || {}
      const after = parsed.after || {}
      // 统计变化字段数
      let changedCount = 0
      const countChanges = (b, a) => {
        const keys = new Set([...Object.keys(b || {}), ...Object.keys(a || {})])
        for (const k of keys) {
          if (b?.[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) &&
              a?.[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
            countChanges(b[k], a[k])
          } else if (JSON.stringify(b?.[k]) !== JSON.stringify(a?.[k])) {
            changedCount++
          }
        }
      }
      countChanges(before, after)
      return `${target} · ${changedCount} 个字段变化`
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
