<template>
  <!--
    神识对决面板（1v1 同时选择博弈 PvP）
    - 4 Tab：当前对决/发起挑战/对决历史/玩法说明
    - 业务逻辑全部在后端 DivineDuelService 中处理，前端仅展示与接口调用
    - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
  -->
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm" @click.self="emit('close')">
    <div class="relative w-full max-w-4xl max-h-[92vh] mx-4 bg-gradient-to-b from-[#1c1917] to-[#0c0a09] border border-purple-900/50 rounded-2xl shadow-2xl shadow-purple-900/30 flex flex-col">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-purple-900/40 shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-indigo-700 flex items-center justify-center shadow-lg shadow-purple-900/50">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-purple-100">
              <path d="M12 2a10 10 0 1 0 10 10"/>
              <path d="M12 2v10l7 7"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
          <div>
            <h2 class="text-xl font-bold text-purple-200 tracking-wider">神识对决</h2>
            <p class="text-[11px] text-stone-500">1v1 同时选择博弈 · 灵识交锋</p>
          </div>
        </div>
        <button @click="emit('close')" class="text-stone-400 hover:text-rose-400 transition-colors w-8 h-8 flex items-center justify-center rounded-full hover:bg-rose-900/30">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- Tab 栏 -->
      <div class="flex border-b border-purple-900/40 shrink-0">
        <button v-for="tab in tabs" :key="tab.id" @click="switchTab(tab.id)"
          :class="['flex-1 px-4 py-3 text-sm font-bold tracking-wider transition-all relative',
                   activeTab === tab.id ? 'text-purple-200 bg-purple-900/20' : 'text-stone-500 hover:text-stone-300']">
          {{ tab.name }}
          <span v-if="tab.id === 'active' && activeDuel" class="absolute top-1 right-2 w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        </button>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto p-6">
        <!-- Tab 1: 当前对决 -->
        <div v-if="activeTab === 'active'">
          <div v-if="loadingActive" class="text-center py-10 text-stone-500">查询中...</div>
          <div v-else-if="!activeDuel" class="text-center py-12">
            <div class="text-stone-500 text-sm mb-3">当前无进行中的神识对决</div>
            <button @click="switchTab('challenge')" class="px-5 py-2 bg-purple-700 hover:bg-purple-600 text-purple-100 rounded-lg text-sm font-bold transition-colors">
              前往发起挑战
            </button>
          </div>
          <div v-else class="space-y-5">
            <!-- 对决基本信息 -->
            <div class="bg-purple-950/30 border border-purple-900/40 rounded-xl p-4">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <span class="text-xs px-2 py-0.5 rounded-full" :class="statusBadgeClass(activeDuel.status)">{{ statusLabel(activeDuel.status) }}</span>
                  <span class="text-xs text-stone-500">第 {{ activeDuel.round_number }} 回合</span>
                </div>
                <div class="text-xs text-stone-400">
                  赌注：<span class="text-amber-300 font-bold">{{ activeDuel.bet_amount }}</span>
                  <span class="text-stone-500">{{ activeDuel.bet_type === 'spirit_stone' ? '灵石' : '神识' }}</span>
                </div>
              </div>

              <!-- 双方对决区 -->
              <div class="grid grid-cols-2 gap-3">
                <!-- 发起方 -->
                <div class="bg-stone-900/50 border border-stone-700/50 rounded-lg p-3 text-center">
                  <div class="text-xs text-stone-500 mb-1">发起方</div>
                  <div class="text-sm font-bold text-purple-200 truncate">{{ activeDuel.challenger?.nickname || '未知' }}</div>
                  <div class="text-[10px] text-stone-500 mb-2">{{ activeDuel.challenger?.realm_name || `境界 ${activeDuel.challenger?.realm_rank}` }}</div>
                  <div class="text-2xl font-bold" :class="shieldColorClass(activeDuel.challenger_shield)">{{ activeDuel.challenger_shield }}</div>
                  <div class="text-[10px] text-stone-500 mt-1">护盾值</div>
                </div>
                <!-- 应战方 -->
                <div class="bg-stone-900/50 border border-stone-700/50 rounded-lg p-3 text-center">
                  <div class="text-xs text-stone-500 mb-1">应战方</div>
                  <div class="text-sm font-bold text-purple-200 truncate">{{ activeDuel.defender?.nickname || '未知' }}</div>
                  <div class="text-[10px] text-stone-500 mb-2">{{ activeDuel.defender?.realm_name || `境界 ${activeDuel.defender?.realm_rank}` }}</div>
                  <div class="text-2xl font-bold" :class="shieldColorClass(activeDuel.defender_shield)">{{ activeDuel.defender_shield }}</div>
                  <div class="text-[10px] text-stone-500 mt-1">护盾值</div>
                </div>
              </div>
            </div>

            <!-- 行动状态与操作 -->
            <div v-if="activeDuel.status === 'ongoing'" class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
              <div class="text-center mb-3">
                <div v-if="activeDuel.your_action" class="text-sm text-emerald-300">
                  你已选择「{{ actionLabel(activeDuel.your_action) }}」，等待对手...
                </div>
                <div v-else class="text-sm text-amber-300">
                  请选择本回合行动
                </div>
                <div v-if="activeDuel.action_deadline" class="text-[10px] text-stone-500 mt-1">
                  行动截止：{{ formatTime(activeDuel.action_deadline) }}
                </div>
              </div>

              <!-- 行动按钮 -->
              <div class="grid grid-cols-2 gap-3">
                <button @click="openActionConfirm('focus')"
                  :disabled="!!activeDuel.your_action || actionLoading"
                  :class="['px-4 py-3 rounded-lg font-bold text-sm transition-all border',
                           activeDuel.your_action === 'focus'
                             ? 'bg-rose-900/40 border-rose-500 text-rose-200 cursor-default'
                             : activeDuel.your_action
                               ? 'bg-stone-800 border-stone-700 text-stone-600 cursor-not-allowed'
                               : 'bg-rose-900/30 border-rose-700/50 text-rose-200 hover:bg-rose-800/50 hover:border-rose-500']">
                  <div class="text-base mb-1">⚡ 凝神</div>
                  <div class="text-[10px] opacity-80">攻击试探 · 突破护盾</div>
                </button>
                <button @click="openActionConfirm('stabilize')"
                  :disabled="!!activeDuel.your_action || actionLoading"
                  :class="['px-4 py-3 rounded-lg font-bold text-sm transition-all border',
                           activeDuel.your_action === 'stabilize'
                             ? 'bg-cyan-900/40 border-cyan-500 text-cyan-200 cursor-default'
                             : activeDuel.your_action
                               ? 'bg-stone-800 border-stone-700 text-stone-600 cursor-not-allowed'
                               : 'bg-cyan-900/30 border-cyan-700/50 text-cyan-200 hover:bg-cyan-800/50 hover:border-cyan-500']">
                  <div class="text-base mb-1">🛡️ 固元</div>
                  <div class="text-[10px] opacity-80">防御恢复 · 反伤对手</div>
                </button>
              </div>

              <!-- 投降按钮 -->
              <div class="mt-4 pt-3 border-t border-stone-800 text-center">
                <button @click="surrenderConfirmShow = true"
                  :disabled="actionLoading"
                  class="text-xs text-stone-500 hover:text-rose-400 transition-colors">
                  认输投降
                </button>
              </div>
            </div>

            <!-- 等待接受提示 -->
            <div v-else-if="activeDuel.status === 'pending'" class="bg-amber-950/30 border border-amber-800/40 rounded-xl p-4 text-center">
              <div class="text-sm text-amber-300 mb-2">挑战已发出，等待对方接受...</div>
              <div v-if="activeDuel.action_deadline" class="text-[10px] text-stone-500">
                接受截止：{{ formatTime(activeDuel.action_deadline) }}
              </div>
            </div>

            <!-- 刷新按钮 -->
            <div class="text-center">
              <button @click="loadActiveDuel" class="text-xs text-stone-500 hover:text-purple-300 transition-colors">
                ↻ 刷新状态
              </button>
            </div>
          </div>
        </div>

        <!-- Tab 2: 发起挑战 -->
        <div v-else-if="activeTab === 'challenge'">
          <div class="max-w-md mx-auto space-y-4">
            <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
              <label class="block text-sm text-stone-300 mb-2">目标玩家 ID</label>
              <input v-model.number="challengeForm.target_player_id" type="number" min="1"
                placeholder="输入对方玩家ID"
                class="w-full px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-stone-100 text-sm focus:border-purple-500 focus:outline-none" />
              <p class="text-[10px] text-stone-500 mt-1">可在排行榜/聊天频道查看对方玩家ID</p>
            </div>

            <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
              <label class="block text-sm text-stone-300 mb-2">赌注类型</label>
              <div class="grid grid-cols-2 gap-2">
                <button @click="challengeForm.bet_type = 'spirit_stone'"
                  :class="['px-3 py-2 rounded-lg text-sm font-bold transition-all border',
                           challengeForm.bet_type === 'spirit_stone'
                             ? 'bg-amber-900/40 border-amber-500 text-amber-200'
                             : 'bg-stone-950 border-stone-700 text-stone-400 hover:border-stone-500']">
                  💰 灵石
                </button>
                <button @click="challengeForm.bet_type = 'divine_sense'"
                  :class="['px-3 py-2 rounded-lg text-sm font-bold transition-all border',
                           challengeForm.bet_type === 'divine_sense'
                             ? 'bg-purple-900/40 border-purple-500 text-purple-200'
                             : 'bg-stone-950 border-stone-700 text-stone-400 hover:border-stone-500']">
                  ✨ 神识
                </button>
              </div>
            </div>

            <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
              <label class="block text-sm text-stone-300 mb-2">赌注数量</label>
              <input v-model.number="challengeForm.bet_amount" type="number" min="1"
                placeholder="输入赌注数量"
                class="w-full px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-stone-100 text-sm focus:border-purple-500 focus:outline-none" />
              <p class="text-[10px] text-stone-500 mt-1">胜者通吃，请谨慎下注</p>
            </div>

            <button @click="openChallengeConfirm"
              :disabled="!canChallenge || challengeLoading"
              class="w-full px-4 py-3 bg-gradient-to-r from-purple-700 to-indigo-700 hover:from-purple-600 hover:to-indigo-600 text-purple-100 rounded-lg font-bold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              {{ challengeLoading ? '发起中...' : '发起挑战' }}
            </button>
          </div>
        </div>

        <!-- Tab 3: 对决历史 -->
        <div v-else-if="activeTab === 'history'">
          <div v-if="historyLoading" class="text-center py-10 text-stone-500">加载中...</div>
          <div v-else-if="!history.length" class="text-center py-10 text-stone-500 text-sm">暂无对决记录</div>
          <div v-else class="space-y-3">
            <div v-for="duel in history" :key="duel.duel_id"
              class="bg-stone-900/50 border border-stone-700/50 rounded-lg p-3">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="text-xs px-2 py-0.5 rounded-full" :class="resultBadgeClass(duel)">
                    {{ resultLabel(duel) }}
                  </span>
                  <span class="text-xs text-stone-500">#{{ duel.duel_id }}</span>
                </div>
                <div class="text-[10px] text-stone-500">{{ formatTime(duel.finished_at || duel.created_at) }}</div>
              </div>
              <div class="grid grid-cols-2 gap-2 text-xs">
                <div class="text-stone-300">
                  <span class="text-stone-500">发起：</span>{{ duel.challenger?.nickname || '未知' }}
                </div>
                <div class="text-stone-300">
                  <span class="text-stone-500">应战：</span>{{ duel.defender?.nickname || '未知' }}
                </div>
              </div>
              <div class="flex items-center justify-between mt-2 text-[11px] text-stone-500">
                <div>第 {{ duel.round_number }} 回合 · {{ settleReasonLabel(duel.settle_reason) }}</div>
                <div>
                  赌注：<span class="text-amber-300">{{ duel.bet_amount }}</span>
                  {{ duel.bet_type === 'spirit_stone' ? '灵石' : '神识' }}
                </div>
              </div>
            </div>

            <!-- 分页 -->
            <div v-if="historyTotal > historyPageSize" class="flex items-center justify-center gap-2 pt-2">
              <button @click="changeHistoryPage(historyPage - 1)" :disabled="historyPage <= 1"
                class="px-3 py-1 text-xs bg-stone-800 border border-stone-700 rounded text-stone-300 hover:border-stone-500 disabled:opacity-30 disabled:cursor-not-allowed">
                上一页
              </button>
              <span class="text-xs text-stone-500">{{ historyPage }} / {{ Math.ceil(historyTotal / historyPageSize) }}</span>
              <button @click="changeHistoryPage(historyPage + 1)" :disabled="historyPage * historyPageSize >= historyTotal"
                class="px-3 py-1 text-xs bg-stone-800 border border-stone-700 rounded text-stone-300 hover:border-stone-500 disabled:opacity-30 disabled:cursor-not-allowed">
                下一页
              </button>
            </div>
          </div>
        </div>

        <!-- Tab 4: 玩法说明 -->
        <div v-else-if="activeTab === 'guide'" class="space-y-4 text-sm text-stone-300">
          <div class="bg-purple-950/20 border border-purple-900/40 rounded-xl p-4">
            <h3 class="text-purple-200 font-bold mb-2">⚡ 玩法简介</h3>
            <p class="text-xs text-stone-400 leading-relaxed">神识对决是 1v1 同时选择博弈 PvP。双方同时选择「凝神」或「固元」，互不知晓对方选择，结算后造成对应效果。先使对方护盾归零者胜，或在回合上限（默认10回合）后按护盾多寡判定。</p>
          </div>

          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-rose-200 font-bold mb-3">⚔️ 行动效果矩阵</h3>
            <div class="space-y-2 text-xs">
              <div class="flex items-start gap-2">
                <span class="text-rose-300 font-bold shrink-0">凝神 vs 固元</span>
                <span class="text-stone-400">凝神方 dominant，造成 30 点伤害（固元方减伤至 15）</span>
              </div>
              <div class="flex items-start gap-2">
                <span class="text-amber-300 font-bold shrink-0">凝神 vs 凝神</span>
                <span class="text-stone-400">双方互相试探，各造成 20 点伤害</span>
              </div>
              <div class="flex items-start gap-2">
                <span class="text-emerald-300 font-bold shrink-0">固元 vs 固元</span>
                <span class="text-stone-400">双方和平互守，各恢复 10 点护盾</span>
              </div>
              <div class="flex items-start gap-2">
                <span class="text-cyan-300 font-bold shrink-0">固元 vs 凝神</span>
                <span class="text-stone-400">固元方承受 30 点伤害（被克制）</span>
              </div>
            </div>
          </div>

          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-amber-200 font-bold mb-3">💰 赌注机制</h3>
            <ul class="text-xs text-stone-400 space-y-1 list-disc list-inside">
              <li>赌注类型：灵石 或 神识</li>
              <li>胜者通吃：胜方获得全部赌注，败方失去赌注</li>
              <li>平局返还：双方各自返还赌注</li>
              <li>投降结算：投降方失去全部赌注，对手获得</li>
            </ul>
          </div>

          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-cyan-200 font-bold mb-3">⏱️ 超时机制</h3>
            <ul class="text-xs text-stone-400 space-y-1 list-disc list-inside">
              <li>挑战发出后对方需在限定时间内接受，超时自动取消</li>
              <li>每回合行动有截止时间，超时自动选择「固元」</li>
              <li>建议在双方都活跃时进行对决</li>
            </ul>
          </div>

          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-purple-200 font-bold mb-3">🎯 策略提示</h3>
            <ul class="text-xs text-stone-400 space-y-1 list-disc list-inside">
              <li>凝神是主动攻击，但被固元克制时效果减半</li>
              <li>固元是稳妥防御，但被凝神命中承受高额伤害</li>
              <li>残血时固元可恢复护盾，但若对手凝神则雪上加霜</li>
              <li>心理博弈：观察对手行动模式，预判其下一步</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- ===== Modal: 挑战确认 ===== -->
      <Modal :isOpen="challengeConfirmShow" title="确认发起挑战" width="460px" @close="challengeConfirmShow = false">
        <div class="space-y-3 text-sm">
          <div class="bg-stone-900/50 rounded-lg p-3 space-y-2">
            <div class="flex justify-between"><span class="text-stone-400">目标玩家ID：</span><span class="text-stone-100 font-bold">{{ challengeForm.target_player_id }}</span></div>
            <div class="flex justify-between"><span class="text-stone-400">赌注类型：</span><span class="text-stone-100 font-bold">{{ challengeForm.bet_type === 'spirit_stone' ? '灵石' : '神识' }}</span></div>
            <div class="flex justify-between"><span class="text-stone-400">赌注数量：</span><span class="text-amber-300 font-bold">{{ challengeForm.bet_amount }}</span></div>
          </div>
          <div class="text-xs text-rose-300 bg-rose-950/30 border border-rose-900/40 rounded p-2">
            ⚠️ 高风险操作：对方接受后即开始对决，败者将失去赌注。
          </div>
        </div>
        <div class="flex gap-3 mt-4">
          <button @click="challengeConfirmShow = false" class="flex-1 px-4 py-2 bg-stone-800 hover:bg-stone-700 text-stone-300 rounded-lg text-sm font-bold transition-colors">取消</button>
          <button @click="executeChallenge" :disabled="challengeLoading" class="flex-1 px-4 py-2 bg-purple-700 hover:bg-purple-600 text-purple-100 rounded-lg text-sm font-bold transition-colors disabled:opacity-50">
            {{ challengeLoading ? '处理中...' : '确认发起' }}
          </button>
        </div>
      </Modal>

      <!-- ===== Modal: 行动确认 ===== -->
      <Modal :isOpen="actionConfirmShow" :title="`确认${pendingAction === 'focus' ? '凝神' : '固元'}`" width="420px" @close="actionConfirmShow = false">
        <div class="space-y-3 text-sm">
          <p class="text-stone-300">即将执行「{{ pendingAction === 'focus' ? '凝神' : '固元' }}」行动：</p>
          <div v-if="pendingAction === 'focus'" class="text-xs text-rose-300 bg-rose-950/30 border border-rose-900/40 rounded p-2">
            ⚡ 凝神：主动攻击，若对手固元则造成 30 伤害，对手凝神则双方互伤 20
          </div>
          <div v-else class="text-xs text-cyan-300 bg-cyan-950/30 border border-cyan-900/40 rounded p-2">
            🛡️ 固元：防御恢复，若对手固元则双方各回 10 护盾，对手凝神则承受 30 伤害
          </div>
          <p class="text-[11px] text-stone-500">提交后无法更改，需等待对手行动或回合结算</p>
        </div>
        <div class="flex gap-3 mt-4">
          <button @click="actionConfirmShow = false" class="flex-1 px-4 py-2 bg-stone-800 hover:bg-stone-700 text-stone-300 rounded-lg text-sm font-bold transition-colors">取消</button>
          <button @click="executeAction" :disabled="actionLoading" class="flex-1 px-4 py-2 bg-purple-700 hover:bg-purple-600 text-purple-100 rounded-lg text-sm font-bold transition-colors disabled:opacity-50">
            {{ actionLoading ? '提交中...' : '确认行动' }}
          </button>
        </div>
      </Modal>

      <!-- ===== Modal: 行动结果 ===== -->
      <Modal :isOpen="actionResultShow" title="回合结算" width="520px" @close="actionResultShow = false">
        <div v-if="lastActionResult" class="space-y-3 text-sm">
          <!-- 结算信息 -->
          <div class="bg-stone-900/50 rounded-lg p-3">
            <div class="text-center text-xs text-stone-500 mb-2">第 {{ lastActionResult.round_number }} 回合</div>
            <div class="grid grid-cols-2 gap-3">
              <div class="text-center">
                <div class="text-[10px] text-stone-500">发起方行动</div>
                <div class="text-base font-bold" :class="lastActionResult.challenger_action === 'focus' ? 'text-rose-300' : 'text-cyan-300'">
                  {{ actionLabel(lastActionResult.challenger_action) }}
                </div>
              </div>
              <div class="text-center">
                <div class="text-[10px] text-stone-500">应战方行动</div>
                <div class="text-base font-bold" :class="lastActionResult.defender_action === 'focus' ? 'text-rose-300' : 'text-cyan-300'">
                  {{ actionLabel(lastActionResult.defender_action) }}
                </div>
              </div>
            </div>
          </div>

          <!-- 护盾变化 -->
          <div class="bg-stone-900/50 rounded-lg p-3 space-y-2">
            <div class="flex justify-between text-xs">
              <span class="text-stone-400">发起方护盾变化：</span>
              <span :class="lastActionResult.challenger_shield_change >= 0 ? 'text-emerald-300' : 'text-rose-300'">
                {{ lastActionResult.challenger_shield_change >= 0 ? '+' : '' }}{{ lastActionResult.challenger_shield_change }} → {{ lastActionResult.challenger_shield }}
              </span>
            </div>
            <div class="flex justify-between text-xs">
              <span class="text-stone-400">应战方护盾变化：</span>
              <span :class="lastActionResult.defender_shield_change >= 0 ? 'text-emerald-300' : 'text-rose-300'">
                {{ lastActionResult.defender_shield_change >= 0 ? '+' : '' }}{{ lastActionResult.defender_shield_change }} → {{ lastActionResult.defender_shield }}
              </span>
            </div>
          </div>

          <!-- 对局结果 -->
          <div v-if="lastActionResult.duel_finished" class="bg-amber-950/30 border border-amber-800/40 rounded-lg p-3 text-center">
            <div class="text-amber-300 font-bold">⚡ 对局结束</div>
            <div class="text-xs text-stone-400 mt-1">{{ settleReasonLabel(lastActionResult.settle_reason) }}</div>
            <div v-if="lastActionResult.bet_settlement" class="text-xs text-amber-300 mt-2">
              赌注结算：胜方 +{{ lastActionResult.bet_settlement.winner_gain }} / 败方 -{{ lastActionResult.bet_settlement.loser_loss }}
            </div>
          </div>
          <div v-else class="text-center text-xs text-stone-500">
            进入第 {{ lastActionResult.next_round }} 回合
          </div>
        </div>
        <div class="mt-4">
          <button @click="actionResultShow = false" class="w-full px-4 py-2 bg-purple-700 hover:bg-purple-600 text-purple-100 rounded-lg text-sm font-bold transition-colors">确认</button>
        </div>
      </Modal>

      <!-- ===== Modal: 投降确认 ===== -->
      <Modal :isOpen="surrenderConfirmShow" title="投降确认" width="420px" @close="surrenderConfirmShow = false">
        <div class="space-y-3 text-sm">
          <p class="text-rose-300">⚠️ 投降将立即结束对局，你将失去全部赌注，对手获得赌注。</p>
          <p class="text-[11px] text-stone-500">建议在护盾明显劣势且无翻盘可能时使用。</p>
        </div>
        <div class="flex gap-3 mt-4">
          <button @click="surrenderConfirmShow = false" class="flex-1 px-4 py-2 bg-stone-800 hover:bg-stone-700 text-stone-300 rounded-lg text-sm font-bold transition-colors">取消</button>
          <button @click="executeSurrender" :disabled="actionLoading" class="flex-1 px-4 py-2 bg-rose-700 hover:bg-rose-600 text-rose-100 rounded-lg text-sm font-bold transition-colors disabled:opacity-50">
            {{ actionLoading ? '处理中...' : '确认投降' }}
          </button>
        </div>
      </Modal>
    </div>
  </div>
