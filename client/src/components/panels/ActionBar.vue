<template>
  <div class="shrink-0 flex flex-col p-4 bg-[#0c0a09] border-t border-stone-800 select-none z-20">
    <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
      <button 
        v-for="action in refinedActions" 
        :key="action.id"
        @click="handleAction(action.id)"
        class="group relative flex flex-col items-center justify-center p-2 rounded-lg bg-[#1c1917] border border-stone-800 transition-all duration-300
               hover:border-stone-600 hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] hover:-translate-y-0.5 active:scale-95 active:shadow-inner"
        :class="{
          'bg-gradient-to-r from-stone-900 to-[#1c1917]': action.id === 'meditate',
          'animate-shake ring-1 ring-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.4)]': action.id === 'meditate' && isBreakthroughReady
        }"
      >
        <div 
           class="mb-1 transition-transform duration-300 group-hover:scale-110" 
           :class="{'animate-pulse drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]': action.id === 'meditate' && isBreakthroughReady}"
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
import { computed } from 'vue'

const props = defineProps({
  player: {
    type: Object,
    default: () => ({})
  }
})

// 判断是否可以突破
const isBreakthroughReady = computed(() => {
  return props.player && props.player.exp >= props.player.exp_next && props.player.exp_next > 0
})

const refinedActions = [
  { 
    id: 'meditate', 
    name: '打坐', 
    // Cyan for calm/spirit
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-400"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
    desc: '恢复灵力 提升修为' 
  },
  { 
    id: 'explore', 
    name: '历练', 
    // Emerald for nature/travel
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`,
    desc: '探索周边 寻找机缘' 
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
]

const emit = defineEmits(['action'])

const handleAction = (id) => {
  emit('action', id)
}
</script>


