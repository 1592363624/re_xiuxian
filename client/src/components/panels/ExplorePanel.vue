<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <div class="relative bg-[#1c1917] border border-stone-800 rounded-lg p-6 max-w-lg w-full mx-4 shadow-2xl animate-fade-in max-h-[85vh] flex flex-col">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-emerald-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2 2.5 9.5l1 10.5L12 22l8.5-2L22 10l-10-7.5z"/>
          </svg>
          历练探索
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- 当前地图信息 -->
        <div v-if="currentMap" class="bg-[#292524] rounded-lg p-4 border border-stone-700">
          <div class="flex items-center gap-3 mb-2">
            <div class="text-emerald-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
            </div>
            <span class="font-bold text-stone-200">{{ currentMap.name }}</span>
            <span class="text-xs text-stone-500 bg-[#1c1917] px-2 py-0.5 rounded">{{ currentMap.environment }}</span>
          </div>
          <p class="text-sm text-stone-400">{{ currentMap.description }}</p>
        </div>

        <!-- 环境信息 -->
        <div class="flex gap-2 text-sm text-stone-400">
          <span class="bg-[#292524] px-3 py-1.5 rounded border border-stone-700 flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2"/><path d="M12 21v2"/><path d="M4.22 4.22l1.42 1.42"/><path d="M18.36 18.36l1.42 1.42"/><path d="M1 12h2"/><path d="M21 12h2"/><path d="M4.22 19.78l1.42-1.42"/><path d="M18.36 5.64l1.42-1.42"/></svg>
            {{ timeOfDay }}
          </span>
          <span class="bg-[#292524] px-3 py-1.5 rounded border border-stone-700 flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
            {{ weather }}
          </span>
        </div>

        <!-- 历练时长选择（未历练时显示） -->
        <div v-if="!isExploring" class="space-y-3">
          <div class="text-sm text-stone-400 mb-2">
            <span class="text-emerald-400 font-bold">选择历练时长</span>
            <span class="text-stone-500 text-xs ml-2">时长越长奖励越高，但受伤风险也越大</span>
          </div>
          <!-- 时长类型选择卡片（v-for 渲染，配置来自后端 /api/config/game-balance/public） -->
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="item in durationTypeList"
              :key="item.key"
              @click="selectDurationType(item.key)"
              class="text-left bg-[#292524] border rounded-lg p-3 transition-all duration-300 relative"
              :class="selectedDurationType === item.key
                ? `${item.activeBorder} ring-1 ${item.activeRing}`
                : 'border-stone-700 hover:' + item.hoverBorder"
            >
              <!-- 推荐标识（仅默认时长类型显示） -->
              <div v-if="item.isDefault" class="absolute -top-2 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 text-[9px] tracking-wider">推荐</div>
              <div class="text-sm font-bold mb-1" :class="item.titleColor">{{ item.config.label }}</div>
              <div class="text-xs text-stone-400 mb-2">{{ formatDurationLabel(item.config.duration) }}</div>
              <div class="space-y-0.5">
                <div class="text-[10px] text-stone-500 flex justify-between">
                  <span>奖励</span><span :class="item.titleColor">×{{ item.config.reward_multiplier }}</span>
                </div>
                <div class="text-[10px] text-stone-500 flex justify-between">
                  <span>受伤</span><span :class="item.titleColor">{{ formatPercent(item.config.injury_chance) }}</span>
                </div>
              </div>
            </button>
          </div>

          <!-- 风险提示 -->
          <div class="bg-[#292524] rounded-lg p-3 border border-stone-700 text-xs text-stone-400 space-y-1.5">
            <div class="flex items-start gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <div>
                <span class="text-amber-400 font-bold">提前结束惩罚：</span>
                按已时长比例结算，并扣除 {{ earlyFinishPenaltyPercent }} 收益，<span class="text-rose-400">不设保底</span>。
              </div>
            </div>
            <div class="flex items-start gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <div>
                <span class="text-rose-400 font-bold">受伤风险：</span>
                历练结束时按概率受伤，损失当前气血的一定比例。时长越长风险越高。
              </div>
            </div>
          </div>

          <!-- 开始历练按钮 -->
          <button
            @click="startExploreAction"
            :disabled="isLoading"
            class="w-full py-4 px-6 bg-gradient-to-r from-emerald-900/80 to-[#064e3b] hover:from-emerald-800/80 hover:to-[#047857] border border-emerald-700 hover:border-emerald-500 text-emerald-400 hover:text-emerald-300 rounded-lg transition-all duration-300 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed group"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-hover:scale-110 transition-transform">
              <path d="M12 2 2.5 9.5l1 10.5L12 22l8.5-2L22 10l-10-7.5z"/>
            </svg>
            <span class="font-bold text-lg">开始{{ durationTypeLabel }}</span>
          </button>
          <p class="text-xs text-stone-500 text-center">历练过程中会遭遇各种随机事件，可能获得修为、物品或触发战斗</p>
        </div>

        <!-- 历练中状态 -->
        <div v-else class="bg-[#292524] rounded-lg p-6 border border-stone-700 text-center space-y-4">
          <div class="flex justify-center">
            <div class="animate-spin text-emerald-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
            </div>
          </div>

          <div v-if="currentEvent" class="space-y-3">
            <span class="text-xs text-stone-500 uppercase tracking-wider">历练事件</span>
            <h3 class="text-lg font-bold text-amber-400">{{ currentEvent.title }}</h3>
            <p class="text-stone-300 text-sm leading-relaxed">{{ currentEvent.description }}</p>

            <!-- 历练进度 -->
            <div v-if="currentEvent.duration > 0" class="bg-[#1c1917] rounded p-2 border border-stone-700">
              <div class="flex justify-between text-xs text-stone-500 mb-1">
                <span>历练进度</span>
                <span>{{ exploreProgressText }}</span>
              </div>
              <div class="h-1.5 bg-stone-800 rounded-full overflow-hidden">
                <div
                  class="h-full bg-gradient-to-r from-emerald-700 to-emerald-400 transition-all duration-1000"
                  :style="{ width: `${exploreProgressPercent}%` }"
                ></div>
              </div>
            </div>

            <div v-if="currentEvent.type === 'combat'" class="mt-4">
              <button
                @click="enterCombatAction"
                class="w-full py-3 bg-gradient-to-r from-rose-900/80 to-[#881337] hover:from-rose-800/80 hover:to-[#9f1239] border border-rose-700 text-rose-400 rounded-lg transition-all font-bold"
              >
                进入战斗
              </button>
            </div>

            <div v-if="currentEvent.rewards && currentEvent.rewards.exp" class="text-sm text-emerald-400">
              预计获得: {{ formatNumber(currentEvent.rewards.exp) }} 修为
            </div>
          </div>

          <button
            @click="completeExploreAction"
            class="py-2 px-4 bg-[#44403c] hover:bg-[#57534e] border border-stone-600 text-stone-300 rounded-lg transition-colors"
          >
            结束历练
          </button>
        </div>

        <!-- AI 状态 -->
        <div v-if="aiStatus" class="bg-[#292524] rounded-lg p-3 border border-stone-700">
          <div class="flex items-center gap-2 text-sm">
            <div :class="aiStatus.available ? 'text-emerald-400' : 'text-amber-400'">
              <svg v-if="aiStatus.available" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <span class="text-stone-400">
              AI 生成: {{ aiStatus.available ? '已启用' : '使用模板' }}
            </span>
            <span v-if="aiStatus.provider" class="text-stone-500 text-xs">
              ({{ aiStatus.provider }})
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 历练探索面板组件（重构版）
 *
 * 重构要点：
 *   1. 新增时长类型选择 UI（short/medium/long）
 *   2. 显示各时长的奖励倍率与受伤概率
 *   3. 风险提示：提前结束惩罚、受伤风险
 *   4. 历练中显示进度条
 *   5. 使用统一 API 层进行历练操作
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  getAiStatus,
  getExploreEvent,
  getExploreStatus,
  startExplore,
  completeExplore,
  enterCombat,
  type DurationType
} from '../../api/explore'
import { getMapInfo } from '../../api/map'
import { getGameBalancePublic, type AdventureConfig, type DurationTypeConfig } from '../../api/config'
import { useUIStore } from '../../stores/ui'
// 修复 B27：奖励数值未走 formatNumber，大数显示为科学计数法或精度丢失
import { formatNumber } from '../../utils/format'

