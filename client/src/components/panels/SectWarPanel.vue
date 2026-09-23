<!--
 * 宗门战面板组件
 *
 * 弹窗式组件，展示宗门战/领地争夺系统的资源点/战役/排行。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 外壳走 ui/PanelShell，分段导航走 ui/Tabs，二次确认用 common/Modal
 *   - 战役状态机：preparing → announced → active → settled
 *     阶段时间取后端给的 prepare_end_time / active_start_time / active_end_time
 *   - 数值口径来自 server/config/game_balance.json 的 sect_war 块：
 *     占领计时 30 秒、宣战军费 5000 灵石、备战 24 小时、通告 2 小时、交战 30 分钟
 *   - 颜色风格：宗门战混合金戈铁马与神秘感，用 gold-* + violet-*
 *
 * 数据来源（响应统一是 { code, data }，业务字段一律从 res.data.data 取）：
 *   - getCurrentSeason()：当前赛季（SectWarSeason 原始行）
 *   - getTerritories()：资源点（_formatTerritory 的字段集）
 *   - getMySectInfo()：我的宗门战信息
 *   - getWarList()：分页 { list, total, page, limit }，list 项是 _formatWar
 *   - getWarDetail()：_formatWar 全字段 + target_territory + attackers/defenders
 *                      + attacker_count/defender_count（名单项是 _formatParticipant）
 *   - declareWar/joinWar/leaveWar/attackPlayer/captureTerritory/surrender：战役操作
