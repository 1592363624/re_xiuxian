<script setup>
/**
 * 系统任务「尘缘指归」面板
 * 对应后端 /api/system-quest：一条独立线性链（识途/立心/破障），
 * 完成当前环自动发奖并自动续环，本面板只展示与跳转，没有「领取」按钮。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { getSystemQuestBoard } from '../../api/systemQuest'
import { router, panelRoute } from '../../router'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import StatBar from '../ui/StatBar.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'

const uiStore = useUIStore()
const playerStore = usePlayerStore()

defineEmits(['close'])

const payload = ref(null)
const loading = ref(false)
const loadError = ref('')

const chain = computed(() => payload.value?.chain || {})
const acts = computed(() => payload.value?.acts || [])
const nodes = computed(() => payload.value?.nodes || [])
const currentNode = computed(() => nodes.value.find(n => n.state === 'active') || null)

const nodesByAct = computed(() => {
  const map = {}
  for (const n of nodes.value) {
    if (!map[n.act]) map[n.act] = []
    map[n.act].push(n)
  }
  for (const key of Object.keys(map)) {
    map[key].sort((a, b) => (a.order || 0) - (b.order || 0))
  }
  return map
})

const rewardText = (reward) => {
  if (!reward) return ''
  const parts = []
  if (reward.spirit_stones) parts.push(`${reward.spirit_stones} 灵石`)
  if (reward.exp) parts.push(`${reward.exp} 修为`)
  for (const entry of reward.items || []) {
    parts.push(`${entry.item_name || entry.item_key}×${entry.quantity || 1}`)
  }
  if (reward.title_id) parts.push(`称号「${reward.title_name || reward.title_id}」`)
  return parts.length ? parts.join('、') : '无'
}

const goPanel = (panelId) => {
  if (!panelId) return
  router.push(panelRoute(panelId))
}

const fetchBoard = async ({ silent = false } = {}) => {
  if (!silent) {
    loading.value = true
    loadError.value = ''
  }
  try {
    const res = await getSystemQuestBoard()
    // 路由回的是 { success, chain, acts, nodes, ... }；兼容多包一层 data 的形状
    payload.value = res.data?.chain ? res.data : (res.data?.data || {})
    loadError.value = ''
  } catch (err) {
    console.error('获取指归失败:', err)
    if (!silent) loadError.value = '获取尘缘指归失败'
  } finally {
    if (!silent) loading.value = false
  }
}

const onQuestUpdate = (payloadEvt) => {
  const p = payloadEvt?.detail || payloadEvt
  if (p?.updateType === 'system_quest') {
    fetchBoard({ silent: true })
    playerStore.scheduleFetchPlayer?.().catch(() => {})
  }
}

onMounted(() => {
  fetchBoard()
  window.addEventListener('player:updated', onQuestUpdate)
})

onUnmounted(() => {
  window.removeEventListener('player:updated', onQuestUpdate)
})
</script>

<template>
  <PanelShell
    title="尘缘指归"
    :hint="chain.short_name ? `玉简 · ${chain.short_name}` : '指归玉简'"
    :loading="loading"
    :error="loadError"
    size="lg"
    @close="$emit('close')"
    @retry="() => fetchBoard()"
  >
    <template #header-actions>
      <Badge tone="gold">{{ payload?.completed_count || 0 }} / {{ payload?.total_count || 0 }}</Badge>
      <Badge v-if="chain.status === 'done'" tone="muted">已归尘</Badge>
      <Badge v-else tone="azure">进行中</Badge>
    </template>

    <div class="space-y-5">
      <!-- 玉简引言 / 终章 -->
      <PanelCard padded tone="gold">
        <p class="text-[13px] leading-relaxed text-fg-secondary">
          {{ chain.status === 'done' ? chain.ending : chain.intro }}
        </p>
        <p v-if="chain.status === 'done' && chain.final_title_id" class="mt-2 text-[12px] text-gold-400">
          称号已留识海：{{ chain.final_title_id === 'zhigui_returned' ? '已识归途' : chain.final_title_id }}
        </p>
      </PanelCard>

      <!-- 当前环大卡 -->
      <PanelCard v-if="currentNode" padded tone="plain" class="border-l-2 border-l-gold-500">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="text-[11px] text-fg-faint tracking-widest">当前一环</div>
            <h3 class="text-base font-display font-bold text-fg-primary mt-0.5">{{ currentNode.name }}</h3>
            <p class="text-[12px] text-fg-muted mt-1">{{ currentNode.tagline }}</p>
          </div>
          <Badge tone="gold" solid>进行中</Badge>
        </div>
        <p class="text-[12px] text-fg-secondary leading-relaxed mt-3">{{ currentNode.body }}</p>
        <p v-if="currentNode.teach" class="text-[11px] text-azure-300 mt-2">教你：{{ currentNode.teach }}</p>
        <p v-if="currentNode.hint" class="text-[12px] text-amber-200/90 mt-2">→ {{ currentNode.hint }}</p>

        <div class="mt-3 space-y-1.5">
          <div
            v-for="obj in currentNode.objectives"
            :key="obj.id"
            class="flex items-center gap-2"
          >
            <span
              class="inline-block w-4 h-4 rounded border text-[10px] leading-4 text-center shrink-0"
              :class="obj.done ? 'bg-gold-500 border-gold-500 text-black' : 'border-line-strong text-transparent'"
              aria-hidden="true"
            >✓</span>
            <span class="text-[12px] flex-1" :class="obj.done ? 'text-fg-faint line-through' : 'text-fg-primary'">
              {{ obj.label }}
            </span>
            <span v-if="obj.target > 1" class="text-[11px] num text-fg-faint">{{ obj.progress }}/{{ obj.target }}</span>
          </div>
        </div>

        <div class="mt-2" v-if="currentNode.objectives?.some(o => o.target > 1)">
          <StatBar
            :value="currentNode.objectives.filter(o => o.done).length"
            :max="currentNode.objectives.length"
            :text="`${currentNode.objectives.filter(o => o.done).length} / ${currentNode.objectives.length}`"
            tone="gold"
            :show-value="false"
          />
        </div>

        <div class="mt-2 text-[11px] text-fg-faint">完成即发奖 · 自动翻开下一环</div>
        <div class="text-[11px] text-fg-muted mt-1">预览奖励：{{ rewardText(currentNode.rewards) }}</div>

        <div class="mt-3 flex gap-2">
          <AppButton
            v-if="currentNode.panel"
            size="sm"
            variant="primary"
            @click="goPanel(currentNode.panel)"
          >
            去这里
          </AppButton>
        </div>
      </PanelCard>

      <PanelCard v-else-if="chain.status === 'done'" padded tone="muted">
        <p class="text-[13px] text-fg-secondary">玉简已碎，指归落幕。去写你自己的长生。</p>
      </PanelCard>

      <!-- 三卷时间轴 -->
      <div v-for="act in acts" :key="act.id" class="space-y-2">
        <div class="flex items-baseline gap-2">
          <h3 class="text-[13px] font-display font-bold text-fg-secondary">
            卷{{ ['一', '二', '三'][act.id - 1] || act.id }} · {{ act.name }}
          </h3>
          <span class="text-[11px] text-fg-faint">{{ act.subtitle }}</span>
        </div>
        <div class="space-y-1.5">
          <PanelCard
            v-for="n in nodesByAct[act.id] || []"
            :key="n.id"
            :padded="true"
            :tone="n.state === 'done' ? 'muted' : n.state === 'active' ? 'gold' : 'plain'"
            class="flex flex-col gap-1"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[11px] num text-fg-faint shrink-0">{{ n.order }}</span>
                <span
                  class="text-[13px] font-bold truncate"
                  :class="n.state === 'locked' ? 'text-fg-faint' : 'text-fg-primary'"
                >
                  {{ n.name }}
                </span>
              </div>
              <Badge v-if="n.state === 'done'" tone="muted">已完</Badge>
              <Badge v-else-if="n.state === 'active'" tone="gold" solid>当前</Badge>
              <Badge v-else tone="muted">未至</Badge>
            </div>
            <p v-if="n.state !== 'locked' && n.tagline" class="text-[11px] text-fg-muted">
              {{ n.tagline }}
            </p>
            <p v-if="n.state === 'active' && n.body" class="text-[11px] text-fg-faint leading-snug">
              {{ n.body }}
            </p>
            <ul v-if="n.state === 'active' && n.objectives?.length" class="mt-0.5 space-y-0.5">
              <li
                v-for="obj in n.objectives"
                :key="obj.id"
                class="text-[11px]"
                :class="obj.done ? 'text-fg-faint line-through' : 'text-fg-secondary'"
              >
                · {{ obj.label }}
              </li>
            </ul>
            <div v-if="n.rewards && n.state !== 'locked'" class="text-[11px] text-fg-faint">
              奖励：{{ rewardText(n.rewards) }}
            </div>
          </PanelCard>
        </div>
        <p v-if="act.epilogue && (nodesByAct[act.id] || []).every(x => x.state === 'done')" class="text-[11px] text-gold-300/80 italic">
          {{ act.epilogue }}
        </p>
      </div>
    </div>
  </PanelShell>
</template>
