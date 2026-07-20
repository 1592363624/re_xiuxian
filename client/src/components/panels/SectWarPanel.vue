/**
 * 宗门战面板组件
 *
 * 弹窗式组件，展示宗门战/领地争夺系统的资源点/战役/排行。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 战役状态机：preparing → announced → active → settled
 *   - 占领计时30秒，阵亡复活60秒，宣战消耗5000灵石
 *   - 颜色风格：宗门战混合金戈铁马与神秘感，用 amber-400 + violet-400
 *
 * 数据来源：
 *   - getCurrentSeason()：当前赛季
 *   - getTerritories()：9个资源点动态信息
 *   - getMySectInfo()：我的宗门战信息
 *   - getWarList() / getWarDetail()：战役列表与详情
 *   - declareWar/joinWar/leaveWar/attackPlayer/captureTerritory/surrender：战役操作
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- 遮罩层：点击关闭面板 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>

    <!-- 主容器 -->
    <div class="relative bg-[#141210] border border-amber-900/40 rounded-lg w-full max-w-5xl h-[88vh] flex flex-col shadow-2xl shadow-amber-900/20 overflow-hidden animate-fade-in">
      <!-- 顶部标题栏 -->
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-gradient-to-r from-[#1c1917] to-[#292524]">
        <h2 class="text-xl font-bold flex items-center gap-2 bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-violet-400">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.5 17.5L3 6V3h3l11.5 11.5"/>
            <path d="M13 19l6-6"/>
            <path d="M16 16l4 4"/>
            <path d="M19 21l2-2"/>
            <path d="M2 22l3-3"/>
          </svg>
          宗门战役 · 九州烽烟
        </h2>
        <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors" aria-label="关闭面板">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 赛季信息条 -->
      <div v-if="season" class="px-4 py-2 border-b border-stone-800 bg-[#0c0a09]/60 text-xs flex items-center justify-between flex-wrap gap-2">
        <div class="flex items-center gap-3 text-stone-400">
          <span class="text-amber-400 font-bold">{{ season.season_name }}</span>
          <span>·</span>
          <span>赛季ID #{{ season.id }}</span>
          <span>·</span>
          <span>{{ formatDate(season.start_date) }} ~ {{ formatDate(season.end_date) }}</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-stone-400">累计战役 <span class="text-violet-300 font-bold">{{ season.total_wars }}</span></span>
          <span v-if="season.status === 'active'" class="px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-700/50">进行中</span>
          <span v-else-if="season.status === 'pending'" class="px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-700/50">待开启</span>
          <span v-else class="px-2 py-0.5 rounded bg-stone-800 text-stone-400 border border-stone-700">已结束</span>
        </div>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex items-center gap-1 px-3 py-2 border-b border-stone-800 bg-[#0c0a09]">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          @click="switchTab(tab.key)"
          class="px-4 py-1.5 rounded text-sm whitespace-nowrap transition-colors flex items-center gap-1.5"
          :class="activeTab === tab.key
            ? 'bg-gradient-to-r from-amber-900/30 to-violet-900/30 text-amber-300 border border-amber-700/50'
            : 'text-stone-500 hover:text-stone-300 border border-transparent'"
        >
          <span>{{ tab.label }}</span>
          <span v-if="tab.badge" class="text-xs px-1.5 py-0.5 rounded bg-rose-900/60 text-rose-300">{{ tab.badge }}</span>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto p-4 custom-scrollbar">
        <!-- 全局加载中 -->
        <div v-if="loading && !season" class="flex flex-col items-center justify-center h-64 text-stone-500">
          <svg class="animate-spin h-10 w-10 text-amber-500 mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <div class="text-sm">正在查阅九州烽烟录...</div>
        </div>

        <template v-else>
          <!-- ====== Tab1: 资源点 ====== -->
          <div v-if="activeTab === 'territories'" class="space-y-4">
            <div class="flex items-center justify-between flex-wrap gap-2">
              <div class="text-sm text-stone-400">九州九宫格 · 共 <span class="text-amber-300 font-bold">{{ territories.length }}</span> 处资源点</div>
              <button @click="fetchTerritories" :disabled="territoryLoading"
                class="text-xs text-stone-400 hover:text-amber-300 transition-colors disabled:opacity-50">
                {{ territoryLoading ? '刷新中...' : '刷新资源点' }}
              </button>
            </div>

            <!-- 3x3 九宫格 -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div
                v-for="t in sortedTerritories"
                :key="t.territory_key"
                class="relative border rounded-lg p-3 transition-all duration-300"
                :class="getTerritoryCardClass(t)"
              >
                <!-- 正在被攻击时的红色脉冲指示 -->
                <div v-if="t.is_under_attack" class="absolute -top-1 -right-1 flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-900/80 border border-rose-500 text-rose-200 text-xs animate-pulse">
                  <span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
                  交战中
                </div>

                <!-- 名称与类型 -->
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-lg" :class="getTerritoryIconColor(t.territory_type)">{{ getTerritoryIcon(t.territory_type) }}</span>
                  <div class="flex-1">
                    <div class="text-sm font-bold text-stone-100">{{ t.territory_name }}</div>
                    <div class="text-xs text-stone-500">{{ getTerritoryTypeName(t.territory_type) }}</div>
                  </div>
                </div>

                <!-- 归属宗门 -->
                <div class="text-xs mb-2">
                  <span class="text-stone-500">归属：</span>
                  <span v-if="t.owner_sect_name" class="text-amber-300 font-bold">{{ t.owner_sect_name }}</span>
                  <span v-else class="text-stone-600">无主之地</span>
                </div>

                <!-- 产出与防御 -->
                <div class="grid grid-cols-2 gap-2 text-xs mb-2">
                  <div class="bg-[#0c0a09]/60 rounded p-1.5">
                    <div class="text-stone-500">日产出</div>
                    <div class="font-bold" :class="getProductionColor(t.production_type)">
                      {{ formatProduction(t) }}
                    </div>
                  </div>
                  <div class="bg-[#0c0a09]/60 rounded p-1.5">
                    <div class="text-stone-500">防御等级</div>
                    <div class="font-bold text-violet-300">Lv.{{ t.defense_level }}</div>
                  </div>
                </div>

                <!-- 防守阵法 -->
                <div v-if="t.defense_formation" class="text-xs text-stone-500 mb-2">
                  阵法：<span class="text-violet-300">{{ t.defense_formation }}</span>
                </div>

                <!-- 描述 -->
                <div class="text-xs text-stone-500 leading-relaxed border-t border-stone-800 pt-2">
                  {{ t.description || '暂无描述' }}
                </div>

                <!-- 占领时间 -->
                <div v-if="t.owner_since" class="text-xs text-stone-600 mt-2">
                  占领自 {{ formatDate(t.owner_since) }}
                </div>
              </div>
            </div>

            <div v-if="territories.length === 0" class="text-center text-stone-500 py-12 text-sm">
              暂无资源点数据
            </div>
          </div>

          <!-- ====== Tab2: 我的宗门 ====== -->
          <div v-else-if="activeTab === 'mysect'" class="space-y-4">
            <div v-if="!mySectInfo" class="text-center text-stone-500 py-12 text-sm">
              你尚未加入任何宗门，无法参与宗门战。
            </div>
            <template v-else>
              <!-- 宗门信息卡 -->
              <div class="bg-gradient-to-br from-amber-950/30 to-[#292524] border border-amber-800/40 rounded-lg p-4">
                <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
                  <div class="flex items-center gap-3">
                    <div class="w-12 h-12 rounded-full bg-amber-900/40 border border-amber-600/50 flex items-center justify-center text-2xl">⚔</div>
                    <div>
                      <div class="text-lg font-bold text-amber-300">{{ mySectInfo.sect_name }}</div>
                      <div class="text-xs text-stone-400">
                        身份：<span class="text-violet-300 font-bold">{{ getRoleName(mySectInfo.role) }}</span>
                        <span v-if="mySectInfo.is_leader" class="ml-1 px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 text-xs">宗主</span>
                      </div>
                    </div>
                  </div>
                  <button
                    v-if="mySectInfo.is_leader && season?.status === 'active'"
                    @click="openDeclareWarModal"
                    class="px-3 py-1.5 text-sm font-bold rounded bg-gradient-to-r from-amber-700 to-violet-700 text-white hover:from-amber-600 hover:to-violet-600 transition-all border border-amber-500/50"
                  >
                    宣战出师
                  </button>
                </div>

                <!-- 资金与战绩 -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div class="bg-[#0c0a09]/60 rounded p-2">
                    <div class="text-xs text-stone-500">宗门资金</div>
                    <div class="font-bold text-amber-300">{{ formatNumber(mySectInfo.fund.fund_balance) }}</div>
                  </div>
                  <div class="bg-[#0c0a09]/60 rounded p-2">
                    <div class="text-xs text-stone-500">成员数</div>
                    <div class="font-bold text-stone-200">{{ mySectInfo.member_count }}</div>
                  </div>
                  <div class="bg-[#0c0a09]/60 rounded p-2">
                    <div class="text-xs text-stone-500">赛季战绩</div>
                    <div class="font-bold text-violet-300">{{ mySectInfo.fund.season_war_score }} 分</div>
                  </div>
                  <div class="bg-[#0c0a09]/60 rounded p-2">
                    <div class="text-xs text-stone-500">占领资源点</div>
                    <div class="font-bold text-emerald-300">{{ mySectInfo.fund.territories_count }} 处</div>
                  </div>
                </div>
              </div>

              <!-- 已占领资源点 -->
              <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
                <div class="text-sm font-bold text-amber-300 mb-2">我宗占领的资源点</div>
                <div v-if="mySectInfo.owned_territories.length === 0" class="text-xs text-stone-500 py-3 text-center">
                  暂未占领任何资源点
                </div>
                <ul v-else class="space-y-1.5">
                  <li
                    v-for="t in mySectInfo.owned_territories"
                    :key="t.territory_key"
                    class="flex items-center justify-between px-2 py-1.5 rounded bg-[#0c0a09]/60 text-xs"
                  >
                    <div class="flex items-center gap-2">
                      <span :class="getTerritoryIconColor(t.territory_type)">{{ getTerritoryIcon(t.territory_type) }}</span>
                      <span class="text-stone-200 font-bold">{{ t.territory_name }}</span>
                      <span class="text-stone-500">{{ getTerritoryTypeName(t.territory_type) }}</span>
                    </div>
                    <div class="text-stone-400">
                      日产 <span :class="getProductionColor(t.production_type)">{{ formatProduction(t) }}</span>
                    </div>
                  </li>
                </ul>
              </div>

              <!-- 进行中战役 -->
              <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
                <div class="text-sm font-bold text-violet-300 mb-2">我宗进行中的战役</div>
                <div v-if="!mySectInfo.ongoing_wars || mySectInfo.ongoing_wars.length === 0" class="text-xs text-stone-500 py-3 text-center">
                  暂无进行中的战役
                </div>
                <ul v-else class="space-y-2">
                  <li
                    v-for="w in mySectInfo.ongoing_wars"
                    :key="w.id"
                    class="px-3 py-2 rounded bg-[#0c0a09]/60 border border-stone-800 cursor-pointer hover:border-amber-700/50 transition-colors"
                    @click="openWarDetail(w.id)"
                  >
                    <div class="flex items-center justify-between text-xs">
                      <div class="flex items-center gap-2">
                        <span class="text-amber-300">{{ w.attacker_sect_name }}</span>
                        <span class="text-stone-500">VS</span>
                        <span class="text-violet-300">{{ w.defender_sect_name }}</span>
                      </div>
                      <span class="px-1.5 py-0.5 rounded text-xs" :class="getWarStatusClass(w.status)">
                        {{ getWarStatusName(w.status) }}
                      </span>
                    </div>
                  </li>
                </ul>
              </div>
            </template>
          </div>

          <!-- ====== Tab3: 战役 ====== -->
          <div v-else-if="activeTab === 'wars'" class="space-y-4">
            <!-- 战役详情视图 -->
            <template v-if="warDetail">
              <div class="flex items-center justify-between">
                <button @click="closeWarDetail" class="text-xs text-stone-400 hover:text-amber-300 flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>
                  </svg>
                  返回战役列表
                </button>
                <button @click="refreshWarDetail" :disabled="warDetailLoading"
                  class="text-xs text-stone-400 hover:text-amber-300 disabled:opacity-50">
                  {{ warDetailLoading ? '刷新中...' : '刷新详情' }}
                </button>
              </div>

              <!-- 战役标题卡 -->
              <div class="bg-gradient-to-br from-amber-950/30 to-violet-950/30 border border-amber-800/40 rounded-lg p-4">
                <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
                  <div class="flex items-center gap-3">
                    <span class="text-amber-300 font-bold">{{ warDetail.attacker_sect_name }}</span>
                    <span class="text-stone-500 text-xs">攻</span>
                    <span class="text-rose-400 text-lg">⚔</span>
                    <span class="text-stone-500 text-xs">守</span>
                    <span class="text-violet-300 font-bold">{{ warDetail.defender_sect_name }}</span>
                  </div>
                  <span class="px-2 py-1 rounded text-xs font-bold" :class="getWarStatusClass(warDetail.status)">
                    {{ getWarStatusName(warDetail.status) }}
                  </span>
                </div>

                <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div class="bg-[#0c0a09]/60 rounded p-2">
                    <div class="text-stone-500">奖池</div>
                    <div class="font-bold text-amber-300">{{ formatNumber(warDetail.war_chest) }} 灵石</div>
                  </div>
                  <div class="bg-[#0c0a09]/60 rounded p-2">
                    <div class="text-stone-500">目标资源点</div>
                    <div class="font-bold text-stone-200">{{ warDetail.target_territory_name || '纯荣誉战' }}</div>
                  </div>
                  <div class="bg-[#0c0a09]/60 rounded p-2">
                    <div class="text-stone-500">参战人数</div>
                    <div class="font-bold text-cyan-300">攻 {{ warDetail.attacker_count }} / 守 {{ warDetail.defender_count }}</div>
                  </div>
                  <div class="bg-[#0c0a09]/60 rounded p-2">
                    <div class="text-stone-500">击杀数</div>
                    <div class="font-bold text-rose-300">攻 {{ warDetail.attacker_kills }} / 守 {{ warDetail.defender_kills }}</div>
                  </div>
                </div>

                <!-- 倒计时区 -->
                <div v-if="warDetail.status !== 'settled'" class="mt-3 text-xs flex items-center gap-3">
                  <span class="text-stone-500">{{ getNextStatusLabel(warDetail.status) }}：</span>
                  <span class="text-amber-400 font-bold">{{ formatCountdownText(getWarRemainingMs(warDetail)) }}</span>
                </div>
                <div v-else class="mt-3 text-xs">
                  <span class="text-stone-500">胜方：</span>
                  <span class="font-bold" :class="warDetail.winner_side === 'attacker' ? 'text-amber-300' : 'text-violet-300'">
                    {{ warDetail.winner_side === 'attacker' ? warDetail.attacker_sect_name : warDetail.defender_sect_name }}
                  </span>
                  <span class="ml-2 text-stone-500">结算于 {{ formatDate(warDetail.settle_time) }}</span>
                </div>
              </div>

              <!-- 战斗操作区（仅 active 阶段且已加入） -->
              <div v-if="warDetail.status === 'active'" class="bg-red-950/20 border border-red-800/40 rounded-lg p-3 space-y-3">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <div class="text-sm font-bold text-rose-300">交战期 · 可攻击敌方玩家</div>
                  <div class="flex gap-2">
                    <button
                      v-if="!myParticipant"
                      @click="handleJoinWar"
                      :disabled="operating"
                      class="px-3 py-1 text-xs font-bold rounded bg-emerald-900/60 border border-emerald-700 text-emerald-300 hover:bg-emerald-800/60 disabled:opacity-50"
                    >加入战役</button>
                    <template v-else>
                      <button
                        @click="openLeaveConfirm"
                        :disabled="operating"
                        class="px-3 py-1 text-xs font-bold rounded bg-stone-800 border border-stone-600 text-stone-300 hover:bg-stone-700 disabled:opacity-50"
                      >离开战场</button>
                      <button
                        v-if="mySectInfo?.is_leader && warDetail.attacker_sect_id === mySectInfo.sect_id"
                        @click="openSurrenderConfirm"
                        :disabled="operating"
                        class="px-3 py-1 text-xs font-bold rounded bg-rose-900/60 border border-rose-700 text-rose-300 hover:bg-rose-800/60 disabled:opacity-50"
                      >投降认输</button>
                    </template>
                  </div>
                </div>

                <!-- 玩家自身状态 -->
                <template v-if="myParticipant">
                  <!-- HP/MP 条 -->
                  <div class="bg-[#0c0a09]/60 border border-stone-800 rounded p-3 space-y-2">
                    <div class="flex items-center justify-between text-xs">
                      <span class="text-stone-300 font-bold">{{ myParticipant.nickname || '我' }}</span>
                      <span class="text-stone-500">阵营：<span :class="myParticipant.side === 'attacker' ? 'text-amber-300' : 'text-violet-300'">{{ myParticipant.side === 'attacker' ? '攻方' : '守方' }}</span></span>
                    </div>
                    <!-- HP -->
                    <div>
                      <div class="flex justify-between text-xs mb-0.5">
                        <span class="text-rose-300">气血</span>
                        <span class="text-stone-400">{{ myCurrentHp }} / {{ myMaxHp }}</span>
                      </div>
                      <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-rose-700 to-rose-500 transition-all duration-300"
                          :style="{ width: `${myHpPercent}%` }"></div>
                      </div>
                    </div>
                    <!-- MP -->
                    <div>
                      <div class="flex justify-between text-xs mb-0.5">
                        <span class="text-cyan-300">灵力</span>
                        <span class="text-stone-400">{{ myCurrentMp }} / {{ myMaxMp }}</span>
                      </div>
                      <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-cyan-700 to-cyan-500 transition-all duration-300"
                          :style="{ width: `${myMpPercent}%` }"></div>
                      </div>
                    </div>
                    <!-- 死亡复活倒计时 -->
                    <div v-if="myParticipant.is_dead" class="text-xs text-rose-400 bg-rose-950/40 rounded p-2 flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                      </svg>
                      阵亡 · 复活倒计时 {{ formatCountdownText(getReviveRemainingMs()) }}
                    </div>
                  </div>

                  <!-- 敌方目标列表 -->
                  <div class="bg-[#0c0a09]/60 border border-stone-800 rounded p-2">
                    <div class="text-xs text-stone-500 mb-2">敌方目标（点击选择攻击目标）</div>
                    <div v-if="enemyParticipants.length === 0" class="text-xs text-stone-600 py-2 text-center">暂无可攻击的敌方玩家</div>
                    <ul v-else class="space-y-1">
                      <li
                        v-for="p in enemyParticipants"
                        :key="p.player_id"
                        @click="selectTarget(p)"
                        class="flex items-center justify-between px-2 py-1.5 rounded cursor-pointer text-xs transition-colors"
                        :class="selectedTarget?.player_id === p.player_id
                          ? 'bg-rose-950/40 border border-rose-700/60'
                          : 'bg-stone-900/40 hover:bg-stone-800/60 border border-transparent'"
                      >
                        <div class="flex items-center gap-2">
                          <span class="text-stone-200">{{ p.nickname }}</span>
                          <span v-if="p.is_dead" class="text-rose-500 text-xs">[阵亡]</span>
                        </div>
                        <div class="flex items-center gap-2 text-stone-500">
                          <span>HP {{ p.hp_current ?? p.hp_after ?? 0 }}/{{ p.hp_max ?? 0 }}</span>
                        </div>
                      </li>
                    </ul>
                  </div>

                  <!-- 行动按钮 -->
                  <div class="grid grid-cols-3 gap-2">
                    <button
                      @click="handleAttack('attack')"
                      :disabled="actionLoading || !selectedTarget || myParticipant.is_dead"
                      class="px-2 py-2 text-xs font-bold rounded bg-rose-900/60 border border-rose-700 text-rose-300 hover:bg-rose-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
                    >普攻</button>
                    <button
                      @click="handleAttack('skill')"
                      :disabled="actionLoading || !selectedTarget || myParticipant.is_dead || myCurrentMp < SKILL_MP_COST"
                      class="px-2 py-2 text-xs font-bold rounded bg-violet-900/60 border border-violet-700 text-violet-300 hover:bg-violet-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
                    >技能 <span class="text-xs text-cyan-400">-{{ SKILL_MP_COST }}MP</span></button>
                    <button
                      @click="handleAttack('defend')"
                      :disabled="actionLoading || myParticipant.is_dead"
                      class="px-2 py-2 text-xs font-bold rounded bg-cyan-900/60 border border-cyan-700 text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
                    >防御</button>
                  </div>

                  <!-- 攻击结果展示 -->
                  <div v-if="lastAttackResult" class="bg-[#0c0a09]/60 border border-amber-900/30 rounded p-2 text-xs space-y-1">
                    <div class="text-amber-300 font-bold">上一回合战报</div>
                    <div class="text-stone-300">
                      你<span class="text-amber-300">{{ getActionName(lastAttackResult.attack.action) }}</span>
                      造成 <span class="text-rose-300 font-bold">{{ lastAttackResult.attack.damage }}</span> 伤害
                      <span v-if="lastAttackResult.attack.is_crit" class="text-amber-400">（暴击！）</span>
                    </div>
                    <div v-if="lastAttackResult.counter" class="text-stone-400">
                      对方反击造成 <span class="text-rose-400">{{ lastAttackResult.counter.damage }}</span> 伤害
                      <span v-if="lastAttackResult.counter.is_crit" class="text-amber-400">（暴击！）</span>
                    </div>
                    <div v-if="lastAttackResult.defender?.is_dead" class="text-emerald-300 font-bold">
                      击杀成功！
                      <span v-if="lastAttackResult.rewards?.honor" class="ml-2 text-amber-300">荣誉 +{{ lastAttackResult.rewards.honor }}</span>
                    </div>
                  </div>

                  <!-- 占领资源点按钮 -->
                  <div v-if="warDetail.target_territory_id && !myParticipant.is_dead">
                    <button
                      @click="handleCapture"
                      :disabled="operating || captureRemainingSec > 0"
                      class="w-full px-3 py-2 text-xs font-bold rounded bg-gradient-to-r from-amber-800 to-violet-800 text-white hover:from-amber-700 hover:to-violet-700 disabled:opacity-50 transition-all"
                    >
                      <span v-if="captureRemainingSec > 0">占领中... {{ captureRemainingSec }}s</span>
                      <span v-else>占领目标资源点（30秒计时）</span>
                    </button>
                    <!-- 占领进度条 -->
                    <div v-if="captureRemainingSec > 0" class="h-1.5 mt-1 bg-stone-800 rounded-full overflow-hidden">
                      <div class="h-full bg-gradient-to-r from-amber-500 to-violet-500 transition-all duration-300"
                        :style="{ width: `${captureProgress}%` }"></div>
                    </div>
                  </div>
                </template>
              </div>

              <!-- 参战名单 -->
              <div v-if="warDetail.participants && warDetail.participants.length" class="bg-[#292524] border border-stone-700 rounded-lg p-3">
                <div class="text-sm font-bold text-amber-300 mb-2">参战名单</div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <div>
                    <div class="text-stone-400 mb-1">攻方 · {{ warDetail.attacker_sect_name }}</div>
                    <ul class="space-y-1">
                      <li v-for="p in attackerParticipants" :key="p.player_id" class="flex items-center justify-between px-2 py-1 rounded bg-[#0c0a09]/40">
                        <span class="text-stone-200">{{ p.nickname }}</span>
                        <span class="text-stone-500">击杀 {{ p.kills || 0 }}</span>
                      </li>
                    </ul>
                  </div>
                  <div>
                    <div class="text-stone-400 mb-1">守方 · {{ warDetail.defender_sect_name }}</div>
                    <ul class="space-y-1">
                      <li v-for="p in defenderParticipants" :key="p.player_id" class="flex items-center justify-between px-2 py-1 rounded bg-[#0c0a09]/40">
                        <span class="text-stone-200">{{ p.nickname }}</span>
                        <span class="text-stone-500">击杀 {{ p.kills || 0 }}</span>
                      </li>
                    </ul>
                  </div>
                </div>
              </div>

              <!-- 近期战斗记录 -->
              <div v-if="warDetail.recent_battles && warDetail.recent_battles.length" class="bg-[#292524] border border-stone-700 rounded-lg p-3">
                <div class="text-sm font-bold text-violet-300 mb-2">近期战斗记录</div>
                <ul class="space-y-1 text-xs">
                  <li v-for="(b, idx) in warDetail.recent_battles.slice(0, 10)" :key="idx" class="flex items-center gap-2 px-2 py-1 rounded bg-[#0c0a09]/40">
                    <span class="text-stone-500 shrink-0">{{ formatTimeOfDay(b.timestamp || b.created_at) }}</span>
                    <span class="text-stone-300 flex-1">{{ b.description || formatBattleLog(b) }}</span>
                  </li>
                </ul>
              </div>
            </template>

            <!-- 战役列表视图 -->
            <template v-else>
              <!-- 状态过滤 -->
              <div class="flex items-center gap-1 flex-wrap">
                <button
                  v-for="opt in warStatusFilters"
                  :key="opt.value"
                  @click="changeWarFilter(opt.value)"
                  class="px-3 py-1 rounded text-xs transition-colors"
                  :class="warFilter === opt.value
                    ? 'bg-amber-900/40 text-amber-300 border border-amber-700/50'
                    : 'text-stone-500 hover:text-stone-300 border border-transparent'"
                >{{ opt.label }}</button>
              </div>

              <div v-if="warList.length === 0" class="text-center text-stone-500 py-12 text-sm">
                暂无符合条件的战役
              </div>

              <ul v-else class="space-y-2">
                <li
                  v-for="w in warList"
                  :key="w.id"
                  class="bg-[#292524] border border-stone-700 rounded-lg p-3 cursor-pointer hover:border-amber-700/50 transition-colors"
                  @click="openWarDetail(w.id)"
                >
                  <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
                    <div class="flex items-center gap-2 text-sm">
                      <span class="text-amber-300 font-bold">{{ w.attacker_sect_name }}</span>
                      <span class="text-stone-500 text-xs">攻</span>
                      <span class="text-rose-400">⚔</span>
                      <span class="text-stone-500 text-xs">守</span>
                      <span class="text-violet-300 font-bold">{{ w.defender_sect_name }}</span>
                    </div>
                    <span class="px-2 py-0.5 rounded text-xs font-bold" :class="getWarStatusClass(w.status)">
                      {{ getWarStatusName(w.status) }}
                    </span>
                  </div>
                  <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-stone-400">
                    <div>奖池：<span class="text-amber-300">{{ formatNumber(w.war_chest) }}</span></div>
                    <div>目标：<span class="text-stone-200">{{ w.target_territory_name || '纯荣誉战' }}</span></div>
                    <div>参战：<span class="text-cyan-300">{{ w.attacker_count + w.defender_count }} 人</span></div>
                    <div>击杀：<span class="text-rose-300">{{ w.attacker_kills + w.defender_kills }}</span></div>
                  </div>
                  <div v-if="w.status !== 'settled'" class="mt-2 text-xs text-stone-500">
                    {{ getNextStatusLabel(w.status) }}：{{ formatCountdownText(getWarRemainingMs(w)) }}
                  </div>
                </li>
              </ul>
            </template>
          </div>

          <!-- ====== Tab4: 排行 ====== -->
          <div v-else-if="activeTab === 'ranking'" class="space-y-4">
            <div class="flex items-center justify-between">
              <div class="text-sm text-stone-400">赛季宗门积分榜</div>
              <button @click="fetchRanking" :disabled="rankingLoading"
                class="text-xs text-stone-400 hover:text-amber-300 disabled:opacity-50">
                {{ rankingLoading ? '刷新中...' : '刷新排行' }}
              </button>
            </div>

            <div v-if="ranking.length === 0" class="text-center text-stone-500 py-12 text-sm">
              暂无排行数据
            </div>

            <ul v-else class="space-y-2">
              <li
                v-for="(r, idx) in ranking"
                :key="r.sect_id || idx"
                class="flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors"
                :class="idx < 3
                  ? 'bg-gradient-to-r from-amber-950/40 to-[#292524] border-amber-700/50'
                  : 'bg-[#292524] border-stone-700'"
              >
                <!-- 排名 -->
                <div class="w-10 text-center font-bold text-lg"
                  :class="idx === 0 ? 'text-amber-400' : idx === 1 ? 'text-stone-300' : idx === 2 ? 'text-amber-700' : 'text-stone-500'">
                  {{ idx + 1 }}
                </div>
                <!-- 宗门名 -->
                <div class="flex-1">
                  <div class="text-sm font-bold" :class="idx < 3 ? 'text-amber-300' : 'text-stone-200'">{{ r.sect_name }}</div>
                  <div class="text-xs text-stone-500">{{ r.sect_alignment || '' }}</div>
                </div>
                <!-- 数据 -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-stone-400">
                  <div><span class="text-stone-500">胜场</span> <span class="text-emerald-300 font-bold">{{ r.wins || 0 }}</span></div>
                  <div><span class="text-stone-500">总击杀</span> <span class="text-rose-300 font-bold">{{ r.total_kills || 0 }}</span></div>
                  <div><span class="text-stone-500">资源点</span> <span class="text-amber-300 font-bold">{{ r.territories_count || 0 }}</span></div>
                  <div><span class="text-stone-500">积分</span> <span class="text-violet-300 font-bold">{{ r.score || r.season_war_score || 0 }}</span></div>
                </div>
              </li>
            </ul>
          </div>
        </template>
      </div>

      <!-- 底部操作栏 -->
      <div class="mt-2 flex gap-2 p-3 border-t border-stone-800 bg-[#1c1917]">
        <button
          @click="emit('close')"
          class="px-4 py-2 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors"
        >关闭</button>
        <button
          @click="refreshAll"
          :disabled="loading"
          class="flex-1 py-2 rounded-lg font-bold tracking-widest text-sm transition-all disabled:opacity-50 bg-gradient-to-r from-amber-900/40 to-violet-900/40 border border-amber-700 text-amber-300 hover:from-amber-900/60 hover:to-violet-900/60 hover:border-amber-500"
        >
          {{ loading ? '刷新中...' : '刷新九州烽烟录' }}
        </button>
      </div>

      <!-- ====== 宣战表单弹窗 ====== -->
      <Modal :isOpen="declareModalShow" title="宣战出师" width="480px" @close="closeDeclareModal">
        <div class="space-y-4">
          <p class="text-stone-300 text-sm">宗主请慎重决策，宣战将消耗宗门资金 <span class="text-amber-300 font-bold">{{ formatNumber(DECLARE_WAR_COST) }}</span> 灵石作为军费。</p>

          <!-- 选择防守方宗门 -->
          <div>
            <label class="block text-xs text-stone-400 mb-1">讨伐对象（防守方宗门）</label>
            <select
              v-model="declareForm.defenderSectId"
              class="w-full bg-[#0c0a09] border border-stone-700 rounded px-3 py-2 text-sm text-stone-200 focus:border-amber-500 focus:outline-none"
            >
              <option value="">请选择...</option>
              <option
                v-for="s in availableDefenderSects"
                :key="s.sect_id"
                :value="s.sect_id"
              >{{ s.sect_name }}</option>
            </select>
          </div>

          <!-- 选择目标资源点 -->
          <div>
            <label class="block text-xs text-stone-400 mb-1">目标资源点（可选，留空为纯荣誉战）</label>
            <select
              v-model="declareForm.targetTerritoryId"
              class="w-full bg-[#0c0a09] border border-stone-700 rounded px-3 py-2 text-sm text-stone-200 focus:border-amber-500 focus:outline-none"
            >
              <option :value="null">纯荣誉战（无目标资源点）</option>
              <option
                v-for="t in targetableTerritories"
                :key="t.territory_key"
                :value="getTerritoryNumericId(t)"
              >{{ t.territory_name }}（{{ t.owner_sect_name || '无主' }}）</option>
            </select>
          </div>

          <!-- 消耗提示 -->
          <div class="bg-amber-950/30 border border-amber-800/50 rounded p-2 text-xs text-amber-300">
            宣战军费：{{ formatNumber(DECLARE_WAR_COST) }} 灵石（从宗门资金扣除）
          </div>
        </div>

        <template #footer>
          <button @click="closeDeclareModal" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">取消</button>
          <button
            @click="openDeclareConfirm"
            :disabled="!declareForm.defenderSectId || operating"
            class="px-4 py-2 bg-gradient-to-r from-amber-700 to-violet-700 hover:from-amber-600 hover:to-violet-600 text-white rounded text-sm disabled:opacity-50"
          >下一步</button>
        </template>
      </Modal>

      <!-- ====== 宣战二次确认弹窗 ====== -->
      <Modal :isOpen="declareConfirmShow" title="二次确认 · 出师讨伐" width="420px" @close="declareConfirmShow = false">
        <div class="space-y-2 text-sm">
          <p class="text-stone-300">确认向以下宗门宣战？</p>
          <div class="bg-[#0c0a09]/60 rounded p-2 text-xs space-y-1">
            <div><span class="text-stone-500">讨伐对象：</span><span class="text-violet-300 font-bold">{{ selectedDefenderName }}</span></div>
            <div><span class="text-stone-500">目标资源点：</span><span class="text-amber-300">{{ selectedTargetName }}</span></div>
            <div><span class="text-stone-500">军费消耗：</span><span class="text-amber-300 font-bold">{{ formatNumber(DECLARE_WAR_COST) }} 灵石</span></div>
          </div>
          <p class="text-rose-400 text-xs">宣战后进入备战期（24小时），备战期内可加入/离开；通告期（1小时）后不可离开；交战期默认2小时。</p>
        </div>
        <template #footer>
          <button @click="declareConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">再想想</button>
          <button
            @click="handleDeclareWar"
            :disabled="operating"
            class="px-4 py-2 bg-gradient-to-r from-rose-700 to-amber-700 hover:from-rose-600 hover:to-amber-600 text-white rounded text-sm disabled:opacity-50"
          >{{ operating ? '出征中...' : '确认宣战' }}</button>
        </template>
      </Modal>

      <!-- ====== 离开战役确认弹窗 ====== -->
      <Modal :isOpen="leaveConfirmShow" title="离开战场确认" width="420px" @close="leaveConfirmShow = false">
        <p class="text-stone-300 text-sm">确认要离开这场战役吗？</p>
        <p class="text-rose-400 text-xs mt-2">
          备战/通告期离开无惩罚；交战期离开视为临阵脱逃，将影响战绩结算。
        </p>
        <template #footer>
          <button @click="leaveConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">取消</button>
          <button
            @click="handleLeaveWar"
            :disabled="operating"
            class="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded text-sm disabled:opacity-50"
          >{{ operating ? '执行中...' : '确认离开' }}</button>
        </template>
      </Modal>

      <!-- ====== 投降确认弹窗 ====== -->
      <Modal :isOpen="surrenderConfirmShow" title="投降认输确认" width="420px" @close="surrenderConfirmShow = false">
        <p class="text-stone-300 text-sm">宗主，确认要投降认输吗？</p>
        <p class="text-rose-400 text-xs mt-2">
          投降后对方获胜并获得全部奖池，本宗宗门资金扣除已付出的军费。此操作不可撤销。
        </p>
        <template #footer>
          <button @click="surrenderConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">再战</button>
          <button
            @click="handleSurrender"
            :disabled="operating"
            class="px-4 py-2 bg-rose-800 hover:bg-rose-700 text-white rounded text-sm disabled:opacity-50"
          >{{ operating ? '执行中...' : '确认投降' }}</button>
        </template>
      </Modal>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 宗门战面板组件逻辑层
 *
 * 模块组成：
 *   1. 状态：activeTab/season/territories/mySectInfo/warList/warDetail/ranking
 *   2. 计算：sortedTerritories/enemyParticipants/attackerParticipants/defenderParticipants/myParticipant 等
 *   3. 数据加载：fetchSeason/fetchTerritories/fetchMySect/fetchWarList/fetchWarDetail/fetchRanking
 *   4. 战斗操作：handleAttack/handleCapture/handleJoinWar/handleLeaveWar/handleSurrender/handleDeclareWar
 *   5. 辅助方法：getTerritoryIcon/getWarStatusName/formatCountdownText 等
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import Modal from '../common/Modal.vue'
import {
  getCurrentSeason,
  getTerritories,
  getMySectInfo,
  getWarList,
  getWarDetail,
  declareWar,
  joinWar,
  leaveWar,
  attackPlayer,
  captureTerritory,
  surrender,
  getSeasonRanking,
  type SectWarSeason,
  type Territory,
  type MySectInfo,
  type WarListItem,
  type WarDetail,
  type WarStatus,
  type WarAction,
  type AttackPlayerResult
} from '../../api/sectWar'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

// ====== 配置常量（前端仅作展示，业务值由后端权威计算） ======
/** 技能消耗 MP（仅用于按钮禁用判断，后端权威） */
const SKILL_MP_COST = 20
/** 宣战军费灵石数（仅展示，后端权威扣费） */
const DECLARE_WAR_COST = 5000
/** 占领计时秒数（仅用于本地进度条展示） */
const CAPTURE_TOTAL_SEC = 30
/** 阵亡复活秒数（仅用于本地倒计时展示） */
const REVIVE_TOTAL_SEC = 60

