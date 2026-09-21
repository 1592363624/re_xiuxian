<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-fg-primary">PVP 斗法管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchList(playerPagination.page)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-control text-fg-primary text-sm">刷新列表</button>
        <button @click="fetchMetrics" class="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded-control text-fg-primary text-sm">更新指标</button>
      </div>
    </div>

    <!-- 统计指标卡片 -->
    <div v-if="metrics" class="grid grid-cols-2 md:grid-cols-3 gap-3">
      <!-- 当前进行中战斗数 -->
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">在线战斗</div>
        <div class="text-2xl font-bold text-red-400 num">{{ metrics.ongoing_battles }}</div>
        <div class="text-[10px] text-fg-faint mt-1">进行中战斗数</div>
      </div>
      <!-- 今日战斗总数 -->
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">今日战斗</div>
        <div class="text-2xl font-bold text-amber-400 num">{{ metrics.today_battle_count }}</div>
        <div class="text-[10px] text-fg-faint mt-1">本日累计场次</div>
      </div>
      <!-- 段位分布柱状图（用 div 宽度模拟） -->
      <div class="bg-surface-raised rounded-lg border border-line p-3">
        <div class="text-xs text-fg-muted mb-1">段位分布</div>
        <div v-if="rankDistributionList.length === 0" class="text-xs text-fg-faint">暂无数据</div>
        <div v-else class="space-y-1">
          <div v-for="item in rankDistributionList" :key="item.name" class="flex items-center gap-2 text-[10px]">
            <span class="w-10 text-fg-muted shrink-0">{{ item.name }}</span>
            <div class="flex-1 h-2 bg-surface-sunken rounded overflow-hidden">
              <div class="h-full bg-gradient-to-r from-red-700 to-red-500 transition-all duration-300"
                :style="{ width: `${item.percent}%` }"></div>
            </div>
            <span class="w-6 text-right text-red-300 num">{{ item.count }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 切换：玩家段位列表 / 战斗记录 -->
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

    <!-- 子 Tab 1：玩家段位列表 -->
    <div v-if="currentSubTab === 'players'">
      <!-- 筛选与搜索 -->
      <div class="bg-surface-raised rounded-lg border border-line p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-fg-muted whitespace-nowrap">段位：</label>
            <!-- 后端 /admin/pvp/list 仅支持 filter=all/top/bottom（按积分区间归段） -->
            <select v-model="listSearchParams.filter"
              class="px-3 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
              <option value="all">全部</option>
              <option value="top">高分段（宗主/大能）</option>
              <option value="bottom">低分段（散修）</option>
            </select>
          </div>
          <div class="flex items-center gap-2">
            <label class="text-sm text-fg-muted whitespace-nowrap">排序：</label>
            <select v-model="listSearchParams.sort"
              class="px-3 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
              <option value="score_desc">积分降序</option>
              <option value="score_asc">积分升序</option>
              <option value="wins_desc">胜场降序</option>
            </select>
          </div>
          <button @click="handleListSearch" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-control text-fg-primary text-sm">查询</button>
          <AppButton variant="default" size="sm" @click="resetListSearch">重置</AppButton>
        </div>
      </div>

      <!-- 玩家段位列表表格 -->
      <div class="bg-surface-base rounded-lg border border-line overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-surface-raised text-fg-muted">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">玩家ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">昵称</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">境界</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">段位</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">积分</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">赛季胜率</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">连胜</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">总场次</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="listLoading" class="text-center text-fg-faint">
                <td colspan="9" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="playerList.length === 0" class="text-center text-fg-faint">
                <td colspan="9" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="p in playerList" :key="p.player_id"
                class="border-t border-line-subtle hover:bg-surface-hover">
                <td class="px-3 py-2 text-fg-muted num">{{ p.player_id }}</td>
                <td class="px-3 py-2 text-fg-primary">{{ p.nickname }}</td>
                <td class="px-3 py-2 text-fg-secondary text-xs">{{ p.realm }}</td>
                <td class="px-3 py-2">
                  <span class="px-2 py-0.5 rounded text-xs bg-red-900/60 text-red-300">{{ p.rank_tier }}</span>
                </td>
                <td class="px-3 py-2 text-red-300 font-bold num">{{ p.score }}</td>
                <td class="px-3 py-2 text-amber-300">
                  <span v-if="seasonWinRate(p) !== null">{{ seasonWinRate(p) }}%</span>
                  <span v-else class="text-fg-faint">未知</span>
                </td>
                <td class="px-3 py-2 text-emerald-300">{{ p.win_streak }}</td>
                <td class="px-3 py-2 text-fg-secondary">{{ p.total_battles }}</td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <button @click="openDetailModal(p)" class="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded-control text-fg-primary text-xs mr-1">详情</button>
                  <AppButton variant="primary" size="xs" @click="openScoreEditModal(p)" class="mr-1">调整积分</AppButton>
                  <AppButton variant="danger" size="xs" @click="openResetScoreModal(p)">重置段位</AppButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-line flex items-center justify-between text-sm">
          <div class="text-fg-muted num">共 {{ playerPagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <AppButton variant="default" size="sm" :disabled="playerPagination.page <= 1 || listLoading" @click="fetchList(playerPagination.page - 1)">
              上一页
            </AppButton>
            <span class="text-fg-secondary num">{{ playerPagination.page }} / {{ playerPagination.totalPages }}</span>
            <AppButton variant="default" size="sm" :disabled="playerPagination.page >= playerPagination.totalPages || listLoading" @click="fetchList(playerPagination.page + 1)">
              下一页
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 子 Tab 2：战斗记录 -->
    <div v-else-if="currentSubTab === 'battles'">
      <!-- 战斗记录筛选 -->
      <div class="bg-surface-raised rounded-lg border border-line p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-fg-muted whitespace-nowrap">状态：</label>
            <select v-model="battleSearchParams.status"
              class="px-3 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
              <option value="">全部</option>
              <option value="ongoing">进行中</option>
              <option value="finished">已结束</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>
          <div class="flex items-center gap-2">
            <label class="text-sm text-fg-muted whitespace-nowrap">玩家ID：</label>
            <!-- 后端 /admin/pvp/battles 支持 player_id（攻方或守方命中即可） -->
            <input v-model="battleSearchParams.player_id" type="number" min="1" placeholder="按玩家ID筛选"
              class="px-3 py-1 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600 w-32"
              @keyup.enter="handleBattleSearch">
          </div>
          <button @click="handleBattleSearch" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-control text-fg-primary text-sm">查询</button>
          <AppButton variant="default" size="sm" @click="resetBattleSearch">重置</AppButton>
        </div>
      </div>

      <!-- 战斗记录表格 -->
      <div class="bg-surface-base rounded-lg border border-line overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-surface-raised text-fg-muted">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">战斗ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">类型</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">攻击方</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">防守方</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">胜方</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">回合数</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">积分变化(攻/守)</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">灵石奖励</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">状态</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">时间</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="battleLoading" class="text-center text-fg-faint">
                <td colspan="11" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="battleList.length === 0" class="text-center text-fg-faint">
                <td colspan="11" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="b in battleList" :key="b.battle_id"
                class="border-t border-line-subtle hover:bg-surface-hover">
                <td class="px-3 py-2 text-fg-muted num">{{ b.battle_id }}</td>
                <td class="px-3 py-2">
                  <span :class="b.battle_type === 'bounty' ? 'text-purple-300' : 'text-fg-secondary'"
                    class="text-xs">{{ battleTypeLabel(b.battle_type) }}</span>
                </td>
                <td class="px-3 py-2 text-cyan-300 text-xs">
                  {{ b.attacker?.nickname || ('#' + b.attacker?.id) }}
                </td>
                <td class="px-3 py-2 text-red-300 text-xs">
                  {{ b.defender?.nickname || ('#' + b.defender?.id) }}
                </td>
                <td class="px-3 py-2 text-xs">
                  <span v-if="b.status !== 'finished'" class="text-fg-faint">-</span>
                  <span v-else-if="b.winner_id === null" class="text-fg-muted">平局</span>
                  <span v-else-if="b.winner_id === b.attacker?.id" class="text-cyan-400">攻方</span>
                  <span v-else class="text-red-400">守方</span>
                </td>
                <td class="px-3 py-2 text-fg-secondary">{{ b.total_rounds }}</td>
                <td class="px-3 py-2 text-xs">
                  <span :class="b.attacker_score_change >= 0 ? 'text-emerald-400' : 'text-rose-400'">
                    {{ b.attacker_score_change >= 0 ? '+' : '' }}{{ b.attacker_score_change }}
                  </span>
                  <span class="text-fg-faint mx-1">/</span>
                  <span :class="b.defender_score_change >= 0 ? 'text-emerald-400' : 'text-rose-400'">
                    {{ b.defender_score_change >= 0 ? '+' : '' }}{{ b.defender_score_change }}
                  </span>
                </td>
                <td class="px-3 py-2 text-amber-300">{{ b.spirit_stone_reward }}</td>
                <td class="px-3 py-2">
                  <span :class="battleStatusClass(b.status)" class="px-2 py-0.5 rounded text-xs">{{ battleStatusLabel(b.status) }}</span>
                </td>
                <td class="px-3 py-2 text-xs text-fg-muted whitespace-nowrap num">{{ formatDate(b.started_at) }}</td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <AppButton variant="danger" size="xs" v-if="b.status === 'ongoing'" @click="openCancelBattleModal(b)">
                    强制取消
                  </AppButton>
                  <span v-else class="text-fg-faint text-xs">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-line flex items-center justify-between text-sm">
          <div class="text-fg-muted num">共 {{ battlePagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <AppButton variant="default" size="sm" :disabled="battlePagination.page <= 1 || battleLoading" @click="fetchBattles(battlePagination.page - 1)">
              上一页
            </AppButton>
            <span class="text-fg-secondary num">{{ battlePagination.page }} / {{ battlePagination.totalPages }}</span>
            <AppButton variant="default" size="sm" :disabled="battlePagination.page >= battlePagination.totalPages || battleLoading" @click="fetchBattles(battlePagination.page + 1)">
              下一页
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 玩家详情弹窗 -->
    <Modal :isOpen="!!detailPlayer" title="玩家 PVP 详情" width="600px" @close="detailPlayer = null">
      <div v-if="detailPlayer" class="space-y-3 text-sm">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-fg-muted mb-1">玩家ID</label>
            <div class="text-fg-primary num">{{ detailPlayer.id }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">昵称</label>
            <div class="text-fg-primary">{{ detailPlayer.nickname }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">境界</label>
            <div class="text-fg-primary">{{ detailPlayer.realm }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">段位</label>
            <div class="text-red-300 font-bold">{{ detailPlayer.rank_tier }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">积分</label>
            <div class="text-red-300 font-bold num">{{ detailPlayer.score }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">荣誉值</label>
            <div class="text-amber-300">{{ detailPlayer.honor }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">因果值</label>
            <div :class="detailPlayer.karma < 0 ? 'text-rose-400' : 'text-fg-primary'">{{ detailPlayer.karma }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">赛季战绩</label>
            <div class="text-fg-primary">
              胜 {{ detailPlayer.season_wins }} / 负 {{ detailPlayer.season_losses }}
              <span v-if="detailPlayer.season_draws !== undefined"> / 平 {{ detailPlayer.season_draws }}</span>
            </div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">当前连胜</label>
            <div class="text-emerald-300">{{ detailPlayer.win_streak }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">历史最高连胜</label>
            <div class="text-purple-300">{{ detailPlayer.max_win_streak || 0 }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">总场次</label>
            <div class="text-fg-primary">{{ detailPlayer.total_battles }}</div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">虚弱截止时间</label>
            <div :class="detailPlayer.weakness_end_time ? 'text-rose-400' : 'text-emerald-400'" class="text-xs num">
              {{ formatDate(detailPlayer.weakness_end_time) || '无' }}
            </div>
          </div>
          <div>
            <label class="block text-fg-muted mb-1">上次战斗</label>
            <div class="text-fg-primary text-xs num">{{ formatDate(detailPlayer.last_battle_time) || '-' }}</div>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" @click="detailPlayer = null">关闭</AppButton>
      </template>
    </Modal>

    <!-- 调整积分弹窗（含二次确认） -->
    <Modal :isOpen="!!scoreEditing" title="调整 PVP 积分" width="500px" @close="scoreEditing = null">
      <div v-if="scoreEditing" class="space-y-3 text-sm">
        <p class="text-fg-secondary">玩家：<span class="text-amber-400">{{ scoreEditing.nickname }} (ID: {{ scoreEditing.player_id }})</span></p>
        <p class="text-xs text-fg-faint">当前积分：<span class="text-red-300 font-bold num">{{ scoreEditing.score }}</span></p>
        <div>
          <label class="block text-fg-muted mb-1">新积分</label>
          <input v-model.number="scoreForm.score" type="number" min="0"
            class="w-full px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
        </div>
        <div>
          <label class="block text-fg-muted mb-1">调整原因（必填）</label>
          <textarea v-model="scoreForm.reason" rows="3"
            class="w-full px-2 py-1 bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600"
            placeholder="请输入调整原因，将记录到操作日志"></textarea>
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="scoreEditing = null">取消</AppButton>
        <AppButton variant="primary" :disabled="operating" @click="openScoreConfirm">
          {{ operating ? '保存中...' : '下一步' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 调整积分二次确认弹窗 -->
    <Modal :isOpen="scoreConfirmShow" title="确认调整积分" width="420px" @close="scoreConfirmShow = false">
      <p class="text-fg-secondary text-sm">请确认积分调整：</p>
      <div class="mt-2 text-sm">
        <div class="text-fg-muted">玩家：<span class="text-fg-primary">{{ scoreEditing?.nickname }}</span></div>
        <div class="text-fg-muted">原积分：<span class="text-red-300 num">{{ scoreEditing?.score }}</span></div>
        <div class="text-fg-muted">新积分：<span class="text-emerald-300 font-bold num">{{ scoreForm.score }}</span></div>
        <div class="text-fg-muted mt-1">原因：{{ scoreForm.reason }}</div>
      </div>
      <p class="text-amber-500 text-xs mt-3">⚠️ 调整将立即生效并记录到操作日志。</p>
      <template #footer>
        <AppButton variant="default" @click="scoreConfirmShow = false">取消</AppButton>
        <AppButton variant="danger" :disabled="operating" @click="submitScoreEdit">
          {{ operating ? '执行中...' : '确认调整' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 重置段位确认弹窗 -->
    <Modal :isOpen="resetConfirmShow" title="重置段位" width="420px" @close="resetConfirmShow = false">
      <p class="text-fg-secondary text-sm">确定要重置玩家 <span class="text-amber-400">{{ resetTarget?.nickname }}</span> (ID: {{ resetTarget?.player_id }}) 的段位吗？</p>
      <p class="text-rose-400 text-xs mt-2">将清零积分与段位（回落为「散修」），并重置当前连胜与每日挑战次数；赛季战绩与荣誉值保留。此操作不可撤销。</p>
      <template #footer>
        <AppButton variant="default" @click="resetConfirmShow = false">取消</AppButton>
        <AppButton variant="danger" :disabled="operating" @click="submitResetScore">
          {{ operating ? '执行中...' : '确认重置' }}
        </AppButton>
      </template>
    </Modal>

    <!-- 强制取消战斗确认弹窗 -->
    <Modal :isOpen="cancelBattleConfirmShow" title="强制取消战斗" width="420px" @close="cancelBattleConfirmShow = false">
      <p class="text-fg-secondary text-sm">确定要强制取消战斗 <span class="text-amber-400">#{{ cancelTarget?.battle_id }}</span> 吗？</p>
      <p class="text-rose-400 text-xs mt-2">
        攻击方 {{ cancelTarget?.attacker?.nickname || ('#' + cancelTarget?.attacker?.id) }} vs 防守方 {{ cancelTarget?.defender?.nickname || ('#' + cancelTarget?.defender?.id) }}
      </p>
      <p class="text-amber-500 text-xs mt-2">⚠️ 战斗将被强制结束，双方均按未完成处理，不结算积分。</p>
      <template #footer>
        <AppButton variant="default" @click="cancelBattleConfirmShow = false">取消</AppButton>
        <AppButton variant="danger" :disabled="operating" @click="submitCancelBattle">
          {{ operating ? '执行中...' : '确认取消' }}
        </AppButton>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * PVP 斗法管理组件（GM 后台）
 *
 * 功能：
 *   1. 展示 PVP 系统统计指标（在线战斗、今日战斗、段位分布柱状图）
 *   2. 子 Tab 切换：玩家段位列表 / 战斗记录
 *   3. 玩家段位列表（分页）：详情/调整积分/重置段位
 *   4. 战斗记录列表（分页）：强制取消进行中战斗
 *   5. 调整积分弹窗（含二次确认）
 *   6. 重置段位确认弹窗
 *   7. 强制取消战斗确认弹窗
 *
 * 所有操作均通过 admin_pvp API 调用后端，前端只做展示与接口调用。
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { formatBeijing } from '../../../utils/time'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
import AppButton from '../../ui/AppButton.vue'
import {
  getMetrics,
  getList,
  getBattles,
  getPlayerDetail,
  updateScore,
  resetScore,
  cancelBattle
} from '../../../api/admin_pvp'

const uiStore = useUIStore()

// ====== 响应式状态 ======
const operating = ref(false)
const metrics = ref(null)

// 子 Tab 配置
const subTabs = [
  { id: 'players', name: '玩家段位列表' },
  { id: 'battles', name: '战斗记录' }
]
const currentSubTab = ref('players')

// 玩家段位列表
const listLoading = ref(false)
const playerList = ref([])
const playerPagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
})
// 后端 GET /admin/pvp/list 只支持 filter=all/top/bottom 与 sort=score_desc/score_asc/wins_desc
const listSearchParams = reactive({
  filter: 'all',
  sort: 'score_desc'
})

// 战斗记录列表
const battleLoading = ref(false)
const battleList = ref([])
const battlePagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
})
const battleSearchParams = reactive({
  status: '',
  player_id: ''
})

// 详情弹窗
const detailPlayer = ref(null)

// 调整积分弹窗
const scoreEditing = ref(null)
const scoreForm = reactive({
  score: 0,
  reason: ''
})
const scoreConfirmShow = ref(false)

// 重置段位确认弹窗
const resetConfirmShow = ref(false)
const resetTarget = ref(null)

// 强制取消战斗确认弹窗
const cancelBattleConfirmShow = ref(false)
const cancelTarget = ref(null)

// ====== 计算属性 ======

/**
 * 段位分布列表（转为数组并计算百分比，用于柱状图渲染）
 * 后端 rank_distribution 是按 rank_tier 分组的数组 [{rank_tier, count}]，count 可能为字符串
 */
const rankDistributionList = computed(() => {
  const dist = Array.isArray(metrics.value?.rank_distribution) ? metrics.value.rank_distribution : []
  const rows = dist.map(row => ({ name: row?.rank_tier || '未知', count: Number(row?.count) || 0 }))
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return rows.map(row => ({
    name: row.name,
    count: row.count,
    percent: total > 0 ? Math.round((row.count / total) * 100) : 0
  }))
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
    uiStore.showApiError(err, '获取指标失败')
  }
}

/**
 * 切换子 Tab
 */
const switchTab = (tabId) => {
  currentSubTab.value = tabId
  // 切换到战斗记录 Tab 时按需加载
  if (tabId === 'battles' && battleList.value.length === 0) {
    fetchBattles(1)
  }
}

/**
 * 拉取玩家段位列表
 */
const fetchList = async (page = 1) => {
  if (page < 1) page = 1
  listLoading.value = true
  try {
    // 后端只识别 page/limit/filter/sort
    const params = {
      page,
      limit: playerPagination.pageSize,
      filter: listSearchParams.filter || 'all',
      sort: listSearchParams.sort || 'score_desc'
    }
    const res = await getList(params)
    const data = res.data?.data || res.data
    playerList.value = data.list || []
    playerPagination.total = data.total || 0
    playerPagination.page = data.page || page
    playerPagination.totalPages = Math.ceil(playerPagination.total / playerPagination.pageSize) || 1
  } catch (err) {
    console.error('获取列表失败:', err)
    uiStore.showApiError(err, '获取列表失败')
  } finally {
    listLoading.value = false
  }
}

/**
 * 拉取战斗记录列表
 */
const fetchBattles = async (page = 1) => {
  if (page < 1) page = 1
  battleLoading.value = true
  try {
    // 后端只识别 page/limit/player_id/status
    const params = {
      page,
      limit: battlePagination.pageSize
    }
    if (battleSearchParams.status) params.status = battleSearchParams.status
    if (battleSearchParams.player_id) params.player_id = battleSearchParams.player_id
    const res = await getBattles(params)
    const data = res.data?.data || res.data
    battleList.value = data.list || []
    battlePagination.total = data.total || 0
    battlePagination.page = data.page || page
    battlePagination.totalPages = Math.ceil(battlePagination.total / battlePagination.pageSize) || 1
  } catch (err) {
    console.error('获取战斗记录失败:', err)
    uiStore.showApiError(err, '获取战斗记录失败')
  } finally {
    battleLoading.value = false
  }
}

/**
 * 玩家列表搜索
 */
const handleListSearch = () => {
  fetchList(1)
}

/**
 * 重置玩家列表搜索
 */
const resetListSearch = () => {
  listSearchParams.filter = 'all'
  listSearchParams.sort = 'score_desc'
  fetchList(1)
}

/**
 * 战斗记录搜索
 */
const handleBattleSearch = () => {
  fetchBattles(1)
}

/**
 * 重置战斗记录搜索
 */
const resetBattleSearch = () => {
  battleSearchParams.status = ''
  battleSearchParams.player_id = ''
  fetchBattles(1)
}

/**
 * 打开玩家详情弹窗
 * GET /admin/pvp/:playerId 返回 {player, ranking, recent_battles}，
 * 详情弹窗需要的是玩家信息 + 段位记录合并后的单层对象（无段位记录时回落到 players 表冗余字段）
 */
const openDetailModal = async (player) => {
  try {
    const res = await getPlayerDetail(player.player_id)
    const data = res.data?.data || res.data
    const info = data?.player || {}
    const ranking = data?.ranking || {}
    detailPlayer.value = {
      ...info,
      ...ranking,
      score: ranking.score ?? info.pvp_score ?? 0,
      rank_tier: ranking.rank_tier || info.pvp_rank || '未定段',
      season_wins: ranking.season_wins ?? 0,
      season_losses: ranking.season_losses ?? 0,
      win_streak: ranking.win_streak ?? 0,
      total_battles: ranking.total_battles ?? 0
    }
  } catch (err) {
    console.error('获取详情失败:', err)
    uiStore.showApiError(err, '获取详情失败')
  }
}

/**
 * 打开调整积分弹窗
 */
const openScoreEditModal = (player) => {
  scoreEditing.value = player
  scoreForm.score = player.score ?? 0
  scoreForm.reason = ''
}

/**
 * 打开调整积分的二次确认弹窗
 */
const openScoreConfirm = () => {
  if (!scoreEditing.value) return
  if (scoreForm.score === null || scoreForm.score === undefined || scoreForm.score < 0) {
    uiStore.showToast('请输入有效的新积分（>=0）', 'warning')
    return
  }
  if (!scoreForm.reason || !scoreForm.reason.trim()) {
    uiStore.showToast('请填写调整原因', 'warning')
    return
  }
  scoreConfirmShow.value = true
}

/**
 * 提交积分调整
 */
const submitScoreEdit = async () => {
  if (!scoreEditing.value) return
  operating.value = true
  try {
    const res = await updateScore(scoreEditing.value.player_id, {
      score: scoreForm.score,
      reason: scoreForm.reason.trim()
    })
    // 该接口的提示文案在响应顶层 message 字段（不在 data 内）
    const data = res.data?.data || res.data
    uiStore.showToast(res.data?.message || data?.message || '积分已调整', 'success')
    scoreConfirmShow.value = false
    scoreEditing.value = null
    await fetchList(playerPagination.page)
    await fetchMetrics()
  } catch (err) {
    uiStore.showApiError(err, '调整失败')
  } finally {
    operating.value = false
  }
}

/**
 * 打开重置段位确认弹窗
 */
const openResetScoreModal = (player) => {
  resetTarget.value = player
  resetConfirmShow.value = true
}

/**
 * 提交重置段位
 */
const submitResetScore = async () => {
  if (!resetTarget.value) return
  operating.value = true
  try {
    const res = await resetScore(resetTarget.value.player_id)
    // 该接口的提示文案在响应顶层 message 字段（不在 data 内）
    const data = res.data?.data || res.data
    uiStore.showToast(res.data?.message || data?.message || '段位已重置', 'success')
    resetConfirmShow.value = false
    resetTarget.value = null
    await fetchList(playerPagination.page)
    await fetchMetrics()
  } catch (err) {
    uiStore.showApiError(err, '重置失败')
  } finally {
    operating.value = false
  }
}

/**
 * 打开强制取消战斗确认弹窗
 */
const openCancelBattleModal = (battle) => {
  cancelTarget.value = battle
  cancelBattleConfirmShow.value = true
}

/**
 * 提交强制取消战斗
 */
const submitCancelBattle = async () => {
  if (!cancelTarget.value) return
  operating.value = true
  try {
    const res = await cancelBattle(cancelTarget.value.battle_id)
    // 该接口的提示文案在响应顶层 message 字段（不在 data 内）
    const data = res.data?.data || res.data
    uiStore.showToast(res.data?.message || data?.message || '战斗已强制取消', 'success')
    cancelBattleConfirmShow.value = false
    cancelTarget.value = null
    await fetchBattles(battlePagination.page)
    await fetchMetrics()
  } catch (err) {
    uiStore.showApiError(err, '取消失败')
  } finally {
    operating.value = false
  }
}

// ====== 工具函数 ======

/**
 * 战斗类型中文标签（后端 pvp_battle_records.battle_type 取值：normal/match/bounty）
 */
const battleTypeLabel = (type) => {
  const map = { normal: '普通', match: '匹配', bounty: '悬赏' }
  return map[type] || type || '-'
}

/**
 * 赛季胜率（后端 GET /admin/pvp/list 不返回 win_rate，按赛季胜/负/平现算）
 * @param {Object} p 玩家段位行数据
 * @returns {number|null} 0-100 的整数百分比；本赛季无对局时返回 null（模板显示"未知"）
 */
const seasonWinRate = (p) => {
  const wins = Number(p?.season_wins) || 0
  const games = wins + (Number(p?.season_losses) || 0) + (Number(p?.season_draws) || 0)
  return games > 0 ? Math.round((wins / games) * 100) : null
}

/**
 * 战斗状态中文标签
 */
const battleStatusLabel = (status) => {
  const map = { ongoing: '进行中', finished: '已结束', cancelled: '已取消' }
  return map[status] || status || '-'
}

/**
 * 战斗状态徽章样式
 */
const battleStatusClass = (status) => {
  const map = {
    ongoing: 'bg-red-900 text-red-300',
    finished: 'bg-emerald-900 text-emerald-300',
    cancelled: 'bg-surface-hover text-fg-muted'
  }
  return map[status] || 'bg-surface-hover text-fg-secondary'
}

/**
 * 格式化日期
 */
const formatDate = (dateStr) => {
  if (!dateStr) return ''
  try {
    // 统一按北京时间展示（固定 UTC+8）
    return formatBeijing(dateStr, { fallback: dateStr })
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
