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
 *   - 颜色风格与 MultiDungeonPanel.vue 一致（修仙古风：#1c1917 / #292524 / amber-300）
 *   - 五行配色：金=yellow / 木=emerald / 水=sky / 火=rose / 土=amber-stone
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS（除淡入动画外）
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-amber-900/40 rounded-lg p-6 max-w-5xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-amber-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
            <path d="M2 12h20"/>
          </svg>
          太一门 · 引道五行
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- Tab 切换栏 -->
      <div class="flex border-b border-stone-700 mb-3 overflow-x-auto">
        <button v-for="tab in tabs" :key="tab.id"
          @click="switchTab(tab.id)"
          class="px-4 py-2 text-xs font-medium transition-colors whitespace-nowrap relative"
          :class="activeTab === tab.id ? 'text-amber-300' : 'text-stone-500 hover:text-stone-300'">
          {{ tab.name }}
          <div v-if="activeTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-400"></div>
        </button>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto pr-1">

        <!-- ============ Tab 1: 道途面板 ============ -->
        <div v-show="activeTab === 'profile'" class="space-y-3">
          <div v-if="loading.profile" class="text-center py-6 text-stone-500 text-sm">加载道途面板中...</div>
          <template v-else-if="profileData">
            <!-- 未选择道途：5种道途卡片 -->
            <template v-if="!profileData.gate.dao_path">
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-amber-300 mb-2">引道入门</div>
                <div class="text-[11px] text-stone-400">
                  · 需达到<span class="text-amber-300">元婴期</span>且神识≥<span class="text-amber-300">200</span>方可引道<br/>
                  · 五行道途各有专长：金主杀伐、木主生机、水主防御、火主洞察、土主稳固<br/>
                  · 首次选择免费，后续切换需消耗法则碎片（每月1次免费）
                </div>
              </section>

              <section class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <div v-for="path in allDaoPaths" :key="path"
                  class="bg-[#292524] border rounded-lg p-4 flex flex-col transition-all hover:shadow-lg"
                  :class="getPathTheme(path).border">
                  <!-- 卡片头 -->
                  <div class="flex items-center justify-between mb-2">
                    <div class="text-sm font-bold" :class="getPathTheme(path).text">
                      {{ getPathName(path) }}
                    </div>
                    <div class="text-[10px] px-2 py-0.5 rounded border" :class="getPathTheme(path).badge">
                      五行
                    </div>
                  </div>
                  <!-- 道途描述 -->
                  <div class="text-[11px] text-stone-400 mb-3 flex-1">{{ getPathDescription(path) }}</div>
                  <!-- 被动加成 -->
                  <div class="text-[10px] text-stone-500 mb-3">
                    · 被动：{{ getPathPassive(path) }}
                  </div>
                  <!-- 选择按钮 -->
                  <button @click="handleChoosePath(path)"
                    :disabled="loading.action"
                    class="w-full py-2 rounded text-xs font-bold disabled:opacity-50"
                    :class="getPathTheme(path).button">
                    选择此道途
                  </button>
                </div>
              </section>
            </template>

            <!-- 已选择道途：展示道途详情 + 操作 -->
            <template v-else>
              <!-- 道途核心信息卡 -->
              <section class="bg-[#292524] border rounded-lg p-4"
                :class="getPathTheme(profileData.gate.dao_path).border">
                <div class="flex items-center justify-between mb-3">
                  <div>
                    <div class="text-sm font-bold" :class="getPathTheme(profileData.gate.dao_path).text">
                      {{ profileData.gate.dao_path_name }}
                    </div>
                    <div class="text-[10px] text-stone-500">{{ profileData.gate.dao_level_title }}</div>
                  </div>
                  <div class="text-right">
                    <div class="text-[10px] text-stone-500">道途等级</div>
                    <div class="text-lg font-bold text-amber-300">
                      {{ profileData.gate.dao_level }}
                      <span class="text-[10px] text-stone-500">/ 10</span>
                    </div>
                  </div>
                </div>

                <!-- 道途描述 -->
                <div class="text-[11px] text-stone-400 mb-3">{{ profileData.gate.dao_path_description }}</div>

                <!-- 被动加成 -->
                <div v-if="profileData.gate.passive_bonus" class="text-[11px] mb-3 p-2 bg-stone-900/40 border border-stone-800 rounded">
                  <span class="text-stone-500">被动加成：</span>
                  <span class="text-emerald-300">{{ profileData.gate.passive_bonus.description }}</span>
                  <span class="text-stone-400">（当前 +{{ Math.round(profileData.gate.passive_bonus.value * 100) }}%）</span>
                </div>

                <!-- 经验进度条 -->
                <div class="text-xs mb-3">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-stone-500">道途经验</span>
                    <span class="text-stone-300">
                      {{ profileData.gate.dao_exp }}
                      <span v-if="profileData.gate.dao_level < 10" class="text-stone-500">/ {{ profileData.gate.next_level_exp }}</span>
                      <span v-else class="text-amber-300">（已满级）</span>
                    </span>
                  </div>
                  <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                    <div class="h-full transition-all"
                      :class="getPathTheme(profileData.gate.dao_path).bar"
                      :style="{ width: `${getExpPercent(profileData.gate.dao_exp, profileData.gate.next_level_exp, profileData.gate.dao_level)}%` }"></div>
                  </div>
                </div>

                <!-- 神识值 -->
                <div class="text-xs">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-stone-500">神识</span>
                    <span class="text-sky-300">
                      {{ profileData.divine_sense.current }} / {{ profileData.divine_sense.max }}
                    </span>
                  </div>
                  <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-sky-700 to-sky-400 transition-all"
                      :style="{ width: `${getDivineSensePercent()}%` }"></div>
                  </div>
                </div>
              </section>

              <!-- 引道修炼 + 切换道途 操作区 -->
              <section class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <!-- 引道修炼 -->
                <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                  <div class="text-sm font-bold text-amber-300 mb-2">引道修炼</div>
                  <div class="text-[11px] text-stone-400 mb-3">
                    · 消耗 <span class="text-sky-300">50 神识</span> 获得道途经验<br/>
                    · 每日上限 <span class="text-amber-300">{{ cultivateLimit }}</span> 次（今日已修 <span class="text-amber-300">{{ cultivateCountToday }}</span> 次）
                  </div>
                  <button @click="handleCultivate"
                    :disabled="loading.action || !canCultivate"
                    class="w-full py-2 rounded text-xs font-bold bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed">
                    {{ canCultivate ? '引道修炼' : '不可修炼' }}
                  </button>
                </div>

                <!-- 切换道途 -->
                <div class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                  <div class="text-sm font-bold text-purple-300 mb-2">切换道途</div>
                  <div class="text-[11px] text-stone-400 mb-3">
                    · 每月 <span class="text-amber-300">1 次</span>免费，之后消耗 <span class="text-rose-300">100 五行法则碎片</span><br/>
                    · 切换冷却 <span class="text-amber-300">7 天</span>，等级重置为1，保留 50% 经验
                  </div>
                  <!-- 选择目标道途 -->
                  <select v-model="switchTargetPath"
                    class="w-full bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-purple-500 focus:outline-none mb-2">
                    <option value="">选择目标道途</option>
                    <option v-for="path in allDaoPaths.filter(p => p !== profileData.gate.dao_path)" :key="path" :value="path">
                      {{ getPathName(path) }} - {{ getPathDescription(path).slice(0, 12) }}...
                    </option>
                  </select>
                  <button @click="handleSwitchPath"
                    :disabled="loading.action || !switchTargetPath"
                    class="w-full py-2 rounded text-xs font-bold bg-purple-700 text-purple-100 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed">
                    确认切换
                  </button>
                </div>
              </section>

              <!-- 道途技能列表 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-amber-300 mb-3">道途技能</div>
                <div v-if="profileData.skills.length === 0" class="text-[11px] text-stone-500 text-center py-2">暂无技能</div>
                <div v-else class="space-y-2">
                  <div v-for="skill in profileData.skills" :key="skill.skill_id"
                    class="bg-stone-900/40 border border-stone-800 rounded p-3">
                    <!-- 技能头 -->
                    <div class="flex items-center justify-between mb-2">
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-bold text-amber-300">{{ skill.skill_name }}</span>
                        <!-- 锁定/可用 徽章 -->
                        <span v-if="skill.is_locked" class="text-[9px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-500 border border-stone-700">
                          锁定（需 {{ skill.skill_min_level }} 级）
                        </span>
                        <span v-else-if="skill.cooldown_end && isCoolingDown(skill.cooldown_end)" class="text-[9px] px-1.5 py-0.5 rounded bg-rose-950/60 text-rose-300 border border-rose-800">
                          冷却中
                        </span>
                        <span v-else-if="skill.can_use" class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800">
                          可用
                        </span>
                        <span v-else class="text-[9px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-400 border border-stone-700">
                          神识不足
                        </span>
                      </div>
                      <div class="text-[10px] text-stone-500">
                        消耗 {{ skill.skill_divine_sense_cost }} 神识 · 冷却 {{ skill.skill_cooldown_hours }} 小时
                      </div>
                    </div>
                    <!-- 技能描述 -->
                    <div class="text-[11px] text-stone-400 mb-2">{{ skill.skill_description }}</div>
                    <!-- 冷却倒计时 -->
                    <div v-if="skill.cooldown_end && isCoolingDown(skill.cooldown_end)" class="text-[10px] text-rose-400 mb-2">
                      · 冷却结束于：{{ formatTimeString(skill.cooldown_end) }}
                    </div>

                    <!-- 使用技能：目标输入区（仅对需要目标的技能显示） -->
                    <div v-if="!skill.is_locked && needsTarget(skill.skill_id)" class="grid grid-cols-2 gap-2 mb-2">
                      <input v-model.number="skillTargetPlayerId" type="number" min="1" placeholder="目标玩家 ID"
                        class="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-[11px] text-white focus:border-amber-500 focus:outline-none" />
                      <input v-if="needsBeastId(skill.skill_id)" v-model.number="skillTargetBeastId" type="number" min="1" placeholder="目标灵兽 ID"
                        class="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-[11px] text-white focus:border-amber-500 focus:outline-none" />
                    </div>

                    <!-- 使用技能按钮 -->
                    <button @click="handleUseSkill(skill)"
                      :disabled="loading.action || !canUseSkill(skill)"
                      class="w-full py-1.5 rounded text-[11px] font-bold bg-rose-900/60 border border-rose-700 text-rose-200 hover:bg-rose-800/60 disabled:opacity-50 disabled:cursor-not-allowed">
                      {{ skill.is_locked ? '技能未解锁' : (isCoolingDown(skill.cooldown_end || '') ? '冷却中' : '施展技能') }}
                    </button>
                  </div>
                </div>
              </section>

              <!-- 累计统计 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-stone-300 mb-3">道途累计</div>
                <div class="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <div class="text-[10px] text-stone-500">总修炼次数</div>
                    <div class="text-lg font-bold text-amber-300">{{ profileData.stats.total_cultivate_count }}</div>
                  </div>
                  <div>
                    <div class="text-[10px] text-stone-500">总技能次数</div>
                    <div class="text-lg font-bold text-rose-300">{{ profileData.stats.total_skill_use_count }}</div>
                  </div>
                  <div>
                    <div class="text-[10px] text-stone-500">总共鸣次数</div>
                    <div class="text-lg font-bold text-sky-300">{{ profileData.stats.total_resonance_count }}</div>
                  </div>
                </div>
              </section>
            </template>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无道途数据</div>
        </div>

        <!-- ============ Tab 2: 修炼任务 ============ -->
        <div v-show="activeTab === 'tasks'" class="space-y-3">
          <div v-if="loading.tasks" class="text-center py-6 text-stone-500 text-sm">加载任务中...</div>
          <template v-else-if="tasksData">
            <!-- 任务重置时间 -->
            <section v-if="tasksData.reset_time" class="bg-[#292524] border border-stone-700 rounded-lg p-3 flex items-center justify-between">
              <div class="text-xs text-stone-400">
                · 任务将于 <span class="text-amber-300">{{ formatTimeString(tasksData.reset_time) }}</span> 重置
              </div>
              <button @click="loadTasks"
                :disabled="loading.tasks"
                class="px-3 py-1 text-[11px] bg-stone-800 rounded hover:bg-stone-700 text-stone-300 disabled:opacity-50">
                刷新任务
              </button>
            </section>

            <!-- 任务列表 -->
            <section v-if="tasksData.tasks.length === 0" class="text-center py-12 text-stone-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="mx-auto mb-3 opacity-40">
                <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
              <div class="text-sm">{{ tasksData.message || '今日暂无任务' }}</div>
              <div class="text-[11px] mt-1">需先选择道途方可领取日常任务</div>
            </section>

            <section v-else class="space-y-2">
              <div v-for="(task, idx) in tasksData.tasks" :key="idx"
                class="bg-[#292524] border rounded-lg p-3"
                :class="task.completed && !task.rewards_claimed ? 'border-emerald-700 shadow-lg shadow-emerald-900/20' : 'border-stone-700'">
                <!-- 任务头 -->
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-bold text-amber-300">{{ task.task_name }}</span>
                    <!-- 状态徽章 -->
                    <span v-if="task.rewards_claimed" class="text-[9px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-500 border border-stone-700">
                      已领取
                    </span>
                    <span v-else-if="task.completed" class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800 animate-pulse">
                      可领取
                    </span>
                    <span v-else class="text-[9px] px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800">
                      进行中
                    </span>
                  </div>
                  <div class="text-[10px] text-stone-500">
                    进度：{{ task.current_count }} / {{ task.target_count }}
                  </div>
                </div>
                <!-- 任务描述 -->
                <div class="text-[11px] text-stone-400 mb-2">{{ task.task_description }}</div>
                <!-- 进度条 -->
                <div class="h-1.5 bg-stone-800 rounded-full overflow-hidden mb-2">
                  <div class="h-full transition-all"
                    :class="task.completed ? 'bg-gradient-to-r from-emerald-700 to-emerald-400' : 'bg-gradient-to-r from-amber-700 to-amber-400'"
                    :style="{ width: `${Math.min(100, (task.current_count / task.target_count) * 100)}%` }"></div>
                </div>
                <!-- 奖励 + 领取按钮 -->
                <div class="flex items-center justify-between">
                  <div class="text-[10px] text-stone-400">
                    奖励：
                    <span v-if="task.rewards.dao_exp" class="text-amber-300">道途经验 +{{ task.rewards.dao_exp }}</span>
                    <span v-if="task.rewards.divine_sense" class="text-sky-300"> 神识 +{{ task.rewards.divine_sense }}</span>
                    <span v-if="task.rewards.law_fragment_five_elements" class="text-purple-300"> 五行碎片 +{{ task.rewards.law_fragment_five_elements }}</span>
                  </div>
                  <button v-if="task.completed && !task.rewards_claimed"
                    @click="handleClaimTask(idx)"
                    :disabled="loading.action"
                    class="px-3 py-1 text-[11px] font-bold bg-emerald-700 text-emerald-100 rounded hover:bg-emerald-600 disabled:opacity-50">
                    领取奖励
                  </button>
                </div>
              </div>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无任务数据</div>
        </div>

        <!-- ============ Tab 3: 排行榜 ============ -->
        <div v-show="activeTab === 'ranking'" class="space-y-3">
          <!-- 子分类切换 -->
          <div class="flex border-b border-stone-700 mb-2">
            <button v-for="cat in rankingCategories" :key="cat.key"
              @click="switchRankingCategory(cat.key)"
              class="px-3 py-1.5 text-[11px] font-medium transition-colors relative"
              :class="rankingCategory === cat.key ? 'text-amber-300' : 'text-stone-500 hover:text-stone-300'">
              {{ cat.name }}
              <div v-if="rankingCategory === cat.key" class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-400"></div>
            </button>
          </div>

          <div v-if="loading.ranking" class="text-center py-6 text-stone-500 text-sm">加载排行中...</div>
          <template v-else-if="rankingData">
            <!-- 排行列表 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-3">
              <div class="flex items-center justify-between mb-3">
                <div class="text-xs text-stone-400">
                  · 共 <span class="text-amber-300">{{ rankingData.total }}</span> 名修士上榜
                </div>
                <div class="flex items-center gap-2 text-xs">
                  <button @click="changeRankingPage(rankingData.current_page - 1)"
                    :disabled="loading.ranking || rankingData.current_page <= 1"
                    class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">上一页</button>
                  <span class="text-stone-400">{{ rankingData.current_page }} / {{ rankingData.total_pages || 1 }}</span>
                  <button @click="changeRankingPage(rankingData.current_page + 1)"
                    :disabled="loading.ranking || rankingData.current_page >= rankingData.total_pages"
                    class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">下一页</button>
                </div>
              </div>

              <div v-if="rankingData.rankings.length === 0" class="text-center py-6 text-stone-500 text-xs">
                暂无上榜修士
              </div>
              <div v-else class="space-y-1 max-h-[60vh] overflow-y-auto">
                <div v-for="entry in rankingData.rankings" :key="entry.rank"
                  class="bg-stone-900/40 border border-stone-800 rounded p-2 flex items-center gap-3">
                  <!-- 排名 -->
                  <div class="w-8 text-center shrink-0">
                    <div v-if="entry.rank === 1" class="text-amber-400 font-bold text-lg">①</div>
                    <div v-else-if="entry.rank === 2" class="text-stone-300 font-bold text-lg">②</div>
                    <div v-else-if="entry.rank === 3" class="text-amber-700 font-bold text-lg">③</div>
                    <div v-else class="text-stone-500 text-xs">{{ entry.rank }}</div>
                  </div>
                  <!-- 玩家信息 -->
                  <div class="flex-1 min-w-0">
                    <div class="text-xs text-stone-200 truncate">{{ entry.player_nickname }}</div>
                    <div class="text-[10px]" :class="getPathTheme(entry.dao_path).text">
                      {{ entry.dao_path_name }} · {{ entry.dao_level }} 级
                    </div>
                  </div>
                  <!-- 数值 -->
                  <div class="text-right shrink-0">
                    <div class="text-[10px] text-stone-500">{{ getRankingValueLabel(rankingCategory) }}</div>
                    <div class="text-sm font-bold text-amber-300">{{ entry.value }}</div>
                  </div>
                </div>
              </div>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无排行数据</div>
        </div>

        <!-- ============ Tab 4: 共鸣 ============ -->
        <div v-show="activeTab === 'resonance'" class="space-y-3">
          <div v-if="loading.resonance" class="text-center py-6 text-stone-500 text-sm">加载共鸣状态中...</div>
          <template v-else-if="resonanceData">
            <div v-if="!resonanceData.dao_path" class="text-center py-12 text-stone-500">
              <div class="text-sm">{{ resonanceData.message || '尚未选择道途，无共鸣' }}</div>
            </div>
            <template v-else>
              <!-- 当前道途 -->
              <section class="bg-[#292524] border rounded-lg p-4"
                :class="getPathTheme(resonanceData.dao_path as DaoPath).border">
                <div class="flex items-center justify-between mb-3">
                  <div>
                    <div class="text-sm font-bold" :class="getPathTheme(resonanceData.dao_path as DaoPath).text">
                      {{ resonanceData.dao_path_name }}
                    </div>
                    <div class="text-[10px] text-stone-500">当前道途</div>
                  </div>
                  <div class="text-right">
                    <div class="text-[10px] text-stone-500">共鸣加成</div>
                    <div class="text-xl font-bold text-amber-300">
                      +{{ Math.round(resonanceData.resonance_bonus * 100) }}%
                    </div>
                  </div>
                </div>
                <div class="text-[11px] text-stone-300">{{ resonanceData.resonance_description }}</div>
              </section>

              <!-- 同道途玩家统计 -->
              <section class="grid grid-cols-2 gap-3">
                <div class="bg-[#292524] border border-stone-700 rounded-lg p-4 text-center">
                  <div class="text-[10px] text-stone-500 mb-1">同道途修士</div>
                  <div class="text-2xl font-bold text-amber-300">{{ resonanceData.same_path_total }}</div>
                  <div class="text-[10px] text-stone-500 mt-1">人</div>
                </div>
                <div class="bg-[#292524] border border-stone-700 rounded-lg p-4 text-center">
                  <div class="text-[10px] text-stone-500 mb-1">高等级修士</div>
                  <div class="text-2xl font-bold text-emerald-300">{{ resonanceData.same_path_advanced }}</div>
                  <div class="text-[10px] text-stone-500 mt-1">人（5级以上）</div>
                </div>
              </section>

              <!-- 共鸣加成说明 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-amber-300 mb-2">共鸣机制</div>
                <div class="text-[11px] text-stone-400 space-y-1">
                  · 同道途玩家组队时获得被动加成叠加<br/>
                  · 2人 +10% / 3人 +20% / 4人 +30% / 5人 +50%（封顶）<br/>
                  · 加成作用于道途经验获取与技能效果
                </div>
              </section>

              <!-- 相克道途列表 -->
              <section v-if="resonanceData.restraint_targets.length > 0" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-rose-300 mb-3">相克道途</div>
                <div class="text-[11px] text-stone-400 mb-3">
                  · 你的道途克制以下道途，对它们施展技能时效果 +20%
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div v-for="targetPath in resonanceData.restraint_targets" :key="targetPath"
                    class="bg-stone-900/40 border rounded p-2 flex items-center gap-2"
                    :class="getPathTheme(targetPath as DaoPath).border">
                    <span class="text-xs font-bold" :class="getPathTheme(targetPath as DaoPath).text">
                      {{ getPathName(targetPath as DaoPath) }}
                    </span>
                    <span class="text-[10px] text-stone-500">· 受你克制</span>
                  </div>
                </div>
              </section>
            </template>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无共鸣数据</div>
        </div>
      </div>
    </div>

    <!-- 二次确认弹窗（通用） -->
    <Modal :isOpen="confirmModal.show" :title="confirmModal.title" @close="confirmModal.show = false" width="420px">
      <p class="text-stone-300 text-sm whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <button @click="confirmModal.show = false"
          class="px-4 py-2 text-xs rounded bg-stone-800 text-stone-300 hover:bg-stone-700">取消</button>
        <button @click="confirmModal.onConfirm(); confirmModal.show = false"
          :disabled="loading.action"
          class="px-4 py-2 text-xs rounded bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
          确认
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
/**
 * 太一门引道综合面板脚本
 * 4 Tab 共享一个面板，按需懒加载对应子模块数据
 */