const emit = defineEmits(['close', 'combat'])

const uiStore = useUIStore()

const currentMap = ref<any>(null)
const timeOfDay = ref('')
const weather = ref('')
const aiStatus = ref<any>(null)
const isExploring = ref(false)
const currentEvent = ref<any>(null)
const isLoading = ref(false)
// 默认中时历练（推荐档位）—— 实际默认值从后端配置读取，未拉取到时降级为 medium
const selectedDurationType = ref<DurationType>('medium')
// 历练开始时间与总时长（用于进度展示）
const exploreStartTime = ref<number>(0)
const exploreTotalDuration = ref<number>(0)
const nowTick = ref<number>(Date.now())
let autoCompleteTimer: number | null = null
let progressTimer: number | null = null

// 历练配置（从后端 /api/config/game-balance/public 拉取，未拉取到时降级为 null）
const adventureConfig = ref<AdventureConfig | null>(null)

/**
 * 时长类型列表（供 v-for 渲染）
 * 顺序固定为 short → medium → long，每项附带样式映射
 */
const durationTypeList = computed(() => {
  if (!adventureConfig.value) return []
  const types = adventureConfig.value.duration_types
  const defaultType = adventureConfig.value.default_duration_type || 'medium'
  // 样式映射表（按 short/medium/long 区分颜色）
  const styleMap: Record<string, { titleColor: string; activeBorder: string; activeRing: string; hoverBorder: string }> = {
    short: { titleColor: 'text-emerald-300', activeBorder: 'border-emerald-600', activeRing: 'ring-emerald-600/30', hoverBorder: 'border-emerald-700' },
    medium: { titleColor: 'text-amber-300', activeBorder: 'border-amber-600', activeRing: 'ring-amber-600/30', hoverBorder: 'border-amber-700' },
    long: { titleColor: 'text-rose-300', activeBorder: 'border-rose-600', activeRing: 'ring-rose-600/30', hoverBorder: 'border-rose-700' }
  }
  return (['short', 'medium', 'long'] as const).map(key => ({
    key,
    config: types[key] as DurationTypeConfig,
    isDefault: key === defaultType,
    ...styleMap[key]
  }))
})

