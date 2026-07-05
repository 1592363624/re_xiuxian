<script setup lang="ts">
/**
 * 装备管理组件（GM 后台）
 *
 * 功能说明：
 *   - 装备列表查询（分页 + 筛选 玩家ID/昵称/槽位/本命标记）
 *   - 查看指定玩家装备详情
 *   - 修改装备记录（耐久/最大耐久/祭炼等级/排序/本命标记/法力值/祭出状态）
 *   - 重置装备记录（恢复初始耐久/祭炼等级清零/取消本命）
 *   - GM 一键修理（无消耗，不扣 max_durability）
 *   - 删除装备记录（强制卸下，归还物品到背包）
 *
 * 安全设计：
 *   - 所有操作通过 admin_equipment API 调用，后端做双层权限校验
 *   - 所有操作记录到 admin_logs 表
 *   - 字段范围校验由后端统一处理
 */
import { ref, reactive, computed, onMounted } from 'vue'
import Modal from '../../common/Modal.vue'
import {
  getEquipmentList,
  getPlayerEquipment,
  updateEquipmentRecord,
  resetEquipmentRecord,
  gmRepairAll,
  deleteEquipmentRecord,
  type AdminEquipmentRecord,
  type EquipmentListQuery,
  type UpdateEquipmentPayload
} from '../../../api/admin_equipment'

// ====== 响应式状态 ======
const loading = ref(false)
const operating = ref(false)
const list = ref<AdminEquipmentRecord[]>([])
const total = ref(0)

// 搜索参数
const searchParams = reactive<EquipmentListQuery>({
  keyword: '',
  slot: '',
  is_benming: undefined,
  page: 1,
  pageSize: 20
})

// 详情弹窗
const detailModal = ref<{ show: boolean; playerId: number; playerName: string }>({
  show: false,
  playerId: 0,
  playerName: ''
})
const detailData = ref<{ player: any; equipments: AdminEquipmentRecord[]; count: number } | null>(null)

// 编辑弹窗
const editModal = ref<{ show: boolean; record: AdminEquipmentRecord | null }>({
  show: false,
  record: null
})
const editForm = reactive<UpdateEquipmentPayload & { id: number; player_id: number }>({
  id: 0,
  player_id: 0,
  durability: 0,
  max_durability: 0,
  refine_level: 0,
  sort_order: 0,
  is_benming: false,
  is_summoned: false,
  spirit_power: 0
})

// 确认弹窗
const confirmModal = ref<{
  show: boolean
  action: 'reset' | 'repairAll' | 'delete'
  record: AdminEquipmentRecord | null
  playerId: number
}>({
  show: false,
  action: 'reset',
  record: null,
  playerId: 0
})

// 提示弹窗
const toastModal = ref<{ show: boolean; message: string; isSuccess: boolean }>({
  show: false,
  message: '',
  isSuccess: true
})

// ====== 计算属性 ======
const totalPages = computed(() => Math.ceil(total.value / searchParams.pageSize))

// ====== 方法 ======

/**
 * 显示提示
 */
function showToast(message: string, isSuccess = true) {
  toastModal.value = { show: true, message, isSuccess }
}

/**
 * 拉取列表
 */
async function fetchList(page = 1) {
  searchParams.page = page
  loading.value = true
  try {
    const res = await getEquipmentList(searchParams)
    const data = res.data?.data || res.data
    list.value = data.list || []
    total.value = data.total || 0
  } catch (e: any) {
    showToast(e.message || '查询失败', false)
  } finally {
    loading.value = false
  }
}

/**
 * 搜索
 */
function handleSearch() {
  fetchList(1)
}

/**
 * 重置搜索
 */
function resetSearch() {
  searchParams.keyword = ''
  searchParams.slot = ''
  searchParams.is_benming = undefined
  fetchList(1)
}

/**
 * 查看玩家装备详情
 */
async function viewDetail(record: AdminEquipmentRecord) {
  detailModal.value = {
    show: true,
    playerId: record.player_id,
    playerName: `玩家 #${record.player_id}`
  }
  try {
    const res = await getPlayerEquipment(record.player_id)
    const data = res.data?.data || res.data
    detailData.value = data
    detailModal.value.playerName = `${data.player.nickname} (#${data.player.id})`
  } catch (e: any) {
    showToast(e.message || '查询详情失败', false)
  }
}

