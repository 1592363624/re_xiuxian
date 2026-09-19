/**
 * 侍妾面板组件
 *
 * 批次3 侍妾 / 红尘寻缘 / 远航 / 婉影觉醒 子模块前端 UI
 *
 * Tab 划分：
 *   1. 侍妾列表：网格展示所有侍妾卡片（名字/境界等阶/修为/亲密·魅力·忠诚/安置/操作）
 *   2. 红尘寻缘：今日剩余次数 + 寻缘按钮 + 寻缘结果展示
 *   3. 远航：4 种远航模式选择（稳妥 4h/均衡 8h/冒险 12h/月殿寻痕 24h）+ 进行中与归来待领取列表
 *   4. 日志：简化为最近 20 条侍妾互动日志（由列表刷新间接呈现）
 *
 * 数据契约（以 server/game/services/ConcubineService.js 为准）：
 *   - /concubine/list 只有 count + concubines，没有 total / status / name / realm / location /
 *     avatar / awaken_level / is_awakened，也没有寻缘当日余量；状态由 is_placed + is_voyaging 推导，
 *     境界只有 realm_rank（中文名后端不给），exp 是字符串
 *   - /concubine/voyage/status 只有未分组的 voyages，进行中 / 待领取由前端按 can_return 分流，
 *     远航记录不带侍妾名字，需按 concubine_id 关联列表
 *
 * 设计原则：
 *   - 所有状态从后端 GET /concubine/list 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色统一取设计令牌（surface-* / line-* / fg-* / gold-*，见 styles/tokens.css）
 *   - 外壳与标签页走 ui/PanelShell.vue + ui/Tabs.vue，全部使用 Tailwind 工具类
 */