// ====== 响应式状态 ======
const loading = ref(true)                  // 整体加载锁
const operating = ref(false)               // 操作中状态锁，防止重复提交
const actionLoading = ref(false)           // 战斗动作加载锁
const territoryLoading = ref(false)        // 资源点刷新加载
const warDetailLoading = ref(false)        // 战役详情刷新加载
const rankingLoading = ref(false)          // 排行刷新加载

const activeTab = ref<'territories' | 'mysect' | 'wars' | 'ranking'>('territories')
const season = ref<SectWarSeason | null>(null)
const territories = ref<Territory[]>([])
const mySectInfo = ref<MySectInfo | null>(null)
const warList = ref<WarListItem[]>([])
const warDetail = ref<WarDetail | null>(null)
const ranking = ref<any[]>([])

// 战役状态过滤
const warFilter = ref<'all' | WarStatus>('all')

// 战斗相关
const selectedTarget = ref<any>(null)              // 当前选中的攻击目标
const lastAttackResult = ref<AttackPlayerResult | null>(null)  // 最近一次攻击结果
const captureRemainingSec = ref(0)                  // 占领剩余秒数（本地倒计时）
const captureTimer = ref<number | null>(null)       // 占领计时器句柄
const lastAttackTs = ref(0)                         // 上次攻击时间戳（用于复活倒计时计算）

