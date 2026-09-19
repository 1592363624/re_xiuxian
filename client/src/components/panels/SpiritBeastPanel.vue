/**
 * 灵兽面板组件
 *
 * 灵兽系统前端 UI，3 Tab 划分：
 *   1. 灵兽图鉴：展示所有灵兽种类（4 阶：青云狼/火焰狮/冰魄狐/腾蛇），含已捕获标记
 *   2. 我的灵兽：玩家拥有的灵兽列表（网格布局），点击查看详情/操作
 *   3. 灵兽详情：单只灵兽完整属性、战力、元素相克、操作按钮
 *
 * 设计原则：
 *   - 所有状态从后端 GET /spirit-beast/* 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色全部取 tokens.css 的 surface-* / line-* / fg-* / gold-* / state-* 令牌
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS（除淡入动画）
 */
<template>
  <PanelShell
    title="灵兽 · 寻觅养成"
    size="xl"
    scoped-scroll
    @close="$emit('close')"
  >
    <div class="h-full flex flex-col">
      <!-- Tab 切换栏 -->
      <Tabs :model-value="activeTab" :items="tabs" class="shrink-0 px-4" @update:model-value="switchTab" />

      <!-- 内容滚动区 -->
      <div class="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-4">

        <!-- ============ Tab 1: 灵兽图鉴 ============ -->
        <div v-show="activeTab === 'codex'" class="space-y-3">
          <LoadingBlock v-if="loading.types" text="正在凝神查阅灵兽图鉴…" />
          <template v-else>
            <!-- 元素相克说明 -->
            <section v-if="typesData" class="bg-surface-hover border border-line rounded-panel p-3">
              <div class="text-xs font-bold text-state-success mb-2">五行相克</div>
              <div class="flex flex-wrap gap-2">
                <div v-for="el in typesData.elements" :key="el.key"
                  class="text-[11px] px-2 py-1 rounded-control border"
                  :style="{ borderColor: el.color, color: el.color }">
                  {{ el.name }}克{{ getElementName(el.strong_against) }} · 畏{{ getElementName(el.weak_against) }}
                </div>
              </div>
            </section>

            <!-- 灵兽种类卡片网格 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <section v-for="bt in typesData?.beast_types || []" :key="bt.beast_key"
                class="bg-surface-hover border rounded-panel p-3 relative"
                :style="{ borderColor: bt.rarity_color + '60' }">
                <!-- 已捕获徽章 -->
                <Badge v-if="bt.caught" tone="success" class="absolute top-2 right-2">已捕获</Badge>
                <!-- 标题行 -->
                <div class="flex items-center gap-2 mb-2">
                  <div class="text-base font-bold font-display" :style="{ color: bt.rarity_color }">{{ bt.name }}</div>
                  <span class="text-[10px] px-1.5 py-0.5 rounded border"
                    :style="{ borderColor: bt.element_color, color: bt.element_color }">
                    {{ bt.element_name }}属性
                  </span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded"
                    :style="{ backgroundColor: bt.rarity_color + '30', color: bt.rarity_color }">
                    {{ bt.rarity_name }}
                  </span>
                </div>
                <!-- 描述 -->
                <div class="text-[11px] text-fg-muted mb-2 wrap-cjk">{{ bt.description }}</div>
                <!-- 基础属性 -->
                <div class="grid grid-cols-4 gap-1 text-[11px] text-fg-secondary mb-2">
                  <div><span class="text-fg-muted">气血</span> <span class="num">{{ bt.base_hp }}</span></div>
                  <div><span class="text-fg-muted">攻击</span> <span class="num">{{ bt.base_atk }}</span></div>
                  <div><span class="text-fg-muted">防御</span> <span class="num">{{ bt.base_def }}</span></div>
                  <div><span class="text-fg-muted">速度</span> <span class="num">{{ bt.base_speed }}</span></div>
                </div>
                <!-- 捕获信息 -->
                <div class="flex items-center justify-between text-[11px] gap-2">
                  <div class="text-fg-muted">
                    灵力消耗：<span class="text-gold-400 num">{{ bt.catch_cost_mp }}</span> ·
                    成功率：<span class="text-state-success num">{{ Math.floor(bt.catch_chance * 100) }}%</span>
                  </div>
                  <AppButton size="xs" variant="primary" :disabled="loading.action || !canCatch(bt)" @click="handleCatch(bt)">
                    寻觅
                  </AppButton>
                </div>
              </section>
            </div>
          </template>
        </div>

        <!-- ============ Tab 2: 我的灵兽 ============ -->
        <div v-show="activeTab === 'mine'" class="space-y-3">
          <LoadingBlock v-if="loading.list" text="正在召唤灵兽…" />
          <template v-else>
            <!-- 统计信息 -->
            <section v-if="listData" class="bg-surface-hover border border-line rounded-panel p-3">
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <div class="text-fg-muted">灵兽数量</div>
                  <div class="text-state-success font-bold num">{{ listData.stats.total }} / {{ listData.stats.max }}</div>
                </div>
                <div>
                  <div class="text-fg-muted">出战灵兽</div>
                  <div class="text-gold-400 font-bold num">{{ listData.stats.active_count }} 只</div>
                </div>
                <div>
                  <div class="text-fg-muted">今日捕获</div>
                  <div class="text-pink-300 font-bold num">{{ dailyStatus?.today_count || 0 }} / {{ dailyStatus?.daily_limit || 20 }}</div>
                </div>
                <div>
                  <div class="text-fg-muted">剩余次数</div>
                  <div class="text-state-danger font-bold num">{{ dailyStatus?.remaining ?? '?' }} 次</div>
                </div>
              </div>
            </section>

            <!-- 灵兽列表网格 -->
            <div v-if="listData && listData.beasts.length > 0" class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <section v-for="beast in listData.beasts" :key="beast.id"
                class="bg-surface-hover border rounded-panel p-3 cursor-pointer hover:bg-surface-active/50 transition-colors relative"
                :style="{ borderColor: beast.rarity_color + '60' }"
                @click="openDetail(beast.id)">
                <!-- 出战徽章 -->
                <Badge v-if="beast.is_active" tone="gold" class="absolute top-2 right-2">出战中</Badge>
                <!-- 标题行 -->
                <div class="flex items-center gap-2 mb-2">
                  <div class="text-base font-bold font-display" :style="{ color: beast.rarity_color }">{{ beast.display_name }}</div>
                  <span class="text-[10px] px-1.5 py-0.5 rounded border"
                    :style="{ borderColor: beast.element_color, color: beast.element_color }">
                    {{ beast.element_name }}
                  </span>
                  <span class="text-[10px] text-gold-400 num">★{{ beast.star_level }}</span>
                </div>
                <!-- 等级与战力 -->
                <div class="grid grid-cols-2 gap-2 text-[11px] text-fg-secondary mb-2">
                  <div><span class="text-fg-muted">等级</span> <span class="num">{{ beast.level }}</span></div>
                  <div><span class="text-fg-muted">战力</span> <span class="num">{{ beast.combat_power }}</span></div>
                </div>
                <!-- 属性 -->
                <div class="grid grid-cols-4 gap-1 text-[11px] text-fg-secondary mb-2">
                  <div><span class="text-fg-muted">气血</span> <span class="num" :title="String(beast.hp_max)">{{ formatCompact(beast.hp_max) }}</span></div>
                  <div><span class="text-fg-muted">攻</span> <span class="num">{{ beast.atk }}</span></div>
                  <div><span class="text-fg-muted">防</span> <span class="num">{{ beast.def }}</span></div>
                  <div><span class="text-fg-muted">速</span> <span class="num">{{ beast.speed }}</span></div>
                </div>
                <!-- 忠诚度进度条 -->
                <StatBar
                  label="忠诚度"
                  :value="beast.loyalty"
                  :max="100"
                  tone="arcane"
                  height="h-1"
                />
              </section>
            </div>

            <!-- 空状态 -->
            <EmptyState v-else text="您还未拥有任何灵兽" hint="前往图鉴寻觅你的第一只灵兽">
              <AppButton size="sm" variant="primary" @click="switchTab('codex')">前往图鉴寻觅</AppButton>
            </EmptyState>
          </template>
        </div>

        <!-- ============ Tab 3: 灵兽详情 ============ -->
        <div v-show="activeTab === 'detail'" class="space-y-3">
          <LoadingBlock v-if="loading.detail" text="正在凝视灵兽…" />
          <template v-else-if="detailData">
            <!-- 标题行 -->
            <section class="bg-surface-hover border rounded-panel p-4"
              :style="{ borderColor: detailData.rarity_color + '60' }">
              <div class="flex items-center gap-3 mb-3 flex-wrap">
                <div class="text-xl font-bold font-display" :style="{ color: detailData.rarity_color }">{{ detailData.display_name }}</div>
                <span class="text-xs px-2 py-0.5 rounded border"
                  :style="{ borderColor: detailData.element_color, color: detailData.element_color }">
                  {{ detailData.element_name }}属性
                </span>
                <span class="text-xs px-2 py-0.5 rounded"
                  :style="{ backgroundColor: detailData.rarity_color + '30', color: detailData.rarity_color }">
                  {{ detailData.rarity_name }}
                </span>
                <span class="text-gold-400 text-sm num">★{{ detailData.star_level }}</span>
                <Badge v-if="detailData.is_active" tone="gold">出战中</Badge>
              </div>
              <div class="text-xs text-fg-muted mb-3 wrap-cjk">{{ detailData.description }}</div>

              <!-- 等级与经验 -->
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
                <div>
                  <div class="text-fg-muted">等级</div>
                  <div class="text-state-success font-bold num">{{ detailData.level }} / 100</div>
                </div>
                <div>
                  <div class="text-fg-muted">战力</div>
                  <div class="text-gold-400 font-bold num">{{ detailData.combat_power }}</div>
                </div>
                <div>
                  <div class="text-fg-muted">忠诚度</div>
                  <div class="text-pink-300 font-bold num">{{ detailData.loyalty }}/100</div>
                </div>
                <div>
                  <div class="text-fg-muted">捕获时间</div>
                  <div class="text-fg-secondary text-[10px] num">{{ formatTime(detailData.caught_at) }}</div>
                </div>
              </div>

              <!-- 经验进度条 -->
              <div class="text-xs mb-3">
                <div class="flex justify-between text-fg-muted mb-0.5">
                  <span>经验</span>
                  <span class="text-state-success num" :title="`${detailData.exp} / ${detailData.exp_cap}`">{{ formatCompact(detailData.exp) }} / {{ formatCompact(detailData.exp_cap) }} ({{ detailData.exp_percent }}%)</span>
                </div>
                <StatBar :value="detailData.exp" :max="detailData.exp_cap" tone="jade" :show-value="false" />
              </div>

              <!-- 属性 -->
              <div class="grid grid-cols-4 gap-2 text-xs text-fg-secondary mb-3">
                <div class="bg-surface-sunken p-2 rounded-control border border-line">
                  <div class="text-fg-muted text-[10px]">气血上限</div>
                  <div class="text-state-danger font-bold num" :title="String(detailData.hp_max)">{{ formatCompact(detailData.hp_max) }}</div>
                </div>
                <div class="bg-surface-sunken p-2 rounded-control border border-line">
                  <div class="text-fg-muted text-[10px]">攻击</div>
                  <div class="text-gold-300 font-bold num">{{ detailData.atk }}</div>
                </div>
                <div class="bg-surface-sunken p-2 rounded-control border border-line">
                  <div class="text-fg-muted text-[10px]">防御</div>
                  <div class="text-state-info font-bold num">{{ detailData.def }}</div>
                </div>
                <div class="bg-surface-sunken p-2 rounded-control border border-line">
                  <div class="text-fg-muted text-[10px]">速度</div>
                  <div class="text-gold-400 font-bold num">{{ detailData.speed }}</div>
                </div>
              </div>

              <!-- 元素相克 -->
              <div v-if="detailData.element_relations" class="text-xs bg-surface-sunken p-2 rounded-control border border-line mb-3">
                <div class="text-fg-muted mb-1">五行相克</div>
                <div class="flex gap-4 flex-wrap">
                  <div>克制：<span class="text-state-success">{{ detailData.element_relations.strong_against.name }}</span>（伤害 <span class="num">×{{ detailData.element_relations.strong_against.multiplier }}</span>）</div>
                  <div>畏惧：<span class="text-state-danger">{{ detailData.element_relations.weak_against.name }}</span>（伤害 <span class="num">×{{ detailData.element_relations.weak_against.multiplier }}</span>）</div>
                </div>
              </div>
            </section>

            <!-- 冷却信息 -->
            <section class="bg-surface-hover border border-line rounded-panel p-3">
              <div class="text-xs font-bold text-state-success mb-2">操作冷却</div>
              <div class="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div class="text-fg-muted">喂养冷却</div>
                  <div class="num" :class="detailData.cooldown.feed_remaining_sec > 0 ? 'text-state-danger' : 'text-state-success'">
                    {{ detailData.cooldown.feed_remaining_sec > 0 ? formatCooldown(detailData.cooldown.feed_remaining_sec) : '可喂养' }}
                  </div>
                </div>
                <div>
                  <div class="text-fg-muted">互动冷却</div>
                  <div class="num" :class="detailData.cooldown.interact_remaining_sec > 0 ? 'text-state-danger' : 'text-state-success'">
                    {{ detailData.cooldown.interact_remaining_sec > 0 ? formatCooldown(detailData.cooldown.interact_remaining_sec) : '可互动' }}
                  </div>
                </div>
              </div>
            </section>

            <!-- 操作按钮 -->
            <section class="bg-surface-hover border border-line rounded-panel p-3">
              <div class="text-xs font-bold text-state-success mb-2">灵兽操作</div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                <AppButton block size="sm" variant="primary"
                  :disabled="loading.action || detailData.cooldown.feed_remaining_sec > 0"
                  @click="handleFeed">
                  喂养（消耗灵石）
                </AppButton>
                <AppButton block size="sm" variant="outline"
                  :disabled="loading.action || detailData.cooldown.interact_remaining_sec > 0"
                  @click="handleInteract">
                  互动（增加忠诚）
                </AppButton>
                <AppButton v-if="!detailData.is_active" block size="sm" variant="primary"
                  :disabled="loading.action" @click="handleSetActive">
                  设置出战
                </AppButton>
                <AppButton v-else block size="sm" variant="default" disabled>
                  已在出战中
                </AppButton>
                <AppButton block size="sm" variant="danger"
                  :disabled="loading.action" @click="handleRelease">
                  放生（返还灵石）
                </AppButton>
              </div>
            </section>
          </template>
          <EmptyState v-else text="请从「我的灵兽」中选择一只灵兽查看详情" />
        </div>

        <!-- 操作结果提示条 -->
        <div v-if="actionMessage" class="mt-3 px-3 py-2 rounded-control text-xs border" :class="actionMessage.success ? 'bg-surface-tint-jade border-state-success/60 text-state-success' : 'bg-rose-950/40 border-state-danger/60 text-state-danger'">
          {{ actionMessage.text }}
        </div>
      </div>
    </div>

    <!-- 放生确认弹窗 -->
    <div v-if="releaseConfirm" class="fixed inset-0 z-[60] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/90" @click="releaseConfirm = false"></div>
      <div class="relative bg-surface-raised border border-state-danger/50 rounded-panel p-6 max-w-sm w-full mx-4 shadow-2xl shadow-black/60">
        <h3 class="text-lg font-bold text-state-danger mb-2 font-display">确认放生</h3>
        <p class="text-fg-muted text-sm mb-4">放生后灵兽将永久离开，将按稀有度返还部分灵石。此操作不可撤销，是否继续？</p>
        <div class="flex justify-end gap-3">
          <AppButton variant="default" @click="releaseConfirm = false">取消</AppButton>
          <AppButton variant="danger" :disabled="loading.action" @click="confirmRelease">确认放生</AppButton>
        </div>
      </div>
    </div>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 灵兽面板组件逻辑
 * - 通过 apiClient 调用灵兽系统接口
 * - 维护 3 个 Tab 状态：图鉴 / 我的灵兽 / 详情
 * - 操作结果通过底部消息条展示（不使用浏览器 alert）
 * - 放生操作通过自定义 Modal 二次确认
 */
