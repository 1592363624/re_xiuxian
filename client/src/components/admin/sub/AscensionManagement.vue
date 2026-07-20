<template>
  <!--
    飞升+夺舍重生系统 GM 后台管理组件
    功能模块：
      1. 全局统计：飞升人数、成功率、活跃节点数、状态分布
      2. 玩家飞升进度列表：昵称、境界、大衍诀、法则碎片、坐标、状态
      3. GM 操作：调整大衍诀层数、发放法则碎片、发放逆灵通道坐标、重置飞升冷却
      4. 夺舍目标管理：列表、新增、编辑（CRUD）
    设计原则：
      - 所有数据从后端拉取，禁止硬编码
      - 写操作二次确认，避免误操作
      - 禁用浏览器原生 alert/confirm，使用自定义 Modal
      - GM 权限由后端 auth + adminCheck 中间件保障
  -->
  <div class="space-y-6">
    <!-- 顶部：标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-amber-300">飞升系统管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchStats"
          class="px-3 py-1 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm">刷新统计</button>
        <button @click="fetchPlayers"
          class="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-white text-sm">刷新列表</button>
      </div>
    </div>

    <!-- 统计指标卡片（4列网格） -->
    <div v-if="stats" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <!-- 已飞升玩家数（金色） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">已飞升玩家</div>
        <div class="text-2xl font-bold text-amber-300">{{ stats.total_ascended }}</div>
        <div class="text-[10px] text-gray-500 mt-1">成功飞升灵界人数</div>
      </div>
      <!-- 飞升成功率（绿色） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">飞升成功率</div>
        <div class="text-2xl font-bold text-emerald-400">{{ (stats.success_rate * 100).toFixed(1) }}%</div>
        <div class="text-[10px] text-gray-500 mt-1">{{ stats.total_success }}/{{ stats.total_attempts }} 次尝试</div>
      </div>
      <!-- 活跃节点数（青色） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">活跃节点</div>
        <div class="text-2xl font-bold text-cyan-400">{{ stats.active_nodes }}</div>
        <div class="text-[10px] text-gray-500 mt-1">当前已发现/稳固中节点数</div>
      </div>
      <!-- 准备中玩家数（紫色） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">准备中玩家</div>
        <div class="text-2xl font-bold text-purple-400">{{ stats.state_distribution.preparing }}</div>
        <div class="text-[10px] text-gray-500 mt-1">飞升中: {{ stats.state_distribution.ascending }} · 已失败: {{ stats.state_distribution.failed }}</div>
      </div>
    </div>

    <!-- 子 Tab 切换：玩家进度 / 夺舍目标 -->
    <div class="flex border-b border-gray-700 bg-gray-800/50">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        @click="switchTab(tab.id)"
        class="px-6 py-2 text-sm font-medium transition-colors relative whitespace-nowrap cursor-pointer"
        :class="currentSubTab === tab.id ? 'text-amber-300' : 'text-gray-400 hover:text-white hover:bg-gray-700/50'"
      >
        {{ tab.name }}
        <div v-if="currentSubTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-500"></div>
      </button>
    </div>

    <!-- 子 Tab 1：玩家飞升进度列表 -->
    <div v-if="currentSubTab === 'players'">
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <!-- 分页控制 -->
        <div class="flex justify-between items-center mb-3">
          <div class="text-sm text-gray-400">共 {{ playerList.total }} 条记录</div>
          <div class="flex items-center space-x-2">
            <button @click="changePage(playerList.page - 1)" :disabled="playerList.page <= 1"
              class="px-2 py-1 text-xs bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600">上一页</button>
            <span class="text-xs text-gray-400">{{ playerList.page }} / {{ playerList.total_pages }}</span>
            <button @click="changePage(playerList.page + 1)" :disabled="playerList.page >= playerList.total_pages"
              class="px-2 py-1 text-xs bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600">下一页</button>
          </div>
        </div>

        <!-- 玩家列表表格 -->
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-400 border-b border-gray-700">
                <th class="px-2 py-2">玩家</th>
                <th class="px-2 py-2">境界</th>
                <th class="px-2 py-2">大衍诀</th>
                <th class="px-2 py-2">法则碎片</th>
                <th class="px-2 py-2">坐标</th>
                <th class="px-2 py-2">状态</th>
                <th class="px-2 py-2">尝试/成功</th>
                <th class="px-2 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="player in playerList.list" :key="player.id"
                class="border-b border-gray-700/50 hover:bg-gray-700/30">
                <td class="px-2 py-2">
                  <div class="text-white font-bold">{{ player.nickname }}</div>
                  <div class="text-[10px] text-gray-500">ID: {{ player.player_id }}</div>
                </td>
                <td class="px-2 py-2 text-gray-300">{{ player.realm }}</td>
                <td class="px-2 py-2 text-purple-300">{{ player.dayan_level }}/5</td>
                <td class="px-2 py-2 text-cyan-300">{{ player.law_fragments_count }}/5</td>
                <td class="px-2 py-2 text-xs text-gray-400">{{ player.reverse_channel_coord || '—' }}</td>
                <td class="px-2 py-2">
                  <span class="text-[10px] px-2 py-0.5 rounded"
                    :class="getAscensionStateClass(player.ascension_state)">
                    {{ getAscensionStateLabel(player.ascension_state) }}
                  </span>
                </td>
                <td class="px-2 py-2 text-xs text-gray-400">
                  {{ player.ascension_attempt_count }}/{{ player.ascension_success_count }}
                </td>
                <td class="px-2 py-2">
                  <div class="flex flex-wrap gap-1">
                    <button @click="openDayanModal(player)"
                      class="text-[10px] px-2 py-0.5 bg-purple-900/40 border border-purple-700 text-purple-300 rounded hover:bg-purple-800/40">大衍诀</button>
                    <button @click="openLawFragmentModal(player)"
                      class="text-[10px] px-2 py-0.5 bg-cyan-900/40 border border-cyan-700 text-cyan-300 rounded hover:bg-cyan-800/40">法则碎片</button>
                    <button @click="openCoordModal(player)"
                      class="text-[10px] px-2 py-0.5 bg-amber-900/40 border border-amber-700 text-amber-300 rounded hover:bg-amber-800/40">坐标</button>
                    <button @click="openResetCooldownModal(player)"
                      class="text-[10px] px-2 py-0.5 bg-rose-900/40 border border-rose-700 text-rose-300 rounded hover:bg-rose-800/40">重置CD</button>
                  </div>
                </td>
              </tr>
              <tr v-if="playerList.list.length === 0">
                <td colspan="8" class="text-center py-6 text-gray-500">暂无玩家飞升档案数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 子 Tab 2：夺舍目标管理 -->
    <div v-if="currentSubTab === 'targets'">
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="flex justify-between items-center mb-3">
          <div class="text-sm text-gray-400">夺舍目标列表（共 {{ targets.length }} 条）</div>
          <button @click="openCreateTargetModal"
            class="px-3 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-sm">新增目标</button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-400 border-b border-gray-700">
                <th class="px-2 py-2">名称</th>
                <th class="px-2 py-2">类型</th>
                <th class="px-2 py-2">境界</th>
                <th class="px-2 py-2">继承比例</th>
                <th class="px-2 py-2">跌落</th>
                <th class="px-2 py-2">风险</th>
                <th class="px-2 py-2">权重</th>
                <th class="px-2 py-2">稀有</th>
                <th class="px-2 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="target in targets" :key="target.id"
                class="border-b border-gray-700/50 hover:bg-gray-700/30">
                <td class="px-2 py-2">
                  <div class="text-white font-bold">{{ target.target_name }}</div>
                  <div class="text-[10px] text-gray-500">{{ target.target_key }}</div>
                </td>
                <td class="px-2 py-2 text-gray-300">{{ getTargetTypeLabel(target.target_type) }}</td>
                <td class="px-2 py-2 text-gray-400">rank {{ target.realm_rank }}</td>
                <td class="px-2 py-2 text-emerald-300">{{ (target.inherit_ratio * 100).toFixed(0) }}%</td>
                <td class="px-2 py-2 text-amber-300">{{ target.drop_realm_count }} 大境界</td>
                <td class="px-2 py-2">
                  <span class="text-[10px] px-2 py-0.5 rounded"
                    :class="getRiskClass(target.risk_level)">
                    {{ target.risk_level }}
                  </span>
                </td>
                <td class="px-2 py-2 text-gray-400">{{ target.weight }}</td>
                <td class="px-2 py-2">
                  <span v-if="target.is_rare" class="text-[10px] px-2 py-0.5 rounded bg-amber-900/60 text-amber-300 border border-amber-700">稀有</span>
                  <span v-else class="text-gray-600">—</span>
                </td>
                <td class="px-2 py-2">
                  <button @click="openEditTargetModal(target)"
                    class="text-[10px] px-2 py-0.5 bg-blue-900/40 border border-blue-700 text-blue-300 rounded hover:bg-blue-800/40">编辑</button>
                </td>
              </tr>
              <tr v-if="targets.length === 0">
                <td colspan="9" class="text-center py-6 text-gray-500">暂无夺舍目标，请配置</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 大衍诀调整弹窗 -->
    <Modal :isOpen="dayanModal.open" title="调整大衍诀层数" @close="dayanModal.open = false">
      <div v-if="dayanModal.player" class="space-y-3">
        <div class="text-sm text-gray-300">
          玩家：<span class="font-bold text-white">{{ dayanModal.player.nickname }}</span>
          （当前：{{ dayanModal.player.dayan_level }} 层）
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">新层数（0-5）</label>
          <input v-model.number="dayanModal.value" type="number" min="0" max="5"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
        </div>
        <div class="flex justify-end gap-2">
          <button @click="dayanModal.open = false"
            class="px-4 py-2 text-sm bg-gray-700 rounded hover:bg-gray-600">取消</button>
          <button @click="submitDayanLevel"
            :disabled="dayanModal.loading"
            class="px-4 py-2 text-sm bg-purple-700 rounded hover:bg-purple-600 disabled:opacity-50">
            {{ dayanModal.loading ? '提交中...' : '确认调整' }}
          </button>
        </div>
      </div>
    </Modal>

    <!-- 法则碎片发放弹窗 -->
    <Modal :isOpen="lawFragmentModal.open" title="发放法则碎片" @close="lawFragmentModal.open = false">
      <div v-if="lawFragmentModal.player" class="space-y-3">
        <div class="text-sm text-gray-300">
          玩家：<span class="font-bold text-white">{{ lawFragmentModal.player.nickname }}</span>
          （当前：{{ lawFragmentModal.player.law_fragments_count }} 块）
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">发放数量（1-10）</label>
          <input v-model.number="lawFragmentModal.value" type="number" min="1" max="10"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
        </div>
        <div class="flex justify-end gap-2">
          <button @click="lawFragmentModal.open = false"
            class="px-4 py-2 text-sm bg-gray-700 rounded hover:bg-gray-600">取消</button>
          <button @click="submitLawFragment"
            :disabled="lawFragmentModal.loading"
            class="px-4 py-2 text-sm bg-cyan-700 rounded hover:bg-cyan-600 disabled:opacity-50">
            {{ lawFragmentModal.loading ? '提交中...' : '确认发放' }}
          </button>
        </div>
      </div>
    </Modal>

    <!-- 坐标发放弹窗 -->
    <Modal :isOpen="coordModal.open" title="发放逆灵通道坐标" @close="coordModal.open = false">
      <div v-if="coordModal.player" class="space-y-3">
        <div class="text-sm text-gray-300">
          玩家：<span class="font-bold text-white">{{ coordModal.player.nickname }}</span>
          （当前坐标：{{ coordModal.player.reverse_channel_coord || '无' }}）
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">坐标字符串（留空则自动生成）</label>
          <input v-model="coordModal.value" type="text" placeholder="例如：东经135.2北纬28.4"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
        </div>
        <div class="text-xs text-gray-500">提示：留空将自动生成随机坐标</div>
        <div class="flex justify-end gap-2">
          <button @click="coordModal.open = false"
            class="px-4 py-2 text-sm bg-gray-700 rounded hover:bg-gray-600">取消</button>
          <button @click="submitCoord"
            :disabled="coordModal.loading"
            class="px-4 py-2 text-sm bg-amber-700 rounded hover:bg-amber-600 disabled:opacity-50">
            {{ coordModal.loading ? '提交中...' : '确认发放' }}
          </button>
        </div>
      </div>
    </Modal>

    <!-- 重置冷却确认弹窗 -->
    <Modal :isOpen="resetCdModal.open" title="重置飞升冷却" @close="resetCdModal.open = false">
      <div v-if="resetCdModal.player" class="space-y-3">
        <div class="text-sm text-gray-300">
          确认重置玩家 <span class="font-bold text-white">{{ resetCdModal.player.nickname }}</span> 的飞升冷却？<br>
          重置后玩家可立即再次尝试飞升。
        </div>
        <div class="flex justify-end gap-2">
          <button @click="resetCdModal.open = false"
            class="px-4 py-2 text-sm bg-gray-700 rounded hover:bg-gray-600">取消</button>
          <button @click="submitResetCooldown"
            :disabled="resetCdModal.loading"
            class="px-4 py-2 text-sm bg-rose-700 rounded hover:bg-rose-600 disabled:opacity-50">
            {{ resetCdModal.loading ? '提交中...' : '确认重置' }}
          </button>
        </div>
      </div>
    </Modal>

    <!-- 新增/编辑夺舍目标弹窗 -->
    <Modal :isOpen="targetModal.open" :title="targetModal.isEdit ? '编辑夺舍目标' : '新增夺舍目标'" @close="targetModal.open = false">
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-sm text-gray-400 mb-1">目标标识*</label>
            <input v-model="targetModal.form.target_key" type="text" :disabled="targetModal.isEdit"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white disabled:opacity-50">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">目标名称*</label>
            <input v-model="targetModal.form.target_name" type="text"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">类型*</label>
            <select v-model="targetModal.form.target_type"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
              <option value="mortal">凡人</option>
              <option value="cultivator">修士</option>
              <option value="monster">妖兽</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">境界排名*</label>
            <input v-model.number="targetModal.form.realm_rank" type="number" min="0"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">继承比例*</label>
            <input v-model.number="targetModal.form.inherit_ratio" type="number" min="0" max="1" step="0.1"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">境界跌落*</label>
            <input v-model.number="targetModal.form.drop_realm_count" type="number" min="1" max="5"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">风险等级*</label>
            <select v-model.number="targetModal.form.risk_level"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
              <option :value="1">1（低）</option>
              <option :value="2">2（中）</option>
              <option :value="3">3（高）</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">权重</label>
            <input v-model.number="targetModal.form.weight" type="number" min="0"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">基础攻击</label>
            <input v-model.number="targetModal.form.base_atk" type="number"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">基础防御</label>
            <input v-model.number="targetModal.form.base_def" type="number"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">基础HP</label>
            <input v-model.number="targetModal.form.base_hp_max" type="number"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">基础速度</label>
            <input v-model.number="targetModal.form.base_speed" type="number"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">基础神识</label>
            <input v-model.number="targetModal.form.base_sense" type="number"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">稀有目标</label>
            <select v-model="targetModal.form.is_rare"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
              <option :value="false">否</option>
              <option :value="true">是</option>
            </select>
          </div>
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">描述</label>
          <textarea v-model="targetModal.form.description" rows="3"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"></textarea>
        </div>
        <div class="flex justify-end gap-2">
          <button @click="targetModal.open = false"
            class="px-4 py-2 text-sm bg-gray-700 rounded hover:bg-gray-600">取消</button>
          <button @click="submitTarget"
            :disabled="targetModal.loading"
            class="px-4 py-2 text-sm bg-rose-700 rounded hover:bg-rose-600 disabled:opacity-50">
            {{ targetModal.loading ? '提交中...' : (targetModal.isEdit ? '确认编辑' : '确认新增') }}
          </button>
        </div>
      </div>
    </Modal>
  </div>
