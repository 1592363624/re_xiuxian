<script setup lang="ts">
/**
 * 炼制系统面板组件（炼丹房 / 炼器阁）
 *
 * 功能说明：
 *   - 全屏遮罩 + 居中弹窗布局，emits('close') 关闭面板
 *   - 顶部 Tab 切换：炼丹房（alchemy 丹药）/ 炼器阁（refining 装备）
 *   - 顶部展示炼制技能信息：等级、称号、经验进度条、成功率加成
 *   - 每个已学配方以卡片形式展示，含产物、材料、成功率、冷却倒计时、炼制次数选择
 *   - 炼制成功/失败通过 uiStore.showToast 提示，禁用浏览器原生 alert/confirm
 *   - 所有业务逻辑通过 crafting API 调用后端，前端只做展示与交互
 *   - 炼制后刷新配方列表，同步材料持有量与冷却状态
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  getLearnedRecipes,
  craft,
  craftStart,
  craftHeat,
  craftFinish,
  craftCancel,
  type LearnedRecipe,
  type CraftSkillInfo,
  type LearnedRecipesData,
  type CraftStartResult,
  type CraftHeatResult,
  type CraftResult
} from '../../api/crafting'
import { useUIStore } from '../../stores/ui'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ====== 响应式状态 ======
const loading = ref(true)                          // 整体加载状态
const crafting = ref(false)                        // 炼制操作中状态锁，防止重复提交
const activeTab = ref<'alchemy' | 'refining'>('alchemy')  // 当前激活的 Tab
const alchemyRecipes = ref<LearnedRecipe[]>([])    // 炼丹配方列表
const refiningRecipes = ref<LearnedRecipe[]>([])   // 炼器配方列表
const skillInfo = ref<CraftSkillInfo | null>(null) // 炼制技能信息

// 每个配方的炼制次数选择（recipe_id -> 次数，默认 1）
const craftQuantities = ref<Record<string, number>>({})

// 数据拉取时间戳，用于本地冷却倒计时递减计算
const lastFetchTime = ref(Date.now())
// 当前时间戳，每秒更新一次驱动冷却倒计时刷新
const currentTime = ref(Date.now())
let timer: number | null = null

// ====== 火候控制状态 ======
// 当前火候会话（null 表示未开炉）
const heatSession = ref<CraftStartResult | null>(null)
// 各阶段的控火反馈记录，用于炉火时间线展示
const heatLogs = ref<CraftHeatResult[]>([])
// 控火请求进行中，防止连点导致跳阶段
const heatSubmitting = ref(false)
// 结算结果，用于成品展示弹层
const craftOutcome = ref<CraftResult | null>(null)
// 会话剩余秒数（由 currentTime 驱动）
const heatRemaining = computed(() => {
  if (!heatSession.value) return 0
  return Math.max(0, Math.floor((heatSession.value.expires_at - currentTime.value) / 1000))
})
// 可选火候档位列表
const heatOptions = computed(() => {
  if (!heatSession.value) return []
  const { heat_min, heat_max } = heatSession.value
  return Array.from({ length: heat_max - heat_min + 1 }, (_, i) => heat_min + i)
})
// 火候阶段是否已全部完成
const heatFinished = computed(() => {
  if (!heatSession.value) return false
  return heatLogs.value.length >= heatSession.value.total_stages
})

// ====== 计算属性 ======

/**
 * 当前 Tab 对应的配方列表
 */
const currentRecipes = computed(() => {
  return activeTab.value === 'alchemy' ? alchemyRecipes.value : refiningRecipes.value
})

/**
 * 经验进度百分比
 * - 未达满级：当前经验 / 下一级所需经验
 * - 已满级（next_level_exp 为 null）：100%
 */
const expProgress = computed(() => {
  if (!skillInfo.value) return 0
  const { exp, next_level_exp } = skillInfo.value
  if (next_level_exp === null || next_level_exp <= 0) return 100
  return Math.min(100, Math.floor((exp / next_level_exp) * 100))
})

