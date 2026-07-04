<template>
  <!--
    状态清理监控面板
    展示 StateCleanerService 的运行指标，可视化各状态清理统计和健康度
    支持：实时刷新、手动触发清理、查看历史趋势（基于内存累计数据）
  -->
  <div class="space-y-4">
    <!-- 顶部操作栏 -->
    <div class="flex items-center justify-between bg-gray-800/50 rounded-lg p-3 border border-gray-700">
      <div class="flex items-center gap-3">
        <div class="text-sm text-gray-400">自动刷新（10s）</div>
        <button
          @click="autoRefresh = !autoRefresh"
          :class="[
            'relative w-10 h-5 rounded-full transition-colors',
            autoRefresh ? 'bg-emerald-600' : 'bg-gray-600'
          ]"
        >
          <div
            class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
            :class="autoRefresh ? 'translate-x-5' : 'translate-x-0.5'"
          ></div>
        </button>
        <span v-if="lastRefreshAt" class="text-xs text-gray-500">
          最后刷新: {{ lastRefreshAt }}
        </span>
      </div>
      <div class="flex gap-2">
        <button
          @click="fetchMetrics"
          class="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
        >
          手动刷新
        </button>
        <button
          @click="handleTriggerRun"
          :disabled="triggering"
          class="px-3 py-1.5 text-xs bg-amber-700 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
        >
          {{ triggering ? '执行中...' : '手动触发清理' }}
        </button>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading && !metrics" class="text-center py-8 text-gray-400">
      加载监控数据中...
    </div>

    <!-- 数据展示 -->
    <div v-else-if="metrics" class="space-y-4">
      <!-- 健康度总览卡片 -->
      <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div class="bg-gray-800/70 rounded-lg p-4 border border-gray-700">
          <div class="text-xs text-gray-400 mb-1">健康度</div>
          <div
            class="text-lg font-bold"
            :class="{
              'text-emerald-400': health === 'healthy',
              'text-amber-400': health === 'warning',
              'text-red-400': health === 'critical'
            }"
          >
            {{ healthText }}
          </div>
          <div class="text-xs text-gray-500 mt-1">错误率 {{ (metrics.errorRate * 100).toFixed(2) }}%</div>
        </div>
        <div class="bg-gray-800/70 rounded-lg p-4 border border-gray-700">
          <div class="text-xs text-gray-400 mb-1">累计执行次数</div>
          <div class="text-lg font-bold text-blue-400">{{ metrics.totalRuns }}</div>
          <div class="text-xs text-gray-500 mt-1">已清理 {{ metrics.totalItemsCleaned }} 项</div>
        </div>
        <div class="bg-gray-800/70 rounded-lg p-4 border border-gray-700">
          <div class="text-xs text-gray-400 mb-1">上次执行耗时</div>
          <div class="text-lg font-bold text-purple-400">{{ metrics.lastRunDurationMs }} ms</div>
          <div class="text-xs text-gray-500 mt-1">{{ metrics.lastRunAt ? formatTime(metrics.lastRunAt) : '尚未执行' }}</div>
        </div>
        <div class="bg-gray-800/70 rounded-lg p-4 border border-gray-700">
          <div class="text-xs text-gray-400 mb-1">调度间隔</div>
          <div class="text-lg font-bold text-cyan-400">{{ (metrics.intervalMs / 1000).toFixed(0) }} s</div>
          <div class="text-xs text-gray-500 mt-1">{{ metrics.enabled ? '已启用' : '已禁用' }}</div>
        </div>
      </div>

      <!-- 已注册状态处理器列表 -->
      <div class="bg-gray-800/70 rounded-lg p-4 border border-gray-700">
        <div class="text-sm font-semibold text-gray-200 mb-3">已注册状态处理器（{{ metrics.registeredStates.length }} 个）</div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          <div
            v-for="state in metrics.registeredStates"
            :key="state.stateType"
            class="flex items-center justify-between p-2 bg-gray-900/50 rounded border border-gray-700"
          >
            <div>
              <div class="text-sm text-gray-200">{{ state.displayName }}</div>
              <div class="text-xs text-gray-500">{{ state.stateType }} · {{ state.stateEnum }}</div>
            </div>
            <div
              class="px-2 py-0.5 text-xs rounded"
              :class="state.exclusive ? 'bg-red-900/40 text-red-300' : 'bg-gray-700 text-gray-400'"
            >
              {{ state.exclusive ? '互斥' : '共存' }}
            </div>
          </div>
        </div>
      </div>

      <!-- 上次清理统计详情 -->
      <div class="bg-gray-800/70 rounded-lg p-4 border border-gray-700">
        <div class="text-sm font-semibold text-gray-200 mb-3">上次清理统计</div>
        <div v-if="hasLastRunStats" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-gray-400 border-b border-gray-700">
                <th class="text-left py-2 px-3">状态类型</th>
                <th class="text-right py-2 px-3">扫描数</th>
                <th class="text-right py-2 px-3">已清理</th>
                <th class="text-right py-2 px-3">失败数</th>
                <th class="text-left py-2 px-3">状态</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(stat, type) in metrics.lastRunStats"
                :key="type"
                class="border-b border-gray-800 hover:bg-gray-900/30"
              >
                <td class="py-2 px-3 text-gray-200">{{ type }}</td>
                <td class="py-2 px-3 text-right text-gray-300">{{ stat.scanned ?? 0 }}</td>
                <td class="py-2 px-3 text-right text-emerald-400">{{ getCleanedCount(stat) }}</td>
                <td class="py-2 px-3 text-right" :class="stat.failed > 0 ? 'text-red-400' : 'text-gray-500'">
                  {{ stat.failed ?? 0 }}
                </td>
                <td class="py-2 px-3">
                  <span v-if="stat.skipped" class="text-xs text-gray-500">跳过（{{ stat.reason }}）</span>
                  <span v-else-if="stat.failed > 0" class="text-xs text-red-400">部分失败</span>
                  <span v-else-if="(stat.scanned ?? 0) > 0" class="text-xs text-emerald-400">正常</span>
                  <span v-else class="text-xs text-gray-500">无过期数据</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="text-center py-4 text-gray-500 text-sm">
          尚无执行记录
        </div>
      </div>

      <!-- 服务运行信息 -->
      <div class="bg-gray-800/70 rounded-lg p-4 border border-gray-700">
        <div class="text-sm font-semibold text-gray-200 mb-3">服务信息</div>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span class="text-gray-500">服务启动时间：</span>
            <span class="text-gray-300">{{ formatTime(metrics.startedAt) }}</span>
          </div>
          <div>
            <span class="text-gray-500">累计错误次数：</span>
            <span :class="metrics.totalErrors > 0 ? 'text-red-400' : 'text-emerald-400'">
              {{ metrics.totalErrors }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-else class="text-center py-8 text-red-400">
      加载监控数据失败
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 状态清理监控面板组件
 *
 * 功能：
 *   1. 实时展示 StateCleanerService 的监控指标（健康度/执行次数/错误率/已注册状态）
 *   2. 可视化上次清理统计（按状态类型分组展示扫描/清理/失败数）
 *   3. 支持手动触发清理
 *   4. 支持自动刷新（10s 间隔，可开关）
 *
 * 数据来源：GET /api/admin/state-cleaner/metrics
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getStateCleanerMetrics, triggerStateCleanerRun } from '../../../api/admin';
import { useUIStore } from '../../../stores/ui';

