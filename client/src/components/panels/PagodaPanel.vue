<!--
  琉璃古塔面板（玩法文档第30节·古塔流程）
  Tab: 闯塔 | 琉璃塔榜 | 历史
-->
<template>
  <PanelShell title="琉璃古塔" hint="九重试炼 闯塔争榜" size="lg" @close="$emit('close')">
    <template #header-actions>
      <div class="hidden sm:flex items-center gap-2">
        <Badge tone="gold">最高 <span class="num">{{ status?.highest_floor || 0 }}</span> 层</Badge>
        <Badge tone="success">今日 <span class="num">{{ status?.today_attempts ?? 0 }}</span>/{{ status?.daily_limit ?? 5 }}</Badge>
        <Badge tone="arcane">最佳分 <span class="num">{{ status?.best_score || 0 }}</span></Badge>
      </div>
    </template>

    <Tabs :model-value="tab" :items="tabItems" class="mb-4" @update:model-value="tab = String($event)" />

    <LoadingBlock v-if="loading" />
    <template v-else>
      <!-- 闯塔 -->
      <div v-if="tab === 'climb'">
        <PanelCard tone="gold" class="mb-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div class="text-sm text-fg-muted">当前进度</div>
              <div class="text-lg font-bold">
                <template v-if="status?.in_tower">塔中 · 第 {{ status.current_floor }} 层待战</template>
                <template v-else>塔外 · 下一层 {{ status?.next_floor || 1 }}</template>
              </div>
            </div>
            <div class="flex gap-2">
              <AppButton tone="gold" :disabled="busy || !status?.can_climb" @click="onClimb">
                {{ status?.in_tower ? '继续闯塔' : '闯塔' }}
              </AppButton>
              <AppButton v-if="status?.in_tower" tone="ghost" :disabled="busy" @click="onExit">退出古塔</AppButton>
              <AppButton tone="danger" :disabled="busy" @click="confirmReset = true">重置</AppButton>
            </div>
          </div>
        </PanelCard>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-center">
          <PanelCard><div class="text-xs text-fg-muted">最高层</div><div class="num font-bold">{{ status?.highest_floor || 0 }}</div></PanelCard>
          <PanelCard><div class="text-xs text-fg-muted">通关次数</div><div class="num font-bold">{{ status?.total_clears || 0 }}</div></PanelCard>
          <PanelCard><div class="text-xs text-fg-muted">今日重置</div><div class="num font-bold">{{ status?.today_resets ?? 0 }}/{{ status?.reset_daily_limit ?? 1 }}</div></PanelCard>
          <PanelCard><div class="text-xs text-fg-muted">重置花费</div><div class="num font-bold">{{ status?.reset_cost_spirit_stones ?? 0 }} 灵石</div></PanelCard>
        </div>

        <PanelCard v-if="lastResult" class="mb-3" :tone="lastResult.success ? 'success' : 'danger'">
          <div class="font-bold mb-1">{{ lastResult.message }}</div>
          <div class="text-xs text-fg-muted mb-2">
            用时 {{ lastResult.rounds_used }} 回合 · 评分 {{ lastResult.score }}
            <span v-if="lastResult.is_first_clear" class="text-gold-400"> · 首通</span>
          </div>
          <div class="text-xs text-fg-muted mb-1">修为 +{{ lastResult.exp_gained }} · 灵石 +{{ lastResult.spirit_stones_gained }}</div>
          <div class="max-h-32 overflow-y-auto text-xs space-y-0.5 text-fg-muted">
            <div v-for="(line, i) in (lastResult.battle_log || [])" :key="i">{{ line }}</div>
          </div>
        </PanelCard>

        <div class="space-y-2">
          <div v-for="f in floors" :key="f.floor" class="border border-line rounded-panel p-3 flex items-center justify-between">
            <div>
              <div class="font-bold">第 {{ f.floor }} 层 · {{ f.name }}</div>
              <div class="text-xs text-fg-muted">{{ f.description }}</div>
            </div>
            <Badge :tone="(status?.first_clears || []).includes(f.floor) ? 'success' : 'stone'">
              {{ (status?.first_clears || []).includes(f.floor) ? '已首通' : '未通关' }}
            </Badge>
          </div>
        </div>
      </div>

      <!-- 排行榜 -->
      <div v-else-if="tab === 'ranking'">
        <EmptyState v-if="ranking.length === 0" text="暂无塔榜数据" />
        <div v-else class="space-y-2">
          <div v-for="r in ranking" :key="r.player_id" class="border border-line rounded-panel p-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full bg-surface-hover grid place-items-center num font-bold">{{ r.rank }}</div>
              <div>
                <div class="font-bold">{{ r.nickname }}</div>
                <div class="text-xs text-fg-muted">{{ r.realm }}</div>
              </div>
            </div>
            <div class="text-right text-sm">
              <div class="num font-bold text-gold-400">{{ r.best_score }}</div>
              <div class="text-xs text-fg-muted">最高 {{ r.highest_floor }} 层</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 历史 -->
      <div v-else>
        <EmptyState v-if="history.length === 0" text="尚无闯塔记录" />
        <div v-else class="space-y-2">
          <div v-for="(h, i) in history" :key="i" class="border border-line rounded-panel p-3 text-sm">
            <div class="flex justify-between">
              <span class="font-bold">第 {{ h.floor }} 层 · {{ h.floor_name }}</span>
              <Badge :tone="h.result === 'win' ? 'success' : 'danger'">{{ h.result === 'win' ? '通关' : '败退' }}</Badge>
            </div>
            <div class="text-xs text-fg-muted mt-1">评分 {{ h.score }} · {{ h.rounds_used }} 回合 · 修为+{{ h.exp_gained }}</div>
          </div>
        </div>
      </div>
    </template>

    <!-- 重置确认（自定义弹窗，不用浏览器 alert） -->
    <div v-if="confirmReset" class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" @click.self="confirmReset = false">
      <div class="bg-surface-canvas border border-line rounded-panel p-5 max-w-sm w-full">
        <div class="font-bold mb-2">重置琉璃古塔？</div>
        <p class="text-sm text-fg-muted mb-4">将清空最高层进度，花费 {{ status?.reset_cost_spirit_stones ?? 0 }} 灵石。首通记录保留。</p>
        <div class="flex justify-end gap-2">
          <AppButton tone="ghost" @click="confirmReset = false">取消</AppButton>
          <AppButton tone="danger" :disabled="busy" @click="onReset">确认重置</AppButton>
        </div>
      </div>
    </div>
  </PanelShell>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import Tabs from '../ui/Tabs.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import EmptyState from '../ui/EmptyState.vue'
