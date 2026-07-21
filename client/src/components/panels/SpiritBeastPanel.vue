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
 *   - 颜色风格与 CompanionPanel.vue 一致（修仙古风：#1c1917 / #292524 / amber-300 / emerald-300）
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS（除淡入动画）
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-emerald-900/40 rounded-lg p-6 max-w-5xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-emerald-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-2.97 7 .41 1.04 1 2.02 1.56 2.85 2.53 3.8-1.41 6.35-4.5 4.73l-3.23-1.68a19 19 0 0 0-2.57 0l-3.23 1.68c-3.09 1.62-7.03-.93-4.5-4.73.56-.83 1.15-1.81 1.56-2.85-2.55 0-4.37-6.42-2.97-7C4.62 2.25 7.87 3.09 9.65 5.09 10.3 4.92 11.33 5 12 5z"/>
          </svg>
          灵兽 · 寻觅养成
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
          :class="activeTab === tab.id ? 'text-emerald-300' : 'text-stone-500 hover:text-stone-300'">
          {{ tab.name }}
          <div v-if="activeTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-emerald-400"></div>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto pr-1">

        <!-- ============ Tab 1: 灵兽图鉴 ============ -->
        <div v-show="activeTab === 'codex'" class="space-y-3">
          <div v-if="loading.types" class="text-center py-8 text-stone-500 text-sm">正在凝神查阅灵兽图鉴...</div>
          <template v-else>
            <!-- 元素相克说明 -->
            <section v-if="typesData" class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs font-bold text-emerald-300 mb-2">五行相克</div>
              <div class="flex flex-wrap gap-2">
                <div v-for="el in typesData.elements" :key="el.key"
                  class="text-[11px] px-2 py-1 rounded border"
                  :style="{ borderColor: el.color, color: el.color }">
                  {{ el.name }}克{{ getElementName(el.strong_against) }} · 畏{{ getElementName(el.weak_against) }}
                </div>
              </div>
            </section>

            <!-- 灵兽种类卡片网格 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <section v-for="bt in typesData?.beast_types || []" :key="bt.beast_key"
                class="bg-[#292524] border rounded-lg p-3 relative"
                :style="{ borderColor: bt.rarity_color + '60' }">
                <!-- 已捕获徽章 -->
                <div v-if="bt.caught" class="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded bg-emerald-900/60 text-emerald-300 border border-emerald-800">
                  已捕获
                </div>
                <!-- 标题行 -->
                <div class="flex items-center gap-2 mb-2">
                  <div class="text-base font-bold" :style="{ color: bt.rarity_color }">{{ bt.name }}</div>
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
                <div class="text-[11px] text-stone-400 mb-2">{{ bt.description }}</div>
                <!-- 基础属性 -->
                <div class="grid grid-cols-4 gap-1 text-[11px] text-stone-300 mb-2">
                  <div><span class="text-stone-500">气血</span> {{ bt.base_hp }}</div>
                  <div><span class="text-stone-500">攻击</span> {{ bt.base_atk }}</div>
                  <div><span class="text-stone-500">防御</span> {{ bt.base_def }}</div>
                  <div><span class="text-stone-500">速度</span> {{ bt.base_speed }}</div>
                </div>
                <!-- 捕获信息 -->
                <div class="flex items-center justify-between text-[11px]">
                  <div class="text-stone-400">
                    灵力消耗：<span class="text-amber-300">{{ bt.catch_cost_mp }}</span> ·
                    成功率：<span class="text-emerald-300">{{ Math.floor(bt.catch_chance * 100) }}%</span>
                  </div>
                  <button
                    @click="handleCatch(bt)"
                    :disabled="loading.action || !canCatch(bt)"
                    class="px-3 py-1 rounded text-[11px] font-bold bg-emerald-800 text-emerald-100 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed">
                    寻觅
                  </button>
                </div>
              </section>
            </div>
          </template>
        </div>

        <!-- ============ Tab 2: 我的灵兽 ============ -->
        <div v-show="activeTab === 'mine'" class="space-y-3">
          <div v-if="loading.list" class="text-center py-8 text-stone-500 text-sm">正在召唤灵兽...</div>
          <template v-else>
            <!-- 统计信息 -->
            <section v-if="listData" class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <div class="text-stone-500">灵兽数量</div>
                  <div class="text-emerald-300 font-bold">{{ listData.stats.total }} / {{ listData.stats.max }}</div>
                </div>
                <div>
                  <div class="text-stone-500">出战灵兽</div>
                  <div class="text-amber-300 font-bold">{{ listData.stats.active_count }} 只</div>
                </div>
                <div>
                  <div class="text-stone-500">今日捕获</div>
                  <div class="text-pink-300 font-bold">{{ dailyStatus?.today_count || 0 }} / {{ dailyStatus?.daily_limit || 20 }}</div>
                </div>
                <div>
                  <div class="text-stone-500">剩余次数</div>
                  <div class="text-rose-300 font-bold">{{ dailyStatus?.remaining ?? '?' }} 次</div>
                </div>
              </div>
            </section>

            <!-- 灵兽列表网格 -->
            <div v-if="listData && listData.beasts.length > 0" class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <section v-for="beast in listData.beasts" :key="beast.id"
                class="bg-[#292524] border rounded-lg p-3 cursor-pointer hover:bg-stone-800/50 transition-colors relative"
                :style="{ borderColor: beast.rarity_color + '60' }"
                @click="openDetail(beast.id)">
                <!-- 出战徽章 -->
                <div v-if="beast.is_active" class="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded bg-amber-900/60 text-amber-300 border border-amber-800">
                  出战中
                </div>
                <!-- 标题行 -->
                <div class="flex items-center gap-2 mb-2">
                  <div class="text-base font-bold" :style="{ color: beast.rarity_color }">{{ beast.display_name }}</div>
                  <span class="text-[10px] px-1.5 py-0.5 rounded border"
                    :style="{ borderColor: beast.element_color, color: beast.element_color }">
                    {{ beast.element_name }}
                  </span>
                  <span class="text-[10px] text-amber-400">★{{ beast.star_level }}</span>
                </div>
                <!-- 等级与战力 -->
                <div class="grid grid-cols-2 gap-2 text-[11px] text-stone-300 mb-2">
                  <div><span class="text-stone-500">等级</span> {{ beast.level }}</div>
                  <div><span class="text-stone-500">战力</span> {{ beast.combat_power }}</div>
                </div>
                <!-- 属性 -->
                <div class="grid grid-cols-4 gap-1 text-[11px] text-stone-300 mb-2">
                  <div><span class="text-stone-500">气血</span> {{ formatBig(beast.hp_max) }}</div>
                  <div><span class="text-stone-500">攻</span> {{ beast.atk }}</div>
                  <div><span class="text-stone-500">防</span> {{ beast.def }}</div>
                  <div><span class="text-stone-500">速</span> {{ beast.speed }}</div>
                </div>
                <!-- 忠诚度进度条 -->
                <div class="text-[11px]">
                  <div class="flex justify-between text-stone-500 mb-0.5">
                    <span>忠诚度</span>
                    <span class="text-pink-300">{{ beast.loyalty }}/100</span>
                  </div>
                  <div class="h-1 bg-stone-800 rounded overflow-hidden">
                    <div class="h-full bg-pink-500" :style="{ width: beast.loyalty + '%' }"></div>
                  </div>
                </div>
              </section>
            </div>

            <!-- 空状态 -->
            <div v-else class="text-center py-12 text-stone-500 text-sm">
              <div class="mb-3">您还未拥有任何灵兽</div>
              <button @click="switchTab('codex')" class="px-4 py-2 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">
                前往图鉴寻觅
              </button>
            </div>
          </template>
        </div>

        <!-- ============ Tab 3: 灵兽详情 ============ -->
        <div v-show="activeTab === 'detail'" class="space-y-3">
          <div v-if="loading.detail" class="text-center py-8 text-stone-500 text-sm">正在凝视灵兽...</div>
          <template v-else-if="detailData">
            <!-- 标题行 -->
            <section class="bg-[#292524] border rounded-lg p-4"
              :style="{ borderColor: detailData.rarity_color + '60' }">
              <div class="flex items-center gap-3 mb-3">
                <div class="text-xl font-bold" :style="{ color: detailData.rarity_color }">{{ detailData.display_name }}</div>
                <span class="text-xs px-2 py-0.5 rounded border"
                  :style="{ borderColor: detailData.element_color, color: detailData.element_color }">
                  {{ detailData.element_name }}属性
                </span>
                <span class="text-xs px-2 py-0.5 rounded"
                  :style="{ backgroundColor: detailData.rarity_color + '30', color: detailData.rarity_color }">
                  {{ detailData.rarity_name }}
                </span>
                <span class="text-amber-400 text-sm">★{{ detailData.star_level }}</span>
                <span v-if="detailData.is_active" class="text-[10px] px-2 py-0.5 rounded bg-amber-900/60 text-amber-300 border border-amber-800">
                  出战中
                </span>
              </div>
              <div class="text-xs text-stone-400 mb-3">{{ detailData.description }}</div>

              <!-- 等级与经验 -->
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
                <div>
                  <div class="text-stone-500">等级</div>
                  <div class="text-emerald-300 font-bold">{{ detailData.level }} / 100</div>
                </div>
                <div>
                  <div class="text-stone-500">战力</div>
                  <div class="text-amber-300 font-bold">{{ detailData.combat_power }}</div>
                </div>
                <div>
                  <div class="text-stone-500">忠诚度</div>
                  <div class="text-pink-300 font-bold">{{ detailData.loyalty }}/100</div>
                </div>
                <div>
                  <div class="text-stone-500">捕获时间</div>
                  <div class="text-stone-300 text-[10px]">{{ formatTime(detailData.caught_at) }}</div>
                </div>
              </div>

              <!-- 经验进度条 -->
              <div class="text-xs mb-3">
                <div class="flex justify-between text-stone-500 mb-0.5">
                  <span>经验</span>
                  <span class="text-emerald-300">{{ formatBig(detailData.exp) }} / {{ formatBig(detailData.exp_cap) }} ({{ detailData.exp_percent }}%)</span>
                </div>
                <div class="h-1.5 bg-stone-800 rounded overflow-hidden">
                  <div class="h-full bg-emerald-500" :style="{ width: detailData.exp_percent + '%' }"></div>
                </div>
              </div>

              <!-- 属性 -->
              <div class="grid grid-cols-4 gap-2 text-xs text-stone-300 mb-3">
                <div class="bg-stone-900/50 p-2 rounded border border-stone-800">
                  <div class="text-stone-500 text-[10px]">气血上限</div>
                  <div class="text-rose-300 font-bold">{{ formatBig(detailData.hp_max) }}</div>
                </div>
                <div class="bg-stone-900/50 p-2 rounded border border-stone-800">
                  <div class="text-stone-500 text-[10px]">攻击</div>
                  <div class="text-orange-300 font-bold">{{ detailData.atk }}</div>
                </div>
                <div class="bg-stone-900/50 p-2 rounded border border-stone-800">
                  <div class="text-stone-500 text-[10px]">防御</div>
                  <div class="text-blue-300 font-bold">{{ detailData.def }}</div>
                </div>
                <div class="bg-stone-900/50 p-2 rounded border border-stone-800">
                  <div class="text-stone-500 text-[10px]">速度</div>
                  <div class="text-yellow-300 font-bold">{{ detailData.speed }}</div>
                </div>
              </div>

              <!-- 元素相克 -->
              <div v-if="detailData.element_relations" class="text-xs bg-stone-900/40 p-2 rounded border border-stone-800 mb-3">
                <div class="text-stone-500 mb-1">五行相克</div>
                <div class="flex gap-4">
                  <div>克制：<span class="text-emerald-300">{{ detailData.element_relations.strong_against.name }}</span>（伤害 ×{{ detailData.element_relations.strong_against.multiplier }}）</div>
                  <div>畏惧：<span class="text-rose-300">{{ detailData.element_relations.weak_against.name }}</span>（伤害 ×{{ detailData.element_relations.weak_against.multiplier }}）</div>
                </div>
              </div>
            </section>

            <!-- 冷却信息 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs font-bold text-emerald-300 mb-2">操作冷却</div>
              <div class="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div class="text-stone-500">喂养冷却</div>
                  <div :class="detailData.cooldown.feed_remaining_sec > 0 ? 'text-rose-300' : 'text-emerald-300'">
                    {{ detailData.cooldown.feed_remaining_sec > 0 ? formatCooldown(detailData.cooldown.feed_remaining_sec) : '可喂养' }}
                  </div>
                </div>
                <div>
                  <div class="text-stone-500">互动冷却</div>
                  <div :class="detailData.cooldown.interact_remaining_sec > 0 ? 'text-rose-300' : 'text-emerald-300'">
                    {{ detailData.cooldown.interact_remaining_sec > 0 ? formatCooldown(detailData.cooldown.interact_remaining_sec) : '可互动' }}
                  </div>
                </div>
              </div>
            </section>

            <!-- 操作按钮 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="text-xs font-bold text-emerald-300 mb-2">灵兽操作</div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                <button @click="handleFeed"
                  :disabled="loading.action || detailData.cooldown.feed_remaining_sec > 0"
                  class="px-3 py-2 rounded text-xs font-bold bg-amber-800 text-amber-100 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed">
                  喂养（消耗灵石）
                </button>
                <button @click="handleInteract"
                  :disabled="loading.action || detailData.cooldown.interact_remaining_sec > 0"
                  class="px-3 py-2 rounded text-xs font-bold bg-pink-800 text-pink-100 hover:bg-pink-700 disabled:opacity-40 disabled:cursor-not-allowed">
                  互动（增加忠诚）
                </button>
                <button v-if="!detailData.is_active" @click="handleSetActive"
                  :disabled="loading.action"
                  class="px-3 py-2 rounded text-xs font-bold bg-emerald-800 text-emerald-100 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed">
                  设置出战
                </button>
                <button v-else disabled
                  class="px-3 py-2 rounded text-xs font-bold bg-stone-800 text-stone-500 cursor-not-allowed">
                  已在出战中
                </button>
                <button @click="handleRelease"
                  :disabled="loading.action"
                  class="px-3 py-2 rounded text-xs font-bold bg-rose-900/60 text-rose-300 hover:bg-rose-800 disabled:opacity-40 border border-rose-800">
                  放生（返还灵石）
                </button>
              </div>
            </section>
          </template>
          <div v-else class="text-center py-12 text-stone-500 text-sm">
            请从"我的灵兽"中选择一只灵兽查看详情
          </div>
        </div>
      </div>

      <!-- 操作结果提示条 -->
      <div v-if="actionMessage" class="mt-3 px-3 py-2 rounded text-xs border" :class="actionMessage.success ? 'bg-emerald-900/40 border-emerald-800 text-emerald-300' : 'bg-rose-900/40 border-rose-800 text-rose-300'">
        {{ actionMessage.text }}
      </div>
    </div>

    <!-- 放生确认弹窗 -->
    <div v-if="releaseConfirm" class="fixed inset-0 z-[60] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/90" @click="releaseConfirm = false"></div>
      <div class="relative bg-[#1c1917] border border-rose-800 rounded-lg p-6 max-w-sm w-full mx-4 shadow-2xl">
        <h3 class="text-lg font-bold text-rose-300 mb-2">确认放生</h3>
        <p class="text-stone-400 text-sm mb-4">放生后灵兽将永久离开，将按稀有度返还部分灵石。此操作不可撤销，是否继续？</p>
        <div class="flex justify-end gap-3">
          <button @click="releaseConfirm = false" class="px-4 py-2 rounded border border-stone-700 text-stone-300 hover:bg-stone-800 text-xs">取消</button>
          <button @click="confirmRelease" :disabled="loading.action"
            class="px-4 py-2 rounded bg-rose-900/60 border border-rose-800 text-rose-300 hover:bg-rose-900 text-xs disabled:opacity-50">
            确认放生
          </button>
        </div>
      </div>
    </div>
  </div>
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
import {
  getBeastTypes, getMyBeasts, getBeastDetail, getDailyStatus,
  catchBeast, feedBeast, interactBeast, setActiveBeast, releaseBeast,
  type BeastTypesData, type BeastListData, type SpiritBeastDetail, type DailyStatusData,
  type BeastTypeInfo
} from '../../api/spiritBeast';

/** Tab 定义 */
const tabs = [
  { id: 'codex', name: '灵兽图鉴' },
  { id: 'mine', name: '我的灵兽' },
  { id: 'detail', name: '灵兽详情' }
] as const;

type TabId = typeof tabs[number]['id'];

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
 */
const switchTab = async (tab: TabId) => {
  activeTab.value = tab;
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
 * 格式化大数字（BigInt 字符串）
 */
const formatBig = (val: string | number | null | undefined): string => {
  if (val === null || val === undefined) return '0';
  const s = String(val);
  // 千分位分隔
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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

<style scoped>
@keyframes fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fade-in 0.2s ease-out;
}
</style>
