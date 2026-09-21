/**
 * 多人副本综合面板组件
 *
 * 批次3 多人副本系统 - 副本大厅 / 我的副本 / 奖励池 / 历史记录 综合面板
 *
 * Tab 划分：
 *   1. 副本大厅：按 /help 的 dungeons（以 dungeon_key 为键）渲染入口卡片，
 *      含名称/描述/人数/队长与队员境界门槛/幕数/冷却/奖励池概要
 *   2. 我的副本：显示当前玩家参与的副本详情（实例信息/变量/抉择/队长操作/投粽）
 *   3. 奖励池：按副本子页签展示普通掉落/首通奖励/稀有掉落表格（页签内置 4 个副本）
 *   4. 历史记录：分页展示玩家历史副本记录（含进行中的副本）
 *
 * 副本清单与人数/幕数/门槛一律以 /help 为准，不在前端列举
 * （后端 config/multi_dungeon_data.json 现有 10 个副本键，含 2026-07-21 新增的
 *  xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong）。
 *
 * 设计原则：
 *   - 所有状态从后端拉取，禁止硬编码业务数据
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 后端没给的字段一律显示「未知」，不补默认值、不印 undefined/NaN
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色一律取 tokens.css 的 surface-* / line-* / fg-* / gold-* 令牌（见 src/styles/tokens.css）
 *   - 外壳、页签、卡片、徽章、进度条复用 ui/ 基础件，不再自写遮罩与滚动条
 *   - 进度条颜色按数值分级：<30 血光 / 30-70 鎏金 / >70 灵木
 */
