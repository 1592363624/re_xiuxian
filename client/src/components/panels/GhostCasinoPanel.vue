<script setup>
/**
 * 鬼赌坊面板：天命玉简闯关 + 六道轮回盘
 */
import { ref, onMounted } from 'vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import AppButton from '../ui/AppButton.vue'
import apiClient from '../../api/index'

const emit = defineEmits(['close'])
const loading = ref(false)
const status = ref(null)
const message = ref('')
const error = ref('')

async function load() {
  loading.value = true
  try {
    const res = await apiClient.get('/ghost-casino/status')
    status.value = res.data || res
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function playDestiny() {
  loading.value = true
  error.value = ''
  try {
    const res = await apiClient.post('/ghost-casino/destiny-slip')
    message.value = res.message || res.data?.message || ''
    await load()
  } catch (e) {
    error.value = e.message || '闯关失败'
  } finally {
    loading.value = false
  }
}

async function cashOut() {
  loading.value = true
  try {
    const res = await apiClient.post('/ghost-casino/destiny-slip/cash')
    message.value = res.message || `兑奖 +${res.data?.gain}`
    await load()
  } catch (e) {
    error.value = e.message || '兑奖失败'
  } finally {
    loading.value = false
  }
}

async function buyTicket(count = 1) {
  loading.value = true
  try {
    const res = await apiClient.post('/ghost-casino/six-paths/buy', { count })
    message.value = res.message || '购入成功'
    await load()
  } catch (e) {
    error.value = e.message || '购买失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <PanelShell title="鬼赌坊" size="lg" :loading="loading" @close="emit('close')">
    <div class="space-y-4">
      <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
      <div v-if="message" class="text-sm text-gold-500">{{ message }}</div>

      <PanelCard v-if="status?.destiny_slip" title="天命玉简">
        <div class="text-sm space-y-2">
          <div class="text-xs text-fg-muted">
            入场 {{ status.destiny_slip.entry_fee }} 灵石 · 最多 {{ status.destiny_slip.max_stages }} 关 · 每关奖池 ×{{ status.destiny_slip.stage_cash_multiplier }}
          </div>
          <div>
            当前第 <span class="text-gold-500">{{ status.destiny_slip.current_stage }}</span> 关 · 奖池
            <span class="text-gold-500">{{ status.destiny_slip.pot }}</span>
          </div>
          <div class="flex gap-2">
            <AppButton size="sm" variant="primary" :disabled="loading" @click="playDestiny">
              {{ status.destiny_slip.current_stage > 0 ? '继续闯关' : '入场闯关' }}
            </AppButton>
            <AppButton size="sm" :disabled="loading || !status.destiny_slip.current_stage" @click="cashOut">
              兑奖离场
            </AppButton>
          </div>
          <div class="text-xs text-fg-muted">失败则奖池归零，见好就收才是天机。</div>
        </div>
      </PanelCard>

      <PanelCard v-if="status?.six_paths_wheel" title="六道轮回盘">
        <div class="text-sm space-y-2">
          <div class="text-xs text-fg-muted">票价 {{ status.six_paths_wheel.ticket_price }} 灵石 / 注 · 我有 {{ status.tickets || 0 }} 注</div>
          <div class="text-xs text-fg-muted">
            奖池：
            <span v-for="p in status.six_paths_wheel.prizes || []" :key="p.rank" class="mr-2">
              {{ p.rank }} 等 ×{{ p.count }} = {{ p.stones }}
            </span>
          </div>
          <AppButton size="sm" @click="buyTicket(1)">买 1 注</AppButton>
          <AppButton size="sm" class="ml-2" @click="buyTicket(10)">买 10 注</AppButton>
        </div>
      </PanelCard>
    </div>
  </PanelShell>
</template>
