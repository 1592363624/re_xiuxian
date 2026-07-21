/**
 * 灵兽探渊综合面板组件
 *
 * 灵兽探渊系统 - 异步多人 PVE+PVP 混合探索综合面板
 *
 * Tab 划分：
 *   1. 探渊状态：展示进行中探渊列表（灵兽名/层数/剩余时间/到期标识）+ 召回按钮 + 今日探渊次数
 *   2. 开始探渊：层数选择 + 灵兽输入 + 时长输入 + 体力消耗预览 + 开始按钮
 *   3. 排行榜：3 个子分类切换（最深层数/累计探渊次数/累计PVP胜利）
 *   4. 历史记录：分页展示探渊历史，点击单条记录查看遭遇详情
 *
 * 设计原则：
 *   - 所有状态从后端拉取，禁止硬编码业务数据
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格与 MultiDungeonPanel.vue 一致（修仙古风：#1c1917 / #292524 / amber-300）
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS
 *   - 到期探渊高亮显示（amber/emerald 边框）
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-amber-900/40 rounded-lg p-6 max-w-5xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-amber-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a4 4 0 0 0-4 4c0 1.6.8 3 2 4-2.2.5-4 2.5-4 5v3h12v-3c0-2.5-1.8-4.5-4-5 1.2-1 2-2.4 2-4a4 4 0 0 0-4-4z"/>
            <path d="M5 22h14"/><path d="M12 18v4"/>
          </svg>
          灵兽探渊 · 深渊秘境
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex border-b border-stone-700 mb-3 overflow-x-auto">
        <button v-for="tab in tabs" :key="tab.id"
          @click="switchTab(tab.id)"
          class="px-4 py-2 text-xs font-medium transition-colors whitespace-nowrap relative"
          :class="activeTab === tab.id ? 'text-amber-300' : 'text-stone-500 hover:text-stone-300'">
          {{ tab.name }}
          <div v-if="activeTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-400"></div>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto pr-1">

        <!-- ============ Tab 1: 探渊状态 ============ -->
        <div v-show="activeTab === 'status'" class="space-y-3">
          <div v-if="loading.status" class="text-center py-6 text-stone-500 text-sm">加载探渊状态中...</div>
          <template v-else-if="statusData">
            <!-- 今日探渊次数统计 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm font-bold text-amber-300">今日探渊</div>
                  <div class="text-[11px] text-stone-500">· 每日 0 点重置次数</div>
                </div>
                <div class="text-right">
                  <span class="text-2xl font-bold text-amber-300">{{ statusData.daily_explores_today }}</span>
                  <span class="text-stone-500 text-sm"> / {{ statusData.daily_limit }}</span>
                </div>
              </div>
            </section>

            <!-- 进行中探渊列表 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-3">进行中的探渊</div>
              <div v-if="statusData.active_explores.length === 0" class="text-center py-6 text-stone-500 text-xs">
                暂无进行中的探渊，前往「开始探渊」派出灵兽
              </div>
              <div v-else class="space-y-2">
                <div v-for="exp in statusData.active_explores" :key="exp.explore_id"
                  class="bg-stone-900/40 border rounded p-3"
                  :class="exp.is_expired ? 'border-emerald-700 shadow-lg shadow-emerald-900/20' : 'border-stone-800'">
                  <!-- 行 1：灵兽名 + 层数 -->
                  <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-bold text-amber-300">{{ exp.beast_name }}</span>
                      <span class="text-[10px] px-2 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800">
                        第 {{ exp.floor }} 层
                      </span>
                      <!-- 到期标识 -->
                      <span v-if="exp.is_expired" class="text-[10px] px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800 animate-pulse">
                        已到期·可召回
                      </span>
                    </div>
                    <span class="text-[10px] text-stone-500">ID: {{ exp.explore_id }}</span>
                  </div>
                  <!-- 行 2：起止时间 -->
                  <div class="grid grid-cols-2 gap-2 text-[11px] mb-2">
                    <div>
                      <span class="text-stone-500">开始：</span>
                      <span class="text-stone-300">{{ formatTimeString(exp.start_time) }}</span>
                    </div>
                    <div>
                      <span class="text-stone-500">结束：</span>
                      <span class="text-stone-300">{{ formatTimeString(exp.end_time) }}</span>
                    </div>
                  </div>
                  <!-- 行 3：剩余时间 + 召回按钮 -->
                  <div class="flex items-center justify-between">
                    <div class="text-[11px]">
                      <span class="text-stone-500">剩余：</span>
                      <span v-if="exp.remaining_seconds > 0" class="text-amber-300 font-bold">
                        {{ formatTime(exp.remaining_seconds) }}
                      </span>
                      <span v-else class="text-emerald-300 font-bold">已到期</span>
                    </div>
                    <button @click="handleRecall(exp.beast_id, exp.beast_name)"
                      :disabled="loading.action"
                      class="px-3 py-1 rounded text-[11px] font-bold bg-rose-950/40 border border-rose-800 text-rose-300 hover:bg-rose-900/40 disabled:opacity-50">
                      召回灵兽
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无探渊状态数据</div>
        </div>

        <!-- ============ Tab 2: 开始探渊 ============ -->
        <div v-show="activeTab === 'start'" class="space-y-3">
          <div v-if="loading.floors" class="text-center py-6 text-stone-500 text-sm">加载深渊层数中...</div>
          <template v-else-if="floorsData">
            <!-- 探渊参数概览 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-2">探渊参数</div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
                <div>
                  <div class="text-stone-500">同时派出上限</div>
                  <div class="text-amber-300 font-bold">{{ floorsData.max_concurrent_beasts }} 只</div>
                </div>
                <div>
                  <div class="text-stone-500">时长范围</div>
                  <div class="text-amber-300 font-bold">{{ floorsData.min_duration_hours }} - {{ floorsData.max_duration_hours }} 小时</div>
                </div>
                <div>
                  <div class="text-stone-500">每日次数</div>
                  <div class="text-amber-300 font-bold">
                    {{ floorsData.daily_explore_limit - floorsData.daily_remaining }} / {{ floorsData.daily_explore_limit }}
                  </div>
                </div>
                <div>
                  <div class="text-stone-500">今日剩余</div>
                  <div class="font-bold" :class="floorsData.daily_remaining > 0 ? 'text-emerald-300' : 'text-rose-400'">
                    {{ floorsData.daily_remaining }} 次
                  </div>
                </div>
              </div>
            </section>

            <!-- 层数选择 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-3">选择深渊层数</div>
              <div v-if="floorsData.floors.length === 0" class="text-center py-4 text-stone-500 text-xs">
                当前境界无可用层数
              </div>
              <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <button v-for="f in floorsData.floors" :key="f.floor"
                  @click="selectedFloor = f.floor"
                  :class="[
                    'text-left p-3 rounded border transition-all',
                    selectedFloor === f.floor
                      ? 'bg-amber-950/40 border-amber-600 shadow-lg shadow-amber-900/20'
                      : 'bg-stone-900/40 border-stone-800 hover:border-amber-700'
                  ]">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-bold text-amber-300">第 {{ f.floor }} 层 · {{ f.name }}</span>
                    <span v-if="selectedFloor === f.floor" class="text-[10px] text-amber-400">✓ 已选</span>
                  </div>
                  <div class="text-[10px] text-stone-400 mb-1">{{ f.description }}</div>
                  <div class="text-[10px] text-stone-500">· 入场境界：{{ f.min_realm_name }}</div>
                </button>
              </div>
            </section>

            <!-- 探渊配置输入 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-3">探渊配置</div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <!-- 灵兽 ID 输入 -->
                <div>
                  <label class="text-[11px] text-stone-500 mb-1 block">灵兽 ID</label>
                  <input v-model.number="startForm.beast_id" type="number" min="1" placeholder="请输入灵兽 ID"
                    class="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none" />
                  <div class="text-[10px] text-stone-500 mt-1">· 可在「灵兽面板」查看灵兽 ID</div>
                </div>
                <!-- 探渊时长输入 -->
                <div>
                  <label class="text-[11px] text-stone-500 mb-1 block">
                    探渊时长（{{ floorsData.min_duration_hours }} - {{ floorsData.max_duration_hours }} 小时）
                  </label>
                  <input v-model.number="startForm.duration_hours" type="number"
                    :min="floorsData.min_duration_hours" :max="floorsData.max_duration_hours" placeholder="时长"
                    class="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none" />
                  <div class="text-[10px] text-stone-500 mt-1">· 时长越长，奖励与风险越高</div>
                </div>
              </div>
              <!-- 体力消耗预览 -->
              <div class="mt-3 p-2 bg-stone-900/40 border border-stone-800 rounded text-[11px]">
                <span class="text-stone-500">体力消耗：</span>
                <span class="text-amber-300 font-bold">{{ staminaPerExplore }}</span>
                <span class="text-stone-500"> 点 / 每次探渊</span>
              </div>
              <!-- 开始按钮 -->
              <button @click="handleStart"
                :disabled="loading.action || !canStart"
                class="w-full mt-3 py-2 rounded text-xs font-bold bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed">
                {{ canStart ? '开始探渊' : '请填写完整配置' }}
              </button>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无层数数据</div>
        </div>

        <!-- ============ Tab 3: 排行榜 ============ -->
        <div v-show="activeTab === 'ranking'" class="space-y-3">
          <!-- 子分类切换 -->
          <div class="flex border-b border-stone-700 mb-2">
            <button v-for="sub in rankingSubTabs" :key="sub.key"
              @click="switchRankingSub(sub.key)"
              class="px-3 py-1.5 text-[11px] font-medium transition-colors relative"
              :class="rankingSubTab === sub.key ? 'text-amber-300' : 'text-stone-500 hover:text-stone-300'">
              {{ sub.name }}
              <div v-if="rankingSubTab === sub.key" class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-400"></div>
            </button>
          </div>

          <div v-if="loading.ranking" class="text-center py-6 text-stone-500 text-sm">加载排行榜中...</div>
          <template v-else-if="rankingData">
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="flex items-center justify-between mb-3">
                <div class="text-sm font-bold text-amber-300">{{ getRankingSubName(rankingSubTab) }}</div>
                <div class="flex items-center gap-2 text-xs">
                  <button @click="changeRankingPage(rankingData.page - 1)"
                    :disabled="loading.ranking || rankingData.page <= 1"
                    class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">上一页</button>
                  <span class="text-stone-400">{{ rankingData.page }} / {{ Math.max(1, Math.ceil((rankingData.total || rankingData.ranking.length) / rankingData.page_size)) }}</span>
                  <button @click="changeRankingPage(rankingData.page + 1)"
                    :disabled="loading.ranking || rankingData.ranking.length < rankingData.page_size"
                    class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">下一页</button>
                </div>
              </div>
              <div v-if="rankingData.ranking.length === 0" class="text-center py-6 text-stone-500 text-xs">暂无排行数据</div>
              <table v-else class="w-full text-[11px]">
                <thead>
                  <tr class="text-stone-500 border-b border-stone-700">
                    <th class="text-left py-1 w-12">名次</th>
                    <th class="text-left py-1">玩家</th>
                    <th class="text-left py-1">境界</th>
                    <th class="text-right py-1">{{ getRankingValueName(rankingSubTab) }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in rankingData.ranking" :key="r.player_id" class="border-b border-stone-800">
                    <td class="py-1.5">
                      <span :class="getRankBadgeClass(r.rank)">{{ r.rank }}</span>
                    </td>
                    <td class="py-1.5 text-amber-300">{{ r.nickname }}</td>
                    <td class="py-1.5 text-stone-300">{{ r.realm }}</td>
                    <td class="py-1.5 text-right text-emerald-300 font-bold">{{ r.value }}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无排行数据</div>
        </div>

        <!-- ============ Tab 4: 历史记录 ============ -->
        <div v-show="activeTab === 'history'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-amber-300">探渊历史</div>
              <div class="flex items-center gap-2 text-xs">
                <button @click="changeHistoryPage(historyData.page - 1)"
                  :disabled="loading.history || historyData.page <= 1"
                  class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">上一页</button>
                <span class="text-stone-400">{{ historyData.page }} / {{ historyData.total_pages || 1 }}</span>
                <button @click="changeHistoryPage(historyData.page + 1)"
                  :disabled="loading.history || historyData.page >= historyData.total_pages"
                  class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">下一页</button>
              </div>
            </div>
            <div v-if="loading.history" class="text-center py-3 text-stone-500 text-xs">加载历史记录中...</div>
            <div v-else-if="historyData.history.length === 0" class="text-center py-6 text-stone-500 text-xs">
              暂无历史记录
            </div>
            <div v-else class="space-y-1 max-h-96 overflow-y-auto">
              <button v-for="rec in historyData.history" :key="rec.explore_id"
                @click="handleViewEncounters(rec.explore_id, `灵兽#${rec.beast_id}`, rec.max_floor_reached)"
                class="w-full text-left bg-stone-900/40 border border-stone-800 rounded p-2 text-[11px] hover:border-amber-700 transition-colors">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-2">
                    <span class="text-amber-300 font-bold">灵兽 #{{ rec.beast_id }}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800">
                      最深 {{ rec.max_floor_reached }} 层
                    </span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded" :class="getOutcomeBadgeClass(rec.status)">
                      {{ getOutcomeName(rec.status) }}
                    </span>
                  </div>
                  <span class="text-stone-500">{{ formatTimeString(rec.end_time) }}</span>
                </div>
                <div class="text-stone-400">
                  · 时长：{{ rec.duration_hours }} 小时 · 击杀 {{ rec.monster_kills }} · PVP {{ rec.pvp_wins }}胜{{ rec.pvp_losses }}负
                </div>
                <div class="text-[10px] text-amber-500 mt-1">▸ 点击查看遭遇详情</div>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- 二次确认弹窗（通用） -->
    <Modal :isOpen="confirmModal.show" :title="confirmModal.title" @close="confirmModal.show = false" width="420px">
      <p class="text-stone-300 text-sm whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <button @click="confirmModal.show = false"
          class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">取消</button>
        <button @click="confirmModal.onConfirm(); confirmModal.show = false"
          :disabled="loading.action"
          class="px-4 py-2 text-xs rounded bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
          确认
        </button>
      </template>
    </Modal>

    <!-- 遭遇详情弹窗 -->
    <Modal :isOpen="encountersModal.show" :title="encountersModal.title" @close="encountersModal.show = false" width="640px">
      <div v-if="loading.encounters" class="text-center py-6 text-stone-500 text-sm">加载遭遇详情中...</div>
      <div v-else-if="encountersData && encountersData.encounters.length > 0" class="space-y-2 max-h-[60vh] overflow-y-auto">
        <div v-for="enc in encountersData.encounters" :key="enc.round"
          class="bg-stone-900/40 border rounded p-2"
          :class="getEncounterBorderClass(enc.encounter_type)">
          <!-- 回合头 -->
          <div class="flex items-center justify-between mb-1">
            <div class="flex items-center gap-2">
              <span class="text-[10px] px-1.5 py-0.5 rounded text-stone-200" :class="getEncounterBadgeClass(enc.encounter_type)">
                第 {{ enc.round }} 回合 · {{ getEncounterTypeName(enc.encounter_type) }}
              </span>
            </div>
            <!-- PVP 对手信息 -->
            <span v-if="enc.pvp_opponent" class="text-[10px] text-purple-300">
              对手：{{ enc.pvp_opponent.nickname }}（{{ enc.pvp_opponent.realm }}）
            </span>
          </div>
          <!-- 遭遇描述 -->
          <div class="text-[11px] text-stone-300 mb-1">{{ enc.description }}</div>
          <!-- 结果描述 -->
          <div class="text-[11px] text-amber-300 mb-1">· {{ enc.result }}</div>
          <!-- 数值变化 -->
          <div class="flex flex-wrap gap-2 text-[10px]">
            <span v-if="enc.hp_change !== 0" :class="enc.hp_change > 0 ? 'text-emerald-300' : 'text-rose-300'">
              HP {{ enc.hp_change > 0 ? '+' : '' }}{{ enc.hp_change }}
            </span>
            <span v-if="enc.exp_change !== 0" :class="enc.exp_change > 0 ? 'text-emerald-300' : 'text-rose-300'">
              经验 {{ enc.exp_change > 0 ? '+' : '' }}{{ enc.exp_change }}
            </span>
            <span v-if="enc.spirit_stones && enc.spirit_stones > 0" class="text-amber-300">
              灵石 +{{ enc.spirit_stones }}
            </span>
            <span v-for="(item, idx) in (enc.items || [])" :key="idx" class="text-purple-300">
              {{ item.name }} ×{{ item.amount }}
            </span>
          </div>
        </div>
      </div>
      <div v-else class="text-center py-6 text-stone-500 text-sm">暂无遭遇详情</div>
      <template #footer>
        <button @click="encountersModal.show = false"
          class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">关闭</button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
/**
 * 灵兽探渊综合面板脚本
 * 4 Tab 共享一个面板，按需懒加载对应子模块数据
 */
