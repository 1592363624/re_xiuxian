/**
 * 小世界综合面板组件
 *
 * 批次3 后期系统 - 小世界/神庙/香火/神识/法则 5 大子模块综合面板
 *
 * Tab 划分：
 *   1. 小世界：开辟/显灵/神迹干预（relieve_disaster 赈灾 / preach 布道）
 *   2. 神庙：升级/修复禁制/兑换供奉
 *   3. 香火：收割/流水分页
 *   4. 神识：淬炼（100 香火=1 神识）
 *   5. 法则：神识/碎片→法则点 + 7 种法则转换
 *
 * 设计原则：
 *   - 所有状态从后端拉取，禁止硬编码业务数据
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 颜色风格与 AscensionPanel.vue 一致（修仙古风：#1c1917 / #292524 / amber-300 / purple-300）
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS
 *   - 联合类型判别字段：has_small_world / has_temple
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
            <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          小世界 · 神域治理
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

        <!-- ============ Tab 1: 小世界 ============ -->
        <div v-show="activeTab === 'small_world'" class="space-y-3">
          <div v-if="loading.smallWorld" class="text-center py-6 text-stone-500 text-sm">加载小世界数据中...</div>
          <template v-else-if="smallWorldProfile">
            <!-- 未开辟小世界 -->
            <section v-if="!smallWorldProfile.has_small_world" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-3">开辟小世界</div>
              <div class="text-xs text-stone-400 space-y-1 mb-4">
                <div>· 境界要求：<span class="text-amber-300">{{ smallWorldProfile.create_cost.realm_required }}</span></div>
                <div>· 消耗灵石：<span class="text-amber-300">{{ formatNumber(smallWorldProfile.create_cost.spirit_stones) }}</span></div>
                <div>· 开辟后可建立神域、收割香火、显灵干预</div>
              </div>
              <div class="flex items-center gap-2">
                <input v-model="worldName" maxlength="50" placeholder="为小世界赐名（最长 50 字符）"
                  class="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none" />
                <button @click="handleCreateWorld"
                  :disabled="loading.action || !smallWorldProfile.can_create || !worldName.trim()"
                  class="px-4 py-2 rounded text-xs font-bold bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
                  开辟
                </button>
              </div>
              <div v-if="!smallWorldProfile.can_create" class="text-[10px] text-rose-400 mt-2">
                · 境界或灵石条件未满足，无法开辟
              </div>
            </section>

            <!-- 已开辟小世界 -->
            <template v-else>
              <!-- 小世界信息 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-sm font-bold text-amber-300">{{ smallWorldProfile.world.world_name }}</div>
                  <div class="text-[10px] px-2 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800">
                    Lv.{{ smallWorldProfile.world.world_level }}
                  </div>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div class="text-stone-500">人口</div>
                    <div class="text-stone-200 font-bold">{{ smallWorldProfile.world.population }} / {{ smallWorldProfile.world.population_max }}</div>
                  </div>
                  <div>
                    <div class="text-stone-500">信仰</div>
                    <div class="text-purple-300 font-bold">{{ smallWorldProfile.world.faith }} / {{ smallWorldProfile.world.faith_max }}</div>
                  </div>
                  <div>
                    <div class="text-stone-500">稳定度</div>
                    <div class="text-emerald-300 font-bold">{{ smallWorldProfile.world.stability }} / 100</div>
                  </div>
                  <div>
                    <div class="text-stone-500">香火产出/h</div>
                    <div class="text-amber-300 font-bold">{{ smallWorldProfile.world.incense_production_rate }}</div>
                  </div>
                </div>
                <!-- 稳定度进度条 -->
                <div class="mt-3 h-1.5 bg-stone-800 rounded-full overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all"
                    :style="{ width: `${smallWorldProfile.world.stability}%` }"></div>
                </div>
              </section>

              <!-- 玩家资源 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-amber-300 mb-3">玩家资源</div>
                <div class="grid grid-cols-3 gap-3 text-xs">
                  <div class="bg-stone-900/50 rounded p-2 text-center">
                    <div class="text-stone-500">香火余额</div>
                    <div class="text-amber-300 font-bold text-lg">{{ smallWorldProfile.player.incense_balance }}</div>
                  </div>
                  <div class="bg-stone-900/50 rounded p-2 text-center">
                    <div class="text-stone-500">神识余额</div>
                    <div class="text-cyan-300 font-bold text-lg">{{ smallWorldProfile.player.divine_sense_balance }}</div>
                  </div>
                  <div class="bg-stone-900/50 rounded p-2 text-center">
                    <div class="text-stone-500">法则点</div>
                    <div class="text-purple-300 font-bold text-lg">{{ smallWorldProfile.player.law_points }}</div>
                  </div>
                </div>
              </section>

              <!-- 显灵 + 神迹干预 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-purple-300 mb-3">显灵与神迹</div>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <button @click="handleManifest"
                    :disabled="loading.action"
                    class="py-2 rounded text-xs font-bold bg-purple-950/40 border border-purple-800 text-purple-300 hover:bg-purple-900/40 disabled:opacity-50">
                    显灵回应祈愿（消耗 100 香火）
                  </button>
                  <button @click="handleMiracle('relieve_disaster')"
                    :disabled="loading.action"
                    class="py-2 rounded text-xs font-bold bg-emerald-950/40 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-50">
                    赈灾（稳定度+）
                  </button>
                  <button @click="handleMiracle('preach')"
                    :disabled="loading.action"
                    class="py-2 rounded text-xs font-bold bg-cyan-950/40 border border-cyan-800 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-50">
                    布道（信仰+）
                  </button>
                </div>
                <div class="text-[10px] text-stone-500 mt-2">
                  · 显灵：消耗 100 香火，获得信仰+5 / 稳定+3 / 灵石回馈<br>
                  · 神迹每日限次：relieve_disaster=赈灾 / preach=布道
                </div>
              </section>
            </template>
          </template>
        </div>

        <!-- ============ Tab 2: 神庙 ============ -->
        <div v-show="activeTab === 'divine_temple'" class="space-y-3">
          <div v-if="loading.temple" class="text-center py-6 text-stone-500 text-sm">加载神庙数据中...</div>
          <template v-else-if="templeProfile">
            <!-- 未创建神庙 -->
            <section v-if="!templeProfile.has_temple" class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-2">神庙</div>
              <div class="text-xs text-stone-400">{{ templeProfile.message || '尚未创建神庙，需先开辟小世界' }}</div>
            </section>

            <!-- 已创建神庙 -->
            <template v-else>
              <!-- 神庙信息 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-sm font-bold text-amber-300">{{ templeProfile.temple.temple_name }}</div>
                  <div class="text-[10px] px-2 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800">
                    Lv.{{ templeProfile.temple.temple_level }}
                  </div>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div>
                    <div class="text-stone-500">护界禁制</div>
                    <div class="text-emerald-300 font-bold">{{ templeProfile.temple.defense_power }} / {{ templeProfile.temple.defense_max }}</div>
                  </div>
                  <div>
                    <div class="text-stone-500">玩家香火</div>
                    <div class="text-amber-300 font-bold">{{ templeProfile.player_incense_balance }}</div>
                  </div>
                  <div>
                    <div class="text-stone-500">玩家灵石</div>
                    <div class="text-amber-200 font-bold">{{ formatNumber(templeProfile.player_spirit_stones) }}</div>
                  </div>
                </div>
                <!-- 禁制进度条 -->
                <div class="mt-3 h-1.5 bg-stone-800 rounded-full overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all"
                    :style="{ width: `${(templeProfile.temple.defense_power / templeProfile.temple.defense_max) * 100}%` }"></div>
                </div>
              </section>

              <!-- 升级 + 修复 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-amber-300 mb-3">升级与修复</div>
                <div v-if="templeProfile.upgrade_info.is_max_level" class="text-xs text-emerald-300 mb-3">
                  · 已达最高等级
                </div>
                <div v-else-if="templeProfile.upgrade_info.next_upgrade" class="text-[11px] text-stone-400 space-y-1 mb-3">
                  <div>· 升级至 Lv.{{ templeProfile.upgrade_info.next_upgrade.to_level }}</div>
                  <div>· 消耗香火：<span class="text-amber-300">{{ templeProfile.upgrade_info.next_upgrade.cost_incense }}</span></div>
                  <div>· 消耗灵石：<span class="text-amber-300">{{ formatNumber(templeProfile.upgrade_info.next_upgrade.cost_spirit_stones) }}</span></div>
                  <div>· 解锁特性：<span class="text-purple-300">{{ templeProfile.upgrade_info.next_upgrade.unlock_feature }}</span></div>
                  <div>· 神庙加成：<span class="text-emerald-300">{{ templeProfile.upgrade_info.next_upgrade.temple_bonus }}</span></div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <button @click="handleUpgradeTemple"
                    :disabled="loading.action || templeProfile.upgrade_info.is_max_level"
                    class="py-2 rounded text-xs font-bold bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
                    {{ templeProfile.upgrade_info.is_max_level ? '已满级' : '升级神庙' }}
                  </button>
                  <button @click="handleRepairDefense"
                    :disabled="loading.action"
                    class="py-2 rounded text-xs font-bold bg-emerald-950/40 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-50">
                    修复禁制（消耗灵石，CD 1h）
                  </button>
                </div>
              </section>

              <!-- 供奉兑换 -->
              <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
                <div class="text-sm font-bold text-purple-300 mb-3">供奉兑换</div>
                <div v-if="templeProfile.available_offerings.length === 0" class="text-xs text-stone-500 text-center py-3">
                  当前等级暂无可兑换供奉
                </div>
                <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div v-for="offering in templeProfile.available_offerings" :key="offering.offering_id"
                    class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-amber-300 font-bold">{{ offering.name }}</span>
                      <span class="text-[10px] text-stone-500">Lv.{{ offering.min_temple_level }}+</span>
                    </div>
                    <div class="text-stone-400 text-[11px] mb-2">
                      · 消耗香火：<span class="text-amber-300">{{ offering.cost_incense }}</span><br>
                      · 奖励：<span class="text-emerald-300">{{ offering.reward.type }} ×{{ offering.reward.amount }}</span>
                      <span v-if="offering.description"> · {{ offering.description }}</span>
                    </div>
                    <button @click="handleExchangeOffering(offering.offering_id)"
                      :disabled="loading.action"
                      class="w-full py-1 rounded bg-purple-950/40 border border-purple-800 text-purple-300 hover:bg-purple-900/40 disabled:opacity-50">
                      兑换
                    </button>
                  </div>
                </div>
              </section>
            </template>
          </template>
        </div>

        <!-- ============ Tab 3: 香火 ============ -->
        <div v-show="activeTab === 'incense'" class="space-y-3">
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-amber-300">香火收割</div>
              <button @click="handleHarvest"
                :disabled="loading.action"
                class="px-4 py-2 rounded text-xs font-bold bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
                收割香火
              </button>
            </div>
            <div class="text-[11px] text-stone-400">
              · 按小世界产出速率累计，收割后同步更新人口/信仰/稳定度
            </div>
          </section>

          <!-- 香火流水 -->
          <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-amber-300">香火流水</div>
              <div class="flex items-center gap-2 text-xs">
                <button @click="changeLogPage(incenseLogs.page - 1)" :disabled="loading.logs || incenseLogs.page <= 1"
                  class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">上一页</button>
                <span class="text-stone-400">{{ incenseLogs.page }} / {{ incenseLogs.total_pages || 1 }}</span>
                <button @click="changeLogPage(incenseLogs.page + 1)" :disabled="loading.logs || incenseLogs.page >= incenseLogs.total_pages"
                  class="px-2 py-1 text-xs bg-stone-800 rounded disabled:opacity-50 hover:bg-stone-700">下一页</button>
              </div>
            </div>
            <div v-if="loading.logs" class="text-center py-3 text-stone-500 text-xs">加载流水中...</div>
            <div v-else-if="incenseLogs.list.length === 0" class="text-center py-3 text-stone-500 text-xs">暂无流水记录</div>
            <div v-else class="space-y-1 max-h-72 overflow-y-auto">
              <div v-for="log in incenseLogs.list" :key="log.id"
                class="bg-stone-900/40 border border-stone-800 rounded p-2 text-[11px] flex items-center justify-between">
                <div>
                  <span class="text-stone-300">{{ log.change_type_name }}</span>
                  <span class="text-stone-500 ml-2">{{ log.reason }}</span>
                </div>
                <div class="flex items-center gap-2">
                  <span :class="log.change_amount >= 0 ? 'text-emerald-300' : 'text-rose-400'">
                    {{ log.change_amount >= 0 ? '+' : '' }}{{ log.change_amount }}
                  </span>
                  <span class="text-stone-500">余额 {{ log.balance_after }}</span>
                  <span class="text-stone-600">{{ formatTime(log.created_at) }}</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- ============ Tab 4: 神识 ============ -->
        <div v-show="activeTab === 'divine_sense'" class="space-y-3">
          <div v-if="loading.divineSense" class="text-center py-6 text-stone-500 text-sm">加载神识数据中...</div>
          <template v-else-if="divineSenseProfile">
            <!-- 神识状态 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-cyan-300 mb-3">神识状态</div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <div class="text-stone-500">当前/上限</div>
                  <div class="text-cyan-300 font-bold">{{ divineSenseProfile.divine_sense.current }} / {{ divineSenseProfile.divine_sense.max }}</div>
                </div>
                <div>
                  <div class="text-stone-500">恢复/h</div>
                  <div class="text-emerald-300 font-bold">{{ divineSenseProfile.divine_sense.regen_rate_per_hour }}</div>
                </div>
                <div>
                  <div class="text-stone-500">累计淬炼</div>
                  <div class="text-purple-300 font-bold">{{ divineSenseProfile.divine_sense.total_quenched }}</div>
                </div>
                <div>
                  <div class="text-stone-500">累计消耗</div>
                  <div class="text-rose-300 font-bold">{{ divineSenseProfile.divine_sense.total_consumed }}</div>
                </div>
              </div>
              <!-- 神识进度条 -->
              <div class="mt-3 h-1.5 bg-stone-800 rounded-full overflow-hidden">
                <div class="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 transition-all"
                  :style="{ width: `${(divineSenseProfile.divine_sense.current / divineSenseProfile.divine_sense.max) * 100}%` }"></div>
              </div>
            </section>

            <!-- 淬炼操作 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-cyan-300 mb-3">神识淬炼</div>
              <div class="text-[11px] text-stone-400 space-y-1 mb-3">
                <div>· 每日次数：{{ divineSenseProfile.quench_info.daily_count }} / {{ divineSenseProfile.quench_info.daily_limit }}（剩余 {{ divineSenseProfile.quench_info.daily_remaining }}）</div>
                <div>· 比率：每 1 神识消耗 {{ divineSenseProfile.quench_info.cost_incense_per_sense }} 香火</div>
                <div>· 单次最大：{{ divineSenseProfile.quench_info.max_amount_per_time }} 神识</div>
                <div>· CD 状态：<span :class="divineSenseProfile.quench_info.cooldown_ready ? 'text-emerald-300' : 'text-rose-400'">
                  {{ divineSenseProfile.quench_info.cooldown_ready ? '可淬炼' : `冷却中（剩余 ${divineSenseProfile.quench_info.cooldown_remaining_sec} 秒）` }}
                </span></div>
                <div>· 玩家香火余额：<span class="text-amber-300">{{ divineSenseProfile.player_incense_balance }}</span></div>
              </div>
              <div class="flex items-center gap-2">
                <input v-model.number="quenchAmount" type="number" min="1" :max="divineSenseProfile.quench_info.max_amount_per_time" placeholder="淬炼数量"
                  class="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none" />
                <button @click="handleQuench"
                  :disabled="loading.action || !divineSenseProfile.quench_info.cooldown_ready || divineSenseProfile.quench_info.daily_remaining <= 0 || !quenchAmount"
                  class="px-4 py-2 rounded text-xs font-bold bg-cyan-700 text-cyan-100 hover:bg-cyan-600 disabled:opacity-50">
                  淬炼
                </button>
              </div>
            </section>

            <!-- 神识用途表 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-3">神识用途</div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div v-for="(usage, idx) in divineSenseProfile.usage_table" :key="idx"
                  class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs">
                  <div class="flex items-center justify-between">
                    <span class="text-amber-300 font-bold">{{ usage.name }}</span>
                    <span class="text-cyan-300">消耗 {{ usage.cost }}</span>
                  </div>
                  <div v-if="usage.description" class="text-stone-500 text-[10px] mt-1">{{ usage.description }}</div>
                </div>
              </div>
            </section>
          </template>
        </div>

        <!-- ============ Tab 5: 法则 ============ -->
        <div v-show="activeTab === 'law'" class="space-y-3">
          <div v-if="loading.law" class="text-center py-6 text-stone-500 text-sm">加载法则数据中...</div>
          <template v-else-if="lawProfile">
            <!-- 法则点 + 碎片 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-3">法则点与碎片</div>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-stone-500">当前法则点</div>
                  <div class="text-purple-300 font-bold text-lg">{{ lawProfile.law_points.current }}</div>
                  <div class="text-[10px] text-stone-500">每日剩余：{{ lawProfile.law_points.daily_remaining }} / {{ lawProfile.law_points.daily_limit }}</div>
                </div>
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-stone-500">累计获得</div>
                  <div class="text-emerald-300 font-bold">{{ lawProfile.law_points.total_earned }}</div>
                </div>
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-stone-500">累计消耗</div>
                  <div class="text-rose-300 font-bold">{{ lawProfile.law_points.total_spent }}</div>
                </div>
              </div>
              <div class="grid grid-cols-5 gap-2 mt-3 text-[11px]">
                <div v-for="(count, key) in lawProfile.fragments" :key="key"
                  class="bg-stone-900/50 border border-stone-700 rounded p-2 text-center">
                  <div class="text-stone-500">{{ getFragmentName(lawProfile.fragment_types, key) }}</div>
                  <div class="text-cyan-300 font-bold">{{ count }}</div>
                </div>
              </div>
            </section>

            <!-- 转换：神识→法则点 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-cyan-300 mb-3">神识 → 法则点</div>
              <div class="text-[11px] text-stone-400 mb-2">
                · 比率：100 神识 = 1 法则点（受每日上限限制）
              </div>
              <div class="flex items-center gap-2">
                <input v-model.number="convertDivineSenseAmount" type="number" min="100" step="100" placeholder="神识数量"
                  class="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none" />
                <button @click="handleConvertDivineSense"
                  :disabled="loading.action || !convertDivineSenseAmount"
                  class="px-4 py-2 rounded text-xs font-bold bg-cyan-700 text-cyan-100 hover:bg-cyan-600 disabled:opacity-50">
                  转换
                </button>
              </div>
            </section>

            <!-- 转换：碎片→法则点 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-amber-300 mb-3">碎片 → 法则点</div>
              <div class="text-[11px] text-stone-400 mb-2">
                · 比率：空间碎片=5 点 / 其他碎片=3 点
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
                <select v-model="convertFragType"
                  class="bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none">
                  <option value="">选择碎片类型</option>
                  <option v-for="(info, key) in lawProfile.fragment_types" :key="key" :value="key">
                    {{ info.name }}（存量 {{ lawProfile.fragments[key] || 0 }}）
                  </option>
                </select>
                <input v-model.number="convertFragCount" type="number" min="1" placeholder="碎片数量"
                  class="bg-stone-900 border border-stone-700 rounded px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none" />
              </div>
              <button @click="handleConvertFragment"
                :disabled="loading.action || !convertFragType || !convertFragCount"
                class="w-full py-2 rounded text-xs font-bold bg-amber-700 text-amber-100 hover:bg-amber-600 disabled:opacity-50">
                转换碎片
              </button>
            </section>

            <!-- 法则转换选项 -->
            <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
              <div class="text-sm font-bold text-purple-300 mb-3">法则转换（消耗法则点，兑换永久/临时效果）</div>
              <div v-if="lawProfile.convert_options.length === 0" class="text-xs text-stone-500 text-center py-3">
                暂无可转换选项
              </div>
              <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div v-for="opt in lawProfile.convert_options" :key="opt.convert_id"
                  class="bg-stone-900/50 border border-stone-700 rounded p-2 text-xs">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-purple-300 font-bold">{{ opt.name }}</span>
                    <span class="text-amber-300">{{ opt.cost_points }} 点</span>
                  </div>
                  <div class="text-stone-400 text-[11px] mb-2">
                    · 效果：<span class="text-emerald-300">{{ opt.effect }}</span>
                    <span v-if="opt.description"> · {{ opt.description }}</span>
                  </div>
                  <button @click="handleConvertLaw(opt.convert_id)"
                    :disabled="loading.action"
                    class="w-full py-1 rounded bg-purple-950/40 border border-purple-800 text-purple-300 hover:bg-purple-900/40 disabled:opacity-50">
                    转换
                  </button>
                </div>
              </div>
            </section>
          </template>
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
 * 小世界综合面板脚本
 * 5 Tab 共享一个面板，按需懒加载对应子模块数据
 */