<template>
  <PanelShell
    title="多人副本 · 群英会战"
    :hint="dungeonHint"
    size="xl"
    @close="$emit('close')"
  >
    <!-- Tab 切换栏：切换时按需懒加载对应子模块 -->
    <Tabs
      :model-value="activeTab"
      :items="tabs"
      class="mb-3"
      @update:model-value="switchTab"
    />

    <div>

      <!-- ============ Tab 1: 副本大厅 ============ -->
      <div v-show="activeTab === 'hall'" class="space-y-3">
        <LoadingBlock v-if="loading.hall" text="加载副本大厅中…" />
        <template v-else-if="helpData">
          <!-- 流程状态说明：文案取自 /help 的 state_machine（后端配置，不前端硬编码） -->
          <PanelCard v-if="stateFlow.length" title="副本流程">
            <ul class="text-[11px] text-fg-muted space-y-1 list-disc pl-4">
              <li v-for="st in stateFlow" :key="st.key">{{ st.label }}：{{ st.desc }}</li>
            </ul>
          </PanelCard>

          <!-- 副本入口卡片：/help 的 dungeons 是以 dungeon_key 为键的对象 -->
          <section class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <PanelCard v-for="(dgn, dungeonKey) in helpData.dungeons" :key="dungeonKey" class="flex flex-col">
              <!-- 卡片头部 -->
              <div class="flex items-center justify-between mb-2">
                <div class="text-sm font-bold text-gold-300">{{ dgn.name }}</div>
                <Badge tone="gold">{{ dgn.act_count }} 幕</Badge>
              </div>
              <!-- 副本描述 -->
              <div class="text-[11px] text-fg-muted mb-3">{{ dgn.desc }}</div>
              <!-- 副本参数（字段名与 MultiDungeonService.getHelp 对齐） -->
              <div class="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] mb-3">
                <div>
                  <span class="text-fg-faint">人数：</span>
                  <span class="text-fg-primary">{{ dgn.member_min }}-{{ dgn.member_max }} 人</span>
                </div>
                <div>
                  <span class="text-fg-faint">集结时限：</span>
                  <span class="text-fg-primary">{{ dgn.expire_hours }} 小时</span>
                </div>
                <div>
                  <span class="text-fg-faint">队长门槛：</span>
                  <span class="text-gold-300">{{ dgn.leader_min_realm }}及以上</span>
                </div>
                <div>
                  <span class="text-fg-faint">队员门槛：</span>
                  <span class="text-gold-300">{{ dgn.member_min_realm }}及以上</span>
                </div>
                <div>
                  <span class="text-fg-faint">冷却：</span>
                  <span class="text-fg-primary">{{ dgn.cooldown_hours }} 小时</span>
                </div>
                <div>
                  <span class="text-fg-faint">奖励：</span>
                  <span class="text-emerald-300">{{ dgn.rewards_summary }}</span>
                </div>
              </div>
              <!-- 冷却状态 -->
              <div class="text-[11px] mb-3">
                <span class="text-fg-faint">当前：</span>
                <span v-if="cooldownOf(dungeonKey)?.in_cooldown" class="text-rose-400">
                  冷却中{{ cooldownLeftText(dungeonKey) ? `（剩余 ${cooldownLeftText(dungeonKey)}）` : '（剩余时间未知）' }}
                </span>
                <span v-else class="text-emerald-300">可开启</span>
              </div>
              <!-- 操作按钮：队长开启副本 -->
              <AppButton
                size="sm"
                variant="primary"
                block
                :disabled="loading.action || (cooldownOf(dungeonKey)?.in_cooldown ?? false)"
                @click="handleCreate(dungeonKey)"
              >
                开启副本
              </AppButton>
            </PanelCard>
          </section>

          <!-- 队员加入入口 -->
          <PanelCard title="加入他人副本" hint="输入队长分享的实例 ID，即可加入对应副本">
            <div class="flex items-center gap-2">
              <input v-model.number="joinInstanceId" type="number" min="1" placeholder="实例 ID"
                class="flex-1 min-w-0 bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-gold-500 focus:outline-none" />
              <AppButton
                size="sm"
                variant="primary"
                :disabled="loading.action || !joinInstanceId"
                @click="handleJoin"
              >
                加入副本
              </AppButton>
            </div>
          </PanelCard>
        </template>
        <EmptyState v-else text="暂无副本数据" hint="稍后重新进入「副本大厅」，或点击刷新重试" />
      </div>

      <!-- ============ Tab 2: 我的副本 ============ -->
      <div v-show="activeTab === 'mine'" class="space-y-3">
        <LoadingBlock v-if="loading.mine" text="加载副本进度中…" />
        <!-- /status 的 has_instance 为 false 时后端不下发 instance，直接按 instance 判空 -->
        <template v-else-if="instance">
          <PanelCard :padded="true">
            <!-- 实例信息头 -->
            <div class="flex items-center justify-between mb-3">
              <div>
                <div class="text-sm font-bold text-gold-300">{{ instance.dungeon_name }}</div>
                <div class="text-[10px] text-fg-faint">实例 ID：{{ instance.id }}</div>
              </div>
              <Badge :tone="getStatusTone(instance.instance_state)">
                {{ getStatusName(instance.instance_state) }}
              </Badge>
            </div>
            <!-- 当前幕数 -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
              <div>
                <div class="text-fg-faint">当前幕数</div>
                <div class="text-gold-300 font-bold">
                  第 {{ instance.current_act }} 幕
                  <span v-if="totalActs !== null"> / {{ totalActs }} 幕</span>
                  <span v-else class="text-fg-faint"> / 总幕数未知</span>
                </div>
              </div>
              <div>
                <div class="text-fg-faint">队长</div>
                <div v-if="leaderName !== null" class="text-fg-primary font-bold truncate">{{ leaderName }}</div>
                <div v-else class="text-fg-faint">未知</div>
              </div>
              <div>
                <div class="text-fg-faint">成员数</div>
                <div class="text-fg-primary font-bold">{{ members.length }} / {{ instance.member_max }} 人</div>
              </div>
              <div>
                <div class="text-fg-faint">我的身份</div>
                <div v-if="instance.is_leader" class="text-gold-300 font-bold">队长</div>
                <div v-else class="text-purple-300 font-bold">队员</div>
              </div>
            </div>
            <!-- 成员列表：/status 的 members 在 data 顶层，字段为 nickname/role/realm -->
            <div class="bg-surface-sunken border border-line-subtle rounded-control p-2 mb-3">
              <div class="text-[11px] text-fg-faint mb-1">成员列表</div>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-1">
                <div v-for="m in members" :key="m.player_id"
                  class="text-[11px] flex items-center gap-1 min-w-0">
                  <span class="truncate" :class="m.role === 'leader' ? 'text-gold-300' : 'text-fg-secondary'">
                    {{ m.nickname || `#${m.player_id}` }}
                  </span>
                  <span v-if="m.role === 'leader'" class="text-[9px] text-gold-500 shrink-0">[队长]</span>
                  <span v-if="m.realm" class="text-[9px] text-fg-faint shrink-0">[{{ m.realm }}]</span>
                </div>
              </div>
            </div>
          </PanelCard>

          <!-- 副本变量（进度条）：/status 的 variables 挂在 data 顶层，本面板只渲染已知且非 null 的变量 -->
          <PanelCard v-if="visibleVariables.length" title="副本变量">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div v-for="v in visibleVariables" :key="v.key" class="text-xs">
                <div class="flex items-center justify-between gap-2 mb-1">
                  <span class="text-fg-muted truncate">{{ v.label }}</span>
                  <!-- 虚天殿·道路选择特殊展示：0=未选 / 1=冰道 / 2=火道 -->
                  <span v-if="v.key === 'path_choice'" class="font-bold text-cyan-300 shrink-0">
                    {{ getPathChoiceText(Number(v.value)) }}
                  </span>
                  <!-- 通用数值展示：HP 一类的大数压缩显示，精确值放 title -->
                  <span v-else class="font-bold num shrink-0"
                    :class="getVariableValueClass(getVariablePercent(Number(v.value), v.key))"
                    :title="String(v.value)">{{ formatCompact(Number(v.value)) }}</span>
                </div>
                <!-- 进度条：根据数值高低显示不同颜色（道路选择不显示进度条） -->
                <StatBar
                  v-if="v.key !== 'path_choice'"
                  :value="getVariablePercent(Number(v.value), v.key)"
                  :max="100"
                  :tone="getVariableTone(getVariablePercent(Number(v.value), v.key))"
                  :show-value="false"
                />
              </div>
            </div>
          </PanelCard>

          <!-- 当前幕剧情 + 抉择：幕信息挂在 data.current_act，抉择挂在 data.current_act.choices -->
          <PanelCard v-if="currentAct" :title="`第 ${instance.current_act} 幕 · ${currentAct.act_name || '剧情推进'}`">
            <p v-if="currentAct.description" class="text-[12px] text-fg-secondary mb-3 whitespace-pre-line leading-relaxed">{{ currentAct.description }}</p>

            <!-- 昆吾山第三幕阵眼进度提示 -->
            <div v-if="currentAct.multi_choice_progress" class="mb-3 p-2 bg-surface-tint-arcane border border-purple-800 rounded-control text-[11px] text-purple-300">
              · 阵眼进度：{{ currentAct.multi_choice_progress.finished_count }} / {{ currentAct.multi_choice_progress.total_count }}
              <span v-if="currentAct.multi_choice_progress.next_eye_name">
                · 下一阵眼：{{ currentAct.multi_choice_progress.next_eye_name }}
              </span>
            </div>

            <!-- 抉择选项（仅队长可推进）：选项字段为 key / text / desc -->
            <div v-if="currentAct.choices && currentAct.choices.length">
              <div class="text-[11px] text-fg-faint mb-2">
                · {{ instance.is_leader ? '请队长抉择推进剧情' : '等待队长抉择' }}
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <button v-for="choice in currentAct.choices" :key="choice.key"
                  @click="handleChoose(choice.key)"
                  :disabled="loading.action || !instance.is_leader"
                  class="bg-surface-sunken border border-line rounded-control p-2 text-left hover:border-gold-600 disabled:opacity-50 disabled:cursor-not-allowed">
                  <div class="text-xs font-bold text-gold-300 mb-1">{{ choice.text }}</div>
                  <div v-if="choice.desc" class="text-[10px] text-fg-muted">{{ choice.desc }}</div>
                </button>
              </div>
            </div>

            <!-- 自动决战幕（昆吾山第四幕 / 虚天殿第六幕等）：由队长调用 /advance 一次性结算 -->
            <div v-else-if="currentAct.is_auto_advance" class="mt-2">
              <div class="text-[11px] text-fg-faint mb-2">
                · 本幕为自动决战，{{ instance.is_leader ? '请队长确认后触发战斗' : '等待队长触发决战' }}
              </div>
              <button v-if="instance.is_leader" @click="handleAdvance"
                :disabled="loading.action"
                class="w-full py-3 rounded-control text-sm font-bold bg-gradient-to-r from-rose-900 to-purple-900 border border-rose-600 text-gold-200 hover:from-rose-800 hover:to-purple-800 disabled:opacity-50 disabled:cursor-not-allowed">
                ⚔ {{ getAdvanceButtonText(currentAct) }}
              </button>
              <div v-else class="text-center text-[11px] text-fg-faint py-2">
                · 仅队长可触发决战
              </div>
            </div>
          </PanelCard>

          <!-- 队长操作区 -->
          <PanelCard v-if="instance.is_leader" title="队长操作">
            <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
              <!-- 进入开打：后端仅允许 preparing 状态进入 -->
              <button v-if="instance.instance_state === 'preparing'" @click="handleEnter"
                :disabled="loading.action"
                class="py-2 rounded-control text-xs font-bold bg-emerald-950/40 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-50">
                进入开打
              </button>
              <!-- 解散副本 -->
              <AppButton size="sm" variant="danger" :disabled="loading.action" @click="handleDissolve">
                解散副本
              </AppButton>
            </div>
            <!-- 踢人操作：后端仅允许 preparing 状态踢人 -->
            <div v-if="instance.instance_state === 'preparing'" class="mt-3 border-t border-line pt-3">
              <div class="text-[11px] text-fg-faint mb-2">· 选择成员踢出副本</div>
              <div class="flex items-center gap-2">
                <select v-model.number="kickTargetId"
                  class="flex-1 min-w-0 bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-rose-500 focus:outline-none">
                  <option value="">选择成员</option>
                  <option v-for="m in kickableMembers(members)" :key="m.player_id" :value="m.player_id">
                    {{ m.nickname || `#${m.player_id}` }}（ID: {{ m.player_id }}）
                  </option>
                </select>
                <AppButton size="sm" variant="danger" :disabled="loading.action || !kickTargetId" @click="handleKick">
                  踢出
                </AppButton>
              </div>
            </div>
          </PanelCard>

          <!-- 端午投粽：后端只接受 preparing 状态的端午副本，队长与队员皆可投 -->
          <PanelCard v-if="instance.dungeon_key === 'duanwu' && instance.instance_state === 'preparing'"
            title="端午投粽" hint="每次投 1-5 个美味肉粽，计入个人与全队投粽数；开打时全队未投将触发空舟惩罚">
            <div class="flex items-center gap-2">
              <input v-model.number="zongziCount" type="number" min="1" max="5" placeholder="1-5"
                class="flex-1 min-w-0 bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-purple-500 focus:outline-none" />
              <button @click="handleThrowZongzi"
                :disabled="loading.action || !zongziCount || zongziCount < 1 || zongziCount > 5"
                class="px-4 py-2 rounded-control text-xs font-bold bg-purple-700 text-purple-100 hover:bg-purple-600 disabled:opacity-50">
                投粽
              </button>
            </div>
          </PanelCard>
        </template>
        <!-- 无副本空状态 -->
        <EmptyState v-else text="当前未参与任何副本" hint="前往「副本大厅」开启或加入副本" />
      </div>

      <!-- ============ Tab 3: 奖励池 ============ -->
      <div v-show="activeTab === 'rewards'" class="space-y-3">
        <!-- 子页签切换：每个副本一份奖励表 -->
        <Tabs
          :model-value="rewardSubTab"
          :items="rewardSubTabs"
          class="mb-2"
          @update:model-value="switchRewardSub"
        />

        <LoadingBlock v-if="loading.rewards" text="加载奖励池中…" />
        <template v-else-if="rewardsData">
          <!-- 普通掉落 -->
          <PanelCard title="普通掉落">
            <div v-if="rewardsData.normal_rewards.length === 0" class="text-[11px] text-fg-faint text-center py-2">暂无</div>
            <table v-else class="w-full text-[11px]">
              <thead>
                <tr class="text-fg-faint border-b border-line">
                  <th class="text-left py-1">名称</th>
                  <th class="text-left py-1">描述</th>
                  <th class="text-right py-1">数量/概率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rewardsData.normal_rewards" :key="r.reward_key" class="border-b border-line-subtle">
                  <td class="py-1 text-gold-300">{{ r.name }}</td>
                  <td class="py-1 text-fg-muted">{{ r.description || '-' }}</td>
                  <td class="py-1 text-right text-fg-primary">{{ r.amount ?? '-' }}</td>
                </tr>
              </tbody>
            </table>
          </PanelCard>
          <!-- 首通奖励 -->
          <PanelCard title="首通奖励">
            <div v-if="rewardsData.first_clear_rewards.length === 0" class="text-[11px] text-fg-faint text-center py-2">暂无</div>
            <table v-else class="w-full text-[11px]">
              <thead>
                <tr class="text-fg-faint border-b border-line">
                  <th class="text-left py-1">名称</th>
                  <th class="text-left py-1">描述</th>
                  <th class="text-right py-1">数量</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rewardsData.first_clear_rewards" :key="r.reward_key" class="border-b border-line-subtle">
                  <td class="py-1 text-purple-300">{{ r.name }}</td>
                  <td class="py-1 text-fg-muted">{{ r.description || '-' }}</td>
                  <td class="py-1 text-right text-fg-primary">{{ r.amount ?? '-' }}</td>
                </tr>
              </tbody>
            </table>
          </PanelCard>
          <!-- 稀有掉落 -->
          <PanelCard title="稀有掉落">
            <div v-if="rewardsData.rare_rewards.length === 0" class="text-[11px] text-fg-faint text-center py-2">暂无</div>
            <table v-else class="w-full text-[11px]">
              <thead>
                <tr class="text-fg-faint border-b border-line">
                  <th class="text-left py-1">名称</th>
                  <th class="text-left py-1">描述</th>
                  <th class="text-right py-1">数量/概率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rewardsData.rare_rewards" :key="r.reward_key" class="border-b border-line-subtle">
                  <td class="py-1 text-rose-300">{{ r.name }}</td>
                  <td class="py-1 text-fg-muted">{{ r.description || '-' }}</td>
                  <td class="py-1 text-right text-fg-primary">{{ r.amount ?? '-' }}</td>
                </tr>
              </tbody>
            </table>
          </PanelCard>
        </template>
        <EmptyState v-else text="暂无奖励数据" />
      </div>

      <!-- ============ Tab 4: 历史记录 ============ -->
      <div v-show="activeTab === 'history'" class="space-y-3">
        <PanelCard :padded="true">
          <div class="flex items-center justify-between gap-2 mb-3">
            <div class="text-sm font-bold text-gold-300">副本历史</div>
            <div class="flex items-center gap-2 text-xs">
              <AppButton
                size="xs"
                :disabled="loading.history || historyData.page <= 1"
                @click="changeHistoryPage(historyData.page - 1)"
              >上一页</AppButton>
              <span class="text-fg-muted num">{{ historyData.page }} / {{ historyTotalPages }}</span>
              <AppButton
                size="xs"
                :disabled="loading.history || historyData.page >= historyTotalPages"
                @click="changeHistoryPage(historyData.page + 1)"
              >下一页</AppButton>
            </div>
          </div>
          <LoadingBlock v-if="loading.history" text="加载历史记录中…" />
          <EmptyState v-else-if="historyData.records.length === 0" text="暂无历史记录" hint="参与一场多人副本后在此回看结果与幕数" />
          <div v-else class="space-y-1 max-h-96 overflow-y-auto scroll-thin">
            <div v-for="rec in historyData.records" :key="`${rec.instance_id}-${rec.join_time}`"
              class="bg-surface-sunken border border-line-subtle rounded-control p-2 text-[11px]">
              <div class="flex items-center justify-between gap-2 mb-1">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-gold-300 font-bold truncate">{{ rec.dungeon_name }}</span>
                  <Badge v-if="rec.first_clear" tone="arcane">首通</Badge>
                  <Badge :tone="getStatusTone(rec.instance_state)">{{ getStatusName(rec.instance_state) }}</Badge>
                </div>
                <span class="text-fg-faint num shrink-0" :title="historyTime(rec) || ''">{{ formatTimeString(historyTime(rec)) }}</span>
              </div>
              <div class="text-fg-muted">
                · 进度：第 {{ rec.current_act }} 幕<span v-if="actCountOf(rec.dungeon_key) !== null"> / {{ actCountOf(rec.dungeon_key) }} 幕</span>
              </div>
              <div class="text-fg-muted">
                · 身份：{{ rec.role === 'leader' ? '队长' : '队员' }}
                <span v-if="rec.contribution !== null"> · 贡献 {{ rec.contribution }}</span>
              </div>
            </div>
          </div>
        </PanelCard>
      </div>
    </div>

    <!-- 二次确认弹窗（通用） -->
    <Modal :isOpen="confirmModal.show" :title="confirmModal.title" @close="confirmModal.show = false" width="420px">
      <p class="text-fg-secondary text-sm whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <AppButton size="sm" variant="ghost" @click="confirmModal.show = false">取消</AppButton>
        <AppButton
          size="sm"
          variant="primary"
          :disabled="loading.action"
          @click="confirmModal.onConfirm(); confirmModal.show = false"
        >
          确认
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 多人副本综合面板脚本
 * 4 Tab 共享一个面板，按需懒加载对应子模块数据
 */
