/**
 * 多人副本综合面板组件
 *
 * 批次3 多人副本系统 - 掩月抢亲 / 端午镇蛟 / 昆吾山·封魔塔 / 虚天殿 四大副本综合面板
 *
 * Tab 划分：
 *   1. 副本大厅：显示四个副本入口卡片，含名称/人数/境界/冷却/奖励池概要
 *   2. 我的副本：显示当前玩家参与的副本详情（实例信息/变量/抉择/队长操作/队员操作）
 *   3. 奖励池：分四个子页签展示普通掉落/首通奖励/稀有掉落表格
 *   4. 历史记录：分页展示玩家历史副本记录
 *
 * 副本特色：
 *   - yanyue（掩月抢亲）：3-5人，6幕抉择，元婴期及以上
 *   - duanwu（端午镇蛟）：10人投粽，端午专属
 *   - kunwu（昆吾山·封魔塔）：3-5人，4幕+第三幕阵眼多次抉择+第四幕5回合自动决战
 *   - xutian（虚天殿）：3-5人，6幕抉择+第六幕6回合自动决战（2026-07-21 新增）
 *
 * 设计原则：
 *   - 所有状态从后端拉取，禁止硬编码业务数据
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格与 AscensionPanel.vue / SmallWorldPanel.vue 一致（修仙古风：#1c1917 / #292524 / amber-300）
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS
 *   - 进度条颜色按数值分级：<30 红色 / 30-70 黄色 / >70 绿色
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
            <path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/>
          </svg>
          多人副本 · 群英会战
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

        <!-- ============ Tab 1: 副本大厅 ============ -->
        <div v-show="activeTab === 'hall'" class="space-y-3">
          <div v-if="loading.hall" class="text-center py-6 text-stone-500 text-sm">加载副本大厅中...</div>
          <template v-else-if="helpData">
            <!-- 规则说明 -->
            <section v-if="helpData.rules && helpData.rules.length" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-2">副本规则</div>
              <ul class="text-[11px] text-stone-400 space-y-1 list-disc pl-4">
                <li v-for="(rule, idx) in helpData.rules" :key="idx">{{ rule }}</li>
              </ul>
            </section>

            <!-- 副本入口卡片 -->
            <section class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div v-for="dgn in helpData.dungeons" :key="dgn.dungeon_key"
                class="bg-[#292524] border border-stone-700 rounded-lg p-4 flex flex-col">
                <!-- 卡片头部 -->
                <div class="flex items-center justify-between mb-2">
                  <div class="text-sm font-bold text-amber-300">{{ dgn.name }}</div>
                  <div class="text-[10px] px-2 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800">
                    {{ dgn.duration_text || '多人' }}
                  </div>
                </div>
                <!-- 副本描述 -->
                <div class="text-[11px] text-stone-400 mb-3">{{ dgn.description }}</div>
                <!-- 副本参数 -->
                <div class="grid grid-cols-2 gap-2 text-[11px] mb-3">
                  <div>
                    <span class="text-stone-500">人数：</span>
                    <span class="text-stone-200">{{ dgn.min_players }}-{{ dgn.max_players }} 人</span>
                  </div>
                  <div>
                    <span class="text-stone-500">境界：</span>
                    <span class="text-amber-300">{{ dgn.realm_required }}</span>
                  </div>
                </div>
                <!-- 冷却状态 -->
                <div class="text-[11px] mb-3">
                  <span class="text-stone-500">冷却：</span>
                  <span v-if="getCooldown(dgn.dungeon_key)?.in_cooldown" class="text-rose-400">
                    冷却中（剩余 {{ formatTime(getCooldown(dgn.dungeon_key)!.remaining_seconds) }}）
                  </span>
                  <span v-else class="text-emerald-300">可开启</span>
                </div>
                <!-- 操作按钮：队长开启副本 -->
                <button @click="handleCreate(dgn.dungeon_key)"
                  :disabled="loading.action || (getCooldown(dgn.dungeon_key)?.in_cooldown ?? false)"
                  class="w-full py-2 rounded text-xs font-bold bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
                  开启副本
                </button>
              </div>
            </section>

            <!-- 队员加入入口 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-2">加入他人副本</div>
              <div class="text-[11px] text-stone-400 mb-3">· 输入队长分享的实例 ID，即可加入对应副本</div>
              <div class="flex items-center gap-2">
                <input v-model.number="joinInstanceId" type="number" min="1" placeholder="实例 ID"
                  class="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none" />
                <button @click="handleJoin"
                  :disabled="loading.action || !joinInstanceId"
                  class="px-4 py-2 rounded text-xs font-bold bg-purple-700 text-purple-100 hover:bg-purple-600 disabled:opacity-50">
                  加入副本
                </button>
              </div>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无副本数据</div>
        </div>

        <!-- ============ Tab 2: 我的副本 ============ -->
        <div v-show="activeTab === 'mine'" class="space-y-3">
          <div v-if="loading.mine" class="text-center py-6 text-stone-500 text-sm">加载副本进度中...</div>
          <template v-else-if="statusData && statusData.has_instance && statusData.instance">
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <!-- 实例信息头 -->
              <div class="flex items-center justify-between mb-3">
                <div>
                  <div class="text-sm font-bold text-amber-300">{{ statusData.instance.dungeon_name }}</div>
                  <div class="text-[10px] text-stone-500">实例 ID：{{ statusData.instance.instance_id }}</div>
                </div>
                <div class="text-[10px] px-2 py-0.5 rounded border" :class="getStatusBadgeClass(statusData.instance.status)">
                  {{ getStatusName(statusData.instance.status) }}
                </div>
              </div>
              <!-- 当前幕数 -->
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
                <div>
                  <div class="text-stone-500">当前幕数</div>
                  <div class="text-amber-300 font-bold">
                    第 {{ statusData.instance.current_act }} 幕
                    <span v-if="statusData.instance.total_acts"> / {{ statusData.instance.total_acts }} 幕</span>
                  </div>
                </div>
                <div>
                  <div class="text-stone-500">队长</div>
                  <div class="text-stone-200 font-bold">{{ statusData.instance.leader_player_name || `#${statusData.instance.leader_player_id}` }}</div>
                </div>
                <div>
                  <div class="text-stone-500">成员数</div>
                  <div class="text-stone-200 font-bold">{{ statusData.instance.members.length }} 人</div>
                </div>
                <div>
                  <div class="text-stone-500">我的身份</div>
                  <div v-if="statusData.instance.is_leader" class="text-amber-300 font-bold">队长</div>
                  <div v-else class="text-purple-300 font-bold">队员</div>
                </div>
              </div>
              <!-- 成员列表 -->
              <div class="bg-stone-900/40 border border-stone-800 rounded p-2 mb-3">
                <div class="text-[11px] text-stone-500 mb-1">成员列表</div>
                <div class="grid grid-cols-2 md:grid-cols-3 gap-1">
                  <div v-for="m in statusData.instance.members" :key="m.player_id"
                    class="text-[11px] flex items-center gap-1">
                    <span :class="m.is_leader ? 'text-amber-300' : 'text-stone-300'">
                      {{ m.player_name }}
                    </span>
                    <span v-if="m.is_leader" class="text-[9px] text-amber-500">[队长]</span>
                    <span v-if="!m.is_online" class="text-[9px] text-stone-600">[离线]</span>
                  </div>
                </div>
              </div>
            </section>

            <!-- 副本变量（进度条） -->
            <section v-if="statusData.instance.variables" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-3">副本变量</div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div v-for="(val, key) in statusData.instance.variables" :key="key" class="text-xs">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-stone-400">{{ getVariableName(key as DungeonVariable) }}</span>
                    <!-- 虚天殿·道路选择特殊展示：0=未选 / 1=冰道 / 2=火道 -->
                    <span v-if="key === 'path_choice'" class="font-bold text-cyan-300">
                      {{ getPathChoiceText(val as number) }}
                    </span>
                    <!-- 虚天主魂HP特殊展示：null=未进入第六幕 -->
                    <span v-else-if="key === 'void_soul_hp'" class="font-bold" :class="val ? 'text-rose-300' : 'text-stone-500'">
                      {{ val ? val : '未进入第六幕' }}
                    </span>
                    <!-- 通用数值展示 -->
                    <span v-else class="font-bold" :class="getVariableValueClass(val as number)">{{ val }}</span>
                  </div>
                  <!-- 进度条：根据数值高低显示不同颜色（道路选择与未进入第六幕的虚天主魂HP不显示进度条） -->
                  <div v-if="key !== 'path_choice' && !(key === 'void_soul_hp' && !val)" class="h-1.5 bg-stone-800 rounded-full overflow-hidden">
                    <div class="h-full transition-all"
                      :class="getVariableBarClass(Number(val))"
                      :style="{ width: `${getVariablePercent(Number(val), key as DungeonVariable)}%` }"></div>
                  </div>
                </div>
              </div>
            </section>

            <!-- 当前幕剧情 + 抉择 -->
            <section v-if="statusData.instance.current_act_description" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-2">第 {{ statusData.instance.current_act }} 幕 · 剧情推进</div>
              <p class="text-[12px] text-stone-300 mb-3 whitespace-pre-line">{{ statusData.instance.current_act_description }}</p>

              <!-- 昆吾山第三幕阵眼进度提示 -->
              <div v-if="statusData.instance.multi_choice_progress" class="mb-3 p-2 bg-purple-950/30 border border-purple-800 rounded text-[11px] text-purple-300">
                · 阵眼进度：{{ statusData.instance.multi_choice_progress.finished_count }} / {{ statusData.instance.multi_choice_progress.total_count }}
                <span v-if="statusData.instance.multi_choice_progress.next_eye_name">
                  · 下一阵眼：{{ statusData.instance.multi_choice_progress.next_eye_name }}
                </span>
              </div>

              <!-- 抉择选项（仅队长可推进） -->
              <div v-if="statusData.instance.current_choices && statusData.instance.current_choices.length">
                <div class="text-[11px] text-stone-500 mb-2">
                  · {{ statusData.instance.is_leader ? '请队长抉择推进剧情' : '等待队长抉择' }}
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <button v-for="choice in statusData.instance.current_choices" :key="choice.choice_key"
                    @click="handleChoose(choice.choice_key)"
                    :disabled="loading.action || !statusData.instance.is_leader"
                    class="bg-stone-900/50 border border-stone-700 rounded p-2 text-left hover:border-amber-600 disabled:opacity-50 disabled:cursor-not-allowed">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-xs font-bold text-amber-300">{{ choice.name }}</span>
                      <span v-if="choice.is_recommended" class="text-[9px] text-emerald-400">推荐</span>
                    </div>
                    <div v-if="choice.description" class="text-[10px] text-stone-400 mb-1">{{ choice.description }}</div>
                    <!-- 变量变化预览 -->
                    <div v-if="choice.variable_changes" class="flex flex-wrap gap-1 mt-1">
                      <span v-for="(chg, vk) in choice.variable_changes" :key="vk"
                        class="text-[9px] px-1 py-0.5 rounded"
                        :class="(chg as number) >= 0 ? 'bg-emerald-950/60 text-emerald-300' : 'bg-rose-950/60 text-rose-300'">
                        {{ getVariableName(vk as DungeonVariable) }} {{ (chg as number) >= 0 ? '+' : '' }}{{ chg }}
                      </span>
                    </div>
                  </button>
                </div>
              </div>

              <!-- 昆吾山第四幕 / 虚天殿第六幕 自动决战按钮 -->
              <div v-else-if="statusData.instance.is_auto_advance" class="mt-2">
                <div class="text-[11px] text-stone-500 mb-2">
                  · 本幕为自动决战，{{ statusData.instance.is_leader ? `请队长确认后触发${statusData.instance.rounds_max || 5}回合战斗` : '等待队长触发决战' }}
                </div>
                <button v-if="statusData.instance.is_leader" @click="handleAdvance"
                  :disabled="loading.action"
                  class="w-full py-3 rounded text-sm font-bold bg-gradient-to-r from-rose-900 to-purple-900 border border-rose-600 text-amber-200 hover:from-rose-800 hover:to-purple-800 disabled:opacity-50 disabled:cursor-not-allowed">
                  ⚔ {{ getAdvanceButtonText(statusData.instance.dungeon_key) }}（{{ statusData.instance.rounds_max || 5 }} 回合）
                </button>
                <div v-else class="text-center text-[11px] text-stone-500 py-2">
                  · 仅队长可触发决战
                </div>
              </div>
            </section>

            <!-- 队长操作区 -->
            <section v-if="statusData.instance.is_leader" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-3">队长操作</div>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
                <!-- 进入开打：仅在 forming 状态可用 -->
                <button v-if="statusData.instance.status === 'forming'" @click="handleEnter"
                  :disabled="loading.action"
                  class="py-2 rounded text-xs font-bold bg-emerald-950/40 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-50">
                  进入开打
                </button>
                <!-- 解散副本 -->
                <button @click="handleDissolve"
                  :disabled="loading.action"
                  class="py-2 rounded text-xs font-bold bg-rose-950/40 border border-rose-800 text-rose-300 hover:bg-rose-900/40 disabled:opacity-50">
                  解散副本
                </button>
              </div>
              <!-- 踢人操作 -->
              <div class="mt-3 border-t border-stone-700 pt-3">
                <div class="text-[11px] text-stone-500 mb-2">· 选择成员踢出副本</div>
                <div class="flex items-center gap-2">
                  <select v-model.number="kickTargetId"
                    class="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-rose-500 focus:outline-none">
                    <option value="">选择成员</option>
                    <option v-for="m in kickableMembers(statusData.instance)" :key="m.player_id" :value="m.player_id">
                      {{ m.player_name }}（ID: {{ m.player_id }}）
                    </option>
                  </select>
                  <button @click="handleKick"
                    :disabled="loading.action || !kickTargetId"
                    class="px-4 py-2 rounded text-xs font-bold bg-rose-800 text-rose-100 hover:bg-rose-700 disabled:opacity-50">
                    踢出
                  </button>
                </div>
              </div>
            </section>

            <!-- 队员操作区：端午投粽 -->
            <section v-if="!statusData.instance.is_leader && statusData.instance.dungeon_key === 'duanwu' && statusData.instance.status === 'active'"
              class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-3">端午投粽</div>
              <div class="text-[11px] text-stone-400 mb-3">· 每次投粽 1-5 个，可提升封印稳定度</div>
              <div class="flex items-center gap-2">
                <input v-model.number="zongziCount" type="number" min="1" max="5" placeholder="1-5"
                  class="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-purple-500 focus:outline-none" />
                <button @click="handleThrowZongzi"
                  :disabled="loading.action || !zongziCount || zongziCount < 1 || zongziCount > 5"
                  class="px-4 py-2 rounded text-xs font-bold bg-purple-700 text-purple-100 hover:bg-purple-600 disabled:opacity-50">
                  投粽
                </button>
              </div>
            </section>
          </template>
          <!-- 无副本空状态 -->
          <div v-else class="text-center py-12 text-stone-500">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="mx-auto mb-3 opacity-40">
              <path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/>
            </svg>
            <div class="text-sm">当前未参与任何副本</div>
            <div class="text-[11px] mt-1">前往「副本大厅」开启或加入副本</div>
          </div>
        </div>

        <!-- ============ Tab 3: 奖励池 ============ -->
        <div v-show="activeTab === 'rewards'" class="space-y-3">
          <!-- 子页签切换 -->
          <div class="flex border-b border-stone-700 mb-2">
            <button v-for="sub in rewardSubTabs" :key="sub.key"
              @click="switchRewardSub(sub.key)"
              class="px-3 py-1.5 text-[11px] font-medium transition-colors relative"
              :class="rewardSubTab === sub.key ? 'text-amber-300' : 'text-stone-500 hover:text-stone-300'">
              {{ sub.name }}
              <div v-if="rewardSubTab === sub.key" class="absolute bottom-0 left-0 w-full h-0.5 bg-amber-400"></div>
            </button>
          </div>

          <div v-if="loading.rewards" class="text-center py-6 text-stone-500 text-sm">加载奖励池中...</div>
          <template v-else-if="rewardsData">
            <!-- 普通掉落 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-stone-300 mb-2">普通掉落</div>
              <div v-if="rewardsData.normal_rewards.length === 0" class="text-[11px] text-stone-500 text-center py-2">暂无</div>
              <table v-else class="w-full text-[11px]">
                <thead>
                  <tr class="text-stone-500 border-b border-stone-700">
                    <th class="text-left py-1">名称</th>
                    <th class="text-left py-1">描述</th>
                    <th class="text-right py-1">数量/概率</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in rewardsData.normal_rewards" :key="r.reward_key" class="border-b border-stone-800">
                    <td class="py-1 text-amber-300">{{ r.name }}</td>
                    <td class="py-1 text-stone-400">{{ r.description || '-' }}</td>
                    <td class="py-1 text-right text-stone-200">{{ r.amount ?? '-' }}</td>
                  </tr>
                </tbody>
              </table>
            </section>
            <!-- 首通奖励 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-2">首通奖励</div>
              <div v-if="rewardsData.first_clear_rewards.length === 0" class="text-[11px] text-stone-500 text-center py-2">暂无</div>
              <table v-else class="w-full text-[11px]">
                <thead>
                  <tr class="text-stone-500 border-b border-stone-700">
                    <th class="text-left py-1">名称</th>
                    <th class="text-left py-1">描述</th>
                    <th class="text-right py-1">数量</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in rewardsData.first_clear_rewards" :key="r.reward_key" class="border-b border-stone-800">
                    <td class="py-1 text-purple-300">{{ r.name }}</td>
                    <td class="py-1 text-stone-400">{{ r.description || '-' }}</td>
                    <td class="py-1 text-right text-stone-200">{{ r.amount ?? '-' }}</td>
                  </tr>
                </tbody>
              </table>
            </section>
            <!-- 稀有掉落 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-rose-300 mb-2">稀有掉落</div>
              <div v-if="rewardsData.rare_rewards.length === 0" class="text-[11px] text-stone-500 text-center py-2">暂无</div>
              <table v-else class="w-full text-[11px]">
                <thead>
                  <tr class="text-stone-500 border-b border-stone-700">
                    <th class="text-left py-1">名称</th>
                    <th class="text-left py-1">描述</th>
                    <th class="text-right py-1">数量/概率</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in rewardsData.rare_rewards" :key="r.reward_key" class="border-b border-stone-800">
                    <td class="py-1 text-rose-300">{{ r.name }}</td>
                    <td class="py-1 text-stone-400">{{ r.description || '-' }}</td>
                    <td class="py-1 text-right text-stone-200">{{ r.amount ?? '-' }}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          </template>
          <div v-else class="text-center py-6 text-stone-500 text-sm">暂无奖励数据</div>
        </div>

        <!-- ============ Tab 4: 历史记录 ============ -->
        <div v-show="activeTab === 'history'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-amber-300">副本历史</div>
              <div class="flex items-center gap-2 text-xs">
                <button @click="changeHistoryPage(historyData.page - 1)"
                  :disabled="loading.history || historyData.page <= 1"
                  class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">上一页</button>
                <span class="text-stone-400">{{ historyData.page }} / {{ historyData.total_pages || 1 }}</span>
                <button @click="changeHistoryPage(historyData.page + 1)"
                  :disabled="loading.history || historyData.page >= historyData.total_pages"
                  class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">下一页</button>
              </div>
            </div>
            <div v-if="loading.history" class="text-center py-3 text-stone-500 text-xs">加载历史记录中...</div>
            <div v-else-if="historyData.list.length === 0" class="text-center py-6 text-stone-500 text-xs">
              暂无历史记录
            </div>
            <div v-else class="space-y-1 max-h-96 overflow-y-auto">
              <div v-for="rec in historyData.list" :key="rec.id"
                class="bg-stone-900/40 border border-stone-800 rounded p-2 text-[11px]">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-2">
                    <span class="text-amber-300 font-bold">{{ rec.dungeon_name }}</span>
                    <span v-if="rec.is_first_clear" class="text-[9px] px-1 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800">首通</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded" :class="getResultBadgeClass(rec.result)">
                      {{ getResultName(rec.result) }}
                    </span>
                  </div>
                  <span class="text-stone-500">{{ formatTimeString(rec.finished_at) }}</span>
                </div>
                <div class="text-stone-400">
                  · 进度：第 {{ rec.reached_act || 0 }} 幕<span v-if="rec.total_acts"> / {{ rec.total_acts }} 幕</span>
                </div>
                <div v-if="rec.rewards && rec.rewards.length" class="text-stone-400 mt-1">
                  · 奖励：
                  <span v-for="(rw, idx) in rec.rewards" :key="idx" class="text-emerald-300">
                    {{ rw.name }}<span v-if="rw.amount"> ×{{ rw.amount }}</span><span v-if="idx < rec.rewards!.length - 1">、</span>
                  </span>
                </div>
              </div>
            </div>
          </section>
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
 * 多人副本综合面板脚本
 * 4 Tab 共享一个面板，按需懒加载对应子模块数据
 */