import { ref, reactive, onMounted } from 'vue';
import PanelShell from '../ui/PanelShell.vue';
import Tabs from '../ui/Tabs.vue';
import AppButton from '../ui/AppButton.vue';
import Badge from '../ui/Badge.vue';
import StatBar from '../ui/StatBar.vue';
import EmptyState from '../ui/EmptyState.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
import { formatCompact } from '../../utils/format';
import {
  getBeastTypes, getMyBeasts, getBeastDetail, getDailyStatus,
  catchBeast, feedBeast, interactBeast, setActiveBeast, releaseBeast,
  type BeastTypesData, type BeastListData, type SpiritBeastDetail, type DailyStatusData,
  type BeastTypeInfo
} from '../../api/spiritBeast';

/** Tab 定义（key/label 契约见 ui/Tabs.vue） */
const tabs = [
  { key: 'codex', label: '灵兽图鉴' },
  { key: 'mine', label: '我的灵兽' },
  { key: 'detail', label: '灵兽详情' }
] as const;

type TabId = typeof tabs[number]['key'];

/** 当前激活的 Tab */
const activeTab = ref<TabId>('codex');

/** 加载状态 */
const loading = reactive({
  types: false,
  list: false,
  detail: false,
  action: false
});

/** 图鉴数据 */
const typesData = ref<BeastTypesData | null>(null);
/** 我的灵兽列表 */
const listData = ref<BeastListData | null>(null);
/** 灵兽详情 */
const detailData = ref<SpiritBeastDetail | null>(null);
/** 今日捕获状态 */
const dailyStatus = ref<DailyStatusData | null>(null);

