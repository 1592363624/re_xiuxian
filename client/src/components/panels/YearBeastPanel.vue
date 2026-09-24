<script setup>
/**
 * 年兽大作战面板：组队、破盾、集火、领赏
 */
import { ref, onMounted } from 'vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import AppButton from '../ui/AppButton.vue'
import apiClient from '../../api/index'

const emit = defineEmits(['close'])
const loading = ref(false)
const parties = ref([])
const current = ref(null)
const message = ref('')
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await apiClient.get('/year-beast/active')
    parties.value = res.data || res || []
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function act(fn) {
  loading.value = true
  error.value = ''
  message.value = ''
  try {
    const res = await fn()
    current.value = res.data || res
    message.value = res.message || ''
    await load()
  } catch (e) {
    error.value = e.message || '操作失败'
  } finally {
    loading.value = false
  }
}

const create = () => act(() => apiClient.post('/year-beast/party'))
const join = (id) => act(() => apiClient.post(`/year-beast/party/${id}/join`))
const start = (id) => act(() => apiClient.post(`/year-beast/party/${id}/start`))
const cracker = (id) => act(() => apiClient.post(`/year-beast/party/${id}/cracker`))
const focus = (id) => act(() => apiClient.post(`/year-beast/party/${id}/focus`))
const settle = (id) => act(() => apiClient.post(`/year-beast/party/${id}/settle`))
const view = (id) => act(() => apiClient.get(`/year-beast/party/${id}`))

onMounted(load)
</script>

<template>
  <PanelShell title="年兽大作战" size="lg" :loading="loading" @close="emit('close')">
    <div class="space-y-4">
      <div class="text-xs text-fg-muted">
        先破盾，后输出！护盾未破时集火伤害为 0；护盾归零后集火造成 200% 暴击。需【特制爆竹】破盾。
      </div>
      <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
      <div v-if="message" class="text-sm text-gold-500">{{ message }}</div>

      <div class="flex gap-2">
        <AppButton variant="primary" size="sm" :disabled="loading" @click="create">集结讨伐</AppButton>
        <AppButton size="sm" variant="ghost" :disabled="loading" @click="load">刷新</AppButton>
      </div>

      <PanelCard v-if="current" :title="`队伍 #${current.party_id} · ${current.status}`">
        <div class="text-sm space-y-1">
          <div>
            岁除之盾 <span class="text-red-300">{{ current.shield }}</span> / {{ current.max_shield }}
            · 回合 {{ current.turns }}
            · 总伤害 {{ current.damage_dealt }}
          </div>
          <div class="text-xs text-fg-muted">
            队员 {{ current.members.length }} 人：
            <span v-for="m in current.members" :key="m.player_id" class="mr-2">
              #{{ m.player_id }}{{ m.role === 'leader' ? '👑' : '' }} 爆竹{{ m.firecrackers_used }} 伤{{ m.damage }}
            </span>
          </div>
          <div class="flex gap-2 flex-wrap mt-2">
            <AppButton v-if="current.status === 'forming'" size="sm" @click="start(current.party_id)">开始讨伐</AppButton>
            <AppButton v-if="current.status === 'fighting'" size="sm" @click="cracker(current.party_id)">🧨 放爆竹</AppButton>
            <AppButton v-if="current.status === 'fighting'" size="sm" variant="primary" @click="focus(current.party_id)">⚔️ 集火</AppButton>
            <AppButton v-if="current.status === 'victory'" size="sm" variant="primary" @click="settle(current.party_id)">领取赏赐</AppButton>
          </div>
          <div class="text-xs text-fg-muted mt-2 max-h-32 overflow-y-auto">
            <div v-for="(l, i) in current.log || []" :key="i">{{ l.msg }}</div>
          </div>
        </div>
      </PanelCard>

      <PanelCard title="进行中的讨伐">
        <div v-if="!parties.length" class="text-sm text-fg-muted">暂无进行中的讨伐</div>
        <div v-for="p in parties" :key="p.party_id"
          class="flex items-center justify-between py-2 border-b border-line/40 last:border-0 text-sm">
          <div>
            #{{ p.party_id }} · {{ p.status }}
            <span class="text-xs text-fg-muted ml-2">盾 {{ p.shield }}/{{ p.max_shield }} · {{ p.members.length }} 人</span>
          </div>
          <div class="flex gap-2">
            <AppButton size="xs" variant="ghost" @click="view(p.party_id)">查看</AppButton>
            <AppButton v-if="p.status === 'forming'" size="xs" @click="join(p.party_id)">加入</AppButton>
          </div>
        </div>
      </PanelCard>
    </div>
  </PanelShell>
</template>
