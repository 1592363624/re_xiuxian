/**
 * 器灵系统面板组件（法宝器灵养成与多人试炼竞技）
 *
 * 弹窗式组件，展示器灵系统 4 大子模块：
 *   Tab 1: 我的器灵 — 已唤醒器灵列表，支持抚摸/温养/护主/催发/试炼操作
 *   Tab 2: 唤醒器灵 — 选择已装备法宝 + 器灵类型 + 名称进行唤醒
 *   Tab 3: 试炼榜 — 全服试炼累计分排行（多人竞争维度）
 *   Tab 4: 器灵图鉴 — 4种器灵类型说明（攻击/防御/辅助/平衡）
 *
 * 设计原则：
 *   - 所有业务逻辑在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格：器灵系统用青绿双色系（cyan/emerald），彰显灵性与养成感
 *   - 4种器灵类型差异化配色：attack红/defense蓝/support紫/balance金
 *
 * 数据来源：
 *   - getMySpirits() / getSpiritDetail() — 器灵列表与详情
 *   - awakenSpirit() — 唤醒器灵
 *   - trialSpirit() / petSpirit() / nurtureSpirit() / protectSpirit() / activateSpirit() — 互动操作
 *   - getTrialRanking() — 试炼排行榜
 */
<template>
  <PanelShell
    title="法宝器灵 · 灵识养成"
    size="xl"
    scoped-scroll
    fill
    @close="$emit('close')"
  >
    <div class="h-full flex flex-col">
      <!-- Tab 切换栏 -->
      <Tabs :model-value="activeTab" :items="tabs" class="shrink-0 px-4" @update:model-value="switchTab" />

      <!-- 内容滚动区 -->
      <div class="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-4 space-y-3">

        <!-- ===== Tab 1: 我的器灵 ===== -->
        <div v-if="activeTab === 'my'" class="space-y-3">
          <LoadingBlock v-if="loading.my" text="加载器灵列表中…" />
          <EmptyState
            v-else-if="mySpirits.length === 0"
            text="尚未唤醒任何器灵"
            hint="前往「唤醒器灵」页签选择法宝唤醒器灵"
          />
          <template v-else>
            <div v-for="spirit in mySpirits" :key="spirit.spirit_id"
              class="bg-surface-hover border rounded-panel p-3"
              :class="getSpiritTypeBorderClass(spirit.spirit_type)">
              <!-- 器灵头部 -->
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="text-[15px] font-bold font-display" :class="getSpiritTypeTextClass(spirit.spirit_type)">
                    {{ spirit.spirit_name || spirit.spirit_type_name }}
                  </span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded" :class="getSpiritTypeBadgeClass(spirit.spirit_type)">
                    {{ spirit.spirit_type_name }}
                  </span>
                  <span class="text-[10px] text-fg-muted num">Lv.{{ spirit.spirit_level }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <Badge v-if="spirit.is_protecting" tone="success">护主中</Badge>
                  <Badge v-if="spirit.is_activating" tone="gold">催发中</Badge>
                  <Badge v-if="spirit.is_equipment_broken" tone="danger">法宝已碎</Badge>
                </div>
              </div>

              <!-- 器灵属性条 -->
              <div class="grid grid-cols-3 gap-2 text-xs mb-3">
                <div>
                  <div class="text-fg-muted">亲密度</div>
                  <div class="text-state-info font-bold num">{{ spirit.intimacy }}/100</div>
                </div>
                <div>
                  <div class="text-fg-muted">力量值</div>
                  <div class="text-state-success font-bold num">{{ spirit.power }}/1000</div>
                </div>
                <div>
                  <div class="text-fg-muted">试炼最高</div>
                  <div class="text-gold-400 font-bold num" :title="String(spirit.trial_best_score)">{{ formatCompact(spirit.trial_best_score) }}</div>
                </div>
              </div>

              <!-- 操作按钮组 -->
              <div class="grid grid-cols-5 gap-1">
                <button @click="handleAction(spirit, 'detail')"
                  class="py-1.5 rounded-control text-[11px] font-bold bg-surface-sunken border border-line text-fg-secondary hover:bg-surface-hover transition-colors disabled:opacity-40">
                  详情
                </button>
                <button @click="handleAction(spirit, 'pet')"
                  :disabled="loading.action"
                  class="py-1.5 rounded-control text-[11px] font-bold bg-pink-950/40 border border-pink-800 text-pink-300 hover:bg-pink-900/40 disabled:opacity-40 transition-colors">
                  抚摸
                </button>
                <button @click="handleAction(spirit, 'nurture')"
                  :disabled="loading.action"
                  class="py-1.5 rounded-control text-[11px] font-bold bg-surface-tint-arcane border border-state-info/50 text-state-info hover:bg-surface-active disabled:opacity-40 transition-colors">
                  温养
                </button>
                <button @click="handleAction(spirit, 'protect')"
                  :disabled="loading.action"
                  class="py-1.5 rounded-control text-[11px] font-bold bg-surface-tint-jade border border-state-success/50 text-state-success hover:bg-surface-active disabled:opacity-40 transition-colors">
                  护主
                </button>
                <button @click="handleAction(spirit, 'activate')"
                  :disabled="loading.action"
                  class="py-1.5 rounded-control text-[11px] font-bold bg-surface-tint-gold-strong border border-gold-700 text-gold-300 hover:bg-surface-active disabled:opacity-40 transition-colors">
                  催发
                </button>
              </div>
              <div class="grid grid-cols-1 gap-1 mt-1">
                <button @click="handleAction(spirit, 'trial')"
                  :disabled="loading.action"
                  class="py-1.5 rounded-control text-[11px] font-bold bg-surface-tint-arcane border border-state-arcane/50 text-state-arcane hover:bg-surface-active disabled:opacity-40 transition-colors">
                  器灵试炼（每日3次，获取奖励+排行榜积分）
                </button>
              </div>
            </div>
          </template>
        </div>

        <!-- ===== Tab 2: 唤醒器灵 ===== -->
        <div v-if="activeTab === 'awaken'" class="space-y-3">
          <div class="bg-surface-hover border border-line rounded-panel p-4">
            <div class="text-sm font-bold text-state-info mb-3 font-display">唤醒器灵</div>
            <div class="text-xs text-fg-secondary space-y-1 mb-4">
              <div>· 唤醒条件：筑基期以上 + 法宝已装备 + 消耗 50000 灵石 + 5 个魂石</div>
              <div>· 唤醒成功率：基础 80% + 每级祭炼加成 2%（最高 98%）</div>
              <div>· 唤醒失败消耗资源不返还，请谨慎选择</div>
            </div>

            <!-- 法宝选择 -->
            <div class="mb-3">
              <label class="text-xs text-fg-secondary mb-1 block">选择已装备的法宝</label>
              <div v-if="availableEquipments.length === 0" class="text-xs text-state-danger">
                暂无可用装备（需先在装备面板穿戴法宝）
              </div>
              <div v-else class="grid grid-cols-2 md:grid-cols-3 gap-2">
                <button v-for="eq in availableEquipments" :key="eq.record_id"
                  @click="selectedEquipmentId = eq.record_id"
                  :class="selectedEquipmentId === eq.record_id
                    ? 'bg-surface-tint-arcane border-state-info text-state-info'
                    : 'bg-surface-sunken border-line text-fg-secondary hover:border-line-strong'"
                  class="border rounded-control p-2 text-xs text-left transition-colors">
                  <div class="font-bold">{{ eq.name }}</div>
                  <div class="text-[10px] text-fg-muted">{{ eq.slot_name }} · 祭炼<span class="num">{{ eq.refine_level }}</span>级</div>
                </button>
              </div>
            </div>

            <!-- 器灵类型选择 -->
            <div class="mb-3">
              <label class="text-xs text-fg-secondary mb-1 block">选择器灵类型</label>
              <div class="grid grid-cols-2 gap-2">
                <button v-for="opt in spiritTypeOptions" :key="opt.value"
                  @click="selectedSpiritType = opt.value"
                  :class="selectedSpiritType === opt.value
                    ? opt.activeClass
                    : 'bg-surface-sunken border-line text-fg-secondary hover:border-line-strong'"
                  class="border rounded-control p-2 text-xs text-left transition-colors">
                  <div class="font-bold" :class="opt.textClass">{{ opt.label }}</div>
                  <div class="text-[10px] text-fg-muted">{{ opt.desc }}</div>
                </button>
              </div>
            </div>

            <!-- 器灵命名 -->
            <div class="mb-3">
              <label class="text-xs text-fg-secondary mb-1 block">器灵命名（可选，最长50字符）</label>
              <input v-model="spiritNameInput" maxlength="50" placeholder="为器灵赐名..."
                class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-state-info focus:outline-none focus-ring" />
            </div>

            <!-- 唤醒按钮 -->
            <AppButton
              block
              variant="primary"
              :loading="loading.action"
              :disabled="!selectedEquipmentId || !selectedSpiritType"
              @click="handleAwaken"
            >
              {{ loading.action ? '唤醒中…' : '唤醒器灵（消耗 50000 灵石 + 5 魂石）' }}
            </AppButton>
          </div>
        </div>

        <!-- ===== Tab 3: 试炼榜 ===== -->
        <div v-if="activeTab === 'ranking'" class="space-y-3">
          <div class="bg-surface-tint-arcane border border-state-info/40 rounded-panel p-3 flex items-center justify-between">
            <div>
              <span class="text-xs text-fg-secondary">我的排名</span>
              <span class="text-lg font-bold text-state-info ml-2 num">{{ rankingData?.my_rank || '未上榜' }}</span>
            </div>
            <div v-if="rankingData?.my_spirit">
              <span class="text-xs text-fg-secondary">累计试炼分</span>
              <span
                class="text-lg font-bold text-gold-400 ml-2 num"
                :title="String(rankingData.my_spirit.trial_total_score)"
              >{{ formatCompact(rankingData.my_spirit.trial_total_score) }}</span>
            </div>
          </div>

          <LoadingBlock v-if="loading.ranking" text="加载试炼榜中…" />
          <EmptyState v-else-if="!rankingData || rankingData.ranking.length === 0" text="暂无试炼记录，快去试炼吧！" />
          <template v-else>
            <div v-for="entry in rankingData.ranking" :key="entry.spirit_id"
              class="bg-surface-hover border rounded-panel p-2 flex items-center justify-between"
              :class="entry.is_self ? 'border-state-info' : 'border-line'">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-sm font-bold w-8 text-center num"
                  :class="getRankBadgeClass(entry.rank)">{{ entry.rank }}</span>
                <div class="min-w-0">
                  <div class="text-xs font-bold truncate" :class="entry.is_self ? 'text-state-info' : 'text-fg-primary'">
                    {{ entry.player_name }}{{ entry.is_self ? '（我）' : '' }}
                  </div>
                  <div class="text-[10px] text-fg-muted">
                    {{ entry.spirit_type_name }} · {{ entry.spirit_name || '未命名' }} · Lv.<span class="num">{{ entry.spirit_level }}</span>
                  </div>
                </div>
              </div>
              <div class="text-right shrink-0">
                <div class="text-xs text-gold-400 font-bold num" :title="String(entry.trial_total_score)">{{ formatCompact(entry.trial_total_score) }}</div>
                <div class="text-[10px] text-fg-muted num">最高 {{ formatCompact(entry.trial_best_score) }}</div>
              </div>
            </div>

            <!-- 分页 -->
            <div v-if="rankingData && rankingData.total > rankingData.page_size" class="flex items-center justify-center gap-2 pt-2">
              <AppButton size="xs" variant="default" :disabled="rankingData.page <= 1" @click="loadRanking(rankingData.page - 1)">
                上一页
              </AppButton>
              <span class="text-xs text-fg-secondary num">{{ rankingData.page }} / {{ Math.ceil(rankingData.total / rankingData.page_size) }}</span>
              <AppButton size="xs" variant="default" :disabled="rankingData.page >= Math.ceil(rankingData.total / rankingData.page_size)" @click="loadRanking(rankingData.page + 1)">
                下一页
              </AppButton>
            </div>
          </template>
        </div>

        <!-- ===== Tab 4: 器灵图鉴 ===== -->
        <div v-if="activeTab === 'guide'" class="space-y-3">
          <div class="text-xs text-fg-secondary mb-2">
            器灵共 {{ spiritTypeOptions.length }} 种类型（清单与文案取自内容 artifact_spirit_data），
            每种类型提供不同的战斗加成和护主/催发效果，请根据法宝定位选择。
          </div>
          <div v-for="opt in spiritTypeOptions" :key="opt.value"
            class="bg-surface-hover border rounded-panel p-3"
            :class="opt.borderClass">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-[15px] font-bold font-display" :class="opt.textClass">{{ opt.label }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded" :class="opt.badgeClass">{{ opt.value }}</span>
            </div>
            <div class="text-xs text-fg-secondary space-y-1">
              <div>· {{ opt.desc }}</div>
              <div>· 基础加成：{{ opt.baseBonus }}</div>
              <div>· 护主效果：{{ opt.protectEffect }}</div>
              <div>· 催发效果：{{ opt.activateEffect }}</div>
            </div>
          </div>

          <div class="bg-surface-sunken border border-line rounded-panel p-3 mt-3">
            <div class="text-xs font-bold text-gold-400 mb-2">养成路径</div>
            <div class="text-[11px] text-fg-secondary space-y-1">
              <div>1. <span class="text-state-info">唤醒器灵</span>：在已装备法宝上消耗资源唤醒</div>
              <div>2. <span class="text-pink-300">抚摸法宝</span>：CD 1小时，增加亲密度+经验</div>
              <div>3. <span class="text-state-info">温养器灵</span>：CD 2小时，消耗灵石增加力量值</div>
              <div>4. <span class="text-state-arcane">器灵试炼</span>：每日3次，获取经验/灵石/力量值奖励 + 排行榜积分</div>
              <div>5. <span class="text-state-success">器灵护主</span>：CD 30分钟，消耗亲密度，限时减伤/反弹/回血</div>
              <div>6. <span class="text-gold-400">催发器灵</span>：CD 1小时，消耗力量值，限时属性爆发</div>
              <div>7. 器灵等级满 10 级后经验转化为力量值溢出</div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- 器灵详情弹窗：外壳统一走 Modal（遮罩、层级、出入场动画、滚动区不再各写一份） -->
    <Modal :is-open="detailModal.show" title="器灵详情" width="448px" @close="detailModal.show = false">
      <div v-if="detailModal.data" class="space-y-2 text-xs">
        <div class="grid grid-cols-2 gap-2">
          <div><span class="text-fg-muted">类型：</span><span :class="getSpiritTypeTextClass(detailModal.data.spirit_type)">{{ detailModal.data.spirit_type_name }}</span></div>
          <div><span class="text-fg-muted">等级：</span><span class="text-state-info num">Lv.{{ detailModal.data.spirit_level }} / {{ detailModal.data.max_level }}</span></div>
          <div><span class="text-fg-muted">经验：</span><span class="text-state-info num">{{ detailModal.data.spirit_exp }} / {{ detailModal.data.next_level_exp }}</span></div>
          <div><span class="text-fg-muted">亲密度：</span><span class="text-pink-300 num">{{ detailModal.data.intimacy }} / {{ detailModal.data.intimacy_max }}</span></div>
          <div><span class="text-fg-muted">力量值：</span><span class="text-state-success num">{{ detailModal.data.power }} / {{ detailModal.data.power_max }}</span></div>
          <div><span class="text-fg-muted">试炼最高：</span><span class="text-gold-400 num" :title="String(detailModal.data.trial_best_score)">{{ formatCompact(detailModal.data.trial_best_score) }}</span></div>
          <div><span class="text-fg-muted">今日试炼：</span><span class="text-state-arcane num">{{ detailModal.data.daily_trial_count }} / {{ detailModal.data.daily_trial_limit }}</span></div>
          <div><span class="text-fg-muted">累计试炼：</span><span class="text-fg-secondary num">{{ detailModal.data.trial_total_count }} 次</span></div>
        </div>
        <div class="border-t border-line pt-2 mt-2">
          <div class="text-fg-muted mb-1">冷却时间（秒）：</div>
          <div class="grid grid-cols-2 gap-2 num">
            <div>抚摸：{{ detailModal.data.cooldowns.pet }}s</div>
            <div>温养：{{ detailModal.data.cooldowns.nurture }}s</div>
            <div>护主：{{ detailModal.data.cooldowns.protect }}s</div>
            <div>催发：{{ detailModal.data.cooldowns.activate }}s</div>
          </div>
        </div>
        <div v-if="detailModal.data.is_protecting || detailModal.data.is_activating" class="border-t border-line pt-2 mt-2">
          <div v-if="detailModal.data.is_protecting" class="text-state-success">· 护主状态中，至 {{ formatTime(detailModal.data.protect_active_until) }}</div>
          <div v-if="detailModal.data.is_activating" class="text-gold-400">· 催发状态中，至 {{ formatTime(detailModal.data.activate_active_until) }}</div>
        </div>
      </div>
    </Modal>

    <!-- 操作结果弹窗 -->
    <Modal :is-open="resultModal.show" :title="resultModal.title" width="448px" @close="resultModal.show = false">
      <div class="text-sm text-fg-secondary whitespace-pre-line wrap-cjk">{{ resultModal.message }}</div>
      <AppButton block variant="primary" class="mt-4" @click="resultModal.show = false">确认</AppButton>
    </Modal>

    <!-- 二次确认弹窗 -->
    <Modal :is-open="confirmModal.show" :title="confirmModal.title" width="448px" @close="confirmModal.show = false">
      <div class="text-sm text-fg-secondary mb-4 whitespace-pre-line wrap-cjk">{{ confirmModal.message }}</div>
      <div class="grid grid-cols-2 gap-2">
        <AppButton variant="default" @click="confirmModal.show = false">取消</AppButton>
        <AppButton variant="primary" @click="confirmModal.confirm">确认</AppButton>
      </div>
    </Modal>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 器灵面板组件逻辑
 * 4 Tab 设计：我的器灵 / 唤醒器灵 / 试炼榜 / 器灵图鉴
 * 所有业务逻辑在后端，前端仅做展示与接口调用
 */
import { ref, computed, onMounted, reactive } from 'vue';
import { formatBeijing } from '../../utils/time';
import PanelShell from '../ui/PanelShell.vue';
import Modal from '../common/Modal.vue';
import Tabs from '../ui/Tabs.vue';
import AppButton from '../ui/AppButton.vue';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
import { formatCompact } from '../../utils/format';
import {
  getMySpirits,
  getSpiritDetail,
  awakenSpirit,
  trialSpirit,
  protectSpirit,
  activateSpirit,
  petSpirit,
  nurtureSpirit,
  getTrialRanking,
  type MySpiritEntry,
  type SpiritDetail,
  type SpiritType,
  type SpiritTypeCatalogEntry,
  type TrialRankingResult
} from '../../api/artifactSpirit';
import { getEquipped } from '../../api/equipment';

/** Tab 定义（key/label 契约见 ui/Tabs.vue） */
const tabs = [
  { key: 'my', label: '我的器灵' },
  { key: 'awaken', label: '唤醒器灵' },
  { key: 'ranking', label: '试炼榜' },
  { key: 'guide', label: '器灵图鉴' }
] as const;

/** 当前激活 Tab */
const activeTab = ref<'my' | 'awaken' | 'ranking' | 'guide'>('my');

/** 加载状态 */
const loading = reactive({
  my: false,
  ranking: false,
  action: false
});

/** 我的器灵列表 */
const mySpirits = ref<MySpiritEntry[]>([]);

/** 可用装备列表（用于唤醒） */
const availableEquipments = ref<any[]>([]);

/** 选中的装备ID */
const selectedEquipmentId = ref<number | null>(null);

/** 选中的器灵类型 */
const selectedSpiritType = ref<SpiritType | null>(null);

/** 器灵名称输入 */
const spiritNameInput = ref('');

/** 试炼榜数据 */
const rankingData = ref<TrialRankingResult | null>(null);

/**
 * 器灵类型清单：来自 GET /artifact-spirit/list 的 spirit_types（内容是 artifact_spirit_data）。
 * 这里以前抄了一份 4 档类型，连"攻击 +5%（每级 +2%）""反弹 20% 伤害"都是手打的字符串——
 * 内容改数值界面不会跟着变，而且那份平灵型文案漏了"暴击 +1%"。
 * 前端只留配色：按顺序取色板，资料片加一档也有颜色。
 */
const SPIRIT_TYPE_PALETTE = [
  { textClass: 'text-rose-300', borderClass: 'border-rose-800/40', badgeClass: 'bg-rose-950/60 text-rose-300 border border-rose-800', activeClass: 'bg-rose-950/60 border-rose-600 text-rose-300' },
  { textClass: 'text-blue-300', borderClass: 'border-blue-800/40', badgeClass: 'bg-blue-950/60 text-blue-300 border border-blue-800', activeClass: 'bg-blue-950/60 border-blue-600 text-blue-300' },
  { textClass: 'text-purple-300', borderClass: 'border-purple-800/40', badgeClass: 'bg-purple-950/60 text-purple-300 border border-purple-800', activeClass: 'bg-purple-950/60 border-purple-600 text-purple-300' },
  { textClass: 'text-amber-300', borderClass: 'border-amber-800/40', badgeClass: 'bg-amber-950/60 text-amber-300 border border-amber-800', activeClass: 'bg-amber-950/60 border-amber-600 text-amber-300' },
  { textClass: 'text-teal-300', borderClass: 'border-teal-800/40', badgeClass: 'bg-teal-950/60 text-teal-300 border border-teal-800', activeClass: 'bg-teal-950/60 border-teal-600 text-teal-300' }
];

/** 服务端给的器灵类型清单（loadMySpirits 时填） */
const spiritTypeCatalog = ref<SpiritTypeCatalogEntry[]>([]);

/** 类型选项：内容清单 + 前端配色 */
const spiritTypeOptions = computed(() => spiritTypeCatalog.value.map((t, i) => ({
  value: t.key,
  label: t.name,
  desc: t.desc,
  baseBonus: t.bonus_text,
  protectEffect: t.protect_text,
  activateEffect: t.activate_text,
  ...SPIRIT_TYPE_PALETTE[i % SPIRIT_TYPE_PALETTE.length]
})));

/** 详情弹窗 */
const detailModal = reactive({
  show: false,
  data: null as SpiritDetail | null
});

/** 结果弹窗 */
const resultModal = reactive({
  show: false,
  success: true,
  title: '',
  message: ''
});

/** 二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '',
  message: '',
  confirm: () => {}
});

/**
 * 切换 Tab
 * @param tabId ui/Tabs.vue 回调的 key
 */
function switchTab(tabId) {
  activeTab.value = tabId;
  if (tabId === 'my') loadMySpirits();
  else if (tabId === 'awaken') loadEquipments();
  else if (tabId === 'ranking') loadRanking(1);
}

/**
 * 加载我的器灵列表
 */
async function loadMySpirits() {
  loading.my = true;
  try {
    const res = await getMySpirits();
    if (res.code === 200 && res.data) {
      mySpirits.value = res.data.spirits || [];
      spiritTypeCatalog.value = res.data.spirit_types || [];
    }
  } catch (e) {
    console.error('加载器灵列表失败', e);
  } finally {
    loading.my = false;
  }
}

/**
 * 加载已装备列表（用于唤醒器灵选择）
 */
async function loadEquipments() {
  try {
    const res = await getEquipped();
    // equipment.ts 的 getEquipped 直接返回 axios response，后端响应在 res.data 中
    const payload = (res as any)?.data || res;
    if (payload.code === 200 && payload.data) {
      // 仅显示耐久>0的装备
      const slots = payload.data.slots || {};
      availableEquipments.value = Object.values(slots).filter((eq: any) => !eq.is_broken);
    }
  } catch (e) {
    console.error('加载装备列表失败', e);
  }
}

/**
 * 加载试炼榜
 */
async function loadRanking(page: number) {
  loading.ranking = true;
  try {
    const res = await getTrialRanking(page, 20);
    if (res.code === 200 && res.data) {
      rankingData.value = res.data;
    }
  } catch (e) {
    console.error('加载试炼榜失败', e);
  } finally {
    loading.ranking = false;
  }
}

/**
 * 处理器灵操作（统一入口）
 * @param spirit 器灵对象
 * @param action 操作类型
 */
function handleAction(spirit: MySpiritEntry, action: 'detail' | 'pet' | 'nurture' | 'protect' | 'activate' | 'trial') {
  if (action === 'detail') {
    openDetailModal(spirit.spirit_id);
    return;
  }

  // 危险操作二次确认
  const actionLabels: Record<string, { title: string; message: string }> = {
    pet: { title: '抚摸法宝', message: `抚摸 ${spirit.spirit_name || spirit.spirit_type_name}？\n增加亲密度+经验（CD 1小时）` },
    nurture: { title: '温养器灵', message: `温养 ${spirit.spirit_name || spirit.spirit_type_name}？\n消耗 1000 灵石增加力量值（CD 2小时）` },
    protect: { title: '器灵护主', message: `开启 ${spirit.spirit_name || spirit.spirit_type_name} 护主？\n消耗 5 亲密度，持续 5 分钟（CD 30分钟）` },
    activate: { title: '催发器灵', message: `催发 ${spirit.spirit_name || spirit.spirit_type_name}？\n消耗 50 力量值，持续 3 分钟属性爆发（CD 1小时）` },
    trial: { title: '器灵试炼', message: `让 ${spirit.spirit_name || spirit.spirit_type_name} 参加试炼？\n每日 3 次，按战力评分获取奖励` }
  };

  const config = actionLabels[action];
  confirmModal.title = config.title;
  confirmModal.message = config.message;
  confirmModal.confirm = () => {
    confirmModal.show = false;
    executeAction(spirit.spirit_id, action);
  };
  confirmModal.show = true;
}

/**
 * 执行操作（实际调用接口）
 */
async function executeAction(spiritId: number, action: 'pet' | 'nurture' | 'protect' | 'activate' | 'trial') {
  loading.action = true;
  try {
    let res;
    let title = '';
    let message = '';

    switch (action) {
      case 'pet':
        res = await petSpirit(spiritId);
        title = '抚摸完成';
        if (res.data) {
          message = `亲密度 +${res.data.intimacy_gain}（${res.data.intimacy}/${res.data.intimacy_max}）\n经验 +${res.data.exp_gain}`;
          if (res.data.leveled_up) message += `\n🎉 器灵升级至 Lv.${res.data.spirit_level}！`;
        }
        break;
      case 'nurture':
        res = await nurtureSpirit(spiritId);
        title = '温养完成';
        if (res.data) {
          message = `力量值 +${res.data.power_gain}（${res.data.power}/${res.data.power_max}）\n消耗灵石 ${res.data.spirit_stones_cost}`;
        }
        break;
      case 'protect':
        res = await protectSpirit(spiritId);
        title = '护主开启';
        if (res.data) {
          message = `护主状态已开启，持续 ${res.data.duration_seconds} 秒\n消耗亲密度 ${res.data.intimacy_cost}（剩余 ${res.data.intimacy_remaining}）`;
        }
        break;
      case 'activate':
        res = await activateSpirit(spiritId);
        title = '催发开启';
        if (res.data) {
          message = `催发状态已开启，持续 ${res.data.duration_seconds} 秒\n消耗力量值 ${res.data.power_cost}（剩余 ${res.data.power_remaining}）\n属性倍率 ${res.data.bonus_multiplier}x`;
        }
        break;
      case 'trial':
        res = await trialSpirit(spiritId);
        title = '试炼完成';
        if (res.data) {
          message = `本次分数：${res.data.score}${res.data.is_best_score ? ' 🎉 新纪录！' : ''}\n奖励：经验+${res.data.rewards.exp} / 灵石+${res.data.rewards.spirit_stones} / 力量+${res.data.rewards.power_gain}`;
          if (res.data.leveled_up) message += `\n🎉 器灵升级至 Lv.${res.data.spirit_level}！`;
          message += `\n今日试炼：${res.data.daily_trial_count}/${res.data.daily_trial_limit}`;
        }
        break;
    }

    resultModal.show = true;
    resultModal.success = !!(res && (res as any).data);
    resultModal.title = title;
    resultModal.message = message || (res as any)?.message || '操作完成';

    // 刷新器灵列表
    await loadMySpirits();
  } catch (e: any) {
    resultModal.show = true;
    resultModal.success = false;
    resultModal.title = '操作失败';
    resultModal.message = e?.response?.data?.message || e.message || '未知错误';
  } finally {
    loading.action = false;
  }
}

/**
 * 打开详情弹窗
 */
async function openDetailModal(spiritId: number) {
  try {
    const res = await getSpiritDetail(spiritId);
    if (res.code === 200 && res.data) {
      detailModal.data = res.data;
      detailModal.show = true;
    }
  } catch (e) {
    console.error('获取器灵详情失败', e);
  }
}

/**
 * 处理唤醒器灵
 */
async function handleAwaken() {
  if (!selectedEquipmentId.value || !selectedSpiritType.value) return;

  confirmModal.title = '唤醒器灵';
  confirmModal.message = `确认唤醒器灵？\n类型：${spiritTypeOptions.value.find(o => o.value === selectedSpiritType.value)?.label}\n消耗：50000 灵石 + 5 魂石\n成功率：80% + 祭炼加成（失败不返还资源）`;
  confirmModal.confirm = async () => {
    confirmModal.show = false;
    loading.action = true;
    try {
      const res = await awakenSpirit({
        equipment_id: selectedEquipmentId.value!,
        spirit_type: selectedSpiritType.value!,
        spirit_name: spiritNameInput.value.trim() || undefined
      });
      resultModal.show = true;
      resultModal.success = !!(res && (res as any).data);
      resultModal.title = res.data ? '唤醒成功' : '唤醒失败';
      if (res.data) {
        resultModal.message = `器灵类型：${spiritTypeOptions.value.find(o => o.value === res.data?.spirit_type)?.label}\n亲密度：${res.data.intimacy}\n力量值：${res.data.power}\n成功率：${(res.data.success_rate * 100).toFixed(1)}%`;
        // 重置选择
        selectedEquipmentId.value = null;
        selectedSpiritType.value = null;
        spiritNameInput.value = '';
        // 切换到我的器灵
        await loadMySpirits();
        activeTab.value = 'my';
      } else {
        resultModal.message = (res as any)?.message || '唤醒失败，资源已消耗';
      }
    } catch (e: any) {
      resultModal.show = true;
      resultModal.success = false;
      resultModal.title = '唤醒失败';
      resultModal.message = e?.response?.data?.message || e.message || '未知错误';
    } finally {
      loading.action = false;
    }
  };
  confirmModal.show = true;
}

/**
 * 获取器灵类型对应的边框样式
 */
function getSpiritTypeBorderClass(type: SpiritType): string {
  return spiritTypeOptions.value.find(o => o.value === type)?.borderClass || 'border-line';
}

/**
 * 获取器灵类型对应的文字样式
 */
function getSpiritTypeTextClass(type: SpiritType): string {
  return spiritTypeOptions.value.find(o => o.value === type)?.textClass || 'text-fg-secondary';
}

/**
 * 获取器灵类型对应的徽章样式
 */
function getSpiritTypeBadgeClass(type: SpiritType): string {
  return spiritTypeOptions.value.find(o => o.value === type)?.badgeClass || 'bg-surface-active text-fg-secondary';
}

/**
 * 获取排名徽章样式
 */
function getRankBadgeClass(rank: number): string {
  if (rank === 1) return 'text-gold-400';
  if (rank === 2) return 'text-fg-secondary';
  if (rank === 3) return 'text-gold-600';
  return 'text-fg-muted';
}

/**
 * 格式化时间
 */
function formatTime(dateStr: string | null): string {
  // 统一按北京时间展示（固定 UTC+8，仅时分秒）
  return formatBeijing(dateStr, { showDate: false, fallback: '无' });
}

// 组件挂载时加载我的器灵
onMounted(() => {
  loadMySpirits();
});
</script>
