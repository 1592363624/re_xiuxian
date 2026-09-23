/**
 * 太一门引道综合面板组件
 *
 * 玩法文档第25节"太一门引道"——五行道途+神识联动+多人共鸣
 *
 * Tab 划分：
 *   1. 道途面板：未选择道途时展示5种道途卡片可选；已选择时展示道途/等级/经验/神识/技能/修炼/切换
 *   2. 修炼任务：展示今日3个任务（名称/描述/进度/奖励），支持领取已完成任务奖励
 *   3. 排行榜：3个子分类（道途等级/技能使用次数/共鸣加成），分页展示
 *   4. 共鸣：展示同道途玩家数/高等级玩家数/共鸣加成/相克道途列表
 *
 * 设计原则：
 *   - 所有状态从后端拉取，禁止硬编码业务数据
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色统一取设计令牌（surface-* / line-* / fg-* / gold-*，见 styles/tokens.css）
 *   - 五行配色：金=yellow / 木=emerald / 水=sky / 火=rose / 土=amber-stone
 *   - 使用 Tailwind CSS 工具类，外壳与标签页走 ui/PanelShell.vue + ui/Tabs.vue，无自定义 CSS
 */
<template>
  <PanelShell
    title="太一门 · 引道五行"
    hint="五行道途 · 修炼任务 · 排行 · 共鸣"
    size="xl"
    @close="$emit('close')"
  >
    <!-- Tab 切换栏（切换时按需懒加载，见 switchTab） -->
    <Tabs :model-value="activeTab" :items="tabItems" class="mb-3" @update:model-value="switchTab" />

    <!-- ============ Tab 1: 道途面板 ============ -->
    <div v-show="activeTab === 'profile'" class="space-y-3">
      <LoadingBlock v-if="loading.profile" text="加载道途面板中…" />
      <template v-else-if="profileData">
        <!-- 未选择道途：5种道途卡片 -->
        <template v-if="!profileData.gate.dao_path">
          <PanelCard>
            <div class="text-sm font-bold text-gold-300 mb-2">引道入门</div>
            <div class="text-[11px] text-fg-muted">
              · 需达到<span class="text-gold-300">元婴期</span>且神识≥<span class="text-gold-300">200</span>方可引道<br/>
              · 五行道途各有专长：金主杀伐、木主生机、水主防御、火主洞察、土主稳固<br/>
              · 首次选择免费，后续切换需消耗法则碎片（每月1次免费）
            </div>
          </PanelCard>

          <section class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div v-for="path in allDaoPaths" :key="path"
              class="bg-surface-raised border rounded-panel p-4 flex flex-col transition-all hover:shadow-lg"
              :class="getPathTheme(path).border">
              <!-- 卡片头 -->
              <div class="flex items-center justify-between mb-2">
                <div class="text-sm font-bold" :class="getPathTheme(path).text">
                  {{ getPathName(path) }}
                </div>
                <div class="text-[10px] px-2 py-0.5 rounded border" :class="getPathTheme(path).badge">
                  {{ getRestraintLabel(path) }}
                </div>
              </div>
              <!-- 道途描述 -->
              <div class="text-[11px] text-fg-muted mb-3 flex-1">{{ getPathDescription(path) }}</div>
              <!-- 被动加成 -->
              <div class="text-[10px] text-fg-faint mb-3">
                · 被动：{{ getPathPassive(path) }}
              </div>
              <!-- 选择按钮 -->
              <button @click="handleChoosePath(path)"
                :disabled="loading.action"
                class="w-full py-2 rounded-control text-xs font-bold disabled:opacity-50"
                :class="getPathTheme(path).button">
                选择此道途
              </button>
            </div>
          </section>
        </template>

        <!-- 已选择道途：展示道途详情 + 操作 -->
        <template v-else>
          <!-- 道途核心信息卡 -->
          <section class="bg-surface-raised border rounded-panel p-4"
            :class="getPathTheme(profileData.gate.dao_path).border">
            <div class="flex items-center justify-between mb-3">
              <div>
                <div class="text-sm font-bold" :class="getPathTheme(profileData.gate.dao_path).text">
                  {{ profileData.gate.dao_path_name }}
                </div>
                <div class="text-[10px] text-fg-faint">{{ profileData.gate.dao_level_title }}</div>
              </div>
              <div class="text-right">
                <div class="text-[10px] text-fg-faint">道途等级</div>
                <div class="text-lg font-bold text-gold-300 num">
                  {{ profileData.gate.dao_level }}
                  <span class="text-[10px] text-fg-faint">/ 10</span>
                </div>
              </div>
            </div>

            <!-- 道途描述 -->
            <div class="text-[11px] text-fg-muted mb-3">{{ profileData.gate.dao_path_description }}</div>

            <!-- 被动加成 -->
            <div v-if="profileData.gate.passive_bonus" class="text-[11px] mb-3 p-2 bg-surface-sunken/60 border border-line-subtle rounded-control">
              <span class="text-fg-faint">被动加成：</span>
              <span class="text-emerald-300">{{ profileData.gate.passive_bonus.description }}</span>
              <span class="text-fg-muted">（当前 +{{ Math.round(profileData.gate.passive_bonus.value * 100) }}%）</span>
            </div>

            <!-- 经验进度条 -->
            <div class="text-xs mb-3">
              <div class="flex items-center justify-between mb-1">
                <span class="text-fg-faint">道途经验</span>
                <span class="text-fg-secondary num" :title="String(profileData.gate.dao_exp)">
                  {{ formatCompact(profileData.gate.dao_exp) }}
                  <span v-if="profileData.gate.dao_level < 10" class="text-fg-faint">/ {{ formatCompact(profileData.gate.next_level_exp) }}</span>
                  <span v-else class="text-gold-300">（已满级）</span>
                </span>
              </div>
              <div class="h-2 bg-surface-sunken rounded-full overflow-hidden border border-line-subtle">
                <div class="h-full transition-all"
                  :class="getPathTheme(profileData.gate.dao_path).bar"
                  :style="{ width: `${getExpPercent(profileData.gate.dao_exp, profileData.gate.next_level_exp, profileData.gate.dao_level)}%` }"></div>
              </div>
            </div>

            <!-- 神识值 -->
            <div class="text-xs">
              <div class="flex items-center justify-between mb-1">
                <span class="text-fg-faint">神识</span>
                <span class="text-sky-300 num" :title="profileData.divine_sense.current + ' / ' + profileData.divine_sense.max">
                  {{ formatCompact(profileData.divine_sense.current) }} / {{ formatCompact(profileData.divine_sense.max) }}
                </span>
              </div>
              <div class="h-2 bg-surface-sunken rounded-full overflow-hidden border border-line-subtle">
                <div class="h-full bg-gradient-to-r from-sky-700 to-sky-400 transition-all"
                  :style="{ width: `${getDivineSensePercent()}%` }"></div>
              </div>
            </div>
          </section>

          <!-- 引道修炼 + 切换道途 操作区 -->
          <section class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <!-- 引道修炼 -->
            <div class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-gold-300 mb-2">引道修炼</div>
              <div class="text-[11px] text-fg-muted mb-3">
                · 消耗 <span class="text-sky-300 num">50 神识</span> 获得道途经验<br/>
                · 每日上限 <span class="text-gold-300">{{ cultivateLimit }}</span> 次（今日已修 <span class="text-gold-300">{{ cultivateCountToday }}</span> 次）
              </div>
              <AppButton variant="primary" size="sm" block :disabled="loading.action || !canCultivate" :title="cultivateBlockReason || '消耗 50 神识获得道途经验'" @click="handleCultivate">
                {{ canCultivate ? '引道修炼' : (cultivateBlockReason || '不可修炼') }}
              </AppButton>
            </div>

            <!-- 切换道途 -->
            <div class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-purple-300 mb-2">切换道途</div>
              <div class="text-[11px] text-fg-muted mb-3">
                · 每月 <span class="text-gold-300">1 次</span>免费，之后消耗 <span class="text-rose-300">100 五行法则碎片</span><br/>
                · 切换冷却 <span class="text-gold-300">7 天</span>，等级重置为1，保留 50% 经验
              </div>
              <!-- 选择目标道途 -->
              <select v-model="switchTargetPath"
                class="w-full bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus-ring mb-2">
                <option value="">选择目标道途</option>
                <option v-for="path in allDaoPaths.filter(p => p !== profileData.gate.dao_path)" :key="path" :value="path">
                  {{ getPathName(path) }} - {{ getPathDescription(path).slice(0, 12) }}...
                </option>
              </select>
              <button @click="handleSwitchPath"
                :disabled="loading.action || !switchTargetPath"
                class="w-full py-2 rounded-control text-xs font-bold bg-purple-700 text-purple-100 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed">
                确认切换
              </button>
            </div>
          </section>

          <!-- 道途技能列表 -->
          <PanelCard>
            <div class="text-sm font-bold text-gold-300 mb-3">道途技能</div>
            <div v-if="profileData.skills.length === 0" class="text-[11px] text-fg-faint text-center py-2">暂无技能</div>
            <div v-else class="space-y-2">
              <div v-for="skill in profileData.skills" :key="skill.skill_id"
                class="bg-surface-sunken/60 border border-line-subtle rounded-control p-3">
                <!-- 技能头 -->
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-bold text-gold-300">{{ skill.skill_name }}</span>
                    <!-- 锁定/可用 徽章 -->
                    <Badge v-if="skill.is_locked" tone="muted">锁定（需 {{ skill.skill_min_level }} 级）</Badge>
                    <Badge v-else-if="skill.cooldown_end && isCoolingDown(skill.cooldown_end)" tone="danger">冷却中</Badge>
                    <Badge v-else-if="skill.can_use" tone="success">可用</Badge>
                    <Badge v-else tone="neutral">神识不足</Badge>
                  </div>
                  <div class="text-[10px] text-fg-faint num">
                    消耗 {{ formatCompact(skill.skill_divine_sense_cost) }} 神识 · 冷却 {{ skill.skill_cooldown_hours }} 小时
                  </div>
                </div>
                <!-- 技能描述 -->
                <div class="text-[11px] text-fg-muted mb-2">{{ skill.skill_description }}</div>
                <!-- 冷却倒计时 -->
                <div v-if="skill.cooldown_end && isCoolingDown(skill.cooldown_end)" class="text-[10px] text-rose-400 mb-2">
                  · 冷却结束于：{{ formatTimeString(skill.cooldown_end) }}
                </div>

                <!-- 使用技能：目标输入区（仅对需要目标的技能显示） -->
                <div v-if="!skill.is_locked && needsTarget(skill.skill_id)" class="grid grid-cols-2 gap-2 mb-2">
                  <input v-model.number="skillTargetPlayerId" type="number" min="1" placeholder="目标玩家 ID"
                    class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-[11px] text-fg-primary focus-ring" />
                  <input v-if="needsBeastId(skill.skill_id)" v-model.number="skillTargetBeastId" type="number" min="1" placeholder="目标灵兽 ID"
                    class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-[11px] text-fg-primary focus-ring" />
                </div>

                <!-- 使用技能按钮 -->
                <AppButton variant="danger" size="xs" block :disabled="loading.action || !canUseSkill(skill)" @click="handleUseSkill(skill)">
                  {{ skill.is_locked ? '技能未解锁' : (isCoolingDown(skill.cooldown_end || '') ? '冷却中' : '施展技能') }}
                </AppButton>
              </div>
            </div>
          </PanelCard>

          <!-- 累计统计 -->
          <PanelCard>
            <div class="text-sm font-bold text-fg-secondary mb-3">道途累计</div>
            <div class="grid grid-cols-3 gap-3 text-center">
              <div>
                <div class="text-[10px] text-fg-faint">总修炼次数</div>
                <div class="text-lg font-bold text-gold-300 num" :title="String(profileData.stats.total_cultivate_count)">{{ formatCompact(profileData.stats.total_cultivate_count) }}</div>
              </div>
              <div>
                <div class="text-[10px] text-fg-faint">总技能次数</div>
                <div class="text-lg font-bold text-rose-300 num" :title="String(profileData.stats.total_skill_use_count)">{{ formatCompact(profileData.stats.total_skill_use_count) }}</div>
              </div>
              <div>
                <div class="text-[10px] text-fg-faint">总共鸣次数</div>
                <div class="text-lg font-bold text-sky-300 num" :title="String(profileData.stats.total_resonance_count)">{{ formatCompact(profileData.stats.total_resonance_count) }}</div>
              </div>
            </div>
          </PanelCard>
        </template>
      </template>
      <EmptyState v-else text="暂无道途数据" />
    </div>

    <!-- ============ Tab 2: 修炼任务 ============ -->
    <div v-show="activeTab === 'tasks'" class="space-y-3">
      <LoadingBlock v-if="loading.tasks" text="加载任务中…" />
      <template v-else-if="tasksData">
        <!-- 任务重置时间 -->
        <PanelCard v-if="tasksData.reset_time" class="flex items-center justify-between">
          <div class="text-xs text-fg-muted num">
            · 任务将于 <span class="text-gold-300">{{ formatTimeString(tasksData.reset_time) }}</span> 重置
          </div>
          <AppButton variant="default" size="xs" :disabled="loading.tasks" @click="loadTasks">刷新任务</AppButton>
        </PanelCard>

        <!-- 任务列表 -->
        <EmptyState
          v-if="tasksData.tasks.length === 0"
          :text="tasksData.message || '今日暂无任务'"
          hint="需先选择道途方可领取日常任务"
        />

        <section v-else class="space-y-2">
          <div v-for="(task, idx) in tasksData.tasks" :key="idx"
            class="bg-surface-raised border rounded-panel p-3"
            :class="task.completed && !task.rewards_claimed ? 'border-emerald-700 shadow-lg shadow-emerald-900/20' : 'border-line'">
            <!-- 任务头 -->
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-xs font-bold text-gold-300">{{ task.task_name }}</span>
                <!-- 状态徽章 -->
                <Badge v-if="task.rewards_claimed" tone="muted">已领取</Badge>
                <Badge v-else-if="task.completed" tone="success" class="animate-pulse">可领取</Badge>
                <Badge v-else tone="gold">进行中</Badge>
              </div>
              <div class="text-[10px] text-fg-faint">
                进度：{{ task.current_count }} / {{ task.target_count }}
              </div>
            </div>
            <!-- 任务描述 -->
            <div class="text-[11px] text-fg-muted mb-2">{{ task.task_description }}</div>
            <!-- 进度条 -->
            <div class="h-1.5 bg-surface-hover rounded-full overflow-hidden mb-2">
              <div class="h-full transition-all"
                :class="task.completed ? 'bg-gradient-to-r from-emerald-700 to-emerald-400' : 'bg-gradient-to-r from-gold-700 to-gold-400'"
                :style="{ width: `${Math.min(100, (task.current_count / task.target_count) * 100)}%` }"></div>
            </div>
            <!-- 奖励 + 领取按钮 -->
            <div class="flex items-center justify-between">
              <div class="text-[10px] text-fg-muted">
                奖励：
                <span v-if="task.rewards.dao_exp" class="text-gold-300">道途经验 +{{ task.rewards.dao_exp }}</span>
                <span v-if="task.rewards.divine_sense" class="text-sky-300"> 神识 +{{ task.rewards.divine_sense }}</span>
                <span v-if="task.rewards.law_fragment_five_elements" class="text-purple-300"> 五行碎片 +{{ task.rewards.law_fragment_five_elements }}</span>
              </div>
              <button v-if="task.completed && !task.rewards_claimed"
                @click="handleClaimTask(idx)"
                :disabled="loading.action"
                class="px-3 py-1 text-[11px] font-bold bg-emerald-700 text-emerald-100 rounded-control hover:bg-emerald-600 disabled:opacity-50">
                领取奖励
              </button>
            </div>
          </div>
        </section>
      </template>
      <EmptyState v-else text="暂无任务数据" />
    </div>

    <!-- ============ Tab 3: 排行榜 ============ -->
    <div v-show="activeTab === 'ranking'" class="space-y-3">
      <!-- 子分类切换 -->
      <Tabs :model-value="rankingCategory" :items="rankingCategories" class="mb-2" @update:model-value="switchRankingCategory" />

      <LoadingBlock v-if="loading.ranking" text="加载排行中…" />
      <template v-else-if="rankingData">
        <!-- 排行列表 -->
        <PanelCard>
          <div class="flex items-center justify-between mb-3">
            <div class="text-xs text-fg-muted num">
              · 共 <span class="text-gold-300">{{ rankingData.total }}</span> 名修士上榜
            </div>
            <div class="flex items-center gap-2 text-xs">
              <AppButton variant="default" size="xs" :disabled="loading.ranking || rankingData.current_page <= 1" @click="changeRankingPage(rankingData.current_page - 1)">上一页</AppButton>
              <span class="text-fg-muted">{{ rankingData.current_page }} / {{ rankingData.total_pages || 1 }}</span>
              <AppButton variant="default" size="xs" :disabled="loading.ranking || rankingData.current_page >= rankingData.total_pages" @click="changeRankingPage(rankingData.current_page + 1)">下一页</AppButton>
            </div>
          </div>

          <EmptyState v-if="rankingData.rankings.length === 0" text="暂无上榜修士" />
          <div v-else class="space-y-1 max-h-[60vh] overflow-y-auto scroll-thin">
            <div v-for="entry in rankingData.rankings" :key="entry.rank"
              class="bg-surface-sunken/60 border border-line-subtle rounded-control p-2 flex items-center gap-3">
              <!-- 排名 -->
              <div class="w-8 text-center shrink-0">
                <div v-if="entry.rank === 1" class="text-gold-400 font-bold text-lg">①</div>
                <div v-else-if="entry.rank === 2" class="text-fg-secondary font-bold text-lg">②</div>
                <div v-else-if="entry.rank === 3" class="text-gold-700 font-bold text-lg">③</div>
                <div v-else class="text-fg-faint text-xs">{{ entry.rank }}</div>
              </div>
              <!-- 玩家信息 -->
              <div class="flex-1 min-w-0">
                <div class="text-xs text-fg-secondary truncate">{{ entry.player_nickname }}</div>
                <div class="text-[10px]" :class="getPathTheme(entry.dao_path).text">
                  {{ entry.dao_path_name }} · {{ entry.dao_level }} 级
                </div>
              </div>
              <!-- 数值 -->
              <div class="text-right shrink-0">
                <div class="text-[10px] text-fg-faint">{{ getRankingValueLabel(rankingCategory) }}</div>
                <div class="text-sm font-bold text-gold-300 num" :title="String(entry.value)">{{ formatCompact(entry.value) }}</div>
              </div>
            </div>
          </div>
        </PanelCard>
      </template>
      <EmptyState v-else text="暂无排行数据" />
    </div>

    <!-- ============ Tab 4: 共鸣 ============ -->
    <div v-show="activeTab === 'resonance'" class="space-y-3">
      <LoadingBlock v-if="loading.resonance" text="加载共鸣状态中…" />
      <template v-else-if="resonanceData">
        <EmptyState v-if="!resonanceData.dao_path" :text="resonanceData.message || '尚未选择道途，无共鸣'" />
        <template v-else>
          <!-- 当前道途 -->
          <section class="bg-surface-raised border rounded-panel p-4"
            :class="getPathTheme(resonanceData.dao_path as DaoPath).border">
            <div class="flex items-center justify-between mb-3">
              <div>
                <div class="text-sm font-bold" :class="getPathTheme(resonanceData.dao_path as DaoPath).text">
                  {{ resonanceData.dao_path_name }}
                </div>
                <div class="text-[10px] text-fg-faint">当前道途</div>
              </div>
              <div class="text-right">
                <div class="text-[10px] text-fg-faint">共鸣加成</div>
                <div class="text-xl font-bold text-gold-300">
                  +{{ Math.round(resonanceData.resonance_bonus * 100) }}%
                </div>
              </div>
            </div>
            <div class="text-[11px] text-fg-secondary">{{ resonanceData.resonance_description }}</div>
          </section>

          <!-- 同道途玩家统计 -->
          <section class="grid grid-cols-2 gap-3">
            <div class="bg-surface-hover border border-line rounded-panel p-4 text-center">
              <div class="text-[10px] text-fg-faint mb-1">同道途修士</div>
              <div class="text-2xl font-bold text-gold-300 num">{{ resonanceData.same_path_total }}</div>
              <div class="text-[10px] text-fg-faint mt-1">人</div>
            </div>
            <div class="bg-surface-hover border border-line rounded-panel p-4 text-center">
              <div class="text-[10px] text-fg-faint mb-1">高等级修士</div>
              <div class="text-2xl font-bold text-emerald-300 num">{{ resonanceData.same_path_advanced }}</div>
              <div class="text-[10px] text-fg-faint mt-1">人（5级以上）</div>
            </div>
          </section>

          <!-- 共鸣加成说明 -->
          <PanelCard>
            <div class="text-sm font-bold text-gold-300 mb-2">共鸣机制</div>
            <div class="text-[11px] text-fg-muted space-y-1">
              · 同道途玩家组队时获得被动加成叠加<br/>
              · 2人 +10% / 3人 +20% / 4人 +30% / 5人 +50%（封顶）<br/>
              · 加成作用于道途经验获取与技能效果
            </div>
          </PanelCard>

          <!-- 相克道途列表 -->
          <PanelCard v-if="resonanceData.restraint_targets.length > 0">
            <div class="text-sm font-bold text-rose-300 mb-3">相克道途</div>
            <div class="text-[11px] text-fg-muted mb-3">
              · 你的道途克制以下道途，对它们施展技能时效果 +20%
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div v-for="targetPath in resonanceData.restraint_targets" :key="targetPath"
                class="bg-surface-raised/40 border rounded p-2 flex items-center gap-2"
                :class="getPathTheme(targetPath as DaoPath).border">
                <span class="text-xs font-bold" :class="getPathTheme(targetPath as DaoPath).text">
                  {{ getPathName(targetPath as DaoPath) }}
                </span>
                <span class="text-[10px] text-fg-faint">· 受你克制</span>
              </div>
            </div>
          </PanelCard>
        </template>
      </template>
      <EmptyState v-else text="暂无共鸣数据" />
    </div>

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
 * 太一门引道综合面板脚本
 * 4 Tab 共享一个面板，按需懒加载对应子模块数据
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
import { formatCompact } from '../../utils/format';
import { useUIStore } from '../../stores/ui';
import {
  taoismGateGetProfile,
  taoismGateChoose,
  taoismGateSwitch,
  taoismGateCultivate,
  taoismGateUseSkill,
  taoismGateGetTasks,
  taoismGateClaimTask,
  taoismGateGetRanking,
  taoismGateGetResonance,
  DAO_PATH_THEME_MAP,
  type DaoPath,
  type TaoismDaoPathOption,
  type RankingCategory,
  type TaoismProfileData,
  type TaoismTasksData,
  type TaoismRankingData,
  type TaoismResonanceData,
  type TaoismSkillInfo
} from '../../api/taoismGate';

