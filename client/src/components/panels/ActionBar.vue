<template>
  <aside
    class="shrink-0 flex flex-col bg-[#0c0a09] border-t border-stone-800 md:border-t-0 md:border-l select-none z-20 transition-[width] duration-200"
    :class="railExpanded ? 'md:w-[152px]' : 'md:w-[58px]'"
  >
    <!-- 标签显隐开关：仅桌面端，用于在"省空间"与"易辨认"之间切换 -->
    <div class="hidden md:flex items-center justify-end px-1 py-1.5 border-b border-stone-800/60">
      <button
        @click="toggleExpanded"
        class="p-1 rounded text-stone-600 hover:text-amber-500 hover:bg-[#1c1917] transition-colors"
        :title="railExpanded ? '收起标签' : '展开标签'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path v-if="railExpanded" d="m9 18 6-6-6-6" />
          <path v-else d="m15 18-6-6 6-6" />
        </svg>
      </button>
    </div>

    <!-- rail 主体：桌面纵向滚动，移动端横向滚动条 -->
    <div ref="scrollRef" class="rail-scroll flex flex-row gap-2 p-2 md:flex-col md:gap-0 md:p-1 md:overflow-y-auto overflow-x-auto">
      <!-- contents 让分组容器在移动端不产生布局盒，按钮直接流入横向滚动条 -->
      <div v-for="group in actionGroups" :key="group.key" class="contents md:flex md:flex-col md:gap-1">
        <div class="hidden md:block mt-2.5 mb-1 text-[10px] text-stone-600 text-center tracking-[0.25em] font-serif">
          {{ group.label }}
        </div>

        <div v-for="action in group.items" :key="action.id" class="relative shrink-0">
          <button
            @click="handleAction(action.id)"
            @mouseenter="showTip(action, $event)"
            @mouseleave="hideTip"
            class="group relative flex flex-col items-center justify-center gap-0.5 w-16 h-14 md:w-full md:h-[42px] md:gap-0 rounded-lg bg-[#1c1917] border border-stone-800 transition-all duration-200
                   hover:border-stone-600 hover:bg-[#292524] active:scale-95"
            :class="{
              'md:flex-row md:gap-2': railExpanded,
              'animate-shake ring-1 ring-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.4)]': action.id === 'cultivate' && isBreakthroughReady
            }"
          >
            <span
              class="shrink-0 transition-transform duration-200 group-hover:scale-110 flex items-center justify-center"
              :class="{ 'animate-pulse drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]': action.id === 'cultivate' && isBreakthroughReady }"
              v-html="action.icon"
            ></span>
            <!-- 移动端始终带标签；桌面端折叠态隐藏，标签改由悬浮提示承载 -->
            <span
              class="text-stone-300 group-hover:text-amber-500 transition-colors font-bold tracking-wider truncate max-w-full text-[10px] md:text-[11px]"
              :class="{ 'md:hidden': !railExpanded }"
            >{{ action.name }}</span>

            <!-- 闭关冷却倒计时 -->
            <span
              v-if="action.id === 'cultivate' && remainingCooldown > 0"
              class="absolute inset-0 flex items-center justify-center bg-black/70 rounded-lg z-10 cursor-not-allowed font-mono text-amber-500 text-xs"
              @click.stop
            >{{ formatCooldown(remainingCooldown) }}</span>

            <span class="absolute inset-0 rounded-lg bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></span>
          </button>
        </div>
      </div>
    </div>

    <!--
      悬浮提示用 fixed 定位挂在滚动容器之外：rail 需要 overflow-y-auto，
      而容器内的 absolute 提示会被 overflow 裁掉，故取按钮 rect 手动定位。
    -->
    <div
      v-if="tip"
      class="fixed z-[70] pointer-events-none hidden md:flex flex-col gap-0.5 px-2.5 py-1.5 rounded-md bg-[#1c1917] border border-stone-700 shadow-2xl max-w-[220px]"
      :style="{ left: tip.x + 'px', top: tip.y + 'px', transform: 'translate(-100%, -50%)' }"
    >
      <span class="text-xs font-bold text-amber-500 tracking-wider">{{ tip.name }}</span>
      <span v-if="tip.desc" class="text-[10px] text-stone-400 leading-snug">{{ tip.desc }}</span>
    </div>
  </aside>
</template>

