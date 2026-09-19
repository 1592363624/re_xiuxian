<script setup lang="ts">
/**
 * 宗门系统面板组件
 *
 * 功能说明：
 *   - 外壳走 ui/PanelShell.vue（右坞停靠 + 遮罩 + Esc 关闭 + 加载态）
 *   - 顶部 Tab 切换：宗门列表 / 我的宗门（已加入宗门时默认显示"我的宗门"）
 *   - 宗门列表视图：展示 6 大宗门卡片，支持拜入（自定义 Modal 二次确认）
 *   - 我的宗门视图：宗门信息、每日点卯/传功（带冷却倒计时）、宗门任务、宝库兑换、叛出宗门
 *   - 所有业务逻辑通过 sect API 调用后端，前端只做展示与交互
 *   - 操作成功后刷新数据并同步玩家状态（修为/灵石变更影响其他 UI）
 *   - 禁用浏览器原生 alert/confirm，统一使用自定义 Modal 组件
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import Badge from '../ui/Badge.vue'
import EmptyState from '../ui/EmptyState.vue'
import ErrorState from '../ui/ErrorState.vue'
import AppButton from '../ui/AppButton.vue'
import {
  getSectList,
  getMySect,
  getQuests,
  getTreasury,
  joinSect,
  leaveSect,
  dailyCheckIn,
  transferSkill,
  submitQuest,
  acceptQuest,
  exchangeTreasury,
  type Sect,
  type MySect,
  type SectQuest,
  type TreasuryItem
} from '../../api/sect'
import { useUIStore } from '../../stores/ui'
import { useAsyncTask } from '../../composables/useAsyncTask'
import { usePlayerStore } from '../../stores/player'
// 修复 4-3-P1-2：引入 formatNumber 处理 BigInt 字符串显示
import { formatNumber, formatCompact } from '../../utils/format'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

// ====== 响应式状态 ======
const { loading, error, run } = useAsyncTask({ fallback: '加载宗门数据失败' })
const operating = ref(false)             // 操作中状态锁，防止重复提交
const activeTab = ref<'list' | 'my'>('list')  // 当前激活的 Tab
const sects = ref<Sect[]>([])             // 所有宗门列表
const mySect = ref<MySect | null>(null)   // 我的宗门信息
const quests = ref<SectQuest[]>([])       // 我的宗门任务列表
const treasury = ref<TreasuryItem[]>([])  // 我的宗门宝库物品
// 当前时间戳，每秒更新一次用于驱动冷却倒计时
const currentTime = ref(Date.now())
let timer: number | null = null

// ====== 确认弹窗状态（统一管理 拜入/叛出/兑换 三类确认） ======
const confirmModal = ref<{
  show: boolean
  type: 'join' | 'leave' | 'exchange'
  // 拜入时存 Sect，兑换时存 TreasuryItem，叛出时为 null
  payload: Sect | TreasuryItem | null
}>({
  show: false,
  type: 'join',
  payload: null
})

// ====== 计算属性 ======

/**
 * 是否已加入宗门
 */
const hasJoined = computed(() => !!mySect.value)

/** 标签页定义（key/label 契约见 ui/Tabs.vue）；已入宗时给「我的宗门」挂一个圆点 */
const tabItems = computed(() => [
  { key: 'list', label: '宗门列表' },
  { key: 'my', label: '我的宗门', badge: hasJoined.value ? '●' : undefined }
])

/**
 * 基于后端权威冷却剩余 + 本地 tick 递减计算点卯剩余冷却毫秒
 * 设计说明：冷却时长由后端配置（game_balance.sect.checkin_cooldown_hours）权威计算，
 * 前端不再硬编码 24h，仅基于后端返回的剩余值做本地平滑递减展示，避免时钟漂移误差
 */
const checkInRemainingMs = computed(() => {
  if (!mySect.value) return 0
  const backendRemaining = mySect.value.checkin_cooldown_remaining_ms ?? 0
  if (backendRemaining <= 0) return 0
  // 基于服务端时间戳计算本地流逝时间，避免时钟漂移
  const serverTime = mySect.value.server_time || Date.now()
  const localElapsedMs = currentTime.value - serverTime
  return Math.max(0, backendRemaining - localElapsedMs)
})

/**
 * 传功剩余冷却毫秒（基于后端权威值 + 本地 tick 递减）
 */
