<template>
  <div class="space-y-6">
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-fg-primary">服务器统计</h3>
      <AppButton variant="primary" size="sm" @click="fetchStats">刷新</AppButton>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="bg-surface-base/50 p-4 rounded-panel border border-line text-center">
        <div class="text-3xl font-bold text-gold-500 num">{{ stats.total_players || 0 }}</div>
        <div class="text-fg-muted text-sm mt-1">总玩家数</div>
      </div>
      <div class="bg-surface-base/50 p-4 rounded-panel border border-line text-center">
        <div class="text-3xl font-bold text-green-400 num">{{ stats.online_players || 0 }}</div>
        <div class="text-fg-muted text-sm mt-1">在线玩家</div>
      </div>
      <div class="bg-surface-base/50 p-4 rounded-panel border border-line text-center">
        <div class="text-3xl font-bold text-red-400 num">{{ stats.banned_count || 0 }}</div>
        <div class="text-fg-muted text-sm mt-1">已封禁</div>
      </div>
      <div class="bg-surface-base/50 p-4 rounded-panel border border-line text-center">
        <div class="text-3xl font-bold text-blue-400 num">{{ formatUptime(stats.server_uptime) }}</div>
        <div class="text-fg-muted text-sm mt-1">服务器运行时间</div>
      </div>
    </div>

    <!-- 境界分布 -->
    <div class="bg-surface-base/50 p-4 rounded-panel border border-line">
      <h4 class="text-md font-bold text-fg-primary mb-4">境界分布</h4>
      <div class="space-y-2">
        <div v-for="realm in stats.realm_distribution" :key="realm.realm" class="flex items-center gap-3">
          <span class="text-fg-secondary w-24">{{ realm.realm }}</span>
          <div class="flex-1 h-6 bg-surface-sunken border border-line-subtle rounded overflow-hidden">
            <div
              class="h-full bg-gold-500/50 transition-all duration-300"
              :style="{ width: getRealmBarWidth(realm.count) + '%' }"
            ></div>
          </div>
          <span class="text-fg-muted w-12 text-right num">{{ realm.count }}</span>
        </div>
        <div v-if="!stats.realm_distribution?.length" class="text-fg-faint text-center py-4">暂无数据</div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 服务器统计子组件
 * 负责展示服务器统计数据和境界分布
 */
import { ref, onMounted } from 'vue'
import { getStats } from '../../../api/admin'
import AppButton from '../../ui/AppButton.vue'

// 统计数据
const stats = ref({
  total_players: 0,
  online_players: 0,
  banned_count: 0,
  server_uptime: 0,
  realm_distribution: []
})

/**
 * 获取统计数据
 */
const fetchStats = async () => {
  try {
    const res = await getStats()
    stats.value = res.data.data || {}
  } catch (error) {
    console.error('Fetch stats error:', error)
  }
}

/**
 * 格式化运行时间
 */
const formatUptime = (seconds) => {
  if (!seconds) return '0秒'
  const d = Math.floor(seconds / (3600 * 24))
  const h = Math.floor((seconds % (3600 * 24)) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  const parts = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0) parts.push(`${m}分`)
  if (s > 0 || parts.length === 0) parts.push(`${s}秒`)

  return parts.join('')
}

/**
 * 计算境界分布条形图宽度
 */
const getRealmBarWidth = (count) => {
  if (!stats.value.realm_distribution || !stats.value.realm_distribution.length) return 0
  const max = Math.max(...stats.value.realm_distribution.map(r => r.count))
  return max ? (count / max) * 100 : 0
}

// 暴露刷新方法给父组件
defineExpose({
  fetchStats
})

onMounted(() => {
  fetchStats()
})
</script>