import { ref, reactive, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import PanelShell from '../ui/PanelShell.vue';
import Tabs from '../ui/Tabs.vue';
import PanelCard from '../ui/PanelCard.vue';
import Badge from '../ui/Badge.vue';
import AppButton from '../ui/AppButton.vue';
import StatBar from '../ui/StatBar.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
import EmptyState from '../ui/EmptyState.vue';
import { useUIStore } from '../../stores/ui';
import { formatCompact } from '../../utils/format';
import {
  multiDungeonGetHelp,
  multiDungeonCreate,
  multiDungeonJoin,
  multiDungeonEnter,
  multiDungeonGetStatus,
  multiDungeonChoose,
  multiDungeonAdvance,
  multiDungeonThrowZongzi,
  multiDungeonDissolve,
  multiDungeonKick,
  multiDungeonGetRewards,
  multiDungeonGetHistory,
  multiDungeonGetCooldown,
  type DungeonKey
} from '../../api/multiDungeon';

/**
 * 本面板用到的服务端契约（键名逐字对齐 MultiDungeonService 的返回）
 *
 * client/src/api/multiDungeon.ts 的类型声明已与后端脱节（/help 的 dungeons 是以
 * dungeon_key 为键的对象、/status 的抉择挂在 data.current_act.choices、成员挂在
 * data.members），按那份声明取值会读到 undefined，故在此重述真实结构。
 * 状态机取值见 models/multiDungeonInstance.js：preparing/active/cleared/failed/dissolved。
 */

/** 抉择项：current_act.choices 与阵眼 next_eye_choices 同构 */
interface MChoice {
  key: string;
  text: string;
  desc: string;
}

/** GET /help → data.dungeons[dungeon_key] */
interface MDungeonHelp {
  name: string;
  desc: string;
  member_min: number;
  member_max: number;
  leader_min_realm: string;
  leader_min_realm_rank: number;
  member_min_realm: string;
  member_min_realm_rank: number;
  consume_item_key: string | null;
  consume_item_count: number | null;
  cooldown_hours: number;
  expire_hours: number;
  act_count: number;
  has_empty_boat_penalty: boolean;
  rewards_summary: string;
}

/** GET /help → data */
interface MHelpData {
  dungeons: Record<string, MDungeonHelp>;
  state_machine?: Record<string, { next_states?: string[]; description?: string }>;
  global_bounds?: Record<string, unknown>;
  /** 变量中文名与归属副本（GM 管理面板的下拉用它，玩家面板的变量名来自 /status 的同名字段） */
  variable_meta?: Record<string, { label?: string; dungeons?: string[] | null }>;
}

/** GET /status → data.current_act（currentAct.multi_choice_progress 仅阵眼幕非空） */
interface MCurrentAct {
  act_number: number;
  act_name: string;
  description: string;
  is_final_act: boolean;
  is_random_choice: boolean;
  is_multi_choice_act: boolean;
  is_auto_advance: boolean;
  rounds_max: number | null;
  choices: MChoice[];
  escape_choices: unknown[];
  multi_choice_progress: {
    finished_count: number;
    total_count: number;
    next_eye_key: string | null;
    next_eye_name: string | null;
    next_eye_choices: MChoice[];
  } | null;
}

/** GET /status → data.instance（注意：这里的 current_act 是幕号） */
interface MInstanceSummary {
  id: number;
  dungeon_key: string;
  dungeon_name: string;
  instance_state: string;
  current_act: number;
  current_act_state: string;
  member_count: number;
  member_max: number;
  member_min: number;
  expire_at: string | null;
  started_at: string | null;
  is_leader: boolean;
  role: string;
}

/** GET /status → data.members[] */
interface MMember {
  player_id: number;
  nickname: string | null;
  realm: string | null;
  role: string;
  contribution: number;
  zongzi_invested: number;
  is_ready: boolean;
}

/** GET /status → data（HP 类变量后端返回字符串，未进入对应幕时为 null） */
interface MStatusData {
  has_instance: boolean;
  message?: string;
  instance?: MInstanceSummary;
  variables?: Record<string, number | string | null>;
  current_act?: MCurrentAct | null;
  members?: MMember[];
  history_choices?: unknown[];
}

/** GET /rewards → data */
interface MRewardEntry {
  reward_key: string;
  name: string;
  description: string;
  amount: string;
  type: string;
}
interface MRewardsData {
  dungeon_key: string;
  dungeon_name: string;
  normal_rewards: MRewardEntry[];
  first_clear_rewards: MRewardEntry[];
  rare_rewards: MRewardEntry[];
  rewards?: Record<string, unknown>;
}

/** GET /history → data.records[]（含进行中与已结束） */
interface MHistoryRecord {
  instance_id: number;
  dungeon_key: string;
  dungeon_name: string;
  role: string;
  instance_state: string;
  current_act: number;
  first_clear: boolean;
  contribution: number | null;
  zongzi_invested: number;
  started_at: string | null;
  cleared_at: string | null;
  dissolved_at: string | null;
  join_time: string | null;
}
interface MHistoryData {
  records: MHistoryRecord[];
  total: number;
  page: number;
  size: number;
}

/** GET /cooldown → data.cooldowns[dungeon_key]（冷却中才带 remaining_ms） */
interface MCooldownEntry {
  dungeon_key: string;
  in_cooldown: boolean;
  cooldown_end_time?: string;
  cooldown_hours?: number;
  reason?: string;
  remaining_ms?: number;
}

/** 副本终态：进入即由后端给全员铺冷却（见 MultiDungeonService.TERMINAL_STATES） */
const FINISHED_STATES = ['cleared', 'failed', 'dissolved'];

const uiStore = useUIStore();

/** Tab 配置（key/label 契约见 ui/Tabs.vue） */
const tabs = [
  { key: 'hall', label: '副本大厅' },
  { key: 'mine', label: '我的副本' },
  { key: 'rewards', label: '奖励池' },
  { key: 'history', label: '历史记录' }
];
/** 当前激活 Tab */
const activeTab = ref('hall');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/**
 * 奖励池子页签配置（key/label 契约见 ui/Tabs.vue）
 *
 * 副本清单与中文名取自 /help 的 dungeons（内容是 multi_dungeon_data.json）。
 * 这里以前写死 4 个副本，其余 6 个副本的奖励表在界面上根本进不去，
 * 新增一个 DLC 副本还得回来改这一处。
 */
const rewardSubTabs = computed<Array<{ key: string; label: string }>>(() =>
  Object.entries(helpData.value?.dungeons || {}).map(([key, dgn]) => ({ key, label: dgn?.name || key }))
);
/** 奖励池当前子页签；空串表示副本清单还没到手，由 ensureRewardSub() 兜首个 */
const rewardSubTab = ref('');
/** 面板副标题：可打的副本名，跟着内容走 */
const dungeonHint = computed(() => rewardSubTabs.value.map(t => t.label).join(' · '));

/** 各模块加载状态 */
const loading = reactive({
  hall: false,
  mine: false,
  rewards: false,
  history: false,
  action: false
});

/** 各模块数据 */
const helpData = ref<MHelpData | null>(null);
const statusData = ref<MStatusData | null>(null);
const rewardsData = ref<MRewardsData | null>(null);
const cooldownList = ref<MCooldownEntry[]>([]);
const historyData = reactive<MHistoryData>({
  records: [], total: 0, page: 1, size: 20
});

/** 输入框绑定值 */
const joinInstanceId = ref<number | null>(null); // 队员加入实例 ID
const kickTargetId = ref<number | null>(null);   // 队长踢人目标
const zongziCount = ref<number | null>(null);    // 端午投粽数量

/** 通用二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '操作确认',
  message: '',
  onConfirm: () => {}
});

/**
 * 组件挂载时加载首个 Tab 数据 + 冷却状态
 */
onMounted(async () => {
  await Promise.all([loadHall(), loadCooldown()]);
  loadedTabs.add('hall');
});

// ============ 视图派生数据（后端没给的就是 null，界面显示「未知」） ============

/** /status 的三个挂载点：实例概要、成员、当前幕（无副本时全为空） */
const instance = computed<MInstanceSummary | null>(() => statusData.value?.instance ?? null);
const members = computed<MMember[]>(() => statusData.value?.members ?? []);
const currentAct = computed<MCurrentAct | null>(() => statusData.value?.current_act ?? null);

/** 队长道号：/status 只在 members 里给出 role=leader 的成员 */
const leaderName = computed<string | null>(() => {
  const leader = members.value.find(m => m.role === 'leader');
  return leader?.nickname || (leader ? `#${leader.player_id}` : null);
});

/**
 * 某个副本的总幕数：/status 不返回，取自 /help 的 act_count
 * @param key 副本 key
 */
function actCountOf(key: string | undefined | null): number | null {
  if (!key) return null;
  const n = helpData.value?.dungeons?.[key]?.act_count;
  return typeof n === 'number' ? n : null;
}
/** 当前副本的总幕数 */
const totalActs = computed(() => actCountOf(instance.value?.dungeon_key));

/**
 * 当前可见变量：名字与归属全部来自后端 /status 的 variable_meta
 * （内容由 config/multi_dungeon_data.json 的 global.variable_labels 与各副本的 instance_vars/member_vars 生成）。
 *
 * 这里以前另抄着一份 15 条的中文名字典和一份 9 条的归属字典：内容里已经写了 40 个变量，
 * 抄的那份既少（25 个键只能走兜底）又新（两处文案已经和内容对不上）。
 * 现在新增副本变量只改内容就行，面板不用再动 —— 没有标签的键一律不显示，不印裸键名。
 */
const visibleVariables = computed<Array<{ key: string; label: string; value: number | string }>>(() => {
  const vars = statusData.value?.variables;
  const dungeonKey = instance.value?.dungeon_key;
  if (!vars || !dungeonKey) return [];
  const meta = statusData.value?.variable_meta || {};
  const out: Array<{ key: string; label: string; value: number | string }> = [];
  for (const [key, value] of Object.entries(vars)) {
    if (value === null || value === undefined) continue;
    const entry = meta[key];
    if (!entry?.label) continue;
    // dungeons 为 null 表示各副本通用；否则只在列出的副本里显示，
    // 免得在掩月副本里印出「魔气 0」这类属于别的副本的库表默认值
    if (Array.isArray(entry.dungeons) && !entry.dungeons.includes(dungeonKey)) continue;
    out.push({ key, label: entry.label, value });
  }
  return out;
});

/** /help 的 state_machine：只渲染有中文文案的五个状态，其余键（超时配置等）忽略 */
const stateFlow = computed<Array<{ key: string; label: string; desc: string }>>(() => {
  const sm = helpData.value?.state_machine;
  if (!sm) return [];
  return ['preparing', 'active', 'cleared', 'failed', 'dissolved']
    .filter(k => sm[k] && typeof sm[k].description === 'string')
    .map(k => {
      const raw = (sm[k]!.description as string).trim();
      // 后端文案自带「准备中：」这类状态名前缀，和前端状态名撞车，只取说明部分
      const cut = raw.indexOf('：');
      return { key: k, label: getStatusName(k), desc: cut > 0 && cut <= 8 ? raw.slice(cut + 1).trim() : raw };
    });
});

/** 历史总页数：后端只给 total + size，页数由前端推导 */
const historyTotalPages = computed(() =>
  Math.max(1, Math.ceil((historyData.total || 0) / (historyData.size || 20))));

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (loadedTabs.has(tabId)) return;
  if (tabId === 'hall') await loadHall();
  else if (tabId === 'mine') await loadStatus();
  else if (tabId === 'rewards') await loadRewards(await ensureRewardSub());
  else if (tabId === 'history') await loadHistory();
  loadedTabs.add(tabId);
}

