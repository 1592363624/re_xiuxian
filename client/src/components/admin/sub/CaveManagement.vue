<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white">洞府管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchList(pagination.page)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
      </div>
    </div>

    <!-- 搜索区域 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">玩家ID：</label>
          <input
            v-model="searchParams.player_id"
            type="text"
            class="w-32 px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
            placeholder="精确匹配"
            @keyup.enter="handleSearch"
          >
        </div>
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">昵称：</label>
          <input
            v-model="searchParams.nickname"
            type="text"
            class="w-40 px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
            placeholder="模糊匹配"
            @keyup.enter="handleSearch"
          >
        </div>
        <button @click="handleSearch" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">查询</button>
        <button @click="resetSearch" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
      </div>
    </div>

    <!-- 洞府列表表格 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-900 text-gray-400">
            <tr>
              <th class="px-3 py-2 text-left whitespace-nowrap">玩家ID</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">昵称</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">境界</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">是否开辟</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">灵脉等级</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">静室</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">丹房</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">器室</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">大阵</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">药园地块</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">开辟时间</th>
              <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            <!-- 加载中 -->
            <tr v-if="loading" class="text-center text-gray-500">
              <td colspan="12" class="px-3 py-6">加载中...</td>
            </tr>
            <!-- 空数据 -->
            <tr v-else-if="caveList.length === 0" class="text-center text-gray-500">
              <td colspan="12" class="px-3 py-6">暂无洞府数据</td>
            </tr>
            <!-- 数据行 -->
            <tr
              v-for="c in caveList"
              :key="c.player_id"
              class="border-t border-gray-700 hover:bg-gray-750"
            >
              <td class="px-3 py-2 text-gray-400">{{ c.player_id }}</td>
              <td class="px-3 py-2 text-white">{{ c.nickname }}</td>
              <td class="px-3 py-2 text-gray-300 text-xs">{{ c.realm }}</td>
              <td class="px-3 py-2">
                <span
                  :class="c.is_opened ? 'bg-green-900 text-green-300' : 'bg-gray-700 text-gray-400'"
                  class="px-2 py-0.5 rounded text-xs"
                >{{ c.is_opened ? '已开辟' : '未开辟' }}</span>
              </td>
              <td class="px-3 py-2 text-yellow-400 font-bold">{{ c.spirit_vein_level }}</td>
              <td class="px-3 py-2 text-blue-300">{{ c.quiet_room_level }}</td>
              <td class="px-3 py-2 text-purple-300">{{ c.pill_room_level }}</td>
              <td class="px-3 py-2 text-orange-300">{{ c.tool_room_level }}</td>
              <td class="px-3 py-2 text-red-300">{{ c.grand_formation_level }}</td>
              <td class="px-3 py-2 text-green-400 font-bold">{{ c.garden_plots }} / 9</td>
              <td class="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{{ formatDate(c.opened_at) }}</td>
              <td class="px-3 py-2 text-center whitespace-nowrap">
                <button
                  @click="openFacilityModal(c)"
                  :disabled="!c.is_opened"
                  class="px-2 py-1 bg-yellow-600 hover:bg-yellow-500 rounded text-white text-xs mr-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >设施</button>
                <button
                  @click="openPlotsModal(c)"
                  :disabled="!c.is_opened"
                  class="px-2 py-1 bg-green-700 hover:bg-green-600 rounded text-white text-xs mr-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >地块</button>
                <button
                  @click="openResetModal(c)"
                  class="px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-white text-xs"
                >重置</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 分页 -->
    <div class="flex justify-center items-center gap-4">
      <button
        :disabled="pagination.page <= 1"
        @click="fetchList(pagination.page - 1)"
        class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600 text-white text-sm"
      >上一页</button>
      <span class="text-gray-400 text-sm">第 {{ pagination.page }} / {{ pagination.totalPages }} 页 (共{{ pagination.total }}条)</span>
      <button
        :disabled="pagination.page >= pagination.totalPages"
        @click="fetchList(pagination.page + 1)"
        class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600 text-white text-sm"
      >下一页</button>
    </div>

    <!-- 调整设施等级弹窗 -->
    <Modal :isOpen="facilityModal.show" title="调整设施等级" @close="closeFacilityModal">
      <div v-if="facilityModal.cave" class="space-y-4">
        <p class="text-gray-300">
          玩家：<span class="text-xiuxian-gold">{{ facilityModal.cave.nickname }}</span>
          （ID：{{ facilityModal.cave.player_id }}）
        </p>
        <div>
          <label class="block text-sm text-gray-400 mb-1">设施类型</label>
          <select
            v-model="facilityModal.facility"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
          >
            <option v-for="opt in facilityOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}（当前等级：{{ getFacilityLevel(facilityModal.cave, opt.value) }}）
            </option>
          </select>
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">新等级（0-10）</label>
          <input
            v-model.number="facilityModal.level"
            type="number"
            min="0"
            max="10"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
            placeholder="输入新的等级数值"
          >
          <p class="mt-1 text-xs text-gray-500">提示：0 表示未建造，10 为最高等级；GM 调整不消耗资源</p>
        </div>
      </div>
      <template #footer>
        <button @click="closeFacilityModal" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">取消</button>
        <button
          @click="confirmFacility"
          :disabled="facilityModal.submitting"
          class="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 rounded text-white text-sm disabled:opacity-50"
        >{{ facilityModal.submitting ? '提交中...' : '确认调整' }}</button>
      </template>
    </Modal>

    <!-- 重置洞府确认弹窗 -->
    <Modal :isOpen="resetModal.show" title="重置洞府确认" width="480px" @close="closeResetModal">
      <div v-if="resetModal.cave" class="space-y-3">
        <p class="text-red-300 font-bold">⚠️ 此操作不可撤销，请确认！</p>
        <p class="text-gray-300">
          玩家：<span class="text-xiuxian-gold">{{ resetModal.cave.nickname }}</span>
          （ID：{{ resetModal.cave.player_id }}）
        </p>
        <p class="text-gray-400 text-sm">重置后玩家洞府将发生以下变化：</p>
        <ul class="text-sm text-gray-400 list-disc list-inside space-y-1">
          <li>所有设施等级（灵脉/静室/丹房/器室/大阵）清零</li>
          <li>灵脉累计产出与待领取灵石清零</li>
          <li>药园地块数重置为初始值（3 块）</li>
          <li>洞府状态置为「未开辟」，玩家需重新开辟</li>
          <li>玩家本身不受影响，仅重置洞府记录</li>
        </ul>
      </div>
      <template #footer>
        <button @click="closeResetModal" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">取消</button>
        <button
          @click="confirmReset"
          :disabled="resetModal.submitting"
          class="px-4 py-2 bg-red-600 hover:bg-red-500 rounded text-white text-sm disabled:opacity-50"
        >{{ resetModal.submitting ? '提交中...' : '确认重置' }}</button>
      </template>
    </Modal>

    <!-- 调整药园地块数弹窗 -->
    <Modal :isOpen="plotsModal.show" title="调整药园地块数" @close="closePlotsModal">
      <div v-if="plotsModal.cave" class="space-y-4">
        <p class="text-gray-300">
          玩家：<span class="text-xiuxian-gold">{{ plotsModal.cave.nickname }}</span>
          （ID：{{ plotsModal.cave.player_id }}）
        </p>
        <p class="text-gray-400 text-sm">当前地块数：<span class="text-green-400">{{ plotsModal.cave.garden_plots }}</span> 块</p>
        <div>
          <label class="block text-sm text-gray-400 mb-1">新地块数（0-9）</label>
          <input
            v-model.number="plotsModal.plots"
            type="number"
            min="0"
            max="9"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
            placeholder="输入新的地块数"
          >
          <p class="mt-1 text-xs text-gray-500">提示：0 表示无地块，9 为最大值；GM 调整不消耗灵石</p>
        </div>
      </div>
      <template #footer>
        <button @click="closePlotsModal" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">取消</button>
        <button
          @click="confirmPlots"
          :disabled="plotsModal.submitting"
          class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm disabled:opacity-50"
        >{{ plotsModal.submitting ? '提交中...' : '确认调整' }}</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * 洞府管理子组件
 * 供 GM 后台管理玩家洞府：
 *   1. 分页查询玩家洞府列表，支持按玩家ID/昵称筛选
 *   2. 调整玩家设施等级（灵脉/静室/丹房/器室/大阵，GM 不消耗资源）
 *   3. 重置玩家洞府（清空所有设施与产出，状态置为未开辟）
 *   4. 调整玩家药园地块数（GM 不消耗灵石）
 *
 * 所有弹窗使用自定义 Modal 组件，禁用浏览器原生 alert/confirm
 * 业务逻辑全部通过 API 调用后端，前端只做展示与交互
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
import {
  getCaveList,
  updateCaveFacility,
  resetCave,
  updateGardenPlots
} from '../../../api/admin_cave'