<template>
  <PanelShell
    title="侍妾 · 红尘寻缘"
    hint="寻缘 · 远航 · 婉影觉醒"
    size="xl"
    @close="$emit('close')"
  >
    <!-- Tab 切换栏（切换时按需懒加载，见 switchTab） -->
    <Tabs :model-value="activeTab" :items="tabItems" class="mb-3" @update:model-value="switchTab" />

    <!-- ============ Tab 1: 侍妾列表 ============ -->
    <div v-show="activeTab === 'list'" class="space-y-3">
      <!-- 加载 / 空状态（放在页签栏之下：交给 PanelShell 会把页签一起藏掉） -->
      <LoadingBlock v-if="loading.list && !listData" text="加载侍妾数据中…" />
      <EmptyState
        v-else-if="!listData?.concubines.length"
        text="尚未拥有侍妾"
        hint="请前往「红尘寻缘」觅得有缘人"
      />

      <!-- 侍妾卡片网格 -->
      <section v-else>
        <div class="text-xs text-fg-faint mb-2">
          · 共有 <span class="num">{{ listData.count }}</span> 位侍妾
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div v-for="concubine in listData.concubines" :key="concubine.id"
            class="bg-surface-hover border border-line rounded-lg p-3">
            <!-- 头部：名字首字 + 名字 + 境界等阶 + 状态徽章 -->
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <div class="w-10 h-10 rounded bg-surface-raised border border-fuchsia-900/40 flex items-center justify-center text-xl text-fuchsia-300">
                  {{ concubine.concubine_name.charAt(0) }}
                </div>
                <div>
                  <div class="text-fuchsia-300 font-bold text-sm">{{ concubine.concubine_name }}</div>
                  <div class="text-[10px] text-gold-300">
                    第 <span class="num">{{ concubine.realm_rank }}</span> 阶 · 修为
                    <span class="num" :title="concubine.exp">{{ formatCompact(Number(concubine.exp)) }}</span>
                  </div>
                </div>
              </div>
              <div class="flex flex-col items-end gap-1">
                <span v-if="concubine.awakened_form" :title="`婉影形态：${concubine.awakened_form}`"
                  class="text-[10px] px-1.5 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800">
                  婉影觉醒
                </span>
                <span class="text-[10px] px-1.5 py-0.5 rounded"
                  :class="getStatusBadgeClass(getConcubineState(concubine))">
                  {{ getStatusLabel(getConcubineState(concubine)) }}
                </span>
              </div>
            </div>

            <!-- 属性进度条 -->
            <div class="space-y-1.5">
              <div>
                <div class="flex justify-between text-[11px] text-fg-faint mb-0.5">
                  <span>亲密度</span>
                  <span class="text-pink-300">{{ concubine.intimacy }} / 100</span>
                </div>
                <div class="h-1 bg-surface-hover rounded-full overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-pink-600 to-pink-400 transition-all"
                    :style="{ width: `${concubine.intimacy}%` }"></div>
                </div>
              </div>
              <div>
                <div class="flex justify-between text-[11px] text-fg-faint mb-0.5">
                  <span>魅力</span>
                  <span class="text-fuchsia-300">{{ concubine.charm }} / 100</span>
                </div>
                <div class="h-1 bg-surface-hover rounded-full overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-fuchsia-600 to-fuchsia-400 transition-all"
                    :style="{ width: `${concubine.charm}%` }"></div>
                </div>
              </div>
              <div>
                <div class="flex justify-between text-[11px] text-fg-faint mb-0.5">
                  <span>忠诚度</span>
                  <span class="text-gold-300">{{ concubine.loyalty }} / 100</span>
                </div>
                <div class="h-1 bg-surface-hover rounded-full overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-gold-600 to-gold-400 transition-all"
                    :style="{ width: `${concubine.loyalty}%` }"></div>
                </div>
              </div>
            </div>

            <!-- 安置地点 -->
            <div v-if="concubine.placement_location" class="mt-2 text-[11px] text-fg-muted">
              · 当前安置：<span class="text-cyan-300">{{ concubine.placement_location }}</span>
            </div>

            <!-- 操作按钮组（后端仅按 远航中 / 已安置 设限，问安日上限等业务限制由接口回信提示） -->
            <div class="mt-3 grid grid-cols-4 gap-1">
              <button @click="handleAskAfter(concubine.id)"
                :disabled="loading.action || concubine.is_voyaging"
                class="py-1 text-[10px] rounded bg-pink-950/40 border border-pink-800 text-pink-300 hover:bg-pink-900/40 disabled:opacity-50">
                问安
              </button>
              <button @click="handleBackfeed(concubine.id)"
                :disabled="loading.action || concubine.is_voyaging"
                class="py-1 text-[10px] rounded bg-cyan-950/40 border border-cyan-800 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-50">
                反哺
              </button>
              <button @click="openGiftModal(concubine.id)"
                :disabled="loading.action || concubine.is_voyaging"
                class="py-1 text-[10px] rounded bg-gold-900/40 border border-gold-800 text-gold-300 hover:bg-gold-900/40 disabled:opacity-50">
                赠予
              </button>
              <button @click="handleProtect(concubine.id)"
                :disabled="loading.action || concubine.is_voyaging"
                class="py-1 text-[10px] rounded bg-purple-950/40 border border-purple-800 text-purple-300 hover:bg-purple-900/40 disabled:opacity-50">
                护法
              </button>
              <button @click="handleAwaken(concubine.id)"
                :disabled="loading.action || concubine.is_voyaging || !!concubine.awakened_form"
                class="py-1 text-[10px] rounded bg-fuchsia-950/40 border border-fuchsia-800 text-fuchsia-300 hover:bg-fuchsia-900/40 disabled:opacity-50">
                觉醒
              </button>
              <button @click="openPlaceModal(concubine.id)"
                :disabled="loading.action || concubine.is_voyaging || concubine.is_placed"
                class="py-1 text-[10px] rounded bg-emerald-950/40 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-50">
                安置
              </button>
              <button @click="handleRecall(concubine.id)"
                :disabled="loading.action || !concubine.is_placed"
                class="py-1 text-[10px] rounded bg-surface-hover border border-line-strong text-fg-secondary hover:bg-surface-active disabled:opacity-50">
                召回
              </button>
              <button @click="handleDismiss(concubine.id)"
                :disabled="loading.action || concubine.is_voyaging"
                class="py-1 text-[10px] rounded bg-rose-950/40 border border-rose-800 text-rose-300 hover:bg-rose-900/40 disabled:opacity-50">
                遣散
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ============ Tab 2: 红尘寻缘 ============ -->
    <div v-show="activeTab === 'seek_fate'" class="space-y-3">
      <section class="bg-surface-hover border border-line rounded-lg p-4">
        <div class="flex items-center justify-between mb-3">
          <div class="text-sm font-bold text-fuchsia-300">红尘寻缘</div>
          <!-- 后端列表接口不带寻缘当日余量，只有寻缘结果里带；未寻缘前一律显示「未知」而非编造数字 -->
          <div class="text-[11px] text-fg-faint">
            今日剩余：
            <template v-if="seekRemaining !== null">
              <span class="text-gold-300 font-bold num">{{ seekRemaining }}</span> /
              <span class="num">{{ seekDailyLimit }}</span> 次
            </template>
            <span v-else class="text-fg-muted" title="寻缘一次之后即可看到当日余量">未知</span>
          </div>
        </div>
        <div class="text-[11px] text-fg-muted space-y-1 mb-4">
          <div>· 每日 1 次免费寻缘，额外 3 次消耗灵石</div>
          <div>· 寻得之侍妾随机出自 7 大原型</div>
          <div>· 侍妾境界、魅力、亲密度等属性随机生成</div>
        </div>
        <AppButton
          variant="primary"
          size="sm"
          block
          :disabled="loading.action || (seekRemaining !== null && seekRemaining <= 0)"
          @click="handleSeekFate"
        >
          {{ seekRemaining !== null && seekRemaining <= 0 ? '今日次数已尽' : '红尘寻缘' }}
        </AppButton>
      </section>

      <!-- 寻缘结果 -->
      <section v-if="lastSeekResult" class="bg-surface-hover border border-line rounded-lg p-4">
        <div class="text-sm font-bold text-fuchsia-300 mb-2">寻缘结果</div>
        <div v-if="lastSeekResult.obtained_concubine"
          class="bg-surface-raised/50 border border-fuchsia-900/40 rounded p-3 text-xs">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <div class="w-10 h-10 rounded bg-surface-raised border border-fuchsia-900/40 flex items-center justify-center text-xl text-fuchsia-300">
                {{ lastSeekResult.obtained_concubine.concubine_name.charAt(0) }}
              </div>
              <div>
                <div class="text-fuchsia-300 font-bold">{{ lastSeekResult.obtained_concubine.concubine_name }}</div>
                <div v-if="seekResultConcubine" class="text-[10px] text-gold-300">
                  第 <span class="num">{{ seekResultConcubine.realm_rank }}</span> 阶
                </div>
              </div>
            </div>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800">
              {{ lastSeekResult.is_rare ? '稀有缘来' : '缘来' }}
            </span>
          </div>
          <div class="grid grid-cols-3 gap-2 text-[11px]">
            <div>亲密度：<span class="text-pink-300 num">{{ lastSeekResult.obtained_concubine.intimacy }}</span></div>
            <div>魅力：<span class="text-fuchsia-300 num">{{ lastSeekResult.obtained_concubine.charm }}</span></div>
            <div>忠诚：<span class="text-gold-300 num">{{ lastSeekResult.obtained_concubine.loyalty }}</span></div>
          </div>
          <div v-if="seekCostStones > 0" class="text-[11px] text-fg-muted mt-2">
            · 本次消耗灵石 <span class="text-gold-300 num" :title="lastSeekResult.cost_spirit_stones">{{ formatCompact(seekCostStones) }}</span>
          </div>
        </div>
        <div v-else class="text-fg-faint text-xs text-center py-2">
          {{ lastSeekResult.is_duplicate ? '· 所寻侍妾已经拥有，未重复纳入' : '· 缘分未至，下次再来' }}
        </div>
        <div class="text-[11px] text-fg-muted mt-2">{{ lastSeekResult.message }}</div>
      </section>
    </div>

    <!-- ============ Tab 3: 远航 ============ -->
    <div v-show="activeTab === 'voyage'" class="space-y-3">
      <LoadingBlock v-if="loading.voyage" text="加载远航数据中…" />
      <template v-else-if="voyageData">
        <!-- 远航模式选择 -->
        <section class="bg-surface-hover border border-line rounded-lg p-4">
          <div class="text-sm font-bold text-fuchsia-300 mb-2">侍妾远航</div>
          <div class="text-[11px] text-fg-muted mb-3">
            · 选择一位空闲侍妾执行远航任务<br>
            · 时长越长奖励越丰厚，月殿寻痕为顶级远航
          </div>
          <!-- 侍妾选择 -->
          <div class="mb-3">
            <label class="block text-[11px] text-fg-muted mb-1">选择侍妾</label>
            <select v-model="voyageForm.concubineId"
              class="w-full bg-surface-raised border border-line rounded px-3 py-2 text-xs text-fg-primary focus:border-fuchsia-500 focus:outline-none">
              <option value="">请选择空闲侍妾</option>
              <option v-for="c in idleConcubines" :key="c.id" :value="c.id">
                {{ c.concubine_name }}（第 {{ c.realm_rank }} 阶）
              </option>
            </select>
            <div v-if="listData && !idleConcubines.length" class="text-[11px] text-fg-faint mt-1">
              · 暂无空闲侍妾：需先召回已安置的侍妾，或等待远航中的侍妾归来
            </div>
          </div>
          <!-- 模式选择 -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <button v-for="mode in voyageModes" :key="mode.value"
              @click="voyageForm.mode = mode.value"
              :disabled="loading.action"
              :class="[
                'py-2 rounded text-xs font-bold border transition-colors',
                voyageForm.mode === mode.value
                  ? 'bg-fuchsia-700 border-fuchsia-500 text-fuchsia-100'
                  : 'bg-surface-raised/40 border-line text-fg-secondary hover:bg-surface-hover/60'
              ]">
              <div>{{ mode.label }}</div>
              <div class="text-[10px] text-fg-muted mt-0.5">{{ mode.duration }}</div>
            </button>
          </div>
          <AppButton
            variant="primary"
            size="sm"
            block
            :disabled="loading.action || !voyageForm.concubineId || !voyageForm.mode"
            @click="handleStartVoyage"
          >
            开始远航
          </AppButton>
        </section>

        <!-- 进行中远航 -->
        <section v-if="ongoingVoyages.length" class="bg-surface-hover border border-line rounded-lg p-4">
          <div class="text-sm font-bold text-gold-300 mb-3">进行中远航</div>
          <div class="space-y-2">
            <div v-for="voyage in ongoingVoyages" :key="voyage.voyage_id"
              class="bg-surface-raised/50 border border-line rounded p-2 text-xs">
              <div class="flex items-center justify-between mb-1">
                <span class="text-fuchsia-300 font-bold">{{ getConcubineName(voyage.concubine_id) }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-gold-900/60 text-gold-300 border border-gold-800">
                  {{ getVoyageModeLabel(voyage.voyage_mode) }}
                </span>
              </div>
              <div class="text-fg-faint text-[11px]">
                · 出发：{{ formatTime(voyage.started_at) }}<br>
                · 预计归来：{{ formatTime(voyage.expected_end_time) }}
              </div>
            </div>
          </div>
        </section>

        <!-- 归来待领取 -->
        <section v-if="returnableVoyages.length" class="bg-surface-hover border border-line rounded-lg p-4">
          <div class="text-sm font-bold text-emerald-300 mb-3">归来待领取</div>
          <div class="space-y-2">
            <div v-for="voyage in returnableVoyages" :key="voyage.voyage_id"
              class="bg-surface-raised/50 border border-emerald-900/40 rounded p-2 text-xs">
              <div class="flex items-center justify-between mb-2">
                <div>
                  <span class="text-fuchsia-300 font-bold">{{ getConcubineName(voyage.concubine_id) }}</span>
                  <span class="ml-2 text-[10px] text-fg-faint">{{ getVoyageModeLabel(voyage.voyage_mode) }}</span>
                </div>
                <button @click="handleReturnVoyage(voyage.voyage_id)"
                  :disabled="loading.action"
                  class="px-3 py-1 rounded bg-emerald-700 text-emerald-100 hover:bg-emerald-600 disabled:opacity-50">
                  归来
                </button>
              </div>
              <div class="text-fg-faint text-[11px]">
                · 预计归来：{{ formatTime(voyage.expected_end_time) }}
              </div>
              <div v-if="voyage.rewards?.length" class="text-[11px] text-fg-muted mt-1">
                奖励：
                <span v-for="(reward, idx) in (voyage.rewards ?? [])" :key="idx" class="ml-1 text-gold-300">
                  {{ reward.name }} ×<span class="num">{{ formatCompact(reward.amount) }}</span>
                </span>
              </div>
            </div>
          </div>
        </section>

        <!-- 空状态 -->
        <EmptyState
          v-if="!ongoingVoyages.length && !returnableVoyages.length"
          text="暂无远航记录"
        />
      </template>
    </div>

    <!-- ============ Tab 4: 日志（简化） ============ -->
    <div v-show="activeTab === 'log'" class="space-y-3">
      <section class="bg-surface-hover border border-line rounded-lg p-4">
        <div class="text-sm font-bold text-fuchsia-300 mb-2">侍妾互动日志</div>
        <div class="text-[11px] text-fg-muted mb-3">
          · 展示侍妾列表中的最新状态与操作记录<br>
          · 完整流水请见后端日志系统
        </div>
        <div v-if="listData?.concubines.length" class="space-y-2">
          <div v-for="concubine in listData.concubines" :key="concubine.id"
            class="bg-surface-raised/50 border border-line rounded p-2 text-xs">
            <div class="flex items-center justify-between mb-1">
              <span class="text-fuchsia-300 font-bold">{{ concubine.concubine_name }}</span>
              <span class="text-[10px] text-fg-faint">{{ formatTime(concubine.created_at) }}</span>
            </div>
            <div class="text-fg-faint text-[11px] space-y-0.5">
              <div>· 当前状态：<span class="text-gold-300">{{ getStatusLabel(getConcubineState(concubine)) }}</span></div>
              <div>· 今日问安：<span class="num">{{ concubine.daily_ask_after_count }}</span> 次</div>
              <div v-if="concubine.last_ask_after_time">· 上次问安：{{ formatTime(concubine.last_ask_after_time) }}</div>
              <div v-if="concubine.last_backfeed_time">· 上次反哺：{{ formatTime(concubine.last_backfeed_time) }}</div>
              <div v-if="concubine.awakened_form">· 已觉醒婉影：<span class="text-purple-300">{{ concubine.awakened_form }}</span></div>
            </div>
          </div>
        </div>
        <EmptyState v-else text="暂无侍妾记录" />
      </section>
    </div>

    <!-- 赠予物品弹窗 -->
    <Modal :isOpen="giftModal.show" title="赠予物品" @close="giftModal.show = false" width="420px">
      <div class="space-y-3">
        <p class="text-fg-secondary text-sm">将物品赠予侍妾，可提升其亲密度与魅力。</p>
        <div>
          <label class="block text-xs text-fg-muted mb-1">物品 key</label>
          <input v-model="giftModal.itemKey" placeholder="例如：spirit_herb / ling_zhi 等"
            class="w-full bg-surface-raised border border-line-strong rounded px-3 py-2 text-fg-primary text-sm" />
        </div>
        <div>
          <label class="block text-xs text-fg-muted mb-1">数量（1-99）</label>
          <input v-model.number="giftModal.count" type="number" min="1" max="99"
            class="w-full bg-surface-raised border border-line-strong rounded px-3 py-2 text-fg-primary text-sm" />
        </div>
        <p class="text-[11px] text-fg-faint">· 物品 key 请见后端物品配置文件</p>
      </div>
      <template #footer>
        <AppButton variant="default" size="sm" @click="giftModal.show = false">取消</AppButton>
        <AppButton
          variant="primary"
          size="sm"
          :disabled="loading.action || !giftModal.itemKey || !giftModal.count"
          @click="handleGift"
        >
          确认赠予
        </AppButton>
      </template>
    </Modal>

    <!-- 安置地点弹窗 -->
    <Modal :isOpen="placeModal.show" title="安置侍妾" @close="placeModal.show = false" width="420px">
      <div class="space-y-3">
        <p class="text-fg-secondary text-sm">选择安置地点，侍妾可在该地提供加成。</p>
        <div class="grid grid-cols-2 gap-2">
          <button v-for="loc in placeLocations" :key="loc"
            @click="placeModal.location = loc"
            :class="[
              'py-2 px-3 rounded text-xs font-bold border transition-colors',
              placeModal.location === loc
                ? 'bg-emerald-700 border-emerald-500 text-emerald-100'
                : 'bg-surface-raised/40 border-line text-fg-secondary hover:bg-surface-hover/60'
            ]">
            {{ loc }}
          </button>
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" size="sm" @click="placeModal.show = false">取消</AppButton>
        <AppButton variant="primary" size="sm" :disabled="loading.action || !placeModal.location" @click="handlePlace">
          确认安置
        </AppButton>
      </template>
    </Modal>

    <!-- 二次确认弹窗（通用） -->
    <Modal :isOpen="confirmModal.show" :title="confirmModal.title" @close="confirmModal.show = false" width="420px">
      <p class="text-fg-secondary text-sm whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <AppButton variant="default" size="sm" @click="confirmModal.show = false">取消</AppButton>
        <AppButton variant="primary" size="sm" :disabled="loading.action" @click="confirmModal.onConfirm(); confirmModal.show = false">
          确认
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 侍妾面板组件脚本
 * 使用 Composition API，所有状态从后端拉取，禁止硬编码业务数据
 */
