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

          <button v-for="btn in displayMenuButtons" :key="btn.name" @click="handleMenuClick(btn.name)" :class="[
            'w-full flex items-center gap-3 px-4 py-3 text-sm rounded transition-colors border',
            btn.name === 'GM' 
              ? 'bg-gradient-to-r from-purple-900/40 to-pink-900/40 text-pink-300 hover:from-purple-800/60 hover:to-pink-800/60 hover:text-pink-200 border-pink-700/50 hover:border-pink-500 shadow-lg shadow-pink-900/20'
              : 'text-stone-300 hover:bg-[#292524] hover:text-amber-500 border-transparent hover:border-stone-700'
          ]">
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
            重生之凡人修仙传 <span class="text-xs text-stone-500 font-sans font-normal border border-stone-700 px-1.5 py-0.5 rounded bg-[#0c0a09]">{{ currentVersion }}</span>
          </h1>
        </div>
        
        <!-- 桌面端顶部按钮组 -->
        <div class="hidden md:flex items-center gap-2">
          <button v-for="btn in displayMenuButtons" :key="btn.name" @click="handleMenuClick(btn.name)" :class="[
            'flex items-center gap-2 px-3 py-2 rounded transition-all text-sm min-w-[80px] justify-center group border',
            btn.name === 'GM'
              ? 'bg-gradient-to-r from-purple-900/40 to-pink-900/40 hover:from-purple-800/60 hover:to-pink-800/60 text-pink-300 hover:text-pink-200 border-pink-700/50 hover:border-pink-500 shadow-lg shadow-pink-900/20'
              : 'bg-[#292524] hover:bg-[#44403c] border-stone-700 hover:border-stone-500 text-stone-300 hover:text-amber-100'
          ]">
            <span class="group-hover:scale-110 transition-transform" v-html="btn.icon"></span>
            {{ btn.name }}
          </button>
          
          <!-- 退出登录按钮 (仅图标) -->
          <button @click="handleLogoutClick" class="p-2 ml-2 text-stone-500 hover:text-rose-500 transition-colors rounded-full hover:bg-stone-800/50" title="退出登录">
             <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </header>

      <!-- 返回战斗浮动按钮：仅当玩家有进行中战斗且战斗面板未打开时显示
           位置：屏幕底部中央上方（ActionBar 之上），大号红字+脉动动画，确保玩家不会错过 -->
      <button
        v-if="hasActiveBattle && !isCombatOpen"
        @click="handleReturnToBattle"
        class="fixed bottom-24 left-1/2 -translate-x-1/2 z-40 px-6 py-3 rounded-full bg-red-700 hover:bg-red-600 text-white font-bold shadow-2xl shadow-red-900/50 animate-pulse flex items-center gap-2 border-2 border-red-400/50"
        title="您有进行中的战斗，点击返回"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/></svg>
        <span>您有未完成的战斗，点击返回</span>
      </button>

      <!-- 闭关修炼浮动状态条（header 下方，不遮挡内容） -->
      <SeclusionOverlay v-if="isStateSynced && playerStore.player?.is_secluded" />

      <!-- 静思悟道浮动状态条（第三阶段新增：悟道中显示进度与中断按钮） -->
      <MeditationOverlay v-if="isStateSynced && playerStore.player?.is_meditating" />

      <!-- 历练进行中浮动状态条（参考闭关设计，后端权威数据驱动） -->
      <ExploreOverlay v-if="isStateSynced && playerStore.adventureStatus?.is_adventuring" />

      <!-- 赶路移动浮动状态条（header 下方，不遮挡内容） -->
      <MovingOverlay
        :show="movingState.isMoving"
        @complete="handleMoveComplete"
      />

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

    <BreakthroughPortal v-if="playerStore.player" />
    
    <!-- 设置弹窗 -->
    <SettingsModal v-if="isSettingsOpen" @close="isSettingsOpen = false" />
    
    <!-- GM 管理后台 -->
    <AdminPanel v-if="isAdminPanelOpen" @close="isAdminPanelOpen = false" />
    
    <!-- 地图面板 -->
    <MapPanel v-if="isMapOpen" @close="isMapOpen = false" />
    
    <!-- 历练面板 -->
    <ExplorePanel v-if="isExploreOpen" @close="isExploreOpen = false" @combat="handleExploreCombat" />

    <!-- 闭关修炼选择面板（让玩家选择常规/深度闭关） -->
    <SeclusionPanel v-if="isSeclusionOpen" @close="isSeclusionOpen = false" />
    
    <!-- 战斗面板 -->
    <CombatPanel v-if="isCombatOpen" :initialBattleId="currentBattleId ?? undefined" @close="isCombatOpen = false" />
    
    <!-- 角色弹窗 -->
    <CharacterModal v-if="isCharacterOpen" @close="isCharacterOpen = false" />

    <!-- 背包（储物袋）面板 -->
    <InventoryPanel v-if="isInventoryOpen" @close="isInventoryOpen = false" />

    <!-- 宗门面板 -->
    <SectPanel v-if="isSectOpen" @close="isSectOpen = false" />

    <!-- 坊市（万宝楼）面板 -->
    <MarketPanel v-if="isMarketOpen" @close="isMarketOpen = false" />
    <!-- 洞府面板（开辟洞府、升级设施、药园种植） -->
    <CavePanel v-if="isCaveOpen" @close="isCaveOpen = false" />
    <!-- 法宝管理面板（祭炼/本命/祭出/收宝/调序/散念/修理） -->
    <EquipmentPanel v-if="isTreasureOpen" @close="isTreasureOpen = false" />
    <!-- 炼制系统面板（炼丹/炼器、学习配方、技能成长） -->
    <CraftingPanel v-if="isCraftingOpen" @close="isCraftingOpen = false" />

    <!-- 静思悟道面板（第三阶段新增：选择时长、查看瓶颈进度） -->
    <MeditationPanel v-if="isMeditationOpen" @close="isMeditationOpen = false" />

    <!-- PVP 斗法面板（第四阶段新增：段位卡、战斗、排行榜、段位信息） -->
    <PvpPanel v-if="isPvpOpen" @close="isPvpOpen = false" />

    <!-- 聚宝当铺面板（第四阶段新增：典当、赎回、信用额度） -->
    <PawnshopPanel v-if="isPawnshopOpen" @close="isPawnshopOpen = false" />

    <!-- 聚宝股市面板（第四阶段新增：行情、持仓、交易、融资） -->
    <StockPanel v-if="isStockOpen" @close="isStockOpen = false" />
    
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

    <!-- 系统通知弹窗 -->
    <SystemAlert />
  </div>
