/**
 * 道侣/双修系统面板组件
 *
 * 道侣/双修系统重做版（玩家间 1v1 长期社交玩法）前端 UI
 *
 * Tab 划分：
 *   1. 道侣关系：当前道侣状态、求婚、响应求婚、解除道侣
 *   2. 双修互动：道侣互动（每日问安）、闭关双修、凝聚心印
 *   3. 心劫：待处理心劫事件、3 选项抉择（信任/怀疑/考验）
 *
 * 设计原则：
 *   - 所有状态从后端 GET /dao-companion/my 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格与 CompanionPanel.vue 一致（修仙古风：#1c1917 / #292524 / rose-300 / amber-300）
 *   - 使用 Tailwind CSS 工具类
 *
 * 与 CompanionPanel.vue 区别：
 *   - 旧 CompanionPanel 调用 /api/companion（批次3 寻侣/双修/温养/采补/立誓/心契/心劫）
 *   - 新 DaoCompanionPanel 调用 /api/dao-companion（重做版 求婚/响应/互动/双修/心劫/心印）
 *   - 新系统含亲密度 0-100 进度条、心契等级 0-9、心印数量、双修加成比例显示
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-rose-900/40 rounded-lg p-6 max-w-5xl w-full mx-4 shadow-2xl animate-fade-in max-h-[90vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-rose-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          道侣 · 同修大道
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
          :class="activeTab === tab.id ? 'text-rose-300' : 'text-stone-500 hover:text-stone-300'">
          {{ tab.name }}
          <div v-if="activeTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-rose-400"></div>
        </button>
      </div>

      <!-- 加载中状态 -->
      <div v-if="loading.my && !myData" class="flex-1 flex items-center justify-center">
        <div class="text-stone-500 text-sm">正在凝神查阅道侣录...</div>
      </div>

      <!-- 内容滚动区 -->
      <div v-else class="flex-1 overflow-y-auto pr-1">

        <!-- ============ Tab 1: 道侣关系 ============ -->
        <div v-show="activeTab === 'relation'" class="space-y-3">
          <!-- 无道侣 -->
          <section v-if="!myData?.has_companion" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="text-sm font-bold text-rose-300 mb-3">寻觅道侣</div>
            <div class="text-xs text-stone-400 space-y-1 mb-4">
              <div>· 道侣同行，双修互补，亲密度越高加成越强</div>
              <div>· 亲密度 ≥ 50 有几率触发心劫，抉择之间见真性情</div>
              <div>· 亲密度 ≥ 80 可凝聚心印，每 3 个心印提升 1 级心契</div>
              <div>· 心契 0-9 级，每级提升双修加成 5%</div>
              <div v-if="myData?.min_realm_name" class="text-amber-300 mt-2">
                · 最低境界要求：{{ myData.min_realm_name }}（rank {{ myData.min_realm_rank }}）
                <span v-if="myData.can_propose" class="text-emerald-300 ml-1">✓ 已满足</span>
                <span v-else class="text-rose-400 ml-1">✗ 未满足</span>
              </div>
            </div>
            <!-- 求婚输入框 -->
            <div class="flex items-center gap-2">
              <input v-model.number="proposeTargetId" type="number" min="1" placeholder="对方玩家 ID（数字）"
                class="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-rose-500 focus:outline-none" />
              <button @click="handlePropose"
                :disabled="loading.action || !proposeTargetId || !myData?.can_propose"
                class="px-4 py-2 rounded text-xs font-bold bg-rose-700 text-rose-100 hover:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed">
                发起求婚
              </button>
            </div>
            <div v-if="!myData?.can_propose" class="text-[11px] text-rose-400 mt-2">
              境界不足，无法求婚
            </div>
          </section>

          <!-- 已有道侣 -->
          <section v-else class="bg-[#292524] border border-rose-900/40 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <div class="text-sm font-bold text-rose-300">已结道侣</div>
                <div class="text-[11px] text-stone-500">结侣时间：{{ formatTime(myData.created_at) }}</div>
              </div>
              <button @click="handleBreak"
                :disabled="loading.action"
                class="px-3 py-1.5 rounded text-[11px] bg-rose-900/50 border border-rose-800 text-rose-300 hover:bg-rose-900 disabled:opacity-50">
                解除道侣
              </button>
            </div>

            <!-- 道侣信息卡 -->
            <div class="bg-stone-900/50 border border-stone-700 rounded p-3">
              <div class="flex items-center gap-3 mb-2">
                <div class="w-10 h-10 rounded bg-rose-900/40 border border-rose-700 flex items-center justify-center text-rose-300 font-bold">
                  {{ myData.partner?.nickname?.charAt(0) || '?' }}
                </div>
                <div class="flex-1">
                  <div class="text-rose-300 font-bold text-sm">{{ myData.partner?.nickname || '未知道侣' }}</div>
                  <div class="text-[11px] text-stone-500">
                    ID: {{ myData.partner?.id }} · 境界：{{ myData.partner?.realm }} ·
                    <span :class="myData.partner?.is_online ? 'text-emerald-300' : 'text-stone-500'">
                      {{ myData.partner?.is_online ? '在线' : '离线' }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- 亲密度进度条 -->
              <div class="mb-2">
                <div class="flex justify-between text-[11px] mb-1">
                  <span class="text-stone-400">亲密度</span>
                  <span class="text-rose-300">{{ myData.intimacy }}/100</span>
                </div>
                <div class="h-1.5 bg-stone-800 rounded overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-rose-700 to-rose-400" :style="{ width: (myData.intimacy || 0) + '%' }"></div>
                </div>
              </div>

              <!-- 心契、心印、双修次数 -->
              <div class="grid grid-cols-3 gap-2 text-[11px] text-stone-300">
                <div class="bg-stone-800/40 rounded px-2 py-1">
                  <div class="text-stone-500">心契等级</div>
                  <div class="text-amber-300 font-bold">
                    {{ myData.heart_contract_level }}/{{ myData.settings?.max_heart_contract_level || 9 }}
                  </div>
                </div>
                <div class="bg-stone-800/40 rounded px-2 py-1">
                  <div class="text-stone-500">心印数量</div>
                  <div class="text-pink-300 font-bold">{{ myData.heart_imprint_count }}</div>
                </div>
                <div class="bg-stone-800/40 rounded px-2 py-1">
                  <div class="text-stone-500">双修次数</div>
                  <div class="text-cyan-300 font-bold">{{ myData.dual_cultivation_count }}</div>
                </div>
              </div>

              <!-- 双修加成比例 -->
              <div class="mt-2 text-[11px] text-emerald-300">
                当前双修加成：×{{ (myData.dual_cultivation_bonus_rate || 1.5).toFixed(3) }}
                <span class="text-stone-500 ml-1">（含亲密度/心契加成）</span>
              </div>
            </div>
          </section>

          <!-- 我收到的求婚列表 -->
          <section v-if="proposalsData && proposalsData.proposals.length > 0" class="bg-[#292524] border border-amber-900/40 rounded-lg p-4">
            <div class="text-sm font-bold text-amber-300 mb-2 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
              待您回应的求婚（{{ proposalsData.count }}/{{ proposalsData.max_pending }}）
            </div>
            <div class="space-y-2">
              <div v-for="p in proposalsData.proposals" :key="p.proposal_id"
                class="bg-stone-900/50 border border-stone-700 rounded p-3 text-xs flex items-center justify-between">
                <div>
                  <div class="text-rose-300 font-bold">{{ p.from_player?.nickname || '未知玩家' }}</div>
                  <div class="text-stone-500 text-[11px]">
                    ID: {{ p.from_player?.id }} · 境界：{{ p.from_player?.realm }} · 求婚时间：{{ formatTime(p.created_at) }}
                  </div>
                </div>
                <div class="flex gap-1">
                  <button @click="handleRespond(p.proposal_id, 'accept')"
                    :disabled="loading.action"
                    class="px-3 py-1.5 rounded bg-emerald-700 text-emerald-100 hover:bg-emerald-600 disabled:opacity-50">
                    接受
                  </button>
                  <button @click="handleRespond(p.proposal_id, 'refuse')"
                    :disabled="loading.action"
                    class="px-3 py-1.5 rounded bg-stone-700 text-stone-300 hover:bg-stone-600 disabled:opacity-50">
                    拒绝
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- ============ Tab 2: 双修互动 ============ -->
        <div v-show="activeTab === 'interact'" class="space-y-3">
          <div v-if="!myData?.has_companion" class="text-center py-8 text-stone-500 text-sm">
            尚未结侣，无法双修互动
          </div>
          <template v-else>
            <!-- 道侣互动 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <div>
                  <div class="text-sm font-bold text-rose-300">每日问安（道侣互动）</div>
                  <div class="text-[11px] text-stone-500">24 小时冷却，亲密度 +2，双方各获得少量修为</div>
                </div>
                <button @click="handleInteract"
                  :disabled="loading.action || (myData.interact_cooldown_remaining ?? 0) > 0"
                  class="px-4 py-2 rounded text-xs font-bold bg-rose-700 text-rose-100 hover:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed">
                  {{ (myData.interact_cooldown_remaining ?? 0) > 0 ? `冷却 ${formatCooldown(myData.interact_cooldown_remaining!)}` : '问安互动' }}
                </button>
              </div>
            </section>

            <!-- 闭关双修 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <div>
                  <div class="text-sm font-bold text-rose-300">闭关双修</div>
                  <div class="text-[11px] text-stone-500">
                    24 小时冷却，双方在线，亲密度 +5，修为按加成比例 × 持续时间结算
                  </div>
                </div>
                <button @click="handleDualCultivate"
                  :disabled="loading.action || (myData.dual_cultivation_cooldown_remaining ?? 0) > 0 || !myData.partner?.is_online"
                  class="px-4 py-2 rounded text-xs font-bold bg-rose-700 text-rose-100 hover:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed">
                  {{ (myData.dual_cultivation_cooldown_remaining ?? 0) > 0
                      ? `冷却 ${formatCooldown(myData.dual_cultivation_cooldown_remaining!)}`
                      : (!myData.partner?.is_online ? '道侣离线' : '开启双修') }}
                </button>
              </div>
            </section>

            <!-- 凝聚心印 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <div>
                  <div class="text-sm font-bold text-pink-300">凝聚心印</div>
                  <div class="text-[11px] text-stone-500">
                    亲密度 ≥ {{ myData.settings?.min_intimacy_for_heart_imprint || 80 }} 时可凝聚，消耗双方各 {{ myData.settings?.heart_imprint_exp_cost || 1000 }} 修为
                  </div>
                  <div class="text-[11px] text-stone-500 mt-0.5">
                    每 {{ myData.settings?.heart_imprint_count_per_level || 3 }} 个心印提升 1 级心契（上限 {{ myData.settings?.max_heart_contract_level || 9 }} 级）
                  </div>
                </div>
                <button @click="handleCondenseImprint"
                  :disabled="loading.action || (myData.intimacy ?? 0) < (myData.settings?.min_intimacy_for_heart_imprint || 80) || (myData.heart_contract_level ?? 0) >= (myData.settings?.max_heart_contract_level || 9)"
                  class="px-4 py-2 rounded text-xs font-bold bg-pink-700 text-pink-100 hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed">
                  凝聚心印
                </button>
              </div>
              <!-- 当前心印进度 -->
              <div class="mt-2 text-[11px] text-stone-400">
                当前心印：{{ myData.heart_imprint_count }} 个，距下次升级还差
                <span class="text-pink-300 font-bold">{{ (myData.settings?.heart_imprint_count_per_level || 3) - ((myData.heart_imprint_count ?? 0) % (myData.settings?.heart_imprint_count_per_level || 3)) }}</span> 个
              </div>
            </section>
          </template>
        </div>

        <!-- ============ Tab 3: 心劫 ============ -->
        <div v-show="activeTab === 'tribulation'" class="space-y-3">
          <div v-if="loading.tribulation" class="text-center py-8 text-stone-500 text-sm">正在查阅心劫录...</div>
          <template v-else-if="tribulationData?.has_pending && tribulationData.pending_event">
            <section class="bg-[#292524] border border-rose-700/50 rounded-lg p-4">
              <div class="flex items-center justify-between mb-3">
                <div>
                  <div class="text-sm font-bold text-rose-300">心劫降临</div>
                  <div class="text-[11px] text-stone-500">
                    触发时间：{{ formatTime(tribulationData.pending_event.created_at) }} ·
                    过期时间：{{ formatTime(tribulationData.pending_event.expires_at) }}
                  </div>
                </div>
                <div class="text-[11px] text-amber-300">超时视为怀疑</div>
              </div>

              <!-- 心劫背景描述 -->
              <div class="bg-stone-900/50 border border-stone-700 rounded p-3 mb-3 text-xs text-stone-300">
                <div class="text-amber-300 font-bold mb-1">心劫事件 #{{ tribulationData.pending_event.event_id }}</div>
                <div>道侣之间生出心魔，必须在限时内做出抉择，否则亲密度与心契等级将受重创。</div>
              </div>

              <!-- 3 个选项 -->
              <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
                <button v-for="opt in tribulationData.pending_event.options" :key="opt.option"
                  @click="handleTribulationRespond(tribulationData.pending_event!.event_id, opt.option)"
                  :disabled="loading.action"
                  class="bg-stone-900/50 border border-stone-700 rounded p-3 text-xs text-left hover:bg-stone-800/60 hover:border-rose-700/50 disabled:opacity-50">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-amber-300 font-bold">{{ opt.name }}</span>
                    <span class="text-[10px] text-emerald-300">成功率 {{ Math.floor(opt.success_rate * 100) }}%</span>
                  </div>
                  <div class="text-stone-500 text-[11px] space-y-0.5">
                    <div>· 亲密度：{{ opt.intimacy_gain >= 0 ? '+' : '' }}{{ opt.intimacy_gain }}</div>
                    <div v-if="opt.description">· {{ opt.description }}</div>
                  </div>
                </button>
              </div>
            </section>
          </template>
          <div v-else class="text-center py-12 text-stone-500 text-sm">
            <div class="mb-2">当前无心劫事件</div>
            <div class="text-[11px] text-stone-600">亲密度 ≥ {{ myData?.settings?.min_intimacy_for_heart_tribulation || 50 }} 时，互动/双修有概率触发心劫</div>
          </div>
        </div>

        <!-- ============ Tab 4: 护道 ============ -->
        <div v-show="activeTab === 'protect'" class="space-y-3">
          <!-- 护道机制说明 -->
          <section class="bg-[#292524] border border-amber-900/40 rounded-lg p-3">
            <div class="text-xs text-amber-300 font-bold mb-1">护道机制</div>
            <div class="text-[11px] text-stone-400 leading-relaxed">
              心契等级 ≥ 2 时，道侣被攻击时有概率分担伤害并反击攻击方。<br/>
              触发概率随心契等级提升（L2=10% / L5=25% / L9=30%），同一对道侣冷却 1 小时。
            </div>
          </section>

          <!-- 护道统计卡 -->
          <section v-if="protectStatsData" class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <!-- 被护道方统计 -->
            <div class="bg-[#292524] border border-rose-900/40 rounded-lg p-3">
              <div class="text-xs font-bold text-rose-300 mb-2">道侣护我（作为被护道方）</div>
              <div class="grid grid-cols-3 gap-2 text-center">
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-[10px] text-stone-500">总次数</div>
                  <div class="text-base font-bold text-rose-300">{{ protectStatsData.as_defender.total_count }}</div>
                </div>
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-[10px] text-stone-500">累计分担</div>
                  <div class="text-xs font-bold text-amber-300">{{ formatBigInt(protectStatsData.as_defender.total_shared_damage) }}</div>
                </div>
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-[10px] text-stone-500">累计反击</div>
                  <div class="text-xs font-bold text-emerald-300">{{ formatBigInt(protectStatsData.as_defender.total_counter_damage) }}</div>
                </div>
              </div>
              <div v-if="protectStatsData.as_defender.last_protect_time" class="text-[10px] text-stone-600 mt-2">
                最后：{{ formatTime(protectStatsData.as_defender.last_protect_time) }}
              </div>
            </div>

            <!-- 护道方统计 -->
            <div class="bg-[#292524] border border-emerald-900/40 rounded-lg p-3">
              <div class="text-xs font-bold text-emerald-300 mb-2">我护道侣（作为护道方）</div>
              <div class="grid grid-cols-3 gap-2 text-center">
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-[10px] text-stone-500">总次数</div>
                  <div class="text-base font-bold text-emerald-300">{{ protectStatsData.as_protector.total_count }}</div>
                </div>
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-[10px] text-stone-500">累计分担</div>
                  <div class="text-xs font-bold text-amber-300">{{ formatBigInt(protectStatsData.as_protector.total_shared_damage) }}</div>
                </div>
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-[10px] text-stone-500">累计反击</div>
                  <div class="text-xs font-bold text-cyan-300">{{ formatBigInt(protectStatsData.as_protector.total_counter_damage) }}</div>
                </div>
              </div>
              <div v-if="protectStatsData.as_protector.last_protect_time" class="text-[10px] text-stone-600 mt-2">
                最后：{{ formatTime(protectStatsData.as_protector.last_protect_time) }}
              </div>
            </div>
          </section>

          <!-- 角色过滤与刷新 -->
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-1">
              <button v-for="r in [
                { v: 'all', n: '全部' },
                { v: 'defender', n: '被护道' },
                { v: 'protector', n: '护道他人' }
              ]" :key="r.v"
                @click="switchProtectRole(r.v as 'all' | 'defender' | 'protector')"
                :class="protectRole === r.v
                  ? 'bg-rose-900/50 border-rose-700/50 text-rose-300'
                  : 'bg-stone-900/50 border-stone-700 text-stone-400 hover:text-stone-200'"
                class="px-3 py-1 rounded text-[11px] border transition-colors">
                {{ r.n }}
              </button>
            </div>
            <button @click="loadProtectLogs" :disabled="loading.protect"
              class="text-[11px] text-stone-400 hover:text-rose-300 disabled:opacity-50">
              {{ loading.protect ? '加载中...' : '刷新日志' }}
            </button>
          </div>

          <!-- 护道日志列表 -->
          <div v-if="loading.protect && !protectLogsData" class="text-center py-8 text-stone-500 text-sm">
            正在查阅护道录...
          </div>
          <div v-else-if="protectLogsData && protectLogsData.logs.length > 0" class="space-y-2">
            <div v-for="log in protectLogsData.logs" :key="log.id"
              class="bg-stone-900/50 border border-stone-700 rounded p-3 text-xs">
              <!-- 头部：时间 + 战斗类型 -->
              <div class="flex items-center justify-between mb-2">
                <div class="text-stone-400">
                  <span class="text-rose-300">#{{ log.id }}</span>
                  <span class="mx-1">·</span>
                  <span>{{ getBattleTypeName(log.battle_type) }}</span>
                  <span v-if="log.battle_round" class="ml-1 text-stone-600">第{{ log.battle_round }}回合</span>
                </div>
                <div class="text-[10px] text-stone-500">{{ formatTime(log.created_at) }}</div>
              </div>

              <!-- 三方玩家ID -->
              <div class="grid grid-cols-3 gap-2 mb-2 text-[11px]">
                <div>
                  <span class="text-stone-500">攻击：</span>
                  <span class="text-rose-300">#{{ log.attacker_id }}</span>
                </div>
                <div>
                  <span class="text-stone-500">被护：</span>
                  <span class="text-emerald-300">#{{ log.defender_id }}</span>
                </div>
                <div>
                  <span class="text-stone-500">护道：</span>
                  <span class="text-amber-300">#{{ log.protector_id }}</span>
                </div>
              </div>

              <!-- 伤害明细 -->
              <div class="grid grid-cols-3 gap-2 text-[11px]">
                <div class="bg-stone-800/40 rounded px-2 py-1">
                  <div class="text-stone-500">原始伤害</div>
                  <div class="font-bold text-stone-200">{{ formatBigInt(log.original_damage) }}</div>
                </div>
                <div class="bg-stone-800/40 rounded px-2 py-1">
                  <div class="text-stone-500">分担伤害</div>
                  <div class="font-bold text-amber-300">{{ formatBigInt(log.shared_damage) }}</div>
                </div>
                <div class="bg-stone-800/40 rounded px-2 py-1">
                  <div class="text-stone-500">反击伤害</div>
                  <div class="font-bold text-cyan-300">{{ formatBigInt(log.counter_damage) }}</div>
                </div>
              </div>

              <!-- 心契等级与备注 -->
              <div class="mt-2 flex items-center gap-2 text-[10px]">
                <span class="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-700/30">
                  心契 L{{ log.heart_contract_level }}
                </span>
                <span class="text-stone-500">触发率 {{ Math.floor(log.protect_rate * 100) }}%</span>
                <span v-if="log.remark" class="text-stone-600">· {{ log.remark }}</span>
              </div>
            </div>

            <!-- 翻页 -->
            <div v-if="protectLogsData.total_pages > 1" class="flex items-center justify-between pt-2">
              <button @click="changeProtectPage(-1)" :disabled="protectPage <= 1"
                class="px-3 py-1 text-[11px] rounded bg-stone-800 text-stone-300 hover:bg-stone-700 disabled:opacity-50">
                上一页
              </button>
              <div class="text-[11px] text-stone-400">
                {{ protectPage }} / {{ protectLogsData.total_pages }} 页（共 {{ protectLogsData.total }} 条）
              </div>
              <button @click="changeProtectPage(1)" :disabled="protectPage >= protectLogsData.total_pages"
                class="px-3 py-1 text-[11px] rounded bg-stone-800 text-stone-300 hover:bg-stone-700 disabled:opacity-50">
                下一页
              </button>
            </div>
          </div>
          <div v-else class="text-center py-12 text-stone-500 text-sm">
            <div class="mb-2">暂无护道记录</div>
            <div class="text-[11px] text-stone-600">心契 ≥ 2 且亲密度 ≥ 50 时，PVP 战斗中有概率触发护道</div>
          </div>
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
          class="px-4 py-2 text-xs rounded bg-rose-700 text-rose-100 hover:bg-rose-600 disabled:opacity-50">
          确认
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
/**
 * 道侣/双修系统面板组件脚本
 * 使用 Composition API，所有状态从后端拉取，禁止硬编码业务数据
 */
