<template>
  <div class="flex flex-col md:flex-row h-screen bg-surface-canvas text-fg-primary overflow-hidden relative font-sans">
    <!-- 侧边栏 (Desktop) -->
    <aside class="hidden md:flex w-72 flex-col border-r border-line-subtle bg-surface-base">
      <PlayerStatus
        v-if="playerStore.player"
        :player="playerStore.player"
        :map-name="playerStore.worldState?.map_name || ''"
        :synced="isStateSynced"
        @action="handleAction"
      />
    </aside>

    <!-- 移动端/窄屏功能抽屉（xl 以上由右坞承担导航） -->
    <div v-if="isMobileMenuOpen" class="fixed inset-0 z-companion xl:hidden flex">
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="isMobileMenuOpen = false"></div>
      <div class="relative w-64 h-full bg-surface-base border-r border-line-subtle flex flex-col shadow-2xl animate-slide-in">
        <div class="p-4 border-b border-line-subtle flex justify-between items-center bg-surface-canvas">
          <span class="font-bold text-lg text-gold-500 font-display">功能菜单</span>
          <button @click="isMobileMenuOpen = false" class="text-fg-muted hover:text-fg-primary" aria-label="关闭菜单">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-2 space-y-2">
          <div class="bg-surface-raised rounded p-3 mb-4 border border-line-subtle">
             <div class="flex items-center gap-3 mb-2">
                <div class="w-10 h-10 rounded bg-surface-hover border border-line overflow-hidden shrink-0" @contextmenu="onAvatarContextMenu">
                   <img v-if="player.avatar_url && !mobileAvatarFailed" :src="player.avatar_url" alt="Avatar" class="w-full h-full object-cover" @error="mobileAvatarFailed = true">
                   <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full p-1.5 text-fg-faint"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
               <div class="min-w-0">
                 <div class="font-bold text-fg-primary truncate">{{ player.name }}</div>
                 <div class="text-xs text-gold-600">{{ player.realm }}</div>
               </div>
             </div>
             <div class="grid grid-cols-2 gap-2 text-xs text-fg-muted">
                <div>灵石: <span class="text-fg-secondary num">{{ formatCompact(player.spirit_stones) }}</span></div>
                <div>贡献: <span class="text-fg-secondary num">{{ formatCompact(player.sect_contribution) }}</span></div>
             </div>
          </div>

          <!-- 图标与文案取右坞同一份目录，避免两处清单漂移 -->
          <div v-for="group in mobileMenuGroups" :key="group.key" class="pt-2">
            <div class="px-4 pb-1 text-[10px] text-fg-faint tracking-[0.25em] font-display">{{ group.label }}</div>
            <button
              v-for="item in group.items"
              :key="item.id"
              @click="handleAction(item.id)"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-sm rounded transition-colors border text-fg-secondary hover:bg-surface-hover hover:text-gold-500 border-transparent hover:border-line"
            >
              <span v-html="item.icon"></span>
              {{ item.name }}
            </button>
          </div>

          <button
            v-for="item in systemMenuItems"
            :key="item.id"
            @click="handleAction(item.id)"
            class="w-full flex items-center gap-3 px-4 py-3 text-sm rounded transition-colors border text-fg-secondary hover:bg-surface-hover hover:text-gold-500 border-transparent hover:border-line"
          >
            {{ item.name }}
          </button>
        </div>
      </div>
    </div>

    <!-- 主区域 -->
    <main class="flex-1 flex flex-col h-full relative min-w-0 bg-surface-canvas">
      <!-- 顶部 Header：玩法导航已整体迁入右坞，这里只留标题与系统级入口 -->
      <header class="h-14 bg-surface-raised border-b border-line-subtle flex items-center justify-between px-4 shadow-md z-nav shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <!-- 窄屏功能菜单按钮 -->
          <button @click="isMobileMenuOpen = true" class="xl:hidden p-2 -ml-2 text-fg-muted hover:text-fg-primary rounded active:bg-surface-hover shrink-0" aria-label="打开功能菜单">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
          </button>

          <h1 class="text-xl font-display font-bold text-gold-500 tracking-wider flex items-center gap-2 truncate">
            重生之凡人修仙传 <span class="text-xs text-fg-faint font-sans font-normal border border-line px-1.5 py-0.5 rounded bg-surface-canvas shrink-0">{{ currentVersion }}</span>
          </h1>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <AppButton size="sm" @click="handleAction('settings')">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="hidden sm:inline">设置</span>
          </AppButton>

          <button @click="handleLogoutClick" class="p-2 ml-1 text-fg-faint hover:text-rose-500 transition-colors rounded-full hover:bg-surface-hover/50" title="退出登录" aria-label="退出登录">
             <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </header>

      <!-- 返回战斗：仅当后端确认有进行中战斗且战斗面板未打开。
           移动端底部有横向滚动的 ActionBar，按钮上移避开，桌面端贴底居中。 -->
      <button
        v-if="playerStore.activeBattleId && !isCombatOpen"
        @click="handleReturnToBattle"
        class="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-floating px-6 py-3 rounded-full bg-red-700 hover:bg-red-600 text-white font-bold shadow-2xl shadow-red-900/50 animate-pulse flex items-center gap-2 border-2 border-red-400/50"
        title="您有进行中的战斗，点击返回"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/></svg>
        <span>您有未完成的战斗，点击返回</span>
      </button>

      <!-- 赶路移动浮动状态条（header 下方，不遮挡内容） -->
      <MovingOverlay :show="movingState.isMoving" @complete="handleMoveComplete" />

      <!-- 中部三栏：【日志窄栏】+【右坞：分类导航 / 功能面板停靠】
           xl 以下放不下三栏，日志独占宽度、导航退回底部操作条 -->
      <div class="flex-1 flex flex-col xl:flex-row overflow-hidden relative min-h-0">
        <div class="w-full xl:w-[560px] 2xl:w-[680px] shrink-0 flex flex-col overflow-hidden relative min-w-0">
          <!-- 窄阅读栏之外的留白用灵尘氛围层填充，避免读作渲染缺陷 -->
          <div class="absolute inset-0 pointer-events-none overflow-hidden">
            <div class="absolute inset-0 bg-[radial-gradient(90%_70%_at_72%_18%,rgba(56,189,248,0.05),transparent_65%)]"></div>
            <div class="absolute w-2 h-2 bg-emerald-500/25 rounded-full blur-[1px] animate-float top-1/3 left-[64%]"></div>
            <div class="absolute w-3 h-3 bg-cyan-500/15 rounded-full blur-[2px] animate-float top-2/3 left-[78%]" style="animation-duration: 9s; animation-delay: 1.2s;"></div>
            <div class="absolute w-1 h-1 bg-amber-500/35 rounded-full animate-float top-1/2 left-[88%]" style="animation-duration: 6s; animation-delay: 2.4s;"></div>
            <div class="absolute w-4 h-4 bg-purple-500/10 rounded-full blur-[3px] animate-float top-1/4 left-[94%]" style="animation-duration: 11s; animation-delay: 0.6s;"></div>
          </div>
          <GameLog />
        </div>

        <FeatureDock :player="playerStore.player" :open-panel-id="openPanel" @action="handleAction" @close-panel="dismissPanel">
          <!-- 闭关 / 悟道 / 历练 进度条收进总览的状态卡，不再各占一条 header 下方的横条 -->
          <template #status>
            <SeclusionOverlay v-if="isStateSynced && playerStore.player?.is_secluded" />
            <MeditationOverlay v-if="isStateSynced && playerStore.player?.is_meditating" />
            <ExploreOverlay v-if="isStateSynced && playerStore.adventureStatus?.is_adventuring" />
          </template>
        </FeatureDock>
      </div>

      <!-- 移动端底部操作条（桌面端导航由右坞承担） -->
      <ActionBar :player="playerStore.player" @action="handleAction" />
    </main>

    <!-- 全局聊天组件 -->
    <GlobalChat />

    <BreakthroughPortal v-if="playerStore.player" />

    <!-- ============================================================
         功能面板：openPanel 经 panels/registry.js 解析成异步组件。
         md 以上由 .panel-shell 停靠进右坞（规则见 style.css），
         窄屏仍是全屏 modal。:key 保证换面板时整块重挂，
         避免上一个面板的局部状态（页签 / 筛选 / 滚动位置）残留。
         PanelBoundary 兜住面板渲染期异常：单个面板崩不影响状态栏/日志/右坞。
         ============================================================ -->
    <PanelBoundary
      v-if="activePanel"
      :key="openPanel"
      :label="ACTIONS[openPanel]?.name || openPanel"
      @close="closePanel"
    >
      <component
        :is="activePanel"
        v-on="panelEvents"
        @close="closePanel"
      />
    </PanelBoundary>

    <!-- ============================================================
         系统层：设置 / GM 后台 / 死亡遮罩 / 系统公告。
         刻意排在功能面板之后 —— 层级(z-system)和 DOM 顺序必须同向。
         之前它们与面板同为 z-50 且 DeathOverlay 写在面板前面，
         于是「开着面板时死亡遮罩被盖住」，玩家死了还能继续操作面板。
         ============================================================ -->
    <DeathOverlay v-if="playerStore.player?.is_dead" />
    <SettingsModal v-if="isSettingsOpen" @close="isSettingsOpen = false" />
    <AdminPanel v-if="isAdminPanelOpen" @close="isAdminPanelOpen = false" />
    <SystemAlert />

    <!-- 退出确认弹窗 -->
    <div v-if="isLogoutConfirmOpen" class="fixed inset-0 z-dialog flex items-center justify-center">
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="isLogoutConfirmOpen = false"></div>
      <div class="relative bg-surface-raised border border-line-subtle rounded-panel p-6 max-w-sm w-full mx-4 shadow-2xl">
        <h3 class="text-lg font-bold text-fg-primary mb-2 font-display">退出登录</h3>
        <p class="text-fg-muted mb-6">确定要退出当前的修仙之路吗？未保存的进度可能会丢失。</p>
        <div class="flex justify-end gap-3">
          <AppButton variant="outline" @click="isLogoutConfirmOpen = false">取消</AppButton>
          <AppButton variant="danger" @click="confirmLogout">确认退出</AppButton>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