</template>

<script setup lang="ts">
/**
 * 游戏主布局组件
 * 负责整体页面结构和路由管理
 */
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue';
import { getStats } from '../../api/system';
import { getCombatStatus } from '../../api/combat';
import { currentVersion } from '../../data/changelog';
import { usePlayerStore } from '../../stores/player';
import { useUIStore } from '../../stores/ui';
import { useNotificationStore } from '../../stores/notification';
import PlayerStatus from '../panels/PlayerStatus.vue';
import GameLog from '../panels/GameLog.vue';
import ActionBar from '../panels/ActionBar.vue';
import GlobalChat from '../widgets/GlobalChat.vue';
import BreakthroughPortal from '../widgets/BreakthroughPortal.vue';
import SettingsModal from '../modals/SettingsModal.vue';
import AdminPanel from '../admin/AdminPanel.vue';
import SeclusionOverlay from '../panels/SeclusionOverlay.vue';
import ExploreOverlay from '../panels/ExploreOverlay.vue';
import SeclusionPanel from '../panels/SeclusionPanel.vue';
import MovingOverlay from '../overlays/MovingOverlay.vue';
import MapPanel from '../panels/MapPanel.vue';
import SystemAlert from '../widgets/SystemAlert.vue';
import ExplorePanel from '../panels/ExplorePanel.vue';
import CombatPanel from '../panels/CombatPanel.vue';
import CharacterModal from '../modals/CharacterModal.vue';
import InventoryPanel from '../panels/InventoryPanel.vue';
import SectPanel from '../panels/SectPanel.vue';
import MarketPanel from '../panels/MarketPanel.vue';
import CavePanel from '../panels/CavePanel.vue';
import EquipmentPanel from '../panels/EquipmentPanel.vue';
// 炼制系统面板（炼丹/炼器、学习配方、技能成长）
import CraftingPanel from '../panels/CraftingPanel.vue';
// 静思悟道面板与浮动状态条（第三阶段新增：悟道玩法 + 瓶颈系统）
import MeditationPanel from '../panels/MeditationPanel.vue';
import MeditationOverlay from '../panels/MeditationOverlay.vue';
// PVP 斗法面板（第四阶段新增：玩家段位 + 排行榜 + 进行中战斗）
import PvpPanel from '../panels/PvpPanel.vue';
// 聚宝当铺面板（第四阶段新增：典当、赎回、信用额度）
import PawnshopPanel from '../panels/PawnshopPanel.vue';
// 聚宝股市面板（第四阶段新增：行情、持仓、交易、融资）
import StockPanel from '../panels/StockPanel.vue';

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
const notificationStore = useNotificationStore();
const isMobileMenuOpen = ref(false);
const isSettingsOpen = ref(false);
const isCharacterOpen = ref(false);
const isMapOpen = ref(false);
const isExploreOpen = ref(false)
const isCombatOpen = ref(false)
// 闭关修炼选择面板状态（用于让玩家选择常规/深度闭关模式）
const isSeclusionOpen = ref(false)
// 新增功能面板状态
const isInventoryOpen = ref(false);
const isSectOpen = ref(false);
const isMarketOpen = ref(false);
const isCaveOpen = ref(false);
// 法宝管理面板状态（祭炼/本命/祭出/收宝/调序/散念/修理）
const isTreasureOpen = ref(false);
// 炼制系统面板状态（炼丹/炼器）
const isCraftingOpen = ref(false);
// 静思悟道面板状态（第三阶段新增）
const isMeditationOpen = ref(false);
// PVP 斗法面板状态（第四阶段新增）
const isPvpOpen = ref(false);
// 聚宝当铺面板状态（第四阶段新增）
const isPawnshopOpen = ref(false);
// 聚宝股市面板状态（第四阶段新增：行情、持仓、交易、融资）
const isStockOpen = ref(false);
const currentBattleId = ref<string | null>(null);
const isAdminPanelOpen = ref(false);
const isLogoutConfirmOpen = ref(false);
const onlineCount = ref(0);
const totalPlayers = ref(0);
// 标记是否已完成后端状态同步，防止用 localStorage 旧数据误渲染闭关遮罩
const isStateSynced = ref(false);
// 标记玩家是否有进行中战斗（用于显示"返回战斗"按钮）
// 后端权威判断：调用 /combat/status（不带 battleId）查询是否有 ActiveBattle 记录
const hasActiveBattle = ref(false);
let statsInterval: any = null;

