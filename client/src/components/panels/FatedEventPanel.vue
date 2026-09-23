<!--
  事件奇遇面板（玩法文档第22节·隐藏/事件式命令）
-->
<template>
  <PanelShell title="奇遇" hint="天机垂青 抉择定缘" size="md" @close="$emit('close')">
    <LoadingBlock v-if="loading" />
    <template v-else>
      <PanelCard v-if="active" tone="arcane" class="mb-3">
        <div class="font-bold text-lg mb-1">{{ active.name }}</div>
        <p class="text-sm text-fg-muted mb-3">{{ active.description }}</p>
        <div v-if="active.command_hints?.length" class="text-xs text-fg-faint mb-3">
          相关命令：{{ active.command_hints.join(' / ') }}
        </div>

        <!-- 答题 -->
        <div v-if="active.quiz" class="mb-2">
          <div class="font-bold mb-2">{{ active.quiz.question }}</div>
          <div class="grid gap-2">
            <AppButton
              v-for="opt in active.quiz.options"
              :key="opt.id"
              tone="ghost"
              :disabled="busy"
              @click="onChoose(opt.id)"
            >{{ opt.id }}. {{ opt.label }}</AppButton>
          </div>
        </div>

        <!-- 抉择 -->
        <div v-else class="grid gap-2">
          <div v-for="c in active.choices" :key="c.id" class="border border-line rounded-panel p-3">
            <div class="font-bold mb-1">{{ c.label }}</div>
            <div class="text-xs text-fg-muted mb-2">{{ c.description }}</div>
            <AppButton tone="gold" :disabled="busy" @click="onChoose(c.id)">{{ c.label }}</AppButton>
          </div>
        </div>
      </PanelCard>

      <PanelCard v-else class="mb-3">
        <EmptyState text="当前没有未决奇遇" hint="点下方按钮感应天机" />
        <div class="mt-3 text-center">
          <AppButton tone="gold" :disabled="busy" @click="onTrigger">感应天机</AppButton>
        </div>
      </PanelCard>

      <div class="text-xs text-fg-muted mb-2">最近奇遇</div>
      <EmptyState v-if="recent.length === 0" text="尚无奇遇记录" />
      <div v-else class="space-y-2">
        <div v-for="(r, i) in recent" :key="i" class="border border-line rounded-panel p-2 text-sm flex justify-between">
          <span>{{ r.event_name }}</span>
          <Badge :tone="r.result === 'success' || r.result === 'correct' ? 'success' : r.result === 'fail' || r.result === 'wrong' ? 'danger' : 'stone'">
            {{ r.result || r.status }}
          </Badge>
        </div>
      </div>
    </template>
  </PanelShell>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import EmptyState from '../ui/EmptyState.vue'
import { useUIStore } from '../../stores/ui'
import { getFatedStatus, triggerFatedEvent, chooseFatedEvent } from '../../api/fatedEvent'

defineEmits(['close'])
const uiStore = useUIStore()
const loading = ref(true)
const busy = ref(false)
const active = ref(null)
const recent = ref([])

async function refresh() {
  loading.value = true
  try {
    const res = await getFatedStatus()
    active.value = res.data?.data?.active || null
    recent.value = res.data?.data?.recent || []
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '加载奇遇失败', 'error')
  } finally {
    loading.value = false
  }
}

async function onTrigger() {
  busy.value = true
  try {
    const res = await triggerFatedEvent()
    uiStore.showToast(res.data?.message || '天机感应', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '感应失败', 'error')
  } finally {
    busy.value = false
  }
}

async function onChoose(id) {
  busy.value = true
  try {
    const res = await chooseFatedEvent(id)
    uiStore.showToast(res.data?.message || '抉择已定', 'success')
    await refresh()
  } catch (e) {
    uiStore.showToast(e?.response?.data?.message || '抉择失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
</script>
