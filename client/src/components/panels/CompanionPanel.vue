/**
 * 道侣面板组件
 *
 * 批次3 道侣 / 双修 / 心契 / 心劫 子模块前端 UI
 *
 * Tab 划分：
 *   1. 道侣关系：当前道侣状态、寻找道侣、解除道侣（后端暂无邀请列表接口，接受邀请区块待字段补齐）
 *   2. 双修互动：闭关双修 / 温养 / 采补 / 立誓（3 种类型）
 *   3. 心契：心契等级、双修累计进度、各等级加成说明
 *   4. 心劫：待处理心劫事件列表、3 选项抉择
 *
 * 设计原则：
 *   - 状态从后端 GET /companion/profile 拉取，禁止硬编码
 *   - 温养 / 采补的当日次数三个 GET 接口都不下发，仅由对应 POST 的
 *     daily_count / daily_limit 回填，未回填前界面显示「未知」
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色统一取设计令牌（surface-* / line-* / fg-* / gold-*，见 styles/tokens.css）
 *   - 外壳与标签页走 ui/PanelShell.vue + ui/Tabs.vue，全部使用 Tailwind 工具类
 *   - 加载/空态一律放在标签页内容里（见 PanelShell 顶部警告：交给外壳会连标签页一起藏掉）
 */
