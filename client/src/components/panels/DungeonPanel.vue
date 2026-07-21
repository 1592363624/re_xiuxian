/**
 * 副本挑战面板组件
 *
 * 副本系统综合玩法面板，包含以下功能模块：
 *   1. 副本章节列表：5章×每章5-7关，按境界解锁
 *   2. 难度选择：普通/困难/噩梦三档，影响怪物属性与奖励倍率
 *   3. 副本进行中：剧情/战斗/解谜/BOSS/奖励5种关卡类型
 *   4. 三星评级：HP剩余率≥80%=3星；≥50%=2星；>0%=1星
 *   5. 扫荡：三星通关后可扫荡，奖励按比例发放
 *   6. 通关历史：查询过往通关记录
 *
 * 设计原则：
 *   - 所有状态从后端 GET /dungeon/status 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 未解锁章节展示锁定状态与境界要求
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-stone-800 rounded-lg p-6 max-w-4xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-amber-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 21h18"/>
            <path d="M5 21V8l7-5 7 5v13"/>
            <path d="M9 21v-6h6v6"/>
            <path d="M9 11h6"/>
          </svg>
          秘境副本
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 状态总览 -->
      <div v-if="status" class="bg-[#292524] border border-stone-700 rounded-lg p-3 mb-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <div class="text-stone-500">当前境界</div>
          <div class="text-amber-300 font-bold">{{ status.realm_name }}</div>
        </div>
        <div>
          <div class="text-stone-500">今日挑战</div>
          <div class="font-bold" :class="status.daily_challenge_count >= status.daily_challenge_limit ? 'text-rose-400' : 'text-emerald-400'">
            {{ status.daily_challenge_count }} / {{ status.daily_challenge_limit }}
          </div>
        </div>
        <div>
          <div class="text-stone-500">冷却状态</div>
          <div class="font-bold" :class="status.cooldown_ready ? 'text-emerald-400' : 'text-amber-400'">
            {{ status.cooldown_ready ? '就绪' : `冷却中 ${formatTime(status.cooldown_remaining_sec)}` }}
          </div>
        </div>
        <div>
          <div class="text-stone-500">通关章节数</div>
          <div class="text-cyan-300 font-bold">{{ status.completed_chapters.length }}</div>
        </div>
      </div>

      <!-- 副本进行中提示 -->
      <div v-if="status?.in_dungeon && status.in_progress" class="bg-rose-950/30 border border-rose-800/50 rounded-lg p-3 mb-4 text-xs text-rose-300 flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span>
          副本进行中：<span class="text-amber-300">{{ status.in_progress.chapter_name }}</span>
          · 难度：<span class="text-amber-300">{{ getDifficultyLabel(status.in_progress.difficulty) }}</span>
          · 剩余时间：<span class="text-amber-300">{{ formatTime(status.in_progress.remaining_seconds) }}</span>
        </span>
        <button @click="handleContinueDungeon"
          :disabled="loading"
          class="ml-auto px-3 py-1 rounded bg-amber-950/40 border border-amber-700 text-amber-300 hover:bg-amber-900/40 transition-colors">
          继续挑战
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-3 pr-1">
        <!-- 视图切换：章节选择 / 副本进行中 / 通关历史 -->
        <div v-if="view === 'list'" class="space-y-3">
          <!-- 章节列表 -->
          <section v-for="chapter in chapters" :key="chapter.id" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-start justify-between mb-2">
              <div class="flex-1">
                <div class="text-sm font-bold text-amber-300 flex items-center gap-2">
                  {{ chapter.name }}
                  <span v-if="getChapterStars(chapter.id) > 0" class="text-[10px] text-amber-500">
                    {{ '★'.repeat(getChapterStars(chapter.id)) }}
                  </span>
                </div>
                <div class="text-[11px] text-stone-500 mt-0.5">
                  推荐境界：{{ chapter.recommended_realm }} · {{ chapter.node_count }} 关 · BOSS：{{ chapter.boss_name || '未知' }} · 时长 {{ formatTime(chapter.duration_sec) }}
                </div>
                <div class="text-xs text-stone-400 mt-2 leading-relaxed">{{ chapter.description }}</div>
              </div>
              <div v-if="!status?.unlocked || (status?.realm_rank ?? 0) < chapter.min_realm_rank"
                class="text-[10px] text-rose-400 px-2 py-0.5 rounded bg-rose-950/40 border border-rose-900/40 shrink-0 ml-2">
                需{{ chapter.recommended_realm }}
              </div>
            </div>

            <!-- 难度选择与操作 -->
            <div v-if="canChallenge(chapter)" class="mt-3 pt-3 border-t border-stone-800">
              <div class="flex items-center gap-2 text-xs mb-2">
                <span class="text-stone-500">难度：</span>
                <button v-for="d in difficulties" :key="d.value"
                  @click="selectDifficulty(chapter.id, d.value)"
                  :disabled="loading"
                  class="text-xs py-1 px-2 rounded border transition-all"
                  :class="getSelectedDifficulty(chapter.id) === d.value
                    ? `${d.activeClass} ${d.borderClass} ${d.textClass}`
                    : 'bg-stone-900/40 border-stone-700 text-stone-400 hover:border-stone-500'">
                  {{ d.label }}
                </button>
                <span class="text-stone-500 ml-2 text-[10px]">
                  倍率：HP×{{ getDifficultyMultiplier(getSelectedDifficulty(chapter.id), 'hp') }} · 攻击×{{ getDifficultyMultiplier(getSelectedDifficulty(chapter.id), 'atk') }} · 修为×{{ getDifficultyMultiplier(getSelectedDifficulty(chapter.id), 'exp') }}
                </span>
              </div>
              <div class="flex gap-2">
                <button @click="handleStartDungeon(chapter.id)"
                  :disabled="loading || !status?.cooldown_ready || (status?.daily_challenge_count ?? 0) >= (status?.daily_challenge_limit ?? 0) || status?.in_dungeon"
                  class="flex-1 py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-amber-950/40 border border-amber-700 text-amber-300 hover:bg-amber-900/40 hover:border-amber-500">
                  <span v-if="loading">进入中...</span>
                  <span v-else-if="status?.in_dungeon">已在副本中</span>
                  <span v-else-if="!status?.cooldown_ready">冷却中</span>
                  <span v-else-if="(status?.daily_challenge_count ?? 0) >= (status?.daily_challenge_limit ?? 0)">今日次数已用尽</span>
                  <span v-else>进入副本</span>
                </button>
                <button v-if="canSweep(chapter.id)" @click="handleSweepDungeon(chapter.id)"
                  :disabled="loading || !status?.cooldown_ready || (status?.daily_challenge_count ?? 0) >= (status?.daily_challenge_limit ?? 0) || status?.in_dungeon"
                  class="flex-1 py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-950/40 border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40 hover:border-cyan-500">
                  <span v-if="loading">扫荡中...</span>
                  <span v-else>扫荡（{{ Math.round((status?.sweep_reward_ratio ?? 0) * 100) }}%奖励）</span>
                </button>
              </div>
            </div>

            <!-- 未解锁提示 -->
            <div v-else class="mt-3 pt-3 border-t border-stone-800 text-xs text-stone-500 text-center py-2">
              境界达到 <span class="text-amber-400">{{ chapter.recommended_realm }}</span> 后解锁
            </div>
          </section>

          <!-- 查看通关历史按钮 -->
          <button @click="switchView('history')"
            class="w-full py-2 rounded-lg text-xs font-bold tracking-wider bg-stone-900/40 border border-stone-700 text-stone-300 hover:bg-stone-800/40 hover:border-stone-500 transition-all">
            查看通关历史
          </button>
        </div>

        <!-- 副本进行中视图 -->
        <div v-else-if="view === 'progress'" class="space-y-3">
          <DungeonProgressView
            :progress="status?.in_progress"
            :current-node="currentNode"
            :battle-result="lastBattleResult"
            :settlement="lastSettlement"
            :loading="loading"
            @advance="handleAdvance"
            @battle="handleBattle"
            @choose-option="handleChooseOption"
            @interrupt="confirmInterrupt"
            @exit="handleExitProgress"
          />
        </div>

        <!-- 通关历史视图 -->
        <div v-else-if="view === 'history'" class="space-y-2">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-stone-300">通关历史</h3>
            <button @click="switchView('list')"
              class="text-xs text-stone-400 hover:text-amber-300 transition-colors">
              ← 返回章节列表
            </button>
          </div>
          <div v-if="history.length === 0" class="text-center py-8 text-stone-500 text-sm">
            暂无通关记录
          </div>
          <div v-for="entry in history" :key="entry.id"
            class="bg-[#292524] border border-stone-700 rounded-lg p-3 text-xs">
            <div class="flex items-center justify-between mb-1">
              <div class="font-bold text-amber-300">
                {{ entry.chapter_name }}
                <span class="text-[10px] text-stone-500 ml-1">（{{ getDifficultyLabel(entry.difficulty) }}）</span>
              </div>
              <div class="text-amber-500">{{ '★'.repeat(entry.stars) }}<span class="text-stone-700">{{ '★'.repeat(3 - entry.stars) }}</span></div>
            </div>
            <div class="text-stone-400 flex items-center gap-3 text-[11px]">
              <span>用时：{{ formatTime(entry.completion_time_sec) }}</span>
              <span>修为：+{{ formatNumber(entry.exp_gained) }}</span>
              <span>灵石：+{{ formatNumber(entry.spirit_stones_gained) }}</span>
            </div>
            <div class="text-stone-600 text-[10px] mt-1">{{ formatDate(entry.completed_at) }}</div>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="mt-4 flex gap-2">
        <button @click="handleRefresh"
          :disabled="loading"
          class="px-4 py-2.5 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors disabled:opacity-50">
          刷新状态
        </button>
        <button @click="$emit('close')"
          class="flex-1 py-2.5 rounded-lg font-bold tracking-widest text-sm transition-all bg-stone-900/40 border border-stone-700 text-stone-300 hover:bg-stone-800/40 hover:border-stone-500">
          关闭
        </button>
      </div>
    </div>

    <!-- 中断副本二次确认弹窗 -->
    <Modal :isOpen="interruptConfirmOpen" title="中断副本确认" width="500px" @close="interruptConfirmOpen = false">
      <div class="space-y-3 text-sm text-stone-300">
        <p class="text-amber-300 font-bold">确定要中断当前副本挑战吗？</p>
        <ul class="text-xs text-stone-400 space-y-1 list-disc pl-5">
          <li>中断将按失败结算，本次挑战不记录通关</li>
          <li>补偿50%已积累修为，不发放物品与灵石</li>
          <li>会消耗一次今日挑战次数与冷却时间</li>
        </ul>
        <p class="text-xs text-stone-500">建议仅在HP过低无法继续时使用此功能。</p>
      </div>
      <template #footer>
        <button @click="interruptConfirmOpen = false"
          class="px-4 py-2 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors">
          继续挑战
        </button>
        <button @click="handleInterrupt"
          :disabled="loading"
          class="px-4 py-2 text-sm font-bold text-rose-300 bg-rose-950/40 border border-rose-700 hover:bg-rose-900/40 rounded-lg transition-colors disabled:opacity-50">
          <span v-if="loading">执行中...</span>
          <span v-else>确认中断</span>
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { formatTime, formatNumber } from '../../utils/format'
import Modal from '../common/Modal.vue'
import DungeonProgressView from './DungeonProgressView.vue'
import {
  getConfig,
  getStatus,
  startDungeon,
  getCurrentNode,
  chooseOption,
  advanceNode,
  battleNode,
  interruptDungeon,
  sweepDungeon,
  getHistory
} from '../../api/dungeon'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

const loading = ref(false)
const status = ref(null)
const config = ref(null)
const history = ref([])
const currentNode = ref(null)
const lastBattleResult = ref(null)
const lastSettlement = ref(null)
const interruptConfirmOpen = ref(false)
const view = ref('list')  // 'list' | 'progress' | 'history'
const selectedDifficultyMap = ref({})  // { chapterId: difficulty }

// 当前时间 tick，用于驱动倒计时显示
const now = ref(Date.now())
let tickTimer = null

/**
 * 难度选项配置
 */