<script setup>
/**
 * 右侧操作栏（rail）
 *
 * 设计原则：后端计算，前端只渲染
 *   - 突破就绪状态：直接读取后端 player.can_breakthrough，不再前端比较 exp >= exp_next
 *   - 闭关冷却剩余：读取后端 normal_cooldown_remaining + server_time 做本地 tick 递减
 *   - 不再硬编码冷却时长 3600 秒
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/player'

const props = defineProps({
  player: {
    type: Object,
    default: () => ({})
  }
})

const store = usePlayerStore()
const now = ref(Date.now())
let timer = null

/**
 * 拉取闭关状态，触发 store 更新（store 变更后 computed 自动响应）
 */
const fetchSeclusionCooldown = async () => {
  try {
    await store.fetchSeclusionStatus()
  } catch (err) {
    console.error('获取闭关冷却状态失败:', err)
  }
}

// 计算剩余冷却时间 (秒) - 直接读取 store，响应式更新
// 设计说明：直接从 store.systemConfig.seclusion 读取后端权威值，
// 当 socket 推送触发 store.fetchSeclusionStatus() 时，computed 自动重算，无需手动同步
const remainingCooldown = computed(() => {
  const secData = store.systemConfig?.seclusion
  if (!secData) return 0
  const backendRemaining = secData.normal_cooldown_remaining ?? 0
  if (backendRemaining <= 0) return 0
  // 基于服务端时间戳计算本地流逝时间，避免时钟漂移
  const serverTime = secData.server_time || Date.now()
  const localElapsedSec = Math.floor((now.value - serverTime) / 1000)
  return Math.max(0, backendRemaining - localElapsedSec)
})

