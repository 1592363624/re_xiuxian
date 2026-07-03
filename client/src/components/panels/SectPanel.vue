<script setup lang="ts">
/**
 * 宗门系统面板组件
 *
 * 功能说明：
 *   - 全屏遮罩 + 居中弹窗布局，emits('close') 关闭面板
 *   - 顶部 Tab 切换：宗门列表 / 我的宗门（已加入宗门时默认显示"我的宗门"）
 *   - 宗门列表视图：展示 6 大宗门卡片，支持拜入（自定义 Modal 二次确认）
 *   - 我的宗门视图：宗门信息、每日点卯/传功（带冷却倒计时）、宗门任务、宝库兑换、叛出宗门
 *   - 所有业务逻辑通过 sect API 调用后端，前端只做展示与交互
 *   - 操作成功后刷新数据并同步玩家状态（修为/灵石变更影响其他 UI）
 *   - 禁用浏览器原生 alert/confirm，统一使用自定义 Modal 组件
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
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
  exchangeTreasury,
  type Sect,
  type MySect,
  type SectQuest,
  type TreasuryItem
} from '../../api/sect'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

// ====== 响应式状态 ======
const loading = ref(true)                 // 整体加载状态
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

// ====== 冷却时间常量（与后端 game_balance.sect 配置保持一致，仅用于前端倒计时展示） ======
const CHECKIN_COOLDOWN_HOURS = 24
const TRANSFER_COOLDOWN_HOURS = 24

// ====== 计算属性 ======

/**
 * 是否已加入宗门
 */
const hasJoined = computed(() => !!mySect.value)

/**
 * 点卯剩余冷却毫秒数（0 表示可点卯）
 */
const checkInRemainingMs = computed(() => {
  if (!mySect.value?.last_check_in) return 0
  const last = new Date(mySect.value.last_check_in).getTime()
  const next = last + CHECKIN_COOLDOWN_HOURS * 3600 * 1000
  const remain = next - currentTime.value
  return remain > 0 ? remain : 0
})

/**
 * 传功剩余冷却毫秒数（0 表示可传功）
 */
