<template>
  <!--
    批次3 多人副本系统 GM 后台管理组件

    功能模块（1 个 Tab，4 个操作模块）：
      1. 强制解散副本（输入 instance_id）
      2. 调整副本变量（输入 instance_id + variable 下拉 + value 数值）
      3. 发放副本奖励（输入 player_id + dungeon_key 下拉 + reward_key 文本）
      4. 重置玩家冷却（输入 player_id + dungeon_key 下拉）

    设计原则：
      - 所有数据通过 multiDungeon.ts 中封装的 GM API 调用
      - 写操作 emit showConfirm 委托父组件 AdminPanel.vue 二次确认
      - 禁用浏览器原生 alert/confirm
      - 玩家ID/实例ID 手动输入，方便 GM 快速操作任意目标
  -->
  <div class="space-y-4">
    <!-- 顶部标题 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-amber-300">多人副本管理</h3>
      <div class="text-xs text-fg-faint">批次3 多人副本系统 GM 操作面板</div>
    </div>

    <!-- ============ 模块 1：强制解散副本 ============ -->
    <div class="bg-surface-raised rounded-lg border border-line p-4">
      <div class="text-sm font-bold text-rose-300 mb-2">强制解散副本</div>
      <div class="text-xs text-fg-faint mb-3">
        · 强制解散指定实例 ID 的多人副本<br>
        · 用于处理卡死/异常的副本实例，所有成员将退出
      </div>
      <div class="mb-3">
        <label class="block text-xs text-fg-muted mb-1">副本实例 ID</label>
        <input v-model.number="forceDissolveForm.instanceId" type="number" min="1" placeholder="例如：1"
          class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
      </div>
      <AppButton variant="danger" size="sm" :disabled="actionLoading || !forceDissolveForm.instanceId" @click="submitForceDissolve">
        {{ actionLoading ? '提交中...' : '强制解散' }}
      </AppButton>
    </div>

    <!-- ============ 模块 2：调整副本变量 ============ -->
    <div class="bg-surface-raised rounded-lg border border-line p-4">
      <div class="text-sm font-bold text-purple-300 mb-2">调整副本变量</div>
      <div class="text-xs text-fg-faint mb-3">
        · 直接覆盖指定副本实例的某项变量值<br>
        · 可调变量与中文名取自内容，共 {{ variableOptions.length }} 个（下拉里选，不再抄一份名单在这里）
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <div>
          <label class="block text-xs text-fg-muted mb-1">副本实例 ID</label>
          <input v-model.number="adjustVariableForm.instanceId" type="number" min="1" placeholder="例如：1"
            class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
        </div>
        <div>
          <label class="block text-xs text-fg-muted mb-1">变量名</label>
          <select v-model="adjustVariableForm.variable"
            class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
            <option value="">请选择变量</option>
            <option v-for="opt in variableOptions" :key="opt.value" :value="opt.value">
              {{ opt.value }}（{{ opt.label }}）
            </option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-fg-muted mb-1">新值</label>
          <input v-model.number="adjustVariableForm.value" type="number" placeholder="例如：80"
            class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
        </div>
      </div>
      <button @click="submitAdjustVariable"
        :disabled="actionLoading || !adjustVariableForm.instanceId || !adjustVariableForm.variable || adjustVariableForm.value === null"
        class="px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded-control text-fg-primary text-sm disabled:opacity-50">
        {{ actionLoading ? '提交中...' : '确认调整' }}
      </button>
    </div>

    <!-- ============ 模块 3：发放副本奖励 ============ -->
    <div class="bg-surface-raised rounded-lg border border-line p-4">
      <div class="text-sm font-bold text-amber-300 mb-2">发放副本奖励</div>
      <div class="text-xs text-fg-faint mb-3">
        · 直接为指定玩家发放副本奖励（绕过副本完成流程）<br>
        · 奖励 key 来自副本奖励池配置，请先确认对应 key 存在
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <div>
          <label class="block text-xs text-fg-muted mb-1">目标玩家 ID</label>
          <input v-model.number="grantRewardForm.playerId" type="number" min="1" placeholder="例如：1"
            class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
        </div>
        <div>
          <label class="block text-xs text-fg-muted mb-1">副本 key</label>
          <select v-model="grantRewardForm.dungeonKey"
            class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
            <option value="">请选择副本</option>
            <option v-for="opt in dungeonKeyOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}（{{ opt.value }}）
            </option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-fg-muted mb-1">奖励 key</label>
          <input v-model="grantRewardForm.rewardKey" type="text" placeholder="例如：spirit_stone_small"
            class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
        </div>
      </div>
      <AppButton variant="primary" size="sm" :disabled="actionLoading || !grantRewardForm.playerId || !grantRewardForm.dungeonKey || !grantRewardForm.rewardKey" @click="submitGrantReward">
        {{ actionLoading ? '提交中...' : '确认发放' }}
      </AppButton>
    </div>

    <!-- ============ 模块 4：重置玩家冷却 ============ -->
    <div class="bg-surface-raised rounded-lg border border-line p-4">
      <div class="text-sm font-bold text-emerald-300 mb-2">重置玩家冷却</div>
      <div class="text-xs text-fg-faint mb-3">
        · 重置指定玩家对应副本的冷却状态<br>
        · 重置后玩家可立即再次开启/加入该副本<br>
        · 选择「全部副本」可一次性重置所有4个副本的冷却
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs text-fg-muted mb-1">目标玩家 ID</label>
          <input v-model.number="resetCooldownForm.playerId" type="number" min="1" placeholder="例如：1"
            class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
        </div>
        <div>
          <label class="block text-xs text-fg-muted mb-1">副本 key</label>
          <select v-model="resetCooldownForm.dungeonKey"
            class="w-full px-3 py-1.5 text-sm bg-surface-sunken border border-line rounded-control text-fg-secondary focus-ring focus:border-gold-600">
            <option value="">请选择副本</option>
            <option v-for="opt in dungeonKeyOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}（{{ opt.value }}）
            </option>
            <option value="all">全部副本（all）</option>
          </select>
        </div>
      </div>
      <AppButton variant="primary" size="sm" :disabled="actionLoading || !resetCooldownForm.playerId || !resetCooldownForm.dungeonKey" @click="submitResetCooldown">
        {{ actionLoading ? '提交中...' : '确认重置' }}
      </AppButton>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 多人副本系统 GM 管理组件脚本
 * 4 个操作模块共享 emit showConfirm 委托二次确认
 */
