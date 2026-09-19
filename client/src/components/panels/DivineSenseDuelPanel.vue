<template>
  <!--
    神识对决面板（1v1 同时选择博弈 PvP）
    - 4 Tab：当前对决/发起挑战/对决历史/玩法说明
    - 业务逻辑全部在后端 DivineDuelService 中处理，前端仅展示与接口调用
    - 外壳走 ui/PanelShell，分段导航走 ui/Tabs；二次确认仍用 common/Modal
  -->
  <PanelShell title="神识对决" hint="1v1 同时选择博弈 · 灵识交锋" size="lg" @close="emit('close')">
    <template #header-actions>
      <Badge v-if="activeDuel" tone="success" dot>对决进行中</Badge>
    </template>

    <Tabs :model-value="activeTab" :items="tabItems" class="mb-4" @update:model-value="switchTab" />

    <!-- Tab 1: 当前对决 -->
    <div v-if="activeTab === 'active'">
      <LoadingBlock v-if="loadingActive" text="查询中…" />
      <EmptyState
        v-else-if="!activeDuel"
        text="当前无进行中的神识对决"
        hint="前往「发起挑战」下注一局的灵石或神识"
      >
        <AppButton size="sm" variant="primary" @click="switchTab('challenge')">前往发起挑战</AppButton>
      </EmptyState>
      <div v-else class="space-y-5">
        <!-- 对决基本信息 -->
        <PanelCard tone="gold">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <Badge :tone="statusBadgeTone(activeDuel.status)">{{ statusLabel(activeDuel.status) }}</Badge>
              <span class="text-xs text-fg-faint num">第 {{ activeDuel.round_number }} 回合</span>
            </div>
            <div class="text-xs text-fg-muted">
              赌注：<span class="text-gold-300 font-bold num">{{ activeDuel.bet_amount }}</span>
              <span class="text-fg-faint">{{ activeDuel.bet_type === 'spirit_stone' ? '灵石' : '神识' }}</span>
            </div>
          </div>

          <!-- 双方对决区 -->
          <div class="grid grid-cols-2 gap-3">
            <!-- 发起方 -->
            <div class="bg-surface-sunken border border-line rounded-panel p-3 text-center">
              <div class="text-xs text-fg-faint mb-1">发起方</div>
              <div class="text-sm font-bold text-purple-200 truncate">{{ activeDuel.challenger?.nickname || '未知' }}</div>
              <div class="text-[10px] text-fg-faint mb-2">{{ activeDuel.challenger?.realm_name || `境界 ${activeDuel.challenger?.realm_rank}` }}</div>
              <div class="text-2xl font-bold num" :class="shieldColorClass(activeDuel.challenger_shield)">{{ activeDuel.challenger_shield }}</div>
              <div class="text-[10px] text-fg-faint mt-1">护盾值</div>
            </div>
            <!-- 应战方 -->
            <div class="bg-surface-sunken border border-line rounded-panel p-3 text-center">
              <div class="text-xs text-fg-faint mb-1">应战方</div>
              <div class="text-sm font-bold text-purple-200 truncate">{{ activeDuel.defender?.nickname || '未知' }}</div>
              <div class="text-[10px] text-fg-faint mb-2">{{ activeDuel.defender?.realm_name || `境界 ${activeDuel.defender?.realm_rank}` }}</div>
              <div class="text-2xl font-bold num" :class="shieldColorClass(activeDuel.defender_shield)">{{ activeDuel.defender_shield }}</div>
              <div class="text-[10px] text-fg-faint mt-1">护盾值</div>
            </div>
          </div>
        </PanelCard>

        <!-- 行动状态与操作 -->
        <PanelCard v-if="activeDuel.status === 'ongoing'">
          <div class="text-center mb-3">
            <div v-if="activeDuel.your_action" class="text-sm text-emerald-300">
              你已选择「{{ actionLabel(activeDuel.your_action) }}」，等待对手…
            </div>
            <div v-else class="text-sm text-gold-300">
              请选择本回合行动
            </div>
            <div v-if="activeDuel.action_deadline" class="text-[10px] text-fg-faint mt-1 num">
              行动截止：{{ formatTime(activeDuel.action_deadline) }}
            </div>
          </div>

          <!-- 行动按钮 -->
          <div class="grid grid-cols-2 gap-3">
            <button type="button" @click="openActionConfirm('focus')"
              :disabled="!!activeDuel.your_action || actionLoading"
              :class="['px-4 py-3 rounded-panel font-bold text-sm transition-all border',
                       activeDuel.your_action === 'focus'
                         ? 'bg-rose-900/40 border-rose-500 text-rose-200 cursor-default'
                         : activeDuel.your_action
                           ? 'bg-surface-active border-line text-fg-faint cursor-not-allowed'
                           : 'bg-rose-900/30 border-rose-700/50 text-rose-200 hover:bg-rose-800/50 hover:border-rose-500']">
              <div class="text-base mb-1">凝神</div>
              <div class="text-[10px] opacity-80">攻击试探 · 突破护盾</div>
            </button>
            <button type="button" @click="openActionConfirm('stabilize')"
              :disabled="!!activeDuel.your_action || actionLoading"
              :class="['px-4 py-3 rounded-panel font-bold text-sm transition-all border',
                       activeDuel.your_action === 'stabilize'
                         ? 'bg-cyan-900/40 border-cyan-500 text-cyan-200 cursor-default'
                         : activeDuel.your_action
                           ? 'bg-surface-active border-line text-fg-faint cursor-not-allowed'
                           : 'bg-cyan-900/30 border-cyan-700/50 text-cyan-200 hover:bg-cyan-800/50 hover:border-cyan-500']">
              <div class="text-base mb-1">固元</div>
              <div class="text-[10px] opacity-80">防御恢复 · 反伤对手</div>
            </button>
          </div>

          <!-- 投降按钮 -->
          <div class="mt-4 pt-3 border-t border-line-subtle text-center">
            <AppButton size="xs" variant="ghost" :disabled="actionLoading" @click="surrenderConfirmShow = true">
              认输投降
            </AppButton>
          </div>
        </PanelCard>

        <!-- 等待接受提示 -->
        <PanelCard v-else-if="activeDuel.status === 'pending'" tone="gold">
          <div class="text-center">
            <div class="text-sm text-gold-300 mb-2">挑战已发出，等待对方接受…</div>
            <div v-if="activeDuel.action_deadline" class="text-[10px] text-fg-faint num">
              接受截止：{{ formatTime(activeDuel.action_deadline) }}
            </div>
          </div>
        </PanelCard>

        <!-- 刷新按钮 -->
        <div class="text-center">
          <AppButton size="xs" variant="ghost" @click="loadActiveDuel">刷新状态</AppButton>
        </div>
      </div>
    </div>

    <!-- Tab 2: 发起挑战 -->
    <div v-else-if="activeTab === 'challenge'">
      <div class="max-w-md mx-auto space-y-4">
        <PanelCard>
          <label class="block text-sm text-fg-secondary mb-2">目标玩家 ID</label>
          <input v-model.number="challengeForm.target_player_id" type="number" min="1"
            placeholder="输入对方玩家ID"
            class="num w-full px-3 py-2 bg-surface-sunken border border-line rounded-panel text-fg-primary text-sm focus:border-gold-600 focus:outline-none" />
          <p class="text-[10px] text-fg-faint mt-1">可在排行榜/聊天频道查看对方玩家ID</p>
        </PanelCard>

        <PanelCard title="赌注类型">
          <div class="grid grid-cols-2 gap-2">
            <button type="button" @click="challengeForm.bet_type = 'spirit_stone'"
              :class="['px-3 py-2 rounded-panel text-sm font-bold transition-all border',
                       challengeForm.bet_type === 'spirit_stone'
                         ? 'bg-surface-tint-gold-strong border-gold-500 text-gold-200'
                         : 'bg-surface-sunken border-line text-fg-muted hover:border-line-strong']">
              灵石
            </button>
            <button type="button" @click="challengeForm.bet_type = 'divine_sense'"
              :class="['px-3 py-2 rounded-panel text-sm font-bold transition-all border',
                       challengeForm.bet_type === 'divine_sense'
                         ? 'bg-purple-900/40 border-purple-500 text-purple-200'
                         : 'bg-surface-sunken border-line text-fg-muted hover:border-line-strong']">
              神识
            </button>
          </div>
        </PanelCard>

        <PanelCard>
          <label class="block text-sm text-fg-secondary mb-2">赌注数量</label>
          <input v-model.number="challengeForm.bet_amount" type="number" min="1"
            placeholder="输入赌注数量"
            class="num w-full px-3 py-2 bg-surface-sunken border border-line rounded-panel text-fg-primary text-sm focus:border-gold-600 focus:outline-none" />
          <p class="text-[10px] text-fg-faint mt-1">胜者通吃，请谨慎下注</p>
        </PanelCard>

        <AppButton
          variant="primary"
          block
          :disabled="!canChallenge || challengeLoading"
          @click="openChallengeConfirm"
        >
          {{ challengeLoading ? '发起中…' : '发起挑战' }}
        </AppButton>
      </div>
    </div>

    <!-- Tab 3: 对决历史 -->
    <div v-else-if="activeTab === 'history'">
      <LoadingBlock v-if="historyLoading" />
      <EmptyState v-else-if="!history.length" text="暂无对决记录" hint="到「发起挑战」约一位道友试试手" />
      <div v-else class="space-y-3">
        <PanelCard v-for="duel in history" :key="duel.duel_id" :padded="true">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <Badge :tone="resultBadgeTone(duel)">{{ resultLabel(duel) }}</Badge>
              <span class="text-xs text-fg-faint num">#{{ duel.duel_id }}</span>
            </div>
            <div class="text-[10px] text-fg-faint num">{{ formatTime(duel.finished_at || duel.created_at) }}</div>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="text-fg-secondary">
              <span class="text-fg-faint">发起：</span>{{ duel.challenger?.nickname || '未知' }}
            </div>
            <div class="text-fg-secondary">
              <span class="text-fg-faint">应战：</span>{{ duel.defender?.nickname || '未知' }}
            </div>
          </div>
          <div class="flex items-center justify-between mt-2 text-[11px] text-fg-faint">
            <div class="num">第 {{ duel.round_number }} 回合 · {{ settleReasonLabel(duel.settle_reason) }}</div>
            <div>
              赌注：<span class="text-gold-300 num">{{ duel.bet_amount }}</span>
              {{ duel.bet_type === 'spirit_stone' ? '灵石' : '神识' }}
            </div>
          </div>
        </PanelCard>

        <!-- 分页 -->
        <div v-if="historyTotal > historyPageSize" class="flex items-center justify-center gap-2 pt-2">
          <AppButton size="xs" variant="default" :disabled="historyPage <= 1" @click="changeHistoryPage(historyPage - 1)">
            上一页
          </AppButton>
          <span class="text-xs text-fg-faint num">{{ historyPage }} / {{ Math.ceil(historyTotal / historyPageSize) }}</span>
          <AppButton
            size="xs"
            variant="default"
            :disabled="historyPage * historyPageSize >= historyTotal"
            @click="changeHistoryPage(historyPage + 1)"
          >
            下一页
          </AppButton>
        </div>
      </div>
    </div>

    <!-- Tab 4: 玩法说明 -->
    <div v-else-if="activeTab === 'guide'" class="space-y-4 text-sm text-fg-secondary">
      <PanelCard title="玩法简介" tone="gold">
        <p class="text-xs text-fg-muted leading-relaxed">神识对决是 1v1 同时选择博弈 PvP。双方同时选择「凝神」或「固元」，互不知晓对方选择，结算后造成对应效果。先使对方护盾归零者胜，或在回合上限（默认 10 回合）后按护盾多寡判定。</p>
      </PanelCard>

      <PanelCard title="行动效果矩阵">
        <div class="space-y-2 text-xs">
          <div class="flex items-start gap-2">
            <span class="text-rose-300 font-bold shrink-0">凝神 vs 固元</span>
            <span class="text-fg-muted">凝神方占优，造成 <span class="num">30</span> 点伤害（固元方减伤至 <span class="num">15</span>）</span>
          </div>
          <div class="flex items-start gap-2">
            <span class="text-gold-300 font-bold shrink-0">凝神 vs 凝神</span>
            <span class="text-fg-muted">双方互相试探，各造成 <span class="num">20</span> 点伤害</span>
          </div>
          <div class="flex items-start gap-2">
            <span class="text-emerald-300 font-bold shrink-0">固元 vs 固元</span>
            <span class="text-fg-muted">双方和平互守，各恢复 <span class="num">10</span> 点护盾</span>
          </div>
          <div class="flex items-start gap-2">
            <span class="text-cyan-300 font-bold shrink-0">固元 vs 凝神</span>
            <span class="text-fg-muted">固元方承受 <span class="num">30</span> 点伤害（被克制）</span>
          </div>
        </div>
      </PanelCard>

      <PanelCard title="赌注机制">
        <ul class="text-xs text-fg-muted space-y-1 list-disc list-inside">
          <li>赌注类型：灵石 或 神识</li>
          <li>胜者通吃：胜方获得全部赌注，败方失去赌注</li>
          <li>平局返还：双方各自返还赌注</li>
          <li>投降结算：投降方失去全部赌注，对手获得</li>
        </ul>
      </PanelCard>

      <PanelCard title="超时机制">
        <ul class="text-xs text-fg-muted space-y-1 list-disc list-inside">
          <li>挑战发出后对方需在限定时间内接受，超时自动取消</li>
          <li>每回合行动有截止时间，超时自动选择「固元」</li>
          <li>建议在双方都活跃时进行对决</li>
        </ul>
      </PanelCard>

      <PanelCard title="策略提示">
        <ul class="text-xs text-fg-muted space-y-1 list-disc list-inside">
          <li>凝神是主动攻击，但被固元克制时效果减半</li>
          <li>固元是稳妥防御，但被凝神命中承受高额伤害</li>
          <li>残血时固元可恢复护盾，但若对手凝神则雪上加霜</li>
          <li>心理博弈：观察对手行动模式，预判其下一步</li>
        </ul>
      </PanelCard>
    </div>

    <!-- ===== Modal: 挑战确认 ===== -->
    <Modal :isOpen="challengeConfirmShow" title="确认发起挑战" width="460px" @close="challengeConfirmShow = false">
      <div class="space-y-3 text-sm">
        <div class="bg-surface-raised rounded-panel p-3 space-y-2">
          <div class="flex justify-between"><span class="text-fg-muted">目标玩家ID：</span><span class="text-fg-primary font-bold num">{{ challengeForm.target_player_id }}</span></div>
          <div class="flex justify-between"><span class="text-fg-muted">赌注类型：</span><span class="text-fg-primary font-bold">{{ challengeForm.bet_type === 'spirit_stone' ? '灵石' : '神识' }}</span></div>
          <div class="flex justify-between"><span class="text-fg-muted">赌注数量：</span><span class="text-gold-300 font-bold num">{{ challengeForm.bet_amount }}</span></div>
        </div>
        <div class="text-xs text-rose-300 bg-rose-950/30 border border-rose-900/40 rounded-control p-2">
          高风险操作：对方接受后即开始对决，败者将失去赌注。
        </div>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="challengeConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="primary" :disabled="challengeLoading" @click="executeChallenge">
          {{ challengeLoading ? '处理中…' : '确认发起' }}
        </AppButton>
      </template>
    </Modal>

    <!-- ===== Modal: 行动确认 ===== -->
    <Modal :isOpen="actionConfirmShow" :title="`确认${pendingAction === 'focus' ? '凝神' : '固元'}`" width="420px" @close="actionConfirmShow = false">
      <div class="space-y-3 text-sm">
        <p class="text-fg-secondary">即将执行「{{ pendingAction === 'focus' ? '凝神' : '固元' }}」行动：</p>
        <div v-if="pendingAction === 'focus'" class="text-xs text-rose-300 bg-rose-950/30 border border-rose-900/40 rounded-control p-2">
          凝神：主动攻击，若对手固元则造成 30 伤害，对手凝神则双方互伤 20
        </div>
        <div v-else class="text-xs text-cyan-300 bg-cyan-950/30 border border-cyan-900/40 rounded-control p-2">
          固元：防御恢复，若对手固元则双方各回 10 护盾，对手凝神则承受 30 伤害
        </div>
        <p class="text-[11px] text-fg-faint">提交后无法更改，需等待对手行动或回合结算</p>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="actionConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="primary" :disabled="actionLoading" @click="executeAction">
          {{ actionLoading ? '提交中…' : '确认行动' }}
        </AppButton>
      </template>
    </Modal>

    <!-- ===== Modal: 行动结果 ===== -->
    <Modal :isOpen="actionResultShow" title="回合结算" width="520px" @close="actionResultShow = false">
      <div v-if="lastActionResult" class="space-y-3 text-sm">
        <!-- 结算信息 -->
        <div class="bg-surface-raised rounded-panel p-3">
          <div class="text-center text-xs text-fg-faint mb-2 num">第 {{ lastActionResult.round_number }} 回合</div>
          <div class="grid grid-cols-2 gap-3">
            <div class="text-center">
              <div class="text-[10px] text-fg-faint">发起方行动</div>
              <div class="text-base font-bold" :class="lastActionResult.challenger_action === 'focus' ? 'text-rose-300' : 'text-cyan-300'">
                {{ actionLabel(lastActionResult.challenger_action) }}
              </div>
            </div>
            <div class="text-center">
              <div class="text-[10px] text-fg-faint">应战方行动</div>
              <div class="text-base font-bold" :class="lastActionResult.defender_action === 'focus' ? 'text-rose-300' : 'text-cyan-300'">
                {{ actionLabel(lastActionResult.defender_action) }}
              </div>
            </div>
          </div>
        </div>

        <!-- 护盾变化 -->
        <div class="bg-surface-raised rounded-panel p-3 space-y-2">
          <div class="flex justify-between text-xs">
            <span class="text-fg-muted">发起方护盾变化：</span>
            <span class="num" :class="lastActionResult.challenger_shield_change >= 0 ? 'text-emerald-300' : 'text-rose-300'">
              {{ lastActionResult.challenger_shield_change >= 0 ? '+' : '' }}{{ lastActionResult.challenger_shield_change }} → {{ lastActionResult.challenger_shield }}
            </span>
          </div>
          <div class="flex justify-between text-xs">
            <span class="text-fg-muted">应战方护盾变化：</span>
            <span class="num" :class="lastActionResult.defender_shield_change >= 0 ? 'text-emerald-300' : 'text-rose-300'">
              {{ lastActionResult.defender_shield_change >= 0 ? '+' : '' }}{{ lastActionResult.defender_shield_change }} → {{ lastActionResult.defender_shield }}
            </span>
          </div>
        </div>

        <!-- 对局结果 -->
        <div v-if="lastActionResult.duel_finished" class="bg-surface-tint-gold border border-gold-700/60 rounded-panel p-3 text-center">
          <div class="text-gold-300 font-bold">对局结束</div>
          <div class="text-xs text-fg-muted mt-1">{{ settleReasonLabel(lastActionResult.settle_reason) }}</div>
          <div v-if="lastActionResult.bet_settlement" class="text-xs text-gold-300 mt-2 num">
            赌注结算：胜方 +{{ lastActionResult.bet_settlement.winner_gain }} / 败方 -{{ lastActionResult.bet_settlement.loser_loss }}
          </div>
        </div>
        <div v-else class="text-center text-xs text-fg-faint num">
          进入第 {{ lastActionResult.next_round }} 回合
        </div>
      </div>
      <template #footer>
        <AppButton size="sm" variant="primary" @click="actionResultShow = false">确认</AppButton>
      </template>
    </Modal>

    <!-- ===== Modal: 投降确认 ===== -->
    <Modal :isOpen="surrenderConfirmShow" title="投降确认" width="420px" @close="surrenderConfirmShow = false">
      <div class="space-y-3 text-sm">
        <p class="text-rose-300">投降将立即结束对局，你将失去全部赌注，对手获得赌注。</p>
        <p class="text-[11px] text-fg-faint">建议在护盾明显劣势且无翻盘可能时使用。</p>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="surrenderConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="danger" :disabled="actionLoading" @click="executeSurrender">
          {{ actionLoading ? '处理中…' : '确认投降' }}
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup>
/**
 * 神识对决面板逻辑
 *
 * 设计原则：后端计算，前端只渲染与接口调用
 *  - 不在前端计算行动效果/护盾变化/胜负判定，全部以后端返回为准
 *  - 状态变更后调用 loadActiveDuel 刷新权威数据
 *  - 所有操作均通过自定义 Modal 二次确认
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import PanelCard from '../ui/PanelCard.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import { useUIStore } from '../../stores/ui'
import {
  challengeDuel,
  acceptDuel,
  performDuelAction,
  getActiveDuel,
  getDuelHistory,
  surrenderDuel
} from '../../api/divineSenseDuel'

// 运行时声明 emit（项目 <script setup> 未启用 lang="ts"，不可使用 TS 泛型语法）
const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ===== Tab 管理（key/label 契约见 ui/Tabs.vue）=====
const tabItems = [
  { key: 'active', label: '当前对决' },
  { key: 'challenge', label: '发起挑战' },
  { key: 'history', label: '对决历史' },
  { key: 'guide', label: '玩法说明' }
]
const activeTab = ref('active')

// ===== 当前对决状态 =====
const activeDuel = ref(null)
const loadingActive = ref(false)

// ===== 发起挑战表单 =====
const challengeForm = ref({
  target_player_id: null,
  bet_type: 'spirit_stone',
  bet_amount: 100
})
const challengeLoading = ref(false)
const challengeConfirmShow = ref(false)

// ===== 行动相关 =====
const pendingAction = ref(null) // 'focus' | 'stabilize'
const actionConfirmShow = ref(false)
const actionLoading = ref(false)
const actionResultShow = ref(false)
const lastActionResult = ref(null)

// ===== 投降 =====
const surrenderConfirmShow = ref(false)

// ===== 历史记录 =====
const history = ref([])
const historyLoading = ref(false)
const historyPage = ref(1)
const historyPageSize = 10
const historyTotal = ref(0)

// ===== 自动刷新定时器 =====
let refreshTimer = null

// ===== 计算属性 =====
const canChallenge = computed(() => {
  const f = challengeForm.value
  return Number.isInteger(f.target_player_id) && f.target_player_id > 0
    && (f.bet_type === 'spirit_stone' || f.bet_type === 'divine_sense')
    && Number.isInteger(f.bet_amount) && f.bet_amount > 0
})

// ===== 工具方法 =====
/** 状态徽章色（tone 取值见 ui/Badge.vue） */
function statusBadgeTone(status) {
  const map = {
    pending: 'gold',
    ongoing: 'success',
    finished: 'muted',
    cancelled: 'muted',
    expired: 'muted'
  }
  return map[status] || 'neutral'
}
function statusLabel(status) {
  const map = { pending: '待接受', ongoing: '进行中', finished: '已结束', cancelled: '已取消', expired: '已过期' }
  return map[status] || status
}
/** 行动中文名 */
function actionLabel(action) {
  return action === 'focus' ? '凝神' : action === 'stabilize' ? '固元' : '未知'
}
/** 护盾值颜色 */
function shieldColorClass(shield) {
  if (shield <= 0) return 'text-rose-400'
  if (shield < 30) return 'text-gold-400'
  return 'text-emerald-400'
}
/** 历史结果徽章色 */
function resultBadgeTone(duel) {
  if (duel.is_draw) return 'muted'
  return duel.is_winner ? 'success' : 'danger'
}
function resultLabel(duel) {
  if (duel.status !== 'finished') return statusLabel(duel.status)
  if (duel.is_draw) return '平局'
  return duel.is_winner ? '胜利' : '失败'
}
function settleReasonLabel(reason) {
  const map = {
    shield_zero: '护盾归零',
    rounds_limit: '回合上限',
    surrender: '投降',
    timeout: '超时',
    cancel: '取消'
  }
  return map[reason] || reason || '未知'
}
function formatTime(isoStr) {
  if (!isoStr) return '-'
  try {
    const d = new Date(isoStr)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return isoStr
  }
}