const uiStore = useUIStore()

// 设施类型选项（与后端白名单一致，便于下拉选择）
const facilityOptions = [
  { value: 'spirit_vein', label: '灵脉' },
  { value: 'quiet_room', label: '静室' },
  { value: 'pill_room', label: '丹房' },
  { value: 'tool_room', label: '器室' },
  { value: 'grand_formation', label: '护山大阵' }
]

// 洞府列表数据
const caveList = ref([])
const loading = ref(false)

// 搜索参数
const searchParams = reactive({
  player_id: '',
  nickname: ''
})

// 分页状态
const pagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
})

// 设施等级调整弹窗状态
const facilityModal = reactive({
  show: false,
  cave: null,
  facility: 'spirit_vein',
  level: 0,
  submitting: false
})

// 重置洞府弹窗状态
const resetModal = reactive({
  show: false,
  cave: null,
  submitting: false
})

// 调整地块数弹窗状态
const plotsModal = reactive({
  show: false,
  cave: null,
  plots: 0,
  submitting: false
})

/**
 * 获取洞府列表
 * @param {number} page 页码
 */
const fetchList = async (page = 1) => {
  loading.value = true
  try {
    const params = { page, page_size: pagination.pageSize }
    // 仅在非空时附带筛选参数，避免后端将空字符串解析为 0
    if (searchParams.player_id !== '') params.player_id = searchParams.player_id
    if (searchParams.nickname !== '') params.nickname = searchParams.nickname

    const res = await getCaveList(params)
    // 后端返回结构：{ data: { list, total, page, page_size, total_pages } }
    const body = res.data?.data || res.data || {}
    caveList.value = Array.isArray(body.list) ? body.list : []
    pagination.page = body.page || 1
    pagination.total = body.total || 0
    pagination.totalPages = body.total_pages || 1
  } catch (err) {
    // 错误已由 axios 拦截器统一 toast
    caveList.value = []
  } finally {
    loading.value = false
  }
}

