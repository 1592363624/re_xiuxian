<template>
  <div class="space-y-6">
    <!-- 顶部操作栏 -->
    <div class="flex justify-between items-center">
      <div>
        <h3 class="text-lg font-bold text-white">修炼参数配置</h3>
        <p class="text-xs text-gray-500 mt-0.5">闭关（常规/深度）与历练（时长分级）参数，修改后热加载无需重启</p>
      </div>
      <button @click="fetchConfig" :disabled="loading" class="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded text-white text-sm flex items-center gap-1">
        <svg v-if="loading" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        刷新配置
      </button>
    </div>

    <!-- 闭关配置区 -->
    <div class="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
      <h4 class="text-md font-bold text-cyan-400 mb-4 flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
        闭关修炼
      </h4>

      <!-- 基础修为速率 -->
      <div class="mb-4">
        <label class="block text-sm text-gray-400 mb-1.5">基础修为速率（每秒）</label>
        <div class="flex items-center gap-2">
          <input v-model.number="form.seclusion.base_exp_rate" type="number" step="0.1" min="0.1" max="100"
            class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-cyan-500 focus:outline-none" />
          <span class="text-xs text-gray-500">修为/秒</span>
        </div>
        <p class="mt-1 text-xs text-gray-500">所有闭关的公共基础速率，最终收益 = 基础速率 × 时长 × 模式倍率 × 境界加成</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- 常规闭关 -->
        <div class="bg-gray-900/50 rounded p-3 border border-cyan-900/40">
          <h5 class="text-sm font-bold text-cyan-300 mb-3 flex items-center justify-between">
            <span>常规闭关（normal）</span>
            <span class="text-[10px] text-gray-500">日常修炼</span>
          </h5>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">单次最长时长（秒）</label>
              <input v-model.number="form.seclusion.normal.max_duration" type="number" min="60" max="7200" step="60"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-cyan-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">建议 60-7200，当前：{{ formatDuration(form.seclusion.normal.max_duration) }}</p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">每日次数上限</label>
              <input v-model.number="form.seclusion.normal.daily_limit" type="number" min="1" max="100" step="1"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">冷却时间（秒）</label>
              <input v-model.number="form.seclusion.normal.cooldown" type="number" min="0" max="86400" step="60"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-cyan-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">当前：{{ formatDuration(form.seclusion.normal.cooldown) }}</p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">收益倍率</label>
              <input v-model.number="form.seclusion.normal.exp_rate" type="number" min="0.1" max="100" step="0.1"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-cyan-500 focus:outline-none" />
            </div>
          </div>
        </div>

        <!-- 深度闭关 -->
        <div class="bg-gray-900/50 rounded p-3 border border-purple-900/40">
          <h5 class="text-sm font-bold text-purple-300 mb-3 flex items-center justify-between">
            <span>深度闭关（deep）</span>
            <span class="text-[10px] text-gray-500">长线挂机 2 倍收益</span>
          </h5>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">最短时长（秒）</label>
              <input v-model.number="form.seclusion.deep.min_duration" type="number" min="600" max="86400" step="600"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-purple-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">未达此时长提前结束按强行出关处理</p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">最长时长（秒）</label>
              <input v-model.number="form.seclusion.deep.max_duration" type="number" min="600" max="172800" step="600"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-purple-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">当前：{{ formatDuration(form.seclusion.deep.max_duration) }}</p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">每日次数上限</label>
              <input v-model.number="form.seclusion.deep.daily_limit" type="number" min="1" max="50" step="1"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-purple-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">冷却时间（秒）</label>
              <input v-model.number="form.seclusion.deep.cooldown" type="number" min="0" max="172800" step="60"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-purple-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">当前：{{ formatDuration(form.seclusion.deep.cooldown) }}</p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">收益倍率</label>
              <input v-model.number="form.seclusion.deep.exp_rate" type="number" min="0.1" max="100" step="0.1"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-purple-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">境界要求</label>
              <input v-model="form.seclusion.deep.min_realm" type="text"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-purple-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">如：筑基期、金丹期、元婴期等</p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">强行出关损失比例（0-1）</label>
              <input v-model.number="form.seclusion.deep.forced_penalty" type="number" min="0" max="1" step="0.1"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-purple-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">0.5 = 损失 50% 收益</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 闭关保存按钮 -->
      <div class="mt-4 flex justify-end">
        <button @click="saveSeclusion" :disabled="savingSeclusion"
          class="px-5 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 rounded text-white text-sm font-bold flex items-center gap-2">
          <svg v-if="savingSeclusion" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          保存闭关配置并热加载
        </button>
      </div>
    </div>

    <!-- 历练配置区 -->
    <div class="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
      <h4 class="text-md font-bold text-amber-400 mb-4 flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
        历练探索
      </h4>

      <!-- 全局参数 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">默认时长类型</label>
          <select v-model="form.adventure.default_duration_type"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-amber-500 focus:outline-none">
            <option value="short">短时（short）</option>
            <option value="medium">中时（medium）</option>
            <option value="long">长时（long）</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">提前结束惩罚比例（0-1）</label>
          <input v-model.number="form.adventure.early_finish_penalty" type="number" min="0" max="1" step="0.1"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:border-amber-500 focus:outline-none" />
          <p class="text-[10px] text-gray-500 mt-0.5">0.5 = 提前结束时再扣 50% 收益，无保底</p>
        </div>
      </div>

      <!-- 三档时长配置 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div v-for="type in ['short', 'medium', 'long']" :key="type"
          class="bg-gray-900/50 rounded p-3 border"
          :class="type === 'medium' ? 'border-amber-700/60' : 'border-gray-700'">
          <h5 class="text-sm font-bold mb-3 flex items-center justify-between"
            :class="type === 'medium' ? 'text-amber-300' : (type === 'short' ? 'text-green-300' : 'text-red-300')">
            <span>{{ form.adventure.duration_types[type].label }}</span>
            <span class="text-[10px] text-gray-500">{{ type }}</span>
          </h5>
          <div class="space-y-2.5">
            <div>
              <label class="block text-[11px] text-gray-400 mb-0.5">显示标签</label>
              <input v-model="form.adventure.duration_types[type].label" type="text"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:border-amber-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-[11px] text-gray-400 mb-0.5">时长（秒）</label>
              <input v-model.number="form.adventure.duration_types[type].duration" type="number" min="10" max="3600" step="10"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:border-amber-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">{{ formatDuration(form.adventure.duration_types[type].duration) }}</p>
            </div>
            <div>
              <label class="block text-[11px] text-gray-400 mb-0.5">奖励倍率</label>
              <input v-model.number="form.adventure.duration_types[type].reward_multiplier" type="number" min="0.1" max="10" step="0.1"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:border-amber-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-[11px] text-gray-400 mb-0.5">受伤概率（0-1）</label>
              <input v-model.number="form.adventure.duration_types[type].injury_chance" type="number" min="0" max="1" step="0.01"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:border-amber-500 focus:outline-none" />
              <p class="text-[10px] text-gray-500 mt-0.5">{{ Math.round(form.adventure.duration_types[type].injury_chance * 100) }}% 概率受伤</p>
            </div>
            <div>
              <label class="block text-[11px] text-gray-400 mb-0.5">受伤气血损失比例（0-1）</label>
              <input v-model.number="form.adventure.duration_types[type].injury_hp_loss_rate" type="number" min="0" max="1" step="0.01"
                class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:border-amber-500 focus:outline-none" />
            </div>
          </div>
        </div>
      </div>

      <!-- 历练保存按钮 -->
      <div class="mt-4 flex justify-end">
        <button @click="saveAdventure" :disabled="savingAdventure"
          class="px-5 py-2 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-white text-sm font-bold flex items-center gap-2">
          <svg v-if="savingAdventure" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          保存历练配置并热加载
        </button>
      </div>
    </div>

    <!-- 自定义确认弹窗 -->
    <div v-if="confirmVisible" class="fixed inset-0 z-[70] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="confirmVisible = false"></div>
      <div class="relative bg-gray-900 border border-gray-700 rounded-lg p-5 max-w-md w-full mx-4 shadow-2xl">
        <h3 class="text-base font-bold text-amber-400 mb-2">{{ confirmTitle }}</h3>
        <p class="text-sm text-gray-300 mb-4 whitespace-pre-line">{{ confirmMessage }}</p>
        <div class="flex justify-end gap-2">
          <button @click="confirmVisible = false" class="px-4 py-1.5 text-sm border border-gray-600 text-gray-300 rounded hover:bg-gray-800">取消</button>
          <button @click="confirmAction" class="px-4 py-1.5 text-sm bg-amber-700 hover:bg-amber-600 text-white rounded font-bold">确认</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 修炼配置子组件
 * 提供 GM 后台对闭关（常规/深度）与历练（时长分级）参数的可视化编辑入口
 *
 * 设计要点：
 *   - 数据流向：组件 → API → 后端写 JSON + 热更新 → ConfigLoader 缓存刷新 → 业务模块下次读取即生效
 *   - 弹窗：使用组件内自定义确认弹窗，不依赖父组件，不使用浏览器原生 confirm
 *   - 字段校验：前端做基础必填校验，后端做数值范围校验（权威校验在后端）
 */