import { ref, reactive, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import { useUIStore } from '../../stores/ui';
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
  type DungeonKey,
  type DungeonVariable,
  type MultiDungeonHelpData,
  type MultiDungeonStatusData,
  type MultiDungeonRewardsData,
  type MultiDungeonHistoryData,
  type MultiDungeonCooldown,
  type MultiDungeonInstance,
  type MultiDungeonMember
} from '../../api/multiDungeon';

const uiStore = useUIStore();

/** Tab 配置 */
const tabs = [
  { id: 'hall', name: '副本大厅' },
  { id: 'mine', name: '我的副本' },
  { id: 'rewards', name: '奖励池' },
  { id: 'history', name: '历史记录' }
];
/** 当前激活 Tab */
const activeTab = ref('hall');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/** 奖励池子页签配置 */
// 2026-07-21 新增 xutian（虚天殿）
const rewardSubTabs = [
  { key: 'yanyue' as DungeonKey, name: '掩月抢亲' },
  { key: 'duanwu' as DungeonKey, name: '端午镇蛟' },
  { key: 'kunwu' as DungeonKey, name: '昆吾山·封魔塔' },
  { key: 'xutian' as DungeonKey, name: '虚天殿' }
];
/** 奖励池当前子页签 */
const rewardSubTab = ref<DungeonKey>('yanyue');

