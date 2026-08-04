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

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const panel = ref<any>(null)
const loading = ref(false)
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
const fetchPanel = async () => {
  loading.value = true
  try {
    const res = await getLotteryPanel()
    panel.value = res.data?.data || res.data || {}
  } catch (err) {
    console.error('获取抽奖面板失败:', err)
    uiStore.showToast('获取抽奖面板失败', 'error')
  } finally {
    loading.value = false
  }
}

const refreshResources = async () => {
  try { await playerStore.fetchPlayer() } catch (e) { /* 忽略 */ }
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
  <div class="panel-overlay" @click.self="$emit('close')">
    <div class="panel lottery-panel">
      <div class="panel-header">
        <h2>🎰 寻仙机缘</h2>
        <button class="close-btn" @click="$emit('close')">✕</button>
      </div>

      <div v-if="loading" class="loading">加载中…</div>

      <div v-else class="panel-body">
        <div class="info-row">
          <span>余额：{{ playerSS }} 灵石</span>
          <span>保底剩余：{{ pityRemaining }} 抽</span>
          <span>累计抽取：{{ panel?.total_draws || 0 }}</span>
        </div>

        <div class="actions">
          <button class="draw-btn single" :disabled="!canSingle" @click="onDraw('single')">
            单次（{{ singleCost }} 灵石）
          </button>
          <button class="draw-btn ten" :disabled="!canTen" @click="onDraw('ten')">
            十连（{{ tenCost }} 灵石）
          </button>
        </div>

        <div v-if="results.length" class="result-grid">
          <div
            v-for="(r, i) in results"
            :key="i"
            class="result-card"
            :class="['rank-' + r.rank, { show: i <= animationIdx }]"
          >
            <div class="r-rank">{{ r.rank_name }}</div>
            <div class="r-name">{{ r.name }}</div>
            <div class="r-reward">
              {{ r.reward.spirit_stones ? r.reward.spirit_stones + ' 灵石' : '' }}
              {{ r.reward.exp ? '、' + r.reward.exp + ' 修为' : '' }}
            </div>
          </div>
        </div>

        <div class="pool-title">奖池预览</div>
        <div class="pool-grid">
          <div v-for="(p, i) in pool" :key="i" class="pool-item" :class="'rank-' + p.rank">
            <span class="p-rank">{{ p.rank_name }}</span>
            <span class="p-name">{{ p.name }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.panel {
  width: min(760px, 94vw); max-height: 86vh; background: #1c1917; color: #e7e5e4;
  border: 1px solid #44403c; border-radius: 12px; display: flex; flex-direction: column;
}
.panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid #44403c;
}
.close-btn { background: transparent; border: none; color: #a8a29e; font-size: 18px; cursor: pointer; }
.panel-body { padding: 16px 18px; overflow-y: auto; }
.loading { padding: 40px; text-align: center; color: #a8a29e; }
.info-row { display: flex; gap: 18px; font-size: 13px; color: #d6d3d1; margin-bottom: 14px; }
.actions { display: flex; gap: 12px; margin-bottom: 16px; }
.draw-btn {
  flex: 1; padding: 12px; border-radius: 10px; border: none; cursor: pointer;
  font-weight: 600; font-size: 14px;
}
.draw-btn.single { background: #0ea5e9; color: #06151f; }
.draw-btn.ten { background: #f59e0b; color: #1c1917; }
.draw-btn:disabled { background: #44403c; color: #78716c; cursor: not-allowed; }
.result-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-bottom: 18px; }
.result-card {
  border: 1px solid #44403c; border-radius: 8px; padding: 10px; text-align: center;
  background: #292524; opacity: 0; transform: translateY(8px); transition: all .2s;
}
.result-card.show { opacity: 1; transform: none; }
.r-rank { font-size: 12px; color: #fbbf24; }
.r-name { font-size: 14px; font-weight: 600; color: #f5f5f4; margin: 4px 0; }
.r-reward { font-size: 11px; color: #a8a29e; }
.rank-SSR { border-color: #f59e0b !important; box-shadow: 0 0 10px rgba(245,158,11,.4); }
.rank-SR { border-color: #8b5cf6 !important; }
.rank-R { border-color: #0ea5e9 !important; }
.rank-N { border-color: #78716c !important; }
.pool-title { font-size: 14px; color: #d6d3d1; margin: 8px 0; }
.pool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
.pool-item {
  display: flex; align-items: center; gap: 6px; padding: 8px; border-radius: 8px;
  border: 1px solid #44403c; background: #292524; font-size: 12px;
}
.p-rank { color: #fbbf24; white-space: nowrap; }
.p-name { color: #d6d3d1; }
</style>
