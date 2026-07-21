<template>
  <div class="space-y-6">
    <!-- 顶部：标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white">灵兽系统管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchBeastList()"
          class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新列表</button>
        <button @click="fetchStats"
          class="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white text-sm">更新指标</button>
        <button @click="openGiveModal"
          class="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-white text-sm">GM 发放灵兽</button>
      </div>
    </div>

    <!-- 统计指标卡片（4列网格） -->
    <div v-if="stats" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">总灵兽数</div>
        <div class="text-2xl font-bold text-emerald-400">{{ stats.total_beasts }}</div>
        <div class="text-[10px] text-gray-500 mt-1">全服灵兽实例总数</div>
      </div>
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">出战灵兽</div>
        <div class="text-2xl font-bold text-orange-400">{{ stats.active_beasts }}</div>
        <div class="text-[10px] text-gray-500 mt-1">玩家正在出战的灵兽数</div>
      </div>
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">拥有玩家数</div>
        <div class="text-2xl font-bold text-cyan-400">{{ stats.players_with_beasts }}</div>
        <div class="text-[10px] text-gray-500 mt-1">拥有灵兽的玩家数（去重）</div>
      </div>
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">今日新增</div>
        <div class="text-2xl font-bold text-pink-400">{{ stats.today_new_beasts }}</div>
        <div class="text-[10px] text-gray-500 mt-1">今日零点后新增捕获数</div>
      </div>
    </div>

    <!-- 子 Tab 切换：灵兽列表 / 分布统计 -->
    <div class="flex border-b border-gray-700 bg-gray-800/50">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        @click="switchTab(tab.id)"
        class="px-6 py-2 text-sm font-medium transition-colors relative whitespace-nowrap cursor-pointer"
        :class="currentSubTab === tab.id ? 'text-emerald-400' : 'text-gray-400 hover:text-white hover:bg-gray-700/50'"
      >
        {{ tab.name }}
        <div v-if="currentSubTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-emerald-500"></div>
      </button>
    </div>

    <!-- 子 Tab 1：灵兽列表 -->
    <div v-if="currentSubTab === 'beasts'">
      <!-- 筛选区 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">玩家ID</label>
            <input v-model="searchParams.player_id" type="number" placeholder="精确匹配"
              class="w-full px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">种类</label>
            <select v-model="searchParams.beast_key"
              class="w-full px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">全部</option>
              <option v-for="b in BEAST_KEY_LIST" :key="b.value" :value="b.value">{{ b.label }}</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">稀有度</label>
            <select v-model="searchParams.rarity"
              class="w-full px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">全部</option>
              <option v-for="r in RARITY_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">元素</label>
            <select v-model="searchParams.element"
              class="w-full px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">全部</option>
              <option v-for="e in ELEMENT_OPTIONS" :key="e.value" :value="e.value">{{ e.label }}</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">出战状态</label>
            <select v-model="searchParams.is_active"
              class="w-full px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">全部</option>
              <option value="true">出战中</option>
              <option value="false">未出战</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">昵称搜索</label>
            <input v-model="searchParams.keyword" placeholder="模糊匹配"
              class="w-full px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div class="flex items-end gap-2 md:col-span-2">
            <button @click="handleSearch"
              class="px-4 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">查询</button>
            <button @click="resetSearch"
              class="px-4 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
          </div>
        </div>
      </div>

      <!-- 灵兽列表表格 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden mt-3">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">灵兽ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">玩家</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">种类/名称</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">稀有度</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">元素</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">星级</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">等级</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">忠诚</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">出战</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">属性(HP/ATK/DEF/SPD)</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="beastLoading" class="text-center text-gray-500">
                <td colspan="11" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="beastList.length === 0" class="text-center text-gray-500">
                <td colspan="11" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="b in beastList" :key="b.beast_id" class="border-t border-gray-700 hover:bg-gray-750">
                <td class="px-3 py-2 text-gray-400">{{ b.beast_id }}</td>
                <td class="px-3 py-2 text-white">
                  <div>{{ b.player_nickname || '未知' }}</div>
                  <div class="text-[10px] text-gray-500">ID:{{ b.player_id }} · {{ b.player_realm || '未知' }}</div>
                </td>
                <td class="px-3 py-2 text-white">
                  <div>{{ beastKeyLabel(b.beast_key) }}</div>
                  <div class="text-[10px] text-gray-500">{{ b.beast_name || '(默认名)' }}</div>
                </td>
                <td class="px-3 py-2">
                  <span :class="rarityClass(b.rarity)" class="px-2 py-0.5 rounded text-xs">
                    {{ rarityLabel(b.rarity) }}
                  </span>
                </td>
                <td class="px-3 py-2">
                  <span :class="elementClass(b.element)" class="px-2 py-0.5 rounded text-xs">
                    {{ elementLabel(b.element) }}
                  </span>
                </td>
                <td class="px-3 py-2 text-yellow-400">★{{ b.star_level }}</td>
                <td class="px-3 py-2 text-cyan-400">Lv.{{ b.level }}</td>
                <td class="px-3 py-2">
                  <span :class="b.loyalty < 30 ? 'text-red-400' : 'text-gray-300'">{{ b.loyalty }}</span>
                </td>
                <td class="px-3 py-2">
                  <span v-if="b.is_active" class="text-emerald-400">出战</span>
                  <span v-else class="text-gray-500">—</span>
                </td>
                <td class="px-3 py-2 text-xs text-gray-300 whitespace-nowrap">
                  {{ b.hp_max }} / {{ b.atk }} / {{ b.def }} / {{ b.speed }}
                </td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <button @click="openEditModal(b)" class="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs mr-1">编辑</button>
                  <button @click="handleSetActive(b)" class="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-600 rounded text-white text-xs mr-1">
                    {{ b.is_active ? '取消出战' : '强制出战' }}
                  </button>
                  <button @click="handleResetCooldowns(b)" class="px-2 py-0.5 bg-purple-700 hover:bg-purple-600 rounded text-white text-xs mr-1">重置CD</button>
                  <button @click="handleDelete(b)" class="px-2 py-0.5 bg-red-700 hover:bg-red-600 rounded text-white text-xs">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 分页 -->
        <div class="flex items-center justify-between p-3 border-t border-gray-700 text-sm">
          <div class="text-gray-400">共 {{ pagination.total }} 条</div>
          <div class="flex items-center gap-2">
            <button @click="fetchBeastList(pagination.page - 1)" :disabled="pagination.page <= 1"
              class="px-3 py-1 bg-gray-700 rounded text-white text-xs disabled:opacity-50">上一页</button>
            <span class="text-gray-400">{{ pagination.page }} / {{ pagination.totalPages }}</span>
            <button @click="fetchBeastList(pagination.page + 1)" :disabled="pagination.page >= pagination.totalPages"
              class="px-3 py-1 bg-gray-700 rounded text-white text-xs disabled:opacity-50">下一页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 子 Tab 2：分布统计 -->
    <div v-if="currentSubTab === 'distribution'">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- 稀有度分布 -->
        <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
          <h4 class="text-sm text-gray-400 mb-3">稀有度分布</h4>
          <div v-if="stats" class="space-y-2">
            <div v-for="r in stats.rarity_distribution" :key="r.rarity" class="flex items-center gap-2">
              <span :class="rarityClass(r.rarity)" class="px-2 py-0.5 rounded text-xs w-12 text-center">
                {{ r.rarity_name }}
              </span>
              <div class="flex-1 h-3 bg-gray-900 rounded overflow-hidden">
                <div :class="rarityBgClass(r.rarity)" :style="`width: ${rarityPercent(r.count)}%`"></div>
              </div>
              <span class="text-white text-sm w-12 text-right">{{ r.count }}</span>
            </div>
          </div>
        </div>

        <!-- 元素分布 -->
        <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
          <h4 class="text-sm text-gray-400 mb-3">元素分布</h4>
          <div v-if="stats" class="space-y-2">
            <div v-for="e in stats.element_distribution" :key="e.element" class="flex items-center gap-2">
              <span :class="elementClass(e.element)" class="px-2 py-0.5 rounded text-xs w-12 text-center">
                {{ e.element_name }}
              </span>
              <div class="flex-1 h-3 bg-gray-900 rounded overflow-hidden">
                <div :class="elementBgClass(e.element)" :style="`width: ${elementPercent(e.count)}%`"></div>
              </div>
              <span class="text-white text-sm w-12 text-right">{{ e.count }}</span>
            </div>
          </div>
        </div>

        <!-- 种类分布 -->
        <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
          <h4 class="text-sm text-gray-400 mb-3">种类分布</h4>
          <div v-if="stats" class="space-y-2">
            <div v-for="b in stats.breed_distribution" :key="b.beast_key" class="flex items-center gap-2">
              <span class="text-xs text-white w-24">{{ beastKeyLabel(b.beast_key) }}</span>
              <div class="flex-1 h-3 bg-gray-900 rounded overflow-hidden">
                <div class="h-full bg-emerald-600" :style="`width: ${breedPercent(b.count)}%`"></div>
              </div>
              <span class="text-white text-sm w-12 text-right">{{ b.count }}</span>
            </div>
          </div>
        </div>

        <!-- Top 玩家 -->
        <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
          <h4 class="text-sm text-gray-400 mb-3">灵兽数量 Top10 玩家</h4>
          <div v-if="stats" class="space-y-1">
            <div v-for="(p, idx) in stats.top_players" :key="p.player_id" class="flex items-center gap-3 text-sm">
              <span class="text-yellow-400 w-6">{{ idx + 1 }}</span>
              <span class="text-white flex-1">{{ p.player_nickname }}</span>
              <span class="text-gray-400 text-xs">{{ p.player_realm }}</span>
              <span class="text-emerald-400">{{ p.beast_count }} 只</span>
            </div>
            <div v-if="stats.top_players.length === 0" class="text-center text-gray-500 text-sm py-4">暂无数据</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑灵兽弹窗 -->
    <Modal :isOpen="editModalShow" title="编辑灵兽属性" @close="editModalShow = false" width="600px">
      <div v-if="editingBeast" class="space-y-3">
        <div class="bg-gray-900 p-3 rounded text-xs text-gray-400">
          灵兽ID: {{ editingBeast.beast_id }} · 玩家: {{ editingBeast.player_nickname || '未知' }} ·
          种类: {{ beastKeyLabel(editingBeast.beast_key) }} · 元素: {{ elementLabel(editingBeast.element) }}
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">自定义昵称</label>
            <input v-model="editForm.beast_name" placeholder="留空使用默认名"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">星级 (1-10)</label>
            <input v-model.number="editForm.star_level" type="number" min="1" max="10"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">等级 (1-100)</label>
            <input v-model.number="editForm.level" type="number" min="1" max="100"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">忠诚度 (0-100)</label>
            <input v-model.number="editForm.loyalty" type="number" min="0" max="100"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">经验值</label>
            <input v-model="editForm.exp" type="text"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">气血上限</label>
            <input v-model="editForm.hp_max" type="text"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">攻击</label>
            <input v-model.number="editForm.atk" type="number" min="0"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">防御</label>
            <input v-model.number="editForm.def" type="number" min="0"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">速度</label>
            <input v-model.number="editForm.speed" type="number" min="0"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">出战状态</label>
            <select v-model="editForm.is_active"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option :value="false">未出战</option>
              <option :value="true">出战中</option>
            </select>
          </div>
        </div>

        <div class="flex items-center gap-2 bg-blue-900/30 border border-blue-700 p-2 rounded">
          <input type="checkbox" v-model="editForm.recalculate" id="recalculate-check" class="cursor-pointer">
          <label for="recalculate-check" class="text-xs text-blue-300 cursor-pointer">
            勾选后将按 base × (1 + (level-1)×0.1) × star_level 公式重算 HP/ATK/DEF/SPEED
            （会覆盖上方手填的属性值，但保留 level/star 修改）
          </label>
        </div>
      </div>
      <template #footer>
        <button @click="editModalShow = false" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="submitEdit" :disabled="operating"
          class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50">保存</button>
      </template>
    </Modal>

    <!-- GM 发放灵兽弹窗 -->
    <Modal :isOpen="giveModalShow" title="GM 发放灵兽" @close="giveModalShow = false" width="600px">
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">目标玩家ID *</label>
            <input v-model.number="giveForm.player_id" type="number" min="1" placeholder="必填"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">灵兽种类 *</label>
            <select v-model="giveForm.beast_key"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">请选择</option>
              <option v-for="b in BEAST_KEY_LIST" :key="b.value" :value="b.value">{{ b.label }}</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">星级 (1-10)</label>
            <input v-model.number="giveForm.star_level" type="number" min="1" max="10"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">等级 (1-100)</label>
            <input v-model.number="giveForm.level" type="number" min="1" max="100"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">忠诚度 (0-100)</label>
            <input v-model.number="giveForm.loyalty" type="number" min="0" max="100"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">立即出战</label>
            <select v-model="giveForm.is_active"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option :value="false">否</option>
              <option :value="true">是</option>
            </select>
          </div>
          <div class="col-span-2">
            <label class="block text-xs text-gray-400 mb-1">自定义昵称（可选）</label>
            <input v-model="giveForm.beast_name" placeholder="留空使用默认名"
              class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
          </div>
        </div>
        <div class="bg-yellow-900/30 border border-yellow-700 p-2 rounded text-xs text-yellow-300">
          说明：GM 发放绕过境界/灵力/捕获次数限制。属性将按公式 base × (1 + (level-1)×0.1) × star_level 自动计算。
        </div>
      </div>
      <template #footer>
        <button @click="giveModalShow = false" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="submitGive" :disabled="operating"
          class="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded disabled:opacity-50">确认发放</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * GM 灵兽系统管理面板
 *
 * 提供灵兽系统的 GM 管理界面（参考 server/routes/admin_spirit_beast.js）：
 *   1. 顶部统计指标卡片（总灵兽数/出战数/玩家数/今日新增）
 *   2. 子 Tab 切换：灵兽列表 / 分布统计（稀有度/元素/种类/Top10 玩家）
 *   3. 列表支持多条件过滤（玩家ID/种类/稀有度/元素/出战状态/昵称）
 *   4. 编辑灵兽属性（含 recalculate 选项按公式重算）
 *   5. GM 发放灵兽（绕过捕获限制）
 *   6. 强制出战/取消出战、重置冷却、删除灵兽
 *
 * 设计说明：
 *   - 所有弹窗使用项目通用 Modal 组件，禁用浏览器原生弹窗
 *   - 危险操作（删除）通过 emit('showConfirm') 委托父组件 AdminPanel 二次确认
 *   - 接口调用均带 loading 状态，错误信息通过 uiStore.showToast 反馈
 *   - 接口路径与后端 admin_spirit_beast.js 严格对应
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
import {
  getStats,
  getBeastList,
  giveBeast,
  updateBeast,
  deleteBeast,
  setBeastActive,
  resetBeastCooldowns
} from '../../../api/admin_spirit_beast'

