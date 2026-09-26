<script setup lang="ts">
/**
 * 炼制系统面板组件（炼丹房 / 炼器阁）
 *
 * 功能说明：
 *   - 外壳统一走 ui/PanelShell（遮罩、关闭、右坞停靠由它给），面板不再自写遮罩与外壳
 *   - Tab 切换走 ui/Tabs：炼丹房（alchemy 丹药）/ 炼器阁（refining 装备），标签上带配方数
 *   - 炼制技能信息：等级、称号、经验进度条（ui/StatBar）、成功率加成
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
import PanelShell from '../ui/PanelShell.vue'
import Modal from '../common/Modal.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import StatBar from '../ui/StatBar.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import { useItemQualities } from '../../composables/useItemQualities'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

// 模块级缓存：面板每次打开都会整块重挂（GameLayout :key），没有缓存就得干等接口。
// 这里记住上次配方快照，重开时先铺上再后台刷新（stale-while-revalidate），转圈只留给首次。
let recipesSnapshot: LearnedRecipesData | null = null

// ====== 响应式状态 ======
const loading = ref(true)                          // 仅首次无缓存时整屏转圈
const refreshing = ref(false)                      // 有缓存时的后台静默刷新
const crafting = ref(false)                        // 炼制操作中状态锁，防止重复提交
const activeTab = ref<'alchemy' | 'refining' | 'legendary'>('alchemy')  // 当前激活的 Tab
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
 * 页签定义（key/label 契约见 ui/Tabs.vue）；badge 沿用原先写在标签里的配方数
 */
const tabItems = computed(() => [
  { key: 'alchemy', label: '炼丹房', badge: alchemyRecipes.value.length },
  { key: 'refining', label: '炼器阁', badge: refiningRecipes.value.length },
  { key: 'legendary', label: '通天灵宝', badge: legendaryRecipes.value.length }
])

const legendaryRecipes = ref<any[]>([])
const craftingLegend = ref(false)
// 通天灵宝炼制结果（null 表示无浮层）；与本页炼制结果共用同一套浮层版式
const legendOutcome = ref<any | null>(null)

const loadLegendary = async () => {
  try {
    const api = (await import('../../api/index')).default
    const res = await api.get('/legendary-weapons/recipes')
    // 响应体是 { code, data: { recipes } }，按标准解包取 data.data（此前少取一层，列表恒为空）
    legendaryRecipes.value = res.data?.data?.recipes || []
  } catch { legendaryRecipes.value = [] }
}

/**
 * 取配方中文名（服务端下发），用于结果浮层展示宝物本身
 * 不直接印服务端消息里的物品键，避免把内部 key 露给玩家
 * @param recipeId - 配方 id
 */
const legendRecipeName = (recipeId: string): string => {
  return legendaryRecipes.value.find((r: any) => r.id === recipeId)?.name || ''
}

/**
 * 通天灵宝炼制（逆天炼宝：失败毁材、损修为，低概率跌境）
 * 结果走自定义浮层展示，禁用浏览器原生 alert
 * @param recipeId - 配方 id
 */
const craftLegendary = async (recipeId: string) => {
  craftingLegend.value = true
  try {
    const api = (await import('../../api/index')).default
    const res = await api.post('/legendary-weapons/craft', { recipe: recipeId })
    // 后端回 { code, message, data }，判定结果与损失明细都在 data 内
    const data = res.data?.data || {}
    legendOutcome.value = {
      win: !!data.win,
      recipe: data.recipe || recipeId,
      rate: Number(data.rate) || 0,
      exp_loss: Number(data.exp_loss) || 0,
      realm_fell: !!data.realm_fell,
      message: data.message || res.data?.message || ''
    }
    await loadLegendary()
  } catch (e: any) {
    // 材料不足/灵石不足等业务错误（400）统一由这里播报，拦截器已认领传输层错误
    uiStore.showApiError(e, '炼制失败')
  } finally {
    craftingLegend.value = false
  }
}