const transferRemainingMs = computed(() => {
  if (!mySect.value) return 0
  const backendRemaining = mySect.value.transfer_cooldown_remaining_ms ?? 0
  if (backendRemaining <= 0) return 0
  const serverTime = mySect.value.server_time || Date.now()
  const localElapsedMs = currentTime.value - serverTime
  return Math.max(0, backendRemaining - localElapsedMs)
})

/**
 * 是否可点卯（无冷却且非操作中）
 */
const canCheckIn = computed(() => checkInRemainingMs.value === 0 && !operating.value)

/**
 * 是否可传功（无冷却且非操作中）
 */
const canTransfer = computed(() => transferRemainingMs.value === 0 && !operating.value)

// ====== 数据加载 ======

/**
 * 初始化加载：并行获取宗门列表与我的宗门信息
 * 已加入宗门时默认切换到"我的宗门"Tab
 * 失败由 useAsyncTask 记账：常驻错误态 + 重试入口，不再只 toast 一句就留白
 */
const fetchAll = () => run(async () => {
  await Promise.all([fetchSectList(), fetchMySect()])
  // 已加入宗门则默认进入"我的宗门"视图
  if (mySect.value) {
    activeTab.value = 'my'
  }
})

/**
 * 获取所有宗门列表
 * 失败不再就地吞掉：交给 fetchAll 外层的 run() 统一播报并留痕
 */
const fetchSectList = async () => {
  const res = await getSectList()
  // 后端返回 { code, data: { sects: [...] } }
  sects.value = res.data?.data?.sects || []
}

/**
 * 获取我的宗门信息（未加入返回 null）
 * 若已加入则顺带加载任务和宝库
 */
const fetchMySect = async () => {
  try {
    const res = await getMySect()
    const data = res.data?.data
    mySect.value = data || null

    if (mySect.value) {
      // 并行加载任务和宝库
      await Promise.all([fetchQuests(), fetchTreasury(mySect.value.sect_id)])
    } else {
      // 未加入宗门，清空任务和宝库
      quests.value = []
      treasury.value = []
    }
  } catch (error) {
    console.error('获取我的宗门信息失败:', error)
    mySect.value = null
  }
}

/**
 * 获取宗门任务列表
 */
const fetchQuests = async () => {
  try {
    const res = await getQuests()
    const data = res.data?.data
    quests.value = data?.quests || []
  } catch (error) {
    console.error('获取宗门任务失败:', error)
    quests.value = []
  }
}

/**
 * 获取宗门宝库物品列表
 * @param sectId - 宗门ID
 */
const fetchTreasury = async (sectId: string) => {
  try {
    const res = await getTreasury(sectId)
    const data = res.data?.data
    treasury.value = data?.treasury || []
  } catch (error) {
    console.error('获取宗门宝库失败:', error)
    treasury.value = []
  }
}

// ====== 操作处理 ======

/**
 * 点击拜入按钮：打开确认弹窗
 * @param sect - 宗门对象
 */
const handleJoin = (sect: Sect) => {
  if (operating.value) return
  confirmModal.value = {
    show: true,
    type: 'join',
    payload: sect
  }
}

/**
 * 点击叛出按钮：打开确认弹窗
 */
const handleLeave = () => {
  if (operating.value) return
  confirmModal.value = {
    show: true,
    type: 'leave',
    payload: null
  }
}

/**
 * 点击兑换按钮：打开确认弹窗
 * @param item - 宝库物品
 */
const handleExchange = (item: TreasuryItem) => {
  if (operating.value) return
  confirmModal.value = {
    show: true,
    type: 'exchange',
    payload: item
  }
}

/**
 * 关闭确认弹窗
 */
const closeConfirmModal = () => {
  confirmModal.value.show = false
  confirmModal.value.payload = null
}

/**
 * 确认弹窗回调：根据 type 执行对应操作
 */
const handleConfirm = async () => {
  const { type, payload } = confirmModal.value
  // 先关闭弹窗，再执行操作（避免操作期间弹窗被多次点击）
  closeConfirmModal()

  if (type === 'join' && payload) {
    await doJoin(payload as Sect)
  } else if (type === 'leave') {
    await doLeave()
  } else if (type === 'exchange' && payload) {
    await doExchange(payload as TreasuryItem)
  }
}