// 当前时间 tick（每秒更新一次，用于驱动倒计时刷新）
const now = ref(Date.now())
let tickTimer: number | null = null

// ====== 弹窗状态 ======
const declareModalShow = ref(false)                 // 宣战表单弹窗
const declareConfirmShow = ref(false)               // 宣战二次确认弹窗
const leaveConfirmShow = ref(false)                 // 离开战役确认弹窗
const surrenderConfirmShow = ref(false)             // 投降确认弹窗

// 宣战表单
const declareForm = ref<{
  defenderSectId: string
  targetTerritoryId: number | null
}>({
  defenderSectId: '',
  targetTerritoryId: null
})

// ====== Tab 配置 ======
const tabs = computed(() => [
  { key: 'territories' as const, label: '资源点', badge: '' },
  { key: 'mysect' as const, label: '我的宗门', badge: '' },
  {
    key: 'wars' as const,
    label: '战役',
    badge: mySectInfo.value?.ongoing_wars?.length ? String(mySectInfo.value.ongoing_wars.length) : ''
  },
  { key: 'ranking' as const, label: '排行', badge: '' }
])

// ====== 战役状态过滤选项 ======
const warStatusFilters = [
  { value: 'all' as const, label: '全部' },
  { value: 'preparing' as const, label: '备战中' },
  { value: 'announced' as const, label: '通告中' },
  { value: 'active' as const, label: '交战中' },
  { value: 'settled' as const, label: '已结算' }
]