const difficulties = [
  { value: 'normal',    label: '普通', activeClass: 'bg-emerald-950/40', borderClass: 'border-emerald-600', textClass: 'text-emerald-300' },
  { value: 'hard',      label: '困难', activeClass: 'bg-amber-950/40',   borderClass: 'border-amber-600',   textClass: 'text-amber-300' },
  { value: 'nightmare', label: '噩梦', activeClass: 'bg-rose-950/40',    borderClass: 'border-rose-600',    textClass: 'text-rose-300' }
]

/**
 * 章节列表（从配置中读取）
 */
const chapters = computed(() => config.value?.chapters || [])

/**
 * 获取难度中文标签
 */
const getDifficultyLabel = (difficulty) => {
  return { normal: '普通', hard: '困难', nightmare: '噩梦' }[difficulty] || difficulty
}

/**
 * 获取难度倍率
 */
const getDifficultyMultiplier = (difficulty, key) => {
  if (!config.value?.global?.difficulty_multipliers?.[difficulty]) return 1
  return config.value.global.difficulty_multipliers[difficulty][key] ?? 1
}

/**
 * 获取章节最高星级（综合各难度）
 */
const getChapterStars = (chapterId) => {
  if (!status.value?.completed_chapters) return 0
  const records = status.value.completed_chapters.filter(c => c.chapter_id === chapterId)
  if (records.length === 0) return 0
  return Math.max(...records.map(r => r.stars))
}