/**
 * 执行拜入宗门操作
 * @param sect - 宗门对象
 */
const doJoin = async (sect: Sect) => {
  operating.value = true
  try {
    const res = await joinSect(sect.id)
    const result = res.data
    uiStore.showToast(result.message || `成功拜入【${sect.name}】`, 'success')

    // 同步玩家灵石（拜入消耗灵石）
    if (result.spirit_stones !== undefined && playerStore.player) {
      playerStore.player.spirit_stones = result.spirit_stones
    }

    // 刷新宗门信息并切换到"我的宗门"Tab
    await fetchMySect()
    activeTab.value = 'my'

    uiStore.addLog({
      content: `你拜入了${sect.alignment}宗门【${sect.name}】，自此踏上宗门修行之路。`,
      type: 'info',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '拜入失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行叛出宗门操作
 */
const doLeave = async () => {
  operating.value = true
  try {
    const res = await leaveSect()
    uiStore.showToast(res.data?.message || '已叛出宗门', 'success')

    // 清空本地宗门数据并切换到"宗门列表"Tab
    mySect.value = null
    quests.value = []
    treasury.value = []
    activeTab.value = 'list'

    uiStore.addLog({
      content: '你叛出宗门，自此孑然一身，重新踏上散修之路。',
      type: 'info',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '叛出失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行每日点卯
 */
const handleCheckIn = async () => {
  if (!canCheckIn.value) return
  operating.value = true
  try {
    const res = await dailyCheckIn()
    const result = res.data
    uiStore.showToast(result.message || '点卯成功', 'success')

    // 同步玩家修为（点卯奖励修为）
    if (result.exp !== undefined && playerStore.player) {
      playerStore.player.exp = result.exp
    }

    // 刷新宗门信息（更新 last_check_in 与贡献度）
    await fetchMySect()

    uiStore.addLog({
      content: `你在宗门完成点卯，获得贡献 +${result.rewards?.contribution || 0}，修为 +${formatNumber(result.rewards?.exp || 0)}。`,
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '点卯失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行宗门传功
 */
const handleTransfer = async () => {
  if (!canTransfer.value) return
  operating.value = true
  try {
    const res = await transferSkill()
    const result = res.data
    uiStore.showToast(result.message || '传功完成', 'success')

    // 同步玩家修为与灵石（传功消耗灵石、增加修为）
    if (playerStore.player) {
      if (result.exp !== undefined) playerStore.player.exp = result.exp
      if (result.spirit_stones !== undefined) playerStore.player.spirit_stones = result.spirit_stones
    }

    // 刷新宗门信息（更新 last_transfer）
    await fetchMySect()

    uiStore.addLog({
      content: `你接受宗门长辈传功，消耗灵石 ${result.cost_spirit_stones || 0}，修为 +${result.gain_exp || 0}。`,
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '传功失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 提交宗门任务
 * @param quest - 任务对象
 */
const handleSubmitQuest = async (quest: SectQuest) => {
  if (quest.completed || operating.value) return
  operating.value = true
  try {
    const res = await submitQuest(quest.id)
    const result = res.data
    uiStore.showToast(result.message || '任务完成', 'success')

    // 同步玩家修为
    if (result.exp !== undefined && playerStore.player) {
      playerStore.player.exp = result.exp
    }

    // 刷新任务列表与宗门信息（贡献度变化）
    await Promise.all([fetchQuests(), fetchMySect()])

    uiStore.addLog({
      content: `你完成了宗门任务【${quest.name}】，获得贡献 +${result.rewards?.contribution || 0}，修为 +${formatNumber(result.rewards?.exp || 0)}。`,
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '提交任务失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 接取宗门任务
 * @param quest - 任务对象
 */
const handleAcceptQuest = async (quest: SectQuest) => {
  if (quest.accepted || quest.completed || operating.value) return
  operating.value = true
  try {
    const res = await acceptQuest(quest.id)
    const result = res.data
    uiStore.showToast(result.message || '任务接取成功', 'success')

    // 刷新任务列表（更新接取状态）
    await fetchQuests()

    uiStore.addLog({
      content: `你接取了宗门任务【${quest.name}】，预计需要 ${result.min_wait_minutes || 5} 分钟完成。`,
      type: 'info',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '接取任务失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 执行宝库兑换
 * @param item - 宝库物品
 */
const doExchange = async (item: TreasuryItem) => {
  operating.value = true
  try {
    const res = await exchangeTreasury(item.id)
    const result = res.data
    uiStore.showToast(result.message || `兑换成功，获得【${item.name}】`, 'success')

    // 刷新宗门信息（贡献度减少）
    await fetchMySect()

    uiStore.addLog({
      content: `你在宗门宝库兑换了【${item.name}】，消耗贡献 ${result.cost || item.cost}。`,
      type: 'success',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '兑换失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== 辅助方法 ======

/**
 * 获取阵营对应的卡片样式（正道：金/蓝边框；魔道：紫/红边框）
 * @param alignment - 阵营
 */
const getAlignmentCardClass = (alignment: string) => {
  if (alignment === '正道') {
    return 'border-gold-700/50 hover:border-gold-500/80 hover:shadow-[0_0_15px_rgb(var(--gold-500)/0.15)]'
  }
  return 'border-purple-700/50 hover:border-purple-500/80 hover:shadow-[0_0_15px_rgb(var(--state-arcane)/0.15)]'
}

/**
 * 获取阵营标签色（ui/Badge.vue 的 tone）
 * @param alignment - 阵营
 */
const getAlignmentTone = (alignment: string) => (alignment === '正道' ? 'gold' : 'arcane')

/**
 * 获取五行属性标签色（ui/Badge.vue 的 tone）
 * @param element - 五行属性
 */
const getElementTone = (element: string) => {
  const map: Record<string, string> = {
    '金': 'gold',
    '木': 'success',
    '水': 'info',
    '火': 'danger',
    '土': 'neutral'
  }
  return map[element] || 'neutral'
}

/**
 * 获取身份中文名
 * @param role - 身份 key
 */
const getRoleName = (role: string) => {
  return role === 'elder' ? '长老' : '弟子'
}

/**
 * 宗门加成字段中文名映射表
 * 设计说明：后端 sect_data.json 的 bonus 字段为英文 key，前端需映射为修仙题材中文名展示
 * 不同宗门只配置各自相关的 2 个字段，其余字段为 undefined 不展示
 */
const bonusLabels: Record<string, string> = {
  exp_multiplier: '修为加成',
  gather_bonus: '采集加成',
  sense_multiplier: '感知加成',
  breakthrough_bonus: '突破加成',
  luck_bonus: '气运加成',
  atk_multiplier: '攻击加成',
  dark_arts_bonus: '魔道加成',
  charm_bonus: '魅惑加成',
  mp_multiplier: '灵力加成',
  mental_strength: '道心加成'
}

/**
 * 格式化 bonus 字段值为展示文本
 *   - *_multiplier 类（倍率）：1.1 → "+10%"
 *   - *_bonus / mental_strength 类（加成比例）：0.15 → "+15%"
 *   - 其他数值：原样展示
 * @param key - bonus 字段 key
 * @param value - 字段值
 * @returns {string} 格式化后的展示文本
 */
const formatBonusValue = (key: string, value: number): string => {
  if (typeof value !== 'number' || isNaN(value)) return '—'
  // 倍率类字段：value - 1 后转百分比（1.1 → +10%）
  if (key.endsWith('_multiplier')) {
    const pct = (value - 1) * 100
    return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`
  }
  // 加成比例类字段：直接转百分比（0.15 → +15%）
  const pct = value * 100
  return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`
}

/**
 * 将 bonus 对象转换为有序展示列表
 * 只返回该宗门实际配置的字段（过滤 undefined），按 bonusLabels 映射顺序输出
 * @param bonus - 宗门加成对象
 * @returns {Array<{label: string, value: string}>} 加成项列表
 */
const getBonusList = (bonus: Record<string, number> | undefined | null): Array<{ label: string; value: string }> => {
  if (!bonus || typeof bonus !== 'object') return []
  const result: Array<{ label: string; value: string }> = []
  // 按 bonusLabels 定义顺序遍历，保证各宗门展示顺序一致
  for (const key of Object.keys(bonusLabels)) {
    const val = bonus[key]
    if (val !== undefined && val !== null) {
      result.push({
        label: bonusLabels[key],
        value: formatBonusValue(key, Number(val))
      })
    }
  }
  return result
}

/**
 * 格式化冷却倒计时（HH:MM:SS）
 * @param ms - 剩余毫秒
 */
const formatCountdown = (ms: number) => {
  if (ms <= 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

/**
 * 格式化日期为 yyyy-MM-dd HH:mm
 * @param dateStr - 日期字符串
 */
const formatDate = (dateStr: string | null) => {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const min = d.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

// ====== 生命周期 ======
onMounted(() => {
  // 挂载即进入加载态：首屏在 fetchAll 落地前先亮 LoadingBlock（原先由 ref(true) 承担）
  loading.value = true
  fetchAll()
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
    title="宗门系统"
    hint="拜入 · 点卯 · 传功 · 任务 · 宝库"
    size="xl"
    :loading="loading"
    @close="emit('close')"
  >
    <!-- Tab 切换栏 -->
    <Tabs v-model="activeTab" :items="tabItems" class="mb-4" />

    <!-- ====== 宗门列表视图 ====== -->
    <div v-if="activeTab === 'list'" class="space-y-4">
      <!-- 拉取失败：错误态放在页签体内。
           交给 PanelShell 的 :error 会整块替换插槽，连「宗门列表 / 我的宗门」页签一起藏掉。 -->
      <ErrorState v-if="error" :message="error" @retry="fetchAll" />
      <EmptyState v-else-if="sects.length === 0" text="暂无宗门信息" />

      <!-- 宗门卡片网格 -->
      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          v-for="sect in sects"
          :key="sect.id"
          class="bg-surface-raised border rounded-panel p-4 transition-all duration-300"
          :class="getAlignmentCardClass(sect.alignment)"
        >
          <!-- 卡片头部：名称 + 阵营/五行徽章 -->
          <div class="flex justify-between items-start mb-3">
            <div>
              <h3 class="text-lg font-bold flex items-center gap-2 font-display"
                  :class="sect.alignment === '正道' ? 'text-gold-400' : 'text-purple-400'">
                {{ sect.name }}
              </h3>
              <div class="flex gap-1.5 mt-1.5">
                <Badge :tone="getAlignmentTone(sect.alignment)">{{ sect.alignment }}</Badge>
                <Badge :tone="getElementTone(sect.element)">{{ sect.element }}行</Badge>
              </div>
            </div>
            <!-- 已加入标记 -->
            <Badge v-if="hasJoined && mySect?.sect_id === sect.id" tone="success" solid>已拜入</Badge>
          </div>

          <!-- 宗门描述 -->
          <p class="text-xs text-fg-muted leading-relaxed mb-3">{{ sect.description }}</p>

          <!-- 加入要求 -->
          <div class="bg-surface-canvas rounded-control p-2 border border-line-subtle mb-3">
            <div class="text-xs text-fg-faint mb-1">拜入要求</div>
            <div class="flex justify-between text-xs">
              <span class="text-fg-secondary">境界: <span class="text-gold-400">{{ sect.join_requirement?.realm_min || '无' }}</span></span>
              <span class="text-fg-secondary">灵石: <span class="text-yellow-500">{{ sect.join_requirement?.spirit_stones || 0 }}</span></span>
            </div>
          </div>

          <!-- 宗门加成展示区：展示该宗门独有的加成特色（不同宗门字段不同） -->
          <div v-if="getBonusList(sect.bonus).length > 0" class="bg-surface-canvas rounded-control p-2 border border-line-subtle mb-3">
            <div class="text-xs text-fg-faint mb-1.5 flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-violet-500">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              宗门加成
            </div>
            <div class="flex flex-wrap gap-2">
              <span
                v-for="item in getBonusList(sect.bonus)"
                :key="item.label"
                class="text-xs px-2 py-0.5 rounded bg-violet-900/20 border border-violet-700/40 text-violet-300"
              >
                {{ item.label }} <span class="text-emerald-400 font-bold">{{ item.value }}</span>
              </span>
            </div>
          </div>

          <!-- 操作按钮 -->
          <div class="flex justify-end">
            <button
              v-if="!hasJoined"
              @click="handleJoin(sect)"
              :disabled="operating"
              class="px-4 py-1.5 rounded-control bg-violet-900/30 border border-violet-700/50 text-violet-400 hover:bg-violet-800/50 hover:text-violet-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              拜入
            </button>
            <AppButton v-else-if="mySect?.sect_id === sect.id" variant="default" size="sm" disabled>
              已加入
            </AppButton>
            <span v-else class="text-xs text-fg-faint">已加入其他宗门</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ====== 我的宗门视图 ====== -->
    <div v-else-if="activeTab === 'my'">
      <!-- 未加入宗门提示 -->
      <EmptyState v-if="!hasJoined" text="你尚未拜入任何宗门">
        <AppButton variant="primary" size="sm" @click="activeTab = 'list'">前往宗门列表</AppButton>
      </EmptyState>

      <!-- 已加入宗门：展示完整信息 -->
      <div v-else class="space-y-4">
        <!-- 宗门信息卡片 -->
        <div class="bg-surface-raised border rounded-panel p-4"
             :class="mySect.alignment === '正道' ? 'border-gold-700/50' : 'border-purple-700/50'">
          <div class="flex justify-between items-start mb-3">
            <div>
              <h3 class="text-xl font-bold flex items-center gap-2 font-display"
                  :class="mySect.alignment === '正道' ? 'text-gold-400' : 'text-purple-400'">
                {{ mySect.name }}
                <Badge :tone="getAlignmentTone(mySect.alignment)">{{ mySect.alignment }}</Badge>
                <Badge :tone="getElementTone(mySect.element)">{{ mySect.element }}行</Badge>
              </h3>
              <p class="text-xs text-fg-muted mt-1">{{ mySect.description }}</p>
            </div>
            <AppButton variant="danger" size="xs" :disabled="operating" @click="handleLeave">
              叛出宗门
            </AppButton>
          </div>

          <!-- 身份与贡献度统计 -->
          <div class="grid grid-cols-3 gap-3 mt-3">
            <div class="bg-surface-canvas rounded-control p-2 border border-line-subtle text-center">
              <div class="text-xs text-fg-faint mb-1">身份</div>
              <div class="text-sm font-bold text-violet-400">{{ getRoleName(mySect.role) }}</div>
            </div>
            <div class="bg-surface-canvas rounded-control p-2 border border-line-subtle text-center">
              <div class="text-xs text-fg-faint mb-1">贡献度</div>
              <div class="text-sm font-bold text-gold-400 num" :title="String(mySect.contribution)">
                {{ formatCompact(mySect.contribution) }}
              </div>
            </div>
            <div class="bg-surface-canvas rounded-control p-2 border border-line-subtle text-center">
              <div class="text-xs text-fg-faint mb-1">加入时间</div>
              <div class="text-xs font-bold text-fg-secondary mt-1 num">{{ formatDate(mySect.joined_at) }}</div>
            </div>
          </div>

          <!-- 宗门加成展示区：玩家已加入宗门后查看自身加成（紫色主题，与列表卡片保持一致） -->
          <div v-if="getBonusList(mySect.bonus).length > 0" class="mt-3 bg-surface-canvas rounded-control p-3 border border-violet-800/40">
            <div class="text-xs text-fg-muted mb-2 flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-violet-500">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              <span class="font-bold text-violet-400">宗门加成</span>
              <span class="text-fg-faint font-normal">（入宗即享，永久生效）</span>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div
                v-for="item in getBonusList(mySect.bonus)"
                :key="item.label"
                class="flex items-center justify-between px-2.5 py-1.5 rounded bg-violet-900/15 border border-violet-700/30"
              >
                <span class="text-xs text-violet-300">{{ item.label }}</span>
                <span class="text-xs text-emerald-400 font-bold">{{ item.value }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 每日操作区：点卯 + 传功 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <!-- 点卯卡片 -->
          <div class="bg-surface-raised border border-line-subtle rounded-panel p-4">
            <div class="flex items-center justify-between mb-2">
              <h4 class="text-sm font-bold text-fg-secondary flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-gold-500">
                  <circle cx="12" cy="12" r="10"/>
                  <polyline points="12 6 12 12 16 14"/>
                </svg>
                每日点卯
              </h4>
              <span v-if="mySect.last_check_in" class="text-xs text-fg-faint">
                上次: {{ formatDate(mySect.last_check_in) }}
              </span>
            </div>
            <p class="text-xs text-fg-faint mb-3">每日拜见师长，领取贡献与修为奖励</p>
            <AppButton
              block
              size="sm"
              :variant="canCheckIn ? 'primary' : 'default'"
              :disabled="!canCheckIn"
              @click="handleCheckIn"
            >
              <span v-if="canCheckIn">点卯</span>
              <span v-else class="num">冷却中 {{ formatCountdown(checkInRemainingMs) }}</span>
            </AppButton>
          </div>

          <!-- 传功卡片 -->
          <div class="bg-surface-raised border border-line-subtle rounded-panel p-4">
            <div class="flex items-center justify-between mb-2">
              <h4 class="text-sm font-bold text-fg-secondary flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-500">
                  <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM2 9h4v12H2z"/>
                </svg>
                宗门传功
              </h4>
              <span v-if="mySect.last_transfer" class="text-xs text-fg-faint">
                上次: {{ formatDate(mySect.last_transfer) }}
              </span>
            </div>
            <p class="text-xs text-fg-faint mb-3">消耗灵石接受长辈传功，换取修为</p>
            <button
              @click="handleTransfer"
              :disabled="!canTransfer"
              class="w-full py-2 rounded-control border transition-colors text-sm"
              :class="canTransfer
                ? 'bg-cyan-900/30 border-cyan-700/50 text-cyan-400 hover:bg-cyan-800/50 hover:text-cyan-300'
                : 'bg-surface-raised border-line text-fg-faint cursor-not-allowed'"
            >
              <span v-if="canTransfer">传功</span>
              <span v-else class="num">冷却中 {{ formatCountdown(transferRemainingMs) }}</span>
            </button>
          </div>
        </div>

        <!-- 宗门任务列表 -->
        <div class="bg-surface-raised border border-line-subtle rounded-panel p-4">
          <h4 class="text-sm font-bold text-fg-secondary mb-3 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-500">
              <path d="M9 11l3 3L22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
            宗门任务
            <span class="text-xs text-fg-faint font-normal">（每日刷新）</span>
          </h4>

          <div v-if="quests.length === 0" class="text-center text-fg-faint text-sm py-4">
            暂无可用任务
          </div>

          <div v-else class="space-y-2">
            <div
              v-for="quest in quests"
              :key="quest.id"
              class="bg-surface-canvas border border-line-subtle rounded-control p-3 flex justify-between items-center"
              :class="{ 'opacity-60': quest.completed }"
            >
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm font-bold text-fg-secondary">{{ quest.name }}</span>
                  <Badge v-if="quest.daily" tone="neutral">日常</Badge>
                  <Badge v-if="quest.completed" tone="success">已完成</Badge>
                  <Badge v-else-if="quest.accepted" tone="info">进行中</Badge>
                </div>
                <p class="text-xs text-fg-faint mb-1">{{ quest.description }}</p>
                <div class="text-xs flex gap-3 num">
                  <span class="text-gold-400" :title="String(quest.contribution)">贡献 +{{ formatCompact(quest.contribution) }}</span>
                  <span class="text-cyan-400" :title="String(quest.exp_reward)">修为 +{{ formatCompact(quest.exp_reward) }}</span>
                  <span v-if="(quest.min_contribution || 0) > 0" class="text-fg-faint">需要贡献 ≥{{ formatCompact(quest.min_contribution) }}</span>
                </div>
              </div>
              <!-- 按钮区：未接取显示"接取"，已接取未完成显示"提交"，已完成显示"已完成" -->
              <button
                v-if="!quest.completed && !quest.accepted"
                @click="handleAcceptQuest(quest)"
                :disabled="operating || (mySect?.contribution || 0) < (quest.min_contribution || 0)"
                class="ml-3 px-3 py-1.5 rounded-control border text-xs whitespace-nowrap transition-colors"
                :class="(mySect?.contribution || 0) < (quest.min_contribution || 0)
                  ? 'bg-surface-raised border-line text-fg-faint cursor-not-allowed'
                  : 'bg-cyan-900/30 border-cyan-700/50 text-cyan-400 hover:bg-cyan-800/50 hover:text-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed'"
              >
                {{ (mySect?.contribution || 0) < (quest.min_contribution || 0) ? '贡献不足' : '接取' }}
              </button>
              <button
                v-else-if="quest.accepted && !quest.completed"
                @click="handleSubmitQuest(quest)"
                :disabled="operating"
                class="ml-3 px-3 py-1.5 rounded-control border text-xs whitespace-nowrap transition-colors bg-emerald-900/30 border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                提交
              </button>
              <button
                v-else
                disabled
                class="ml-3 px-3 py-1.5 rounded-control border text-xs whitespace-nowrap bg-surface-raised border-line text-fg-faint cursor-not-allowed"
              >
                已完成
              </button>
            </div>
          </div>
        </div>

        <!-- 宝库兑换区 -->
        <div class="bg-surface-raised border border-line-subtle rounded-panel p-4">
          <div class="flex justify-between items-center mb-3">
            <h4 class="text-sm font-bold text-fg-secondary flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yellow-500">
                <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>
                <path d="M3 6h18"/>
                <path d="M16 10a4 4 0 0 1-8 0"/>
              </svg>
              宗门宝库
            </h4>
            <span class="text-xs text-fg-faint">当前贡献: <span class="text-gold-400 font-bold num" :title="String(mySect.contribution)">{{ formatCompact(mySect.contribution) }}</span></span>
          </div>

          <div v-if="treasury.length === 0" class="text-center text-fg-faint text-sm py-4">
            暂无宝库物品
          </div>

          <div v-else class="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div
              v-for="item in treasury"
              :key="item.id"
              class="bg-surface-canvas border border-line-subtle rounded-control p-3"
            >
              <div class="text-sm font-bold text-fg-secondary mb-1">{{ item.name }}</div>
              <p class="text-xs text-fg-faint mb-2 leading-relaxed">{{ item.description }}</p>
              <div class="flex justify-between items-center">
                <span class="text-xs text-gold-400 num">{{ item.cost }} 贡献</span>
                <button
                  @click="handleExchange(item)"
                  :disabled="operating || mySect.contribution < item.cost"
                  class="px-2.5 py-1 rounded-control bg-yellow-900/30 border border-yellow-700/50 text-yellow-400 hover:bg-yellow-800/50 hover:text-yellow-300 transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  兑换
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 确认弹窗（自定义 Modal 组件，替代浏览器原生 confirm） -->
    <Modal
      :isOpen="confirmModal.show"
      :title="confirmModal.type === 'join' ? '确认拜入' : confirmModal.type === 'leave' ? '确认叛出' : '确认兑换'"
      @close="closeConfirmModal"
      width="420px"
    >
      <div class="space-y-3" v-if="confirmModal.type === 'join' && confirmModal.payload">
        <p class="text-fg-secondary">
          确定要拜入
          <span class="font-bold text-gold-400">{{ (confirmModal.payload as Sect).name }}</span>
          吗？
        </p>
        <p class="text-xs text-fg-faint leading-relaxed">
          拜入后将消耗
          <span class="text-yellow-500">{{ (confirmModal.payload as Sect).join_requirement?.spirit_stones || 0 }}</span>
          灵石，且无法同时加入其他宗门。
        </p>
      </div>

      <div class="space-y-3" v-else-if="confirmModal.type === 'leave'">
        <div class="flex items-center gap-3 text-rose-400">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <p class="text-lg font-bold">叛出后贡献清零</p>
        </div>
        <p class="text-fg-secondary">确定要叛出当前宗门吗？</p>
        <p class="text-xs text-fg-faint leading-relaxed">
          叛出后宗门贡献度将全部清空，且需要重新消耗灵石才能拜入其他宗门。
        </p>
      </div>

      <div class="space-y-3" v-else-if="confirmModal.type === 'exchange' && confirmModal.payload">
        <p class="text-fg-secondary">
          确定要兑换
          <span class="font-bold text-gold-400">{{ (confirmModal.payload as TreasuryItem).name }}</span>
          吗？
        </p>
        <p class="text-xs text-fg-faint leading-relaxed">
          将消耗
          <span class="text-gold-400">{{ (confirmModal.payload as TreasuryItem).cost }}</span>
          贡献度，物品将存入储物袋。
        </p>
      </div>

      <template #footer>
        <AppButton variant="default" size="sm" @click="closeConfirmModal">取消</AppButton>
        <button
          @click="handleConfirm"
          :disabled="operating"
          class="px-4 py-2 rounded-control text-fg-primary transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :class="confirmModal.type === 'leave'
            ? 'bg-rose-600 hover:bg-rose-500'
            : 'bg-violet-600 hover:bg-violet-500'"
        >
          <span v-if="operating">处理中...</span>
          <span v-else>确认</span>
        </button>
      </template>
    </Modal>
  </PanelShell>
</template>
