/**
 * 世界BOSS面板组件
 *
 * 弹窗式组件，展示世界BOSS列表/详情/伤害排行/战斗操作。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - HP/伤害等大整数以字符串形式展示，避免精度丢失
 *   - 攻击冷却5秒，复活冷却60秒，撤退禁入5分钟
 *   - 颜色风格：世界BOSS 用红色系（red-400/red-500/red-600）匹配战斗主题
 *
 * 数据来源：
 *   - getAvailableBosses()：可挑战BOSS列表 + 当前赛季
 *   - getBossDetail()：BOSS详情/技能/排行
 *   - attackBoss() / revive() / retreat()：战斗操作
 *   - getSeasons() / getSeasonRanking()：赛季查询
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-red-900/40 rounded-lg p-6 max-w-4xl w-full mx-4 shadow-2xl shadow-red-900/20 animate-fade-in max-h-[88vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-red-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 3 L19 3 L19 12 a7 7 0 0 1 -14 0 Z"/>
            <path d="M12 19 L12 22"/>
            <circle cx="9" cy="9" r="1"/>
            <circle cx="15" cy="9" r="1"/>
          </svg>
          世界BOSS
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 标签页切换 -->
      <div class="flex gap-1 mb-4 border-b border-stone-800">
        <button @click="switchTab('bosses')"
          :class="activeTab === 'bosses' ? 'border-red-500 text-red-300' : 'border-transparent text-stone-400 hover:text-stone-200'"
          class="px-4 py-2 text-sm font-bold border-b-2 transition-colors">BOSS榜单</button>
        <button @click="switchTab('seasons')"
          :class="activeTab === 'seasons' ? 'border-red-500 text-red-300' : 'border-transparent text-stone-400 hover:text-stone-200'"
          class="px-4 py-2 text-sm font-bold border-b-2 transition-colors">赛季总览</button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- ============ BOSS榜单标签页 ============ -->
        <template v-if="activeTab === 'bosses'">
          <!-- 加载中 -->
          <div v-if="bossLoading && !bosses.length" class="text-center text-stone-500 py-10">正在查阅天机阁榜单...</div>

          <template v-else>
            <!-- ===== 列表视图 ===== -->
            <template v-if="!selectedBossId">
              <!-- 当前赛季卡 -->
              <div v-if="currentSeason" class="bg-gradient-to-br from-red-950/40 to-[#292524] border border-red-800/40 rounded-lg p-4">
                <div class="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <div class="text-xs text-red-400 mb-1">当前赛季</div>
                    <div class="text-lg font-bold text-red-300">{{ currentSeason.season_name }}</div>
                    <div class="text-xs text-stone-400 mt-1">{{ currentSeason.start_date }} ~ {{ currentSeason.end_date }}</div>
                  </div>
                  <div class="text-center">
                    <div class="text-xs text-stone-500">已诛魔数</div>
                    <div class="text-2xl font-bold text-amber-300">{{ currentSeason.total_bosses_killed }}</div>
                  </div>
                </div>
              </div>

              <!-- BOSS 列表 -->
              <div v-if="bosses.length === 0" class="text-center text-stone-500 py-8 text-sm">
                当前无可挑战之BOSS，敬请期待天机阁新通缉令
              </div>
              <div v-else class="space-y-3">
                <div v-for="boss in bosses" :key="boss.id"
                  @click="enterBossDetail(boss.id)"
                  class="bg-[#292524] border border-stone-700 hover:border-red-600/60 rounded-lg p-4 cursor-pointer transition-all hover:bg-[#292524]/80">
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <span class="text-base font-bold text-red-300">{{ boss.boss_name }}</span>
                        <span v-if="boss.status === 'pending'"
                          class="px-2 py-0.5 rounded text-xs font-bold bg-stone-800 text-stone-300">即将现世</span>
                        <span v-else-if="boss.status === 'active'"
                          class="px-2 py-0.5 rounded text-xs font-bold bg-red-900/60 text-red-300 animate-pulse">激战中</span>
                        <span v-else-if="boss.status === 'defeated'"
                          class="px-2 py-0.5 rounded text-xs font-bold bg-amber-900/60 text-amber-300">已伏诛</span>
                        <span v-else-if="boss.status === 'expired'"
                          class="px-2 py-0.5 rounded text-xs font-bold bg-stone-800 text-stone-500">已消散</span>
                      </div>
                      <div class="text-xs text-stone-400 mb-2">境界要求：{{ realmRankLabel(boss.realm_rank_min) }}</div>

                      <!-- pending: 显示刷新倒计时 -->
                      <div v-if="boss.status === 'pending'" class="text-xs text-amber-400">
                        <span v-if="boss.countdown_seconds > 0">距现世：{{ formatTime(boss.countdown_seconds) }}</span>
                        <span v-else>即将现世</span>
                      </div>

                      <!-- active/defeated: HP进度条 + 参与人数 + 阶段 -->
                      <div v-else class="space-y-1">
                        <div class="flex justify-between text-xs">
                          <span class="text-stone-400">气血：{{ formatNumber(boss.hp_current) }} / {{ formatNumber(boss.hp_max) }}</span>
                          <span class="text-stone-500">{{ boss.hp_percentage }}%</span>
                        </div>
                        <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                          <div class="h-full transition-all duration-300"
                            :class="hpBarColorClass(boss.hp_percentage)"
                            :style="{ width: `${clampPercent(boss.hp_percentage)}%` }"></div>
                        </div>
                        <div class="flex items-center justify-between text-xs text-stone-500 mt-1">
                          <span>阶段：第 {{ boss.phase }} 阶</span>
                          <span>参战修士：{{ boss.participant_count }} 人</span>
                        </div>
                      </div>
                    </div>
                    <svg class="w-5 h-5 text-stone-500 shrink-0 mt-1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m9 18 6-6-6-6"/>
                    </svg>
                  </div>
                </div>
              </div>
            </template>

            <!-- ===== 详情视图 ===== -->
            <template v-else>
              <button @click="exitBossDetail" class="flex items-center gap-1 text-sm text-stone-400 hover:text-red-300 transition-colors mb-2">
                <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                返回榜单
              </button>

              <!-- 详情加载中 -->
              <div v-if="detailLoading && !bossDetail" class="text-center text-stone-500 py-10">正在调取BOSS卷宗...</div>

              <template v-else-if="bossDetail">
                <!-- BOSS基础信息 -->
                <div class="bg-gradient-to-br from-red-950/40 to-[#292524] border border-red-800/40 rounded-lg p-4">
                  <div class="flex items-start justify-between flex-wrap gap-3">
                    <div>
                      <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 class="text-lg font-bold text-red-300">{{ bossDetail.boss.boss_name }}</h3>
                        <span class="px-2 py-0.5 rounded text-xs font-bold"
                          :class="bossStatusBadgeClass(bossDetail.boss.status)">
                          {{ bossStatusLabel(bossDetail.boss.status) }}
                        </span>
                      </div>
                      <div class="text-xs text-stone-400">境界要求：{{ realmRankLabel(bossDetail.boss.realm_rank_min) }}</div>
                      <div class="text-xs text-stone-400">阶段：第 {{ bossDetail.boss.phase }} 阶</div>
                    </div>
                    <div class="text-right text-xs text-stone-500">
                      <div>攻击 <span class="text-red-300">{{ bossDetail.boss.atk }}</span> · 防御 <span class="text-cyan-300">{{ bossDetail.boss.def }}</span></div>
                      <div>速度 <span class="text-amber-300">{{ bossDetail.boss.speed }}</span></div>
                      <div>参战 <span class="text-stone-300">{{ bossDetail.boss.participant_count }}</span> 人</div>
                    </div>
                  </div>

                  <!-- 描述 -->
                  <p v-if="bossDetail.description" class="mt-3 text-xs text-stone-400 italic leading-relaxed border-l-2 border-red-900/50 pl-3">
                    "{{ bossDetail.description }}"
                  </p>

                  <!-- HP 大进度条 -->
                  <div class="mt-4 space-y-1">
                    <div class="flex justify-between text-xs">
                      <span class="text-red-300 font-bold">BOSS气血</span>
                      <span class="text-stone-400">
                        {{ formatNumber(bossDetail.boss.hp_current) }} / {{ formatNumber(bossDetail.boss.hp_max) }}
                        <span class="ml-1 text-stone-500">({{ bossDetail.boss.hp_percentage }}%)</span>
                      </span>
                    </div>
                    <div class="h-3 bg-stone-800 rounded-full overflow-hidden">
                      <div class="h-full transition-all duration-500"
                        :class="hpBarColorClass(bossDetail.boss.hp_percentage)"
                        :style="{ width: `${clampPercent(bossDetail.boss.hp_percentage)}%` }"></div>
                    </div>
                  </div>

                  <!-- 击杀信息 -->
                  <div v-if="bossDetail.boss.killer_nickname" class="mt-3 text-xs text-amber-300 bg-amber-950/30 border border-amber-900/40 rounded p-2">
                    已被 <span class="font-bold">{{ bossDetail.boss.killer_nickname }}</span> 道友诛灭于 {{ bossDetail.boss.defeat_time }}
                  </div>
                </div>

                <!-- 当前阶段技能列表 -->
                <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                  <div class="text-sm font-bold text-red-300 mb-3">当前阶段神通</div>
                  <div v-if="!bossDetail.current_phase_skills || bossDetail.current_phase_skills.length === 0" class="text-xs text-stone-500">暂无技能数据</div>
                  <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div v-for="(skill, idx) in bossDetail.current_phase_skills" :key="idx"
                      class="bg-[#0c0a09]/60 border border-stone-800 rounded p-3">
                      <div class="flex items-center justify-between mb-1">
                        <span class="text-sm font-bold text-amber-300">{{ skill.name }}</span>
                        <span class="text-xs text-stone-500">{{ skill.type }}</span>
                      </div>
                      <p class="text-xs text-stone-400 mb-2">{{ skill.description }}</p>
                      <div class="flex items-center gap-3 text-xs text-stone-500 flex-wrap">
                        <span>倍率 <span class="text-red-300">{{ skill.damage_multiplier }}x</span></span>
                        <span>CD <span class="text-amber-300">{{ skill.cooldown_seconds }}s</span></span>
                        <span v-if="skill.effect" class="text-purple-400">{{ skill.effect }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 个人伤害排行前10 -->
                <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                  <div class="text-sm font-bold text-red-300 mb-3">个人伤害榜 · 前十</div>
                  <div v-if="!bossDetail.personal_ranking || bossDetail.personal_ranking.length === 0" class="text-xs text-stone-500">尚无修士造成伤害</div>
                  <ul v-else class="space-y-1 text-xs">
                    <li v-for="item in bossDetail.personal_ranking.slice(0, 10)" :key="item.player_id"
                      class="flex items-center justify-between px-2 py-1.5 rounded"
                      :class="item.rank <= 3 ? 'bg-amber-950/30' : ''">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="w-6 text-center font-bold shrink-0"
                          :class="item.rank === 1 ? 'text-amber-400' : item.rank === 2 ? 'text-stone-300' : item.rank === 3 ? 'text-amber-700' : 'text-stone-500'">
                          {{ item.rank }}
                        </span>
                        <span class="text-stone-200 truncate">{{ item.player_nickname }}</span>
                        <span class="text-xs text-stone-500 shrink-0">[{{ item.player_realm }}]</span>
                        <span v-if="item.sect_name" class="text-xs text-cyan-400 truncate">{{ item.sect_name }}</span>
                      </div>
                      <div class="flex items-center gap-3 text-stone-400 shrink-0">
                        <span class="text-red-300 font-bold">{{ formatNumber(item.total_damage) }}</span>
                        <span class="text-stone-500">{{ item.damage_percentage }}%</span>
                      </div>
                    </li>
                  </ul>
                </div>

                <!-- 宗门伤害排行前10 -->
                <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                  <div class="text-sm font-bold text-red-300 mb-3">宗门伤害榜 · 前十</div>
                  <div v-if="!bossDetail.sect_ranking || bossDetail.sect_ranking.length === 0" class="text-xs text-stone-500">尚无宗门造成伤害</div>
                  <ul v-else class="space-y-1 text-xs">
                    <li v-for="item in bossDetail.sect_ranking.slice(0, 10)" :key="item.sect_id"
                      class="flex items-center justify-between px-2 py-1.5 rounded"
                      :class="item.rank <= 3 ? 'bg-amber-950/30' : ''">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="w-6 text-center font-bold shrink-0"
                          :class="item.rank === 1 ? 'text-amber-400' : item.rank === 2 ? 'text-stone-300' : item.rank === 3 ? 'text-amber-700' : 'text-stone-500'">
                          {{ item.rank }}
                        </span>
                        <span class="text-stone-200 truncate">{{ item.sect_name }}</span>
                        <span class="text-xs text-stone-500 shrink-0">{{ item.member_count }} 人</span>
                      </div>
                      <div class="flex items-center gap-3 text-stone-400 shrink-0">
                        <span class="text-red-300 font-bold">{{ formatNumber(item.sect_total_damage) }}</span>
                        <span class="text-stone-500">{{ item.damage_percentage }}%</span>
                      </div>
                    </li>
                  </ul>
                </div>

                <!-- ============ 战斗操作区（仅 active 状态显示） ============ -->
                <div v-if="bossDetail.boss.status === 'active'" class="bg-red-950/20 border border-red-800/50 rounded-lg p-4 space-y-3">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                      <span class="px-2 py-0.5 rounded text-xs font-bold bg-red-900/60 text-red-300 animate-pulse">激战中</span>
                      <span class="text-xs text-stone-400">阶段 {{ bossDetail.boss.phase }}</span>
                    </div>
                    <div class="text-xs text-stone-500">已发起 {{ attackCount }} 次攻势</div>
                  </div>

                  <!-- 玩家战斗 HP 条（独立于世界HP） -->
                  <div class="space-y-1">
                    <div class="flex justify-between text-xs">
                      <span class="text-cyan-300">己方气血</span>
                      <span class="text-stone-400">
                        {{ formatNumber(battleHpCurrent) }} / {{ formatNumber(battleHpMax) }}
                      </span>
                    </div>
                    <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                      <div class="h-full bg-gradient-to-r from-cyan-700 to-cyan-500 transition-all duration-300"
                        :style="{ width: `${battleHpPercent}%` }"></div>
                    </div>
                    <div v-if="isDead" class="text-xs text-rose-400 mt-1">已陨落，需原地复活方可再战</div>
                  </div>

                  <!-- 上次攻击结果展示 -->
                  <div v-if="lastAttackResult" class="bg-[#0c0a09]/60 border border-stone-800 rounded p-3 space-y-1.5 text-xs">
                    <div class="flex items-center justify-between">
                      <span class="text-stone-400">本回合攻势</span>
                      <span class="text-amber-300">
                        {{ skillLabel(lastAttackResult.attack.skill_id) }} ·
                        <span :class="lastAttackResult.attack.is_crit ? 'text-red-400 font-bold' : 'text-stone-300'">
                          伤害 {{ formatNumber(lastAttackResult.attack.damage) }}{{ lastAttackResult.attack.is_crit ? ' (暴击!)' : '' }}
                        </span>
                      </span>
                    </div>
                    <div v-if="lastAttackResult.counter && lastAttackResult.counter.damage > 0" class="flex items-center justify-between text-rose-400">
                      <span>BOSS反击</span>
                      <span>-{{ formatNumber(lastAttackResult.counter.damage) }}</span>
                    </div>
                    <div v-if="lastAttackResult.boss && lastAttackResult.boss.phase_changed" class="text-purple-400">
                      BOSS进入新阶段！
                    </div>
                    <div v-if="lastAttackResult.boss && lastAttackResult.boss.defeated" class="text-amber-300 font-bold">
                      BOSS已被诛灭！
                    </div>
                    <div v-if="lastAttackResult.settle && lastAttackResult.settle.summary" class="text-emerald-300 border-t border-stone-800 pt-1.5 mt-1">
                      {{ lastAttackResult.settle.summary }}
                    </div>
                  </div>

                  <!-- 三技能按钮 -->
                  <div class="grid grid-cols-3 gap-2">
                    <button @click="handleAttack('basic')"
                      :disabled="attackLoading || attackCooldownRemaining > 0 || isDead"
                      class="px-2 py-2.5 text-xs font-bold rounded bg-red-900/50 border border-red-700 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed">
                      <div>普攻</div>
                      <div class="text-[10px] opacity-70">1.0x</div>
                      <div v-if="attackCooldownRemaining > 0" class="text-[10px] text-amber-400">{{ attackCooldownRemaining }}s</div>
                    </button>
                    <button @click="handleAttack('skill')"
                      :disabled="attackLoading || attackCooldownRemaining > 0 || isDead"
                      class="px-2 py-2.5 text-xs font-bold rounded bg-purple-900/50 border border-purple-700 text-purple-300 hover:bg-purple-800/60 disabled:opacity-40 disabled:cursor-not-allowed">
                      <div>技能</div>
                      <div class="text-[10px] opacity-70">1.5x</div>
                      <div v-if="attackCooldownRemaining > 0" class="text-[10px] text-amber-400">{{ attackCooldownRemaining }}s</div>
                    </button>
                    <button @click="handleAttack('ultimate')"
                      :disabled="attackLoading || attackCooldownRemaining > 0 || isDead"
                      class="px-2 py-2.5 text-xs font-bold rounded bg-amber-900/50 border border-amber-700 text-amber-300 hover:bg-amber-800/60 disabled:opacity-40 disabled:cursor-not-allowed">
                      <div>必杀</div>
                      <div class="text-[10px] opacity-70">2.5x</div>
                      <div v-if="attackCooldownRemaining > 0" class="text-[10px] text-amber-400">{{ attackCooldownRemaining }}s</div>
                    </button>
                  </div>

                  <!-- 复活/撤退按钮 -->
                  <div class="grid grid-cols-2 gap-2">
                    <button v-if="isDead" @click="openReviveConfirm"
                      :disabled="actionLoading || reviveCooldownRemaining > 0"
                      class="px-2 py-2 text-xs font-bold rounded bg-emerald-900/50 border border-emerald-700 text-emerald-300 hover:bg-emerald-800/60 disabled:opacity-40 disabled:cursor-not-allowed">
                      <span v-if="reviveCooldownRemaining > 0">复活冷却 {{ reviveCooldownRemaining }}s</span>
                      <span v-else>原地复活 (消耗灵石)</span>
                    </button>
                    <button @click="openRetreatConfirm"
                      :disabled="actionLoading"
                      class="px-2 py-2 text-xs font-bold rounded bg-stone-800 border border-stone-600 text-stone-300 hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed">
                      撤退 (5分钟禁入)
                    </button>
                  </div>
                </div>

                <!-- 待激活提示 -->
                <div v-else-if="bossDetail.boss.status === 'pending'" class="bg-amber-950/20 border border-amber-800/50 rounded-lg p-4 text-center">
                  <div class="text-amber-300 text-sm font-bold mb-1">魔头尚未现世</div>
                  <div class="text-xs text-stone-400">
                    <span v-if="pendingCountdown > 0">距现世：{{ formatTime(pendingCountdown) }}</span>
                    <span v-else>即将现世</span>
                  </div>
                  <div class="text-xs text-stone-500 mt-2">现世后即可参与围攻</div>
                </div>

                <!-- 已伏诛 -->
                <div v-else-if="bossDetail.boss.status === 'defeated'" class="bg-amber-950/20 border border-amber-800/50 rounded-lg p-4 text-center">
                  <div class="text-amber-300 text-sm font-bold">魔头已伏诛</div>
                  <div class="text-xs text-stone-400 mt-1">可查看上方伤害榜</div>
                </div>

                <!-- 已消散 -->
                <div v-else-if="bossDetail.boss.status === 'expired'" class="bg-stone-800/40 border border-stone-700 rounded-lg p-4 text-center">
                  <div class="text-stone-400 text-sm font-bold">魔气已散</div>
                  <div class="text-xs text-stone-500 mt-1">BOSS已超时消失</div>
                </div>
              </template>
            </template>
          </template>
        </template>

        <!-- ============ 赛季总览标签页 ============ -->
        <template v-else-if="activeTab === 'seasons'">
          <!-- 赛季列表 -->
          <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="text-sm font-bold text-red-300 mb-3">赛季列表</div>
            <div v-if="seasonLoading && !seasons.length" class="text-center text-stone-500 py-4 text-xs">正在查阅赛季卷宗...</div>
            <div v-else-if="seasons.length === 0" class="text-center text-stone-500 py-4 text-xs">暂无赛季记录</div>
            <ul v-else class="space-y-2 text-xs">
              <li v-for="season in seasons" :key="season.season_id"
                @click="selectSeason(season.season_id)"
                class="flex items-center justify-between px-3 py-2 rounded cursor-pointer transition-colors"
                :class="selectedSeasonId === season.season_id ? 'bg-red-900/40 border border-red-600' : 'bg-[#0c0a09]/40 border border-stone-800 hover:border-stone-600'">
                <div>
                  <div class="font-bold text-stone-200">{{ season.season_name }}</div>
                  <div class="text-stone-500">{{ season.start_date }} ~ {{ season.end_date }}</div>
                </div>
                <div class="flex items-center gap-3">
                  <span class="px-2 py-0.5 rounded text-[10px] font-bold"
                    :class="seasonStatusBadgeClass(season.status)">{{ seasonStatusLabel(season.status) }}</span>
                  <span class="text-amber-300">已诛魔 {{ season.total_bosses_killed }}</span>
                </div>
              </li>
            </ul>
          </div>

          <!-- 赛季宗门伤害排行 -->
          <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-red-300">赛季宗门伤害榜</div>
              <button @click="refreshSeasonRanking" :disabled="seasonRankingLoading"
                class="text-xs text-stone-400 hover:text-red-300 transition-colors">
                {{ seasonRankingLoading ? '刷新中...' : '刷新' }}
              </button>
            </div>
            <div v-if="!selectedSeasonId" class="text-xs text-stone-500 py-3 text-center">请选择赛季</div>
            <div v-else-if="seasonRankingLoading && !seasonRanking.length" class="text-xs text-stone-500 py-3 text-center">正在调取榜单...</div>
            <div v-else-if="seasonRanking.length === 0" class="text-xs text-stone-500 py-3 text-center">暂无排行数据</div>
            <ul v-else class="space-y-1 text-xs">
              <li v-for="(item, idx) in seasonRanking" :key="idx"
                class="flex items-center justify-between px-2 py-1.5 rounded"
                :class="idx < 3 ? 'bg-amber-950/30' : ''">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-6 text-center font-bold shrink-0"
                    :class="idx === 0 ? 'text-amber-400' : idx === 1 ? 'text-stone-300' : idx === 2 ? 'text-amber-700' : 'text-stone-500'">
                    {{ idx + 1 }}
                  </span>
                  <span class="text-stone-200 truncate">{{ item.sect_name || '散修联盟' }}</span>
                  <span class="text-xs text-stone-500 shrink-0">{{ item.member_count || 0 }} 人</span>
                </div>
                <div class="flex items-center gap-3 text-stone-400 shrink-0">
                  <span class="text-red-300 font-bold">{{ formatNumber(item.sect_total_damage || item.total_damage || 0) }}</span>
                  <span v-if="item.damage_percentage" class="text-stone-500">{{ item.damage_percentage }}%</span>
                </div>
              </li>
            </ul>
          </div>
        </template>
      </div>

      <!-- 底部操作栏 -->
      <div class="mt-4 flex gap-2">
        <button @click="$emit('close')"
          class="px-4 py-2.5 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors">
          关闭
        </button>
        <button @click="refreshAll"
          :disabled="loading"
          class="flex-1 py-2.5 rounded-lg font-bold tracking-widest text-sm transition-all disabled:opacity-50 bg-red-950/40 border border-red-700 text-red-300 hover:bg-red-900/40 hover:border-red-500">
          {{ loading ? '刷新中...' : '刷新天机阁' }}
        </button>
      </div>

      <!-- 撤退确认弹窗 -->
      <Modal :isOpen="retreatConfirmShow" title="撤退确认" width="420px" @close="retreatConfirmShow = false">
        <p class="text-stone-300 text-sm">确定要撤退吗？</p>
        <p class="text-rose-400 text-xs mt-2">撤退后5分钟内不可再次加入此BOSS战，已造成的伤害不会清零。</p>
        <template #footer>
          <button @click="retreatConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">取消</button>
          <button @click="confirmRetreat" :disabled="actionLoading"
            class="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded text-sm disabled:opacity-50">
            {{ actionLoading ? '执行中...' : '确认撤退' }}
          </button>
        </template>
      </Modal>

      <!-- 复活确认弹窗 -->
      <Modal :isOpen="reviveConfirmShow" title="原地复活" width="420px" @close="reviveConfirmShow = false">
        <p class="text-stone-300 text-sm">确定要原地复活吗？</p>
        <p class="text-amber-400 text-xs mt-2">复活将消耗灵石（默认1000），并恢复全部战斗气血。复活冷却60秒。</p>
        <template #footer>
          <button @click="reviveConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">取消</button>
          <button @click="confirmRevive" :disabled="actionLoading"
            class="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-sm disabled:opacity-50">
            {{ actionLoading ? '执行中...' : '确认复活' }}
          </button>
        </template>
      </Modal>

      <!-- 错误提示弹窗 -->
      <Modal :isOpen="errorModalShow" title="提示" width="380px" @close="errorModalShow = false">
        <p class="text-stone-300 text-sm">{{ errorMessage }}</p>
        <template #footer>
          <button @click="errorModalShow = false" class="px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded text-sm">知道了</button>
        </template>
      </Modal>
    </div>
  </div>
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
import { formatTime, formatNumber } from '../../utils/format'
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

// 标签页：'bosses' | 'seasons'
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
    const msg = err?.response?.data?.message || '攻击失败'
    uiStore.showToast(msg, 'error')
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
    const msg = err?.response?.data?.message || '撤退失败'
    uiStore.showToast(msg, 'error')
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
    const msg = err?.response?.data?.message || '复活失败'
    uiStore.showToast(msg, 'error')
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
 * HP 进度条颜色（红→黄→绿根据百分比）
 * 设计意图：BOSS HP 高=红色（满血危险），中=黄色，低=绿色（即将胜利）
 */
