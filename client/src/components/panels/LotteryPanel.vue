<script setup lang="ts">
/**
 * 抽奖（寻仙机缘）系统面板
 * 对应后端 /api/lottery：展示花费 / 保底 / 奖池预览 / 玩家保底进度，
 * 支持单次、十连抽奖，结果带 rank 展示。
 */
import { ref, computed, onMounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { getLotteryPanel, drawLottery } from '../../api/lottery'
import { useAsyncTask } from '../../composables/useAsyncTask'
import { formatCompact } from '../../utils/format'
import PanelShell from '../ui/PanelShell.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const emit = defineEmits(['close'])

const panel = ref<any>(null)
const { loading, error, run } = useAsyncTask({ fallback: '获取抽奖面板失败' })
const busy = ref(false)
const results = ref<any[]>([])
const animationIdx = ref(-1)

const playerSS = computed(() => Number(playerStore.player?.spirit_stones ?? 0))
const singleCost = computed(() => panel.value?.single_cost || 0)
const tenCost = computed(() => panel.value?.ten_cost || 0)
const pityRemaining = computed(() => panel.value?.pity_remaining ?? 0)
const pool = computed(() => panel.value?.pool || [])

const canSingle = computed(() => !busy.value && playerSS.value >= singleCost.value)
const canTen = computed(() => !busy.value && playerSS.value >= tenCost.value)

/** 拉取面板 */
const fetchPanel = () => run(async () => {
  const res = await getLotteryPanel()
  panel.value = res.data?.data || res.data || {}
})

const refreshResources = async () => {
  try { playerStore.scheduleFetchPlayer() } catch (e) { /* 忽略 */ }
}

/** 抽奖 */
const onDraw = async (mode: 'single' | 'ten') => {
  if (busy.value) return
  busy.value = true
  results.value = []
  animationIdx.value = -1
  try {
    const res = await drawLottery(mode)
    const p = res.data
    if (!p?.success) { uiStore.showToast(p?.message || '抽奖失败', 'warning'); return }
    results.value = p.results || []
    // 逐条展示抽卡动画
    for (let i = 0; i < results.value.length; i++) {
      animationIdx.value = i
      await new Promise(r => setTimeout(r, 120))
    }
    panel.value = {
      ...panel.value,
      pity_remaining: p.pity_remaining,
      total_draws: p.balance ? panel.value.total_draws : panel.value.total_draws
    }
    uiStore.showToast(`获得 ${p.total_gain?.spirit_stones || 0} 灵石、${p.total_gain?.exp || 0} 修为`, 'success')
    await fetchPanel()
    await refreshResources()
  } catch (err: any) {
    uiStore.showToast(err?.response?.data?.message || '抽奖失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(fetchPanel)
</script>

<template>
  <PanelShell
    title="寻仙机缘"
    hint="单次 · 十连 · 保底"
    size="lg"
    :loading="loading"
    :error="error"
    @close="emit('close')"
    @retry="fetchPanel"
  >
    <template #header-actions>
      <Badge tone="gold">保底剩余 {{ pityRemaining }} 抽</Badge>
    </template>

    <div class="space-y-4">
      <!-- 玩家资源与保底进度 -->
      <div class="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2 text-[13px] text-fg-secondary
                  rounded-control border border-line-subtle bg-surface-raised">
        <span>余额 <b class="text-gold-400 num" :title="playerSS">{{ formatCompact(playerSS) }}</b> 灵石</span>
        <span>累计抽取 <b class="text-fg-primary num">{{ panel?.total_draws || 0 }}</b> 次</span>
      </div>

      <!-- 抽取按钮 -->
      <div class="flex gap-3">
        <AppButton class="flex-1" variant="default" :disabled="!canSingle" @click="onDraw('single')">
          单次（<span class="num">{{ formatCompact(singleCost) }}</span> 灵石）
        </AppButton>
        <AppButton class="flex-1" variant="primary" :disabled="!canTen" @click="onDraw('ten')">
          十连（<span class="num">{{ formatCompact(tenCost) }}</span> 灵石）
        </AppButton>
      </div>

      <!-- 抽取结果：rank 决定描边色，逐条揭示 -->
      <div v-if="results.length" class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5">
        <div
          v-for="(r, i) in results"
          :key="i"
          class="result-card rounded-control border border-line bg-surface-hover px-2.5 py-2.5 text-center"
          :class="['rank-' + r.rank, { show: i <= animationIdx }]"
        >
          <div class="text-xs text-gold-400">{{ r.rank_name }}</div>
          <div class="text-sm font-semibold text-fg-primary my-1">{{ r.name }}</div>
          <div class="text-[11px] text-fg-muted">
            <span v-if="r.reward.spirit_stones" class="num" :title="r.reward.spirit_stones">{{ formatCompact(r.reward.spirit_stones) }} 灵石</span>
            <span v-if="r.reward.exp" class="num" :title="r.reward.exp">、{{ formatCompact(r.reward.exp) }} 修为</span>
          </div>
        </div>
      </div>

      <!-- 奖池预览 -->
      <div>
        <h3 class="text-[13px] font-bold text-fg-secondary tracking-wide font-display mb-2">奖池预览</h3>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          <div
            v-for="(p, i) in pool"
            :key="i"
            class="flex items-center gap-1.5 px-2 py-2 rounded-control border border-line bg-surface-hover text-xs"
            :class="'rank-' + p.rank"
          >
            <span class="text-gold-400 whitespace-nowrap">{{ p.rank_name }}</span>
            <span class="text-fg-secondary truncate">{{ p.name }}</span>
          </div>
        </div>
      </div>
    </div>
  </PanelShell>
</template>

<style scoped>
/* 抽卡结果逐条揭示动画（结构与配色交给 Tailwind，这里只留动效） */
.result-card {
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.2s, transform 0.2s;
}
.result-card.show {
  opacity: 1;
  transform: none;
}

/* 品阶描边：SSR 鎏金 / SR 紫 / R 青 / N 灰，是玩法信息，保留色相区分 */
.rank-SSR { border-color: rgb(var(--gold-500)) !important; box-shadow: 0 0 10px rgb(var(--gold-500) / 0.4); }
.rank-SR { border-color: rgb(139 92 246) !important; }
.rank-R { border-color: rgb(14 165 233) !important; }
.rank-N { border-color: rgb(var(--line)) !important; }
</style>