</template>

<script setup lang="ts">
/**
 * 飞升系统 GM 管理组件脚本
 * 使用 Composition API，所有数据从后端拉取
 */
import { ref, reactive, onMounted } from 'vue';
import Modal from '../../common/Modal.vue';
import { useUIStore } from '../../../stores/ui';
import {
  gmGetStats,
  gmGetPlayerList,
  gmSetDayanLevel,
  gmGiveLawFragment,
  gmGiveCoord,
  gmResetCooldown,
  gmGetTargets,
  gmCreateTarget,
  gmUpdateTarget,
  type AscensionStats,
  type PlayerAscensionList,
  type PlayerAscensionListItem
} from '../../../api/ascension';

const uiStore = useUIStore();

/** 全局统计数据 */
const stats = ref<AscensionStats | null>(null);
/** 玩家飞升进度列表 */
const playerList = ref<PlayerAscensionList>({ list: [], total: 0, page: 1, page_size: 20, total_pages: 0 });
/** 夺舍目标列表 */
const targets = ref<any[]>([]);
/** 当前子 Tab */
const currentSubTab = ref<'players' | 'targets'>('players');

/** 子 Tab 配置 */
const subTabs = [
  { id: 'players', name: '玩家飞升进度' },
  { id: 'targets', name: '夺舍目标管理' }
];

