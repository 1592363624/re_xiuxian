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
 *   6. 调度模式切换：模式清单与名字取自内容（/second-soul/profile 的 dispatch_modes，各模式独立 CD）
 *   7. 独立修炼：12 小时上限，每日 2 次
 *
 * 设计原则：
 *   - 所有状态从后端 GET /second-soul/profile 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色全部取 tokens.css 的 surface-* / line-* / fg-* / gold-* / state-* 令牌
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS
 */
<template>
  <PanelShell
    title="第二元神 · 元神分化"
    size="lg"
    :loading="loading && !profile"
    @close="$emit('close')"
  >
    <!-- 状态总览栏 -->
    <div v-if="profile" class="bg-surface-hover border border-line rounded-panel p-3 mb-3 grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
      <div>
        <div class="text-fg-muted">当前境界</div>
        <div class="text-gold-400 font-bold">{{ profile.player.realm }}</div>
      </div>
      <div>
        <div class="text-fg-muted">灵石</div>
        <div class="text-gold-300 font-bold num" :title="String(profile.player.spirit_stones)">{{ formatCompact(profile.player.spirit_stones) }}</div>
      </div>
      <div>
        <div class="text-fg-muted">神识</div>
        <div class="text-state-info font-bold num">{{ profile.player.divine_sense }}</div>
      </div>
      <div>
        <div class="text-fg-muted">残魂</div>
        <div class="text-state-arcane font-bold num">{{ profile.player.remnant_soul }}</div>
      </div>
      <div>
        <div class="text-fg-muted">副元神数</div>
        <div class="text-pink-300 font-bold num">{{ profile.player.second_soul_count }} / 2</div>
      </div>
    </div>

    <!-- 内容区 -->
    <div v-if="profile" class="space-y-3">
      <!-- 元神列表 -->
      <section class="bg-surface-hover border border-line rounded-panel p-4">
        <div class="text-sm font-bold text-gold-400 mb-3 font-display">元神列表</div>
        <div v-if="profile.souls.length === 0" class="text-xs text-fg-muted text-center py-4">
          暂无元神记录
        </div>
        <div v-else class="space-y-3">
          <div v-for="soul in profile.souls" :key="soul.id"
            class="bg-surface-sunken border border-line rounded-control p-3 text-xs">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="font-bold" :class="soul.soul_index === 1 ? 'text-gold-400' : 'text-state-arcane'">
                  {{ getSoulIndexLabel(soul.soul_index) }}
                </span>
                <span class="text-fg-secondary">{{ soul.soul_name }}</span>
                <Badge tone="neutral">{{ soul.soul_type }}</Badge>
              </div>
              <div class="flex items-center gap-2 text-[10px]">
                <Badge v-if="soul.is_cultivating" tone="info">修炼中</Badge>
                <Badge v-if="soul.last_dispatch_mode" tone="arcane">{{ getDispatchModeLabel(soul.last_dispatch_mode) }}</Badge>
              </div>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-fg-muted">
              <div>境界：<span class="text-gold-400">{{ soul.realm }}</span></div>
              <div>修为：<span class="text-state-success num" :title="String(soul.exp)">{{ formatCompact(soul.exp) }}</span></div>
              <div>继承率：<span class="text-state-arcane num">{{ (soul.inherit_ratio * 100).toFixed(0) }}%</span></div>
              <div>斗法次数：<span class="text-state-danger num">{{ soul.combat_count }}</span></div>
            </div>
            <div class="grid grid-cols-5 gap-2 mt-2 text-[11px]">
              <div class="bg-surface-base rounded-control px-2 py-1 border border-line-subtle">
                <div class="text-fg-muted">攻</div>
                <div class="text-gold-400 font-bold num">{{ soul.attributes.atk ?? 0 }}</div>
              </div>
              <div class="bg-surface-base rounded-control px-2 py-1 border border-line-subtle">
                <div class="text-fg-muted">防</div>
                <div class="text-gold-400 font-bold num">{{ soul.attributes.def ?? 0 }}</div>
              </div>
              <div class="bg-surface-base rounded-control px-2 py-1 border border-line-subtle">
                <div class="text-fg-muted">血</div>
                <div class="text-gold-400 font-bold num">{{ soul.attributes.hp_max ?? 0 }}</div>
              </div>
              <div class="bg-surface-base rounded-control px-2 py-1 border border-line-subtle">
                <div class="text-fg-muted">速</div>
                <div class="text-gold-400 font-bold num">{{ soul.attributes.speed ?? 0 }}</div>
              </div>
              <div class="bg-surface-base rounded-control px-2 py-1 border border-line-subtle">
                <div class="text-fg-muted">识</div>
                <div class="text-gold-400 font-bold num">{{ soul.attributes.sense ?? 0 }}</div>
              </div>
            </div>

            <!-- 修炼进度提示 -->
            <div v-if="soul.is_cultivating && soul.cultivate_end_time" class="mt-2 text-[11px] text-state-info num">
              · 修炼中，预计结束：{{ formatTime(soul.cultivate_end_time) }}
            </div>
            <div v-if="soul.dispatch_until" class="mt-1 text-[11px] text-state-arcane num">
              · 调度中，持续至：{{ formatTime(soul.dispatch_until) }}
            </div>

            <!-- 副元神操作按钮 -->
            <div v-if="soul.soul_index >= 2" class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
              <button v-for="mode in dispatchModes" :key="mode.value"
                @click="handleDispatch(soul.soul_index as 2|3, mode.value)"
                :disabled="loading"
                :class="[
                  'py-1.5 text-[11px] rounded-control border transition-colors disabled:opacity-50',
                  soul.last_dispatch_mode === mode.value
                    ? 'bg-surface-tint-arcane border-state-arcane text-state-arcane font-bold'
                    : 'bg-surface-base border-line text-fg-secondary hover:bg-surface-hover'
                ]">
                {{ mode.label }}
              </button>
              <AppButton
                block
                size="xs"
                variant="outline"
                :disabled="loading || soul.is_cultivating"
                @click="handleCultivate(soul.soul_index as 2|3)"
              >
                {{ soul.is_cultivating ? '修炼中' : '独立修炼' }}
              </AppButton>
            </div>
          </div>
        </div>
      </section>

      <!-- 残篇收集进度 -->
      <section class="bg-surface-hover border border-line rounded-panel p-4">
        <div class="text-sm font-bold text-state-arcane mb-3 font-display">元神残篇收集</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div v-for="(frag, key) in profile.fragment_progress" :key="key"
            class="bg-surface-sunken border border-line rounded-control p-2 text-xs">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-gold-400 font-bold">{{ frag.name }}</span>
                <span class="ml-2 text-fg-muted text-[10px]">{{ frag.source }}</span>
              </div>
              <div class="num" :class="frag.met ? 'text-state-success' : 'text-state-danger'">
                {{ frag.collected }} / {{ frag.required }}
              </div>
            </div>
            <!-- 进度条 -->
            <div class="mt-1 h-1 bg-surface-sunken rounded-full overflow-hidden border border-line-subtle">
              <div class="h-full transition-all duration-500"
                :class="frag.met ? 'bg-state-success' : 'bg-gold-500'"
                :style="{ width: `${Math.min((frag.collected / frag.required) * 100, 100)}%` }"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- 凝练/分化操作 -->
      <section class="bg-surface-hover border border-line rounded-panel p-4">
        <div class="text-sm font-bold text-gold-400 mb-3 font-display">元神凝练与分化</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <!-- 凝练第二元神 -->
          <div class="bg-surface-sunken border border-line rounded-control p-3">
            <div class="text-xs text-gold-400 font-bold mb-2">凝练第二元神</div>
            <div class="text-[11px] text-fg-secondary space-y-1 mb-3">
              <div>· 境界要求：<span :class="profile.condense_requirements.realm_met ? 'text-state-success' : 'text-state-danger'">
                {{ profile.condense_requirements.realm_required }}
              </span></div>
              <div>· 残篇收集：<span :class="profile.condense_requirements.fragments_met ? 'text-state-success' : 'text-state-danger'">
                {{ profile.condense_requirements.fragments_met ? '已齐全' : '尚有缺失' }}
              </span></div>
              <div>· 消耗灵石：<span class="text-gold-400 num" :title="String(profile.condense_requirements.cost.spirit_stones)">{{ formatCompact(profile.condense_requirements.cost.spirit_stones) }}</span></div>
              <div>· 消耗神识：<span class="text-state-info num">{{ profile.condense_requirements.cost.divine_sense }}</span></div>
              <div>· 消耗残魂：<span class="text-state-arcane num">{{ profile.condense_requirements.cost.remnant_soul }}</span></div>
            </div>
            <AppButton
              block
              variant="primary"
              :disabled="loading || !profile.condense_requirements.can_condense || hasSecondSoul"
              @click="openCondenseModal(2)"
            >
              {{ hasSecondSoul ? '已有第二元神' : (profile.condense_requirements.can_condense ? '凝练第二元神' : '条件未满足') }}
            </AppButton>
          </div>

          <!-- 分化第三元神 -->
          <div class="bg-surface-sunken border border-line rounded-control p-3">
            <div class="text-xs text-state-arcane font-bold mb-2">分化第三元神</div>
            <div class="text-[11px] text-fg-secondary space-y-1 mb-3">
              <div>· 需第二元神境界≥化神期</div>
              <div>· 元神上限：<span class="num">3</span>（主+第二+第三）</div>
              <div>· 消耗：额外灵石/神识/残魂</div>
              <div>· 第三元神属性继承第二元神</div>
            </div>
            <AppButton
              block
              variant="outline"
              :disabled="loading || !hasSecondSoul || hasThirdSoul"
              @click="openCondenseModal(3)"
            >
              {{ !hasSecondSoul ? '需先凝练第二元神' : (hasThirdSoul ? '已有第三元神' : '分化第三元神') }}
            </AppButton>
          </div>
        </div>
      </section>
    </div>

    <!-- 凝练/分化元神命名弹窗 -->
    <Modal :isOpen="showNameModal" :title="nameModalTitle" @close="showNameModal = false" width="420px">
      <div class="space-y-3">
        <p class="text-fg-secondary text-sm">
          请为{{ pendingSoulIndex === 2 ? '第二元神' : '第三元神' }}赐名（最长 50 字符）：
        </p>
        <input v-model="soulName" maxlength="50"
          class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-fg-primary focus:border-gold-500 focus:outline-none focus-ring"
          placeholder="如：玄清分身、太虚影魂等" />
        <p class="text-[11px] text-fg-muted">
          · 元神名称将显示在元神列表与战斗日志中<br>
          · 凝练后将消耗对应资源，操作不可撤销
        </p>
      </div>
      <template #footer>
        <AppButton variant="default" @click="showNameModal = false">取消</AppButton>
        <AppButton
          variant="primary"
          :loading="loading"
          :disabled="!soulName.trim()"
          @click="confirmCondense"
        >
          确认凝练
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 第二元神面板组件脚本
 * 使用 Composition API，所有状态从后端拉取，禁止硬编码业务数据
 */
import { ref, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import PanelShell from '../ui/PanelShell.vue';
import AppButton from '../ui/AppButton.vue';
import Badge from '../ui/Badge.vue';
import { useUIStore } from '../../stores/ui';
import { formatCompact } from '../../utils/format';
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

/**
 * 调度模式选项：取自 /second-soul/profile 的 dispatch_modes（内容是 late_stage_data）。
 * 这里以前自己抄了 4 条，而且三条文案和内容的 display_name 不一致（斗法/窥探/护身 vs 出战/探查/护法），
 * 资料片加一种模式面板上永远看不到。
 */
const dispatchModes = computed<Array<{ value: string; label: string }>>(() =>
  (profile.value?.dispatch_modes || []).map(m => ({ value: m.key, label: m.name }))
);

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
async function handleDispatch(soulIndex: 2 | 3, mode: string) {
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
 * 获取调度模式中文标签：名字仍取自内容的 dispatch_modes，"…中"是这里自己的展示语法。
 * @param mode 调度模式
 */
function getDispatchModeLabel(mode: string): string {
  const name = dispatchModes.value.find(m => m.value === mode)?.label;
  return name ? `${name}中` : mode;
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