/**
 * 打开编辑弹窗
 */
function openEdit(record: AdminEquipmentRecord) {
  editModal.value = { show: true, record }
  Object.assign(editForm, {
    id: record.id,
    player_id: record.player_id,
    durability: record.durability,
    max_durability: record.max_durability,
    refine_level: record.refine_level,
    sort_order: record.sort_order,
    is_benming: record.is_benming,
    is_summoned: record.is_summoned,
    spirit_power: record.spirit_power
  })
}

/**
 * 提交编辑
 */
async function submitEdit() {
  operating.value = true
  try {
    const payload: UpdateEquipmentPayload = {
      durability: editForm.durability,
      max_durability: editForm.max_durability,
      refine_level: editForm.refine_level,
      sort_order: editForm.sort_order,
      is_benming: editForm.is_benming,
      is_summoned: editForm.is_summoned,
      spirit_power: editForm.spirit_power
    }
    await updateEquipmentRecord(editForm.player_id, editForm.id, payload)
    showToast('修改成功', true)
    editModal.value.show = false
    await fetchList(searchParams.page)
  } catch (e: any) {
    showToast(e.message || '修改失败', false)
  } finally {
    operating.value = false
  }
}

/**
 * 打开确认弹窗
 */
function openConfirm(action: 'reset' | 'repairAll' | 'delete', record: AdminEquipmentRecord | null, playerId: number = 0) {
  confirmModal.value = { show: true, action, record, playerId }
}

/**
 * 确认操作
 */
async function handleConfirm() {
  const { action, record, playerId } = confirmModal.value
  confirmModal.value.show = false
  operating.value = true
  try {
    let message = ''
    if (action === 'reset' && record) {
      const res = await resetEquipmentRecord(record.player_id, record.id)
      message = res.data?.message || '重置成功'
    } else if (action === 'repairAll') {
      const targetPlayerId = playerId || record?.player_id || 0
      if (!targetPlayerId) throw new Error('无效的玩家 ID')
      const res = await gmRepairAll(targetPlayerId)
      message = res.data?.message || 'GM 一键修理完成'
    } else if (action === 'delete' && record) {
      const res = await deleteEquipmentRecord(record.player_id, record.id)
      message = res.data?.message || '删除成功'
    }
    showToast(message, true)
    await fetchList(searchParams.page)
    // 若详情弹窗打开，刷新详情
    if (detailModal.value.show && record) {
      viewDetail(record)
    }
  } catch (e: any) {
    showToast(e.message || '操作失败', false)
  } finally {
    operating.value = false
  }
}

/**
 * 格式化时间
 */
