<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  player: {
    type: Object,
    required: true
  },
  serverStatus: String,
  dbStatus: String,
  ping: {
    type: Number,
    default: 0
  }
})

// 计算经验条百分比 (已废弃，直接在模板中计算)
const expPercentage = computed(() => {
  return Math.min((props.player.exp / (props.player.exp_next || 1)) * 100, 100) + '%'
})

// 计算寿命百分比 (已废弃，直接在模板中计算)
const lifePercentage = computed(() => {
  return Math.min((props.player.lifespan_current / (props.player.lifespan_max || 1)) * 100, 100) + '%'
})

// 连接状态判断
const isConnected = computed(() => {
  return props.serverStatus === '服务器正常运行，数据库连接成功' || props.serverStatus?.includes('正常')
})

// 默认头像 (凡人修仙传韩立风格)
const defaultAvatar = 'https://i.postimg.cc/q73059Z3/hanli.jpg'

const isExpChanged = ref(false)

// 监听经验变化
watch(() => props.player, (newVal) => {
  console.log('PlayerStatus player update:', newVal)
}, { deep: true, immediate: true })

watch(() => props.player.exp, (newVal, oldVal) => {
  if (newVal !== oldVal) {
    isExpChanged.value = true
    setTimeout(() => {
      isExpChanged.value = false
    }, 500)
  }
})
</script>