import { ref, reactive, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import { useUIStore } from '../../stores/ui';
import {
  daoCompanionGetMy,
  daoCompanionGetProposals,
  daoCompanionPropose,
  daoCompanionRespond,
  daoCompanionInteract,
  daoCompanionDualCultivate,
  daoCompanionBreak,
  daoCompanionCondenseHeartImprint,
  daoCompanionGetHeartTribulationStatus,
  daoCompanionRespondHeartTribulation,
  daoCompanionGetProtectLogs,
  daoCompanionGetProtectStats,
  type MyCompanionData,
  type ProposalListData,
  type HeartTribulationStatusData,
  type HeartTribulationOption,
  type ProtectLogsData,
  type ProtectStatsData
} from '../../api/daoCompanion';

const uiStore = useUIStore();

/** Tab 配置 */
const tabs = [
  { id: 'relation', name: '道侣关系' },
  { id: 'interact', name: '双修互动' },
  { id: 'tribulation', name: '心劫' },
  { id: 'protect', name: '护道' }
];
/** 当前激活 Tab */
const activeTab = ref('relation');

/** 各模块加载状态 */
const loading = reactive({
  my: false,
  proposals: false,
  tribulation: false,
  protect: false,
  action: false
});

/** 各模块数据 */
const myData = ref<MyCompanionData | null>(null);
const proposalsData = ref<ProposalListData | null>(null);
const tribulationData = ref<HeartTribulationStatusData | null>(null);
/** 护道日志分页数据 */
const protectLogsData = ref<ProtectLogsData | null>(null);
/** 护道统计数据 */
const protectStatsData = ref<ProtectStatsData | null>(null);
/** 护道日志角色过滤 */
const protectRole = ref<'all' | 'defender' | 'protector'>('all');
/** 护道日志当前页码 */
const protectPage = ref(1);

/** 求婚输入的目标玩家 ID */
const proposeTargetId = ref<number | null>(null);

/** 通用二次确认弹窗 */
const confirmModal = reactive({
  show: false,
  title: '操作确认',
  message: '',
  onConfirm: () => {}
});

/**
 * 组件挂载时加载首个 Tab 数据
 */
onMounted(async () => {
  await loadMyData();
  await loadProposals();
});

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (tabId === 'tribulation' && !tribulationData.value) {
    await loadTribulationStatus();
  }
  if (tabId === 'protect') {
    // 进入护道 Tab 时刷新数据
    await Promise.all([loadProtectLogs(), loadProtectStats()]);
  }
}