function formatTime(t: string | null): string {
  if (!t) return '-'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

onMounted(() => {
  fetchList(1)
})
</script>

<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white">装备管理</h3>
      <button @click="fetchList(searchParams.page)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
    </div>

    <!-- 搜索区域 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">玩家ID/昵称：</label>
          <input
            v-model="searchParams.keyword"
            type="text"
            class="w-40 px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
            placeholder="ID 或 昵称"
            @keyup.enter="handleSearch"
          >
        </div>
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">槽位：</label>
          <select
            v-model="searchParams.slot"
            class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
          >
            <option value="">全部</option>
            <option value="weapon">武器</option>
            <option value="armor">护甲</option>
            <option value="accessory">饰品</option>
            <option value="boots">靴子</option>
            <option value="dharma">法器</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-400 whitespace-nowrap">本命：</label>
          <select
            v-model="searchParams.is_benming"
            class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
          >
            <option :value="undefined">全部</option>
            <option :value="true">是</option>
            <option :value="false">否</option>
          </select>
        </div>
        <button @click="handleSearch" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">查询</button>
        <button @click="resetSearch" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
      </div>
    </div>

    <!-- 装备列表表格 -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-900 text-gray-400">
            <tr>
              <th class="px-3 py-2 text-left whitespace-nowrap">记录ID</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">玩家ID</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">槽位</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">物品key</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">耐久</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">最大耐久</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">祭炼</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">本命</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">法力</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">祭出</th>
              <th class="px-3 py-2 text-left whitespace-nowrap">穿戴时间</th>
              <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="12" class="px-3 py-6 text-center text-gray-400">加载中...</td>
            </tr>
            <tr v-else-if="list.length === 0">
              <td colspan="12" class="px-3 py-6 text-center text-gray-400">暂无数据</td>
            </tr>
            <tr v-for="item in list" :key="item.id" class="border-t border-gray-700 hover:bg-gray-700/50">
              <td class="px-3 py-2 text-gray-300">{{ item.id }}</td>
              <td class="px-3 py-2 text-blue-300 cursor-pointer hover:underline" @click="viewDetail(item)">{{ item.player_id }}</td>
              <td class="px-3 py-2 text-gray-300">{{ item.slot }}</td>
              <td class="px-3 py-2 text-gray-300">{{ item.item_key }}</td>
              <td class="px-3 py-2" :class="item.durability <= 0 ? 'text-red-400' : 'text-gray-300'">{{ item.durability }}</td>
              <td class="px-3 py-2 text-gray-300">{{ item.max_durability }}</td>
              <td class="px-3 py-2 text-amber-300">+{{ item.refine_level }}</td>
              <td class="px-3 py-2">
                <span v-if="item.is_benming" class="text-amber-300">是 #{{ item.benming_slot }}</span>
                <span v-else class="text-gray-500">否</span>
              </td>
              <td class="px-3 py-2 text-gray-300">{{ item.spirit_power }}</td>
              <td class="px-3 py-2">
                <span v-if="item.is_summoned" class="text-cyan-300">已祭出</span>
                <span v-else class="text-gray-500">-</span>
              </td>
              <td class="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{{ formatTime(item.equipped_at) }}</td>
              <td class="px-3 py-2 text-center whitespace-nowrap">
                <button @click="openEdit(item)" class="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded text-white text-xs mr-1">编辑</button>
                <button @click="openConfirm('reset', item)" class="px-2 py-1 bg-blue-700 hover:bg-blue-600 rounded text-white text-xs mr-1">重置</button>
                <button @click="openConfirm('delete', item)" class="px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-white text-xs">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div class="px-4 py-3 border-t border-gray-700 flex justify-between items-center text-sm">
        <span class="text-gray-400">共 {{ total }} 条</span>
        <div class="flex gap-2">
          <button
            @click="fetchList(searchParams.page! - 1)"
            :disabled="searchParams.page! <= 1"
            class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-50"
          >上一页</button>
          <span class="text-gray-400">{{ searchParams.page }} / {{ totalPages }}</span>
          <button
            @click="fetchList(searchParams.page! + 1)"
            :disabled="searchParams.page! >= totalPages"
            class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-50"
          >下一页</button>
        </div>
      </div>
    </div>

    <!-- 详情弹窗 -->
    <Modal :show="detailModal.show" :title="`玩家装备详情 - ${detailModal.playerName}`" @close="detailModal.show = false">
      <div v-if="!detailData" class="text-gray-400 py-4">加载中...</div>
      <div v-else class="space-y-3">
        <div class="flex justify-between items-center bg-gray-800 p-3 rounded">
          <div>
            <div class="text-white">{{ detailData.player.nickname }} (#{{ detailData.player.id }})</div>
            <div class="text-xs text-gray-400">境界：{{ detailData.player.realm }} | 灵石：{{ detailData.player.spirit_stones }}</div>
          </div>
          <button
            @click="openConfirm('repairAll', null, detailData.player.id)"
            class="px-3 py-1 bg-blue-700 hover:bg-blue-600 rounded text-white text-sm"
          >GM 一键修理</button>
        </div>
        <div class="text-gray-300 text-sm">装备数量：{{ detailData.count }}</div>
        <div class="max-h-80 overflow-y-auto">
          <table class="w-full text-xs">
            <thead class="bg-gray-900 text-gray-400 sticky top-0">
              <tr>
                <th class="px-2 py-1 text-left">槽位</th>
                <th class="px-2 py-1 text-left">物品</th>
                <th class="px-2 py-1 text-left">耐久</th>
                <th class="px-2 py-1 text-left">祭炼</th>
                <th class="px-2 py-1 text-left">本命</th>
                <th class="px-2 py-1 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="eq in detailData.equipments" :key="eq.id" class="border-t border-gray-700">
                <td class="px-2 py-1 text-gray-300">{{ eq.slot }}</td>
                <td class="px-2 py-1 text-gray-300">{{ eq.item_key }}</td>
                <td class="px-2 py-1 text-gray-300">{{ eq.durability }}/{{ eq.max_durability }}</td>
                <td class="px-2 py-1 text-amber-300">+{{ eq.refine_level }}</td>
                <td class="px-2 py-1">
                  <span v-if="eq.is_benming" class="text-amber-300">#{{ eq.benming_slot }}</span>
                  <span v-else class="text-gray-500">-</span>
                </td>
                <td class="px-2 py-1 text-center">
                  <button @click="openEdit(eq)" class="px-2 py-0.5 bg-amber-700 hover:bg-amber-600 rounded text-white">编辑</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <template #footer>
        <button @click="detailModal.show = false" class="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white">关闭</button>
      </template>
    </Modal>

    <!-- 编辑弹窗 -->
    <Modal :show="editModal.show" title="编辑装备记录" @close="editModal.show = false">
      <div v-if="editModal.record" class="space-y-3">
        <div class="text-sm text-gray-400">
          记录 #{{ editModal.record.id }} | 玩家 #{{ editModal.record.player_id }} | {{ editModal.record.slot }} - {{ editModal.record.item_key }}
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-sm text-gray-400">耐久度 (0~999)</label>
            <input v-model.number="editForm.durability" type="number" min="0" max="999" class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm" />
          </div>
          <div>
            <label class="text-sm text-gray-400">最大耐久 (1~999)</label>
            <input v-model.number="editForm.max_durability" type="number" min="1" max="999" class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm" />
          </div>
          <div>
            <label class="text-sm text-gray-400">祭炼等级 (0~15)</label>
            <input v-model.number="editForm.refine_level" type="number" min="0" max="15" class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm" />
          </div>
          <div>
            <label class="text-sm text-gray-400">排序 (0~99)</label>
            <input v-model.number="editForm.sort_order" type="number" min="0" max="99" class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm" />
          </div>
          <div>
            <label class="text-sm text-gray-400">法力值 (0~9999)</label>
            <input v-model.number="editForm.spirit_power" type="number" min="0" max="9999" class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm" />
          </div>
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-2 text-sm text-gray-300">
              <input v-model="editForm.is_benming" type="checkbox" class="form-checkbox" />
              本命法器
            </label>
            <label class="flex items-center gap-2 text-sm text-gray-300">
              <input v-model="editForm.is_summoned" type="checkbox" class="form-checkbox" />
              已祭出
            </label>
          </div>
        </div>
      </div>
      <template #footer>
        <button @click="editModal.show = false" class="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white mr-2">取消</button>
        <button @click="submitEdit" :disabled="operating" class="px-4 py-2 text-sm rounded bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-50">保存</button>
      </template>
    </Modal>

    <!-- 确认弹窗 -->
    <Modal :show="confirmModal.show" title="操作确认" @close="confirmModal.show = false">
      <div class="text-gray-200">
        <template v-if="confirmModal.action === 'reset' && confirmModal.record">
          确认重置装备记录 #{{ confirmModal.record.id }}？将恢复初始耐久、祭炼等级清零、取消本命。
        </template>
        <template v-else-if="confirmModal.action === 'repairAll'">
          确认 GM 一键修理玩家 #{{ confirmModal.playerId }} 的所有装备？此操作无消耗，不扣减最大耐久。
        </template>
        <template v-else-if="confirmModal.action === 'delete' && confirmModal.record">
          确认删除装备记录 #{{ confirmModal.record.id }}？将强制卸下并归还物品到玩家背包。
        </template>
      </div>
      <template #footer>
        <button @click="confirmModal.show = false" class="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white mr-2">取消</button>
        <button @click="handleConfirm" :disabled="operating" class="px-4 py-2 text-sm rounded bg-red-700 hover:bg-red-600 text-white disabled:opacity-50">确认</button>
      </template>
    </Modal>

    <!-- 提示弹窗 -->
    <Modal :show="toastModal.show" title="操作结果" @close="toastModal.show = false">
      <div :class="toastModal.isSuccess ? 'text-green-300' : 'text-red-300'">{{ toastModal.message }}</div>
      <template #footer>
        <button @click="toastModal.show = false" class="px-4 py-2 text-sm rounded bg-amber-700 hover:bg-amber-600 text-white">确定</button>
      </template>
    </Modal>
  </div>
</template>