import { ref, reactive, onMounted } from 'vue';
import Modal from '../common/Modal.vue';
import { useUIStore } from '../../stores/ui';
import { formatNumber } from '../../utils/format';
import {
  smallWorldGetProfile,
  smallWorldCreate,
  smallWorldManifest,
  smallWorldMiracle,
  divineTempleGetProfile,
  divineTempleUpgrade,
  divineTempleRepairDefense,
  divineTempleExchangeOffering,
  incenseHarvest,
  incenseGetLogs,
  divineSenseGetProfile,
  divineSenseQuench,
  lawGetProfile,
  lawConvertDivineSense,
  lawConvertFragment,
  lawConvert,
  type SmallWorldProfileData,
  type DivineTempleProfileData,
  type IncenseLogsData,
  type DivineSenseProfileData,
  type LawProfileData
} from '../../api/lateStage';

const uiStore = useUIStore();

/** Tab 配置 */
const tabs = [
  { id: 'small_world', name: '小世界' },
  { id: 'divine_temple', name: '神庙' },
  { id: 'incense', name: '香火' },
  { id: 'divine_sense', name: '神识' },
  { id: 'law', name: '法则' }
];
/** 当前激活 Tab */
const activeTab = ref('small_world');
/** 已加载过的 Tab 集合，避免重复请求 */
const loadedTabs = reactive<Set<string>>(new Set());