// ============ 数据加载函数 ============

/**
 * 加载我的道侣信息
 */
async function loadMyData() {
  loading.my = true;
  try {
    const res = await daoCompanionGetMy();
    const body = res.data;
    if (body && body.data) {
      myData.value = body.data;
    }
  } catch (err) {
    console.error('加载道侣信息失败:', err);
    uiStore.showToast('加载道侣信息失败', 'error');
  } finally {
    loading.my = false;
  }
}

/**
 * 加载我收到的求婚列表
 */
async function loadProposals() {
  loading.proposals = true;
  try {
    const res = await daoCompanionGetProposals();
    const body = res.data;
    if (body && body.data) {
      proposalsData.value = body.data;
    }
  } catch (err) {
    console.error('加载求婚列表失败:', err);
  } finally {
    loading.proposals = false;
  }
}

/**
 * 加载心劫状态
 */
async function loadTribulationStatus() {
  loading.tribulation = true;
  try {
    const res = await daoCompanionGetHeartTribulationStatus();
    const body = res.data;
    if (body && body.data) {
      tribulationData.value = body.data;
    }
  } catch (err) {
    console.error('加载心劫状态失败:', err);
  } finally {
    loading.tribulation = false;
  }
}

/**
 * 加载护道日志（按角色过滤+分页）
 */