/**
 * 是否已达技能满级
 */
const isMaxLevel = computed(() => {
  if (!skillInfo.value) return false
  return skillInfo.value.next_level_exp === null
})

// ====== 数据加载 ======

/**
 * 把配方快照铺进响应式状态
 */
const applyRecipes = (data: LearnedRecipesData) => {
  alchemyRecipes.value = data.alchemy || []
  refiningRecipes.value = data.refining || []
  skillInfo.value = data.skill_info || null
  // 记录拉取时间，用于本地冷却递减
  lastFetchTime.value = Date.now()
  // 初始化未设置的炼制次数为 1
  initCraftQuantities(data.alchemy)
  initCraftQuantities(data.refining)
}

/**
 * 拉取已学配方列表（含材料持有量、冷却状态、实际成功率）
 * 组件挂载时与每次炼制后调用，保证数据与后端一致
 * @param opts.silent - 已有缓存时后台刷新，不闪整屏转圈
 */
const fetchRecipes = async (opts: { silent?: boolean } = {}) => {
  const silent = opts.silent === true && !!recipesSnapshot
  if (silent) {
    refreshing.value = true
  } else {
    loading.value = true
  }
  try {
    const data: LearnedRecipesData = await getLearnedRecipes()
    recipesSnapshot = data
    applyRecipes(data)
  } catch (error: any) {
    console.error('获取炼制配方失败:', error)
    // 静默刷新失败时保留旧快照，只在没有可展示数据时才报错
    if (!silent) uiStore.showToast('获取炼制配方失败', 'error')
  } finally {
    loading.value = false
    refreshing.value = false
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
 * 品质的颜色与中文名一律取服务端品质词表（composables/useItemQualities.js）。
 * 这里原来抄了两份五档字典，还用了另一套叫法（凡品/灵品/珍品/仙品/神品）：
 * 同一件东西在背包里叫"传说"、在炼器面板里叫"神品"；而两份都漏了 mythic，
 * 于是神话档产物在面板上直接印成"凡品"（本轮补的玄天斩灵剑就是那一档）。
 */
const { textClass: qualityClass, labelOf: qualityLabel } = useItemQualities()

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
  if (recipesSnapshot) {
    // 有缓存：立刻铺开，后台静默对齐冷却/材料
    applyRecipes(recipesSnapshot)
    loading.value = false
    fetchRecipes({ silent: true })
  } else {
    fetchRecipes()
  }
  loadLegendary()
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
  <PanelShell
    title="炼制阁"
    hint="炼丹 · 炼器 · 控火"
    size="xl"
    scoped-scroll
    fill
    @close="emit('close')"
  >
    <div class="h-full flex flex-col min-h-0">
      <!-- 炼制技能信息栏 -->
      <div v-if="skillInfo" class="shrink-0 p-4 border-b border-line-subtle bg-surface-canvas">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <!-- 等级与称号 -->
          <div class="flex items-center gap-4 flex-wrap">
            <div class="flex items-center gap-2">
              <span class="text-xs text-fg-faint">等级</span>
              <span class="text-lg font-bold text-gold-400 num">{{ skillInfo.level }}</span>
              <span class="text-xs text-fg-faint num">/ {{ skillInfo.max_level }}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-fg-faint">称号</span>
              <Badge tone="arcane">{{ skillInfo.title }}</Badge>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-fg-faint">成功率加成</span>
              <span class="text-sm font-bold text-emerald-400 num">+{{ skillInfo.success_bonus }}%</span>
            </div>
          </div>

          <!-- 经验进度条 -->
          <StatBar
            label="经验"
            tone="gold"
            class="flex-1 min-w-[200px] max-w-md"
            :value="isMaxLevel ? 1 : skillInfo.exp"
            :max="isMaxLevel ? 1 : skillInfo.next_level_exp"
            :text="isMaxLevel ? '已满级' : `${skillInfo.exp} / ${skillInfo.next_level_exp}`"
          />
        </div>
      </div>

      <!-- Tab 切换栏：配方数走 Tabs 的 badge；后台刷新时角落轻提示，不再闪整屏 -->
      <div class="shrink-0 relative">
        <Tabs v-model="activeTab" :items="tabItems" />
        <span
          v-if="refreshing"
          class="absolute top-2 right-3 text-[11px] text-fg-faint animate-pulse"
        >同步中…</span>
      </div>

      <!-- 内容区域 -->
      <div class="flex-1 min-h-0 overflow-y-auto p-4">
        <LoadingBlock v-if="loading" />

        <!-- 通天灵宝：独立炼制链（青竹蜂云剑 / 三焰·七焰扇） -->
        <div v-else-if="activeTab === 'legendary'" class="space-y-3">
          <div class="text-xs text-fg-muted">逆天炼宝，失败可能毁材甚至跌境。成功率吃灵根与太一秘术加成。</div>
          <div v-if="!legendaryRecipes.length" class="text-sm text-fg-muted py-8 text-center">暂无可用配方</div>
          <div
            v-for="r in legendaryRecipes"
            :key="r.id"
            class="bg-surface-raised border border-amber-900/50 rounded-panel p-4"
          >
            <div class="flex justify-between items-start mb-2">
              <div>
                <h3 class="text-base font-bold text-amber-200">{{ r.name }}</h3>
                <div class="text-xs text-fg-muted mt-0.5">{{ r.desc }}</div>
              </div>
              <div class="text-right text-xs">
                <div class="text-gold-500 font-bold">{{ Math.round(r.success_rate * 100) }}%</div>
                <div v-if="r.fail_note" class="text-red-300 mt-1">{{ r.fail_note }}</div>
              </div>
            </div>
            <div class="text-xs text-fg-muted space-y-0.5 mb-3">
              <div v-for="(qty, key) in (r.materials || {})" :key="key">
                {{ key }} ×{{ qty }}
                <span v-if="key !== 'spirit_stones'" class="ml-2"
                  :class="(r.stock?.[key] ?? 0) >= qty ? 'text-emerald-300' : 'text-red-300'">
                  持有 {{ r.stock?.[key] ?? 0 }}
                </span>
              </div>
            </div>
            <AppButton
              size="sm"
              variant="primary"
              :disabled="craftingLegend"
              @click="craftLegendary(r.id)"
            >开炉炼制</AppButton>
          </div>
        </div>

        <!-- 空状态 -->
        <EmptyState
          v-else-if="currentRecipes.length === 0"
          :text="`尚未习得任何${activeTab === 'alchemy' ? '丹方' : '器谱'}`"
          hint="先通过历练、坊市或宗门兑换取得配方，再回来开炉"
        />

        <!-- 配方卡片列表 -->
        <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div
            v-for="recipe in currentRecipes"
            :key="recipe.recipe_id"
            class="bg-surface-raised border rounded-panel p-4 transition-all duration-300"
            :class="activeTab === 'alchemy'
              ? 'border-gold-800 hover:border-gold-700'
              : 'border-purple-900 hover:border-purple-700'"
          >
            <!-- 卡片头部：配方名称 + 类型徽章 -->
            <div class="flex justify-between items-start mb-2">
              <div>
                <h3 class="text-base font-bold flex items-center gap-2"
                    :class="activeTab === 'alchemy' ? 'text-gold-300' : 'text-purple-300'">
                  {{ recipe.name }}
                </h3>
                <p class="text-xs text-fg-faint mt-1 leading-relaxed">{{ recipe.description }}</p>
              </div>
            </div>

            <!-- 产物信息 -->
            <div class="bg-surface-canvas rounded-control px-2.5 py-2.5 border border-line-subtle mb-3">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="text-xs text-fg-faint">产物</span>
                  <span class="text-sm font-bold" :class="qualityClass(recipe.product.quality)">
                    {{ recipe.product.name }}
                  </span>
                  <span class="text-xs text-fg-muted">x{{ recipe.product.quantity }}</span>
                </div>
                <span class="text-xs px-2 py-0.5 rounded border border-line"
                      :class="qualityClass(recipe.product.quality)">
                  {{ qualityLabel(recipe.product.quality) }}
                </span>
              </div>
            </div>

            <!-- 材料列表 -->
            <div class="mb-3">
              <div class="text-xs text-fg-faint mb-1.5">所需材料</div>
              <div class="space-y-1">
                <div
                  v-for="mat in recipe.materials"
                  :key="mat.item_key"
                  class="flex items-center justify-between text-xs bg-surface-canvas rounded-control px-2.5 py-1.5 border border-line-subtle"
                >
                  <span class="text-fg-secondary">{{ mat.name }}</span>
                  <span class="num" :class="mat.sufficient ? 'text-fg-muted' : 'text-rose-400'">
                    {{ mat.owned }} / {{ mat.required }}
                    <span v-if="!mat.sufficient" class="ml-1 text-rose-500">不足</span>
                  </span>
                </div>
              </div>
            </div>

            <!-- 成功率与技能经验 -->
            <div class="flex items-center gap-4 mb-3 text-xs">
              <div class="flex items-center gap-1.5">
                <span class="text-fg-faint">基础成功率</span>
                <span class="text-fg-secondary num">{{ recipe.base_success_rate }}%</span>
              </div>
              <svg class="w-3 h-3 text-fg-faint" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
              <div class="flex items-center gap-1.5">
                <span class="text-fg-faint">实际成功率</span>
                <span class="font-bold text-emerald-400 num">{{ recipe.actual_success_rate }}%</span>
              </div>
              <div class="flex items-center gap-1.5 ml-auto">
                <span class="text-fg-faint">经验</span>
                <span class="text-cyan-400 num">+{{ recipe.skill_exp }}</span>
              </div>
            </div>

            <!-- 炼制次数选择 + 炼制按钮 -->
            <div class="flex items-center gap-3">
              <!-- 次数选择器 -->
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-fg-faint">次数</span>
                <div class="flex items-center bg-surface-canvas border border-line rounded-control overflow-hidden">
                  <button
                    @click="craftQuantities[recipe.recipe_id] = Math.max(1, (craftQuantities[recipe.recipe_id] || 1) - 1)"
                    :disabled="crafting"
                    class="px-2 py-1 text-fg-muted hover:text-gold-400 hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >-</button>
                  <input
                    v-model.number="craftQuantities[recipe.recipe_id]"
                    type="number"
                    min="1"
                    max="10"
                    class="w-10 bg-transparent text-center text-sm text-fg-primary num focus:outline-none"
                    @change="() => {
                      const v = craftQuantities[recipe.recipe_id]
                      if (!v || v < 1) craftQuantities[recipe.recipe_id] = 1
                      if (v > 10) craftQuantities[recipe.recipe_id] = 10
                    }"
                  />
                  <button
                    @click="craftQuantities[recipe.recipe_id] = Math.min(10, (craftQuantities[recipe.recipe_id] || 1) + 1)"
                    :disabled="crafting"
                    class="px-2 py-1 text-fg-muted hover:text-gold-400 hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >+</button>
                </div>
              </div>

              <!-- 炼制按钮组：开炉控火（高收益）/ 一键炼制（省事但有惩罚） -->
              <div class="flex-1 flex gap-2">
                <!-- 开炉控火：进入火候小游戏，可炼出更高品质（丹金器紫，保留色相对立） -->
                <button
                  @click="handleStartHeat(recipe)"
                  :disabled="!canCraft(recipe)"
                  :title="canCraft(recipe) ? '手动把控火候，偏差越小品质越高' : ''"
                  class="flex-1 py-2 rounded-control border transition-colors text-sm font-bold disabled:cursor-not-allowed"
                  :class="canCraft(recipe)
                    ? (activeTab === 'alchemy'
                        ? 'bg-surface-tint-gold border-gold-700 text-gold-400 hover:bg-surface-tint-gold-strong hover:text-gold-300'
                        : 'bg-surface-tint-arcane border-purple-800 text-purple-400 hover:bg-purple-950/60 hover:text-purple-300')
                    : 'bg-surface-sunken border-line text-fg-faint'"
                >
                  <span v-if="canCraft(recipe)">开炉控火</span>
                  <span v-else>{{ getDisableReason(recipe) || '无法炼制' }}</span>
                </button>

                <!-- 一键炼制：跳过火候，承担固定成功率惩罚 -->
                <AppButton
                  v-if="canCraft(recipe)"
                  size="xs"
                  variant="default"
                  title="跳过火候把控，成功率略降且品质固定为中档"
                  :disabled="crafting"
                  @click="handleCraft(recipe)"
                >
                  一键
                </AppButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ====== 火候控制浮层：定时会话，禁用关闭按钮与遮罩关闭，避免误关丢炼丹进度 ====== -->
    <Modal
      :is-open="!!heatSession"
      width="448px"
      :show-close="false"
      :close-on-backdrop="false"
    >
      <!-- 标题栏：丹方名 + 阶段进度 + 冷却倒计时 -->
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-gold-400 font-bold">{{ heatSession.recipe_name }}</h3>
          <p class="text-xs text-fg-faint">
            第 <span class="num">{{ Math.min(heatLogs.length + 1, heatSession.total_stages) }} / {{ heatSession.total_stages }}</span> 阶段
            · 数量 <span class="num">x{{ heatSession.quantity }}</span>
          </p>
        </div>
        <!-- 剩余时间：低于 30 秒转红警示 -->
        <div class="text-right">
          <div class="text-xs text-fg-faint">丹炉冷却倒计时</div>
          <div class="num text-sm" :class="heatRemaining <= 30 ? 'text-rose-400' : 'text-fg-secondary'">
            {{ heatRemaining }}s
          </div>
        </div>
      </div>

      <!-- 炉火动画区 -->
      <div class="py-5 flex flex-col items-center">
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
        <p v-if="!heatFinished" class="mt-4 text-center text-sm text-gold-300 px-2">
          {{ heatSession.hint?.text }}
        </p>
        <p v-else class="mt-4 text-center text-sm text-emerald-400">
          火候把控完毕，可以开炉了
        </p>
      </div>

      <!-- 阶段反馈时间线 -->
      <div v-if="heatLogs.length" class="pb-2 flex justify-center gap-2">
        <div
          v-for="(log, idx) in heatLogs"
          :key="idx"
          class="px-2 py-1 rounded text-xs border"
          :class="log.stage_result === 'perfect'
            ? 'border-emerald-800 bg-emerald-900/20 text-emerald-400'
            : (log.stage_result === 'too_hot'
                ? 'border-rose-800 bg-rose-900/20 text-rose-400'
                : 'border-sky-800 bg-sky-900/20 text-sky-400')"
          :title="log.stage_message"
        >
          {{ log.stage_result === 'perfect' ? '完美' : (log.stage_result === 'too_hot' ? '火大' : '火小') }}
        </div>
      </div>

      <!-- 火候档位选择 -->
      <div v-if="!heatFinished" class="pb-2">
        <div class="grid grid-cols-5 gap-2">
          <button
            v-for="h in heatOptions"
            :key="h"
            @click="handleSubmitHeat(h)"
            :disabled="heatSubmitting"
            class="py-2 rounded-control border border-line bg-surface-hover text-xs text-fg-secondary hover:border-gold-700 hover:text-gold-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {{ getHeatLabel(h) }}
          </button>
        </div>
      </div>

      <!-- 操作区 -->
      <div class="mt-4 pt-4 border-t border-line-subtle flex gap-2">
        <AppButton variant="default" :disabled="crafting" @click="handleCancelHeat">停火散炉</AppButton>
        <AppButton
          v-if="heatFinished"
          variant="primary"
          class="flex-1"
          :disabled="crafting"
          @click="handleFinishHeat"
        >
          {{ crafting ? '开炉中…' : '开炉取丹' }}
        </AppButton>
      </div>
    </Modal>

    <!-- ====== 炼制结果浮层：成败色标题留在正文，外壳走统一 Modal ====== -->
    <Modal :is-open="!!craftOutcome" width="384px" @close="craftOutcome = null">
      <h3 class="text-center font-bold mb-3" :class="craftOutcome.success ? 'text-emerald-400' : 'text-rose-400'">
        {{ craftOutcome.success ? '炼制成功' : '炼制失败' }}
      </h3>

      <!-- 成品信息 -->
      <div v-if="craftOutcome.success_count > 0" class="text-center mb-4">
        <div class="text-lg text-gold-300">
          {{ craftOutcome.product.name }} x{{ craftOutcome.product.quantity }}
        </div>
        <div v-if="craftOutcome.product.quality_tier" class="mt-1 text-sm text-gold-500">
          【{{ craftOutcome.product.quality_tier }}】
          <!-- 丹药展示效果倍率（服用恢复/修为放大）；装备展示属性浮动倍率（穿戴基础属性放大） -->
          <span v-if="craftOutcome.recipe_type === 'alchemy'" class="text-fg-faint text-xs">效果 x{{ craftOutcome.product.effect_multiplier }}</span>
          <span v-else class="text-fg-faint text-xs">属性 x{{ craftOutcome.product.attr_multiplier }}</span>
        </div>
      </div>

      <!-- 成功率构成明细，让玩家看懂数值来源 -->
      <div class="text-xs space-y-1 bg-surface-sunken rounded-control p-3 border border-line-subtle">
        <div class="flex justify-between text-fg-muted">
          <span>基础成功率</span><span class="num">{{ (craftOutcome.rate_detail.base * 100).toFixed(0) }}%</span>
        </div>
        <div class="flex justify-between text-fg-muted">
          <span>技能加成</span><span class="text-emerald-400 num">+{{ (craftOutcome.rate_detail.skill_bonus * 100).toFixed(1) }}%</span>
        </div>
        <div class="flex justify-between text-fg-muted">
          <span>境界修正</span>
          <span class="num" :class="craftOutcome.rate_detail.realm_modifier >= 0 ? 'text-emerald-400' : 'text-rose-400'">
            {{ craftOutcome.rate_detail.realm_modifier >= 0 ? '+' : '' }}{{ (craftOutcome.rate_detail.realm_modifier * 100).toFixed(1) }}%
          </span>
        </div>
        <div class="flex justify-between text-fg-muted">
          <span>洞府丹房</span><span class="text-emerald-400 num">+{{ (craftOutcome.rate_detail.cave_bonus * 100).toFixed(1) }}%</span>
        </div>
        <div class="flex justify-between text-fg-muted">
          <span>火候修正</span>
          <span class="num" :class="craftOutcome.rate_detail.heat_modifier >= 0 ? 'text-emerald-400' : 'text-rose-400'">
            {{ craftOutcome.rate_detail.heat_modifier >= 0 ? '+' : '' }}{{ (craftOutcome.rate_detail.heat_modifier * 100).toFixed(1) }}%
          </span>
        </div>
        <div class="flex justify-between pt-1 mt-1 border-t border-line-subtle text-gold-400 font-bold">
          <span>最终成功率</span><span class="num">{{ (craftOutcome.rate_detail.final * 100).toFixed(1) }}%</span>
        </div>
      </div>

      <div class="mt-3 text-xs text-fg-faint text-center">
        成功 <span class="num">{{ craftOutcome.success_count }} / {{ craftOutcome.total_attempts }}</span> 次
        · 获得技能经验 <span class="num">{{ craftOutcome.skill_exp_gained }}</span>
        <span v-if="craftOutcome.skill_level_up" class="text-gold-400">（技能升级！）</span>
      </div>

      <AppButton variant="default" block class="mt-4" @click="craftOutcome = null">确定</AppButton>
    </Modal>

    <!-- ====== 通天灵宝炼制结果浮层：与上方炼制结果同一套外壳与版式（替代原生 alert） ====== -->
    <Modal :is-open="!!legendOutcome" width="384px" @close="legendOutcome = null">
      <h3 class="text-center font-bold mb-3" :class="legendOutcome.win ? 'text-emerald-400' : 'text-rose-400'">
        {{ legendOutcome.win ? '炼制成功' : '炼制失败' }}
      </h3>

      <!-- 成品：只印服务端下发的配方名，不把物品键露给玩家 -->
      <div v-if="legendOutcome.win" class="text-center mb-4">
        <div class="text-lg text-gold-300">{{ legendRecipeName(legendOutcome.recipe) }} ×1</div>
      </div>

      <!-- 本次判定明细：实际成功率 + 失败代价 -->
      <div class="text-xs space-y-1 bg-surface-sunken rounded-control p-3 border border-line-subtle">
        <div class="flex justify-between text-fg-muted">
          <span>炼制成功率</span><span class="num">{{ (legendOutcome.rate * 100).toFixed(1) }}%</span>
        </div>
        <div v-if="legendOutcome.exp_loss > 0" class="flex justify-between text-fg-muted">
          <span>修为损失</span><span class="num text-rose-400">-{{ legendOutcome.exp_loss }}</span>
        </div>
        <div v-if="legendOutcome.realm_fell" class="flex justify-between text-fg-muted">
          <span>境界跌落</span><span class="num text-rose-400">已跌落</span>
        </div>
      </div>

      <!-- 失败叙事文案（毁材/反噬）；成功文案含物品键，故不外露 -->
      <div v-if="!legendOutcome.win" class="mt-3 text-xs text-fg-faint text-center whitespace-pre-line wrap-cjk">
        {{ legendOutcome.message }}
      </div>

      <AppButton variant="default" block class="mt-4" @click="legendOutcome = null">确定</AppButton>
    </Modal>
  </PanelShell>
</template>

<style scoped>
/* 丹炉光晕：以呼吸动画表现炉火强弱，配合火候提示等级切换颜色。
 * 颜色取令牌通道值（state-info / gold-400 / state-danger），换主题时不用回来改。 */
.furnace-glow {
  animation: furnacePulse 1.6s ease-in-out infinite;
}
.furnace-low {
  background: radial-gradient(circle, rgb(var(--state-info) / 0.25), transparent 70%);
  box-shadow: 0 0 24px rgb(var(--state-info) / 0.35);
}
.furnace-mid {
  background: radial-gradient(circle, rgb(var(--gold-400) / 0.28), transparent 70%);
  box-shadow: 0 0 28px rgb(var(--gold-400) / 0.4);
}
.furnace-high {
  background: radial-gradient(circle, rgb(var(--state-danger) / 0.3), transparent 70%);
  box-shadow: 0 0 34px rgb(var(--state-danger) / 0.5);
}
@keyframes furnacePulse {
  0%, 100% { transform: scale(1); filter: brightness(1); }
  50% { transform: scale(1.08); filter: brightness(1.25); }
}

/* 尊重用户的减少动效偏好，避免动画引起不适 */
@media (prefers-reduced-motion: reduce) {
  .furnace-glow { animation: none; }
}
</style>