/** 各模块加载状态 */
const loading = reactive({
  hall: false,
  mine: false,
  rewards: false,
  history: false,
  action: false
});

/** 各模块数据 */
const helpData = ref<MultiDungeonHelpData | null>(null);
const statusData = ref<MultiDungeonStatusData | null>(null);
const rewardsData = ref<MultiDungeonRewardsData | null>(null);
const cooldownList = ref<MultiDungeonCooldown[]>([]);
const historyData = reactive<MultiDungeonHistoryData>({
  list: [], total: 0, page: 1, page_size: 20, total_pages: 0
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

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (loadedTabs.has(tabId)) return;
  if (tabId === 'hall') await loadHall();
  else if (tabId === 'mine') await loadStatus();
  else if (tabId === 'rewards') await loadRewards(rewardSubTab.value);
  else if (tabId === 'history') await loadHistory();
  loadedTabs.add(tabId);
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

/** 加载副本大厅（规则 + 副本列表） */
async function loadHall() {
  loading.hall = true;
  try {
    const resp = await multiDungeonGetHelp();
    if (resp.data?.code === 200 && resp.data.data) {
      helpData.value = resp.data.data;
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
      cooldownList.value = resp.data.data.cooldowns || [];
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
function getCooldown(key: DungeonKey): MultiDungeonCooldown | undefined {
  return cooldownList.value.find(c => c.dungeon_key === key);
}

/** 加载我的副本进度 */
async function loadStatus() {
  loading.mine = true;
  try {
    const resp = await multiDungeonGetStatus();
    if (resp.data?.code === 200 && resp.data.data) {
      statusData.value = resp.data.data;
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
  loading.rewards = true;
  try {
    const resp = await multiDungeonGetRewards(key);
    if (resp.data?.code === 200 && resp.data.data) {
      rewardsData.value = resp.data.data;
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
    const resp = await multiDungeonGetHistory(historyData.page, historyData.page_size);
    if (resp.data?.code === 200 && resp.data.data) {
      Object.assign(historyData, resp.data.data);
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
  if (page < 1 || page > historyData.total_pages) return;
  historyData.page = page;
  await loadHistory();
}

// ============ 操作处理函数 ============

/**
 * 队长开启副本
 * @param dungeonKey 副本 key
 */
function handleCreate(dungeonKey: DungeonKey) {
  const dgn = helpData.value?.dungeons.find(d => d.dungeon_key === dungeonKey);
  showConfirm(
    '开启副本',
    `确认以队长身份开启「${dgn?.name || dungeonKey}」副本？\n· 需等待队员加入后由你「进入开打」\n· 解散前不可再开新副本`,
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonCreate(dungeonKey);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '副本已开启', 'success');
          // 切换到「我的副本」Tab 查看
          await switchTab('mine');
          await loadStatus();
        } else {
          uiStore.showToast(resp.data?.message || '开启失败', 'error');
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
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '加入成功', 'success');
      joinInstanceId.value = null;
      // 切换到「我的副本」Tab 查看
      await switchTab('mine');
      await loadStatus();
    } else {
      uiStore.showToast(resp.data?.message || '加入失败', 'error');
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
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '已进入开打', 'success');
      await loadStatus();
    } else {
      uiStore.showToast(resp.data?.message || '进入失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 队长推进抉择
 * @param choiceKey 选项 key
 */
async function handleChoose(choiceKey: string) {
  showConfirm(
    '推进抉择',
    `确认推进此选项？\n· 抉择不可撤回\n· 变量变化将立即生效`,
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonChoose(choiceKey);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '抉择已推进', 'success');
          await loadStatus();
          // 副本结束时同步刷新冷却
          if (resp.data.data?.is_finished) {
            await loadCooldown();
          }
        } else {
          uiStore.showToast(resp.data?.message || '推进失败', 'error');
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
 * 队长触发自动决战（昆吾山第四幕 / 虚天殿第六幕通用）
 * 一次性结算自动战斗，不可中途干预
 * - kunwu: 5 回合，每回合伤害 = 200000 + 玲珑值 × 2000
 * - xutian: 6 回合，每回合伤害 = 180000 + 阵法强度 × 2500
 */
function handleAdvance() {
  // 根据副本键构造不同的确认提示
  const dungeonKey = statusData.value?.instance?.dungeon_key;
  const isXutian = dungeonKey === 'xutian';
  const title = isXutian ? '虚天主魂·幻海归元' : '玲珑封魔塔决战';
  const roundsMax = isXutian ? 6 : 5;
  const damageFormula = isXutian
    ? `每回合伤害 = 180000 + 阵法强度 × 2500`
    : `每回合伤害 = 200000 + 玲珑值 × 2000`;
  const clearCondition = isXutian
    ? `6回合内削减虚天主魂HP（1500000）至0 即通关`
    : `5回合内击杀塔心魔影（1000000）且封印推进≥80 即通关`;

  showConfirm(
    title,
    `确认触发「${title}」？\n· 系统将自动进行${roundsMax}回合战斗\n· ${damageFormula}\n· ${clearCondition}\n· 操作不可撤销`,
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonAdvance();
        if (resp.data?.code === 200 && resp.data.data) {
          const result = resp.data.data;
          // 展示决战结果详情（昆吾山/虚天殿共用日志格式，字段差异由后端保证）
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
            ? `\n\n战斗回合：${result.auto_battle.rounds_total}\n总伤害：${totalDamage.toString()}`
            : '';
          uiStore.showToast(
            (resp.data.message || '决战完成') + detailMsg,
            result.instance_state === 'cleared' ? 'success' : 'error'
          );
          await loadStatus();
          // 副本结束同步刷新冷却
          await loadCooldown();
        } else {
          uiStore.showToast(resp.data?.message || '决战失败', 'error');
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
 * 获取自动决战按钮文案
 * @param dungeonKey 副本键
 * @returns 按钮文案（昆吾山=触发封魔决战 / 虚天殿=幻海归元决战）
 */
function getAdvanceButtonText(dungeonKey: DungeonKey | undefined): string {
  if (dungeonKey === 'xutian') return '触发虚天主魂决战';
  return '触发封魔决战';
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
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '投粽成功', 'success');
      zongziCount.value = null;
      await loadStatus();
    } else {
      uiStore.showToast(resp.data?.message || '投粽失败', 'error');
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
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '副本已解散', 'success');
          await loadStatus();
        } else {
          uiStore.showToast(resp.data?.message || '解散失败', 'error');
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
  showConfirm(
    '踢出成员',
    `确认将玩家 ID=${kickTargetId.value} 踢出副本？\n· 该玩家将立即退出副本`,
    async () => {
      loading.action = true;
      try {
        const resp = await multiDungeonKick(kickTargetId.value!);
        if (resp.data?.code === 200) {
          uiStore.showToast(resp.data.message || '已踢出', 'success');
          kickTargetId.value = null;
          await loadStatus();
        } else {
          uiStore.showToast(resp.data?.message || '踢人失败', 'error');
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
 * 获取副本状态中文名
 * @param status 状态值
 */
function getStatusName(status: string): string {
  const map: Record<string, string> = {
    forming: '集结中',
    active: '进行中',
    choosing: '抉择中',
    finished: '已结束',
    dissolved: '已解散'
  };
  return map[status] || status;
}

/**
 * 获取副本状态徽章样式
 * @param status 状态值
 */
function getStatusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    forming: 'bg-amber-950/60 text-amber-300 border-amber-800',
    active: 'bg-emerald-950/60 text-emerald-300 border-emerald-800',
    choosing: 'bg-purple-950/60 text-purple-300 border-purple-800',
    finished: 'bg-stone-800 text-stone-400 border-stone-700',
    dissolved: 'bg-rose-950/60 text-rose-300 border-rose-800'
  };
  return map[status] || 'bg-stone-800 text-stone-400 border-stone-700';
}

/**
 * 获取历史结果中文名
 * @param result 结果值
 */
function getResultName(result: string): string {
  const map: Record<string, string> = {
    success: '成功',
    fail: '失败',
    dissolved: '解散'
  };
  return map[result] || result;
}

/**
 * 获取历史结果徽章样式
 * @param result 结果值
 */
function getResultBadgeClass(result: string): string {
  const map: Record<string, string> = {
    success: 'bg-emerald-950/60 text-emerald-300 border border-emerald-800',
    fail: 'bg-rose-950/60 text-rose-300 border border-rose-800',
    dissolved: 'bg-stone-800 text-stone-400 border border-stone-700'
  };
  return map[result] || 'bg-stone-800 text-stone-400 border border-stone-700';
}

/**
 * 获取副本变量中文名
 * @param key 变量 key
 */
function getVariableName(key: DungeonVariable): string {
  const map: Record<DungeonVariable, string> = {
    morale: '士气',
    vigilance: '警戒',
    demon_corruption: '魔染',
    seal_stability: '封印稳定度',
    soul_stability: '神魂稳定度',
    harvest_multiplier: '收获倍率',
    // 昆吾山·封魔塔专属变量
    demonic_qi: '魔气',
    mountain_seal: '山禁',
    treasure_pressure: '宝压/夺宝压力',
    linglong: '玲珑',
    seal_progress: '封印推进',
    tower_shadow_hp: '塔心魔影HP',
    // 虚天殿专属变量（2026-07-21 新增）
    path_choice: '道路选择',
    formation_power: '阵法强度',
    void_soul_hp: '虚天主魂HP'
  };
  return map[key] || key;
}

/**
 * 根据变量值获取进度条颜色类
 * <30 红色 / 30-70 黄色 / >70 绿色
 * @param val 数值
 */
function getVariableBarClass(val: number): string {
  if (val < 30) return 'bg-gradient-to-r from-rose-700 to-rose-500';
  if (val <= 70) return 'bg-gradient-to-r from-amber-600 to-amber-400';
  return 'bg-gradient-to-r from-emerald-700 to-emerald-500';
}

/**
 * 根据变量值获取数值文字颜色类
 * @param val 数值
 */
function getVariableValueClass(val: number): string {
  if (val < 30) return 'text-rose-400';
  if (val <= 70) return 'text-amber-300';
  return 'text-emerald-300';
}

/**
 * 计算变量百分比（用于进度条宽度）
 * @param val 当前值
 * @param key 变量 key（收获倍率按 200 上限 / 塔心魔影HP 按 1000000 上限 / 虚天主魂HP 按 1500000 上限 / 其他按 100 上限）
 */
function getVariablePercent(val: number, key: DungeonVariable): number {
  // 收获倍率通常为 1.0-2.0，按 200% 上限显示
  if (key === 'harvest_multiplier') {
    return Math.min(100, Math.max(0, (val / 2) * 100));
  }
  // 塔心魔影HP 初始1000000，按此上限显示百分比
  if (key === 'tower_shadow_hp') {
    return Math.min(100, Math.max(0, (val / 1000000) * 100));
  }
  // 虚天主魂HP 初始1500000，按此上限显示百分比（2026-07-21 新增）
  if (key === 'void_soul_hp') {
    return Math.min(100, Math.max(0, (val / 1500000) * 100));
  }
  // 其他变量按 0-100 显示
  return Math.min(100, Math.max(0, val));
}

/**
 * 获取可踢出的成员列表（排除队长本人）
 * @param instance 副本实例
 */
function kickableMembers(instance: MultiDungeonInstance): MultiDungeonMember[] {
  return instance.members.filter(m => !m.is_leader);
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

<style scoped>
/* 局部淡入动画，与 AscensionPanel / SmallWorldPanel 保持一致 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}
</style>
