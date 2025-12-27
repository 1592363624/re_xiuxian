<template>
  <div class="flex flex-col md:flex-row h-screen bg-[#0c0a09] text-stone-200 overflow-hidden relative font-sans">
    <!-- 侧边栏 (Desktop) -->
    <aside class="hidden md:flex w-72 flex-col border-r border-stone-800 bg-[#141210]">
      <PlayerStatus v-if="playerStore.player" :player="playerStore.player" />
    </aside>

    <!-- 移动端侧边栏 (遮罩 + 内容) -->
    <div v-if="isMobileMenuOpen" class="fixed inset-0 z-50 md:hidden flex">
      <!-- 遮罩 -->
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="isMobileMenuOpen = false"></div>
      <!-- 侧边栏内容 -->
      <div class="relative w-64 h-full bg-[#141210] border-r border-stone-800 flex flex-col shadow-2xl animate-slide-in">
        <div class="p-4 border-b border-stone-800 flex justify-between items-center bg-[#0c0a09]">
          <span class="font-bold text-lg text-amber-500">功能菜单</span>
          <button @click="isMobileMenuOpen = false" class="text-stone-500 hover:text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-2 space-y-2">
          <!-- 移动端也会显示简略状态 -->
          <div class="bg-[#1c1917] rounded p-3 mb-4 border border-stone-800">
             <div class="flex items-center gap-3 mb-2">
               <div class="w-10 h-10 rounded bg-stone-800 border border-stone-700 overflow-hidden shrink-0">
                  <img src="/vite.svg" alt="Avatar" class="w-full h-full object-cover" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNjY2IiBzdHJva2Utd2lkdGg9IjIiPjxjaXJjbGUgY3g9IjEyIiBjeT0iOCIgcj0iNCIvPjxwYXRoIGQ9Ik02IDIxdjItYTQgNCAwIDAgMSA0LTRoOGE0IDQgMCAwIDEgNCA0djIiLz48L3N2Zz4='">
               </div>
               <div>
                 <div class="font-bold text-stone-200">{{ player.name }}</div>
                 <div class="text-xs text-amber-600">{{ player.realm }}</div>
               </div>
             </div>
             <div class="grid grid-cols-2 gap-2 text-xs text-stone-400">
                <div>灵石: <span class="text-stone-200">{{ player.spirit_stones }}</span></div>
                <div>贡献: <span class="text-stone-200">{{ player.sect_contribution }}</span></div>
             </div>
          </div>

          <button v-for="btn in displayMenuButtons" :key="btn.name" @click="handleMenuClick(btn.name)" class="w-full flex items-center gap-3 px-4 py-3 text-sm text-stone-300 hover:bg-[#292524] hover:text-amber-500 rounded transition-colors border border-transparent hover:border-stone-700">
            <span v-html="btn.icon"></span>
            {{ btn.name }}
          </button>
        </div>
      </div>
    </div>

    <!-- 主区域 -->
    <main class="flex-1 flex flex-col h-full relative min-w-0 bg-[#0c0a09]">
      <!-- 顶部 Header -->
      <header class="h-14 bg-[#1c1917] border-b border-stone-800 flex items-center justify-between px-4 shadow-md z-20 shrink-0">
        <div class="flex items-center gap-3">
          <!-- 移动端菜单按钮 -->
          <button @click="isMobileMenuOpen = true" class="md:hidden p-2 -ml-2 text-stone-400 hover:text-white rounded active:bg-stone-800">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
          </button>
          
          <h1 class="text-xl font-serif font-bold text-amber-500 tracking-wider flex items-center gap-2">
            重生之凡人修仙传 <span class="text-xs text-stone-500 font-sans font-normal border border-stone-700 px-1.5 py-0.5 rounded bg-[#0c0a09]">v0.0.2_BETA</span>
          </h1>
        </div>
        
        <!-- 桌面端顶部按钮组 -->
        <div class="hidden md:flex items-center gap-2">
          <button v-for="btn in displayMenuButtons" :key="btn.name" @click="handleMenuClick(btn.name)" class="flex items-center gap-2 px-3 py-2 bg-[#292524] hover:bg-[#44403c] border border-stone-700 hover:border-stone-500 text-stone-300 hover:text-amber-100 rounded transition-all text-sm min-w-[80px] justify-center group">
            <span class="group-hover:scale-110 transition-transform" v-html="btn.icon"></span>
            {{ btn.name }}
          </button>
          
          <!-- 退出登录按钮 (仅图标) -->
          <button @click="handleLogoutClick" class="p-2 ml-2 text-stone-500 hover:text-rose-500 transition-colors rounded-full hover:bg-stone-800/50" title="退出登录">
             <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </header>

      <!-- 游戏内容区 (日志 + 战斗视觉) -->
      <div class="flex-1 overflow-hidden relative flex flex-col">
        <!-- 这里可以放战斗视觉层 (CombatVisuals) -->
        <GameLog :logs="logs" />
      </div>

      <!-- 底部操作栏 -->
    <ActionBar :player="playerStore.player" @action="handleAction" />
  </main>

    <!-- 全局聊天组件 -->
    <GlobalChat />
    
    <!-- 闭关遮罩层 -->
    <SeclusionOverlay v-if="playerStore.player?.is_secluded" />

    <BreakthroughPortal v-if="playerStore.player" />
    
    <!-- 设置弹窗 -->
    <SettingsModal v-if="isSettingsOpen" @close="isSettingsOpen = false" />
    
    <!-- GM 管理后台 -->
    <AdminPanel v-if="isAdminPanelOpen" @close="isAdminPanelOpen = false" />
    
    <!-- 地图面板 -->
    <MapPanel v-if="isMapOpen" @close="isMapOpen = false" />
    
    <!-- 退出确认弹窗 -->
    <div v-if="isLogoutConfirmOpen" class="fixed inset-0 z-[60] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="isLogoutConfirmOpen = false"></div>
      <div class="relative bg-[#1c1917] border border-stone-800 rounded-lg p-6 max-w-sm w-full mx-4 shadow-2xl animate-fade-in">
        <h3 class="text-lg font-bold text-stone-200 mb-2">退出登录</h3>
        <p class="text-stone-400 mb-6">确定要退出当前的修仙之路吗？未保存的进度可能会丢失。</p>
        <div class="flex justify-end gap-3">
          <button @click="isLogoutConfirmOpen = false" class="px-4 py-2 rounded border border-stone-700 text-stone-300 hover:bg-stone-800 transition-colors">取消</button>
          <button @click="confirmLogout" class="px-4 py-2 rounded bg-rose-900/50 border border-rose-800 text-rose-300 hover:bg-rose-900 transition-colors">确认退出</button>
        </div>
      </div>
    </div>

    <!-- 自动保存动态指示器 -->
    <div class="fixed bottom-4 left-4 z-50 flex items-center gap-2 px-3 py-2 rounded-full bg-[#1c1917]/90 border border-stone-800 shadow-lg backdrop-blur-sm transition-all duration-500 pointer-events-none select-none"
         :class="{ 'opacity-0 translate-y-4': playerStore.saveStatus === 'idle', 'opacity-100 translate-y-0': playerStore.saveStatus !== 'idle' }">
      
      <!-- 保存中 (旋转) -->
      <svg v-if="playerStore.saveStatus === 'saving'" class="animate-spin text-amber-500" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
      </svg>
      
      <!-- 保存成功 -->
      <svg v-else-if="playerStore.saveStatus === 'success'" class="text-emerald-500" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      
      <!-- 保存失败 -->
      <svg v-else-if="playerStore.saveStatus === 'error'" class="text-rose-500" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>

      <span class="text-xs font-mono font-bold" :class="{
        'text-stone-400': playerStore.saveStatus === 'saving',
        'text-emerald-400 animate-pulse': playerStore.saveStatus === 'success',
        'text-rose-400': playerStore.saveStatus === 'error'
      }">
        {{ playerStore.saveStatus === 'saving' ? '自动存档中...' : (playerStore.saveStatus === 'error' ? '存档失败' : '存档完成') }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue';
import axios from 'axios';
import { usePlayerStore } from '../../stores/player';
import { useUIStore } from '../../stores/ui';
import PlayerStatus from '../panels/PlayerStatus.vue';
import GameLog from '../panels/GameLog.vue';
import ActionBar from '../panels/ActionBar.vue';
import GlobalChat from '../widgets/GlobalChat.vue';
import BreakthroughPortal from '../widgets/BreakthroughPortal.vue';
import SettingsModal from '../modals/SettingsModal.vue';
import AdminPanel from '../admin/AdminPanel.vue';
import SeclusionOverlay from '../panels/SeclusionOverlay.vue';
import MapPanel from '../panels/MapPanel.vue';

const props = defineProps<{
  player: any
  logs?: any[]
  serverStatus?: string
  dbStatus?: string
  ping?: number
}>();

const emit = defineEmits(['action']);

const playerStore = usePlayerStore();
const uiStore = useUIStore();
const isMobileMenuOpen = ref(false);
const isSettingsOpen = ref(false);
const isMapOpen = ref(false);
const isAdminPanelOpen = ref(false);
const isLogoutConfirmOpen = ref(false);
const onlineCount = ref(0);
const totalPlayers = ref(0);
let statsInterval: any = null;

const fetchStats = async () => {
  try {
    const res = await axios.get('/api/system/stats');
    if (res.data) {
      onlineCount.value = res.data.online;
      totalPlayers.value = res.data.total;
    }
  } catch (error) {
    console.error('Fetch stats failed:', error);
  }
};

const handleAction = async (actionId: string) => {
  console.log('ActionBar emitted action:', actionId);
  
  if (actionId === 'cultivate') {
    try {
      await playerStore.startSeclusion();
      uiStore.showToast('进入闭关状态', 'success');
      uiStore.addLog({
        content: '开始闭关修炼，摒除杂念，感悟天地灵气。',
        type: 'info',
        actorId: 'self'
      });
    } catch (error: any) {
      const msg = error.response?.data?.error || '无法开始闭关';
      uiStore.showToast(msg, 'error');
    }
    return;
  }
  
  emit('action', actionId);
};

const handleMenuClick = (btnName: string) => {
  if (btnName === '设置') {
    isSettingsOpen.value = true;
    isMobileMenuOpen.value = false;
  } else if (btnName === '地图') {
    isMapOpen.value = true;
    isMobileMenuOpen.value = false;
  } else if (btnName === 'GM') {
    isAdminPanelOpen.value = true;
    isMobileMenuOpen.value = false;
  }
};

const handleLogoutClick = () => {
  isLogoutConfirmOpen.value = true;
};

const confirmLogout = () => {
  playerStore.logout();
  isLogoutConfirmOpen.value = false;
};

onMounted(() => {
  playerStore.startAutoSave();
  fetchStats();
  statsInterval = setInterval(fetchStats, 30000);
});

onUnmounted(() => {
  playerStore.stopAutoSave();
  if (statsInterval) clearInterval(statsInterval);
});

const menuButtons = [
  { name: '地图', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>' },
  { name: '功法', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>' },
  { name: '储物', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>' }, // 暂时用个图标代替
  { name: '角色', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' },
  { name: '成就', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>' },
  { name: '灵宠', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-2.97 7 .41 1.04 1 2.02 1.56 2.85 2.53 3.8-1.41 6.35-4.5 4.73l-3.23-1.68a19 19 0 0 0-2.57 0l-3.23 1.68c-3.09 1.62-7.03-.93-4.5-4.73.56-.83 1.15-1.81 1.56-2.85-2.55 0-4.37-6.42-2.97-7C4.62 2.25 7.87 3.09 9.65 5.09 10.3 4.92 11.33 5 12 5z"/></svg>' },
  { name: '抽奖', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/></svg>' },
  { name: '设置', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>' },
];

const displayMenuButtons = computed(() => {
  const btns = [...menuButtons];
  if (props.player && props.player.role === 'admin') {
    btns.push({ 
      name: 'GM', 
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' 
    });
  }
  return btns;
});
</script>

<style scoped>
@keyframes slide-in {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}
.animate-slide-in {
  animation: slide-in 0.3s ease-out;
}
</style>
