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
/** 正在领取的成就 id：只让这一张卡片转圈，不要把整屏可领按钮一起点亮 */
const claimingId = ref('')
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

/**
 * 拉取成就列表。
 * silent=true 时只换数据、不动整页 loading —— PanelShell 的 loading 会整块替换内容，
 * 领取成功后若走非静默刷新，玩家会先看见一屏转圈再看见列表，这是「领取转圈卡顿」的另一半。
 */
const fetchList = async ({ silent = false } = {}) => {
  if (!silent) {
    loading.value = true
    loadError.value = ''
  }
  try {
    const res = await getAchievements()
    payload.value = res.data?.data || res.data || {}
    categories.value = payload.value.categories || {}
    loadError.value = ''
  } catch (err) {
    console.error('获取成就失败:', err)
    if (!silent) loadError.value = '获取成就失败'
  } finally {
    if (!silent) loading.value = false
  }
}

const onClaim = async (item) => {
  if (claimingId.value) return
  claimingId.value = item.id
  try {
    const res = await claimAchievement(item.id)
    const p = res.data
    if (!p?.success) {
      uiStore.showToast(p?.message || '领取失败', 'warning')
      await fetchList({ silent: true })
      return
    }
    // 先本地熄灯：静默刷新前按钮立刻变「已领取」
    item.claimed = true
    uiStore.showToast(p.message || '领取成功', 'success')
    // 列表与资源并行刷新；串行会把转圈拖长到三倍 RTT
    await Promise.all([
      fetchList({ silent: true }),
      playerStore.fetchPlayer().catch(() => { /* 资源刷新失败不该挡成就列表 */ })
    ])
  } catch (err) {
    uiStore.showApiError(err, '领取失败')
    // 后端可能已经落库（如「奖励已领取」），刷新对账，避免按钮一直亮着
    await fetchList({ silent: true }).catch(() => {})
  } finally {
    claimingId.value = ''
  }
}

/**
 * 奖励文案：只在真有奖励时列出，避免出现「奖励：、 修为」这种空项。
 * 物品与称号的名字由服务端在出参那一刻按内容解析（item_name / title_name），
 * 客户端不再抄一份物品典 —— 资料片改一次名字，这里跟着变，代码不用动。
 * 查不到名字时退回键名只是兜底：那种行一旦在界面上出现，说明内容里引用了不存在的物品，
 * 而启动闸 _validateItemKeysDeep 本该拦住它（成就的 reward.items 也在它的扫描范围内）。
 */
const rewardText = (item) => {
  const parts = []
  if (item.reward?.spirit_stones) parts.push(`${item.reward.spirit_stones} 灵石`)
  if (item.reward?.exp) parts.push(`${item.reward.exp} 修为`)
  for (const entry of item.reward?.items || []) {
    parts.push(`${entry.item_name || entry.item_key}×${entry.quantity || 1}`)
  }
  if (item.reward?.title_id) parts.push(`称号「${item.reward.title_name || item.reward.title_id}」`)
  return parts.length ? `奖励：${parts.join('、')}` : '无奖励'
}

onMounted(() => fetchList())
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
    @retry="() => fetchList()"
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
                :disabled="!it.completed || it.claimed || !!claimingId"
                :loading="claimingId === it.id"
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
