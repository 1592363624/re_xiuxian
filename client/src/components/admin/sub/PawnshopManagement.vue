<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400">
          <path d="M12 2 2 7l10 5 10-5-10-5z"/>
          <path d="m2 17 10 5 10-5"/>
          <path d="m2 12 10 5 10-5"/>
        </svg>
        聚宝当铺管理
      </h3>
      <div class="flex space-x-2">
        <button @click="fetchList(pagination.page)" class="px-3 py-1 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm">刷新当票</button>
        <button @click="fetchMetrics" class="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-white text-sm">更新指标</button>
      </div>
    </div>

    <!-- 统计指标卡片 -->
    <div v-if="metrics" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <!-- 活跃当票数 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">活跃当票</div>
        <div class="text-2xl font-bold text-amber-400">{{ metrics.listings.active }}</div>
        <div class="text-[10px] text-gray-500 mt-1">
          逾期 {{ metrics.listings.overdue }} · 已赎回 {{ metrics.listings.redeemed }}
        </div>
      </div>
      <!-- 今日典当 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">今日典当</div>
        <div class="text-2xl font-bold text-amber-400">{{ metrics.today.pawn_count }} 笔</div>
        <div class="text-[10px] text-amber-300 mt-1">
          总额 {{ metrics.today.pawn_total_amount }} 灵石
        </div>
      </div>
      <!-- 今日赎回 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">今日赎回</div>
        <div class="text-2xl font-bold text-emerald-400">{{ metrics.today.redeem_count }} 笔</div>
        <div class="text-[10px] text-emerald-300 mt-1">
          总额 {{ metrics.today.redeem_total_amount }} 灵石
        </div>
      </div>
      <!-- 信用分布 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">信用分布</div>
        <div class="text-2xl font-bold text-amber-400">
          {{ metrics.credit.players_with_credit }} / {{ metrics.credit.total_players }}
        </div>
        <div class="text-[10px] text-gray-500 mt-1">
          平均信用 {{ metrics.credit.avg_credit }}
        </div>
      </div>
    </div>

    <!-- 筛选与搜索 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">状态：</label>
          <select
            v-model="searchParams.status"
            class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
            @change="handleSearch"
          >
            <option value="">全部</option>
            <option value="active">典当中</option>
            <option value="redeemed">已赎回</option>
            <option value="overdue">已逾期</option>
            <option value="auctioned">已拍卖</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">玩家ID：</label>
          <input
            v-model.number="searchParams.player_id"
            type="number"
            min="1"
            placeholder="按玩家ID筛选"
            class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm w-40"
            @keyup.enter="handleSearch"
          />
        </div>
        <button @click="handleSearch" class="px-3 py-1 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm">查询</button>
        <button @click="resetSearch" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
      </div>
    </div>

    <!-- 当票列表表格 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-900 text-gray-400">
            <tr>
              <th class="px-3 py-2 text-left whitespace-nowrap">当票ID</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">玩家</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">物品</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">数量</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">典当所得</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">赎回价</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">状态</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">典当时间</th>
              <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            <!-- 加载中 -->
            <tr v-if="loading" class="text-center text-gray-500">
              <td colspan="9" class="px-3 py-6">加载中...</td>
            </tr>
            <!-- 空数据 -->
            <tr v-else-if="list.length === 0" class="text-center text-gray-500">
              <td colspan="9" class="px-3 py-6">暂无数据</td>
            </tr>
            <!-- 数据行 -->
            <tr
              v-for="item in list"
              :key="item.id"
              class="border-t border-gray-700 hover:bg-gray-750"
            >
              <td class="px-3 py-2 text-gray-400">{{ item.id }}</td>
              <td class="px-3 py-2">
                <div class="text-white">{{ item.player_nickname }}</div>
                <div class="text-xs text-gray-500">ID: {{ item.player_id }} · {{ item.player_realm }}</div>
              </td>
              <td class="px-3 py-2">
                <div class="text-amber-300">{{ item.item_name }}</div>
                <div class="text-xs text-gray-500">{{ item.item_quality }}</div>
              </td>
              <td class="px-3 py-2 text-gray-300">{{ item.quantity }}</td>
              <td class="px-3 py-2 text-amber-400 font-bold">{{ item.pawn_amount }}</td>
              <td class="px-3 py-2 text-rose-400">{{ item.redeem_amount }}</td>
              <td class="px-3 py-2">
                <span
                  :class="statusBadgeClass(item.status)"
                  class="px-2 py-0.5 rounded text-xs"
                >{{ statusLabel(item.status) }}</span>
              </td>
              <td class="px-3 py-2 text-xs text-gray-400">{{ formatDate(item.pawned_at) }}</td>
              <td class="px-3 py-2 text-center whitespace-nowrap">
                <button
                  @click="openDetailModal(item)"
                  class="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs mr-1"
                >详情</button>
                <button
                  v-if="item.status === 'active'"
                  @click="openForceRedeemModal(item)"
                  class="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-white text-xs mr-1"
                >强制赎回</button>
                <button
                  v-if="item.status === 'active'"
                  @click="openCancelModal(item)"
                  class="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-xs"
                >取消当票</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div class="px-4 py-3 border-t border-gray-700 flex items-center justify-between text-sm">
        <div class="text-gray-400">
          共 {{ pagination.total }} 条记录
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="fetchList(pagination.page - 1)"
            :disabled="pagination.page <= 1 || loading"
            class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >上一页</button>
          <span class="text-gray-300">{{ pagination.page }} / {{ pagination.totalPages }}</span>
          <button
            @click="fetchList(pagination.page + 1)"
            :disabled="pagination.page >= pagination.totalPages || loading"
            class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >下一页</button>
        </div>
      </div>
    </div>

    <!-- 调整信用入口 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <h4 class="text-sm font-bold text-amber-400 mb-3">调整玩家当铺信用</h4>
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">玩家ID：</label>
          <input
            v-model.number="creditForm.player_id"
            type="number"
            min="1"
            placeholder="玩家ID"
            class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm w-32"
          />
        </div>
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">信用值：</label>
          <input
            v-model.number="creditForm.credit"
            type="number"
            min="0"
            placeholder="0-100"
            class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm w-24"
          />
        </div>
        <div class="flex items-center gap-2 flex-1 min-w-[200px]">
          <label class="text-sm text-gray-400 whitespace-nowrap">原因：</label>
          <input
            v-model="creditForm.reason"
            type="text"
            placeholder="操作原因（必填，记录到审计日志）"
            class="flex-1 px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
          />
        </div>
        <button
          @click="openCreditConfirmModal"
          :disabled="operating"
          class="px-4 py-1 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >提交调整</button>
      </div>
      <p class="text-xs text-gray-500 mt-2">
        提示：调整信用值将影响玩家在当铺的估值加成（最高 +10%）。所有调整将记录到 admin_logs 审计日志。
      </p>
    </div>

    <!-- 当票详情弹窗 -->
    <Modal :isOpen="!!detailData" title="当票详情" width="640px" @close="detailData = null">
      <div v-if="detailData" class="space-y-3 text-sm">
        <!-- 当票基础信息 -->
        <div class="bg-gray-900 rounded p-3 border border-gray-700">
          <div class="text-xs text-gray-400 mb-2">当票信息</div>
          <div class="grid grid-cols-2 gap-x-3 gap-y-2">
            <div>
              <label class="block text-gray-500 mb-1">当票ID</label>
              <div class="text-white">{{ detailData.listing.id }}</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">状态</label>
              <div>
                <span :class="statusBadgeClass(detailData.listing.status)" class="px-2 py-0.5 rounded text-xs">
                  {{ statusLabel(detailData.listing.status) }}
                </span>
              </div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">物品</label>
              <div class="text-amber-300">{{ detailData.listing.item_name }} ({{ detailData.listing.item_quality }})</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">数量</label>
              <div class="text-white">{{ detailData.listing.quantity }}</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">典当所得</label>
              <div class="text-amber-400 font-bold">{{ detailData.listing.pawn_amount }} 灵石</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">手续费</label>
              <div class="text-rose-400">{{ detailData.listing.pawn_fee }} 灵石</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">赎回价</label>
              <div class="text-rose-400 font-bold">{{ detailData.listing.redeem_amount }} 灵石</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">基础价值</label>
              <div class="text-gray-300">{{ detailData.listing.base_price }} 灵石</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">典当时间</label>
              <div class="text-white text-xs">{{ formatDate(detailData.listing.pawned_at) }}</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">赎回截止</label>
              <div class="text-white text-xs">{{ formatDate(detailData.listing.redeem_deadline) }}</div>
            </div>
            <div v-if="detailData.listing.redeemed_at">
              <label class="block text-gray-500 mb-1">实际赎回时间</label>
              <div class="text-emerald-400 text-xs">{{ formatDate(detailData.listing.redeemed_at) }}</div>
            </div>
          </div>
        </div>

        <!-- 玩家信息 -->
        <div v-if="detailData.player" class="bg-gray-900 rounded p-3 border border-gray-700">
          <div class="text-xs text-gray-400 mb-2">玩家信息</div>
          <div class="grid grid-cols-2 gap-x-3 gap-y-2">
            <div>
              <label class="block text-gray-500 mb-1">玩家ID</label>
              <div class="text-white">{{ detailData.player.id }}</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">昵称</label>
              <div class="text-white">{{ detailData.player.nickname }}</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">境界</label>
              <div class="text-white">{{ detailData.player.realm }}</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">当铺信用</label>
              <div class="text-amber-400 font-bold">{{ detailData.player.pawnshop_credit }}</div>
            </div>
            <div>
              <label class="block text-gray-500 mb-1">灵石余额</label>
              <div class="text-amber-300">{{ detailData.player.spirit_stones }}</div>
            </div>
          </div>
        </div>

        <!-- 关联历史记录 -->
        <div v-if="detailData.histories && detailData.histories.length > 0" class="bg-gray-900 rounded p-3 border border-gray-700">
          <div class="text-xs text-gray-400 mb-2">关联历史记录</div>
          <ul class="space-y-1 text-xs">
            <li
              v-for="h in detailData.histories"
              :key="h.id"
              class="flex items-center gap-2 px-2 py-1 rounded bg-gray-800"
            >
              <span :class="actionTypeTextClass(h.action_type)" class="font-bold">
                {{ actionTypeLabel(h.action_type) }}
              </span>
              <span class="text-gray-300">{{ h.item_name }} x{{ h.quantity }}</span>
              <span class="text-amber-400">{{ h.amount }} 灵石</span>
              <span class="text-gray-500 ml-auto">{{ formatDate(h.created_at) }}</span>
            </li>
          </ul>
        </div>
      </div>
      <template #footer>
        <button @click="detailData = null" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">关闭</button>
      </template>
    </Modal>

    <!-- 强制赎回弹窗 -->
    <Modal :isOpen="forceRedeemModal.show" title="强制赎回当票" width="480px" @close="forceRedeemModal.show = false">
      <div v-if="forceRedeemModal.listing" class="space-y-3 text-sm">
        <p class="text-gray-300">确定要强制赎回以下当票吗？</p>
        <div class="bg-gray-900 rounded p-3 border border-gray-700 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-gray-500">当票ID</span>
            <span class="text-white">{{ forceRedeemModal.listing.id }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">玩家</span>
            <span class="text-white">{{ forceRedeemModal.listing.player_nickname }} ({{ forceRedeemModal.listing.player_id }})</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">物品</span>
            <span class="text-amber-300">{{ forceRedeemModal.listing.item_name }} x{{ forceRedeemModal.listing.quantity }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">当前赎回价</span>
            <span class="text-rose-400 font-bold">{{ forceRedeemModal.listing.redeem_amount }} 灵石</span>
          </div>
        </div>
        <div>
          <label class="block text-gray-400 mb-1">操作原因（必填）</label>
          <textarea
            v-model="forceRedeemModal.reason"
            rows="3"
            placeholder="请填写强制赎回原因，将记录到审计日志"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-sm"
          ></textarea>
        </div>
        <p class="text-xs text-amber-400">
          提示：强制赎回为 GM 代赎，物品将归还玩家但不扣减玩家灵石。信用额度会正常 +1。
        </p>
      </div>
      <template #footer>
        <button @click="forceRedeemModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button
          @click="confirmForceRedeem"
          :disabled="operating"
          class="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ operating ? '执行中...' : '确认强制赎回' }}
        </button>
      </template>
    </Modal>

    <!-- 取消当票弹窗 -->
    <Modal :isOpen="cancelModal.show" title="强制取消当票" width="480px" @close="cancelModal.show = false">
      <div v-if="cancelModal.listing" class="space-y-3 text-sm">
        <p class="text-gray-300">确定要强制取消以下当票吗？</p>
        <div class="bg-gray-900 rounded p-3 border border-gray-700 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-gray-500">当票ID</span>
            <span class="text-white">{{ cancelModal.listing.id }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">玩家</span>
            <span class="text-white">{{ cancelModal.listing.player_nickname }} ({{ cancelModal.listing.player_id }})</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">物品</span>
            <span class="text-amber-300">{{ cancelModal.listing.item_name }} x{{ cancelModal.listing.quantity }}</span>
          </div>
        </div>
        <div>
          <label class="block text-gray-400 mb-1">操作原因（必填）</label>
          <textarea
            v-model="cancelModal.reason"
            rows="3"
            placeholder="请填写取消原因，将记录到审计日志"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-sm"
          ></textarea>
        </div>
        <p class="text-xs text-rose-400">
          提示：强制取消将把物品归还玩家储物袋，且不扣减玩家灵石（已典当所得会被回收，若玩家灵石不足将报警）。
        </p>
      </div>
      <template #footer>
        <button @click="cancelModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button
          @click="confirmCancel"
          :disabled="operating"
          class="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ operating ? '执行中...' : '确认取消' }}
        </button>
      </template>
    </Modal>

    <!-- 信用调整确认弹窗 -->
    <Modal :isOpen="creditConfirmModal.show" title="确认调整信用" width="420px" @close="creditConfirmModal.show = false">
      <div class="space-y-3 text-sm">
        <p class="text-gray-300">请确认以下信用调整操作：</p>
        <div class="bg-gray-900 rounded p-3 border border-gray-700 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-gray-500">玩家ID</span>
            <span class="text-white">{{ creditForm.player_id }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">新信用值</span>
            <span class="text-amber-400 font-bold">{{ creditForm.credit }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">原因</span>
            <span class="text-white text-xs">{{ creditForm.reason || '-' }}</span>
          </div>
        </div>
        <p class="text-xs text-amber-400">
          提示：调整信用将立即影响玩家在当铺的估值加成。所有调整将记录到 admin_logs 审计日志。
        </p>
      </div>
      <template #footer>
        <button @click="creditConfirmModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button
          @click="confirmUpdateCredit"
          :disabled="operating"
          class="px-4 py-2 bg-amber-700 hover:bg-amber-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ operating ? '执行中...' : '确认调整' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * 聚宝当铺管理组件（GM 后台）
 *
 * 功能：
 *   1. 展示当铺系统统计指标（活跃当票数、今日典当/赎回汇总、信用分布）
 *   2. 分页查询所有当票（支持按玩家 ID 与状态筛选）
 *   3. 查看当票详情（含玩家信息与关联历史记录）
 *   4. 强制赎回当票（GM 代赎，不扣玩家灵石）
 *   5. 强制取消当票（物品归还玩家，已得灵石回收）
 *   6. 调整玩家当铺信用额度（影响估值加成）
 *
 * 所有操作均通过 admin_pawnshop API 调用后端，前端只做展示与接口调用。
 * 所有写操作均要求填写操作原因，记录到 admin_logs 审计日志。
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
import {
  getMetrics,
  getList,
  getDetail,
  forceRedeem,
  cancelListing,
  updateCredit
} from '../../../api/admin_pawnshop'

const uiStore = useUIStore()

/* ===================== 响应式状态 ===================== */

const loading = ref(false)
const operating = ref(false)
const metrics = ref(null)
const list = ref([])

// 分页参数
const pagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
})

// 筛选参数
const searchParams = reactive({
  status: '',
  player_id: undefined
})

// 当票详情数据
const detailData = ref(null)

// 强制赎回弹窗状态
const forceRedeemModal = ref({
  show: false,
  listing: null,
  reason: ''
})

// 取消当票弹窗状态
const cancelModal = ref({
  show: false,
  listing: null,
  reason: ''
})

// 信用调整表单
const creditForm = reactive({
  player_id: undefined,
  credit: 0,
  reason: ''
})

// 信用调整确认弹窗
const creditConfirmModal = ref({ show: false })

/* ===================== 数据获取 ===================== */

/**
 * 拉取统计指标
 */
const fetchMetrics = async () => {
  try {
    const res = await getMetrics()
    metrics.value = res.data?.data || res.data
  } catch (err) {
    console.error('[PawnshopManagement] 获取指标失败:', err)
    uiStore.showToast('获取指标失败', 'error')
  }
}

/**
 * 拉取当票列表
 * @param {number} page - 页码
 */
const fetchList = async (page = 1) => {
  if (page < 1) page = 1
  loading.value = true
  try {
    const params = {
      page,
      limit: pagination.pageSize
    }
    if (searchParams.status) params.status = searchParams.status
    if (searchParams.player_id) params.player_id = searchParams.player_id
    const res = await getList(params)
    const data = res.data?.data || res.data
    list.value = data.list || []
    pagination.total = data.total || 0
    pagination.page = data.page || page
    pagination.totalPages = data.total_pages || 1
  } catch (err) {
    console.error('[PawnshopManagement] 获取列表失败:', err)
    const msg = err?.response?.data?.message || '获取列表失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 搜索（重置到第 1 页）
 */
const handleSearch = () => {
  fetchList(1)
}

/**
 * 重置筛选条件
 */
const resetSearch = () => {
  searchParams.status = ''
  searchParams.player_id = undefined
  fetchList(1)
}

/* ===================== 详情弹窗 ===================== */

/**
 * 打开当票详情弹窗
 * @param {Object} item - 列表项当票对象
 */
const openDetailModal = async (item) => {
  try {
    const res = await getDetail(item.id)
    detailData.value = res.data?.data || res.data
  } catch (err) {
    console.error('[PawnshopManagement] 获取详情失败:', err)
    const msg = err?.response?.data?.message || '获取详情失败'
    uiStore.showToast(msg, 'error')
  }
}

/* ===================== 强制赎回 ===================== */

/**
 * 打开强制赎回弹窗
 * @param {Object} item - 当票对象
 */
const openForceRedeemModal = (item) => {
  forceRedeemModal.value = {
    show: true,
    listing: item,
    reason: ''
  }
}

/**
 * 确认强制赎回
 */
const confirmForceRedeem = async () => {
  const { listing, reason } = forceRedeemModal.value
  if (!listing) return
  if (!reason || !reason.trim()) {
    uiStore.showToast('请填写操作原因', 'warning')
    return
  }
  if (operating.value) return
  operating.value = true
  try {
    const res = await forceRedeem(listing.id, listing.player_id, reason.trim())
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '强制赎回成功', 'success')
    forceRedeemModal.value = { show: false, listing: null, reason: '' }
    // 刷新列表与指标
    await Promise.all([fetchList(pagination.page), fetchMetrics()])
  } catch (err) {
    console.error('[PawnshopManagement] 强制赎回失败:', err)
    const msg = err?.response?.data?.message || '强制赎回失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/* ===================== 强制取消 ===================== */

/**
 * 打开取消当票弹窗
 * @param {Object} item - 当票对象
 */
const openCancelModal = (item) => {
  cancelModal.value = {
    show: true,
    listing: item,
    reason: ''
  }
}

/**
 * 确认取消当票
 */
const confirmCancel = async () => {
  const { listing, reason } = cancelModal.value
  if (!listing) return
  if (!reason || !reason.trim()) {
    uiStore.showToast('请填写操作原因', 'warning')
    return
  }
  if (operating.value) return
  operating.value = true
  try {
    const res = await cancelListing(listing.id, reason.trim())
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '取消当票成功', 'success')
    cancelModal.value = { show: false, listing: null, reason: '' }
    await Promise.all([fetchList(pagination.page), fetchMetrics()])
  } catch (err) {
    console.error('[PawnshopManagement] 取消当票失败:', err)
    const msg = err?.response?.data?.message || '取消当票失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/* ===================== 信用调整 ===================== */

/**
 * 打开信用调整确认弹窗
 */
const openCreditConfirmModal = () => {
  // 基础校验
  if (!creditForm.player_id || creditForm.player_id < 1) {
    uiStore.showToast('请填写有效的玩家 ID', 'warning')
    return
  }
  if (creditForm.credit === undefined || creditForm.credit === null || creditForm.credit < 0) {
    uiStore.showToast('信用值不能小于 0', 'warning')
    return
  }
  if (!creditForm.reason || !creditForm.reason.trim()) {
    uiStore.showToast('请填写操作原因', 'warning')
    return
  }
  creditConfirmModal.value.show = true
}

/**
 * 确认调整信用
 */
const confirmUpdateCredit = async () => {
  if (operating.value) return
  operating.value = true
  try {
    const res = await updateCredit(
      creditForm.player_id,
      creditForm.credit,
      creditForm.reason.trim()
    )
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '信用调整成功', 'success')
    creditConfirmModal.value.show = false
    // 清空表单
    creditForm.player_id = undefined
    creditForm.credit = 0
    creditForm.reason = ''
    // 刷新指标
    await fetchMetrics()
  } catch (err) {
    console.error('[PawnshopManagement] 信用调整失败:', err)
    const msg = err?.response?.data?.message || '信用调整失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/* ===================== 工具函数 ===================== */

/**
 * 当票状态中文标签
 * @param {string} status - 当票状态
 */
const statusLabel = (status) => {
  const map = {
    active: '典当中',
    redeemed: '已赎回',
    overdue: '已逾期',
    auctioned: '已拍卖'
  }
  return map[status] || status
}

/**
 * 当票状态徽章样式
 * @param {string} status - 当票状态
 */
const statusBadgeClass = (status) => {
  const map = {
    active: 'bg-amber-900 text-amber-300',
    redeemed: 'bg-emerald-900 text-emerald-300',
    overdue: 'bg-rose-900 text-rose-300',
    auctioned: 'bg-gray-700 text-gray-300'
  }
  return map[status] || 'bg-gray-700 text-gray-300'
}

/**
 * 历史操作类型中文标签
 * @param {string} actionType - 操作类型
 */
const actionTypeLabel = (actionType) => {
  const map = {
    pawn: '典当',
    redeem: '赎回',
    overdue: '逾期',
    auction: '拍卖'
  }
  return map[actionType] || actionType
}

/**
 * 历史操作类型文字样式
 * @param {string} actionType - 操作类型
 */
const actionTypeTextClass = (actionType) => {
  const map = {
    pawn: 'text-amber-400',
    redeem: 'text-emerald-400',
    overdue: 'text-rose-400',
    auction: 'text-gray-400'
  }
  return map[actionType] || 'text-gray-400'
}

/**
 * 格式化日期
 * @param {string} dateStr - ISO 时间字符串
 */
const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return dateStr
  }
}

/* ===================== 生命周期 ===================== */

onMounted(() => {
  // 进入面板时并行拉取指标与列表
  fetchMetrics()
  fetchList(1)
})
</script>

<style scoped>
</style>