// ====== 计算属性 ======

/**
 * 资源点按地图坐标排序（左上→右下）
 */
const sortedTerritories = computed(() => {
  return [...territories.value].sort((a, b) => {
    if (a.map_y !== b.map_y) return a.map_y - b.map_y
    return a.map_x - b.map_x
  })
})

/**
 * 宣战表单：可选择的防守方宗门列表（排除自己宗门）
 */
const availableDefenderSects = computed(() => {
  // 当前接口未单独提供所有宗门列表，使用资源点归属宗门去重作为可选项
  // 后端会进一步校验，前端仅做基础过滤
  if (!mySectInfo.value) return []
  const map = new Map<string, { sect_id: string; sect_name: string }>()
  territories.value.forEach(t => {
    if (t.owner_sect_id && t.owner_sect_id !== mySectInfo.value!.sect_id) {
      map.set(t.owner_sect_id, { sect_id: t.owner_sect_id, sect_name: t.owner_sect_name || '' })
    }
  })
  return Array.from(map.values())
})

/**
 * 宣战表单：可作为目标的资源点列表（敌方占领或无主）
 */
const targetableTerritories = computed(() => {
  if (!mySectInfo.value) return []
  return territories.value.filter(t => t.owner_sect_id !== mySectInfo.value!.sect_id)
})

