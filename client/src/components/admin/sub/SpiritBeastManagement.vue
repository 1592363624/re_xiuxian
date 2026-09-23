<template>
  <div class="space-y-6">
    <!-- 顶部：标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-fg-primary">灵兽系统管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchBeastList()"
          class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-control text-fg-primary text-sm">刷新列表</button>
        <button @click="fetchStats"
          class="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded-control text-fg-primary text-sm">更新指标</button>
        <AppButton variant="primary" size="sm" @click="openGiveModal">
          GM 发放灵兽
        </AppButton>
      </div>
    </div>

    <!-- 统计指标卡片（4列网格） -->
    <div v-if="stats" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">总灵兽数</div>
        <div class="text-2xl font-bold text-emerald-400 num">{{ stats.total_beasts }}</div>
        <div class="text-[10px] text-fg-faint mt-1">全服灵兽实例总数</div>
      </div>
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">出战灵兽</div>
        <div class="text-2xl font-bold text-orange-400 num">{{ stats.active_beasts }}</div>
        <div class="text-[10px] text-fg-faint mt-1">玩家正在出战的灵兽数</div>
      </div>
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">拥有玩家数</div>
        <div class="text-2xl font-bold text-cyan-400 num">{{ stats.players_with_beasts }}</div>
        <div class="text-[10px] text-fg-faint mt-1">拥有灵兽的玩家数（去重）</div>
      </div>
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">今日新增</div>
        <div class="text-2xl font-bold text-pink-400 num">{{ stats.today_new_beasts }}</div>
        <div class="text-[10px] text-fg-faint mt-1">今日零点后新增捕获数</div>
      </div>
    </div>

    <!-- 子 Tab 切换：灵兽列表 / 分布统计 -->
    <div class="flex border-b border-line bg-surface-raised/50">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        @click="switchTab(tab.id)"
        class="px-6 py-2 text-sm font-medium transition-colors relative whitespace-nowrap cursor-pointer"
        :class="currentSubTab === tab.id ? 'text-emerald-400' : 'text-fg-muted hover:text-fg-primary hover:bg-surface-hover/50'"
      >
        {{ tab.name }}
        <div v-if="currentSubTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-emerald-500"></div>
      </button>
    </div>

    <!-- 子 Tab 1：灵兽列表 -->
    <div v-if="currentSubTab === 'beasts'">
      <!-- 筛选区 -->
      <div class="bg-surface-raised rounded-lg border border-line p-4">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label class="block text-xs text-fg-muted mb-1">玩家ID</label>
            <input v-model="searchParams.player_id" type="number" placeholder="精确匹配"
              class="w-full px-3 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">种类</label>
            <SearchableSelect
              v-model="searchParams.beast_key"
              :options="beastSelectOptions"
              placeholder="全部"
              search-placeholder="搜索灵兽种类…"
            />
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">稀有度</label>
            <SearchableSelect
              v-model="searchParams.rarity"
              :options="raritySelectOptions"
              placeholder="全部"
              search-placeholder="搜索稀有度…"
            />
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">元素</label>
            <SearchableSelect
              v-model="searchParams.element"
              :options="elementSelectOptions"
              placeholder="全部"
              search-placeholder="搜索元素…"
            />
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">出战状态</label>
            <select v-model="searchParams.is_active"
              class="w-full px-3 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
              <option value="">全部</option>
              <option value="true">出战中</option>
              <option value="false">未出战</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">昵称搜索</label>
            <input v-model="searchParams.keyword" placeholder="模糊匹配"
              class="w-full px-3 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div class="flex items-end gap-2 md:col-span-2">
            <button @click="handleSearch"
              class="px-4 py-1 bg-blue-600 hover:bg-blue-500 rounded-control text-fg-primary text-sm">查询</button>
            <AppButton variant="default" size="sm" @click="resetSearch">
              重置
            </AppButton>
          </div>
        </div>
      </div>

      <!-- 灵兽列表表格 -->
      <div class="bg-surface-base rounded-lg border border-line overflow-hidden mt-3">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-surface-raised text-fg-muted">
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
              <tr v-if="beastLoading" class="text-center text-fg-faint">
                <td colspan="11" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="beastList.length === 0" class="text-center text-fg-faint">
                <td colspan="11" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="b in beastList" :key="b.beast_id" class="border-t border-line-subtle hover:bg-surface-hover">
                <td class="px-3 py-2 text-fg-muted">{{ b.beast_id }}</td>
                <td class="px-3 py-2 text-fg-primary">
                  <div>{{ b.player_nickname || '未知' }}</div>
                  <div class="text-[10px] text-fg-faint">ID:{{ b.player_id }} · {{ b.player_realm || '未知' }}</div>
                </td>
                <td class="px-3 py-2 text-fg-primary">
                  <div>{{ beastKeyLabel(b.beast_key) }}</div>
                  <div class="text-[10px] text-fg-faint">{{ b.beast_name || '(默认名)' }}</div>
                </td>
                <td class="px-3 py-2">
                  <span :style="rarityStyle(b.rarity, b.rarity_color)" class="px-2 py-0.5 rounded text-xs">
                    {{ b.rarity_name || rarityLabel(b.rarity) }}
                  </span>
                </td>
                <td class="px-3 py-2">
                  <span :style="elementStyle(b.element)" class="px-2 py-0.5 rounded text-xs">
                    {{ b.element_name || elementLabel(b.element) }}
                  </span>
                </td>
                <td class="px-3 py-2 text-yellow-400">★{{ b.star_level }}</td>
                <td class="px-3 py-2 text-cyan-400">Lv.{{ b.level }}</td>
                <td class="px-3 py-2">
                  <span :class="b.loyalty < 30 ? 'text-red-400' : 'text-fg-secondary'">{{ b.loyalty }}</span>
                </td>
                <td class="px-3 py-2">
                  <span v-if="b.is_active" class="text-emerald-400">出战</span>
                  <span v-else class="text-fg-faint">—</span>
                </td>
                <td class="px-3 py-2 text-xs text-fg-secondary whitespace-nowrap num">
                  {{ b.hp_max }} / {{ b.atk }} / {{ b.def }} / {{ b.speed }}
                </td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <button @click="openEditModal(b)" class="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-fg-primary text-xs mr-1">编辑</button>
                  <AppButton variant="primary" size="xs" @click="handleSetActive(b)" class="mr-1">
                    {{ b.is_active ? '取消出战' : '强制出战' }}
                  </AppButton>
                  <button @click="handleResetCooldowns(b)" class="px-2 py-0.5 bg-purple-700 hover:bg-purple-600 rounded text-fg-primary text-xs mr-1">重置CD</button>
                  <AppButton variant="danger" size="xs" @click="handleDelete(b)">删除</AppButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 分页 -->
        <div class="flex items-center justify-between p-3 border-t border-line text-sm">
          <div class="text-fg-muted num">共 {{ pagination.total }} 条</div>
          <div class="flex items-center gap-2">
            <AppButton variant="default" size="xs" :disabled="pagination.page <= 1" @click="fetchBeastList(pagination.page - 1)">
              上一页
            </AppButton>
            <span class="text-fg-muted num">{{ pagination.page }} / {{ pagination.totalPages }}</span>
            <AppButton variant="default" size="xs" :disabled="pagination.page >= pagination.totalPages" @click="fetchBeastList(pagination.page + 1)">
              下一页
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 子 Tab 2：分布统计 -->
    <div v-if="currentSubTab === 'distribution'">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- 稀有度分布 -->
        <div class="bg-surface-raised rounded-lg border border-line p-4">
          <h4 class="text-sm text-fg-muted mb-3">稀有度分布</h4>
          <div v-if="stats" class="space-y-2">
            <div v-for="r in stats.rarity_distribution" :key="r.rarity" class="flex items-center gap-2">
              <span :style="rarityStyle(r.rarity, r.rarity_color)" class="px-2 py-0.5 rounded text-xs w-12 text-center">
                {{ r.rarity_name }}
              </span>
              <div class="flex-1 h-3 bg-surface-sunken rounded overflow-hidden">
                <div :style="barStyle(rarityColorOf(r.rarity, r.rarity_color), rarityPercent(r.count))"></div>
              </div>
              <span class="text-fg-primary text-sm w-12 text-right num">{{ r.count }}</span>
            </div>
          </div>
        </div>

        <!-- 元素分布 -->
        <div class="bg-surface-raised rounded-lg border border-line p-4">
          <h4 class="text-sm text-fg-muted mb-3">元素分布</h4>
          <div v-if="stats" class="space-y-2">
            <div v-for="e in stats.element_distribution" :key="e.element" class="flex items-center gap-2">
              <span :style="elementStyle(e.element, e.element_color)" class="px-2 py-0.5 rounded text-xs w-12 text-center">
                {{ e.element_name }}
              </span>
              <div class="flex-1 h-3 bg-surface-sunken rounded overflow-hidden">
                <div :style="barStyle(elementColorOf(e.element, e.element_color), elementPercent(e.count))"></div>
              </div>
              <span class="text-fg-primary text-sm w-12 text-right num">{{ e.count }}</span>
            </div>
          </div>
        </div>

        <!-- 种类分布 -->
        <div class="bg-surface-raised rounded-lg border border-line p-4">
          <h4 class="text-sm text-fg-muted mb-3">种类分布</h4>
          <div v-if="stats" class="space-y-2">
            <div v-for="b in stats.breed_distribution" :key="b.beast_key" class="flex items-center gap-2">
              <span class="text-xs text-fg-primary w-24">{{ beastKeyLabel(b.beast_key) }}</span>
              <div class="flex-1 h-3 bg-surface-sunken rounded overflow-hidden">
                <div class="h-full bg-emerald-600" :style="`width: ${breedPercent(b.count)}%`"></div>
              </div>
              <span class="text-fg-primary text-sm w-12 text-right num">{{ b.count }}</span>
            </div>
          </div>
        </div>

        <!-- Top 玩家 -->
        <div class="bg-surface-raised rounded-lg border border-line p-4">
          <h4 class="text-sm text-fg-muted mb-3">灵兽数量 Top10 玩家</h4>
          <div v-if="stats" class="space-y-1">
            <div v-for="(p, idx) in stats.top_players" :key="p.player_id" class="flex items-center gap-3 text-sm">
              <span class="text-yellow-400 w-6">{{ idx + 1 }}</span>
              <span class="text-fg-primary flex-1">{{ p.player_nickname }}</span>
              <span class="text-fg-muted text-xs">{{ p.player_realm }}</span>
              <span class="text-emerald-400">{{ p.beast_count }} 只</span>
            </div>
            <div v-if="stats.top_players.length === 0" class="text-center text-fg-faint text-sm py-4">暂无数据</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑灵兽弹窗 -->
    <Modal :isOpen="editModalShow" title="编辑灵兽属性" @close="editModalShow = false" width="600px">
      <div v-if="editingBeast" class="space-y-3">
        <div class="bg-surface-sunken p-3 rounded text-xs text-fg-muted">
          灵兽ID: {{ editingBeast.beast_id }} · 玩家: {{ editingBeast.player_nickname || '未知' }} ·
          种类: {{ beastKeyLabel(editingBeast.beast_key) }} · 元素: {{ elementLabel(editingBeast.element) }}
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs text-fg-muted mb-1">自定义昵称</label>
            <input v-model="editForm.beast_name" placeholder="留空使用默认名"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">星级 (1-10)</label>
            <input v-model.number="editForm.star_level" type="number" min="1" max="10"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">等级 (1-100)</label>
            <input v-model.number="editForm.level" type="number" min="1" max="100"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">忠诚度 (0-100)</label>
            <input v-model.number="editForm.loyalty" type="number" min="0" max="100"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">经验值</label>
            <input v-model="editForm.exp" type="text"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">气血上限</label>
            <input v-model="editForm.hp_max" type="text"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">攻击</label>
            <input v-model.number="editForm.atk" type="number" min="0"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">防御</label>
            <input v-model.number="editForm.def" type="number" min="0"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">速度</label>
            <input v-model.number="editForm.speed" type="number" min="0"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">出战状态</label>
            <select v-model="editForm.is_active"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
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
        <AppButton variant="ghost" @click="editModalShow = false">取消</AppButton>
        <button @click="submitEdit" :disabled="operating"
          class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-fg-primary rounded-control disabled:opacity-50">保存</button>
      </template>
    </Modal>

    <!-- GM 发放灵兽弹窗 -->
    <Modal :isOpen="giveModalShow" title="GM 发放灵兽" @close="giveModalShow = false" width="600px">
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs text-fg-muted mb-1">目标玩家ID *</label>
            <input v-model.number="giveForm.player_id" type="number" min="1" placeholder="必填"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">灵兽种类 *</label>
            <SearchableSelect
              v-model="giveForm.beast_key"
              :options="beastSelectOptions"
              title="选择灵兽种类"
              placeholder="选择灵兽种类"
              search-placeholder="搜索种类名 / key…"
              :allow-empty="false"
              :clearable="false"
            />
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">星级 (1-10)</label>
            <input v-model.number="giveForm.star_level" type="number" min="1" max="10"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">等级 (1-100)</label>
            <input v-model.number="giveForm.level" type="number" min="1" max="100"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">忠诚度 (0-100)</label>
            <input v-model.number="giveForm.loyalty" type="number" min="0" max="100"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-xs text-fg-muted mb-1">立即出战</label>
            <select v-model="giveForm.is_active"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
              <option :value="false">否</option>
              <option :value="true">是</option>
            </select>
          </div>
          <div class="col-span-2">
            <label class="block text-xs text-fg-muted mb-1">自定义昵称（可选）</label>
            <input v-model="giveForm.beast_name" placeholder="留空使用默认名"
              class="w-full px-2 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
          </div>
        </div>
        <div class="bg-yellow-900/30 border border-yellow-700 p-2 rounded text-xs text-yellow-300">
          说明：GM 发放绕过境界/灵力/捕获次数限制。属性将按公式 base × (1 + (level-1)×0.1) × star_level 自动计算。
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="giveModalShow = false">取消</AppButton>
        <AppButton variant="primary" :disabled="operating" @click="submitGive">
          确认发放
        </AppButton>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