/**
 * 是否已达技能满级
 */
const isMaxLevel = computed(() => {
  if (!skillInfo.value) return false
  return skillInfo.value.next_level_exp === null
})

// ====== 数据加载 ======

/**
 * 拉取已学配方列表（含材料持有量、冷却状态、实际成功率）
 * 组件挂载时与每次炼制后调用，保证数据与后端一致
 */
const fetchRecipes = async () => {
  loading.value = true
  try {
    const data: LearnedRecipesData = await getLearnedRecipes()
    alchemyRecipes.value = data.alchemy || []
    refiningRecipes.value = data.refining || []
    skillInfo.value = data.skill_info || null
    // 记录拉取时间，用于本地冷却递减
    lastFetchTime.value = Date.now()
    // 初始化未设置的炼制次数为 1
    initCraftQuantities(data.alchemy)
    initCraftQuantities(data.refining)
  } catch (error: any) {
    console.error('获取炼制配方失败:', error)
    uiStore.showToast('获取炼制配方失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 初始化配方的炼制次数（未设置时默认为 1）
 * @param recipes - 配方列表
 */
const initCraftQuantities = (recipes: LearnedRecipe[]) => {
  recipes.forEach((r) => {
    if (!craftQuantities.value[r.recipe_id]) {
      craftQuantities.value[r.recipe_id] = 1
    }
  })
}

// ====== 炼制操作 ======

/**
 * 执行炼制
 * - 校验材料是否充足、是否冷却中
 * - 调用后端 craft 接口，根据结果展示 toast
 * - 炼制后刷新配方列表，同步材料持有量与冷却状态
 * @param recipe - 配方对象
 */
const handleCraft = async (recipe: LearnedRecipe) => {
  // 操作中锁定，防止重复提交
  if (crafting.value) return
  // 材料不足或不可炼制时拦截
  if (!recipe.can_craft) {
    uiStore.showToast('材料不足或条件未满足，无法炼制', 'warning')
    return
  }
  // 冷却中拦截（本地计算）
  if (getCooldownRemaining(recipe) > 0) {
    uiStore.showToast(`${recipe.name}正在冷却中`, 'warning')
    return
  }

  const quantity = craftQuantities.value[recipe.recipe_id] || 1
  crafting.value = true
  try {
    const result = await craft(recipe.recipe_id, quantity)
    // 后端返回 { code, success, message, ... }，直接读取业务字段
    if (result.success) {
      uiStore.showToast(result.message || '炼制成功', 'success')
    } else {
      uiStore.showToast(result.message || '炼制失败', 'warning')
    }
    // 刷新配方列表，同步材料持有量、冷却、技能经验
    await fetchRecipes()
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '炼制失败'
    uiStore.showToast(msg, 'error')
  } finally {
    crafting.value = false
  }
}

// ====== 火候控制交互 ======

/**
 * 开炉：创建火候会话，进入控火流程
 * 与 handleCraft（一键炼制）互斥，玩家二选一
 * @param recipe - 配方对象
 */
const handleStartHeat = async (recipe: LearnedRecipe) => {
  if (crafting.value) return
  if (!recipe.can_craft) {
    uiStore.showToast('材料不足或条件未满足，无法炼制', 'warning')
    return
  }
  if (getCooldownRemaining(recipe) > 0) {
    uiStore.showToast(`${recipe.name}正在冷却中`, 'warning')
    return
  }

  const quantity = craftQuantities.value[recipe.recipe_id] || 1
  crafting.value = true
  try {
    const session = await craftStart(recipe.recipe_id, quantity)
    heatSession.value = session
    heatLogs.value = []
    craftOutcome.value = null
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '开炉失败'
    uiStore.showToast(msg, 'error')
  } finally {
    crafting.value = false
  }
}

/**
 * 控火：提交当前阶段的火候档位
 * 使用 heatSubmitting 锁防止连点造成阶段错乱
 * @param heat - 玩家选择的火候档位
 */
const handleSubmitHeat = async (heat: number) => {
  if (!heatSession.value || heatSubmitting.value || heatFinished.value) return

  heatSubmitting.value = true
  try {
    const res = await craftHeat(heat)
    heatLogs.value.push(res)
    // 阶段推进后更新提示，供下一阶段参考
    if (res.hint && heatSession.value) {
      heatSession.value.hint = res.hint
      heatSession.value.current_stage = res.current_stage
    }
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '控火失败'
    uiStore.showToast(msg, 'error')
    // 会话超时或失效时退出控火界面，避免玩家卡在无效状态
    if (msg.includes('超时') || msg.includes('没有进行中')) {
      heatSession.value = null
      heatLogs.value = []
    }
  } finally {
    heatSubmitting.value = false
  }
}

/**
 * 开炉结算：执行炼制并展示成品
 */
const handleFinishHeat = async () => {
  if (!heatSession.value || crafting.value) return

  crafting.value = true
  try {
    const result = await craftFinish()
    craftOutcome.value = result
    heatSession.value = null
    heatLogs.value = []
    uiStore.showToast(result.message || '炼制完成', result.success ? 'success' : 'warning')
    await fetchRecipes()
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '结算失败'
    uiStore.showToast(msg, 'error')
    heatSession.value = null
    heatLogs.value = []
  } finally {
    crafting.value = false
  }
}

/**
 * 停火散炉：放弃当前火候会话
 */
const handleCancelHeat = async () => {
  try {
    await craftCancel()
  } catch {
    // 取消失败不影响前端退出控火界面，会话最终会由服务端超时清理
  } finally {
    heatSession.value = null
    heatLogs.value = []
    uiStore.showToast('已停火散炉', 'info')
  }
}

/**
 * 火候档位对应的显示文案
 * @param heat - 档位数值
 * @returns 中文火候名称
 */
const getHeatLabel = (heat: number): string => {
  const labels: Record<number, string> = {
    1: '文火',
    2: '小火',
    3: '中火',
    4: '大火',
    5: '武火'
  }
  return labels[heat] || `${heat}档`
}

// ====== 辅助方法 ======

/**
 * 计算配方本地冷却剩余秒数
 * 基于后端返回的 cooldown_remaining + 本地已流逝时间递减
 * 避免因时钟漂移导致的误差，实际权威值由后端校验
 * @param recipe - 配方对象
 * @returns 剩余秒数
 */
const getCooldownRemaining = (recipe: LearnedRecipe): number => {
  if (recipe.cooldown_remaining <= 0) return 0
  const elapsedSec = Math.floor((currentTime.value - lastFetchTime.value) / 1000)
  return Math.max(0, recipe.cooldown_remaining - elapsedSec)
}

/**
 * 格式化冷却倒计时（HH:MM:SS）
 * @param sec - 剩余秒数
 */
const formatCountdown = (sec: number): string => {
  if (sec <= 0) return ''
  const hours = Math.floor(sec / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  const seconds = sec % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

/**
 * 品质对应的文字颜色类
 * @param quality - 品质 key
 */
const qualityClass = (quality: string): string => {
  const map: Record<string, string> = {
    common: 'text-gray-300',
    uncommon: 'text-green-400',
    rare: 'text-blue-400',
    epic: 'text-purple-400',
    legendary: 'text-yellow-400'
  }
  return map[quality] || 'text-gray-300'
}

/**
 * 品质中文名
 * @param quality - 品质 key
 */
const qualityLabel = (quality: string): string => {
  const map: Record<string, string> = {
    common: '凡品',
    uncommon: '灵品',
    rare: '珍品',
    epic: '仙品',
    legendary: '神品'
  }
  return map[quality] || '凡品'
}

/**
 * 判断配方是否可炼制（材料充足 + 无冷却 + 非操作中）
 * @param recipe - 配方对象
 */
const canCraft = (recipe: LearnedRecipe): boolean => {
  return recipe.can_craft && getCooldownRemaining(recipe) === 0 && !crafting.value
}

/**
 * 获取配方炼制按钮的禁用原因（用于按钮文案展示）
 * @param recipe - 配方对象
 */
const getDisableReason = (recipe: LearnedRecipe): string => {
  const remaining = getCooldownRemaining(recipe)
  if (remaining > 0) return `冷却中 ${formatCountdown(remaining)}`
  if (!recipe.can_craft) return '材料不足'
  return ''
}

// ====== 生命周期 ======
onMounted(() => {
  fetchRecipes()
  // 每秒更新当前时间，驱动冷却倒计时刷新
  timer = window.setInterval(() => {
    currentTime.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- 遮罩层：点击关闭面板 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>

    <!-- 主容器 -->
    <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-5xl h-[88vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
      <!-- 顶部标题栏 -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 2h6l3 7-3 3-3-2-3 2-3-3z"/>
            <path d="M10 2v6l2 2 2-2V2"/>
            <path d="M12 14v8"/>
            <path d="M8 22h8"/>
          </svg>
          炼制阁
        </h2>
        <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 炼制技能信息栏 -->
      <div v-if="skillInfo" class="p-4 border-b border-stone-800 bg-[#0c0a09]">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <!-- 等级与称号 -->
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-2">
              <span class="text-xs text-stone-500">等级</span>
              <span class="text-lg font-bold text-amber-400">{{ skillInfo.level }}</span>
              <span class="text-xs text-stone-600">/ {{ skillInfo.max_level }}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-stone-500">称号</span>
              <span class="text-sm font-bold text-violet-400 px-2 py-0.5 rounded bg-violet-900/30 border border-violet-700/50">{{ skillInfo.title }}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-stone-500">成功率加成</span>
              <span class="text-sm font-bold text-emerald-400">+{{ skillInfo.success_bonus }}%</span>
            </div>
          </div>

          <!-- 经验进度条 -->
          <div class="flex items-center gap-3 flex-1 min-w-[200px] max-w-md">
            <span class="text-xs text-stone-500 whitespace-nowrap">经验</span>
            <div class="flex-1 bg-stone-800 rounded-full h-2 overflow-hidden border border-stone-700">
              <div
                class="h-full bg-gradient-to-r from-amber-600 to-amber-400 transition-all duration-300"
                :style="{ width: expProgress + '%' }"
              ></div>
            </div>
            <span class="text-xs text-stone-400 whitespace-nowrap">
              <span v-if="isMaxLevel" class="text-amber-400">已满级</span>
              <span v-else>{{ skillInfo.exp }} / {{ skillInfo.next_level_exp }}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex items-center gap-1 p-3 border-b border-stone-800 bg-[#1c1917]">
        <button
          @click="activeTab = 'alchemy'"
          class="px-4 py-1.5 rounded text-sm whitespace-nowrap transition-colors flex items-center gap-1.5"
          :class="activeTab === 'alchemy'
            ? 'bg-amber-900/30 text-amber-400 border border-amber-700/50'
            : 'text-stone-500 hover:text-stone-300 border border-transparent'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 2h6l3 7-3 3-3-2-3 2-3-3z"/>
            <path d="M10 2v6l2 2 2-2V2"/>
            <path d="M12 14v8"/>
            <path d="M8 22h8"/>
          </svg>
          炼丹房
          <span class="text-xs text-stone-600">（{{ alchemyRecipes.length }}）</span>
        </button>
        <button
          @click="activeTab = 'refining'"
          class="px-4 py-1.5 rounded text-sm whitespace-nowrap transition-colors flex items-center gap-1.5"
          :class="activeTab === 'refining'
            ? 'bg-purple-900/30 text-purple-400 border border-purple-700/50'
            : 'text-stone-500 hover:text-stone-300 border border-transparent'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.5 17.5 3 6V3h3l11.5 11.5"/>
            <path d="m13 19 6-6"/>
            <path d="m16 16 4 4"/>
            <path d="m19 21 2-2"/>
          </svg>
          炼器阁
          <span class="text-xs text-stone-600">（{{ refiningRecipes.length }}）</span>
        </button>
      </div>

      <!-- 内容区域 -->
      <div class="flex-1 overflow-y-auto p-4">
        <!-- 加载中 -->
        <div v-if="loading" class="flex justify-center items-center h-64">
          <svg class="animate-spin h-10 w-10 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>

        <!-- 空状态 -->
        <div v-else-if="currentRecipes.length === 0" class="flex flex-col items-center justify-center h-64 text-stone-500">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
            <path d="M9 2h6l3 7-3 3-3-2-3 2-3-3z"/>
            <path d="M12 14v8"/>
            <path d="M8 22h8"/>
          </svg>
          <p>尚未习得任何{{ activeTab === 'alchemy' ? '丹方' : '器谱' }}，请先获取并学习配方</p>
        </div>

        <!-- 配方卡片列表 -->
        <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div
            v-for="recipe in currentRecipes"
            :key="recipe.recipe_id"
            class="bg-[#1c1917] border rounded-lg p-4 transition-all duration-300"
            :class="activeTab === 'alchemy'
              ? 'border-amber-900/40 hover:border-amber-700/60'
              : 'border-purple-900/40 hover:border-purple-700/60'"
          >
            <!-- 卡片头部：配方名称 + 类型徽章 -->
            <div class="flex justify-between items-start mb-2">
              <div>
                <h3 class="text-base font-bold flex items-center gap-2"
                    :class="activeTab === 'alchemy' ? 'text-amber-300' : 'text-purple-300'">
                  {{ recipe.name }}
                </h3>
                <p class="text-xs text-stone-500 mt-1 leading-relaxed">{{ recipe.description }}</p>
              </div>
            </div>

            <!-- 产物信息 -->
            <div class="bg-[#0c0a09] rounded p-2.5 border border-stone-800 mb-3">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="text-xs text-stone-500">产物</span>
                  <span class="text-sm font-bold" :class="qualityClass(recipe.product.quality)">
                    {{ recipe.product.name }}
                  </span>
                  <span class="text-xs text-stone-400">x{{ recipe.product.quantity }}</span>
                </div>
                <span class="text-xs px-2 py-0.5 rounded border border-stone-700"
                      :class="qualityClass(recipe.product.quality)">
                  {{ qualityLabel(recipe.product.quality) }}
                </span>
              </div>
            </div>

            <!-- 材料列表 -->
            <div class="mb-3">
              <div class="text-xs text-stone-500 mb-1.5">所需材料</div>
              <div class="space-y-1">
                <div
                  v-for="mat in recipe.materials"
                  :key="mat.item_key"
                  class="flex items-center justify-between text-xs bg-[#0c0a09] rounded px-2.5 py-1.5 border border-stone-800"
                >
                  <span class="text-stone-300">{{ mat.name }}</span>
                  <span :class="mat.sufficient ? 'text-stone-400' : 'text-red-400'">
                    {{ mat.owned }} / {{ mat.required }}
                    <span v-if="!mat.sufficient" class="ml-1 text-red-500">不足</span>
                  </span>
                </div>
              </div>
            </div>

            <!-- 成功率与技能经验 -->
            <div class="flex items-center gap-4 mb-3 text-xs">
              <div class="flex items-center gap-1.5">
                <span class="text-stone-500">基础成功率</span>
                <span class="text-stone-300">{{ recipe.base_success_rate }}%</span>
              </div>
              <svg class="w-3 h-3 text-stone-600" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
              <div class="flex items-center gap-1.5">
                <span class="text-stone-500">实际成功率</span>
                <span class="font-bold text-emerald-400">{{ recipe.actual_success_rate }}%</span>
              </div>
              <div class="flex items-center gap-1.5 ml-auto">
                <span class="text-stone-500">经验</span>
                <span class="text-cyan-400">+{{ recipe.skill_exp }}</span>
              </div>
            </div>

            <!-- 炼制次数选择 + 炼制按钮 -->
            <div class="flex items-center gap-3">
              <!-- 次数选择器 -->
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-stone-500">次数</span>
                <div class="flex items-center bg-[#0c0a09] border border-stone-700 rounded overflow-hidden">
                  <button
                    @click="craftQuantities[recipe.recipe_id] = Math.max(1, (craftQuantities[recipe.recipe_id] || 1) - 1)"
                    :disabled="crafting"
                    class="px-2 py-1 text-stone-400 hover:text-amber-400 hover:bg-stone-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >-</button>
                  <input
                    v-model.number="craftQuantities[recipe.recipe_id]"
                    type="number"
                    min="1"
                    max="10"
                    class="w-10 bg-transparent text-center text-sm text-stone-200 focus:outline-none"
                    @change="() => {
                      const v = craftQuantities[recipe.recipe_id]
                      if (!v || v < 1) craftQuantities[recipe.recipe_id] = 1
                      if (v > 10) craftQuantities[recipe.recipe_id] = 10
                    }"
                  />
                  <button
                    @click="craftQuantities[recipe.recipe_id] = Math.min(10, (craftQuantities[recipe.recipe_id] || 1) + 1)"
                    :disabled="crafting"
                    class="px-2 py-1 text-stone-400 hover:text-amber-400 hover:bg-stone-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >+</button>
                </div>
              </div>

              <!-- 炼制按钮组：开炉控火（高收益）/ 一键炼制（省事但有惩罚） -->
              <div class="flex-1 flex gap-2">
                <!-- 开炉控火：进入火候小游戏，可炼出更高品质 -->
                <button
                  @click="handleStartHeat(recipe)"
                  :disabled="!canCraft(recipe)"
                  :title="canCraft(recipe) ? '手动把控火候，偏差越小品质越高' : ''"
                  class="flex-1 py-2 rounded border transition-colors text-sm font-bold disabled:cursor-not-allowed"
                  :class="canCraft(recipe)
                    ? (activeTab === 'alchemy'
                        ? 'bg-amber-900/30 border-amber-700/50 text-amber-400 hover:bg-amber-800/50 hover:text-amber-300'
                        : 'bg-purple-900/30 border-purple-700/50 text-purple-400 hover:bg-purple-800/50 hover:text-purple-300')
                    : 'bg-stone-900 border-stone-700 text-stone-500'"
                >
                  <span v-if="canCraft(recipe)">开炉控火</span>
                  <span v-else>{{ getDisableReason(recipe) || '无法炼制' }}</span>
                </button>

                <!-- 一键炼制：跳过火候，承担固定成功率惩罚 -->
                <button
                  v-if="canCraft(recipe)"
                  @click="handleCraft(recipe)"
                  :disabled="crafting"
                  title="跳过火候把控，成功率略降且品质固定为中档"
                  class="px-3 py-2 rounded border border-stone-700 bg-stone-900/60 text-stone-400 text-xs hover:text-stone-200 hover:border-stone-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  一键
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ====== 火候控制浮层 ====== -->
    <div
      v-if="heatSession"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
    >
      <div class="w-full max-w-md bg-stone-900 border border-amber-800/50 rounded-lg shadow-2xl animate-fade-in">
        <!-- 标题栏 -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-stone-800">
          <div>
            <h3 class="text-amber-400 font-bold">{{ heatSession.recipe_name }}</h3>
            <p class="text-xs text-stone-500">
              第 {{ Math.min(heatLogs.length + 1, heatSession.total_stages) }} / {{ heatSession.total_stages }} 阶段
              · 数量 x{{ heatSession.quantity }}
            </p>
          </div>
          <!-- 剩余时间：低于 30 秒转红警示 -->
          <div class="text-right">
            <div class="text-xs text-stone-500">丹炉冷却倒计时</div>
            <div class="font-mono text-sm" :class="heatRemaining <= 30 ? 'text-red-400' : 'text-stone-300'">
              {{ heatRemaining }}s
            </div>
          </div>
        </div>

        <!-- 炉火动画区 -->
        <div class="px-4 py-5 flex flex-col items-center">
          <div
            class="w-24 h-24 rounded-full flex items-center justify-center text-4xl transition-all duration-500 furnace-glow"
            :class="{
              'furnace-low': heatSession.hint?.level === 'low',
              'furnace-mid': heatSession.hint?.level === 'mid',
              'furnace-high': heatSession.hint?.level === 'high'
            }"
          >
            🔥
          </div>
          <!-- 火候提示：模糊描述，玩家据此推断档位 -->
          <p v-if="!heatFinished" class="mt-4 text-center text-sm text-amber-300/90 px-2">
            {{ heatSession.hint?.text }}
          </p>
          <p v-else class="mt-4 text-center text-sm text-emerald-400">
            火候把控完毕，可以开炉了
          </p>
        </div>

        <!-- 阶段反馈时间线 -->
        <div v-if="heatLogs.length" class="px-4 pb-2 flex justify-center gap-2">
          <div
            v-for="(log, idx) in heatLogs"
            :key="idx"
            class="px-2 py-1 rounded text-xs border"
            :class="log.stage_result === 'perfect'
              ? 'border-emerald-700/60 bg-emerald-900/20 text-emerald-400'
              : (log.stage_result === 'too_hot'
                  ? 'border-red-700/60 bg-red-900/20 text-red-400'
                  : 'border-sky-700/60 bg-sky-900/20 text-sky-400')"
            :title="log.stage_message"
          >
            {{ log.stage_result === 'perfect' ? '完美' : (log.stage_result === 'too_hot' ? '火大' : '火小') }}
          </div>
        </div>

        <!-- 火候档位选择 -->
        <div v-if="!heatFinished" class="px-4 pb-4">
          <div class="grid grid-cols-5 gap-2">
            <button
              v-for="h in heatOptions"
              :key="h"
              @click="handleSubmitHeat(h)"
              :disabled="heatSubmitting"
              class="py-2 rounded border border-stone-700 bg-stone-800/60 text-xs text-stone-300 hover:border-amber-600 hover:text-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {{ getHeatLabel(h) }}
            </button>
          </div>
        </div>

        <!-- 操作区 -->
        <div class="px-4 pb-4 flex gap-2">
          <button
            @click="handleCancelHeat"
            :disabled="crafting"
            class="px-4 py-2 rounded border border-stone-700 text-stone-400 text-sm hover:text-stone-200 transition-colors disabled:opacity-40"
          >
            停火散炉
          </button>
          <button
            v-if="heatFinished"
            @click="handleFinishHeat"
            :disabled="crafting"
            class="flex-1 py-2 rounded border border-amber-700/50 bg-amber-900/30 text-amber-400 text-sm font-bold hover:bg-amber-800/50 transition-colors disabled:opacity-40"
          >
            {{ crafting ? '开炉中…' : '开炉取丹' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ====== 炼制结果浮层 ====== -->
    <div
      v-if="craftOutcome"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      @click.self="craftOutcome = null"
    >
      <div class="w-full max-w-sm bg-stone-900 border border-stone-700 rounded-lg shadow-2xl animate-fade-in p-5">
        <h3 class="text-center font-bold mb-3" :class="craftOutcome.success ? 'text-emerald-400' : 'text-red-400'">
          {{ craftOutcome.success ? '炼制成功' : '炼制失败' }}
        </h3>

        <!-- 成品信息 -->
        <div v-if="craftOutcome.success_count > 0" class="text-center mb-4">
          <div class="text-lg text-amber-300">
            {{ craftOutcome.product.name }} x{{ craftOutcome.product.quantity }}
          </div>
          <div v-if="craftOutcome.product.quality_tier" class="mt-1 text-sm text-amber-500">
            【{{ craftOutcome.product.quality_tier }}】
            <!-- 丹药展示效果倍率（服用恢复/修为放大）；装备展示属性浮动倍率（穿戴基础属性放大） -->
            <span v-if="craftOutcome.recipe_type === 'alchemy'" class="text-stone-500 text-xs">效果 x{{ craftOutcome.product.effect_multiplier }}</span>
            <span v-else class="text-stone-500 text-xs">属性 x{{ craftOutcome.product.attr_multiplier }}</span>
          </div>
        </div>

        <!-- 成功率构成明细，让玩家看懂数值来源 -->
        <div class="text-xs space-y-1 bg-stone-950/60 rounded p-3 border border-stone-800">
          <div class="flex justify-between text-stone-400">
            <span>基础成功率</span><span>{{ (craftOutcome.rate_detail.base * 100).toFixed(0) }}%</span>
          </div>
          <div class="flex justify-between text-stone-400">
            <span>技能加成</span><span class="text-emerald-400">+{{ (craftOutcome.rate_detail.skill_bonus * 100).toFixed(1) }}%</span>
          </div>
          <div class="flex justify-between text-stone-400">
            <span>境界修正</span>
            <span :class="craftOutcome.rate_detail.realm_modifier >= 0 ? 'text-emerald-400' : 'text-red-400'">
              {{ craftOutcome.rate_detail.realm_modifier >= 0 ? '+' : '' }}{{ (craftOutcome.rate_detail.realm_modifier * 100).toFixed(1) }}%
            </span>
          </div>
          <div class="flex justify-between text-stone-400">
            <span>洞府丹房</span><span class="text-emerald-400">+{{ (craftOutcome.rate_detail.cave_bonus * 100).toFixed(1) }}%</span>
          </div>
          <div class="flex justify-between text-stone-400">
            <span>火候修正</span>
            <span :class="craftOutcome.rate_detail.heat_modifier >= 0 ? 'text-emerald-400' : 'text-red-400'">
              {{ craftOutcome.rate_detail.heat_modifier >= 0 ? '+' : '' }}{{ (craftOutcome.rate_detail.heat_modifier * 100).toFixed(1) }}%
            </span>
          </div>
          <div class="flex justify-between pt-1 mt-1 border-t border-stone-800 text-amber-400 font-bold">
            <span>最终成功率</span><span>{{ (craftOutcome.rate_detail.final * 100).toFixed(1) }}%</span>
          </div>
        </div>

        <div class="mt-3 text-xs text-stone-500 text-center">
          成功 {{ craftOutcome.success_count }} / {{ craftOutcome.total_attempts }} 次
          · 获得技能经验 {{ craftOutcome.skill_exp_gained }}
          <span v-if="craftOutcome.skill_level_up" class="text-amber-400">（技能升级！）</span>
        </div>

        <button
          @click="craftOutcome = null"
          class="mt-4 w-full py-2 rounded border border-stone-700 text-stone-300 text-sm hover:border-amber-600 hover:text-amber-400 transition-colors"
        >
          确定
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

/* 丹炉光晕：以呼吸动画表现炉火强弱，配合火候提示等级切换颜色 */
.furnace-glow {
  animation: furnacePulse 1.6s ease-in-out infinite;
}
.furnace-low {
  background: radial-gradient(circle, rgba(56, 189, 248, 0.25), transparent 70%);
  box-shadow: 0 0 24px rgba(56, 189, 248, 0.35);
}
.furnace-mid {
  background: radial-gradient(circle, rgba(251, 191, 36, 0.28), transparent 70%);
  box-shadow: 0 0 28px rgba(251, 191, 36, 0.4);
}
.furnace-high {
  background: radial-gradient(circle, rgba(239, 68, 68, 0.3), transparent 70%);
  box-shadow: 0 0 34px rgba(239, 68, 68, 0.5);
}
@keyframes furnacePulse {
  0%, 100% { transform: scale(1); filter: brightness(1); }
  50% { transform: scale(1.08); filter: brightness(1.25); }
}

/* 尊重用户的减少动效偏好，避免动画引起不适 */
@media (prefers-reduced-motion: reduce) {
  .furnace-glow { animation: none; }
  .animate-fade-in { animation: none; }
}
</style>
