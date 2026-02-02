<template>
  <Modal :isOpen="true" @close="$emit('close')" title="角色系统" width="1200px">
    <div class="h-[80vh] flex flex-col bg-[#141210]">
      <!-- 顶部标签栏 -->
      <div class="flex border-b border-stone-700 bg-[#1c1917]">
        <button 
          v-for="tab in tabs" 
          :key="tab.id"
          @click="currentTab = tab.id"
          class="px-6 py-3 text-sm font-medium transition-colors relative"
          :class="currentTab === tab.id ? 'text-amber-500' : 'text-stone-400 hover:text-stone-200'"
        >
          <div class="flex items-center gap-2">
            <span v-if="tab.icon" v-html="tab.icon"></span>
            {{ tab.name }}
          </div>
          <!-- 激活状态下划线 -->
          <div 
            v-if="currentTab === tab.id" 
            class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"
          ></div>
        </button>
      </div>

      <!-- 内容区域 -->
      <div class="flex-1 overflow-y-auto p-6 custom-scrollbar">
        
        <!-- 角色信息 Tab -->
        <div v-if="currentTab === 'info'" class="space-y-6">
          
          <!-- 角色属性概览 -->
          <div class="bg-[#1c1917] rounded-lg border border-stone-800 p-5 relative overflow-hidden group">
            <div class="flex justify-between items-start mb-4">
              <h3 class="text-lg font-bold text-stone-200 flex items-center gap-2">
                <span class="text-amber-500">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                </span>
                角色属性
              </h3>
              <button @click="toggleDetail" class="text-xs text-stone-500 hover:text-stone-300 transition-colors">
                {{ showDetail ? '隐藏详情' : '显示详情' }}
              </button>
            </div>

            <!-- 核心属性数值 -->
            <div class="grid grid-cols-2 gap-y-3 gap-x-12 mb-6">
              <div class="flex justify-between items-center">
                <span class="text-stone-400">攻击:</span>
                <span class="text-red-400 font-bold font-mono text-lg">{{ attributes.current?.atk || 0 }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-stone-400">防御:</span>
                <span class="text-blue-400 font-bold font-mono text-lg">{{ attributes.current?.def || 0 }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-stone-400">神识:</span>
                <span class="text-purple-400 font-bold font-mono text-lg">{{ attributes.current?.sense || 0 }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-stone-400">体魄:</span>
                <span class="text-orange-400 font-bold font-mono text-lg">{{ attributes.current?.physique || 0 }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-stone-400">声望:</span>
                <span class="text-stone-400 font-bold font-mono text-lg">{{ player?.reputation || 0 }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-stone-400">气血:</span>
                <span class="text-emerald-400 font-bold font-mono text-lg">
                  {{ attributes.current?.hp || 0 }} / {{ attributes.max?.hp_max || 0 }}
                </span>
              </div>
              <div class="col-start-2 flex justify-between items-center">
                <span class="text-stone-400">速度:</span>
                <span class="text-amber-400 font-bold font-mono text-lg">{{ attributes.current?.speed || 0 }}</span>
              </div>
            </div>

            <!-- 属性来源分解 (可折叠) -->
            <div v-if="showDetail" class="border-t border-stone-800 pt-4 mt-2 animate-fade-in">
              <div class="text-xs text-stone-500 mb-2">属性来源分解:</div>
              <div class="grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-stone-400">
                <div class="flex gap-2">
                  <span class="w-16 text-stone-600">基础:</span>
                  <span>攻击 {{ attributes.breakdown?.base?.atk || 0 }}, 防御 {{ attributes.breakdown?.base?.def || 0 }}, 气血 {{ attributes.breakdown?.base?.hp_max || 0 }}</span>
                </div>
                <div class="flex gap-2">
                  <span class="w-16 text-stone-600">天赋:</span>
                  <span>攻击 {{ attributes.breakdown?.talent?.atk || 0 }}, 防御 {{ attributes.breakdown?.talent?.def || 0 }}, 气血 {{ attributes.breakdown?.talent?.hp_max || 0 }}</span>
                </div>
                <div class="flex gap-2">
                  <span class="w-16 text-stone-600">称号:</span>
                  <span>攻击 {{ attributes.breakdown?.title?.atk || 0 }}, 防御 {{ attributes.breakdown?.title?.def || 0 }}, 气血 {{ attributes.breakdown?.title?.hp_max || 0 }}</span>
                </div>
                <div class="flex gap-2">
                  <span class="w-16 text-stone-600">灵根:</span>
                  <span>攻击 {{ attributes.breakdown?.spirit_root?.atk || 0 }}, 防御 {{ attributes.breakdown?.spirit_root?.def || 0 }}, 气血 {{ attributes.breakdown?.spirit_root?.hp_max || 0 }}</span>
                </div>
                <div class="flex gap-2">
                  <span class="w-16 text-stone-600">加点:</span>
                  <span>攻击 {{ attributes.breakdown?.allocated?.atk || 0 }}, 防御 {{ attributes.breakdown?.allocated?.def || 0 }}, 气血 {{ attributes.breakdown?.allocated?.hp_max || 0 }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 属性加点 -->
          <div class="bg-[#1c1917] rounded-lg border border-stone-800 p-5">
            <div class="flex items-center gap-2 mb-4">
              <span class="text-amber-500">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </span>
              <h3 class="text-lg font-bold text-stone-200">可分配属性点: <span class="text-amber-500 font-mono text-xl">{{ attributes.attribute_points }}</span></h3>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              <div v-for="attr in allocatableAttributes" :key="attr.key" 
                   class="relative overflow-hidden rounded border transition-all duration-300 group"
                   :class="getAttributeCardClass(attr.color)"
              >
                <div class="p-3 flex justify-between items-center relative z-10">
                  <div class="flex flex-col">
                    <span class="text-sm font-bold text-stone-300 opacity-90">{{ attr.name }}</span>
                    <div class="flex items-baseline gap-1 mt-1">
                      <span class="font-mono text-lg font-bold text-white">{{ attributes.current?.[attr.key] || 0 }}</span>
                      <span v-if="allocation[attr.key] > 0" class="text-xs font-mono text-emerald-300 animate-pulse">
                        → {{ (attributes.current?.[attr.key] || 0) + allocation[attr.key] }} (+{{ allocation[attr.key] }})
                      </span>
                    </div>
                  </div>
                  
                  <div class="flex flex-col items-center gap-1">
                     <button 
                      @click="allocatePoint(attr.key)"
                      :disabled="attributes.attribute_points <= 0"
                      class="w-10 h-10 rounded flex items-center justify-center transition-colors shadow-lg active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed bg-black/20 hover:bg-black/40 text-white"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    </button>
                    <span v-if="allocation[attr.key] > 0" class="text-[10px] font-mono font-bold text-white/80">+{{ allocation[attr.key] }}</span>
                  </div>
                </div>
                <!-- 背景装饰 -->
                <div class="absolute right-0 bottom-0 opacity-10 transform translate-x-1/4 translate-y-1/4 scale-150 pointer-events-none">
                   <!-- Icons same as before -->
                   <svg v-if="attr.key === 'atk'" xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="currentColor"><path d="M14.5 17.5L3 6V3h3l11.5 11.5-3 3zM15 17l1 1 4-4-4-4-1 1 3 3-3 3z"/></svg>
                   <svg v-else-if="attr.key === 'def'" xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                   <svg v-else-if="attr.key === 'hp'" xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                </div>
              </div>
            </div>
            
            <!-- 确认加点按钮 -->
            <div v-if="hasPendingAllocation" class="flex justify-end gap-3 mt-4 animate-fade-in">
              <button @click="resetAllocation" class="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 hover:bg-stone-800 rounded transition-colors">重置</button>
              <button @click="confirmAllocation" class="px-6 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded font-medium shadow-lg shadow-amber-900/20 transition-all active:scale-95 flex items-center gap-2">
                <span v-if="isSubmitting" class="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full"></span>
                确认分配
              </button>
            </div>
          </div>

          <!-- 天赋 -->
          <div class="bg-[#1c1917] rounded-lg border border-stone-800 p-5">
            <div class="flex items-center gap-2 mb-4">
               <span class="text-purple-500">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
               </span>
               <h3 class="text-lg font-bold text-stone-200">天赋</h3>
            </div>
            
            <div v-if="attributes.info?.talent" class="bg-[#141210] border border-stone-800 rounded p-4 relative overflow-hidden">
               <div class="flex items-center gap-3 mb-2">
                 <span class="text-purple-400 font-bold text-lg">{{ attributes.info.talent.name }}</span>
                 <span class="text-xs border border-purple-900/50 bg-purple-900/20 text-purple-400 px-2 py-0.5 rounded-full">{{ getQualityName(attributes.info.talent.quality) }}</span>
               </div>
               <p class="text-stone-400 text-sm mb-3">{{ attributes.info.talent.description }}</p>
               <p class="text-xs text-stone-600 italic">* 天赋在游戏开始时随机生成，之后不可修改</p>
            </div>
            <div v-else class="text-stone-500 text-sm">暂无天赋信息</div>
          </div>

          <!-- 称号系统 -->
          <div class="bg-[#1c1917] rounded-lg border border-stone-800 p-5">
             <div class="flex justify-between items-center mb-4">
                <div class="flex items-center gap-2">
                  <span class="text-amber-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
                  </span>
                  <h3 class="text-lg font-bold text-stone-200">称号系统 <span class="text-stone-500 text-sm font-normal ml-2">({{ ownedTitles.length }}/{{ allTitles.length }})</span></h3>
                </div>
                <button @click="showTitlesList = !showTitlesList" class="text-xs text-stone-500 hover:text-stone-300 transition-colors">{{ showTitlesList ? '收起' : '展开' }}</button>
             </div>

             <!-- 已装备称号 (默认显示) -->
             <div v-if="attributes.info?.title" class="border border-amber-900/30 bg-[#141210] rounded p-4 relative mb-4">
                <div class="absolute -top-1 -left-1 w-3 h-3 border-t border-l border-amber-700"></div>
                <div class="absolute -bottom-1 -right-1 w-3 h-3 border-b border-r border-amber-700"></div>
                
                <div class="flex items-start gap-4">
                  <div class="flex-1">
                     <div class="flex items-center gap-3 mb-2">
                        <span class="font-bold text-blue-400">{{ attributes.info.title.name }} <span class="text-xs font-normal opacity-70">({{ getQualityName(attributes.info.title.quality) }})</span></span>
                        <span class="bg-amber-900/30 text-amber-500 text-xs px-2 py-0.5 rounded border border-amber-900/50">已装备</span>
                     </div>
                     <p class="text-stone-400 text-sm mb-2">{{ attributes.info.title.description }}</p>
                     <p class="text-xs text-stone-500 mb-3">获得条件：{{ attributes.info.title.condition }}</p>
                     
                     <div class="space-y-1">
                        <div v-for="(val, key) in attributes.info.title.bonuses" :key="key" class="text-xs text-stone-300">
                            {{ formatBonusKey(key) }} <span class="text-emerald-400">+{{ val }}</span>
                        </div>
                     </div>
                  </div>
                </div>
             </div>
             <div v-else-if="!showTitlesList" class="text-stone-500 text-sm italic mb-4">
                 未装备称号
             </div>

             <!-- 称号列表 (展开时显示) -->
             <div v-if="showTitlesList" class="space-y-3 animate-fade-in max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
                 <div v-for="title in allTitles" :key="title.id" 
                      class="border rounded p-3 relative transition-colors"
                      :class="isEquipped(title.id) ? 'border-amber-900/30 bg-[#141210]' : (isOwned(title.id) ? 'border-stone-700 bg-stone-900/50 hover:bg-stone-900' : 'border-stone-800 bg-stone-950 opacity-60')"
                 >
                    <div class="flex justify-between items-start">
                        <div>
                             <div class="flex items-center gap-2 mb-1">
                                <span class="font-bold" :class="getTitleColor(title.quality)">{{ title.name }}</span>
                                <span class="text-xs opacity-70">({{ getQualityName(title.quality) }})</span>
                                <span v-if="isEquipped(title.id)" class="text-[10px] text-amber-500 border border-amber-500/30 px-1 rounded">已装备</span>
                                <span v-else-if="isOwned(title.id)" class="text-[10px] text-emerald-500 border border-emerald-500/30 px-1 rounded">已获得</span>
                             </div>
                             <p class="text-stone-400 text-xs mb-1">{{ title.description }}</p>
                             <p class="text-[10px] text-stone-600">条件: {{ title.condition }}</p>
                        </div>
                        
                        <button v-if="isOwned(title.id) && !isEquipped(title.id)" 
                                @click="equipTitle(title.id)"
                                class="px-3 py-1 bg-stone-800 hover:bg-stone-700 text-stone-300 text-xs rounded transition-colors"
                        >
                            装备
                        </button>
                    </div>
                 </div>
             </div>

          </div>

        </div>

        <!-- 数据统计 Tab -->
        <div v-else-if="currentTab === 'stats'" class="space-y-6">
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
import { ref, onMounted, computed, reactive } from 'vue';
import Modal from '../common/Modal.vue';
import { usePlayerStore } from '../../stores/player';
import { useUIStore } from '../../stores/ui';
import axios from 'axios';

defineEmits(['close']);

const playerStore = usePlayerStore();
const uiStore = useUIStore();
const player = computed(() => playerStore.player);

const currentTab = ref('info');
const showDetail = ref(false);
const showTitlesList = ref(false);
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
const isSubmitting = ref(false);

// 临时分配点数
const allocation = reactive({
  atk: 0,
  def: 0,
  hp: 0,
  sense: 0,
  physique: 0,
  speed: 0
});

const tabs = [
  { id: 'info', name: '角色信息', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>' },
  { id: 'stats', name: '数据统计', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>' }
];

const allocatableAttributes = [
  { key: 'atk', name: '攻击', color: 'red' },
  { key: 'def', name: '防御', color: 'blue' },
  { key: 'hp', name: '气血', color: 'green' },
  { key: 'sense', name: '神识', color: 'purple' },
  { key: 'physique', name: '体魄', color: 'orange' },
  { key: 'speed', name: '速度', color: 'amber' }
];

const hasPendingAllocation = computed(() => {
  return Object.values(allocation).some(v => v > 0);
});

const allTitles = computed(() => attributes.value.info?.all_titles || []);
const ownedTitles = computed(() => attributes.value.info?.owned_titles || []);
const equippedTitleId = computed(() => attributes.value.info?.title?.id);

const isOwned = (id) => ownedTitles.value.includes(id);
const isEquipped = (id) => equippedTitleId.value === id;

const fetchAttributes = async () => {
  try {
    const res = await axios.get('/api/attribute/full');
    if (res.data && res.data.data) {
      attributes.value = res.data.data;
      // 重置 allocation 如果有
      if (res.data.data.attribute_points < 0) {
          // 异常情况处理
      }
    }
  } catch (error) {
    console.error('Fetch attributes failed:', error);
    uiStore.showToast('获取属性信息失败', 'error');
  }
};

const toggleDetail = () => {
  showDetail.value = !showDetail.value;
};

const allocatePoint = (key) => {
  if (attributes.value.attribute_points > 0) {
    allocation[key]++;
    attributes.value.attribute_points--;
  }
};

const resetAllocation = () => {
  // Restore points
  const totalAllocated = Object.values(allocation).reduce((a, b) => a + b, 0);
  attributes.value.attribute_points += totalAllocated;
  
  // Reset object
  Object.keys(allocation).forEach(key => allocation[key] = 0);
};

const confirmAllocation = async () => {
  if (!hasPendingAllocation.value || isSubmitting.value) return;
  
  isSubmitting.value = true;
  try {
    const res = await axios.post('/api/attribute/allocate', {
      points: allocation
    });
    
    if (res.data.code === 200) {
      uiStore.showToast('属性分配成功', 'success');
      await fetchAttributes();
      
      // Reset allocation
      Object.keys(allocation).forEach(key => allocation[key] = 0);
    }
  } catch (error) {
    console.error('Allocation failed:', error);
    uiStore.showToast(error.response?.data?.message || '属性分配失败', 'error');
  } finally {
    isSubmitting.value = false;
  }
};

const equipTitle = async (id) => {
    try {
        const res = await axios.post('/api/attribute/equip_title', { title_id: id });
        if (res.data.code === 200) {
            uiStore.showToast('称号装备成功', 'success');
            fetchAttributes();
        }
    } catch (error) {
        uiStore.showToast(error.response?.data?.message || '装备称号失败', 'error');
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
    if (!player.value) return 0;
    // 简单的进度计算，实际应该基于境界经验上限
    // 这里暂时用一个假设的上限公式或者从后端获取 cap
    // 之前代码里有 player.exp_cap ?
    // 如果没有，就先返回 0 或 mock
    // 假设 exp_cap 是 realm 基础 * 1000
    return 0; // TODO: get exp_cap from backend
};

const getAttributeCardClass = (color) => {
  const classes = {
    red: 'bg-red-900/20 border-red-900/50 hover:border-red-500',
    blue: 'bg-blue-900/20 border-blue-900/50 hover:border-blue-500',
    green: 'bg-emerald-900/20 border-emerald-900/50 hover:border-emerald-500',
    purple: 'bg-purple-900/20 border-purple-900/50 hover:border-purple-500',
    orange: 'bg-orange-900/20 border-orange-900/50 hover:border-orange-500',
    amber: 'bg-amber-900/20 border-amber-900/50 hover:border-amber-500'
  };
  return classes[color] || classes.amber;
};

const getQualityName = (quality) => {
    const map = {
        common: '普通',
        uncommon: '非凡',
        rare: '稀有',
        epic: '史诗',
        legendary: '传说',
        mythical: '神话'
    };
    return map[quality] || quality;
};

const getTitleColor = (quality) => {
    const map = {
        common: 'text-stone-400',
        uncommon: 'text-green-400',
        rare: 'text-blue-400',
        epic: 'text-purple-400',
        legendary: 'text-orange-400',
        mythical: 'text-red-500'
    };
    return map[quality] || 'text-stone-400';
};

const formatBonusKey = (key) => {
    const map = {
        atk: '攻击',
        def: '防御',
        hp_max: '气血',
        mp_max: '灵力',
        speed: '速度',
        sense: '神识',
        physique: '体魄',
        cultivate_speed_pct: '修炼速度',
        atk_pct: '攻击加成'
    };
    return map[key] || key;
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

@keyframes fade-in {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fade-in 0.3s ease-out forwards;
}
</style>