/** 操作消息（底部展示） */
const actionMessage = ref<{ success: boolean; text: string } | null>(null);

/** 放生确认弹窗 */
const releaseConfirm = ref(false);
/** 当前操作的灵兽ID（用于放生） */
const currentBeastId = ref<number | null>(null);

/**
 * 切换 Tab，并按需拉取数据
 * @param tab ui/Tabs.vue 回调的 key
 */
const switchTab = async (tab: TabId | string) => {
  activeTab.value = tab as TabId;
  if (tab === 'codex' && !typesData.value) {
    await fetchTypes();
  } else if (tab === 'mine' && !listData.value) {
    await Promise.all([fetchList(), fetchDailyStatus()]);
  }
};

/**
 * 拉取图鉴数据
 */
const fetchTypes = async () => {
  loading.types = true;
  try {
    const res = await getBeastTypes();
    if (res.data?.code === 200 && res.data.data) {
      typesData.value = res.data.data;
    }
  } catch (e) {
    console.error('[SpiritBeastPanel.fetchTypes]', e);
  } finally {
    loading.types = false;
  }
};

/**
 * 拉取我的灵兽列表
 */
const fetchList = async () => {
  loading.list = true;
  try {
    const res = await getMyBeasts();
    if (res.data?.code === 200 && res.data.data) {
      listData.value = res.data.data;
    }
  } catch (e) {
    console.error('[SpiritBeastPanel.fetchList]', e);
  } finally {
    loading.list = false;
  }
};