-->
<template>
  <PanelShell
    title="宗门战役"
    hint="九州烽烟 · 领地争夺"
    size="xl"
    @close="emit('close')"
  >
    <!-- 赛季信息条：置于外壳头部读数的位置 -->
    <template #header-actions>
      <div v-if="season" class="hidden md:flex items-center gap-3 text-xs">
        <span class="text-gold-400 font-bold">{{ season.season_name }}</span>
        <span class="text-fg-faint num">赛季ID #{{ season.id }}</span>
        <span class="text-fg-faint num">{{ formatDate(season.start_date) }} ~ {{ formatDate(season.end_date) }}</span>
        <Badge tone="arcane">累计战役 <span class="num">{{ season.total_wars }}</span></Badge>
        <Badge v-if="season.status === 'active'" tone="success" dot>进行中</Badge>
        <Badge v-else-if="season.status === 'pending'" tone="gold">待开启</Badge>
        <Badge v-else tone="muted">已结束</Badge>
      </div>
    </template>

    <!-- Tab 切换栏 -->
    <Tabs :model-value="activeTab" :items="tabs" class="mb-4" @update:model-value="switchTab" />

    <!-- ====== Tab1: 资源点 ====== -->
    <div v-if="activeTab === 'territories'" class="space-y-4">
      <!-- 首屏加载态放在页签体内：交给 PanelShell 的 :loading 会整块替换插槽，
           连带把四个页签一起藏掉（见 ui/PanelShell.vue 顶部警告）。 -->
      <LoadingBlock v-if="booting" text="加载九州烽烟中…" />

      <div class="flex items-center justify-between flex-wrap gap-2">
        <div class="text-sm text-fg-muted">九州九宫格 · 共 <span class="text-gold-300 font-bold num">{{ territories.length }}</span> 处资源点</div>
        <AppButton size="xs" variant="ghost" :disabled="territoryLoading" @click="fetchTerritories">
          {{ territoryLoading ? '刷新中…' : '刷新资源点' }}
        </AppButton>
      </div>

      <!-- 拉取失败：常驻错误态 + 重试。放在页签体内而不是交给外壳，
           PanelShell 的 :error 会整块替换 slot，把四个页签一起藏掉。 -->
      <ErrorState v-if="error" :message="error" @retry="fetchTerritories" />

      <!-- 3x3 九宫格 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div
          v-for="t in sortedTerritories"
          :key="t.territory_key"
          class="relative border rounded-panel p-3 transition-all duration-300"
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
              <div class="text-sm font-bold text-fg-primary">{{ t.territory_name }}</div>
              <div class="text-xs text-fg-faint">{{ getTerritoryTypeName(t.territory_type) }}</div>
            </div>
          </div>

          <!-- 归属宗门 -->
          <div class="text-xs mb-2">
            <span class="text-fg-faint">归属：</span>
            <span v-if="t.owner_sect_name" class="text-gold-300 font-bold">{{ t.owner_sect_name }}</span>
            <span v-else class="text-fg-faint">无主之地</span>
          </div>

          <!-- 产出与防御 -->
          <div class="grid grid-cols-2 gap-2 text-xs mb-2">
            <div class="bg-surface-sunken rounded-control p-1.5">
              <div class="text-fg-faint">日产出</div>
              <div class="font-bold" :class="getProductionColor(t.production_type)">
                {{ formatProduction(t) }}
              </div>
            </div>
            <div class="bg-surface-sunken rounded-control p-1.5">
              <div class="text-fg-faint">防御等级</div>
              <div class="font-bold text-violet-300 num">Lv.{{ t.defense_level }}</div>
            </div>
          </div>

          <!-- 防守阵法 -->
          <div v-if="t.defense_formation" class="text-xs text-fg-faint mb-2">
            阵法：<span class="text-violet-300">{{ t.defense_formation }}</span>
          </div>

          <!-- 描述 -->
          <div class="text-xs text-fg-faint leading-relaxed border-t border-line-subtle pt-2 wrap-cjk">
            {{ t.description || '暂无描述' }}
          </div>

          <!-- 占领时间 -->
          <div v-if="t.owner_since" class="text-xs text-fg-faint mt-2 num">
            占领自 {{ formatDate(t.owner_since) }}
          </div>
        </div>
      </div>

      <div v-if="territories.length === 0 && !error && !booting" class="text-center text-fg-faint py-12 text-sm">
        暂无资源点数据
      </div>
    </div>

    <!-- ====== Tab2: 我的宗门 ====== -->
    <div v-else-if="activeTab === 'mysect'" class="space-y-4">
      <div v-if="!mySectInfo" class="text-center text-fg-faint py-12 text-sm">
        你尚未加入任何宗门，无法参与宗门战。
      </div>
      <template v-else>
        <!-- 宗门信息卡 -->
        <PanelCard tone="gold">
          <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div class="flex items-center gap-3">
              <div class="w-12 h-12 rounded-full bg-gold-800/40 border border-gold-600/50 flex items-center justify-center text-2xl">⚔</div>
              <div>
                <div class="text-lg font-bold text-gold-300 font-display">{{ mySectInfo.sect_name }}</div>
                <div class="text-xs text-fg-muted">
                  身份：<span class="text-violet-300 font-bold">{{ getRoleName(mySectInfo.role) }}</span>
                  <Badge v-if="mySectInfo.is_leader" tone="gold" class="ml-1">宗主</Badge>
                </div>
              </div>
            </div>
            <AppButton
              v-if="mySectInfo.is_leader && season?.status === 'active'"
              size="sm"
              variant="primary"
              @click="openDeclareWarModal"
            >
              宣战出师
            </AppButton>
          </div>

          <!-- 资金与战绩 -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div class="bg-surface-sunken rounded-control p-2">
              <div class="text-xs text-fg-faint">宗门资金</div>
              <div class="font-bold text-gold-300 num">{{ formatNumber(mySectInfo.fund.fund_balance) }}</div>
            </div>
            <div class="bg-surface-sunken rounded-control p-2">
              <div class="text-xs text-fg-faint">成员数</div>
              <div class="font-bold text-fg-primary num">{{ mySectInfo.member_count }}</div>
            </div>
            <div class="bg-surface-sunken rounded-control p-2">
              <div class="text-xs text-fg-faint">赛季战绩</div>
              <div class="font-bold text-violet-300 num">{{ mySectInfo.fund.season_war_score }} 分</div>
            </div>
            <div class="bg-surface-sunken rounded-control p-2">
              <div class="text-xs text-fg-faint">占领资源点</div>
              <div class="font-bold text-emerald-300 num">{{ mySectInfo.fund.territories_count }} 处</div>
            </div>
          </div>
        </PanelCard>

        <!-- 已占领资源点 -->
        <PanelCard title="我宗占领的资源点">
          <div v-if="mySectInfo.owned_territories.length === 0" class="text-xs text-fg-faint py-3 text-center">
            暂未占领任何资源点
          </div>
          <ul v-else class="space-y-1.5">
            <li
              v-for="t in mySectInfo.owned_territories"
              :key="t.territory_key"
              class="flex items-center justify-between px-2 py-1.5 rounded-control bg-surface-sunken text-xs"
            >
              <div class="flex items-center gap-2">
                <span :class="getTerritoryIconColor(t.territory_type)">{{ getTerritoryIcon(t.territory_type) }}</span>
                <span class="text-fg-primary font-bold">{{ t.territory_name }}</span>
                <span class="text-fg-faint">{{ getTerritoryTypeName(t.territory_type) }}</span>
              </div>
              <div class="text-fg-muted">
                日产 <span class="num" :class="getProductionColor(t.production_type)">{{ formatProduction(t) }}</span>
              </div>
            </li>
          </ul>
        </PanelCard>

        <!-- 进行中战役 -->
        <PanelCard title="我宗进行中的战役">
          <div v-if="!mySectInfo.ongoing_wars || mySectInfo.ongoing_wars.length === 0" class="text-xs text-fg-faint py-3 text-center">
            暂无进行中的战役
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="w in mySectInfo.ongoing_wars"
              :key="w.id"
              class="px-3 py-2 rounded-control bg-surface-sunken border border-line-subtle cursor-pointer hover:border-gold-700/60 transition-colors"
              @click="openWarDetail(w.id)"
            >
              <div class="flex items-center justify-between text-xs">
                <div class="flex items-center gap-2">
                  <span class="text-gold-300">{{ w.attacker_sect_name }}</span>
                  <span class="text-fg-faint">VS</span>
                  <span class="text-violet-300">{{ w.defender_sect_name }}</span>
                </div>
                <Badge :tone="getWarStatusTone(w.status)">{{ getWarStatusName(w.status) }}</Badge>
              </div>
            </li>
          </ul>
        </PanelCard>
      </template>
    </div>

    <!-- ====== Tab3: 战役 ====== -->
    <div v-else-if="activeTab === 'wars'" class="space-y-4">
      <!-- 战役详情视图 -->
      <template v-if="warDetail">
        <div class="flex items-center justify-between">
          <AppButton size="xs" variant="ghost" @click="closeWarDetail">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>
            </svg>
            返回战役列表
          </AppButton>
          <AppButton size="xs" variant="ghost" :disabled="warDetailLoading" @click="refreshWarDetail">
            {{ warDetailLoading ? '刷新中…' : '刷新详情' }}
          </AppButton>
        </div>

        <!-- 战役标题卡 -->
        <PanelCard tone="gold">
          <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div class="flex items-center gap-3">
              <span class="text-gold-300 font-bold">{{ warDetail.attacker_sect_name }}</span>
              <span class="text-fg-faint text-xs">攻</span>
              <span class="text-rose-400 text-lg">⚔</span>
              <span class="text-fg-faint text-xs">守</span>
              <span class="text-violet-300 font-bold">{{ warDetail.defender_sect_name }}</span>
            </div>
            <Badge :tone="getWarStatusTone(warDetail.status)" :dot="warDetail.status === 'active'">{{ getWarStatusName(warDetail.status) }}</Badge>
          </div>

          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div class="bg-surface-sunken rounded-control p-2">
              <div class="text-fg-faint">奖池</div>
              <div class="font-bold text-gold-300 num">{{ formatNumber(warDetail.war_chest) }} 灵石</div>
            </div>
            <div class="bg-surface-sunken rounded-control p-2">
              <div class="text-fg-faint">目标资源点</div>
              <div class="font-bold" :class="targetTerritoryNameOf(warDetail) === null ? 'text-fg-faint' : 'text-fg-primary'">
                {{ targetTerritoryNameOf(warDetail) ?? '未知' }}
              </div>
            </div>
            <div class="bg-surface-sunken rounded-control p-2">
              <div class="text-fg-faint">参战人数</div>
              <div class="font-bold text-cyan-300 num">攻 {{ warDetail.attacker_count }} / 守 {{ warDetail.defender_count }}</div>
            </div>
            <div class="bg-surface-sunken rounded-control p-2">
              <div class="text-fg-faint">击杀数</div>
              <div class="font-bold text-rose-300 num">攻 {{ warDetail.attacker_kills }} / 守 {{ warDetail.defender_kills }}</div>
            </div>
          </div>

          <!-- 倒计时区 -->
          <div v-if="warDetail.status !== 'settled'" class="mt-3 text-xs flex items-center gap-3">
            <span class="text-fg-faint">{{ getNextStatusLabel(warDetail.status) }}：</span>
            <span class="text-gold-400 font-bold num">{{ formatWarCountdown(warDetail) }}</span>
          </div>
          <div v-else class="mt-3 text-xs">
            <span class="text-fg-faint">胜方：</span>
            <span v-if="winnerSectName !== null" class="font-bold" :class="winnerIsAttacker ? 'text-gold-300' : 'text-violet-300'">
              {{ winnerSectName }}
            </span>
            <span v-else class="text-fg-faint">未知</span>
            <span class="ml-2 text-fg-faint num">结算于 {{ formatDate(warDetail.settle_time) }}</span>
          </div>
        </PanelCard>

        <!-- 战斗操作区（仅 active 阶段且已加入） -->
        <PanelCard v-if="warDetail.status === 'active'" tone="danger">
          <div class="space-y-3">
            <div class="flex items-center justify-between flex-wrap gap-2">
              <div class="text-sm font-bold text-rose-300">交战期 · 可攻击敌方玩家</div>
              <div class="flex gap-2">
                <AppButton
                  v-if="!myParticipant"
                  size="xs"
                  variant="primary"
                  :disabled="operating"
                  @click="handleJoinWar"
                >加入战役</AppButton>
                <template v-else>
                  <AppButton size="xs" variant="outline" :disabled="operating" @click="openLeaveConfirm">离开战场</AppButton>
                  <AppButton
                    v-if="mySectInfo?.is_leader && warDetail.attacker_sect_id === mySectInfo.sect_id"
                    size="xs"
                    variant="danger"
                    :disabled="operating"
                    @click="openSurrenderConfirm"
                  >投降认输</AppButton>
                </template>
              </div>
            </div>

            <!-- 玩家自身状态 -->
            <template v-if="myParticipant">
              <div class="bg-surface-sunken border border-line rounded-control p-3 space-y-2">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-fg-secondary font-bold">{{ myParticipant.player_nickname || '我' }}</span>
                  <span class="text-fg-faint">阵营：<span :class="myParticipant.side === 'attacker' ? 'text-gold-300' : 'text-violet-300'">{{ myParticipant.side === 'attacker' ? '攻方' : '守方' }}</span></span>
                </div>
                <!-- 气血 / 灵力：后端参战名单（_formatParticipant）不带这两个字段，
                     取不到时整条退化为「未知」，不要印 0 / 0。 -->
                <StatBar
                  v-if="myHpPercent !== null"
                  label="气血"
                  tone="blood"
                  height="h-2"
                  :value="myHpPercent ?? 0"
                  :max="100"
                  :text="`${myHpCurrent} / ${myHpMax}`"
                />
                <div v-else class="flex items-center justify-between text-xs">
                  <span class="text-fg-muted">气血</span>
                  <span class="text-fg-faint">未知</span>
                </div>
                <StatBar
                  v-if="myMpPercent !== null"
                  label="灵力"
                  tone="azure"
                  height="h-2"
                  :value="myMpPercent ?? 0"
                  :max="100"
                  :text="`${myMpCurrent} / ${myMpMax}`"
                />
                <div v-else class="flex items-center justify-between text-xs">
                  <span class="text-fg-muted">灵力</span>
                  <span class="text-fg-faint">未知</span>
                </div>
                <!-- 战绩读数：后端参战名单给的是击杀/阵亡次数与贡献分 -->
                <div class="flex items-center gap-3 text-xs text-fg-faint num">
                  <span>击杀 {{ myParticipant.kill_count }}</span>
                  <span>阵亡 {{ myParticipant.death_count }}</span>
                  <span>贡献 <span class="text-violet-300">{{ myParticipant.contribution_score }}</span></span>
                </div>
              </div>

              <!-- 敌方目标列表 -->
              <div class="bg-surface-sunken border border-line rounded-control p-2">
                <div class="text-xs text-fg-faint mb-2">敌方目标（点击选择攻击目标）</div>
                <div v-if="enemyParticipants.length === 0" class="text-xs text-fg-faint py-2 text-center">暂无可攻击的敌方玩家</div>
                <ul v-else class="space-y-1">
                  <li
                    v-for="p in enemyParticipants"
                    :key="p.player_id"
                    @click="selectTarget(p)"
                    class="flex items-center justify-between px-2 py-1.5 rounded-control cursor-pointer text-xs transition-colors"
                    :class="selectedTarget?.player_id === p.player_id
                      ? 'bg-rose-950/40 border border-rose-700/60'
                      : 'bg-surface-hover hover:bg-surface-active border border-transparent'"
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-fg-primary">{{ p.player_nickname }}</span>
                    </div>
                    <div class="flex items-center gap-2 text-fg-faint num">
                      <span>击杀 {{ p.kill_count }}</span>
                      <span>贡献 {{ p.contribution_score }}</span>
                    </div>
                  </li>
                </ul>
              </div>

              <!-- 行动按钮 -->
              <div class="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  @click="handleAttack('attack')"
                  :disabled="actionLoading || !selectedTarget"
                  class="focus-ring px-2 py-2 text-xs font-bold rounded-control bg-rose-900/60 border border-rose-700 text-rose-300 hover:bg-rose-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
                >普攻</button>
                <button
                  type="button"
                  @click="handleAttack('skill')"
                  :disabled="actionLoading || !selectedTarget || mpNotEnough"
                  class="focus-ring px-2 py-2 text-xs font-bold rounded-control bg-violet-900/60 border border-violet-700 text-violet-300 hover:bg-violet-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
                >技能 <span class="text-xs text-cyan-400 num">-{{ SKILL_MP_COST }}MP</span></button>
                <button
                  type="button"
                  @click="handleAttack('defend')"
                  :disabled="actionLoading"
                  class="focus-ring px-2 py-2 text-xs font-bold rounded-control bg-cyan-900/60 border border-cyan-700 text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
                >防御</button>
              </div>

              <!-- 攻击结果展示：后端 attackPlayer 返回的是扁平字段
                   { action, damage, is_crit, attacker_hp, defender_hp, defender_killed,
                     attacker_contribution, attacker_kills } -->
              <div v-if="lastAttackResult" class="bg-surface-sunken border border-gold-800/40 rounded-control p-2 text-xs space-y-1">
                <div class="text-gold-300 font-bold">上一回合战报</div>
                <div class="text-fg-secondary">
                  你<span class="text-gold-300">{{ getActionName(lastAttackResult.action) }}</span>
                  造成 <span class="text-rose-300 font-bold num">{{ formatNumber(lastAttackResult.damage) }}</span> 伤害
                  <span v-if="lastAttackResult.is_crit" class="text-gold-400">（暴击！）</span>
                </div>
                <div v-if="lastAttackResult.defender_killed" class="text-emerald-300 font-bold">击杀成功！</div>
                <div class="text-fg-faint num">
                  累计击杀 {{ lastAttackResult.attacker_kills }} · 累计贡献 {{ lastAttackResult.attacker_contribution }}
                </div>
              </div>

              <!-- 占领资源点按钮 -->
              <div v-if="warDetail.target_territory_id">
                <AppButton
                  variant="primary"
                  block
                  :disabled="operating || captureRemainingSec > 0"
                  @click="handleCapture"
                >
                  <span v-if="captureRemainingSec > 0" class="num">占领中… {{ captureRemainingSec }}s</span>
                  <span v-else>占领目标资源点（30秒计时）</span>
                </AppButton>
                <!-- 占领进度条 -->
                <StatBar
                  v-if="captureRemainingSec > 0"
                  class="mt-1"
                  height="h-1.5"
                  tone="gold"
                  :show-value="false"
                  :value="captureProgress"
                  :max="100"
                />
              </div>
            </template>
          </div>
        </PanelCard>

        <!-- 参战名单：后端把双方名单拆成 attackers / defenders 两个数组返回 -->
        <PanelCard v-if="attackerParticipants.length || defenderParticipants.length" title="参战名单">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
            <div>
              <div class="text-fg-muted mb-1">攻方 · {{ warDetail.attacker_sect_name }}</div>
              <ul class="space-y-1">
                <li v-for="p in attackerParticipants" :key="p.player_id" class="flex items-center justify-between px-2 py-1 rounded-control bg-surface-sunken">
                  <span class="text-fg-primary">{{ p.player_nickname }}</span>
                  <span class="text-fg-faint num">击杀 {{ p.kill_count }} · 贡献 {{ p.contribution_score }}</span>
                </li>
              </ul>
            </div>
            <div>
              <div class="text-fg-muted mb-1">守方 · {{ warDetail.defender_sect_name }}</div>
              <ul class="space-y-1">
                <li v-for="p in defenderParticipants" :key="p.player_id" class="flex items-center justify-between px-2 py-1 rounded-control bg-surface-sunken">
                  <span class="text-fg-primary">{{ p.player_nickname }}</span>
                  <span class="text-fg-faint num">击杀 {{ p.kill_count }} · 贡献 {{ p.contribution_score }}</span>
                </li>
              </ul>
            </div>
          </div>
        </PanelCard>
      </template>

      <!-- 战役列表视图 -->
      <template v-else>
        <!-- 状态过滤 -->
        <div class="flex items-center gap-1 flex-wrap">
          <button
            v-for="opt in warStatusFilters"
            :key="opt.value"
            type="button"
            @click="changeWarFilter(opt.value)"
            class="focus-ring px-3 py-1 rounded-control text-xs transition-colors border"
            :class="warFilter === opt.value
              ? 'bg-surface-tint-gold-strong text-gold-300 border-gold-700/50'
              : 'text-fg-faint border-transparent hover:text-fg-secondary'"
          >{{ opt.label }}</button>
        </div>

        <div v-if="warList.length === 0" class="text-center text-fg-faint py-12 text-sm">
          暂无符合条件的战役
        </div>

        <ul v-else class="space-y-2">
          <li
            v-for="w in warList"
            :key="w.id"
            class="bg-surface-raised border border-line rounded-panel p-3 cursor-pointer hover:border-gold-700/50 transition-colors"
            @click="openWarDetail(w.id)"
          >
            <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
              <div class="flex items-center gap-2 text-sm">
                <span class="text-gold-300 font-bold">{{ w.attacker_sect_name }}</span>
                <span class="text-fg-faint text-xs">攻</span>
                <span class="text-rose-400">⚔</span>
                <span class="text-fg-faint text-xs">守</span>
                <span class="text-violet-300 font-bold">{{ w.defender_sect_name }}</span>
              </div>
              <Badge :tone="getWarStatusTone(w.status)" :dot="w.status === 'active'">{{ getWarStatusName(w.status) }}</Badge>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-fg-muted">
              <div>奖池：<span class="text-gold-300 num">{{ formatNumber(w.war_chest) }}</span></div>
              <div>
                目标：<span :class="targetTerritoryNameOf(w) === null ? 'text-fg-faint' : 'text-fg-primary'">{{ targetTerritoryNameOf(w) ?? '未知' }}</span>
              </div>
              <div>参战：<span class="text-cyan-300 num">{{ w.attacker_participants + w.defender_participants }} 人</span></div>
              <div>击杀：<span class="text-rose-300 num">{{ w.attacker_kills + w.defender_kills }}</span></div>
            </div>
            <div v-if="w.status !== 'settled'" class="mt-2 text-xs text-fg-faint">
              {{ getNextStatusLabel(w.status) }}：<span class="num">{{ formatWarCountdown(w) }}</span>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <!-- ====== Tab4: 排行 ====== -->
    <div v-else-if="activeTab === 'ranking'" class="space-y-4">
      <div class="flex items-center justify-between">
        <div class="text-sm text-fg-muted font-display">
          赛季宗门积分榜
          <!-- 明确当前榜单单据来自哪个赛季，避免玩家把「空榜」误读成「读取失败」 -->
          <span v-if="season" class="text-gold-300 num ml-1">· {{ season.season_name }}</span>
        </div>
        <AppButton size="xs" variant="ghost" :disabled="rankingLoading" @click="fetchRanking">
          {{ rankingLoading ? '刷新中…' : '刷新排行' }}
        </AppButton>
      </div>

      <div v-if="ranking.length === 0" class="text-center text-fg-faint py-12 text-sm">
        {{ season ? '暂无排行数据' : '当前没有进行中的赛季，暂无排行' }}
      </div>

      <ul v-else class="space-y-2">
        <li
          v-for="(r, idx) in ranking"
          :key="r?.sect_id || idx"
          class="flex items-center gap-3 px-3 py-2 rounded-panel border transition-colors"
          :class="idx < 3
            ? 'bg-surface-tint-gold border-gold-700/50'
            : 'bg-surface-raised border-line'"
        >
          <!-- 排名 -->
          <div class="w-10 text-center font-bold text-lg num"
            :class="idx === 0 ? 'text-gold-400' : idx === 1 ? 'text-fg-secondary' : idx === 2 ? 'text-gold-700' : 'text-fg-faint'">
            {{ idx + 1 }}
          </div>
          <!-- 宗门名 -->
          <div class="flex-1 min-w-0">
            <div class="text-sm font-bold truncate" :class="idx < 3 ? 'text-gold-300' : 'text-fg-primary'">{{ r.sect_name }}</div>
            <div class="text-xs text-fg-faint num">宗门 ID：{{ r.sect_id }}</div>
          </div>
          <!-- 数据：字段名与后端 getSeasonRanking 的返回一致 -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-fg-muted">
            <div><span class="text-fg-faint">胜场</span> <span class="text-emerald-300 font-bold num">{{ r.war_wins }}</span></div>
            <div><span class="text-fg-faint">总击杀</span> <span class="text-rose-300 font-bold num">{{ r.total_kills }}</span></div>
            <div><span class="text-fg-faint">资源点</span> <span class="text-gold-300 font-bold num">{{ r.territories_held }}</span></div>
            <div><span class="text-fg-faint">积分</span> <span class="text-violet-300 font-bold num">{{ r.total_score }}</span></div>
          </div>
        </li>
      </ul>
    </div>

    <!-- 底部操作栏 -->
    <template #footer>
      <AppButton size="sm" variant="outline" @click="emit('close')">关闭</AppButton>
      <AppButton size="sm" variant="primary" block :disabled="loading" @click="refreshAll">
        {{ loading ? '刷新中…' : '刷新九州烽烟录' }}
      </AppButton>
    </template>

    <!-- ====== 宣战表单弹窗 ====== -->
    <Modal :isOpen="declareModalShow" title="宣战出师" width="480px" @close="closeDeclareModal">
      <div class="space-y-4">
        <p class="text-fg-secondary text-sm">宗主请慎重决策，宣战将消耗宗门资金 <span class="text-gold-300 font-bold num">{{ formatNumber(DECLARE_WAR_COST) }}</span> 灵石作为军费。</p>

        <!-- 选择防守方宗门 -->
        <div>
          <label class="block text-xs text-fg-muted mb-1">讨伐对象（防守方宗门）</label>
          <select
            v-model="declareForm.defenderSectId"
            class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-sm text-fg-primary focus:border-gold-500 focus:outline-none"
          >
            <option value="">请选择…</option>
            <option
              v-for="s in availableDefenderSects"
              :key="s.sect_id"
              :value="s.sect_id"
            >{{ s.sect_name }}</option>
          </select>
        </div>

        <!-- 选择目标资源点 -->
        <div>
          <label class="block text-xs text-fg-muted mb-1">目标资源点（可选，留空为纯荣誉战）</label>
          <select
            v-model="declareForm.targetTerritoryId"
            class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-sm text-fg-primary focus:border-gold-500 focus:outline-none"
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
        <div class="bg-surface-tint-gold border border-gold-800/50 rounded-control p-2 text-xs text-gold-300">
          宣战军费：<span class="num">{{ formatNumber(DECLARE_WAR_COST) }}</span> 灵石（从宗门资金扣除）
        </div>
      </div>

      <template #footer>
        <AppButton size="sm" variant="outline" @click="closeDeclareModal">取消</AppButton>
        <AppButton size="sm" variant="primary" :disabled="!declareForm.defenderSectId || operating" @click="openDeclareConfirm">
          下一步
        </AppButton>
      </template>
    </Modal>

    <!-- ====== 宣战二次确认弹窗 ====== -->
    <Modal :isOpen="declareConfirmShow" title="二次确认 · 出师讨伐" width="420px" @close="declareConfirmShow = false">
      <div class="space-y-2 text-sm">
        <p class="text-fg-secondary">确认向以下宗门宣战？</p>
        <div class="bg-surface-sunken rounded-control p-2 text-xs space-y-1">
          <div><span class="text-fg-faint">讨伐对象：</span><span class="text-violet-300 font-bold">{{ selectedDefenderName }}</span></div>
          <div><span class="text-fg-faint">目标资源点：</span><span class="text-gold-300">{{ selectedTargetName }}</span></div>
          <div><span class="text-fg-faint">军费消耗：</span><span class="text-gold-300 font-bold num">{{ formatNumber(DECLARE_WAR_COST) }} 灵石</span></div>
        </div>
        <p class="text-rose-400 text-xs">宣战后进入备战期（24 小时），备战期结束转通告期（2 小时），通告期起才能加入战场；交战期默认 30 分钟。</p>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="declareConfirmShow = false">再想想</AppButton>
        <AppButton size="sm" variant="danger" :disabled="operating" @click="handleDeclareWar">
          {{ operating ? '出征中…' : '确认宣战' }}
        </AppButton>
      </template>
    </Modal>

    <!-- ====== 离开战役确认弹窗 ====== -->
    <Modal :isOpen="leaveConfirmShow" title="离开战场确认" width="420px" @close="leaveConfirmShow = false">
      <p class="text-fg-secondary text-sm">确认要离开这场战役吗？</p>
      <p class="text-rose-400 text-xs mt-2">
        离开后你从参战名单中移除，需重新加入才能攻击/占领；已积累的贡献分与战败荣誉结算不受影响。
      </p>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="leaveConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="danger" :disabled="operating" @click="handleLeaveWar">
          {{ operating ? '执行中…' : '确认离开' }}
        </AppButton>
      </template>
    </Modal>

    <!-- ====== 投降确认弹窗 ====== -->
    <Modal :isOpen="surrenderConfirmShow" title="投降认输确认" width="420px" @close="surrenderConfirmShow = false">
      <p class="text-fg-secondary text-sm">宗主，确认要投降认输吗？</p>
      <p class="text-rose-400 text-xs mt-2">
        投降后对方获胜并获得全部奖池，本宗宗门资金扣除已付出的军费。此操作不可撤销。
      </p>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="surrenderConfirmShow = false">再战</AppButton>
        <AppButton size="sm" variant="danger" :disabled="operating" @click="handleSurrender">
          {{ operating ? '执行中…' : '确认投降' }}
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
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
import { formatBeijing } from '../../utils/time'
import { useUIStore } from '../../stores/ui'
import { useAsyncTask } from '../../composables/useAsyncTask'
import { usePlayerStore } from '../../stores/player'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import StatBar from '../ui/StatBar.vue'
import ErrorState from '../ui/ErrorState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
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
  type WarStatus,
  type WarAction
} from '../../api/sectWar'
// 注：api/sectWar.ts 里的 WarListItem / WarDetail / AttackPlayerResult 类型与
// server/routes/sect_war.js + SectWarService 的实际返回不一致（多出一批后端不发的字段），
// 因此本面板内这几个对象按后端字段以 any 读取，避免照着错类型写代码。

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

