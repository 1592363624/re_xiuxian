<!--
 * 世界BOSS面板组件
 *
 * 弹窗式组件，展示世界BOSS列表/详情/伤害排行/战斗操作。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 外壳走 ui/PanelShell，分段导航走 ui/Tabs，二次确认用 common/Modal
 *   - HP/伤害等大整数以字符串形式展示，避免精度丢失
 *   - 攻击冷却5秒，复活冷却60秒，撤退禁入5分钟
 *   - 颜色风格：世界BOSS 用血光系（red/rose）匹配战斗主题
 *
 * 数据来源：
 *   - getAvailableBosses()：可挑战BOSS列表 + 当前赛季
 *   - getBossDetail()：BOSS详情/技能/排行
 *   - attackBoss() / revive() / retreat()：战斗操作
 *   - getSeasons() / getSeasonRanking()：赛季查询
-->
<template>
  <PanelShell title="世界BOSS" hint="天机阁通缉 · 赛季争锋" size="xl" @close="$emit('close')">
    <template #header-actions>
      <div class="hidden sm:flex items-center gap-2">
        <Badge v-if="currentSeason" tone="danger">{{ currentSeason.season_name }}</Badge>
        <Badge tone="gold">已诛魔 <span class="num">{{ currentSeason?.total_bosses_killed || 0 }}</span></Badge>
      </div>
    </template>

    <!-- 标签页切换 -->
    <Tabs
      :model-value="activeTab"
      :items="tabItems"
      class="mb-4"
      @update:model-value="switchTab"
    />

    <!-- ============ BOSS榜单标签页 ============ -->
    <div v-if="activeTab === 'bosses'" class="space-y-4">
      <!-- 加载中 -->
      <LoadingBlock v-if="bossLoading && !bosses.length" text="正在查阅天机阁榜单…" />

      <template v-else>
        <!-- ===== 列表视图 ===== -->
        <template v-if="!selectedBossId">
          <!-- 当前赛季卡 -->
          <PanelCard v-if="currentSeason" tone="danger">
            <div class="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div class="text-xs text-red-400 mb-1">当前赛季</div>
                <div class="text-lg font-bold text-red-300 font-display">{{ currentSeason.season_name }}</div>
                <div class="text-xs text-fg-muted mt-1 num">{{ currentSeason.start_date }} ~ {{ currentSeason.end_date }}</div>
              </div>
              <div class="text-center">
                <div class="text-xs text-fg-faint">已诛魔数</div>
                <div class="text-2xl font-bold text-gold-300 num">{{ currentSeason.total_bosses_killed }}</div>
              </div>
            </div>
          </PanelCard>

          <!-- BOSS 列表 -->
          <div v-if="bosses.length === 0" class="text-center text-fg-faint py-8 text-sm">
            当前无可挑战之BOSS，敬请期待天机阁新通缉令
          </div>
          <div v-else class="space-y-3">
            <div v-for="boss in bosses" :key="boss.id"
              @click="enterBossDetail(boss.id)"
              class="bg-surface-raised border border-line hover:border-red-600/60 rounded-panel p-4 cursor-pointer transition-all hover:bg-surface-hover">
              <div class="flex items-start justify-between gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1 flex-wrap">
                    <span class="text-base font-bold text-red-300 font-display">{{ boss.boss_name }}</span>
                    <Badge v-if="boss.status === 'pending'" tone="muted">即将现世</Badge>
                    <Badge v-else-if="boss.status === 'active'" tone="danger" dot>激战中</Badge>
                    <Badge v-else-if="boss.status === 'defeated'" tone="gold">已伏诛</Badge>
                    <Badge v-else-if="boss.status === 'expired'" tone="muted">已消散</Badge>
                  </div>
                  <div class="text-xs text-fg-muted mb-2">境界要求：{{ realmRankLabel(boss.realm_rank_min) }}</div>

                  <!-- pending: 显示刷新倒计时 -->
                  <div v-if="boss.status === 'pending'" class="text-xs text-gold-400 num">
                    <span v-if="boss.countdown_seconds > 0">距现世：{{ formatTime(boss.countdown_seconds) }}</span>
                    <span v-else>即将现世</span>
                  </div>

                  <!-- active/defeated: HP进度条 + 参与人数 + 阶段 -->
                  <div v-else class="space-y-1">
                    <StatBar
                      label="气血"
                      :tone="hpBarTone(boss.hp_percentage)"
                      height="h-2"
                      :value="clampPercent(boss.hp_percentage)"
                      :max="100"
                      :text="`${formatCompact(boss.hp_current)} / ${formatCompact(boss.hp_max)}（${boss.hp_percentage}%）`"
                    />
                    <div class="flex items-center justify-between text-xs text-fg-faint mt-1 num">
                      <span>阶段：第 {{ boss.phase }} 阶</span>
                      <span>参战修士：{{ boss.participant_count }} 人</span>
                    </div>
                  </div>
                </div>
                <svg class="w-5 h-5 text-fg-faint shrink-0 mt-1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m9 18 6-6-6-6"/>
                </svg>
              </div>
            </div>
          </div>
        </template>

        <!-- ===== 详情视图 ===== -->
        <div v-else class="space-y-4">
          <button type="button" @click="exitBossDetail" class="flex items-center gap-1 text-sm text-fg-muted hover:text-red-300 transition-colors">
            <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            返回榜单
          </button>

          <!-- 详情加载中 -->
          <LoadingBlock v-if="detailLoading && !bossDetail" text="正在调取BOSS卷宗…" />

          <template v-else-if="bossDetail">
            <!-- BOSS基础信息 -->
            <PanelCard tone="danger">
              <div class="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div class="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 class="text-lg font-bold text-red-300 font-display">{{ bossDetail.boss.boss_name }}</h3>
                    <Badge :tone="bossStatusBadgeTone(bossDetail.boss.status)">{{ bossStatusLabel(bossDetail.boss.status) }}</Badge>
                  </div>
                  <div class="text-xs text-fg-muted">境界要求：{{ realmRankLabel(bossDetail.boss.realm_rank_min) }}</div>
                  <div class="text-xs text-fg-muted num">阶段：第 {{ bossDetail.boss.phase }} 阶</div>
                </div>
                <div class="text-right text-xs text-fg-faint num">
                  <div>攻击 <span class="text-red-300">{{ bossDetail.boss.atk }}</span> · 防御 <span class="text-cyan-300">{{ bossDetail.boss.def }}</span></div>
                  <div>速度 <span class="text-gold-300">{{ bossDetail.boss.speed }}</span></div>
                  <div>参战 <span class="text-fg-secondary">{{ bossDetail.boss.participant_count }}</span> 人</div>
                </div>
              </div>

              <!-- 描述 -->
              <p v-if="bossDetail.description" class="mt-3 text-xs text-fg-muted italic leading-relaxed border-l-2 border-red-900/50 pl-3 wrap-cjk">
                "{{ bossDetail.description }}"
              </p>

              <!-- HP 大进度条 -->
              <div class="mt-4">
                <StatBar
                  label="BOSS气血"
                  :tone="hpBarTone(bossDetail.boss.hp_percentage)"
                  height="h-3"
                  :value="clampPercent(bossDetail.boss.hp_percentage)"
                  :max="100"
                  :text="`${formatCompact(bossDetail.boss.hp_current)} / ${formatCompact(bossDetail.boss.hp_max)}（${bossDetail.boss.hp_percentage}%）`"
                />
              </div>

              <!-- 击杀信息 -->
              <div v-if="bossDetail.boss.killer_nickname" class="mt-3 text-xs text-gold-300 bg-surface-tint-gold border border-gold-800/60 rounded-control p-2">
                已被 <span class="font-bold">{{ bossDetail.boss.killer_nickname }}</span> 道友诛灭于 <span class="num">{{ bossDetail.boss.defeat_time }}</span>
              </div>
            </PanelCard>

            <!-- 当前阶段技能列表 -->
            <PanelCard title="当前阶段神通">
              <div v-if="!bossDetail.current_phase_skills || bossDetail.current_phase_skills.length === 0" class="text-xs text-fg-faint">暂无技能数据</div>
              <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div v-for="(skill, idx) in bossDetail.current_phase_skills" :key="idx"
                  class="bg-surface-sunken border border-line-subtle rounded-control p-3">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-sm font-bold text-gold-300">{{ skill.name }}</span>
                    <span class="text-xs text-fg-faint">{{ skill.type }}</span>
                  </div>
                  <p class="text-xs text-fg-muted mb-2">{{ skill.description }}</p>
                  <div class="flex items-center gap-3 text-xs text-fg-faint flex-wrap num">
                    <span>倍率 <span class="text-red-300">{{ skill.damage_multiplier }}x</span></span>
                    <span>CD <span class="text-gold-300">{{ skill.cooldown_seconds }}s</span></span>
                    <span v-if="skill.effect" class="text-purple-400">{{ skill.effect }}</span>
                  </div>
                </div>
              </div>
            </PanelCard>

            <!-- 个人伤害排行前10 -->
            <PanelCard title="个人伤害榜 · 前十">
              <div v-if="!bossDetail.personal_ranking || bossDetail.personal_ranking.length === 0" class="text-xs text-fg-faint">尚无修士造成伤害</div>
              <ul v-else class="space-y-1 text-xs">
                <li v-for="item in bossDetail.personal_ranking.slice(0, 10)" :key="item.player_id"
                  class="flex items-center justify-between px-2 py-1.5 rounded-control"
                  :class="item.rank <= 3 ? 'bg-surface-tint-gold' : ''">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="w-6 text-center font-bold shrink-0 num"
                      :class="item.rank === 1 ? 'text-gold-400' : item.rank === 2 ? 'text-fg-secondary' : item.rank === 3 ? 'text-gold-700' : 'text-fg-faint'">
                      {{ item.rank }}
                    </span>
                    <span class="text-fg-primary truncate">{{ item.player_nickname }}</span>
                    <span class="text-xs text-fg-faint shrink-0">[{{ item.player_realm }}]</span>
                    <span v-if="item.sect_name" class="text-xs text-cyan-400 truncate">{{ item.sect_name }}</span>
                  </div>
                  <div class="flex items-center gap-3 text-fg-muted shrink-0 num">
                    <span class="text-red-300 font-bold">{{ formatCompact(item.total_damage) }}</span>
                    <span class="text-fg-faint">{{ item.damage_percentage }}%</span>
                  </div>
                </li>
              </ul>
            </PanelCard>

            <!-- 宗门伤害排行前10 -->
            <PanelCard title="宗门伤害榜 · 前十">
              <div v-if="!bossDetail.sect_ranking || bossDetail.sect_ranking.length === 0" class="text-xs text-fg-faint">尚无宗门造成伤害</div>
              <ul v-else class="space-y-1 text-xs">
                <li v-for="item in bossDetail.sect_ranking.slice(0, 10)" :key="item.sect_id"
                  class="flex items-center justify-between px-2 py-1.5 rounded-control"
                  :class="item.rank <= 3 ? 'bg-surface-tint-gold' : ''">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="w-6 text-center font-bold shrink-0 num"
                      :class="item.rank === 1 ? 'text-gold-400' : item.rank === 2 ? 'text-fg-secondary' : item.rank === 3 ? 'text-gold-700' : 'text-fg-faint'">
                      {{ item.rank }}
                    </span>
                    <span class="text-fg-primary truncate">{{ item.sect_name }}</span>
                    <span class="text-xs text-fg-faint shrink-0 num">{{ item.member_count }} 人</span>
                  </div>
                  <div class="flex items-center gap-3 text-fg-muted shrink-0 num">
                    <span class="text-red-300 font-bold">{{ formatCompact(item.sect_total_damage) }}</span>
                    <span class="text-fg-faint">{{ item.damage_percentage }}%</span>
                  </div>
                </li>
              </ul>
            </PanelCard>

            <!-- ============ 战斗操作区（仅 active 状态显示） ============ -->
            <PanelCard v-if="bossDetail.boss.status === 'active'" tone="danger">
              <div class="space-y-3">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <Badge tone="danger" dot solid>激战中</Badge>
                    <span class="text-xs text-fg-muted num">阶段 {{ bossDetail.boss.phase }}</span>
                  </div>
                  <div class="text-xs text-fg-faint num">已发起 {{ attackCount }} 次攻势</div>
                </div>

                <!-- 玩家战斗 HP 条（独立于世界HP） -->
                <div>
                  <StatBar
                    label="己方气血"
                    tone="azure"
                    height="h-2"
                    :value="battleHpPercent"
                    :max="100"
                    :text="`${formatCompact(battleHpCurrent)} / ${formatCompact(battleHpMax)}`"
                  />
                  <div v-if="isDead" class="text-xs text-rose-400 mt-1">已陨落，需原地复活方可再战</div>
                </div>

                <!-- 上次攻击结果展示 -->
                <div v-if="lastAttackResult" class="bg-surface-sunken border border-line rounded-control p-3 space-y-1.5 text-xs">
                  <div class="flex items-center justify-between">
                    <span class="text-fg-muted">本回合攻势</span>
                    <span class="text-gold-300 num">
                      {{ skillLabel(lastAttackResult.attack.skill_id) }} ·
                      <span :class="lastAttackResult.attack.is_crit ? 'text-red-400 font-bold' : 'text-fg-secondary'">
                        伤害 {{ formatCompact(lastAttackResult.attack.damage) }}{{ lastAttackResult.attack.is_crit ? ' (暴击!)' : '' }}
                      </span>
                    </span>
                  </div>
                  <!-- 灵兽助战伤害（批次4-2-Ext2 新增） -->
                  <div v-if="lastAttackResult.attack.damage_breakdown?.beast_assist_damage && Number(lastAttackResult.attack.damage_breakdown.beast_assist_damage) > 0"
                    class="flex items-center justify-between text-emerald-300">
                    <span>灵兽助战 · {{ lastAttackResult.spirit_beast?.beast_name || '出战灵兽' }}</span>
                    <span class="num">+{{ formatCompact(lastAttackResult.attack.damage_breakdown.beast_assist_damage) }}</span>
                  </div>
                  <!-- 五行相克提示（批次4-2-Ext2 新增） -->
                  <div v-if="lastAttackResult.elemental_counter" class="flex items-center justify-between">
                    <span class="text-fg-muted">五行相克</span>
                    <span :class="elementalCounterClass(lastAttackResult.elemental_counter)">
                      {{ lastAttackResult.elemental_counter.description || '无相克' }}
                    </span>
                  </div>
                  <!-- BOSS 技能反击（批次4-2-Ext3 新增，替代简化公式）
                       反击现在也掷闪避：被闪掉时伤害是 0，只按 damage>0 判断的话这一记会整行消失，
                       玩家看不到自己闪掉了什么，所以 missed 也要占一行 -->
                  <div v-if="lastAttackResult.counter && (lastAttackResult.counter.damage > 0 || lastAttackResult.counter.missed)"
                    class="flex items-center justify-between"
                    :class="lastAttackResult.counter.missed ? 'text-emerald-300' : 'text-rose-400'">
                    <span>
                      BOSS反击
                      <span v-if="lastAttackResult.counter.skill?.name" class="ml-1 text-purple-300">[{{ lastAttackResult.counter.skill.name }}]</span>
                      <span v-if="lastAttackResult.counter.skill?.type === 'aoe_all' || lastAttackResult.counter.skill?.type === 'ultimate_screen_wide'"
                        class="ml-1 text-orange-400 font-bold">[群伤]</span>
                      <span v-if="lastAttackResult.counter.crit" class="ml-1 text-red-400 font-bold">(暴击!)</span>
                    </span>
                    <span class="num">
                      {{ lastAttackResult.counter.missed ? '已闪避' : `-${formatCompact(lastAttackResult.counter.damage)}` }}
                    </span>
                  </div>
                  <!-- AOE 事件（批次4-2-Ext3 新增，BOSS 释放范围技能） -->
                  <div v-if="lastAttackResult.aoe_event" class="text-orange-300 border-t border-line pt-1.5">
                    <span class="font-bold">【AOE】{{ lastAttackResult.aoe_event.skill_name || '范围技能' }}</span>
                    <span class="ml-2 text-fg-muted num">波及 {{ lastAttackResult.aoe_event.affected_count || '?' }} 人</span>
                    <span class="ml-2 text-rose-400 num">总伤 {{ formatCompact(lastAttackResult.aoe_event.aoe_damage) }}</span>
                  </div>
                  <!-- BOSS 当前 Buff（批次4-2-Ext3 新增） -->
                  <div v-if="lastAttackResult.boss?.active_buffs && lastAttackResult.boss.active_buffs.length > 0"
                    class="flex items-start gap-2 text-yellow-300">
                    <span class="text-fg-muted shrink-0">BOSS增益</span>
                    <div class="flex flex-wrap gap-1">
                      <span v-for="buff in lastAttackResult.boss.active_buffs" :key="buff.name"
                        class="px-1.5 py-0.5 bg-yellow-900/50 border border-yellow-700 rounded-control text-[10px]">
                        {{ buff.name }}
                        <span v-if="buff.expire_at" class="text-yellow-500 ml-1 num">{{ formatBuffRemaining(buff.expire_at) }}</span>
                      </span>
                    </div>
                  </div>
                  <!-- BOSS 召唤的小怪（批次4-2-Ext3 新增） -->
                  <div v-if="lastAttackResult.boss?.minions && lastAttackResult.boss.minions.length > 0"
                    class="flex items-start gap-2 text-pink-300">
                    <span class="text-fg-muted shrink-0">BOSS分身</span>
                    <div class="flex flex-wrap gap-1">
                      <span v-for="(minion, idx) in lastAttackResult.boss.minions" :key="idx"
                        class="px-1.5 py-0.5 bg-pink-900/50 border border-pink-700 rounded-control text-[10px]">
                        {{ minion.name }} <span class="num">(HP {{ formatCompact(minion.hp_current) }}/{{ formatCompact(minion.hp_max) }})</span>
                      </span>
                    </div>
                  </div>
                  <div v-if="lastAttackResult.boss && lastAttackResult.boss.phase_changed" class="text-purple-400">
                    BOSS进入新阶段！
                  </div>
                  <div v-if="lastAttackResult.boss && lastAttackResult.boss.defeated" class="text-gold-300 font-bold">
                    BOSS已被诛灭！
                  </div>
                  <div v-if="lastAttackResult.settle && lastAttackResult.settle.summary" class="text-emerald-300 border-t border-line pt-1.5 mt-1">
                    {{ lastAttackResult.settle.summary }}
                  </div>
                </div>

                <!-- 三技能按钮 -->
                <div class="grid grid-cols-3 gap-2">
                  <button type="button" @click="handleAttack('basic')"
                    :disabled="attackLoading || attackCooldownRemaining > 0 || isDead"
                    class="focus-ring px-2 py-2.5 text-xs font-bold rounded-control bg-red-900/50 border border-red-700 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed">
                    <div>普攻</div>
                    <div class="text-[10px] opacity-70 num">1.0x</div>
                    <div v-if="attackCooldownRemaining > 0" class="text-[10px] text-gold-400 num">{{ attackCooldownRemaining }}s</div>
                  </button>
                  <button type="button" @click="handleAttack('skill')"
                    :disabled="attackLoading || attackCooldownRemaining > 0 || isDead"
                    class="focus-ring px-2 py-2.5 text-xs font-bold rounded-control bg-purple-900/50 border border-purple-700 text-purple-300 hover:bg-purple-800/60 disabled:opacity-40 disabled:cursor-not-allowed">
                    <div>技能</div>
                    <div class="text-[10px] opacity-70 num">1.5x</div>
                    <div v-if="attackCooldownRemaining > 0" class="text-[10px] text-gold-400 num">{{ attackCooldownRemaining }}s</div>
                  </button>
                  <button type="button" @click="handleAttack('ultimate')"
                    :disabled="attackLoading || attackCooldownRemaining > 0 || isDead"
                    class="focus-ring px-2 py-2.5 text-xs font-bold rounded-control bg-gold-800/50 border border-gold-700 text-gold-300 hover:bg-gold-700/60 disabled:opacity-40 disabled:cursor-not-allowed">
                    <div>必杀</div>
                    <div class="text-[10px] opacity-70 num">2.5x</div>
                    <div v-if="attackCooldownRemaining > 0" class="text-[10px] text-gold-400 num">{{ attackCooldownRemaining }}s</div>
                  </button>
                </div>

                <!-- 复活/撤退按钮 -->
                <div class="grid grid-cols-2 gap-2">
                  <AppButton
                    v-if="isDead"
                    size="xs"
                    variant="default"
                    :disabled="actionLoading || reviveCooldownRemaining > 0"
                    @click="openReviveConfirm"
                  >
                    <span v-if="reviveCooldownRemaining > 0" class="num">复活冷却 {{ reviveCooldownRemaining }}s</span>
                    <span v-else>原地复活 (消耗灵石)</span>
                  </AppButton>
                  <AppButton size="xs" variant="outline" :disabled="actionLoading" @click="openRetreatConfirm">
                    撤退 (5分钟禁入)
                  </AppButton>
                </div>
              </div>
            </PanelCard>

            <!-- 待激活提示 -->
            <PanelCard v-else-if="bossDetail.boss.status === 'pending'" tone="gold">
              <div class="text-center">
                <div class="text-gold-300 text-sm font-bold mb-1">魔头尚未现世</div>
                <div class="text-xs text-fg-muted num">
                  <span v-if="pendingCountdown > 0">距现世：{{ formatTime(pendingCountdown) }}</span>
                  <span v-else>即将现世</span>
                </div>
                <div class="text-xs text-fg-faint mt-2">现世后即可参与围攻</div>
              </div>
            </PanelCard>

            <!-- 已伏诛 -->
            <PanelCard v-else-if="bossDetail.boss.status === 'defeated'" tone="gold">
              <div class="text-center">
                <div class="text-gold-300 text-sm font-bold">魔头已伏诛</div>
                <div class="text-xs text-fg-muted mt-1">可查看上方伤害榜</div>
              </div>
            </PanelCard>

            <!-- 已消散 -->
            <PanelCard v-else-if="bossDetail.boss.status === 'expired'" tone="muted">
              <div class="text-center">
                <div class="text-fg-muted text-sm font-bold">魔气已散</div>
                <div class="text-xs text-fg-faint mt-1">BOSS已超时消失</div>
              </div>
            </PanelCard>
          </template>
        </div>
      </template>
    </div>

    <!-- ============ 赛季总览标签页 ============ -->
    <div v-else-if="activeTab === 'seasons'" class="space-y-4">
      <!-- 赛季列表 -->
      <PanelCard title="赛季列表">
        <LoadingBlock v-if="seasonLoading && !seasons.length" text="正在查阅赛季卷宗…" />
        <EmptyState v-else-if="seasons.length === 0" text="暂无赛季记录" />
        <ul v-else class="space-y-2 text-xs">
          <li v-for="season in seasons" :key="season.season_id"
            @click="selectSeason(season.season_id)"
            class="flex items-center justify-between px-3 py-2 rounded-control cursor-pointer transition-colors"
            :class="selectedSeasonId === season.season_id ? 'bg-red-900/40 border border-red-600' : 'bg-surface-sunken border border-line-subtle hover:border-line-strong'">
            <div>
              <div class="font-bold text-fg-primary">{{ season.season_name }}</div>
              <div class="text-fg-faint num">{{ season.start_date }} ~ {{ season.end_date }}</div>
            </div>
            <div class="flex items-center gap-3">
              <Badge :tone="seasonStatusBadgeTone(season.status)">{{ seasonStatusLabel(season.status) }}</Badge>
              <span class="text-gold-300 num">已诛魔 {{ season.total_bosses_killed }}</span>
            </div>
          </li>
        </ul>
      </PanelCard>

      <!-- 赛季宗门伤害排行 -->
      <PanelCard title="赛季宗门伤害榜">
        <template #action>
          <AppButton size="xs" variant="ghost" :disabled="seasonRankingLoading" @click="refreshSeasonRanking">
            {{ seasonRankingLoading ? '刷新中…' : '刷新' }}
          </AppButton>
        </template>
        <div v-if="!selectedSeasonId" class="text-xs text-fg-faint py-3 text-center">请选择赛季</div>
        <div v-else-if="seasonRankingLoading && !seasonRanking.length" class="text-xs text-fg-faint py-3 text-center">正在调取榜单…</div>
        <div v-else-if="seasonRanking.length === 0" class="text-xs text-fg-faint py-3 text-center">暂无排行数据</div>
        <ul v-else class="space-y-1 text-xs">
          <li v-for="(item, idx) in seasonRanking" :key="idx"
            class="flex items-center justify-between px-2 py-1.5 rounded-control"
            :class="idx < 3 ? 'bg-surface-tint-gold' : ''">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-6 text-center font-bold shrink-0 num"
                :class="idx === 0 ? 'text-gold-400' : idx === 1 ? 'text-fg-secondary' : idx === 2 ? 'text-gold-700' : 'text-fg-faint'">
                {{ idx + 1 }}
              </span>
              <span class="text-fg-primary truncate">{{ item.sect_name || '散修联盟' }}</span>
              <span class="text-xs text-fg-faint shrink-0 num">{{ item.member_count || 0 }} 人</span>
            </div>
            <div class="flex items-center gap-3 text-fg-muted shrink-0 num">
              <span class="text-red-300 font-bold">{{ formatCompact(item.sect_total_damage || item.total_damage || 0) }}</span>
              <span v-if="item.damage_percentage" class="text-fg-faint">{{ item.damage_percentage }}%</span>
            </div>
          </li>
        </ul>
      </PanelCard>
    </div>

    <!-- 底部操作栏 -->
    <template #footer>
      <AppButton size="sm" variant="outline" @click="$emit('close')">关闭</AppButton>
      <AppButton size="sm" variant="danger" block :disabled="loading" @click="refreshAll">
        {{ loading ? '刷新中…' : '刷新天机阁' }}
      </AppButton>
    </template>

    <!-- 撤退确认弹窗 -->
    <Modal :isOpen="retreatConfirmShow" title="撤退确认" width="420px" @close="retreatConfirmShow = false">
      <p class="text-fg-secondary text-sm">确定要撤退吗？</p>
      <p class="text-rose-400 text-xs mt-2">撤退后5分钟内不可再次加入此BOSS战，已造成的伤害不会清零。</p>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="retreatConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="danger" :disabled="actionLoading" @click="confirmRetreat">
          {{ actionLoading ? '执行中…' : '确认撤退' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 复活确认弹窗 -->
    <Modal :isOpen="reviveConfirmShow" title="原地复活" width="420px" @close="reviveConfirmShow = false">
      <p class="text-fg-secondary text-sm">确定要原地复活吗？</p>
      <p class="text-gold-400 text-xs mt-2">复活将消耗灵石（默认1000），并恢复全部战斗气血。复活冷却60秒。</p>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="reviveConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="primary" :disabled="actionLoading" @click="confirmRevive">
          {{ actionLoading ? '执行中…' : '确认复活' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 错误提示弹窗 -->
    <Modal :isOpen="errorModalShow" title="提示" width="380px" @close="errorModalShow = false">
      <p class="text-fg-secondary text-sm">{{ errorMessage }}</p>
      <template #footer>
        <AppButton size="sm" variant="danger" @click="errorModalShow = false">知道了</AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup>
/**
 * 世界BOSS面板组件
 *
 * 功能模块：
 *   1. 标签页切换：BOSS榜单 / 赛季总览
 *   2. BOSS榜单：当前赛季卡 + 可挑战BOSS列表 + BOSS详情视图
 *   3. BOSS详情：基础信息、HP进度条、当前阶段技能、个人/宗门伤害榜
 *   4. 战斗操作区：普攻/技能/必杀三按钮、攻击结果展示、玩家HP、复活、撤退
 *   5. 赛季总览：赛季列表 + 赛季宗门伤害排行
 *
 * 所有数据通过 api/worldBoss 模块调用后端，前端只做展示与接口调用。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import StatBar from '../ui/StatBar.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import { formatTime, formatCompact } from '../../utils/format'
import {
  getAvailableBosses,
  getBossDetail,
  attackBoss,
  revive,
  retreat,
  getSeasons,
  getSeasonRanking
} from '../../api/worldBoss'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ====== 响应式状态 ======

// 标签页：'bosses' | 'seasons'（key/label 契约见 ui/Tabs.vue）
const tabItems = [
  { key: 'bosses', label: 'BOSS榜单' },
  { key: 'seasons', label: '赛季总览' }
]
const activeTab = ref('bosses')

// 全局刷新loading
const loading = ref(false)
// 各区块独立loading
const bossLoading = ref(false)
const detailLoading = ref(false)
const actionLoading = ref(false)
const attackLoading = ref(false)
const seasonLoading = ref(false)
const seasonRankingLoading = ref(false)

// 可挑战BOSS列表 + 当前赛季 + 服务器时间
const bosses = ref([])
const currentSeason = ref(null)
const serverTime = ref('')

// 当前选中的BOSS ID（用于详情视图）
const selectedBossId = ref(null)
// BOSS详情数据
const bossDetail = ref(null)

// 上次攻击结果（用于战斗操作区展示）
const lastAttackResult = ref(null)

// 玩家战斗 HP（独立于BOSS世界HP）
const battleHpCurrent = ref('0')
const battleHpMax = ref('0')
const isDead = ref(false)
const attackCount = ref(0)

// 攻击冷却倒计时（5秒）
const attackCooldownRemaining = ref(0)
// 复活冷却倒计时（60秒）
const reviveCooldownRemaining = ref(0)
// pending BOSS 距现世倒计时
const pendingCountdown = ref(0)

// 赛季相关
const seasons = ref([])
const selectedSeasonId = ref(null)
const seasonRanking = ref([])

// Modal 弹窗状态
const retreatConfirmShow = ref(false)
const reviveConfirmShow = ref(false)
const errorModalShow = ref(false)
const errorMessage = ref('')

// 每秒 tick 定时器（驱动所有冷却倒计时）
let tickTimer = null

// ====== 计算属性 ======

/**
 * 玩家战斗 HP 百分比
 * 使用 BigInt 字符串计算，避免大整数精度丢失
 */
const battleHpPercent = computed(() => {
  try {
    const cur = BigInt(battleHpCurrent.value || '0')
    const mx = BigInt(battleHpMax.value || '1')
    if (mx === 0n) return 0
    return Math.max(0, Math.min(100, Number((cur * 100n) / mx)))
  } catch (e) {
    return 0
  }
})

// ====== 数据拉取方法 ======

/**
 * 拉取可挑战BOSS列表 + 当前赛季
 */
const fetchAvailableBosses = async () => {
  bossLoading.value = true
  try {
    const res = await getAvailableBosses()
    const data = res.data?.data || res.data
    bosses.value = data?.bosses || []
    currentSeason.value = data?.current_season || null
    serverTime.value = data?.server_time || new Date().toISOString()
  } catch (err) {
    const msg = err?.response?.data?.message || '获取BOSS列表失败'
    showError(msg)
  } finally {
    bossLoading.value = false
  }
}

/**
 * 拉取BOSS详情
 */
const fetchBossDetail = async () => {
  if (!selectedBossId.value) return
  detailLoading.value = true
  try {
    const res = await getBossDetail(selectedBossId.value)
    const data = res.data?.data || res.data
    bossDetail.value = data
    // pending 状态计算距现世倒计时（基于 spawn_time 与本地时间差）
    if (data?.boss?.status === 'pending' && data.boss.spawn_time) {
      const spawnTime = new Date(data.boss.spawn_time).getTime()
      const now = Date.now()
      pendingCountdown.value = Math.max(0, Math.floor((spawnTime - now) / 1000))
    } else {
      pendingCountdown.value = 0
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '获取BOSS详情失败'
    showError(msg)
  } finally {
    detailLoading.value = false
  }
}

/**
 * 拉取赛季列表
 */
const fetchSeasons = async () => {
  seasonLoading.value = true
  try {
    const res = await getSeasons()
    const data = res.data?.data || res.data
    // 兼容数组或 {list} 两种返回结构
    seasons.value = Array.isArray(data) ? data : (data?.list || [])
    // 默认选中第一个 active 赛季
    if (!selectedSeasonId.value && seasons.value.length > 0) {
      const activeSeason = seasons.value.find(s => s.status === 'active')
      selectedSeasonId.value = activeSeason?.season_id || seasons.value[0].season_id
      await fetchSeasonRanking()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '获取赛季列表失败'
    showError(msg)
  } finally {
    seasonLoading.value = false
  }
}

/**
 * 拉取赛季宗门伤害排行
 */
const fetchSeasonRanking = async () => {
  if (!selectedSeasonId.value) return
  seasonRankingLoading.value = true
  try {
    const res = await getSeasonRanking(selectedSeasonId.value, 100)
    const data = res.data?.data || res.data
    // 兼容多种返回结构
    const list = data?.ranking || data?.list || (Array.isArray(data) ? data : [])
    seasonRanking.value = Array.isArray(list) ? list : []
  } catch (err) {
    const msg = err?.response?.data?.message || '获取赛季排行失败'
    showError(msg)
  } finally {
    seasonRankingLoading.value = false
  }
}

// ====== 交互方法 ======

/**
 * 切换标签页（按需加载赛季数据）
 */
const switchTab = (tab) => {
  if (activeTab.value === tab) return
  activeTab.value = tab
  // 切换到赛季标签页时按需加载
  if (tab === 'seasons' && seasons.value.length === 0) {
    fetchSeasons()
  }
}

/**
 * 进入BOSS详情视图
 */
const enterBossDetail = (bossId) => {
  selectedBossId.value = bossId
  bossDetail.value = null
  lastAttackResult.value = null
  battleHpCurrent.value = '0'
  battleHpMax.value = '0'
  isDead.value = false
  attackCount.value = 0
  attackCooldownRemaining.value = 0
  reviveCooldownRemaining.value = 0
  pendingCountdown.value = 0
  fetchBossDetail()
}

/**
 * 退出BOSS详情视图并刷新列表
 */
const exitBossDetail = () => {
  selectedBossId.value = null
  bossDetail.value = null
  lastAttackResult.value = null
  // 同时刷新列表，保持最新状态
  fetchAvailableBosses()
}

/**
 * 选择赛季
 */
const selectSeason = (seasonId) => {
  selectedSeasonId.value = seasonId
  fetchSeasonRanking()
}

/**
 * 攻击BOSS
 * @param skillId 技能ID：basic=普攻 / skill=技能 / ultimate=必杀
 */
const handleAttack = async (skillId) => {
  if (!selectedBossId.value) return
  // 攻击冷却中拦截
  if (attackCooldownRemaining.value > 0) {
    uiStore.showToast(`攻击冷却中，剩余 ${attackCooldownRemaining.value} 秒`, 'warning')
    return
  }
  // 死亡状态拦截
  if (isDead.value) {
    uiStore.showToast('已陨落，需先原地复活', 'warning')
    return
  }
  if (attackLoading.value) return

  attackLoading.value = true
  try {
    const res = await attackBoss(selectedBossId.value, skillId)
    const data = res.data?.data || res.data
    lastAttackResult.value = data

    // 更新玩家战斗 HP 与死亡状态
    if (data?.player) {
      battleHpCurrent.value = data.player.battle_hp_after || '0'
      battleHpMax.value = data.player.battle_hp_max || battleHpMax.value
      isDead.value = !!data.player.is_dead
      attackCount.value = data.player.attack_count || attackCount.value + 1
    }

    // 同步更新 BOSS 信息
    if (data?.boss && bossDetail.value) {
      bossDetail.value.boss.hp_current = data.boss.hp_after
      bossDetail.value.boss.hp_percentage = data.boss.hp_percentage
      bossDetail.value.boss.phase = data.boss.phase
      bossDetail.value.boss.status = data.boss.status

      // BOSS被击败时刷新详情和列表
      if (data.boss.defeated) {
        uiStore.showToast('BOSS已被诛灭！', 'success')
        await fetchBossDetail()
        await fetchAvailableBosses()
      }
    }

    // 攻击后启动5秒冷却
    attackCooldownRemaining.value = 5
    // 若死亡，启动60秒复活冷却
    if (isDead.value) {
      reviveCooldownRemaining.value = 60
    }
  } catch (err) {
    uiStore.showApiError(err, '攻击失败')
  } finally {
    attackLoading.value = false
  }
}

/**
 * 打开撤退确认弹窗
 */
const openRetreatConfirm = () => {
  retreatConfirmShow.value = true
}

/**
 * 确认撤退
 */
const confirmRetreat = async () => {
  if (actionLoading.value) return
  if (!selectedBossId.value) return
  actionLoading.value = true
  try {
    const res = await retreat(selectedBossId.value)
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '已撤退', 'warning')
    retreatConfirmShow.value = false
    // 退出详情视图，刷新列表
    exitBossDetail()
  } catch (err) {
    uiStore.showApiError(err, '撤退失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 打开复活确认弹窗
 */
const openReviveConfirm = () => {
  reviveConfirmShow.value = true
}

/**
 * 确认复活
 */
const confirmRevive = async () => {
  if (actionLoading.value) return
  if (!selectedBossId.value) return
  if (reviveCooldownRemaining.value > 0) {
    uiStore.showToast(`复活冷却中，剩余 ${reviveCooldownRemaining.value} 秒`, 'warning')
    return
  }
  actionLoading.value = true
  try {
    const res = await revive(selectedBossId.value)
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '已复活', 'success')
    reviveConfirmShow.value = false
    // 更新玩家 HP
    if (data?.battle_hp) {
      battleHpCurrent.value = data.battle_hp
    }
    isDead.value = false
    // 重新拉取详情以同步 BOSS 状态
    await fetchBossDetail()
  } catch (err) {
    uiStore.showApiError(err, '复活失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 刷新全部数据（按当前标签页刷新）
 */
const refreshAll = async () => {
  loading.value = true
  try {
    if (activeTab.value === 'bosses') {
      if (selectedBossId.value) {
        await Promise.all([fetchAvailableBosses(), fetchBossDetail()])
      } else {
        await fetchAvailableBosses()
      }
    } else {
      await Promise.all([fetchSeasons(), fetchSeasonRanking()])
    }
  } finally {
    loading.value = false
  }
}

/**
 * 仅刷新赛季排行
 */
const refreshSeasonRanking = () => {
  fetchSeasonRanking()
}

/**
 * 显示错误弹窗
 */
const showError = (msg) => {
  errorMessage.value = msg
  errorModalShow.value = true
}

// ====== 格式化辅助 ======

/**
 * 将百分比限制在 0-100 之间
 */
const clampPercent = (percent) => {
  const n = Number(percent) || 0
  return Math.max(0, Math.min(100, n))
}

/**
 * HP 进度条色（红→金→绿根据百分比）
 * 设计意图：BOSS HP 高=血光（满血危险），中=鎏金，低=灵光（即将胜利）
 * tone 取值见 ui/StatBar.vue
 */
const hpBarTone = (percent) => {
  const p = Number(percent) || 0
  if (p >= 75) return 'blood'
  if (p >= 30) return 'gold'
  return 'jade'
}

/**
 * BOSS 状态徽章色（tone 取值见 ui/Badge.vue）
 */
const bossStatusBadgeTone = (status) => {
  const map = {
    pending: 'muted',
    active: 'danger',
    defeated: 'gold',
    expired: 'muted'
  }
  return map[status] || 'neutral'
}

/**
 * BOSS 状态中文标签
 */
const bossStatusLabel = (status) => {
  const map = {
    pending: '即将现世',
    active: '激战中',
    defeated: '已伏诛',
    expired: '已消散'
  }
  return map[status] || status
}

/**
 * 赛季状态徽章色
 */
const seasonStatusBadgeTone = (status) => {
  const map = {
    active: 'danger',
    pending: 'neutral',
    ended: 'muted'
  }
  return map[status] || 'neutral'
}

/**
 * 赛季状态中文标签
 */
const seasonStatusLabel = (status) => {
  const map = {
    active: '进行中',
    pending: '未开始',
    ended: '已结束'
  }
  return map[status] || status
}

/**
 * 技能ID中文标签
 */
const skillLabel = (skillId) => {
  const map = {
    basic: '普攻',
    skill: '技能',
    ultimate: '必杀'
  }
  return map[skillId] || skillId
}

/**
 * 境界要求中文标签
 * realm_rank_min: 1=炼气 2=筑基 3=金丹 4=元婴 5=化神 6=炼虚 7=合体 8=大乘 9=渡劫
 */
const realmRankLabel = (rank) => {
  const map = {
    1: '炼气期',
    2: '筑基期',
    3: '金丹期',
    4: '元婴期',
    5: '化神期',
    6: '炼虚期',
    7: '合体期',
    8: '大乘期',
    9: '渡劫期'
  }
  return map[rank] || `境界${rank}`
}

/**
 * 五行相克样式（批次4-2-Ext2 新增）
 * 根据 elemental_counter.advantage 字段返回 Tailwind 颜色类
 * - advantage=true：绿色（玩家灵兽克制BOSS）
 * - advantage=false：红色（被BOSS克制）
 * - null/undefined：灰色（无相克）
 * @param {Object} elementalCounter - elemental_counter 响应对象
 * @returns {string} Tailwind 颜色类
 */
const elementalCounterClass = (elementalCounter) => {
  if (!elementalCounter) return 'text-fg-muted'
  if (elementalCounter.advantage === true) return 'text-emerald-400 font-bold'
  if (elementalCounter.advantage === false) return 'text-rose-400 font-bold'
  return 'text-fg-muted'
}

/**
 * 格式化 Buff 剩余时间（批次4-2-Ext3 新增）
 * 将 Buff.expire_at 时间戳转为 "Xs" 倒计时显示
 * @param {string|number} expireAt - 过期时间戳（ms）
 * @returns {string} 剩余秒数显示
 */
const formatBuffRemaining = (expireAt) => {
  if (!expireAt) return ''
  const remainMs = Number(expireAt) - Date.now()
  if (remainMs <= 0) return '已过期'
  return `${Math.ceil(remainMs / 1000)}s`
}

// ====== 生命周期 ======

onMounted(async () => {
  // 进入面板自动拉取可挑战BOSS列表
  await fetchAvailableBosses()
  // 启动每秒 tick，驱动所有冷却倒计时递减
  tickTimer = setInterval(() => {
    if (attackCooldownRemaining.value > 0) attackCooldownRemaining.value--
    if (reviveCooldownRemaining.value > 0) reviveCooldownRemaining.value--
    if (pendingCountdown.value > 0) pendingCountdown.value--
  }, 1000)
})

onUnmounted(() => {
  // 清理定时器，避免内存泄漏
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
})
</script>
