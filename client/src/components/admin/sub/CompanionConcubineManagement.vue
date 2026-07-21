<template>
  <!--
    批次3 道侣 / 侍妾系统 GM 后台管理组件

    功能模块（2 大子模块 Tab）：
      1. 道侣管理：
         - 强制解除道侣（输入 player_id）
         - 调整心契等级（输入 player_id + level 0-5）
         - 触发心劫（输入 player_id）
      2. 侍妾管理：
         - 直接发放侍妾（输入 player_id + concubine_key 下拉 7 种）
         - 调整侍妾属性（输入 concubine_id + attr 下拉 + value）
         - 立即完成远航（输入 voyage_id）

    设计原则：
      - 所有数据通过 companion.ts 中封装的 GM API 调用
      - 写操作 emit showConfirm 委托父组件 AdminPanel.vue 二次确认
      - 禁用浏览器原生 alert/confirm
      - 玩家ID 手动输入，方便 GM 快速操作任意玩家
  -->
  <div class="space-y-4">
    <!-- 顶部标题 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-amber-300">道侣 / 侍妾管理</h3>
      <div class="text-xs text-gray-500">批次3 道侣侍妾系统 GM 操作面板</div>
    </div>

    <!-- 子 Tab 切换 -->
    <div class="flex border-b border-gray-700 bg-gray-800/50 overflow-x-auto">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        @click="currentSubTab = tab.id"
        class="px-6 py-2 text-sm font-medium transition-colors relative whitespace-nowrap cursor-pointer"
        :class="currentSubTab === tab.id ? 'text-amber-300' : 'text-gray-400 hover:text-white hover:bg-gray-700/50'"
      >
        {{ tab.name }}
        <div v-if="currentSubTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-500"></div>
      </button>
    </div>

    <!-- ============ 子 Tab 1：道侣管理 ============ -->
    <div v-if="currentSubTab === 'dao_companion'" class="space-y-4">
      <!-- 强制解除道侣 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="text-sm font-bold text-rose-300 mb-2">强制解除道侣</div>
        <div class="text-xs text-gray-500 mb-3">
          · 强制解除指定玩家的道侣关系，用于处理玩家纠纷或异常状态<br>
          · 操作不可撤销，会清空亲密度与心契等级
        </div>
        <div class="mb-3">
          <label class="block text-xs text-gray-400 mb-1">目标玩家 ID</label>
          <input v-model.number="daoBreakForm.playerId" type="number" min="1" placeholder="例如：1"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
        </div>
        <button @click="submitDaoBreak"
          :disabled="actionLoading || !daoBreakForm.playerId"
          class="px-4 py-2 bg-rose-700 hover:bg-rose-600 rounded text-white text-sm disabled:opacity-50">
          {{ actionLoading ? '提交中...' : '强制解除' }}
        </button>
      </div>

      <!-- 调整心契等级 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="text-sm font-bold text-purple-300 mb-2">调整心契等级</div>
        <div class="text-xs text-gray-500 mb-3">
          · 直接覆盖指定玩家的心契等级（0-5）<br>
          · 0=未启心契，5=满级心契
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">目标玩家 ID</label>
            <input v-model.number="heartContractForm.playerId" type="number" min="1" placeholder="例如：1"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">心契等级（0-5）</label>
            <input v-model.number="heartContractForm.level" type="number" min="0" max="5" placeholder="0-5"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
          </div>
        </div>
        <button @click="submitSetHeartContract"
          :disabled="actionLoading || !heartContractForm.playerId || heartContractForm.level === null"
          class="px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded text-white text-sm disabled:opacity-50">
          {{ actionLoading ? '提交中...' : '确认调整' }}
        </button>
      </div>

      <!-- 触发心劫 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="text-sm font-bold text-amber-300 mb-2">触发心劫</div>
        <div class="text-xs text-gray-500 mb-3">
          · 立即为指定玩家生成一个心劫事件<br>
          · 玩家需在道侣面板的心劫 Tab 中抉择应对
        </div>
        <div class="mb-3">
          <label class="block text-xs text-gray-400 mb-1">目标玩家 ID</label>
          <input v-model.number="triggerTribulationForm.playerId" type="number" min="1" placeholder="例如：1"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
        </div>
        <button @click="submitTriggerTribulation"
          :disabled="actionLoading || !triggerTribulationForm.playerId"
          class="px-4 py-2 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm disabled:opacity-50">
          {{ actionLoading ? '提交中...' : '触发心劫' }}
        </button>
      </div>
    </div>

    <!-- ============ 子 Tab 2：侍妾管理 ============ -->
    <div v-if="currentSubTab === 'concubine'" class="space-y-4">
      <!-- 直接发放侍妾 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="text-sm font-bold text-fuchsia-300 mb-2">直接发放侍妾</div>
        <div class="text-xs text-gray-500 mb-3">
          · 直接为玩家发放一个指定原型的侍妾<br>
          · 共 7 种原型可选
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">目标玩家 ID</label>
            <input v-model.number="grantConcubineForm.playerId" type="number" min="1" placeholder="例如：1"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">侍妾原型</label>
            <select v-model="grantConcubineForm.concubineKey"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
              <option value="">请选择侍妾原型</option>
              <option v-for="opt in concubineKeyOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}（{{ opt.value }}）
              </option>
            </select>
          </div>
        </div>
        <button @click="submitGrantConcubine"
          :disabled="actionLoading || !grantConcubineForm.playerId || !grantConcubineForm.concubineKey"
          class="px-4 py-2 bg-fuchsia-700 hover:bg-fuchsia-600 rounded text-white text-sm disabled:opacity-50">
          {{ actionLoading ? '提交中...' : '确认发放' }}
        </button>
      </div>

      <!-- 调整侍妾属性 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="text-sm font-bold text-cyan-300 mb-2">调整侍妾属性</div>
        <div class="text-xs text-gray-500 mb-3">
          · 直接覆盖指定侍妾的某项属性<br>
          · charm=魅力(0-100) / intimacy=亲密度(0-100) / loyalty=忠诚度(0-100) / exp=经验 / realm_rank=境界等阶
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">侍妾 ID</label>
            <input v-model.number="setAttrForm.concubineId" type="number" min="1" placeholder="例如：1"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">属性名</label>
            <select v-model="setAttrForm.attr"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
              <option value="">请选择属性</option>
              <option value="charm">charm（魅力）</option>
              <option value="intimacy">intimacy（亲密度）</option>
              <option value="loyalty">loyalty（忠诚度）</option>
              <option value="exp">exp（经验）</option>
              <option value="realm_rank">realm_rank（境界等阶）</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">新值</label>
            <input v-model.number="setAttrForm.value" type="number" placeholder="例如：80"
              class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
          </div>
        </div>
        <button @click="submitSetAttr"
          :disabled="actionLoading || !setAttrForm.concubineId || !setAttrForm.attr || setAttrForm.value === null"
          class="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded text-white text-sm disabled:opacity-50">
          {{ actionLoading ? '提交中...' : '确认调整' }}
        </button>
      </div>

      <!-- 立即完成远航 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="text-sm font-bold text-emerald-300 mb-2">立即完成远航</div>
        <div class="text-xs text-gray-500 mb-3">
          · 强制将指定远航标记为已完成<br>
          · 玩家可在侍妾面板的远航 Tab 中领取奖励
        </div>
        <div class="mb-3">
          <label class="block text-xs text-gray-400 mb-1">远航 ID</label>
          <input v-model.number="finishVoyageForm.voyageId" type="number" min="1" placeholder="例如：1"
            class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm">
        </div>
        <button @click="submitFinishVoyage"
          :disabled="actionLoading || !finishVoyageForm.voyageId"
          class="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-white text-sm disabled:opacity-50">
          {{ actionLoading ? '提交中...' : '立即完成' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 道侣 / 侍妾系统 GM 管理组件脚本
 * 使用 Composition API，2 大子模块共享 emit showConfirm 委托二次确认
 */
import { ref, reactive } from 'vue';
import { useUIStore } from '../../../stores/ui';
import {
  adminBreakDaoCompanion,
  adminSetHeartContractLevel,
  adminTriggerHeartTribulation,
  adminGrantConcubine,
  adminSetConcubineAttr,
  adminFinishVoyage
} from '../../../api/companion';

const uiStore = useUIStore();

/** 父组件事件：showConfirm(title, message, onConfirm) 委托 AdminPanel 二次确认 */
const emit = defineEmits(['showConfirm']);

/** 子 Tab 配置 */
const subTabs = [
  { id: 'dao_companion', name: '道侣管理' },
  { id: 'concubine', name: '侍妾管理' }
];
/** 当前子 Tab */
const currentSubTab = ref('dao_companion');

/** 全局操作 loading */
const actionLoading = ref(false);

/** 道侣管理表单 */
const daoBreakForm = reactive({
  playerId: null as number | null
});
const heartContractForm = reactive({
  playerId: null as number | null,
  level: null as number | null
});
const triggerTribulationForm = reactive({
  playerId: null as number | null
});

/** 侍妾管理表单 */
const grantConcubineForm = reactive({
  playerId: null as number | null,
  concubineKey: ''
});
const setAttrForm = reactive({
  concubineId: null as number | null,
  attr: '' as '' | 'charm' | 'intimacy' | 'loyalty' | 'exp' | 'realm_rank',
  value: null as number | null
});
const finishVoyageForm = reactive({
  voyageId: null as number | null
});

/** 侍妾原型选项（7 种，与 server/config/companion_data.json 的 concubine_key 严格对齐） */
const concubineKeyOptions = [
  { value: 'nangong_wan', label: '南宫婉' },
  { value: 'ziling', label: '紫灵' },
  { value: 'wen_qing', label: '温清' },
  { value: 'mu_pei', label: '慕沛' },
  { value: 'liu_yu', label: '柳雨' },
  { value: 'han_xue', label: '寒雪' },
  { value: 'xue_ji', label: '血姬' }
];

/**
 * 校验玩家ID 是否已填写
 * @returns 是否通过校验
 */
function validatePlayerId(playerId: number | null): boolean {
  if (!playerId || playerId <= 0) {
    uiStore.showToast('请输入有效的玩家ID', 'warning');
    return false;
  }
  return true;
}

/**
 * 提交：强制解除道侣
 */
function submitDaoBreak() {
  if (!validatePlayerId(daoBreakForm.playerId)) return;
  emit('showConfirm',
    '强制解除道侣',
    `确认强制解除玩家 ID=${daoBreakForm.playerId} 的道侣关系？\n· 操作不可撤销\n· 将清空亲密度与心契等级`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminBreakDaoCompanion(daoBreakForm.playerId!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '道侣关系已强制解除', 'success');
          daoBreakForm.playerId = null;
        } else {
          uiStore.showToast(resp.data?.message || '解除失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        actionLoading.value = false;
      }
    }
  );
}

/**
 * 提交：调整心契等级
 */
function submitSetHeartContract() {
  if (!validatePlayerId(heartContractForm.playerId)) return;
  if (heartContractForm.level === null || heartContractForm.level < 0 || heartContractForm.level > 5) {
    uiStore.showToast('心契等级需在 0-5 之间', 'warning');
    return;
  }
  emit('showConfirm',
    '调整心契等级',
    `确认将玩家 ID=${heartContractForm.playerId} 的心契等级调整为 ${heartContractForm.level}？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminSetHeartContractLevel(heartContractForm.playerId!, heartContractForm.level!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '心契等级已调整', 'success');
          heartContractForm.playerId = null;
          heartContractForm.level = null;
        } else {
          uiStore.showToast(resp.data?.message || '调整失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        actionLoading.value = false;
      }
    }
  );
}

/**
 * 提交：触发心劫
 */
function submitTriggerTribulation() {
  if (!validatePlayerId(triggerTribulationForm.playerId)) return;
  emit('showConfirm',
    '触发心劫',
    `确认为玩家 ID=${triggerTribulationForm.playerId} 触发心劫？\n· 将生成一个待处理的心劫事件`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminTriggerHeartTribulation(triggerTribulationForm.playerId!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '心劫已触发', 'success');
          triggerTribulationForm.playerId = null;
        } else {
          uiStore.showToast(resp.data?.message || '触发失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        actionLoading.value = false;
      }
    }
  );
}

/**
 * 提交：直接发放侍妾
 */
function submitGrantConcubine() {
  if (!validatePlayerId(grantConcubineForm.playerId)) return;
  if (!grantConcubineForm.concubineKey) {
    uiStore.showToast('请选择侍妾原型', 'warning');
    return;
  }
  const concubineLabel = concubineKeyOptions.find(o => o.value === grantConcubineForm.concubineKey)?.label || grantConcubineForm.concubineKey;
  emit('showConfirm',
    '发放侍妾',
    `确认向玩家 ID=${grantConcubineForm.playerId} 发放侍妾「${concubineLabel}」？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminGrantConcubine(grantConcubineForm.playerId!, grantConcubineForm.concubineKey);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '侍妾已发放', 'success');
          grantConcubineForm.playerId = null;
          grantConcubineForm.concubineKey = '';
        } else {
          uiStore.showToast(resp.data?.message || '发放失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        actionLoading.value = false;
      }
    }
  );
}

