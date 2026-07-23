<template>
  <div class="shrink-0 flex flex-col p-4 bg-[#0c0a09] border-t border-stone-800 select-none z-20">
    <div class="grid grid-cols-3 md:grid-cols-7 lg:grid-cols-13 gap-4">
      <div 
        class="relative"
        @mouseenter="showCultivateMenu = true"
        @mouseleave="showCultivateMenu = false"
      >
        <button 
          @click="handleAction('cultivate')"
          class="group relative flex flex-col items-center justify-center p-2 rounded-lg bg-[#1c1917] border border-stone-800 transition-all duration-300
                 hover:border-stone-600 hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] hover:-translate-y-0.5 active:scale-95 active:shadow-inner w-full"
          :class="{
            'bg-gradient-to-r from-stone-900 to-[#1c1917]': true,
            'animate-shake ring-1 ring-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.4)]': isBreakthroughReady
          }"
        >
          <div 
             class="mb-1 transition-transform duration-300 group-hover:scale-110" 
             :class="{'animate-pulse drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]': isBreakthroughReady}"
             v-html="cultivateIcon"
          ></div>
          <span class="text-stone-300 font-bold tracking-widest text-sm group-hover:text-amber-500 transition-colors">修炼</span>
          
          <!-- 冷却倒计时 -->
          <div
            v-if="remainingCooldown > 0"
            class="absolute inset-0 flex items-center justify-center bg-black/60 rounded-lg z-10 pointer-events-auto cursor-not-allowed"
            @click.stop
          >
            <span class="text-amber-500 font-mono font-bold">{{ formatCooldown(remainingCooldown) }}</span>
          </div>

          <!-- 悬停光效 -->
          <div class="absolute inset-0 rounded-lg bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
        </button>
      </div>

      <button 
        v-for="action in refinedActions" 
        :key="action.id"
        @click="handleAction(action.id)"
        class="group relative flex flex-col items-center justify-center p-2 rounded-lg bg-[#1c1917] border border-stone-800 transition-all duration-300
               hover:border-stone-600 hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] hover:-translate-y-0.5 active:scale-95 active:shadow-inner"
      >
        <div 
           class="mb-1 transition-transform duration-300 group-hover:scale-110" 
           v-html="action.icon"
        ></div>
        <span class="text-stone-300 font-bold tracking-widest text-sm group-hover:text-amber-500 transition-colors">{{ action.name }}</span>

        <!-- 悬停光效 -->
        <div class="absolute inset-0 rounded-lg bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
      </button>
    </div>
  </div>
</template>