const emit = defineEmits(['showConfirm'])
const uiStore = useUIStore()

// ====== 常量配置（与 spirit_beast_data.json 对应） ======

const BEAST_KEY_LIST = [
  { value: 'qingyun_wolf', label: '青云狼' },
  { value: 'huoyan_lion', label: '火焰狮' },
  { value: 'bingpo_fox', label: '冰魄狐' },
  { value: 'tenglong_snake', label: '腾蛇' }
]

const RARITY_OPTIONS = [
  { value: 'common', label: '凡品' },
  { value: 'rare', label: '灵品' },
  { value: 'epic', label: '宝品' },
  { value: 'legendary', label: '仙品' }
]

const ELEMENT_OPTIONS = [
  { value: 'metal', label: '金' },
  { value: 'wood', label: '木' },
  { value: 'water', label: '水' },
  { value: 'fire', label: '火' },
  { value: 'earth', label: '土' }
]

const DEFAULT_PAGE_SIZE = 10

// ====== 响应式状态 ======

const operating = ref(false)
const stats = ref(null)

const subTabs = [
  { id: 'beasts', name: '灵兽列表' },
  { id: 'distribution', name: '分布统计' }
]
const currentSubTab = ref('beasts')

// 列表相关
const beastLoading = ref(false)
const beastList = ref([])
const pagination = reactive({
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 1
})
const searchParams = reactive({
  player_id: '',
  beast_key: '',
  rarity: '',
  element: '',
  is_active: '',
  keyword: ''
})

