<template>
  <div class="flex flex-col md:flex-row h-screen bg-[#0c0a09] text-stone-200 overflow-hidden relative font-sans">
    <!-- 侧边栏 (Desktop) -->
    <aside class="hidden md:flex w-72 flex-col border-r border-stone-800 bg-[#141210]">
      <PlayerStatus v-if="playerStore.player" :player="playerStore.player" />
    </aside>

    <!-- 移动端/窄屏功能抽屉（xl 以上由右坞承担导航） -->
    <div v-if="isMobileMenuOpen" class="fixed inset-0 z-50 xl:hidden flex">
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
                  <img v-if="player.avatar_url && !mobileAvatarFailed" :src="player.avatar_url" alt="Avatar" class="w-full h-full object-cover" @error="mobileAvatarFailed = true">
                  <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full p-1.5 text-stone-500"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
               </div>
               <div>
                 <div class="font-bold text-stone-200">{{ player.name }}</div>
                 <div class="text-xs text-amber-600">{{ player.realm }}</div>
               </div>
             </div>
             <div class="grid grid-cols-2 gap-2 text-xs text-stone-400">
                <div>灵石: <span class="text-stone-200">{{ formatCompact(player.spirit_stones) }}</span></div>
                <div>贡献: <span class="text-stone-200">{{ formatCompact(player.sect_contribution) }}</span></div>
             </div>
          </div>

          <!-- 图标与文案取右坞同一份目录，避免两处清单漂移 -->
          <div v-for="group in mobileMenuGroups" :key="group.key" class="pt-2">
            <div class="px-4 pb-1 text-[10px] text-stone-600 tracking-[0.25em] font-serif">{{ group.label }}</div>
            <button
              v-for="item in group.items"
              :key="item.id"
              @click="handleAction(item.id)"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-sm rounded transition-colors border text-stone-300 hover:bg-[#292524] hover:text-amber-500 border-transparent hover:border-stone-700"
            >
              <span v-html="item.icon"></span>
              {{ item.name }}
            </button>
          </div>

          <button
            v-for="item in systemMenuItems"
            :key="item.id"
            @click="handleAction(item.id)"
            :class="[
              'w-full flex items-center gap-3 px-4 py-3 text-sm rounded transition-colors border',
              item.id === 'gm'
                ? 'bg-gradient-to-r from-purple-900/40 to-pink-900/40 text-pink-300 hover:from-purple-800/60 hover:to-pink-800/60 hover:text-pink-200 border-pink-700/50 hover:border-pink-500 shadow-lg shadow-pink-900/20'
                : 'text-stone-300 hover:bg-[#292524] hover:text-amber-500 border-transparent hover:border-stone-700'
            ]"
          >
            {{ item.name }}
          </button>
        </div>
      </div>
    </div>

    <!-- 主区域 -->
    <main class="flex-1 flex flex-col h-full relative min-w-0 bg-[#0c0a09]">
      <!-- 顶部 Header：功能导航已整体迁入右坞，这里只留标题与系统级入口 -->
      <header class="h-14 bg-[#1c1917] border-b border-stone-800 flex items-center justify-between px-4 shadow-md z-20 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <!-- 窄屏功能菜单按钮 -->
          <button @click="isMobileMenuOpen = true" class="xl:hidden p-2 -ml-2 text-stone-400 hover:text-white rounded active:bg-stone-800 shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
          </button>

          <h1 class="text-xl font-serif font-bold text-amber-500 tracking-wider flex items-center gap-2 truncate">
            重生之凡人修仙传 <span class="text-xs text-stone-500 font-sans font-normal border border-stone-700 px-1.5 py-0.5 rounded bg-[#0c0a09] shrink-0">{{ currentVersion }}</span>
          </h1>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button
            @click="handleAction('settings')"
            class="flex items-center gap-2 px-3 py-2 rounded transition-all text-sm justify-center border bg-[#292524] hover:bg-[#44403c] border-stone-700 hover:border-stone-500 text-stone-300 hover:text-amber-100"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="hidden sm:inline">设置</span>
          </button>

          <button
            v-if="player && player.role === 'admin'"
            @click="handleAction('gm')"
            class="flex items-center gap-2 px-3 py-2 rounded transition-all text-sm justify-center border bg-gradient-to-r from-purple-900/40 to-pink-900/40 hover:from-purple-800/60 hover:to-pink-800/60 text-pink-300 hover:text-pink-200 border-pink-700/50 hover:border-pink-500 shadow-lg shadow-pink-900/20"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span class="hidden sm:inline">GM</span>
          </button>

          <!-- 退出登录按钮 (仅图标) -->
          <button @click="handleLogoutClick" class="p-2 ml-1 text-stone-500 hover:text-rose-500 transition-colors rounded-full hover:bg-stone-800/50" title="退出登录">
             <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </header>

      <!-- 返回战斗浮动按钮：仅当玩家有进行中战斗且战斗面板未打开时显示
           位置：屏幕底部中央（移动端需避开横向滚动的 ActionBar），大号红字+脉动动画，确保玩家不会错过 -->
      <button
        v-if="hasActiveBattle && !isCombatOpen"
        @click="handleReturnToBattle"
        class="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-40 px-6 py-3 rounded-full bg-red-700 hover:bg-red-600 text-white font-bold shadow-2xl shadow-red-900/50 animate-pulse flex items-center gap-2 border-2 border-red-400/50"
        title="您有进行中的战斗，点击返回"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/></svg>
        <span>您有未完成的战斗，点击返回</span>
      </button>

      <!-- 赶路移动浮动状态条（header 下方，不遮挡内容） -->
      <MovingOverlay
        :show="movingState.isMoving"
        @complete="handleMoveComplete"
      />

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
          <!-- 这里可以放战斗视觉层 (CombatVisuals) -->
          <GameLog :logs="logs" />
        </div>

        <FeatureDock :player="playerStore.player" :open-panel-id="openPanel" @action="handleAction">
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

    <!-- 死亡遮罩：玩家 is_dead=true 时全屏覆盖，提供轮回重生入口
         修复 B4：之前死亡无 UI 反馈，玩家完全无感知 -->
    <DeathOverlay v-if="playerStore.player?.is_dead" />

    <!-- 设置弹窗 -->
    <SettingsModal v-if="isSettingsOpen" @close="isSettingsOpen = false" />

    <!-- GM 管理后台 -->
    <AdminPanel v-if="isAdminPanelOpen" @close="isAdminPanelOpen = false" />

    <!-- ============================================================
         功能面板：md 以上由 .panel-shell 停靠进右坞（规则见 style.css），
         窄屏仍是全屏 modal。openPanel 单值保证同时只展开一个。
         ============================================================ -->

    <!-- 地图面板 -->
    <MapPanel v-if="openPanel === 'map'" @close="closePanel()" />

    <!-- 历练面板 -->
    <ExplorePanel v-if="openPanel === 'explore'" @close="closePanel()" @combat="handleExploreCombat" />

    <!-- 闭关修炼选择面板（让玩家选择常规/深度闭关） -->
    <SeclusionPanel v-if="openPanel === 'cultivate'" @close="closePanel()" />

    <!-- 战斗面板 -->
    <CombatPanel v-if="isCombatOpen" :initialBattleId="currentBattleId ?? undefined" @close="closePanel()" />

    <!-- 角色弹窗 -->
    <CharacterModal v-if="openPanel === 'character'" @close="closePanel()" />

    <!-- 背包（储物袋）面板 -->
    <InventoryPanel v-if="openPanel === 'inventory'" @close="closePanel()" />

    <!-- 宗门面板 -->
    <SectPanel v-if="openPanel === 'sect'" @close="closePanel()" />

    <!-- 坊市（万宝楼）面板 -->
    <MarketPanel v-if="openPanel === 'market'" @close="closePanel()" />
    <!-- 洞府面板（开辟洞府、升级设施、药园种植） -->
    <CavePanel v-if="openPanel === 'cave'" @close="closePanel()" />
    <!-- 法宝管理面板（祭炼/本命/祭出/收宝/调序/散念/修理） -->
    <EquipmentPanel v-if="openPanel === 'treasure'" @close="closePanel()" />
    <!-- 炼制系统面板（炼丹/炼器、学习配方、技能成长） -->
    <CraftingPanel v-if="openPanel === 'crafting'" @close="closePanel()" />

    <!-- 功法系统面板（修炼/突破/领悟/装备）
         TechniquePanel 自身是裸内容块、没有遮罩层，这里补上统一 shell，
         否则窄屏会把它当普通块渲染、桌面端也无法停靠。 -->
    <div v-if="openPanel === 'technique'" class="fixed inset-0 z-50 flex items-center justify-center panel-shell" @click.self="closePanel()">
      <div class="absolute inset-0 bg-black/80 backdrop-blur-sm panel-backdrop" @click="closePanel()"></div>
      <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden panel-body">
        <div class="flex items-center justify-between px-4 py-3 border-b border-stone-800 bg-[#1c1917] shrink-0">
          <h2 class="text-base font-bold text-amber-500 tracking-wider font-serif">功法</h2>
          <button @click="closePanel()" class="text-stone-500 hover:text-white text-xl leading-none px-1">✕</button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto p-4">
          <TechniquePanel @close="closePanel()" />
        </div>
      </div>
    </div>

    <!-- 成就系统面板（成就总览 / 奖励领取） -->
    <AchievementPanel v-if="openPanel === 'achievement'" @close="closePanel()" />
    <!-- 抽奖（寻仙机缘）系统面板（单次 / 十连 / 奖池预览） -->
    <LotteryPanel v-if="openPanel === 'lottery'" @close="closePanel()" />

    <!-- 静思悟道面板（第三阶段新增：选择时长、查看瓶颈进度） -->
    <MeditationPanel v-if="openPanel === 'meditation'" @close="closePanel()" />

    <!-- PVP 斗法面板（第四阶段新增：段位卡、战斗、排行榜、段位信息） -->
    <PvpPanel v-if="openPanel === 'arena'" @close="closePanel()" />

    <!-- 悬赏追杀面板（PVP 延伸玩法：发布悬赏/接取追杀/悬赏榜单/我的悬赏） -->
    <BountyPanel v-if="openPanel === 'bounty'" @close="closePanel()" />

    <!-- 洞府社交面板（留言板/访客录/景观布置/游商货品） -->
    <CaveSocialPanel v-if="openPanel === 'cave_social'" @close="closePanel()" />

    <!-- 封神台面板（PVP 镜像排名竞技场：排行榜/挑战/防守/赛季） -->
    <FengshenPanel v-if="openPanel === 'fengshen'" @close="closePanel()" />

    <!-- 器灵面板（法宝器灵养成：唤醒/抚摸/温养/试炼/护主/催发/试炼榜） -->
    <ArtifactSpiritPanel v-if="openPanel === 'artifact_spirit'" @close="closePanel()" />

    <!-- 聚宝当铺面板（第四阶段新增：典当、赎回、信用额度） -->
    <PawnshopPanel v-if="openPanel === 'pawnshop'" @close="closePanel()" />

    <!-- 聚宝股市面板（第四阶段新增：行情、持仓、交易、融资） -->
    <StockPanel v-if="openPanel === 'stock'" @close="closePanel()" />

    <!-- 拍卖竞价面板（玩法文档第27节：竞价博弈，多人经济玩法） -->
    <AuctionPanel v-if="openPanel === 'auction'" @close="closePanel()" />

    <!-- 元婴出窍面板（高阶境界扩展：出窍/归来/问道/法相天地/探寻裂缝/夺舍重生） -->
    <NascentSoulPanel v-if="openPanel === 'nascent_soul'" @close="closePanel()" />

    <!-- 大衍诀修炼面板（玩法文档第23节：5层修炼，神识联动，飞升前置） -->
    <DayanPanel v-if="openPanel === 'dayan'" @close="closePanel()" />

    <!-- 傀儡工坊面板（玩法文档第23节：大衍诀·控傀解锁，制造/出战/护法/淬炼/维修/回收） -->
    <PuppetPanel v-if="openPanel === 'puppet'" @close="closePanel()" />

    <!-- 灵溪垂钓面板（玩法文档第21节：4级钓竿/鱼饵/鱼塘/钓术熟练度/剖鱼机缘/排行榜） -->
    <FishingPanel v-if="openPanel === 'fishing'" @close="closePanel()" />

    <!-- 赌石面板（玩法文档第21节：生成原石/线索博弈/切石机缘/熟练度/排行榜） -->
    <GamblingStonePanel v-if="openPanel === 'gambling_stone'" @close="closePanel()" />

    <!-- 飞升灵界面板（批次3新增：问道/法相天地/探寻裂缝/空间节点/飞升/天机回溯/夺舍重生） -->
    <AscensionPanel v-if="openPanel === 'ascension'" @close="closePanel()" />

    <!-- 第二元神面板（批次3新增：凝练/分化/调度/独立修炼） -->
    <SecondSoulPanel v-if="openPanel === 'second_soul'" @close="closePanel()" />

    <!-- 小世界综合面板（批次3新增：小世界/神庙/香火/神识/法则 5 Tab） -->
    <SmallWorldPanel v-if="openPanel === 'small_world'" @close="closePanel()" />

    <!-- 神识对决面板（1v1 同时选择博弈 PvP） -->
    <DivineSenseDuelPanel v-if="openPanel === 'divine_sense_duel'" @close="closePanel()" />

    <!-- 道侣面板（批次3新增：道侣/双修/心契/心劫 4 Tab） -->
    <CompanionPanel v-if="openPanel === 'companion'" @close="closePanel()" />

    <!-- 侍妾面板（批次3新增：侍妾列表/红尘寻缘/远航/日志 4 Tab） -->
    <ConcubinePanel v-if="openPanel === 'concubine'" @close="closePanel()" />

    <!-- 多人副本面板（批次3新增：副本大厅/我的副本/奖励池/历史记录 4 Tab） -->
    <MultiDungeonPanel v-if="openPanel === 'multi_dungeon'" @close="closePanel()" />

    <!-- 灵兽面板（4阶灵兽/五行相克/捕获/喂养/互动/出战/放生） -->
    <SpiritBeastPanel v-if="openPanel === 'spirit_beast'" @close="closePanel()" />

    <!-- 太一门引道面板（五行道途+神识联动+多人共鸣） -->
    <TaoismGatePanel v-if="openPanel === 'taoism_gate'" @close="closePanel()" />

    <!-- 灵兽探渊面板（异步多人 PVE+PVP 混合探索：探渊状态/开始探渊/排行榜/历史记录 4 Tab） -->
    <BeastAbyssPanel v-if="openPanel === 'beast_abyss'" @close="closePanel()" />

    <!-- 道侣/双修系统面板（玩家间 1v1 长期社交：求婚/双修/心契/心印/心劫） -->
    <DaoCompanionPanel v-if="openPanel === 'dao_companion'" @close="closePanel()" />

    <!-- 世界BOSS面板（批次2多人玩法：3档BOSS、3阶段切换、伤害排行、赛季结算） -->
    <WorldBossPanel v-if="openPanel === 'world_boss'" @close="closePanel()" />

    <!-- 宗门战面板（批次2多人玩法：领地争夺、宣战、攻防、占领、赛季结算） -->
    <SectWarPanel v-if="openPanel === 'sect_war'" @close="closePanel()" />

    <!-- 秘境副本面板（5章节 / 三档难度 / 三星评级 / 扫荡） -->
    <DungeonPanel v-if="openPanel === 'dungeon'" @close="closePanel()" />

    <!-- 阵法系统面板（10大阵法 / 4类×4品阶 / 熟练度 / 相克 / 战力加成） -->
    <FormationPanel v-if="openPanel === 'formation'" @close="closePanel()" />

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
 *
 * 三栏：左角色状态 · 中日志流 · 右坞（分类导航 + 功能面板停靠）
 *
 * 面板开关收敛到单一 openPanel：
 *   原先每个面板一个 isXOpen ref，顶栏与底部操作栏各维护一份 id 映射，
 *   两处会漂移，而且能同时叠开两个 modal。现在 actionId 就是面板标识。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { formatCompact } from '../../utils/format';