<script setup>
/**
 * 操作栏组件
 * 显示修炼、历练等操作按钮
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

// 修炼按钮图标
const cultivateIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-400"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`

// 其他操作按钮列表
const refinedActions = [
  {
    id: 'explore',
    name: '历练',
    // Emerald for adventure/explore
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400"><path d="M12 2 2.5 9.5l1 10.5L12 22l8.5-2L22 10l-10-7.5z"/><path d="M12 12 12 22"/><path d="M12 12 22 12"/></svg>`,
    desc: '历练探索 随机事件'
  },
  {
    id: 'inventory',
    name: '背包',
    // Amber for wealth/items
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
    desc: '查看物品 整理行囊'
  },
  {
    id: 'sect',
    name: '宗门',
    // Violet for mystery/sect
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-violet-400"><path d="M3 21h18"/><path d="M5 21V7l8-4 8 4v14"/><path d="M17 21v-8H7v8"/></svg>`,
    desc: '宗门任务 兑换贡献'
  },
  {
    id: 'market',
    name: '坊市',
    // Rose for trade/market
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-rose-400"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>`,
    desc: '买卖物品 互通有无'
  },
  {
    id: 'cave',
    name: '洞府',
    // Stone/earth tone for cave/dwelling
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-stone-400"><path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/><path d="M9 11h6"/></svg>`,
    desc: '洞府经营 药园种植'
  },
  {
    id: 'treasure',
    name: '法宝',
    // Indigo/violet for dharma treasure
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-indigo-400"><path d="M12 2 4 7v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V7l-8-5z"/><path d="m9 12 2 2 4-4"/></svg>`,
    desc: '祭炼本命 法宝管理'
  },
  {
    id: 'crafting',
    name: '炼制',
    // Orange for alchemy/crafting fire
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-orange-400"><path d="M12 2c0 0-4 4-4 8a4 4 0 0 0 8 0c0-4-4-8-4-8z"/><path d="M8 14a4 4 0 1 0 8 0"/><path d="M5 18h14"/><path d="M7 22h10"/></svg>`,
    desc: '炼丹炼器 学习配方'
  },
  {
    id: 'meditation',
    name: '悟道',
    // Amber/yellow for meditation/insight
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
    desc: '静思悟道 破除瓶颈'
  },
  {
    id: 'arena',
    name: '斗法',
    // Red for battle/duel
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-red-400"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/></svg>`,
    desc: '挑战同修 争夺段位'
  },
  {
    id: 'bounty',
    name: '悬赏',
    // Amber/gold for bounty - matches bounty reward gold theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>`,
    desc: '悬赏追杀 缉拿目标'
  },
  {
    id: 'cave_social',
    name: '社交',
    // Emerald for cave social - matches cave social green theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    desc: '洞府社交 留言访客'
  },
  {
    id: 'fengshen',
    name: '封神',
    // Purple for fengshen arena - matches fengshen purple/gold theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-purple-400"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`,
    desc: '封神台 镜像排名战'
  },
  {
    id: 'artifact_spirit',
    name: '器灵',
    // Cyan for artifact spirit - matches 器灵 cyan/emerald theme (灵识养成)
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-400"><path d="M12 2v6"/><path d="M12 22v-6"/><path d="M4.93 4.93l4.24 4.24"/><path d="M14.83 14.83l4.24 4.24"/><path d="M2 12h6"/><path d="M22 12h-6"/><path d="M4.93 19.07l4.24-4.24"/><path d="M14.83 9.17l4.24-4.24"/></svg>`,
    desc: '法宝器灵 灵识养成'
  },
  {
    id: 'pawnshop',
    name: '当铺',
    // Amber/gold for pawnshop - matches 聚宝当铺 yellow theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>`,
    desc: '典当赎回 周转灵石'
  },
  {
    id: 'stock',
    name: '股市',
    // Cyan for stock market - matches 聚宝股市 cyan theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-400"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>`,
    desc: '聚宝股市 买卖股票'
  },
  {
    id: 'auction',
    name: '拍卖',
    // Rose/red for auction - 竞价博弈的热烈感
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-rose-400"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94"/></svg>`,
    desc: '拍卖竞价 多人博弈'
  },
  {
    id: 'dungeon',
    name: '副本',
    // Amber for dungeon/secret realm - matches 秘境副本 amber theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"><path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/><path d="M9 11h6"/></svg>`,
    desc: '秘境副本 三星扫荡'
  },
  {
    id: 'formation',
    name: '阵法',
    // Purple for formation system - matches 阵法堂 purple/cyan theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-purple-400"><circle cx="12" cy="12" r="10"/><path d="M12 2v20"/><path d="M2 12h20"/><circle cx="12" cy="12" r="4"/></svg>`,
    desc: '阵法堂 布阵加持'
  },
  {
    id: 'nascent_soul',
    name: '元婴',
    // Purple for nascent soul / high realm features
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-purple-400"><path d="M12 2a3 3 0 0 0-3 3c0 1.6.8 3 2 4-1.2 1-2 2.4-2 4a3 3 0 0 0 6 0c0-1.6-.8-3-2-4 1.2-1 2-2.4 2-4a3 3 0 0 0-3-3z"/><path d="M5 22h14"/><path d="M12 16v6"/></svg>`,
    desc: '元婴出窍 高阶境界'
  },
  {
    id: 'ascension',
    name: '飞升',
    // Amber/gold for ascension - matches 飞升灵界 gold theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-300"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>`,
    desc: '飞升灵界 夺舍重生'
  },
  {
    id: 'second_soul',
    name: '元神',
    // Indigo for second soul / duality - matches 第二元神 mystic theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-indigo-300"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18"/><path d="M3 12h18"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>`,
    desc: '第二元神 元神出窍'
  },
  {
    id: 'small_world',
    name: '小世界',
    // Cyan for small world / domain - matches 小世界 realm theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-300"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a9 9 0 0 1 0 18"/><path d="M12 3a9 9 0 0 0 0 18"/><path d="M7 8h10"/><path d="M7 16h10"/></svg>`,
    desc: '开辟小世界 香火神庙'
  },
  {
    id: 'divine_sense_duel',
    name: '神识对决',
    // Purple for divine sense duel - 1v1 mystic PvP
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-purple-300"><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/><path d="M12 3v2"/><path d="M12 19v2"/><circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.4"/></svg>`,
    desc: '神识对决 1v1 博弈 PvP'
  },
  {
    id: 'taoism_gate',
    name: '太一门',
    // Indigo/cyan for Taoism gate / five elements dao path - blends mystic & elemental themes
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-indigo-300"><path d="M12 2 4 7v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V7l-8-5z"/><path d="M12 8a4 4 0 0 1 4 4"/><path d="M12 16a4 4 0 0 1-4-4"/><path d="M12 2v20"/><path d="M4 12h16"/></svg>`,
    desc: '太一门引道 五行道途 共鸣'
  },
  {
    id: 'companion',
    name: '道侣',
    // Rose/pink for companion / love / dao companion
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-rose-300"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    desc: '道侣双修 心契心劫'
  },
  {
    id: 'concubine',
    name: '侍妾',
    // Purple for concubine / red chamber / cultivation companion
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-fuchsia-300"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    desc: '红尘寻缘 远航归来'
  },
  {
    id: 'multi_dungeon',
    name: '多人',
    // Amber/orange for dungeon / raid / multiplayer challenge
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-300"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/></svg>`,
    desc: '多人副本 掩月抢亲 端午镇蛟'
  },
  {
    id: 'spirit_beast',
    name: '灵兽',
    // Emerald for spirit beast / pet / companion creature
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-300"><path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-2.97 7 .41 1.04 1 2.02 1.56 2.85 2.53 3.8-1.41 6.35-4.5 4.73l-3.23-1.68a19 19 0 0 0-2.57 0l-3.23 1.68c-3.09 1.62-7.03-.93-4.5-4.73.56-.83 1.15-1.81 1.56-2.85-2.55 0-4.37-6.42-2.97-7C4.62 2.25 7.87 3.09 9.65 5.09 10.3 4.92 11.33 5 12 5z"/></svg>`,
    desc: '灵兽图鉴 捕获培养'
  },
  {
    id: 'beast_abyss',
    name: '探渊',
    // Deep teal/emerald for abyss exploration - darker than spirit beast to signify depth
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-teal-400"><path d="M12 2a4 4 0 0 0-4 4v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/><path d="M12 10v8"/><path d="M9 14h6"/><path d="M3 12a9 9 0 0 1 18 0"/></svg>`,
    desc: '灵兽探渊 异步多人 PVE+PVP'
  },
  {
    id: 'dao_companion',
    name: '道侣',
    // Rose for dao companion / dual cultivation / heart contract
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-rose-300"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    desc: '道侣双修 心契心印'
  },
  {
    id: 'world_boss',
    name: '讨伐',
    // Red for world boss / raid battle - matches 世界BOSS red theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-red-500"><path d="M5 3v4l3 3"/><path d="M19 3v4l-3 3"/><path d="M3 5h4l3 3"/><path d="M21 5h-4l-3 3"/><path d="M12 12v9"/><path d="M8 17h8"/><circle cx="12" cy="9" r="3"/></svg>`,
    desc: '世界BOSS 全服讨伐'
  },
  {
    id: 'sect_war',
    name: '宗战',
    // Amber for sect war / guild battle - matches 宗门战 gold theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-500"><path d="M4 22V4l4-2 4 2 4-2 4 2v18"/><path d="M4 14h16"/><path d="M9 9h2"/><path d="M13 9h2"/><path d="M9 17h2"/><path d="M13 17h2"/></svg>`,
    desc: '宗门战 领地争夺'
  },
]

const emit = defineEmits(['action'])

const handleAction = (id) => {
  emit('action', id)
}
</script>

<style scoped>
</style>


