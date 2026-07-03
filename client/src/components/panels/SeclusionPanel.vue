/**
 * 闭关修炼选择面板组件
 *
 * 弹窗式组件，用于让玩家在开始闭关前选择修炼方式：
 *   - 常规闭关（normal）：短时多次，最长 30 分钟，每日 3 次，冷却 5 分钟
 *   - 深度闭关（deep）：长线挂机 4-8 小时，每日 1 次，2 倍收益，需筑基期以上
 *                     未达最短时长结束时按强行出关处理，损失 50% 收益
 *
 * 设计依据：参考修仙游戏指南文档第 4 节"修炼方式"
 *   常规修炼使用 .闭关修炼，适合日常获取修为；
 *   高阶或长线挂机可使用 .深度闭关
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-stone-800 rounded-lg p-6 max-w-2xl w-full mx-4 shadow-2xl animate-fade-in max-h-[85vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-cyan-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          闭关修炼
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- 今日次数总览（醒目展示，避免玩家点了开始才发现次数用尽） -->
        <div class="grid grid-cols-2 gap-3 bg-[#292524] rounded-lg p-3 border border-stone-700">
          <div class="flex items-center justify-between">
            <div class="text-xs text-stone-400">常规闭关</div>
            <div class="flex items-center gap-2">
              <div class="text-xs text-stone-500">今日剩余</div>
              <div class="px-2 py-0.5 rounded text-xs font-bold"
                :class="normalRemaining > 0
                  ? 'bg-emerald-950/50 border border-emerald-800/60 text-emerald-400'
                  : 'bg-rose-950/50 border border-rose-800/60 text-rose-400'">
                {{ normalRemaining }} / {{ normalConfig.daily_limit }}
              </div>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <div class="text-xs text-stone-400">深度闭关</div>
            <div class="flex items-center gap-2">
              <div class="text-xs text-stone-500">今日剩余</div>
              <div class="px-2 py-0.5 rounded text-xs font-bold"
                :class="deepRemaining > 0
                  ? 'bg-emerald-950/50 border border-emerald-800/60 text-emerald-400'
                  : 'bg-rose-950/50 border border-rose-800/60 text-rose-400'">
                {{ deepRemaining }} / {{ deepConfig.daily_limit }}
              </div>
            </div>
          </div>
        </div>

        <!-- 冷却中提示（醒目红色 banner，避免玩家误以为系统故障） -->
        <div v-if="cooldownRemainingText" class="bg-amber-950/30 border border-amber-800/50 rounded-lg p-2.5 text-xs text-amber-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          <span>闭关冷却中：{{ cooldownRemainingText }}</span>
        </div>

        <!-- 模式选择卡片 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- 常规闭关卡片 -->
          <button
            @click="selectMode('normal')"
            :disabled="loading || normalRemaining <= 0 || isNormalCooldown"
            class="text-left bg-[#292524] hover:bg-[#332b27] border rounded-lg p-5 transition-all duration-300 group relative disabled:opacity-60 disabled:cursor-not-allowed"
            :class="selectedMode === 'normal'
              ? 'border-cyan-600 ring-1 ring-cyan-600/30'
              : 'border-stone-700 hover:border-cyan-700'"
          >
            <!-- 次数已用尽锁标 -->
            <div v-if="normalRemaining <= 0" class="absolute top-2 right-2 px-2 py-0.5 rounded bg-rose-950/60 border border-rose-800/60 text-rose-400 text-[10px] font-bold">
              今日已用尽
            </div>
            <!-- 图标 + 名称 -->
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <div class="w-10 h-10 rounded-full bg-cyan-950/40 border border-cyan-700/40 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                  </svg>
                </div>
                <div>
                  <div class="text-base font-bold text-cyan-300">常规闭关</div>
                  <div class="text-xs text-stone-500">日常修炼，随时可停</div>
                </div>
              </div>
              <!-- 选中标识 -->
              <div v-if="selectedMode === 'normal'" class="w-5 h-5 rounded-full bg-cyan-600 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
            </div>
            <!-- 参数列表 -->
            <ul class="text-xs text-stone-400 space-y-1.5 mb-3">
              <li class="flex items-center gap-2">
                <span class="text-stone-500">单次时长：</span>
                <span class="text-stone-200">最长 {{ formatDuration(normalConfig.max_duration) }}</span>
              </li>
              <li class="flex items-center gap-2">
                <span class="text-stone-500">每日次数：</span>
                <span class="text-stone-200">{{ normalConfig.daily_limit }} 次</span>
                <!-- 剩余次数醒目徽章 -->
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold"
                  :class="normalRemaining > 0
                    ? 'bg-emerald-950/50 border border-emerald-800/60 text-emerald-400'
                    : 'bg-rose-950/50 border border-rose-800/60 text-rose-400'">
                  剩余 {{ normalRemaining }} 次
                </span>
              </li>
              <li class="flex items-center gap-2">
                <span class="text-stone-500">冷却时间：</span>
                <span class="text-stone-200">{{ formatDuration(normalConfig.cooldown) }}</span>
              </li>
              <li class="flex items-center gap-2">
                <span class="text-stone-500">收益倍率：</span>
                <span class="text-cyan-400">×{{ normalConfig.exp_rate }}</span>
              </li>
            </ul>
            <!-- 时长滑块（常规闭关） -->
            <div v-if="selectedMode === 'normal'" class="mt-3 pt-3 border-t border-stone-700">
              <label class="text-xs text-stone-400 flex justify-between mb-1.5">
                <span>闭关时长</span>
                <span class="text-cyan-300 font-mono">{{ formatDuration(normalDuration) }}</span>
              </label>
              <input
                type="range"
                v-model.number="normalDuration"
                min="60"
                :max="normalConfig.max_duration"
                step="60"
                class="w-full accent-cyan-600"
              />
              <div class="flex justify-between text-[10px] text-stone-500 mt-1">
                <span>1分钟</span>
                <span>{{ formatDuration(normalConfig.max_duration) }}</span>
              </div>
            </div>
          </button>

          <!-- 深度闭关卡片 -->
          <button
            @click="selectMode('deep')"
            :disabled="loading || !canDeep || deepRemaining <= 0 || isDeepCooldown"
            class="text-left bg-[#292524] hover:bg-[#332b27] border rounded-lg p-5 transition-all duration-300 group relative disabled:opacity-60 disabled:cursor-not-allowed"
            :class="selectedMode === 'deep'
              ? 'border-purple-600 ring-1 ring-purple-600/30'
              : 'border-stone-700 hover:border-purple-700'"
          >
            <!-- 次数已用尽锁标 -->
            <div v-if="deepRemaining <= 0" class="absolute top-2 right-2 px-2 py-0.5 rounded bg-rose-950/60 border border-rose-800/60 text-rose-400 text-[10px] font-bold">
              今日已用尽
            </div>
            <!-- 境界不足锁标 -->
            <div v-else-if="!canDeep" class="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-amber-950/40 border border-amber-800/50 text-amber-500 text-[10px]">
              需{{ deepConfig.min_realm }}
            </div>
            <!-- 图标 + 名称 -->
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <div class="w-10 h-10 rounded-full bg-purple-950/40 border border-purple-700/40 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                  </svg>
                </div>
                <div>
                  <div class="text-base font-bold text-purple-300">深度闭关</div>
                  <div class="text-xs text-stone-500">长线挂机，2倍收益</div>
                </div>
              </div>
              <div v-if="selectedMode === 'deep'" class="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
            </div>
            <!-- 参数列表 -->
            <ul class="text-xs text-stone-400 space-y-1.5 mb-3">
              <li class="flex items-center gap-2">
                <span class="text-stone-500">单次时长：</span>
                <span class="text-stone-200">{{ formatDuration(deepConfig.min_duration) }} - {{ formatDuration(deepConfig.max_duration) }}</span>
              </li>
              <li class="flex items-center gap-2">
                <span class="text-stone-500">每日次数：</span>
                <span class="text-stone-200">{{ deepConfig.daily_limit }} 次</span>
                <!-- 剩余次数醒目徽章 -->
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold"
                  :class="deepRemaining > 0
                    ? 'bg-emerald-950/50 border border-emerald-800/60 text-emerald-400'
                    : 'bg-rose-950/50 border border-rose-800/60 text-rose-400'">
                  剩余 {{ deepRemaining }} 次
                </span>
              </li>
              <li class="flex items-center gap-2">
                <span class="text-stone-500">境界要求：</span>
                <span class="text-stone-200">{{ deepConfig.min_realm }}</span>
                <span :class="canDeep ? 'text-emerald-400' : 'text-rose-400'">{{ canDeep ? '✓ 已达成' : '× 未达成' }}</span>
              </li>
              <li class="flex items-center gap-2">
                <span class="text-stone-500">收益倍率：</span>
                <span class="text-purple-400">×{{ deepConfig.exp_rate }}</span>
              </li>
              <li class="flex items-center gap-2">
                <span class="text-stone-500">强行出关：</span>
                <span class="text-amber-400">损失 {{ Math.round(deepConfig.forced_penalty * 100) }}% 收益</span>
              </li>
            </ul>
            <!-- 时长滑块（深度闭关） -->
            <div v-if="selectedMode === 'deep'" class="mt-3 pt-3 border-t border-stone-700">
              <label class="text-xs text-stone-400 flex justify-between mb-1.5">
                <span>闭关时长</span>
                <span class="text-purple-300 font-mono">{{ formatDuration(deepDuration) }}</span>
              </label>
              <input
                type="range"
                v-model.number="deepDuration"
                :min="deepConfig.min_duration"
                :max="deepConfig.max_duration"
                :step="1800"
                class="w-full accent-purple-600"
              />
              <div class="flex justify-between text-[10px] text-stone-500 mt-1">
                <span>{{ formatDuration(deepConfig.min_duration) }}</span>
                <span>{{ formatDuration(deepConfig.max_duration) }}</span>
              </div>
            </div>
          </button>
        </div>

        <!-- 风险提示 -->
        <div v-if="selectedMode === 'deep'" class="bg-amber-950/20 border border-amber-900/40 rounded-lg p-3 text-xs text-amber-400">
          <svg xmlns="http://www.w3.org/2000/svg" class="inline w-4 h-4 mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          深度闭关需达到 {{ deepConfig.min_realm }} 方可进行；若未达最短时长 {{ formatDuration(deepConfig.min_duration) }} 提前结束，将按强行出关处理，损失 {{ Math.round(deepConfig.forced_penalty * 100) }}% 收益。
        </div>

        <!-- 收益预估 -->
        <div class="bg-[#292524] rounded-lg p-4 border border-stone-700">
          <div class="text-xs text-stone-500 mb-2">收益预估</div>
          <div class="grid grid-cols-2 gap-3">
            <div class="text-center">
              <div class="text-[10px] text-stone-500 mb-0.5">基础速率</div>
              <div class="text-sm text-stone-300 font-mono">{{ baseExpRate }} /秒</div>
            </div>
            <div class="text-center">
              <div class="text-[10px] text-stone-500 mb-0.5">预计获得修为</div>
              <div
                class="text-lg font-mono font-bold"
                :class="selectedMode === 'deep' ? 'text-purple-400' : 'text-cyan-400'"
              >+{{ estimatedExp }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="mt-4 flex gap-2">
        <button
          @click="$emit('close')"
          class="px-4 py-2.5 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors"
        >
          取消
        </button>
        <button
          @click="handleStart"
          :disabled="loading || (selectedMode === 'deep' ? (!canDeep || deepRemaining <= 0 || isDeepCooldown) : (normalRemaining <= 0 || isNormalCooldown))"
          class="flex-1 py-2.5 rounded-lg font-bold tracking-widest text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          :class="selectedMode === 'deep'
            ? 'bg-purple-950/40 border border-purple-700 text-purple-300 hover:bg-purple-900/40 hover:border-purple-500'
            : 'bg-cyan-950/40 border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40 hover:border-cyan-500'"
        >
          <span v-if="loading">正在进入...</span>
          <span v-else-if="selectedMode === 'deep' && deepRemaining <= 0">今日深度闭关已用尽</span>
          <span v-else-if="selectedMode === 'normal' && normalRemaining <= 0">今日常规闭关已用尽</span>
          <span v-else-if="selectedMode === 'deep' && isDeepCooldown">深度闭关冷却中</span>
          <span v-else-if="selectedMode === 'normal' && isNormalCooldown">常规闭关冷却中</span>
          <span v-else>开始{{ selectedMode === 'deep' ? '深度' : '常规' }}闭关</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'

const emit = defineEmits(['close'])

const store = usePlayerStore()
const uiStore = useUIStore()

const loading = ref(false)
const selectedMode = ref('normal') // 默认常规闭关
const normalDuration = ref(1800) // 默认 30 分钟
const deepDuration = ref(14400) // 默认 4 小时

// 当前时间 tick（每秒更新一次，用于驱动冷却倒计时显示）
const now = ref(Date.now())
let tickTimer = null

// 闭关配置（从后端拉取的状态中读取，降级默认值）
const normalConfig = computed(() => {
  return store.systemConfig?.seclusion?.normal || {
    max_duration: 1800,
    daily_limit: 3,
    cooldown: 300,
    exp_rate: 1
  }
})
const deepConfig = computed(() => {
  return store.systemConfig?.seclusion?.deep || {
    min_duration: 14400,
    max_duration: 28800,
    daily_limit: 1,
    cooldown: 3600,
    exp_rate: 2,
    min_realm: '筑基期',
    forced_penalty: 0.5
  }
})

// 基础修为速率
const baseExpRate = computed(() => {
  return store.systemConfig?.seclusion?.exp_rate || 1
})

// 每日剩余次数
const normalRemaining = computed(() => {
  return store.systemConfig?.seclusion?.normal_remaining ?? normalConfig.value.daily_limit
})
const deepRemaining = computed(() => {
  return store.systemConfig?.seclusion?.deep_remaining ?? deepConfig.value.daily_limit
})

/**
 * 计算指定模式的冷却剩余秒数
 * 基于 player.last_seclusion_time + config.cooldown - now
 * @param {object} cfg - 模式配置对象（含 cooldown 字段）
 * @returns {number} 剩余冷却秒数，<=0 表示冷却已结束
 */
