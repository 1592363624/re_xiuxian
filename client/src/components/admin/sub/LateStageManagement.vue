<template>
  <!--
    批次3 后期系统 GM 后台管理组件

    功能模块（6 大子模块 Tab）：
      1. 第二元神：调整副元神属性（atk/def/hp_max/speed/sense）
      2. 小世界：重置小世界 / 调整小世界等级（1-10）
      3. 神庙：调整神庙等级（1-10）
      4. 香火：发放/扣减香火（-1000000~1000000）
      5. 神识：发放/扣减神识（-10000~10000）
      6. 法则：发放/扣减法则点 / 发放/扣减法则碎片（5 类）

    设计原则：
      - 所有数据通过 lateStage.ts 中封装的 GM API 调用
      - 写操作 emit showConfirm 委托父组件 AdminPanel.vue 二次确认
      - 禁用浏览器原生 alert/confirm
      - 玩家ID 手动输入，方便 GM 快速操作任意玩家
      - 灵石/经验等 BigInt 字段使用字符串显示避免精度丢失
  -->
  <div class="space-y-4">
    <!-- 顶部标题 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-amber-300">后期系统管理</h3>
      <div class="text-xs text-gray-500">批次3 后期系统 6 大子模块 GM 操作面板</div>
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

    <!-- 玩家ID 输入（所有子模块共享） -->
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
      <div class="flex items-center gap-3">
        <label class="text-sm text-gray-400 whitespace-nowrap">目标玩家ID：</label>
        <input v-model.number="playerId" type="number" min="1" placeholder="例如：1"
          class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:border-amber-500 focus:outline-none" />
        <span class="text-xs text-gray-500">测试账号 ID=1（韩天尊）</span>
      </div>
    </div>

    <!-- ============ 子 Tab 1：第二元神属性调整 ============ -->
    <div v-if="currentSubTab === 'second_soul'" class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="text-sm font-bold text-purple-300 mb-3">调整副元神属性</div>
      <div class="text-xs text-gray-500 mb-3">
        · 调整第二/第三元神的攻/防/血/速/识属性<br>
        · 仅传需要调整的字段，其他字段保持不变
      </div>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <div>
          <label class="block text-xs text-gray-400 mb-1">元神序号</label>
          <select v-model="secondSoulForm.soulIndex"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
            <option :value="2">2（第二元神）</option>
            <option :value="3">3（第三元神）</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">攻击 (atk)</label>
          <input v-model.number="secondSoulForm.atk" type="number" placeholder="留空不调整"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">防御 (def)</label>
          <input v-model.number="secondSoulForm.def" type="number" placeholder="留空不调整"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">气血 (hp_max)</label>
          <input v-model.number="secondSoulForm.hpMax" type="number" placeholder="留空不调整"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">速度 (speed)</label>
          <input v-model.number="secondSoulForm.speed" type="number" placeholder="留空不调整"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">神识 (sense)</label>
          <input v-model.number="secondSoulForm.sense" type="number" placeholder="留空不调整"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
        </div>
      </div>
      <button @click="submitSecondSoulAdjust"
        :disabled="actionLoading || !playerId"
        class="px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded text-white text-sm disabled:opacity-50">
        {{ actionLoading ? '提交中...' : '确认调整' }}
      </button>
    </div>

    <!-- ============ 子 Tab 2：小世界管理 ============ -->
    <div v-if="currentSubTab === 'small_world'" class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="text-sm font-bold text-amber-300 mb-3">小世界管理</div>
      <div class="text-xs text-gray-500 mb-3">
        · 重置：删除玩家小世界与神庙记录，玩家可重新开辟<br>
        · 调整等级：直接覆盖小世界等级（1-10）
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <!-- 重置小世界 -->
        <div class="bg-gray-900/50 border border-gray-700 rounded p-3">
          <div class="text-xs text-rose-300 font-bold mb-2">重置小世界</div>
          <div class="text-[11px] text-gray-500 mb-3">将删除该玩家的小世界与神庙记录，操作不可撤销。</div>
          <button @click="submitSmallWorldReset"
            :disabled="actionLoading || !playerId"
            class="w-full px-4 py-2 bg-rose-700 hover:bg-rose-600 rounded text-white text-sm disabled:opacity-50">
            重置小世界
          </button>
        </div>
        <!-- 调整等级 -->
        <div class="bg-gray-900/50 border border-gray-700 rounded p-3">
          <div class="text-xs text-amber-300 font-bold mb-2">调整小世界等级</div>
          <div class="mb-2">
            <label class="block text-[11px] text-gray-400 mb-1">新等级（1-10）</label>
            <input v-model.number="smallWorldLevel" type="number" min="1" max="10"
              class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
          </div>
          <button @click="submitSmallWorldSetLevel"
            :disabled="actionLoading || !playerId || !smallWorldLevel"
            class="w-full px-4 py-2 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm disabled:opacity-50">
            调整等级
          </button>
        </div>
      </div>
    </div>

    <!-- ============ 子 Tab 3：神庙等级调整 ============ -->
    <div v-if="currentSubTab === 'divine_temple'" class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="text-sm font-bold text-amber-300 mb-3">神庙等级调整</div>
      <div class="text-xs text-gray-500 mb-3">
        · 直接覆盖神庙等级（1-10），不影响禁制值与其他属性
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs text-gray-400 mb-1">新等级（1-10）</label>
          <input v-model.number="templeLevel" type="number" min="1" max="10"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
        </div>
      </div>
      <button @click="submitTempleSetLevel"
        :disabled="actionLoading || !playerId || !templeLevel"
        class="px-4 py-2 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm disabled:opacity-50">
        {{ actionLoading ? '提交中...' : '确认调整' }}
      </button>
    </div>

    <!-- ============ 子 Tab 4：香火发放/扣减 ============ -->
    <div v-if="currentSubTab === 'incense'" class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="text-sm font-bold text-amber-300 mb-3">香火发放/扣减</div>
      <div class="text-xs text-gray-500 mb-3">
        · 正数发放，负数扣减（范围 -1000000 ~ 1000000）<br>
        · 操作将记录到香火流水，可在玩家面板查询
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs text-gray-400 mb-1">数量（正数发放 / 负数扣减）</label>
          <input v-model.number="incenseAmount" type="number" placeholder="例如：1000 或 -500"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
        </div>
      </div>
      <button @click="submitIncenseGrant"
        :disabled="actionLoading || !playerId || incenseAmount === null"
        class="px-4 py-2 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm disabled:opacity-50">
        {{ actionLoading ? '提交中...' : '确认发放' }}
      </button>
    </div>

    <!-- ============ 子 Tab 5：神识发放/扣减 ============ -->
    <div v-if="currentSubTab === 'divine_sense'" class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="text-sm font-bold text-cyan-300 mb-3">神识发放/扣减</div>
      <div class="text-xs text-gray-500 mb-3">
        · 正数发放，负数扣减（范围 -10000 ~ 10000）<br>
        · 神识用于第二元神凝练、神迹干预、法则转换等
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs text-gray-400 mb-1">数量（正数发放 / 负数扣减）</label>
          <input v-model.number="divineSenseAmount" type="number" placeholder="例如：100 或 -50"
            class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
        </div>
      </div>
      <button @click="submitDivineSenseGrant"
        :disabled="actionLoading || !playerId || divineSenseAmount === null"
        class="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded text-white text-sm disabled:opacity-50">
        {{ actionLoading ? '提交中...' : '确认发放' }}
      </button>
    </div>

    <!-- ============ 子 Tab 6：法则点 / 碎片发放 ============ -->
    <div v-if="currentSubTab === 'law'" class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <div class="text-sm font-bold text-purple-300 mb-3">法则点 / 法则碎片发放</div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <!-- 法则点发放 -->
        <div class="bg-gray-900/50 border border-gray-700 rounded p-3">
          <div class="text-xs text-purple-300 font-bold mb-2">法则点发放/扣减</div>
          <div class="text-[11px] text-gray-500 mb-2">范围 -10000 ~ 10000</div>
          <div class="mb-2">
            <label class="block text-[11px] text-gray-400 mb-1">数量</label>
            <input v-model.number="lawPointsAmount" type="number" placeholder="例如：100 或 -50"
              class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
          </div>
          <button @click="submitLawGrantPoints"
            :disabled="actionLoading || !playerId || lawPointsAmount === null"
            class="w-full px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded text-white text-sm disabled:opacity-50">
            确认发放法则点
          </button>
        </div>
        <!-- 法则碎片发放 -->
        <div class="bg-gray-900/50 border border-gray-700 rounded p-3">
          <div class="text-xs text-cyan-300 font-bold mb-2">法则碎片发放/扣减</div>
          <div class="text-[11px] text-gray-500 mb-2">范围 -1000 ~ 1000</div>
          <div class="mb-2">
            <label class="block text-[11px] text-gray-400 mb-1">碎片类型</label>
            <select v-model="lawFragmentType"
              class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
              <option value="">选择碎片类型</option>
              <option value="space">空间碎片</option>
              <option value="time">时间碎片</option>
              <option value="five_elements">五行碎片</option>
              <option value="soul">魂魄碎片</option>
              <option value="karma">因果碎片</option>
            </select>
          </div>
          <div class="mb-2">
            <label class="block text-[11px] text-gray-400 mb-1">数量</label>
            <input v-model.number="lawFragmentAmount" type="number" placeholder="例如：10 或 -5"
              class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
          </div>
          <button @click="submitLawGrantFragment"
            :disabled="actionLoading || !playerId || !lawFragmentType || lawFragmentAmount === null"
            class="w-full px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded text-white text-sm disabled:opacity-50">
            确认发放碎片
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 后期系统 GM 管理组件脚本
 * 使用 Composition API，6 大子模块共享玩家ID，emit showConfirm 委托二次确认
 */