/**
 * 拉取今日捕获状态
 */
const fetchDailyStatus = async () => {
  try {
    const res = await getDailyStatus();
    if (res.data?.code === 200 && res.data.data) {
      dailyStatus.value = res.data.data;
    }
  } catch (e) {
    console.error('[SpiritBeastPanel.fetchDailyStatus]', e);
  }
};

/**
 * 打开灵兽详情
 */
const openDetail = async (beastId: number) => {
  activeTab.value = 'detail';
  currentBeastId.value = beastId;
  loading.detail = true;
  detailData.value = null;
  try {
    const res = await getBeastDetail(beastId);
    if (res.data?.code === 200 && res.data.data) {
      detailData.value = res.data.data;
    } else {
      showMessage(false, res.data?.message || '获取灵兽详情失败');
    }
  } catch (e) {
    console.error('[SpiritBeastPanel.openDetail]', e);
    showMessage(false, '获取灵兽详情失败');
  } finally {
    loading.detail = false;
  }
};

/**
 * 刷新当前详情灵兽
 */
const refreshDetail = async () => {
  if (!currentBeastId.value) return;
  try {
    const res = await getBeastDetail(currentBeastId.value);
    if (res.data?.code === 200 && res.data.data) {
      detailData.value = res.data.data;
    }
  } catch (e) {
    console.error('[SpiritBeastPanel.refreshDetail]', e);
  }
};