</template>

<script setup>
/**
 * 神识对决面板逻辑
 *
 * 设计原则：后端计算，前端只渲染与接口调用
 *  - 不在前端计算行动效果/护盾变化/胜负判定，全部以后端返回为准
 *  - 状态变更后调用 loadActiveDuel 刷新权威数据
 *  - 所有操作均通过自定义 Modal 二次确认
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Modal from '../common/Modal.vue'
import { useUIStore } from '../../stores/ui'
import {
  challengeDuel,
  acceptDuel,
  performDuelAction,
  getActiveDuel,
  getDuelHistory,
  surrenderDuel
} from '../../api/divineSenseDuel'

// 运行时声明 emit（项目 <script setup> 未启用 lang="ts"，不可使用 TS 泛型语法）
const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ===== Tab 管理 =====
const tabs = [
  { id: 'active', name: '当前对决' },
  { id: 'challenge', name: '发起挑战' },
  { id: 'history', name: '对决历史' },
  { id: 'guide', name: '玩法说明' }
]
const activeTab = ref('active')

// ===== 当前对决状态 =====
const activeDuel = ref(null)
const loadingActive = ref(false)

// ===== 发起挑战表单 =====
const challengeForm = ref({
  target_player_id: null,
  bet_type: 'spirit_stone',
  bet_amount: 100
})
const challengeLoading = ref(false)
const challengeConfirmShow = ref(false)

// ===== 行动相关 =====
const pendingAction = ref(null) // 'focus' | 'stabilize'
const actionConfirmShow = ref(false)
const actionLoading = ref(false)
const actionResultShow = ref(false)
const lastActionResult = ref(null)

// ===== 投降 =====
const surrenderConfirmShow = ref(false)

// ===== 历史记录 =====
const history = ref([])
const historyLoading = ref(false)
const historyPage = ref(1)
const historyPageSize = 10
const historyTotal = ref(0)

// ===== 自动刷新定时器 =====
let refreshTimer = null

// ===== 计算属性 =====
const canChallenge = computed(() => {
  const f = challengeForm.value
  return Number.isInteger(f.target_player_id) && f.target_player_id > 0
    && (f.bet_type === 'spirit_stone' || f.bet_type === 'divine_sense')
    && Number.isInteger(f.bet_amount) && f.bet_amount > 0
})

// ===== 工具方法 =====
/** 状态徽章 class */
function statusBadgeClass(status) {
  const map = {
    pending: 'bg-amber-900/40 text-amber-300',
    ongoing: 'bg-emerald-900/40 text-emerald-300',
    finished: 'bg-stone-700 text-stone-300',
    cancelled: 'bg-stone-700 text-stone-400',
    expired: 'bg-stone-700 text-stone-400'
  }
  return map[status] || 'bg-stone-700 text-stone-300'
}
function statusLabel(status) {
  const map = { pending: '待接受', ongoing: '进行中', finished: '已结束', cancelled: '已取消', expired: '已过期' }
  return map[status] || status
}
/** 行动中文名 */
function actionLabel(action) {
  return action === 'focus' ? '凝神' : action === 'stabilize' ? '固元' : '未知'
}
/** 护盾值颜色 */
function shieldColorClass(shield) {
  if (shield <= 0) return 'text-rose-400'
  if (shield < 30) return 'text-amber-400'
  return 'text-emerald-400'
}
/** 历史结果徽章 class */
function resultBadgeClass(duel) {
  if (duel.is_draw) return 'bg-stone-700 text-stone-300'
  return duel.is_winner ? 'bg-emerald-900/40 text-emerald-300' : 'bg-rose-900/40 text-rose-300'
}
function resultLabel(duel) {
  if (duel.status !== 'finished') return statusLabel(duel.status)
  if (duel.is_draw) return '平局'
  return duel.is_winner ? '胜利' : '失败'
}
function settleReasonLabel(reason) {
  const map = {
    shield_zero: '护盾归零',
    rounds_limit: '回合上限',
    surrender: '投降',
    timeout: '超时',
    cancel: '取消'
  }
  return map[reason] || reason || '未知'
}
function formatTime(isoStr) {
  if (!isoStr) return '-'
  try {
    const d = new Date(isoStr)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return isoStr
  }
}