const transferRemainingMs = computed(() => {
  if (!mySect.value?.last_transfer) return 0
  const last = new Date(mySect.value.last_transfer).getTime()
  const next = last + TRANSFER_COOLDOWN_HOURS * 3600 * 1000
  const remain = next - currentTime.value
  return remain > 0 ? remain : 0
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
 */
const fetchAll = async () => {
  loading.value = true
  try {
    await Promise.all([fetchSectList(), fetchMySect()])
    // 已加入宗门则默认进入"我的宗门"视图
    if (mySect.value) {
      activeTab.value = 'my'
    }
  } catch (error) {
    console.error('加载宗门数据失败:', error)
    uiStore.showToast('加载宗门数据失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 获取所有宗门列表
 */
const fetchSectList = async () => {
  try {
    const res = await getSectList()
    // 后端返回 { code, data: { sects: [...] } }
    sects.value = res.data?.data?.sects || []
  } catch (error) {
    console.error('获取宗门列表失败:', error)
  }
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
      content: `你在宗门完成点卯，获得贡献 +${result.rewards?.contribution || 0}，修为 +${result.rewards?.exp || 0}。`,
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
      content: `你完成了宗门任务【${quest.name}】，获得贡献 +${result.rewards?.contribution || 0}，修为 +${result.rewards?.exp || 0}。`,
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
    return 'border-amber-700/50 hover:border-amber-500/80 hover:shadow-[0_0_15px_rgba(245,158,11,0.15)]'
  }
  return 'border-purple-700/50 hover:border-purple-500/80 hover:shadow-[0_0_15px_rgba(168,85,247,0.15)]'
}

/**
 * 获取阵营徽章样式
 * @param alignment - 阵营
 */
const getAlignmentBadgeClass = (alignment: string) => {
  if (alignment === '正道') {
    return 'bg-amber-900/30 text-amber-400 border-amber-700/50'
  }
  return 'bg-purple-900/30 text-purple-400 border-purple-700/50'
}

/**
 * 获取五行属性徽章样式
 * @param element - 五行属性
 */
const getElementBadgeClass = (element: string) => {
  const map: Record<string, string> = {
    '金': 'bg-yellow-900/30 text-yellow-400 border-yellow-700/50',
    '木': 'bg-emerald-900/30 text-emerald-400 border-emerald-700/50',
    '水': 'bg-blue-900/30 text-blue-400 border-blue-700/50',
    '火': 'bg-red-900/30 text-red-400 border-red-700/50',
    '土': 'bg-amber-900/30 text-amber-600 border-amber-800/50'
  }
  return map[element] || 'bg-stone-800 text-stone-400 border-stone-700'
}

/**
 * 获取身份中文名
 * @param role - 身份 key
 */
const getRoleName = (role: string) => {
  return role === 'elder' ? '长老' : '弟子'
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
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- 遮罩层：点击关闭面板 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>

    <!-- 主容器 -->
    <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-5xl h-[88vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
      <!-- 顶部标题栏 -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-violet-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 21h18"/>
            <path d="M5 21V7l8-4 8 4v14"/>
            <path d="M17 21v-8H7v8"/>
          </svg>
          宗门系统
        </h2>
        <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex items-center gap-1 p-3 border-b border-stone-800 bg-[#0c0a09]">
        <button
          @click="activeTab = 'list'"
          class="px-4 py-1.5 rounded text-sm whitespace-nowrap transition-colors"
          :class="activeTab === 'list'
            ? 'bg-violet-900/30 text-violet-400 border border-violet-700/50'
            : 'text-stone-500 hover:text-stone-300 border border-transparent'"
        >
          宗门列表
        </button>
        <button
          @click="activeTab = 'my'"
          class="px-4 py-1.5 rounded text-sm whitespace-nowrap transition-colors"
          :class="activeTab === 'my'
            ? 'bg-violet-900/30 text-violet-400 border border-violet-700/50'
            : 'text-stone-500 hover:text-stone-300 border border-transparent'"
        >
          我的宗门
          <span v-if="hasJoined" class="ml-1 text-xs text-emerald-400">●</span>
        </button>
      </div>

      <!-- 内容区域 -->
      <div class="flex-1 overflow-y-auto p-4">
        <!-- 加载中 -->
        <div v-if="loading" class="flex justify-center items-center h-64">
          <svg class="animate-spin h-10 w-10 text-violet-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>

        <!-- ====== 宗门列表视图 ====== -->
        <div v-else-if="activeTab === 'list'" class="space-y-4">
          <div v-if="sects.length === 0" class="flex flex-col items-center justify-center h-64 text-stone-500">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
              <path d="M3 21h18"/>
              <path d="M5 21V7l8-4 8 4v14"/>
            </svg>
            <p>暂无宗门信息</p>
          </div>

          <!-- 宗门卡片网格 -->
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div
              v-for="sect in sects"
              :key="sect.id"
              class="bg-[#1c1917] border rounded-lg p-4 transition-all duration-300"
              :class="getAlignmentCardClass(sect.alignment)"
            >
              <!-- 卡片头部：名称 + 阵营/五行徽章 -->
              <div class="flex justify-between items-start mb-3">
                <div>
                  <h3 class="text-lg font-bold flex items-center gap-2"
                      :class="sect.alignment === '正道' ? 'text-amber-400' : 'text-purple-400'">
                    {{ sect.name }}
                  </h3>
                  <div class="flex gap-1.5 mt-1.5">
                    <span class="text-xs px-2 py-0.5 rounded border"
                          :class="getAlignmentBadgeClass(sect.alignment)">
                      {{ sect.alignment }}
                    </span>
                    <span class="text-xs px-2 py-0.5 rounded border"
                          :class="getElementBadgeClass(sect.element)">
                      {{ sect.element }}行
                    </span>
                  </div>
                </div>
                <!-- 已加入标记 -->
                <div v-if="hasJoined && mySect?.sect_id === sect.id"
                     class="text-xs px-2 py-1 rounded bg-emerald-900/30 border border-emerald-700/50 text-emerald-400">
                  已拜入
                </div>
              </div>

              <!-- 宗门描述 -->
              <p class="text-xs text-stone-400 leading-relaxed mb-3">{{ sect.description }}</p>

              <!-- 加入要求 -->
              <div class="bg-[#0c0a09] rounded p-2 border border-stone-800 mb-3">
                <div class="text-xs text-stone-500 mb-1">拜入要求</div>
                <div class="flex justify-between text-xs">
                  <span class="text-stone-300">境界: <span class="text-amber-400">{{ sect.join_requirement?.realm_min || '无' }}</span></span>
                  <span class="text-stone-300">灵石: <span class="text-yellow-500">{{ sect.join_requirement?.spirit_stones || 0 }}</span></span>
                </div>
              </div>

              <!-- 操作按钮 -->
              <div class="flex justify-end">
                <button
                  v-if="!hasJoined"
                  @click="handleJoin(sect)"
                  :disabled="operating"
                  class="px-4 py-1.5 rounded bg-violet-900/30 border border-violet-700/50 text-violet-400 hover:bg-violet-800/50 hover:text-violet-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  拜入
                </button>
                <button
                  v-else-if="mySect?.sect_id === sect.id"
                  disabled
                  class="px-4 py-1.5 rounded bg-stone-900 border border-stone-700 text-stone-500 text-sm cursor-not-allowed"
                >
                  已加入
                </button>
                <span v-else class="text-xs text-stone-500">已加入其他宗门</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ====== 我的宗门视图 ====== -->
        <div v-else-if="activeTab === 'my'">
          <!-- 未加入宗门提示 -->
          <div v-if="!hasJoined" class="flex flex-col items-center justify-center h-64 text-stone-500">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50">
              <path d="M3 21h18"/>
              <path d="M5 21V7l8-4 8 4v14"/>
            </svg>
            <p class="mb-4">你尚未拜入任何宗门</p>
            <button
              @click="activeTab = 'list'"
              class="px-4 py-2 rounded bg-violet-900/30 border border-violet-700/50 text-violet-400 hover:bg-violet-800/50 transition-colors text-sm"
            >
              前往宗门列表
            </button>
          </div>

          <!-- 已加入宗门：展示完整信息 -->
          <div v-else class="space-y-4">
            <!-- 宗门信息卡片 -->
            <div class="bg-[#1c1917] border rounded-lg p-4"
                 :class="mySect.alignment === '正道' ? 'border-amber-700/50' : 'border-purple-700/50'">
              <div class="flex justify-between items-start mb-3">
                <div>
                  <h3 class="text-xl font-bold flex items-center gap-2"
                      :class="mySect.alignment === '正道' ? 'text-amber-400' : 'text-purple-400'">
                    {{ mySect.name }}
                    <span class="text-xs px-2 py-0.5 rounded border"
                          :class="getAlignmentBadgeClass(mySect.alignment)">
                      {{ mySect.alignment }}
                    </span>
                    <span class="text-xs px-2 py-0.5 rounded border"
                          :class="getElementBadgeClass(mySect.element)">
                      {{ mySect.element }}行
                    </span>
                  </h3>
                  <p class="text-xs text-stone-400 mt-1">{{ mySect.description }}</p>
                </div>
                <button
                  @click="handleLeave"
                  :disabled="operating"
                  class="px-3 py-1 rounded bg-rose-900/30 border border-rose-700/50 text-rose-400 hover:bg-rose-800/50 transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  叛出宗门
                </button>
              </div>

              <!-- 身份与贡献度统计 -->
              <div class="grid grid-cols-3 gap-3 mt-3">
                <div class="bg-[#0c0a09] rounded p-2 border border-stone-800 text-center">
                  <div class="text-xs text-stone-500 mb-1">身份</div>
                  <div class="text-sm font-bold text-violet-400">{{ getRoleName(mySect.role) }}</div>
                </div>
                <div class="bg-[#0c0a09] rounded p-2 border border-stone-800 text-center">
                  <div class="text-xs text-stone-500 mb-1">贡献度</div>
                  <div class="text-sm font-bold text-amber-400">{{ mySect.contribution }}</div>
                </div>
                <div class="bg-[#0c0a09] rounded p-2 border border-stone-800 text-center">
                  <div class="text-xs text-stone-500 mb-1">加入时间</div>
                  <div class="text-xs font-bold text-stone-300 mt-1">{{ formatDate(mySect.joined_at) }}</div>
                </div>
              </div>
            </div>

            <!-- 每日操作区：点卯 + 传功 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <!-- 点卯卡片 -->
              <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-4">
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-sm font-bold text-stone-200 flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-500">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    每日点卯
                  </h4>
                  <span v-if="mySect.last_check_in" class="text-xs text-stone-500">
                    上次: {{ formatDate(mySect.last_check_in) }}
                  </span>
                </div>
                <p class="text-xs text-stone-500 mb-3">每日拜见师长，领取贡献与修为奖励</p>
                <button
                  @click="handleCheckIn"
                  :disabled="!canCheckIn"
                  class="w-full py-2 rounded border transition-colors text-sm"
                  :class="canCheckIn
                    ? 'bg-amber-900/30 border-amber-700/50 text-amber-400 hover:bg-amber-800/50 hover:text-amber-300'
                    : 'bg-stone-900 border-stone-700 text-stone-500 cursor-not-allowed'"
                >
                  <span v-if="canCheckIn">点卯</span>
                  <span v-else>冷却中 {{ formatCountdown(checkInRemainingMs) }}</span>
                </button>
              </div>

              <!-- 传功卡片 -->
              <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-4">
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-sm font-bold text-stone-200 flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-500">
                      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM2 9h4v12H2z"/>
                    </svg>
                    宗门传功
                  </h4>
                  <span v-if="mySect.last_transfer" class="text-xs text-stone-500">
                    上次: {{ formatDate(mySect.last_transfer) }}
                  </span>
                </div>
                <p class="text-xs text-stone-500 mb-3">消耗灵石接受长辈传功，换取修为</p>
                <button
                  @click="handleTransfer"
                  :disabled="!canTransfer"
                  class="w-full py-2 rounded border transition-colors text-sm"
                  :class="canTransfer
                    ? 'bg-cyan-900/30 border-cyan-700/50 text-cyan-400 hover:bg-cyan-800/50 hover:text-cyan-300'
                    : 'bg-stone-900 border-stone-700 text-stone-500 cursor-not-allowed'"
                >
                  <span v-if="canTransfer">传功</span>
                  <span v-else>冷却中 {{ formatCountdown(transferRemainingMs) }}</span>
                </button>
              </div>
            </div>

            <!-- 宗门任务列表 -->
            <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-4">
              <h4 class="text-sm font-bold text-stone-200 mb-3 flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-500">
                  <path d="M9 11l3 3L22 4"/>
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                </svg>
                宗门任务
                <span class="text-xs text-stone-500 font-normal">（每日刷新）</span>
              </h4>

              <div v-if="quests.length === 0" class="text-center text-stone-500 text-sm py-4">
                暂无可用任务
              </div>

              <div v-else class="space-y-2">
                <div
                  v-for="quest in quests"
                  :key="quest.id"
                  class="bg-[#0c0a09] border border-stone-800 rounded p-3 flex justify-between items-center"
                  :class="{ 'opacity-60': quest.completed }"
                >
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-sm font-bold text-stone-200">{{ quest.name }}</span>
                      <span v-if="quest.daily" class="text-xs px-1.5 py-0.5 rounded bg-stone-800 text-stone-400">日常</span>
                      <span v-if="quest.completed" class="text-xs px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400 border border-emerald-700/50">已完成</span>
                    </div>
                    <p class="text-xs text-stone-500 mb-1">{{ quest.description }}</p>
                    <div class="text-xs flex gap-3">
                      <span class="text-amber-400">贡献 +{{ quest.contribution }}</span>
                      <span class="text-cyan-400">修为 +{{ quest.exp_reward }}</span>
                    </div>
                  </div>
                  <button
                    @click="handleSubmitQuest(quest)"
                    :disabled="quest.completed || operating"
                    class="ml-3 px-3 py-1.5 rounded border text-xs whitespace-nowrap transition-colors"
                    :class="quest.completed
                      ? 'bg-stone-900 border-stone-700 text-stone-600 cursor-not-allowed'
                      : 'bg-emerald-900/30 border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed'"
                  >
                    {{ quest.completed ? '已完成' : '提交' }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 宝库兑换区 -->
            <div class="bg-[#1c1917] border border-stone-800 rounded-lg p-4">
              <div class="flex justify-between items-center mb-3">
                <h4 class="text-sm font-bold text-stone-200 flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yellow-500">
                    <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>
                    <path d="M3 6h18"/>
                    <path d="M16 10a4 4 0 0 1-8 0"/>
                  </svg>
                  宗门宝库
                </h4>
                <span class="text-xs text-stone-500">当前贡献: <span class="text-amber-400 font-bold">{{ mySect.contribution }}</span></span>
              </div>

              <div v-if="treasury.length === 0" class="text-center text-stone-500 text-sm py-4">
                暂无宝库物品
              </div>

              <div v-else class="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div
                  v-for="item in treasury"
                  :key="item.id"
                  class="bg-[#0c0a09] border border-stone-800 rounded p-3"
                >
                  <div class="text-sm font-bold text-stone-200 mb-1">{{ item.name }}</div>
                  <p class="text-xs text-stone-500 mb-2 leading-relaxed">{{ item.description }}</p>
                  <div class="flex justify-between items-center">
                    <span class="text-xs text-amber-400">{{ item.cost }} 贡献</span>
                    <button
                      @click="handleExchange(item)"
                      :disabled="operating || mySect.contribution < item.cost"
                      class="px-2.5 py-1 rounded bg-yellow-900/30 border border-yellow-700/50 text-yellow-400 hover:bg-yellow-800/50 hover:text-yellow-300 transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      兑换
                    </button>
                  </div>
                </div>
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
        <p class="text-stone-300">
          确定要拜入
          <span class="font-bold text-amber-400">{{ (confirmModal.payload as Sect).name }}</span>
          吗？
        </p>
        <p class="text-xs text-stone-500 leading-relaxed">
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
        <p class="text-stone-300">确定要叛出当前宗门吗？</p>
        <p class="text-xs text-stone-500 leading-relaxed">
          叛出后宗门贡献度将全部清空，且需要重新消耗灵石才能拜入其他宗门。
        </p>
      </div>

      <div class="space-y-3" v-else-if="confirmModal.type === 'exchange' && confirmModal.payload">
        <p class="text-stone-300">
          确定要兑换
          <span class="font-bold text-amber-400">{{ (confirmModal.payload as TreasuryItem).name }}</span>
          吗？
        </p>
        <p class="text-xs text-stone-500 leading-relaxed">
          将消耗
          <span class="text-amber-400">{{ (confirmModal.payload as TreasuryItem).cost }}</span>
          贡献度，物品将存入储物袋。
        </p>
      </div>

      <template #footer>
        <button
          @click="closeConfirmModal"
          class="px-4 py-2 bg-stone-700 hover:bg-stone-600 text-stone-200 rounded transition-colors text-sm"
        >取消</button>
        <button
          @click="handleConfirm"
          :disabled="operating"
          class="px-4 py-2 rounded text-white transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :class="confirmModal.type === 'leave'
            ? 'bg-rose-600 hover:bg-rose-500'
            : 'bg-violet-600 hover:bg-violet-500'"
        >
          <span v-if="operating">处理中...</span>
          <span v-else>确认</span>
        </button>
      </template>
    </Modal>
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
</style>
