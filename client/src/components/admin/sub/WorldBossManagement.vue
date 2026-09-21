<template>
  <div class="space-y-6">
    <!-- 顶部：标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-fg-primary">世界BOSS管理</h3>
      <div class="flex space-x-2">
        <button @click="refreshCurrent"
          class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-control text-fg-primary text-sm">刷新列表</button>
        <button @click="fetchMetrics"
          class="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded-control text-fg-primary text-sm">更新指标</button>
      </div>
    </div>

    <!-- 统计指标卡片（4列网格） -->
    <div v-if="metrics" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <!-- 活跃BOSS数（红色，危险主题） -->
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">活跃BOSS</div>
        <div class="text-2xl font-bold text-red-400 num">{{ metrics.active_boss_count }}</div>
        <div class="text-[10px] text-fg-faint mt-1">当前待激活/战斗中BOSS数</div>
      </div>
      <!-- 历史击杀BOSS数（紫色） -->
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">历史击杀</div>
        <div class="text-2xl font-bold text-purple-400 num">{{ metrics.total_bosses_killed }}</div>
        <div class="text-[10px] text-fg-faint mt-1">累计已击杀BOSS总数</div>
      </div>
      <!-- 活跃赛季数（青色） -->
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">活跃赛季</div>
        <div class="text-2xl font-bold text-cyan-400 num">{{ metrics.active_season_count }}</div>
        <div class="text-[10px] text-fg-faint mt-1">当前进行中赛季数</div>
      </div>
      <!-- 总赛季数（橙色） -->
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">总赛季数</div>
        <div class="text-2xl font-bold text-orange-400 num">{{ metrics.total_seasons }}</div>
        <div class="text-[10px] text-fg-faint mt-1">历史创建赛季总数</div>
      </div>
    </div>

    <!-- 子 Tab 切换：BOSS列表 / 赛季列表 -->
    <div class="flex border-b border-line bg-surface-raised/50">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        @click="switchTab(tab.id)"
        class="px-6 py-2 text-sm font-medium transition-colors relative whitespace-nowrap cursor-pointer"
        :class="currentSubTab === tab.id ? 'text-red-400' : 'text-fg-muted hover:text-fg-primary hover:bg-surface-hover/50'"
      >
        {{ tab.name }}
        <div v-if="currentSubTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-red-500"></div>
      </button>
    </div>

    <!-- 子 Tab 1：BOSS列表 -->
    <div v-if="currentSubTab === 'bosses'">
      <!-- 筛选区 + 手动刷新BOSS入口 -->
      <div class="bg-surface-raised rounded-lg border border-line p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-fg-muted whitespace-nowrap">状态：</label>
            <select v-model="bossSearchParams.status"
              class="px-3 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
              <option v-for="opt in BOSS_STATUS_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
          <button @click="handleBossSearch"
            class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-control text-fg-primary text-sm">查询</button>
          <AppButton variant="default" size="sm" @click="resetBossSearch">
            重置
          </AppButton>
          <div class="ml-auto">
            <AppButton variant="danger" size="sm" @click="openSpawnModal">
              手动刷新BOSS
            </AppButton>
          </div>
        </div>
      </div>

      <!-- BOSS列表表格 -->
      <div class="bg-surface-base rounded-lg border border-line overflow-hidden mt-3">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-surface-raised text-fg-muted">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">BOSS ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">BOSS名称</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">状态</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">当前HP/最大HP</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">阶段</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">所属赛季</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">参战人数</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">击杀者</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">生成时间</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="bossLoading" class="text-center text-fg-faint">
                <td colspan="10" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="bossList.length === 0" class="text-center text-fg-faint">
                <td colspan="10" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="b in bossList" :key="b.boss_id" class="border-t border-line-subtle hover:bg-surface-hover">
                <td class="px-3 py-2 text-fg-muted">{{ b.boss_id }}</td>
                <td class="px-3 py-2 text-fg-primary">
                  {{ b.boss_name }}
                  <div class="text-[10px] text-fg-faint">{{ b.boss_key }}</div>
                </td>
                <td class="px-3 py-2">
                  <span :class="bossStatusClass(b.status)" class="px-2 py-0.5 rounded text-xs">
                    {{ bossStatusLabel(b.status) }}
                  </span>
                </td>
                <td class="px-3 py-2">
                  <!-- HP 数值与百分比进度条（百分比由 hp_current / hp_max 现算，算不出则隐藏进度条） -->
                  <div class="text-xs text-fg-secondary whitespace-nowrap num">
                    {{ formatHp(b.hp_current) }} / {{ formatHp(b.hp_max) }}
                  </div>
                  <template v-if="hpPercentage(b) !== null">
                    <div class="mt-1 w-32 h-2 bg-surface-sunken rounded overflow-hidden">
                      <div class="h-full transition-all duration-300"
                        :class="hpBarClass(hpPercentage(b))"
                        :style="{ width: `${hpPercentage(b)}%` }"></div>
                    </div>
                    <div class="text-[10px] text-fg-faint mt-0.5">{{ hpPercentage(b) }}%</div>
                  </template>
                  <div v-else class="text-[10px] text-fg-faint mt-1">未知</div>
                </td>
                <td class="px-3 py-2 text-amber-300">{{ b.phase }}</td>
                <td class="px-3 py-2 text-fg-secondary">#{{ b.season_id }}</td>
                <td class="px-3 py-2 text-cyan-300">{{ b.participant_count }}</td>
                <td class="px-3 py-2 text-xs">
                  <span v-if="b.killer_player_id" class="text-emerald-300">
                    {{ b.killer_nickname || ('#' + b.killer_player_id) }}
                  </span>
                  <span v-else class="text-fg-faint">-</span>
                </td>
                <td class="px-3 py-2 text-xs text-fg-muted whitespace-nowrap num">{{ formatDate(b.spawn_time) }}</td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <!-- 强制过期按钮仅对 pending/active 显示 -->
                  <AppButton variant="danger" size="xs" v-if="b.status === 'pending' || b.status === 'active'" @click="handleExpireBoss(b)">
                    强制过期
                  </AppButton>
                  <span v-else class="text-fg-faint text-xs">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-line flex items-center justify-between text-sm">
          <div class="text-fg-muted num">共 {{ bossPagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <AppButton variant="default" size="sm" :disabled="bossPagination.page <= 1 || bossLoading" @click="fetchBossList(bossPagination.page - 1)">
              上一页
            </AppButton>
            <span class="text-fg-secondary num">{{ bossPagination.page }} / {{ bossPagination.totalPages }}</span>
            <AppButton variant="default" size="sm" :disabled="bossPagination.page >= bossPagination.totalPages || bossLoading" @click="fetchBossList(bossPagination.page + 1)">
              下一页
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 子 Tab 2：赛季列表 -->
    <div v-else-if="currentSubTab === 'seasons'">
      <!-- 顶部操作区：创建赛季入口 -->
      <div class="bg-surface-raised rounded-lg border border-line p-4">
        <div class="flex justify-end">
          <AppButton variant="danger" size="sm" @click="openCreateSeasonModal">
            创建赛季
          </AppButton>
        </div>
      </div>

      <!-- 赛季列表表格 -->
      <div class="bg-surface-base rounded-lg border border-line overflow-hidden mt-3">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-surface-raised text-fg-muted">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">赛季ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">赛季名称</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">状态</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">开始时间</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">结束时间</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">击杀BOSS数</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="seasonLoading" class="text-center text-fg-faint">
                <td colspan="7" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="seasonList.length === 0" class="text-center text-fg-faint">
                <td colspan="7" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="s in seasonList" :key="s.season_id" class="border-t border-line-subtle hover:bg-surface-hover">
                <td class="px-3 py-2 text-fg-muted">{{ s.season_id }}</td>
                <td class="px-3 py-2 text-fg-primary">{{ s.season_name }}</td>
                <td class="px-3 py-2">
                  <span :class="seasonStatusClass(s.status)" class="px-2 py-0.5 rounded text-xs">
                    {{ seasonStatusLabel(s.status) }}
                  </span>
                </td>
                <td class="px-3 py-2 text-xs text-fg-muted whitespace-nowrap num">{{ formatDate(s.start_date) }}</td>
                <td class="px-3 py-2 text-xs text-fg-muted whitespace-nowrap num">{{ formatDate(s.end_date) }}</td>
                <td class="px-3 py-2 text-emerald-300">{{ s.total_bosses_killed }}</td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <!-- 强制结算按钮仅对 active 状态显示 -->
                  <AppButton variant="danger" size="xs" v-if="s.status === 'active'" @click="handleSettleSeason(s)">
                    强制结算
                  </AppButton>
                  <span v-else class="text-fg-faint text-xs">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-line flex items-center justify-between text-sm">
          <div class="text-fg-muted num">共 {{ seasonPagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <AppButton variant="default" size="sm" :disabled="seasonPagination.page <= 1 || seasonLoading" @click="fetchSeasonList(seasonPagination.page - 1)">
              上一页
            </AppButton>
            <span class="text-fg-secondary num">{{ seasonPagination.page }} / {{ seasonPagination.totalPages }}</span>
            <AppButton variant="default" size="sm" :disabled="seasonPagination.page >= seasonPagination.totalPages || seasonLoading" @click="fetchSeasonList(seasonPagination.page + 1)">
              下一页
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 弹窗1：刷新BOSS弹窗 -->
    <Modal :isOpen="spawnModalShow" title="手动刷新BOSS" width="500px" @close="spawnModalShow = false">
      <div class="space-y-4 text-sm">
        <div>
          <label class="block text-fg-muted mb-1">BOSS key <span class="text-rose-400">*</span></label>
          <select v-model="spawnForm.boss_key"
            class="w-full px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
            <option value="" disabled>请选择BOSS</option>
            <option v-for="b in bossCatalog" :key="b.boss_key" :value="b.boss_key">{{ b.boss_name }}（{{ b.boss_key }}）</option>
          </select>
          <p class="mt-1 text-xs text-fg-faint">共 {{ bossCatalog.length }} 只，清单取自内容 world_boss_data.json</p>
        </div>
        <div>
          <label class="block text-fg-muted mb-1">自定义HP（可选）</label>
          <input v-model="spawnForm.custom_hp" type="text"
            class="w-full px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600"
            placeholder="留空则使用配置默认HP">
          <p class="mt-1 text-xs text-fg-faint">提示：HP为超大整数，请输入正整数字符串（如 1000000000000）</p>
        </div>
        <p class="text-amber-500 text-xs">⚠️ 手动刷新将立即生成一个新BOSS实例并加入当前活跃赛季。</p>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="spawnModalShow = false">取消</AppButton>
        <AppButton variant="danger" :disabled="operating" @click="submitSpawn">
          {{ operating ? '刷新中...' : '确认刷新' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 弹窗2：创建赛季弹窗 -->
    <Modal :isOpen="seasonModalShow" title="创建新赛季" width="500px" @close="seasonModalShow = false">
      <div class="space-y-4 text-sm">
        <div>
          <label class="block text-fg-muted mb-1">赛季名称 <span class="text-rose-400">*</span></label>
          <input v-model="seasonForm.season_name" type="text"
            class="w-full px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600"
            placeholder="例如：青元劫·第一赛季">
        </div>
        <div>
          <label class="block text-fg-muted mb-1">开始日期 <span class="text-rose-400">*</span></label>
          <input v-model="seasonForm.start_date" type="date"
            class="w-full px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
        </div>
        <div>
          <label class="block text-fg-muted mb-1">结束日期 <span class="text-rose-400">*</span></label>
          <input v-model="seasonForm.end_date" type="date"
            class="w-full px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
        </div>
        <p class="text-amber-500 text-xs">⚠️ 创建赛季后将在开始日期自动激活；结束日期后将自动结算。</p>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="seasonModalShow = false">取消</AppButton>
        <AppButton variant="danger" :disabled="operating" @click="submitCreateSeason">
          {{ operating ? '创建中...' : '确认创建' }}
        </AppButton>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * GM 后台世界BOSS管理子组件（批次2新增）
 * 功能：统计指标、BOSS列表查询、赛季列表查询、手动刷新BOSS、强制过期BOSS、创建赛季、强制结算赛季
 * 参考：server/routes/admin_world_boss.js
 *
 * 设计说明：
 *   1. 顶部展示统计指标（4列网格），危险主题用红色系强调
 *   2. 子 Tab 切换：BOSS列表 / 赛季列表
 *   3. 危险操作（强制过期/强制结算）通过 emit('showConfirm') 委托父组件 AdminPanel 做二次确认
 *   4. 创建/刷新操作使用项目通用 Modal 组件，禁用浏览器原生弹窗
 *   5. 所有接口调用均带 loading 状态与错误处理，错误信息通过 uiStore.showToast 反馈
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
import AppButton from '../../ui/AppButton.vue'
import {
  getMetrics,
  getBossList,
  getSeasonList,
  spawnBoss,
  expireBoss,
  createSeason,
  settleSeason
} from '../../../api/admin_world_boss'

// emit 定义：危险操作通过 showConfirm 委托父组件 AdminPanel 做二次确认
const emit = defineEmits(['showConfirm'])
const uiStore = useUIStore()

// ====== 常量配置（避免硬编码） ======

/**
 * BOSS 状态筛选选项（pending/active/defeated/expired）
 * value 为空表示"全部"
 */
const BOSS_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待激活' },
  { value: 'active', label: '战斗中' },
  { value: 'defeated', label: '已击杀' },
  { value: 'expired', label: '已过期' }
]

/**
 * 赛季状态筛选选项（pending/active/ended）
 */
const SEASON_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '未开始' },
  { value: 'active', label: '进行中' },
  { value: 'ended', label: '已结束' }
]

/** 分页默认页大小 */
const DEFAULT_PAGE_SIZE = 10

// ====== 响应式状态 ======

/** 全局操作进行中标记（用于禁用按钮） */
const operating = ref(false)

/** 统计指标数据 */
const metrics = ref(null)

/**
 * 可刷新的 BOSS 清单：来自 GET /admin/world-boss/metrics 的 bosses（内容是 world_boss_data.json）。
 * 这里以前自己抄了一份 ['qingyuanzi','yaoshou','mulan']，还注释着"与后端保持一致"——
 * 资料片加一只 BOSS，后台"手动刷新BOSS"的下拉里就没有它（服务端 spawn 一直是按内容认的，本来刷得出来）。
 */
const bossCatalog = computed(() => metrics.value?.bosses || [])

/** 子 Tab 配置 */
const subTabs = [
  { id: 'bosses', name: 'BOSS列表' },
  { id: 'seasons', name: '赛季列表' }
]
/** 当前激活的子 Tab */
const currentSubTab = ref('bosses')

// ===== BOSS 列表相关状态 =====
const bossLoading = ref(false)
const bossList = ref([])
const bossPagination = reactive({
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 1
})
const bossSearchParams = reactive({
  status: ''
})

// ===== 赛季列表相关状态 =====
const seasonLoading = ref(false)
const seasonList = ref([])
const seasonPagination = reactive({
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 1
})

// ===== 刷新BOSS弹窗状态 =====
const spawnModalShow = ref(false)
const spawnForm = reactive({
  boss_key: '',
  custom_hp: ''
})

// ===== 创建赛季弹窗状态 =====
const seasonModalShow = ref(false)
const seasonForm = reactive({
  season_name: '',
  start_date: '',
  end_date: ''
})

// ====== 方法 ======

/**
 * 拉取世界BOSS系统统计指标
 * GET /admin/world-boss/metrics
 */
const fetchMetrics = async () => {
  try {
    const res = await getMetrics()
    // 兼容 res.data.data 与 res.data 两种返回结构
    metrics.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取世界BOSS指标失败:', err)
    uiStore.showApiError(err, '获取世界BOSS指标失败')
  }
}

/**
 * 切换子 Tab
 * 切换到赛季列表时按需加载（避免初始请求两次）
 * @param {string} tabId 子 Tab ID
 */
const switchTab = (tabId) => {
  currentSubTab.value = tabId
  if (tabId === 'seasons' && seasonList.value.length === 0) {
    fetchSeasonList(1)
  }
}

/**
 * 拉取BOSS实例列表
 * GET /admin/world-boss/bosses
 * @param {number} page 页码（从1开始）
 */
const fetchBossList = async (page = 1) => {
  if (page < 1) page = 1
  bossLoading.value = true
  try {
    const status = bossSearchParams.status || undefined
    const res = await getBossList(page, bossPagination.pageSize, status)
    const data = res.data?.data || res.data
    bossList.value = data.bosses || []
    bossPagination.total = data.total || 0
    bossPagination.page = data.page || page
    // 分页大小以后端回传的 limit 为准（否则页数会按本地 pageSize 误算）
    if (data.limit) bossPagination.pageSize = data.limit
    bossPagination.totalPages = Math.max(1, Math.ceil(bossPagination.total / bossPagination.pageSize))
  } catch (err) {
    console.error('获取BOSS列表失败:', err)
    uiStore.showApiError(err, '获取BOSS列表失败')
  } finally {
    bossLoading.value = false
  }
}

/**
 * 拉取赛季列表
 * GET /admin/world-boss/seasons
 * @param {number} page 页码
 */
const fetchSeasonList = async (page = 1) => {
  if (page < 1) page = 1
  seasonLoading.value = true
  try {
    const res = await getSeasonList(page, seasonPagination.pageSize)
    const data = res.data?.data || res.data
    seasonList.value = data.seasons || []
    seasonPagination.total = data.total || 0
    seasonPagination.page = data.page || page
    // 分页大小以后端回传的 limit 为准（否则页数会按本地 pageSize 误算）
    if (data.limit) seasonPagination.pageSize = data.limit
    seasonPagination.totalPages = Math.max(1, Math.ceil(seasonPagination.total / seasonPagination.pageSize))
  } catch (err) {
    console.error('获取赛季列表失败:', err)
    uiStore.showApiError(err, '获取赛季列表失败')
  } finally {
    seasonLoading.value = false
  }
}

/**
 * 刷新当前 Tab 对应的列表（顶部"刷新列表"按钮）
 */
const refreshCurrent = () => {
  if (currentSubTab.value === 'bosses') {
    fetchBossList(bossPagination.page)
  } else if (currentSubTab.value === 'seasons') {
    fetchSeasonList(seasonPagination.page)
  }
}

/**
 * BOSS列表查询（重置到第一页）
 */
const handleBossSearch = () => {
  fetchBossList(1)
}

/**
 * 重置BOSS列表筛选条件
 */
const resetBossSearch = () => {
  bossSearchParams.status = ''
  fetchBossList(1)
}

/**
 * 打开"手动刷新BOSS"弹窗
 */
const openSpawnModal = () => {
  spawnForm.boss_key = ''
  spawnForm.custom_hp = ''
  spawnModalShow.value = true
}

/**
 * 提交手动刷新BOSS
 * POST /admin/world-boss/spawn
 */
const submitSpawn = async () => {
  // 校验必填项
  if (!spawnForm.boss_key) {
    uiStore.showToast('请选择BOSS key', 'warning')
    return
  }
  // 自定义HP校验：若填写必须为正整数字符串
  const customHp = spawnForm.custom_hp.trim()
  if (customHp && !/^\d+$/.test(customHp)) {
    uiStore.showToast('自定义HP必须为正整数字符串', 'warning')
    return
  }
  operating.value = true
  try {
    const params = { boss_key: spawnForm.boss_key }
    if (customHp) params.custom_hp = customHp
    const res = await spawnBoss(params)
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || 'BOSS已刷新', 'success')
    spawnModalShow.value = false
    // 刷新列表与指标
    await fetchBossList(bossPagination.page)
    await fetchMetrics()
  } catch (err) {
    const msg = err?.response?.data?.message || '刷新BOSS失败'
    console.error('刷新BOSS失败:', err)
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 强制过期BOSS（危险操作，通过 showConfirm emit 委托父组件做二次确认）
 * POST /admin/world-boss/:bossId/expire
 * @param {Object} boss BOSS实例对象
 */
const handleExpireBoss = (boss) => {
  const title = '强制过期BOSS确认'
  const message = `确定要将BOSS【${boss.boss_name}】（ID: ${boss.boss_id}）强制过期吗？\n此操作将立即结束该BOSS实例，所有参战记录保留但不再接受攻击，不可恢复。`
  emit('showConfirm', title, message, async () => {
    operating.value = true
    try {
      const res = await expireBoss(boss.boss_id)
      const data = res.data?.data || res.data
      uiStore.showToast(data?.message || 'BOSS已强制过期', 'success')
      // 刷新列表与指标
      await fetchBossList(bossPagination.page)
      await fetchMetrics()
    } catch (err) {
      const msg = err?.response?.data?.message || '强制过期失败'
      console.error('强制过期BOSS失败:', err)
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  })
}

/**
 * 打开"创建赛季"弹窗
 */
const openCreateSeasonModal = () => {
  seasonForm.season_name = ''
  seasonForm.start_date = ''
  seasonForm.end_date = ''
  seasonModalShow.value = true
}

/**
 * 提交创建赛季
 * POST /admin/world-boss/season/create
 */
const submitCreateSeason = async () => {
  // 校验必填项
  if (!seasonForm.season_name.trim()) {
    uiStore.showToast('请填写赛季名称', 'warning')
    return
  }
  if (!seasonForm.start_date) {
    uiStore.showToast('请选择开始日期', 'warning')
    return
  }
  if (!seasonForm.end_date) {
    uiStore.showToast('请选择结束日期', 'warning')
    return
  }
  // 校验日期范围：结束日期必须晚于开始日期
  if (new Date(seasonForm.end_date) <= new Date(seasonForm.start_date)) {
    uiStore.showToast('结束日期必须晚于开始日期', 'warning')
    return
  }
  operating.value = true
  try {
    // 后端 start_date/end_date 为 DATEONLY，只接受 YYYY-MM-DD（见 WorldBossService.createSeason）
    const params = {
      season_name: seasonForm.season_name.trim(),
      start_date: seasonForm.start_date,
      end_date: seasonForm.end_date
    }
    const res = await createSeason(params)
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '赛季已创建', 'success')
    seasonModalShow.value = false
    // 刷新赛季列表与指标
    await fetchSeasonList(seasonPagination.page)
    await fetchMetrics()
  } catch (err) {
    const msg = err?.response?.data?.message || '创建赛季失败'
    console.error('创建赛季失败:', err)
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 强制结算赛季（危险操作，通过 showConfirm emit 委托父组件做二次确认）
 * POST /admin/world-boss/season/:seasonId/settle
 * @param {Object} season 赛季对象
 */
const handleSettleSeason = (season) => {
  const title = '强制结算赛季确认'
  const message = `确定要将赛季【${season.season_name}】（ID: ${season.season_id}）强制结算吗？\n此操作将立即结束赛季、结算所有BOSS实例并发放奖励，不可恢复。`
  emit('showConfirm', title, message, async () => {
    operating.value = true
    try {
      const res = await settleSeason(season.season_id)
      const data = res.data?.data || res.data
      uiStore.showToast(data?.message || '赛季已强制结算', 'success')
      // 刷新赛季列表与指标
      await fetchSeasonList(seasonPagination.page)
      await fetchMetrics()
    } catch (err) {
      const msg = err?.response?.data?.message || '强制结算失败'
      console.error('强制结算赛季失败:', err)
      uiStore.showToast(msg, 'error')
    } finally {
      operating.value = false
    }
  })
}

// ====== 工具函数 ======

/**
 * BOSS 状态中文标签
 * @param {string} status 状态值
 * @returns {string} 中文标签
 */
const bossStatusLabel = (status) => {
  const map = {
    pending: '待激活',
    active: '战斗中',
    defeated: '已击杀',
    expired: '已过期'
  }
  return map[status] || status || '-'
}

/**
 * BOSS 状态徽章样式（pending=灰、active=红、defeated=绿、expired=黄）
 * @param {string} status 状态值
 * @returns {string} tailwind 类名
 */
const bossStatusClass = (status) => {
  const map = {
    pending: 'bg-surface-hover text-fg-secondary',
    active: 'bg-red-900 text-red-300',
    defeated: 'bg-emerald-900 text-emerald-300',
    expired: 'bg-amber-900 text-amber-300'
  }
  return map[status] || 'bg-surface-hover text-fg-secondary'
}

/**
 * 赛季状态中文标签
 * @param {string} status 状态值
 * @returns {string} 中文标签
 */
const seasonStatusLabel = (status) => {
  const map = {
    pending: '未开始',
    active: '进行中',
    ended: '已结束'
  }
  return map[status] || status || '-'
}

/**
 * 赛季状态徽章样式（pending=灰、active=红、ended=黄）
 * @param {string} status 状态值
 * @returns {string} tailwind 类名
 */
const seasonStatusClass = (status) => {
  const map = {
    pending: 'bg-surface-hover text-fg-secondary',
    active: 'bg-red-900 text-red-300',
    ended: 'bg-amber-900 text-amber-300'
  }
  return map[status] || 'bg-surface-hover text-fg-secondary'
}

/**
 * HP 剩余百分比（后端 GET /bosses 只回传 hp_max / hp_current 字符串，无 hp_percentage）
 * 超大整数用 BigInt 计算；最大HP缺失或为 0 时返回 null，模板据此隐藏进度条并显示"未知"
 * @param {Object} boss BOSS行数据
 * @returns {number|null} 0-100 的整数百分比，无法计算返回 null
 */
const hpPercentage = (boss) => {
  try {
    const max = BigInt(String(boss?.hp_max ?? ''))
    const cur = BigInt(String(boss?.hp_current ?? ''))
    if (max <= 0n || cur < 0n) return null
    return Math.min(100, Math.max(0, Number((cur * 100n) / max)))
  } catch {
    return null
  }
}

/**
 * HP 进度条颜色（根据百分比渐变：高HP=红、中HP=橙、低HP=黄）
 * @param {number} percentage 0-100
 * @returns {string} tailwind 类名
 */
const hpBarClass = (percentage) => {
  const p = Number(percentage) || 0
  if (p > 60) return 'bg-gradient-to-r from-red-700 to-red-500'
  if (p > 30) return 'bg-gradient-to-r from-orange-700 to-orange-500'
  return 'bg-gradient-to-r from-amber-700 to-amber-500'
}

/**
 * 格式化HP显示（BigInt 字符串过长时截断加千分位）
 * @param {string} hpStr HP字符串
 * @returns {string} 格式化后的字符串
 */
const formatHp = (hpStr) => {
  if (hpStr === null || hpStr === undefined || hpStr === '') return '0'
  try {
    // BigInt 处理超大整数，加千分位
    const big = BigInt(hpStr)
    return big.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  } catch {
    // 转换失败则原样返回
    return String(hpStr)
  }
}

/**
 * 格式化日期为本地时间字符串
 * @param {string} dateStr 日期字符串
 * @returns {string} 格式化后的日期
 */
const formatDate = (dateStr) => {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return dateStr
  }
}

// ====== 生命周期 ======

/**
 * 组件挂载时：
 *   1. 拉取统计指标
 *   2. 拉取BOSS列表（默认 Tab）
 */
onMounted(() => {
  fetchMetrics()
  fetchBossList(1)
})
</script>

<style scoped>
</style>