import { getStats } from '../../api/system';
import { getCombatStatus } from '../../api/combat';
import { currentVersion } from '../../data/changelog';
import { ACTIONS, DOCK_TABS } from '../../data/actionCatalog';
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
// 功法系统面板（修炼/突破/领悟/装备）
import TechniquePanel from '../panels/TechniquePanel.vue';
// 成就系统面板（成就总览 / 奖励领取）
import AchievementPanel from '../panels/AchievementPanel.vue';
// 抽奖（寻仙机缘）系统面板（单次 / 十连 / 奖池预览）
import LotteryPanel from '../panels/LotteryPanel.vue';
// 静思悟道面板与浮动状态条（第三阶段新增：悟道玩法 + 瓶颈系统）
import MeditationPanel from '../panels/MeditationPanel.vue';
import MeditationOverlay from '../panels/MeditationOverlay.vue';
// 死亡遮罩：玩家寿元耗尽/被击杀时全屏显示死亡画面，提供轮回重生入口
import DeathOverlay from '../overlays/DeathOverlay.vue';
// 元婴出窍面板（高阶境界扩展：出窍/归来/问道/法相天地/探寻裂缝/夺舍重生）
import NascentSoulPanel from '../panels/NascentSoulPanel.vue';
// 飞升灵界面板（批次3新增：问道/法相天地/探寻裂缝/空间节点/飞升/天机回溯/夺舍重生）
import AscensionPanel from '../panels/AscensionPanel.vue';
// 第二元神面板（批次3新增：凝练/分化/调度/独立修炼）
import SecondSoulPanel from '../panels/SecondSoulPanel.vue';
// 小世界综合面板（批次3新增：小世界/神庙/香火/神识/法则 5 Tab）
import SmallWorldPanel from '../panels/SmallWorldPanel.vue';
import DivineSenseDuelPanel from '../panels/DivineSenseDuelPanel.vue';
// 道侣面板（批次3新增：道侣/双修/心契/心劫）
import CompanionPanel from '../panels/CompanionPanel.vue';
// 侍妾面板（批次3新增：侍妾列表/红尘寻缘/远航/日志 4 Tab）
import ConcubinePanel from '../panels/ConcubinePanel.vue';
// 多人副本面板（批次3新增：副本大厅/我的副本/奖励池/历史记录 4 Tab）
import MultiDungeonPanel from '../panels/MultiDungeonPanel.vue';
// 灵兽面板（4阶灵兽/五行相克/捕获/喂养/互动/出战/放生）
import SpiritBeastPanel from '../panels/SpiritBeastPanel.vue';
// 太一门引道面板（五行道途/神识联动/多人共鸣/道途技能/日常任务/排行榜）
import TaoismGatePanel from '../panels/TaoismGatePanel.vue';
// 灵兽探渊面板（异步多人 PVE+PVP 混合探索：探渊状态/开始探渊/排行榜/历史记录 4 Tab）
import BeastAbyssPanel from '../panels/BeastAbyssPanel.vue';
// 道侣/双修系统面板（玩家间 1v1 长期社交：求婚/双修/心契/心印/心劫）
import DaoCompanionPanel from '../panels/DaoCompanionPanel.vue';
// 世界BOSS面板（批次2多人玩法：3档BOSS、3阶段切换、伤害排行、赛季结算）
import WorldBossPanel from '../panels/WorldBossPanel.vue';
// 宗门战面板（批次2多人玩法：领地争夺、宣战、攻防、占领、赛季结算）
import SectWarPanel from '../panels/SectWarPanel.vue';
// 秘境副本面板（5章节×5-7关 / 三档难度 / 三星评级 / 扫荡）
import DungeonPanel from '../panels/DungeonPanel.vue';
// 阵法系统面板（10大阵法 / 4类×4品阶 / 熟练度 / 相克 / 战力加成）
import FormationPanel from '../panels/FormationPanel.vue';
// PVP 斗法面板（第四阶段新增：玩家段位 + 排行榜 + 进行中战斗）
import PvpPanel from '../panels/PvpPanel.vue';
import BountyPanel from '../panels/BountyPanel.vue';
import CaveSocialPanel from '../panels/CaveSocialPanel.vue';
// 封神台面板（PVP 镜像排名竞技场：排行榜/挑战/防守/赛季）
import FengshenPanel from '../panels/FengshenPanel.vue';
// 器灵面板（法宝器灵养成：唤醒/抚摸/温养/试炼/护主/催发/试炼榜）
import ArtifactSpiritPanel from '../panels/ArtifactSpiritPanel.vue';
// 聚宝当铺面板（第四阶段新增：典当、赎回、信用额度）
import PawnshopPanel from '../panels/PawnshopPanel.vue';
// 聚宝股市面板（第四阶段新增：行情、持仓、交易、融资）
import StockPanel from '../panels/StockPanel.vue';
import AuctionPanel from '../panels/AuctionPanel.vue';
// 大衍诀修炼面板（玩法文档第23节：5层修炼，神识联动，飞升前置）
import DayanPanel from '../panels/DayanPanel.vue';
// 傀儡工坊面板（玩法文档第23节：大衍诀·控傀解锁，制造/出战/护法/淬炼/维修/回收）
import PuppetPanel from '../panels/PuppetPanel.vue';
// 灵溪垂钓面板（玩法文档第21节：4级钓竿/鱼饵/鱼塘/钓术熟练度/剖鱼机缘/排行榜）
import FishingPanel from '../panels/FishingPanel.vue';
import GamblingStonePanel from '../panels/GamblingStonePanel.vue';

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
const isAdminPanelOpen = ref(false);
const isLogoutConfirmOpen = ref(false);
const currentBattleId = ref<string | null>(null);