<template>
  <PanelShell
    title="道侣 · 双修心契"
    hint="寻觅道侣 · 双修互动 · 心契 · 心劫"
    size="xl"
    @close="$emit('close')"
  >
    <!-- Tab 切换栏（切换时按需懒加载，见 switchTab） -->
    <Tabs :model-value="activeTab" :items="tabItems" class="mb-3" @update:model-value="switchTab" />

    <!-- ============ Tab 1: 道侣关系 ============ -->
    <div v-show="activeTab === 'relation'" class="space-y-3">
      <LoadingBlock v-if="loading.profile && !profile" text="加载道侣档案中…" />
      <!-- 无道侣 -->
      <PanelCard v-else-if="!profile?.has_companion">
        <div class="text-sm font-bold text-rose-300 mb-3">寻觅道侣</div>
        <div class="text-xs text-fg-muted space-y-1 mb-4">
          <div>· 道侣同行，双修互补，可立誓护道、共修、守秘</div>
          <div>· 心契逐级加深可解锁护道、共修等加成</div>
          <div>· 输入对方玩家 ID 发起道侣邀请，待对方同意后即可结侣</div>
        </div>
        <!-- 寻找道侣输入框 -->
        <div class="flex items-center gap-2">
          <input v-model.number="seekTargetId" type="number" min="1" placeholder="对方玩家 ID（数字）"
            class="flex-1 bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus-ring" />
          <AppButton variant="danger" size="sm" :disabled="loading.action || !seekTargetId" @click="handleSeek">
            发起邀请
          </AppButton>
        </div>

        <!-- 待处理邀请列表：后端目前没有任何邀请列表接口，profile 也从不返回 pending_invitations，
             故这块在接口补齐前恒不渲染（保留标记与同意结侣的流程，等后端补字段即可直接复用） -->
        <div v-if="profile?.pending_invitations?.length" class="mt-4">
          <div class="text-xs text-gold-300 font-bold mb-2">待您回应的道侣邀请</div>
          <div class="space-y-2">
            <div v-for="inv in profile.pending_invitations" :key="inv.companion_id"
              class="bg-surface-sunken/60 border border-line rounded-control p-3 text-xs flex items-center justify-between">
              <div>
                <div class="text-rose-300 font-bold">{{ inv.from_player_name }}</div>
                <div class="text-fg-faint text-[11px]">
                  ID: {{ inv.from_player_id }} · 境界：{{ inv.from_player_realm }} · 邀请时间：{{ formatTime(inv.created_at) }}
                </div>
              </div>
              <button @click="handleAccept(inv.companion_id)"
                :disabled="loading.action"
                class="px-3 py-1.5 rounded-control bg-emerald-700 text-emerald-100 hover:bg-emerald-600 disabled:opacity-50">
                同意结侣
              </button>
            </div>
          </div>
        </div>
      </PanelCard>

      <!-- 已有道侣 -->
      <PanelCard v-else>
        <div class="flex items-center justify-between mb-3">
          <div class="text-sm font-bold text-rose-300">道侣信息</div>
          <Badge tone="danger">已结侣</Badge>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div>
            <div class="text-fg-faint">对方道号</div>
            <div class="text-rose-300 font-bold">{{ profile?.partner?.nickname || '未知' }}</div>
          </div>
          <div>
            <div class="text-fg-faint">对方境界</div>
            <div class="text-gold-300 font-bold">{{ profile?.partner?.realm || '未知' }}</div>
          </div>
          <div>
            <div class="text-fg-faint">心印</div>
            <div class="text-pink-300 font-bold num" :title="`已种心印 ${companion?.heart_imprint_count ?? 0} 次`">
              {{ formatCompact(companion?.heart_imprint_count ?? 0) }}
            </div>
          </div>
          <div>
            <div class="text-fg-faint">双修累计</div>
            <div class="text-emerald-300 font-bold num" :title="`累计双修 ${companion?.dual_cultivation_count_total ?? 0} 次`">
              {{ formatCompact(companion?.dual_cultivation_count_total ?? 0) }}
            </div>
          </div>
          <div>
            <div class="text-fg-faint">心契等级</div>
            <div class="text-purple-300 font-bold num">Lv.{{ companion?.heart_contract_level ?? 0 }}</div>
          </div>
        </div>

        <!-- 今日双修进度（后端 profile 无亲密度字段，进度条改用真实下发的当日双修次数） -->
        <div class="mt-3">
          <div class="flex items-center justify-between text-[11px] mb-1">
            <span class="text-fg-faint">今日双修</span>
            <span v-if="dualCultivationCount !== null && dualCultivationLimit !== null" class="text-gold-300 font-bold num">
              {{ dualCultivationCount }} / {{ dualCultivationLimit }}
            </span>
            <span v-else class="text-fg-faint">未知</span>
          </div>
          <div class="h-1.5 bg-surface-sunken border border-line-subtle rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-rose-600 to-pink-400 transition-all"
              :style="{ width: `${dailyDualCultivationPercent}%` }"></div>
          </div>
        </div>

        <!-- 双修 / 温养 / 采补 当日次数：温养与采补 GET 不下发，仅由对应 POST 回填，未回填前显示未知 -->
        <div class="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <div class="bg-surface-sunken/60 rounded-control p-2 text-center">
            <div class="text-fg-faint">双修今日</div>
            <div v-if="dualCultivationCount !== null && dualCultivationLimit !== null" class="text-gold-300 font-bold num"
              :title="`今日双修 ${dualCultivationCount} / ${dualCultivationLimit} 次`">
              {{ dualCultivationCount }} / {{ dualCultivationLimit }}
            </div>
            <div v-else class="text-fg-faint">未知</div>
          </div>
          <div class="bg-surface-sunken/60 rounded-control p-2 text-center">
            <div class="text-fg-faint">温养今日</div>
            <div v-if="warmNourishCount !== null && warmNourishLimit !== null" class="text-cyan-300 font-bold num"
              :title="`今日温养 ${warmNourishCount} / ${warmNourishLimit} 次`">
              {{ warmNourishCount }} / {{ warmNourishLimit }}
            </div>
            <div v-else class="text-fg-faint">未知</div>
          </div>
          <div class="bg-surface-sunken/60 rounded-control p-2 text-center">
            <div class="text-fg-faint">采补今日</div>
            <div v-if="pluckSupplementCount !== null && pluckSupplementLimit !== null" class="text-rose-300 font-bold num"
              :title="`今日采补 ${pluckSupplementCount} / ${pluckSupplementLimit} 次`">
              {{ pluckSupplementCount }} / {{ pluckSupplementLimit }}
            </div>
            <div v-else class="text-fg-faint">未知</div>
          </div>
        </div>

        <!-- 已立誓：后端只保留一条当前誓言（vow_type / vow_expire_time / vow_broken），不是列表 -->
        <div v-if="vowDisplay" class="mt-3">
          <div class="text-[11px] text-fg-faint mb-1">已立誓言：</div>
          <div class="flex flex-wrap items-center gap-1">
            <Badge tone="arcane">{{ vowDisplay?.label }}</Badge>
            <Badge v-if="vowDisplay?.broken" tone="danger">已毁誓</Badge>
            <span v-if="vowDisplay?.expireText" class="text-[11px] text-fg-faint num">{{ vowDisplay?.expireText }}</span>
          </div>
        </div>

        <!-- 解除道侣 -->
        <div class="mt-4 grid grid-cols-2 gap-2">
          <AppButton variant="default" size="sm" block :disabled="loading.action" @click="handleBreak('agreement')">
            和离（双方同意）
          </AppButton>
          <AppButton variant="danger" size="sm" block :disabled="loading.action" @click="handleBreak('vow_break')">
            毁誓解除（心契归零）
          </AppButton>
        </div>
      </PanelCard>
    </div>

    <!-- ============ Tab 2: 双修互动 ============ -->
    <div v-show="activeTab === 'dual_cultivate'" class="space-y-3">
      <EmptyState
        v-if="!profile?.has_companion"
        text="尚未结侣，无法双修互动"
        hint="请先在「道侣关系」中寻得道侣"
      />
      <template v-else>
        <!-- 双修 -->
        <PanelCard>
          <div class="text-sm font-bold text-gold-300 mb-2">闭关双修</div>
          <div class="text-[11px] text-fg-muted mb-3">
            · 主方修为 +5%，日上限
            <span v-if="dualCultivationLimit !== null" class="text-gold-300 font-bold num">{{ dualCultivationLimit }}</span>
            <span v-else class="text-fg-faint">未知</span>
            次<br>
            · 今日已用
            <span v-if="dualCultivationCount !== null" class="text-gold-300 font-bold num">{{ dualCultivationCount }}</span>
            <span v-else class="text-fg-faint">未知</span>
            次
          </div>
          <AppButton variant="primary" size="sm" block
            :disabled="loading.action || isDailyLimitReached(dualCultivationCount, dualCultivationLimit)"
            @click="handleDualCultivate">
            {{ isDailyLimitReached(dualCultivationCount, dualCultivationLimit) ? '今日次数已满' : '开始双修' }}
          </AppButton>
        </PanelCard>

        <!-- 温养 -->
        <PanelCard>
          <div class="text-sm font-bold text-cyan-300 mb-2">温养</div>
          <div class="text-[11px] text-fg-muted mb-3">
            · 双方修为 +3%<br>
            · 今日已用：
            <span v-if="warmNourishCount !== null && warmNourishLimit !== null" class="text-cyan-300 font-bold num">{{ warmNourishCount }} / {{ warmNourishLimit }}</span>
            <span v-else class="text-fg-faint">未知（完成一次温养后显示）</span>
          </div>
          <button @click="handleWarmNourish"
            :disabled="loading.action || isDailyLimitReached(warmNourishCount, warmNourishLimit)"
            class="w-full py-2 rounded-control text-xs font-bold bg-cyan-700 text-cyan-100 hover:bg-cyan-600 disabled:opacity-50">
            {{ isDailyLimitReached(warmNourishCount, warmNourishLimit) ? '今日次数已满' : '开始温养' }}
          </button>
        </PanelCard>

        <!-- 采补 -->
        <PanelCard>
          <div class="text-sm font-bold text-rose-300 mb-2">采补</div>
          <div class="text-[11px] text-fg-muted mb-3">
            · 主方 +10%，副方 -3%<br>
            · 今日已用：
            <span v-if="pluckSupplementCount !== null && pluckSupplementLimit !== null" class="text-rose-300 font-bold num">{{ pluckSupplementCount }} / {{ pluckSupplementLimit }}</span>
            <span v-else class="text-fg-faint">未知（完成一次采补后显示）</span><br>
            · <span class="text-rose-400">高风险操作：将损耗对方修为，请谨慎抉择</span>
          </div>
          <AppButton variant="danger" size="sm" block
            :disabled="loading.action || isDailyLimitReached(pluckSupplementCount, pluckSupplementLimit)"
            @click="handlePluckSupplement">
            {{ isDailyLimitReached(pluckSupplementCount, pluckSupplementLimit) ? '今日次数已满' : '采补修行' }}
          </AppButton>
        </PanelCard>

        <!-- 立誓 -->
        <PanelCard>
          <div class="text-sm font-bold text-purple-300 mb-2">立誓</div>
          <div class="text-[11px] text-fg-muted mb-3">
            · 三种誓言同时只生效一条，改立即覆盖旧誓（后端无撤销接口）<br>
            · 已立誓：{{ vowDisplay ? vowDisplay.label : '无' }}
          </div>
          <div class="grid grid-cols-3 gap-2">
            <button v-for="vow in vowTypes" :key="vow.value"
              @click="handleVow(vow.value)"
              :disabled="loading.action || isVowActivated(vow.value)"
              :class="[
                'py-2 rounded-control text-xs font-bold border disabled:opacity-50',
                isVowActivated(vow.value)
                  ? 'bg-purple-950/40 border-purple-800 text-purple-300 cursor-not-allowed'
                  : 'bg-purple-700 text-purple-100 hover:bg-purple-600 border-purple-500'
              ]">
              {{ isVowActivated(vow.value) ? '已立' : vow.label }}
            </button>
          </div>
          <div class="mt-2 text-[11px] text-fg-faint space-y-1">
            <div>· 护道：道侣受袭时，主方可代为承受部分伤害</div>
            <div>· 守秘：双方身份与秘密互不外泄，心契加深更快</div>
            <div>· 共修：双修效果额外提升</div>
          </div>
        </PanelCard>
      </template>
    </div>

    <!-- ============ Tab 3: 心契 ============ -->
    <div v-show="activeTab === 'heart_contract'" class="space-y-3">
      <LoadingBlock v-if="loading.heartContract" text="加载心契数据中…" />
      <template v-else-if="heartContractData?.has_companion">
        <PanelCard>
          <div class="text-sm font-bold text-purple-300 mb-3">心契等级</div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <div class="text-fg-faint">当前等级</div>
              <div class="text-purple-300 font-bold text-lg num">Lv.{{ heartContractData.heart_contract_level }}</div>
            </div>
            <div>
              <div class="text-fg-faint">双修累计</div>
              <!-- 心契进度由累计双修次数驱动（后端无经验字段）；BigInt 级数字走 formatCompact，精确值挂 title -->
              <div class="text-gold-300 font-bold num"
                :title="`累计双修 ${heartContractData.dual_cultivation_count_total} 次`">
                {{ formatCompact(heartContractData.dual_cultivation_count_total) }}
              </div>
            </div>
            <div>
              <div class="text-fg-faint">下一级门槛</div>
              <div v-if="heartContractData.next_level_threshold !== null" class="text-cyan-300 font-bold num"
                :title="`再累计到 ${heartContractData.next_level_threshold} 次双修升级`">
                {{ formatCompact(heartContractData.next_level_threshold) }}
              </div>
              <div v-else class="text-fg-faint">已达上限</div>
            </div>
            <div>
              <div class="text-fg-faint">等级上限</div>
              <div class="text-rose-300 font-bold num">Lv.{{ heartContractMaxLevel }}</div>
            </div>
          </div>
          <!-- 心契升级进度条：后端 progress 已是 0..1，这里不再除一次 -->
          <div class="mt-3 h-1.5 bg-surface-sunken border border-line-subtle rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-purple-600 to-pink-400 transition-all"
              :style="{ width: `${heartContractProgressPercent}%` }"></div>
          </div>
          <div class="text-[11px] text-fg-faint mt-1">
            · 当前加成：<span class="text-emerald-300">{{ currentLevelEffect || '暂无（心契尚未达到 1 级）' }}</span>
          </div>
          <div v-if="nextLevelEffect" class="text-[11px] text-fg-faint mt-1">
            · 下一级加成：<span class="text-cyan-300">{{ nextLevelEffect }}</span>
          </div>
        </PanelCard>

        <!-- 心契各等级加成说明：后端 level_effects 是「等级 → 描述」字典 -->
        <PanelCard>
          <div class="text-sm font-bold text-purple-300 mb-3">心契加成说明</div>
          <div class="space-y-2">
            <div v-for="bonus in heartContractBonuses" :key="bonus.level"
              class="bg-surface-sunken/60 border border-line rounded-control p-2 text-xs">
              <div class="flex items-center justify-between mb-1">
                <span class="text-purple-300 font-bold">Lv.<span class="num">{{ bonus.level }}</span></span>
                <Badge v-if="isLevelActivated(bonus.level)" tone="success">已激活</Badge>
                <Badge v-else tone="muted">未激活</Badge>
              </div>
              <div class="text-fg-muted text-[11px]">{{ bonus.description }}</div>
            </div>
          </div>
        </PanelCard>

        <!-- 当前生效加成：取自 level_effects 中等级不大于当前心契等级的条目 -->
        <PanelCard v-if="activeLevelBonuses.length">
          <div class="text-sm font-bold text-emerald-300 mb-2">当前生效加成</div>
          <ul class="text-xs text-fg-secondary space-y-1">
            <li v-for="bonus in activeLevelBonuses" :key="bonus.level" class="flex items-start gap-2">
              <span class="text-emerald-400">·</span>
              <span><span class="text-purple-300 num">Lv.{{ bonus.level }}</span> {{ bonus.description }}</span>
            </li>
          </ul>
        </PanelCard>
      </template>
      <EmptyState v-else text="尚未结侣，无心契数据" />
    </div>

    <!-- ============ Tab 4: 心劫 ============ -->
    <div v-show="activeTab === 'heart_tribulation'" class="space-y-3">
      <LoadingBlock v-if="loading.heartTribulation" text="加载心劫事件中…" />
      <template v-else-if="heartTribulationData">
        <EmptyState
          v-if="!heartTribulationData.count"
          text="当前无待处理心劫"
          hint="心劫由后端在道侣互动中触发，一旦触发须在到期前完成抉择"
        />
        <div v-else class="space-y-3">
          <div class="text-xs text-fg-faint">
            待处理心劫 <span class="text-rose-300 font-bold num">{{ heartTribulationData.count }}</span> 条
          </div>
          <div v-for="event in heartTribulationData.pending_events" :key="event.event_id"
            class="bg-surface-raised border border-rose-900/50 rounded-panel p-4">
            <div class="flex items-center justify-between mb-2">
              <div class="text-sm font-bold text-rose-300">{{ getEventTypeLabel(event.event_type) }}</div>
              <Badge tone="danger">事件 <span class="num">{{ event.event_id }}</span></Badge>
            </div>
            <div class="text-xs text-fg-secondary mb-3 num">
              · 触发于 {{ formatTime(event.created_at) }} · 抉择截止 {{ formatTime(event.expires_at) }}
            </div>
            <!-- 抉择选项：后端 options 是以选项键为索引的字典，非数组 -->
            <div v-if="tribulationChoices(event).length" class="grid grid-cols-1 md:grid-cols-3 gap-2">
              <button v-for="choice in tribulationChoices(event)" :key="choice.key"
                @click="handleChooseTribulation(event.event_id, choice.key)"
                :disabled="loading.action || !choice.submittable"
                class="bg-surface-sunken/60 border border-line-subtle rounded-control p-2 text-xs text-left hover:bg-surface-hover disabled:opacity-50">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-gold-300 font-bold">{{ choice.label }}</span>
                  <span class="text-[10px] text-emerald-300 num">成功率 {{ (choice.opt.success_rate * 100).toFixed(0) }}%</span>
                </div>
                <div class="text-fg-faint text-[11px] space-y-0.5">
                  <div v-if="choice.opt.intimacy_gain !== undefined" class="num">
                    · 亲密度：{{ choice.opt.intimacy_gain >= 0 ? '+' : '' }}{{ choice.opt.intimacy_gain }}
                  </div>
                  <div v-if="choice.opt.remnant_soul_cost !== undefined" class="num">
                    · 残魂消耗：{{ choice.opt.remnant_soul_cost }}
                  </div>
                  <div v-if="choice.opt.description">{{ choice.opt.description }}</div>
                  <div v-if="!choice.submittable" class="text-rose-300">· 此抉择项后端暂未开放提交</div>
                </div>
              </button>
            </div>
            <div v-else class="text-[11px] text-fg-faint">该事件未下发可抉择的选项</div>
          </div>
        </div>
      </template>
      <EmptyState v-else text="尚未结侣，无心劫" />
    </div>

    <!-- 二次确认弹窗（通用） -->
    <Modal :isOpen="confirmModal.show" :title="confirmModal.title" @close="confirmModal.show = false" width="420px">
      <p class="text-fg-secondary text-sm whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <AppButton variant="default" size="sm" @click="confirmModal.show = false">取消</AppButton>
        <AppButton variant="danger" size="sm" :disabled="loading.action" @click="confirmModal.onConfirm(); confirmModal.show = false">
          确认
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 道侣面板组件脚本
 * 使用 Composition API，所有状态从后端拉取，禁止硬编码业务数据
 */