/**
 * 提交：调整侍妾属性
 */
function submitSetAttr() {
  if (!setAttrForm.concubineId || setAttrForm.concubineId <= 0) {
    uiStore.showToast('请输入有效的侍妾ID', 'warning');
    return;
  }
  if (!setAttrForm.attr) {
    uiStore.showToast('请选择属性名', 'warning');
    return;
  }
  if (setAttrForm.value === null || setAttrForm.value < 0) {
    uiStore.showToast('请输入有效的属性值（非负数）', 'warning');
    return;
  }
  // 魅力/亲密度/忠诚度上限为 100，其他无上限
  if (['charm', 'intimacy', 'loyalty'].includes(setAttrForm.attr) && setAttrForm.value > 100) {
    uiStore.showToast(`${setAttrForm.attr} 上限为 100`, 'warning');
    return;
  }
  emit('showConfirm',
    '调整侍妾属性',
    `确认将侍妾 ID=${setAttrForm.concubineId} 的 ${setAttrForm.attr} 调整为 ${setAttrForm.value}？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminSetConcubineAttr(
          setAttrForm.concubineId!,
          setAttrForm.attr as 'charm' | 'intimacy' | 'loyalty' | 'exp' | 'realm_rank',
          setAttrForm.value!
        );
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '侍妾属性已调整', 'success');
          setAttrForm.concubineId = null;
          setAttrForm.attr = '';
          setAttrForm.value = null;
        } else {
          uiStore.showToast(resp.data?.message || '调整失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        actionLoading.value = false;
      }
    }
  );
}

/**
 * 提交：立即完成远航
 */
function submitFinishVoyage() {
  if (!finishVoyageForm.voyageId || finishVoyageForm.voyageId <= 0) {
    uiStore.showToast('请输入有效的远航ID', 'warning');
    return;
  }
  emit('showConfirm',
    '立即完成远航',
    `确认立即完成远航 ID=${finishVoyageForm.voyageId}？\n· 远航将标记为已完成\n· 玩家可在侍妾面板领取奖励`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminFinishVoyage(finishVoyageForm.voyageId!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '远航已完成', 'success');
          finishVoyageForm.voyageId = null;
        } else {
          uiStore.showToast(resp.data?.message || '完成失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        actionLoading.value = false;
      }
    }
  );
}
</script>