/** 大衍诀调整弹窗 */
const dayanModal = reactive({
  open: false,
  player: null as PlayerAscensionListItem | null,
  value: 0,
  loading: false
});

/** 法则碎片发放弹窗 */
const lawFragmentModal = reactive({
  open: false,
  player: null as PlayerAscensionListItem | null,
  value: 1,
  loading: false
});

/** 坐标发放弹窗 */
const coordModal = reactive({
  open: false,
  player: null as PlayerAscensionListItem | null,
  value: '',
  loading: false
});

/** 重置冷却弹窗 */
const resetCdModal = reactive({
  open: false,
  player: null as PlayerAscensionListItem | null,
  loading: false
});

/** 夺舍目标新增/编辑弹窗 */
const targetModal = reactive({
  open: false,
  isEdit: false,
  editId: 0,
  loading: false,
  form: {
    target_key: '',
    target_name: '',
    target_type: 'mortal' as 'mortal' | 'cultivator' | 'monster',
    realm_rank: 0,
    inherit_ratio: 0.3,
    drop_realm_count: 1,
    risk_level: 1 as 1 | 2 | 3,
    weight: 100,
    base_atk: 100,
    base_def: 50,
    base_hp_max: 1000,
    base_speed: 10,
    base_sense: 10,
    is_rare: false,
    description: ''
  }
});