/**
 * 奖励池要先有个子页签：副本清单来自 /help，没到手就补拉一次，然后选中第一个副本。
 * @returns 可用的 dungeon_key；内容里一个副本都没有时返回空串
 */
async function ensureRewardSub() {
  if (!helpData.value) await loadHall();
  const keys = rewardSubTabs.value.map(t => t.key);
  if (!keys.includes(rewardSubTab.value)) rewardSubTab.value = keys[0] || '';
  return rewardSubTab.value;
}

/**
 * 奖励池子页签切换
 * @param subKey 子页签 key
 */
async function switchRewardSub(subKey: DungeonKey) {
  rewardSubTab.value = subKey;
  await loadRewards(subKey);
}

// ============ 数据加载函数 ============

/** 加载副本大厅（流程状态 + 副本列表） */
async function loadHall() {
  loading.hall = true;
  try {
    const resp = await multiDungeonGetHelp();
    if (resp.data?.code === 200 && resp.data.data) {
      helpData.value = resp.data.data as unknown as MHelpData;
    } else {
      uiStore.showToast(resp.data?.message || '获取副本大厅数据失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.hall = false;
  }
}

/** 加载冷却状态 */
async function loadCooldown() {
  try {
    const resp = await multiDungeonGetCooldown();
    if (resp.data?.code === 200 && resp.data.data) {
      // 后端 MultiDungeonService.getCooldown 返回的是按副本 key 索引的对象
      // （cooldowns.yanyue = { in_cooldown, ... }），而这里要的是带 dungeon_key
      // 的数组（api 的类型声明也是数组）。直接赋值会让 cooldownOf() 里的
      // .find 抛 "is not a function"，面板每次打开都白屏。
      // 用 Array.isArray 而不是 || [] ：对象是 truthy，挡不住错误形态。
      const raw = resp.data.data.cooldowns;
      cooldownList.value = Array.isArray(raw)
        ? raw
        : Object.entries(raw || {}).map(([dungeon_key, v]) => ({ dungeon_key, ...(v as object) } as any));
    }
  } catch (e: any) {
    // 冷却状态加载失败不弹 toast，避免刷屏
    console.warn('加载副本冷却状态失败:', e);
  }
}

/**
 * 获取指定副本的冷却信息
 * @param key 副本 key
 */
function cooldownOf(key: string): MCooldownEntry | undefined {
  return cooldownList.value.find(c => c.dungeon_key === key);
}

/**
 * 冷却剩余文案：后端给的是 remaining_ms（毫秒），缺失时返回 null 由界面显示未知
 * @param key 副本 key
 */
function cooldownLeftText(key: string): string | null {
  const ms = cooldownOf(key)?.remaining_ms;
  return typeof ms === 'number' ? formatTime(Math.ceil(ms / 1000)) : null;
}

/** 加载我的副本进度 */
async function loadStatus() {
  loading.mine = true;
  try {
    const resp = await multiDungeonGetStatus();
    if (resp.data?.code === 200 && resp.data.data) {
      statusData.value = resp.data.data as unknown as MStatusData;
    } else {
      uiStore.showToast(resp.data?.message || '获取副本进度失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.mine = false;
  }
}

/**
 * 加载奖励池
 * @param key 副本 key
 */
async function loadRewards(key: DungeonKey) {
  if (!key) return; // 副本清单没到手（/help 失败或内容里没有副本），不发无 key 的请求
  loading.rewards = true;
  try {
    const resp = await multiDungeonGetRewards(key);
    if (resp.data?.code === 200 && resp.data.data) {
      rewardsData.value = resp.data.data as unknown as MRewardsData;
    } else {
      uiStore.showToast(resp.data?.message || '获取奖励池失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.rewards = false;
  }
}

/** 加载历史记录 */
async function loadHistory() {
  loading.history = true;
  try {
    const resp = await multiDungeonGetHistory(historyData.page, historyData.size);
    if (resp.data?.code === 200 && resp.data.data) {
      const payload = resp.data.data as unknown as Partial<MHistoryData>;
      historyData.records = Array.isArray(payload.records) ? payload.records : [];
      historyData.total = payload.total ?? 0;
      historyData.page = payload.page ?? 1;
      historyData.size = payload.size ?? historyData.size;
    } else {
      uiStore.showToast(resp.data?.message || '获取历史记录失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.history = false;
  }
}

/**
 * 历史记录翻页
 * @param page 目标页码
 */
async function changeHistoryPage(page: number) {
  if (page < 1 || page > historyTotalPages.value) return;
  historyData.page = page;
  await loadHistory();
}

// ============ 操作处理函数 ============

/**
 * 业务是否成功
 * 后端路由把失败也包成 code:200，只靠 code 判成功会把「副本已满员」
 * 这类失败弹成绿条，判别字段是 success（见 routes/multi_dungeon.js sendServiceResult）。
 * @param resp axios 响应
 */
function isBizOk(resp: { data?: { code?: number; success?: boolean } }): boolean {
  return resp?.data?.code === 200 && resp.data.success !== false;
}

/**
 * 取后端业务消息（失败时的原因文案）
 * @param resp axios 响应
 * @param fallback 后端没给文案时的兜底
 */
function bizMessage(resp: { data?: { message?: string } }, fallback: string): string {
  return resp?.data?.message || fallback;
}

/**
 * 队长开启副本
 * @param dungeonKey 副本 key（来自 /help 的 dungeons 键名）
 */
function handleCreate(dungeonKey: string) {
  // /help 的 dungeons 是以 dungeon_key 为键的对象，不是数组
  const dgn = helpData.value?.dungeons?.[dungeonKey] as { name?: string } | undefined;
  showConfirm(
    '开启副本',
    `确认以队长身份开启「${dgn?.name || dungeonKey}」副本？\n· 需等待队员加入后由你「进入开打」\n· 解散前不可再开新副本`,
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonCreate(dungeonKey as DungeonKey);
        if (isBizOk(resp)) {
          uiStore.showToast(bizMessage(resp, '副本已开启'), 'success');
          // 切换到「我的副本」Tab 查看
          await switchTab('mine');
          await loadStatus();
          await loadCooldown();
        } else {
          uiStore.showToast(bizMessage(resp, '开启失败'), 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        loading.action = false;
      }
    }
  );
}

/** 队员加入副本 */
async function handleJoin() {
  if (!joinInstanceId.value || joinInstanceId.value <= 0) {
    uiStore.showToast('请输入有效的实例 ID', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await multiDungeonJoin(joinInstanceId.value);
    if (isBizOk(resp)) {
      uiStore.showToast(bizMessage(resp, '加入成功'), 'success');
      joinInstanceId.value = null;
      // 切换到「我的副本」Tab 查看
      await switchTab('mine');
      await loadStatus();
    } else {
      uiStore.showToast(bizMessage(resp, '加入失败'), 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 队长进入开打 */
async function handleEnter() {
  loading.action = true;
  try {
    const resp = await multiDungeonEnter();
    if (isBizOk(resp)) {
      uiStore.showToast(bizMessage(resp, '已进入开打'), 'success');
      await loadStatus();
    } else {
      uiStore.showToast(bizMessage(resp, '进入失败'), 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 队长推进抉择
 * @param choiceKey 选项 key（current_act.choices[].key；阵眼幕后端也接受裸选项键）
 */
async function handleChoose(choiceKey: string) {
  showConfirm(
    '推进抉择',
    `确认推进此选项？\n· 抉择不可撤回\n· 变量变化将立即生效`,
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonChoose(choiceKey);
        if (isBizOk(resp)) {
          uiStore.showToast(bizMessage(resp, '抉择已推进'), 'success');
          await loadStatus();
          // 副本结束时同步刷新冷却：choose 的返回里没有 is_finished，终态看 instance_state
          const state = (resp.data?.data as unknown as { instance_state?: string } | null)?.instance_state;
          if (state && FINISHED_STATES.includes(state)) {
            await loadCooldown();
          }
        } else {
          uiStore.showToast(bizMessage(resp, '推进失败'), 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        loading.action = false;
      }
    }
  );
}

/**
 * 队长触发自动决战（昆吾山第四幕 / 虚天殿第六幕等 is_auto_advance 幕）
 * 一次性结算自动战斗，不可中途干预
 * 幕名、回合上限、结算说明全部取 /status 的 current_act，前端不再硬编码数值公式
 */
function handleAdvance() {
  const act = currentAct.value;
  const title = act?.act_name || '自动决战';
  const detail = [
    `确认触发「${title}」？`,
    `· 系统将自动结算本幕战斗${typeof act?.rounds_max === 'number' ? `（至多 ${act.rounds_max} 回合）` : ''}`,
    '· 一次性结算，不可中途干预'
  ];
  if (act?.description) detail.push('', act.description);

  showConfirm(
    title,
    detail.join('\n'),
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonAdvance();
        if (isBizOk(resp) && resp.data.data) {
          const result = resp.data.data;
          // 展示决战结果详情（各副本共用 rounds_log 骨架，回合伤害字段一致）
          const roundsLog = result.auto_battle?.rounds_log || [];
          let totalDamage = BigInt(0);
          try {
            for (const r of roundsLog) {
              totalDamage += BigInt(r.damage);
            }
          } catch (bigintErr) {
            // BigInt 转换失败时降级为数字求和
            totalDamage = BigInt(roundsLog.reduce((sum, r) => sum + (parseInt(r.damage, 10) || 0), 0));
          }
          const detailMsg = roundsLog.length > 0
            ? `\n\n战斗回合：${result.auto_battle.rounds_total}\n总伤害：${formatCompact(totalDamage)}`
            : '';
          uiStore.showToast(
            bizMessage(resp, '决战完成') + detailMsg,
            result.instance_state === 'cleared' ? 'success' : 'error'
          );
          await loadStatus();
          // 副本结束同步刷新冷却
          await loadCooldown();
        } else {
          uiStore.showToast(bizMessage(resp, '决战失败'), 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        loading.action = false;
      }
    }
  );
}

/**
 * 获取自动决战按钮文案（幕名与回合上限取后端）
 * @param act 当前幕
 * @returns 按钮文案，如 触发「玲珑封魔塔决战」（5 回合）
 */
function getAdvanceButtonText(act: MCurrentAct | null): string {
  const base = act?.act_name ? `触发「${act.act_name}」` : '触发决战';
  return typeof act?.rounds_max === 'number' ? `${base}（${act.rounds_max} 回合）` : base;
}

/**
 * 获取虚天殿·道路选择中文名
 * @param val 道路选择值（0=未选 / 1=冰道 / 2=火道）
 * @returns 中文名
 */
function getPathChoiceText(val: number): string {
  const map: Record<number, string> = {
    0: '未选',
    1: '冰道',
    2: '火道'
  };
  return map[val] ?? String(val);
}

/** 端午投粽 */
async function handleThrowZongzi() {
  if (!zongziCount.value || zongziCount.value < 1 || zongziCount.value > 5) {
    uiStore.showToast('投粽数量需在 1-5 之间', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await multiDungeonThrowZongzi(zongziCount.value);
    if (isBizOk(resp)) {
      uiStore.showToast(bizMessage(resp, '投粽成功'), 'success');
      zongziCount.value = null;
      await loadStatus();
    } else {
      uiStore.showToast(bizMessage(resp, '投粽失败'), 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 队长解散副本 */
function handleDissolve() {
  showConfirm(
    '解散副本',
    '确认解散当前副本？\n· 操作不可撤销\n· 所有成员将退出副本',
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonDissolve();
        if (isBizOk(resp)) {
          uiStore.showToast(bizMessage(resp, '副本已解散'), 'success');
          await loadStatus();
        } else {
          uiStore.showToast(bizMessage(resp, '解散失败'), 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        loading.action = false;
      }
    }
  );
}

/** 队长踢人 */
function handleKick() {
  if (!kickTargetId.value || kickTargetId.value <= 0) {
    uiStore.showToast('请选择要踢出的成员', 'warning');
    return;
  }
  const target = members.value.find(m => m.player_id === kickTargetId.value);
  showConfirm(
    '踢出成员',
    `确认将「${target?.nickname || `玩家 #${kickTargetId.value}`}」踢出副本？\n· 该玩家将立即退出副本`,
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonKick(kickTargetId.value!);
        if (isBizOk(resp)) {
          uiStore.showToast(bizMessage(resp, '已踢出'), 'success');
          kickTargetId.value = null;
          await loadStatus();
        } else {
          uiStore.showToast(bizMessage(resp, '踢人失败'), 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        loading.action = false;
      }
    }
  );
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
 * 获取副本状态中文名（取值见 models/multiDungeonInstance.js 的 instance_state）
 * @param status 状态值
 */
function getStatusName(status: string): string {
  const map: Record<string, string> = {
    preparing: '集结中',
    active: '进行中',
    cleared: '已通关',
    failed: '已失败',
    dissolved: '已解散'
  };
  return map[status] || status;
}

/**
 * 获取副本状态徽章色阶（tone 契约见 ui/Badge.vue）
 * @param status 状态值
 */
function getStatusTone(status: string): 'gold' | 'success' | 'arcane' | 'neutral' | 'danger' {
  const map: Record<string, 'gold' | 'success' | 'arcane' | 'neutral' | 'danger'> = {
    preparing: 'gold',
    active: 'success',
    cleared: 'arcane',
    failed: 'danger',
    dissolved: 'neutral'
  };
  return map[status] || 'neutral';
}

/**
 * 历史记录的展示时间：终态时间后端拆成三个字段，取实际有值的那个
 * @param rec 历史记录
 */
function historyTime(rec: MHistoryRecord): string | null {
  return rec.cleared_at || rec.dissolved_at || rec.started_at || rec.join_time || null;
}

/**
 * 根据变量完成度获取进度条色阶（tone 契约见 ui/StatBar.vue）
 * <30 血光 / 30-70 鎏金 / >70 灵木
 * @param val 归一化到 0-100 的完成度
 */
function getVariableTone(val: number): 'blood' | 'gold' | 'jade' {
  if (val < 30) return 'blood';
  if (val <= 70) return 'gold';
  return 'jade';
}

/**
 * 根据变量完成度获取数值文字颜色类
 * @param val 归一化到 0-100 的完成度
 */
function getVariableValueClass(val: number): string {
  if (val < 30) return 'text-rose-400';
  if (val <= 70) return 'text-gold-300';
  return 'text-emerald-300';
}

/**
 * 计算变量百分比（用于进度条宽度与色阶）
 * @param val 当前值
 * @param key 变量 key（收获倍率按 200 上限 / 塔心魔影HP 按 1000000 上限 / 虚天主魂HP 按 1500000 上限 / 其他按 100 上限）
 */
function getVariablePercent(val: number, key: string): number {
  // 收获倍率通常为 1.0-2.0，按 200% 上限显示
  if (key === 'harvest_multiplier') {
    return Math.min(100, Math.max(0, (val / 2) * 100));
  }
  // 塔心魔影HP 初始1000000，按此上限显示百分比
  if (key === 'tower_shadow_hp') {
    return Math.min(100, Math.max(0, (val / 1000000) * 100));
  }
  // 虚天主魂HP 初始1500000，按此上限显示百分比
  if (key === 'void_soul_hp') {
    return Math.min(100, Math.max(0, (val / 1500000) * 100));
  }
  // 其他变量按 0-100 显示
  return Math.min(100, Math.max(0, val));
}

/**
 * 获取可踢出的成员列表（排除队长本人；后端只允许踢 role=member）
 * @param list 成员列表
 */
function kickableMembers(list: MMember[]): MMember[] {
  return list.filter(m => m.role !== 'leader');
}

/**
 * 格式化秒数为可读时长
 * @param seconds 秒数
 */
function formatTime(seconds: number): string {
  if (seconds <= 0) return '0 秒';
  if (seconds < 60) return `${seconds} 秒`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours} 小时 ${remainMins} 分钟`;
}

/**
 * 格式化时间显示（M/D HH:MM）
 * @param time ISO 时间字符串
 */
function formatTimeString(time: string | null): string {
  if (!time) return '-';
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>