import { ref, reactive, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import { useUIStore } from '../../stores/ui';
import {
  beastAbyssGetFloors,
  beastAbyssStart,
  beastAbyssRecall,
  beastAbyssGetStatus,
  beastAbyssGetHistory,
  beastAbyssGetEncounters,
  beastAbyssGetRanking,
  beastAbyssGetConfig,
  type AbyssRankingCategory,
  type AbyssStatusData,
  type AbyssFloorsData,
  type AbyssHistoryData,
  type AbyssRankingData,
  type AbyssEncountersData,
  type AbyssConfigData
} from '../../api/beastAbyss';

const uiStore = useUIStore();

/** Tab 配置 */
const tabs = [
  { id: 'status', name: '探渊状态' },
  { id: 'start', name: '开始探渊' },
  { id: 'ranking', name: '排行榜' },
  { id: 'history', name: '历史记录' }
];
/** 当前激活 Tab */
const activeTab = ref('status');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/** 排行榜子分类配置 */
const rankingSubTabs: Array<{ key: AbyssRankingCategory; name: string }> = [
  { key: 'deepest_floor', name: '最深层数' },
  { key: 'total_explore_count', name: '累计探渊次数' },
  { key: 'total_pvp_wins', name: '累计PVP胜利' }
];
/** 排行榜当前子分类 */
const rankingSubTab = ref<AbyssRankingCategory>('deepest_floor');

/** 各模块加载状态 */
const loading = reactive({
  status: false,
  floors: false,
  ranking: false,
  history: false,
  encounters: false,
  action: false
});

/** 各模块数据 */
const statusData = ref<AbyssStatusData | null>(null);
const floorsData = ref<AbyssFloorsData | null>(null);
const rankingData = ref<AbyssRankingData | null>(null);
const encountersData = ref<AbyssEncountersData | null>(null);
const configData = ref<AbyssConfigData | null>(null);
const historyData = reactive<AbyssHistoryData>({
  list: [], total: 0, page: 1, page_size: 10, total_pages: 0
});

/** 开始探渊表单 */
const startForm = reactive({
  beast_id: null as number | null,
  duration_hours: null as number | null
});
/** 已选层数 */
const selectedFloor = ref<number | null>(null);

/** 通用二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '操作确认',
  message: '',
  onConfirm: () => {}
});

/** 遭遇详情弹窗 */
const encountersModal = reactive({
  show: false,
  title: '遭遇详情'
});

/**
 * 体力消耗（从配置或 floors 接口获取，避免硬编码）
 * 优先使用 /config 接口的 stamina_per_explore，其次回退到 floors 接口的隐式默认值
 */
const staminaPerExplore = computed(() => {
  if (configData.value?.abyss?.stamina_per_explore != null) {
    return configData.value.abyss.stamina_per_explore;
  }
  // 回退默认值（仅在 config 接口未加载时使用）
  return 0;
});

/**
 * 是否可以开始探渊
 * 灵兽ID + 时长 + 层数 均需填写
 */
const canStart = computed(() => {
  if (!floorsData.value) return false;
  if (!startForm.beast_id || startForm.beast_id <= 0) return false;
  if (!startForm.duration_hours) return false;
  if (startForm.duration_hours < floorsData.value.min_duration_hours ||
      startForm.duration_hours > floorsData.value.max_duration_hours) return false;
  if (!selectedFloor.value) return false;
  if (floorsData.value.daily_remaining <= 0) return false;
  return true;
});

/**
 * 组件挂载时加载首个 Tab 数据 + 配置（用于体力消耗等展示）
 */
onMounted(async () => {
  await Promise.all([loadStatus(), loadConfig()]);
  loadedTabs.add('status');
});

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (loadedTabs.has(tabId)) return;
  if (tabId === 'status') await loadStatus();
  else if (tabId === 'start') await loadFloors();
  else if (tabId === 'ranking') await loadRanking(rankingSubTab.value);
  else if (tabId === 'history') await loadHistory();
  loadedTabs.add(tabId);
}

