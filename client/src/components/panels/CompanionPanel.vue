/**
 * 道侣面板组件
 *
 * 批次3 道侣 / 双修 / 心契 / 心劫 子模块前端 UI
 *
 * Tab 划分：
 *   1. 道侣关系：当前道侣状态、寻找道侣、接受邀请、解除道侣
 *   2. 双修互动：闭关双修 / 温养 / 采补 / 立誓（3 种类型）
 *   3. 心契：心契等级、经验、5 级加成说明
 *   4. 心劫：待处理心劫事件列表、3 选项抉择
 *
 * 设计原则：
 *   - 所有状态从后端 GET /companion/profile 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格与 SmallWorldPanel.vue 一致（修仙古风：#1c1917 / #292524 / amber-300 / rose-300）
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS（除淡入动画）
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-rose-900/40 rounded-lg p-6 max-w-5xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-rose-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          道侣 · 双修心契
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
          :class="activeTab === tab.id ? 'text-rose-300' : 'text-stone-500 hover:text-stone-300'">
          {{ tab.name }}
          <div v-if="activeTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-rose-400"></div>
        </button>
      </div>

      <!-- 加载中状态 -->
      <div v-if="loading.profile && !profile" class="flex-1 flex items-center justify-center">
        <div class="text-stone-500 text-sm">正在凝神查阅道侣录...</div>
      </div>

      <!-- 内容滚动区 -->
      <div v-else class="flex-1 overflow-y-auto pr-1">

        <!-- ============ Tab 1: 道侣关系 ============ -->
        <div v-show="activeTab === 'relation'" class="space-y-3">
          <!-- 无道侣 -->
          <section v-if="!profile?.has_companion" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="text-sm font-bold text-rose-300 mb-3">寻觅道侣</div>
            <div class="text-xs text-stone-400 space-y-1 mb-4">
              <div>· 道侣同行，双修互补，可立誓护道、共修、守秘</div>
              <div>· 心契加深至 5 级可触发心劫，抉择之间见真性情</div>
              <div>· 输入对方玩家 ID 发起道侣邀请，待对方同意后即可结侣</div>
            </div>
            <!-- 寻找道侣输入框 -->
            <div class="flex items-center gap-2">
              <input v-model.number="seekTargetId" type="number" min="1" placeholder="对方玩家 ID（数字）"
                class="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-rose-500 focus:outline-none" />
              <button @click="handleSeek"
                :disabled="loading.action || !seekTargetId"
                class="px-4 py-2 rounded text-xs font-bold bg-rose-700 text-rose-100 hover:bg-rose-600 disabled:opacity-50">
                发起邀请
              </button>
            </div>

            <!-- 待处理邀请列表 -->
            <div v-if="profile?.pending_invitations.length" class="mt-4">
              <div class="text-xs text-amber-300 font-bold mb-2">待您回应的道侣邀请</div>
              <div class="space-y-2">
                <div v-for="inv in profile.pending_invitations" :key="inv.companion_id"
                  class="bg-stone-900/50 border border-stone-700 rounded p-3 text-xs flex items-center justify-between">
                  <div>
                    <div class="text-rose-300 font-bold">{{ inv.from_player_name }}</div>
                    <div class="text-stone-500 text-[11px]">
                      ID: {{ inv.from_player_id }} · 境界：{{ inv.from_player_realm }} · 邀请时间：{{ formatTime(inv.created_at) }}
                    </div>
                  </div>
                  <button @click="handleAccept(inv.companion_id)"
                    :disabled="loading.action"
                    class="px-3 py-1.5 rounded bg-emerald-700 text-emerald-100 hover:bg-emerald-600 disabled:opacity-50">
                    同意结侣
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- 已有道侣 -->
          <section v-else class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-rose-300">道侣信息</div>
              <div class="text-[10px] px-2 py-0.5 rounded bg-rose-950/60 text-rose-300 border border-rose-800">
                已结侣
              </div>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <div class="text-stone-500">对方道号</div>
                <div class="text-rose-300 font-bold">{{ profile?.companion_name }}</div>
              </div>
              <div>
                <div class="text-stone-500">对方境界</div>
                <div class="text-amber-300 font-bold">{{ profile?.companion_realm }}</div>
              </div>
              <div>
                <div class="text-stone-500">亲密度</div>
                <div class="text-pink-300 font-bold">{{ companion?.intimacy ?? 0 }} / 100</div>
              </div>
              <div>
                <div class="text-stone-500">心契等级</div>
                <div class="text-purple-300 font-bold">Lv.{{ companion?.heart_contract_level ?? 0 }}</div>
              </div>
            </div>

            <!-- 亲密度进度条 -->
            <div class="mt-3">
              <div class="h-1.5 bg-stone-800 rounded-full overflow-hidden">
                <div class="h-full bg-gradient-to-r from-rose-600 to-pink-400 transition-all"
                  :style="{ width: `${companion?.intimacy ?? 0}%` }"></div>
              </div>
            </div>

            <!-- 双修次数统计 -->
            <div class="mt-3 grid grid-cols-3 gap-2 text-[11px]">
              <div class="bg-stone-900/50 rounded p-2 text-center">
                <div class="text-stone-500">双修今日</div>
                <div class="text-amber-300 font-bold">{{ companion?.dual_cultivate_count ?? 0 }} / {{ companion?.dual_cultivate_limit ?? 3 }}</div>
              </div>
              <div class="bg-stone-900/50 rounded p-2 text-center">
                <div class="text-stone-500">温养今日</div>
                <div class="text-cyan-300 font-bold">{{ companion?.warm_nourish_count ?? 0 }} / {{ companion?.warm_nourish_limit ?? 2 }}</div>
              </div>
              <div class="bg-stone-900/50 rounded p-2 text-center">
                <div class="text-stone-500">采补今日</div>
                <div class="text-rose-300 font-bold">{{ companion?.pluck_supplement_count ?? 0 }} / {{ companion?.pluck_supplement_limit ?? 1 }}</div>
              </div>
            </div>

            <!-- 已立誓 -->
            <div v-if="companion?.vows && companion.vows.length" class="mt-3">
              <div class="text-[11px] text-stone-500 mb-1">已立誓言：</div>
              <div class="flex flex-wrap gap-1">
                <span v-for="vow in companion.vows" :key="vow"
                  class="px-2 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800 text-[11px]">
                  {{ getVowLabel(vow) }}
                </span>
              </div>
            </div>

            <!-- 解除道侣 -->
            <div class="mt-4 grid grid-cols-2 gap-2">
              <button @click="handleBreak('agreement')"
                :disabled="loading.action"
                class="py-2 rounded text-xs font-bold bg-stone-800 border border-stone-600 text-stone-300 hover:bg-stone-700 disabled:opacity-50">
                和离（双方同意）
              </button>
              <button @click="handleBreak('vow_break')"
                :disabled="loading.action"
                class="py-2 rounded text-xs font-bold bg-rose-950/40 border border-rose-800 text-rose-300 hover:bg-rose-900/40 disabled:opacity-50">
                毁誓解除（残魂损耗）
              </button>
            </div>
          </section>
        </div>

        <!-- ============ Tab 2: 双修互动 ============ -->
        <div v-show="activeTab === 'dual_cultivate'" class="space-y-3">
          <section v-if="!profile?.has_companion" class="bg-[#292524] border border-stone-700 rounded-lg p-4 text-center">
            <div class="text-stone-500 text-sm">尚未结侣，无法双修互动</div>
            <div class="text-[11px] text-stone-500 mt-1">请先在「道侣关系」中寻得道侣</div>
          </section>
          <template v-else>
            <!-- 双修 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-2">闭关双修</div>
              <div class="text-[11px] text-stone-400 mb-3">
                · 主方修为 +5%，日上限 {{ companion?.dual_cultivate_limit ?? 3 }} 次<br>
                · 今日已用：{{ companion?.dual_cultivate_count ?? 0 }} 次
              </div>
              <button @click="handleDualCultivate"
                :disabled="loading.action || (companion?.dual_cultivate_count ?? 0) >= (companion?.dual_cultivate_limit ?? 3)"
                class="w-full py-2 rounded text-xs font-bold bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
                {{ (companion?.dual_cultivate_count ?? 0) >= (companion?.dual_cultivate_limit ?? 3) ? '今日次数已满' : '开始双修' }}
              </button>
            </section>

            <!-- 温养 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-cyan-300 mb-2">温养</div>
              <div class="text-[11px] text-stone-400 mb-3">
                · 双方修为 +3%，日上限 {{ companion?.warm_nourish_limit ?? 2 }} 次<br>
                · 今日已用：{{ companion?.warm_nourish_count ?? 0 }} 次
              </div>
              <button @click="handleWarmNourish"
                :disabled="loading.action || (companion?.warm_nourish_count ?? 0) >= (companion?.warm_nourish_limit ?? 2)"
                class="w-full py-2 rounded text-xs font-bold bg-cyan-700 text-cyan-100 hover:bg-cyan-600 disabled:opacity-50">
                {{ (companion?.warm_nourish_count ?? 0) >= (companion?.warm_nourish_limit ?? 2) ? '今日次数已满' : '开始温养' }}
              </button>
            </section>

            <!-- 采补 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-rose-300 mb-2">采补</div>
              <div class="text-[11px] text-stone-400 mb-3">
                · 主方 +10%，副方 -3%，日上限 {{ companion?.pluck_supplement_limit ?? 1 }} 次<br>
                · 今日已用：{{ companion?.pluck_supplement_count ?? 0 }} 次<br>
                · <span class="text-rose-400">高风险操作：将损耗对方修为，请谨慎抉择</span>
              </div>
              <button @click="handlePluckSupplement"
                :disabled="loading.action || (companion?.pluck_supplement_count ?? 0) >= (companion?.pluck_supplement_limit ?? 1)"
                class="w-full py-2 rounded text-xs font-bold bg-rose-700 text-rose-100 hover:bg-rose-600 disabled:opacity-50">
                {{ (companion?.pluck_supplement_count ?? 0) >= (companion?.pluck_supplement_limit ?? 1) ? '今日次数已满' : '采补修行' }}
              </button>
            </section>

            <!-- 立誓 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-2">立誓</div>
              <div class="text-[11px] text-stone-400 mb-3">
                · 三种誓言，每种只能立一次，立后不可撤销<br>
                · 已立誓：{{ companion?.vows?.length ? companion.vows.map(getVowLabel).join('、') : '无' }}
              </div>
              <div class="grid grid-cols-3 gap-2">
                <button v-for="vow in vowTypes" :key="vow.value"
                  @click="handleVow(vow.value)"
                  :disabled="loading.action || isVowActivated(vow.value)"
                  :class="[
                    'py-2 rounded text-xs font-bold border disabled:opacity-50',
                    isVowActivated(vow.value)
                      ? 'bg-purple-950/40 border-purple-800 text-purple-300 cursor-not-allowed'
                      : 'bg-purple-700 text-purple-100 hover:bg-purple-600 border-purple-500'
                  ]">
                  {{ isVowActivated(vow.value) ? '已立' : vow.label }}
                </button>
              </div>
              <div class="mt-2 text-[11px] text-stone-500 space-y-1">
                <div>· 护道：道侣受袭时，主方可代为承受部分伤害</div>
                <div>· 守秘：双方身份与秘密互不外泄，提升心契经验获取</div>
                <div>· 共修：双修效果额外 +20%</div>
              </div>
            </section>
          </template>
        </div>

        <!-- ============ Tab 3: 心契 ============ -->
        <div v-show="activeTab === 'heart_contract'" class="space-y-3">
          <div v-if="loading.heartContract" class="text-center py-6 text-stone-500 text-sm">加载心契数据中...</div>
          <template v-else-if="heartContractData">
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-3">心契等级</div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <div class="text-stone-500">当前等级</div>
                  <div class="text-purple-300 font-bold text-lg">Lv.{{ heartContractData.heart_contract.level }}</div>
                </div>
                <div>
                  <div class="text-stone-500">当前经验</div>
                  <!-- 修复 4-3-P1-2：使用 formatNumber 处理 BigInt 字符串 -->
                  <div class="text-amber-300 font-bold">{{ formatNumber(heartContractData.heart_contract.exp) }}</div>
                </div>
                <div>
                  <div class="text-stone-500">升级所需</div>
                  <div class="text-cyan-300 font-bold">{{ heartContractData.heart_contract.exp_to_next }}</div>
                </div>
                <div>
                  <div class="text-stone-500">等级上限</div>
                  <div class="text-rose-300 font-bold">Lv.5</div>
                </div>
              </div>
              <!-- 心契经验进度条 -->
              <div class="mt-3 h-1.5 bg-stone-800 rounded-full overflow-hidden">
                <div class="h-full bg-gradient-to-r from-purple-600 to-pink-400 transition-all"
                  :style="{ width: `${heartContractExpPercent}%` }"></div>
              </div>
              <div class="text-[11px] text-stone-500 mt-1">
                · 当前加成：<span class="text-emerald-300">{{ heartContractData.heart_contract.current_bonus || '暂无' }}</span>
              </div>
              <div v-if="heartContractData.heart_contract.level < 5" class="text-[11px] text-stone-500 mt-1">
                · 下一级加成：<span class="text-cyan-300">{{ heartContractData.heart_contract.next_bonus || '已达上限' }}</span>
              </div>
            </section>

            <!-- 5 级心契加成说明 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-3">心契加成说明</div>
              <div class="space-y-2">
                <div v-for="bonus in heartContractData.heart_contract.level_bonuses" :key="bonus.level"
                  class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-purple-300 font-bold">Lv.{{ bonus.level }} · {{ bonus.name }}</span>
                    <span v-if="heartContractData.heart_contract.level >= bonus.level"
                      class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800">
                      已激活
                    </span>
                    <span v-else
                      class="text-[10px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-500 border border-stone-700">
                      未激活
                    </span>
                  </div>
                  <div class="text-stone-400 text-[11px]">{{ bonus.description }}</div>
                </div>
              </div>
            </section>

            <!-- 当前生效加成 -->
            <section v-if="heartContractData.active_bonuses.length" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-emerald-300 mb-2">当前生效加成</div>
              <ul class="text-xs text-stone-300 space-y-1">
                <li v-for="(bonus, idx) in heartContractData.active_bonuses" :key="idx" class="flex items-start gap-2">
                  <span class="text-emerald-400">·</span>
                  <span>{{ bonus }}</span>
                </li>
              </ul>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">尚未结侣，无心契数据</div>
        </div>

        <!-- ============ Tab 4: 心劫 ============ -->
        <div v-show="activeTab === 'heart_tribulation'" class="space-y-3">
          <div v-if="loading.heartTribulation" class="text-center py-6 text-stone-500 text-sm">加载心劫事件中...</div>
          <template v-else-if="heartTribulationData">
            <section v-if="!heartTribulationData.has_event" class="bg-[#292524] border border-stone-700 rounded-lg p-4 text-center">
              <div class="text-stone-500 text-sm">当前无待处理心劫</div>
              <div class="text-[11px] text-stone-500 mt-1">· 心劫由心契等级提升、亲密度变化、立誓等触发</div>
            </section>
            <section v-else class="space-y-3">
              <div v-for="event in heartTribulationData.events" :key="event.event_id"
                class="bg-[#292524] border border-rose-900/40 rounded-lg p-4">
                <div class="flex items-center justify-between mb-2">
                  <div class="text-sm font-bold text-rose-300">{{ event.title }}</div>
                  <div v-if="event.event_type"
                    class="text-[10px] px-2 py-0.5 rounded bg-rose-950/60 text-rose-300 border border-rose-800">
                    {{ event.event_type }}
                  </div>
                </div>
                <div class="text-xs text-stone-300 mb-3">{{ event.description }}</div>
                <!-- 3 个选项 -->
                <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <button v-for="opt in event.options" :key="opt.option"
                    @click="handleChooseTribulation(event.event_id, opt.option)"
                    :disabled="loading.action"
                    class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs text-left hover:bg-stone-800/60 disabled:opacity-50">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-amber-300 font-bold">{{ opt.name }}</span>
                      <span class="text-[10px] text-emerald-300">成功率 {{ (opt.success_rate * 100).toFixed(0) }}%</span>
                    </div>
                    <div class="text-stone-500 text-[11px] space-y-0.5">
                      <div>· 亲密度：{{ opt.intimacy_change >= 0 ? '+' : '' }}{{ opt.intimacy_change }}</div>
                      <div>· 残魂消耗：{{ opt.remnant_soul_cost }}</div>
                      <div v-if="opt.description">· {{ opt.description }}</div>
                    </div>
                  </button>
                </div>
              </div>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">尚未结侣，无心劫</div>
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
          class="px-4 py-2 text-xs rounded bg-rose-700 text-rose-100 hover:bg-rose-600 disabled:opacity-50">
          确认
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
/**
 * 道侣面板组件脚本
 * 使用 Composition API，所有状态从后端拉取，禁止硬编码业务数据
 */
