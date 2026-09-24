<script setup>
/**
 * 试炼古塔面板：闯塔、首通、排行
 */
import { ref, onMounted } from 'vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import AppButton from '../ui/AppButton.vue'
import apiClient from '../../api/index'

const emit = defineEmits(['close'])
const loading = ref(false)
const status = ref(null)
const ranking = ref([])
const lastResult = ref(null)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [s, r] = await Promise.all([
      apiClient.get('/trial-tower/status'),
      apiClient.get('/trial-tower/ranking?limit=10')
    ])
    status.value = s.data || s
    ranking.value = (r.data?.list || r.list || [])
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function challenge() {
  loading.value = true
  error.value = ''
  try {
    const res = await apiClient.post('/trial-tower/challenge')
    lastResult.value = res.data || res
    await load()
  } catch (e) {
    error.value = e.message || '挑战失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <PanelShell title="试炼古塔" size="lg" :loading="loading" @close="emit('close')">
    <div class="space-y-4">
      <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
      <div v-if="lastResult" class="text-sm rounded-panel border border-line bg-surface-raised p-3">
        <div class="font-medium" :class="lastResult.win ? 'text-emerald-300' : 'text-red-300'">
          {{ lastResult.win ? `闯过第 ${lastResult.floor} 层` : `第 ${lastResult.floor} 层失败` }}
          <span v-if="lastResult.first_clear" class="ml-2 text-amber-300">首通！</span>
          <span v-if="lastResult.server_first" class="ml-2 text-purple-300">全服首杀</span>
        </div>
        <div class="text-xs text-fg-muted mt-1">
          战力 {{ lastResult.power }} / 需要 {{ lastResult.required }} · 修为 +{{ lastResult.exp_gain }} · 灵石 +{{ lastResult.stone_gain }}
        </div>
      </div>

      <PanelCard v-if="status">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-lg font-display text-gold-500">第 {{ status.floor }} 层</div>
            <div class="text-xs text-fg-muted">历史最高 {{ status.best_floor }} / {{ status.max_floor }}</div>
          </div>
          <div class="text-right text-xs text-fg-muted">
            今日免费 {{ status.free_attempts_left }} 次<br/>
            重置消耗 {{ status.reset_cost_exp }} 修为
          </div>
        </div>
        <div v-if="status.next_floor" class="mt-3 text-sm">
          下一层：#{{ status.next_floor.floor }}
          <span class="ml-2 px-2 py-0.5 rounded text-xs"
            :class="status.next_floor.kind === 'boss' ? 'bg-red-900/50 text-red-200'
              : status.next_floor.kind === 'elite' ? 'bg-amber-900/50 text-amber-200'
              : 'bg-surface text-fg-muted'">
            {{ status.next_floor.kind === 'boss' ? '首领层' : status.next_floor.kind === 'elite' ? '精英层' : '普通层' }}
          </span>
          <span class="ml-2 text-xs text-fg-muted">需求战力 {{ status.next_floor.power }}</span>
          <span v-if="status.next_floor.first_clear" class="ml-2 text-xs text-gold-500">未首通</span>
        </div>
        <div class="mt-4">
          <AppButton variant="primary" :disabled="loading || !status.next_floor" @click="challenge">
            闯塔
          </AppButton>
        </div>
      </PanelCard>

      <PanelCard title="琉璃塔榜">
        <div v-if="!ranking.length" class="text-sm text-fg-muted">暂无上榜修士</div>
        <div v-for="(r, i) in ranking" :key="r.player_id" class="flex justify-between text-sm py-1 border-b border-line/40 last:border-0">
          <span>#{{ i + 1 }} {{ r.nickname || '道友' }} <span class="text-xs text-fg-muted">{{ r.realm }}</span></span>
          <span class="text-gold-500">{{ r.best_floor }} 层</span>
        </div>
      </PanelCard>
    </div>
  </PanelShell>
</template>