/**
 * 宣战二次确认弹窗：选中的防守方宗门名
 */
const selectedDefenderName = computed(() => {
  const s = availableDefenderSects.value.find(x => x.sect_id === declareForm.value.defenderSectId)
  return s?.sect_name || '—'
})

/**
 * 宣战二次确认弹窗：选中的目标资源点名
 */
const selectedTargetName = computed(() => {
  if (declareForm.value.targetTerritoryId === null) return '纯荣誉战'
  const t = targetableTerritories.value.find(x => getTerritoryNumericId(x) === declareForm.value.targetTerritoryId)
  return t?.territory_name || '—'
})

/**
 * 战役详情：攻方参战玩家
 */
const attackerParticipants = computed(() => {
  const list = warDetail.value?.participants || []
  return list.filter((p: any) => p.side === 'attacker')
})

/**
 * 战役详情：守方参战玩家
 */
const defenderParticipants = computed(() => {
  const list = warDetail.value?.participants || []
  return list.filter((p: any) => p.side === 'defender')
})

/**
 * 战役详情：敌方玩家列表（用于选择攻击目标）
 */
const enemyParticipants = computed(() => {
  if (!warDetail.value || !mySectInfo.value) return []
  // 我方宗门属于攻方时，敌方为守方；反之亦然
  const mySideIsAttacker = warDetail.value.attacker_sect_id === mySectInfo.value.sect_id
  const enemySide = mySideIsAttacker ? 'defender' : 'attacker'
  return (warDetail.value.participants || []).filter((p: any) => p.side === enemySide && !p.is_dead)
})