// 移动端抽屉里的 QQ 头像加载失败时回退默认图标；换头像后重置，避免新头像被旧失败状态挡掉
const mobileAvatarFailed = ref(false);
watch(() => props.player?.avatar_url, () => { mobileAvatarFailed.value = false; });

/**
 * 当前展开的功能面板 id；null 表示右坞显示总览 / 分类卡片。
 * 设置与 GM 后台是系统级 modal，不占用这个槽位。
 */
const openPanel = ref<string | null>(null);
const closePanel = () => { openPanel.value = null; };
const isCombatOpen = computed(() => openPanel.value === 'combat');

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
const onlineCount = ref(0);
const totalPlayers = ref(0);
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
 * 统一入口路由：右坞卡片、移动端操作条、移动抽屉都只发 actionId。
 * 原先 40 多个 if 分支各自 set 一个 ref，现在 actionId 即面板标识。
 */
const handleAction = (actionId: string) => {
  isMobileMenuOpen.value = false;
  if (actionId === 'menu') { isMobileMenuOpen.value = true; return; }
  if (actionId === 'settings') { isSettingsOpen.value = true; return; }
  if (actionId === 'gm') { isAdminPanelOpen.value = true; return; }
  openPanel.value = actionId;
  emit('action', actionId);
};

/**
 * 处理历练战斗
 */
const handleExploreCombat = (battleId?: string) => {
  if (battleId) {
    currentBattleId.value = battleId
  }
  openPanel.value = 'combat'
}

/**
 * 检查玩家是否有进行中战斗（后端权威判断）
 * 用于显示"返回战斗"按钮，解决战斗中关闭面板后无法恢复入口的问题
 */
const hasActiveBattle = ref(false);
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
  openPanel.value = 'combat'
  // 打开面板后标记为已处理，避免重复提示
  hasActiveBattle.value = false
}

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

// 标记是否已完成后端状态同步，防止用 localStorage 旧数据误渲染闭关遮罩
const isStateSynced = ref(false);
let statsInterval: any = null;

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
const systemMenuItems = computed(() => {
  const items: { id: string; name: string }[] = [{ id: 'settings', name: '设置' }];
  if (props.player && props.player.role === 'admin') items.push({ id: 'gm', name: 'GM' });
  return items;
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