import { reactive, ref, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import {
  getCultivationConfig,
  updateSeclusionConfig,
  updateAdventureConfig
} from '../../../api/admin_cultivation'

const uiStore = useUIStore()

const loading = ref(false)
const savingSeclusion = ref(false)
const savingAdventure = ref(false)

// 表单数据（默认值仅在前端兜底，正常应从后端拉取）
const form = reactive({
  seclusion: {
    base_exp_rate: 1,
    normal: {
      max_duration: 1800,
      daily_limit: 3,
      cooldown: 300,
      exp_rate: 1
    },
    deep: {
      min_duration: 14400,
      max_duration: 28800,
      daily_limit: 1,
      cooldown: 3600,
      exp_rate: 2,
      min_realm: '筑基期',
      forced_penalty: 0.5
    }
  },
  adventure: {
    duration_types: {
      short: { duration: 30, reward_multiplier: 0.6, injury_chance: 0, injury_hp_loss_rate: 0.05, label: '短时历练' },
      medium: { duration: 90, reward_multiplier: 1.0, injury_chance: 0.05, injury_hp_loss_rate: 0.08, label: '中时历练' },
      long: { duration: 300, reward_multiplier: 1.8, injury_chance: 0.1, injury_hp_loss_rate: 0.12, label: '长时历练' }
    },
    default_duration_type: 'medium',
    early_finish_penalty: 0.5
  }
})

// 自定义确认弹窗状态
const confirmVisible = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmCallback = ref(null)

/**
 * 拉取修炼配置
 */
const fetchConfig = async () => {
  loading.value = true
  try {
    const res = await getCultivationConfig()
    const data = res.data?.data
    if (data) {
      // 闭关配置
      if (data.seclusion) {
        form.seclusion.base_exp_rate = data.seclusion.base_exp_rate ?? 1
        if (data.seclusion.normal) Object.assign(form.seclusion.normal, data.seclusion.normal)
        if (data.seclusion.deep) Object.assign(form.seclusion.deep, data.seclusion.deep)
      }
      // 历练配置
      if (data.adventure) {
        form.adventure.default_duration_type = data.adventure.default_duration_type || 'medium'
        form.adventure.early_finish_penalty = data.adventure.early_finish_penalty ?? 0.5
        if (data.adventure.duration_types) {
          for (const type of ['short', 'medium', 'long']) {
            if (data.adventure.duration_types[type]) {
              Object.assign(form.adventure.duration_types[type], data.adventure.duration_types[type])
            }
          }
        }
      }
      uiStore.showToast('配置已刷新', 'success')
    }
  } catch (error) {
    console.error('拉取修炼配置失败:', error)
    uiStore.showToast('拉取修炼配置失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 保存闭关配置（含自定义确认弹窗）
 */
const saveSeclusion = () => {
  // 前端基础校验
  if (form.seclusion.deep.min_duration > form.seclusion.deep.max_duration) {
    uiStore.showToast('深度闭关最短时长不能大于最长时长', 'warning')
    return
  }

  showConfirm(
    '确认保存闭关配置',
    '保存后将立即热加载，影响所有玩家的闭关行为。\n原配置会自动备份到 server/config/backup/ 目录。\n\n是否继续？',
    doSaveSeclusion
  )
}

/**
 * 执行保存闭关配置（用户确认后调用）
 */
const doSaveSeclusion = async () => {
  savingSeclusion.value = true
  try {
    const res = await updateSeclusionConfig({
      base_exp_rate: form.seclusion.base_exp_rate,
      normal: { ...form.seclusion.normal },
      deep: { ...form.seclusion.deep }
    })
    const msg = res.data?.message || '闭关配置已保存并热加载'
    uiStore.showToast(msg, 'success')
  } catch (error) {
    console.error('保存闭关配置失败:', error)
    const msg = error.response?.data?.message || '保存闭关配置失败'
    uiStore.showToast(msg, 'error')
  } finally {
    savingSeclusion.value = false
  }
}

/**
 * 保存历练配置
 */
const saveAdventure = () => {
  showConfirm(
    '确认保存历练配置',
    '保存后将立即热加载，影响所有玩家的历练行为。\n原配置会自动备份到 server/config/backup/ 目录。\n\n是否继续？',
    doSaveAdventure
  )
}

/**
 * 执行保存历练配置（用户确认后调用）
 */
const doSaveAdventure = async () => {
  savingAdventure.value = true
  try {
    const res = await updateAdventureConfig({
      duration_types: {
        short: { ...form.adventure.duration_types.short },
        medium: { ...form.adventure.duration_types.medium },
        long: { ...form.adventure.duration_types.long }
      },
      default_duration_type: form.adventure.default_duration_type,
      early_finish_penalty: form.adventure.early_finish_penalty
    })
    const msg = res.data?.message || '历练配置已保存并热加载'
    uiStore.showToast(msg, 'success')
  } catch (error) {
    console.error('保存历练配置失败:', error)
    const msg = error.response?.data?.message || '保存历练配置失败'
    uiStore.showToast(msg, 'error')
  } finally {
    savingAdventure.value = false
  }
}

/**
 * 显示自定义确认弹窗
 * @param {string} title - 标题
 * @param {string} message - 消息内容
 * @param {function} callback - 确认后回调
 */
const showConfirm = (title, message, callback) => {
  confirmTitle.value = title
  confirmMessage.value = message
  confirmCallback.value = callback
  confirmVisible.value = true
}

/**
 * 确认按钮回调
 */
const confirmAction = () => {
  confirmVisible.value = false
  if (typeof confirmCallback.value === 'function') {
    confirmCallback.value()
  }
}

/**
 * 格式化时长（秒 → 中文）
 * @param {number} seconds
 */
const formatDuration = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0秒'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const parts = []
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0) parts.push(`${m}分钟`)
  if (s > 0 && h === 0) parts.push(`${s}秒`)
  return parts.join('') || '0秒'
}

onMounted(() => {
  fetchConfig()
})
</script>