const uiStore = useUIStore();

/** Tab 配置 */
const tabItems = [
  { key: 'profile', label: '道途面板' },
  { key: 'tasks', label: '修炼任务' },
  { key: 'ranking', label: '排行榜' },
  { key: 'resonance', label: '共鸣' }
];
/** 当前激活 Tab */
const activeTab = ref('profile');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/** 排行榜子分类配置 */
const rankingCategories = [
  { key: 'dao_level' as RankingCategory, label: '道途等级' },
  { key: 'total_skill_use' as RankingCategory, label: '技能使用次数' },
  { key: 'total_resonance' as RankingCategory, label: '共鸣加成' }
];
/** 当前排行榜子分类 */
const rankingCategory = ref<RankingCategory>('dao_level');

/**
 * 道途全集：取自 `/taoism-gate/profile` 的 `dao_path_options`（内容 taoism_gate_data.dao_paths 导出）。
 * 以前这里是写死的 `['metal','wood','water','fire','earth']` + 一份中文名表 + 一份五段描述文案，
 * 三处都是内容的副本：资料片加一档道途就少一张卡，改文案界面也不跟着变
 * （抄的那份中文名还比内容短一截："金道" vs 内容里的"金道·锐金"）。
 */
const daoPathOptions = computed<TaoismDaoPathOption[]>(() => profileData.value?.dao_path_options || []);
const allDaoPaths = computed<DaoPath[]>(() => daoPathOptions.value.map(o => o.key));
const daoPathOption = (path: DaoPath) => daoPathOptions.value.find(o => o.key === path) || null;