import { ref, reactive } from 'vue';
import { useUIStore } from '../../../stores/ui';
import {
  gmSecondSoulAdjustAttributes,
  gmSmallWorldReset,
  gmSmallWorldSetLevel,
  gmDivineTempleSetLevel,
  gmIncenseGrant,
  gmDivineSenseGrant,
  gmLawGrantPoints,
  gmLawGrantFragment
} from '../../../api/lateStage';

const uiStore = useUIStore();

/** 父组件事件：showConfirm(title, message, onConfirm) 委托 AdminPanel 二次确认 */
const emit = defineEmits(['showConfirm']);

/** 子 Tab 配置 */
const subTabs = [
  { id: 'second_soul', name: '第二元神' },
  { id: 'small_world', name: '小世界' },
  { id: 'divine_temple', name: '神庙' },
  { id: 'incense', name: '香火' },
  { id: 'divine_sense', name: '神识' },
  { id: 'law', name: '法则' }
];
/** 当前子 Tab */
const currentSubTab = ref('second_soul');

/** 共享：目标玩家ID */
const playerId = ref<number | null>(null);
/** 全局操作 loading */
const actionLoading = ref(false);

/** 第二元神属性调整表单 */
const secondSoulForm = reactive({
  soulIndex: 2 as 2 | 3,
  atk: null as number | null,
  def: null as number | null,
  hpMax: null as number | null,
  speed: null as number | null,
  sense: null as number | null
});