/**
 * 寻觅/捕获灵兽
 */
const handleCatch = async (bt: BeastTypeInfo) => {
  if (!canCatch(bt)) return;
  loading.action = true;
  actionMessage.value = null;
  try {
    const res = await catchBeast(bt.beast_key);
    const data = res.data;
    if (data?.data) {
      const result = data.data;
      if (result.caught) {
        showMessage(true, `捕获成功！获得 ${result.beast_name}（${bt.rarity_name}）`);
        // 刷新图鉴与列表
        await Promise.all([fetchTypes(), fetchList(), fetchDailyStatus()]);
      } else {
        showMessage(false, `${result.beast_name}寻觅失败，灵力消耗 ${result.cost_mp}（返还 ${result.return_mp || '0'}）`);
        await fetchDailyStatus();
      }
    } else {
      showMessage(false, data?.message || '捕获失败');
    }
  } catch (e: any) {
    showMessage(false, e?.response?.data?.message || '捕获失败');
  } finally {
    loading.action = false;
  }
};

/**
 * 喂养灵兽
 */
const handleFeed = async () => {
  if (!currentBeastId.value) return;
  loading.action = true;
  actionMessage.value = null;
  try {
    const res = await feedBeast(currentBeastId.value);
    const data = res.data;
    if (data?.success !== false && data?.data) {
      const r = data.data;
      showMessage(true, `喂养成功！获得经验 ${r.exp_gain}，忠诚度 +${r.loyalty_gain}${r.level_up ? `，升级至 ${r.new_level} 级！` : ''}`);
      await Promise.all([refreshDetail(), fetchList()]);
    } else {
      showMessage(false, data?.message || '喂养失败');
    }
  } catch (e: any) {
    showMessage(false, e?.response?.data?.message || '喂养失败');
  } finally {
    loading.action = false;
  }
};