/**
 * 当前选中的时长类型标签（从后端 label 字段读取，移除硬编码映射）
 */
const durationTypeLabel = computed(() => {
  if (!adventureConfig.value) {
    // 降级文案，仅在配置未加载时使用
    const fallback = { short: '短时历练', medium: '中时历练', long: '长时历练' }
    return fallback[selectedDurationType.value]
  }
  return adventureConfig.value.duration_types[selectedDurationType.value]?.label || '历练'
})

/**
 * 提前结束惩罚百分比文案（如 "50%"），从后端 early_finish_penalty 计算
 */
const earlyFinishPenaltyPercent = computed(() => {
  const penalty = adventureConfig.value?.early_finish_penalty ?? 0.5
  return `${Math.round(penalty * 100)}%`
})

/**
 * 格式化秒数为中文时长标签（如 30秒 / 1分30秒 / 5分钟）
 */
const formatDurationLabel = (sec: number) => {
  if (!sec) return '0秒'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m === 0) return `${s}秒`
  if (s === 0) return m >= 60 ? `${Math.floor(m / 60)}分钟` : `${m}分钟`
  return m >= 60 ? `${Math.floor(m / 60)}分${m % 60}秒` : `${m}分${s}秒`
}

/**
 * 格式化概率（0-1 → 百分比文案，如 0.05 → "5%"）
 */
const formatPercent = (rate: number) => {
  return `${Math.round(rate * 100)}%`
}

/**
 * 历练进度百分比
 */
const exploreProgressPercent = computed(() => {
  if (!exploreTotalDuration.value || !exploreStartTime.value) return 0
  const elapsed = Math.floor((nowTick.value - exploreStartTime.value) / 1000)
  return Math.min(100, Math.max(0, Math.floor(elapsed / exploreTotalDuration.value * 100)))
})

/**
 * 历练进度文本（已时长/总时长）
 */
const exploreProgressText = computed(() => {
  if (!exploreTotalDuration.value || !exploreStartTime.value) return ''
  const elapsed = Math.max(0, Math.floor((nowTick.value - exploreStartTime.value) / 1000))
  return `${formatSeconds(elapsed)} / ${formatSeconds(exploreTotalDuration.value)}`
})

/**
 * 格式化秒数为 mm:ss
 */
