<template>
  <div class="space-y-6">
    <div class="flex justify-between items-center">
       <h3 class="text-lg font-bold text-white">系统参数配置</h3>
       <button @click="fetchConfig" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新配置</button>
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

      <!-- 闭关冷却时间 -->
      <div class="bg-gray-800 p-4 rounded border border-gray-700">
        <label class="block text-sm font-medium text-gray-400 mb-2">闭关冷却时间 (秒)</label>
        <div class="flex space-x-2">
          <input
            v-model="configs.seclusion_cooldown"
            type="number"
            class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
          >
          <button @click="saveConfig('seclusion_cooldown', configs.seclusion_cooldown, '闭关冷却时间(秒)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
        </div>
        <p class="mt-1 text-xs text-gray-500">默认: 3600 (60分钟)</p>
      </div>

      <!-- 闭关经验倍率 -->
      <div class="bg-gray-800 p-4 rounded border border-gray-700">
        <label class="block text-sm font-medium text-gray-400 mb-2">闭关基础收益 (修为/秒)</label>
        <div class="flex space-x-2">
          <input
            v-model="configs.seclusion_exp_rate"
            type="number"
            step="0.01"
            class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
          >
          <button @click="saveConfig('seclusion_exp_rate', configs.seclusion_exp_rate, '闭关经验倍率(修为/秒)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
        </div>
        <p class="mt-1 text-xs text-gray-500">默认: 0.1 (每10秒1点修为)</p>
      </div>

      <!-- 修炼时间间隔 -->
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

      <!-- 深度闭关配置 -->
      <div class="bg-gray-800 p-4 rounded border border-gray-700 md:col-span-2 lg:col-span-3">
        <h4 class="text-md font-bold text-purple-400 mb-4">深度闭关配置</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">深度闭关收益倍率</label>
            <div class="flex space-x-2">
              <input
                v-model="configs.deep_seclusion_exp_rate"
                type="number"
                step="0.1"
                class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
              >
              <button @click="saveConfig('deep_seclusion_exp_rate', configs.deep_seclusion_exp_rate, '深度闭关收益倍率')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
            </div>
            <p class="mt-1 text-xs text-gray-500">默认: 2.0 (2倍收益)</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">深度闭关时间间隔 (秒)</label>
            <div class="flex space-x-2">
              <input
                v-model="configs.deep_seclusion_interval"
                type="number"
                min="1"
                class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
              >
              <button @click="saveConfig('deep_seclusion_interval', configs.deep_seclusion_interval, '深度闭关时间间隔(秒)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
            </div>
            <p class="mt-1 text-xs text-gray-500">默认: 300 (5分钟)</p>
          </div>
        </div>
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
 * 负责系统参数配置展示和修改
 */
import { reactive, ref, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import { getConfig, updateConfig, timeTravel } from '../../../api/admin'

const emit = defineEmits(['timeTravelComplete'])
const uiStore = useUIStore()

// 系统配置
const configs = reactive({
  auto_save_interval: 10000,
  seclusion_cooldown: 3600,
  seclusion_exp_rate: 0.1,
  cultivate_interval: 60,
  deep_seclusion_exp_rate: 2.0,
  deep_seclusion_interval: 300
})

// 时间加速
const timeTravelYears = ref(1)
const isTimeTraveling = ref(false)

/**
 * 获取配置
 */
const fetchConfig = async () => {
  try {
    const res = await getConfig()
    const configData = res.data?.data || res.data || []
    if (Array.isArray(configData)) {
      configData.forEach(item => {
        if (item.key === 'auto_save_interval') configs.auto_save_interval = parseInt(item.value)
        if (item.key === 'seclusion_cooldown') configs.seclusion_cooldown = parseInt(item.value)
        if (item.key === 'seclusion_exp_rate') configs.seclusion_exp_rate = parseFloat(item.value)
        if (item.key === 'cultivate_interval') configs.cultivate_interval = parseInt(item.value)
        if (item.key === 'deep_seclusion_exp_rate') configs.deep_seclusion_exp_rate = parseFloat(item.value)
        if (item.key === 'deep_seclusion_interval') configs.deep_seclusion_interval = parseInt(item.value)
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
 * 确认时间加速
 */
const confirmTimeTravel = async () => {
  if (!timeTravelYears.value || timeTravelYears.value <= 0) {
    uiStore.showToast('请输入有效的年数', 'warning')
    return
  }

  if (!confirm(`确定要让时间加速 ${timeTravelYears.value} 年吗？\n\n⚠️ 警告：这会导致所有在线/离线玩家消耗寿元。寿元耗尽者将会死亡并掉落境界！`)) {
    return
  }

  isTimeTraveling.value = true
  try {
    const res = await timeTravel(parseFloat(timeTravelYears.value))

    if (res.data && res.data.userDied) {
      emit('timeTravelComplete', { died: true, message: res.data.deathLog || '寿元耗尽，身死道消。' })
    } else {
      const msg = res.data?.message || '操作成功'
      uiStore.showToast(msg, 'success')
      emit('timeTravelComplete', { died: false })
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