/**
 * 战役详情：我的参战信息
 */
const myParticipant = computed(() => {
  if (!warDetail.value?.participants || !playerStore.player) return null
  const myPlayerId = playerStore.player.id
  return (warDetail.value.participants as any[]).find(p => p.player_id === myPlayerId) || null
})

/**
 * 我的 HP/MP 进度百分比
 */
const myMaxHp = computed(() => Number(myParticipant.value?.hp_max) || 0)
const myCurrentHp = computed(() => {
  const p = myParticipant.value
  if (!p) return 0
  // 兼容 hp_current / hp_after 两种字段命名
  return Number(p.hp_current ?? p.hp_after ?? 0)
})
const myHpPercent = computed(() => {
  if (myMaxHp.value <= 0) return 0
  return Math.max(0, Math.min(100, (myCurrentHp.value / myMaxHp.value) * 100))
})
const myMaxMp = computed(() => Number(myParticipant.value?.mp_max) || 0)
const myCurrentMp = computed(() => {
  const p = myParticipant.value
  if (!p) return 0
  return Number(p.mp_current ?? p.mp_after ?? 0)
})
const myMpPercent = computed(() => {
  if (myMaxMp.value <= 0) return 0
  return Math.max(0, Math.min(100, (myCurrentMp.value / myMaxMp.value) * 100))
})

/**
 * 占领进度百分比
 */
const captureProgress = computed(() => {
  if (captureRemainingSec.value <= 0) return 0
  return Math.max(0, Math.min(100, ((CAPTURE_TOTAL_SEC - captureRemainingSec.value) / CAPTURE_TOTAL_SEC) * 100))
})

// ====== 数据加载 ======

/**
 * 初始化加载：并行获取赛季+资源点+我的宗门信息
 */