// 格式化冷却时间 (MM:SS)
const formatCooldown = (seconds) => {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h${m}m`
  }
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

onMounted(() => {
  fetchSeclusionCooldown()
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// 判断是否可以突破 - 直接读取后端权威计算的 can_breakthrough 字段
// 避免前端用 exp >= exp_next 比较大整数（BigInt 字符串）导致精度问题
const isBreakthroughReady = computed(() => {
  return !!(props.player && props.player.can_breakthrough)
})

/* ============================================================
 * 按钮清单
 * 图标统一 28x28，折叠态下按钮 42px 高，图标居中即可
 * ============================================================ */
const svg = (cls, paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="${cls}">${paths}</svg>`

const ACTIONS = {
  cultivate: { name: '修炼', desc: '闭关修炼 突破境界', icon: svg('text-cyan-400', '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>') },
  meditation: { name: '悟道', desc: '静思悟道 破除瓶颈', icon: svg('text-amber-400', '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>') },
  dayan: { name: '大衍诀', desc: '大衍诀修炼 神识飞升前置', icon: svg('text-indigo-300', '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="11"/><path d="M12 1v3"/><path d="M12 20v3"/>') },

  explore: { name: '历练', desc: '历练探索 随机事件', icon: svg('text-emerald-400', '<path d="M12 2 2.5 9.5l1 10.5L12 22l8.5-2L22 10l-10-7.5z"/><path d="M12 12 12 22"/><path d="M12 12 22 12"/>') },
  dungeon: { name: '副本', desc: '秘境副本 三星扫荡', icon: svg('text-amber-400', '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/><path d="M9 11h6"/>') },
  multi_dungeon: { name: '多人', desc: '多人副本 掩月抢亲 端午镇蛟', icon: svg('text-amber-300', '<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/>') },
  beast_abyss: { name: '探渊', desc: '灵兽探渊 异步多人 PVE+PVP', icon: svg('text-teal-400', '<path d="M12 2a4 4 0 0 0-4 4v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/><path d="M12 10v8"/><path d="M9 14h6"/><path d="M3 12a9 9 0 0 1 18 0"/>') },

  arena: { name: '斗法', desc: '挑战同修 争夺段位', icon: svg('text-red-400', '<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/>') },
  fengshen: { name: '封神', desc: '封神台 镜像排名战', icon: svg('text-purple-400', '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>') },
  divine_sense_duel: { name: '神识对决', desc: '神识对决 1v1 博弈 PvP', icon: svg('text-purple-300', '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/><path d="M12 3v2"/><path d="M12 19v2"/><circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.4"/>') },
  bounty: { name: '悬赏', desc: '悬赏追杀 缉拿目标', icon: svg('text-amber-400', '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>') },
  world_boss: { name: '讨伐', desc: '世界BOSS 全服讨伐', icon: svg('text-red-500', '<path d="M5 3v4l3 3"/><path d="M19 3v4l-3 3"/><path d="M3 5h4l3 3"/><path d="M21 5h-4l-3 3"/><path d="M12 12v9"/><path d="M8 17h8"/><circle cx="12" cy="9" r="3"/>') },
  sect_war: { name: '宗战', desc: '宗门战 领地争夺', icon: svg('text-amber-500', '<path d="M4 22V4l4-2 4 2 4-2 4 2v18"/><path d="M4 14h16"/><path d="M9 9h2"/><path d="M13 9h2"/><path d="M9 17h2"/><path d="M13 17h2"/>') },

  inventory: { name: '背包', desc: '查看物品 整理行囊', icon: svg('text-amber-400', '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>') },
  market: { name: '坊市', desc: '买卖物品 互通有无', icon: svg('text-rose-400', '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>') },
  cave: { name: '洞府', desc: '洞府经营 药园种植', icon: svg('text-stone-400', '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/><path d="M9 11h6"/>') },
  pawnshop: { name: '当铺', desc: '典当赎回 周转灵石', icon: svg('text-amber-400', '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>') },
  stock: { name: '股市', desc: '聚宝股市 买卖股票', icon: svg('text-cyan-400', '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>') },
  auction: { name: '拍卖', desc: '拍卖竞价 多人博弈', icon: svg('text-rose-400', '<circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94"/>') },
  crafting: { name: '炼制', desc: '炼丹炼器 学习配方', icon: svg('text-orange-400', '<path d="M12 2c0 0-4 4-4 8a4 4 0 0 0 8 0c0-4-4-8-4-8z"/><path d="M8 14a4 4 0 1 0 8 0"/><path d="M5 18h14"/><path d="M7 22h10"/>') },

  treasure: { name: '法宝', desc: '祭炼本命 法宝管理', icon: svg('text-indigo-400', '<path d="M12 2 4 7v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V7l-8-5z"/><path d="m9 12 2 2 4-4"/>') },
  artifact_spirit: { name: '器灵', desc: '法宝器灵 灵识养成', icon: svg('text-cyan-400', '<path d="M12 2v6"/><path d="M12 22v-6"/><path d="M4.93 4.93l4.24 4.24"/><path d="M14.83 14.83l4.24 4.24"/><path d="M2 12h6"/><path d="M22 12h-6"/><path d="M4.93 19.07l4.24-4.24"/><path d="M14.83 9.17l4.24-4.24"/>') },
  formation: { name: '阵法', desc: '阵法堂 布阵加持', icon: svg('text-purple-400', '<circle cx="12" cy="12" r="10"/><path d="M12 2v20"/><path d="M2 12h20"/><circle cx="12" cy="12" r="4"/>') },
  puppet: { name: '傀儡', desc: '傀儡工坊 制造出战护法', icon: svg('text-amber-400', '<circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/>') },
  spirit_beast: { name: '灵兽', desc: '灵兽图鉴 捕获培养', icon: svg('text-emerald-300', '<path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-2.97 7 .41 1.04 1 2.02 1.56 2.85 2.53 3.8-1.41 6.35-4.5 4.73l-3.23-1.68a19 19 0 0 0-2.57 0l-3.23 1.68c-3.09 1.62-7.03-.93-4.5-4.73.56-.83 1.15-1.81 1.56-2.85-2.55 0-4.37-6.42-2.97-7C4.62 2.25 7.87 3.09 9.65 5.09 10.3 4.92 11.33 5 12 5z"/>') },

  nascent_soul: { name: '元婴', desc: '元婴出窍 高阶境界', icon: svg('text-purple-400', '<path d="M12 2a3 3 0 0 0-3 3c0 1.6.8 3 2 4-1.2 1-2 2.4-2 4a3 3 0 0 0 6 0c0-1.6-.8-3-2-4 1.2-1 2-2.4 2-4a3 3 0 0 0-3-3z"/><path d="M5 22h14"/><path d="M12 16v6"/>') },
  second_soul: { name: '元神', desc: '第二元神 元神出窍', icon: svg('text-indigo-300', '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18"/><path d="M3 12h18"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>') },
  small_world: { name: '小世界', desc: '开辟小世界 香火神庙', icon: svg('text-cyan-300', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a9 9 0 0 1 0 18"/><path d="M12 3a9 9 0 0 0 0 18"/><path d="M7 8h10"/><path d="M7 16h10"/>') },
  ascension: { name: '飞升', desc: '飞升灵界 夺舍重生', icon: svg('text-amber-300', '<path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/>') },

  sect: { name: '宗门', desc: '宗门任务 兑换贡献', icon: svg('text-violet-400', '<path d="M3 21h18"/><path d="M5 21V7l8-4 8 4v14"/><path d="M17 21v-8H7v8"/>') },
  taoism_gate: { name: '太一门', desc: '太一门引道 五行道途 共鸣', icon: svg('text-indigo-300', '<path d="M12 2 4 7v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V7l-8-5z"/><path d="M12 8a4 4 0 0 1 4 4"/><path d="M12 16a4 4 0 0 1-4-4"/><path d="M12 2v20"/><path d="M4 12h16"/>') },

  companion: { name: '道侣', desc: '道侣面板 心契心劫', icon: svg('text-rose-300', '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>') },
  dao_companion: { name: '双修', desc: '玩家间 1v1 长期社交 求婚双修', icon: svg('text-rose-400', '<path d="M12 21s-7.5-4.9-9.5-9.2A5.3 5.3 0 0 1 12 6.3a5.3 5.3 0 0 1 9.5 5.5C19.5 16.1 12 21 12 21z"/><path d="M12 6.3v14.7"/>') },
  concubine: { name: '侍妾', desc: '红尘寻缘 远航归来', icon: svg('text-fuchsia-300', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>') },
  cave_social: { name: '社交', desc: '洞府社交 留言访客', icon: svg('text-emerald-400', '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>') },

  fishing: { name: '垂钓', desc: '灵溪垂钓 钓竿剖鱼排行', icon: svg('text-cyan-400', '<path d="M12 2v14"/><path d="M12 16a4 4 0 0 1-4-4"/><circle cx="12" cy="20" r="2"/><path d="M6 20q3 2 6 0t6 0"/>') },
  gambling_stone: { name: '赌石', desc: '赌石博彩 线索博弈 切石机缘', icon: svg('text-purple-400', '<path d="M12 2 4 7v10l8 5 8-5V7l-8-5z"/><path d="M12 22V12"/><path d="M4 7l8 5 8-5"/><path d="M9 9l3-2 3 2"/>') },
}

/**
 * 分组清单：新增功能时把 action id 追加到对应分组即可，
 * 未分组的 id 会被下方 missingActionIds 检出并告警，避免按钮静默丢失。
 */
const actionGroups = [
  { key: 'practice', label: '修行', ids: ['cultivate', 'meditation', 'dayan'] },
  { key: 'adventure', label: '历练', ids: ['explore', 'dungeon', 'multi_dungeon', 'beast_abyss'] },
  { key: 'battle', label: '征伐', ids: ['arena', 'fengshen', 'divine_sense_duel', 'bounty', 'world_boss', 'sect_war'] },
  { key: 'economy', label: '经营', ids: ['inventory', 'market', 'cave', 'pawnshop', 'stock', 'auction', 'crafting'] },
  { key: 'craft', label: '炼养', ids: ['treasure', 'artifact_spirit', 'formation', 'puppet', 'spirit_beast'] },
  { key: 'realm', label: '境界', ids: ['nascent_soul', 'second_soul', 'small_world', 'ascension'] },
  { key: 'sect', label: '宗门', ids: ['sect', 'taoism_gate'] },
  { key: 'worldly', label: '红尘', ids: ['companion', 'dao_companion', 'concubine', 'cave_social'] },
  { key: 'leisure', label: '闲趣', ids: ['fishing', 'gambling_stone'] },
].map(group => ({
  ...group,
  items: group.ids.map(id => ({ id, ...ACTIONS[id] }))
}))

const missingActionIds = computed(() => {
  const grouped = new Set(actionGroups.flatMap(g => g.items.map(i => i.id)))
  return Object.keys(ACTIONS).filter(id => !grouped.has(id))
})
if (missingActionIds.value.length) {
  console.warn('[ActionBar] 以下 action 已定义但未归入任何分组:', missingActionIds.value)
}

/* ============================================================
 * 折叠 / 悬浮提示
 * ============================================================ */
const railExpanded = ref(localStorage.getItem('actionRailExpanded') === '1')
const scrollRef = ref(null)
const tip = ref(null)

const toggleExpanded = () => {
  railExpanded.value = !railExpanded.value
  localStorage.setItem('actionRailExpanded', railExpanded.value ? '1' : '0')
  tip.value = null
}

const showTip = (action, event) => {
  if (railExpanded.value) return
  const rect = event.currentTarget.getBoundingClientRect()
  tip.value = {
    name: action.name,
    desc: action.desc,
    x: rect.left - 8,
    y: rect.top + rect.height / 2
  }
}

const hideTip = () => {
  tip.value = null
}

const emit = defineEmits(['action'])

const handleAction = (id) => {
  tip.value = null
  emit('action', id)
}
</script>

<style scoped>
.rail-scroll::-webkit-scrollbar {
  width: 3px;
  height: 3px;
}
.rail-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.rail-scroll::-webkit-scrollbar-thumb {
  background: #44403c;
  border-radius: 2px;
}
.rail-scroll::-webkit-scrollbar-thumb:hover {
  background: #57534e;
}
.rail-scroll {
  scrollbar-width: thin;
  scrollbar-color: #44403c transparent;
}
</style>
