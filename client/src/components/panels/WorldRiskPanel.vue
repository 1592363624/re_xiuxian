<script setup>
/**
 * 天道异闻面板：神魂状态 / 风雷翅奇袭 / 世界凶名
 */
import { ref, onMounted } from 'vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import AppButton from '../ui/AppButton.vue'
import apiClient from '../../api/index'

const emit = defineEmits(['close'])
const loading = ref(false)
const soul = ref(null)
const wings = ref(null)
const world = ref(null)
const message = ref('')
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [s, w, e] = await Promise.all([
      apiClient.get('/soul-risk/status').catch(() => ({ data: null })),
      apiClient.get('/wind-wings/status').catch(() => ({ data: null })),
      apiClient.get('/world-events/status').catch(() => ({ data: null }))
    ])
    soul.value = s.data || null
    wings.value = w.data || null
    world.value = e.data || null
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function raid(mode) {
  loading.value = true
  error.value = ''
  try {
    const res = await apiClient.post('/wind-wings/raid', { mode })
    message.value = res.message || res.data?.message || '已施展'
    await load()
  } catch (e) {
    error.value = e.message || '奇袭失败'
  } finally {
    loading.value = false
  }
}

async function triggerEvent() {
  loading.value = true
  try {
    const res = await apiClient.post('/world-events/trigger')
    message.value = res.message || '已触发'
    await load()
  } catch (e) {
    error.value = e.message || '触发失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <PanelShell title="天道异闻" size="lg" :loading="loading" @close="emit('close')">
    <div class="space-y-4">
      <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
      <div v-if="message" class="text-sm text-gold-500">{{ message }}</div>

      <PanelCard title="神魂状态">
        <div v-if="soul" class="text-sm space-y-1">
          <div>今日斗法：{{ soul.duel_used_today }} / {{ soul.duel_limit }}</div>
          <div>仇敌数：{{ (soul.enemies || []).length }} · 复仇加成 +{{ Math.round((soul.revenge_power_bonus || 0) * 100) }}%</div>
          <div v-if="soul.is_unstable" class="text-red-300">⚠ 神魂动荡中（战力 -{{ Math.round((soul.unstable_power_penalty || 0) * 100) }}%）</div>
          <div v-if="soul.heartbroken" class="text-amber-300">⚠ 道心破碎中</div>
          <div v-if="!soul.is_unstable && !soul.heartbroken" class="text-emerald-300">神魂安稳</div>
        </div>
      </PanelCard>

      <PanelCard title="风雷翅 · 奇袭">
        <div v-if="wings" class="text-sm space-y-2">
          <div class="text-xs text-fg-muted">
            冷却缩减 {{ Math.round((wings.cooldown_reduction || 0) * 100) }}% · 高阶逃生 +{{ Math.round((wings.escape_bonus_vs_higher || 0) * 100) }}%
            <span v-if="wings.locked" class="ml-2 text-amber-300">神通反锁中</span>
          </div>
          <div class="text-xs" :class="wings.raid_ready ? 'text-emerald-300' : 'text-fg-muted'">
            风雷降世：{{ wings.raid_ready ? '可施展' : '冷却中' }}
          </div>
          <div class="flex gap-2 flex-wrap">
            <AppButton size="sm" :disabled="!wings.raid_ready" @click="raid('steal')">奇袭夺宝</AppButton>
            <AppButton size="sm" :disabled="!wings.raid_ready" @click="raid('break')">寂灭破阵</AppButton>
            <AppButton size="sm" variant="danger" :disabled="!wings.raid_ready" @click="raid('instant')">血色瞬杀</AppButton>
          </div>
        </div>
      </PanelCard>

      <PanelCard title="天道凶名">
        <div v-if="world" class="text-sm space-y-1">
          <div>杀戮：{{ world.kills }}</div>
          <div v-if="world.notorious_title" class="text-red-300">
            当前凶名【{{ world.notorious_title.name }}】战力 +{{ Math.round((world.notorious_title.power_bonus || 0) * 100) }}%
          </div>
          <div v-else class="text-fg-muted">尚无凶名</div>
          <div class="text-xs text-fg-muted mt-2">
            <span v-for="t in world.thresholds || []" :key="t.title_id" class="mr-3">
              {{ t.kills }} 杀 → {{ t.name }}
            </span>
          </div>
          <AppButton size="sm" variant="ghost" class="mt-2" @click="triggerEvent">推演天道事件</AppButton>
        </div>
      </PanelCard>
    </div>
  </PanelShell>
</template>
