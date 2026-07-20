<template>
  <div class="space-y-6">
    <div class="flex justify-between items-center">
       <h3 class="text-lg font-bold text-white">系统参数配置</h3>
       <button @click="fetchConfig" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新配置</button>
    </div>

    <!-- 闭关/历练参数已迁移至「修炼配置」Tab 的提示 -->
    <div class="bg-cyan-950/30 border border-cyan-800/50 rounded-lg p-3 flex items-start gap-2">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
      <div class="text-xs text-cyan-300">
        <div class="font-bold mb-0.5">闭关与历练参数已迁移</div>
        <div class="text-cyan-400/80">常规闭关、深度闭关、历练时长分级的参数配置已迁移至「修炼配置」Tab，支持整体编辑与热加载。本页仅保留通用系统参数。</div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <!-- 自动存档间隔 -->
      <div class="bg-gray-800 p-4 rounded border border-gray-700">
        <label class="block text-sm font-medium text-gray-400 mb-2">自动存档间隔 (毫秒)</label>
        <div class="flex space-x-2">
          <input
            v-model="configs.auto_save_interval"
            type="number"
            class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
          >
          <button @click="saveConfig('auto_save_interval', configs.auto_save_interval, '自动存档间隔(ms)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
        </div>
        <p class="mt-1 text-xs text-gray-500">默认: 10000 (10秒)</p>
      </div>

      <!-- 修炼时间间隔（保留字段，向后兼容） -->
      <div class="bg-gray-800 p-4 rounded border border-gray-700">
        <label class="block text-sm font-medium text-gray-400 mb-2">修炼时间间隔 (秒)</label>
        <div class="flex space-x-2">
          <input
            v-model="configs.cultivate_interval"
            type="number"
            min="1"
            class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
          >
          <button @click="saveConfig('cultivate_interval', configs.cultivate_interval, '修炼时间间隔(秒)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
        </div>
        <p class="mt-1 text-xs text-gray-500">默认: 60 (1分钟)</p>
      </div>

      <!-- 时间控制 (GM) -->
      <div class="bg-gray-800 p-4 rounded border border-gray-700 md:col-span-2 lg:col-span-3 mt-4">
        <label class="block text-sm font-medium text-amber-500 mb-2 font-bold">⏳ 时光飞逝 (时间加速)</label>
        <div class="flex items-center gap-4 flex-wrap">
          <div class="flex items-center gap-2 flex-1 min-w-[200px]">
            <span class="text-gray-400 text-sm">加速年份:</span>
            <input
              v-model="timeTravelYears"
              type="number"
              min="0.1"
              step="0.1"
              class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
              placeholder="输入年份，如 1 或 0.5"
            >
          </div>
          <button
            @click="confirmTimeTravel"
            :disabled="isTimeTraveling"
            class="px-6 py-2 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg v-if="isTimeTraveling" class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
            {{ isTimeTraveling ? '加速中...' : '执行加速' }}
          </button>
        </div>
        <p class="mt-2 text-xs text-gray-500">警告：此操作会增加全服所有玩家的寿命，可能导致寿元耗尽的玩家死亡！(24小时=1年)</p>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 系统配置子组件
 * 负责通用系统参数配置展示和修改
 *
 * 重构说明：
 *   - 闭关/历练相关参数（seclusion_cooldown、seclusion_exp_rate、
 *     deep_seclusion_exp_rate、deep_seclusion_interval）已迁移至
 *     CultivationConfig.vue（「修炼配置」Tab），支持整体编辑与热加载
 *   - 本页仅保留通用系统参数（auto_save_interval、cultivate_interval）
 *     和时间加速功能，避免管理员在两处重复修改同一参数
 */
import { reactive, ref, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import { getConfig, updateConfig, timeTravel } from '../../../api/admin'

const emit = defineEmits(['timeTravelComplete', 'showConfirm'])
const uiStore = useUIStore()

// 系统配置（已移除闭关/历练相关字段，仅保留通用参数）
const configs = reactive({
  auto_save_interval: 10000,
  cultivate_interval: 60
})

// 时间加速
const timeTravelYears = ref(1)
const isTimeTraveling = ref(false)

/**
 * 获取配置（仅拉取通用系统参数，闭关/历练参数由 CultivationConfig 自行拉取）
 */
const fetchConfig = async () => {
  try {
    const res = await getConfig()
    const configData = res.data?.data || res.data || []
    if (Array.isArray(configData)) {
      configData.forEach(item => {
        if (item.key === 'auto_save_interval') configs.auto_save_interval = parseInt(item.value)
        if (item.key === 'cultivate_interval') configs.cultivate_interval = parseInt(item.value)
      })
    }
  } catch (error) {
    console.error('Fetch config error:', error)
  }
}

/**
 * 保存配置
 */
const saveConfig = async (key, value, desc) => {
  try {
    await updateConfig(key, value.toString(), desc)
    uiStore.showToast('配置保存成功', 'success')
  } catch (error) {
    uiStore.showToast('配置保存失败', 'error')
  }
}

/**
 * 确认时间加速（显示自定义确认弹窗，替代浏览器原生 confirm）
 */
const confirmTimeTravel = async () => {
  if (!timeTravelYears.value || timeTravelYears.value <= 0) {
    uiStore.showToast('请输入有效的年数', 'warning')
    return
  }

  // 通过父组件 AdminPanel 的自定义确认弹窗进行确认
  const confirmMessage = `确定要让时间加速 ${timeTravelYears.value} 年吗？\n\n⚠️ 警告：这会导致所有在线/离线玩家消耗寿元。寿元耗尽者将会死亡并掉落境界！`
  emit('showConfirm', '确认时间加速', confirmMessage, executeTimeTravel)
}

/**
 * 执行时间加速操作（在用户确认后调用）
 */
const executeTimeTravel = async () => {
  isTimeTraveling.value = true
  try {
    const res = await timeTravel(parseFloat(timeTravelYears.value))

    // 修复 B21：后端返回结构是 { code, message, data: { userDied, dead_count } }
    // 旧代码 `res.data.userDied` 读不到（userDied 在 data.data 中），导致死亡永远不提示
    // 新代码正确读取 res.data.data.userDied，并使用 res.data.message 作为死亡提示
    const payload = res.data?.data || {}
    const serverMsg = res.data?.message || ''

    if (payload.userDied) {
      // 当前 GM 账号在时间加速中寿元耗尽：触发死亡弹窗
      emit('timeTravelComplete', {
        died: true,
        message: serverMsg || '寿元耗尽，身死道消。'
      })
    } else {
      const msg = serverMsg || '操作成功'
      uiStore.showToast(msg, 'success')
      emit('timeTravelComplete', { died: false, deadCount: payload.dead_count || 0 })
    }
  } catch (error) {
    console.error('Time travel error:', error)
    const errorMsg = error.response?.data?.message || '时间加速失败'
    uiStore.showToast(errorMsg, 'error')
  } finally {
    isTimeTraveling.value = false
  }
}

onMounted(() => {
  fetchConfig()
})
</script>