import AppButton from '../../ui/AppButton.vue'
import SearchableSelect from '../../ui/SearchableSelect.vue'
import {
  getStats,
  getBeastList,
  giveBeast,
  updateBeast,
  deleteBeast,
  setBeastActive,
  resetBeastCooldowns
} from '../../../api/admin_spirit_beast'
import { getContentKeyOptions } from '../../../api/config'

const emit = defineEmits(['showConfirm'])
const uiStore = useUIStore()

// ====== 常量配置 ======

/**
 * 灵兽种类清单：取自内容（GET /config/content/keys/spirit_beast_data）。
 * 以前这里抄了一份 4 只的清单，资料片加一只灵兽，后台"发放/刷新"的下拉里就没有它。
 */
const BEAST_KEY_LIST = ref([])

async function loadBeastKeyList() {
  try {
    const res = await getContentKeyOptions('spirit_beast_data')
    BEAST_KEY_LIST.value = (res.data?.data?.entries || []).map(e => ({ value: e.key, label: e.name }))
  } catch (err) {
    uiStore.showToast(err?.message || '获取灵兽种类清单失败', 'error')
  }
}

/**
 * 灵兽属性清单：同样取自内容（GET /config/content/keys/spirit_beast_data?collection=elements）。
 * 以前这里抄了一份五行常量，而属性词表本轮才登记成资料片可扩的集合 ——
 * 资料片自带新一档灵兽属性（凡人遗宝就补了一档「雷」）时，这个下拉里就会少一种，GM 改不了也发不出。
 */
