/**
 * PVP 斗法面板组件
 *
 * 弹窗式组件，展示玩家 PVP 状态、进行中战斗、排行榜、段位信息。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 冷却倒计时基于 server_time + cooldown_remaining_seconds 本地 tick 递减
 *   - 战斗日志展示按时间倒序（最新在上）
 *   - 颜色风格：PVP 用红色系（red-400/red-500/red-600）区分战斗主题
 *
 * 数据来源：
 *   - getStatus()：玩家自身段位、战绩、进行中战斗、冷却、虚弱、配置
 *   - getLeaderboard(10)：前 10 名玩家排行榜
 *   - executeAction() / flee()：战斗动作
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-red-900/40 rounded-lg p-6 max-w-3xl w-full mx-4 shadow-2xl shadow-red-900/20 animate-fade-in max-h-[88vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-red-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.5 17.5L3 6V3h3l11.5 11.5"/>
            <path d="M13 19l6-6"/>
            <path d="M16 16l4 4"/>
            <path d="M19 21l2-2"/>
          </svg>
          斗法场
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- 加载中 -->
        <div v-if="loading && !status" class="text-center text-stone-500 py-10">正在查阅斗法录...</div>

        <template v-else-if="status">
          <!-- 段位卡：段位名 + 积分 + 胜率 + 连胜 -->
          <div class="bg-gradient-to-br from-red-950/40 to-[#292524] border border-red-800/40 rounded-lg p-4">
            <div class="flex items-center justify-between flex-wrap gap-3">
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-full bg-red-900/40 border border-red-600/50 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-300">
                    <path d="M14.5 17.5L3 6V3h3l11.5 11.5"/>
                    <path d="M13 19l6-6"/>
                    <path d="M16 16l4 4"/>
                  </svg>
                </div>
                <div>
                  <div class="text-2xl font-bold text-red-300">{{ status.ranking.rank_tier || '散修' }}</div>
                  <div class="text-xs text-stone-400">段位</div>
                </div>
              </div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <div class="text-xs text-stone-500">积分</div>
                  <div class="text-red-300 font-bold">{{ status.ranking.score }}</div>
                </div>
                <div>
                  <div class="text-xs text-stone-500">胜率</div>
                  <div class="text-amber-300 font-bold">{{ status.ranking.win_rate }}%</div>
                </div>
                <div>
                  <div class="text-xs text-stone-500">连胜</div>
                  <div class="text-emerald-300 font-bold">{{ status.ranking.win_streak }}</div>
                </div>
                <div>
                  <div class="text-xs text-stone-500">最高连胜</div>
                  <div class="text-purple-300 font-bold">{{ status.ranking.max_win_streak }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- 状态区：剩余次数、冷却、虚弱、荣誉、因果 -->
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            <!-- 今日挑战剩余 -->
            <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs text-stone-400 mb-1">今日挑战</div>
              <div class="text-sm font-bold"
                :class="challengeRemaining > 0 ? 'text-red-400' : 'text-stone-500'">
                {{ challengeRemaining }} / {{ status.config.daily_challenge_limit }}
              </div>
            </div>
            <!-- 今日防守剩余 -->
            <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs text-stone-400 mb-1">今日防守</div>
              <div class="text-sm font-bold"
                :class="defendRemaining > 0 ? 'text-amber-400' : 'text-stone-500'">
                {{ defendRemaining }} / {{ status.config.daily_defend_limit }}
              </div>
            </div>
            <!-- 冷却倒计时 -->
            <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs text-stone-400 mb-1">战斗冷却</div>
              <div v-if="cooldownRemaining > 0" class="text-sm font-bold text-amber-400">
                {{ formatTime(cooldownRemaining) }}
              </div>
              <div v-else class="text-sm font-bold text-emerald-400">可挑战</div>
            </div>
            <!-- 荣誉值 -->
            <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs text-stone-400 mb-1">荣誉值</div>
              <div class="text-sm font-bold text-amber-300">{{ status.player.honor }}</div>
            </div>
            <!-- 因果值 -->
            <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs text-stone-400 mb-1">因果值</div>
              <div class="text-sm font-bold"
                :class="status.player.karma < 0 ? 'text-rose-400' : 'text-stone-200'">
                {{ status.player.karma }}
              </div>
            </div>
            <!-- 战力 -->
            <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs text-stone-400 mb-1">战力</div>
              <div class="text-sm font-bold text-cyan-300">{{ status.player.power }}</div>
            </div>
          </div>

          <!-- 虚弱状态警告（仅虚弱时显示） -->
          <div v-if="status.player.is_weak" class="bg-rose-950/30 border border-rose-800/60 rounded-lg p-3 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div class="flex-1">
              <div class="text-rose-300 font-bold text-sm">斗法落败 · 灵力虚浮</div>
              <div class="text-xs text-rose-400/80">
                剩余 {{ formatTime(weaknessRemaining) }} · 修炼/突破效率下降，请静养恢复
              </div>
            </div>
          </div>

          <!-- 避世/入世模式卡 -->
          <!-- 玩法文档第17节：避世可免疫斗法与袭扰，入世则恢复正常 PVP 交互 -->
          <div class="bg-[#292524] border rounded-lg p-3"
            :class="isRecluseMode ? 'border-cyan-700/60' : 'border-stone-700'">
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
                    :class="isRecluseMode ? 'text-cyan-400/70' : 'text-stone-400'">
                    {{ isRecluseMode
                      ? '避世清修·免疫斗法袭扰，自身亦不可发起挑战'
                      : '入世历劫·可正常参与 PVP 挑战、决斗、封神台' }}
                  </div>
                </div>
              </div>
              <!-- 切换按钮 -->
              <button
                @click="openPvpModeConfirm"
                :disabled="modeSwitching"
                class="px-3 py-1.5 text-xs font-bold rounded border transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                :class="isRecluseMode
                  ? 'bg-emerald-900/40 border-emerald-600 text-emerald-300 hover:bg-emerald-800/50'
                  : 'bg-cyan-900/40 border-cyan-600 text-cyan-300 hover:bg-cyan-800/50'"
              >
                {{ modeSwitching ? '切换中...' : (isRecluseMode ? '入世' : '避世') }}
              </button>
            </div>
          </div>

          <!-- 进行中战斗区 -->
          <div v-if="status.is_in_pvp_battle && status.battle_info" class="bg-red-950/20 border border-red-800/50 rounded-lg p-4 space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded text-xs font-bold bg-red-900/60 text-red-300">战斗中</span>
                <span class="text-xs text-stone-400">回合 {{ status.battle_info.current_round }} / {{ status.battle_info.max_rounds }}</span>
              </div>
              <div class="text-xs"
                :class="status.battle_info.is_my_turn ? 'text-emerald-400 font-bold' : 'text-amber-400'">
                {{ status.battle_info.is_my_turn ? '己方回合' : '对手回合' }}
              </div>
            </div>

            <!-- 对手信息 -->
            <div class="bg-[#0c0a09]/60 border border-red-900/30 rounded p-3">
              <div class="flex items-center justify-between text-sm mb-2">
                <div class="flex items-center gap-2">
                  <span class="text-stone-400 text-xs">对手：</span>
                  <span class="text-red-300 font-bold">{{ status.battle_info.opponent_nickname }}</span>
                  <span class="text-xs text-stone-500">[{{ status.battle_info.opponent_realm }}]</span>
                </div>
                <div class="text-xs text-stone-500">
                  对手战力：<span class="text-red-300">{{ status.battle_info.opponent_power }}</span>
                  <span class="mx-1">|</span>
                  己方战力：<span class="text-cyan-300">{{ status.battle_info.attacker_power }}</span>
                </div>
              </div>
              <!-- HP 进度条 -->
              <div class="space-y-2">
                <div>
                  <div class="flex justify-between text-xs mb-0.5">
                    <span class="text-cyan-300">己方气血</span>
                    <span class="text-stone-400">{{ currentAttackerHp }} / {{ maxHp }}</span>
                  </div>
                  <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-cyan-700 to-cyan-500 transition-all duration-300"
                      :style="{ width: `${attackerHpPercent}%` }"></div>
                  </div>
                </div>
                <div>
                  <div class="flex justify-between text-xs mb-0.5">
                    <span class="text-red-300">对手气血</span>
                    <span class="text-stone-400">{{ currentDefenderHp }} / {{ maxHp }}</span>
                  </div>
                  <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-red-700 to-red-500 transition-all duration-300"
                      :style="{ width: `${defenderHpPercent}%` }"></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 战斗日志（最近 5 条，最新在上） -->
            <div class="bg-[#0c0a09]/60 border border-stone-800/60 rounded p-2">
              <div class="text-xs text-stone-500 mb-1">战斗记录</div>
              <div v-if="recentLogs.length === 0" class="text-xs text-stone-600 py-2 text-center">尚无战斗记录</div>
              <ul v-else class="space-y-1 text-xs">
                <li v-for="(log, idx) in recentLogs" :key="idx"
                  class="flex items-start gap-2 px-2 py-1 rounded"
                  :class="log.actor === 'attacker' ? 'bg-cyan-950/30' : 'bg-red-950/30'">
                  <span class="text-stone-500 shrink-0">[R{{ log.round || '-' }}]</span>
                  <span :class="log.actor === 'attacker' ? 'text-cyan-300' : 'text-red-300'">
                    {{ log.actor === 'attacker' ? '攻' : '守' }}
                  </span>
                  <span class="text-stone-300 flex-1">{{ formatLogText(log) }}</span>
                  <span v-if="log.damage > 0" class="text-amber-400 shrink-0">-{{ log.damage }}</span>
                </li>
              </ul>
            </div>

            <!-- 操作按钮 -->
            <div class="grid grid-cols-4 gap-2">
              <button
                @click="handleAction('attack')"
                :disabled="actionLoading || !status.battle_info.is_my_turn"
                class="px-2 py-2 text-xs font-bold rounded bg-red-900/50 border border-red-700 text-red-300 hover:bg-red-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
              >攻击</button>
              <button
                @click="handleAction('skill')"
                :disabled="actionLoading || !status.battle_info.is_my_turn"
                class="px-2 py-2 text-xs font-bold rounded bg-purple-900/50 border border-purple-700 text-purple-300 hover:bg-purple-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
              >技能</button>
              <button
                @click="handleAction('defend')"
                :disabled="actionLoading || !status.battle_info.is_my_turn"
                class="px-2 py-2 text-xs font-bold rounded bg-cyan-900/50 border border-cyan-700 text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
              >防御</button>
              <button
                @click="openFleeConfirm"
                :disabled="actionLoading"
                class="px-2 py-2 text-xs font-bold rounded bg-stone-800 border border-stone-600 text-stone-300 hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >逃跑</button>
            </div>
          </div>

          <!-- 排行榜区（前 10 名） -->
          <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
              <div class="text-sm font-bold text-red-300">天榜前十</div>
              <button @click="refreshLeaderboard" :disabled="leaderboardLoading"
                class="text-xs text-stone-400 hover:text-red-300 transition-colors">
                {{ leaderboardLoading ? '刷新中...' : '刷新' }}
              </button>
            </div>
            <div v-if="leaderboard.length === 0" class="text-xs text-stone-500 py-2 text-center">暂无榜单数据</div>
            <ul v-else class="space-y-1 text-xs">
              <li v-for="(item, idx) in leaderboard" :key="item.player_id"
                class="flex items-center justify-between px-2 py-1 rounded"
                :class="idx < 3 ? 'bg-amber-950/30' : ''">
                <div class="flex items-center gap-2">
                  <span class="w-5 text-center font-bold"
                    :class="idx === 0 ? 'text-amber-400' : idx === 1 ? 'text-stone-300' : idx === 2 ? 'text-amber-700' : 'text-stone-500'">
                    {{ idx + 1 }}
                  </span>
                  <span class="text-stone-200">{{ item.nickname }}</span>
                  <span class="text-xs text-stone-500">[{{ item.rank_tier }}]</span>
                </div>
                <div class="flex items-center gap-3 text-stone-400">
                  <span>积分 <span class="text-red-300 font-bold">{{ item.score }}</span></span>
                  <span>胜率 <span class="text-amber-300">{{ calcWinRate(item) }}%</span></span>
                </div>
              </li>
            </ul>
          </div>

          <!-- 段位信息区 -->
          <div class="bg-[#292524] border border-stone-700 rounded-lg p-3">
            <div class="text-sm font-bold text-red-300 mb-2">段位阶序</div>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              <div v-for="(rank, idx) in status.config.ranks" :key="idx"
                class="px-2 py-1.5 rounded border flex items-center justify-between"
                :class="rank.name === status.ranking.rank_tier
                  ? 'bg-red-900/40 border-red-600 text-red-300'
                  : 'bg-[#0c0a09]/40 border-stone-800 text-stone-400'">
                <span class="font-bold">{{ rank.name }}</span>
                <span>{{ formatScoreRange(rank) }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- 底部操作栏 -->
      <div class="mt-4 flex gap-2">
        <button
          @click="$emit('close')"
          class="px-4 py-2.5 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors"
        >关闭</button>
        <button
          @click="refreshAll"
          :disabled="loading"
          class="flex-1 py-2.5 rounded-lg font-bold tracking-widest text-sm transition-all disabled:opacity-50 bg-red-950/40 border border-red-700 text-red-300 hover:bg-red-900/40 hover:border-red-500"
        >
          {{ loading ? '刷新中...' : '刷新斗法录' }}
        </button>
      </div>

      <!-- 逃跑确认弹窗 -->
      <Modal :isOpen="fleeConfirmShow" title="逃跑确认" width="420px" @close="fleeConfirmShow = false">
        <p class="text-stone-300 text-sm">确定要逃跑吗？</p>
        <p class="text-rose-400 text-xs mt-2">逃跑将视为失败结算：扣除积分、可能进入虚弱状态，且不会获得任何奖励。</p>
        <template #footer>
          <button @click="fleeConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">取消</button>
          <button @click="confirmFlee" :disabled="actionLoading"
            class="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded text-sm disabled:opacity-50">
            {{ actionLoading ? '执行中...' : '确认逃跑' }}
          </button>
        </template>
      </Modal>

      <!-- 避世/入世切换确认弹窗 -->
      <!-- 玩法文档第17节：避世免疫斗法袭扰，入世恢复正常 PVP 交互 -->
      <Modal :isOpen="pvpModeConfirmShow" :title="pvpModeConfirmTitle" width="460px" @close="pvpModeConfirmShow = false">
        <div class="space-y-3">
          <p class="text-stone-300 text-sm">{{ pvpModeConfirmDesc }}</p>
          <div class="bg-[#0c0a09]/60 border border-stone-800 rounded p-3 space-y-1.5 text-xs">
            <div v-for="(effect, idx) in pvpModeConfirmEffects" :key="idx"
              class="flex items-start gap-2"
              :class="effect.type === 'positive' ? 'text-emerald-300' : 'text-amber-300'">
              <span class="shrink-0">{{ effect.type === 'positive' ? '✓' : '✗' }}</span>
              <span class="flex-1">{{ effect.text }}</span>
            </div>
          </div>
        </div>
        <template #footer>
          <button @click="pvpModeConfirmShow = false"
            class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">再思</button>
          <button @click="confirmSwitchPvpMode" :disabled="modeSwitching"
            class="px-4 py-2 text-white rounded text-sm disabled:opacity-50"
            :class="pendingPvpMode === 'recluse'
              ? 'bg-cyan-700 hover:bg-cyan-600'
              : 'bg-emerald-700 hover:bg-emerald-600'">
            {{ modeSwitching ? '切换中...' : '确认' }}
          </button>
        </template>
      </Modal>
    </div>
  </div>
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
import { usePlayerStore } from '../../stores/player'
import { formatTime } from '../../utils/format'
import Modal from '../common/Modal.vue'
import {
  getStatus,
  getLeaderboard,
  executeAction,
  flee,
  setPvpMode
} from '../../api/pvp'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
// 引入 playerStore 用于读取当前玩家ID（PVP 结算时判断胜/败方）
const playerStore = usePlayerStore()

// ====== 响应式状态 ======
const loading = ref(false)
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
 * 攻击方 HP 百分比
 */
