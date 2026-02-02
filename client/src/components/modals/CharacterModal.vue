<template>
  <Modal :isOpen="true" @close="$emit('close')" title="数据统计" width="1200px">
    <div class="h-[80vh] flex flex-col bg-[#141210]">
      <!-- 内容区域 -->
      <div class="flex-1 overflow-y-auto p-6 custom-scrollbar">
        <div class="space-y-6">
           <!-- 基础统计 -->
           <div>
              <h3 class="text-lg font-bold text-stone-200 mb-3 flex items-center gap-2">
                 <span class="text-blue-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                 </span>
                 基础统计
              </h3>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">游戏天数</div>
                    <div class="text-lg font-mono text-amber-500">{{ Math.floor((player?.total_online_time || 0) / (24 * 60 * 60 * 1000)) + 1 }}</div>
                 </div>
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">游戏时长</div>
                    <div class="text-lg font-mono text-blue-400">{{ formatOnlineTime(player?.total_online_time || 0) }}</div>
                 </div>
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">当前境界</div>
                    <div class="text-lg font-mono text-purple-400">{{ player?.realm }}</div>
                 </div>
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">境界进度</div>
                    <div class="w-full bg-stone-900 rounded-full h-2 mt-2 mb-1 overflow-hidden">
                       <div class="bg-purple-600 h-full rounded-full" :style="{ width: `${calculateExpProgress()}%` }"></div>
                    </div>
                    <div class="text-right text-xs text-purple-400">{{ calculateExpProgress() }}%</div>
                 </div>
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">当前修为</div>
                    <div class="text-lg font-mono text-emerald-400">{{ player?.exp || 0 }}</div>
                 </div>
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">当前灵石</div>
                    <div class="text-lg font-mono text-yellow-500">{{ player?.spirit_stones || 0 }}</div>
                 </div>
              </div>
           </div>

           <!-- 战斗统计 -->
           <div>
              <h3 class="text-lg font-bold text-stone-200 mb-3 flex items-center gap-2">
                 <span class="text-red-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 17.5-11.5-11.5"/><path d="m11.5 6 11.5 11.5"/><path d="m17.5 14.5 3 3"/><path d="m3 3 11.5 11.5"/><path d="m3 21 4-4"/><path d="m17 7 4-4"/></svg>
                 </span>
                 战斗统计
              </h3>
              <div class="grid grid-cols-3 gap-3">
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">击杀敌人</div>
                    <div class="text-lg font-mono text-red-400">{{ attributes.player_stats?.kill_count || 0 }}</div>
                 </div>
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">历练次数</div>
                    <div class="text-lg font-mono text-orange-400">{{ attributes.player_stats?.exploration_count || 0 }}</div>
                 </div>
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">死亡次数</div>
                    <div class="text-lg font-mono text-purple-400">{{ attributes.player_stats?.death_count || 0 }}</div>
                 </div>
              </div>
           </div>

           <!-- 修炼统计 -->
           <div>
              <h3 class="text-lg font-bold text-stone-200 mb-3 flex items-center gap-2">
                 <span class="text-amber-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                 </span>
                 修炼统计
              </h3>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">打坐次数</div>
                    <div class="text-lg font-mono text-blue-400">{{ attributes.player_stats?.meditation_count || 0 }}</div>
                 </div>
                 <div class="bg-[#1c1917] p-3 rounded border border-stone-800">
                    <div class="text-xs text-stone-500 mb-1">突破次数</div>
                    <div class="text-lg font-mono text-purple-400">{{ attributes.player_stats?.breakthrough_count || 0 }}</div>
                 </div>
                 <!-- 更多统计项 -->
              </div>
           </div>
        </div>
      </div>
    </div>
  </Modal>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import Modal from '../common/Modal.vue';
import { usePlayerStore } from '../../stores/player';
import { useUIStore } from '../../stores/ui';
import axios from 'axios';

defineEmits(['close']);

const playerStore = usePlayerStore();
const uiStore = useUIStore();
const player = computed(() => playerStore.player);

const attributes = ref({ 
    current: {}, 
    max: {}, 
    breakdown: {},
    info: {
        talent: null,
        title: null,
        all_titles: [],
        owned_titles: []
    },
    player_stats: {},
    attribute_points: 0,
    validation: {} 
});

const fetchAttributes = async () => {
  try {
    const res = await axios.get('/api/attribute/full');
    if (res.data && res.data.data) {
      attributes.value = res.data.data;
    }
  } catch (error) {
    console.error('Fetch attributes failed:', error);
    uiStore.showToast('获取属性信息失败', 'error');
  }
};

const formatOnlineTime = (ms) => {
  if (!ms) return '0分钟';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}小时${remainingMinutes}分钟`;
};

const calculateExpProgress = () => {
    if (!attributes.value.exp) return 0;
    const current = BigInt(attributes.value.exp.current || 0);
    const cap = BigInt(attributes.value.exp.cap || 1);
    if (cap === 0n) return 100;
    
    const progress = Number((current * 10000n) / cap) / 100;
    return Math.min(100, Math.max(0, progress));
};

onMounted(() => {
  fetchAttributes();
});
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: #1c1917;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #44403c;
  border-radius: 3px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #57534e;
}
</style>
