<!--
  剑诀面板（玩法文档第30节·剑诀线）
  Tab: 我的剑诀 | 剑诀图鉴 | 剑阵
-->
<template>
  <PanelShell title="剑诀" hint="合成参悟 炼剑布阵" size="lg" @close="$emit('close')">
    <Tabs :model-value="tab" :items="tabItems" class="mb-4" @update:model-value="tab = String($event)" />
    <LoadingBlock v-if="loading" />
    <template v-else>
      <div v-if="tab === 'arts'">
        <EmptyState v-if="myArts.length === 0" text="尚未掌握任何剑诀" hint="到「剑诀图鉴」合成" />
        <div v-else class="space-y-3">
          <PanelCard v-for="a in myArts" :key="a.manual_id" tone="gold">
            <div class="flex justify-between items-start mb-2">
              <div>
                <div class="font-bold">{{ a.name }} <span class="text-xs text-fg-muted">{{ a.grade_name }}</span></div>
                <div class="text-xs text-fg-muted">{{ a.description }}</div>
              </div>
              <Badge tone="arcane">剑意 {{ a.insight }}/{{ a.max_insight }}</Badge>
            </div>
            <div class="text-xs text-fg-muted mb-2">
              炼剑 {{ a.sword_stage }}/{{ a.max_stage }} 阶 · 展示加成 +{{ a.display_bonus }}（未接入战斗）
            </div>
            <div class="text-xs text-fg-muted mb-2">
              今日参悟 {{ a.today_comprehend }}/5 · 炼剑 {{ a.today_refine }}/3
              <span v-if="a.active_formation_id" class="text-state-success"> · 剑阵护持中</span>
            </div>
            <div class="flex gap-2">
              <AppButton tone="gold" :disabled="busy" @click="onComprehend(a.manual_id)">参悟剑诀</AppButton>
              <AppButton tone="ghost" :disabled="busy" @click="onRefine(a.manual_id)">炼剑</AppButton>
            </div>
          </PanelCard>
        </div>
      </div>

      <div v-else-if="tab === 'catalog'">
        <div class="space-y-3">
          <PanelCard v-for="m in manuals" :key="m.id">
            <div class="flex justify-between items-start mb-2">
              <div>
                <div class="font-bold">{{ m.name }} <span class="text-xs text-fg-muted">{{ m.grade_name }}</span></div>
                <div class="text-xs text-fg-muted">{{ m.description }}</div>
              </div>
              <Badge :tone="hasManual(m.id) ? 'success' : 'stone'">{{ hasManual(m.id) ? '已掌握' : '未掌握' }}</Badge>
            </div>
            <div class="text-xs text-fg-muted mb-2">
              合成需「{{ global?.compose_fragment_name || '古剑诀残篇' }}」×{{ global?.compose_fragment_need || 3 }}
              + {{ global?.compose_cost_spirit_stones || 200 }} 灵石
            </div>
            <AppButton v-if="!hasManual(m.id)" tone="gold" :disabled="busy" @click="onCompose(m.id)">合成剑诀</AppButton>
          </PanelCard>
        </div>
      </div>

      <div v-else>
        <div class="space-y-3">
          <PanelCard v-for="f in formations" :key="f.id" :tone="f.unlocked_by ? 'success' : 'stone'">
            <div class="font-bold mb-1">{{ f.name }}</div>
            <div class="text-xs text-fg-muted mb-2">{{ f.description }}</div>
            <div class="text-xs text-fg-muted mb-2">
              需 {{ f.required_insight }} 剑意 · 炼剑 {{ f.required_sword_stage }} 阶 · {{ f.cost_spirit_stones }} 灵石
            </div>
            <div class="text-xs text-fg-faint mb-2">{{ f.buff_note }}</div>
            <AppButton :disabled="busy || !f.unlocked_by" @click="onDeploy(f.id)">布下剑阵</AppButton>
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
import {
  getSwordArtInfo, getSwordArtStatus,
  composeSwordArt, comprehendSwordArt, refineSwordArt, deploySwordFormation
} from '../../api/swordArt'

defineEmits(['close'])
const uiStore = useUIStore()
const tab = ref('arts')
const loading = ref(true)
const busy = ref(false)
const global = ref(null)
const manuals = ref([])
const myArts = ref([])
const formations = ref([])

const tabItems = [
  { key: 'arts', label: '我的剑诀' },
  { key: 'catalog', label: '剑诀图鉴' },
  { key: 'form', label: '剑阵' },
]

function hasManual(id) {
  return myArts.value.some(a => a.manual_id === id)
}

async function refresh() {
  loading.value = true
  try {
    const [infoRes, statusRes] = await Promise.all([getSwordArtInfo(), getSwordArtStatus()])
    global.value = infoRes.data?.data?.global || null
    manuals.value = infoRes.data?.data?.manuals || []
    myArts.value = statusRes.data?.data?.arts || []
    formations.value = statusRes.data?.data?.formations || []
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '加载剑诀失败', 'error')
  } finally {
    loading.value = false
  }
}

async function run(fn, okTip) {
  busy.value = true
  try {
    const res = await fn()
    uiStore.showToast(res.data?.message || okTip, res.data?.success === false ? 'error' : 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '操作失败', 'error')
  } finally {
    busy.value = false
  }
}

const onCompose = (id) => run(() => composeSwordArt(id), '合成完成')
const onComprehend = (id) => run(() => comprehendSwordArt(id), '参悟完成')
const onRefine = (id) => run(() => refineSwordArt(id), '炼剑完成')
const onDeploy = (id) => run(() => deploySwordFormation(id), '布阵完成')

onMounted(refresh)
</script>
