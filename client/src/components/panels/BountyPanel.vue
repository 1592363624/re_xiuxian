/**
 * 悬赏追杀面板组件
 *
 * 弹窗式组件，展示悬赏榜单、我的悬赏、发布悬赏、接取/取消悬赏。
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格：悬赏用金色/琥珀色系（amber-400/amber-500），区分于斗法红色系
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
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-amber-900/40 rounded-lg p-6 max-w-3xl w-full mx-4 shadow-2xl shadow-amber-900/20 animate-fade-in max-h-[88vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-amber-400 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="8" r="6"/>
            <path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>
          </svg>
          悬赏追杀榜
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex gap-2 mb-4 border-b border-stone-700 pb-2">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="activeTab = tab.id"
          :class="activeTab === tab.id
            ? 'text-amber-400 border-b-2 border-amber-400'
            : 'text-stone-400 hover:text-stone-200 border-b-2 border-transparent'"
          class="px-3 py-1 text-sm font-medium transition-colors"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- ===== Tab 1: 悬赏榜单 ===== -->
        <div v-if="activeTab === 'list'">
          <!-- 状态过滤 -->
          <div class="flex items-center gap-2 mb-3">
            <span class="text-xs text-stone-400">状态筛选：</span>
            <button
              v-for="s in statusFilters"
              :key="s.value"
              @click="filterStatus = s.value; loadList(1)"
              :class="filterStatus === s.value
                ? 'bg-amber-900/40 text-amber-300 border-amber-600/50'
                : 'bg-[#292524] text-stone-400 border-stone-700 hover:text-stone-200'"
              class="px-2 py-1 text-xs rounded border transition-colors"
            >
              {{ s.label }}
            </button>
          </div>

          <!-- 加载中 -->
          <div v-if="listLoading" class="text-center text-stone-500 py-10">正在查阅悬赏榜...</div>

          <!-- 空状态 -->
          <div v-else-if="bountyList.length === 0" class="text-center text-stone-500 py-10">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-12 h-12 mx-auto mb-2 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>
            <p>悬赏榜空空如也</p>
          </div>

          <!-- 悬赏列表 -->
          <div v-else class="space-y-2">
            <div
              v-for="bounty in bountyList"
              :key="bounty.bounty_id"
              class="bg-[#292524] border border-stone-700 rounded-lg p-3 hover:border-amber-700/50 transition-colors"
            >
              <div class="flex items-center justify-between gap-3">
                <!-- 左侧：目标 + 发布者信息 -->
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs px-1.5 py-0.5 rounded" :class="statusBadgeClass(bounty.status)">
                      {{ statusLabel(bounty.status) }}
                    </span>
                    <span class="text-sm font-bold text-amber-300 truncate">
                      悬赏 {{ bounty.target?.nickname || '未知' }}
                    </span>
                  </div>
                  <div class="text-xs text-stone-400 truncate">
                    发布者：{{ bounty.publisher?.nickname || '未知' }}
                    <span v-if="bounty.acceptor"> · 接单：{{ bounty.acceptor.nickname }}</span>
                  </div>
                  <div v-if="bounty.reason" class="text-xs text-stone-500 mt-1 italic truncate">
                    "{{ bounty.reason }}"
                  </div>
                </div>
                <!-- 右侧：金额 + 操作 -->
                <div class="flex flex-col items-end gap-1 shrink-0">
                  <div class="text-amber-400 font-bold text-lg">{{ bounty.bounty_amount.toLocaleString() }}</div>
                  <div class="text-xs text-stone-500">灵石</div>
                  <!-- 接取按钮（仅 active 状态且不是自己发布/目标的可接取） -->
                  <button
                    v-if="bounty.status === 'active' && canAccept(bounty)"
                    @click="handleAccept(bounty)"
                    :disabled="actionLoading"
                    class="px-2 py-1 text-xs bg-amber-900/40 text-amber-300 border border-amber-700/50 rounded hover:bg-amber-800/50 transition-colors disabled:opacity-50"
                  >
                    {{ actionLoading ? '接取中...' : '接取' }}
                  </button>
                </div>
              </div>
              <!-- 过期时间 -->
              <div class="text-xs text-stone-500 mt-1">
                {{ bounty.status === 'active' ? '过期' : '创建' }}：{{ formatTime(bounty[bounty.status === 'active' ? 'expire_at' : 'created_at']) }}
              </div>
            </div>

            <!-- 分页 -->
            <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 pt-2">
              <button
                @click="loadList(currentPage - 1)"
                :disabled="currentPage <= 1"
                class="px-3 py-1 text-xs bg-[#292524] border border-stone-700 rounded text-stone-300 hover:text-white disabled:opacity-30 transition-colors"
              >
                上一页
              </button>
              <span class="text-xs text-stone-400">{{ currentPage }} / {{ totalPages }}</span>
              <button
                @click="loadList(currentPage + 1)"
                :disabled="currentPage >= totalPages"
                class="px-3 py-1 text-xs bg-[#292524] border border-stone-700 rounded text-stone-300 hover:text-white disabled:opacity-30 transition-colors"
              >
                下一页
              </button>
            </div>
          </div>
        </div>

        <!-- ===== Tab 2: 我的悬赏 ===== -->
        <div v-else-if="activeTab === 'my'">
          <div v-if="myLoading" class="text-center text-stone-500 py-10">正在查阅我的悬赏...</div>
          <div v-else-if="myBounties.published.length === 0 && myBounties.accepted.length === 0 && (myBounties.targeting_me || []).length === 0" class="text-center text-stone-500 py-10">
            <p>你还没有任何悬赏记录</p>
          </div>
          <div v-else class="space-y-4">
            <!-- 我发布的 -->
            <div v-if="myBounties.published.length > 0">
              <h3 class="text-sm font-bold text-amber-400 mb-2">我发布的悬赏</h3>
              <div class="space-y-2">
                <div
                  v-for="bounty in myBounties.published"
                  :key="bounty.bounty_id"
                  class="bg-[#292524] border border-stone-700 rounded-lg p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs px-1.5 py-0.5 rounded" :class="statusBadgeClass(bounty.status)">
                          {{ statusLabel(bounty.status) }}
                        </span>
                        <span class="text-sm font-bold text-stone-200">悬赏 {{ bounty.target?.nickname || '未知' }}</span>
                      </div>
                      <div class="text-xs text-stone-400">
                        金额：{{ bounty.bounty_amount.toLocaleString() }} 灵石
                        <span v-if="bounty.acceptor"> · 接单者：{{ bounty.acceptor.nickname }}</span>
                      </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <span class="text-amber-400 font-bold">{{ bounty.bounty_amount.toLocaleString() }}</span>
                      <button
                        v-if="bounty.status === 'active'"
                        @click="handleCancel(bounty)"
                        :disabled="actionLoading"
                        class="px-2 py-1 text-xs bg-rose-900/30 text-rose-300 border border-rose-800/50 rounded hover:bg-rose-800/40 transition-colors disabled:opacity-50"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 我接取的 -->
            <div v-if="myBounties.accepted.length > 0">
              <h3 class="text-sm font-bold text-amber-400 mb-2">我接取的悬赏</h3>
              <div class="space-y-2">
                <div
                  v-for="bounty in myBounties.accepted"
                  :key="bounty.bounty_id"
                  class="bg-[#292524] border border-stone-700 rounded-lg p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs px-1.5 py-0.5 rounded" :class="statusBadgeClass(bounty.status)">
                          {{ statusLabel(bounty.status) }}
                        </span>
                        <span class="text-sm font-bold text-stone-200">追杀 {{ bounty.target?.nickname || '未知' }}</span>
                      </div>
                      <div class="text-xs text-stone-400">
                        发布者：{{ bounty.publisher?.nickname || '未知' }}
                        · 金额：{{ bounty.bounty_amount.toLocaleString() }} 灵石
                      </div>
                    </div>
                    <span class="text-amber-400 font-bold shrink-0">{{ bounty.bounty_amount.toLocaleString() }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 针对我的悬赏（我是 target，可反悬赏） -->
            <div v-if="(myBounties.targeting_me || []).length > 0">
              <h3 class="text-sm font-bold text-rose-400 mb-2 flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                针对我的悬赏
              </h3>
              <div class="bg-rose-950/20 border border-rose-800/30 rounded-lg p-2 mb-2 text-xs text-rose-300/80">
                你正被悬赏追杀，可选择接单者来应战，或花费灵石发起反悬赏反击悬赏者
              </div>
              <div class="space-y-2">
                <div
                  v-for="bounty in myBounties.targeting_me"
                  :key="bounty.bounty_id"
                  class="bg-[#292524] border border-rose-800/40 rounded-lg p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs px-1.5 py-0.5 rounded" :class="statusBadgeClass(bounty.status)">
                          {{ statusLabel(bounty.status) }}
                        </span>
                        <span class="text-sm font-bold text-rose-300">被 {{ bounty.publisher?.nickname || '未知' }} 悬赏</span>
                      </div>
                      <div class="text-xs text-stone-400">
                        金额：{{ bounty.bounty_amount.toLocaleString() }} 灵石
                        <span v-if="bounty.acceptor"> · 接单者：{{ bounty.acceptor.nickname }}</span>
                      </div>
                      <div v-if="bounty.reason" class="text-xs text-stone-500 mt-1 italic truncate">
                        "{{ bounty.reason }}"
                      </div>
                    </div>
                    <div class="flex flex-col items-end gap-1 shrink-0">
                      <span class="text-rose-400 font-bold">{{ bounty.bounty_amount.toLocaleString() }}</span>
                      <!-- 反悬赏按钮（仅 active 状态可反悬赏，accepted 状态战斗进行中也可反悬赏） -->
                      <button
                        v-if="bounty.status === 'active' || bounty.status === 'accepted'"
                        @click="handleCounter(bounty)"
                        :disabled="actionLoading"
                        class="px-2 py-1 text-xs bg-purple-900/40 text-purple-300 border border-purple-700/50 rounded hover:bg-purple-800/50 transition-colors disabled:opacity-50"
                      >
                        反悬赏
                      </button>
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
            <div class="bg-amber-950/20 border border-amber-800/40 rounded-lg p-3 text-xs text-amber-300/80">
              <p class="mb-1">📌 发布悬赏需消耗灵石（悬赏金额 + 平台手续费 {{ feeRateText }}）</p>
              <p class="mb-1">📌 悬赏金额范围：{{ minAmount.toLocaleString() }} ~ {{ maxAmount.toLocaleString() }} 灵石</p>
              <p>📌 目标必须为入世状态（避世者不可被悬赏），悬赏 {{ expireHours }} 小时内无人接取则全额退还</p>
            </div>

            <!-- 表单 -->
            <div class="space-y-3">
              <div>
                <label class="text-sm text-stone-300 mb-1 block">目标玩家 ID</label>
                <input
                  v-model.number="publishForm.target_id"
                  type="number"
                  placeholder="输入目标玩家的数字 ID"
                  class="w-full bg-[#292524] border border-stone-700 rounded-lg px-3 py-2 text-stone-200 text-sm focus:border-amber-600/50 focus:outline-none"
                />
                <p class="text-xs text-stone-500 mt-1">可在「斗法场」或「排行榜」中查看玩家 ID</p>
              </div>

              <div>
                <label class="text-sm text-stone-300 mb-1 block">悬赏金额（灵石）</label>
                <input
                  v-model.number="publishForm.amount"
                  type="number"
                  :min="minAmount"
                  :max="maxAmount"
                  :placeholder="`输入 ${minAmount} ~ ${maxAmount} 之间的金额`"
                  class="w-full bg-[#292524] border border-stone-700 rounded-lg px-3 py-2 text-stone-200 text-sm focus:border-amber-600/50 focus:outline-none"
                />
                <p v-if="publishForm.amount > 0" class="text-xs text-amber-400 mt-1">
                  总消耗：{{ totalCost }} 灵石（含手续费 {{ feeAmount }}）
                </p>
              </div>

              <div>
                <label class="text-sm text-stone-300 mb-1 block">悬赏理由（可选，最多 200 字）</label>
                <textarea
                  v-model="publishForm.reason"
                  rows="3"
                  maxlength="200"
                  placeholder="填写悬赏理由，让接单者了解追杀缘由..."
                  class="w-full bg-[#292524] border border-stone-700 rounded-lg px-3 py-2 text-stone-200 text-sm focus:border-amber-600/50 focus:outline-none resize-none"
                ></textarea>
              </div>

              <!-- 发布按钮 -->
              <button
                @click="handlePublish"
                :disabled="actionLoading || !publishForm.target_id || !publishForm.amount"
                class="w-full py-2 bg-amber-900/50 text-amber-300 border border-amber-700/50 rounded-lg font-bold hover:bg-amber-800/60 transition-colors disabled:opacity-30"
              >
                {{ actionLoading ? '发布中...' : '发布悬赏' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 接取确认弹窗 -->
      <Modal :isOpen="acceptConfirmShow" title="接取悬赏" @close="acceptConfirmShow = false">
        <div class="space-y-2 text-sm text-stone-300">
          <p>确认接取此悬赏？接取后将自动发起与目标的斗法战斗。</p>
          <div v-if="pendingBounty" class="bg-[#292524] border border-stone-700 rounded p-3 mt-2">
            <div>目标：<span class="text-amber-300 font-bold">{{ pendingBounty.target?.nickname }}</span></div>
            <div>悬赏金额：<span class="text-amber-400 font-bold">{{ pendingBounty.bounty_amount.toLocaleString() }}</span> 灵石</div>
          </div>
          <p class="text-xs text-rose-400/80 mt-2">⚠️ 接取后进入 PVP 战斗，失败将进入虚弱状态</p>
        </div>
        <template #footer>
          <button @click="acceptConfirmShow = false" class="px-4 py-2 text-sm border border-stone-700 text-stone-300 rounded hover:bg-stone-800 transition-colors">取消</button>
          <button @click="confirmAccept" class="px-4 py-2 text-sm bg-amber-900/50 text-amber-300 border border-amber-700/50 rounded hover:bg-amber-800/60 transition-colors">确认接取</button>
        </template>
      </Modal>

      <!-- 取消确认弹窗 -->
      <Modal :isOpen="cancelConfirmShow" title="取消悬赏" @close="cancelConfirmShow = false">
        <div class="space-y-2 text-sm text-stone-300">
          <p>确认取消此悬赏？取消将扣除手续费，仅退还部分灵石。</p>
          <div v-if="pendingCancel" class="bg-[#292524] border border-stone-700 rounded p-3 mt-2">
            <div>目标：<span class="text-stone-200">{{ pendingCancel.target?.nickname }}</span></div>
            <div>悬赏金额：<span class="text-amber-400">{{ pendingCancel.bounty_amount.toLocaleString() }}</span> 灵石</div>
            <div class="text-xs text-stone-400 mt-1">退还约 {{ Math.floor(pendingCancel.bounty_amount * (1 - feeRate)) }} 灵石（扣 {{ Math.ceil(pendingCancel.bounty_amount * feeRate) }} 手续费）</div>
          </div>
        </div>
        <template #footer>
          <button @click="cancelConfirmShow = false" class="px-4 py-2 text-sm border border-stone-700 text-stone-300 rounded hover:bg-stone-800 transition-colors">保留</button>
          <button @click="confirmCancel" class="px-4 py-2 text-sm bg-rose-900/50 text-rose-300 border border-rose-800/50 rounded hover:bg-rose-800/60 transition-colors">确认取消</button>
        </template>
      </Modal>

      <!-- 反悬赏确认弹窗 -->
      <Modal :isOpen="counterConfirmShow" title="发起反悬赏" width="480px" @close="counterConfirmShow = false">
        <div class="space-y-3 text-sm text-stone-300">
          <p>确认对悬赏者发起反悬赏？反悬赏将创建一个针对原悬赏者的新悬赏。</p>
          <div v-if="pendingCounter" class="bg-[#292524] border border-purple-800/40 rounded p-3 space-y-1.5">
            <div>原悬赏者：<span class="text-purple-300 font-bold">{{ pendingCounter.publisher?.nickname }}</span></div>
            <div>原悬赏金额：<span class="text-stone-200">{{ pendingCounter.bounty_amount.toLocaleString() }}</span> 灵石</div>
            <div class="pt-1 border-t border-stone-700/50">
              反悬赏金额：<span class="text-purple-300 font-bold">{{ counterPreviewAmount.toLocaleString() }}</span> 灵石
              <span class="text-xs text-stone-500">（原金额 × {{ COUNTER_MULTIPLIER }}）</span>
            </div>
            <div class="text-xs text-amber-400">总消耗：{{ counterPreviewCost.toLocaleString() }} 灵石（含手续费）</div>
          </div>
          <div>
            <label class="text-xs text-stone-400 mb-1 block">反悬赏理由（可选，最多 180 字）</label>
            <textarea
              v-model="counterReason"
              rows="2"
              maxlength="180"
              placeholder="填写反悬赏理由..."
              class="w-full bg-[#292524] border border-stone-700 rounded px-3 py-2 text-stone-200 text-sm focus:border-purple-600/50 focus:outline-none resize-none"
            ></textarea>
          </div>
          <p class="text-xs text-purple-400/80">反悬赏链上限 3 次，超出将无法继续反悬赏</p>
        </div>
        <template #footer>
          <button @click="counterConfirmShow = false" class="px-4 py-2 text-sm border border-stone-700 text-stone-300 rounded hover:bg-stone-800 transition-colors">再思</button>
          <button
            @click="confirmCounter"
            :disabled="actionLoading"
            class="px-4 py-2 text-sm bg-purple-900/50 text-purple-300 border border-purple-700/50 rounded hover:bg-purple-800/60 transition-colors disabled:opacity-50"
          >
            {{ actionLoading ? '发布中...' : '确认反悬赏' }}
          </button>
        </template>
      </Modal>
    </div>
  </div>
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
import Modal from '../common/Modal.vue'
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

// ====== Tab 配置 ======
const tabs = [
  { id: 'list', label: '悬赏榜单' },
  { id: 'my', label: '我的悬赏' },
  { id: 'publish', label: '发布悬赏' }
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
 * 悬赏状态徽章样式
 */