const ELEMENT_OPTIONS = ref([])

async function loadElementOptions() {
  try {
    const res = await getContentKeyOptions('spirit_beast_data', 'elements')
    ELEMENT_OPTIONS.value = (res.data?.data?.entries || []).map(e => ({ value: e.key, label: e.name, color: e.color }))
  } catch (err) {
    uiStore.showToast(err?.message || '获取灵兽属性清单失败', 'error')
  }
}

/**
 * 灵兽稀有度清单：取自内容（GET /config/content/keys/spirit_beast_data?collection=rarity_config）。
 * 以前这里手抄了四档名字 + 两份 tailwind 类映射（rarityClass / rarityBgClass），
 * 而词表 2026-09-22 才登记成资料片可扩的集合 —— 抄的那份不会跟着资料片长：
 * 资料片加一档「神话」，这个下拉里就没有它（GM 筛不出、也发不出），徽标退回灰色，
 * 玩家面板却照内容渲染得出颜色，两边看同一只灵兽不像同一只。
 */
const RARITY_OPTIONS = ref([])

// SearchableSelect 选项映射（value/label/meta）
const toSelectOpts = (list) => (list || []).map(o => ({
  value: o.value,
  label: o.label,
  meta: o.value,
  color: o.color || undefined,
}))
const beastSelectOptions = computed(() => toSelectOpts(BEAST_KEY_LIST.value))
const raritySelectOptions = computed(() => toSelectOpts(RARITY_OPTIONS.value))
const elementSelectOptions = computed(() => toSelectOpts(ELEMENT_OPTIONS.value))