async function loadProtectLogs() {
  loading.protect = true;
  try {
    const res = await daoCompanionGetProtectLogs({
      page: protectPage.value,
      limit: 10,
      role: protectRole.value
    });
    const body = res.data;
    if (body && body.data) {
      protectLogsData.value = body.data;
    }
  } catch (err) {
    console.error('加载护道日志失败:', err);
  } finally {
    loading.protect = false;
  }
}

/**
 * 加载护道统计
 */
async function loadProtectStats() {
  try {
    const res = await daoCompanionGetProtectStats();
    const body = res.data;
    if (body && body.data) {
      protectStatsData.value = body.data;
    }
  } catch (err) {
    console.error('加载护道统计失败:', err);
  }
}

/**
 * 切换护道日志角色过滤
 */
async function switchProtectRole(role: 'all' | 'defender' | 'protector') {
  protectRole.value = role;
  protectPage.value = 1;
  await loadProtectLogs();
}

/**
 * 翻页
 */
async function changeProtectPage(delta: number) {
  const newPage = protectPage.value + delta;
  if (newPage < 1) return;
  if (protectLogsData.value && newPage > protectLogsData.value.total_pages) return;
  protectPage.value = newPage;
  await loadProtectLogs();
}

// ============ 业务操作函数 ============

/**
 * 求婚
 */