// 编辑弹窗
const editModalShow = ref(false)
const editingBeast = ref(null)
const editForm = reactive({
  beast_name: '',
  star_level: 1,
  level: 1,
  exp: '0',
  loyalty: 50,
  atk: 0,
  def: 0,
  hp_max: '0',
  speed: 0,
  is_active: false,
  recalculate: false
})

// 发放弹窗
const giveModalShow = ref(false)
const giveForm = reactive({
  player_id: '',
  beast_key: '',
  star_level: 1,
  level: 1,
  loyalty: 50,
  is_active: false,
  beast_name: ''
})

// ====== 工具函数 ======

const beastKeyLabel = (key) => BEAST_KEY_LIST.find(b => b.value === key)?.label || key
const rarityLabel = (r) => RARITY_OPTIONS.find(x => x.value === r)?.label || r
const elementLabel = (e) => ELEMENT_OPTIONS.find(x => x.value === e)?.label || e

const rarityClass = (r) => {
  const map = {
    common: 'bg-gray-600 text-gray-200',
    rare: 'bg-blue-600 text-white',
    epic: 'bg-purple-600 text-white',
    legendary: 'bg-orange-600 text-white'
  }
  return map[r] || 'bg-gray-600 text-gray-200'
}

const rarityBgClass = (r) => {
  const map = {
    common: 'bg-gray-500',
    rare: 'bg-blue-500',
    epic: 'bg-purple-500',
    legendary: 'bg-orange-500'
  }
  return map[r] || 'bg-gray-500'
}

