<!--
  宗门外交面板（玩法文档第33节·宗门外交）
  Tab: 天下大势 | 本宗关系
-->
<template>
  <PanelShell title="宗门外交" hint="天下大势 结盟敌对" size="lg" @close="$emit('close')">
    <Tabs :model-value="tab" :items="tabItems" class="mb-4" @update:model-value="tab = String($event)" />
    <LoadingBlock v-if="loading" />
    <template v-else>
      <div v-if="tab === 'world'">
        <PanelCard class="mb-3">
          <div class="text-sm text-fg-muted mb-1">天下大势</div>
          <div class="flex gap-4 text-sm">
            <span>同盟 <b class="num text-state-success">{{ world?.summary?.allies ?? 0 }}</b></span>
            <span>敌对 <b class="num text-state-danger">{{ world?.summary?.hostiles ?? 0 }}</b></span>
          </div>
        </PanelCard>
        <div class="space-y-2">
          <div v-for="p in world?.pairs || []" :key="p.sect_a_id + p.sect_b_id" class="border border-line rounded-panel p-3 flex justify-between items-center">
            <div>
              <div class="font-bold">{{ p.sect_a_name }} ↔ {{ p.sect_b_name }}</div>
              <div class="text-xs text-fg-muted">{{ p.note || '—' }}</div>
            </div>
            <div class="text-right">
              <div class="num font-bold" :class="relClass(p.relation)">{{ p.relation }}</div>
              <Badge :tone="bandTone(p.band)">{{ p.band?.name || '中立' }}</Badge>
            </div>
          </div>
        </div>
      </div>

      <div v-else>
        <PanelCard tone="gold" class="mb-3">
          <div class="font-bold mb-1">{{ mine?.my_sect_name || '未入宗' }}</div>
          <div class="text-xs text-fg-muted">身份：{{ mine?.my_role || '—' }}</div>
        </PanelCard>
        <EmptyState v-if="(mine?.relations || []).length === 0" text="暂无外交关系" />
        <div v-else class="space-y-3">
          <PanelCard v-for="r in mine?.relations || []" :key="r.other_sect_id">
            <div class="flex justify-between items-center mb-2">
              <div class="font-bold">{{ r.other_sect_name }}</div>
              <div class="text-right">
                <div class="num font-bold" :class="relClass(r.relation)">{{ r.relation }}</div>
                <Badge :tone="bandTone(r.band)">{{ r.band?.name || '中立' }}</Badge>
              </div>
            </div>
            <div class="flex flex-wrap gap-2">
              <AppButton size="sm" tone="ghost" :disabled="busy" @click="onAct(r.other_sect_id, 'goodwill')">示好</AppButton>
              <AppButton size="sm" tone="gold" :disabled="busy" @click="onAct(r.other_sect_id, 'ally')">结盟</AppButton>
              <AppButton size="sm" tone="danger" :disabled="busy" @click="onAct(r.other_sect_id, 'hostile')">敌对</AppButton>
              <AppButton size="sm" tone="ghost" :disabled="busy" @click="onAct(r.other_sect_id, 'break_relation')">解除</AppButton>
            </div>
          </PanelCard>
        </div>
      </div>
    </template>
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
import { getWorldSituation, getMySectRelations, actSectDiplomacy } from '../../api/sectDiplomacy'

defineEmits(['close'])
const uiStore = useUIStore()
const tab = ref('world')
const loading = ref(true)
const busy = ref(false)
const world = ref(null)
const mine = ref(null)

const tabItems = [
  { key: 'world', label: '天下大势' },
  { key: 'mine', label: '本宗关系' },
]

function relClass(v) {
  if (v >= 60) return 'text-state-success'
  if (v <= -20) return 'text-state-danger'
  return ''
}
function bandTone(b) {
  return b?.color || 'stone'
}

async function refresh() {
  loading.value = true
  try {
    const [wRes, mRes] = await Promise.all([getWorldSituation(), getMySectRelations()])
    world.value = wRes.data?.data || null
    mine.value = mRes.data?.data || null
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '加载外交失败', 'error')
  } finally {
    loading.value = false
  }
}

async function onAct(target, action) {
  busy.value = true
  try {
    const res = await actSectDiplomacy(target, action)
    uiStore.showToast(res.data?.message || '外交行动完成', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '外交失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
</script>