// ===== 业务方法 =====
/** 切换 Tab，按需加载数据 */
function switchTab(tabId) {
  activeTab.value = tabId
  if (tabId === 'active') loadActiveDuel()
  else if (tabId === 'history') loadHistory()
}

/** 加载当前进行中的对决 */
async function loadActiveDuel() {
  loadingActive.value = true
  try {
    const res = await getActiveDuel()
    const payload = res.data
    if (payload.code === 200) {
      activeDuel.value = payload.data
    } else {
      uiStore.showToast(payload.message || '查询对决状态失败', 'warning')
    }
  } catch (err) {
    uiStore.showApiError(err, '查询对决状态失败')
  } finally {
    loadingActive.value = false
  }
}

/** 打开发起挑战确认弹窗 */
function openChallengeConfirm() {
  if (!canChallenge.value) {
    uiStore.showToast('请填写完整的挑战参数', 'warning')
    return
  }
  challengeConfirmShow.value = true
}

/** 执行发起挑战 */
async function executeChallenge() {
  challengeLoading.value = true
  try {
    const f = challengeForm.value
    const res = await challengeDuel(f.target_player_id, f.bet_type, f.bet_amount)
    const payload = res.data
    challengeConfirmShow.value = false
    if (payload.code === 200 && payload.data) {
      uiStore.showToast('挑战已发出，等待对方接受', 'success')
      activeTab.value = 'active'
      await loadActiveDuel()
    } else {
      uiStore.showToast(payload.message || '发起挑战失败', 'error')
    }
  } catch (err) {
    uiStore.showApiError(err, '发起挑战失败')
  } finally {
    challengeLoading.value = false
  }
}