const computeCooldownRemaining = (cfg) => {
  const cooldownSec = cfg?.cooldown || 0
  if (cooldownSec <= 0) return 0
  const lastTime = store.player?.last_seclusion_time
  if (!lastTime) return 0
  const lastTs = new Date(lastTime).getTime()
  if (isNaN(lastTs)) return 0
  const elapsedSec = Math.floor((now.value - lastTs) / 1000)
  return Math.max(0, cooldownSec - elapsedSec)
}

// 常规闭关冷却剩余秒数
const normalCooldownRemaining = computed(() => computeCooldownRemaining(normalConfig.value))
// 深度闭关冷却剩余秒数
const deepCooldownRemaining = computed(() => computeCooldownRemaining(deepConfig.value))

// 是否处于冷却中
const isNormalCooldown = computed(() => normalCooldownRemaining.value > 0)
const isDeepCooldown = computed(() => deepCooldownRemaining.value > 0)

/**
 * 冷却剩余文案（取常规/深度中较长的一个展示，避免误导）
 * 仅在玩家未闭关时显示
 */
const cooldownRemainingText = computed(() => {
  if (store.player?.is_secluded) return ''
  const normalRem = normalCooldownRemaining.value
  const deepRem = deepCooldownRemaining.value
  // 优先展示选中模式的冷却
  if (selectedMode.value === 'deep' && deepRem > 0) {
    return `深度闭关还需 ${formatDuration(deepRem)}`
  }
  if (normalRem > 0) {
    return `常规闭关还需 ${formatDuration(normalRem)}`
  }
  if (deepRem > 0) {
    return `深度闭关还需 ${formatDuration(deepRem)}`
  }
  return ''
})