import { useUIStore } from '../../stores/ui'
import {
  getPagodaInfo, getPagodaStatus, getPagodaRanking, getPagodaHistory,
  climbPagoda, exitPagoda, resetPagoda
} from '../../api/pagoda'

defineEmits(['close'])
const uiStore = useUIStore()
const tab = ref('climb')
const loading = ref(true)
const busy = ref(false)
const confirmReset = ref(false)
const status = ref(null)
const floors = ref([])
const ranking = ref([])
const history = ref([])
const lastResult = ref(null)

const tabItems = computed(() => [
  { key: 'climb', label: '闯塔' },
  { key: 'ranking', label: '琉璃塔榜' },
  { key: 'history', label: '历史' },
])

async function refresh() {
  loading.value = true
  try {
    const [infoRes, statusRes, rankRes, histRes] = await Promise.all([
      getPagodaInfo(), getPagodaStatus(), getPagodaRanking(), getPagodaHistory()
    ])
    floors.value = infoRes.data?.data?.floors || []
    status.value = statusRes.data?.data || null
    ranking.value = rankRes.data?.data?.ranking || []
    history.value = histRes.data?.data?.history || []
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '加载古塔失败', 'error')
  } finally {
    loading.value = false
  }
}

async function onClimb() {
  busy.value = true
  try {
    const res = await climbPagoda()
    lastResult.value = res.data?.data || null
    uiStore.showToast(res.data?.message || '闯塔结束', res.data?.data?.success ? 'success' : 'error')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '闯塔失败', 'error')
  } finally {
    busy.value = false
  }
}

async function onExit() {
  busy.value = true
  try {
    const res = await exitPagoda()
    uiStore.showToast(res.data?.message || '已退出', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '退出失败', 'error')
  } finally {
    busy.value = false
  }
}

async function onReset() {
  busy.value = true
  try {
    const res = await resetPagoda()
    confirmReset.value = false
    uiStore.showToast(res.data?.message || '已重置', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '重置失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
</script>