function statusBadgeClass(status) {
  const map = {
    active: 'bg-amber-900/40 text-amber-300 border border-amber-700/50',
    accepted: 'bg-blue-900/40 text-blue-300 border border-blue-700/50',
    completed: 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50',
    expired: 'bg-stone-800 text-stone-400 border border-stone-700',
    cancelled: 'bg-rose-900/30 text-rose-400 border border-rose-800/50'
  }
  return map[status] || 'bg-stone-800 text-stone-400 border border-stone-700'
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
    bountyList.value = res.data.list || []
    currentPage.value = res.data.page || page
    totalPages.value = Math.ceil((res.data.total || 0) / pageSize)
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '加载悬赏榜失败', 'error')
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
    myBounties.value = res.data || { published: [], accepted: [], targeting_me: [] }
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '加载我的悬赏失败', 'error')
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
    uiStore.showToast(err.response?.data?.message || '接取悬赏失败', 'error')
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
    uiStore.showToast(`悬赏已取消，退还 ${res.data.refund_amount || 0} 灵石`, 'success')
    cancelConfirmShow.value = false
    pendingCancel.value = null
    // 刷新我的悬赏列表
    await loadMyBounties()
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '取消悬赏失败', 'error')
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
    const msg = `反悬赏发布成功！消耗 ${res.data.total_cost} 灵石，` +
      `反悬赏 ${res.data.target?.nickname} ${res.data.bounty_amount} 灵石` +
      (res.data.counter_chain_depth > 1 ? `（第 ${res.data.counter_chain_depth} 次反悬赏）` : '')
    uiStore.showToast(msg, 'success')
    counterConfirmShow.value = false
    pendingCounter.value = null
    counterReason.value = ''
    // 刷新我的悬赏列表
    await loadMyBounties()
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '反悬赏失败', 'error')
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
    uiStore.showToast(`悬赏发布成功，消耗 ${res.data.total_cost} 灵石`, 'success')
    // 清空表单
    publishForm.value = { target_id: null, amount: null, reason: '' }
    // 切换到我的悬赏 Tab
    activeTab.value = 'my'
    await loadMyBounties()
  } catch (err) {
    uiStore.showToast(err.response?.data?.message || '发布悬赏失败', 'error')
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