/**
 * 游戏主布局
 *
 * 三栏：左角色状态 · 中日志流 · 右坞（分类导航 + 功能面板停靠）
 *
 * 面板开关收敛到单一 openPanel + panels/registry.js：
 *   actionId 就是面板标识，本文件不再认识任何具体玩法组件。
 *   原先 43 个静态 import + 43 条 v-if 让首屏必须下载全部玩法代码
 *   （实测单 chunk 1.79 MB / gzip 478 KB），现在新增一个玩法
 *   只在 actionCatalog 和 registry 各加一条，组件按需下载。
 */
import { ref, computed, watch, onMounted, defineAsyncComponent } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { panelRoute } from '../../router';
import { formatCompact } from '../../utils/format';
import { currentVersion } from '../../data/changelog';
import { DOCK_TABS, ACTIONS } from '../../data/actionCatalog';
import { resolvePanel } from '../panels/registry';
import { usePlayerStore } from '../../stores/player';
import { useUIStore } from '../../stores/ui';
import { useNotificationStore } from '../../stores/notification';
import PlayerStatus from '../panels/PlayerStatus.vue';
import GameLog from '../panels/GameLog.vue';
import ActionBar from '../panels/ActionBar.vue';
import FeatureDock from '../dock/FeatureDock.vue';
import GlobalChat from '../widgets/GlobalChat.vue';
import BreakthroughPortal from '../widgets/BreakthroughPortal.vue';
import SettingsModal from '../modals/SettingsModal.vue';
import SeclusionOverlay from '../panels/SeclusionOverlay.vue';
import ExploreOverlay from '../panels/ExploreOverlay.vue';
import MeditationOverlay from '../panels/MeditationOverlay.vue';
import MovingOverlay from '../overlays/MovingOverlay.vue';
import DeathOverlay from '../overlays/DeathOverlay.vue';
import SystemAlert from '../widgets/SystemAlert.vue';
import AppButton from '../ui/AppButton.vue';
import PanelBoundary from '../ui/PanelBoundary.vue';

