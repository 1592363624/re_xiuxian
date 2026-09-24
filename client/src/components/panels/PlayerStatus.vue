<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { getStats as getSystemStats } from '../../api/system'
import { ROOT_TYPE_MAP, ROOT_NAME_MAP, POLL_INTERVALS } from '../../config'
import { formatDuration, formatNumber, formatCompact, calcExpProgress, formatExpProgress } from '../../utils/format'
import { useStatSchema } from '../../composables/useStatSchema'

const { sidebarStats, gridCell } = useStatSchema()

const props = defineProps({
  player: {
    type: Object,
    required: true
  },
  /** 所在区域名：来自 playerStore.worldState（/api/world/state 的 map_name），不在 /player/me 里 */
  mapName: {
    type: String,
    default: ''
  },
  /**
   * 世界状态是否已经同步回来。没同步时 mapName 必然为空，
   * 但这时候断言"未知区域"是错的 —— 玩家明明在彩霞山，
   * 首屏却先看到"未知区域"再跳成"彩霞山"，读起来像位置丢了。
   */
  synced: {
    type: Boolean,
    default: false
  }
})

// 侧栏两个入口点击后由 GameLayout 打开对应面板；admin 右键头像进 GM 后台
const emit = defineEmits(['action'])

/** 仅 admin 右键头像时拦截默认菜单并上报 gm；普通玩家放行浏览器菜单 */
const onAvatarContextMenu = (event) => {
  if (props.player?.role !== 'admin') return
  event.preventDefault()
  emit('action', 'gm')
}

// 境界修为进度：与数据统计 / 后端 exp_progress 同一份算法（calcExpProgress）。
// 优先读后端权威值，本地只在缺失时用 exp/exp_next 现算 —— 两边各写一套会
// 出现「左栏 0%、数据统计 0.01%」这种同屏自相矛盾。
const expProgress = computed(() => {
  const fromServer = props.player.exp_progress
  if (fromServer !== undefined && fromServer !== null && fromServer !== '') {
    const n = Number(fromServer)
    if (Number.isFinite(n)) return n
  }
  return calcExpProgress(props.player.exp, props.player.exp_next || props.player.exp_cap)
})

const expPercentage = computed(() => formatExpProgress(expProgress.value))

// 进度条宽度：>0 时给最小可见宽度，避免 0.02% 的条完全看不见
const expBarWidth = computed(() => {
  const p = expProgress.value
  if (p <= 0) return '0%'
  return `${Math.min(100, Math.max(p, 0.5))}%`
})

// 寿元进度条宽度（剩余寿元 / 最大寿元）
// 修复：原来用 lifespan.current / lifespan.max（年龄/最大寿元），玩家 100 岁时显示 5% 看似快死
//      改用 lifespan.remaining / lifespan.max（剩余/最大），进度条直观反映"还能活多久"
const lifespanBarWidth = computed(() => {
  const life = props.player.lifespan
  if (!life?.max || life.max <= 0) return '0%'
  const remaining = life.remaining ?? 0
  return Math.min(Math.max((remaining / life.max) * 100, 0), 100) + '%'
})

// 寿元进度条颜色（根据 lifespan.status 动态切换）
// 后端 LifespanService.getLifespanStatus 返回 status：
//   - danger: remaining <= 0（已死亡或濒死）
//   - warning: remaining < max * 20%（剩余不足 20%，红色预警）
//   - normal: 其他情况（健康）
const lifespanBarClass = computed(() => {
  const status = props.player.lifespan?.status
  if (status === 'danger') return 'bg-rose-700 animate-pulse'
  if (status === 'warning') return 'bg-amber-600'
  return 'bg-cyan-600'
})

// 寿元数值颜色（与进度条颜色呼应，便于玩家快速识别寿元状态）
const lifespanColorClass = computed(() => {
  const status = props.player.lifespan?.status
  if (status === 'danger') return 'text-rose-400 font-bold'
  if (status === 'warning') return 'text-amber-400 font-bold'
  return 'text-fg-primary'
})

// 格式化年龄/寿元数值（最多 1 位小数，整数不补 .0）
// 修仙游戏中"年"是粗粒度单位，1 位小数足够（如 102.6 年）。
// 原来一律 toFixed(1)，于是"1999.0 / 2000.0"这种整数值也带着 .0，
// 和左边"年龄 1.0"挤在同一行时读起来像一串连续数字（1.01999.0 / 2000.0）。
// 超过 1 万年后改用万/亿单位，否则窄侧栏放不下 6 位以上的数字
function formatAge(value) {
  if (value === null || value === undefined) return '0'
  const num = Number(value)
  if (isNaN(num)) return '0'
  if (Math.abs(num) >= 10000) return formatCompact(num)
  return Number.isInteger(num) ? String(num) : num.toFixed(1)
}