const fetchAll = async () => {
  loading.value = true
  try {
    await Promise.all([fetchSeason(), fetchTerritories(), fetchMySect()])
  } catch (error) {
    console.error('加载宗门战数据失败:', error)
    uiStore.showToast('加载宗门战数据失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 获取当前赛季
 */
const fetchSeason = async () => {
  try {
    const res = await getCurrentSeason()
    season.value = res.data?.data ?? null
  } catch (error) {
    console.error('获取赛季信息失败:', error)
    season.value = null
  }
}

/**
 * 获取资源点列表
 */
const fetchTerritories = async () => {
  territoryLoading.value = true
  try {
    const res = await getTerritories()
    territories.value = res.data?.data ?? []
  } catch (error) {
    console.error('获取资源点列表失败:', error)
    territories.value = []
  } finally {
    territoryLoading.value = false
  }
}

/**
 * 获取我的宗门战信息
 */
const fetchMySect = async () => {
  try {
    const res = await getMySectInfo()
    mySectInfo.value = res.data?.data ?? null
  } catch (error) {
    console.error('获取我的宗门战信息失败:', error)
    mySectInfo.value = null
  }
}

/**
 * 获取战役列表
 */
const fetchWarList = async () => {
  try {
    const res = await getWarList(warFilter.value, 1, 50)
    warList.value = res.data?.data?.list ?? []
  } catch (error) {
    console.error('获取战役列表失败:', error)
    warList.value = []
  }
}

/**
 * 获取战役详情
 */
const fetchWarDetail = async (warId: number) => {
  warDetailLoading.value = true
  try {
    const res = await getWarDetail(warId)
    warDetail.value = res.data?.data ?? null
    // 重置战斗相关临时状态
    selectedTarget.value = null
    lastAttackResult.value = null
  } catch (error) {
    console.error('获取战役详情失败:', error)
    uiStore.showToast('获取战役详情失败', 'error')
  } finally {
    warDetailLoading.value = false
  }
}

/**
 * 获取赛季宗门排行
 */
const fetchRanking = async () => {
  rankingLoading.value = true
  try {
    const res = await getSeasonRanking(season.value?.id, 100)
    ranking.value = res.data?.data?.list ?? res.data?.data ?? []
  } catch (error) {
    console.error('获取排行失败:', error)
    ranking.value = []
  } finally {
    rankingLoading.value = false
  }
}

/**
 * 刷新战役详情
 */
const refreshWarDetail = async () => {
  if (!warDetail.value) return
  await fetchWarDetail(warDetail.value.id)
}

/**
 * 刷新全部数据
 */
const refreshAll = async () => {
  await fetchAll()
  if (activeTab.value === 'wars') {
    if (warDetail.value) {
      await fetchWarDetail(warDetail.value.id)
    } else {
      await fetchWarList()
    }
  } else if (activeTab.value === 'ranking') {
    await fetchRanking()
  }
}

// ====== Tab 切换 ======

/**
 * 切换 Tab，按需加载数据
 */
const switchTab = async (key: 'territories' | 'mysect' | 'wars' | 'ranking') => {
  activeTab.value = key
  if (key === 'wars' && !warDetail.value && warList.value.length === 0) {
    await fetchWarList()
  } else if (key === 'ranking' && ranking.value.length === 0) {
    await fetchRanking()
  } else if (key === 'mysect') {
    await fetchMySect()
  } else if (key === 'territories') {
    await fetchTerritories()
  }
}

/**
 * 切换战役状态过滤
 */
const changeWarFilter = async (val: 'all' | WarStatus) => {
  warFilter.value = val
  await fetchWarList()
}

// ====== 战斗操作 ======

/**
 * 选择攻击目标
 */
const selectTarget = (p: any) => {
  if (p.is_dead) return
  selectedTarget.value = p
}

/**
 * 执行攻击/技能/防御
 * @param action - 战斗行动类型
 */
const handleAttack = async (action: WarAction) => {
  if (!warDetail.value || actionLoading.value) return
  if (action !== 'defend' && !selectedTarget.value) {
    uiStore.showToast('请先选择攻击目标', 'info')
    return
  }
  if (myParticipant.value?.is_dead) {
    uiStore.showToast('已阵亡，等待复活', 'info')
    return
  }
  actionLoading.value = true
  try {
    const targetId = selectedTarget.value?.player_id ?? 0
    const res = await attackPlayer(warDetail.value.id, targetId, action)
    const result = res.data?.data ?? null
    lastAttackResult.value = result
    lastAttackTs.value = Date.now()

    // 构建日志文本并提示
    const dmg = result?.attack?.damage ?? 0
    const killed = result?.defender?.is_dead ?? false
    const honor = result?.rewards?.honor ?? 0
    let msg = `${getActionName(action)} · 造成 ${dmg} 伤害`
    if (result?.attack?.is_crit) msg += '（暴击）'
    if (result?.counter) msg += ` · 反击 -${result.counter.damage}`
    if (killed) msg += ` · 击杀！荣誉 +${honor}`
    uiStore.showToast(msg, killed ? 'success' : 'info')

    // 攻击成功后立即刷新详情（同步双方 HP/击杀数）
    await fetchWarDetail(warDetail.value.id)
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '攻击失败'
    uiStore.showToast(msg, 'error')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 占领目标资源点
 * 后端开始30秒占领计时，前端同步显示进度条
 */
const handleCapture = async () => {
  if (!warDetail.value || operating.value) return
  if (!warDetail.value.target_territory_id) {
    uiStore.showToast('本战役无目标资源点', 'info')
    return
  }
  operating.value = true
  try {
    const res = await captureTerritory(warDetail.value.id, warDetail.value.target_territory_id)
    const result = res.data?.data
    uiStore.showToast(result?.message || '占领计时已开始', 'info')

    // 启动本地倒计时（后端权威，前端仅展示）
    startCaptureCountdown()
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '占领失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 启动占领本地倒计时
 */
const startCaptureCountdown = () => {
  if (captureTimer.value) {
    clearInterval(captureTimer.value)
    captureTimer.value = null
  }
  captureRemainingSec.value = CAPTURE_TOTAL_SEC
  captureTimer.value = window.setInterval(() => {
    captureRemainingSec.value -= 1
    if (captureRemainingSec.value <= 0) {
      captureRemainingSec.value = 0
      if (captureTimer.value) {
        clearInterval(captureTimer.value)
        captureTimer.value = null
      }
      // 倒计时结束刷新详情
      if (warDetail.value) {
        fetchWarDetail(warDetail.value.id)
      }
    }
  }, 1000)
}

/**
 * 加入战役
 */
const handleJoinWar = async () => {
  if (!warDetail.value || operating.value) return
  operating.value = true
  try {
    const res = await joinWar(warDetail.value.id)
    uiStore.showToast(res.data?.message || res.data?.data?.message || '已加入战役', 'success')
    await fetchWarDetail(warDetail.value.id)
    await fetchMySect()
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '加入失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 打开离开战役确认弹窗
 */
const openLeaveConfirm = () => {
  leaveConfirmShow.value = true
}

/**
 * 执行离开战役
 */
const handleLeaveWar = async () => {
  if (!warDetail.value || operating.value) return
  operating.value = true
  try {
    leaveConfirmShow.value = false
    const res = await leaveWar(warDetail.value.id)
    uiStore.showToast(res.data?.message || res.data?.data?.message || '已离开战役', 'info')
    await fetchWarDetail(warDetail.value.id)
    await fetchMySect()
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '离开失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 打开投降确认弹窗
 */
const openSurrenderConfirm = () => {
  surrenderConfirmShow.value = true
}

/**
 * 执行投降
 */
const handleSurrender = async () => {
  if (!warDetail.value || operating.value) return
  operating.value = true
  try {
    surrenderConfirmShow.value = false
    const res = await surrender(warDetail.value.id)
    uiStore.showToast(res.data?.message || res.data?.data?.message || '已投降', 'info')
    await fetchWarDetail(warDetail.value.id)
    await fetchMySect()
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '投降失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== 宣战流程 ======

/**
 * 打开宣战表单弹窗
 */
const openDeclareWarModal = () => {
  declareForm.value = { defenderSectId: '', targetTerritoryId: null }
  declareModalShow.value = true
}

/**
 * 关闭宣战表单弹窗
 */
const closeDeclareModal = () => {
  declareModalShow.value = false
}

/**
 * 打开宣战二次确认弹窗
 */
const openDeclareConfirm = () => {
  if (!declareForm.value.defenderSectId) {
    uiStore.showToast('请选择讨伐对象', 'info')
    return
  }
  declareModalShow.value = false
  declareConfirmShow.value = true
}

/**
 * 执行宣战
 */
const handleDeclareWar = async () => {
  if (operating.value) return
  operating.value = true
  try {
    declareConfirmShow.value = false
    const res = await declareWar(declareForm.value.defenderSectId, declareForm.value.targetTerritoryId)
    uiStore.showToast(res.data?.message || res.data?.data?.message || '宣战成功', 'success')

    // 宣战成功后刷新数据
    await Promise.all([fetchMySect(), fetchWarList()])
    // 自动跳转到战役 Tab 并打开新战役详情
    activeTab.value = 'wars'
    uiStore.addLog({
      content: `你以宗主之名向【${selectedDefenderName.value}】宣战，目标：${selectedTargetName.value}，军费 ${formatNumber(DECLARE_WAR_COST)} 灵石。`,
      type: 'info',
      actorId: 'self'
    })
  } catch (error: any) {
    const msg = error.response?.data?.message || error.response?.data?.error || '宣战失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== 战役详情切换 ======

/**
 * 打开战役详情
 */
const openWarDetail = async (warId: number) => {
  await fetchWarDetail(warId)
}

/**
 * 关闭战役详情，返回列表
 */
const closeWarDetail = () => {
  warDetail.value = null
  selectedTarget.value = null
  lastAttackResult.value = null
  if (captureTimer.value) {
    clearInterval(captureTimer.value)
    captureTimer.value = null
  }
  captureRemainingSec.value = 0
  fetchWarList()
}

// ====== 辅助方法 ======

/**
 * 资源点类型 → 中文名
 */
const getTerritoryTypeName = (type: string): string => {
  const map: Record<string, string> = {
    spirit_vein: '灵脉',
    mine: '矿脉',
    secret_realm: '秘境',
    strategic: '战略要冲'
  }
  return map[type] || type
}

/**
 * 资源点类型 → 图标 emoji
 */
const getTerritoryIcon = (type: string): string => {
  const map: Record<string, string> = {
    spirit_vein: '✦',
    mine: '⛏',
    secret_realm: '◈',
    strategic: '★'
  }
  return map[type] || '◆'
}

/**
 * 资源点类型 → 图标颜色 class
 */
const getTerritoryIconColor = (type: string): string => {
  const map: Record<string, string> = {
    spirit_vein: 'text-cyan-400',
    mine: 'text-orange-400',
    secret_realm: 'text-violet-400',
    strategic: 'text-amber-400'
  }
  return map[type] || 'text-stone-400'
}

/**
 * 资源点卡片整体样式（按类型 + 占领状态）
 */
const getTerritoryCardClass = (t: Territory): string => {
  const typeBorderMap: Record<string, string> = {
    spirit_vein: 'border-cyan-900/40 hover:border-cyan-700/60',
    mine: 'border-orange-900/40 hover:border-orange-700/60',
    secret_realm: 'border-violet-900/40 hover:border-violet-700/60',
    strategic: 'border-amber-900/40 hover:border-amber-700/60'
  }
  const base = typeBorderMap[t.territory_type] || 'border-stone-700 hover:border-stone-500'
  // 被攻击时叠加红色脉冲边框
  if (t.is_under_attack) {
    return `${base} ring-2 ring-rose-700/60 animate-pulse`
  }
  return base
}

/**
 * 产出类型 → 颜色 class
 */
const getProductionColor = (type: string): string => {
  const map: Record<string, string> = {
    spirit_stones: 'text-amber-300',
    materials: 'text-orange-300',
    contribution: 'text-violet-300'
  }
  return map[type] || 'text-stone-300'
}

/**
 * 格式化资源点产出文本
 */
const formatProduction = (t: Territory): string => {
  if (t.daily_production <= 0) return '无日产'
  const typeMap: Record<string, string> = {
    spirit_stones: '灵石',
    materials: '材料',
    contribution: '贡献'
  }
  return `${formatNumber(t.daily_production)} ${typeMap[t.production_type] || ''}`
}

/**
 * 战役状态 → 中文名
 */
const getWarStatusName = (status: WarStatus): string => {
  const map: Record<WarStatus, string> = {
    preparing: '备战中',
    announced: '通告中',
    active: '交战中',
    settled: '已结算'
  }
  return map[status] || status
}

/**
 * 战役状态 → 徽章 class
 */
const getWarStatusClass = (status: WarStatus): string => {
  const map: Record<WarStatus, string> = {
    preparing: 'bg-amber-900/40 text-amber-300 border border-amber-700/50',
    announced: 'bg-violet-900/40 text-violet-300 border border-violet-700/50',
    active: 'bg-rose-900/40 text-rose-300 border border-rose-700/50 animate-pulse',
    settled: 'bg-stone-800 text-stone-400 border border-stone-700'
  }
  return map[status] || 'bg-stone-800 text-stone-400'
}

/**
 * 战役状态 → 下一阶段倒计时标签
 * @param status - 战役状态
 * @returns 倒计时描述文案
 */
const getNextStatusLabel = (status: WarStatus): string => {
  const map: Record<WarStatus, string> = {
    preparing: '距开战通告',
    announced: '距正式开战',
    active: '距战役结束',
    settled: '已结算'
  }
  return map[status] || '倒计时'
}

/**
 * 战斗行动类型 → 中文名
 */
const getActionName = (action: string): string => {
  const map: Record<string, string> = {
    attack: '普攻',
    skill: '技能',
    defend: '防御'
  }
  return map[action] || action
}

/**
 * 宗门角色 → 中文名
 */
const getRoleName = (role: string): string => {
  const map: Record<string, string> = {
    leader: '宗主',
    elder: '长老',
    disciple: '弟子'
  }
  return map[role] || role
}

/**
 * 计算战役剩余倒计时（毫秒）
 * 基于后端返回的 next_status_time 与本地 now 计算
 */
const getWarRemainingMs = (war: WarListItem | WarDetail): number => {
  if (!war?.next_status_time) return 0
  const target = new Date(war.next_status_time).getTime()
  const remaining = target - now.value
  return remaining > 0 ? remaining : 0
}

/**
 * 计算阵亡复活剩余倒计时（毫秒）
 * 基于本地最近一次攻击时间戳 + 60秒估算
 */
const getReviveRemainingMs = (): number => {
  if (!myParticipant.value?.is_dead) return 0
  // 优先使用后端 revive_at 时间戳，回退到本地估算
  const reviveAt = (myParticipant.value as any).revive_at
  if (reviveAt) {
    const target = new Date(reviveAt).getTime()
    const remaining = target - now.value
    return remaining > 0 ? remaining : 0
  }
  // 兜底：基于 lastAttackTs + 60s
  const elapsed = now.value - lastAttackTs.value
  const remaining = REVIVE_TOTAL_SEC * 1000 - elapsed
  return remaining > 0 ? remaining : 0
}

/**
 * 毫秒倒计时 → HH:MM:SS 文本
 */
const formatCountdownText = (ms: number): string => {
  if (ms <= 0) return '00:00:00'
  const totalSec = Math.floor(ms / 1000)
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

/**
 * 日期字符串 → yyyy-MM-dd HH:mm
 */
const formatDate = (dateStr: string | null): string => {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const min = d.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

/**
 * 时间字符串 → HH:MM:SS
 */
const formatTimeOfDay = (time: string | null): string => {
  if (!time) return '--:--:--'
  const d = new Date(time)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 数字 → 千分位字符串（兼容 BigInt 字符串）
 */
const formatNumber = (num: number | string | null | undefined): string => {
  if (num === null || num === undefined || num === '') return '0'
  const str = typeof num === 'bigint' ? num.toString() : String(num).trim()
  if (!str) return '0'
  let sign = ''
  let intPart = str
  if (str.startsWith('-')) {
    sign = '-'
    intPart = str.slice(1)
  }
  const dotIdx = intPart.indexOf('.')
  let intStr = dotIdx >= 0 ? intPart.slice(0, dotIdx) : intPart
  if (!/^\d+$/.test(intStr)) return str
  intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return sign + intStr
}

/**
 * 格式化战斗记录条目（兜底文案）
 */
const formatBattleLog = (b: any): string => {
  if (!b) return ''
  const attacker = b.attacker_nickname || b.attacker_name || '某修士'
  const defender = b.defender_nickname || b.defender_name || '某修士'
  const action = getActionName(b.action || 'attack')
  const dmg = b.damage || 0
  return `${attacker} ${action} ${defender}，造成 ${dmg} 伤害`
}

/**
 * 资源点 → 数字 ID
 * 兼容后端返回 territory_key（字符串）或 territory_id（数字）两种字段
 * 当仅有 key 时使用 map_x*10+map_y 作为稳定哈希 ID
 */
const getTerritoryNumericId = (t: Territory): number => {
  const anyT = t as any
  if (typeof anyT.territory_id === 'number') return anyT.territory_id
  if (typeof anyT.id === 'number') return anyT.id
  // 兜底使用坐标哈希（仅用于前端 select value，后端会按 territory_id 解析）
  return anyT.map_x * 10 + anyT.map_y
}

// ====== 生命周期 ======

onMounted(() => {
  fetchAll()
  // 每秒更新 now，驱动倒计时刷新
  tickTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  if (captureTimer.value) {
    clearInterval(captureTimer.value)
    captureTimer.value = null
  }
})
</script>

<style scoped>
/* 自定义滚动条样式，贴合修仙深色主题 */
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

/* 渐入动画 */
.animate-fade-in {
  animation: fadeIn 0.25s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}
</style>