// ====== 配置常量（前端仅作展示，业务值由后端权威计算） ======
/** 技能消耗 MP（game_balance.combat.skill_mp_cost，仅用于按钮禁用判断，后端权威） */
const SKILL_MP_COST = 20
/** 宣战军费灵石数（game_balance.sect_war.declare_cost_spirit_stones，仅展示，后端权威扣费） */
const DECLARE_WAR_COST = 5000
/** 占领计时秒数（game_balance.sect_war.territory_capture_seconds，仅用于本地进度条展示） */
const CAPTURE_TOTAL_SEC = 30

// ====== 响应式状态 ======
const loading = ref(true)                  // 整体加载锁
/**
 * 首屏列表（资源点）拉取失败记账
 * 页签栏在插槽里，:error / :loading 都不能交给 PanelShell —— 外壳会整块替换插槽，
 * 连带把「资源点/我的宗门/战役/排行」四个页签一起藏掉，玩家再也切不过去；
 * 所以加载态与错误态都渲染在页签体内部（见 tab1 的 LoadingBlock / ErrorState）。
 */
const { error, run } = useAsyncTask({ fallback: '获取资源点列表失败' })
const operating = ref(false)               // 操作中状态锁，防止重复提交
const actionLoading = ref(false)           // 战斗动作加载锁
const territoryLoading = ref(false)        // 资源点刷新加载
const warDetailLoading = ref(false)        // 战役详情刷新加载
const rankingLoading = ref(false)          // 排行刷新加载