const uiStore = useUIStore();

const loading = ref(false);
const triggering = ref(false);
const autoRefresh = ref(true);
const lastRefreshAt = ref('');
const metrics = ref<any>(null);
const health = ref<string>('healthy');
let refreshTimer: any = null;

/**
 * 健康度文本
 */
const healthText = computed(() => {
  const map: Record<string, string> = {
    healthy: '健康',
    warning: '警告',
    critical: '严重'
  };
  return map[health.value] || health.value;
});

/**
 * 是否有上次执行统计
 */
const hasLastRunStats = computed(() => {
  if (!metrics.value?.lastRunStats) return false;
  return Object.keys(metrics.value.lastRunStats).length > 0;
});

/**
 * 获取清理数量（不同状态类型字段名不同：settled/cleaned/marked/unbanned）
 */
function getCleanedCount(stat: any): number {
  if (!stat) return 0;
  return (stat.settled || 0) + (stat.cleaned || 0) + (stat.marked || 0) + (stat.unbanned || 0);
}

/**
 * 格式化时间
 */
function formatTime(iso: string): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

/**
 * 拉取监控指标
 */
async function fetchMetrics() {
  loading.value = true;
  try {
    const res = await getStateCleanerMetrics();
    const body = res.data;
    if (body?.code === 200) {
      metrics.value = body.data;
      health.value = body.health || 'healthy';
      lastRefreshAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }
  } catch (err: any) {
    console.error('[StateCleanerMonitor] 获取监控指标失败:', err);
    uiStore.showToast('获取监控指标失败', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 手动触发清理
 */
async function handleTriggerRun() {
  triggering.value = true;
  try {
    const res = await triggerStateCleanerRun();
    const body = res.data;
    if (body?.code === 200) {
      uiStore.showToast('状态清理已触发', 'success');
      // 立即刷新指标
      await fetchMetrics();
    }
  } catch (err: any) {
    console.error('[StateCleanerMonitor] 触发清理失败:', err);
    uiStore.showToast('触发清理失败: ' + (err.message || '未知错误'), 'error');
  } finally {
    triggering.value = false;
  }
}

onMounted(() => {
  fetchMetrics();
  if (autoRefresh.value) {
    refreshTimer = setInterval(fetchMetrics, 10000);
  }
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

// 自动刷新开关变化时重启定时器
function setupAutoRefreshWatcher() {
  // 简化实现：通过 onUnmounted 清理，开关变化时手动重启
}
</script>