const attackerHpPercent = computed(() => {
  if (maxHp.value <= 0) return 0
  return Math.max(0, Math.min(100, (currentAttackerHp.value / maxHp.value) * 100))
})

/**
 * 防守方 HP 百分比
 */
const defenderHpPercent = computed(() => {
  if (maxHp.value <= 0) return 0
  return Math.max(0, Math.min(100, (currentDefenderHp.value / maxHp.value) * 100))
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
const fetchStatus = async () => {
  try {
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
  } catch (err) {
    console.error('获取 PVP 状态失败:', err)
    uiStore.showToast('获取 PVP 状态失败', 'error')
  }
}

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
  loading.value = true
  await Promise.all([fetchStatus(), fetchLeaderboard()])
  loading.value = false
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
    const msg = err?.response?.data?.message || '动作执行失败'
    uiStore.showToast(msg, 'error')
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
    const msg = err?.response?.data?.message || '逃跑失败'
    uiStore.showToast(msg, 'error')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 动作类型中文标签
 */
const actionLabel = (action) => {
  const map = { attack: '攻击', skill: '技能', defend: '防御' }
  return map[action] || action
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
    const msg = err?.response?.data?.message || '切换 PVP 模式失败'
    uiStore.showToast(msg, 'error')
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
  const action = actionLabel(log.action)
  return `${actor}使用${action}`
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

<style scoped>
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