/**
 * 组件挂载时拉取初始数据
 */
onMounted(async () => {
  await Promise.all([fetchStats(), fetchPlayers(), fetchTargets()]);
});

/**
 * 拉取全局统计数据
 */
async function fetchStats() {
  try {
    const resp = await gmGetStats();
    if (resp.data?.code === 200 && resp.data.data) {
      stats.value = resp.data.data;
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '获取统计失败', 'error');
  }
}

/**
 * 拉取玩家飞升进度列表
 */
async function fetchPlayers() {
  try {
    const resp = await gmGetPlayerList(playerList.value.page, playerList.value.page_size);
    if (resp.data?.code === 200 && resp.data.data) {
      playerList.value = resp.data.data;
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '获取玩家列表失败', 'error');
  }
}

/**
 * 拉取夺舍目标列表
 */
async function fetchTargets() {
  try {
    const resp = await gmGetTargets();
    if (resp.data?.code === 200 && resp.data.data) {
      targets.value = resp.data.data;
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '获取夺舍目标失败', 'error');
  }
}

/**
 * 切换子 Tab
 */
function switchTab(tabId: 'players' | 'targets') {
  currentSubTab.value = tabId;
}

/**
 * 翻页
 */
function changePage(page: number) {
  if (page < 1 || page > playerList.value.total_pages) return;
  playerList.value.page = page;
  fetchPlayers();
}