/**
 * 移动状态计算属性
 */
const movingState = computed(() => playerStore.movingState);

/**
 * 移动完成处理
 * 注意：不立即 fetchPlayer，因为后端定时任务可能还没处理完成
 * 后端会通过 Socket 推送 move:completed 事件，由 player store 自动处理刷新
 */
const handleMoveComplete = () => {
  playerStore.clearMovingState();
  uiStore.showToast('已到达目的地', 'success');
};

/**
 * 获取系统统计
 */
const fetchStats = async () => {
  try {
    const res = await getStats();
    const body = res.data;
    if (body && body.data) {
      onlineCount.value = body.data.online ?? 0;
      totalPlayers.value = body.data.total ?? 0;
    }
  } catch (error) {
    console.error('获取统计失败:', error);
  }
};

/**
 * 处理操作栏动作
 */
const handleAction = async (actionId: string) => {
  console.log('ActionBar emitted action:', actionId);
  
  if (actionId === 'cultivate') {
    // 重构后：不再直接开始闭关，而是打开修炼选择面板
    // 让玩家根据自身境界选择常规闭关（normal）或深度闭关（deep）
    isSeclusionOpen.value = true;
    return;
  }
  
  if (actionId === 'explore') {
    isExploreOpen.value = true;
    return;
  }

  // 背包（储物袋）按钮：打开背包面板
  if (actionId === 'inventory') {
    isInventoryOpen.value = true;
    return;
  }

  // 宗门按钮：打开宗门面板
  if (actionId === 'sect') {
    isSectOpen.value = true;
    return;
  }

  // 坊市按钮：打开坊市（万宝楼）面板
  if (actionId === 'market') {
    isMarketOpen.value = true;
    return;
  }

  // 洞府按钮：打开洞府面板（含药园种植）
  if (actionId === 'cave') {
    isCaveOpen.value = true;
    return;
  }

  // 法宝按钮：打开法宝管理面板（祭炼/本命/祭出/收宝/调序/散念/修理）
  if (actionId === 'treasure') {
    isTreasureOpen.value = true;
    return;
  }

  // 炼制按钮：打开炼制面板（炼丹/炼器）
  if (actionId === 'crafting') {
    isCraftingOpen.value = true;
    return;
  }

  // 悟道按钮：打开静思悟道面板（第三阶段新增）
  if (actionId === 'meditation') {
    isMeditationOpen.value = true;
    return;
  }

  // 斗法按钮：打开 PVP 斗法面板（第四阶段新增）
  if (actionId === 'arena') {
    isPvpOpen.value = true;
    return;
  }

  // 当铺按钮：打开聚宝当铺面板（第四阶段新增：典当、赎回、信用额度）
  if (actionId === 'pawnshop') {
    isPawnshopOpen.value = true;
    return;
  }

  // 股市按钮：打开聚宝股市面板（第四阶段新增：行情、持仓、交易、融资）
  if (actionId === 'stock') {
    isStockOpen.value = true;
    return;
  }

  emit('action', actionId);
};