/**
 * 判断是否可以挑战该章节
 */
const canChallenge = (chapter) => {
  if (!status.value?.unlocked) return false
  return (status.value?.realm_rank ?? 0) >= chapter.min_realm_rank
}

/**
 * 判断是否可以扫荡该章节（任意难度三星通关）
 */
const canSweep = (chapterId) => {
  if (!status.value?.completed_chapters) return false
  const sweepMin = status.value?.sweep_min_stars ?? 3
  return status.value.completed_chapters.some(
    c => c.chapter_id === chapterId && c.stars >= sweepMin
  )
}

/**
 * 获取章节选中的难度
 */
const getSelectedDifficulty = (chapterId) => {
  return selectedDifficultyMap.value[chapterId] || 'normal'
}

/**
 * 选择难度
 */
const selectDifficulty = (chapterId, difficulty) => {
  selectedDifficultyMap.value[chapterId] = difficulty
}

/**
 * 切换视图
 */
const switchView = (newView) => {
  view.value = newView
  if (newView === 'history') {
    fetchHistory()
  }
}

/**
 * 格式化日期
 */
const formatDate = (dateStr) => {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 拉取副本配置
 */
const fetchConfig = async () => {
  try {
    const res = await getConfig()
    config.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取副本配置失败:', err)
    uiStore.showToast('获取副本配置失败', 'error')
  }
}

/**
 * 拉取副本状态
 */
const fetchStatus = async () => {
  try {
    const res = await getStatus()
    status.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取副本状态失败:', err)
    uiStore.showToast('获取副本状态失败', 'error')
  }
}

/**
 * 拉取通关历史
 */
const fetchHistory = async () => {
  try {
    const res = await getHistory(20)
    history.value = res.data?.data || []
  } catch (err) {
    console.error('获取通关历史失败:', err)
    uiStore.showToast('获取通关历史失败', 'error')
  }
}

/**
 * 拉取当前节点内容
 */
const fetchCurrentNode = async () => {
  try {
    const res = await getCurrentNode()
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '获取节点内容失败', 'warning')
      return
    }
    currentNode.value = payload.data
  } catch (err) {
    console.error('获取当前节点失败:', err)
    uiStore.showToast('获取当前节点失败', 'error')
  }
}

