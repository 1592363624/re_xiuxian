<!--
  兽潮 · 妖兽入侵面板
  Tab: 战况 | 捐献 | 排行 | 说明
  两阶段：捐献完成锁灵大阵 → 全服讨伐；此前服务端完整、客户端零入口。
-->
<template>
  <PanelShell
    title="兽潮"
    hint="锁灵大阵 · 全服讨伐"
    size="xl"
    :loading="loading && !active"
    @close="emit('close')"
  >
    <template #header-actions>
      <AppButton size="xs" variant="ghost" @click="refresh">刷新</AppButton>
    </template>

    <Tabs v-model="tab" :items="tabItems" class="mb-4" />

    <!-- 无活跃事件 -->
    <EmptyState
      v-if="!active"
      text="当前没有妖兽入侵"
      hint="妖兽潮由 GM 开启；开启后全服捐献锁灵大阵，随后共同讨伐。"
    />

    <template v-else>
      <!-- 战况 -->
      <div v-if="tab === 'battle'">
        <PanelCard tone="danger" class="mb-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div class="text-lg font-bold text-rose-200">{{ active.beast_name }}</div>
              <div class="text-xs text-fg-muted mt-1">
                阶段：
                <Badge :tone="active.phase === 'donation' ? 'gold' : active.phase === 'battle' ? 'danger' : 'muted'">
                  {{ phaseLabel(active.phase) }}
                </Badge>
                <span class="ml-2">倒计时 {{ formatCountdown(countdown) }}</span>
                <span class="ml-2">参与者 {{ active.participant_count }}</span>
              </div>
            </div>
            <div class="text-right text-xs text-fg-muted">
              <div>境界门槛 rank ≥ {{ active.realm_rank_min }}</div>
              <div>累计伤害 {{ active.total_damage_taken }}</div>
            </div>
          </div>
          <div class="mt-3">
            <StatBar
              label="妖兽气血"
              :value="Number(active.hp_current) || 0"
              :max="Number(active.hp_max) || 1"
              tone="blood"
              :text="`${active.hp_current} / ${active.hp_max}`"
            />
          </div>
          <div v-if="active.phase === 'donation'" class="mt-2">
            <StatBar
              label="锁灵大阵"
              :value="active.donation_current"
              :max="active.donation_target || 1"
              tone="gold"
              :text="`${active.donation_current} / ${active.donation_target}`"
            />
          </div>
        </PanelCard>

        <PanelCard v-if="lastAttack" class="mb-3" :tone="lastAttack.beast?.defeated ? 'gold' : 'muted'">
          <div class="font-bold mb-1">
            {{ lastAttack.attack?.skill_used || '攻击' }}
            造成 {{ lastAttack.attack?.damage }} 伤害
            <span v-if="lastAttack.attack?.is_crit" class="text-gold-300">（暴击）</span>
          </div>
          <div class="text-xs text-fg-muted space-y-0.5">
            <div>妖兽剩余 {{ lastAttack.beast?.hp_current }} / {{ lastAttack.beast?.hp_max }}</div>
            <div v-if="lastAttack.counter?.triggered">反击 {{ lastAttack.counter.damage }}</div>
            <div>
              战场气血 {{ lastAttack.player?.battle_hp_after }} / {{ lastAttack.player?.battle_hp_max }}
              <span v-if="lastAttack.player?.is_dead" class="text-rose-300"> · 你已陨落</span>
            </div>
            <div v-if="lastAttack.settle?.summary" class="text-gold-300">{{ lastAttack.settle.summary }}</div>
          </div>
        </PanelCard>

        <PanelCard v-if="detail?.description" class="mb-3">
          <div class="text-xs text-fg-muted leading-relaxed whitespace-pre-line">{{ detail.description }}</div>
        </PanelCard>

        <div class="flex flex-wrap gap-2">
          <AppButton
            variant="danger"
            :disabled="busy || active.phase !== 'battle' || active.status !== 'active'"
            @click="onAttack('basic')"
          >普通攻击</AppButton>
          <AppButton
            variant="primary"
            :disabled="busy || active.phase !== 'battle' || active.status !== 'active'"
            @click="onAttack('skill')"
          >施展技能</AppButton>
          <AppButton
            variant="purple"
            :disabled="busy || active.phase !== 'battle' || active.status !== 'active'"
            @click="onAttack('ultimate')"
          >绝招</AppButton>
          <AppButton variant="outline" :disabled="busy" @click="onRevive">原地复活</AppButton>
          <AppButton variant="ghost" :disabled="busy" @click="onRetreat">撤退</AppButton>
        </div>
        <p class="text-[11px] text-fg-faint mt-2">
          战斗阶段攻击有冷却；虚拟战场气血归零后需复活（耗灵石）或撤退（短时禁入）。
        </p>
      </div>

      <!-- 捐献 -->
      <div v-else-if="tab === 'donate'">
        <PanelCard class="mb-3">
          <div class="text-sm text-fg-muted mb-2">捐献灵物完成锁灵大阵，达标后自动进入讨伐阶段。</div>
          <StatBar
            label="捐献进度"
            :value="active.donation_current"
            :max="active.donation_target || 1"
            tone="gold"
            :text="`${active.donation_percentage ?? 0}%`"
          />
        </PanelCard>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
          <div>
            <label class="text-xs text-fg-muted">物品键</label>
            <input
              v-model.trim="donateForm.itemKey"
              class="w-full mt-1 px-3 py-2 bg-surface-sunken border border-line rounded-control text-fg-primary text-sm"
              placeholder="spirit_stones / ling_cao / yao_dan"
            />
          </div>
          <div>
            <label class="text-xs text-fg-muted">数量</label>
            <input
              v-model.number="donateForm.quantity"
              type="number"
              min="1"
              class="w-full mt-1 px-3 py-2 bg-surface-sunken border border-line rounded-control text-fg-primary text-sm"
            />
          </div>
          <div class="flex items-end">
            <AppButton
              class="w-full"
              :disabled="busy || active.phase !== 'donation' || !donateForm.itemKey || donateForm.quantity < 1"
              @click="onDonate"
            >捐献</AppButton>
          </div>
        </div>

        <PanelCard v-if="myContribution">
          <div class="text-sm font-bold mb-2">我的捐献</div>
          <pre class="text-xs text-fg-muted whitespace-pre-wrap">{{ JSON.stringify(myContribution, null, 2) }}</pre>
        </PanelCard>
      </div>

      <!-- 排行 -->
      <div v-else-if="tab === 'rank'">
        <EmptyState v-if="ranking.length === 0" text="暂无伤害数据" />
        <div v-else class="space-y-2">
          <div
            v-for="r in ranking"
            :key="r.player_id"
            class="border border-line rounded-panel p-3 flex items-center justify-between"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full bg-surface-hover grid place-items-center num font-bold">{{ r.rank }}</div>
              <div>
                <div class="font-bold">{{ r.player_nickname }}</div>
                <div class="text-xs text-fg-muted">{{ r.player_realm }} · 攻击 {{ r.attack_count }} 次</div>
              </div>
            </div>
            <div class="text-right text-xs">
              <div class="num font-bold text-rose-300">{{ r.total_damage }}</div>
              <div class="text-fg-faint">{{ r.damage_percentage }}%</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 说明 -->
      <div v-else class="text-sm text-fg-secondary whitespace-pre-line leading-relaxed">
        {{ helpText }}
      </div>
    </template>
  </PanelShell>