import { ref, reactive, computed, onMounted } from 'vue';
import { useUIStore } from '../../../stores/ui';
import AppButton from '../../ui/AppButton.vue'
import {
  multiDungeonGetHelp,
  adminForceDissolve,
  adminAdjustVariable,
  adminGrantReward,
  adminResetCooldown,
  type DungeonKey,
  type DungeonVariable
} from '../../../api/multiDungeon';

const uiStore = useUIStore();

/** 父组件事件：showConfirm(title, message, onConfirm) 委托 AdminPanel 二次确认 */
const emit = defineEmits(['showConfirm']);

/** 全局操作 loading */
const actionLoading = ref(false);

/** 强制解散表单 */
const forceDissolveForm = reactive({
  instanceId: null as number | null
});

/** 调整变量表单 */
const adjustVariableForm = reactive({
  instanceId: null as number | null,
  variable: '' as '' | DungeonVariable,
  value: null as number | null
});

/** 发放奖励表单 */
const grantRewardForm = reactive({
  playerId: null as number | null,
  dungeonKey: '' as '' | DungeonKey,
  rewardKey: ''
});

/** 重置冷却表单（2026-07-21 dungeonKey 支持 'all' 重置全部） */
const resetCooldownForm = reactive({
  playerId: null as number | null,
  dungeonKey: '' as '' | DungeonKey | 'all'
});

/**
 * /help 的返回：副本清单（dungeon_key → 中文名）与变量元信息（列名 → 中文名/归属副本）。
 * 这两个下拉以前是本文件手写的两份名单（4 个副本、15 个变量），
 * 而内容里有 10 个副本、40 个变量 —— 另外 6 个副本的奖励与冷却没法重置，
 * 坠魔谷/血色试炼/苍坤洞府/黄龙山的变量在 GM 面板里选都选不到。
 */
const helpData = ref<MDungeonHelpPayload | null>(null);
/** 副本变量选项：取自 /help 的 variable_meta */
const variableOptions = computed<Array<{ value: DungeonVariable; label: string }>>(() =>
  Object.entries(helpData.value?.variable_meta || {}).map(([value, meta]) => ({ value, label: meta?.label || value }))
);

/** GET /multi-dungeon/help → data（GM 面板只用得到这两块） */
interface MDungeonHelpPayload {
  dungeons?: Record<string, { name?: string }>;
  variable_meta?: Record<string, { label?: string; dungeons?: string[] | null }>;
}

/** 副本 key 选项：取自 /help 的 dungeons */
const dungeonKeyOptions = computed<Array<{ value: DungeonKey; label: string }>>(() =>
  Object.entries(helpData.value?.dungeons || {}).map(([value, dgn]) => ({ value, label: dgn?.name || value }))
);

/** 进面板就拉一次清单；拉不到要让 GM 看见，而不是留一个空下拉 */
onMounted(async () => {
  try {
    const resp = await multiDungeonGetHelp();
    if (resp.data?.code === 200 && resp.data.data) helpData.value = resp.data.data as MDungeonHelpPayload;
    else uiStore.showToast(resp.data?.message || '获取副本/变量清单失败', 'error');
  } catch (e: any) {
    uiStore.showToast(e?.message || '获取副本/变量清单失败', 'error');
  }
});