/** 打开行动确认弹窗 */
function openActionConfirm(action) {
  if (!activeDuel.value || activeDuel.value.your_action) return
  pendingAction.value = action
  actionConfirmShow.value = true
}

/** 执行行动 */
async function executeAction() {
  if (!pendingAction.value || !activeDuel.value) return
  actionLoading.value = true
  try {
    const res = await performDuelAction(activeDuel.value.duel_id, pendingAction.value)
    const payload = res.data
    actionConfirmShow.value = false
    if (payload.code === 200 && payload.data) {
      const data = payload.data
      if (data.waiting_opponent) {
        uiStore.showToast(`已选择${actionLabel(data.your_action)}，等待对手行动`, 'success')
      } else {
        // 已结算，展示结果
        lastActionResult.value = data
        actionResultShow.value = true
      }
      await loadActiveDuel()
    } else {
      uiStore.showToast(payload.message || '行动失败', 'error')
    }
  } catch (err) {
    uiStore.showApiError(err, '行动失败')
  } finally {
    actionLoading.value = false
    pendingAction.value = null
  }
}

/** 执行投降 */
async function executeSurrender() {
  if (!activeDuel.value) return
  actionLoading.value = true
  try {
    const res = await surrenderDuel(activeDuel.value.duel_id)
    const payload = res.data
    surrenderConfirmShow.value = false
    if (payload.code === 200) {
      uiStore.showToast('已投降，对局结束', 'warning')
      await loadActiveDuel()
    } else {
      uiStore.showToast(payload.message || '投降失败', 'error')
    }
  } catch (err) {
    uiStore.showApiError(err, '投降失败')
  } finally {
    actionLoading.value = false
  }
}

/** 加载历史记录 */
async function loadHistory() {
  historyLoading.value = true
  try {
    const res = await getDuelHistory(historyPage.value, historyPageSize)
    const payload = res.data
    if (payload.code === 200 && payload.data) {
      history.value = payload.data.duels || []
      historyTotal.value = payload.data.total || 0
    } else {
      uiStore.showToast(payload.message || '加载历史失败', 'warning')
    }
  } catch (err) {
    uiStore.showApiError(err, '加载历史失败')
  } finally {
    historyLoading.value = false
  }
}

/** 翻页 */
function changeHistoryPage(newPage) {
  if (newPage < 1 || newPage * historyPageSize >= historyTotal.value + historyPageSize) return
  historyPage.value = newPage
  loadHistory()
}

// ===== 生命周期 =====
onMounted(() => {
  loadActiveDuel()
  // 每 10 秒自动刷新当前对决状态（避免错过对手行动）
  refreshTimer = setInterval(() => {
    if (activeTab.value === 'active' && activeDuel.value && activeDuel.value.status === 'ongoing') {
      loadActiveDuel()
    }
  }, 10000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>