const elementClass = (e) => {
  const map = {
    metal: 'bg-yellow-700 text-yellow-100',
    wood: 'bg-green-700 text-green-100',
    water: 'bg-blue-700 text-blue-100',
    fire: 'bg-red-700 text-red-100',
    earth: 'bg-yellow-800 text-yellow-100'
  }
  return map[e] || 'bg-gray-600 text-gray-200'
}

const elementBgClass = (e) => {
  const map = {
    metal: 'bg-yellow-600',
    wood: 'bg-green-600',
    water: 'bg-blue-600',
    fire: 'bg-red-600',
    earth: 'bg-yellow-700'
  }
  return map[e] || 'bg-gray-500'
}

const rarityPercent = (count) => {
  if (!stats.value || stats.value.total_beasts === 0) return 0
  return (count / stats.value.total_beasts * 100).toFixed(1)
}

const elementPercent = (count) => rarityPercent(count)
const breedPercent = (count) => rarityPercent(count)

// ====== 接口调用 ======

/**
 * 拉取灵兽系统统计
 * GET /admin/spirit-beast/stats
 */
const fetchStats = async () => {
  try {
    const res = await getStats()
    stats.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取灵兽统计失败:', err)
    uiStore.showToast('获取统计失败', 'error')
  }
}

/**
 * 拉取灵兽列表
 * GET /admin/spirit-beast/beasts
 * @param {number} page 页码
 */