// GM 后台连同 23 个管理子页只在玩家是 admin 并主动点开时才用得上，
// 静态 import 会让每个普通玩家的首屏都背上整块后台代码。
const AdminPanel = defineAsyncComponent(() => import('../admin/AdminPanel.vue'));

const props = defineProps({
  player: { type: Object, default: null },
});

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const uiStore = useUIStore();
const notificationStore = useNotificationStore();

const isMobileMenuOpen = ref(false);
const isSettingsOpen = ref(false);
const isAdminPanelOpen = ref(false);
const isLogoutConfirmOpen = ref(false);

// 移动端抽屉里的 QQ 头像加载失败时回退默认图标；换头像后重置，避免新头像被旧失败状态挡掉
const mobileAvatarFailed = ref(false);
watch(() => props.player?.avatar_url, () => { mobileAvatarFailed.value = false; });

/**
 * 当前展开的功能面板 id：唯一事实来源是路由（/p/<panelId>），
 * 这里只读不写 —— 所有开合都走 goPanel/closePanel 改地址。
 * null 表示右坞显示总览 / 分类卡片。
 *
 * 于是浏览器后退收起面板而不是退出游戏，F5 之后还停在同一个面板上。
 */
const openPanel = computed(() => (route.name === 'panel' ? route.params.panelId : null));
const activePanel = computed(() => resolvePanel(openPanel.value));
const isCombatOpen = computed(() => openPanel.value === 'combat');