/**
 * 排行榜子分类切换
 * @param subKey 子分类 key
 */
async function switchRankingSub(subKey: AbyssRankingCategory) {
  rankingSubTab.value = subKey;
  await loadRanking(subKey);
}

// ============ 数据加载函数 ============

/** 加载探渊状态（进行中列表 + 今日次数） */
async function loadStatus() {
  loading.status = true;
  try {
    const resp = await beastAbyssGetStatus();
    if (resp.data?.code === 200 && resp.data.data) {
      statusData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取探渊状态失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.status = false;
  }
}

/** 加载可用深渊层数（含探渊参数） */
async function loadFloors() {
  loading.floors = true;
  try {
    const resp = await beastAbyssGetFloors();
    if (resp.data?.code === 200 && resp.data.data) {
      floorsData.value = resp.data.data;
      // 默认选中第一个可用层数
      if (selectedFloor.value === null && resp.data.data.floors.length > 0) {
        selectedFloor.value = resp.data.data.floors[0].floor;
      }
    } else {
      uiStore.showToast(resp.data?.message || '获取层数列表失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.floors = false;
  }
}

/** 加载探渊配置（用于体力消耗等展示） */
async function loadConfig() {
  try {
    const resp = await beastAbyssGetConfig();
    if (resp.data?.code === 200 && resp.data.data) {
      configData.value = resp.data.data;
    }
    // 配置加载失败不弹 toast，避免刷屏
  } catch (e: any) {
    console.warn('加载探渊配置失败:', e);
  }
}

/**
 * 加载排行榜
 * @param category 分类
 */
async function loadRanking(category: AbyssRankingCategory) {
  loading.ranking = true;
  try {
    const resp = await beastAbyssGetRanking(category, 1, 20);
    if (resp.data?.code === 200 && resp.data.data) {
      rankingData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取排行榜失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.ranking = false;
  }
}

/**
 * 排行榜翻页
 * @param page 目标页码
 */
async function changeRankingPage(page: number) {
  if (!rankingData.value) return;
  // 后端在 total_explore_count / total_pvp_wins 类别下不返回 total 字段，使用 list 长度兜底
  const totalForCalc = rankingData.value.total ?? rankingData.value.ranking.length;
  const totalPages = Math.max(1, Math.ceil(totalForCalc / rankingData.value.page_size));
  // 当本页数据未满 page_size 时，说明已是最后一页
  if (page < 1 || (rankingData.value.ranking.length < rankingData.value.page_size && page > rankingData.value.page)) return;
  if (page > totalPages && rankingData.value.ranking.length < rankingData.value.page_size) return;
  loading.ranking = true;
  try {
    const resp = await beastAbyssGetRanking(rankingSubTab.value, page, 20);
    if (resp.data?.code === 200 && resp.data.data) {
      rankingData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '翻页失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.ranking = false;
  }
}

/** 加载历史记录 */
async function loadHistory() {
  loading.history = true;
  try {
    const resp = await beastAbyssGetHistory(historyData.page, historyData.page_size);
    if (resp.data?.code === 200 && resp.data.data) {
      Object.assign(historyData, resp.data.data);
    } else {
      uiStore.showToast(resp.data?.message || '获取历史记录失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.history = false;
  }
}

/**
 * 历史记录翻页
 * @param page 目标页码
 */
async function changeHistoryPage(page: number) {
  if (page < 1 || page > Math.ceil(historyData.total / historyData.page_size)) return;
  historyData.page = page;
  await loadHistory();
}

/**
 * 查看指定探渊的遭遇详情
 * @param exploreId 探渊记录 ID
 * @param beastName 灵兽名称（用于弹窗标题）
 * @param floor 层数（用于弹窗标题）
 */
async function handleViewEncounters(exploreId: number, beastName: string, floor: number) {
  encountersModal.title = `遭遇详情 · ${beastName} · 第 ${floor} 层`;
  encountersModal.show = true;
  encountersData.value = null;
  loading.encounters = true;
  try {
    const resp = await beastAbyssGetEncounters(exploreId);
    if (resp.data?.code === 200 && resp.data.data) {
      encountersData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取遭遇详情失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.encounters = false;
  }
}

// ============ 操作处理函数 ============

/**
 * 召回灵兽（二次确认）
 * @param beastId 灵兽 ID
 * @param beastName 灵兽名称
 */
function handleRecall(beastId: number, beastName: string) {
  showConfirm(
    '召回灵兽',
    `确认召回「${beastName}」？\n· 提前召回会按剩余时间折算奖励\n· 已到期召回将获得完整奖励`,
    async () => {
      loading.action = true;
      try {
        const resp = await beastAbyssRecall(beastId);
        if (resp.data?.code === 200 && resp.data.data) {
          const result = resp.data.data;
          // 拼接奖励摘要展示
          const rewards = result.rewards || {};
          const parts: string[] = [];
          if (rewards.spirit_stones) parts.push(`灵石 +${rewards.spirit_stones}`);
          if (rewards.exp) parts.push(`经验 +${rewards.exp}`);
          if (rewards.pvp_wins) parts.push(`PVP胜 +${rewards.pvp_wins}`);
          if (rewards.monster_kills) parts.push(`击杀 +${rewards.monster_kills}`);
          const rewardsText = parts.length > 0 ? `\n· 奖励：${parts.join(' / ')}` : '';
          uiStore.showToast(
            (result.message || '召回成功') + rewardsText,
            'success'
          );
          // 刷新探渊状态
          await loadStatus();
        } else {
          uiStore.showToast(resp.data?.message || '召回失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        loading.action = false;
      }
    }
  );
}

/**
 * 开始探渊（二次确认）
 */
function handleStart() {
  if (!canStart.value || !startForm.beast_id || !startForm.duration_hours || !selectedFloor.value) {
    uiStore.showToast('请填写完整配置', 'warning');
    return;
  }
  // 找到选中层数信息
  const floorInfo = floorsData.value?.floors.find(f => f.floor === selectedFloor.value);
  showConfirm(
    '开始探渊',
    `确认开始探渊？\n· 灵兽 ID：${startForm.beast_id}\n· 探渊层数：第 ${selectedFloor.value} 层 · ${floorInfo?.name || ''}\n· 探渊时长：${startForm.duration_hours} 小时\n· 体力消耗：${staminaPerExplore.value} 点\n· 操作不可撤销`,
    async () => {
      loading.action = true;
      try {
        const resp = await beastAbyssStart(startForm.beast_id!, startForm.duration_hours!);
        if (resp.data?.code === 200 && resp.data.data) {
          uiStore.showToast(resp.data.data.message || '探渊已开始', 'success');
          // 重置表单
          startForm.beast_id = null;
          startForm.duration_hours = null;
          // 切换到「探渊状态」Tab 查看进度
          await switchTab('status');
          await loadStatus();
        } else {
          uiStore.showToast(resp.data?.message || '开始失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        loading.action = false;
      }
    }
  );
}

// ============ 工具函数 ============

/**
 * 显示通用二次确认弹窗
 * @param title 标题
 * @param message 内容
 * @param onConfirm 确认回调
 */
function showConfirm(title: string, message: string, onConfirm: () => void) {
  confirmModal.title = title;
  confirmModal.message = message;
  confirmModal.onConfirm = onConfirm;
  confirmModal.show = true;
}

/**
 * 获取探渊结局中文名
 * @param outcome 结局值
 */
function getOutcomeName(status: string): string {
  // 后端 status 字段值：active=进行中 / settled=已结算 / recalled=已召回 / dead=陨落
  // 兼容旧 outcome 字段值：success=成功 / dead=陨落 / recalled=提前召回
  const map: Record<string, string> = {
    active: '探渊中',
    settled: '已结算',
    success: '成功归来',
    dead: '中途陨落',
    recalled: '提前召回'
  };
  return map[status] || status;
}

/**
 * 获取探渊结局徽章样式
 * @param outcome 结局值
 */
function getOutcomeBadgeClass(status: string): string {
  // 后端 status 字段值：active=进行中 / settled=已结算 / recalled=已召回 / dead=陨落
  // 兼容旧 outcome 字段值：success=成功 / dead=陨落 / recalled=提前召回
  const map: Record<string, string> = {
    active: 'bg-sky-950/60 text-sky-300 border border-sky-800',
    settled: 'bg-emerald-950/60 text-emerald-300 border border-emerald-800',
    success: 'bg-emerald-950/60 text-emerald-300 border border-emerald-800',
    dead: 'bg-rose-950/60 text-rose-300 border border-rose-800',
    recalled: 'bg-amber-950/60 text-amber-300 border border-amber-800'
  };
  return map[status] || 'bg-stone-800 text-stone-400 border border-stone-700';
}

/**
 * 获取排行榜子分类中文名
 * @param category 子分类
 */
function getRankingSubName(category: AbyssRankingCategory): string {
  const map: Record<AbyssRankingCategory, string> = {
    deepest_floor: '最深层数',
    total_explore_count: '累计探渊次数',
    total_pvp_wins: '累计PVP胜利'
  };
  return map[category] || category;
}

/**
 * 获取排行榜数值列名
 * @param category 子分类
 */
function getRankingValueName(category: AbyssRankingCategory): string {
  const map: Record<AbyssRankingCategory, string> = {
    deepest_floor: '层数',
    total_explore_count: '次数',
    total_pvp_wins: '胜场'
  };
  return map[category] || '数值';
}

/**
 * 获取名次徽章样式（前三名特殊样式）
 * @param rank 名次
 */
function getRankBadgeClass(rank: number): string {
  if (rank === 1) return 'inline-block px-2 py-0.5 rounded bg-amber-500 text-stone-900 font-bold';
  if (rank === 2) return 'inline-block px-2 py-0.5 rounded bg-stone-300 text-stone-900 font-bold';
  if (rank === 3) return 'inline-block px-2 py-0.5 rounded bg-orange-700 text-stone-100 font-bold';
  return 'inline-block px-2 py-0.5 rounded bg-stone-800 text-stone-300';
}

/**
 * 获取遭遇类型中文名
 * @param type 遭遇类型
 */
function getEncounterTypeName(type: string): string {
  const map: Record<string, string> = {
    monster: '怪物',
    pvp: 'PVP',
    event: '事件',
    treasure: '宝箱',
    trap: '陷阱'
  };
  return map[type] || type;
}

/**
 * 获取遭遇类型徽章样式
 * @param type 遭遇类型
 */
function getEncounterBadgeClass(type: string): string {
  const map: Record<string, string> = {
    monster: 'bg-rose-950/60 text-rose-300',
    pvp: 'bg-purple-950/60 text-purple-300',
    event: 'bg-amber-950/60 text-amber-300',
    treasure: 'bg-emerald-950/60 text-emerald-300',
    trap: 'bg-stone-800 text-stone-300'
  };
  return map[type] || 'bg-stone-800 text-stone-300';
}

/**
 * 获取遭遇类型边框样式
 * @param type 遭遇类型
 */
function getEncounterBorderClass(type: string): string {
  const map: Record<string, string> = {
    monster: 'border-rose-900/50',
    pvp: 'border-purple-900/50',
    event: 'border-amber-900/50',
    treasure: 'border-emerald-900/50',
    trap: 'border-stone-700'
  };
  return map[type] || 'border-stone-800';
}

/**
 * 格式化秒数为可读时长
 * @param seconds 秒数
 */
function formatTime(seconds: number): string {
  if (seconds <= 0) return '已到期';
  if (seconds < 60) return `${seconds} 秒`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours} 小时 ${remainMins} 分钟`;
}

/**
 * 格式化时间显示（M/D HH:MM）
 * @param time ISO 时间字符串
 */
function formatTimeString(time: string | null): string {
  if (!time) return '-';
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>

<style scoped>
/* 局部淡入动画，与 MultiDungeonPanel / AscensionPanel 保持一致 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}
</style>