const fetchBeastList = async (page = 1) => {
  beastLoading.value = true
  try {
    const params = {
      page,
      limit: pagination.pageSize
    }
    if (searchParams.player_id) params.player_id = searchParams.player_id
    if (searchParams.beast_key) params.beast_key = searchParams.beast_key
    if (searchParams.rarity) params.rarity = searchParams.rarity
    if (searchParams.element) params.element = searchParams.element
    if (searchParams.is_active) params.is_active = searchParams.is_active
    if (searchParams.keyword) params.keyword = searchParams.keyword

    const res = await getBeastList(params)
    const data = res.data?.data || res.data
    beastList.value = data.beasts || []
    pagination.total = data.total || 0
    pagination.page = data.page || page
    pagination.totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize))
  } catch (err) {
    console.error('获取灵兽列表失败:', err)
    uiStore.showToast('获取灵兽列表失败', 'error')
  } finally {
    beastLoading.value = false
  }
}

const switchTab = (tabId) => {
  currentSubTab.value = tabId
  if (tabId === 'distribution' && !stats.value) {
    fetchStats()
  }
}

const handleSearch = () => fetchBeastList(1)

const resetSearch = () => {
  searchParams.player_id = ''
  searchParams.beast_key = ''
  searchParams.rarity = ''
  searchParams.element = ''
  searchParams.is_active = ''
  searchParams.keyword = ''
  fetchBeastList(1)
}

// ====== 编辑灵兽 ======

const openEditModal = (beast) => {
  editingBeast.value = beast
  editForm.beast_name = beast.beast_name || ''
  editForm.star_level = beast.star_level
  editForm.level = beast.level
  editForm.exp = beast.exp
  editForm.loyalty = beast.loyalty
  editForm.atk = beast.atk
  editForm.def = beast.def
  editForm.hp_max = beast.hp_max
  editForm.speed = beast.speed
  editForm.is_active = beast.is_active
  editForm.recalculate = false
  editModalShow.value = true
}

