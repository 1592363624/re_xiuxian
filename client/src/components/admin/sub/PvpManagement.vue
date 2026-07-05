<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white">PVP 斗法管理</h3>
      <div class="flex space-x-2">
        <button @click="fetchList(playerPagination.page)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新列表</button>
        <button @click="fetchMetrics" class="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white text-sm">更新指标</button>
      </div>
    </div>

    <!-- 统计指标卡片 -->
    <div v-if="metrics" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <!-- 当前进行中战斗数 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">在线战斗</div>
        <div class="text-2xl font-bold text-red-400">{{ metrics.ongoing_battles }}</div>
        <div class="text-[10px] text-gray-500 mt-1">进行中战斗数</div>
      </div>
      <!-- 今日战斗总数 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">今日战斗</div>
        <div class="text-2xl font-bold text-amber-400">{{ metrics.total_battles_today }}</div>
        <div class="text-[10px] text-gray-500 mt-1">本日累计场次</div>
      </div>
      <!-- PVP 玩家总数 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">参战玩家</div>
        <div class="text-2xl font-bold text-cyan-400">{{ metrics.total_players }}</div>
        <div class="text-[10px] text-gray-500 mt-1">参与过 PVP 的玩家数</div>
      </div>
      <!-- 段位分布柱状图（用 div 宽度模拟） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">段位分布</div>
        <div v-if="rankDistributionList.length === 0" class="text-xs text-gray-500">暂无数据</div>
        <div v-else class="space-y-1">
          <div v-for="item in rankDistributionList" :key="item.name" class="flex items-center gap-2 text-[10px]">
            <span class="w-10 text-gray-400 shrink-0">{{ item.name }}</span>
            <div class="flex-1 h-2 bg-gray-900 rounded overflow-hidden">
              <div class="h-full bg-gradient-to-r from-red-700 to-red-500 transition-all duration-300"
                :style="{ width: `${item.percent}%` }"></div>
            </div>
            <span class="w-6 text-right text-red-300">{{ item.count }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 切换：玩家段位列表 / 战斗记录 -->
    <div class="flex border-b border-gray-700 bg-gray-800/50">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        @click="switchTab(tab.id)"
        class="px-6 py-2 text-sm font-medium transition-colors relative whitespace-nowrap cursor-pointer"
        :class="currentSubTab === tab.id ? 'text-red-400' : 'text-gray-400 hover:text-white hover:bg-gray-700/50'"
      >
        {{ tab.name }}
        <div v-if="currentSubTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-red-500"></div>
      </button>
    </div>

    <!-- 子 Tab 1：玩家段位列表 -->
    <div v-if="currentSubTab === 'players'">
      <!-- 筛选与搜索 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">段位：</label>
            <select v-model="listSearchParams.rank_tier"
              class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">全部</option>
              <option v-for="name in rankNameList" :key="name" :value="name">{{ name }}</option>
            </select>
          </div>
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">关键字：</label>
            <input v-model="listSearchParams.keyword" placeholder="昵称搜索"
              class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
              @keyup.enter="handleListSearch">
          </div>
          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" v-model="listSearchParams.in_battle"
              class="rounded bg-gray-900 border-gray-600">
            仅战斗中
          </label>
          <button @click="handleListSearch" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">查询</button>
          <button @click="resetListSearch" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
        </div>
      </div>

      <!-- 玩家段位列表表格 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">玩家ID</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">昵称</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">境界</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">段位</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">积分</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">胜率</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">连胜</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">总场次</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="listLoading" class="text-center text-gray-500">
                <td colspan="9" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="playerList.length === 0" class="text-center text-gray-500">
                <td colspan="9" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="p in playerList" :key="p.id"
                class="border-t border-gray-700 hover:bg-gray-750">
                <td class="px-3 py-2 text-gray-400">{{ p.id }}</td>
                <td class="px-3 py-2 text-white">
                  {{ p.nickname }}
                  <span v-if="p.is_in_battle" class="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-red-900 text-red-300">战斗中</span>
                </td>
                <td class="px-3 py-2 text-gray-300 text-xs">{{ p.realm }}</td>
                <td class="px-3 py-2">
                  <span class="px-2 py-0.5 rounded text-xs bg-red-900/60 text-red-300">{{ p.rank_tier }}</span>
                </td>
                <td class="px-3 py-2 text-red-300 font-bold">{{ p.score }}</td>
                <td class="px-3 py-2 text-amber-300">{{ p.win_rate }}%</td>
                <td class="px-3 py-2 text-emerald-300">{{ p.win_streak }}</td>
                <td class="px-3 py-2 text-gray-300">{{ p.total_battles }}</td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <button @click="openDetailModal(p)" class="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-xs mr-1">详情</button>
                  <button @click="openScoreEditModal(p)" class="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded text-white text-xs mr-1">调整积分</button>
                  <button @click="openResetScoreModal(p)" class="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-xs">重置段位</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-gray-700 flex items-center justify-between text-sm">
          <div class="text-gray-400">共 {{ playerPagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button @click="fetchList(playerPagination.page - 1)"
              :disabled="playerPagination.page <= 1 || listLoading"
              class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
            <span class="text-gray-300">{{ playerPagination.page }} / {{ playerPagination.totalPages }}</span>
            <button @click="fetchList(playerPagination.page + 1)"
              :disabled="playerPagination.page >= playerPagination.totalPages || listLoading"
              class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 子 Tab 2：战斗记录 -->
    <div v-else-if="currentSubTab === 'battles'">
      <!-- 战斗记录筛选 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">状态：</label>
            <select v-model="battleSearchParams.status"
              class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">全部</option>
              <option value="ongoing">进行中</option>
              <option value="finished">已结束</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">类型：</label>
            <select v-model="battleSearchParams.battle_type"
              class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm">
              <option value="">全部</option>
              <option value="normal">普通</option>
              <option value="ranked">排位</option>
            </select>
          </div>
          <button @click="handleBattleSearch" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">查询</button>
          <button @click="resetBattleSearch" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
        </div>
      </div>

      <!-- 战斗记录表格 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
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
              <tr v-if="battleLoading" class="text-center text-gray-500">
                <td colspan="11" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="battleList.length === 0" class="text-center text-gray-500">
                <td colspan="11" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="b in battleList" :key="b.id"
                class="border-t border-gray-700 hover:bg-gray-750">
                <td class="px-3 py-2 text-gray-400">{{ b.id }}</td>
                <td class="px-3 py-2">
                  <span :class="b.battle_type === 'ranked' ? 'text-purple-300' : 'text-gray-300'"
                    class="text-xs">{{ battleTypeLabel(b.battle_type) }}</span>
                </td>
                <td class="px-3 py-2 text-cyan-300 text-xs">
                  {{ b.attacker_nickname || ('#' + b.attacker_id) }}
                </td>
                <td class="px-3 py-2 text-red-300 text-xs">
                  {{ b.defender_nickname || ('#' + b.defender_id) }}
                </td>
                <td class="px-3 py-2 text-xs">
                  <span v-if="b.winner_id === null" class="text-stone-400">平局</span>
                  <span v-else-if="b.winner_id === b.attacker_id" class="text-cyan-400">攻方</span>
                  <span v-else class="text-red-400">守方</span>
                </td>
                <td class="px-3 py-2 text-gray-300">{{ b.total_rounds }}</td>
                <td class="px-3 py-2 text-xs">
                  <span :class="b.attacker_score_change >= 0 ? 'text-emerald-400' : 'text-rose-400'">
                    {{ b.attacker_score_change >= 0 ? '+' : '' }}{{ b.attacker_score_change }}
                  </span>
                  <span class="text-gray-600 mx-1">/</span>
                  <span :class="b.defender_score_change >= 0 ? 'text-emerald-400' : 'text-rose-400'">
                    {{ b.defender_score_change >= 0 ? '+' : '' }}{{ b.defender_score_change }}
                  </span>
                </td>
                <td class="px-3 py-2 text-amber-300">{{ b.spirit_stone_reward }}</td>
                <td class="px-3 py-2">
                  <span :class="battleStatusClass(b.status)" class="px-2 py-0.5 rounded text-xs">{{ battleStatusLabel(b.status) }}</span>
                </td>
                <td class="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{{ formatDate(b.started_at) }}</td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <button v-if="b.status === 'ongoing'"
                    @click="openCancelBattleModal(b)"
                    class="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-xs">强制取消</button>
                  <span v-else class="text-gray-600 text-xs">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-gray-700 flex items-center justify-between text-sm">
          <div class="text-gray-400">共 {{ battlePagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button @click="fetchBattles(battlePagination.page - 1)"
              :disabled="battlePagination.page <= 1 || battleLoading"
              class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
            <span class="text-gray-300">{{ battlePagination.page }} / {{ battlePagination.totalPages }}</span>
            <button @click="fetchBattles(battlePagination.page + 1)"
              :disabled="battlePagination.page >= battlePagination.totalPages || battleLoading"
              class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 玩家详情弹窗 -->
    <Modal :isOpen="!!detailPlayer" title="玩家 PVP 详情" width="600px" @close="detailPlayer = null">
      <div v-if="detailPlayer" class="space-y-3 text-sm">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-gray-400 mb-1">玩家ID</label>
            <div class="text-white">{{ detailPlayer.id }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">昵称</label>
            <div class="text-white">{{ detailPlayer.nickname }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">境界</label>
            <div class="text-white">{{ detailPlayer.realm }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">段位</label>
            <div class="text-red-300 font-bold">{{ detailPlayer.rank_tier }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">积分</label>
            <div class="text-red-300 font-bold">{{ detailPlayer.score }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">战力</label>
            <div class="text-cyan-300">{{ detailPlayer.power }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">荣誉值</label>
            <div class="text-amber-300">{{ detailPlayer.honor }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">因果值</label>
            <div :class="detailPlayer.karma < 0 ? 'text-rose-400' : 'text-white'">{{ detailPlayer.karma }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">赛季战绩</label>
            <div class="text-white">
              胜 {{ detailPlayer.season_wins }} / 负 {{ detailPlayer.season_losses }}
              <span v-if="detailPlayer.season_draws !== undefined"> / 平 {{ detailPlayer.season_draws }}</span>
            </div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">当前连胜</label>
            <div class="text-emerald-300">{{ detailPlayer.win_streak }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">历史最高连胜</label>
            <div class="text-purple-300">{{ detailPlayer.max_win_streak || 0 }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">总场次</label>
            <div class="text-white">{{ detailPlayer.total_battles }}</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">虚弱状态</label>
            <div :class="detailPlayer.is_weak ? 'text-rose-400' : 'text-emerald-400'">
              {{ detailPlayer.is_weak ? `虚弱中（剩余 ${detailPlayer.weakness_remaining_seconds}s）` : '正常' }}
            </div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">战斗冷却</label>
            <div class="text-amber-300">{{ detailPlayer.cooldown_remaining_seconds }}s</div>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">上次战斗</label>
            <div class="text-white text-xs">{{ formatDate(detailPlayer.last_battle_time) || '-' }}</div>
          </div>
        </div>
      </div>
      <template #footer>
        <button @click="detailPlayer = null" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">关闭</button>
      </template>
    </Modal>

    <!-- 调整积分弹窗（含二次确认） -->
    <Modal :isOpen="!!scoreEditing" title="调整 PVP 积分" width="500px" @close="scoreEditing = null">
      <div v-if="scoreEditing" class="space-y-3 text-sm">
        <p class="text-gray-300">玩家：<span class="text-amber-400">{{ scoreEditing.nickname }} (ID: {{ scoreEditing.id }})</span></p>
        <p class="text-xs text-gray-500">当前积分：<span class="text-red-300 font-bold">{{ scoreEditing.score }}</span></p>
        <div>
          <label class="block text-gray-400 mb-1">新积分</label>
          <input v-model.number="scoreForm.score" type="number" min="0"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
        <div>
          <label class="block text-gray-400 mb-1">调整原因（必填）</label>
          <textarea v-model="scoreForm.reason" rows="3"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            placeholder="请输入调整原因，将记录到操作日志"></textarea>
        </div>
      </div>
      <template #footer>
        <button @click="scoreEditing = null" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="openScoreConfirm" :disabled="operating"
          class="px-4 py-2 bg-amber-700 hover:bg-amber-600 text-white rounded disabled:opacity-50">
          {{ operating ? '保存中...' : '下一步' }}
        </button>
      </template>
    </Modal>

    <!-- 调整积分二次确认弹窗 -->
    <Modal :isOpen="scoreConfirmShow" title="确认调整积分" width="420px" @close="scoreConfirmShow = false">
      <p class="text-gray-300 text-sm">请确认积分调整：</p>
      <div class="mt-2 text-sm">
        <div class="text-gray-400">玩家：<span class="text-white">{{ scoreEditing?.nickname }}</span></div>
        <div class="text-gray-400">原积分：<span class="text-red-300">{{ scoreEditing?.score }}</span></div>
        <div class="text-gray-400">新积分：<span class="text-emerald-300 font-bold">{{ scoreForm.score }}</span></div>
        <div class="text-gray-400 mt-1">原因：{{ scoreForm.reason }}</div>
      </div>
      <p class="text-amber-500 text-xs mt-3">⚠️ 调整将立即生效并记录到操作日志。</p>
      <template #footer>
        <button @click="scoreConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="submitScoreEdit" :disabled="operating"
          class="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded disabled:opacity-50">
          {{ operating ? '执行中...' : '确认调整' }}
        </button>
      </template>
    </Modal>

    <!-- 重置段位确认弹窗 -->
    <Modal :isOpen="resetConfirmShow" title="重置段位" width="420px" @close="resetConfirmShow = false">
      <p class="text-gray-300 text-sm">确定要重置玩家 <span class="text-amber-400">{{ resetTarget?.nickname }}</span> (ID: {{ resetTarget?.id }}) 的段位吗？</p>
      <p class="text-rose-400 text-xs mt-2">将清零积分、赛季战绩与连胜数，段位回落为「散修」。此操作不可撤销。</p>
      <template #footer>
        <button @click="resetConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="submitResetScore" :disabled="operating"
          class="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded disabled:opacity-50">
          {{ operating ? '执行中...' : '确认重置' }}
        </button>
      </template>
    </Modal>

    <!-- 强制取消战斗确认弹窗 -->
    <Modal :isOpen="cancelBattleConfirmShow" title="强制取消战斗" width="420px" @close="cancelBattleConfirmShow = false">
      <p class="text-gray-300 text-sm">确定要强制取消战斗 <span class="text-amber-400">#{{ cancelTarget?.id }}</span> 吗？</p>
      <p class="text-rose-400 text-xs mt-2">
        攻击方 {{ cancelTarget?.attacker_nickname || ('#' + cancelTarget?.attacker_id) }} vs 防守方 {{ cancelTarget?.defender_nickname || ('#' + cancelTarget?.defender_id) }}
      </p>
      <p class="text-amber-500 text-xs mt-2">⚠️ 战斗将被强制结束，双方均按未完成处理，不结算积分。</p>
      <template #footer>
        <button @click="cancelBattleConfirmShow = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="submitCancelBattle" :disabled="operating"
          class="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded disabled:opacity-50">
          {{ operating ? '执行中...' : '确认取消' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * PVP 斗法管理组件（GM 后台）
 *
 * 功能：
 *   1. 展示 PVP 系统统计指标（在线战斗、今日战斗、玩家数、段位分布柱状图）
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
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
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
const listSearchParams = reactive({
  rank_tier: '',
  keyword: '',
  in_battle: false
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
  battle_type: ''
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
 */
const rankDistributionList = computed(() => {
  const dist = metrics.value?.rank_distribution || {}
  const total = Object.values(dist).reduce((sum, n) => sum + (Number(n) || 0), 0)
  return Object.entries(dist).map(([name, count]) => ({
    name,
    count: Number(count) || 0,
    percent: total > 0 ? Math.round((Number(count) / total) * 100) : 0
  }))
})

/**
 * 段位名称列表（用于筛选下拉框）
 */
const rankNameList = computed(() => {
  return Object.keys(metrics.value?.rank_distribution || {})
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
    uiStore.showToast('获取指标失败', 'error')
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
    // 仅在勾选 in_battle 时传递该参数，避免传 false 被后端误判
    const params = {
      page,
      limit: playerPagination.pageSize
    }
    if (listSearchParams.rank_tier) params.rank_tier = listSearchParams.rank_tier
    if (listSearchParams.keyword) params.keyword = listSearchParams.keyword
    if (listSearchParams.in_battle) params.in_battle = true
    const res = await getList(params)
    const data = res.data?.data || res.data
    playerList.value = data.list || []
    playerPagination.total = data.total || 0
    playerPagination.page = data.page || page
    playerPagination.totalPages = Math.ceil(playerPagination.total / playerPagination.pageSize) || 1
  } catch (err) {
    console.error('获取列表失败:', err)
    uiStore.showToast('获取列表失败', 'error')
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
    const params = {
      page,
      limit: battlePagination.pageSize
    }
    if (battleSearchParams.status) params.status = battleSearchParams.status
    if (battleSearchParams.battle_type) params.battle_type = battleSearchParams.battle_type
    const res = await getBattles(params)
    const data = res.data?.data || res.data
    battleList.value = data.list || []
    battlePagination.total = data.total || 0
    battlePagination.page = data.page || page
    battlePagination.totalPages = Math.ceil(battlePagination.total / battlePagination.pageSize) || 1
  } catch (err) {
    console.error('获取战斗记录失败:', err)
    uiStore.showToast('获取战斗记录失败', 'error')
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
  listSearchParams.rank_tier = ''
  listSearchParams.keyword = ''
  listSearchParams.in_battle = false
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
  battleSearchParams.battle_type = ''
  fetchBattles(1)
}

/**
 * 打开玩家详情弹窗
 */
const openDetailModal = async (player) => {
  try {
    const res = await getPlayerDetail(player.id)
    detailPlayer.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取详情失败:', err)
    uiStore.showToast('获取详情失败', 'error')
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
    const res = await updateScore(scoreEditing.value.id, {
      score: scoreForm.score,
      reason: scoreForm.reason.trim()
    })
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '积分已调整', 'success')
    scoreConfirmShow.value = false
    scoreEditing.value = null
    await fetchList(playerPagination.page)
    await fetchMetrics()
  } catch (err) {
    const msg = err?.response?.data?.message || '调整失败'
    uiStore.showToast(msg, 'error')
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
    const res = await resetScore(resetTarget.value.id)
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '段位已重置', 'success')
    resetConfirmShow.value = false
    resetTarget.value = null
    await fetchList(playerPagination.page)
    await fetchMetrics()
  } catch (err) {
    const msg = err?.response?.data?.message || '重置失败'
    uiStore.showToast(msg, 'error')
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
    const res = await cancelBattle(cancelTarget.value.id)
    const data = res.data?.data || res.data
    uiStore.showToast(data?.message || '战斗已强制取消', 'success')
    cancelBattleConfirmShow.value = false
    cancelTarget.value = null
    await fetchBattles(battlePagination.page)
    await fetchMetrics()
  } catch (err) {
    const msg = err?.response?.data?.message || '取消失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

// ====== 工具函数 ======

/**
 * 战斗类型中文标签
 */
const battleTypeLabel = (type) => {
  const map = { normal: '普通', ranked: '排位' }
  return map[type] || type || '-'
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
    cancelled: 'bg-gray-700 text-gray-400'
  }
  return map[status] || 'bg-gray-700 text-gray-300'
}

/**
 * 格式化日期
 */
const formatDate = (dateStr) => {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('zh-CN', { hour12: false })
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