/** 换面板：同 id 不重复推入，否则后退栈里会攒出一串一样的条目 */
const goPanel = (actionId) => {
  if (openPanel.value === actionId) return;
  router.push(panelRoute(actionId));
};

const closePanel = () => {
  if (!openPanel.value) return;
  // 有站内历史就后退，让「关闭」和用户的直觉一致（后退键做的事一样）；
  // 直接深链进来的（没有上一条）才 replace 回总览。
  if (router.options.history.state.back) router.back();
  else router.replace(panelRoute(null));
};

/**
 * 切分类页签时收起面板。用 replace 而不是 back：
 * 历史里可能堆着上一个面板（储物袋 → 角色），back 会退回那个面板而不是分类卡片。
 */
const dismissPanel = () => {
  if (!openPanel.value) return;
  router.replace(panelRoute(null));
};

// 地址里写了一个不认识的面板 id（旧书签、手改 hash）：提示后回总览，
// 不要留一个空白坞面。
watch(openPanel, (id) => {
  if (id && !resolvePanel(id)) {
    uiStore.showToast(`「${ACTIONS[id]?.name || id}」暂未开放`, 'warning');
    router.replace(panelRoute(null));
  }
}, { immediate: true });

/**
 * 少数面板会往外抛导航意图（历练遭遇怪物 → 切进战斗面板）。
 * 注册表只管「id 对应哪个组件」，这类跨面板跳转留在这里；
 * 新增面板若不发特殊事件就不用碰本文件。
 */
const PANEL_EVENTS = {
  explore: {
    combat: (battleId) => {
      if (battleId) playerStore.setActiveBattle(battleId);
      goPanel('combat');
    },
  },
};
const panelEvents = computed(() => PANEL_EVENTS[openPanel.value] || {});

const movingState = computed(() => playerStore.movingState);

/**
 * 移动完成：不立即 fetchPlayer，后端定时任务可能还没处理完，
 * 结果由 Socket 的 move:completed 事件推回来。
 */
const handleMoveComplete = () => {
  playerStore.clearMovingState();
  uiStore.showToast('已到达目的地', 'success');
};

/**
 * 统一入口路由：右坞卡片、移动端操作条、移动抽屉都只发 actionId。
 */
const handleAction = (actionId) => {
  isMobileMenuOpen.value = false;
  if (actionId === 'menu') { isMobileMenuOpen.value = true; return; }
  if (actionId === 'settings') { isSettingsOpen.value = true; return; }
  if (actionId === 'gm') {
    // 后端 adminCheck 会再拦一层；前端只放行 admin，避免普通玩家误触
    if (props.player?.role !== 'admin') return;
    isAdminPanelOpen.value = true;
    return;
  }
  if (!resolvePanel(actionId)) {
    uiStore.showToast(`「${ACTIONS[actionId]?.name || actionId}」暂未开放`, 'warning');
    return;
  }
  goPanel(actionId);
};

/** 头像右键：仅 admin 打开 GM 后台，其他情况放行浏览器默认菜单 */
const onAvatarContextMenu = (event) => {
  if (props.player?.role !== 'admin') return;
  event.preventDefault();
  isMobileMenuOpen.value = false;
  isAdminPanelOpen.value = true;
};

const handleReturnToBattle = () => goPanel('combat');

const handleLogoutClick = () => {
  isLogoutConfirmOpen.value = true;
};

const confirmLogout = () => {
  playerStore.logout();
  isLogoutConfirmOpen.value = false;
};

/**
 * 移动端抽屉菜单：按右坞同一套分类列出全部功能
 */
const mobileMenuGroups = computed(() =>
  DOCK_TABS.map(tab => ({
    key: tab.key,
    label: tab.label,
    items: tab.ids.map(id => ({ id, name: ACTIONS[id].name, icon: ACTIONS[id].icon }))
  }))
);
// GM 入口不进任何菜单：admin 右键自己的头像进入（见 PlayerStatus / 抽屉头像）
const systemMenuItems = computed(() => [{ id: 'settings', name: '设置' }]);

// 等后端状态同步回来再渲染遮罩，否则会用 localStorage 的旧状态误显示闭关
const isStateSynced = ref(false);

onMounted(async () => {
  notificationStore.initSocketListeners();
  try {
    await playerStore.fetchSeclusionStatus();
    await playerStore.fetchAdventureStatus();
    await playerStore.syncActiveBattle();
    // 侧栏「位置」读的是 worldState.map_name，不拉一次就永远显示未知区域
    await playerStore.fetchWorldState();
  } catch (e) {
    console.warn('同步状态失败:', e);
  }
  isStateSynced.value = true;
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
