<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex flex-wrap justify-between items-center gap-2">
      <h3 class="text-lg font-bold text-white">宗门战/领地争夺管理</h3>
      <div class="flex flex-wrap space-x-2">
        <!-- 刷新当前 Tab 数据 -->
        <button @click="refreshCurrent"
          class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新列表</button>
        <!-- 重新拉取统计指标 -->
        <button @click="fetchMetrics"
          class="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white text-sm">更新指标</button>
        <!-- 打开创建赛季弹窗 -->
        <button @click="openCreateSeasonModal"
          class="px-3 py-1 bg-amber-600 hover:bg-amber-500 rounded text-white text-sm">创建赛季</button>
        <!-- 打开初始化资源点弹窗（手动输入赛季ID） -->
        <button @click="openInitTerritoryModal"
          class="px-3 py-1 bg-fuchsia-700 hover:bg-fuchsia-600 rounded text-white text-sm">初始化资源点</button>
        <!-- 手动触发产出结算（二次确认） -->
        <button @click="confirmSettleProduction" :disabled="operating"
          class="px-3 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-sm disabled:opacity-50">手动产出结算</button>
      </div>
    </div>

    <!-- 统计指标卡片（4列网格） -->
    <div v-if="metrics" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <!-- 活跃战役数（红色） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">活跃战役</div>
        <div class="text-2xl font-bold text-red-400">{{ metrics.active_war_count }}</div>
        <div class="text-[10px] text-gray-500 mt-1">筹备+宣告+战斗中</div>
      </div>
      <!-- 资源点占领（紫色，显示 已占领/总数） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">资源点占领</div>
        <div class="text-2xl font-bold text-purple-400">
          {{ metrics.occupied_territory_count }}
          <span class="text-sm text-gray-500">/ {{ metrics.total_territory_count }}</span>
        </div>
        <div class="text-[10px] text-gray-500 mt-1">已占领/总资源点</div>
      </div>
      <!-- 活跃赛季数（青色） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">活跃赛季</div>
        <div class="text-2xl font-bold text-cyan-400">{{ metrics.active_season_count }}</div>
        <div class="text-[10px] text-gray-500 mt-1">进行中的赛季数</div>
      </div>
      <!-- 总赛季数（橙色） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">总赛季数</div>
        <div class="text-2xl font-bold text-orange-400">{{ metrics.total_season_count }}</div>
        <div class="text-[10px] text-gray-500 mt-1">历史赛季累计</div>
      </div>
    </div>

    <!-- 子 Tab 切换：战役列表 / 赛季列表 -->
    <div class="flex border-b border-gray-700 bg-gray-800/50">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        @click="switchTab(tab.id)"
        class="px-6 py-2 text-sm font-medium transition-colors relative whitespace-nowrap cursor-pointer"
        :class="currentSubTab === tab.id ? 'text-purple-400' : 'text-gray-400 hover:text-white hover:bg-gray-700/50'"
      >
        {{ tab.name }}
        <div v-if="currentSubTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-purple-500"></div>
      </button>
    </div>

    <!-- 子 Tab 1：战役列表 -->
    <div v-if="currentSubTab === 'wars'">
      <!-- 筛选区 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-3">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">状态：</label>
            <select v-model="warSearchParams.status"
              class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">全部</option>
              <option value="preparing">筹备中</option>
              <option value="announced">已宣告</option>
              <option value="active">战斗中</option>
              <option value="settled">已结算</option>
            </select>
          </div>
          <button @click="handleWarSearch"
            class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">查询</button>
          <button @click="resetWarSearch"
            class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
        </div>
      </div>

      <!-- 战役列表表格 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">战役ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">赛季ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">进攻方宗门</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">防守方宗门</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">目标资源点</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">状态</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">胜方</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">开战时间</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">参战人数(攻/守)</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <!-- 加载中提示 -->
              <tr v-if="warLoading" class="text-center text-gray-500">
                <td colspan="10" class="px-3 py-6">加载中...</td>
              </tr>
              <!-- 空数据提示 -->
              <tr v-else-if="warList.length === 0" class="text-center text-gray-500">
                <td colspan="10" class="px-3 py-6">暂无数据</td>
              </tr>
              <!-- 数据行 -->
              <tr v-for="w in warList" :key="w.war_id"
                class="border-t border-gray-700 hover:bg-gray-750">
                <td class="px-3 py-2 text-gray-400">{{ w.war_id }}</td>
                <td class="px-3 py-2 text-gray-400">{{ w.season_id }}</td>
                <td class="px-3 py-2 text-cyan-300 text-xs">{{ w.attacker_sect_name || ('#' + w.attacker_sect_id) }}</td>
                <td class="px-3 py-2 text-red-300 text-xs">{{ w.defender_sect_name || ('#' + w.defender_sect_id) }}</td>
                <td class="px-3 py-2 text-amber-300 text-xs">
                  <span v-if="w.target_territory_id">{{ w.target_territory_name || ('#' + w.target_territory_id) }}</span>
                  <span v-else class="text-gray-600">-</span>
                </td>
                <td class="px-3 py-2">
                  <span :class="warStatusColor[w.status] || 'bg-gray-700 text-gray-300'"
                    class="px-2 py-0.5 rounded text-xs">{{ warStatusLabel[w.status] || w.status }}</span>
                </td>
                <td class="px-3 py-2 text-xs">
                  <span v-if="w.winner_sect_id === null" class="text-gray-600">-</span>
                  <span v-else-if="w.winner_sect_id === w.attacker_sect_id" class="text-cyan-400">攻方</span>
                  <span v-else class="text-red-400">守方</span>
                </td>
                <td class="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{{ formatDate(w.start_time) }}</td>
                <td class="px-3 py-2 text-xs">
                  <span class="text-cyan-300">{{ w.attacker_count }}</span>
                  <span class="text-gray-600 mx-1">/</span>
                  <span class="text-red-300">{{ w.defender_count }}</span>
                </td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <!-- 仅对 preparing/announced/active 显示推进按钮，settled 不显示 -->
                  <button v-if="w.status !== 'settled'" @click="confirmAdvanceWar(w)"
                    class="px-2 py-1 bg-purple-700 hover:bg-purple-600 rounded text-white text-xs">推进状态</button>
                  <span v-else class="text-gray-600 text-xs">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-gray-700 flex items-center justify-between text-sm">
          <div class="text-gray-400">共 {{ warPagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button @click="fetchWarList(warPagination.page - 1)"
              :disabled="warPagination.page <= 1 || warLoading"
              class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
            <span class="text-gray-300">{{ warPagination.page }} / {{ warPagination.totalPages }}</span>
            <button @click="fetchWarList(warPagination.page + 1)"
              :disabled="warPagination.page >= warPagination.totalPages || warLoading"
              class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 子 Tab 2：赛季列表 -->
    <div v-else-if="currentSubTab === 'seasons'">
      <!-- 赛季列表表格 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">赛季ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">赛季名称</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">状态</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">起止时间</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">战役进度(已结算/总数)</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">参战宗门数</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <!-- 加载中提示 -->
              <tr v-if="seasonLoading" class="text-center text-gray-500">
                <td colspan="7" class="px-3 py-6">加载中...</td>
              </tr>
              <!-- 空数据提示 -->
              <tr v-else-if="seasonList.length === 0" class="text-center text-gray-500">
                <td colspan="7" class="px-3 py-6">暂无数据</td>
              </tr>
              <!-- 数据行 -->
              <tr v-for="s in seasonList" :key="s.season_id"
                class="border-t border-gray-700 hover:bg-gray-750">
                <td class="px-3 py-2 text-gray-400">{{ s.season_id }}</td>
                <td class="px-3 py-2 text-white">{{ s.season_name }}</td>
                <td class="px-3 py-2">
                  <span :class="seasonStatusColor[s.status] || 'bg-gray-700 text-gray-300'"
                    class="px-2 py-0.5 rounded text-xs">{{ seasonStatusLabel[s.status] || s.status }}</span>
                </td>
                <td class="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">
                  {{ formatDate(s.start_date) }} ~ {{ formatDate(s.end_date) }}
                </td>
                <td class="px-3 py-2 text-xs">
                  <span class="text-emerald-300">{{ s.settled_wars }}</span>
                  <span class="text-gray-600 mx-1">/</span>
                  <span class="text-gray-300">{{ s.total_wars }}</span>
                </td>
                <td class="px-3 py-2 text-amber-300">{{ s.total_sects }}</td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <!-- 仅对 active 显示强制结算与初始化资源点按钮 -->
                  <template v-if="s.status === 'active'">
                    <button @click="confirmSettleSeason(s)"
                      class="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-xs mr-1">强制结算</button>
                    <button @click="confirmInitTerritoryFromRow(s)"
                      class="px-2 py-1 bg-fuchsia-700 hover:bg-fuchsia-600 rounded text-white text-xs">初始化资源点</button>
                  </template>
                  <span v-else class="text-gray-600 text-xs">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-gray-700 flex items-center justify-between text-sm">
          <div class="text-gray-400">共 {{ seasonPagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button @click="fetchSeasonList(seasonPagination.page - 1)"
              :disabled="seasonPagination.page <= 1 || seasonLoading"
              class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
            <span class="text-gray-300">{{ seasonPagination.page }} / {{ seasonPagination.totalPages }}</span>
            <button @click="fetchSeasonList(seasonPagination.page + 1)"
              :disabled="seasonPagination.page >= seasonPagination.totalPages || seasonLoading"
              class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 弹窗1：创建赛季弹窗 -->
    <Modal :isOpen="createSeasonShow" title="创建新赛季" width="500px" @close="closeCreateSeasonModal">
      <div class="space-y-3 text-sm">
        <!-- 赛季名称 -->
        <div>
          <label class="block text-gray-400 mb-1">赛季名称 <span class="text-rose-400">*</span></label>
          <input v-model="createSeasonForm.season_name" type="text" maxlength="64"
            placeholder="例如：甲辰年宗门大战"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
        <!-- 开始日期 -->
        <div>
          <label class="block text-gray-400 mb-1">开始日期 <span class="text-rose-400">*</span></label>
          <input v-model="createSeasonForm.start_date" type="date"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          <div class="text-[10px] text-gray-500 mt-1">格式：YYYY-MM-DD</div>
        </div>
        <!-- 结束日期 -->
        <div>
          <label class="block text-gray-400 mb-1">结束日期 <span class="text-rose-400">*</span></label>
          <input v-model="createSeasonForm.end_date" type="date"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          <div class="text-[10px] text-gray-500 mt-1">格式：YYYY-MM-DD，必须晚于开始日期</div>
        </div>
      </div>
      <template #footer>
        <button @click="closeCreateSeasonModal"
          class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="submitCreateSeason" :disabled="operating"
          class="px-4 py-2 bg-amber-700 hover:bg-amber-600 text-white rounded disabled:opacity-50">
          {{ operating ? '创建中...' : '确认创建' }}
        </button>
      </template>
    </Modal>

    <!-- 弹窗2：初始化资源点弹窗（手动输入赛季ID） -->
    <Modal :isOpen="initTerritoryShow" title="初始化资源点" width="500px" @close="closeInitTerritoryModal">
      <div class="space-y-3 text-sm">
        <!-- 赛季ID输入 -->
        <div>
          <label class="block text-gray-400 mb-1">赛季ID <span class="text-rose-400">*</span></label>
          <input v-model.number="initTerritoryForm.season_id" type="number" min="1"
            placeholder="请输入要初始化资源点的赛季ID"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
        <!-- 警告提示 -->
        <p class="text-rose-400 text-xs mt-2">
          ⚠️ 此操作会清空当前赛季所有资源点的归属，并按配置重新生成资源点初始状态。请谨慎操作。
        </p>
      </div>
      <template #footer>
        <button @click="closeInitTerritoryModal"
          class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="submitInitTerritory" :disabled="operating"
          class="px-4 py-2 bg-fuchsia-700 hover:bg-fuchsia-600 text-white rounded disabled:opacity-50">
          {{ operating ? '执行中...' : '确认初始化' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * GM 后台宗门战/领地争夺管理子组件（批次2新增）
 * 功能：统计指标、战役列表查询、赛季列表查询、创建赛季、强制结算赛季、推进战役状态、初始化资源点、手动产出结算
 * 参考：server/routes/admin_sect_war.js
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
import {
  getMetrics,
  getWarList,
  getSeasonList,
  createSeason,
  settleSeason,
  advanceWarStatus,
  initializeTerritories,
  settleProduction
} from '../../../api/admin_sect_war'

// 向父组件 AdminPanel 抛出 showConfirm 事件，由父组件统一显示确认弹窗
const emit = defineEmits(['showConfirm'])

// UI store 用于显示 toast 提示
const uiStore = useUIStore()

// ====== 状态颜色与标签映射（避免重复 if/else，统一常量对象） ======

/** 战役状态徽章颜色映射 */
const warStatusColor = {
  preparing: 'bg-gray-700 text-gray-300',
  announced: 'bg-yellow-900 text-yellow-300',
  active: 'bg-red-900 text-red-300',
  settled: 'bg-green-900 text-green-300'
}

/** 战役状态中文标签映射 */
const warStatusLabel = {
  preparing: '筹备中',
  announced: '已宣告',
  active: '战斗中',
  settled: '已结算'
}

/** 赛季状态徽章颜色映射 */
const seasonStatusColor = {
  pending: 'bg-gray-700 text-gray-300',
  active: 'bg-green-900 text-green-300',
  ended: 'bg-yellow-900 text-yellow-300'
}

/** 赛季状态中文标签映射 */
const seasonStatusLabel = {
  pending: '未开始',
  active: '进行中',
  ended: '已结束'
}

// ====== 响应式状态 ======

/** 全局操作 loading 标记（用于弹窗按钮防抖） */
const operating = ref(false)
/** 统计指标数据 */
const metrics = ref(null)

/** 子 Tab 配置：战役列表 / 赛季列表 */
const subTabs = [
  { id: 'wars', name: '战役列表' },
  { id: 'seasons', name: '赛季列表' }
]
/** 当前激活的子 Tab，默认展示战役列表 */
const currentSubTab = ref('wars')

// ====== 战役列表状态 ======

/** 战役列表加载中标记 */
const warLoading = ref(false)
/** 战役列表数据 */
const warList = ref([])
/** 战役列表分页参数（默认 pageSize=10） */
const warPagination = reactive({
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1
})
/** 战役列表筛选参数（仅状态一项） */
const warSearchParams = reactive({
  status: ''
})

// ====== 赛季列表状态 ======

/** 赛季列表加载中标记 */
const seasonLoading = ref(false)
/** 赛季列表数据 */
const seasonList = ref([])
/** 赛季列表分页参数（默认 pageSize=10） */
const seasonPagination = reactive({
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1
})

// ====== 弹窗状态：创建赛季 ======

/** 创建赛季弹窗显示标记 */
const createSeasonShow = ref(false)
/** 创建赛季表单数据 */
const createSeasonForm = reactive({
  season_name: '',
  start_date: '',
  end_date: ''
})

// ====== 弹窗状态：初始化资源点（手动输入赛季ID） ======

/** 初始化资源点弹窗显示标记 */
const initTerritoryShow = ref(false)
/** 初始化资源点表单数据（仅需赛季ID） */
const initTerritoryForm = reactive({
  season_id: null
})

// ====== 数据拉取方法 ======

/**
 * 拉取宗门战系统统计指标
 * 调用 GET /admin/sect-war/metrics
 */
const fetchMetrics = async () => {
  try {
    const res = await getMetrics()
    // 兼容 axios 响应结构 data.data 与直接 data 两种返回
    metrics.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取宗门战指标失败:', err)
    uiStore.showToast('获取宗门战指标失败', 'error')
  }
}

/**
 * 拉取战役列表
 * 调用 GET /admin/sect-war/wars
 * @param {number} page 页码，默认 1
 */
const fetchWarList = async (page = 1) => {
  if (page < 1) page = 1
  warLoading.value = true
  try {
    // 仅在指定状态时传递 status 参数
    const status = warSearchParams.status || undefined
    const res = await getWarList(page, warPagination.pageSize, status)
    const data = res.data?.data || res.data
    warList.value = data.list || data.items || []
    warPagination.total = data.total || 0
    warPagination.page = data.page || page
    warPagination.totalPages = Math.ceil(warPagination.total / warPagination.pageSize) || 1
  } catch (err) {
    console.error('获取战役列表失败:', err)
    uiStore.showToast('获取战役列表失败', 'error')
  } finally {
    warLoading.value = false
  }
}

/**
 * 拉取赛季列表
 * 调用 GET /admin/sect-war/seasons
 * @param {number} page 页码，默认 1
 */
const fetchSeasonList = async (page = 1) => {
  if (page < 1) page = 1
  seasonLoading.value = true
  try {
    const res = await getSeasonList(page, seasonPagination.pageSize)
    const data = res.data?.data || res.data
    seasonList.value = data.list || data.items || []
    seasonPagination.total = data.total || 0
    seasonPagination.page = data.page || page
    seasonPagination.totalPages = Math.ceil(seasonPagination.total / seasonPagination.pageSize) || 1
  } catch (err) {
    console.error('获取赛季列表失败:', err)
    uiStore.showToast('获取赛季列表失败', 'error')
  } finally {
    seasonLoading.value = false
  }
}

// ====== Tab 切换与刷新 ======

/**
 * 切换子 Tab，切换到赛季列表时按需加载
 * @param {string} tabId 子 Tab ID（wars / seasons）
 */
const switchTab = (tabId) => {
  currentSubTab.value = tabId
  // 切换到赛季列表且尚未加载过时主动拉取
  if (tabId === 'seasons' && seasonList.value.length === 0) {
    fetchSeasonList(1)
  }
}

/**
 * 刷新当前 Tab 数据（顶部"刷新列表"按钮）
 */
const refreshCurrent = () => {
  if (currentSubTab.value === 'wars') {
    fetchWarList(warPagination.page)
  } else if (currentSubTab.value === 'seasons') {
    fetchSeasonList(seasonPagination.page)
  }
}

// ====== 战役列表筛选 ======

/**
 * 战役列表查询（重置到第一页）
 */
const handleWarSearch = () => {
  fetchWarList(1)
}

/**
 * 重置战役列表筛选条件并重新查询
 */
const resetWarSearch = () => {
  warSearchParams.status = ''
  fetchWarList(1)
}

// ====== 创建赛季 ======

/**
 * 打开创建赛季弹窗，重置表单
 */
const openCreateSeasonModal = () => {
  createSeasonForm.season_name = ''
  createSeasonForm.start_date = ''
  createSeasonForm.end_date = ''
  createSeasonShow.value = true
}

/**
 * 关闭创建赛季弹窗
 */
const closeCreateSeasonModal = () => {
  createSeasonShow.value = false
}

/**
 * 提交创建赛季
 * 校验赛季名称、日期格式与起止关系后调用 POST /admin/sect-war/season/create
 */
const submitCreateSeason = async () => {
  // 参数校验：赛季名称非空
  if (!createSeasonForm.season_name || !createSeasonForm.season_name.trim()) {
    uiStore.showToast('请输入赛季名称', 'warning')
    return
  }
  // 参数校验：起止日期非空
  if (!createSeasonForm.start_date || !createSeasonForm.end_date) {
    uiStore.showToast('请选择起止日期', 'warning')
    return
  }
  // 参数校验：日期格式 YYYY-MM-DD
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(createSeasonForm.start_date) || !dateRegex.test(createSeasonForm.end_date)) {
    uiStore.showToast('日期格式错误，需为 YYYY-MM-DD', 'warning')
    return
  }
  // 参数校验：起始日期必须早于结束日期
  if (new Date(createSeasonForm.start_date) >= new Date(createSeasonForm.end_date)) {
    uiStore.showToast('起始日期必须早于结束日期', 'warning')
    return
  }

  operating.value = true
  try {
    const res = await createSeason({
      season_name: createSeasonForm.season_name.trim(),
      start_date: createSeasonForm.start_date,
      end_date: createSeasonForm.end_date
    })
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '赛季创建成功', 'success')
    closeCreateSeasonModal()
    // 创建成功后刷新指标与赛季列表
    await fetchMetrics()
    await fetchSeasonList(1)
    // 自动切换到赛季列表 Tab，便于查看新建赛季
    currentSubTab.value = 'seasons'
  } catch (err) {
    console.error('创建赛季失败:', err)
    const msg = err?.response?.data?.message || '创建赛季失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== 初始化资源点（弹窗方式，手动输入赛季ID） ======

/**
 * 打开初始化资源点弹窗，重置表单
 */
const openInitTerritoryModal = () => {
  initTerritoryForm.season_id = null
  initTerritoryShow.value = true
}

/**
 * 关闭初始化资源点弹窗
 */
const closeInitTerritoryModal = () => {
  initTerritoryShow.value = false
}

/**
 * 提交初始化资源点（弹窗确认按钮）
 * 调用 POST /admin/sect-war/territories/initialize
 */
const submitInitTerritory = async () => {
  // 参数校验：赛季ID 必须为正整数
  if (!initTerritoryForm.season_id || initTerritoryForm.season_id <= 0 || !Number.isInteger(initTerritoryForm.season_id)) {
    uiStore.showToast('请输入有效的赛季ID（正整数）', 'warning')
    return
  }

  operating.value = true
  try {
    const res = await initializeTerritories(initTerritoryForm.season_id)
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '资源点已初始化', 'success')
    closeInitTerritoryModal()
    // 初始化资源点会影响指标中的占领数，刷新指标
    await fetchMetrics()
  } catch (err) {
    console.error('初始化资源点失败:', err)
    const msg = err?.response?.data?.message || '初始化资源点失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== 危险操作（通过 showConfirm emit 给父组件二次确认） ======

/**
 * 推进战役状态（行内按钮）
 * 通过 showConfirm 二次确认后调用 POST /admin/sect-war/wars/:warId/advance
 * @param {Object} war 战役行数据
 */
const confirmAdvanceWar = (war) => {
  emit('showConfirm', '推进战役状态', `确定要手动推进战役 #${war.war_id}（${war.attacker_sect_name} vs ${war.defender_sect_name}）的状态吗？`, async () => {
    operating.value = true
    try {
      const res = await advanceWarStatus(war.war_id)
      const data = res.data?.data || res.data
      uiStore.showToast(data?.message || '战役状态已推进', 'success')
      // 推进后刷新战役列表与指标
      await fetchWarList(warPagination.page)
      await fetchMetrics()
    } catch (err) {
      console.error('推进战役状态失败:', err)
      const msg = err?.response?.data?.message || '推进战役状态失败'
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  })
}

/**
 * 强制结算赛季（行内按钮，仅 active 赛季显示）
 * 通过 showConfirm 二次确认后调用 POST /admin/sect-war/season/:seasonId/settle
 * @param {Object} season 赛季行数据
 */
const confirmSettleSeason = (season) => {
  emit('showConfirm', '强制结算赛季', `确定要强制结算赛季「${season.season_name}」(#${season.season_id}) 吗？此操作将结束该赛季所有未结算战役，不可撤销。`, async () => {
    operating.value = true
    try {
      const res = await settleSeason(season.season_id)
      const data = res.data?.data || res.data
      uiStore.showToast(data?.message || '赛季已强制结算', 'success')
      // 结算后刷新赛季列表与指标
      await fetchSeasonList(seasonPagination.page)
      await fetchMetrics()
    } catch (err) {
      console.error('强制结算赛季失败:', err)
      const msg = err?.response?.data?.message || '强制结算赛季失败'
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  })
}

/**
 * 行内初始化资源点（仅 active 赛季显示，直接使用该行赛季ID）
 * 通过 showConfirm 二次确认后调用 POST /admin/sect-war/territories/initialize
 * @param {Object} season 赛季行数据
 */
const confirmInitTerritoryFromRow = (season) => {
  emit('showConfirm', '初始化资源点', `确定要初始化赛季「${season.season_name}」(#${season.season_id}) 的资源点吗？此操作会清空当前赛季所有资源点的归属，不可撤销。`, async () => {
    operating.value = true
    try {
      const res = await initializeTerritories(season.season_id)
      const data = res.data?.data || res.data
      uiStore.showToast(data?.message || '资源点已初始化', 'success')
      // 初始化资源点会影响指标中的占领数，刷新指标
      await fetchMetrics()
    } catch (err) {
      console.error('初始化资源点失败:', err)
      const msg = err?.response?.data?.message || '初始化资源点失败'
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  })
}

/**
 * 手动触发资源点产出结算（顶部按钮）
 * 通过 showConfirm 二次确认后调用 POST /admin/sect-war/production/settle
 */
const confirmSettleProduction = () => {
  emit('showConfirm', '手动产出结算', '确定要手动触发所有资源点的产出结算吗？此操作为应急用，正常情况下由定时任务自动执行，不可撤销。', async () => {
    operating.value = true
    try {
      const res = await settleProduction()
      const data = res.data?.data || res.data
      uiStore.showToast(data?.message || '产出结算已触发', 'success')
      // 产出结算不直接影响指标，但为保险起见刷新一次
      await fetchMetrics()
    } catch (err) {
      console.error('手动产出结算失败:', err)
      const msg = err?.response?.data?.message || '手动产出结算失败'
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  })
}

// ====== 工具函数 ======

/**
 * 格式化时间为 YYYY-MM-DD HH:mm
 * 兼容 ISO 字符串、日期对象、空值
 * @param {string|Date} dateStr 时间字符串或对象
 * @returns {string} 格式化后的时间字符串，空值返回空串
 */
const formatDate = (dateStr) => {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return String(dateStr)
    const yyyy = d.getFullYear()
    const MM = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const HH = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${yyyy}-${MM}-${dd} ${HH}:${mm}`
  } catch {
    return String(dateStr)
  }
}

// ====== 生命周期：组件挂载时自动拉取指标与战役列表 ======
onMounted(() => {
  fetchMetrics()
  fetchWarList(1)
})
</script>

<style scoped>
</style>
