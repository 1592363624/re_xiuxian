/**
 * 第二元神面板组件
 *
 * 批次3 后期系统 - 第二元神子模块前端 UI
 *
 * 功能模块：
 *   1. 玩家基础信息栏：境界、灵石、神识、残魂、副元神数量
 *   2. 主元神 + 副元神列表：展示境界、修为、属性、调度状态、修炼进度
 *   3. 残篇收集进度：5 类残篇（妖丹/魔核/鬼玉/龙血/凤羽）收集情况
 *   4. 凝练第二元神：境界≥化神期 + 5 类残篇各 1 份 + 灵石/神识/残魂消耗
 *   5. 分化第三元神：第二元神境界≥化神期，消耗额外资源
 *   6. 调度模式切换：combat=斗法 / cultivate=独立修炼 / scout=窥探 / defend=护身（各模式独立 CD）
 *   7. 独立修炼：12 小时上限，每日 2 次
 *
 * 设计原则：
 *   - 所有状态从后端 GET /second-soul/profile 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格与 AscensionPanel.vue 一致（修仙古风：#1c1917 / #292524 / amber-300 / purple-300）
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-amber-900/40 rounded-lg p-6 max-w-4xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-amber-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3c0 1.6.8 3 2 4-1.2 1-2 2.4-2 4a3 3 0 0 0 6 0c0-1.6-.8-3-2-4 1.2-1 2-2.4 2-4a3 3 0 0 0-3-3z"/>
            <path d="M5 22h14"/><path d="M12 16v6"/>
          </svg>
          第二元神 · 元神分化
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 加载中状态 -->
      <div v-if="loading && !profile" class="flex-1 flex items-center justify-center">
        <div class="text-stone-500 text-sm">正在凝神查阅元神档案...</div>
      </div>

      <!-- 状态总览栏 -->
      <div v-if="profile" class="bg-[#292524] border border-stone-700 rounded-lg p-3 mb-3 grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
        <div>
          <div class="text-stone-500">当前境界</div>
          <div class="text-amber-300 font-bold">{{ profile.player.realm }}</div>
        </div>
        <div>
          <div class="text-stone-500">灵石</div>
          <div class="text-amber-200 font-bold">{{ formatNumber(profile.player.spirit_stones) }}</div>
        </div>
        <div>
          <div class="text-stone-500">神识</div>
          <div class="text-cyan-300 font-bold">{{ profile.player.divine_sense }}</div>
        </div>
        <div>
          <div class="text-stone-500">残魂</div>
          <div class="text-purple-300 font-bold">{{ profile.player.remnant_soul }}</div>
        </div>
        <div>
          <div class="text-stone-500">副元神数</div>
          <div class="text-pink-300 font-bold">{{ profile.player.second_soul_count }} / 2</div>
        </div>
      </div>

      <!-- 内容滚动区 -->
      <div v-if="profile" class="flex-1 overflow-y-auto pr-1 space-y-3">
        <!-- 元神列表 -->
        <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
          <div class="text-sm font-bold text-amber-300 mb-3">元神列表</div>
          <div v-if="profile.souls.length === 0" class="text-xs text-stone-500 text-center py-4">
            暂无元神记录
          </div>
          <div v-else class="space-y-3">
            <div v-for="soul in profile.souls" :key="soul.id"
              class="bg-stone-900/50 border border-stone-700 rounded p-3 text-xs">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="font-bold" :class="soul.soul_index === 1 ? 'text-amber-300' : 'text-purple-300'">
                    {{ getSoulIndexLabel(soul.soul_index) }}
                  </span>
                  <span class="text-stone-300">{{ soul.soul_name }}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-400">
                    {{ soul.soul_type }}
                  </span>
                </div>
                <div class="flex items-center gap-2 text-[10px]">
                  <span v-if="soul.is_cultivating" class="px-1.5 py-0.5 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-800">
                    修炼中
                  </span>
                  <span v-if="soul.last_dispatch_mode" class="px-1.5 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800">
                    {{ getDispatchModeLabel(soul.last_dispatch_mode) }}
                  </span>
                </div>
              </div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-stone-400">
                <div>境界：<span class="text-amber-300">{{ soul.realm }}</span></div>
                <div>修为：<span class="text-emerald-300">{{ formatNumber(soul.exp) }}</span></div>
                <div>继承率：<span class="text-purple-300">{{ (soul.inherit_ratio * 100).toFixed(0) }}%</span></div>
                <div>斗法次数：<span class="text-rose-300">{{ soul.combat_count }}</span></div>
              </div>
              <div class="grid grid-cols-5 gap-2 mt-2 text-[11px]">
                <div class="bg-stone-800/60 rounded px-2 py-1">
                  <div class="text-stone-500">攻</div>
                  <div class="text-amber-300 font-bold">{{ soul.attributes.atk ?? 0 }}</div>
                </div>
                <div class="bg-stone-800/60 rounded px-2 py-1">
                  <div class="text-stone-500">防</div>
                  <div class="text-amber-300 font-bold">{{ soul.attributes.def ?? 0 }}</div>
                </div>
                <div class="bg-stone-800/60 rounded px-2 py-1">
                  <div class="text-stone-500">血</div>
                  <div class="text-amber-300 font-bold">{{ soul.attributes.hp_max ?? 0 }}</div>
                </div>
                <div class="bg-stone-800/60 rounded px-2 py-1">
                  <div class="text-stone-500">速</div>
                  <div class="text-amber-300 font-bold">{{ soul.attributes.speed ?? 0 }}</div>
                </div>
                <div class="bg-stone-800/60 rounded px-2 py-1">
                  <div class="text-stone-500">识</div>
                  <div class="text-amber-300 font-bold">{{ soul.attributes.sense ?? 0 }}</div>
                </div>
              </div>

              <!-- 修炼进度提示 -->
              <div v-if="soul.is_cultivating && soul.cultivate_end_time" class="mt-2 text-[11px] text-cyan-300">
                · 修炼中，预计结束：{{ formatTime(soul.cultivate_end_time) }}
              </div>
              <div v-if="soul.dispatch_until" class="mt-1 text-[11px] text-purple-300">
                · 调度中，持续至：{{ formatTime(soul.dispatch_until) }}
              </div>

              <!-- 副元神操作按钮 -->
              <div v-if="soul.soul_index >= 2" class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
                <button v-for="mode in dispatchModes" :key="mode.value"
                  @click="handleDispatch(soul.soul_index as 2|3, mode.value)"
                  :disabled="loading"
                  :class="[
                    'py-1.5 text-[11px] rounded border transition-colors disabled:opacity-50',
                    soul.last_dispatch_mode === mode.value
                      ? 'bg-purple-900/60 border-purple-600 text-purple-200'
                      : 'bg-stone-900/40 border-stone-700 text-stone-300 hover:bg-stone-800/60'
                  ]">
                  {{ mode.label }}
                </button>
                <button @click="handleCultivate(soul.soul_index as 2|3)"
                  :disabled="loading || soul.is_cultivating"
                  class="py-1.5 text-[11px] rounded bg-cyan-950/40 border border-cyan-800 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-50 transition-colors col-span-2 md:col-span-1">
                  {{ soul.is_cultivating ? '修炼中' : '独立修炼' }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 残篇收集进度 -->
        <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
          <div class="text-sm font-bold text-purple-300 mb-3">元神残篇收集</div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div v-for="(frag, key) in profile.fragment_progress" :key="key"
              class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-amber-300 font-bold">{{ frag.name }}</span>
                  <span class="ml-2 text-stone-500 text-[10px]">{{ frag.source }}</span>
                </div>
                <div :class="frag.met ? 'text-emerald-300' : 'text-rose-400'">
                  {{ frag.collected }} / {{ frag.required }}
                </div>
              </div>
              <!-- 进度条 -->
              <div class="mt-1 h-1 bg-stone-800 rounded-full overflow-hidden">
                <div class="h-full transition-all duration-500"
                  :class="frag.met ? 'bg-emerald-400' : 'bg-amber-500'"
                  :style="{ width: `${Math.min((frag.collected / frag.required) * 100, 100)}%` }"></div>
              </div>
            </div>
          </div>
        </section>

        <!-- 凝练/分化操作 -->
        <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
          <div class="text-sm font-bold text-amber-300 mb-3">元神凝练与分化</div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <!-- 凝练第二元神 -->
            <div class="bg-stone-900/50 border border-stone-700 rounded p-3">
              <div class="text-xs text-amber-300 font-bold mb-2">凝练第二元神</div>
              <div class="text-[11px] text-stone-400 space-y-1 mb-3">
                <div>· 境界要求：<span :class="profile.condense_requirements.realm_met ? 'text-emerald-300' : 'text-rose-400'">
                  {{ profile.condense_requirements.realm_required }}
                </span></div>
                <div>· 残篇收集：<span :class="profile.condense_requirements.fragments_met ? 'text-emerald-300' : 'text-rose-400'">
                  {{ profile.condense_requirements.fragments_met ? '已齐全' : '尚有缺失' }}
                </span></div>
                <div>· 消耗灵石：<span class="text-amber-300">{{ formatNumber(profile.condense_requirements.cost.spirit_stones) }}</span></div>
                <div>· 消耗神识：<span class="text-cyan-300">{{ profile.condense_requirements.cost.divine_sense }}</span></div>
                <div>· 消耗残魂：<span class="text-purple-300">{{ profile.condense_requirements.cost.remnant_soul }}</span></div>
              </div>
              <button @click="openCondenseModal(2)"
                :disabled="loading || !profile.condense_requirements.can_condense || hasSecondSoul"
                class="w-full py-2 rounded text-xs font-bold bg-gradient-to-r from-amber-900 to-amber-700 border border-amber-500 text-amber-100 hover:from-amber-800 hover:to-amber-600 disabled:opacity-50 transition-all">
                {{ hasSecondSoul ? '已有第二元神' : (profile.condense_requirements.can_condense ? '凝练第二元神' : '条件未满足') }}
              </button>
            </div>

            <!-- 分化第三元神 -->
            <div class="bg-stone-900/50 border border-stone-700 rounded p-3">
              <div class="text-xs text-purple-300 font-bold mb-2">分化第三元神</div>
              <div class="text-[11px] text-stone-400 space-y-1 mb-3">
                <div>· 需第二元神境界≥化神期</div>
                <div>· 元神上限：3（主+第二+第三）</div>
                <div>· 消耗：额外灵石/神识/残魂</div>
                <div>· 第三元神属性继承第二元神</div>
              </div>
              <button @click="openCondenseModal(3)"
                :disabled="loading || !hasSecondSoul || hasThirdSoul"
                class="w-full py-2 rounded text-xs font-bold bg-purple-950/40 border border-purple-800 text-purple-300 hover:bg-purple-900/40 disabled:opacity-50 transition-all">
                {{ !hasSecondSoul ? '需先凝练第二元神' : (hasThirdSoul ? '已有第三元神' : '分化第三元神') }}
                </button>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 凝练/分化元神命名弹窗 -->
    <Modal :isOpen="showNameModal" :title="nameModalTitle" @close="showNameModal = false" width="420px">
      <div class="space-y-3">
        <p class="text-stone-300 text-sm">
          请为{{ pendingSoulIndex === 2 ? '第二元神' : '第三元神' }}赐名（最长 50 字符）：
        </p>
        <input v-model="soulName" maxlength="50"
          class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:border-amber-500 focus:outline-none"
          placeholder="如：玄清分身、太虚影魂等" />
        <p class="text-[11px] text-stone-500">
          · 元神名称将显示在元神列表与战斗日志中<br>
          · 凝练后将消耗对应资源，操作不可撤销
        </p>
      </div>
      <template #footer>
        <button @click="showNameModal = false"
          class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">取消</button>
        <button @click="confirmCondense"
          :disabled="loading || !soulName.trim()"
          class="px-4 py-2 text-xs rounded bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
          {{ loading ? '处理中...' : '确认凝练' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
/**
 * 第二元神面板组件脚本
 * 使用 Composition API，所有状态从后端拉取，禁止硬编码业务数据
 */