/**
 * 互动灵兽
 */
const handleInteract = async () => {
  if (!currentBeastId.value) return;
  loading.action = true;
  actionMessage.value = null;
  try {
    const res = await interactBeast(currentBeastId.value);
    const data = res.data;
    if (data?.success !== false && data?.data) {
      const r = data.data;
      showMessage(true, `互动成功！获得经验 ${r.exp_gain}，忠诚度 +${r.loyalty_gain}${r.level_up ? `，升级至 ${r.new_level} 级！` : ''}`);
      await Promise.all([refreshDetail(), fetchList()]);
    } else {
      showMessage(false, data?.message || '互动失败');
    }
  } catch (e: any) {
    showMessage(false, e?.response?.data?.message || '互动失败');
  } finally {
    loading.action = false;
  }
};

/**
 * 设置出战灵兽
 */
const handleSetActive = async () => {
  if (!currentBeastId.value) return;
  loading.action = true;
  actionMessage.value = null;
  try {
    const res = await setActiveBeast(currentBeastId.value);
    const data = res.data;
    if (data?.success !== false) {
      showMessage(true, '出战灵兽已设置');
      await Promise.all([refreshDetail(), fetchList()]);
    } else {
      showMessage(false, data?.message || '设置出战失败');
    }
  } catch (e: any) {
    showMessage(false, e?.response?.data?.message || '设置出战失败');
  } finally {
    loading.action = false;
  }
};

/**
 * 点击放生按钮：弹出确认弹窗
 */
const handleRelease = () => {
  releaseConfirm.value = true;
};

/**
 * 确认放生
 */
const confirmRelease = async () => {
  if (!currentBeastId.value) return;
  releaseConfirm.value = false;
  loading.action = true;
  actionMessage.value = null;
  try {
    const res = await releaseBeast(currentBeastId.value);
    const data = res.data;
    if (data?.success !== false && data?.data) {
      showMessage(true, `已放生灵兽，返还灵石 ${data.data.return_spirit_stones}`);
      // 返回我的灵兽列表
      activeTab.value = 'mine';
      detailData.value = null;
      currentBeastId.value = null;
      await Promise.all([fetchList(), fetchDailyStatus()]);
    } else {
      showMessage(false, data?.message || '放生失败');
    }
  } catch (e: any) {
    showMessage(false, e?.response?.data?.message || '放生失败');
  } finally {
    loading.action = false;
  }
};

/**
 * 校验灵兽是否可捕获（境界/次数由后端权威校验，前端仅做基本禁用判断）
 */
const canCatch = (bt: BeastTypeInfo) => {
  if (!dailyStatus.value) return true;
  // 今日次数已满
  if (dailyStatus.value.remaining <= 0) return false;
  // 灵兽背包已满
  if (dailyStatus.value.current_beast_count >= dailyStatus.value.max_beast_count) return false;
  return true;
};

/**
 * 显示操作消息（3 秒后自动清除）
 */
const showMessage = (success: boolean, text: string) => {
  actionMessage.value = { success, text };
  setTimeout(() => {
    actionMessage.value = null;
  }, 3500);
};

/**
 * 根据元素 key 获取中文名
 */
const getElementName = (key: string): string => {
  return typesData.value?.elements.find(e => e.key === key)?.name || key;
};

/**
 * 格式化时间
 */
const formatTime = (iso: string | null): string => {
  if (!iso) return '未知';
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
};

/**
 * 格式化冷却秒数为可读字符串
 */
const formatCooldown = (sec: number): string => {
  if (sec <= 0) return '可操作';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
};

// 组件挂载时拉取初始数据
onMounted(async () => {
  await Promise.all([fetchTypes(), fetchDailyStatus()]);
});
</script>