<template>
  <div class="h-full flex flex-col p-4 overflow-y-auto select-none font-sans">
    <!-- 顶部角色信息 -->
    <div class="flex flex-col mb-6 pt-2 px-2">
       <div class="flex items-center justify-between w-full mb-3">
         <!-- 头像 (左侧) -->
         <div class="w-16 h-16 rounded-lg border-2 border-emerald-500/50 flex items-center justify-center bg-[#0c0a09] shadow-[0_0_15px_rgba(16,185,129,0.2)] shrink-0 overflow-hidden relative group">
           <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-500 group-hover:scale-110 transition-transform"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
         </div>

         <!-- 名字与UID (右侧) -->
         <div class="flex flex-col items-end flex-1 ml-4">
            <h2 class="text-2xl font-bold text-emerald-400 tracking-wider drop-shadow-[0_0_8px_rgba(52,211,153,0.5)] mb-1">{{ player.nickname || '加载中...' }}</h2>
            <div class="flex items-center gap-2">
              <span class="text-xs text-stone-500 font-mono tracking-wide flex items-center gap-1 uppercase">
                <span class="text-stone-600">UID:</span>
                <span class="text-stone-400">{{ player.id || player.username || '---' }}</span>
              </span>
              <!-- 延迟显示 -->
              <div class="flex items-center gap-1 bg-stone-900/50 px-2 py-1 rounded border border-stone-800" title="网络延迟">
                <div class="w-2 h-2 rounded-full" :class="ping < 100 ? 'bg-emerald-500' : (ping < 300 ? 'bg-amber-500' : 'bg-rose-500')"></div>
                <span class="text-xs font-mono" :class="ping < 100 ? 'text-emerald-600' : (ping < 300 ? 'text-amber-600' : 'text-rose-600')">{{ ping === 0 ? '&lt;1' : ping }}ms</span>
              </div>
            </div>
          </div>
       </div>

       <!-- 境界显示 (下方) -->
       <div class="flex items-center justify-between w-full border-t border-stone-800/50 pt-3">
          <div class="flex items-center gap-2 text-stone-500 text-sm">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-purple-500/70"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
            <span class="font-serif tracking-widest text-stone-400">当前境界</span>
          </div>
          <div class="px-4 py-1 rounded-full bg-purple-900/20 border border-purple-500/30 text-purple-300 text-sm font-bold tracking-wider shadow-[0_0_10px_rgba(168,85,247,0.15)]">
            {{ player.realm || '凡人' }}
          </div>
       </div>
    </div>

    <!-- 状态条 -->
    <div class="space-y-4 mb-8 px-1">
      <!-- 气血 (HP) -->
      <div>
        <div class="flex justify-between text-xs text-stone-400 mb-1">
          <span>气血 (HP)</span>
          <span class="font-mono">{{ player.hp_current || 0 }} / {{ player.hp_max || 0 }}</span>
        </div>
        <div class="h-2 w-full bg-stone-900/80 rounded-sm overflow-hidden border border-stone-800 relative">
          <div class="h-full bg-rose-700 progress-flow transition-all duration-300" :style="{ width: player.hp_max ? Math.min((player.hp_current / player.hp_max) * 100, 100) + '%' : '0%' }"></div>
        </div>
      </div>

      <!-- 修为 (Exp) -->
      <div>
        <div class="flex justify-between text-[10px] text-stone-400 mb-0.5">
          <span>修为 (Exp)</span>
          <span>{{ player.exp || 0 }} / {{ player.exp_next || 0 }}</span>
        </div>
        <div class="h-1.5 w-full bg-stone-900/80 rounded-sm overflow-hidden border border-stone-800 relative">
          <div class="h-full bg-emerald-600 progress-flow transition-all duration-300" 
               :class="{ 'brightness-150': isExpChanged }"
               :style="{ width: player.exp_next ? Math.min((player.exp / player.exp_next) * 100, 100) + '%' : '0%' }"></div>
        </div>
      </div>

      <!-- 寿命/精力 -->
      <div>
        <div class="flex justify-between text-[10px] text-stone-400 mb-0.5">
          <span>寿命 (年)</span>
          <span>{{ player.lifespan_current || 0 }} / {{ player.lifespan_max || 0 }}</span>
        </div>
        <div class="h-1.5 w-full bg-stone-900/80 rounded-sm overflow-hidden border border-stone-800 relative">
          <div class="h-full bg-cyan-600 progress-flow transition-all duration-300" :style="{ width: player.lifespan_max ? Math.min((player.lifespan_current / player.lifespan_max) * 100, 100) + '%' : '0%' }"></div>
        </div>
      </div>
    </div>

    <!-- 装备/功法区域 -->
    <div class="space-y-4 mb-8">
      <!-- 当前功法 -->
      <div class="bg-[#1c1917] border border-stone-800 p-3 flex items-center gap-4 rounded-lg hover:border-stone-600 transition-colors cursor-pointer group shadow-sm">
        <div class="w-10 h-10 flex items-center justify-center bg-stone-800 rounded text-cyan-500 group-hover:text-cyan-400">
           <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        </div>
        <div class="flex flex-col">
          <span class="text-xs text-stone-500 mb-0.5">当前心法</span>
          <span class="text-base text-stone-300 font-medium group-hover:text-amber-500 transition-colors">本心诀</span>
        </div>
      </div>
      
      <!-- 本命法宝 -->
      <div class="bg-[#1c1917] border border-stone-800 p-3 flex items-center gap-4 rounded-lg hover:border-stone-600 transition-colors cursor-pointer group shadow-sm">
        <div class="w-10 h-10 flex items-center justify-center bg-stone-800 rounded text-rose-500 group-hover:text-rose-400">
           <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/></svg>
        </div>
        <div class="flex flex-col">
          <span class="text-xs text-stone-500 mb-0.5">本命法宝</span>
          <span class="text-base text-stone-300 font-medium group-hover:text-amber-500 transition-colors">未装备</span>
        </div>
      </div>
    </div>

    <!-- 属性网格 -->
    <div class="grid grid-cols-2 gap-3 mb-8">
      <div class="bg-[#1c1917] p-3 rounded-lg border border-stone-800 flex flex-col justify-center items-center hover:bg-[#292524] transition-colors">
        <span class="text-xs text-stone-500 mb-1.5">攻击</span>
        <span class="text-stone-200 font-bold font-mono text-lg">{{ player.attributes?.atk || 72 }}</span>
      </div>
      <div class="bg-[#1c1917] p-3 rounded-lg border border-stone-800 flex flex-col justify-center items-center hover:bg-[#292524] transition-colors">
        <span class="text-xs text-stone-500 mb-1.5">防御</span>
        <span class="text-stone-200 font-bold font-mono text-lg">{{ player.attributes?.def || 62 }}</span>
      </div>
      <div class="bg-[#1c1917] p-3 rounded-lg border border-stone-800 flex flex-col justify-center items-center hover:bg-[#292524] transition-colors">
        <span class="text-xs text-stone-500 mb-1.5">速度</span>
        <span class="text-stone-200 font-bold font-mono text-lg">{{ player.attributes?.speed || 122 }}</span>
      </div>
      <div class="bg-[#1c1917] p-3 rounded-lg border border-stone-800 flex flex-col justify-center items-center hover:bg-[#292524] transition-colors">
        <span class="text-xs text-stone-500 mb-1.5">法抗</span>
        <span class="text-stone-200 font-bold font-mono text-lg">{{ player.attributes?.res || 95 }}</span>
      </div>
      <div class="bg-[#1c1917] p-3 rounded-lg border border-stone-800 flex flex-col justify-center items-center hover:bg-[#292524] transition-colors">
        <span class="text-xs text-stone-500 mb-1.5">悟性</span>
        <span class="text-stone-200 font-bold font-mono text-lg">{{ player.attributes?.sense || 39 }}</span>
      </div>
      <div class="bg-[#1c1917] p-3 rounded-lg border border-stone-800 flex flex-col justify-center items-center hover:bg-[#292524] transition-colors">
        <span class="text-xs text-stone-500 mb-1.5">灵石</span>
        <span class="text-amber-500 font-bold font-mono text-lg">{{ player.spirit_stones || 3809 }}</span>
      </div>
    </div>
    
    <!-- 五行灵根 -->
    <div>
      <h3 class="text-sm text-stone-400 font-bold mb-3 flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
        灵根资质
      </h3>
      <div class="flex justify-between bg-[#1c1917] p-3 rounded-lg border border-stone-800">
        <div class="flex flex-col items-center gap-1.5">
          <span class="text-xs text-yellow-600 font-bold">金</span>
          <span class="text-xs text-stone-400 font-mono">1</span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <span class="text-xs text-emerald-600 font-bold">木</span>
          <span class="text-xs text-stone-400 font-mono">8</span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <span class="text-xs text-blue-500 font-bold">水</span>
          <span class="text-xs text-stone-400 font-mono">10</span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <span class="text-xs text-rose-600 font-bold">火</span>
          <span class="text-xs text-stone-400 font-mono">9</span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <span class="text-xs text-stone-500 font-bold">土</span>
          <span class="text-xs text-stone-400 font-mono">7</span>
        </div>
      </div>
    </div>
    
    <div class="mt-auto pt-4 text-xs text-stone-600 italic text-center">
      "道法自然，乐在其中。"
    </div>
  </div>
</template>
