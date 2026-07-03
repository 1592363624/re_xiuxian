<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white">宗门管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchAll" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
      </div>
    </div>

    <!-- 宗门统计卡片 -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <div v-if="statsLoading" class="col-span-full text-center text-gray-500 py-4">统计加载中...</div>
      <div v-else-if="sectStats.length === 0" class="col-span-full text-center text-gray-500 py-4">暂无宗门数据</div>
      <!-- 单个宗门统计卡片 -->
      <div
        v-for="stat in sectStats"
        :key="stat.sect_id"
        class="bg-gray-800 rounded-lg border border-gray-700 p-4 hover:border-gray-600 transition-colors cursor-pointer"
        :class="{ 'ring-2 ring-xiuxian-gold': filterSectId === stat.sect_id }"
        @click="filterBySect(stat.sect_id)"
      >
        <div class="flex justify-between items-start mb-2">
          <h4 class="text-base font-bold text-xiuxian-gold">{{ stat.sect_name }}</h4>
          <span class="text-xs text-gray-500">{{ stat.sect_id }}</span>
        </div>
        <div class="grid grid-cols-2 gap-2 text-sm">
          <div>
            <div class="text-gray-400 text-xs">成员数</div>
            <div class="text-white font-bold">{{ stat.member_count }}</div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">总贡献度</div>
            <div class="text-green-400 font-bold">{{ stat.total_contribution }}</div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">长老数</div>
            <div class="text-purple-400 font-bold">{{ stat.elder_count }}</div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">弟子数</div>
            <div class="text-blue-400 font-bold">{{ stat.disciple_count }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 成员列表区域 -->
    <div class="space-y-4">
      <!-- 筛选与操作 -->
      <div class="flex flex-wrap justify-between items-center gap-2">
        <h4 class="text-base font-bold text-white">成员列表</h4>
        <div class="flex gap-2 items-center">
          <label class="text-sm text-gray-400">宗门筛选：</label>
          <select
            v-model="filterSectId"
            @change="handleFilterChange"
            class="px-3 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm"
          >
            <option value="">全部宗门</option>
            <option v-for="opt in sectOptions" :key="opt.id" :value="opt.id">{{ opt.name }}</option>
          </select>
        </div>
      </div>

      <!-- 成员表格 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">玩家ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">昵称</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">宗门</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">贡献度</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">身份</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">加入时间</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">点卯时间</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">传功时间</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <!-- 加载中 -->
              <tr v-if="membersLoading" class="text-center text-gray-500">
                <td colspan="9" class="px-3 py-6">加载中...</td>
              </tr>
              <!-- 空数据 -->
              <tr v-else-if="members.length === 0" class="text-center text-gray-500">
                <td colspan="9" class="px-3 py-6">暂无宗门成员数据</td>
              </tr>
              <!-- 成员行 -->
              <tr
                v-for="m in members"
                :key="m.player_id"
                class="border-t border-gray-700 hover:bg-gray-750"
              >
                <td class="px-3 py-2 text-gray-400">{{ m.player_id }}</td>
                <td class="px-3 py-2 text-white">{{ m.nickname }}</td>
                <td class="px-3 py-2 text-xiuxian-gold">{{ m.sect_name }}</td>
                <td class="px-3 py-2 text-green-400 font-bold">{{ m.contribution }}</td>
                <td class="px-3 py-2">
                  <span
                    :class="m.role === 'elder' ? 'bg-purple-900 text-purple-300' : 'bg-blue-900 text-blue-300'"
                    class="px-2 py-0.5 rounded text-xs"
                  >{{ formatRole(m.role) }}</span>
                </td>
                <td class="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{{ formatDate(m.joined_at) }}</td>
                <td class="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{{ formatDate(m.last_check_in) }}</td>
                <td class="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{{ formatDate(m.last_transfer) }}</td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <button @click="openContributionModal(m)" class="px-2 py-1 bg-green-700 hover:bg-green-600 rounded text-white text-xs mr-1">贡献</button>
                  <button @click="openRoleModal(m)" class="px-2 py-1 bg-yellow-600 hover:bg-yellow-500 rounded text-white text-xs mr-1">身份</button>
                  <button @click="handleKick(m)" class="px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-white text-xs">踢出</button>
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
          @click="fetchMembers(pagination.page - 1)"
          class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600 text-white text-sm"
        >上一页</button>
        <span class="text-gray-400 text-sm">第 {{ pagination.page }} / {{ pagination.totalPages }} 页 (共{{ pagination.total }}条)</span>
        <button
          :disabled="pagination.page >= pagination.totalPages"
          @click="fetchMembers(pagination.page + 1)"
          class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600 text-white text-sm"
        >下一页</button>
      </div>
    </div>

    <!-- 调整贡献度弹窗 -->
    <div
      v-if="contributionModal.show"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      @click.self="closeContributionModal"
    >
      <div class="bg-gray-800 rounded-lg border border-gray-600 p-6 w-full max-w-md">
        <h3 class="text-lg font-bold text-white mb-4">调整宗门贡献度</h3>
        <div v-if="contributionModal.member" class="space-y-4">
          <p class="text-gray-300">
            玩家：<span class="text-xiuxian-gold">{{ contributionModal.member.nickname }}</span>
            （{{ contributionModal.member.sect_name }}）
          </p>
          <p class="text-gray-400 text-sm">当前贡献度：<span class="text-green-400">{{ contributionModal.member.contribution }}</span></p>
          <div>
            <label class="block text-sm text-gray-400 mb-1">新贡献度数值</label>
            <input
              v-model.number="contributionModal.value"
              type="number"
              min="0"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
              placeholder="输入新的贡献度数值"
            >
            <p class="mt-1 text-xs text-gray-500">提示：贡献度不能为负数，设置为 0 相当于清空贡献</p>
          </div>
        </div>
        <div class="flex justify-end space-x-2 mt-6">
          <button @click="closeContributionModal" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">取消</button>
          <button
            @click="confirmContribution"
            :disabled="contributionModal.submitting"
            class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm disabled:opacity-50"
          >{{ contributionModal.submitting ? '提交中...' : '确认' }}</button>
        </div>
      </div>
    </div>

    <!-- 设置身份弹窗 -->
    <div
      v-if="roleModal.show"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      @click.self="closeRoleModal"
    >
      <div class="bg-gray-800 rounded-lg border border-gray-600 p-6 w-full max-w-md">
        <h3 class="text-lg font-bold text-white mb-4">设置宗门身份</h3>
        <div v-if="roleModal.member" class="space-y-4">
          <p class="text-gray-300">
            玩家：<span class="text-xiuxian-gold">{{ roleModal.member.nickname }}</span>
            （{{ roleModal.member.sect_name }}）
          </p>
          <p class="text-gray-400 text-sm">当前身份：<span :class="roleModal.member.role === 'elder' ? 'text-purple-300' : 'text-blue-300'">{{ formatRole(roleModal.member.role) }}</span></p>
          <div>
            <label class="block text-sm text-gray-400 mb-1">新身份</label>
            <select
              v-model="roleModal.value"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
            >
              <option value="disciple">弟子（disciple）</option>
              <option value="elder">长老（elder）</option>
            </select>
          </div>
        </div>
        <div class="flex justify-end space-x-2 mt-6">
          <button @click="closeRoleModal" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">取消</button>
          <button
            @click="confirmRole"
            :disabled="roleModal.submitting"
            class="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 rounded text-white text-sm disabled:opacity-50"
          >{{ roleModal.submitting ? '提交中...' : '确认' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 宗门管理子组件
 * 供 GM 后台管理宗门成员：
 *   1. 展示六大宗门的统计卡片（成员数、总贡献度、长老数、弟子数）
 *   2. 分页查询成员列表，支持按宗门筛选
 *   3. 调整玩家宗门贡献度（自定义弹窗）
 *   4. 设置玩家宗门身份：弟子/长老（自定义弹窗）
 *   5. 踢出宗门（通过 showConfirm 事件委托父组件做二次确认）
 *
 * 业务逻辑全部通过 API 调用后端，前端只做展示与交互。
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import {
  getSectMembers,
  getSectStats,
  updateMemberContribution,
  updateMemberRole,
  kickMember
} from '../../../api/admin_sect'

const emit = defineEmits(['showConfirm'])
const uiStore = useUIStore()

// 宗门筛选项（静态配置：六大宗门 ID 与名称，与 sect_data.json 保持一致）
const sectOptions = [
  { id: 'luoyun', name: '落云宗' },
  { id: 'xinggong', name: '星宫' },
  { id: 'tianxing', name: '天星宗' },
  { id: 'lingxiao', name: '凌霄宫' },
  { id: 'yinluo', name: '阴罗宗' },
  { id: 'hehuan', name: '合欢宗' }
]

// 宗门统计数据
const sectStats = ref([])
const statsLoading = ref(false)

// 成员列表数据
const members = ref([])
const membersLoading = ref(false)
const filterSectId = ref('')
const pagination = reactive({
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1
})

// 调整贡献度弹窗状态
const contributionModal = reactive({
  show: false,
  member: null,
  value: 0,
  submitting: false
})

// 设置身份弹窗状态
const roleModal = reactive({
  show: false,
  member: null,
  value: 'disciple',
  submitting: false
})

/**
 * 获取宗门统计数据
 */
const fetchStats = async () => {
  statsLoading.value = true
  try {
    const res = await getSectStats()
    // 后端返回结构：{ data: { sects: [...] } }
    const body = res.data?.data?.sects || res.data?.sects || []
    sectStats.value = Array.isArray(body) ? body : []
  } catch (err) {
    // 错误已由 axios 拦截器统一 toast
    sectStats.value = []
  } finally {
    statsLoading.value = false
  }
}

/**
 * 获取成员列表
 * @param {number} page 页码
 */
const fetchMembers = async (page = 1) => {
  membersLoading.value = true
  try {
    const params = { page, page_size: pagination.pageSize }
    if (filterSectId.value) params.sect_id = filterSectId.value

    const res = await getSectMembers(params)
    // 后端返回结构：{ data: { list, total, page, page_size, total_pages } }
    const body = res.data?.data || res.data || {}
    members.value = Array.isArray(body.list) ? body.list : []
    pagination.page = body.page || 1
    pagination.total = body.total || 0
    pagination.totalPages = body.total_pages || 1
  } catch (err) {
    members.value = []
  } finally {
    membersLoading.value = false
  }
}

/**
 * 同时刷新统计与成员列表
 */
const fetchAll = async () => {
  await Promise.all([fetchStats(), fetchMembers(pagination.page)])
}

/**
 * 宗门筛选变更
 */
const handleFilterChange = () => {
  // 切换宗门时重置回第一页
  fetchMembers(1)
}

/**
 * 点击统计卡片按宗门筛选
 * @param {string} sectId 宗门ID
 */
const filterBySect = (sectId) => {
  // 再次点击同一宗门则取消筛选
  filterSectId.value = filterSectId.value === sectId ? '' : sectId
  fetchMembers(1)
}

/**
 * 格式化身份显示
 * @param {string} role 角色标识
 * @returns {string} 中文显示
 */
const formatRole = (role) => {
  if (role === 'elder') return '长老'
  if (role === 'disciple') return '弟子'
  return role || '-'
}

/**
 * 格式化日期
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
 * 打开调整贡献度弹窗
 * @param {Object} member 成员对象
 */
const openContributionModal = (member) => {
  contributionModal.member = member
  // 默认填充当前贡献度，便于增量调整
  contributionModal.value = member.contribution || 0
  contributionModal.submitting = false
  contributionModal.show = true
}

/**
 * 关闭调整贡献度弹窗
 */
const closeContributionModal = () => {
  contributionModal.show = false
  contributionModal.member = null
  contributionModal.submitting = false
}

/**
 * 确认调整贡献度
 */
const confirmContribution = async () => {
  if (!contributionModal.member) return
  // 参数校验：必须为非负整数
  if (contributionModal.value === null || contributionModal.value === undefined || isNaN(contributionModal.value)) {
    uiStore.showToast('请输入有效的贡献度数值', 'error')
    return
  }
  if (contributionModal.value < 0) {
    uiStore.showToast('贡献度不能为负数', 'error')
    return
  }

  contributionModal.submitting = true
  try {
    const res = await updateMemberContribution(contributionModal.member.player_id, contributionModal.value)
    const msg = res.data?.message || '宗门贡献度调整成功'
    uiStore.showToast(msg, 'success')
    closeContributionModal()
    // 刷新成员列表与统计
    await fetchAll()
  } catch (err) {
    const msg = err.response?.data?.message || '调整贡献度失败'
    uiStore.showToast(msg, 'error')
  } finally {
    contributionModal.submitting = false
  }
}

/**
 * 打开设置身份弹窗
 * @param {Object} member 成员对象
 */
const openRoleModal = (member) => {
  roleModal.member = member
  // 默认选中当前身份
  roleModal.value = member.role === 'elder' ? 'elder' : 'disciple'
  roleModal.submitting = false
  roleModal.show = true
}

/**
 * 关闭设置身份弹窗
 */
const closeRoleModal = () => {
  roleModal.show = false
  roleModal.member = null
  roleModal.submitting = false
}

/**
 * 确认设置身份
 */
const confirmRole = async () => {
  if (!roleModal.member) return
  // 校验身份值合法性
  if (!['disciple', 'elder'].includes(roleModal.value)) {
    uiStore.showToast('身份参数非法，仅支持 disciple/elder', 'error')
    return
  }

  roleModal.submitting = true
  try {
    const res = await updateMemberRole(roleModal.member.player_id, roleModal.value)
    const msg = res.data?.message || '宗门身份设置成功'
    uiStore.showToast(msg, 'success')
    closeRoleModal()
    // 刷新成员列表与统计（长老数/弟子数会变化）
    await fetchAll()
  } catch (err) {
    const msg = err.response?.data?.message || '设置身份失败'
    uiStore.showToast(msg, 'error')
  } finally {
    roleModal.submitting = false
  }
}

/**
 * 踢出宗门（二次确认通过父组件的 showConfirm 弹窗实现）
 * @param {Object} member 成员对象
 */
const handleKick = (member) => {
  const title = '踢出宗门确认'
  const message = `确定要将玩家【${member.nickname}】（${member.sect_name}，贡献度 ${member.contribution}）踢出宗门吗？\n此操作将清空其宗门贡献度，不可恢复。`
  emit('showConfirm', title, message, async () => {
    try {
      const res = await kickMember(member.player_id)
      const msg = res.data?.message || '已将玩家踢出宗门'
      uiStore.showToast(msg, 'success')
      // 刷新成员列表与统计
      await fetchAll()
    } catch (err) {
      const msg = err.response?.data?.message || '踢出宗门失败'
      uiStore.showToast(msg, 'error')
    }
  })
}

// 暴露刷新方法给父组件（保持与 PlayerManagement 一致的风格）
defineExpose({
  fetchMembers,
  fetchStats,
  fetchAll,
  pagination
})

onMounted(() => {
  fetchAll()
})
</script>