/** 各模块加载状态 */
const loading = reactive({
  profile: false,
  tasks: false,
  ranking: false,
  resonance: false,
  action: false
});

/** 各模块数据 */
const profileData = ref<TaoismProfileData | null>(null);
const tasksData = ref<TaoismTasksData | null>(null);
const rankingData = ref<TaoismRankingData | null>(null);
const resonanceData = ref<TaoismResonanceData | null>(null);

/** 输入框绑定值 */
const switchTargetPath = ref<DaoPath | ''>('');        // 切换道途目标
const skillTargetPlayerId = ref<number | null>(null);  // 技能目标玩家
const skillTargetBeastId = ref<number | null>(null);   // 技能目标灵兽

/**
 * 今日已修炼次数 / 上限：权威值来自 profile 的 stats.daily_cultivate_*。
 * 旧实现用浏览器会话本地计数（sessionCultivateCount），刷新就归零，
 * 于是「今日已修 0 次」和数据库里的 5 次对不上。会话计数仅作回包前的乐观占位。
 */
const sessionCultivateCount = ref(0);
const dailyCultivateCount = computed(() =>
  profileData.value?.stats?.daily_cultivate_count ?? sessionCultivateCount.value
);
const cultivateLimit = computed(() =>
  profileData.value?.stats?.daily_cultivate_limit ?? 5
);

