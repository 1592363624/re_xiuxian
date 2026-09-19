<!--
 * PVP 斗法面板组件
 *
 * 弹窗式组件，展示玩家 PVP 状态、进行中战斗、排行榜、段位信息。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 二次确认使用 common/Modal，外壳与卡片走 ui/PanelShell + ui/PanelCard
 *   - 冷却倒计时基于 server_time + cooldown_remaining_seconds 本地 tick 递减
 *   - 战斗日志展示按时间倒序（最新在上）
 *   - 颜色风格：PVP 用血光系（red/rose）区分战斗主题
 *
 * 数据来源：
 *   - getStatus()：玩家自身段位、战绩、进行中战斗、冷却、虚弱、配置
 *   - getLeaderboard(10)：前 10 名玩家排行榜
 *   - executeAction() / flee()：战斗动作
-->
<template>
  <PanelShell
    title="斗法场"
    hint="段位 · 挑战 · 天榜"
    size="xl"
    :loading="loading && !status"
    :error="error"
    @close="$emit('close')"
    @retry="refreshAll"
  >
    <template #header-actions>
      <div class="hidden sm:flex items-center gap-2">
        <Badge tone="danger">{{ status?.ranking?.rank_tier || '散修' }}</Badge>
        <Badge tone="gold">今日挑战 <span class="num">{{ challengeRemaining }}</span></Badge>
        <Badge :tone="cooldownRemaining > 0 ? 'muted' : 'success'">
          {{ cooldownRemaining > 0 ? formatTime(cooldownRemaining) : '可挑战' }}
        </Badge>
      </div>
    </template>

    <div v-if="status" class="space-y-4">
      <!-- 段位卡：段位名 + 积分 + 胜率 + 连胜 -->
      <PanelCard tone="danger">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-full bg-rose-900/40 border border-red-600/50 flex items-center justify-center shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-300">
                <path d="M14.5 17.5L3 6V3h3l11.5 11.5"/>
                <path d="M13 19l6-6"/>
                <path d="M16 16l4 4"/>
              </svg>
            </div>
            <div>
              <div class="text-2xl font-bold text-red-300 font-display">{{ status.ranking.rank_tier || '散修' }}</div>
              <div class="text-xs text-fg-muted">段位</div>
            </div>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div class="text-xs text-fg-faint">积分</div>
              <div class="text-red-300 font-bold num">{{ formatCompact(status.ranking.score) }}</div>
            </div>
            <div>
              <div class="text-xs text-fg-faint">胜率</div>
              <div class="text-gold-300 font-bold num">{{ status.ranking.win_rate }}%</div>
            </div>
            <div>
              <div class="text-xs text-fg-faint">连胜</div>
              <div class="text-emerald-300 font-bold num">{{ status.ranking.win_streak }}</div>
            </div>
            <div>
              <div class="text-xs text-fg-faint">最高连胜</div>
              <div class="text-purple-300 font-bold num">{{ status.ranking.max_win_streak }}</div>
            </div>
          </div>
        </div>
      </PanelCard>

      <!-- 状态区：剩余次数、冷却、虚弱、荣誉、因果 -->
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        <!-- 今日挑战剩余 -->
        <div class="bg-surface-raised border border-line rounded-panel p-3">
          <div class="text-xs text-fg-muted mb-1">今日挑战</div>
          <div class="text-sm font-bold num"
            :class="challengeRemaining > 0 ? 'text-red-400' : 'text-fg-faint'">
            {{ challengeRemaining }} / {{ status.config?.daily_challenge_limit || 0 }}
          </div>
        </div>
        <!-- 今日防守剩余 -->
        <div class="bg-surface-raised border border-line rounded-panel p-3">
          <div class="text-xs text-fg-muted mb-1">今日防守</div>
          <div class="text-sm font-bold num"
            :class="defendRemaining > 0 ? 'text-gold-400' : 'text-fg-faint'">
            {{ defendRemaining }} / {{ status.config?.daily_defend_limit || 0 }}
          </div>
        </div>
        <!-- 冷却倒计时 -->
        <div class="bg-surface-raised border border-line rounded-panel p-3">
          <div class="text-xs text-fg-muted mb-1">战斗冷却</div>
          <div v-if="cooldownRemaining > 0" class="text-sm font-bold text-gold-400 num">
            {{ formatTime(cooldownRemaining) }}
          </div>
          <div v-else class="text-sm font-bold text-emerald-400">可挑战</div>
        </div>
        <!-- 荣誉值 -->
        <div class="bg-surface-raised border border-line rounded-panel p-3">
          <div class="text-xs text-fg-muted mb-1">荣誉值</div>
          <div class="text-sm font-bold text-gold-300 num">{{ formatCompact(status.player.honor) }}</div>
        </div>
        <!-- 因果值 -->
        <div class="bg-surface-raised border border-line rounded-panel p-3">
          <div class="text-xs text-fg-muted mb-1">因果值</div>
          <div class="text-sm font-bold num"
            :class="status.player.karma < 0 ? 'text-rose-400' : 'text-fg-primary'">
            {{ status.player.karma }}
          </div>
        </div>
        <!-- 战力 -->
        <div class="bg-surface-raised border border-line rounded-panel p-3">
          <div class="text-xs text-fg-muted mb-1">战力</div>
          <div class="text-sm font-bold text-cyan-300 num">{{ formatCompact(status.player.power) }}</div>
        </div>
      </div>

      <!-- 虚弱状态警告（仅虚弱时显示） -->
      <PanelCard v-if="status.player.is_weak" tone="danger">
        <div class="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div class="flex-1">
            <div class="text-rose-300 font-bold text-sm">斗法落败 · 灵力虚浮</div>
            <div class="text-xs text-rose-400/80">
              剩余 <span class="num">{{ formatTime(weaknessRemaining) }}</span> · 修炼/突破效率下降，请静养恢复
            </div>
          </div>
        </div>
      </PanelCard>

      <!-- 避世/入世模式卡 -->
      <!-- 玩法文档第17节：避世可免疫斗法与袭扰，入世则恢复正常 PVP 交互 -->
      <PanelCard :tone="isRecluseMode ? 'plain' : 'success'">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <!-- 避世图标：山间幽居 -->
            <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
              :class="isRecluseMode ? 'bg-cyan-900/40 border border-cyan-600/50' : 'bg-emerald-900/40 border border-emerald-600/50'">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5"
                :class="isRecluseMode ? 'text-cyan-300' : 'text-emerald-300'"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 20h18"/>
                <path d="M5 20V8l5-4 5 4v12"/>
                <path d="M9 20v-6h2v6"/>
              </svg>
            </div>
            <div>
              <div class="text-sm font-bold"
                :class="isRecluseMode ? 'text-cyan-300' : 'text-emerald-300'">
                {{ status.pvp_mode_name || '入世' }}
              </div>
              <div class="text-xs mt-0.5"
                :class="isRecluseMode ? 'text-cyan-400/70' : 'text-fg-muted'">
                {{ isRecluseMode
                  ? '避世清修·免疫斗法袭扰，自身亦不可发起挑战'
                  : '入世历劫·可正常参与 PVP 挑战、决斗、封神台' }}
              </div>
            </div>
          </div>
          <!-- 切换按钮 -->
          <AppButton
            size="xs"
            :variant="isRecluseMode ? 'primary' : 'outline'"
            :disabled="modeSwitching"
            @click="openPvpModeConfirm"
          >
            {{ modeSwitching ? '切换中…' : (isRecluseMode ? '入世' : '避世') }}
          </AppButton>
        </div>
      </PanelCard>

      <!-- 进行中战斗区 -->
      <PanelCard v-if="status.is_in_pvp_battle && status.battle_info" tone="danger">
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Badge tone="danger" solid>战斗中</Badge>
              <span class="text-xs text-fg-muted num">回合 {{ status.battle_info.current_round }} / {{ status.battle_info.max_rounds }}</span>
            </div>
            <div class="text-xs"
              :class="status.battle_info.is_my_turn ? 'text-emerald-400 font-bold' : 'text-gold-400'">
              {{ status.battle_info.is_my_turn ? '己方回合' : '对手回合' }}
            </div>
          </div>

          <!-- 对手信息 -->
          <div class="bg-surface-sunken border border-red-900/30 rounded-panel p-3">
            <div class="flex items-center justify-between text-sm mb-2">
              <div class="flex items-center gap-2">
                <span class="text-fg-muted text-xs">对手：</span>
                <span class="text-red-300 font-bold">{{ status.battle_info.opponent_nickname }}</span>
                <span class="text-xs text-fg-faint">[{{ status.battle_info.opponent_realm }}]</span>
              </div>
              <div class="text-xs text-fg-faint">
                对手战力：<span class="text-red-300 num">{{ formatCompact(status.battle_info.opponent_power) }}</span>
                <span class="mx-1">|</span>
                己方战力：<span class="text-cyan-300 num">{{ formatCompact(status.battle_info.attacker_power) }}</span>
              </div>
            </div>
            <!-- HP 进度条 -->
            <div class="space-y-2">
              <StatBar
                label="己方气血"
                tone="azure"
                height="h-2"
                :value="currentAttackerHp"
                :max="maxHp"
                :text="`${currentAttackerHp} / ${maxHp}`"
              />
              <StatBar
                label="对手气血"
                tone="blood"
                height="h-2"
                :value="currentDefenderHp"
                :max="maxHp"
                :text="`${currentDefenderHp} / ${maxHp}`"
              />
            </div>

            <!-- 五行相克展示（基于灵根属性，增加 PVP 策略深度） -->
            <!-- 后端 battle_info.element_info 返回双方灵根克制关系与伤害倍率 -->
            <div v-if="status.battle_info.element_info" class="bg-surface-sunken border rounded-panel p-2 mt-2"
              :class="elementBorderColor(status.battle_info.element_info)">
              <div class="flex items-center justify-between gap-2">
                <!-- 己方灵根 -->
                <div class="flex items-center gap-1.5">
                  <span class="text-xs text-fg-muted">己方</span>
                  <span v-if="status.battle_info.element_info.my_element"
                    class="px-1.5 py-0.5 rounded-control text-xs font-bold border"
                    :class="elementBadgeClass(status.battle_info.element_info.my_element)">
                    {{ elementIcon(status.battle_info.element_info.my_element) }}
                    {{ elementName(status.battle_info.element_info.my_element) }}
                  </span>
                  <span v-else class="text-xs text-fg-faint">无属性</span>
                </div>
                <!-- 克制关系 -->
                <div class="flex-1 text-center">
                  <div v-if="status.battle_info.element_info.matchup"
                    class="text-xs font-bold"
                    :class="elementAdvantageTextClass(status.battle_info.element_info)">
                    {{ status.battle_info.element_info.matchup }}
                    <span class="ml-1 num">×{{ status.battle_info.element_info.multiplier }}</span>
                  </div>
                  <div v-else class="text-xs text-fg-faint">无相克关系 <span class="num">×1.0</span></div>
                </div>
                <!-- 对手灵根 -->
                <div class="flex items-center gap-1.5">
                  <span v-if="status.battle_info.element_info.opponent_element"
                    class="px-1.5 py-0.5 rounded-control text-xs font-bold border"
                    :class="elementBadgeClass(status.battle_info.element_info.opponent_element)">
                    {{ elementIcon(status.battle_info.element_info.opponent_element) }}
                    {{ elementName(status.battle_info.element_info.opponent_element) }}
                  </span>
                  <span v-else class="text-xs text-fg-faint">无属性</span>
                  <span class="text-xs text-fg-muted">对手</span>
                </div>
              </div>
              <!-- 克制提示文案 -->
              <div v-if="status.battle_info.element_info.matchup" class="text-center mt-1.5 text-xs"
                :class="status.battle_info.element_info.advantage === 'attacker' ? 'text-emerald-400' : 'text-rose-400'">
                {{ status.battle_info.element_info.advantage === 'attacker'
                  ? '己方灵根克制对手，伤害提升'
                  : '对手灵根克制己方，伤害降低' }}
              </div>
            </div>
          </div>

          <!-- 战斗日志（最近 5 条，最新在上） -->
          <div class="bg-surface-sunken border border-line rounded-panel p-2">
            <div class="text-xs text-fg-faint mb-1">战斗记录</div>
            <div v-if="recentLogs.length === 0" class="text-xs text-fg-faint py-2 text-center">尚无战斗记录</div>
            <ul v-else class="space-y-1 text-xs">
              <li v-for="(log, idx) in recentLogs" :key="idx"
                class="flex items-start gap-2 px-2 py-1 rounded-control"
                :class="log.actor === 'attacker' ? 'bg-cyan-950/30' : 'bg-red-950/30'">
                <span class="text-fg-faint shrink-0 num">[R{{ log.round || '-' }}]</span>
                <span :class="log.actor === 'attacker' ? 'text-cyan-300' : 'text-red-300'">
                  {{ log.actor === 'attacker' ? '攻' : '守' }}
                </span>
                <span class="text-fg-secondary flex-1">{{ formatLogText(log) }}</span>
                <!-- 五行克制标签（行动方对目标方的克制关系） -->
                <span v-if="log.element && log.element.name"
                  class="shrink-0 px-1 rounded-control text-[10px] font-bold"
                  :class="log.element.advantage === 'attacker'
                    ? 'text-emerald-400 bg-emerald-950/50'
                    : 'text-rose-400 bg-rose-950/50'">
                  {{ log.element.name }}
                </span>
                <span v-if="log.damage > 0" class="text-gold-400 shrink-0 num">-{{ log.damage }}</span>
              </li>
            </ul>
          </div>

          <!-- 操作按钮 -->
          <div class="grid grid-cols-5 gap-2">
            <button
              type="button"
              @click="handleAction('attack')"
              :disabled="actionLoading || !status.battle_info.is_my_turn"
              class="focus-ring px-2 py-2 text-xs font-bold rounded-control bg-red-900/50 border border-red-700 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
            >攻击</button>
            <button
              type="button"
              @click="handleAction('skill')"
              :disabled="actionLoading || !status.battle_info.is_my_turn"
              class="focus-ring px-2 py-2 text-xs font-bold rounded-control bg-purple-900/50 border border-purple-700 text-purple-300 hover:bg-purple-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
            >技能</button>
            <button
              type="button"
              @click="handleAction('defend')"
              :disabled="actionLoading || !status.battle_info.is_my_turn"
              class="focus-ring px-2 py-2 text-xs font-bold rounded-control bg-cyan-900/50 border border-cyan-700 text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
            >防御</button>
            <button
              type="button"
              @click="openBattleItems"
              :disabled="actionLoading || !status.battle_info.is_my_turn"
              class="focus-ring px-2 py-2 text-xs font-bold rounded-control bg-gold-800/50 border border-gold-700 text-gold-300 hover:bg-gold-700/60 disabled:opacity-40 disabled:cursor-not-allowed"
            >丹药</button>
            <button
              type="button"
              @click="openFleeConfirm"
              :disabled="actionLoading"
              class="focus-ring px-2 py-2 text-xs font-bold rounded-control bg-surface-active border border-line-strong text-fg-secondary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >逃跑</button>
          </div>
        </div>
      </PanelCard>

      <!-- 排行榜区（前 10 名） -->
      <PanelCard title="天榜前十">
        <template #action>
          <AppButton size="xs" variant="ghost" :disabled="leaderboardLoading" @click="refreshLeaderboard">
            {{ leaderboardLoading ? '刷新中…' : '刷新' }}
          </AppButton>
        </template>
        <div v-if="leaderboard.length === 0" class="text-xs text-fg-faint py-2 text-center">暂无榜单数据</div>
        <ul v-else class="space-y-1 text-xs">
          <li v-for="(item, idx) in leaderboard" :key="item.player_id"
            class="flex items-center justify-between px-2 py-1 rounded-control"
            :class="idx < 3 ? 'bg-surface-tint-gold' : ''">
            <div class="flex items-center gap-2">
              <span class="w-5 text-center font-bold num"
                :class="idx === 0 ? 'text-gold-400' : idx === 1 ? 'text-fg-secondary' : idx === 2 ? 'text-gold-700' : 'text-fg-faint'">
                {{ idx + 1 }}
              </span>
              <span class="text-fg-primary">{{ item.nickname }}</span>
              <span class="text-xs text-fg-faint">[{{ item.rank_tier }}]</span>
            </div>
            <div class="flex items-center gap-3 text-fg-muted">
              <span>积分 <span class="text-red-300 font-bold num">{{ item.score }}</span></span>
              <span>胜率 <span class="text-gold-300 num">{{ calcWinRate(item) }}%</span></span>
            </div>
          </li>
        </ul>
      </PanelCard>

      <!-- 段位信息区 -->
      <PanelCard title="段位阶序">
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
          <div v-for="(rank, idx) in (status.config?.ranks || [])" :key="idx"
            class="px-2 py-1.5 rounded-control border flex items-center justify-between"
            :class="rank.name === status.ranking.rank_tier
              ? 'bg-red-900/40 border-red-600 text-red-300'
              : 'bg-surface-sunken border-line-subtle text-fg-muted'">
            <span class="font-bold">{{ rank.name }}</span>
            <span class="num">{{ formatScoreRange(rank) }}</span>
          </div>
        </div>
      </PanelCard>
    </div>

    <!-- 底部操作栏 -->
    <template #footer>
      <AppButton size="sm" variant="outline" @click="$emit('close')">关闭</AppButton>
      <AppButton size="sm" variant="danger" block :disabled="loading" @click="refreshAll">
        {{ loading ? '刷新中…' : '刷新斗法录' }}
      </AppButton>
    </template>

    <!-- 逃跑确认弹窗 -->
    <Modal :isOpen="fleeConfirmShow" title="逃跑确认" width="420px" @close="fleeConfirmShow = false">
      <p class="text-fg-secondary text-sm">确定要逃跑吗？</p>
      <p class="text-rose-400 text-xs mt-2">逃跑将视为失败结算：扣除积分、可能进入虚弱状态，且不会获得任何奖励。</p>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="fleeConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="danger" :disabled="actionLoading" @click="confirmFlee">
          {{ actionLoading ? '执行中…' : '确认逃跑' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 丹药选择弹窗（PVP 战斗中使用消耗品） -->
    <Modal :isOpen="battleItemsShow" title="使用丹药" width="480px" @close="battleItemsShow = false">
      <div class="space-y-3">
        <!-- 剩余次数提示 -->
        <div class="flex items-center justify-between text-xs">
          <span class="text-fg-muted">本场剩余使用次数</span>
          <span class="font-bold num" :class="battleItemsRemaining > 0 ? 'text-gold-400' : 'text-rose-400'">
            {{ battleItemsRemaining }} / {{ battleItemsMax }}
          </span>
        </div>

        <!-- 加载中 -->
        <LoadingBlock v-if="battleItemsLoading" text="正在翻阅随身丹药…" />

        <!-- 无可用丹药 -->
        <EmptyState
          v-else-if="battleItems.length === 0"
          text="背包中没有可在战斗中使用的丹药"
          hint="回春丹、小还丹、大还丹、凝气丹、聚灵丹可在战斗中使用"
        />

        <!-- 丹药列表 -->
        <div v-else class="space-y-2 max-h-64 overflow-y-auto scroll-thin">
          <button
            v-for="item in battleItems"
            :key="item.item_id"
            type="button"
            @click="handleUseItem(item.item_id)"
            :disabled="actionLoading || battleItemsRemaining <= 0"
            class="w-full flex items-center gap-3 p-3 rounded-panel border transition-all text-left disabled:opacity-40 disabled:cursor-not-allowed"
            :class="item.subtype === 'healing'
              ? 'bg-rose-950/30 border-rose-800/50 hover:border-rose-600 hover:bg-rose-950/50'
              : 'bg-sky-950/30 border-sky-800/50 hover:border-sky-600 hover:bg-sky-950/50'"
          >
            <!-- 丹药图标 -->
            <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
              :class="item.subtype === 'healing' ? 'bg-rose-900/40' : 'bg-sky-900/40'">
              <span class="text-lg">{{ item.subtype === 'healing' ? '💊' : '✨' }}</span>
            </div>
            <!-- 丹药信息 -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold text-fg-primary">{{ item.name }}</span>
                <Badge :tone="item.quality === 'rare' ? 'arcane' : item.quality === 'uncommon' ? 'success' : 'muted'">
                  {{ item.quality === 'rare' ? '稀有' : item.quality === 'uncommon' ? '良品' : '普通' }}
                </Badge>
              </div>
              <p class="text-xs text-fg-faint mt-0.5">{{ item.description }}</p>
              <p class="text-xs mt-1 num" :class="item.subtype === 'healing' ? 'text-rose-400' : 'text-sky-400'">
                恢复 {{ item.effect.hp_restore || item.effect.mp_restore || 0 }} 点{{ item.subtype === 'healing' ? '气血' : '灵力' }}
              </p>
            </div>
            <!-- 持有数量 -->
            <div class="text-right shrink-0">
              <div class="text-xs text-fg-faint">持有</div>
              <div class="text-sm font-bold text-gold-400 num">×{{ item.quantity }}</div>
            </div>
          </button>
        </div>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="battleItemsShow = false">关闭</AppButton>
      </template>
    </Modal>

    <!-- 避世/入世切换确认弹窗 -->
    <!-- 玩法文档第17节：避世免疫斗法袭扰，入世恢复正常 PVP 交互 -->
    <Modal :isOpen="pvpModeConfirmShow" :title="pvpModeConfirmTitle" width="460px" @close="pvpModeConfirmShow = false">
      <div class="space-y-3">
        <p class="text-fg-secondary text-sm">{{ pvpModeConfirmDesc }}</p>
        <div class="bg-surface-sunken border border-line rounded-panel p-3 space-y-1.5 text-xs">
          <div v-for="(effect, idx) in pvpModeConfirmEffects" :key="idx"
            class="flex items-start gap-2"
            :class="effect.type === 'positive' ? 'text-emerald-300' : 'text-gold-300'">
            <span class="shrink-0">{{ effect.type === 'positive' ? '✓' : '✗' }}</span>
            <span class="flex-1">{{ effect.text }}</span>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="pvpModeConfirmShow = false">再思</AppButton>
        <AppButton
          size="sm"
          :variant="pendingPvpMode === 'recluse' ? 'default' : 'primary'"
          :disabled="modeSwitching"
          @click="confirmSwitchPvpMode"
        >
          {{ modeSwitching ? '切换中…' : '确认' }}
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup>
/**
 * PVP 斗法面板组件
 *
 * 功能模块：
 *   1. 段位卡：展示玩家当前段位、积分、胜率、连胜
 *   2. 状态区：剩余次数、冷却倒计时、虚弱状态、荣誉、因果、战力
 *   3. 进行中战斗区：对手信息、HP 进度条、回合、战斗日志、操作按钮
 *   4. 排行榜区：前 10 名玩家
 *   5. 段位信息区：6 档段位积分区间
 *
 * 所有数据通过 api/pvp 模块调用后端，前端只做展示与接口调用。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { useAsyncTask } from '../../composables/useAsyncTask'
import { usePlayerStore } from '../../stores/player'
import { formatTime, formatCompact } from '../../utils/format'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import StatBar from '../ui/StatBar.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import {
  getStatus,
  getLeaderboard,
  executeAction,
  flee,
  setPvpMode,
  getBattleItems
} from '../../api/pvp'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
// 引入 playerStore 用于读取当前玩家ID（PVP 结算时判断胜/败方）
const playerStore = usePlayerStore()

// ====== 响应式状态 ======
const { loading, error, run } = useAsyncTask({ fallback: '获取 PVP 状态失败' })
const actionLoading = ref(false)
const leaderboardLoading = ref(false)
const status = ref(null)
const leaderboard = ref([])
// 当前时间 tick（每秒更新一次，用于驱动冷却倒计时显示）
const now = ref(Date.now())
let tickTimer = null

// 战斗实时 HP（由 action 接口响应更新）
const currentAttackerHp = ref(0)
const currentDefenderHp = ref(0)
const maxHp = ref(1)

// 逃跑确认弹窗
const fleeConfirmShow = ref(false)

// ===== 丹药使用弹窗状态 =====
// battleItemsShow：是否显示丹药选择弹窗
// battleItems：可用丹药列表
// battleItemsLoading：加载中
// battleItemsRemaining：本场剩余使用次数
// battleItemsMax：每场上限次数
const battleItemsShow = ref(false)
const battleItems = ref([])
const battleItemsLoading = ref(false)
const battleItemsRemaining = ref(0)
const battleItemsMax = ref(3)

// ===== 避世/入世模式切换状态 =====
// pvpModeConfirmShow：是否显示切换确认弹窗
// pendingPvpMode：待切换的目标模式（active / recluse）
// modeSwitching：切换中加载态（防止重复点击）
const pvpModeConfirmShow = ref(false)
const pendingPvpMode = ref('active')
const modeSwitching = ref(false)

// ====== 计算属性 ======

/**
 * 当前是否为避世模式
 * 后端 status.pvp_mode='recluse' 表示避世清修中
 */
const isRecluseMode = computed(() => {
  return status.value?.pvp_mode === 'recluse'
})

/**
 * 避世/入世切换弹窗标题
 */
const pvpModeConfirmTitle = computed(() => {
  return pendingPvpMode.value === 'recluse' ? '切换为避世' : '切换为入世'
})

/**
 * 避世/入世切换弹窗描述
 */
const pvpModeConfirmDesc = computed(() => {
  if (pendingPvpMode.value === 'recluse') {
    return '避世清修后，将免疫所有斗法袭扰，专心闭关修炼。'
  }
  return '入世历劫后，将恢复所有 PVP 交互能力，可挑战他人亦会被挑战。'
})

/**
 * 避世/入世切换弹窗影响列表
 * - positive（绿色✓）：切换后获得的好处
 * - negative（琥珀色✗）：切换后受到的限制
 */
const pvpModeConfirmEffects = computed(() => {
  if (pendingPvpMode.value === 'recluse') {
    return [
      { type: 'positive', text: '免疫 PVP 挑战，他人无法对你发起斗法' },
      { type: 'positive', text: '免疫决斗、封神台挑战' },
      { type: 'positive', text: '不可被悬赏、不可被神识探查' },
      { type: 'negative', text: '自身亦无法发起 PVP 挑战、决斗、封神台' },
      { type: 'negative', text: '不影响 PVE 战斗、闭关、悟道等修炼玩法' }
    ]
  }
  return [
    { type: 'positive', text: '可发起 PVP 挑战、决斗、参与封神台' },
    { type: 'positive', text: '可被悬赏、可被神识探查（正常交互）' },
    { type: 'negative', text: '会重新暴露在斗法袭扰之下' }
  ]
})

/**
 * 今日剩余挑战次数（直接读后端权威值）
 */
const challengeRemaining = computed(() => {
  return status.value?.ranking?.daily_challenge_remaining ?? 0
})

/**
 * 今日剩余防守次数
 */
const defendRemaining = computed(() => {
  return status.value?.ranking?.daily_defend_remaining ?? 0
})

/**
 * 冷却剩余秒数（基于后端权威值 + 本地 tick 递减）
 */
const cooldownRemaining = computed(() => {
  if (!status.value) return 0
  const backendRemaining = status.value.player?.cooldown_remaining_seconds || 0
  if (backendRemaining <= 0) return 0
  const serverTime = status.value.server_time || Date.now()
  const localElapsedSec = Math.floor((now.value - serverTime) / 1000)
  return Math.max(0, backendRemaining - localElapsedSec)
})

/**
 * 虚弱剩余秒数（基于后端权威值 + 本地 tick 递减）
 */
const weaknessRemaining = computed(() => {
  if (!status.value) return 0
  const backendRemaining = status.value.player?.weakness_remaining_seconds || 0
  if (backendRemaining <= 0) return 0
  const serverTime = status.value.server_time || Date.now()
  const localElapsedSec = Math.floor((now.value - serverTime) / 1000)
  return Math.max(0, backendRemaining - localElapsedSec)
})

/**
 * 最近 5 条战斗日志（最新在前）
 * 后端返回的 battle_log 已按时间倒序，这里仅截取前 5 条
 */
const recentLogs = computed(() => {
  const logs = status.value?.battle_info?.battle_log || []
  return logs.slice(0, 5)
})

// ====== 方法 ======

/**
 * 拉取 PVP 状态
 */
const fetchStatus = () => run(async () => {
  const res = await getStatus()
  const data = res.data?.data || res.data
  status.value = data
  // 初始化战斗实时 HP（基于最新日志或默认值）
  if (data?.is_in_pvp_battle && data.battle_info) {
    const lastLog = data.battle_info.battle_log?.[0]
    if (lastLog) {
      currentAttackerHp.value = lastLog.attacker_hp ?? 100
      currentDefenderHp.value = lastLog.defender_hp ?? 100
      // 取两者最大值作为 HP 上限（粗略估算）
      maxHp.value = Math.max(currentAttackerHp.value, currentDefenderHp.value, 100)
    } else {
      // 战斗刚开始还没有日志，使用默认值
      currentAttackerHp.value = 100
      currentDefenderHp.value = 100
      maxHp.value = 100
    }
  }
})

/**
 * 拉取排行榜
 */
const fetchLeaderboard = async () => {
  leaderboardLoading.value = true
  try {
    const res = await getLeaderboard(10)
    const data = res.data?.data || res.data
    leaderboard.value = data?.list || []
  } catch (err) {
    console.error('获取排行榜失败:', err)
  } finally {
    leaderboardLoading.value = false
  }
}

/**
 * 刷新全部数据
 */
const refreshAll = async () => {
  await Promise.all([fetchStatus(), fetchLeaderboard()])
}

/**
 * 仅刷新排行榜
 */
const refreshLeaderboard = () => {
  fetchLeaderboard()
}

/**
 * 拼装 PVP 结算奖励日志文案
 *
 * 后端 PvpService.executeAction / flee 返回的 settle 字段结构：
 *   - settle.attacker_honor_gain: number  攻击方荣誉获得
 *   - settle.defender_honor_gain: number  防守方荣誉获得
 *   - settle.attacker_exp_gain: number  攻击方修为获得
 *   - settle.defender_exp_gain: number  防守方修为获得
 *   - settle.spirit_stone_reward: number  灵石奖励（胜方）
 *   - settle.loser_consolation_stone: number  败方保底灵石
 *   - settle.loser_consolation_exp: number  败方保底修为
 *   - settle.loser_id: number|null  败方玩家ID（平局/逃跑可能为 null）
 *   - settle.drop_item_key: string|null  掉落物品 key
 *   - settle.drop_item_quantity: number  掉落物品数量
 *   - settle.winner_id: number  胜者玩家ID
 *   - settle.is_draw: boolean  是否平局
 *   - settle.karma_change: number  因果值变化（攻方胜且战力差距大时为负，因果值降低）
 *
 * 设计要点：
 *   - 后端未直接返回"我是攻方还是守方"，但通过 winner_id + loser_id 可推断身份
 *   - 平局：双方荣誉都获得，无灵石奖励
 *   - 胜方：荣誉 + 灵石 + 修为 + 可能掉落物品
 *   - 败方：保底灵石 + 保底修为（参与奖），不获得荣誉
 *
 * @param {Object} settle - 后端返回的结算对象
 * @param {number} myPlayerId - 当前玩家ID
 * @returns {string} 日志文案
 */
const buildPvpSettleLog = (settle, myPlayerId) => {
  if (!settle) return '斗法结束'
  const isDraw = settle.is_draw === true
  const isWinner = !isDraw && settle.winner_id === myPlayerId
  const isLoser = !isDraw && settle.loser_id === myPlayerId

  // 荣誉/修为：胜方取攻/守中非 0 的那个（自身身份对应），败方无荣誉
  // 平局时双方都获得荣誉，取攻/守荣誉中非 0 的那个作为己方获得
  const myHonor = isLoser ? 0
    : (Number(settle.attacker_honor_gain) || Number(settle.defender_honor_gain) || 0)
  const myExp = isLoser
    ? (Number(settle.loser_consolation_exp) || 0)
    : (Number(settle.attacker_exp_gain) || Number(settle.defender_exp_gain) || 0)
  const myStones = isWinner
    ? (Number(settle.spirit_stone_reward) || 0)
    : (isLoser ? (Number(settle.loser_consolation_stone) || 0) : 0)
  const dropKey = settle.drop_item_key
  const dropQty = Number(settle.drop_item_quantity) || 0

  let resultText
  if (isDraw) {
    resultText = '斗法平局'
  } else if (isWinner) {
    resultText = '斗法胜利'
  } else {
    resultText = '斗法落败'
  }

  const parts = [resultText]
  // 荣誉/修为/灵石（仅在数值 > 0 时展示，避免"获得 0 荣誉"冗余）
  if (myHonor > 0) parts.push(`荣誉 +${myHonor}`)
  if (myExp > 0) parts.push(`修为 +${myExp}`)
  if (myStones > 0) parts.push(`灵石 +${myStones}`)
  // 掉落物品（败方被掉落，仅胜方视角展示）
  if (isWinner && dropKey) {
    parts.push(`掉落 ${dropKey}${dropQty > 1 ? `×${dropQty}` : ''}`)
  }
  // 因果值变化（仅在非 0 时展示）
  const karmaChange = Number(settle.karma_change) || 0
  if (karmaChange !== 0) {
    parts.push(`因果 ${karmaChange > 0 ? '+' : ''}${karmaChange}`)
  }
  return parts.join('，')
}

/**
 * 执行战斗动作
 * @param action 动作类型：attack/skill/defend
 */
const handleAction = async (action) => {
  if (!status.value?.is_in_pvp_battle) {
    uiStore.showToast('当前未在战斗中', 'warning')
    return
  }
  if (!status.value.battle_info?.is_my_turn) {
    uiStore.showToast('当前非己方回合', 'warning')
    return
  }
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    const res = await executeAction(action, 0)
    const data = res.data?.data || res.data
    // 更新实时 HP
    if (data) {
      currentAttackerHp.value = data.attacker_hp ?? currentAttackerHp.value
      currentDefenderHp.value = data.defender_hp ?? currentDefenderHp.value
    }
    // 修复 B4-Reward：字段名应为 battle_ended（后端返回），原 is_finished 永远为 undefined
    // 导致战斗结束后不刷新排行榜，且不展示结算奖励
    if (data?.battle_ended) {
      // 战斗已结束：展示结算奖励日志
      const myPlayerId = playerStore.player?.id
      const settle = data.settle
      const logContent = buildPvpSettleLog(settle, myPlayerId)
      const isWinner = settle?.winner_id === myPlayerId
      const isDraw = settle?.is_draw === true
      uiStore.addLog({
        content: logContent,
        type: isDraw ? 'info' : (isWinner ? 'success' : 'warning'),
        actorId: 'self'
      })
      uiStore.showToast(logContent, isDraw ? 'info' : (isWinner ? 'success' : 'warning'))
      await fetchLeaderboard()
    } else {
      uiStore.showToast(data?.message || `执行 ${actionLabel(action)} 完成`, 'success')
    }
    // 重新拉取状态以同步回合信息与日志
    await fetchStatus()
  } catch (err) {
    uiStore.showApiError(err, '动作执行失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 打开逃跑确认弹窗
 */
const openFleeConfirm = () => {
  fleeConfirmShow.value = true
}

/**
 * 确认逃跑
 *
 * 修复 B4-Reward：逃跑也有 settle 字段（败方保底奖励），需展示给玩家
 * 后端 PvpService.flee 返回 { fled, winner_id, settle }
 */
const confirmFlee = async () => {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    const res = await flee()
    const data = res.data?.data || res.data
    fleeConfirmShow.value = false
    // 展示逃跑结算奖励（败方保底）
    if (data?.settle) {
      const myPlayerId = playerStore.player?.id
      const logContent = `主动逃离战斗，${buildPvpSettleLog(data.settle, myPlayerId)}`
      uiStore.addLog({
        content: logContent,
        type: 'warning',
        actorId: 'self'
      })
      uiStore.showToast(logContent, 'warning')
    } else {
      uiStore.showToast(data?.message || '已逃离战斗', 'warning')
    }
    await fetchStatus()
    await fetchLeaderboard()
  } catch (err) {
    uiStore.showApiError(err, '逃跑失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 动作类型中文标签
 */
const actionLabel = (action) => {
  const map = { attack: '攻击', skill: '技能', defend: '防御', item: '使用丹药' }
  return map[action] || action
}

// ===== 丹药使用方法 =====

/**
 * 打开丹药选择弹窗
 * 调用 GET /pvp/battle-items 获取可用丹药列表
 */
const openBattleItems = async () => {
  if (!status.value?.is_in_pvp_battle) {
    uiStore.showToast('当前未在战斗中', 'warning')
    return
  }
  if (!status.value.battle_info?.is_my_turn) {
    uiStore.showToast('当前非己方回合', 'warning')
    return
  }
  battleItemsShow.value = true
  battleItemsLoading.value = true
  battleItems.value = []
  try {
    const res = await getBattleItems()
    const data = res.data?.data || res.data
    battleItems.value = data?.items || []
    battleItemsRemaining.value = data?.remaining_uses ?? 0
    battleItemsMax.value = data?.max_uses ?? 3
  } catch (err) {
    uiStore.showApiError(err, '获取丹药列表失败')
    battleItemsShow.value = false
  } finally {
    battleItemsLoading.value = false
  }
}

/**
 * 使用丹药（战斗中使用消耗品）
 * 调用 POST /pvp/action (action='item', skill_index=物品ID)
 * @param itemId 物品ID字符串
 */
const handleUseItem = async (itemId) => {
  if (actionLoading.value) return
  if (battleItemsRemaining.value <= 0) {
    uiStore.showToast('本场丹药使用次数已用完', 'warning')
    return
  }
  actionLoading.value = true
  try {
    const res = await executeAction('item', itemId)
    const data = res.data?.data || res.data
    // 更新实时 HP
    if (data) {
      currentAttackerHp.value = data.attacker_hp ?? currentAttackerHp.value
      currentDefenderHp.value = data.defender_hp ?? currentDefenderHp.value
    }
    uiStore.showToast('丹药使用成功', 'success')
    // 关闭弹窗，重新拉取状态
    battleItemsShow.value = false
    await fetchStatus()
  } catch (err) {
    uiStore.showApiError(err, '丹药使用失败')
  } finally {
    actionLoading.value = false
  }
}

// ===== 避世/入世模式切换方法 =====

/**
 * 打开避世/入世切换确认弹窗
 * 根据当前模式决定目标模式（避世→入世，入世→避世）
 */
const openPvpModeConfirm = () => {
  // 战斗进行中禁止切换（与后端 setPvpMode 校验保持一致，避免无效请求）
  if (status.value?.is_in_pvp_battle) {
    uiStore.showToast('斗法进行中，无法切换避世/入世', 'warning')
    return
  }
  // 设置待切换的目标模式：当前为避世则切回入世，当前为入世则切到避世
  pendingPvpMode.value = isRecluseMode.value ? 'active' : 'recluse'
  pvpModeConfirmShow.value = true
}

/**
 * 确认切换 PVP 模式
 * 调用后端 POST /pvp/mode 接口，切换成功后刷新状态
 */
const confirmSwitchPvpMode = async () => {
  if (modeSwitching.value) return
  modeSwitching.value = true
  try {
    const res = await setPvpMode(pendingPvpMode.value)
    const data = res.data?.data || res.data
    const modeName = data?.mode_name || (pendingPvpMode.value === 'recluse' ? '避世' : '入世')
    pvpModeConfirmShow.value = false
    uiStore.showToast(`已切换为${modeName}模式`, 'success')
    uiStore.addLog({
      content: `已切换为${modeName}模式`,
      type: 'info',
      actorId: 'self'
    })
    // 刷新状态以同步 pvp_mode 字段
    await fetchStatus()
  } catch (err) {
    uiStore.showApiError(err, '切换 PVP 模式失败')
  } finally {
    modeSwitching.value = false
  }
}

/**
 * 格式化战斗日志条目为文案
 */
const formatLogText = (log) => {
  if (log.text) return log.text
  const actor = log.actor === 'attacker' ? '攻击方' : '防守方'
  // 丹药使用日志：展示丹药名称和恢复量
  if (log.action === 'item' && log.item) {
    const parts = []
    if (log.item.hp_restore > 0) parts.push(`气血+${log.item.hp_restore}`)
    if (log.item.mp_restore > 0) parts.push(`灵力+${log.item.mp_restore}`)
    return `${actor}使用【${log.item.item_name}】${parts.join('，')}`
  }
  const action = actionLabel(log.action)
  return `${actor}使用${action}`
}

// ===== 五行相克展示辅助方法 =====
// 五行图标与颜色映射，用于在战斗区直观展示双方灵根克制关系

/**
 * 五行属性 → 中文名映射
 * 供战斗区灵根徽章与克制提示展示
 */
const ELEMENT_NAMES = {
  metal: '金',
  wood: '木',
  water: '水',
  fire: '火',
  earth: '土'
}

/**
 * 五行属性 → 图标 emoji 映射
 * 金≈⚔️(金戈) / 木≈🌿(草木) / 水≈💧(水珠) / 火≈🔥(火焰) / 土≈⛰️(山土)
 */
const ELEMENT_ICONS = {
  metal: '⚔️',
  wood: '🌿',
  water: '💧',
  fire: '🔥',
  earth: '⛰️'
}

/**
 * 五行属性 → 徽章样式映射
 * 每种五行使用对应色系的背景+边框，增加视觉辨识度
 */
const elementBadgeClass = (element) => {
  const map = {
    metal: 'bg-gold-900/60 border-gold-600/60 text-gold-300',
    wood: 'bg-emerald-950/60 border-emerald-600/60 text-emerald-300',
    water: 'bg-cyan-950/60 border-cyan-600/60 text-cyan-300',
    fire: 'bg-red-950/60 border-red-600/60 text-red-300',
    earth: 'bg-yellow-950/60 border-yellow-700/60 text-yellow-300'
  }
  return map[element] || 'bg-surface-active border-line-strong text-fg-secondary'
}

/**
 * 五行属性 → 中文名
 */
const elementName = (element) => {
  return ELEMENT_NAMES[element] || element
}

/**
 * 五行属性 → 图标
 */
const elementIcon = (element) => {
  return ELEMENT_ICONS[element] || ''
}

/**
 * 五行展示卡边框样式
 * - 己方克制对手：绿色边框（有利）
 * - 对手克制己方：红色边框（不利）
 * - 无克制：默认灰色边框
 */
const elementBorderColor = (elementInfo) => {
  if (!elementInfo || !elementInfo.matchup) return 'border-line'
  return elementInfo.advantage === 'attacker'
    ? 'border-emerald-600/60'
    : 'border-rose-600/60'
}

/**
 * 克制关系文字颜色
 * - 己方克制：绿色（有利）
 * - 对手克制：红色（不利）
 */
const elementAdvantageTextClass = (elementInfo) => {
  if (!elementInfo || !elementInfo.matchup) return 'text-fg-muted'
  return elementInfo.advantage === 'attacker'
    ? 'text-emerald-300'
    : 'text-rose-300'
}

/**
 * 计算排行榜条目胜率（兜底，若后端未返回则本地计算）
 */
const calcWinRate = (item) => {
  const total = (item.season_wins || 0) + (item.season_losses || 0)
  if (total === 0) return 0
  return Math.round(((item.season_wins || 0) / total) * 100)
}

/**
 * 格式化段位积分区间文案
 */
const formatScoreRange = (rank) => {
  if (!rank) return ''
  const min = rank.min_score ?? 0
  const max = rank.max_score
  if (max === -1 || max === undefined || max === null) return `${min}+`
  return `${min} ~ ${max}`
}

// ====== 生命周期 ======
onMounted(async () => {
  await refreshAll()
  // 启动每秒 tick，驱动冷却倒计时与虚弱倒计时
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
})
</script>