/** 小世界等级 */
const smallWorldLevel = ref<number | null>(null);
/** 神庙等级 */
const templeLevel = ref<number | null>(null);
/** 香火发放数量 */
const incenseAmount = ref<number | null>(null);
/** 神识发放数量 */
const divineSenseAmount = ref<number | null>(null);
/** 法则点发放数量 */
const lawPointsAmount = ref<number | null>(null);
/** 法则碎片类型 */
const lawFragmentType = ref<'space' | 'time' | 'five_elements' | 'soul' | 'karma' | ''>('');
/** 法则碎片数量 */
const lawFragmentAmount = ref<number | null>(null);

/**
 * 校验玩家ID 是否已填写
 * @returns 是否通过校验
 */
function validatePlayerId(): boolean {
  if (!playerId.value || playerId.value <= 0) {
    uiStore.showToast('请输入有效的玩家ID', 'warning');
    return false;
  }
  return true;
}

/**
 * 提交：调整副元神属性
 * 仅传非空字段，由后端按字段覆盖
 */
function submitSecondSoulAdjust() {
  if (!validatePlayerId()) return;
  // 至少填一个属性
  if (secondSoulForm.atk === null && secondSoulForm.def === null &&
      secondSoulForm.hpMax === null && secondSoulForm.speed === null &&
      secondSoulForm.sense === null) {
    uiStore.showToast('请至少填写一个待调整的属性', 'warning');
    return;
  }
  // 构造仅含非空字段的属性对象
  const attributes: Record<string, number> = {};
  if (secondSoulForm.atk !== null) attributes.atk = secondSoulForm.atk;
  if (secondSoulForm.def !== null) attributes.def = secondSoulForm.def;
  if (secondSoulForm.hpMax !== null) attributes.hp_max = secondSoulForm.hpMax;
  if (secondSoulForm.speed !== null) attributes.speed = secondSoulForm.speed;
  if (secondSoulForm.sense !== null) attributes.sense = secondSoulForm.sense;

  emit('showConfirm',
    '调整副元神属性',
    `确认调整玩家 ID=${playerId.value} 的第 ${secondSoulForm.soulIndex} 元神属性？\n${JSON.stringify(attributes)}`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await gmSecondSoulAdjustAttributes(
          playerId.value!,
          secondSoulForm.soulIndex,
          attributes as any
        );
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '副元神属性已调整', 'success');
          // 重置表单
          secondSoulForm.atk = null;
          secondSoulForm.def = null;
          secondSoulForm.hpMax = null;
          secondSoulForm.speed = null;
          secondSoulForm.sense = null;
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
 * 提交：重置小世界
 */
function submitSmallWorldReset() {
  if (!validatePlayerId()) return;
  emit('showConfirm',
    '重置小世界',
    `确认重置玩家 ID=${playerId.value} 的小世界？\n该操作将删除其小世界与神庙记录，不可撤销！`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await gmSmallWorldReset(playerId.value!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '小世界已重置', 'success');
        } else {
          uiStore.showToast(resp.data?.message || '重置失败', 'error');
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
 * 提交：调整小世界等级
 */
function submitSmallWorldSetLevel() {
  if (!validatePlayerId()) return;
  if (!smallWorldLevel.value || smallWorldLevel.value < 1 || smallWorldLevel.value > 10) {
    uiStore.showToast('小世界等级需在 1-10 之间', 'warning');
    return;
  }
  emit('showConfirm',
    '调整小世界等级',
    `确认将玩家 ID=${playerId.value} 的小世界等级调整为 ${smallWorldLevel.value}？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await gmSmallWorldSetLevel(playerId.value!, smallWorldLevel.value!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '小世界等级已调整', 'success');
          smallWorldLevel.value = null;
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
 * 提交：调整神庙等级
 */
function submitTempleSetLevel() {
  if (!validatePlayerId()) return;
  if (!templeLevel.value || templeLevel.value < 1 || templeLevel.value > 10) {
    uiStore.showToast('神庙等级需在 1-10 之间', 'warning');
    return;
  }
  emit('showConfirm',
    '调整神庙等级',
    `确认将玩家 ID=${playerId.value} 的神庙等级调整为 ${templeLevel.value}？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await gmDivineTempleSetLevel(playerId.value!, templeLevel.value!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '神庙等级已调整', 'success');
          templeLevel.value = null;
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
 * 提交：香火发放/扣减
 */
function submitIncenseGrant() {
  if (!validatePlayerId()) return;
  if (incenseAmount.value === null || incenseAmount.value === 0) {
    uiStore.showToast('请输入有效的数量（非零）', 'warning');
    return;
  }
  if (Math.abs(incenseAmount.value) > 1000000) {
    uiStore.showToast('香火调整范围 -1000000 ~ 1000000', 'warning');
    return;
  }
  const action = incenseAmount.value > 0 ? '发放' : '扣减';
  emit('showConfirm',
    `${action}香火`,
    `确认对玩家 ID=${playerId.value} ${action} ${Math.abs(incenseAmount.value)} 香火？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await gmIncenseGrant(playerId.value!, incenseAmount.value!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '香火调整成功', 'success');
          incenseAmount.value = null;
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
 * 提交：神识发放/扣减
 */
function submitDivineSenseGrant() {
  if (!validatePlayerId()) return;
  if (divineSenseAmount.value === null || divineSenseAmount.value === 0) {
    uiStore.showToast('请输入有效的数量（非零）', 'warning');
    return;
  }
  if (Math.abs(divineSenseAmount.value) > 10000) {
    uiStore.showToast('神识调整范围 -10000 ~ 10000', 'warning');
    return;
  }
  const action = divineSenseAmount.value > 0 ? '发放' : '扣减';
  emit('showConfirm',
    `${action}神识`,
    `确认对玩家 ID=${playerId.value} ${action} ${Math.abs(divineSenseAmount.value)} 神识？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await gmDivineSenseGrant(playerId.value!, divineSenseAmount.value!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '神识调整成功', 'success');
          divineSenseAmount.value = null;
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
 * 提交：法则点发放/扣减
 */
function submitLawGrantPoints() {
  if (!validatePlayerId()) return;
  if (lawPointsAmount.value === null || lawPointsAmount.value === 0) {
    uiStore.showToast('请输入有效的数量（非零）', 'warning');
    return;
  }
  if (Math.abs(lawPointsAmount.value) > 10000) {
    uiStore.showToast('法则点调整范围 -10000 ~ 10000', 'warning');
    return;
  }
  const action = lawPointsAmount.value > 0 ? '发放' : '扣减';
  emit('showConfirm',
    `${action}法则点`,
    `确认对玩家 ID=${playerId.value} ${action} ${Math.abs(lawPointsAmount.value)} 法则点？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await gmLawGrantPoints(playerId.value!, lawPointsAmount.value!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '法则点调整成功', 'success');
          lawPointsAmount.value = null;
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
 * 提交：法则碎片发放/扣减
 */
function submitLawGrantFragment() {
  if (!validatePlayerId()) return;
  if (!lawFragmentType.value) {
    uiStore.showToast('请选择碎片类型', 'warning');
    return;
  }
  if (lawFragmentAmount.value === null || lawFragmentAmount.value === 0) {
    uiStore.showToast('请输入有效的数量（非零）', 'warning');
    return;
  }
  if (Math.abs(lawFragmentAmount.value) > 1000) {
    uiStore.showToast('碎片调整范围 -1000 ~ 1000', 'warning');
    return;
  }
  const action = lawFragmentAmount.value > 0 ? '发放' : '扣减';
  emit('showConfirm',
    `${action}法则碎片`,
    `确认对玩家 ID=${playerId.value} ${action} ${Math.abs(lawFragmentAmount.value)} 个 ${lawFragmentType.value} 碎片？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await gmLawGrantFragment(
          playerId.value!,
          lawFragmentType.value as 'space' | 'time' | 'five_elements' | 'soul' | 'karma',
          lawFragmentAmount.value!
        );
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '碎片调整成功', 'success');
          lawFragmentAmount.value = null;
          lawFragmentType.value = '';
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
</script>