const formatSeconds = (sec: number) => {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 获取历练信息
 */
const fetchExploreInfo = async () => {
  try {
    const [mapRes, aiRes] = await Promise.all([
      getMapInfo(),
      getAiStatus()
    ])

    if (mapRes.data?.current_map) {
      currentMap.value = mapRes.data.current_map
    }

    if (aiRes.data?.data) {
      aiStatus.value = aiRes.data.data
    }
  } catch (error) {
    console.error('获取历练信息失败:', error)
  }
}

/**
 * 获取环境信息
 */
const fetchEnvironment = async () => {
  try {
    const res = await getExploreEvent()
    if (res.data?.data) {
      timeOfDay.value = res.data.data.time_of_day || ''
      weather.value = res.data.data.weather || ''
    }
  } catch (error) {
    console.error('获取环境信息失败:', error)
  }
}

/**
 * 选择时长类型
 */
const selectDurationType = (type: DurationType) => {
  selectedDurationType.value = type
}

/**
 * 开始历练
 * 重构后传递 durationType（short/medium/long），由后端根据配置计算具体时长与奖励
 */
const startExploreAction = async () => {
  if (isLoading.value) return
  isLoading.value = true

  try {
    const res = await startExplore(selectedDurationType.value)

    if (res.data?.data?.event) {
      isExploring.value = true
      currentEvent.value = res.data.data.event

      // 记录开始时间与总时长，用于进度展示
      exploreStartTime.value = Date.now()
      exploreTotalDuration.value = res.data.data.event.duration || 0

      // 启动进度刷新计时器
      if (progressTimer) clearInterval(progressTimer)
      progressTimer = window.setInterval(() => {
        nowTick.value = Date.now()
      }, 1000)

      uiStore.addLog({
        content: `开始${durationTypeLabel.value}：${res.data.data.event.title}`,
        type: 'info',
        actorId: 'self'
      })

      const duration = res.data.data.event.duration || 30
      const isCombat = res.data.data.event.type === 'combat'

      // 自动完成定时器：非战斗事件且有时长时，到时自动结算
      if (!isCombat && duration > 0) {
        autoCompleteTimer = window.setTimeout(async () => {
          await completeExploreAction()
        }, duration * 1000)
      }
    }
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '历练失败'
    uiStore.showToast(msg, 'error')
  } finally {
    isLoading.value = false
  }
}

/**
 * 完成历练
 * 后端会根据实际时长计算奖励，提前结束时按比例 × (1 - early_finish_penalty) 结算
 */
const completeExploreAction = async () => {
  try {
    const res = await completeExplore()

    if (res.data?.data?.rewards) {
      const rewards = res.data.data.rewards
      // 修复 B27：奖励数值统一走 formatNumber，避免大数显示为科学计数法或精度丢失
      let rewardText = `获得 ${formatNumber(rewards.exp || 0)} 修为`
      if (rewards.items?.length) {
        rewardText += `，${rewards.items.map((i: any) => i.item_key).join('、')}`
      }
      if (rewards.spirit_stones) {
        rewardText += `，${formatNumber(rewards.spirit_stones)} 灵石`
      }

      // 提前结束时提示奖励缩放比例（后端返回字符串如 "1%"，直接显示）
      if (rewards.early_finish) {
        const scale = rewards.reward_scale
        // 兼容字符串（"1%"）和数字（0.01）两种格式
        const scaleText = typeof scale === 'string'
          ? scale
          : `${Math.round((scale || 0) * 100)}%`
        rewardText += `（提前结束，仅获得 ${scaleText} 奖励）`
      }

      // 受伤提示
      if (rewards.injury) {
        rewardText += `，并因战斗受伤损失 ${formatNumber(rewards.injury.hp_loss || 0)} 气血`
      }

      uiStore.addLog({
        content: `历练完成：${rewardText}`,
        type: rewards.injury ? 'warning' : 'success',
        actorId: 'self'
      })

      uiStore.showToast(rewards.injury ? '历练完成，但受了伤' : '历练完成！', rewards.injury ? 'warning' : 'success')
    }

    isExploring.value = false
    currentEvent.value = null
    exploreStartTime.value = 0
    exploreTotalDuration.value = 0

    if (autoCompleteTimer) {
      clearTimeout(autoCompleteTimer)
      autoCompleteTimer = null
    }
    if (progressTimer) {
      clearInterval(progressTimer)
      progressTimer = null
    }

    emit('close')
  } catch (error: any) {
    // 后端返回 { code, message }，兼容旧格式
    const code = error.response?.data?.code
    const msg = error.response?.data?.message || '完成历练失败'

    if (code === 'ADVENTURE_NOT_COMPLETED') {
      uiStore.showToast(msg, 'warning')
    } else {
      uiStore.showToast(msg, 'error')
    }
  }
}

/**
 * 进入战斗
 */
const enterCombatAction = async () => {
  try {
    const res = await enterCombat()

    if (res.data?.data?.battle_id) {
      uiStore.addLog({
        content: `战斗遭遇：${res.data.data.description || '遭遇敌人'}`,
        type: 'combat',
        actorId: 'self'
      })

      emit('close')
      emit('combat', res.data.data.battle_id)
    } else {
      uiStore.showToast('生成战斗失败', 'error')
    }
  } catch (error: any) {
    // 后端返回 { code, message }，兼容 error 字段
    const msg = error.response?.data?.message || error.response?.data?.error || '进入战斗失败'
    uiStore.showToast(msg, 'error')
  }
}

/**
 * 组件挂载时：
 *   1. 先调用 /explore/status 恢复"历练中"状态（防止关闭面板后状态丢失）
 *   2. 并行拉取地图信息与环境信息
 *
 * 业务计算下沉后端的核心体现：
 *   - 剩余时间、总时长、是否过期均由后端权威返回
 *   - 前端不再用本地缓存估算历练进度
 */
onMounted(async () => {
  // 第一步：恢复进行中的历练状态
  await restoreAdventureStatus()

  // 第二步：并行拉取地图、环境与游戏配置
  fetchExploreInfo()
  fetchEnvironment()
  fetchAdventureConfig()
})

/**
 * 拉取历练配置（时长分级、奖励倍率、受伤概率等）
 * 接口：GET /api/config/game-balance/public
 *
 * 设计目的：
 *   遵循"配置驱动"原则，前端面板不再硬编码时长/倍率/概率，
 *   统一从后端拉取，确保 GM 修改配置后前端立即同步。
 */
const fetchAdventureConfig = async () => {
  try {
    const res = await getGameBalancePublic()
    if (res.data?.code === 200 && res.data.data?.adventure) {
      adventureConfig.value = res.data.data.adventure
      // 同步默认时长类型（后端配置的推荐档位）
      const defaultType = res.data.data.adventure.default_duration_type
      if (defaultType) {
        selectedDurationType.value = defaultType
      }
    }
  } catch (error) {
    console.error('[ExplorePanel] 拉取历练配置失败，将使用降级显示:', error)
  }
}

/**
 * 从后端恢复"历练中"状态
 *
 * 场景：玩家在历练进行中关闭了面板，重新打开时
 *   - 后端仍有 in_progress 的 PlayerAdventure 记录
 *   - 前端本地状态已丢失（组件被 v-if 销毁）
 *   - 需要根据后端权威数据恢复 isExploring、currentEvent、计时器等
 */
const restoreAdventureStatus = async () => {
  try {
    const res = await getExploreStatus()
    const data = res.data?.data
    if (!data || !data.is_adventuring || !data.adventure) {
      // 无进行中的历练，保持默认的"未历练"状态
      return
    }

    const adventure = data.adventure
    // 恢复"历练中"状态
    isExploring.value = true
    // event_data 是后端权威事件数据（含 type/title/description/duration/rewards）
    currentEvent.value = adventure.event_data || {
      type: adventure.event_type,
      title: '进行中的历练',
      description: '你正在进行历练，请等待完成或手动结束。',
      duration: data.total_seconds
    }
    // 恢复开始时间（基于后端返回的 start_time）
    exploreStartTime.value = new Date(adventure.start_time).getTime()
    exploreTotalDuration.value = data.total_seconds || 0

    // 启动进度刷新计时器（每秒 tick 驱动进度条）
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = window.setInterval(() => {
      nowTick.value = Date.now()
    }, 1000)

    // 已过期：提示玩家点击完成领取奖励
    if (data.is_expired) {
      uiStore.addLog({
        content: '历练时间已到，请点击"完成历练"领取奖励',
        type: 'warning',
        actorId: 'self'
      })
      uiStore.showToast('历练已结束，请点击完成领取奖励', 'warning')
      return
    }

    // 战斗事件：提示玩家进入战斗
    if (adventure.event_type === 'combat') {
      uiStore.addLog({
        content: '历练中遭遇敌人，请进入战斗',
        type: 'combat',
        actorId: 'self'
      })
      return
    }

    // 非战斗事件且未过期：重新设置自动完成定时器
    // 剩余秒数由后端权威计算，避免时钟漂移
    const remainingMs = data.remaining_seconds * 1000
    if (autoCompleteTimer) {
      clearTimeout(autoCompleteTimer)
    }
    autoCompleteTimer = window.setTimeout(async () => {
      await completeExploreAction()
    }, remainingMs)
  } catch (error) {
    console.error('恢复历练状态失败:', error)
    // 失败时不阻塞面板初始化，玩家可正常开始新历练
  }
}

onUnmounted(() => {
  if (autoCompleteTimer) {
    clearTimeout(autoCompleteTimer)
    autoCompleteTimer = null
  }
  if (progressTimer) {
    clearInterval(progressTimer)
    progressTimer = null
  }
})
</script>