import { ref, reactive, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import { useUIStore } from '../../stores/ui';
import {
  companionGetProfile,
  companionSeek,
  companionAccept,
  companionBreak,
  companionDualCultivate,
  companionWarmNourish,
  companionPluckSupplement,
  companionVow,
  companionGetHeartContract,
  companionGetHeartTribulation,
  companionChooseHeartTribulation,
  type CompanionProfileData,
  type HeartContractData,
  type HeartTribulationListData,
  type DaoCompanion
} from '../../api/companion';
// 修复 4-3-P1-2：引入 formatNumber 处理 BigInt 字符串显示
import { formatNumber } from '../../utils/format';

const uiStore = useUIStore();

/** Tab 配置 */
const tabs = [
  { id: 'relation', name: '道侣关系' },
  { id: 'dual_cultivate', name: '双修互动' },
  { id: 'heart_contract', name: '心契' },
  { id: 'heart_tribulation', name: '心劫' }
];
/** 当前激活 Tab */
const activeTab = ref('relation');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/** 各模块加载状态 */
const loading = reactive({
  profile: false,
  heartContract: false,
  heartTribulation: false,
  action: false
});

/** 各模块数据 */
const profile = ref<CompanionProfileData | null>(null);
const heartContractData = ref<HeartContractData | null>(null);
const heartTribulationData = ref<HeartTribulationListData | null>(null);

/** 寻找道侣输入的目标玩家 ID */
const seekTargetId = ref<number | null>(null);

/** 立誓类型选项 */
const vowTypes = [
  { value: 'protect' as const, label: '护道' },
  { value: 'secret' as const, label: '守秘' },
  { value: 'cultivate' as const, label: '共修' }
];

/** 通用二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '操作确认',
  message: '',
  onConfirm: () => {}
});

/**
 * 计算属性：当前道侣关系对象
 * 从 profile 中提取，方便模板访问
 */
const companion = computed<DaoCompanion | null>(() => profile.value?.companion ?? null);

/**
 * 计算属性：心契经验百分比
 * 用于渲染进度条
 */
const heartContractExpPercent = computed(() => {
  if (!heartContractData.value) return 0;
  const { exp, exp_to_next } = heartContractData.value.heart_contract;
  if (!exp_to_next || exp_to_next <= 0) return 100;
  return Math.min((exp / exp_to_next) * 100, 100);
});

/**
 * 组件挂载时加载首个 Tab 数据
 */
onMounted(async () => {
  await loadProfile();
  loadedTabs.add('relation');
});

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (loadedTabs.has(tabId)) return;
  if (tabId === 'heart_contract') await loadHeartContract();
  else if (tabId === 'heart_tribulation') await loadHeartTribulation();
  loadedTabs.add(tabId);
}