import { ref, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import { useUIStore } from '../../stores/ui';
import { formatNumber } from '../../utils/format';
import {
  secondSoulGetProfile,
  secondSoulCondense,
  secondSoulDivide,
  secondSoulDispatch,
  secondSoulCultivate,
  type SecondSoulProfileData,
  type SecondSoul
} from '../../api/lateStage';

const uiStore = useUIStore();

/** 面板状态：是否加载中 */
const loading = ref(false);
/** 面板数据 */
const profile = ref<SecondSoulProfileData | null>(null);
/** 命名弹窗显示状态 */
const showNameModal = ref(false);
/** 待操作的元神序号：2=凝练第二元神，3=分化第三元神 */
const pendingSoulIndex = ref<2 | 3>(2);
/** 元神名称输入值 */
const soulName = ref('');

/** 调度模式选项 */
const dispatchModes = [
  { value: 'combat' as const, label: '斗法' },
  { value: 'cultivate' as const, label: '修炼' },
  { value: 'scout' as const, label: '窥探' },
  { value: 'defend' as const, label: '护身' }
];

/** 是否已拥有第二元神 */
const hasSecondSoul = computed(() => {
  if (!profile.value) return false;
  return profile.value.souls.some(s => s.soul_index === 2);
});

/** 是否已拥有第三元神 */
const hasThirdSoul = computed(() => {
  if (!profile.value) return false;
  return profile.value.souls.some(s => s.soul_index === 3);
});

/** 命名弹窗标题（动态区分凝练/分化） */
const nameModalTitle = computed(() =>
  pendingSoulIndex.value === 2 ? '凝练第二元神' : '分化第三元神'
);

/**
 * 组件挂载时拉取面板数据
 */
onMounted(async () => {
  await loadProfile();
});

/**
 * 拉取第二元神面板数据
 */
async function loadProfile() {
  loading.value = true;
  try {
    const resp = await secondSoulGetProfile();
    if (resp.data?.code === 200 && resp.data.data) {
      profile.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取元神档案失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 打开命名弹窗
 * @param soulIndex 元神序号（2=凝练，3=分化）
 */
function openCondenseModal(soulIndex: 2 | 3) {
  pendingSoulIndex.value = soulIndex;
  soulName.value = '';
  showNameModal.value = true;
}

/**
 * 确认凝练/分化元神
 * 根据元神序号调用不同接口
 */
async function confirmCondense() {
  if (!soulName.value.trim()) {
    uiStore.showToast('请输入元神名称', 'warning');
    return;
  }
  loading.value = true;
  try {
    // 凝练第二元神走 /condense，分化第三元神走 /divide
    const resp = pendingSoulIndex.value === 2
      ? await secondSoulCondense(soulName.value.trim())
      : await secondSoulDivide(soulName.value.trim());
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || (pendingSoulIndex.value === 2 ? '凝练成功' : '分化成功'), 'success');
      showNameModal.value = false;
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '操作失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 切换元神调度模式
 * @param soulIndex 元神序号（2 或 3）
 * @param mode 调度模式：combat/cultivate/scout/defend
 */
async function handleDispatch(soulIndex: 2 | 3, mode: 'combat' | 'cultivate' | 'scout' | 'defend') {
  loading.value = true;
  try {
    const resp = await secondSoulDispatch(soulIndex, mode);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '调度已切换', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '调度失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 开始元神独立修炼
 * @param soulIndex 元神序号（2 或 3）
 */
async function handleCultivate(soulIndex: 2 | 3) {
  loading.value = true;
  try {
    const resp = await secondSoulCultivate(soulIndex);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '已开始独立修炼', 'success');
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '修炼开启失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 获取元神序号中文标签
 * @param idx 元神序号
 */
function getSoulIndexLabel(idx: number): string {
  const map: Record<number, string> = { 1: '主元神', 2: '第二元神', 3: '第三元神' };
  return map[idx] || `元神${idx}`;
}

/**
 * 获取调度模式中文标签
 * @param mode 调度模式
 */
function getDispatchModeLabel(mode: string): string {
  const map: Record<string, string> = {
    combat: '斗法中',
    cultivate: '修炼中',
    scout: '窥探中',
    defend: '护身中'
  };
  return map[mode] || mode;
}

/**
 * 格式化时间显示（M/D HH:MM）
 * @param time ISO 时间字符串
 */
function formatTime(time: string | null): string {
  if (!time) return '-';
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>

<style scoped>
/* 局部淡入动画，与 AscensionPanel 保持一致 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}
</style>