import { ref, reactive, computed, onMounted } from 'vue';
import { formatBeijing } from '../../utils/time';
import Modal from '../common/Modal.vue';
import PanelShell from '../ui/PanelShell.vue';
import Tabs from '../ui/Tabs.vue';
import PanelCard from '../ui/PanelCard.vue';
import Badge from '../ui/Badge.vue';
import AppButton from '../ui/AppButton.vue';
import EmptyState from '../ui/EmptyState.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
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
  companionChooseHeartTribulation
} from '../../api/companion';
// 修复 4-3-P1-2：引入 formatCompact 处理 BigInt 字符串显示
import { formatCompact } from '../../utils/format';

// ==================== 后端真实载荷类型 ====================
// api/companion.ts 里的 CompanionProfileData / HeartContractData / HeartTribulationListData
// 是早于后端实现的陈旧结构（profile 实为扁平记录、心契无 heart_contract 嵌套、
// 心劫字段名为 pending_events / count）。在该文件类型修正前，此处按
// server/game/services/CompanionService.js 的实际返回补一份窄类型，只在取值处断言。

/** 道侣对方信息（partner 为 null 表示查不到对方角色） */
interface CompanionPartnerPayload {
  id: number;
  nickname: string;
  realm: string;
}

/** 当前誓言：后端只保留一条，不是列表 */
interface CompanionVowPayload {
  vow_type: string;
  vow_expire_time: string | null;
  vow_broken: boolean;
}

