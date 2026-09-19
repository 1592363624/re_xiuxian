<script setup>
/**
 * 成就系统面板
 * 对应后端 /api/achievement：展示成就总览（分类 / 进度 / 是否达成 / 是否已领奖），
 * 支持领取已达成成就的奖励（灵石 / 修为）。
 */
import { ref, computed, onMounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { getAchievements, claimAchievement } from '../../api/achievement'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import StatBar from '../ui/StatBar.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'

const playerStore = usePlayerStore()
const uiStore = useUIStore()

defineEmits(['close'])

const payload = ref(null)
const loading = ref(false)
const loadError = ref('')
const busy = ref(false)
const categories = ref({})

const items = computed(() => payload.value?.items || [])
const completedCount = computed(() => payload.value?.completed_count || 0)
const total = computed(() => payload.value?.total || 0)

/** 按分类分组展示 */
const grouped = computed(() => {
  const map = {}
  for (const it of items.value) {
    if (!map[it.category]) map[it.category] = []
    map[it.category].push(it)
  }
  return map
})

const fetchList = async () => {
  loading.value = true
  loadError.value = ''
  try {
    const res = await getAchievements()
    payload.value = res.data?.data || res.data || {}
    categories.value = payload.value.categories || {}
  } catch (err) {
    console.error('获取成就失败:', err)
    loadError.value = '获取成就失败'
  } finally {
    loading.value = false
  }
}

const onClaim = async (item) => {
  if (busy.value) return
  busy.value = true
  try {
    const res = await claimAchievement(item.id)
    const p = res.data
    if (!p?.success) {
      uiStore.showToast(p?.message || '领取失败', 'warning')
      return
    }
    uiStore.showToast(p.message || '领取成功', 'success')
    await fetchList()
    try { await playerStore.fetchPlayer() } catch (e) { /* 资源刷新失败不该挡成就列表 */ }
  } catch (err) {
    uiStore.showApiError(err, '领取失败')
  } finally {
    busy.value = false
  }
}

/** 奖励文案：只在真有奖励时列出，避免出现「奖励：、 修为」这种空项 */
const rewardText = (item) => {
  const parts = []
  if (item.reward?.spirit_stones) parts.push(`${item.reward.spirit_stones} 灵石`)
  if (item.reward?.exp) parts.push(`${item.reward.exp} 修为`)
  return parts.length ? `奖励：${parts.join('、')}` : '无奖励'
}

onMounted(fetchList)
</script>

<template>
  <PanelShell
    title="成就"
    :loading="loading"
    :error="loadError"
    :empty="!loading && !loadError && items.length === 0"
    empty-text="尚无成就记录"
    empty-hint="去历练、闭关、经营洞府，成就自会一一解锁"
    size="xl"
    @close="$emit('close')"
    @retry="fetchList"
  >
    <template #header-actions>
      <Badge tone="gold">已达成 {{ completedCount }} / {{ total }}</Badge>
    </template>

    <div class="space-y-5">
      <div v-for="(list, cat) in grouped" :key="cat">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-fg-muted" aria-hidden="true">{{ categories[cat]?.icon || '✦' }}</span>
          <h3 class="text-[13px] font-bold text-fg-secondary tracking-wide font-display">
            {{ categories[cat]?.name || cat }}
          </h3>
          <span class="text-[11px] text-fg-faint num">{{ list.filter(i => i.completed).length }} / {{ list.length }}</span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-2">
          <PanelCard
            v-for="it in list"
            :key="it.id"
            :padded="true"
            :tone="it.claimed ? 'muted' : it.completed ? 'gold' : 'plain'"
            class="flex flex-col gap-1.5"
          >
            <div class="flex items-start justify-between gap-2">
              <span class="text-[13px] font-bold text-fg-primary leading-snug">{{ it.name }}</span>
              <Badge v-if="it.completed && !it.claimed" tone="gold" solid>可领取</Badge>
              <Badge v-else-if="it.claimed" tone="muted">已领取</Badge>
            </div>
            <p class="text-[11px] text-fg-muted leading-snug min-h-8">{{ it.description }}</p>
            <StatBar
              :value="it.progress"
              :max="it.target"
              :text="`${it.progress} / ${it.target}`"
              :tone="it.completed ? 'gold' : 'azure'"
              :show-value="false"
            />
            <div class="flex items-center justify-between gap-2 mt-0.5">
              <span class="text-[11px] text-fg-faint truncate">{{ rewardText(it) }}</span>
              <AppButton
                size="xs"
                :variant="it.completed && !it.claimed ? 'primary' : 'outline'"
                :disabled="!it.completed || it.claimed"
                :loading="busy && it.completed && !it.claimed"
                @click="onClaim(it)"
              >
                {{ it.claimed ? '已领取' : it.completed ? '领取' : '未达成' }}
              </AppButton>
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  </PanelShell>
</template>