/**
 * 校验实例 ID 是否已填写
 * @param instanceId 实例 ID
 * @returns 是否通过校验
 */
function validateInstanceId(instanceId: number | null): boolean {
  if (!instanceId || instanceId <= 0) {
    uiStore.showToast('请输入有效的副本实例 ID', 'warning');
    return false;
  }
  return true;
}

/**
 * 校验玩家 ID 是否已填写
 * @param playerId 玩家 ID
 * @returns 是否通过校验
 */
function validatePlayerId(playerId: number | null): boolean {
  if (!playerId || playerId <= 0) {
    uiStore.showToast('请输入有效的玩家 ID', 'warning');
    return false;
  }
  return true;
}

/**
 * 提交：强制解散副本
 */
function submitForceDissolve() {
  if (!validateInstanceId(forceDissolveForm.instanceId)) return;
  emit('showConfirm',
    '强制解散副本',
    `确认强制解散副本实例 ID=${forceDissolveForm.instanceId}？\n· 操作不可撤销\n· 所有成员将立即退出副本`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminForceDissolve(forceDissolveForm.instanceId!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '副本已强制解散', 'success');
          forceDissolveForm.instanceId = null;
        } else {
          uiStore.showToast(resp.data?.message || '解散失败', 'error');
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
 * 提交：调整副本变量
 */
function submitAdjustVariable() {
  if (!validateInstanceId(adjustVariableForm.instanceId)) return;
  if (!adjustVariableForm.variable) {
    uiStore.showToast('请选择变量名', 'warning');
    return;
  }
  if (adjustVariableForm.value === null || adjustVariableForm.value < 0) {
    uiStore.showToast('请输入有效的变量值（非负数）', 'warning');
    return;
  }
  const varLabel = variableOptions.value.find(o => o.value === adjustVariableForm.variable)?.label || adjustVariableForm.variable;
  emit('showConfirm',
    '调整副本变量',
    `确认将副本实例 ID=${adjustVariableForm.instanceId} 的「${varLabel}」调整为 ${adjustVariableForm.value}？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminAdjustVariable(
          adjustVariableForm.instanceId!,
          adjustVariableForm.variable as DungeonVariable,
          adjustVariableForm.value!
        );
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '副本变量已调整', 'success');
          adjustVariableForm.instanceId = null;
          adjustVariableForm.variable = '';
          adjustVariableForm.value = null;
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
 * 提交：发放副本奖励
 */
function submitGrantReward() {
  if (!validatePlayerId(grantRewardForm.playerId)) return;
  if (!grantRewardForm.dungeonKey) {
    uiStore.showToast('请选择副本', 'warning');
    return;
  }
  if (!grantRewardForm.rewardKey || !grantRewardForm.rewardKey.trim()) {
    uiStore.showToast('请输入奖励 key', 'warning');
    return;
  }
  const dgnLabel = dungeonKeyOptions.value.find(o => o.value === grantRewardForm.dungeonKey)?.label || grantRewardForm.dungeonKey;
  emit('showConfirm',
    '发放副本奖励',
    `确认向玩家 ID=${grantRewardForm.playerId} 发放副本「${dgnLabel}」的奖励「${grantRewardForm.rewardKey}」？`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminGrantReward(
          grantRewardForm.playerId!,
          grantRewardForm.dungeonKey as DungeonKey,
          grantRewardForm.rewardKey.trim()
        );
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '副本奖励已发放', 'success');
          grantRewardForm.playerId = null;
          grantRewardForm.dungeonKey = '';
          grantRewardForm.rewardKey = '';
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
 * 提交：重置玩家冷却
 * 2026-07-21 扩展：支持 'all' 一次性重置所有副本冷却
 */
function submitResetCooldown() {
  if (!validatePlayerId(resetCooldownForm.playerId)) return;
  if (!resetCooldownForm.dungeonKey) {
    uiStore.showToast('请选择副本', 'warning');
    return;
  }
  // 'all' 特殊文案，其他副本查表获取中文名
  const dgnLabel = resetCooldownForm.dungeonKey === 'all'
    ? '全部副本'
    : (dungeonKeyOptions.value.find(o => o.value === resetCooldownForm.dungeonKey)?.label || resetCooldownForm.dungeonKey);
  emit('showConfirm',
    '重置玩家冷却',
    `确认重置玩家 ID=${resetCooldownForm.playerId} 的副本「${dgnLabel}」冷却？\n· 重置后玩家可立即再次开启/加入该副本`,
    async () => {
      actionLoading.value = true;
      try {
        const resp = await adminResetCooldown(
          resetCooldownForm.playerId!,
          resetCooldownForm.dungeonKey as DungeonKey | 'all'
        );
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '冷却已重置', 'success');
          resetCooldownForm.playerId = null;
          resetCooldownForm.dungeonKey = '';
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
</script>