/** 单条待处理心劫事件（profile.pending_tribulation 与 heart-tribulation 列表同构） */
interface HeartTribulationEventPayload {
  event_id: number;
  event_type: string;
  companion_id?: number | null;
  concubine_id?: number | null;
  /** 抉择项字典：以选项键为索引的对象，不是数组 */
  options?: Record<string, HeartTribulationOptionPayload> | null;
  expires_at?: string;
  created_at?: string;
}

/** GET /companion/profile —— CompanionService.getProfile */
interface CompanionProfilePayload {
  has_companion: boolean;
  /** 以下三项仅在 has_companion=false 时下发 */
  can_seek?: boolean;
  min_realm_name?: string;
  seek_cost_spirit_stones?: number;
  /** 以下字段仅在 has_companion=true 时下发 */
  relation_state?: string;
  companion_id?: number;
  partner?: CompanionPartnerPayload | null;
  heart_contract_level?: number;
  heart_imprint_count?: number;
  dual_cultivation_count_total?: number;
  daily_dual_cultivation_count?: number;
  daily_dual_cultivation_limit?: number;
  vow?: CompanionVowPayload | null;
  heart_tribulation_count?: number;
  pending_tribulation?: HeartTribulationEventPayload | null;
  created_at?: string;
  broken_at?: string | null;
  /** 后端没有邀请列表接口，该字段永不下发；保留声明以让占位区块类型可用且恒不渲染 */
  pending_invitations?: Array<{
    companion_id: number;
    from_player_id: number;
    from_player_name: string;
    from_player_realm: string;
    created_at: string;
  }>;
}