async function handlePropose() {
  if (!proposeTargetId.value) return;
  loading.action = true;
  try {
    const res = await daoCompanionPropose(proposeTargetId.value);
    const body = res.data;
    if (body?.success !== false && body?.message) {
      uiStore.showToast(body.message, 'success');
      proposeTargetId.value = null;
      await loadMyData();
    } else {
      uiStore.showToast(body?.message || '求婚失败', 'error');
    }
  } catch (err) {
    console.error('求婚失败:', err);
    uiStore.showToast('求婚失败', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 响应求婚
 * @param proposalId 求婚记录 ID
 * @param action 动作：accept / refuse
 */
async function handleRespond(proposalId: number, action: 'accept' | 'refuse') {
  confirmModal.title = action === 'accept' ? '接受求婚' : '拒绝求婚';
  confirmModal.message = action === 'accept'
    ? `确定接受这道侣求婚吗？\n接受后将自动拒绝其他 pending 求婚，亲密度初始 +10`
    : `确定拒绝这道侣求婚吗？`;
  confirmModal.onConfirm = async () => {
    loading.action = true;
    try {
      const res = await daoCompanionRespond(proposalId, action);
      const body = res.data;
      if (body?.success !== false) {
        uiStore.showToast(body?.message || '操作成功', 'success');
        await Promise.all([loadMyData(), loadProposals()]);
      } else {
        uiStore.showToast(body?.message || '操作失败', 'error');
      }
    } catch (err) {
      console.error('响应求婚失败:', err);
      uiStore.showToast('响应求婚失败', 'error');
    } finally {
      loading.action = false;
    }
  };
  confirmModal.show = true;
}

/**
 * 道侣互动
 */
async function handleInteract() {
  loading.action = true;
  try {
    const res = await daoCompanionInteract();
    const body = res.data;
    if (body?.success !== false) {
      uiStore.showToast(body?.message || '互动成功', 'success');
      await loadMyData();
    } else {
      uiStore.showToast(body?.message || '互动失败', 'error');
    }
  } catch (err) {
    console.error('道侣互动失败:', err);
    uiStore.showToast('道侣互动失败', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 闭关双修
 */
async function handleDualCultivate() {
  confirmModal.title = '闭关双修';
  confirmModal.message = '确定开启闭关双修吗？\n双方将进入双修状态（互斥），收益按当前亲密度/心契加成结算';
  confirmModal.onConfirm = async () => {
    loading.action = true;
    try {
      const res = await daoCompanionDualCultivate();
      const body = res.data;
      if (body?.success !== false) {
        uiStore.showToast(body?.message || '双修成功', 'success');
        await loadMyData();
      } else {
        uiStore.showToast(body?.message || '双修失败', 'error');
      }
    } catch (err) {
      console.error('双修失败:', err);
      uiStore.showToast('双修失败', 'error');
    } finally {
      loading.action = false;
    }
  };
  confirmModal.show = true;
}

/**
 * 凝聚心印
 */
async function handleCondenseImprint() {
  confirmModal.title = '凝聚心印';
  confirmModal.message = `确定凝聚心印吗？\n双方将各消耗 ${myData.value?.settings?.heart_imprint_exp_cost || 1000} 修为\n每 3 个心印提升 1 级心契`;
  confirmModal.onConfirm = async () => {
    loading.action = true;
    try {
      const res = await daoCompanionCondenseHeartImprint();
      const body = res.data;
      if (body?.success !== false) {
        uiStore.showToast(body?.message || '凝聚心印成功', 'success');
        await loadMyData();
      } else {
        uiStore.showToast(body?.message || '凝聚心印失败', 'error');
      }
    } catch (err) {
      console.error('凝聚心印失败:', err);
      uiStore.showToast('凝聚心印失败', 'error');
    } finally {
      loading.action = false;
    }
  };
  confirmModal.show = true;
}

/**
 * 解除道侣关系
 */
async function handleBreak() {
  confirmModal.title = '解除道侣关系';
  confirmModal.message = '【警告】确定解除道侣关系吗？\n· 亲密度 -20 惩罚\n· 7 天内不能再次求婚\n· 此操作不可撤销';
  confirmModal.onConfirm = async () => {
    loading.action = true;
    try {
      const res = await daoCompanionBreak();
      const body = res.data;
      if (body?.success !== false) {
        uiStore.showToast(body?.message || '解除成功', 'success');
        await loadMyData();
      } else {
        uiStore.showToast(body?.message || '解除失败', 'error');
      }
    } catch (err) {
      console.error('解除道侣失败:', err);
      uiStore.showToast('解除道侣失败', 'error');
    } finally {
      loading.action = false;
    }
  };
  confirmModal.show = true;
}

/**
 * 心劫抉择
 * @param eventId 心劫事件 ID
 * @param option 选项：trust / doubt / trial
 */
async function handleTribulationRespond(eventId: number, option: HeartTribulationOption) {
  const optionName = { trust: '信任', doubt: '怀疑', trial: '考验' }[option];
  confirmModal.title = `心劫抉择：${optionName}`;
  confirmModal.message = `确定选择「${optionName}」吗？\n此抉择将影响亲密度与心契等级`;
  confirmModal.onConfirm = async () => {
    loading.action = true;
    try {
      const res = await daoCompanionRespondHeartTribulation(eventId, option);
      const body = res.data;
      if (body?.success !== false) {
        uiStore.showToast(body?.message || '抉择完成', 'success');
        await Promise.all([loadMyData(), loadTribulationStatus()]);
      } else {
        uiStore.showToast(body?.message || '抉择失败', 'error');
      }
    } catch (err) {
      console.error('心劫抉择失败:', err);
      uiStore.showToast('心劫抉择失败', 'error');
    } finally {
      loading.action = false;
    }
  };
  confirmModal.show = true;
}

// ============ 工具函数 ============

/**
 * 格式化时间显示
 * @param time 时间字符串
 */
function formatTime(time?: string | null): string {
  if (!time) return '未知';
  try {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return time;
  }
}

/**
 * 格式化冷却时间
 * @param seconds 剩余秒数
 */
function formatCooldown(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h${m}m`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m${s}s`;
  }
  return `${seconds}s`;
}

/**
 * 格式化 BIGINT 字符串为可读数值（带千分位）
 * 后端 BIGINT 字段返回字符串避免 JS 精度丢失
 * @param value BIGINT 字符串
 */
function formatBigInt(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0';
  const str = String(value);
  // 简单千分位格式化
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 战斗类型转中文名
 * @param type 战斗类型：pvp/sect_war/world_boss
 */
function getBattleTypeName(type: string): string {
  const map: Record<string, string> = {
    pvp: 'PVP 斗法',
    sect_war: '宗门战',
    world_boss: '世界 BOSS',
    adventure: '奇遇',
    dungeon: '副本'
  };
  return map[type] || type;
}
</script>

<style scoped>
/* 淡入动画 */
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
</style>