/**
 * 触发查询（重置到第一页）
 */
const handleSearch = () => {
  fetchList(1)
}

/**
 * 重置搜索条件
 */
const resetSearch = () => {
  searchParams.player_id = ''
  searchParams.nickname = ''
  fetchList(1)
}

/**
 * 格式化日期显示
 * @param {string} dateStr ISO 时间字符串
 * @returns {string} 格式化后的时间
 */
const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * 获取指定设施在洞府记录中的当前等级
 * @param {Object} cave 洞府记录
 * @param {string} facility 设施类型
 * @returns {number} 当前等级
 */
const getFacilityLevel = (cave, facility) => {
  if (!cave) return 0
  const field = `${facility}_level`
  return cave[field] ?? 0
}

/**
 * 打开调整设施等级弹窗
 * @param {Object} cave 洞府记录
 */
const openFacilityModal = (cave) => {
  facilityModal.cave = cave
  // 默认选中灵脉，并填充当前等级便于增量调整
  facilityModal.facility = 'spirit_vein'
  facilityModal.level = cave.spirit_vein_level || 0
  facilityModal.submitting = false
  facilityModal.show = true
}

/**
 * 关闭调整设施等级弹窗
 */
const closeFacilityModal = () => {
  facilityModal.show = false
  facilityModal.cave = null
  facilityModal.submitting = false
}

/**
 * 确认调整设施等级
 */