// 头像：后端 /player/me 下发绑定 QQ 的头像，未绑定时为空
// 换绑/解绑后要重置加载失败标记，否则新头像会被上一次的失败状态一直挡掉
const avatarUrl = computed(() => props.player.avatar_url || '')
const avatarLoadFailed = ref(false)
watch(avatarUrl, () => { avatarLoadFailed.value = false })

const isExpChanged = ref(false)

watch(() => props.player.exp, (newVal, oldVal) => {
  if (newVal !== oldVal) {
    isExpChanged.value = true
    setTimeout(() => {
      isExpChanged.value = false
    }, 500)
  }
})

// 在线人数统计
const onlineCount = ref(0)
const totalCount = ref(0)
const displayedCount = ref(0)
const statsLoading = ref(false)
const statsError = ref(false)
const isCountChanged = ref(false)
let statsInterval = null

// 数字滚动动画
const animateCount = (target) => {
  const start = displayedCount.value
  const diff = target - start
  if (diff === 0) return

  isCountChanged.value = true
  setTimeout(() => isCountChanged.value = false, 300)

  const duration = 1000
  const startTime = performance.now()

  const step = (currentTime) => {
    const elapsed = currentTime - startTime
    const progress = Math.min(elapsed / duration, 1)
    // easeOutQuart
    const ease = 1 - Math.pow(1 - progress, 4)

    displayedCount.value = Math.round(start + diff * ease)

    if (progress < 1) requestAnimationFrame(step)
  }

  requestAnimationFrame(step)
}

const fetchStats = async (isInitial = false) => {
  if (isInitial) statsLoading.value = true

  try {
    const res = await getSystemStats()
    const body = res.data || res
    if (body && body.data) {
      statsError.value = false
      totalCount.value = body.data.total ?? 0

      if (body.data.online !== onlineCount.value) {
        onlineCount.value = body.data.online ?? 0
        animateCount(onlineCount.value)
      }
    }
  } catch (error) {
    console.error('Fetch stats failed:', error)
    statsError.value = true
    onlineCount.value = 0
  } finally {
    if (isInitial) statsLoading.value = false
  }
}

// 灵根：服务端已按 role_init.spirit_roots 归一成 { type, name }，前端只负责配色。
// 映射表从配置读，避免硬编码；服务端认得但表里没有的灵根，退回显示它的中文名。
const currentRoot = computed(() => {
  const root = props.player.spirit_roots
  const type = root?.type
  const name = root?.name
  if (!type && !name) return null
  const mapped = (type && ROOT_TYPE_MAP[type]) || (name && ROOT_NAME_MAP[name])
  if (mapped) return mapped
  const display = name || type
  return display ? { name: `${display}灵根`, class: 'text-fg-muted' } : null
})

/**
 * 属性网格：一格三种表示
 *   shown  格子里显示的短格式（formatCompact，万/亿）
 *   exact  hover 出来的精确值
 *   cls    丹毒/灵石要跳出中性色，它们是玩家会盯的资源
 *
 * 属性格不再写死：显示哪些属性、叫什么、带不带 % 全部来自服务端属性注册表
 * （panel.spot === 'sidebar'）。资料片加一个"剑意"就自动多一格，前端不用改。
 * 丹毒/灵石是玩家资源不是属性，不归注册表管，留在本地。
 */
const RESOURCE_CELLS = (player) => ([
  {
    key: 'toxicity',
    label: '丹毒',
    cls: 'text-rose-500',
    shown: formatCompact(player.toxicity || 0),
    exact: String(player.toxicity || 0)
  },
  {
    key: 'spirit_stones',
    label: '灵石',
    cls: 'text-gold-500',
    shown: formatCompact(player.spirit_stones || 0),
    exact: formatNumber(player.spirit_stones || 0)
  }
])

const attributeGrid = computed(() => {
  const a = props.player.attributes || {}
  return [
    ...sidebarStats.value.map(entry => gridCell(entry, a[entry.key])),
    ...RESOURCE_CELLS(props.player)
  ]
})

onMounted(() => {
  fetchStats(true)
  statsInterval = setInterval(() => fetchStats(false), POLL_INTERVALS.stats)
})