/**
 * 当前玩家境界是否达到深度闭关要求
 * 后端返回 REALM_ORDER 中筑基期以上的境界才可深度闭关
 * 前端仅做基本判断，最终由后端校验
 */
const canDeep = computed(() => {
  const playerRealm = store.player?.realm || '凡人'
  const minRealm = deepConfig.value.min_realm || '筑基期'
  // 简化判断：境界名称中包含筑基/金丹/元婴/化神/炼虚/合体/大乘/渡劫/真仙 即视为达到要求
  const highRealmKeywords = ['筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫', '真仙']
  return highRealmKeywords.some(k => playerRealm.includes(k)) || playerRealm === minRealm
})

/**
 * 预计获得修为
 */
const estimatedExp = computed(() => {
  const duration = selectedMode.value === 'deep' ? deepDuration.value : normalDuration.value
  const modeRate = selectedMode.value === 'deep' ? deepConfig.value.exp_rate : normalConfig.value.exp_rate
  return Math.floor(duration * baseExpRate.value * modeRate)
})

/**
 * 选择模式
 * 增加次数与冷却校验，避免玩家选了不可用的模式
 */
const selectMode = (mode) => {
  if (mode === 'deep') {
    if (!canDeep.value) {
      uiStore.showToast(`深度闭关需达到 ${deepConfig.value.min_realm} 境界`, 'warning')
      return
    }
    if (deepRemaining.value <= 0) {
      uiStore.showToast('今日深度闭关次数已用尽，明日重置', 'warning')
      return
    }
    if (isDeepCooldown.value) {
      uiStore.showToast(`深度闭关冷却中，还需 ${formatDuration(deepCooldownRemaining.value)}`, 'warning')
      return
    }
  } else {
    if (normalRemaining.value <= 0) {
      uiStore.showToast('今日常规闭关次数已用尽，明日重置', 'warning')
      return
    }
    if (isNormalCooldown.value) {
      uiStore.showToast(`常规闭关冷却中，还需 ${formatDuration(normalCooldownRemaining.value)}`, 'warning')
      return
    }
  }
  selectedMode.value = mode
}