const confirmFacility = async () => {
  if (!facilityModal.cave) return
  // 校验等级必须为非负整数
  if (facilityModal.level === null || facilityModal.level === undefined || isNaN(facilityModal.level)) {
    uiStore.showToast('请输入有效的等级数值', 'error')
    return
  }
  const level = parseInt(facilityModal.level)
  if (level < 0 || level > 10) {
    uiStore.showToast('设施等级必须在 0-10 之间', 'error')
    return
  }
  // 校验设施类型合法性
  const validFacilities = ['spirit_vein', 'quiet_room', 'pill_room', 'tool_room', 'grand_formation']
  if (!validFacilities.includes(facilityModal.facility)) {
    uiStore.showToast('设施类型非法', 'error')
    return
  }

  facilityModal.submitting = true
  try {
    const res = await updateCaveFacility(facilityModal.cave.player_id, {
      facility: facilityModal.facility,
      level
    })
    const msg = res.data?.message || '设施等级调整成功'
    uiStore.showToast(msg, 'success')
    closeFacilityModal()
    // 刷新列表展示最新数据
    await fetchList(pagination.page)
  } catch (err) {
    const msg = err.response?.data?.message || '调整设施等级失败'
    uiStore.showToast(msg, 'error')
  } finally {
    facilityModal.submitting = false
  }
}

/**
 * 打开重置洞府确认弹窗
 * @param {Object} cave 洞府记录
 */
const openResetModal = (cave) => {
  resetModal.cave = cave
  resetModal.submitting = false
  resetModal.show = true
}

/**
 * 关闭重置洞府弹窗
 */
const closeResetModal = () => {
  resetModal.show = false
  resetModal.cave = null
  resetModal.submitting = false
}

/**
 * 确认重置洞府
 */
const confirmReset = async () => {
  if (!resetModal.cave) return

  resetModal.submitting = true
  try {
    const res = await resetCave(resetModal.cave.player_id)
    const msg = res.data?.message || '洞府已重置'
    uiStore.showToast(msg, 'success')
    closeResetModal()
    // 刷新列表展示最新数据
    await fetchList(pagination.page)
  } catch (err) {
    const msg = err.response?.data?.message || '重置洞府失败'
    uiStore.showToast(msg, 'error')
  } finally {
    resetModal.submitting = false
  }
}

/**
 * 打开调整药园地块数弹窗
 * @param {Object} cave 洞府记录
 */
const openPlotsModal = (cave) => {
  plotsModal.cave = cave
  // 默认填充当前地块数，便于增量调整
  plotsModal.plots = cave.garden_plots || 0
  plotsModal.submitting = false
  plotsModal.show = true
}

/**
 * 关闭调整药园地块数弹窗
 */
const closePlotsModal = () => {
  plotsModal.show = false
  plotsModal.cave = null
  plotsModal.submitting = false
}

/**
 * 确认调整药园地块数
 */
const confirmPlots = async () => {
  if (!plotsModal.cave) return
  // 校验地块数必须为非负整数
  if (plotsModal.plots === null || plotsModal.plots === undefined || isNaN(plotsModal.plots)) {
    uiStore.showToast('请输入有效的地块数', 'error')
    return
  }
  const plots = parseInt(plotsModal.plots)
  if (plots < 0 || plots > 9) {
    uiStore.showToast('药园地块数必须在 0-9 之间', 'error')
    return
  }

  plotsModal.submitting = true
  try {
    const res = await updateGardenPlots(plotsModal.cave.player_id, { plots })
    const msg = res.data?.message || '药园地块数调整成功'
    uiStore.showToast(msg, 'success')
    closePlotsModal()
    // 刷新列表展示最新数据
    await fetchList(pagination.page)
  } catch (err) {
    const msg = err.response?.data?.message || '调整药园地块数失败'
    uiStore.showToast(msg, 'error')
  } finally {
    plotsModal.submitting = false
  }
}

// 暴露刷新方法给父组件（保持与 SectManagement 一致的风格）
defineExpose({
  fetchList,
  pagination
})

onMounted(() => {
  fetchList(1)
})
</script>