/** 各模块加载状态 */
const loading = reactive({
  smallWorld: false,
  temple: false,
  divineSense: false,
  law: false,
  logs: false,
  action: false
});

/** 各模块数据 */
const smallWorldProfile = ref<SmallWorldProfileData | null>(null);
const templeProfile = ref<DivineTempleProfileData | null>(null);
const divineSenseProfile = ref<DivineSenseProfileData | null>(null);
const lawProfile = ref<LawProfileData | null>(null);
const incenseLogs = reactive<IncenseLogsData>({
  list: [], total: 0, page: 1, page_size: 10, total_pages: 0
});

/** 输入框绑定值 */
const worldName = ref('');                  // 开辟小世界名称
const quenchAmount = ref<number | null>(null); // 神识淬炼数量
const convertDivineSenseAmount = ref<number | null>(null); // 神识→法则点 数量
const convertFragType = ref('');            // 碎片转换-类型
const convertFragCount = ref<number | null>(null); // 碎片转换-数量

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
  await loadSmallWorldProfile();
  loadedTabs.add('small_world');
});

/**
 * Tab 切换：按需懒加载
 * @param tabId Tab ID
 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (loadedTabs.has(tabId)) return;
  if (tabId === 'small_world') await loadSmallWorldProfile();
  else if (tabId === 'divine_temple') await loadTempleProfile();
  else if (tabId === 'incense') await loadIncenseLogs();
  else if (tabId === 'divine_sense') await loadDivineSenseProfile();
  else if (tabId === 'law') await loadLawProfile();
  loadedTabs.add(tabId);
}

// ============ 数据加载函数 ============

/** 加载小世界面板数据 */
async function loadSmallWorldProfile() {
  loading.smallWorld = true;
  try {
    const resp = await smallWorldGetProfile();
    if (resp.data?.code === 200 && resp.data.data) {
      smallWorldProfile.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取小世界数据失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.smallWorld = false;
  }
}

/** 加载神庙面板数据 */
async function loadTempleProfile() {
  loading.temple = true;
  try {
    const resp = await divineTempleGetProfile();
    if (resp.data?.code === 200 && resp.data.data) {
      templeProfile.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取神庙数据失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.temple = false;
  }
}

/** 加载神识面板数据 */
async function loadDivineSenseProfile() {
  loading.divineSense = true;
  try {
    const resp = await divineSenseGetProfile();
    if (resp.data?.code === 200 && resp.data.data) {
      divineSenseProfile.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取神识数据失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.divineSense = false;
  }
}

/** 加载法则面板数据 */
async function loadLawProfile() {
  loading.law = true;
  try {
    const resp = await lawGetProfile();
    if (resp.data?.code === 200 && resp.data.data) {
      lawProfile.value = resp.data.data;
    } else {
      uiStore.showToast(resp.data?.message || '获取法则数据失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.law = false;
  }
}

/** 加载香火流水（默认第 1 页） */
async function loadIncenseLogs() {
  loading.logs = true;
  try {
    const resp = await incenseGetLogs(incenseLogs.page, incenseLogs.page_size);
    if (resp.data?.code === 200 && resp.data.data) {
      Object.assign(incenseLogs, resp.data.data);
    } else {
      uiStore.showToast(resp.data?.message || '获取流水失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.logs = false;
  }
}

/**
 * 香火流水翻页
 * @param page 目标页码
 */
async function changeLogPage(page: number) {
  if (page < 1 || page > incenseLogs.total_pages) return;
  incenseLogs.page = page;
  await loadIncenseLogs();
}

// ============ 操作处理函数 ============

/** 开辟小世界 */
async function handleCreateWorld() {
  if (!worldName.value.trim()) {
    uiStore.showToast('请输入小世界名称', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await smallWorldCreate(worldName.value.trim());
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '小世界开辟成功', 'success');
      worldName.value = '';
      await loadSmallWorldProfile();
    } else {
      uiStore.showToast(resp.data?.message || '开辟失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 显灵回应祈愿 */
async function handleManifest() {
  showConfirm('显灵回应祈愿', '将消耗 100 香火回应祈愿，获得信仰+5 / 稳定+3 / 灵石回馈。确认显灵？', async () => {
    loading.action = true;
    try {
      const resp = await smallWorldManifest();
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '显灵成功', 'success');
        await loadSmallWorldProfile();
      } else {
        uiStore.showToast(resp.data?.message || '显灵失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/**
 * 神迹干预
 * @param type 干预类型：relieve_disaster=赈灾 / preach=布道
 */
async function handleMiracle(type: 'relieve_disaster' | 'preach') {
  const label = type === 'relieve_disaster' ? '赈灾（稳定度+）' : '布道（信仰+）';
  showConfirm('神迹干预', `确认进行「${label}」？每日限次。`, async () => {
    loading.action = true;
    try {
      const resp = await smallWorldMiracle(type);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '神迹干预成功', 'success');
        await loadSmallWorldProfile();
      } else {
        uiStore.showToast(resp.data?.message || '干预失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/** 升级神庙 */
async function handleUpgradeTemple() {
  showConfirm('升级神庙', '确认消耗资源升级神庙？操作不可撤销。', async () => {
    loading.action = true;
    try {
      const resp = await divineTempleUpgrade();
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '升级成功', 'success');
        await loadTempleProfile();
      } else {
        uiStore.showToast(resp.data?.message || '升级失败', 'error');
      }
    } catch (e: any) {
      uiStore.showToast(e.message || '网络错误', 'error');
    } finally {
      loading.action = false;
    }
  });
}

/** 修复护界禁制 */
async function handleRepairDefense() {
  loading.action = true;
  try {
    const resp = await divineTempleRepairDefense();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '禁制已修复', 'success');
      await loadTempleProfile();
    } else {
      uiStore.showToast(resp.data?.message || '修复失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 兑换供奉
 * @param offeringId 供奉 ID
 */
async function handleExchangeOffering(offeringId: string) {
  loading.action = true;
  try {
    const resp = await divineTempleExchangeOffering(offeringId);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '兑换成功', 'success');
      await loadTempleProfile();
    } else {
      uiStore.showToast(resp.data?.message || '兑换失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 收割香火 */
async function handleHarvest() {
  loading.action = true;
  try {
    const resp = await incenseHarvest();
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '收割完成', 'success');
      // 刷新小世界数据 + 流水
      await Promise.all([loadSmallWorldProfile(), loadIncenseLogs()]);
    } else {
      uiStore.showToast(resp.data?.message || '收割失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 神识淬炼 */
async function handleQuench() {
  if (!quenchAmount.value || quenchAmount.value <= 0) {
    uiStore.showToast('请输入有效的淬炼数量', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await divineSenseQuench(quenchAmount.value);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '淬炼成功', 'success');
      quenchAmount.value = null;
      await loadDivineSenseProfile();
    } else {
      uiStore.showToast(resp.data?.message || '淬炼失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 神识→法则点 转换 */
async function handleConvertDivineSense() {
  if (!convertDivineSenseAmount.value || convertDivineSenseAmount.value < 100) {
    uiStore.showToast('最少转换 100 神识', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await lawConvertDivineSense(convertDivineSenseAmount.value);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '转换成功', 'success');
      convertDivineSenseAmount.value = null;
      await loadLawProfile();
    } else {
      uiStore.showToast(resp.data?.message || '转换失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/** 碎片→法则点 转换 */
async function handleConvertFragment() {
  if (!convertFragType.value || !convertFragCount.value || convertFragCount.value <= 0) {
    uiStore.showToast('请选择碎片类型并输入数量', 'warning');
    return;
  }
  loading.action = true;
  try {
    const resp = await lawConvertFragment(convertFragType.value, convertFragCount.value);
    if (resp.data?.code === 200) {
      uiStore.showToast(resp.data.message || '转换成功', 'success');
      convertFragType.value = '';
      convertFragCount.value = null;
      await loadLawProfile();
    } else {
      uiStore.showToast(resp.data?.message || '转换失败', 'error');
    }
  } catch (e: any) {
    uiStore.showToast(e.message || '网络错误', 'error');
  } finally {
    loading.action = false;
  }
}

/**
 * 法则转换（消耗法则点，兑换永久/临时效果）
 * @param convertId 转换选项 ID
 */
async function handleConvertLaw(convertId: string) {
  showConfirm('法则转换', `确认消耗法则点进行转换？操作不可撤销。`, async () => {
    loading.action = true;
    try {
      const resp = await lawConvert(convertId, 1);
      if (resp.data?.code === 200) {
        uiStore.showToast(resp.data.message || '转换成功', 'success');
        await loadLawProfile();
      } else {
        uiStore.showToast(resp.data?.message || '转换失败', 'error');
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
 * 获取碎片中文名
 * @param fragmentTypes 法则面板的 fragment_types 字段
 * @param key 碎片类型 key
 */
function getFragmentName(fragmentTypes: Record<string, { name: string; description?: string }> | undefined, key: string): string {
  return fragmentTypes?.[key]?.name || key;
}

/**
 * 格式化时间显示（M/D HH:MM）
 * @param time ISO 时间字符串
 */
function formatTime(time: string | null): string {
  if (!time) return '-';
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>

<style scoped>
/* 局部淡入动画，与 AscensionPanel 保持一致 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}
</style>