// ===== 业务方法 =====
/** 切换 Tab，按需加载数据 */
function switchTab(tabId) {
  activeTab.value = tabId
  if (tabId === 'active') loadActiveDuel()
  else if (tabId === 'history') loadHistory()
}

/** 加载当前进行中的对决 */
async function loadActiveDuel() {
  loadingActive.value = true
  try {
    const res = await getActiveDuel()
    const payload = res.data
    if (payload.code === 200) {
      activeDuel.value = payload.data
    } else {
      uiStore.showToast(payload.message || '查询对决状态失败', 'warning')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '查询对决状态失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loadingActive.value = false
  }
}

/** 打开发起挑战确认弹窗 */
function openChallengeConfirm() {
  if (!canChallenge.value) {
    uiStore.showToast('请填写完整的挑战参数', 'warning')
    return
  }
  challengeConfirmShow.value = true
}

/** 执行发起挑战 */
async function executeChallenge() {
  challengeLoading.value = true
  try {
    const f = challengeForm.value
    const res = await challengeDuel(f.target_player_id, f.bet_type, f.bet_amount)
    const payload = res.data
    challengeConfirmShow.value = false
    if (payload.code === 200 && payload.data) {
      uiStore.showToast('挑战已发出，等待对方接受', 'success')
      activeTab.value = 'active'
      await loadActiveDuel()
    } else {
      uiStore.showToast(payload.message || '发起挑战失败', 'error')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '发起挑战失败'
    uiStore.showToast(msg, 'error')
  } finally {
    challengeLoading.value = false
  }
}

/** 打开行动确认弹窗 */
function openActionConfirm(action) {
  if (!activeDuel.value || activeDuel.value.your_action) return
  pendingAction.value = action
  actionConfirmShow.value = true
}

/** 执行行动 */
async function executeAction() {
  if (!pendingAction.value || !activeDuel.value) return
  actionLoading.value = true
  try {
    const res = await performDuelAction(activeDuel.value.duel_id, pendingAction.value)
    const payload = res.data
    actionConfirmShow.value = false
    if (payload.code === 200 && payload.data) {
      const data = payload.data
      if (data.waiting_opponent) {
        uiStore.showToast(`已选择${actionLabel(data.your_action)}，等待对手行动`, 'success')
      } else {
        // 已结算，展示结果
        lastActionResult.value = data
        actionResultShow.value = true
      }
      await loadActiveDuel()
    } else {
      uiStore.showToast(payload.message || '行动失败', 'error')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '行动失败'
    uiStore.showToast(msg, 'error')
  } finally {
    actionLoading.value = false
    pendingAction.value = null
  }
}

/** 执行投降 */
async function executeSurrender() {
  if (!activeDuel.value) return
  actionLoading.value = true
  try {
    const res = await surrenderDuel(activeDuel.value.duel_id)
    const payload = res.data
    surrenderConfirmShow.value = false
    if (payload.code === 200) {
      uiStore.showToast('已投降，对局结束', 'warning')
      await loadActiveDuel()
    } else {
      uiStore.showToast(payload.message || '投降失败', 'error')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '投降失败'
    uiStore.showToast(msg, 'error')
  } finally {
    actionLoading.value = false
  }
}

/** 加载历史记录 */
async function loadHistory() {
  historyLoading.value = true
  try {
    const res = await getDuelHistory(historyPage.value, historyPageSize)
    const payload = res.data
    if (payload.code === 200 && payload.data) {
      history.value = payload.data.duels || []
      historyTotal.value = payload.data.total || 0
    } else {
      uiStore.showToast(payload.message || '加载历史失败', 'warning')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '加载历史失败'
    uiStore.showToast(msg, 'error')
  } finally {
    historyLoading.value = false
  }
}

/** 翻页 */
function changeHistoryPage(newPage) {
  if (newPage < 1 || newPage * historyPageSize >= historyTotal.value + historyPageSize) return
  historyPage.value = newPage
  loadHistory()
}

// ===== 生命周期 =====
onMounted(() => {
  loadActiveDuel()
  // 每 10 秒自动刷新当前对决状态（避免错过对手行动）
  refreshTimer = setInterval(() => {
    if (activeTab.value === 'active' && activeDuel.value && activeDuel.value.status === 'ongoing') {
      loadActiveDuel()
    }
  }, 10000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>
