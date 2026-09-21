<template>
  <!--
    状态转移日志查看器
    展示 player_state_log 表数据，支持按玩家ID/动作过滤和分页
  -->
  <div class="space-y-4">
    <!-- 顶部筛选栏 -->
    <div class="flex flex-wrap items-center gap-3 bg-surface-base/50 rounded-panel p-3 border border-line">
      <div class="flex items-center gap-2">
        <label class="text-xs text-fg-muted">玩家ID</label>
        <input
          v-model.number="filters.playerId"
          @keyup.enter="fetchLogs(1)"
          type="number"
          placeholder="留空查全部"
          class="w-28 bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary num focus-ring focus:border-gold-600"
        />
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-fg-muted">动作类型</label>
        <select
          v-model="filters.action"
          class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary focus-ring focus:border-gold-600"
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
        <label class="text-xs text-fg-muted">状态类型</label>
        <select
          v-model="filters.stateType"
          class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary focus-ring focus:border-gold-600"
        >
          <option value="">全部</option>
          <option value="seclusion">闭关</option>
          <option value="combat">战斗</option>
          <option value="adventure">历练</option>
          <option value="moving">移动</option>
          <option value="ban">封禁</option>
        </select>
      </div>
      <AppButton variant="primary" size="xs" @click="fetchLogs(1)">
        查询
      </AppButton>
      <AppButton variant="default" size="xs" @click="resetFilters">
        重置
      </AppButton>
      <span v-if="total" class="ml-auto text-xs text-fg-faint num">共 {{ total }} 条</span>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-8 text-fg-muted">加载中...</div>

    <!-- 日志表格 -->
    <div v-else-if="logs.length > 0" class="bg-surface-base/50 rounded-panel border border-line overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-fg-muted bg-surface-raised border-b border-line">
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
              class="border-b border-line-subtle hover:bg-surface-hover"
            >
              <td class="py-2 px-3 text-fg-muted text-xs whitespace-nowrap num">{{ formatTime(log.created_at) }}</td>
              <td class="py-2 px-3 text-fg-primary num">{{ log.player_id }}{{ log.player_nickname ? ` (${log.player_nickname})` : '' }}</td>
              <td class="py-2 px-3">
                <span class="text-xs px-2 py-0.5 rounded" :class="stateTypeClass(log.state_type)">
                  {{ stateTypeText(log.state_type) }}
                </span>
              </td>
              <td class="py-2 px-3">
                <span class="text-xs" :class="actionClass(log.action)">{{ actionText(log.action) }}</span>
              </td>
              <td class="py-2 px-3 text-fg-muted text-xs">{{ log.from_state || '-' }}</td>
              <td class="py-2 px-3 text-fg-secondary text-xs">{{ log.to_state || '-' }}</td>
              <td class="py-2 px-3 text-fg-faint text-xs">{{ log.source || '-' }}</td>
              <td class="py-2 px-3 text-fg-faint text-xs max-w-xs truncate" :title="log.details">
                {{ log.details || '-' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div class="flex items-center justify-between p-3 border-t border-line-subtle bg-surface-sunken/30">
        <div class="text-xs text-fg-faint num">
          第 {{ currentPage }} / {{ totalPages }} 页
        </div>
        <div class="flex gap-2">
          <AppButton
            variant="default"
            size="xs"
            @click="fetchLogs(currentPage - 1)"
            :disabled="currentPage <= 1"
          >
            上一页
          </AppButton>
          <AppButton
            variant="default"
            size="xs"
            @click="fetchLogs(currentPage + 1)"
            :disabled="currentPage >= totalPages"
          >
            下一页
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="text-center py-12 text-fg-faint">
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
import { formatBeijing } from '../../../utils/time';
import { getStateLogs } from '../../../api/admin';
import { useUIStore } from '../../../stores/ui';
import AppButton from '../../ui/AppButton.vue';

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
    return formatBeijing(iso, { fallback: iso });
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
    ban: 'bg-surface-active text-fg-secondary'
  };
  return map[type] || 'bg-surface-active text-fg-secondary';
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
    exit: 'text-fg-muted',
    transition: 'text-blue-400',
    auto_clean: 'text-amber-400',
    error: 'text-red-400'
  };
  return map[action] || 'text-fg-muted';
}

onMounted(() => {
  fetchLogs(1);
});
</script>