const hpBarColorClass = (percent) => {
  const p = Number(percent) || 0
  if (p >= 75) return 'bg-gradient-to-r from-red-700 to-red-500'
  if (p >= 30) return 'bg-gradient-to-r from-amber-600 to-amber-400'
  return 'bg-gradient-to-r from-emerald-700 to-emerald-500'
}

/**
 * BOSS 状态徽章样式
 */
const bossStatusBadgeClass = (status) => {
  const map = {
    pending: 'bg-stone-800 text-stone-300',
    active: 'bg-red-900/60 text-red-300',
    defeated: 'bg-amber-900/60 text-amber-300',
    expired: 'bg-stone-800 text-stone-500'
  }
  return map[status] || 'bg-stone-800 text-stone-300'
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
 * 赛季状态徽章样式
 */
const seasonStatusBadgeClass = (status) => {
  const map = {
    active: 'bg-red-900/60 text-red-300',
    pending: 'bg-stone-800 text-stone-300',
    ended: 'bg-stone-800 text-stone-500'
  }
  return map[status] || 'bg-stone-800 text-stone-300'
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

<style scoped>
/* 自定义滚动条样式 */
.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}
.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}
.overflow-y-auto::-webkit-scrollbar-thumb {
  background: #7f1d1d;
  border-radius: 2px;
}
.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: #991b1b;
}
</style>
