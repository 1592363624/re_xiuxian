<!--
  落云宗·云梦灵眼定脉面板（玩法文档第25节）
-->
<template>
  <PanelShell title="云梦灵眼定脉" hint="落云宗专属 · 梳理灵眼根脉" size="lg" @close="$emit('close')">
    <LoadingBlock v-if="loading" />
    <template v-else>
      <PanelCard tone="emerald" class="mb-3">
        <div class="flex flex-wrap justify-between gap-3">
          <div>
            <div class="text-xs text-fg-muted">今日脉象</div>
            <div class="text-lg font-bold">{{ status?.tree?.today_vein_name || '平脉' }}</div>
          </div>
          <div>
            <div class="text-xs text-fg-muted">成熟度</div>
            <div class="num font-bold">{{ status?.tree?.growth ?? 0 }}</div>
          </div>
          <div>
            <div class="text-xs text-fg-muted">脉稳</div>
            <div class="num font-bold">{{ status?.tree?.vein_stability ?? 0 }}</div>
          </div>
          <div>
            <div class="text-xs text-fg-muted">浊息</div>
            <div class="num font-bold" :class="pollutionClass">{{ status?.tree?.pollution ?? 0 }}</div>
          </div>
        </div>
        <div class="text-xs text-fg-muted mt-2">
          今日定脉 {{ status?.me?.today_orders ?? 0 }}/{{ status?.me?.daily_limit ?? 6 }}
          · 冲脉 {{ status?.me?.today_charges ?? 0 }}/{{ status?.me?.max_charge_per_day ?? 2 }}
          · 灵根 {{ rootLabel }}
        </div>
      </PanelCard>

      <div class="grid sm:grid-cols-2 gap-2 mb-4">
        <PanelCard v-for="a in status?.actions || []" :key="a.id">
          <div class="font-bold mb-1">{{ a.name }}</div>
          <div class="text-xs text-fg-muted mb-2">{{ a.description }}</div>
          <div class="flex flex-wrap gap-2 items-center">
            <AppButton size="sm" tone="gold" :disabled="busy" @click="onAct(a)">{{ a.name }}</AppButton>
            <select
              v-if="a.uses_element"
              v-model="elements[a.id]"
              class="bg-surface-hover border border-line rounded px-2 py-1 text-xs"
            >
              <option v-for="e in elementOptions" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </div>
        </PanelCard>
      </div>

      <div class="grid sm:grid-cols-2 gap-3">
        <div>
          <div class="text-sm font-bold mb-2">分枝榜</div>
          <div class="space-y-1">
            <div v-for="r in status?.boards?.branch || []" :key="r.player_id" class="text-xs flex justify-between border-b border-line py-1">
              <span>#{{ r.rank }} {{ r.nickname }}</span>
              <span class="num">{{ r.merit }} 功绩</span>
            </div>
          </div>
        </div>
        <div>
          <div class="text-sm font-bold mb-2">净化榜</div>
          <div class="space-y-1">
            <div v-for="r in status?.boards?.purify || []" :key="r.player_id" class="text-xs flex justify-between border-b border-line py-1">
              <span>#{{ r.rank }} {{ r.nickname }}</span>
              <span class="num">{{ r.purify }} 净化</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </PanelShell>
</template>

<script setup>
import { ref, onMounted, computed, reactive } from 'vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import AppButton from '../ui/AppButton.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import { useUIStore } from '../../stores/ui'
import { getDingmaiStatus, actDingmai } from '../../api/dingmai'

defineEmits(['close'])
const uiStore = useUIStore()
const loading = ref(true)
const busy = ref(false)
const status = ref(null)
const elements = reactive({ infuse: 'metal', stabilize: 'wood', charge: 'fire' })

const elementOptions = [
  { id: 'metal', name: '金' },
  { id: 'wood', name: '木' },
  { id: 'water', name: '水' },
  { id: 'fire', name: '火' },
  { id: 'earth', name: '土' },
]

const rootLabel = computed(() => {
  const map = { single: '单灵根', multi: '多灵根', false: '伪灵根', waste: '废灵根' }
  return map[status.value?.me?.root_type] || '未知'
})
const pollutionClass = computed(() => {
  const p = status.value?.tree?.pollution_level
  return p === 'critical' ? 'text-state-danger' : p === 'high' ? 'text-gold-400' : ''
})

async function refresh() {
  loading.value = true
  try {
    const res = await getDingmaiStatus()
    status.value = res.data?.data || null
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '加载定脉失败（需落云宗）', 'error')
  } finally {
    loading.value = false
  }
}

async function onAct(action) {
  busy.value = true
  try {
    const element = action.uses_element ? elements[action.id] : undefined
    const res = await actDingmai(action.id, element)
    uiStore.showToast(res.data?.message || '定脉完成', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '定脉失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
</script>