const activeTab = ref<'territories' | 'mysect' | 'wars' | 'ranking'>('territories')
const season = ref<SectWarSeason | null>(null)
const territories = ref<Territory[]>([])
const mySectInfo = ref<MySectInfo | null>(null)
const warList = ref<any[]>([])
const warDetail = ref<any | null>(null)
const ranking = ref<any[]>([])

// 战役状态过滤
const warFilter = ref<'all' | WarStatus>('all')

// 战斗相关
const selectedTarget = ref<any>(null)              // 当前选中的攻击目标
const lastAttackResult = ref<any | null>(null)     // 最近一次攻击结果（后端扁平字段）
const captureRemainingSec = ref(0)                  // 占领剩余秒数（本地倒计时）
const captureTimer = ref<number | null>(null)       // 占领计时器句柄

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
 * 首屏加载态：只在真的还没有任何数据时展示 LoadingBlock，
 * 之后刷新（含无赛季的账号）不再清空页签体内容。
 */
const booting = computed(() =>
  loading.value && !season.value && territories.value.length === 0 && !mySectInfo.value)

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
 * 只列有数字主键的记录：/territories 在赛季尚未初始化时只回静态配置、没有 id，
 * 那种情况下没有后端认得的 territory_id，不能当宣战目标。
 */
