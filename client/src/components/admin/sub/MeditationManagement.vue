<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white">悟道与瓶颈管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchList(pagination.page)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
        <button @click="fetchMetrics" class="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white text-sm">更新指标</button>
      </div>
    </div>

    <!-- 统计指标卡片 -->
    <div v-if="metrics" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <!-- 当前悟道中 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">悟道中玩家</div>
        <div class="text-2xl font-bold text-amber-400">{{ metrics.meditation.meditating_count }}</div>
        <div class="text-[10px] text-gray-500 mt-1">
          每日上限：常规 {{ metrics.meditation.daily_normal_limit }} / 深度 {{ metrics.meditation.daily_deep_limit }}
        </div>
      </div>
      <!-- 瓶颈分布 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">瓶颈分布</div>
        <div class="flex gap-2 text-xs">
          <span class="text-gray-400">无：<span class="text-gray-200 font-bold">{{ metrics.bottleneck.state_distribution.none }}</span></span>
          <span class="text-rose-400">瓶颈：<span class="font-bold">{{ metrics.bottleneck.state_distribution.active }}</span></span>
          <span class="text-emerald-400">已破：<span class="font-bold">{{ metrics.bottleneck.state_distribution.broken }}</span></span>
          <span class="text-amber-400">失败：<span class="font-bold">{{ metrics.bottleneck.state_distribution.failed }}</span></span>
        </div>
        <div class="text-[10px] text-gray-500 mt-1">
          瓶颈境界：{{ metrics.bottleneck.bottleneck_realms?.join(', ') || '无' }}
        </div>
      </div>
      <!-- 瓶颈系统配置 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">瓶颈配置</div>
        <div class="text-sm text-stone-300">最大失败次数：{{ metrics.bottleneck.max_failure_count }}</div>
        <div class="text-sm text-emerald-400">破除加成：+{{ metrics.bottleneck.broken_bonus }}%</div>
      </div>
      <!-- 冷却时间 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">悟道冷却</div>
        <div class="text-2xl font-bold text-cyan-400">{{ metrics.meditation.cooldown_seconds }}s</div>
        <div class="text-[10px] text-gray-500 mt-1">悟道结束后冷却</div>
      </div>
    </div>

    <!-- 筛选与搜索 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">筛选：</label>
          <select
            v-model="searchParams.filter"
            class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
            @change="handleSearch"
          >
            <option value="all">全部</option>
            <option value="meditating">仅悟道中</option>
            <option value="bottleneck">仅瓶颈期</option>
          </select>
        </div>
        <button @click="handleSearch" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">查询</button>
        <button @click="resetSearch" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
      </div>
    </div>

    <!-- 玩家列表表格 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-900 text-gray-400">
            <tr>
              <th class="px-3 py-2 text-left whitespace-nowrap">玩家ID</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">昵称</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">境界</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">悟道状态</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">悟道模式</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">瓶颈状态</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">瓶颈进度</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">失败次数</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">今日悟道</th>
              <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            <!-- 加载中 -->
            <tr v-if="loading" class="text-center text-gray-500">
              <td colspan="10" class="px-3 py-6">加载中...</td>
            </tr>
            <!-- 空数据 -->
            <tr v-else-if="playerList.length === 0" class="text-center text-gray-500">
              <td colspan="10" class="px-3 py-6">暂无数据</td>
            </tr>
            <!-- 数据行 -->
            <tr
              v-for="p in playerList"
              :key="p.id"
              class="border-t border-gray-700 hover:bg-gray-750"
            >
              <td class="px-3 py-2 text-gray-400">{{ p.id }}</td>
              <td class="px-3 py-2 text-white">{{ p.nickname }}</td>
              <td class="px-3 py-2 text-gray-300 text-xs">{{ p.realm }}</td>
              <td class="px-3 py-2">
                <span
                  :class="p.is_meditating ? 'bg-amber-900 text-amber-300' : 'bg-gray-700 text-gray-400'"
                  class="px-2 py-0.5 rounded text-xs"
                >{{ p.is_meditating ? '悟道中' : '空闲' }}</span>
              </td>
              <td class="px-3 py-2 text-xs">
                <span :class="p.meditation_mode === 'deep' ? 'text-purple-300' : 'text-gray-300'">
                  {{ modeLabel(p.meditation_mode) }}
                </span>
              </td>
              <td class="px-3 py-2">
                <span
                  :class="bottleneckStateClass(p.bottleneck_state)"
                  class="px-2 py-0.5 rounded text-xs"
                >{{ bottleneckStateLabel(p.bottleneck_state) }}</span>
              </td>
              <td class="px-3 py-2 text-xs">
                <span v-if="p.bottleneck_state !== 'none'" class="text-rose-300">
                  {{ p.bottleneck_insight }} / {{ p.bottleneck_threshold }}
                </span>
                <span v-else class="text-gray-500">-</span>
              </td>
              <td class="px-3 py-2 text-xs">
                <span v-if="p.breakthrough_failure_count > 0" class="text-amber-400">{{ p.breakthrough_failure_count }}</span>
                <span v-else class="text-gray-500">0</span>
              </td>
              <td class="px-3 py-2 text-xs text-gray-300">
                常规 {{ p.daily_meditation_count }} / 深度 {{ p.daily_deep_meditation_count }}
              </td>
              <td class="px-3 py-2 text-center whitespace-nowrap">
                <button
                  @click="openDetailModal(p)"
                  class="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs mr-1"
                >详情</button>
                <button
                  v-if="p.is_meditating"
                  @click="openForceSettleModal(p)"
                  class="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-white text-xs mr-1"
                >强制结算</button>
                <button
                  v-if="p.is_meditating"
                  @click="openForceInterruptModal(p)"
                  class="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-xs mr-1"
                >强制中断</button>
                <button
                  @click="openBottleneckModal(p)"
                  class="px-2 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white text-xs mr-1"
                >瓶颈</button>
                <button
                  @click="openResetBottleneckModal(p)"
                  class="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-white text-xs"
                >重置瓶颈</button>
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

    <!-- 玩家详情弹窗 -->
    <Modal :isOpen="!!detailPlayer" title="玩家悟道详情" width="600px" @close="detailPlayer = null">
      <div v-if="detailPlayer" class="space-y-3 text-sm">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-gray-400 mb-1">玩家ID</label>
            <div class="text-white">{{ detailPlayer.id }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">昵称</label>
            <div class="text-white">{{ detailPlayer.nickname }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">境界</label>
            <div class="text-white">{{ detailPlayer.realm }} (rank {{ detailPlayer.realm_rank }})</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">修为</label>
            <div class="text-white font-mono">{{ detailPlayer.exp }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">悟道状态</label>
            <div :class="detailPlayer.is_meditating ? 'text-amber-400' : 'text-gray-400'">
              {{ detailPlayer.is_meditating ? `悟道中（${modeLabel(detailPlayer.meditation_mode)}）` : '空闲' }}
            </div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">悟道时长</label>
            <div class="text-white">{{ detailPlayer.meditation_duration || 0 }} 秒</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">当前感悟值</label>
            <div class="text-amber-400 font-bold">{{ detailPlayer.meditation_insight || 0 }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">今日已用</label>
            <div class="text-white">常规 {{ detailPlayer.daily_meditation_count }} / 深度 {{ detailPlayer.daily_deep_meditation_count }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">瓶颈状态</label>
            <div :class="bottleneckStateTextClass(detailPlayer.bottleneck_state)">
              {{ bottleneckStateLabel(detailPlayer.bottleneck_state) }}
            </div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">瓶颈进度</label>
            <div class="text-white">{{ detailPlayer.bottleneck_insight || 0 }} / {{ detailPlayer.bottleneck_threshold || 100 }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">突破失败次数</label>
            <div class="text-amber-400">{{ detailPlayer.breakthrough_failure_count || 0 }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">瓶颈开始时间</label>
            <div class="text-white text-xs">{{ formatDate(detailPlayer.bottleneck_started_at) || '-' }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">上次悟道时间</label>
            <div class="text-white text-xs">{{ formatDate(detailPlayer.last_meditation_time) || '-' }}</div>
          </div>
        </div>
      </div>
      <template #footer>
        <button @click="detailPlayer = null" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">关闭</button>
      </template>
    </Modal>

    <!-- 修改瓶颈状态弹窗 -->
    <Modal :isOpen="!!bottleneckEditing" title="修改瓶颈状态" width="500px" @close="bottleneckEditing = null">
      <div v-if="bottleneckEditing" class="space-y-3 text-sm">
        <p class="text-gray-300">玩家：<span class="text-amber-400">{{ bottleneckEditing.nickname }} (ID: {{ bottleneckEditing.id }})</span></p>
        <div>
          <label class="block text-gray-400 mb-1">瓶颈状态</label>
          <select v-model="bottleneckForm.bottleneck_state" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="none">none（无瓶颈）</option>
            <option value="active">active（处于瓶颈期）</option>
            <option value="broken">broken（已破除，可突破）</option>
            <option value="failed">failed（突破失败待重试）</option>
          </select>
        </div>
        <div>
          <label class="block text-gray-400 mb-1">瓶颈感悟值</label>
          <input v-model.number="bottleneckForm.bottleneck_insight" type="number" min="0" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          <p class="mt-1 text-xs text-gray-500">范围：0 ~ {{ bottleneckForm.bottleneck_threshold || 100 }}</p>
        </div>
        <div>
          <label class="block text-gray-400 mb-1">瓶颈阈值</label>
          <input v-model.number="bottleneckForm.bottleneck_threshold" type="number" min="1" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
        <div>
          <label class="block text-gray-400 mb-1">突破失败次数</label>
          <input v-model.number="bottleneckForm.breakthrough_failure_count" type="number" min="0" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
      </div>
      <template #footer>
        <button @click="bottleneckEditing = null" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="submitBottleneckEdit" :disabled="operating" class="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded disabled:opacity-50">
          {{ operating ? '保存中...' : '保存' }}
        </button>
      </template>
    </Modal>

    <!-- 确认操作弹窗 -->
    <Modal :isOpen="confirmDialog.show" title="确认操作" width="420px" @close="confirmDialog.show = false">
      <p class="text-gray-300 whitespace-pre-line">{{ confirmDialog.message }}</p>
      <template #footer>
        <button @click="confirmDialog.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="confirmDialogAction" :disabled="operating" class="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded disabled:opacity-50">
          {{ operating ? '执行中...' : '确认' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * 悟道与瓶颈管理组件（GM 后台）
 *
 * 功能：
 *   1. 展示悟道与瓶颈系统的统计指标
 *   2. 分页查询悟道/瓶颈玩家列表
 *   3. 查看玩家悟道详情
 *   4. 强制结算/中断玩家悟道
 *   5. 修改玩家瓶颈状态（用于测试和补偿）
 *   6. 重置玩家瓶颈
 *
 * 所有操作均通过 admin_meditation API 调用后端，前端只做展示与接口调用。
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
import {
  getMetrics,
  getList,
  getPlayerDetail,
  forceSettle,
  forceInterrupt,
  updateBottleneck,
  resetBottleneck
} from '../../../api/admin_meditation'

const uiStore = useUIStore()

// ====== 响应式状态 ======
const loading = ref(false)
const operating = ref(false)
const metrics = ref(null)
const playerList = ref([])
const pagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
})
const searchParams = reactive({
  filter: 'all'
})

// 弹窗状态
const detailPlayer = ref(null)
const bottleneckEditing = ref(null)
const bottleneckForm = reactive({
  bottleneck_state: 'none',
  bottleneck_insight: 0,
  bottleneck_threshold: 100,
  breakthrough_failure_count: 0
})

// 确认弹窗
const confirmDialog = reactive({
  show: false,
  message: '',
  action: null
})

// ====== 方法 ======

/**
 * 拉取统计指标
 */
const fetchMetrics = async () => {
  try {
    const res = await getMetrics()
    metrics.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取指标失败:', err)
    uiStore.showToast('获取指标失败', 'error')
  }
}

/**
 * 拉取玩家列表
 */
const fetchList = async (page = 1) => {
  if (page < 1) page = 1
  loading.value = true
  try {
    const res = await getList({
      filter: searchParams.filter,
      page,
      limit: pagination.pageSize
    })
    const data = res.data?.data || res.data
    playerList.value = data.list || []
    pagination.total = data.total || 0
    pagination.page = data.page || page
    pagination.totalPages = Math.ceil(pagination.total / pagination.pageSize) || 1
  } catch (err) {
    console.error('获取列表失败:', err)
    uiStore.showToast('获取列表失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 搜索
 */
const handleSearch = () => {
  fetchList(1)
}

/**
 * 重置搜索
 */
const resetSearch = () => {
  searchParams.filter = 'all'
  fetchList(1)
}

/**
 * 打开详情弹窗
 */
const openDetailModal = async (player) => {
  try {
    const res = await getPlayerDetail(player.id)
    detailPlayer.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取详情失败:', err)
    uiStore.showToast('获取详情失败', 'error')
  }
}

/**
 * 打开强制结算确认弹窗
 */
const openForceSettleModal = (player) => {
  confirmDialog.message = `确定要强制结算玩家 ${player.nickname} (ID: ${player.id}) 的悟道吗？\n\n强制结算无惩罚，相当于悟道自动到期。`
  confirmDialog.action = async () => {
    operating.value = true
    try {
      const res = await forceSettle(player.id)
      const data = res.data?.data || res.data
      uiStore.showToast(`已强制结算，获得感悟 ${data?.insight_gain || 0} 点`, 'success')
      confirmDialog.show = false
      await fetchList(pagination.page)
      await fetchMetrics()
    } catch (err) {
      const msg = err?.response?.data?.message || '强制结算失败'
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  }
  confirmDialog.show = true
}

/**
 * 打开强制中断确认弹窗
 */
const openForceInterruptModal = (player) => {
  confirmDialog.message = `确定要强制中断玩家 ${player.nickname} (ID: ${player.id}) 的悟道吗？\n\n强制中断将带惩罚，仅按完成度比例发放感悟值。`
  confirmDialog.action = async () => {
    operating.value = true
    try {
      const res = await forceInterrupt(player.id)
      const data = res.data?.data || res.data
      uiStore.showToast(`已强制中断，获得感悟 ${data?.insight_gain || 0} 点`, 'warning')
      confirmDialog.show = false
      await fetchList(pagination.page)
      await fetchMetrics()
    } catch (err) {
      const msg = err?.response?.data?.message || '强制中断失败'
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  }
  confirmDialog.show = true
}

/**
 * 打开修改瓶颈弹窗
 */
const openBottleneckModal = (player) => {
  bottleneckEditing.value = player
  bottleneckForm.bottleneck_state = player.bottleneck_state || 'none'
  bottleneckForm.bottleneck_insight = player.bottleneck_insight || 0
  bottleneckForm.bottleneck_threshold = player.bottleneck_threshold || 100
  bottleneckForm.breakthrough_failure_count = player.breakthrough_failure_count || 0
}

/**
 * 提交瓶颈修改
 */
const submitBottleneckEdit = async () => {
  if (!bottleneckEditing.value) return
  operating.value = true
  try {
    await updateBottleneck(bottleneckEditing.value.id, {
      bottleneck_state: bottleneckForm.bottleneck_state,
      bottleneck_insight: bottleneckForm.bottleneck_insight,
      bottleneck_threshold: bottleneckForm.bottleneck_threshold,
      breakthrough_failure_count: bottleneckForm.breakthrough_failure_count
    })
    uiStore.showToast('瓶颈状态已更新', 'success')
    bottleneckEditing.value = null
    await fetchList(pagination.page)
    await fetchMetrics()
  } catch (err) {
    const msg = err?.response?.data?.message || '修改失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 打开重置瓶颈确认弹窗
 */
const openResetBottleneckModal = (player) => {
  confirmDialog.message = `确定要重置玩家 ${player.nickname} (ID: ${player.id}) 的瓶颈状态吗？\n\n将清空所有瓶颈字段：状态归零、感悟值清零、失败次数清零。`
  confirmDialog.action = async () => {
    operating.value = true
    try {
      await resetBottleneck(player.id)
      uiStore.showToast('瓶颈状态已重置', 'success')
      confirmDialog.show = false
      await fetchList(pagination.page)
      await fetchMetrics()
    } catch (err) {
      const msg = err?.response?.data?.message || '重置失败'
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  }
  confirmDialog.show = true
}

/**
 * 确认弹窗执行动作
 */
const confirmDialogAction = () => {
  if (confirmDialog.action) {
    confirmDialog.action()
  }
}

// ====== 工具函数 ======

/**
 * 悟道模式中文标签
 */
const modeLabel = (mode) => {
  if (!mode) return '-'
  const map = {
    short: '静思一刻',
    medium: '凝神悟道',
    long: '闭关参悟',
    deep: '深度悟道'
  }
  return map[mode] || mode
}

/**
 * 瓶颈状态中文标签
 */
const bottleneckStateLabel = (state) => {
  const map = {
    none: '无瓶颈',
    active: '瓶颈期',
    broken: '已破除',
    failed: '失败待重试'
  }
  return map[state] || state
}

/**
 * 瓶颈状态徽章样式
 */
const bottleneckStateClass = (state) => {
  const map = {
    none: 'bg-gray-700 text-gray-300',
    active: 'bg-rose-900 text-rose-300',
    broken: 'bg-emerald-900 text-emerald-300',
    failed: 'bg-amber-900 text-amber-300'
  }
  return map[state] || 'bg-gray-700 text-gray-300'
}

/**
 * 瓶颈状态文字样式
 */
const bottleneckStateTextClass = (state) => {
  const map = {
    none: 'text-gray-300',
    active: 'text-rose-400',
    broken: 'text-emerald-400',
    failed: 'text-amber-400'
  }
  return map[state] || 'text-gray-300'
}

/**
 * 格式化日期
 */
const formatDate = (dateStr) => {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return dateStr
  }
}

onMounted(() => {
  fetchMetrics()
  fetchList(1)
})
</script>

<style scoped>
</style>