/** 通用二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '操作确认',
  message: '',
  onConfirm: () => {}
});

/**
 * 计算属性：今日是否还可修炼
 * 综合：未满级 + 神识足够 + 当日未达上限（读后端权威值）
 */
const canCultivate = computed(() => !cultivateBlockReason.value);

/** 不可修炼的原因（null = 可以修炼）。灰按钮必须能自解释。 */
const cultivateBlockReason = computed(() => {
  if (!profileData.value) return '加载中…';
  const gate = profileData.value.gate;
  const divine = profileData.value.divine_sense;
  if (gate.dao_level >= 10) return '道途已满级，无需继续修炼';
  if (divine.current < 50) return `神识不足（需 50，当前 ${divine.current}）`;
  if (dailyCultivateCount.value >= cultivateLimit.value) {
    return `今日修炼次数已用完（${dailyCultivateCount.value}/${cultivateLimit.value}），明日重置`;
  }
  return null;
});

/**
 * 计算属性：今日已修炼次数（用于展示，读后端权威值）
 */
const cultivateCountToday = computed(() => dailyCultivateCount.value);

/**
 * 组件挂载时加载首个 Tab 数据
 */
onMounted(async () => {
  await loadProfile();
  loadedTabs.add('profile');
});

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (loadedTabs.has(tabId)) return;
  if (tabId === 'profile') await loadProfile();
  else if (tabId === 'tasks') await loadTasks();
  else if (tabId === 'ranking') await loadRanking(rankingCategory.value);
  else if (tabId === 'resonance') await loadResonance();
  loadedTabs.add(tabId);
}

