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
  <PanelShell
    title="秘境副本"
    hint="章节挑战 · 难度三档 · 三星扫荡"
    size="lg"
    @close="$emit('close')"
  >
    <div class="space-y-3">
      <!-- 状态总览 -->
      <PanelCard v-if="status" :padded="false" class="px-3 py-2.5">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div>
            <div class="text-fg-faint">当前境界</div>
            <div class="text-gold-300 font-bold">{{ status.realm_name }}</div>
          </div>
          <div>
            <div class="text-fg-faint">今日挑战</div>
            <div class="font-bold" :class="status.daily_challenge_count >= status.daily_challenge_limit ? 'text-rose-400' : 'text-emerald-400'">
              {{ status.daily_challenge_count }} / {{ status.daily_challenge_limit }}
            </div>
          </div>
          <div>
            <div class="text-fg-faint">冷却状态</div>
            <div class="font-bold" :class="status.cooldown_ready ? 'text-emerald-400' : 'text-gold-400'">
              {{ status.cooldown_ready ? '就绪' : `冷却中 ${formatTime(status.cooldown_remaining_sec)}` }}
            </div>
          </div>
          <div>
            <div class="text-fg-faint">通关章节数</div>
            <div class="text-cyan-300 font-bold">{{ status.completed_chapters.length }}</div>
          </div>
        </div>
      </PanelCard>

      <!-- 副本进行中提示 -->
      <PanelCard v-if="status?.in_dungeon && status.in_progress" tone="danger" :padded="false" class="flex items-center gap-2 px-3 py-2.5 text-xs text-rose-300">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span>
          副本进行中：<span class="text-gold-300">{{ status.in_progress.chapter_name }}</span>
          · 难度：<span class="text-gold-300">{{ getDifficultyLabel(status.in_progress.difficulty) }}</span>
          · 剩余时间：<span class="text-gold-300">{{ formatTime(status.in_progress.remaining_seconds) }}</span>
        </span>
        <AppButton size="xs" variant="outline" class="ms-auto" :disabled="loading" @click="handleContinueDungeon">
          继续挑战
        </AppButton>
      </PanelCard>

      <!-- 首屏拉取失败：常驻错误态 + 重试。
           没有把 :error 交给 PanelShell —— 外壳的错误态会整块替换插槽，
           连「副本进行中」提示条和视图切换按钮一起吞掉，正在挑战的玩家反而找不到入口。 -->
      <ErrorState
        v-if="configError || statusError"
        :message="configError || statusError"
        @retry="handleRefresh"
      />

      <!-- 内容区：视图切换（章节列表 / 副本进行中 / 通关历史） -->
      <div>
        <!-- 视图切换：章节选择 / 副本进行中 / 通关历史 -->
        <div v-if="view === 'list'" class="space-y-3">
          <!-- 章节列表 -->
          <section v-for="chapter in chapters" :key="chapter.id" class="bg-surface-hover border border-line rounded-panel p-4">
            <div class="flex items-start justify-between mb-2">
              <div class="flex-1">
                <div class="text-sm font-bold text-gold-300 flex items-center gap-2">
                  {{ chapter.name }}
                  <span v-if="getChapterStars(chapter.id) > 0" class="text-[10px] text-gold-500">
                    {{ '★'.repeat(getChapterStars(chapter.id)) }}
                  </span>
                </div>
                <div class="text-[11px] text-fg-faint mt-0.5">
                  推荐境界：{{ chapter.recommended_realm }} · {{ chapter.node_count }} 关 · BOSS：{{ chapter.boss_name || '未知' }} · 时长 {{ formatTime(chapter.duration_sec) }}
                </div>
                <div class="text-xs text-fg-muted mt-2 leading-relaxed">{{ chapter.description }}</div>
              </div>
              <div v-if="!status?.unlocked || (status?.realm_rank ?? 0) < chapter.min_realm_rank"
                class="text-[10px] text-rose-400 px-2 py-0.5 rounded bg-rose-950/40 border border-rose-900/40 shrink-0 ml-2">
                需{{ chapter.recommended_realm }}
              </div>
            </div>

            <!-- 难度选择与操作 -->
            <div v-if="canChallenge(chapter)" class="mt-3 pt-3 border-t border-line-subtle">
              <div class="flex items-center gap-2 text-xs mb-2">
                <span class="text-fg-faint">难度：</span>
                <button v-for="d in difficulties" :key="d.value"
                  @click="selectDifficulty(chapter.id, d.value)"
                  :disabled="loading"
                  class="text-xs py-1 px-2 rounded border transition-all"
                  :class="getSelectedDifficulty(chapter.id) === d.value
                    ? `${d.activeClass} ${d.borderClass} ${d.textClass}`
                    : 'bg-surface-raised/40 border-line text-fg-muted hover:border-line-strong'">
                  {{ d.label }}
                </button>
                <span class="text-fg-faint ml-2 text-[10px]">
                  倍率：HP×{{ getDifficultyMultiplier(getSelectedDifficulty(chapter.id), 'hp') }} · 攻击×{{ getDifficultyMultiplier(getSelectedDifficulty(chapter.id), 'atk') }} · 修为×{{ getDifficultyMultiplier(getSelectedDifficulty(chapter.id), 'exp') }}
                </span>
              </div>
              <div class="flex gap-2">
                <button @click="handleStartDungeon(chapter.id)"
                  :disabled="loading || !status?.cooldown_ready || (status?.daily_challenge_count ?? 0) >= (status?.daily_challenge_limit ?? 0) || status?.in_dungeon"
                  class="flex-1 py-2 rounded-control text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-amber-950/40 border border-gold-700 text-gold-300 hover:bg-gold-900/40 hover:border-gold-500">
                  <span v-if="loading">进入中...</span>
                  <span v-else-if="status?.in_dungeon">已在副本中</span>
                  <span v-else-if="!status?.cooldown_ready">冷却中</span>
                  <span v-else-if="(status?.daily_challenge_count ?? 0) >= (status?.daily_challenge_limit ?? 0)">今日次数已用尽</span>
                  <span v-else>进入副本</span>
                </button>
                <button v-if="canSweep(chapter.id)" @click="handleSweepDungeon(chapter.id)"
                  :disabled="loading || !status?.cooldown_ready || (status?.daily_challenge_count ?? 0) >= (status?.daily_challenge_limit ?? 0) || status?.in_dungeon"
                  class="flex-1 py-2 rounded-control text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-950/40 border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40 hover:border-cyan-500">
                  <span v-if="loading">扫荡中...</span>
                  <span v-else>扫荡（{{ Math.round((status?.sweep_reward_ratio ?? 0) * 100) }}%奖励）</span>
                </button>
              </div>
            </div>

            <!-- 未解锁提示 -->
            <div v-else class="mt-3 pt-3 border-t border-line-subtle text-xs text-fg-faint text-center py-2">
              境界达到 <span class="text-gold-400">{{ chapter.recommended_realm }}</span> 后解锁
            </div>
          </section>

          <!-- 查看通关历史按钮 -->
          <AppButton size="sm" block @click="switchView('history')">查看通关历史</AppButton>
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
            <h3 class="text-sm font-bold text-fg-secondary font-display">通关历史</h3>
            <AppButton size="xs" variant="ghost" @click="switchView('list')">← 返回章节列表</AppButton>
          </div>
          <EmptyState v-if="history.length === 0" text="暂无通关记录" hint="首次通关一章后可在此回看用时、星级与收益" />
          <div v-for="entry in history" :key="entry.id"
            class="bg-surface-hover border border-line rounded-panel p-3 text-xs">
            <div class="flex items-center justify-between mb-1">
              <div class="font-bold text-gold-300">
                {{ entry.chapter_name }}
                <span class="text-[10px] text-fg-faint ml-1">（{{ getDifficultyLabel(entry.difficulty) }}）</span>
              </div>
              <div class="text-gold-500">{{ '★'.repeat(entry.stars) }}<span class="text-line-strong">{{ '★'.repeat(3 - entry.stars) }}</span></div>
            </div>
            <div class="text-fg-muted flex items-center gap-3 text-[11px]">
              <span>用时：{{ formatTime(entry.completion_time_sec) }}</span>
              <span>修为：+{{ formatNumber(entry.exp_gained) }}</span>
              <span>灵石：+{{ formatNumber(entry.spirit_stones_gained) }}</span>
            </div>
            <div class="text-fg-faint text-[10px] mt-1">{{ formatDate(entry.completed_at) }}</div>
          </div>
        </div>
      </div>

    </div>

    <!-- 中断副本二次确认弹窗 -->
    <Modal :isOpen="interruptConfirmOpen" title="中断副本确认" width="500px" @close="interruptConfirmOpen = false">
      <div class="space-y-3 text-sm text-fg-secondary">
        <p class="text-gold-300 font-bold">确定要中断当前副本挑战吗？</p>
        <ul class="text-xs text-fg-muted space-y-1 list-disc pl-5">
          <li>中断将按失败结算，本次挑战不记录通关</li>
          <li>补偿50%已积累修为，不发放物品与灵石</li>
          <li>会消耗一次今日挑战次数与冷却时间</li>
        </ul>
        <p class="text-xs text-fg-faint">建议仅在HP过低无法继续时使用此功能。</p>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="interruptConfirmOpen = false">继续挑战</AppButton>
        <AppButton variant="danger" :disabled="loading" @click="handleInterrupt">
          {{ loading ? '执行中...' : '确认中断' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 底部操作栏 -->
    <template #footer>
      <AppButton variant="outline" :disabled="loading" @click="handleRefresh">刷新状态</AppButton>
      <AppButton class="flex-1" @click="$emit('close')">关闭</AppButton>
    </template>
  </PanelShell>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { formatBeijing } from '../../utils/time'
import { useUIStore } from '../../stores/ui'
import { useAsyncTask } from '../../composables/useAsyncTask'
import { formatTime, formatNumber } from '../../utils/format'
import Modal from '../common/Modal.vue'
import DungeonProgressView from './DungeonProgressView.vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import EmptyState from '../ui/EmptyState.vue'
import ErrorState from '../ui/ErrorState.vue'
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
/**
 * 首屏两份数据的失败记账
 * 与上面的 loading 分开：loading 是「进入副本/扫荡/推进」等动作的进行中锁，
 * 这里只管副本配置与状态拉取，失败要留下常驻的错误态和重试入口。
 */
const { error: configError, run: runConfig } = useAsyncTask({ fallback: '获取副本配置失败' })
const { error: statusError, run: runStatus } = useAsyncTask({ fallback: '获取副本状态失败' })
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
  { value: 'hard',      label: '困难', activeClass: 'bg-amber-950/40',   borderClass: 'border-gold-600',   textClass: 'text-gold-300' },
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
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(dateStr, { seconds: false })
}

/**
 * 拉取副本配置
 */
const fetchConfig = () => runConfig(async () => {
  const res = await getConfig()
  config.value = res.data?.data || res.data
})

/**
 * 拉取副本状态
 */
const fetchStatus = () => runStatus(async () => {
  const res = await getStatus()
  status.value = res.data?.data || res.data
})

/**
 * 拉取通关历史
 */
const fetchHistory = async () => {
  try {
    const res = await getHistory(20)
    history.value = res.data?.data || []
  } catch (err) {
    console.error('获取通关历史失败:', err)
    uiStore.showApiError(err, '获取通关历史失败')
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
    uiStore.showApiError(err, '获取当前节点失败')
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
    uiStore.showApiError(err, '进入副本失败')
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
    uiStore.showApiError(err, '推进节点失败')
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
    uiStore.showApiError(err, '战斗失败')
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
    uiStore.showApiError(err, '选择失败')
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
    uiStore.showApiError(err, '中断副本失败')
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
    uiStore.showApiError(err, '扫荡失败')
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
