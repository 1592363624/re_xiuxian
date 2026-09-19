<!--
 * 悬赏追杀面板组件
 *
 * 弹窗式组件，展示悬赏榜单、我的悬赏、发布悬赏、接取/取消悬赏。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 二次确认使用 common/Modal，外壳与分段导航走 ui/PanelShell + ui/Tabs
 *   - 颜色风格：悬赏用鎏金系（gold-*），区分于斗法的血光系
 *
 * Tab 结构：
 *   1. 悬赏榜单：分页浏览所有悬赏，可接取 active 状态悬赏
 *   2. 我的悬赏：查看我发布的 + 我接取的悬赏
 *   3. 发布悬赏：填写目标ID + 金额 + 理由，发布新悬赏
 *
 * 数据来源：
 *   - getBountyList()：悬赏榜单分页查询
 *   - getMyBounties()：我的悬赏（发布 + 接取）
 *   - publishBounty()：发布悬赏
 *   - acceptBounty()：接取悬赏（自动发起 PVP 战斗）
 *   - cancelBounty()：取消悬赏（退灵石扣手续费）
-->
<template>
  <PanelShell title="悬赏追杀榜" hint="发布 · 接取 · 反悬赏" size="xl" @close="$emit('close')">
    <!-- Tab 切换栏（切换时按需加载，见下方 watch(activeTab)） -->
    <Tabs v-model="activeTab" :items="tabItems" class="mb-4" />

    <!-- ===== Tab 1: 悬赏榜单 ===== -->
    <div v-if="activeTab === 'list'">
      <!-- 状态过滤 -->
      <div class="flex items-center gap-2 mb-3">
        <span class="text-xs text-fg-muted">状态筛选：</span>
        <button
          v-for="s in statusFilters"
          :key="s.value"
          type="button"
          @click="filterStatus = s.value; loadList(1)"
          :class="filterStatus === s.value
            ? 'bg-surface-tint-gold-strong text-gold-300 border-gold-700/60'
            : 'bg-surface-hover text-fg-muted border-line hover:text-fg-primary'"
          class="focus-ring px-2 py-1 text-xs rounded-control border transition-colors"
        >
          {{ s.label }}
        </button>
      </div>

      <!-- 加载中 -->
      <LoadingBlock v-if="listLoading" text="正在查阅悬赏榜…" />

      <!-- 空状态 -->
      <EmptyState
        v-else-if="bountyList.length === 0"
        text="悬赏榜空空如也"
        hint="前往「发布悬赏」页签立下追杀令"
      />

      <!-- 悬赏列表 -->
      <div v-else class="space-y-2">
        <div
          v-for="bounty in bountyList"
          :key="bounty.bounty_id"
          class="bg-surface-hover border border-line rounded-panel p-3 hover:border-gold-700/50 transition-colors"
        >
          <div class="flex items-center justify-between gap-3">
            <!-- 左侧：目标 + 发布者信息 -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <Badge :tone="statusBadgeTone(bounty.status)">{{ statusLabel(bounty.status) }}</Badge>
                <span class="text-sm font-bold text-gold-300 truncate">
                  悬赏 {{ bounty.target?.nickname || '未知' }}
                </span>
              </div>
              <div class="text-xs text-fg-muted truncate">
                发布者：{{ bounty.publisher?.nickname || '未知' }}
                <span v-if="bounty.acceptor"> · 接单：{{ bounty.acceptor.nickname }}</span>
              </div>
              <div v-if="bounty.reason" class="text-xs text-fg-faint mt-1 italic truncate">
                "{{ bounty.reason }}"
              </div>
            </div>
            <!-- 右侧：金额 + 操作 -->
            <div class="flex flex-col items-end gap-1 shrink-0">
              <div class="text-gold-400 font-bold text-lg num">{{ formatCompact(bounty.bounty_amount) }}</div>
              <div class="text-xs text-fg-faint">灵石</div>
              <!-- 接取按钮（仅 active 状态且不是自己发布/目标的可接取） -->
              <AppButton
                v-if="bounty.status === 'active' && canAccept(bounty)"
                size="xs"
                variant="primary"
                :disabled="actionLoading"
                @click="handleAccept(bounty)"
              >
                {{ actionLoading ? '接取中…' : '接取' }}
              </AppButton>
            </div>
          </div>
          <!-- 过期时间 -->
          <div class="text-xs text-fg-faint mt-1">
            {{ bounty.status === 'active' ? '过期' : '创建' }}：<span class="num">{{ formatTime(bounty[bounty.status === 'active' ? 'expire_at' : 'created_at']) }}</span>
          </div>
        </div>

        <!-- 分页 -->
        <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 pt-2">
          <AppButton size="xs" variant="default" :disabled="currentPage <= 1" @click="loadList(currentPage - 1)">
            上一页
          </AppButton>
          <span class="text-xs text-fg-muted num">{{ currentPage }} / {{ totalPages }}</span>
          <AppButton size="xs" variant="default" :disabled="currentPage >= totalPages" @click="loadList(currentPage + 1)">
            下一页
          </AppButton>
        </div>
      </div>
    </div>

    <!-- ===== Tab 2: 我的悬赏 ===== -->
    <div v-else-if="activeTab === 'my'">
      <LoadingBlock v-if="myLoading" text="正在查阅我的悬赏…" />
      <EmptyState
        v-else-if="myBounties.published.length === 0 && myBounties.accepted.length === 0 && (myBounties.targeting_me || []).length === 0"
        text="你还没有任何悬赏记录"
        hint="发布一纸追杀令，或到榜单接单取灵石"
      />
      <div v-else class="space-y-4">
        <!-- 我发布的 -->
        <div v-if="myBounties.published.length > 0">
          <h3 class="text-sm font-bold text-gold-400 mb-2 font-display">我发布的悬赏</h3>
          <div class="space-y-2">
            <div
              v-for="bounty in myBounties.published"
              :key="bounty.bounty_id"
              class="bg-surface-hover border border-line rounded-panel p-3"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <Badge :tone="statusBadgeTone(bounty.status)">{{ statusLabel(bounty.status) }}</Badge>
                    <span class="text-sm font-bold text-fg-primary">悬赏 {{ bounty.target?.nickname || '未知' }}</span>
                  </div>
                  <div class="text-xs text-fg-muted">
                    金额：<span class="num">{{ formatCompact(bounty.bounty_amount) }}</span> 灵石
                    <span v-if="bounty.acceptor"> · 接单者：{{ bounty.acceptor.nickname }}</span>
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="text-gold-400 font-bold num">{{ formatCompact(bounty.bounty_amount) }}</span>
                  <AppButton
                    v-if="bounty.status === 'active'"
                    size="xs"
                    variant="danger"
                    :disabled="actionLoading"
                    @click="handleCancel(bounty)"
                  >
                    取消
                  </AppButton>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 我接取的 -->
        <div v-if="myBounties.accepted.length > 0">
          <h3 class="text-sm font-bold text-gold-400 mb-2 font-display">我接取的悬赏</h3>
          <div class="space-y-2">
            <div
              v-for="bounty in myBounties.accepted"
              :key="bounty.bounty_id"
              class="bg-surface-hover border border-line rounded-panel p-3"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <Badge :tone="statusBadgeTone(bounty.status)">{{ statusLabel(bounty.status) }}</Badge>
                    <span class="text-sm font-bold text-fg-primary">追杀 {{ bounty.target?.nickname || '未知' }}</span>
                  </div>
                  <div class="text-xs text-fg-muted">
                    发布者：{{ bounty.publisher?.nickname || '未知' }}
                    · 金额：<span class="num">{{ formatCompact(bounty.bounty_amount) }}</span> 灵石
                  </div>
                </div>
                <span class="text-gold-400 font-bold shrink-0 num">{{ formatCompact(bounty.bounty_amount) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 针对我的悬赏（我是 target，可反悬赏） -->
        <div v-if="(myBounties.targeting_me || []).length > 0">
          <h3 class="text-sm font-bold text-state-danger mb-2 flex items-center gap-1 font-display">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            针对我的悬赏
          </h3>
          <div class="bg-rose-950/20 border border-state-danger/30 rounded-panel p-2 mb-2 text-xs text-rose-300/80">
            你正被悬赏追杀，可选择接单者来应战，或花费灵石发起反悬赏反击悬赏者
          </div>
          <div class="space-y-2">
            <div
              v-for="bounty in myBounties.targeting_me"
              :key="bounty.bounty_id"
              class="bg-surface-hover border border-state-danger/40 rounded-panel p-3"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <Badge :tone="statusBadgeTone(bounty.status)">{{ statusLabel(bounty.status) }}</Badge>
                    <span class="text-sm font-bold text-rose-300">被 {{ bounty.publisher?.nickname || '未知' }} 悬赏</span>
                  </div>
                  <div class="text-xs text-fg-muted">
                    金额：<span class="num">{{ formatCompact(bounty.bounty_amount) }}</span> 灵石
                    <span v-if="bounty.acceptor"> · 接单者：{{ bounty.acceptor.nickname }}</span>
                  </div>
                  <div v-if="bounty.reason" class="text-xs text-fg-faint mt-1 italic truncate">
                    "{{ bounty.reason }}"
                  </div>
                </div>
                <div class="flex flex-col items-end gap-1 shrink-0">
                  <span class="text-state-danger font-bold num">{{ formatCompact(bounty.bounty_amount) }}</span>
                  <!-- 反悬赏按钮（仅 active 状态可反悬赏，accepted 状态战斗进行中也可反悬赏） -->
                  <AppButton
                    v-if="bounty.status === 'active' || bounty.status === 'accepted'"
                    size="xs"
                    variant="default"
                    :disabled="actionLoading"
                    @click="handleCounter(bounty)"
                  >
                    反悬赏
                  </AppButton>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== Tab 3: 发布悬赏 ===== -->
    <div v-else-if="activeTab === 'publish'">
      <div class="space-y-4">
        <!-- 说明 -->
        <PanelCard tone="gold">
          <p class="mb-1">发布悬赏需消耗灵石（悬赏金额 + 平台手续费 {{ feeRateText }}）</p>
          <p class="mb-1">悬赏金额范围：<span class="num">{{ formatCompact(minAmount) }}</span> ~ <span class="num">{{ formatCompact(maxAmount) }}</span> 灵石</p>
          <p>目标必须为入世状态（避世者不可被悬赏），悬赏 <span class="num">{{ expireHours }}</span> 小时内无人接取则全额退还</p>
        </PanelCard>

        <!-- 表单 -->
        <div class="space-y-3">
          <div>
            <label class="text-sm text-fg-secondary mb-1 block">目标玩家 ID</label>
            <input
              v-model.number="publishForm.target_id"
              type="number"
              placeholder="输入目标玩家的数字 ID"
              class="w-full bg-surface-hover border border-line rounded-panel px-3 py-2 text-fg-primary text-sm focus:border-gold-600 focus:outline-none"
            />
            <p class="text-xs text-fg-faint mt-1">可在「斗法场」或「排行榜」中查看玩家 ID</p>
          </div>

          <div>
            <label class="text-sm text-fg-secondary mb-1 block">悬赏金额（灵石）</label>
            <input
              v-model.number="publishForm.amount"
              type="number"
              :min="minAmount"
              :max="maxAmount"
              :placeholder="`输入 ${minAmount} ~ ${maxAmount} 之间的金额`"
              class="w-full bg-surface-hover border border-line rounded-panel px-3 py-2 text-fg-primary text-sm num focus:border-gold-600 focus:outline-none"
            />
            <p v-if="publishForm.amount > 0" class="text-xs text-gold-400 mt-1">
              总消耗：<span class="num">{{ totalCost }}</span> 灵石（含手续费 <span class="num">{{ feeAmount }}</span>）
            </p>
          </div>

          <div>
            <label class="text-sm text-fg-secondary mb-1 block">悬赏理由（可选，最多 200 字）</label>
            <textarea
              v-model="publishForm.reason"
              rows="3"
              maxlength="200"
              placeholder="填写悬赏理由，让接单者了解追杀缘由…"
              class="w-full bg-surface-hover border border-line rounded-panel px-3 py-2 text-fg-primary text-sm focus:border-gold-600 focus:outline-none resize-none"
            ></textarea>
          </div>

          <!-- 发布按钮 -->
          <AppButton
            variant="primary"
            block
            :disabled="actionLoading || !publishForm.target_id || !publishForm.amount"
            @click="handlePublish"
          >
            {{ actionLoading ? '发布中…' : '发布悬赏' }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 接取确认弹窗 -->
    <Modal :isOpen="acceptConfirmShow" title="接取悬赏" @close="acceptConfirmShow = false">
      <div class="space-y-2 text-sm text-fg-secondary">
        <p>确认接取此悬赏？接取后将自动发起与目标的斗法战斗。</p>
        <div v-if="pendingBounty" class="bg-surface-hover border border-line rounded-panel p-3 mt-2">
          <div>目标：<span class="text-gold-300 font-bold">{{ pendingBounty.target?.nickname }}</span></div>
          <div>悬赏金额：<span class="text-gold-400 font-bold num">{{ formatCompact(pendingBounty.bounty_amount) }}</span> 灵石</div>
        </div>
        <p class="text-xs text-rose-400/80 mt-2">接取后进入 PVP 战斗，失败将进入虚弱状态</p>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="acceptConfirmShow = false">取消</AppButton>
        <AppButton size="sm" variant="primary" @click="confirmAccept">确认接取</AppButton>
      </template>
    </Modal>

    <!-- 取消确认弹窗 -->
    <Modal :isOpen="cancelConfirmShow" title="取消悬赏" @close="cancelConfirmShow = false">
      <div class="space-y-2 text-sm text-fg-secondary">
        <p>确认取消此悬赏？取消将扣除手续费，仅退还部分灵石。</p>
        <div v-if="pendingCancel" class="bg-surface-hover border border-line rounded-panel p-3 mt-2">
          <div>目标：<span class="text-fg-primary">{{ pendingCancel.target?.nickname }}</span></div>
          <div>悬赏金额：<span class="text-gold-400 num">{{ formatCompact(pendingCancel.bounty_amount) }}</span> 灵石</div>
          <div class="text-xs text-fg-muted mt-1">退还约 <span class="num">{{ Math.floor(pendingCancel.bounty_amount * (1 - feeRate)) }}</span> 灵石（扣 <span class="num">{{ Math.ceil(pendingCancel.bounty_amount * feeRate) }}</span> 手续费）</div>
        </div>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="cancelConfirmShow = false">保留</AppButton>
        <AppButton size="sm" variant="danger" @click="confirmCancel">确认取消</AppButton>
      </template>
    </Modal>

    <!-- 反悬赏确认弹窗 -->
    <Modal :isOpen="counterConfirmShow" title="发起反悬赏" width="480px" @close="counterConfirmShow = false">
      <div class="space-y-3 text-sm text-fg-secondary">
        <p>确认对悬赏者发起反悬赏？反悬赏将创建一个针对原悬赏者的新悬赏。</p>
        <div v-if="pendingCounter" class="bg-surface-hover border border-state-arcane/40 rounded-panel p-3 space-y-1.5">
          <div>原悬赏者：<span class="text-purple-300 font-bold">{{ pendingCounter.publisher?.nickname }}</span></div>
          <div>原悬赏金额：<span class="text-fg-primary num">{{ formatCompact(pendingCounter.bounty_amount) }}</span> 灵石</div>
          <div class="pt-1 border-t border-line">
            反悬赏金额：<span class="text-purple-300 font-bold num">{{ formatCompact(counterPreviewAmount) }}</span> 灵石
            <span class="text-xs text-fg-faint num">（原金额 × {{ COUNTER_MULTIPLIER }}）</span>
          </div>
          <div class="text-xs text-gold-400">总消耗：<span class="num">{{ formatCompact(counterPreviewCost) }}</span> 灵石（含手续费）</div>
        </div>
        <div>
          <label class="text-xs text-fg-muted mb-1 block">反悬赏理由（可选，最多 180 字）</label>
          <textarea
            v-model="counterReason"
            rows="2"
            maxlength="180"
            placeholder="填写反悬赏理由…"
            class="w-full bg-surface-hover border border-line rounded-panel px-3 py-2 text-fg-primary text-sm focus:border-state-arcane/60 focus:outline-none resize-none"
          ></textarea>
        </div>
        <p class="text-xs text-purple-400/80">反悬赏链上限 <span class="num">3</span> 次，超出将无法继续反悬赏</p>
      </div>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="counterConfirmShow = false">再思</AppButton>
        <AppButton size="sm" variant="primary" :disabled="actionLoading" @click="confirmCounter">
          {{ actionLoading ? '发布中…' : '确认反悬赏' }}
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup>
/**
 * 悬赏追杀面板组件
 *
 * 功能模块：
 *   1. 悬赏榜单：分页浏览 + 状态过滤 + 接取悬赏
 *   2. 我的悬赏：查看我发布的 + 我接取的，可取消 active 悬赏
 *   3. 发布悬赏：填写目标 ID + 金额 + 理由
 *
 * 所有数据通过 api/bounty 模块调用后端，前端只做展示与接口调用。
 */
import { ref, computed, onMounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { formatCompact } from '../../utils/format'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import PanelCard from '../ui/PanelCard.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import {
  getBountyList,
  getMyBounties,
  publishBounty,
  acceptBounty,
  cancelBounty,
  counterBounty
} from '../../api/bounty'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

// ====== Tab 配置（key/label 契约见 ui/Tabs.vue）======
const tabItems = [
  { key: 'list', label: '悬赏榜单' },
  { key: 'my', label: '我的悬赏' },
  { key: 'publish', label: '发布悬赏' }
]
const activeTab = ref('list')

// ====== 状态过滤 ======
const statusFilters = [
  { value: '', label: '全部' },
  { value: 'active', label: '悬赏中' },
  { value: 'accepted', label: '已接取' },
  { value: 'completed', label: '已完成' }
]
const filterStatus = ref('')

// ====== 悬赏列表 ======
const listLoading = ref(false)
const bountyList = ref([])
const currentPage = ref(1)
const totalPages = ref(1)
const pageSize = 20

// ====== 我的悬赏 ======
const myLoading = ref(false)
const myBounties = ref({ published: [], accepted: [], targeting_me: [] })

// ====== 发布表单 ======
// 悬赏配置（从后端返回的数据中提取，这里用默认值兜底）
const minAmount = 100
const maxAmount = 100000
const feeRate = 0.05
const expireHours = 72
const publishForm = ref({
  target_id: null,
  amount: null,
  reason: ''
})

// ====== 操作状态 ======
const actionLoading = ref(false)

// ====== 确认弹窗 ======
const acceptConfirmShow = ref(false)
const pendingBounty = ref(null)
const cancelConfirmShow = ref(false)
const pendingCancel = ref(null)
// 反悬赏确认弹窗
const counterConfirmShow = ref(false)
const pendingCounter = ref(null)
const counterReason = ref('')

// ====== 计算属性 ======
const feeRateText = computed(() => `${(feeRate * 100).toFixed(0)}%`)
const feeAmount = computed(() => Math.floor((publishForm.value.amount || 0) * feeRate))
const totalCost = computed(() => (publishForm.value.amount || 0) + feeAmount.value)

// ====== 工具函数 ======
/**
 * 悬赏状态标签
 */
function statusLabel(status) {
  const map = {
    active: '悬赏中',
    accepted: '已接取',
    completed: '已完成',
    expired: '已过期',
    cancelled: '已取消'
  }
  return map[status] || status
}

/**
 * 悬赏状态徽章色（tone 取值见 ui/Badge.vue）
 */
function statusBadgeTone(status) {
  const map = {
    active: 'gold',
    accepted: 'info',
    completed: 'success',
    expired: 'muted',
    cancelled: 'danger'
  }
  return map[status] || 'neutral'
}

/**
 * 格式化时间
 */
function formatTime(timeStr) {
  if (!timeStr) return '-'
  const d = new Date(timeStr)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 判断当前玩家是否可接取此悬赏
 * 不可接取：自己发布的、自己被悬赏的
 */
function canAccept(bounty) {
  const myId = playerStore.player?.id
  if (!myId) return false
  if (bounty.publisher?.id === myId) return false
  if (bounty.target?.id === myId) return false
  return true
}

// ====== 数据加载 ======
/**
 * 加载悬赏榜单
 */
async function loadList(page) {
  if (page < 1) page = 1
  listLoading.value = true
  try {
    const res = await getBountyList({
      page,
      page_size: pageSize,
      status: filterStatus.value || undefined
    })
    bountyList.value = res.data.data?.list || []
    currentPage.value = res.data.data?.page || page
    totalPages.value = Math.ceil((res.data.data?.total || 0) / pageSize)
  } catch (err) {
    uiStore.showApiError(err, '加载悬赏榜失败')
  } finally {
    listLoading.value = false
  }
}

/**
 * 加载我的悬赏
 */
async function loadMyBounties() {
  myLoading.value = true
  try {
    const res = await getMyBounties()
    myBounties.value = res.data.data || { published: [], accepted: [], targeting_me: [] }
  } catch (err) {
    uiStore.showApiError(err, '加载我的悬赏失败')
  } finally {
    myLoading.value = false
  }
}

// ====== 操作处理 ======
/**
 * 点击接取悬赏（弹出确认）
 */
function handleAccept(bounty) {
  pendingBounty.value = bounty
  acceptConfirmShow.value = true
}

/**
 * 确认接取悬赏
 */
async function confirmAccept() {
  if (!pendingBounty.value) return
  actionLoading.value = true
  try {
    const res = await acceptBounty(pendingBounty.value.bounty_id)
    uiStore.showToast(res.data.message || '悬赏已接取，斗法已开启', 'success')
    acceptConfirmShow.value = false
    pendingBounty.value = null
    // 接取后关闭面板，让玩家进入战斗 UI
    emit('close')
  } catch (err) {
    uiStore.showApiError(err, '接取悬赏失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 点击取消悬赏（弹出确认）
 */
function handleCancel(bounty) {
  pendingCancel.value = bounty
  cancelConfirmShow.value = true
}

/**
 * 确认取消悬赏
 */
async function confirmCancel() {
  if (!pendingCancel.value) return
  actionLoading.value = true
  try {
    const res = await cancelBounty(pendingCancel.value.bounty_id)
    uiStore.showToast(`悬赏已取消，退还 ${res.data.data?.refund_amount || 0} 灵石`, 'success')
    cancelConfirmShow.value = false
    pendingCancel.value = null
    // 刷新我的悬赏列表
    await loadMyBounties()
  } catch (err) {
    uiStore.showApiError(err, '取消悬赏失败')
  } finally {
    actionLoading.value = false
  }
}

// ===== 反悬赏功能 =====
// 玩法说明：被悬赏者可花费灵石对悬赏者发起反向悬赏，增加 PVP 社交博弈深度
// 反悬赏金额 = 原悬赏金额 * 1.2 倍率，链深度上限 3 次防止无限连锁

/** 反悬赏倍率（与后端配置 counter_bounty.amount_multiplier 保持一致） */
const COUNTER_MULTIPLIER = 1.2

/**
 * 反悬赏预估金额（基于原悬赏金额 * 倍率）
 */
const counterPreviewAmount = computed(() => {
  if (!pendingCounter.value) return 0
  return Math.floor(pendingCounter.value.bounty_amount * COUNTER_MULTIPLIER)
})

/**
 * 反悬赏预估总消耗（含手续费）
 */
const counterPreviewCost = computed(() => {
  return counterPreviewAmount.value + Math.floor(counterPreviewAmount.value * feeRate)
})

/**
 * 点击反悬赏（弹出确认）
 */
function handleCounter(bounty) {
  pendingCounter.value = bounty
  counterReason.value = ''
  counterConfirmShow.value = true
}

/**
 * 确认反悬赏
 */
async function confirmCounter() {
  if (!pendingCounter.value) return
  actionLoading.value = true
  try {
    const res = await counterBounty(
      pendingCounter.value.bounty_id,
      counterReason.value || undefined
    )
    const msg = `反悬赏发布成功！消耗 ${res.data.data.total_cost} 灵石，` +
      `反悬赏 ${res.data.data.target?.nickname} ${res.data.data.bounty_amount} 灵石` +
      (res.data.data.counter_chain_depth > 1 ? `（第 ${res.data.data.counter_chain_depth} 次反悬赏）` : '')
    uiStore.showToast(msg, 'success')
    counterConfirmShow.value = false
    pendingCounter.value = null
    counterReason.value = ''
    // 刷新我的悬赏列表
    await loadMyBounties()
  } catch (err) {
    uiStore.showApiError(err, '反悬赏失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 发布悬赏
 */
async function handlePublish() {
  const { target_id, amount, reason } = publishForm.value
  if (!target_id || !amount) {
    uiStore.showToast('请填写目标 ID 和悬赏金额', 'error')
    return
  }
  if (amount < minAmount || amount > maxAmount) {
    uiStore.showToast(`悬赏金额必须在 ${minAmount} ~ ${maxAmount} 之间`, 'error')
    return
  }
  actionLoading.value = true
  try {
    const res = await publishBounty(target_id, amount, reason || undefined)
    uiStore.showToast(`悬赏发布成功，消耗 ${res.data.data.total_cost} 灵石`, 'success')
    // 清空表单
    publishForm.value = { target_id: null, amount: null, reason: '' }
    // 切换到我的悬赏 Tab
    activeTab.value = 'my'
    await loadMyBounties()
  } catch (err) {
    uiStore.showApiError(err, '发布悬赏失败')
  } finally {
    actionLoading.value = false
  }
}

// ====== Tab 切换时自动加载 ======
function onTabChange(tab) {
  if (tab === 'list' && bountyList.value.length === 0) {
    loadList(1)
  } else if (tab === 'my') {
    loadMyBounties()
  }
}

// 监听 Tab 切换
import { watch } from 'vue'
watch(activeTab, (newTab) => {
  onTabChange(newTab)
})

// ====== 初始化 ======
onMounted(() => {
  loadList(1)
})
</script>
