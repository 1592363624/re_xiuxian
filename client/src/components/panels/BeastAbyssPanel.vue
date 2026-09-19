<!--
 * 灵兽探渊综合面板组件
 *
 * 灵兽探渊系统 - 异步多人 PVE+PVP 混合探索综合面板
 *
 * Tab 划分（外壳 ui/PanelShell，导航 ui/Tabs）：
 *   1. 探渊状态：展示进行中探渊列表（灵兽名/层数/剩余时间/到期标识）+ 召回按钮 + 今日探渊次数
 *   2. 开始探渊：层数选择 + 灵兽输入 + 时长输入 + 体力消耗预览 + 开始按钮
 *   3. 排行榜：3 个子分类切换（最深层数/累计探渊次数/累计PVP胜利）
 *   4. 历史记录：分页展示探渊历史，点击单条记录查看遭遇详情
 *
 * 设计原则：
 *   - 所有状态从后端拉取，禁止硬编码业务数据
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 二次确认走 common/Modal，不弹浏览器原生 alert/confirm
 *   - 配色统一取设计令牌（surface-* / line / fg-* / gold-*）
 *   - 到期探渊高亮显示（gold / emerald 边框）
-->
<template>
  <PanelShell title="灵兽探渊" hint="深渊秘境 · 异步探索" size="2xl" @close="$emit('close')">
    <template #header-actions>
      <div class="hidden sm:flex items-center gap-2">
        <Badge v-if="statusData && dailyLimit !== null" tone="gold">今日探渊 <span class="num">{{ dailyToday }}</span> / <span class="num">{{ dailyLimit }}</span></Badge>
        <Badge v-if="statusData && statusData.active_explores.length" tone="success" dot>进行中 <span class="num">{{ statusData.active_explores.length }}</span></Badge>
      </div>
    </template>

    <!-- Tab 切换栏（切换时按需懒加载，保留 v-show 以免丢失各页输入状态） -->
    <Tabs
      :model-value="activeTab"
      :items="tabItems"
      class="mb-3"
      @update:model-value="switchTab"
    />

    <!-- ============ Tab 1: 探渊状态 ============ -->
    <div v-show="activeTab === 'status'" class="space-y-3">
      <LoadingBlock v-if="loading.status" text="加载探渊状态中…" />
      <template v-else-if="statusData">
        <!-- 今日探渊次数统计 -->
        <PanelCard v-if="dailyLimit !== null" title="今日探渊" hint="每日 0 点重置次数">
          <div class="flex items-center justify-between">
            <div class="text-[11px] text-fg-faint">派出灵兽即计入当日次数</div>
            <div class="text-right">
              <span class="text-2xl font-bold text-gold-300 num">{{ dailyToday }}</span>
              <span class="text-fg-faint text-sm num"> / {{ dailyLimit }}</span>
            </div>
          </div>
        </PanelCard>

        <!-- 进行中探渊列表 -->
        <PanelCard title="进行中的探渊">
          <div v-if="statusData.active_explores.length === 0" class="text-center py-6 text-fg-faint text-xs">
            暂无进行中的探渊，前往「开始探渊」派出灵兽
          </div>
          <div v-else class="space-y-2">
            <div v-for="exp in statusData.active_explores" :key="exp.explore_id"
              class="bg-surface-sunken border rounded-control p-3"
              :class="exp.is_expired ? 'border-emerald-700' : 'border-line-subtle'">
              <!-- 行 1：灵兽名 + 层数 -->
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-bold text-gold-300">{{ exp.beast_name }}</span>
                  <Badge tone="gold">第 <span class="num">{{ exp.start_floor }}</span> 层</Badge>
                  <!-- 到期标识 -->
                  <Badge v-if="exp.is_expired" tone="success" dot>已到期·可召回</Badge>
                </div>
                <span class="text-[10px] text-fg-faint num">ID: {{ exp.explore_id }}</span>
              </div>
              <!-- 行 2：起止时间 -->
              <div class="grid grid-cols-2 gap-2 text-[11px] mb-2">
                <div>
                  <span class="text-fg-faint">开始：</span>
                  <span class="text-fg-secondary num">{{ formatTimeString(exp.start_time) }}</span>
                </div>
                <div>
                  <span class="text-fg-faint">结束：</span>
                  <span class="text-fg-secondary num">{{ formatTimeString(exp.end_time) }}</span>
                </div>
              </div>
              <!-- 行 3：剩余时间 + 召回按钮 -->
              <div class="flex items-center justify-between">
                <div class="text-[11px]">
                  <span class="text-fg-faint">剩余：</span>
                  <span v-if="exp.remaining_seconds > 0" class="text-gold-300 font-bold num">
                    {{ formatTime(exp.remaining_seconds) }}
                  </span>
                  <span v-else class="text-emerald-300 font-bold">已到期</span>
                </div>
                <AppButton size="xs" variant="danger" :disabled="loading.action" @click="handleRecall(exp.beast_id, exp.beast_name)">
                  召回灵兽
                </AppButton>
              </div>
            </div>
          </div>
        </PanelCard>
      </template>
      <EmptyState v-else text="暂无探渊状态数据" hint="派出灵兽后再回来看进度" />
    </div>

    <!-- ============ Tab 2: 开始探渊 ============ -->
    <div v-show="activeTab === 'start'" class="space-y-3">
      <LoadingBlock v-if="loading.floors" text="加载深渊层数中…" />
      <template v-else-if="floorsData">
        <!-- 探渊参数概览 -->
        <PanelCard title="探渊参数">
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
            <div>
              <div class="text-fg-faint">同时派出上限</div>
              <div class="text-gold-300 font-bold num">{{ floorsData.max_concurrent_beasts }} 只</div>
            </div>
            <div>
              <div class="text-fg-faint">时长范围</div>
              <div class="text-gold-300 font-bold num">{{ floorsData.min_duration_hours }} - {{ floorsData.max_duration_hours }} 小时</div>
            </div>
            <div>
              <div class="text-fg-faint">每日次数</div>
              <div v-if="dailyLimit !== null" class="text-gold-300 font-bold num">{{ dailyToday }} / {{ dailyLimit }}</div>
              <div v-else class="text-fg-faint">未知</div>
            </div>
            <div>
              <div class="text-fg-faint">今日剩余</div>
              <div v-if="dailyRemaining !== null" class="font-bold num" :class="dailyRemaining > 0 ? 'text-emerald-300' : 'text-rose-400'">
                {{ dailyRemaining }} 次
              </div>
              <div v-else class="text-fg-faint">未知</div>
            </div>
          </div>
        </PanelCard>

        <!-- 层数选择 -->
        <PanelCard title="选择深渊层数">
          <div v-if="floorsData.floors.length === 0" class="text-center py-4 text-fg-faint text-xs">
            当前境界无可用层数
          </div>
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2">
            <button v-for="f in floorsData.floors" :key="f.floor"
              type="button"
              @click="selectedFloor = f.floor"
              :class="[
                'text-left p-3 rounded-control border transition-all',
                selectedFloor === f.floor
                  ? 'bg-surface-tint-gold-strong border-gold-600'
                  : 'bg-surface-sunken border-line-subtle hover:border-gold-700'
              ]">
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs font-bold text-gold-300">第 <span class="num">{{ f.floor }}</span> 层 · {{ f.name }}</span>
                <span v-if="selectedFloor === f.floor" class="text-[10px] text-gold-400">✓ 已选</span>
              </div>
              <div class="text-[10px] text-fg-muted mb-1">{{ f.description }}</div>
              <div class="text-[10px] text-fg-faint">· 入场境界：{{ f.min_realm_name }}</div>
            </button>
          </div>
        </PanelCard>

        <!-- 探渊配置输入 -->
        <PanelCard title="探渊配置">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <!-- 灵兽 ID 输入 -->
            <div>
              <label class="text-[11px] text-fg-faint mb-1 block">灵兽 ID</label>
              <input v-model.number="startForm.beast_id" type="number" min="1" placeholder="请输入灵兽 ID"
                class="num w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-gold-500 focus:outline-none" />
              <div class="text-[10px] text-fg-faint mt-1">· 可在「灵兽面板」查看灵兽 ID</div>
            </div>
            <!-- 探渊时长输入 -->
            <div>
              <label class="text-[11px] text-fg-faint mb-1 block">
                探渊时长（<span class="num">{{ floorsData.min_duration_hours }} - {{ floorsData.max_duration_hours }}</span> 小时）
              </label>
              <input v-model.number="startForm.duration_hours" type="number"
                :min="floorsData.min_duration_hours" :max="floorsData.max_duration_hours" placeholder="时长"
                class="num w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-gold-500 focus:outline-none" />
              <div class="text-[10px] text-fg-faint mt-1">· 时长越长，奖励与风险越高</div>
            </div>
          </div>
          <!-- 体力消耗预览 -->
          <div class="mt-3 p-2 bg-surface-sunken border border-line-subtle rounded-control text-[11px]">
            <span class="text-fg-faint">体力消耗：</span>
            <span class="text-gold-300 font-bold num">{{ staminaPerExplore }}</span>
            <span class="text-fg-faint"> 点 / 每次探渊</span>
          </div>
          <!-- 开始按钮 -->
          <AppButton
            variant="primary"
            block
            class="mt-3"
            :disabled="loading.action || !canStart"
            @click="handleStart"
          >
            {{ canStart ? '开始探渊' : '请填写完整配置' }}
          </AppButton>
        </PanelCard>
      </template>
      <EmptyState v-else text="暂无层数数据" />
    </div>

    <!-- ============ Tab 3: 排行榜 ============ -->
    <div v-show="activeTab === 'ranking'" class="space-y-3">
      <!-- 子分类切换 -->
      <Tabs
        :model-value="rankingSubTab"
        :items="rankingSubItems"
        class="mb-2"
        @update:model-value="switchRankingSub"
      />

      <LoadingBlock v-if="loading.ranking" text="加载排行榜中…" />
      <PanelCard v-else-if="rankingData" :title="getRankingSubName(rankingSubTab)">
        <template #action>
          <div class="flex items-center gap-2 text-xs">
            <AppButton
              size="xs"
              variant="default"
              :disabled="loading.ranking || rankingData.page <= 1"
              @click="changeRankingPage(rankingData.page - 1)"
            >上一页</AppButton>
            <span class="text-fg-muted num">{{ rankingData.page }} / {{ Math.max(1, Math.ceil((rankingData.total || rankingData.ranking.length) / rankingData.page_size)) }}</span>
            <AppButton
              size="xs"
              variant="default"
              :disabled="loading.ranking || rankingData.ranking.length < rankingData.page_size"
              @click="changeRankingPage(rankingData.page + 1)"
            >下一页</AppButton>
          </div>
        </template>
        <div v-if="rankingData.ranking.length === 0" class="text-center py-6 text-fg-faint text-xs">暂无排行数据</div>
        <table v-else class="w-full text-[11px]">
          <thead>
            <tr class="text-fg-faint border-b border-line">
              <th class="text-left py-1 w-12">名次</th>
              <th class="text-left py-1">玩家</th>
              <th class="text-left py-1">境界</th>
              <th class="text-right py-1">{{ getRankingValueName(rankingSubTab) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rankingData.ranking" :key="r.player_id" class="border-b border-line-subtle">
              <td class="py-1.5">
                <span class="num" :class="getRankBadgeClass(r.rank)">{{ r.rank }}</span>
              </td>
              <td class="py-1.5 text-gold-300">{{ r.nickname }}</td>
              <td class="py-1.5 text-fg-secondary">{{ r.realm }}</td>
              <td class="py-1.5 text-right text-emerald-300 font-bold num">{{ r.value }}</td>
            </tr>
          </tbody>
        </table>
      </PanelCard>
      <EmptyState v-else text="暂无排行数据" />
    </div>

    <!-- ============ Tab 4: 历史记录 ============ -->
    <div v-show="activeTab === 'history'" class="space-y-3">
      <PanelCard title="探渊历史">
        <template #action>
          <div class="flex items-center gap-2 text-xs">
            <AppButton
              size="xs"
              variant="default"
              :disabled="loading.history || historyData.page <= 1"
              @click="changeHistoryPage(historyData.page - 1)"
            >上一页</AppButton>
            <span class="text-fg-muted num">{{ historyData.page }} / {{ historyTotalPages }}</span>
            <AppButton
              size="xs"
              variant="default"
              :disabled="loading.history || historyData.page >= historyTotalPages"
              @click="changeHistoryPage(historyData.page + 1)"
            >下一页</AppButton>
          </div>
        </template>
        <LoadingBlock v-if="loading.history" text="加载历史记录中…" />
        <div v-else-if="historyData.history.length === 0" class="text-center py-6 text-fg-faint text-xs">
          暂无历史记录
        </div>
        <div v-else class="space-y-1 max-h-96 overflow-y-auto scroll-thin">
          <button v-for="rec in historyData.history" :key="rec.explore_id"
            type="button"
            @click="handleViewEncounters(rec.explore_id, `灵兽#${rec.beast_id}`, rec.max_floor_reached)"
            class="w-full text-left bg-surface-sunken border border-line-subtle rounded-control p-2 text-[11px] hover:border-gold-700 transition-colors">
            <div class="flex items-center justify-between mb-1">
              <div class="flex items-center gap-2">
                <span class="text-gold-300 font-bold">灵兽 <span class="num">#{{ rec.beast_id }}</span></span>
                <Badge tone="gold">最深 <span class="num">{{ rec.max_floor_reached }}</span> 层</Badge>
                <Badge :tone="getOutcomeTone(rec.status)">{{ getOutcomeName(rec.status) }}</Badge>
              </div>
              <span class="text-fg-faint num">{{ formatTimeString(rec.end_time) }}</span>
            </div>
            <div class="text-fg-muted num">
              · 时长：{{ rec.duration_hours }} 小时 · 击杀 {{ rec.monster_kills }} · PVP {{ rec.pvp_wins }}胜{{ rec.pvp_losses }}负
            </div>
            <div class="text-[10px] text-gold-500 mt-1">▸ 点击查看遭遇详情</div>
          </button>
        </div>
      </PanelCard>
    </div>

    <!-- 二次确认弹窗（通用） -->
    <Modal :isOpen="confirmModal.show" :title="confirmModal.title" @close="confirmModal.show = false" width="420px">
      <p class="text-fg-secondary text-sm whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <AppButton size="sm" variant="outline" @click="confirmModal.show = false">取消</AppButton>
        <AppButton size="sm" variant="primary" :disabled="loading.action" @click="confirmModal.onConfirm(); confirmModal.show = false">
          确认
        </AppButton>
      </template>
    </Modal>

    <!-- 遭遇详情弹窗（字段契约见 api/beastAbyss.ts AbyssEncounter，来自服务端 getEncounterHistory） -->
    <Modal :isOpen="encountersModal.show" :title="encountersModal.title" @close="encountersModal.show = false" width="640px">
      <LoadingBlock v-if="loading.encounters" text="加载遭遇详情中…" />
      <div v-else-if="encountersData && encountersData.encounters.length > 0" class="space-y-2 max-h-[60vh] overflow-y-auto scroll-thin">
        <div v-for="(enc, idx) in encountersData.encounters" :key="enc.log_id"
          class="bg-surface-sunken border rounded-control p-2"
          :class="getEncounterBorderClass(enc.encounter_type)">
          <!-- 行 1：层数 + 遭遇类型 + 结果。后端无回合号，idx+1 只是本列表的展示序号 -->
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-[10px] px-1.5 py-0.5 rounded-control text-fg-primary shrink-0" :class="getEncounterBadgeClass(enc.encounter_type)">
              <span class="num">#{{ idx + 1 }}</span> · 第 <span class="num">{{ enc.floor }}</span> 层 · {{ getEncounterTypeName(enc.encounter_type) }}
            </span>
            <div class="flex items-center gap-2 min-w-0">
              <!-- PVP 对手：后端只有对手灵兽名与玩家 ID，没有昵称/境界 -->
              <span v-if="enc.opponent_beast_name || enc.opponent_player_id !== null" class="text-[10px] text-purple-300 truncate">
                对手：{{ enc.opponent_beast_name || '未知灵兽' }}<span v-if="enc.opponent_player_id !== null" class="num">（玩家 #{{ enc.opponent_player_id }}）</span>
              </span>
              <span class="text-[10px] font-bold shrink-0" :class="getResultClass(enc.result)">{{ getResultName(enc.result) }}</span>
            </div>
          </div>
          <!-- 行 2：遭遇详情 encounter_detail（JSON 对象，非字符串）。
               服务端目前只在怪物战斗分支构造、且写日志时漏传该字段，缺失时整块不显示 -->
          <div v-if="enc.encounter_detail" class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-secondary mb-1">
            <span v-if="enc.encounter_detail.monster_name">遭遇「{{ enc.encounter_detail.monster_name }}」</span>
            <span v-if="getElementName(enc.encounter_detail.monster_element)">
              <span class="text-fg-faint">属性</span> {{ getElementName(enc.encounter_detail.monster_element) }}
            </span>
            <span v-if="enc.encounter_detail.monster_hp">
              <span class="text-fg-faint">敌方气血</span>
              <span class="num" :title="formatNumber(enc.encounter_detail.monster_hp)">{{ formatCompact(enc.encounter_detail.monster_hp) }}</span>
            </span>
            <span v-if="enc.encounter_detail.rounds">
              <span class="text-fg-faint">战斗</span> <span class="num">{{ enc.encounter_detail.rounds }}</span> 回合
            </span>
          </div>
          <!-- 行 3：数值。气血/体力是遭遇后的绝对值（后端不提供变化量），仅经验/灵石/兽魂/物品为增益 -->
          <div class="flex flex-wrap gap-2 text-[10px] num">
            <span v-if="hasNumber(enc.hp_after)">
              <span class="text-fg-faint">气血</span>
              <span :title="formatNumber(enc.hp_after)">{{ formatCompact(enc.hp_after) }}</span>
            </span>
            <span v-if="hasNumber(enc.stamina_after)">
              <span class="text-fg-faint">体力</span>
              <span :title="formatNumber(enc.stamina_after)">{{ formatCompact(enc.stamina_after) }}</span>
            </span>
            <span v-if="enc.exp_gained > 0" class="text-emerald-300">
              经验 +<span :title="formatNumber(enc.exp_gained)">{{ formatCompact(enc.exp_gained) }}</span>
            </span>
            <span v-if="enc.spirit_stones_gained > 0" class="text-gold-300">
              灵石 +<span :title="formatNumber(enc.spirit_stones_gained)">{{ formatCompact(enc.spirit_stones_gained) }}</span>
            </span>
            <span v-if="enc.beast_soul_gained > 0" class="text-purple-300">
              兽魂 +<span :title="formatNumber(enc.beast_soul_gained)">{{ formatCompact(enc.beast_soul_gained) }}</span>
            </span>
            <span v-for="item in encounterItems(enc)" :key="`${enc.log_id}-${item.item_id}`" class="text-purple-300">
              {{ item.name }} ×<span :title="formatNumber(item.qty)">{{ formatCompact(item.qty) }}</span>
            </span>
          </div>
        </div>
      </div>
      <EmptyState v-else text="暂无遭遇详情" />
      <template #footer>
        <AppButton size="sm" variant="outline" @click="encountersModal.show = false">关闭</AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 灵兽探渊综合面板脚本
 * 4 Tab 共享一个面板，按需懒加载对应子模块数据
 */
import { ref, reactive, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import PanelShell from '../ui/PanelShell.vue';
import PanelCard from '../ui/PanelCard.vue';
import Tabs from '../ui/Tabs.vue';
import AppButton from '../ui/AppButton.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
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
  type AbyssEncounter,
  type AbyssEncounterItem,
  type AbyssConfigData
} from '../../api/beastAbyss';
import { formatCompact, formatNumber } from '../../utils/format';

const uiStore = useUIStore();

/** Tab 配置（key/label 契约见 ui/Tabs.vue） */
const tabItems = [
  { key: 'status', label: '探渊状态' },
  { key: 'start', label: '开始探渊' },
  { key: 'ranking', label: '排行榜' },
  { key: 'history', label: '历史记录' }
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
/** 排行榜子分类 Tab 项（由 rankingSubTabs 派生，保持 key/name 单一来源） */
const rankingSubItems = rankingSubTabs.map(sub => ({ key: sub.key, label: sub.name }));
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
  history: [], total: 0, page: 1, page_size: 10
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
 * 今日探渊次数余量。后端 /status 未返回上限时按「未知」处理（null）：
 * 界面上宁可整块不显示，也不要印出 undefined 或 NaN。
 */
const dailyToday = computed(() =>
  typeof statusData.value?.daily_explores_today === 'number'
    ? statusData.value.daily_explores_today : null);
const dailyLimit = computed(() =>
  typeof statusData.value?.daily_limit === 'number' ? statusData.value.daily_limit : null);
const dailyRemaining = computed(() =>
  dailyToday.value === null || dailyLimit.value === null
    ? null : Math.max(0, dailyLimit.value - dailyToday.value));

/** 历史总页数：后端只给 total + page_size，页数由前端推导 */
const historyTotalPages = computed(() =>
  Math.max(1, Math.ceil((historyData.total || 0) / (historyData.page_size || 10))));

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
  if (dailyRemaining.value === 0) return false;
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
  if (page < 1 || page > historyTotalPages.value) return;
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
 * 获取探渊结局徽章色（tone 取值见 ui/Badge.vue）
 * @param outcome 结局值
 */
function getOutcomeTone(status: string): string {
  // 后端 status 字段值：active=进行中 / settled=已结算 / recalled=已召回 / dead=陨落
  // 兼容旧 outcome 字段值：success=成功 / dead=陨落 / recalled=提前召回
  const map: Record<string, string> = {
    active: 'info',
    settled: 'success',
    success: 'success',
    dead: 'danger',
    recalled: 'gold'
  };
  return map[status] || 'neutral';
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
  if (rank === 1) return 'inline-block px-2 py-0.5 rounded-control bg-gold-500 text-surface-sunken font-bold';
  if (rank === 2) return 'inline-block px-2 py-0.5 rounded-control bg-line-strong text-fg-primary font-bold';
  if (rank === 3) return 'inline-block px-2 py-0.5 rounded-control bg-gold-800 text-gold-200 font-bold';
  return 'inline-block px-2 py-0.5 rounded-control bg-surface-active text-fg-secondary';
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
    event: 'bg-gold-900/60 text-gold-300',
    treasure: 'bg-emerald-950/60 text-emerald-300',
    trap: 'bg-surface-active text-fg-secondary'
  };
  return map[type] || 'bg-surface-active text-fg-secondary';
}

/**
 * 获取遭遇类型边框样式
 * @param type 遭遇类型
 */
function getEncounterBorderClass(type: string): string {
  const map: Record<string, string> = {
    monster: 'border-rose-900/50',
    pvp: 'border-purple-900/50',
    event: 'border-gold-800/50',
    treasure: 'border-emerald-900/50',
    trap: 'border-line'
  };
  return map[type] || 'border-line-subtle';
}

/**
 * 遭遇结果中文名（后端 result 取值 victory/defeat/triggered，列可空）
 * 未知或为空时统一显示「未知」，不要印出 undefined
 * @param result 后端 result 字段
 */
function getResultName(result: string | null): string {
  const map: Record<string, string> = {
    victory: '胜',
    defeat: '败',
    triggered: '触发'
  };
  return map[result || ''] || '未知';
}

/**
 * 遭遇结果文字配色
 * @param result 后端 result 字段
 */
function getResultClass(result: string | null): string {
  const map: Record<string, string> = {
    victory: 'text-emerald-300',
    defeat: 'text-rose-300',
    triggered: 'text-gold-300'
  };
  return map[result || ''] || 'text-fg-faint';
}

/**
 * 五行中文名（encounter_detail.monster_element 为英文 key）
 * @param element 后端属性 key
 * @returns 中文名；无该字段或无法识别时返回空串，由模板 v-if 隐藏
 */
function getElementName(element?: string): string {
  const map: Record<string, string> = {
    metal: '金',
    wood: '木',
    water: '水',
    fire: '火',
    earth: '土',
    dark: '暗'
  };
  return element ? (map[element] || '') : '';
}

/**
 * 数值字段是否可用：hp_after / stamina_after 在库里是可空列，
 * 缺失时整块不显示，宁可留空也不要印成 0（那是凭空造出来的数）
 * @param value 后端数值字段
 */
function hasNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 单条遭遇的实物掉落
 * is_spirit_stone 的项后端不入背包（直接累计到玩家灵石），故此处跳过，
 * 灵石数值统一看 spirit_stones_gained，避免同一笔奖励展示两次
 * @param enc 遭遇日志
 */
function encounterItems(enc: AbyssEncounter): AbyssEncounterItem[] {
  return (enc.items_gained || []).filter(item => !item.is_spirit_stone);
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