/**
 * 开始副本挑战
 */
const handleStartDungeon = async (chapterId) => {
  if (loading.value) return
  const difficulty = getSelectedDifficulty(chapterId)
  loading.value = true
  try {
    const res = await startDungeon(chapterId, difficulty)
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '进入副本失败', 'warning')
    } else {
      uiStore.showToast(payload.message || '进入副本成功', 'success')
      uiStore.addLog({
        content: `进入副本：${payload.data?.chapter_name}（${getDifficultyLabel(difficulty)}）`,
        type: 'info',
        actorId: 'self'
      })
      currentNode.value = payload.data?.current_node
      lastBattleResult.value = null
      lastSettlement.value = null
      view.value = 'progress'
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '进入副本失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 继续进行中副本
 */
const handleContinueDungeon = async () => {
  view.value = 'progress'
  await fetchCurrentNode()
}

/**
 * 推进节点（story/reward）
 */
const handleAdvance = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await advanceNode()
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '推进失败', 'warning')
    } else {
      // 检查是否返回了 settlement（章节通关）
      if (payload.data?.current_node) {
        currentNode.value = payload.data.current_node
        uiStore.addLog({
          content: `进入下一关：${payload.data.current_node.title || ''}`,
          type: 'info',
          actorId: 'self'
        })
      }
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '推进节点失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 战斗节点
 */
const handleBattle = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await battleNode()
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '战斗失败', 'warning')
    } else {
      lastBattleResult.value = payload.data
      uiStore.addLog({
        content: payload.data?.battle_result === 'victory'
          ? `战斗胜利！${payload.data?.victory_text || ''}`
          : `战斗失败：${payload.data?.defeat_text || ''}`,
        type: payload.data?.battle_result === 'victory' ? 'success' : 'error',
        actorId: 'self'
      })

      // 如果有结算信息，说明副本已结束
      if (payload.data?.settlement) {
        lastSettlement.value = payload.data.settlement
        await fetchStatus()
      } else if (payload.data?.current_node) {
        // 推进到下一节点
        currentNode.value = payload.data.current_node
        await fetchStatus()
      }
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '战斗失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 解谜节点选择
 */
const handleChooseOption = async (optionId) => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await chooseOption(optionId)
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '选择失败', 'warning')
    } else {
      uiStore.addLog({
        content: payload.data?.choice_result || '已选择',
        type: 'info',
        actorId: 'self'
      })

      // 检查是否返回了 settlement（HP耗尽或章节通关）
      if (payload.data?.current_node) {
        currentNode.value = payload.data.current_node
      }
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '选择失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 弹出中断副本二次确认弹窗
 */
const confirmInterrupt = () => {
  if (loading.value) return
  interruptConfirmOpen.value = true
}

/**
 * 执行中断副本
 */
const handleInterrupt = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await interruptDungeon()
    const payload = res.data
    interruptConfirmOpen.value = false
    if (payload.success === false) {
      uiStore.showToast(payload.message || '中断失败', 'warning')
    } else {
      uiStore.showToast(payload.message || '副本已中断', 'info')
      // 修复 B4-Reward：BigInt 字符串需用 formatNumber 格式化，避免长串数字不直观
      const rewardExp = payload.data?.rewards?.exp
      uiStore.addLog({
        content: `中断副本：${payload.data?.chapter_name || ''}，补偿修为 ${formatNumber(rewardExp || 0)}`,
        type: 'info',
        actorId: 'self'
      })
      lastSettlement.value = payload.data
      currentNode.value = null
      lastBattleResult.value = null
      view.value = 'list'
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '中断副本失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 扫荡副本
 */
const handleSweepDungeon = async (chapterId) => {
  if (loading.value) return
  const difficulty = getSelectedDifficulty(chapterId)
  loading.value = true
  try {
    const res = await sweepDungeon(chapterId, difficulty)
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '扫荡失败', 'warning')
    } else {
      uiStore.showToast(payload.message || '扫荡成功', 'success')
      // 修复 B4-Reward：BigInt 字符串需用 formatNumber 格式化，避免长串数字不直观
      const rewardExp = payload.data?.rewards?.exp
      const rewardStones = payload.data?.rewards?.spirit_stones
      uiStore.addLog({
        content: `扫荡：${payload.data?.chapter_name}（${getDifficultyLabel(difficulty)}），获得修为 ${formatNumber(rewardExp || 0)}，灵石 ${formatNumber(rewardStones || 0)}`,
        type: 'success',
        actorId: 'self'
      })
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '扫荡失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 退出副本进行中视图（返回章节列表，不中断副本）
 */
const handleExitProgress = () => {
  view.value = 'list'
  currentNode.value = null
  lastBattleResult.value = null
  lastSettlement.value = null
}

/**
 * 手动刷新状态
 */
const handleRefresh = async () => {
  await Promise.all([fetchConfig(), fetchStatus()])
  if (view.value === 'progress' && status.value?.in_dungeon) {
    await fetchCurrentNode()
  } else if (view.value === 'history') {
    await fetchHistory()
  }
  uiStore.showToast('状态已刷新', 'info')
}

onMounted(async () => {
  await Promise.all([fetchConfig(), fetchStatus()])
  // 如果玩家有进行中副本，默认进入进度视图
  if (status.value?.in_dungeon && status.value.in_progress) {
    view.value = 'progress'
    await fetchCurrentNode()
  }
  // 每秒更新 now 用于驱动倒计时显示（前端只是显示用，权威值仍在后端）
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})
</script>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
</style>
