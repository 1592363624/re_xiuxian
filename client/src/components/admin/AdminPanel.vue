<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
    <div class="bg-gray-900 border border-gray-700 w-full max-w-6xl h-[85vh] flex flex-col rounded-lg shadow-2xl">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800">
        <h2 class="text-xl font-bold text-xiuxian-gold">GM 管理后台</h2>
        <button @click="$emit('close')" class="text-gray-400 hover:text-white">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-700 bg-gray-800/50 overflow-x-auto">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="currentTab = tab.id"
          class="px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap cursor-pointer"
          :class="currentTab === tab.id ? 'text-xiuxian-gold' : 'text-gray-400 hover:text-white hover:bg-gray-700/50'"
        >
          {{ tab.name }}
          <div v-if="currentTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-xiuxian-gold"></div>
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto p-4 custom-scrollbar">
        <!-- 玩家管理 -->
        <PlayerManagement
          v-if="currentTab === 'players'"
          ref="playerManagementRef"
          @editPlayer="editPlayer"
          @banPlayer="showBanModal"
          @unbanPlayer="unbanPlayer"
          @givePlayer="showGiveModal"
        />

        <!-- 系统配置 -->
        <SystemConfig
          v-if="currentTab === 'config'"
          @timeTravelComplete="handleTimeTravelComplete"
          @showConfirm="showConfirm"
        />

        <!-- AI 配置管理 -->
        <AIConfig v-if="currentTab === 'ai_config'" />

        <!-- 通知管理 -->
        <NotificationManagement
          v-if="currentTab === 'notifications'"
          ref="notificationManagementRef"
          @showConfirm="showConfirm"
        />

        <!-- 服务器统计 -->
        <ServerStats v-if="currentTab === 'stats'" ref="serverStatsRef" />

        <!-- 操作日志 -->
        <OperationLogs v-if="currentTab === 'logs'" ref="operationLogsRef" />
      </div>
    </div>

    <!-- 编辑玩家弹窗 -->
    <Modal :isOpen="!!editingPlayer" title="编辑玩家" @close="editingPlayer = null">
      <div v-if="editingPlayer" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm text-gray-400 mb-1">账号</label>
            <input :value="editingPlayer.username" disabled class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-gray-500">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">昵称</label>
            <input v-model="editingPlayer.nickname" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">修为 (Exp)</label>
            <input v-model.number="editingPlayer.exp" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">灵石</label>
            <input v-model.number="editingPlayer.spirit_stones" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">境界</label>
            <input v-model="editingPlayer.realm" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">当前寿元</label>
            <input v-model.number="editingPlayer.lifespan_current" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">最大寿元</label>
            <input v-model.number="editingPlayer.lifespan_max" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">角色权限</label>
            <select v-model="editingPlayer.role" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
        </div>
      </div>
      <template #footer>
        <button @click="editingPlayer = null" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="submitPlayerEdit" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded">保存</button>
      </template>
    </Modal>

    <!-- 封禁玩家弹窗 -->
    <Modal :isOpen="!!banningPlayer" title="封禁玩家" @close="banningPlayer = null">
      <div v-if="banningPlayer" class="space-y-4">
        <p class="text-gray-300">封禁玩家: <span class="text-xiuxian-gold">{{ banningPlayer.nickname }}</span></p>
        <div>
          <label class="block text-sm text-gray-400 mb-1">封禁原因</label>
          <input v-model="banReason" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" placeholder="输入封禁原因">
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">封禁天数 (-1表示永久)</label>
          <input v-model.number="banDays" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
      </div>
      <template #footer>
        <button @click="banningPlayer = null" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="confirmBan" class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded">确认封禁</button>
      </template>
    </Modal>

    <!-- 发放物品弹窗 -->
    <Modal :isOpen="!!givingPlayer" title="发放物品" @close="givingPlayer = null">
      <div v-if="givingPlayer" class="space-y-4">
        <p class="text-gray-300">发放给: <span class="text-xiuxian-gold">{{ givingPlayer.nickname }}</span></p>

        <div>
          <label class="block text-sm text-gray-400 mb-1">发放类型</label>
          <select v-model="giveType" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="item">物品</option>
            <option value="spirit_stones">灵石</option>
            <option value="exp">修为</option>
          </select>
        </div>

        <div v-if="giveType === 'item'">
          <label class="block text-sm text-gray-400 mb-1">物品ID</label>
          <input v-model="giveItemId" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" placeholder="输入物品ID">
          <p class="mt-1 text-xs text-gray-500">提示: 可用物品ID见 item_data.json 配置</p>
        </div>

        <div v-if="giveType === 'item'">
          <label class="block text-sm text-gray-400 mb-1">数量</label>
          <input v-model.number="giveQuantity" type="number" min="1" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>

        <div v-if="giveType === 'spirit_stones'">
          <label class="block text-sm text-gray-400 mb-1">灵石数量</label>
          <input v-model.number="giveAmount" type="number" min="1" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>

        <div v-if="giveType === 'exp'">
          <label class="block text-sm text-gray-400 mb-1">修为数量</label>
          <input v-model.number="giveAmount" type="number" min="1" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
      </div>
      <template #footer>
        <button @click="givingPlayer = null" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="confirmGive" class="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded">确认发放</button>
      </template>
    </Modal>

    <!-- 确认对话框 -->
    <Modal :isOpen="confirmDialog.show" title="确认操作" @close="confirmDialog.show = false" width="400px">
      <p class="text-gray-300 whitespace-pre-line">{{ confirmDialog.message }}</p>
      <template #footer>
        <button @click="confirmDialog.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">
          取消
        </button>
        <button @click="handleConfirm" class="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded">
          确认
        </button>
      </template>
    </Modal>

    <!-- Death Modal -->
    <Modal :isOpen="showDeathModal" title="⚠️ 噩耗" :showClose="true" @close="showDeathModal = false">
      <div class="space-y-6 text-center py-4">
        <div class="text-6xl">🪦</div>
        <h3 class="text-2xl font-bold text-red-500">寿元已尽</h3>
        <p class="text-gray-300 text-lg">{{ deathMessage }}</p>
        <p class="text-gray-400">你的境界已跌落，请重新来过。</p>
      </div>
      <template #footer>
        <button @click="showDeathModal = false" class="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">
          黯然接受
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * GM 管理后台主组件
 * 负责 Tab 导航和弹窗管理，具体功能委托给子组件
 */