onUnmounted(() => {
  if (statsInterval) clearInterval(statsInterval)
})
</script>

<template>
  <div class="h-full flex flex-col p-4 overflow-y-auto scroll-thin select-none min-w-0">
    <!-- 顶部角色信息 -->
    <div class="flex flex-col mb-6 pt-2 px-2">
       <div class="flex items-center justify-between w-full mb-3">
         <!-- 头像 (左侧)：绑定 QQ 后显示 QQ 头像，未绑定或图片加载失败时回退默认图标；
              admin 右键头像进入 GM 后台（无可见按钮） -->
         <div
           class="w-16 h-16 rounded-lg border-2 border-emerald-500/50 flex items-center justify-center bg-surface-canvas shadow-[0_0_15px_rgba(16,185,129,0.2)] shrink-0 overflow-hidden relative group"
           :class="{ 'cursor-pointer': player?.role === 'admin' }"
           :title="player?.role === 'admin' ? '右键打开 GM 后台' : undefined"
           @contextmenu="onAvatarContextMenu"
         >
           <img
             v-if="avatarUrl && !avatarLoadFailed"
             :src="avatarUrl"
             :alt="`${player.nickname || '修仙者'}的头像`"
             class="w-full h-full object-cover"
             @error="avatarLoadFailed = true"
           >
           <svg v-else xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-500 group-hover:scale-110 transition-transform"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
         </div>

         <!-- 名字与UID (右侧) -->
         <div class="flex flex-col items-end flex-1 ml-4 min-w-0">
            <h2 class="text-2xl font-bold text-emerald-400 tracking-wider drop-shadow-[0_0_8px_rgba(52,211,153,0.5)] mb-1 truncate max-w-full">{{ player.nickname || '加载中...' }}</h2>
            <span class="text-xs text-fg-faint num tracking-wide flex items-center gap-1">
              <span class="text-fg-faint/70 not-italic">UID</span>
              <span class="text-fg-muted">{{ player.id || player.username || '—' }}</span>
            </span>
          </div>
       </div>

       <!-- 境界 -->
       <div class="flex items-center justify-between w-full border-t border-line-subtle pt-3 gap-2">
          <div class="flex items-center gap-2 text-fg-faint text-sm shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-purple-500/70"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
            <span class="font-display tracking-widest text-fg-muted">境界</span>
          </div>
          <div class="px-3 py-1 rounded-full bg-purple-900/20 border border-purple-500/30 text-purple-300 text-sm font-bold tracking-wider truncate max-w-[60%]">
            {{ player.realm || '凡人' }}
          </div>
       </div>

       <!-- 位置 -->
       <div class="flex items-center justify-between w-full border-t border-line-subtle pt-3 mt-2 gap-2">
          <div class="flex items-center gap-2 text-fg-faint text-sm shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-500/70"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
            <span class="font-display tracking-widest text-fg-muted">位置</span>
          </div>
          <div class="text-emerald-400 text-sm font-bold tracking-wider truncate max-w-[60%]"
               :class="!mapName && !synced ? 'text-fg-faint font-normal' : ''">
            {{ mapName || (synced ? '未知区域' : '定位中…') }}
          </div>
       </div>
    </div>

    <!-- 状态条 -->
    <div class="space-y-4 mb-6 px-1">
      <!-- 气血 (HP) -->
      <div>
        <div class="flex justify-between text-xs text-fg-muted mb-1">
          <span>气血</span>
          <span class="num whitespace-nowrap" :title="`${player.hp_current || 0} / ${player.hp_max || 0}`">{{ formatCompact(player.hp_current || 0) }} / {{ formatCompact(player.hp_max || 0) }}</span>
        </div>
        <div class="h-2 w-full bg-surface-sunken rounded-sm overflow-hidden border border-line-subtle relative">
          <div class="h-full bg-rose-700 progress-flow transition-all duration-300" :style="{ width: player.hp_max ? Math.min((player.hp_current / player.hp_max) * 100, 100) + '%' : '0%' }"></div>
        </div>
      </div>

      <!-- 灵力 (MP) -->
      <div>
        <div class="flex justify-between text-xs text-fg-muted mb-1">
          <span>灵力</span>
          <span class="num whitespace-nowrap" :title="`${player.mp_current || 0} / ${player.mp_max || 0}`">{{ formatCompact(player.mp_current || 0) }} / {{ formatCompact(player.mp_max || 0) }}</span>
        </div>
        <div class="h-2 w-full bg-surface-sunken rounded-sm overflow-hidden border border-line-subtle relative">
          <div class="h-full bg-sky-600 progress-flow transition-all duration-300" :style="{ width: player.mp_max ? Math.min((player.mp_current / player.mp_max) * 100, 100) + '%' : '0%' }"></div>
        </div>
      </div>

      <!-- 修为 (Exp) -->
      <div>
        <div class="flex justify-between text-[10px] text-fg-muted mb-0.5">
          <span>修为</span>
          <!-- 大数走万/亿单位，hover 看精确值（全站数字展示约定） -->
          <span class="num whitespace-nowrap" :title="`${formatNumber(player.exp || 0)} / ${formatNumber(player.exp_next || player.exp_cap || 0)}（${expPercentage}）`">{{ formatCompact(player.exp || 0) }} / {{ formatCompact(player.exp_next || player.exp_cap || 0) }}</span>
        </div>
        <div class="h-1.5 w-full bg-surface-sunken rounded-sm overflow-hidden border border-line-subtle relative">
          <div class="h-full bg-emerald-600 progress-flow transition-all duration-300"
               :class="{ 'brightness-150': isExpChanged }"
               :style="{ width: expBarWidth }"></div>
        </div>
      </div>

      <!-- 寿元（剩余/最大） -->
      <!-- 注意：player.lifespan.current 是"已活年数"，remaining 才是"剩余寿元"。
           进度条按剩余比例渲染，颜色随 status（normal/warning/danger）变化，
           右侧另标"年龄 X 年"，避免玩家把 5% 读成快死了。 -->
      <div>
        <div class="flex justify-between text-[10px] text-fg-muted mb-0.5"
             title="寿元条显示的是「剩余 / 最大」，不是已活年数">
          <span>寿元</span>
          <span class="num">
            <span class="text-fg-faint mr-2">年龄 {{ formatAge(player.lifespan?.current) }} 岁</span>
            <span :class="lifespanColorClass">余 {{ formatAge(player.lifespan?.remaining) }} / {{ formatAge(player.lifespan?.max) }} 年</span>
          </span>
        </div>
        <div class="h-1.5 w-full bg-surface-sunken rounded-sm overflow-hidden border border-line-subtle relative">
          <div class="h-full progress-flow transition-all duration-300"
               :class="lifespanBarClass"
               :style="{ width: lifespanBarWidth }"></div>
        </div>
      </div>
    </div>

    <!-- 修行入口 -->
    <!-- 原先这两行写死了「本心诀 / 未装备」，既不是玩家真实数据也点不动，
         看着像状态栏其实是两个假按钮。改成明确的面板入口。 -->
    <div class="space-y-2 mb-6">
      <button
        type="button"
        @click="emit('action', 'technique')"
        class="focus-ring w-full group flex items-center gap-3 bg-surface-raised border border-line-subtle p-3 rounded-lg text-left hover:border-line-strong transition-colors"
      >
        <span class="w-9 h-9 shrink-0 flex items-center justify-center bg-surface-hover rounded text-cyan-500 group-hover:text-cyan-400">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        </span>
        <span class="flex flex-col min-w-0">
          <span class="text-[11px] text-fg-faint">功法</span>
          <span class="text-sm text-fg-secondary font-medium group-hover:text-gold-500 transition-colors truncate">修炼与装备功法</span>
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ms-auto shrink-0 text-fg-faint group-hover:text-gold-500 transition-colors"><path d="m9 18 6-6-6-6"/></svg>
      </button>

      <button
        type="button"
        @click="emit('action', 'treasure')"
        class="focus-ring w-full group flex items-center gap-3 bg-surface-raised border border-line-subtle p-3 rounded-lg text-left hover:border-line-strong transition-colors"
      >
        <span class="w-9 h-9 shrink-0 flex items-center justify-center bg-surface-hover rounded text-rose-500 group-hover:text-rose-400">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/></svg>
        </span>
        <span class="flex flex-col min-w-0">
          <span class="text-[11px] text-fg-faint">法宝</span>
          <span class="text-sm text-fg-secondary font-medium group-hover:text-gold-500 transition-colors truncate">祭炼与本命法器</span>
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ms-auto shrink-0 text-fg-faint group-hover:text-gold-500 transition-colors"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    </div>

    <!-- 属性网格 -->
    <!-- 侧栏固定 w-72，三列每格约 80px：数值统一走 formatCompact，
         并把格子的水平内边距收到 px-1、字号定在 text-base，
         这两个尺寸是量出来的，保证最坏的 "1.234万" 也不会顶出边框，别改回去。
         格数由服务端属性注册表决定（panel.spot=sidebar），资料片加属性会多出一格、自动换行 -->
    <div class="grid grid-cols-3 gap-2 mb-6">
      <div
        v-for="stat in attributeGrid"
        :key="stat.key"
        class="bg-surface-raised px-1 py-3 rounded-lg border border-line-subtle flex flex-col justify-center items-center min-w-0 hover:bg-surface-hover transition-colors"
      >
        <span class="text-xs text-fg-faint mb-1.5">{{ stat.label }}</span>
        <span class="font-bold num text-base leading-none whitespace-nowrap" :class="stat.cls" :title="stat.exact">{{ stat.shown }}</span>
      </div>
    </div>

    <!-- 灵根资质 -->
    <div>
      <h3 class="text-sm text-fg-muted font-bold mb-3 flex items-center gap-2 font-display">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
        灵根资质
      </h3>
      <div v-if="currentRoot" class="flex justify-between items-center bg-surface-raised p-4 rounded-lg border border-line-subtle">
        <span class="text-base font-bold" :class="currentRoot.class">{{ currentRoot.name }}</span>
        <span class="text-xs text-fg-faint">属性克制生效中</span>
      </div>
      <div v-else class="bg-surface-raised p-4 rounded-lg border border-line-subtle text-center text-fg-faint text-sm">
        暂无灵根数据
      </div>
    </div>

    <!-- 天道凶名 -->
    <div v-if="player && player.notorious_title">
      <h3 class="text-sm text-fg-muted font-bold mb-2 flex items-center gap-2 font-display">天道凶名</h3>
      <div class="bg-surface-raised p-3 rounded-lg border border-red-900/50 flex justify-between items-center">
        <span class="text-base font-bold text-red-300">【{{ player.notorious_title.name }}】</span>
        <span class="text-xs text-red-200/80">战力 +{{ Math.round((player.notorious_title.power_bonus || 0) * 100) }}%</span>
      </div>
    </div>

    <!-- 在线人数统计：沉到侧栏最底部，与 slogan 一起收尾，不再夹在灵根和空白之间 -->
    <div class="mt-auto pt-4 border-t border-line-subtle">
      <div class="bg-surface-raised rounded-lg p-3 border border-line-subtle relative overflow-hidden group">
        <!-- 背景装饰 -->
        <div class="absolute -right-4 -top-4 w-16 h-16 bg-emerald-500/5 rounded-full blur-xl group-hover:bg-emerald-500/10 transition-colors duration-500"></div>

        <div class="flex items-center justify-between mb-2">
          <span class="text-xs text-fg-muted font-bold tracking-wider">当前在线</span>
          <div class="flex items-center gap-1.5">
             <div class="w-1.5 h-1.5 rounded-full animate-pulse" :class="statsError ? 'bg-rose-500' : (statsLoading && !onlineCount ? 'bg-fg-faint' : 'bg-emerald-500')"></div>
             <span class="text-[10px] uppercase num" :class="statsError ? 'text-rose-500' : 'text-fg-faint'">
               {{ statsError ? 'offline' : 'live' }}
             </span>
          </div>
        </div>

        <div class="flex items-end justify-between">
           <!-- 加载状态 -->
           <div v-if="statsLoading && !onlineCount && !statsError" class="h-8 flex items-center gap-1 text-fg-faint">
             <span class="animate-bounce">.</span>
             <span class="animate-bounce delay-100">.</span>
             <span class="animate-bounce delay-200">.</span>
           </div>

           <!-- 错误状态 -->
           <div v-else-if="statsError" class="text-xs text-rose-500/80">
             连接断开，正在重连…
           </div>

           <!-- 正常数值 -->
           <div v-else class="flex items-baseline gap-1">
             <span
               class="text-2xl num font-bold text-fg-primary transition-all duration-300"
               :class="{ 'scale-110 text-emerald-400': isCountChanged }"
             >
               {{ displayedCount }}
             </span>
             <span class="text-xs text-fg-faint">位道友</span>
           </div>

           <div class="flex flex-col items-end num">
             <div class="text-[10px] text-fg-faint">总注册 {{ totalCount }}</div>
             <div class="text-[10px] text-fg-faint mt-0.5">在线 {{ formatDuration(player.total_online_time) }}</div>
           </div>
        </div>
      </div>
    </div>

    <div class="pt-3 pb-1 text-xs text-fg-faint text-center font-display">
      道法自然，乐在其中
    </div>
  </div>
</template>
