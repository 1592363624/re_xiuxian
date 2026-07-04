<template>
  <!--
    状态转移日志查看器
    展示 player_state_log 表数据，支持按玩家ID/动作过滤和分页
  -->
  <div class="space-y-4">
    <!-- 顶部筛选栏 -->
    <div class="flex flex-wrap items-center gap-3 bg-gray-800/50 rounded-lg p-3 border border-gray-700">
      <div class="flex items-center gap-2">
        <label class="text-xs text-gray-400">玩家ID</label>
        <input
          v-model.number="filters.playerId"
          @keyup.enter="fetchLogs(1)"
          type="number"
          placeholder="留空查全部"
          class="w-28 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white"
        />
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-gray-400">动作类型</label>
        <select
          v-model="filters.action"
          class="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white"
        >
          <option value="">全部</option>
          <option value="enter">进入状态</option>
          <option value="exit">退出状态</option>
          <option value="transition">状态转移</option>
          <option value="auto_clean">自动清理</option>
          <option value="error">异常</option>
        </select>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-gray-400">状态类型</label>
        <select
          v-model="filters.stateType"
          class="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white"
        >
          <option value="">全部</option>
          <option value="seclusion">闭关</option>
          <option value="combat">战斗</option>
          <option value="adventure">历练</option>
          <option value="moving">移动</option>
          <option value="ban">封禁</option>
        </select>
      </div>
      <button
        @click="fetchLogs(1)"
        class="px-3 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded transition-colors"
      >
        查询
      </button>
      <button
        @click="resetFilters"
        class="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
      >
        重置
      </button>
      <span v-if="total" class="ml-auto text-xs text-gray-500">共 {{ total }} 条</span>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-8 text-gray-400">加载中...</div>

    <!-- 日志表格 -->
    <div v-else-if="logs.length > 0" class="bg-gray-800/70 rounded-lg border border-gray-700 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-gray-400 bg-gray-900/50 border-b border-gray-700">
              <th class="text-left py-2 px-3">时间</th>
              <th class="text-left py-2 px-3">玩家</th>
              <th class="text-left py-2 px-3">状态类型</th>
              <th class="text-left py-2 px-3">动作</th>
              <th class="text-left py-2 px-3">从</th>
              <th class="text-left py-2 px-3">到</th>
              <th class="text-left py-2 px-3">来源</th>
              <th class="text-left py-2 px-3">详情</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="log in logs"
              :key="log.id"
              class="border-b border-gray-800 hover:bg-gray-900/30"
            >
              <td class="py-2 px-3 text-gray-400 text-xs whitespace-nowrap">{{ formatTime(log.created_at) }}</td>
              <td class="py-2 px-3 text-gray-200">{{ log.player_id }}{{ log.player_nickname ? ` (${log.player_nickname})` : '' }}</td>
              <td class="py-2 px-3">
                <span class="text-xs px-2 py-0.5 rounded" :class="stateTypeClass(log.state_type)">
                  {{ stateTypeText(log.state_type) }}
                </span>
              </td>
              <td class="py-2 px-3">
                <span class="text-xs" :class="actionClass(log.action)">{{ actionText(log.action) }}</span>
              </td>
              <td class="py-2 px-3 text-gray-400 text-xs">{{ log.from_state || '-' }}</td>
              <td class="py-2 px-3 text-gray-300 text-xs">{{ log.to_state || '-' }}</td>
              <td class="py-2 px-3 text-gray-500 text-xs">{{ log.source || '-' }}</td>
              <td class="py-2 px-3 text-gray-500 text-xs max-w-xs truncate" :title="log.details">
                {{ log.details || '-' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div class="flex items-center justify-between p-3 border-t border-gray-700 bg-gray-900/30">
        <div class="text-xs text-gray-500">
          第 {{ currentPage }} / {{ totalPages }} 页
        </div>
        <div class="flex gap-2">
          <button
            @click="fetchLogs(currentPage - 1)"
            :disabled="currentPage <= 1"
            class="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded"
          >
            上一页
          </button>
          <button
            @click="fetchLogs(currentPage + 1)"
            :disabled="currentPage >= totalPages"
            class="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded"
          >
            下一页
          </button>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="text-center py-12 text-gray-500">
      <div class="text-4xl mb-2">📜</div>
      <div>暂无状态转移日志</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 状态转移日志查看器组件
 *
 * 功能：
 *   1. 展示 player_state_log 表数据
 *   2. 支持按玩家ID、动作类型、状态类型筛选
 *   3. 支持分页查询
 *
 * 数据来源：GET /api/admin/state-logs
 */
import { ref, reactive, onMounted } from 'vue';
import { getStateLogs } from '../../../api/admin';
import { useUIStore } from '../../../stores/ui';

const uiStore = useUIStore();

const loading = ref(false);
const logs = ref<any[]>([]);
const total = ref(0);
const currentPage = ref(1);
const totalPages = ref(1);
const pageSize = 20;

const filters = reactive({
  playerId: undefined as number | undefined,
  action: '',
  stateType: ''
});

/**
 * 拉取日志列表
 */
async function fetchLogs(page: number = 1) {
  if (page < 1) return;
  loading.value = true;
  try {
    const params: any = { page, limit: pageSize };
    if (filters.playerId) params.player_id = filters.playerId;
    if (filters.action) params.action = filters.action;
    if (filters.stateType) params.state_type = filters.stateType;

    const res = await getStateLogs(params);
    const body = res.data;
    if (body?.code === 200) {
      logs.value = body.data?.logs || [];
      total.value = body.data?.total || 0;
      currentPage.value = body.data?.currentPage || page;
      totalPages.value = body.data?.totalPages || 1;
    }
  } catch (err: any) {
    console.error('[StateLogViewer] 获取日志失败:', err);
    uiStore.showToast('获取日志失败', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 重置筛选条件
 */
function resetFilters() {
  filters.playerId = undefined;
  filters.action = '';
  filters.stateType = '';
  fetchLogs(1);
}

/**
 * 格式化时间
 */
function formatTime(iso: string): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

/**
 * 状态类型文本
 */
function stateTypeText(type: string): string {
  const map: Record<string, string> = {
    seclusion: '闭关',
    combat: '战斗',
    adventure: '历练',
    moving: '移动',
    ban: '封禁'
  };
  return map[type] || type;
}

/**
 * 状态类型样式
 */
function stateTypeClass(type: string): string {
  const map: Record<string, string> = {
    seclusion: 'bg-purple-900/40 text-purple-300',
    combat: 'bg-red-900/40 text-red-300',
    adventure: 'bg-amber-900/40 text-amber-300',
    moving: 'bg-blue-900/40 text-blue-300',
    ban: 'bg-gray-700 text-gray-300'
  };
  return map[type] || 'bg-gray-700 text-gray-300';
}

/**
 * 动作文本
 */
function actionText(action: string): string {
  const map: Record<string, string> = {
    enter: '进入',
    exit: '退出',
    transition: '转移',
    auto_clean: '自动清理',
    error: '异常'
  };
  return map[action] || action;
}

/**
 * 动作样式
 */
function actionClass(action: string): string {
  const map: Record<string, string> = {
    enter: 'text-emerald-400',
    exit: 'text-gray-400',
    transition: 'text-blue-400',
    auto_clean: 'text-amber-400',
    error: 'text-red-400'
  };
  return map[action] || 'text-gray-400';
}

onMounted(() => {
  fetchLogs(1);
});
</script>