import { ref, reactive } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import Modal from '../common/Modal.vue'
import PlayerManagement from './sub/PlayerManagement.vue'
import SystemConfig from './sub/SystemConfig.vue'
import NotificationManagement from './sub/NotificationManagement.vue'
import ServerStats from './sub/ServerStats.vue'
import OperationLogs from './sub/OperationLogs.vue'
import AIConfig from './sub/AIConfig.vue'
import {
  updatePlayer,
  banPlayer,
  unbanPlayerApi,
  giveItem,
  giveSpiritStones,
  giveExp
} from '../../api/admin'

const emit = defineEmits(['close'])
const playerStore = usePlayerStore()
const uiStore = useUIStore()

// Tab 配置
const tabs = [
  { id: 'players', name: '玩家数据' },
  { id: 'config', name: '系统配置' },
  { id: 'ai_config', name: 'AI 配置' },
  { id: 'notifications', name: '通知管理' },
  { id: 'stats', name: '服务器统计' },
  { id: 'logs', name: '操作日志' }
]
const currentTab = ref('players')

// 子组件引用
const playerManagementRef = ref(null)
const notificationManagementRef = ref(null)
const serverStatsRef = ref(null)
const operationLogsRef = ref(null)

// 自定义确认对话框
const confirmDialog = reactive({
  show: false,
  title: '',
  message: '',
  onConfirm: null
})

/**
 * 显示确认对话框
 */
const showConfirm = (title, message, onConfirm) => {
  confirmDialog.title = title
  confirmDialog.message = message
  confirmDialog.onConfirm = onConfirm
  confirmDialog.show = true
}

/**
 * 处理确认操作
 */