/** GET /companion/heart-contract —— CompanionService.getHeartContract（字段全为扁平） */
interface HeartContractPayload {
  has_companion: boolean;
  heart_contract_level: number;
  dual_cultivation_count_total: number;
  /** 已满级时为 null */
  next_level_threshold: number | null;
  /** 后端已算好的 0..1 进度，前端不要再除一次 */
  progress: number;
  /** 无道侣时后端只回上面四个字段，以下三项届时不下发 */
  heart_imprint_count?: number;
  level_thresholds?: number[];
  /** 等级 → 加成描述，如 { "1": "双修加成 +5%" } */
  level_effects?: Record<string, string>;
}

/** 心劫抉择选项（companion_data.json 的 heart_tribulation.options，以及旧配置的 trust/doubt/trial） */
interface HeartTribulationOptionPayload {
  /** 0..1 */
  success_rate: number;
  /** 选项中文名；新系统的三选一键为 steady/ruthless/deceive，后端不下发名称 */
  name?: string;
  /** 亲密度变化（正为增益） */
  intimacy_gain?: number;
  /** 残魂消耗；部分事件类型不下发此项 */
  remnant_soul_cost?: number;
  /** 选项说明；部分事件类型不下发此项 */
  description?: string;
}

/** GET /companion/heart-tribulation —— CompanionService.getHeartTribulation */
interface HeartTribulationListPayload {
  pending_events: HeartTribulationEventPayload[];
  count: number;
}