import { ref, reactive, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import PanelShell from '../ui/PanelShell.vue';
import Tabs from '../ui/Tabs.vue';
import AppButton from '../ui/AppButton.vue';
import EmptyState from '../ui/EmptyState.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
import { useUIStore } from '../../stores/ui';
import { formatCompact } from '../../utils/format';
import {
  concubineGetList,
  concubineSeekFate,
  concubineAskAfter,
  concubineBackfeed,
  concubineGift,
  concubinePlace,
  concubineRecall,
  concubineDismiss,
  concubineStartVoyage,
  concubineGetVoyageStatus,
  concubineReturnVoyage,
  concubineProtect,
  concubineAwaken,
  type ConcubineListData,
  type VoyageStatusData,
  type ConcubineVoyage,
  type Concubine
} from '../../api/companion';

/**
 * POST /concubine/seek-fate 的实测响应体（见 server/game/services/ConcubineService.js#seekFate）
 *
 * api/companion.ts 里的 SeekFateResult 仍是设计稿形状（found / concubine / seek_fate_remaining），
 * 后端这三个名字一个都没下发，因此面板自己声明这份形状；提示语在响应包装层，取回时并入 message。
 */
interface SeekFatePayload {
  /** 本次是否掉落侍妾 */
  is_drop: boolean;
  /** 是否稀有掉落 */
  is_rare: boolean;
  /** 掉落的侍妾是否已拥有（已拥有则不重复发放） */
  is_duplicate: boolean;
  /** 本次消耗灵石（字符串，免费时为 '0'） */
  cost_spirit_stones: string;
  /** 本次纳到的侍妾（未纳到为 null；后端只给这几项，没有境界） */
  obtained_concubine: {
    id: number;
    concubine_key: string;
    concubine_name: string;
    concubine_type: string;
    charm: number;
    intimacy: number;
    loyalty: number;
  } | null;
  /** 今日已寻缘次数（含本次） */
  today_count: number;
  /** 每日免费次数 */
  daily_free_count: number;
  /** 免费之外可额外购买的次数 */
  extra_seek_max_count: number;
  /** 后端提示语（取自响应包装层的 message，非 data 内字段） */
  message: string;
}

const uiStore = useUIStore();

/** Tab 配置（key/label 契约见 ui/Tabs.vue） */
const tabItems = [
  { key: 'list', label: '侍妾列表' },
  { key: 'seek_fate', label: '红尘寻缘' },
  { key: 'voyage', label: '远航' },
  { key: 'log', label: '日志' }
];
/** 当前激活 Tab */
const activeTab = ref('list');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/** 各模块加载状态 */
const loading = reactive({
  list: false,
  voyage: false,
  action: false
});

/** 各模块数据 */
const listData = ref<ConcubineListData | null>(null);
const voyageData = ref<VoyageStatusData | null>(null);
const lastSeekResult = ref<SeekFatePayload | null>(null);

/** 远航模式选项（4 种） */
const voyageModes = [
  { value: 'safe' as const, label: '稳妥', duration: '4 小时' },
  { value: 'balanced' as const, label: '均衡', duration: '8 小时' },
  { value: 'risky' as const, label: '冒险', duration: '12 小时' },
  { value: 'moon_palace' as const, label: '月殿寻痕', duration: '24 小时' }
];

/** 安置地点选项（与后端配置保持一致，可扩展） */
const placeLocations = ['药园', '洞府', '灵泉', '藏经阁'];

/** 远航表单 */
const voyageForm = reactive({
  concubineId: null as number | null,
  mode: null as 'safe' | 'balanced' | 'risky' | 'moon_palace' | null
});

/** 赠予物品弹窗 */
const giftModal = reactive({
  show: false,
  concubineId: null as number | null,
  itemKey: '',
  count: 1
});

/** 安置侍妾弹窗 */
const placeModal = reactive({
  show: false,
  concubineId: null as number | null,
  location: ''
});

/** 通用二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '操作确认',
  message: '',
  onConfirm: () => {}
});

/**
 * 计算属性：可派遣侍妾列表（用于远航选择）
 * 后端不下发 status，「空闲」即未安置且未远航
 */
const idleConcubines = computed<Concubine[]>(() => {
  if (!listData.value) return [];
  return listData.value.concubines.filter(c => !c.is_placed && !c.is_voyaging);
});

/** 侍妾 ID → 侍妾记录，用于把远航记录 / 寻缘结果关联到列表数据 */
const concubineById = computed<Map<number, Concubine>>(() => {
  const map = new Map<number, Concubine>();
  for (const c of listData.value?.concubines ?? []) map.set(c.id, c);
  return map;
});

/** 远航记录不带名字，列表还没加载时退回「侍妾 #ID」 */
function getConcubineName(concubineId: number): string {
  return concubineById.value.get(concubineId)?.concubine_name ?? `侍妾 #${concubineId}`;
}

/**
 * 远航记录分流：后端只给一份 voyages，
 * can_return（已过预计归来时间且仍在途中）为「归来待领取」，其余未领取的为「进行中」
 */
const returnableVoyages = computed<ConcubineVoyage[]>(() =>
  (voyageData.value?.voyages ?? []).filter(v => v.can_return));
const ongoingVoyages = computed<ConcubineVoyage[]>(() =>
  (voyageData.value?.voyages ?? []).filter(v => !v.can_return && !v.is_collected));

/**
 * 寻缘当日余量：只有 /concubine/seek-fate 的回信带当日次数，列表接口没有。
 * 未寻缘前一律按「未知」处理（null）—— 界面宁可整块不显示，也不印出编造的 0 / 4。
 */
const seekUsedToday = computed<number | null>(() => {
  const result = lastSeekResult.value;
  return result && typeof result.today_count === 'number' ? result.today_count : null;
});
const seekDailyLimit = computed<number | null>(() => {
  const result = lastSeekResult.value;
  if (!result) return null;
  if (typeof result.daily_free_count !== 'number' || typeof result.extra_seek_max_count !== 'number') return null;
  return result.daily_free_count + result.extra_seek_max_count;
});
const seekRemaining = computed<number | null>(() =>
  seekUsedToday.value === null || seekDailyLimit.value === null
    ? null : Math.max(0, seekDailyLimit.value - seekUsedToday.value));

/** 本次寻缘消耗的灵石（后端下发字符串，算术前先 Number） */
const seekCostStones = computed<number>(() => Number(lastSeekResult.value?.cost_spirit_stones ?? 0));

/** 寻缘回信不带境界等阶，改从刷新后的列表里按 ID 关联取 */
const seekResultConcubine = computed<Concubine | null>(() => {
  const obtainedId = lastSeekResult.value?.obtained_concubine?.id;
  if (obtainedId === undefined) return null;
  return concubineById.value.get(obtainedId) ?? null;
});

/**
 * 组件挂载时加载首个 Tab 数据
 */
onMounted(async () => {
  await loadList();
  loadedTabs.add('list');
});

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (loadedTabs.has(tabId)) return;
  if (tabId === 'voyage') await loadVoyageStatus();
  loadedTabs.add(tabId);
}