/**
 * 打开大衍诀调整弹窗
 */
function openDayanModal(player: PlayerAscensionListItem) {
  dayanModal.player = player;
  dayanModal.value = player.dayan_level;
  dayanModal.open = true;
}

/**
 * 提交大衍诀层数调整
 */
async function submitDayanLevel() {
  if (!dayanModal.player) return;
  if (dayanModal.value < 0 || dayanModal.value > 5) {
    uiStore.showToast('大衍诀层数必须在 0-5 之间', 'error');
    return;
  }
  dayanModal.loading = true;
  try {
    const resp = await gmSetDayanLevel(dayanModal.player.player_id, dayanModal.value);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '调整成功', 'success');
      dayanModal.open = false;
      await fetchPlayers();
    } else {
      uiStore.showToast(resp.data?.message || '调整失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    dayanModal.loading = false;
  }
}

/**
 * 打开法则碎片发放弹窗
 */
function openLawFragmentModal(player: PlayerAscensionListItem) {
  lawFragmentModal.player = player;
  lawFragmentModal.value = 1;
  lawFragmentModal.open = true;
}

/**
 * 提交法则碎片发放
 */
async function submitLawFragment() {
  if (!lawFragmentModal.player) return;
  if (lawFragmentModal.value < 1 || lawFragmentModal.value > 10) {
    uiStore.showToast('数量必须在 1-10 之间', 'error');
    return;
  }
  lawFragmentModal.loading = true;
  try {
    const resp = await gmGiveLawFragment(lawFragmentModal.player.player_id, lawFragmentModal.value);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '发放成功', 'success');
      lawFragmentModal.open = false;
      await fetchPlayers();
    } else {
      uiStore.showToast(resp.data?.message || '发放失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    lawFragmentModal.loading = false;
  }
}

/**
 * 打开坐标发放弹窗
 */
function openCoordModal(player: PlayerAscensionListItem) {
  coordModal.player = player;
  coordModal.value = '';
  coordModal.open = true;
}

/**
 * 提交坐标发放
 */