/**
 * 格式化时长（秒 → 中文）
 */
const formatDuration = (seconds) => {
  if (!seconds) return '0秒'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  let parts = []
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0) parts.push(`${m}分钟`)
  if (s > 0 && h === 0) parts.push(`${s}秒`)
  return parts.join('') || '0秒'
}

/**
 * 开始闭关
 * 前端二次校验：次数与冷却，避免无效请求打到后端
 */
const handleStart = async () => {
  if (loading.value) return
  // 二次校验，防止按钮禁用状态被绕过
  if (selectedMode.value === 'deep') {
    if (!canDeep.value || deepRemaining.value <= 0 || isDeepCooldown.value) {
      uiStore.showToast('当前不可开始深度闭关（境界/次数/冷却限制）', 'warning')
      return
    }
  } else {
    if (normalRemaining.value <= 0 || isNormalCooldown.value) {
      uiStore.showToast('当前不可开始常规闭关（次数/冷却限制）', 'warning')
      return
    }
  }
  loading.value = true
  try {
    const duration = selectedMode.value === 'deep' ? deepDuration.value : normalDuration.value
    const res = await store.startSeclusion(selectedMode.value, duration)
    const modeLabel = selectedMode.value === 'deep' ? '深度闭关' : '常规闭关'
    uiStore.showToast(`进入${modeLabel}状态`, 'success')
    uiStore.addLog({
      content: `开始${modeLabel}修炼，摒除杂念，感悟天地灵气。预计获得修为 ${estimatedExp.value} 点。`,
      type: 'info',
      actorId: 'self'
    })
    emit('close')
  } catch (error) {
    console.error('开始闭关失败:', error)
    const msg = error?.response?.data?.message || error?.response?.data?.error || '开始闭关失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  // 拉取最新闭关状态与配置（含每日剩余次数）
  await store.fetchSeclusionStatus()
  // 启动每秒 tick，驱动冷却倒计时显示
  // 注意：关闭面板时需清理，避免内存泄漏
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  // 清理定时器，避免组件销毁后定时器继续运行
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
})
</script>

<style scoped>
/* 滚动条样式 */
.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}
.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}
.overflow-y-auto::-webkit-scrollbar-thumb {
  background: #44403c;
  border-radius: 2px;
}
.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: #57534e;
}
</style>