/** 心劫抉择项：键即后端校验的三选一 */
type HeartTribulationChoice = 'steady' | 'ruthless' | 'deceive';

/** 抉择项中文名（后端只下发选项键，界面用中文呈现） */
const TRIBULATION_CHOICE_LABELS: Record<HeartTribulationChoice, string> = {
  steady: '稳',
  ruthless: '狠',
  deceive: '骗'
};

const uiStore = useUIStore();

/** Tab 配置 */
const tabItems = [
  { key: 'relation', label: '道侣关系' },
  { key: 'dual_cultivate', label: '双修互动' },
  { key: 'heart_contract', label: '心契' },
  { key: 'heart_tribulation', label: '心劫' }
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

/** 各模块数据（载荷结构见上方本地类型，与 api/companion.ts 的陈旧声明无关） */
const profile = ref<CompanionProfilePayload | null>(null);
const heartContractData = ref<HeartContractPayload | null>(null);
const heartTribulationData = ref<HeartTribulationListPayload | null>(null);

/**
 * 温养 / 采补的当日次数：三个 GET 接口都不返回这两项，
 * 只有对应的 POST 成功时才带回 daily_count / daily_limit，故只在本面板会话内回填。
 * 未回填前为 null，界面显示「未知」，绝不印 0/1 这类伪造数字。
 */
const warmNourishDaily = ref<{ count: number; limit: number } | null>(null);
const pluckSupplementDaily = ref<{ count: number; limit: number } | null>(null);
const warmNourishCount = computed(() => warmNourishDaily.value?.count ?? null);
const warmNourishLimit = computed(() => warmNourishDaily.value?.limit ?? null);
const pluckSupplementCount = computed(() => pluckSupplementDaily.value?.count ?? null);
const pluckSupplementLimit = computed(() => pluckSupplementDaily.value?.limit ?? null);

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
 * 计算属性：当前道侣记录
 * 后端 profile 本身就是道侣记录（扁平结构，无 companion 子对象），
 * 未结侣时返回 null，保持模板里 companion?.xxx 这套可空链的语义
 */
const companion = computed<CompanionProfilePayload | null>(
  () => (profile.value?.has_companion ? profile.value : null)
);

/** 今日双修已用次数（profile 直发，缺字段时为 null） */
const dualCultivationCount = computed(() => profile.value?.daily_dual_cultivation_count ?? null);
/** 双修日上限（来自后端配置，profile 直发） */
const dualCultivationLimit = computed(() => profile.value?.daily_dual_cultivation_limit ?? null);

/** 今日双修占比：次数或上限缺失时按空进度处理，不猜默认上限 */
const dailyDualCultivationPercent = computed(() => {
  const count = dualCultivationCount.value;
  const limit = dualCultivationLimit.value;
  if (count === null || limit === null || limit <= 0) return 0;
  return Math.min((count / limit) * 100, 100);
});

/**
 * 已立誓言展示对象：后端 profile.vow 为单条对象或 null
 * 无誓言时为 null，模板据此回到「无」的呈现
 */
const vowDisplay = computed(() => {
  const vow = profile.value?.vow ?? null;
  if (!vow) return null;
  return {
    /** 誓言中文名，沿用 getVowLabel */
    label: getVowLabel(vow.vow_type),
    /** 是否已毁誓 */
    broken: Boolean(vow.vow_broken),
    /** 到期文案，后端未给到期时间时为空串 */
    expireText: vow.vow_expire_time ? `${formatTime(vow.vow_expire_time)} 到期` : ''
  };
});

/** 心契各等级加成列表：把后端 level_effects 字典转成按等级升序的数组 */
const heartContractBonuses = computed<Array<{ level: number; description: string }>>(() => {
  const effects = heartContractData.value?.level_effects ?? {};
  return Object.keys(effects)
    .map(key => ({ level: Number(key), description: effects[key] }))
    .filter(bonus => Number.isFinite(bonus.level))
    .sort((a, b) => a.level - b.level);
});

/** 当前生效的加成：等级不大于当前心契等级的条目（后端无 active_bonuses 字段，由此推导） */
const activeLevelBonuses = computed(() =>
  heartContractBonuses.value.filter(bonus => bonus.level <= (heartContractData.value?.heart_contract_level ?? 0))
);

/** 心契等级上限：以后端下发的门槛档数为准，回退到加成说明的档数 */
const heartContractMaxLevel = computed(() => {
  const thresholds = heartContractData.value?.level_thresholds;
  if (thresholds && thresholds.length) return thresholds.length;
  return heartContractBonuses.value.length;
});

/** 心契升级进度百分比：后端 progress 已是 0..1，这里只做区间裁剪 */
const heartContractProgressPercent = computed(() => {
  const progress = heartContractData.value?.progress;
  if (typeof progress !== 'number') return 0;
  return Math.round(Math.min(Math.max(progress, 0), 1) * 100);
});

/** 当前等级加成描述 */
const currentLevelEffect = computed(() =>
  levelEffectOf(heartContractData.value?.heart_contract_level ?? 0)
);

/** 下一级加成描述；已满级时为空串，模板据此不渲染 */
const nextLevelEffect = computed(() => {
  const level = heartContractData.value?.heart_contract_level ?? 0;
  if (level >= heartContractMaxLevel.value) return '';
  return levelEffectOf(level + 1);
});

/**
 * 心劫抉择项：后端 options 是以选项键为索引的字典（不是数组）
 * 只有 steady / ruthless / deceive 能被 POST /companion/heart-tribulation/choose 接受，
 * 旧系统事件留下的其它键（信任 / 怀疑 / 考验）照常展示，但按钮禁用
 * @param event 待处理心劫事件
 */
function tribulationChoices(event: HeartTribulationEventPayload) {
  const options = event.options ?? {};
  return Object.keys(options)
    .filter(key => typeof options[key]?.success_rate === 'number')
    .map(key => {
      const opt = options[key];
      return {
        key,
        opt,
        label: opt.name || TRIBULATION_CHOICE_LABELS[key as HeartTribulationChoice] || key,
        submittable: key in TRIBULATION_CHOICE_LABELS
      };
    });
}

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
      // api/companion.ts 的 CompanionProfileData 声明滞后于后端实现，按实际返回断言为本地类型
      profile.value = resp.data.data as unknown as CompanionProfilePayload;
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
      // api/companion.ts 的 HeartContractData 声明滞后于后端实现（无 heart_contract 嵌套），此处断言为本地类型
      heartContractData.value = resp.data.data as unknown as HeartContractPayload;
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
      // api/companion.ts 的 HeartTribulationListData 声明滞后于后端实现（字段为 pending_events / count）
      heartTribulationData.value = resp.data.data as unknown as HeartTribulationListPayload;
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
 * 从 POST 响应里取每日次数字段（daily_count / daily_limit）
 * 后端 GET 不下发温养 / 采补次数，只有动作成功时才带回，缺任一项即视为未知
 * @param raw resp.data.data
 */
function pickDailyUsage(raw: unknown): { count: number; limit: number } | null {
  const data = (raw ?? {}) as { daily_count?: unknown; daily_limit?: unknown };
  if (typeof data.daily_count !== 'number' || typeof data.daily_limit !== 'number') return null;
  return { count: data.daily_count, limit: data.daily_limit };
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
    ? '确认和离解除道侣关系？\n· 关系解除后心契与誓言一并终止\n· 操作不可撤销'
    : '确认毁誓解除道侣关系？\n· 心契等级归零，双方各损失 5% 修为\n· 操作不可撤销，且可能触发反噬';
  showConfirm(title, message, async () => {
    loading.action = true;
    try {
      const resp = await companionBreak(mode);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '道侣关系已解除', 'success');
        // 会话内的温养 / 采补计数随旧关系一起作废，回到未知
        warmNourishDaily.value = null;
        pluckSupplementDaily.value = null;
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
      // 当日温养次数只能从这次 POST 的返回里拿到，回填后界面才显示数字
      warmNourishDaily.value = pickDailyUsage(resp.data.data) ?? warmNourishDaily.value;
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
        // 当日采补次数同样只能从这次 POST 的返回里拿到
        pluckSupplementDaily.value = pickDailyUsage(resp.data.data) ?? pluckSupplementDaily.value;
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
  showConfirm('立誓', `确认立下「${getVowLabel(vowType)}」誓言？\n· 当前只生效一条誓言，改立即覆盖旧誓\n· 誓言有有效期，毁誓会连带心契受损`, async () => {
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
 * @param eventId 心劫事件 ID（来自 pending_events[].event_id）
 * @param option 抉择项键（取自后端 options 的键）
 */
async function handleChooseTribulation(
  eventId: number,
  option: string
) {
  // 后端只认 steady/ruthless/deceive 三个键，界面上其它键的按钮已禁用，这里再兜一道
  if (!(option in TRIBULATION_CHOICE_LABELS)) {
    uiStore.showToast('该抉择项后端暂未开放提交', 'warning');
    return;
  }
  const choice = option as HeartTribulationChoice;
  showConfirm('心劫抉择', `确认选择「${TRIBULATION_CHOICE_LABELS[choice]}」应对此心劫？\n· 抉择不可更改\n· 将影响亲密度、残魂与心契升级进度`, async () => {
    loading.action = true;
    try {
      const resp = await companionChooseHeartTribulation(eventId, choice);
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
 * 判断某誓言是否为当前所立之誓（后端只保留一条 vow，毁誓后的誓言不再算生效）
 * @param vowType 誓言类型
 */
function isVowActivated(vowType: string): boolean {
  const vow = profile.value?.vow;
  return !!vow && !vow.vow_broken && vow.vow_type === vowType;
}

/**
 * 取某一心契等级的加成描述
 * @param level 等级（后端 level_effects 以等级数字为键）
 */
function levelEffectOf(level: number): string {
  return heartContractData.value?.level_effects?.[String(level)] ?? '';
}

/**
 * 某等级加成是否已激活
 * @param level 等级
 */
function isLevelActivated(level: number): boolean {
  return level <= (heartContractData.value?.heart_contract_level ?? 0);
}

/**
 * 今日次数是否已用满：任一值未知时不前置拦截，交由后端按日上限裁决
 * @param count 今日已用次数
 * @param limit 日上限
 */
function isDailyLimitReached(count: number | null, limit: number | null): boolean {
  return count !== null && limit !== null && count >= limit;
}

/**
 * 心劫事件类型中文名（后端只下发 event_type，没有标题与背景描述字段）
 * @param eventType 事件类型
 */
function getEventTypeLabel(eventType?: string): string {
  const map: Record<string, string> = {
    heart_tribulation: '心劫 · 情劫加身'
  };
  return map[eventType || ''] || '心劫抉择';
}

/**
 * 格式化时间显示（M/D HH:MM）
 * @param time ISO 时间字符串
 */
function formatTime(time: string | null | undefined): string {
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(time, { dateStyle: 'short', seconds: false, fallback: '-' });
}
</script>
