/**
 * 闭关修炼选择面板组件
 *
 * 弹窗式组件，用于让玩家在开始闭关前选择修炼方式：
 *   - 常规闭关（normal）：短时多次，最长 30 分钟，每日 3 次，冷却 5 分钟
 *   - 深度闭关（deep）：长线挂机 4-8 小时，每日 1 次，2 倍收益，需筑基期以上
 *                     未达最短时长结束时按强行出关处理，损失 50% 收益
 *
 * 设计依据：参考修仙游戏指南文档第 4 节"修炼方式"
 *   常规修炼使用 .闭关修炼，适合日常获取修为；
 *   高阶或长线挂机可使用 .深度闭关
 */
<template>
  <PanelShell
    title="闭关修炼"
    hint="多轮判定 · 成功/失败/走火入魔 · 随机冷却 · 奇遇"
    size="md"
    @close="emit('close')"
  >
    <!-- 闭关进行中：完整状态视图，操作贴在内容流里，不再只把按钮沉底 -->
    <div v-if="store.player?.is_secluded" class="space-y-4">
      <PanelCard :tone="isDeepSeclusion ? 'gold' : 'plain'" class="overflow-hidden">
        <div class="flex items-start justify-between gap-3 mb-4">
          <div class="flex items-center gap-3 min-w-0">
            <div
              class="w-11 h-11 rounded-full border flex items-center justify-center shrink-0"
              :class="isDeepSeclusion
                ? 'bg-purple-950/40 border-purple-700/40'
                : 'bg-cyan-950/40 border-cyan-700/40'"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" :class="isDeepSeclusion ? 'text-purple-400' : 'text-cyan-400'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <div class="min-w-0">
              <div class="text-base font-bold" :class="isDeepSeclusion ? 'text-purple-300' : 'text-cyan-300'">
                {{ isDeepSeclusion ? '深度闭关中' : '常规闭关中' }}
              </div>
              <div class="text-xs text-fg-faint">摒除杂念，灵气自行周天运转</div>
            </div>
          </div>
          <Badge :tone="isDeepSeclusion ? 'arcane' : 'info'" solid>进行中</Badge>
        </div>

        <div class="mb-4">
          <StatBar
            :value="seclusionElapsed"
            :max="Math.max(seclusionTotal, 1)"
            :label="isDeepSeclusion ? '深度闭关进度' : '闭关进度'"
            :text="seclusionProgressText"
            :tone="isDeepSeclusion ? 'arcane' : 'azure'"
            height="h-2"
          />
        </div>

        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-control border border-line-subtle bg-surface-canvas px-2 py-2.5">
            <div class="text-[10px] text-fg-faint mb-0.5">已闭关</div>
            <div class="text-sm font-num text-fg-secondary">{{ formatDuration(seclusionElapsed) }}</div>
          </div>
          <div class="rounded-control border border-line-subtle bg-surface-canvas px-2 py-2.5">
            <div class="text-[10px] text-fg-faint mb-0.5">预计剩余</div>
            <div class="text-sm font-num text-gold-400">{{ formatDuration(seclusionRemaining) }}</div>
          </div>
          <div class="rounded-control border border-line-subtle bg-surface-canvas px-2 py-2.5">
            <div class="text-[10px] text-fg-faint mb-0.5">预计获得</div>
            <div class="text-sm font-num font-bold" :class="isDeepSeclusion ? 'text-purple-400' : 'text-cyan-400'">+{{ activeEstimatedExp }}</div>
          </div>
        </div>
      </PanelCard>

      <PanelCard v-if="isDeepSeclusion" tone="gold" :padded="false" class="px-3 py-2.5 text-xs text-gold-400">
        <svg xmlns="http://www.w3.org/2000/svg" class="inline w-4 h-4 mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        未达最短时长 {{ formatDuration(deepConfig.min_duration) }} 提前结束，将按强行出关处理，损失 {{ Math.round(deepConfig.forced_penalty * 100) }}% 收益。
      </PanelCard>

      <!-- 主操作直接跟在状态卡下方，不再孤立沉在面板最底 -->
      <AppButton
        block
        size="lg"
        variant="danger"
        :disabled="ending"
        :loading="ending"
        @click="handleEndFromPanel"
      >
        {{ ending ? '结算中…' : (isDeepSeclusion ? '结束深度闭关' : '结束闭关') }}
      </AppButton>
    </div>

    <!-- 空闲态：模式选择 -->
    <div v-else class="space-y-4">
      <!-- 今日次数总览（醒目展示，避免玩家点了开始才发现次数用尽） -->
      <PanelCard :padded="true">
        <div class="grid grid-cols-2 gap-3">
          <div class="flex items-center justify-between">
            <div class="text-xs text-fg-muted">常规闭关</div>
            <div class="flex items-center gap-2">
              <div class="text-xs text-fg-faint">今日剩余</div>
              <Badge :tone="normalRemaining > 0 ? 'success' : 'danger'">
                {{ normalRemaining }} / {{ normalConfig.daily_limit }}
              </Badge>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <div class="text-xs text-fg-muted">深度闭关</div>
            <div class="flex items-center gap-2">
              <div class="text-xs text-fg-faint">今日剩余</div>
              <Badge :tone="deepRemaining > 0 ? 'success' : 'danger'">
                {{ deepRemaining }} / {{ deepConfig.daily_limit }}
              </Badge>
            </div>
          </div>
        </div>
      </PanelCard>

      <!-- 冷却中提示（醒目 banner，避免玩家误以为系统故障） -->
      <PanelCard v-if="cooldownRemainingText" tone="gold" :padded="false" class="flex items-center gap-2 px-3 py-2.5 text-xs text-gold-300">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span>闭关冷却中：{{ cooldownRemainingText }}</span>
      </PanelCard>

      <!-- 模式选择卡片 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <!-- 常规闭关卡片 -->
        <button
          @click="selectMode('normal')"
          :disabled="loading || !statusLoaded || normalRemaining <= 0 || isNormalCooldown"
          class="text-left bg-surface-hover hover:bg-surface-active border rounded-panel p-4 transition-all duration-200 group relative disabled:opacity-60 disabled:cursor-not-allowed flex flex-col"
          :class="selectedMode === 'normal'
            ? 'border-cyan-600 ring-1 ring-cyan-600/30 shadow-lg shadow-cyan-950/30'
            : 'border-line hover:border-cyan-700'"
        >
          <!-- 加载中锁标：与深度闭关保持一致 -->
          <Badge v-if="!statusLoaded" tone="muted" class="absolute top-2 right-2">加载中</Badge>
          <!-- 次数已用尽锁标 -->
          <Badge v-else-if="normalRemaining <= 0" tone="danger" class="absolute top-2 right-2">今日已用尽</Badge>
          <!-- 图标 + 名称 -->
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-10 h-10 rounded-full bg-cyan-950/40 border border-cyan-700/40 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <div>
                <div class="text-base font-bold text-cyan-300">常规闭关</div>
                <div class="text-xs text-fg-faint">多轮判定 · 成功/失败/走火入魔</div>
              </div>
            </div>
            <!-- 选中标识 -->
            <div v-if="selectedMode === 'normal'" class="w-5 h-5 rounded-full bg-cyan-600 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 text-fg-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
          </div>
          <!-- 参数列表 -->
          <ul class="text-xs text-fg-muted space-y-1.5 mb-3">
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">单次时长：</span>
              <span class="text-fg-primary">最长 {{ formatDuration(normalConfig.max_duration) }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">每日次数：</span>
              <span class="text-fg-primary">{{ normalConfig.daily_limit }} 次</span>
              <!-- 剩余次数醒目徽章 -->
              <Badge :tone="normalRemaining > 0 ? 'success' : 'danger'">剩余 {{ normalRemaining }} 次</Badge>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">冷却时间：</span>
              <span class="text-fg-primary">{{ normalCooldownLabel }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">单轮判定：</span>
              <span class="text-fg-primary">成功 / 失败 / 走火入魔</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">闭关奇遇：</span>
              <span class="text-fg-primary">有几率触发</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">收益倍率：</span>
              <span class="text-cyan-400">×{{ normalConfig.exp_rate }}</span>
            </li>
          </ul>
          <!-- 时长滑块（常规闭关） -->
          <div v-if="selectedMode === 'normal'" class="mt-auto pt-3 border-t border-line">
            <label class="text-xs text-fg-muted flex justify-between mb-1.5">
              <span>闭关时长</span>
              <span class="text-cyan-300 font-mono">{{ formatDuration(normalDuration) }}</span>
            </label>
            <input
              type="range"
              v-model.number="normalDuration"
              min="60"
              :max="normalConfig.max_duration"
              step="60"
              class="w-full accent-cyan-600"
            />
            <div class="flex justify-between text-[10px] text-fg-faint mt-1">
              <span>1分钟</span>
              <span>{{ formatDuration(normalConfig.max_duration) }}</span>
            </div>
          </div>
        </button>

        <!-- 深度闭关卡片 -->
        <button
          @click="selectMode('deep')"
          :disabled="loading || !statusLoaded || !canDeep || deepRemaining <= 0 || isDeepCooldown"
          class="text-left bg-surface-hover hover:bg-surface-active border rounded-panel p-4 transition-all duration-200 group relative disabled:opacity-60 disabled:cursor-not-allowed flex flex-col"
          :class="selectedMode === 'deep'
            ? 'border-purple-600 ring-1 ring-purple-600/30 shadow-lg shadow-purple-950/30'
            : 'border-line hover:border-purple-700'"
        >
          <!-- 加载中锁标：避免首次打开时误显示"境界不足" -->
          <Badge v-if="!statusLoaded" tone="muted" class="absolute top-2 right-2">加载中</Badge>
          <!-- 次数已用尽锁标（明确标注重置时间，避免玩家误以为永久禁用） -->
          <Badge v-else-if="deepRemaining <= 0" tone="danger" class="absolute top-2 right-2 text-right">
            今日已用尽
            <span class="block text-[9px] font-normal opacity-80">明日0点重置</span>
          </Badge>
          <!-- 境界不足锁标 -->
          <Badge v-else-if="!canDeep" tone="gold" class="absolute top-2 right-2">需{{ deepConfig.min_realm }}</Badge>
          <!-- 图标 + 名称 -->
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-10 h-10 rounded-full bg-purple-950/40 border border-purple-700/40 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <div>
                <div class="text-base font-bold text-purple-300">深度闭关</div>
                <div class="text-xs text-fg-faint">长线挂机，{{ deepConfig.exp_rate }}倍收益</div>
              </div>
            </div>
            <div v-if="selectedMode === 'deep'" class="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 text-fg-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
          </div>
          <!-- 参数列表 -->
          <ul class="text-xs text-fg-muted space-y-1.5 mb-3">
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">单次时长：</span>
              <span class="text-fg-primary">{{ formatDuration(deepConfig.min_duration) }} - {{ formatDuration(deepConfig.max_duration) }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">每日次数：</span>
              <span class="text-fg-primary">{{ deepConfig.daily_limit }} 次</span>
              <!-- 剩余次数醒目徽章 -->
              <Badge :tone="deepRemaining > 0 ? 'success' : 'danger'">剩余 {{ deepRemaining }} 次</Badge>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">境界要求：</span>
              <span class="text-fg-primary">{{ deepConfig.min_realm }}</span>
              <!-- 加载中时显示"加载中"，避免误显示"× 未达成" -->
              <span v-if="!statusLoaded" class="text-fg-faint">加载中</span>
              <span v-else :class="canDeep ? 'text-emerald-400' : 'text-rose-400'">{{ canDeep ? '✓ 已达成' : '× 未达成' }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">收益倍率：</span>
              <span class="text-purple-400">×{{ deepConfig.exp_rate }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="text-fg-faint">强行出关：</span>
              <span class="text-gold-400">损失 {{ Math.round(deepConfig.forced_penalty * 100) }}% 收益</span>
            </li>
          </ul>
          <!-- 时长滑块（深度闭关） -->
          <div v-if="selectedMode === 'deep'" class="mt-auto pt-3 border-t border-line">
            <label class="text-xs text-fg-muted flex justify-between mb-1.5">
              <span>闭关时长</span>
              <span class="text-purple-300 font-mono">{{ formatDuration(deepDuration) }}</span>
            </label>
            <input
              type="range"
              v-model.number="deepDuration"
              :min="deepConfig.min_duration"
              :max="deepConfig.max_duration"
              :step="1800"
              class="w-full accent-purple-600"
            />
            <div class="flex justify-between text-[10px] text-fg-faint mt-1">
              <span>{{ formatDuration(deepConfig.min_duration) }}</span>
              <span>{{ formatDuration(deepConfig.max_duration) }}</span>
            </div>
          </div>
        </button>
      </div>

      <!-- 深度闭关状态说明横幅（明确告知禁用原因，避免玩家误以为境界不足） -->
      <PanelCard v-if="selectedMode === 'deep' && !canDeep" tone="danger" :padded="false" class="flex items-center gap-2 px-3 py-2.5 text-xs text-rose-300">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span>境界未达成：需达到 {{ deepConfig.min_realm }} 方可进行深度闭关，当前境界不足。</span>
      </PanelCard>
      <PanelCard v-else-if="selectedMode === 'deep' && deepRemaining <= 0" tone="gold" :padded="false" class="flex items-center gap-2 px-3 py-2.5 text-xs text-gold-300">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span>✓ 境界已达成，但今日深度闭关次数已用尽（每日 {{ deepConfig.daily_limit }} 次），明日 0:00 重置。</span>
      </PanelCard>
      <PanelCard v-else-if="selectedMode === 'deep' && isDeepCooldown" tone="gold" :padded="false" class="flex items-center gap-2 px-3 py-2.5 text-xs text-gold-300">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span>✓ 境界已达成，深度闭关冷却中，还需 {{ formatDuration(deepCooldownRemaining) }}。</span>
      </PanelCard>

      <!-- 风险提示 -->
      <PanelCard v-if="selectedMode === 'deep'" tone="gold" :padded="false" class="px-3 py-2.5 text-xs text-gold-400">
        <svg xmlns="http://www.w3.org/2000/svg" class="inline w-4 h-4 mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        深度闭关需达到 {{ deepConfig.min_realm }} 方可进行；若未达最短时长 {{ formatDuration(deepConfig.min_duration) }} 提前结束，将按强行出关处理，损失 {{ Math.round(deepConfig.forced_penalty * 100) }}% 收益。
      </PanelCard>

      <!-- 收益预估 -->
      <PanelCard title="收益预估">
        <div class="grid grid-cols-2 gap-3">
          <div class="text-center">
            <div class="text-[10px] text-fg-faint mb-0.5">基础速率</div>
            <div class="text-sm text-fg-secondary font-num">{{ baseExpRate }} /秒</div>
          </div>
          <div class="text-center">
            <div class="text-[10px] text-fg-faint mb-0.5">预计获得修为</div>
            <div
              class="text-lg font-num font-bold"
              :class="selectedMode === 'deep' ? 'text-purple-400' : 'text-cyan-400'"
            >+{{ estimatedExp }}</div>
          </div>
        </div>
      </PanelCard>
    </div>

    <!-- 底部操作栏：仅空闲态需要「取消 / 开始」；进行中态主操作已在内容流里 -->
    <template v-if="!store.player?.is_secluded" #footer>
      <AppButton variant="ghost" @click="emit('close')">取消</AppButton>
      <button
        @click="handleStart"
        :disabled="loading || !statusLoaded || (selectedMode === 'deep' ? (!canDeep || deepRemaining <= 0 || isDeepCooldown) : (normalRemaining <= 0 || isNormalCooldown))"
        class="flex-1 min-w-0 min-h-10 rounded-control font-bold tracking-widest text-sm transition-colors disabled:opacity-50 disabled:pointer-events-none"
        :class="selectedMode === 'deep'
          ? 'bg-purple-950/40 border border-purple-700 text-purple-300 hover:bg-purple-900/40 hover:border-purple-500'
          : 'bg-cyan-950/40 border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40 hover:border-cyan-500'"
      >
        <span v-if="loading">正在进入...</span>
        <!-- 状态加载中：避免 canDeep 默认 false 导致误显示"境界不足" -->
        <span v-else-if="!statusLoaded">加载闭关状态中...</span>
        <span v-else-if="selectedMode === 'deep' && !canDeep">境界不足·需{{ deepConfig.min_realm }}</span>
        <span v-else-if="selectedMode === 'deep' && deepRemaining <= 0">今日深度闭关已用尽·明日0点重置</span>
        <span v-else-if="selectedMode === 'normal' && normalRemaining <= 0">今日常规闭关已用尽·明日0点重置</span>
        <span v-else-if="selectedMode === 'deep' && isDeepCooldown">深度闭关冷却中·还需{{ formatDuration(deepCooldownRemaining) }}</span>
        <span v-else-if="selectedMode === 'normal' && isNormalCooldown">常规闭关冷却中·还需{{ formatDuration(normalCooldownRemaining) }}</span>
        <span v-else>开始{{ selectedMode === 'deep' ? '深度' : '常规' }}闭关</span>
      </button>
    </template>
  </PanelShell>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import StatBar from '../ui/StatBar.vue'
// 结束闭关的结算与日志实现，与总览进度条共用一份（见 composables 里的说明）
import { useSeclusionSettle } from '../../composables/useSeclusionSettle'

const emit = defineEmits(['close'])

const store = usePlayerStore()
const uiStore = useUIStore()

/**
 * 从本面板结束闭关。
 *
 * 结算文案与日志走 useSeclusionSettle —— 与总览进度条上那个"结束修炼"是同一条实现，
 * 不在这里抄第二份（那份要照顾 exp_gain=0 不回退到总修为、强行出关扣益、HP/MP 恢复值）。
 * 结束后再拉一次状态，让"今日剩余次数 / 冷却"立刻跟着变。
 */
const { ending, endNow } = useSeclusionSettle()
const handleEndFromPanel = async () => {
  const r = await endNow()
  if (!r?.skipped && !r?.error) {
    try { await store.fetchSeclusionStatus() } catch { /* 状态刷新失败不影响已完成的结算 */ }
  }
}

const loading = ref(false)
// 闭关状态加载标记：避免首次打开面板时 canDeep 默认 false 导致按钮误显示"境界不足"
// 修复用户报告的 bug：化神期玩家首次打开面板看到"境界不足·需筑基期"提示
// 实际是 fetchSeclusionStatus 异步未完成，can_deep 字段还未加载到 store
const statusLoaded = ref(false)
const selectedMode = ref('normal') // 默认常规闭关
const normalDuration = ref(1800) // 默认 30 分钟
const deepDuration = ref(14400) // 默认 4 小时

// 当前时间 tick（每秒更新一次，用于驱动冷却倒计时显示）
const now = ref(Date.now())
let tickTimer = null

// 闭关配置（从后端拉取的状态中读取，降级默认值与 seclusion.json 保持一致）
const normalConfig = computed(() => {
  return store.systemConfig?.seclusion?.normal || {
    max_duration: 1800,
    daily_limit: 3,
    cooldown: 600,
    cooldown_min: 600,
    cooldown_max: 900,
    exp_rate: 1,
    round_interval: 60
  }
})

/** 常规闭关冷却文案：随机 10~15 分钟（配置驱动） */
const normalCooldownLabel = computed(() => {
  const min = Number(normalConfig.value.cooldown_min ?? normalConfig.value.cooldown ?? 600)
  const max = Number(normalConfig.value.cooldown_max ?? Math.max(min, 900))
  if (min === max) return formatDuration(min)
  return `随机 ${formatDuration(min)} ~ ${formatDuration(max)}`
})
const deepConfig = computed(() => {
  return store.systemConfig?.seclusion?.deep || {
    min_duration: 14400,
    max_duration: 28800,
    daily_limit: 1,
    cooldown: 3600,
    exp_rate: 2,
    min_realm: '筑基期',
    forced_penalty: 0.5
  }
})

// 基础修为速率
const baseExpRate = computed(() => {
  return store.systemConfig?.seclusion?.exp_rate || 1
})

// 境界加成倍率
// 修复（2026-07-21）：原预估公式缺少境界加成，导致化神期玩家预估收益比实际少 3.2 倍
// 后端 /api/seclusion/status 返回此字段，公式：1.0 + (realm.rank - 1) * 0.1
// 化神初期 rank=23 → 倍率 3.2，凡人 rank=0 → 倍率 1.0
const realmMultiplier = computed(() => {
  return store.systemConfig?.seclusion?.realm_multiplier ?? 1.0
})

// 每日剩余次数
const normalRemaining = computed(() => {
  return store.systemConfig?.seclusion?.normal_remaining ?? normalConfig.value.daily_limit
})
const deepRemaining = computed(() => {
  return store.systemConfig?.seclusion?.deep_remaining ?? deepConfig.value.daily_limit
})

/**
 * 计算指定模式的冷却剩余秒数（基于后端权威值 + 本地 tick 递减）
 *
 * 设计要点：
 *   - 后端 status 接口返回 normal_cooldown_remaining / deep_cooldown_remaining 权威值
 *   - 前端记录拉取时的 server_time，每秒 tick 减去本地流逝时间
 *   - 避免前端时钟漂移（与服务器时间不同步）导致冷却显示误差
 *   - 拉取间隔（5-10秒）后会重新同步后端权威值，本地仅做平滑递减
 *
 * @param {string} modeKey - 模式字段名 'normal_cooldown_remaining' 或 'deep_cooldown_remaining'
 * @returns {number} 剩余冷却秒数，<=0 表示冷却已结束
 */
const computeCooldownFromBackend = (modeKey) => {
  const secData = store.systemConfig?.seclusion
  if (!secData) return 0
  const backendRemaining = secData[modeKey] ?? 0
  if (backendRemaining <= 0) return 0
  // 服务端时间戳（拉取时刻）+ 本地流逝时间 = 当前真实剩余
  const serverTime = secData.server_time || Date.now()
  const localElapsedSec = Math.floor((now.value - serverTime) / 1000)
  return Math.max(0, backendRemaining - localElapsedSec)
}

// 常规闭关冷却剩余秒数（基于后端权威值 + 本地 tick）
const normalCooldownRemaining = computed(() => computeCooldownFromBackend('normal_cooldown_remaining'))
// 深度闭关冷却剩余秒数
const deepCooldownRemaining = computed(() => computeCooldownFromBackend('deep_cooldown_remaining'))

// 是否处于冷却中
const isNormalCooldown = computed(() => normalCooldownRemaining.value > 0)
const isDeepCooldown = computed(() => deepCooldownRemaining.value > 0)

/**
 * 冷却剩余文案（取常规/深度中较长的一个展示，避免误导）
 * 仅在玩家未闭关时显示
 */
const cooldownRemainingText = computed(() => {
  if (store.player?.is_secluded) return ''
  const normalRem = normalCooldownRemaining.value
  const deepRem = deepCooldownRemaining.value
  // 优先展示选中模式的冷却
  if (selectedMode.value === 'deep' && deepRem > 0) {
    return `深度闭关还需 ${formatDuration(deepRem)}`
  }
  if (normalRem > 0) {
    return `常规闭关还需 ${formatDuration(normalRem)}`
  }
  if (deepRem > 0) {
    return `深度闭关还需 ${formatDuration(deepRem)}`
  }
  return ''
})

/**
 * 当前玩家境界是否达到深度闭关要求
 * 直接读取后端权威计算的 can_deep 字段，前端不再做境界关键词匹配
 * 避免前端硬编码境界列表导致的判断不一致
 */
const canDeep = computed(() => {
  return store.systemConfig?.seclusion?.can_deep ?? false
})

/**
 * 预计获得修为
 * 修复（2026-07-21）：补加 realm_multiplier 境界加成倍率
 * 公式：duration * baseExpRate * modeRate * realmMultiplier
 * 与后端 /end 实际结算公式保持一致，避免预估与实际不符
 */
const estimatedExp = computed(() => {
  const duration = selectedMode.value === 'deep' ? deepDuration.value : normalDuration.value
  const modeRate = selectedMode.value === 'deep' ? deepConfig.value.exp_rate : normalConfig.value.exp_rate
  return Math.floor(duration * baseExpRate.value * modeRate * realmMultiplier.value)
})

/* ── 闭关进行中状态视图 ── */
const isDeepSeclusion = computed(() => store.player?.seclusion_mode === 'deep')

const seclusionTotal = computed(() => {
  const dur = Number(store.player?.seclusion_duration) || 0
  if (dur > 0) return dur
  const start = store.player?.seclusion_start_time ? new Date(store.player.seclusion_start_time).getTime() : 0
  const end = store.player?.seclusion_end_time ? new Date(store.player.seclusion_end_time).getTime() : 0
  return start && end && end > start ? Math.floor((end - start) / 1000) : 0
})

const seclusionElapsed = computed(() => {
  const start = store.player?.seclusion_start_time ? new Date(store.player.seclusion_start_time).getTime() : 0
  if (!start) return 0
  return Math.max(0, Math.floor((now.value - start) / 1000))
})

const seclusionRemaining = computed(() => {
  return Math.max(0, seclusionTotal.value - seclusionElapsed.value)
})

const seclusionProgressText = computed(() => {
  return `${formatDuration(seclusionElapsed.value)} / ${formatDuration(seclusionTotal.value)}`
})

/** 进行中的预估收益：按已配置总时长估算，与选择态公式一致 */
const activeEstimatedExp = computed(() => {
  const modeRate = isDeepSeclusion.value ? deepConfig.value.exp_rate : normalConfig.value.exp_rate
  const duration = seclusionTotal.value || 0
  return Math.floor(duration * baseExpRate.value * modeRate * realmMultiplier.value)
})

/**
 * 选择模式
 * 增加次数与冷却校验，避免玩家选了不可用的模式
 */
const selectMode = (mode) => {
  if (mode === 'deep') {
    if (!canDeep.value) {
      uiStore.showToast(`深度闭关需达到 ${deepConfig.value.min_realm} 境界`, 'warning')
      return
    }
    if (deepRemaining.value <= 0) {
      uiStore.showToast('今日深度闭关次数已用尽，明日重置', 'warning')
      return
    }
    if (isDeepCooldown.value) {
      uiStore.showToast(`深度闭关冷却中，还需 ${formatDuration(deepCooldownRemaining.value)}`, 'warning')
      return
    }
  } else {
    if (normalRemaining.value <= 0) {
      uiStore.showToast('今日常规闭关次数已用尽，明日重置', 'warning')
      return
    }
    if (isNormalCooldown.value) {
      uiStore.showToast(`常规闭关冷却中，还需 ${formatDuration(normalCooldownRemaining.value)}`, 'warning')
      return
    }
  }
  selectedMode.value = mode
}

/**
 * 格式化时长（秒 → 中文）
 */
const formatDuration = (seconds) => {
  if (!seconds) return '0秒'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  let parts = []
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0) parts.push(`${m}分钟`)
  if (s > 0 && h === 0) parts.push(`${s}秒`)
  return parts.join('') || '0秒'
}

/**
 * 开始闭关
 * 前端二次校验：次数与冷却，避免无效请求打到后端
 */
const handleStart = async () => {
  if (loading.value) return
  // 二次校验，防止按钮禁用状态被绕过
  if (selectedMode.value === 'deep') {
    if (!canDeep.value || deepRemaining.value <= 0 || isDeepCooldown.value) {
      uiStore.showToast('当前不可开始深度闭关（境界/次数/冷却限制）', 'warning')
      return
    }
  } else {
    if (normalRemaining.value <= 0 || isNormalCooldown.value) {
      uiStore.showToast('当前不可开始常规闭关（次数/冷却限制）', 'warning')
      return
    }
  }
  loading.value = true
  try {
    const duration = selectedMode.value === 'deep' ? deepDuration.value : normalDuration.value
    const res = await store.startSeclusion(selectedMode.value, duration)
    const modeLabel = selectedMode.value === 'deep' ? '深度闭关' : '常规闭关'
    uiStore.showToast(`进入${modeLabel}状态`, 'success')
    uiStore.addLog({
      content: `开始${modeLabel}修炼，摒除杂念，感悟天地灵气。预计获得修为 ${estimatedExp.value} 点。`,
      type: 'info',
      actorId: 'self'
    })
    emit('close')
  } catch (error) {
    console.error('开始闭关失败:', error)
    uiStore.showApiError(error, '开始闭关失败')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  // 拉取最新闭关状态与配置（含每日剩余次数）
  await store.fetchSeclusionStatus()
  // 标记状态加载完成，避免按钮误显示"境界不足"
  statusLoaded.value = true
  // 启动每秒 tick，驱动冷却倒计时显示
  // 注意：关闭面板时需清理，避免内存泄漏
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  // 清理定时器，避免组件销毁后定时器继续运行
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
})
</script>