const submitEdit = async () => {
  if (!editingBeast.value) return
  operating.value = true
  try {
    // 构造更新参数：null 也允许（用于清空昵称）
    const payload = {
      beast_name: editForm.beast_name === '' ? null : editForm.beast_name,
      star_level: editForm.star_level,
      level: editForm.level,
      exp: String(editForm.exp),
      loyalty: editForm.loyalty,
      atk: editForm.atk,
      def: editForm.def,
      hp_max: String(editForm.hp_max),
      speed: editForm.speed,
      is_active: editForm.is_active,
      recalculate: editForm.recalculate
    }
    const res = await updateBeast(editingBeast.value.beast_id, payload)
    const data = res.data?.data || res.data
    uiStore.showToast(res.data?.message || '灵兽属性已更新', 'success')
    editModalShow.value = false
    fetchBeastList(pagination.page)
    fetchStats()
  } catch (err) {
    console.error('更新灵兽失败:', err)
    const msg = err.response?.data?.message || err.message || '更新失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== GM 发放灵兽 ======

const openGiveModal = () => {
  giveForm.player_id = ''
  giveForm.beast_key = ''
  giveForm.star_level = 1
  giveForm.level = 1
  giveForm.loyalty = 50
  giveForm.is_active = false
  giveForm.beast_name = ''
  giveModalShow.value = true
}

const submitGive = async () => {
  if (!giveForm.player_id || !giveForm.beast_key) {
    uiStore.showToast('玩家ID 和 灵兽种类 必填', 'warning')
    return
  }
  operating.value = true
  try {
    const payload = {
      player_id: Number(giveForm.player_id),
      beast_key: giveForm.beast_key,
      star_level: Number(giveForm.star_level) || 1,
      level: Number(giveForm.level) || 1,
      loyalty: Number(giveForm.loyalty) !== undefined ? Number(giveForm.loyalty) : 50,
      is_active: !!giveForm.is_active,
      beast_name: giveForm.beast_name || undefined
    }
    const res = await giveBeast(payload)
    uiStore.showToast(res.data?.message || '灵兽已发放', 'success')
    giveModalShow.value = false
    fetchBeastList(pagination.page)
    fetchStats()
  } catch (err) {
    console.error('发放灵兽失败:', err)
    const msg = err.response?.data?.message || err.message || '发放失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== 危险操作：删除/强制出战/重置冷却 ======

const handleDelete = (beast) => {
  emit('showConfirm', '删除灵兽', `确认删除灵兽 [${beastKeyLabel(beast.beast_key)}] (ID:${beast.beast_id})？\n玩家: ${beast.player_nickname || '未知'} (ID:${beast.player_id})\n此操作不可恢复，且不返还灵石！`, async () => {
    try {
      await deleteBeast(beast.beast_id, 'GM 后台手动删除')
      uiStore.showToast('灵兽已删除', 'success')
      fetchBeastList(pagination.page)
      fetchStats()
    } catch (err) {
      console.error('删除灵兽失败:', err)
      const msg = err.response?.data?.message || err.message || '删除失败'
      uiStore.showToast(msg, 'error')
    }
  })
}

const handleSetActive = (beast) => {
  const action = beast.is_active ? '取消出战' : '强制设为出战'
  emit('showConfirm', action, `确认对灵兽 [${beastKeyLabel(beast.beast_key)}] (ID:${beast.beast_id}) 执行「${action}」？`, async () => {
    try {
      const newActive = !beast.is_active
      await setBeastActive(beast.beast_id, newActive)
      uiStore.showToast(`${action}成功`, 'success')
      fetchBeastList(pagination.page)
    } catch (err) {
      console.error('设置出战状态失败:', err)
      const msg = err.response?.data?.message || err.message || '操作失败'
      uiStore.showToast(msg, 'error')
    }
  })
}

const handleResetCooldowns = async (beast) => {
  try {
    await resetBeastCooldowns(beast.beast_id, 'all')
    uiStore.showToast('冷却已重置', 'success')
  } catch (err) {
    console.error('重置冷却失败:', err)
    const msg = err.response?.data?.message || err.message || '重置失败'
    uiStore.showToast(msg, 'error')
  }
}

// ====== 初始化 ======

onMounted(() => {
  fetchStats()
  fetchBeastList(1)
})
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: #1f2937;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #4b5563;
  border-radius: 3px;
}
</style>