// ============ 数据加载函数 ============

/** 加载道侣面板数据 */
async function loadProfile() {
  loading.profile = true;
  try {
    const resp = await companionGetProfile();
    if (resp.data?.code === 200 && resp.data.data) {
      profile.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取道侣档案失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.profile = false;
  }
}

/** 加载心契面板数据 */
async function loadHeartContract() {
  loading.heartContract = true;
  try {
    const resp = await companionGetHeartContract();
    if (resp.data?.code === 200 && resp.data.data) {
      heartContractData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取心契数据失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.heartContract = false;
  }
}

/** 加载心劫事件数据 */
async function loadHeartTribulation() {
  loading.heartTribulation = true;
  try {
    const resp = await companionGetHeartTribulation();
    if (resp.data?.code === 200 && resp.data.data) {
      heartTribulationData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取心劫事件失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.heartTribulation = false;
  }
}

// ============ 操作处理函数 ============

/** 寻找道侣（发起邀请） */
async function handleSeek() {
  if (!seekTargetId.value || seekTargetId.value <= 0) {
    uiStore.showToast('请输入有效的玩家 ID', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await companionSeek(seekTargetId.value);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '邀请已发送', 'success');
      seekTargetId.value = null;
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '邀请失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 同意结侣
 * @param companionId 道侣关系记录 ID
 */
async function handleAccept(companionId: number) {
  showConfirm('同意结侣', `确认接受此道侣邀请？结侣后可双修、立誓、共修心契。`, async () => {
    loading.action = true;
    try {
      const resp = await companionAccept(companionId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '已结为道侣', 'success');
        await loadProfile();
      } else {
        uiStore.showToast(resp.data?.message || '结侣失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 解除道侣
 * @param mode 解除模式：agreement=和离 / vow_break=毁誓
 */
async function handleBreak(mode: 'agreement' | 'vow_break') {
  const title = mode === 'agreement' ? '和离解除道侣' : '毁誓解除道侣';
  const message = mode === 'agreement'
    ? '确认和离解除道侣关系？\n· 双方亲密度与心契经验会归零\n· 操作不可撤销'
    : '确认毁誓解除道侣关系？\n· 将损耗残魂与心契等级\n· 操作不可撤销，且可能触发反噬';
  showConfirm(title, message, async () => {
    loading.action = true;
    try {
      const resp = await companionBreak(mode);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '道侣关系已解除', 'success');
        // 重置已加载标记，重新加载所有 Tab
        loadedTabs.clear();
        await loadProfile();
        loadedTabs.add('relation');
      } else {
        uiStore.showToast(resp.data?.message || '解除失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/** 闭关双修 */
async function handleDualCultivate() {
  loading.action = true;
  try {
    const resp = await companionDualCultivate();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '双修完成，修为精进', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '双修失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 温养 */
async function handleWarmNourish() {
  loading.action = true;
  try {
    const resp = await companionWarmNourish();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '温养完成，双方修为精进', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '温养失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 采补（高风险操作，必须二次确认） */
async function handlePluckSupplement() {
  showConfirm('采补修行', '确认进行采补？\n· 主方修为 +10%，副方修为 -3%\n· 此举可能伤及道侣情谊，请谨慎抉择', async () => {
    loading.action = true;
    try {
      const resp = await companionPluckSupplement();
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '采补完成', 'success');
        await loadProfile();
      } else {
        uiStore.showToast(resp.data?.message || '采补失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 立誓
 * @param vowType 誓言类型
 */
async function handleVow(vowType: 'protect' | 'secret' | 'cultivate') {
  showConfirm('立誓', `确认立下「${getVowLabel(vowType)}」誓言？\n· 誓言立后不可撤销\n· 将影响心契加成与道侣互动`, async () => {
    loading.action = true;
    try {
      const resp = await companionVow(vowType);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '誓言已立', 'success');
        await loadProfile();
      } else {
        uiStore.showToast(resp.data?.message || '立誓失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 心劫抉择
 * @param eventId 心劫事件 ID
 * @param option 选项：steady/ruthless/deceive
 */
async function handleChooseTribulation(
  eventId: number,
  option: 'steady' | 'ruthless' | 'deceive'
) {
  const optionLabel = option === 'steady' ? '稳' : option === 'ruthless' ? '狠' : '骗';
  showConfirm('心劫抉择', `确认选择「${optionLabel}」应对此心劫？\n· 抉择不可更改\n· 将影响亲密度、残魂与心契经验`, async () => {
    loading.action = true;
    try {
      const resp = await companionChooseHeartTribulation(eventId, option);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '心劫抉择已生效', 'success');
        // 刷新心劫与心契
        await Promise.all([loadHeartTribulation(), loadHeartContract()]);
      } else {
        uiStore.showToast(resp.data?.message || '抉择失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
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
 * 获取誓言中文标签
 * @param vowType 誓言类型
 */
function getVowLabel(vowType: string): string {
  const map: Record<string, string> = {
    protect: '护道',
    secret: '守秘',
    cultivate: '共修'
  };
  return map[vowType] || vowType;
}

/**
 * 判断某誓言是否已立
 * @param vowType 誓言类型
 */
function isVowActivated(vowType: string): boolean {
  if (!companion.value?.vows) return false;
  return companion.value.vows.includes(vowType);
}

/**
 * 格式化时间显示（M/D HH:MM）
 * @param time ISO 时间字符串
 */
function formatTime(time: string | null | undefined): string {
  if (!time) return '-';
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>

<style scoped>
/* 局部淡入动画，与 SmallWorldPanel 保持一致 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}
</style>