import { ref, reactive, computed, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
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
  DAO_PATH_NAME_MAP,
  DAO_PATH_THEME_MAP,
  type DaoPath,
  type RankingCategory,
  type TaoismProfileData,
  type TaoismTasksData,
  type TaoismRankingData,
  type TaoismResonanceData,
  type TaoismSkillInfo
} from '../../api/taoismGate';

const uiStore = useUIStore();

/** Tab 配置 */
const tabs = [
  { id: 'profile', name: '道途面板' },
  { id: 'tasks', name: '修炼任务' },
  { id: 'ranking', name: '排行榜' },
  { id: 'resonance', name: '共鸣' }
];
/** 当前激活 Tab */
const activeTab = ref('profile');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/** 排行榜子分类配置 */
const rankingCategories = [
  { key: 'dao_level' as RankingCategory, name: '道途等级' },
  { key: 'total_skill_use' as RankingCategory, name: '技能使用次数' },
  { key: 'total_resonance' as RankingCategory, name: '共鸣加成' }
];
/** 当前排行榜子分类 */
const rankingCategory = ref<RankingCategory>('dao_level');

/** 五行道途全集（用于未选择道途时展示卡片） */
const allDaoPaths: DaoPath[] = ['metal', 'wood', 'water', 'fire', 'earth'];

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
 * 本会话内已修炼次数（前端本地计数）
 * 注：后端 profile 接口未暴露当日已修炼次数，故前端按本会话操作累计
 * 仅用于按钮可用性参考，最终以服务端校验为准
 */