// ============ 数据加载函数 ============

/** 加载侍妾列表数据 */
async function loadList() {
  loading.list = true;
  try {
    const resp = await concubineGetList();
    if (resp.data?.code === 200 && resp.data.data) {
      listData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取侍妾列表失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.list = false;
  }
}

/** 加载远航状态数据 */
async function loadVoyageStatus() {
  loading.voyage = true;
  try {
    const resp = await concubineGetVoyageStatus();
    if (resp.data?.code === 200 && resp.data.data) {
      voyageData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取远航状态失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.voyage = false;
  }
}

// ============ 操作处理函数 ============

/** 红尘寻缘 */
async function handleSeekFate() {
  loading.action = true;
  try {
    const resp = await concubineSeekFate();
    // api/companion.ts 的 SeekFateResult 仍是设计稿字段，这里按后端实测形状接管
    const payload = resp.data.data as unknown as SeekFatePayload | null;
    if (resp.data?.code === 200 && payload) {
      lastSeekResult.value = { ...payload, message: resp.data.message || '' };
      uiStore.showToast(
        resp.data.message || (payload.obtained_concubine ? '寻得有缘人' : '缘分未至'),
        'success'
      );
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '寻缘失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 每日问安
 * @param concubineId 侍妾 ID
 */
async function handleAskAfter(concubineId: number) {
  loading.action = true;
  try {
    const resp = await concubineAskAfter(concubineId);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '问安完成', 'success');
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '问安失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 灵力反哺
 * @param concubineId 侍妾 ID
 */
async function handleBackfeed(concubineId: number) {
  showConfirm('灵力反哺', '确认进行灵力反哺？\n· 侍妾修为 +1000\n· 玩家修为消耗 500', async () => {
    loading.action = true;
    try {
      const resp = await concubineBackfeed(concubineId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '反哺完成', 'success');
        await loadList();
      } else {
        uiStore.showToast(resp.data?.message || '反哺失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 打开赠予物品弹窗
 * @param concubineId 侍妾 ID
 */
function openGiftModal(concubineId: number) {
  giftModal.concubineId = concubineId;
  giftModal.itemKey = '';
  giftModal.count = 1;
  giftModal.show = true;
}

/** 确认赠予物品 */
async function handleGift() {
  if (!giftModal.concubineId || !giftModal.itemKey.trim() || !giftModal.count || giftModal.count < 1 || giftModal.count > 99) {
    uiStore.showToast('请填写有效的物品 key 和数量（1-99）', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await concubineGift(giftModal.concubineId, giftModal.itemKey.trim(), giftModal.count);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '赠予成功', 'success');
      giftModal.show = false;
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '赠予失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 打开安置侍妾弹窗
 * @param concubineId 侍妾 ID
 */
function openPlaceModal(concubineId: number) {
  placeModal.concubineId = concubineId;
  placeModal.location = '';
  placeModal.show = true;
}

/** 确认安置侍妾 */
async function handlePlace() {
  if (!placeModal.concubineId || !placeModal.location) {
    uiStore.showToast('请选择安置地点', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await concubinePlace(placeModal.concubineId, placeModal.location);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '安置完成', 'success');
      placeModal.show = false;
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '安置失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 召回侍妾
 * @param concubineId 侍妾 ID
 */
async function handleRecall(concubineId: number) {
  loading.action = true;
  try {
    const resp = await concubineRecall(concubineId);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '已召回', 'success');
      await loadList();
    } else {
      uiStore.showToast(resp.data?.message || '召回失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 遣散侍妾（高风险操作，必须二次确认）
 * @param concubineId 侍妾 ID
 */
async function handleDismiss(concubineId: number) {
  showConfirm('遣散侍妾', '确认遣散此侍妾？\n· 操作不可撤销\n· 侍妾将永久离开，所有属性与羁绊归零', async () => {
    loading.action = true;
    try {
      const resp = await concubineDismiss(concubineId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '侍妾已遣散', 'success');
        await loadList();
      } else {
        uiStore.showToast(resp.data?.message || '遣散失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/** 开始远航 */
async function handleStartVoyage() {
  if (!voyageForm.concubineId || !voyageForm.mode) {
    uiStore.showToast('请选择侍妾与远航模式', 'warning');
    return;
  }
  showConfirm('开始远航', `确认派遣侍妾进行「${getVoyageModeLabel(voyageForm.mode)}」远航？`, async () => {
    loading.action = true;
    try {
      const resp = await concubineStartVoyage(voyageForm.concubineId!, voyageForm.mode!);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '远航已开始', 'success');
        // 重置表单
        voyageForm.concubineId = null;
        voyageForm.mode = null;
        // 刷新列表与远航状态
        await Promise.all([loadList(), loadVoyageStatus()]);
      } else {
        uiStore.showToast(resp.data?.message || '远航开启失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 远航归来
 * @param voyageId 远航 ID
 */
async function handleReturnVoyage(voyageId: number) {
  loading.action = true;
  try {
    const resp = await concubineReturnVoyage(voyageId);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '远航归来', 'success');
      await Promise.all([loadList(), loadVoyageStatus()]);
    } else {
      uiStore.showToast(resp.data?.message || '归来失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 请侍妾护法
 * @param concubineId 侍妾 ID
 */
async function handleProtect(concubineId: number) {
  showConfirm('请侍妾护法', '确认请此侍妾护法？\n· 侍妾将进入护法状态\n· 可提升玩家修炼效率', async () => {
    loading.action = true;
    try {
      const resp = await concubineProtect(concubineId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '已开始护法', 'success');
        await loadList();
      } else {
        uiStore.showToast(resp.data?.message || '护法失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 觉醒婉影
 * @param concubineId 侍妾 ID
 */
async function handleAwaken(concubineId: number) {
  showConfirm('觉醒婉影', '确认尝试觉醒此侍妾的婉影？\n· 觉醒后侍妾能力大幅提升\n· 觉醒过程消耗资源，且不保证成功', async () => {
    loading.action = true;
    try {
      const resp = await concubineAwaken(concubineId);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '觉醒完成', 'success');
        await loadList();
      } else {
        uiStore.showToast(resp.data?.message || '觉醒失败', 'error');
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
 * 侍妾当前状态：后端不下发 status，只能由 is_voyaging / is_placed 推导
 * （护法不落库到侍妾行，故没有「护法中」这一可呈现状态）
 * @param concubine 侍妾记录
 */
function getConcubineState(concubine: Concubine): 'voyaging' | 'placed' | 'idle' {
  if (concubine.is_voyaging) return 'voyaging';
  if (concubine.is_placed) return 'placed';
  return 'idle';
}

/**
 * 获取侍妾状态中文标签
 * @param status 状态值
 */
function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    idle: '空闲',
    placed: '已安置',
    voyaging: '远航中'
  };
  return map[status] || status;
}

/**
 * 获取侍妾状态徽章样式
 * @param status 状态值
 */
function getStatusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    idle: 'bg-surface-hover text-fg-secondary border border-line',
    placed: 'bg-emerald-950/60 text-emerald-300 border border-emerald-800',
    voyaging: 'bg-gold-900/60 text-gold-300 border border-gold-800'
  };
  return map[status] || 'bg-surface-hover text-fg-secondary border border-line';
}

/**
 * 获取远航模式中文标签
 * @param mode 远航模式
 */
function getVoyageModeLabel(mode: string): string {
  const map: Record<string, string> = {
    safe: '稳妥（4h）',
    balanced: '均衡（8h）',
    risky: '冒险（12h）',
    moon_palace: '月殿寻痕（24h）'
  };
  return map[mode] || mode;
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