</template>

<script setup>
/**
 * 兽潮面板逻辑
 * 业务全在 BeastInvasionService；前端只拉状态、发操作、展示回执。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import Tabs from '../ui/Tabs.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import StatBar from '../ui/StatBar.vue'
import EmptyState from '../ui/EmptyState.vue'
import { useUIStore } from '../../stores/ui'
import {
  getActiveInvasion,
  getInvasionDetail,
  getMyContribution,
  getAttackRanking,
  getBeastInvasionHelp,
  contributeItem,
  attackBeast,
  reviveInBattle,
  retreatBattle
} from '../../api/beastInvasion'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

const tab = ref('battle')
const loading = ref(true)
const busy = ref(false)
const active = ref(null)
const detail = ref(null)
const ranking = ref([])
const myContribution = ref(null)
const helpText = ref('加载中…')
const lastAttack = ref(null)
const countdown = ref(0)
const donateForm = ref({ itemKey: 'ling_cao', quantity: 1 })
let tickTimer = null

const tabItems = computed(() => [
  { key: 'battle', label: '战况' },
  { key: 'donate', label: '捐献' },
  { key: 'rank', label: '排行' },
  { key: 'help', label: '说明' }
])

function phaseLabel(phase) {
  if (phase === 'donation') return '捐献锁灵'
  if (phase === 'battle') return '全服讨伐'
  return '已结束'
}

function formatCountdown(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

async function refresh() {
  loading.value = true
  try {
    const res = await getActiveInvasion()
    active.value = res.data?.data ?? res.data ?? null
    countdown.value = active.value?.countdown_seconds || 0
    if (active.value?.id) {
      const id = active.value.id
      const [detailRes, rankRes, myRes] = await Promise.all([
        getInvasionDetail(id).catch(() => null),
        getAttackRanking(id, 50).catch(() => null),
        getMyContribution(id).catch(() => null)
      ])
      detail.value = detailRes?.data?.data ?? detailRes?.data ?? null
      if (detail.value?.countdown_seconds != null) countdown.value = detail.value.countdown_seconds
      ranking.value = rankRes?.data?.data?.ranking || rankRes?.data?.ranking || []
      myContribution.value = myRes?.data?.data ?? myRes?.data ?? null
    } else {
      detail.value = null
      ranking.value = []
      myContribution.value = null
    }
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '加载兽潮失败', 'error')
  } finally {
    loading.value = false
  }
}

async function loadHelp() {
  try {
    const res = await getBeastInvasionHelp()
    helpText.value = res.data?.data?.content || res.data?.content || '暂无说明'
  } catch {
    helpText.value = '说明加载失败'
  }
}

async function onDonate() {
  if (!active.value?.id) return
  busy.value = true
  try {
    const res = await contributeItem(active.value.id, donateForm.value.itemKey, donateForm.value.quantity)
    uiStore.showToast(res.data?.message || '捐献成功', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '捐献失败', 'error')
  } finally {
    busy.value = false
  }
}

async function onAttack(skillId) {
  if (!active.value?.id) return
  busy.value = true
  try {
    const res = await attackBeast(active.value.id, skillId)
    lastAttack.value = res.data?.data ?? res.data
    uiStore.showToast(res.data?.message || '攻击成功', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '攻击失败', 'error')
  } finally {
    busy.value = false
  }
}

async function onRevive() {
  if (!active.value?.id) return
  busy.value = true
  try {
    const res = await reviveInBattle(active.value.id)
    uiStore.showToast(res.data?.message || '复活成功', 'success')
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '复活失败', 'error')
  } finally {
    busy.value = false
  }
}

async function onRetreat() {
  if (!active.value?.id) return
  busy.value = true
  try {
    const res = await retreatBattle(active.value.id)
    uiStore.showToast(res.data?.message || '已撤退', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '撤退失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadHelp()])
  tickTimer = setInterval(() => {
    if (countdown.value > 0) countdown.value -= 1
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})
</script>