const targetableTerritories = computed(() => {
  if (!mySectInfo.value) return []
  return territories.value.filter(t =>
    typeof (t as any).id === 'number' && t.owner_sect_id !== mySectInfo.value!.sect_id)
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
 * 战役详情：攻方参战玩家（后端已按阵营拆好两个数组：attackers / defenders）
 */
const attackerParticipants = computed<any[]>(() => warDetail.value?.attackers || [])

/**
 * 战役详情：守方参战玩家
 */
const defenderParticipants = computed<any[]>(() => warDetail.value?.defenders || [])

/**
 * 战役详情：敌方玩家列表（用于选择攻击目标）
 * 本宗门既非攻方也非守方时返回空，不给旁观战役列出「可攻击目标」。
 */
const enemyParticipants = computed<any[]>(() => {
  const detail = warDetail.value
  const mySectId = mySectInfo.value?.sect_id
  if (!detail || !mySectId) return []
  if (detail.attacker_sect_id === mySectId) return detail.defenders || []
  if (detail.defender_sect_id === mySectId) return detail.attackers || []
  return []
})

/**
 * 战役详情：我的参战信息
 * 后端 player_id 是整数、store 里的 id 可能是字符串，统一按数值比较。
 */
const myParticipant = computed<any | null>(() => {
  if (!warDetail.value || !playerStore.player) return null
  const myPlayerId = Number(playerStore.player.id)
  const all = [...attackerParticipants.value, ...defenderParticipants.value]
  return all.find(p => Number(p.player_id) === myPlayerId) || null
})

/**
 * 我的气血 / 灵力读数。
 * 后端 _formatParticipant 的名单字段只有 kill_count/death_count/contribution_score，
 * 不含 HP/MP（战斗中的 HP/MP 只存在玩家 attributes 里，宗门战接口不外泄），
 * 所以取不到时保持 null，界面显示「未知」而不是 0 / 0。
 */
const myHpCurrent = computed<number | null>(() =>
  typeof myParticipant.value?.hp_current === 'number' ? myParticipant.value.hp_current : null)
const myHpMax = computed<number | null>(() =>
  typeof myParticipant.value?.hp_max === 'number' ? myParticipant.value.hp_max : null)
const myMpCurrent = computed<number | null>(() =>
  typeof myParticipant.value?.mp_current === 'number' ? myParticipant.value.mp_current : null)
const myMpMax = computed<number | null>(() =>
  typeof myParticipant.value?.mp_max === 'number' ? myParticipant.value.mp_max : null)

const myHpPercent = computed<number | null>(() => {
  const cur = myHpCurrent.value
  const max = myHpMax.value
  if (cur === null || max === null || max <= 0) return null
  return Math.max(0, Math.min(100, (cur / max) * 100))
})
const myMpPercent = computed<number | null>(() => {
  const cur = myMpCurrent.value
  const max = myMpMax.value
  if (cur === null || max === null || max <= 0) return null
  return Math.max(0, Math.min(100, (cur / max) * 100))
})

/** 灵力不足：仅在后端真的给了 MP 值时才用来禁用技能按钮，未知时交给后端判定（MP 不足后端会降级为普攻） */
const mpNotEnough = computed(() =>
  myMpCurrent.value !== null && myMpCurrent.value < SKILL_MP_COST)

/**
 * 战役详情：胜方宗门名 / 是否攻方获胜。
 * 后端只有 winner_sect_id/loser_sect_id（没有 winner_side），
 * 故按 winner_sect_id 与 attacker_sect_id 比对得出，未结算时为 null。
 */
const winnerSectName = computed<string | null>(() => {
  const detail = warDetail.value
  if (!detail?.winner_sect_id) return null
  return winnerIsAttacker.value ? detail.attacker_sect_name : detail.defender_sect_name
})
const winnerIsAttacker = computed<boolean | null>(() => {
  const detail = warDetail.value
  if (!detail?.winner_sect_id) return null
  return detail.winner_sect_id === detail.attacker_sect_id
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
    uiStore.showApiError(error, '加载宗门战数据失败')
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
 * 失败交给 useAsyncTask 记账：页签体内有常驻错误态 + 重试，不再只留一行 console
 */
const fetchTerritories = async () => {
  territoryLoading.value = true
  await run(async () => {
    const res = await getTerritories()
    territories.value = res.data?.data ?? []
  })
  territoryLoading.value = false
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
    uiStore.showApiError(error, '获取战役详情失败')
  } finally {
    warDetailLoading.value = false
  }
}

/**
 * 获取赛季宗门排行
 * 响应统一经 normalizeRankingPayload 归一化：无论后端返回数组、{ list } 还是
 * { ranking } 包装，落到 ranking 的一定是「干净的对象数组」，杜绝渲染期崩面板。
 */
const fetchRanking = async () => {
  rankingLoading.value = true
  try {
    const res = await getSeasonRanking(season.value?.id, 100)
    ranking.value = normalizeRankingPayload(res.data?.data)
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
  actionLoading.value = true
  try {
    const targetId = selectedTarget.value?.player_id ?? 0
    const res = await attackPlayer(warDetail.value.id, targetId, action)
    // 后端统一包了 { code, data }，战报字段在 data 里且是扁平的
    const result = res.data?.data ?? null
    lastAttackResult.value = result

    // 构建日志文本并提示：阵亡/复活等状态由后端在攻击接口里直接报错，前端不猜
    const dmg = result?.damage ?? 0
    const killed = result?.defender_killed === true
    let msg = `${getActionName(result?.action || action)} · 造成 ${dmg} 伤害`
    if (result?.is_crit) msg += '（暴击）'
    if (killed) msg += ` · 击杀！累计贡献 ${result?.attacker_contribution ?? 0}`
    uiStore.showToast(msg, killed ? 'success' : 'info')

    // 攻击成功后立即刷新详情（同步双方击杀数与参战名单）
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
    uiStore.showToast(res.data?.data?.message || '已加入战役', 'success')
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
    uiStore.showToast(res.data?.data?.message || '已离开战役', 'info')
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
    uiStore.showToast(res.data?.data?.message || '已投降', 'info')
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
    uiStore.showToast(res.data?.data?.message || '宣战成功', 'success')

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
 * 归一化排行接口响应 → 可安全遍历的对象数组
 *
 * 为什么需要：模板 `v-for="(r, idx) in ranking"` 只接受「数组」。
 * 一旦拿到的是对象（例如后端无赛季时曾降级返回 { ranking: [], season: null }），
 * Vue 会把对象的属性值当条目遍历，其中 null 值读 r.sect_id 直接抛
 * TypeError 被 PanelBoundary 捕获，整个宗门战面板变成「该面板加载失败」。
 * 所以这里做三件事：拆包装、强制数组、剔除 null / 非对象项。
 *
 * @param payload 后端 data 字段（正常为数组，兼容 { list } / { ranking } 包装）
 * @returns 排行条目数组，任何异常形态一律返回 []
 */
const normalizeRankingPayload = (payload: unknown): any[] => {
  let raw: unknown = payload
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const wrapped = raw as Record<string, unknown>
    raw = wrapped.list ?? wrapped.ranking ?? wrapped.data ?? []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is Record<string, any> => !!item && typeof item === 'object')
}

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
    strategic: 'text-gold-400'
  }
  return map[type] || 'text-fg-muted'
}

/**
 * 资源点卡片整体样式（按类型 + 占领状态）
 */
const getTerritoryCardClass = (t: Territory): string => {
  const typeBorderMap: Record<string, string> = {
    spirit_vein: 'border-cyan-900/40 hover:border-cyan-700/60',
    mine: 'border-orange-900/40 hover:border-orange-700/60',
    secret_realm: 'border-violet-900/40 hover:border-violet-700/60',
    strategic: 'border-gold-800/50 hover:border-gold-700/60'
  }
  const base = typeBorderMap[t.territory_type] || 'border-line hover:border-line-strong'
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
    spirit_stones: 'text-gold-300',
    materials: 'text-orange-300',
    contribution: 'text-violet-300'
  }
  return map[type] || 'text-fg-secondary'
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
 * 战役状态 → 徽章色（tone 取值见 ui/Badge.vue）
 */
const getWarStatusTone = (status: WarStatus): string => {
  const map: Record<WarStatus, string> = {
    preparing: 'gold',
    announced: 'arcane',
    active: 'danger',
    settled: 'muted'
  }
  return map[status] || 'neutral'
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
 * 战役下一阶段截止时间（毫秒时间戳）
 * 后端 _formatWar 给的是分段字段，没有统一的 next_status_time：
 *   preparing → prepare_end_time、announced → active_start_time、active → active_end_time
 * 已结算 / 已取消 / 时间字段缺失时返回 null。
 */
const getWarPhaseEndTime = (war: any): number | null => {
  if (!war) return null
  const phaseTime = war.status === 'preparing' ? war.prepare_end_time
    : war.status === 'announced' ? war.active_start_time
    : war.status === 'active' ? war.active_end_time
    : null
  if (!phaseTime) return null
  const target = new Date(phaseTime).getTime()
  return Number.isFinite(target) ? target : null
}

/**
 * 战役距下一阶段的剩余毫秒；没有下一阶段时返回 null（界面显示未知）
 */
const getWarRemainingMs = (war: any): number | null => {
  const target = getWarPhaseEndTime(war)
  if (target === null) return null
  return Math.max(0, target - now.value)
}

/**
 * 战役倒计时文案：拿不到阶段时间时给「未知」，不印 undefined / NaN
 */
const formatWarCountdown = (war: any): string => {
  const remaining = getWarRemainingMs(war)
  return remaining === null ? '未知' : formatCountdownText(remaining)
}

/**
 * 目标资源点名
 * 详情接口的 target_territory 是 _formatTerritory 对象（名字在 territory_name 上），
 * 列表项只有 target_territory_id，按 id 到已加载的资源点里查名。
 * 无目标即后端口径里的「纯荣誉战」；有 id 却查不到名字返回 null（界面显示未知）。
 */
const targetTerritoryNameOf = (war: any): string | null => {
  const id = war?.target_territory_id
  if (!id) return '纯荣誉战'
  const fromDetail = war?.target_territory?.territory_name
  if (typeof fromDetail === 'string' && fromDetail) return fromDetail
  const known = territories.value.find(t => Number((t as any).id) === Number(id))
  return known?.territory_name || null
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
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(dateStr, { seconds: false, fallback: '—' })
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
 * 资源点 → 数字 ID（后端 declareWar / captureTerritory 按 sect_war_territories 主键解析）
 * /territories 在赛季资源点尚未初始化时只回静态配置、没有 id，此时返回 null，
 * 由 targetableTerritories 过滤掉 —— 不再用坐标编造一个后端认不得的 ID。
 */
const getTerritoryNumericId = (t: Territory): number | null =>
  typeof (t as any).id === 'number' ? (t as any).id : null

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
