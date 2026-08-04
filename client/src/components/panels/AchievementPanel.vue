<script setup lang="ts">
/**
 * 成就系统面板
 * 对应后端 /api/achievement：展示成就总览（分类 / 进度 / 是否达成 / 是否已领奖），
 * 支持领取已达成成就的奖励（灵石 / 修为）。
 */
import { ref, computed, onMounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { getAchievements, claimAchievement } from '../../api/achievement'

const playerStore = usePlayerStore()
const uiStore = useUIStore()

const payload = ref<any>(null)
const loading = ref(false)
const busy = ref(false)
const categories = ref<any>({})

const items = computed(() => payload.value?.items || [])
const completedCount = computed(() => payload.value?.completed_count || 0)
const total = computed(() => payload.value?.total || 0)

/** 按分类分组展示 */
const grouped = computed(() => {
  const map: Record<string, any[]> = {}
  for (const it of items.value) {
    if (!map[it.category]) map[it.category] = []
    map[it.category].push(it)
  }
  return map
})

/** 拉取成就总览 */
const fetchList = async () => {
  loading.value = true
  try {
    const res = await getAchievements()
    payload.value = res.data?.data || res.data || {}
    categories.value = payload.value.categories || {}
  } catch (err) {
    console.error('获取成就失败:', err)
    uiStore.showToast('获取成就失败', 'error')
  } finally {
    loading.value = false
  }
}

/** 刷新玩家资源（领奖后更新顶部资源条） */
const refreshResources = async () => {
  try { await playerStore.fetchPlayer() } catch (e) { /* 忽略 */ }
}

/** 领取奖励 */
const onClaim = async (item: any) => {
  if (busy.value) return
  busy.value = true
  try {
    const res = await claimAchievement(item.id)
    const p = res.data
    if (!p?.success) { uiStore.showToast(p?.message || '领取失败', 'warning'); return }
    uiStore.showToast(p.message || '领取成功', 'success')
    await fetchList()
    await refreshResources()
  } catch (err: any) {
    uiStore.showToast(err?.response?.data?.message || '领取失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(fetchList)
</script>

<template>
  <div class="panel-overlay" @click.self="$emit('close')">
    <div class="panel achievement-panel">
      <div class="panel-header">
        <h2>🏆 成就</h2>
        <div class="header-right">
          <span class="progress-badge">已达成 {{ completedCount }} / {{ total }}</span>
          <button class="close-btn" @click="$emit('close')">✕</button>
        </div>
      </div>

      <div v-if="loading" class="loading">加载中…</div>

      <div v-else class="panel-body">
        <div v-for="(list, cat) in grouped" :key="cat" class="cat-block">
          <div class="cat-title">
            <span>{{ categories[cat]?.icon || '✦' }} {{ categories[cat]?.name || cat }}</span>
          </div>
          <div class="ach-grid">
            <div
              v-for="it in list"
              :key="it.id"
              class="ach-card"
              :class="['rank-' + it.category_color, { done: it.completed, claimed: it.claimed }]"
            >
              <div class="ach-name">{{ it.name }}</div>
              <div class="ach-desc">{{ it.description }}</div>
              <div class="ach-progress">
                <div class="bar">
                  <div class="bar-fill" :style="{ width: it.percent + '%' }"></div>
                </div>
                <span class="bar-text">{{ it.progress }} / {{ it.target }}</span>
              </div>
              <div class="ach-reward">
                奖励：{{ it.reward.spirit_stones ? it.reward.spirit_stones + ' 灵石' : '' }}
                {{ it.reward.exp ? '、' + it.reward.exp + ' 修为' : '' }}
              </div>
              <button
                class="claim-btn"
                :disabled="!it.completed || it.claimed || busy"
                @click="onClaim(it)"
              >
                {{ it.claimed ? '已领取' : it.completed ? '领取' : '未达成' }}
              </button>
            </div>
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
  width: min(880px, 94vw); max-height: 86vh; background: #1c1917; color: #e7e5e4;
  border: 1px solid #44403c; border-radius: 12px; display: flex; flex-direction: column;
}
.panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid #44403c;
}
.header-right { display: flex; align-items: center; gap: 12px; }
.progress-badge { font-size: 13px; color: #fbbf24; }
.close-btn {
  background: transparent; border: none; color: #a8a29e; font-size: 18px; cursor: pointer;
}
.panel-body { padding: 16px 18px; overflow-y: auto; }
.loading { padding: 40px; text-align: center; color: #a8a29e; }
.cat-title { font-size: 15px; margin: 12px 0 8px; color: #d6d3d1; }
.ach-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.ach-card {
  border: 1px solid #44403c; border-radius: 10px; padding: 12px; background: #292524;
  display: flex; flex-direction: column; gap: 6px;
}
.ach-card.done { border-color: #fbbf24; }
.ach-card.claimed { opacity: 0.7; }
.ach-name { font-size: 15px; font-weight: 600; color: #f5f5f4; }
.ach-desc { font-size: 12px; color: #a8a29e; min-height: 32px; }
.ach-progress { display: flex; align-items: center; gap: 8px; }
.bar { flex: 1; height: 6px; background: #1c1917; border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; background: #fbbf24; }
.bar-text { font-size: 11px; color: #a8a29e; white-space: nowrap; }
.ach-reward { font-size: 12px; color: #cbd5e1; }
.claim-btn {
  margin-top: 4px; padding: 7px; border-radius: 8px; border: none; cursor: pointer;
  background: #fbbf24; color: #1c1917; font-weight: 600;
}
.claim-btn:disabled { background: #44403c; color: #78716c; cursor: not-allowed; }
</style>