async function submitCoord() {
  if (!coordModal.player) return;
  coordModal.loading = true;
  try {
    const resp = await gmGiveCoord(coordModal.player.player_id, coordModal.value || undefined);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '发放成功', 'success');
      coordModal.open = false;
      await fetchPlayers();
    } else {
      uiStore.showToast(resp.data?.message || '发放失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    coordModal.loading = false;
  }
}

/**
 * 打开重置冷却确认弹窗
 */
function openResetCooldownModal(player: PlayerAscensionListItem) {
  resetCdModal.player = player;
  resetCdModal.open = true;
}

/**
 * 提交重置冷却
 */
async function submitResetCooldown() {
  if (!resetCdModal.player) return;
  resetCdModal.loading = true;
  try {
    const resp = await gmResetCooldown(resetCdModal.player.player_id);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '重置成功', 'success');
      resetCdModal.open = false;
      await fetchPlayers();
    } else {
      uiStore.showToast(resp.data?.message || '重置失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    resetCdModal.loading = false;
  }
}

/**
 * 打开新增夺舍目标弹窗
 */
function openCreateTargetModal() {
  targetModal.isEdit = false;
  targetModal.editId = 0;
  targetModal.form = {
    target_key: '',
    target_name: '',
    target_type: 'mortal',
    realm_rank: 0,
    inherit_ratio: 0.3,
    drop_realm_count: 1,
    risk_level: 1,
    weight: 100,
    base_atk: 100,
    base_def: 50,
    base_hp_max: 1000,
    base_speed: 10,
    base_sense: 10,
    is_rare: false,
    description: ''
  };
  targetModal.open = true;
}

/**
 * 打开编辑夺舍目标弹窗
 */
function openEditTargetModal(target: any) {
  targetModal.isEdit = true;
  targetModal.editId = target.id;
  targetModal.form = {
    target_key: target.target_key,
    target_name: target.target_name,
    target_type: target.target_type,
    realm_rank: target.realm_rank,
    inherit_ratio: target.inherit_ratio,
    drop_realm_count: target.drop_realm_count,
    risk_level: target.risk_level,
    weight: target.weight,
    base_atk: target.base_atk || 100,
    base_def: target.base_def || 50,
    base_hp_max: target.base_hp_max || 1000,
    base_speed: target.base_speed || 10,
    base_sense: target.base_sense || 10,
    is_rare: target.is_rare || false,
    description: target.description || ''
  };
  targetModal.open = true;
}

/**
 * 提交新增/编辑夺舍目标
 */
async function submitTarget() {
  if (!targetModal.form.target_key || !targetModal.form.target_name) {
    uiStore.showToast('目标标识和名称必填', 'error');
    return;
  }
  targetModal.loading = true;
  try {
    const resp = targetModal.isEdit
      ? await gmUpdateTarget(targetModal.editId, targetModal.form)
      : await gmCreateTarget(targetModal.form);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || (targetModal.isEdit ? '编辑成功' : '新增成功'), 'success');
      targetModal.open = false;
      await fetchTargets();
    } else {
      uiStore.showToast(resp.data?.message || '操作失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    targetModal.loading = false;
  }
}

/**
 * 获取飞升状态中文标签
 */
function getAscensionStateLabel(state: string): string {
  const map: Record<string, string> = {
    preparing: '准备中',
    ascending: '飞升中',
    failed: '已失败'
  };
  return map[state] || state;
}

/**
 * 获取飞升状态样式类
 */
function getAscensionStateClass(state: string): string {
  const map: Record<string, string> = {
    preparing: 'bg-stone-900/60 text-stone-300 border border-stone-700',
    ascending: 'bg-amber-900/60 text-amber-300 border border-amber-700',
    failed: 'bg-rose-900/60 text-rose-300 border border-rose-700'
  };
  return map[state] || 'bg-stone-900/60 text-stone-300 border border-stone-700';
}

/**
 * 获取目标类型中文标签
 */
function getTargetTypeLabel(type: string): string {
  const map: Record<string, string> = {
    mortal: '凡人',
    cultivator: '修士',
    monster: '妖兽'
  };
  return map[type] || type;
}

/**
 * 获取风险等级样式类
 */
function getRiskClass(risk: number): string {
  const map: Record<number, string> = {
    1: 'bg-emerald-900/60 text-emerald-300 border border-emerald-700',
    2: 'bg-amber-900/60 text-amber-300 border border-amber-700',
    3: 'bg-rose-900/60 text-rose-300 border border-rose-700'
  };
  return map[risk] || 'bg-stone-900/60 text-stone-300 border border-stone-700';
}
</script>