/**
 * 处理历练战斗
 */
const handleExploreCombat = (battleId?: string) => {
  if (battleId) {
    currentBattleId.value = battleId
  }
  isCombatOpen.value = true
}

/**
 * 检查玩家是否有进行中战斗（后端权威判断）
 * 用于显示"返回战斗"按钮，解决战斗中关闭面板后无法恢复入口的问题
 */
const checkActiveBattle = async () => {
  try {
    const res = await getCombatStatus()
    // 后端 /combat/status 不带 battleId 时查询玩家当前 ActiveBattle
    // 返回结构：{ code: 200, in_battle: true, battle_id: "xxx", ... } 或 { in_battle: false }
    const data = res.data?.in_battle ? res.data : (res.data?.data || {})
    if (data.in_battle && data.battle_id) {
      hasActiveBattle.value = true
      currentBattleId.value = data.battle_id
    } else {
      hasActiveBattle.value = false
    }
  } catch (e) {
    // 静默失败，不影响主流程
    console.warn('检查进行中战斗失败:', e)
  }
}

/**
 * 点击"返回战斗"按钮：恢复战斗面板
 */
const handleReturnToBattle = () => {
  isCombatOpen.value = true
  // 打开面板后标记为已处理，避免重复提示
  hasActiveBattle.value = false
}

/**
 * 处理菜单点击
 */
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
  } else if (btnName === '角色') {
    isCharacterOpen.value = true;
    isMobileMenuOpen.value = false;
  } else if (btnName === '储物') {
    // 打开背包（储物袋）面板
    isInventoryOpen.value = true;
    isMobileMenuOpen.value = false;
  } else if (btnName === '宗门') {
    // 打开宗门面板
    isSectOpen.value = true;
    isMobileMenuOpen.value = false;
  } else if (btnName === '坊市') {
    // 打开坊市（万宝楼）面板
    isMarketOpen.value = true;
    isMobileMenuOpen.value = false;
  }
};

/**
 * 处理退出登录点击
 */
const handleLogoutClick = () => {
  isLogoutConfirmOpen.value = true;
};

/**
 * 确认退出登录
 */
const confirmLogout = () => {
  playerStore.logout();
  isLogoutConfirmOpen.value = false;
};

onMounted(async () => {
  // 初始化通知系统的 Socket 监听
  notificationStore.initSocketListeners();
  fetchStats();
  statsInterval = setInterval(fetchStats, 30000);
  // 从后端同步闭关状态，避免 localStorage 缓存的旧状态导致遮罩误显示
  try {
    await playerStore.fetchSeclusionStatus();
    // 同步历练状态，恢复"历练中"浮动状态条（关闭面板/重启浏览器后状态恢复）
    await playerStore.fetchAdventureStatus();
    // 检查是否有进行中战斗（用于显示"返回战斗"按钮）
    await checkActiveBattle();
  } catch (e) {
    console.warn('同步状态失败:', e);
  }
  // 状态同步完成，允许渲染遮罩
  isStateSynced.value = true;
});

onUnmounted(() => {
  if (statsInterval) clearInterval(statsInterval);
});

const menuButtons = [
  { name: '地图', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>' },
  { name: '功法', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>' },
  { name: '储物', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>' },
  { name: '宗门', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/></svg>' },
  { name: '坊市', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2v0a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12v0a2 2 0 0 1-2-2V7"/></svg>' },
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