const handleConfirm = () => {
  if (confirmDialog.onConfirm) {
    confirmDialog.onConfirm()
  }
  confirmDialog.show = false
}

// 编辑玩家
const editingPlayer = ref(null)

/**
 * 编辑玩家
 */
const editPlayer = (player) => {
  // 深拷贝防止直接修改显示
  editingPlayer.value = JSON.parse(JSON.stringify(player))
}

/**
 * 提交玩家编辑
 */
const submitPlayerEdit = async () => {
  if (!editingPlayer.value) return
  try {
    await updatePlayer(editingPlayer.value.id, editingPlayer.value)
    uiStore.showToast('玩家信息更新成功', 'success')
    editingPlayer.value = null
    playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
  } catch (error) {
    uiStore.showToast('更新失败: ' + (error.response?.data?.message || error.message), 'error')
  }
}

// 封禁功能相关
const banningPlayer = ref(null)
const banReason = ref('')
const banDays = ref(-1)

/**
 * 显示封禁弹窗
 */
const showBanModal = (player) => {
  banningPlayer.value = player
  banReason.value = ''
  banDays.value = -1
}

/**
 * 确认封禁
 */
const confirmBan = async () => {
  if (!banningPlayer.value) return
  try {
    await banPlayer(banningPlayer.value.id, banReason.value, banDays.value)
    uiStore.showToast('封禁成功', 'success')
    banningPlayer.value = null
    playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
  } catch (error) {
    uiStore.showToast('封禁失败: ' + (error.response?.data?.message || error.message), 'error')
  }
}

/**
 * 解封玩家
 */
const unbanPlayer = (player) => {
  showConfirm('解封玩家', `确定要解封玩家 ${player.nickname} 吗？`, async () => {
    try {
      await unbanPlayerApi(player.id)
      uiStore.showToast('解封成功', 'success')
      playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
    } catch (error) {
      uiStore.showToast('解封失败: ' + (error.response?.data?.message || error.message), 'error')
    }
  })
}

// 发放功能相关
const givingPlayer = ref(null)
const giveType = ref('item')
const giveItemId = ref('')
const giveQuantity = ref(1)
const giveAmount = ref(0)

/**
 * 显示发放弹窗
 */
const showGiveModal = (player) => {
  givingPlayer.value = player
  giveType.value = 'item'
  giveItemId.value = ''
  giveQuantity.value = 1
  giveAmount.value = 0
}

/**
 * 确认发放
 */
const confirmGive = async () => {
  if (!givingPlayer.value) return
  try {
    if (giveType.value === 'item') {
      if (!giveItemId.value) {
        uiStore.showToast('请输入物品ID', 'warning')
        return
      }
      await giveItem(givingPlayer.value.id, giveItemId.value, giveQuantity.value)
      uiStore.showToast('物品发放成功', 'success')
    } else if (giveType.value === 'spirit_stones') {
      await giveSpiritStones(givingPlayer.value.id, giveAmount.value)
      uiStore.showToast('灵石发放成功', 'success')
    } else if (giveType.value === 'exp') {
      await giveExp(givingPlayer.value.id, giveAmount.value)
      uiStore.showToast('修为发放成功', 'success')
    }
    givingPlayer.value = null
    playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
  } catch (error) {
    uiStore.showToast('发放失败: ' + (error.response?.data?.message || error.message), 'error')
  }
}

// 死亡弹窗
const showDeathModal = ref(false)
const deathMessage = ref('')

/**
 * 处理时间加速完成
 */
const handleTimeTravelComplete = async (result) => {
  // 刷新玩家数据
  try {
    await playerStore.fetchPlayer()
  } catch (e) {
    console.warn('Refresh player failed:', e)
  }

  // 刷新管理员面板的玩家列表（如果当前在看列表）
  if (currentTab.value === 'players') {
    playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
  }

  // 检查死亡通知
  if (result.died) {
    deathMessage.value = result.message || '寿元耗尽，身死道消。'
    showDeathModal.value = true
  }
}
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: #1f2937;
  border-radius: 4px;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #4b5563;
  border-radius: 4px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #6b7280;
}
</style>