async function loadRarityOptions() {
  try {
    const res = await getContentKeyOptions('spirit_beast_data', 'rarity_config')
    RARITY_OPTIONS.value = (res.data?.data?.entries || []).map(e => ({ value: e.key, label: e.name, color: e.color }))
  } catch (err) {
    uiStore.showToast(err?.message || '获取灵兽稀有度清单失败', 'error')
  }
}

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

const beastKeyLabel = (key) => BEAST_KEY_LIST.value.find(b => b.value === key)?.label || key
const rarityLabel = (r) => rarityOf(r)?.label || r
const elementOf = (e) => ELEMENT_OPTIONS.value.find(x => x.value === e) || null
const elementLabel = (e) => elementOf(e)?.label || e

const rarityOf = (r) => RARITY_OPTIONS.value.find(x => x.value === r) || null

/** 徽标/色条的颜色：优先用服务端随数据给的那份，其次查词表；两处都没有才退回中性底 */
const rarityColorOf = (r, given) => given || rarityOf(r)?.color || ''
const elementColorOf = (e, given) => given || elementOf(e)?.color || ''

function badgeStyle(color) {
  if (!color) return { background: 'rgba(128, 128, 128, 0.25)', color: 'inherit' }
  return { background: color + '40', color }
}

const rarityStyle = (r, given) => badgeStyle(rarityColorOf(r, given))
const elementStyle = (e, given) => badgeStyle(elementColorOf(e, given))

function barStyle(color, width) {
  return { width: `${width}%`, background: color || 'rgba(128, 128, 128, 0.4)' }
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
    uiStore.showApiError(err, '获取灵兽统计失败')
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
    uiStore.showApiError(err, '获取灵兽列表失败')
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
    uiStore.showApiError(err, '更新失败')
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
    uiStore.showApiError(err, '发放失败')
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
      uiStore.showApiError(err, '删除失败')
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
      uiStore.showApiError(err, '操作失败')
    }
  })
}

const handleResetCooldowns = async (beast) => {
  try {
    await resetBeastCooldowns(beast.beast_id, 'all')
    uiStore.showToast('冷却已重置', 'success')
  } catch (err) {
    console.error('重置冷却失败:', err)
    uiStore.showApiError(err, '重置失败')
  }
}

// ====== 初始化 ======

onMounted(() => {
  loadBeastKeyList()
  loadElementOptions()
  loadRarityOptions()
  fetchStats()
  fetchBeastList(1)
})
</script>