/**
 * 排行榜子分类切换
 * @param category 排行类别
 */
async function switchRankingCategory(category: RankingCategory) {
  rankingCategory.value = category;
  await loadRanking(category);
}

// ============ 数据加载函数 ============

/** 加载道途面板数据 */
async function loadProfile() {
  loading.profile = true;
  try {
    const resp = await taoismGateGetProfile();
    if (resp.data?.code === 200 && resp.data.data) {
      profileData.value = resp.data.data;
      // 重置本会话修炼计数（每次刷新 profile 时归零，由后端最终校验）
      sessionCultivateCount.value = 0;
    } else {
      uiStore.showToast(resp.data?.message || '获取道途面板失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.profile = false;
  }
}

/** 加载今日任务 */
async function loadTasks() {
  loading.tasks = true;
  try {
    const resp = await taoismGateGetTasks();
    if (resp.data?.code === 200 && resp.data.data) {
      tasksData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取任务失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.tasks = false;
  }
}

/**
 * 加载排行榜
 * @param category 排行类别
 */
async function loadRanking(category: RankingCategory) {
  loading.ranking = true;
  try {
    const resp = await taoismGateGetRanking(category);
    if (resp.data?.code === 200 && resp.data.data) {
      rankingData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取排行榜失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.ranking = false;
  }
}

/**
 * 排行榜翻页
 * @param page 目标页码
 */
async function changeRankingPage(page: number) {
  if (!rankingData.value) return;
  if (page < 1 || page > rankingData.value.total_pages) return;
  loading.ranking = true;
  try {
    const resp = await taoismGateGetRanking(rankingCategory.value, page);
    if (resp.data?.code === 200 && resp.data.data) {
      rankingData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '翻页失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.ranking = false;
  }
}

/** 加载道途共鸣状态 */
async function loadResonance() {
  loading.resonance = true;
  try {
    const resp = await taoismGateGetResonance();
    if (resp.data?.code === 200 && resp.data.data) {
      resonanceData.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取共鸣状态失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.resonance = false;
  }
}

// ============ 操作处理函数 ============

/**
 * 选择道途（首次，免费）
 * @param path 道途 key
 */
function handleChoosePath(path: DaoPath) {
  showConfirm(
    '选择道途',
    `确认选择「${getPathName(path)}」作为你的道途？\n· 首次选择免费\n· 选择后将解锁该道途专属技能与日常任务\n· 后续切换需消耗法则碎片（每月1次免费）`,
    async () => {
      loading.action = true;
      try {
        const resp = await taoismGateChoose(path);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || `已选择 ${getPathName(path)}`, 'success');
          await loadProfile();
        } else {
          uiStore.showToast(resp.data?.message || '选择失败', 'error');
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
 * 切换道途（每月1次免费，否则消耗法则碎片，7天冷却）
 */
function handleSwitchPath() {
  if (!switchTargetPath.value) {
    uiStore.showToast('请选择目标道途', 'warning');
    return;
  }
  const targetPath = switchTargetPath.value as DaoPath;
  showConfirm(
    '切换道途',
    `确认切换至「${getPathName(targetPath)}」？\n· 等级将重置为 1，保留 50% 经验\n· 每月1次免费，之后消耗 100 五行法则碎片\n· 切换冷却 7 天\n· 操作不可撤销`,
    async () => {
      loading.action = true;
      try {
        const resp = await taoismGateSwitch(targetPath);
        if (resp.data?.code === 200 && resp.data.data) {
          const result = resp.data.data;
          const costMsg = result.fragment_consumed > 0
            ? `\n消耗法则碎片：${result.fragment_consumed}`
            : '\n本次为本月免费切换';
          uiStore.showToast((resp.data.message || '切换成功') + costMsg, 'success');
          switchTargetPath.value = '';
          sessionCultivateCount.value = 0;
          await loadProfile();
        } else {
          uiStore.showToast(resp.data?.message || '切换失败', 'error');
        }
      } catch (e: any) {
        uiStore.showToast(e.message || '网络错误', 'error');
      } finally {
        loading.action = false;
      }
    }
  );
}

/** 引道修炼（消耗50神识获得道途经验） */
async function handleCultivate() {
  loading.action = true;
  try {
    const resp = await taoismGateCultivate();
    if (resp.data?.code === 200 && resp.data.data) {
      const result = resp.data.data;
      // 乐观占位；真正权威值由下面 loadProfile() 从 stats.daily_cultivate_count 刷回
      sessionCultivateCount.value = result.daily_cultivate_count ?? (sessionCultivateCount.value + 1);
      const levelMsg = result.leveled_up ? `\n道途升级至 ${result.new_level} 级！` : '';
      uiStore.showToast(
        `${resp.data.message || '修炼成功'}\n获得经验：${result.exp_gained}${levelMsg}`,
        result.leveled_up ? 'success' : 'info'
      );
      await loadProfile();
    } else {
      uiStore.showToast(resp.data?.message || '修炼失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 使用道途技能
 * @param skill 技能信息
 */
function handleUseSkill(skill: TaoismSkillInfo) {
  // 校验目标参数（针对需要目标的技能）
  if (needsTarget(skill.skill_id)) {
    if (!skillTargetPlayerId.value) {
      uiStore.showToast('请输入目标玩家 ID', 'warning');
      return;
    }
    if (needsBeastId(skill.skill_id) && !skillTargetBeastId.value) {
      uiStore.showToast('请输入目标灵兽 ID', 'warning');
      return;
    }
  }

  const targetDesc = needsTarget(skill.skill_id)
    ? `\n· 目标玩家：${skillTargetPlayerId.value}${needsBeastId(skill.skill_id) ? ` / 目标灵兽：${skillTargetBeastId.value}` : ''}`
    : '';
  showConfirm(
    '施展技能',
    `确认施展「${skill.skill_name}」？\n· 消耗 ${skill.skill_divine_sense_cost} 神识\n· 冷却 ${skill.skill_cooldown_hours} 小时${targetDesc}`,
    async () => {
      loading.action = true;
      try {
        const resp = await taoismGateUseSkill(
          skillTargetPlayerId.value || undefined,
          skillTargetBeastId.value || undefined
        );
        if (resp.data?.code === 200 && resp.data.data) {
          const result = resp.data.data;
          // 格式化技能效果描述
          const effectDesc = formatSkillResult(result.skill_result);
          uiStore.showToast(
            `${resp.data.message || '技能施展成功'}\n${effectDesc}\n获得经验：${result.exp_gained}`,
            'success'
          );
          // 清空目标输入
          skillTargetPlayerId.value = null;
          skillTargetBeastId.value = null;
          await loadProfile();
        } else {
          uiStore.showToast(resp.data?.message || '技能施展失败', 'error');
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
 * 领取任务奖励
 * @param taskIndex 任务索引（0-based）
 */
async function handleClaimTask(taskIndex: number) {
  loading.action = true;
  try {
    const resp = await taoismGateClaimTask(taskIndex);
    if (resp.data?.code === 200 && resp.data.data) {
      const result = resp.data.data;
      const rw = result.rewards || {};
      const rwDesc = [
        rw.dao_exp ? `道途经验+${rw.dao_exp}` : '',
        rw.divine_sense ? `神识+${rw.divine_sense}` : '',
        rw.law_fragment_five_elements ? `五行碎片+${rw.law_fragment_five_elements}` : ''
      ].filter(Boolean).join(' / ');
      uiStore.showToast(`${resp.data.message || '领取成功'}：${rwDesc}`, 'success');
      // 刷新任务列表 + 道途面板（经验/碎片可能变化）
      await Promise.all([loadTasks(), loadProfile()]);
    } else {
      uiStore.showToast(resp.data?.message || '领取失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
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
 * 获取道途中文名（内容里那份，含"·锐金"这类后缀；未加载 profile 时退回 key）
 * @param path 道途 key
 */
function getPathName(path: DaoPath): string {
  return daoPathOption(path)?.name || path;
}

/** 卡片角标：这一档克制谁（内容的 restraint_targets），没配就只标"道途" */
function getRestraintLabel(path: DaoPath): string {
  const targets = daoPathOption(path)?.restraint_targets || [];
  return targets.length ? `克${targets.map(t => getPathName(t)).join('、')}` : '道途';
}

/**
 * 获取道途主题配色
 * @param path 道途 key
 */
function getPathTheme(path: DaoPath | null | undefined) {
  if (!path) return DAO_PATH_THEME_MAP.earth; // 默认土道配色
  return DAO_PATH_THEME_MAP[path] || DAO_PATH_THEME_MAP.earth;
}

/**
 * 获取道途描述：一律读内容下发那份（以前未选择道途时这里抄了五段文案，
 * 里面连技能名都是手打的，内容改了技能或调整描述都不会跟着变）。
 * @param path 道途 key
 */
function getPathDescription(path: DaoPath): string {
  return daoPathOption(path)?.description
    || (profileData.value?.gate.dao_path === path ? profileData.value.gate.dao_path_description : '');
}

/**
 * 获取道途被动加成描述（简要）
 * @param path 道途 key
 */
function getPathPassive(path: DaoPath): string {
  const passiveMap: Record<DaoPath, string> = {
    metal: '每级+5%神识攻击力',
    wood: '每级+4%灵兽HP恢复速度',
    water: '每级+5%神识防御力',
    fire: '每级+3%炼化效率',
    earth: '每级+4%法则转换效率'
  };
  return passiveMap[path] || '';
}

/**
 * 计算道途经验百分比（用于进度条宽度）
 * @param currentExp 当前经验
 * @param nextLevelExp 下一级所需经验
 * @param level 当前等级
 */
function getExpPercent(currentExp: number, nextLevelExp: number, level: number): number {
  // 已满级时显示 100%
  if (level >= 10) return 100;
  if (!nextLevelExp || nextLevelExp <= 0) return 0;
  return Math.min(100, Math.max(0, (currentExp / nextLevelExp) * 100));
}

/**
 * 计算神识百分比（用于进度条宽度）
 */
function getDivineSensePercent(): number {
  if (!profileData.value) return 0;
  const { current, max } = profileData.value.divine_sense;
  if (!max || max <= 0) return 0;
  return Math.min(100, Math.max(0, (current / max) * 100));
}

/**
 * 判断技能是否处于冷却中
 * @param cooldownEnd 冷却结束时间（ISO 字符串或空字符串）
 */
function isCoolingDown(cooldownEnd: string): boolean {
  if (!cooldownEnd) return false;
  try {
    return new Date(cooldownEnd) > new Date();
  } catch {
    return false;
  }
}

/**
 * 判断技能是否需要目标玩家
 * - metal_blade（金锋裂魂）：需目标玩家 + 目标灵兽
 * - wood_heal（木灵回春）：仅需目标灵兽（自己灵兽）
 * - water_mirror（水镜映心）：无需目标
 * - fire_eye（火眼金睛）：需目标玩家
 * - earth_prison（土牢定身）：需目标玩家 + 目标灵兽
 * @param skillId 技能 ID
 */
function needsTarget(skillId: string): boolean {
  return ['metal_blade', 'wood_heal', 'fire_eye', 'earth_prison'].includes(skillId);
}

/**
 * 判断技能是否需要目标灵兽
 * @param skillId 技能 ID
 */
function needsBeastId(skillId: string): boolean {
  return ['metal_blade', 'wood_heal', 'earth_prison'].includes(skillId);
}

/**
 * 判断技能是否可使用
 * @param skill 技能信息
 */
function canUseSkill(skill: TaoismSkillInfo): boolean {
  if (skill.is_locked) return false;
  if (isCoolingDown(skill.cooldown_end || '')) return false;
  if (!skill.can_use) return false;
  return true;
}

/**
 * 格式化技能效果结果为可读字符串
 * @param result 后端返回的 skill_result 对象
 */
function formatSkillResult(result: Record<string, any>): string {
  if (!result || typeof result !== 'object') return '';
  const lines: string[] = [];
  // 常见字段友好化
  if (result.damage !== undefined) lines.push(`· 伤害：${result.damage}`);
  if (result.heal_amount !== undefined) lines.push(`· 恢复：${result.heal_amount}`);
  if (result.shield_active !== undefined) lines.push(`· 反弹盾已激活`);
  if (result.shield_description) lines.push(`· ${result.shield_description}`);
  if (result.success !== undefined) lines.push(`· 探查${result.success ? '成功' : '失败'}`);
  if (result.target_player_nickname) lines.push(`· 目标：${result.target_player_nickname}`);
  if (result.target_beast_name) lines.push(`· 灵兽：${result.target_beast_name}`);
  if (result.items_seen) lines.push(`· 探查到物品：${result.items_seen}`);
  if (result.prison_end_time) lines.push(`· 定身至：${formatTimeString(result.prison_end_time)}`);
  // 兜底：若以上字段均未命中，按 JSON 输出
  if (lines.length === 0) {
    try {
      lines.push(`· ${JSON.stringify(result)}`);
    } catch {
      lines.push('· 技能已生效');
    }
  }
  return lines.join('\n');
}

/**
 * 获取排行榜数值列名
 * @param category 排行类别
 */
function getRankingValueLabel(category: RankingCategory): string {
  const map: Record<RankingCategory, string> = {
    dao_level: '道途等级',
    total_skill_use: '技能次数',
    total_resonance: '共鸣次数'
  };
  return map[category] || '数值';
}

/**
 * 格式化时间显示（M/D HH:MM）
 * @param time ISO 时间字符串
 */
function formatTimeString(time: string | null | undefined): string {
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(time, { dateStyle: 'short', seconds: false, fallback: '-' });
}
</script>