const sessionCultivateCount = ref(0);
/** 每日修炼上限（来自后端配置：taoism_gate_data.json daily_cultivate_limit=5） */
const cultivateLimit = 5;

/** 通用二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '操作确认',
  message: '',
  onConfirm: () => {}
});

/**
 * 计算属性：今日是否还可修炼
 * 综合：未满级 + 神识足够 + 本会话未达上限
 */
const canCultivate = computed(() => {
  if (!profileData.value) return false;
  const gate = profileData.value.gate;
  const divine = profileData.value.divine_sense;
  // 已满级不可修炼
  if (gate.dao_level >= 10) return false;
  // 神识不足不可修炼
  if (divine.current < 50) return false;
  // 本会话已达上限（仅作参考，最终以后端校验为准）
  if (sessionCultivateCount.value >= cultivateLimit) return false;
  return true;
});

/**
 * 计算属性：本会话今日已修炼次数（用于展示）
 */
const cultivateCountToday = computed(() => sessionCultivateCount.value);

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
      // 本会话计数+1
      sessionCultivateCount.value += 1;
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
 * 获取道途中文名
 * @param path 道途 key
 */
function getPathName(path: DaoPath): string {
  return DAO_PATH_NAME_MAP[path] || path;
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
 * 获取道途描述（从 profileData 中读取，避免硬编码）
 * @param path 道途 key
 */
function getPathDescription(path: DaoPath): string {
  // 若已加载 profile，可从 gate 字段反查；否则返回通用占位
  if (profileData.value?.gate.dao_path === path) {
    return profileData.value.gate.dao_path_description;
  }
  // 各道途简要描述（仅作为未选择时的卡片简介，详细描述以道途选择后的服务端返回为准）
  const descMap: Record<DaoPath, string> = {
    metal: '金主杀伐，锐利无匹。修炼金道可提升神识攻击力，技能"金锋裂魂"能以神识化刃攻击他人灵兽。',
    wood: '木主生机，绵延不绝。修炼木道可提升灵兽HP恢复速度，技能"木灵回春"能以神识恢复自己灵兽HP。',
    water: '水主防御，以柔克刚。修炼水道可提升神识防御力，技能"水镜映心"能设置反弹盾，反弹下次探查。',
    fire: '火主洞察，焚尽虚妄。修炼火道可提升炼化效率，技能"火眼金睛"能以神识探查他人储物袋。',
    earth: '土主稳固，厚德载物。修炼土道可提升法则转换效率，技能"土牢定身"能定身他人灵兽。'
  };
  return descMap[path] || '';
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
  if (!time) return '-';
  try {
    const d = new Date(time);
    if (isNaN(d.getTime())) return '-';
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return '-';
  }
}
</script>

<style scoped>
/* 局部淡入动画，与 AscensionPanel / MultiDungeonPanel 保持一致 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}
</style>
