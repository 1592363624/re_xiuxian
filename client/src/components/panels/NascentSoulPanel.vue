/**
 * 元婴出窍与高阶境界面板组件
 *
 * 高阶境界（化神及以上）综合玩法面板，包含以下功能模块：
 *   1. 元婴出窍：元婴初期以上玩家元神离体，进行探索/窥探/远方修炼
 *   2. 问道：化神初期以上玩家向天道问道，积累感悟值用于突破加成
 *   3. 法相天地：化神后期以上玩家凝聚法相，每级提供 5% 属性加成
 *   4. 探寻裂缝：炼虚初期以上玩家探寻虚空裂缝，获得稀有材料
 *   5. 虚弱/残魂：状态展示与影响说明
 *   6. 夺舍重生：残魂过低时可尝试夺舍，重置境界但保留部分修为
 *
 * 设计原则：
 *   - 所有状态从后端 GET /nascent-soul/status 拉取，禁止硬编码
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 未解锁功能展示锁定状态与解锁境界要求
 */
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩层 -->
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <!-- 主面板 -->
    <div class="relative bg-[#1c1917] border border-stone-800 rounded-lg p-6 max-w-3xl w-full mx-4 shadow-2xl animate-fade-in max-h-[88vh] flex flex-col">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-purple-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3c0 1.6.8 3 2 4-1.2 1-2 2.4-2 4a3 3 0 0 0 6 0c0-1.6-.8-3-2-4 1.2-1 2-2.4 2-4a3 3 0 0 0-3-3z"/>
            <path d="M5 22h14"/>
            <path d="M12 16v6"/>
          </svg>
          元婴出窍与高阶境界
        </h2>
        <button @click="$emit('close')" class="text-stone-500 hover:text-white transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- 境界与状态总览 -->
      <div v-if="status" class="bg-[#292524] border border-stone-700 rounded-lg p-3 mb-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <div class="text-stone-500">当前境界</div>
          <div class="text-amber-300 font-bold">{{ status.realm }}</div>
        </div>
        <div>
          <div class="text-stone-500">残魂值</div>
          <div class="font-bold" :class="status.remnant_soul.is_unstable ? 'text-rose-400' : 'text-emerald-400'">
            {{ status.remnant_soul.value.toFixed(1) }} / {{ status.remnant_soul.max }}
          </div>
        </div>
        <div>
          <div class="text-stone-500">问道感悟</div>
          <div class="text-cyan-300 font-bold">{{ status.ask_dao.insight.toFixed(2) }}</div>
        </div>
        <div>
          <div class="text-stone-500">法相等级</div>
          <div class="text-purple-300 font-bold">
            {{ status.dharma_form.level }} / {{ status.dharma_form.max_level }}
            <span class="text-stone-500 ml-1">(+{{ (status.dharma_form.attribute_bonus * 100).toFixed(0) }}%)</span>
          </div>
        </div>
      </div>

      <!-- 虚弱状态提示条 -->
      <div v-if="status?.weakness?.is_weak" class="bg-rose-950/30 border border-rose-800/50 rounded-lg p-3 mb-4 text-xs text-rose-300 flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>虚弱状态中：修炼经验减少 {{ (status.weakness.exp_gain_penalty * 100).toFixed(0) }}%，突破成功率减少 {{ status.weakness.breakthrough_penalty }}%，剩余 {{ formatTime(status.weakness.remaining_sec) }}</span>
      </div>

      <!-- 内容滚动区 -->
      <div class="flex-1 overflow-y-auto space-y-3 pr-1">
        <!-- 模块1：元婴出窍 -->
        <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-purple-950/40 border border-purple-700/40 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3c0 1.6.8 3 2 4-1.2 1-2 2.4-2 4a3 3 0 0 0 6 0c0-1.6-.8-3-2-4 1.2-1 2-2.4 2-4a3 3 0 0 0-3-3z"/>
                </svg>
              </div>
              <div>
                <div class="text-sm font-bold text-purple-300">元婴出窍</div>
                <div class="text-[10px] text-stone-500">元神离体，远方探索、窥探或修炼</div>
              </div>
            </div>
            <div v-if="!status?.soul_out.unlocked" class="text-[10px] text-rose-400 px-2 py-0.5 rounded bg-rose-950/40 border border-rose-900/40">需元婴初期</div>
            <div v-else-if="status?.soul_out.state === 'out'" class="text-[10px] text-amber-400 px-2 py-0.5 rounded bg-amber-950/40 border border-amber-900/40">出窍中</div>
          </div>

          <!-- 出窍中状态展示 -->
          <div v-if="status?.soul_out.state === 'out'" class="space-y-2">
            <div class="text-xs text-stone-400">
              目标：<span class="text-amber-300">{{ getSoulOutTargetLabel(status.soul_out.target) }}</span>
              ·  剩余：<span class="text-amber-300">{{ formatTime(status.soul_out.out_remaining_sec) }}</span>
              ·  今日：<span class="text-stone-300">{{ status.soul_out.daily_count }} / {{ status.soul_out.daily_limit }}</span>
            </div>
            <div class="h-1.5 bg-stone-800 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-purple-700 to-amber-500 transition-all duration-500"
                :style="{ width: `${soulOutProgress}%` }"></div>
            </div>
            <button @click="handleEndSoulOut"
              :disabled="loading"
              class="w-full py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 bg-rose-950/40 border border-rose-800 text-rose-300 hover:bg-rose-900/40">
              召回元婴（提前召回按比例折减收益）
            </button>
          </div>

          <!-- 出窍操作 -->
          <div v-else-if="status?.soul_out.unlocked" class="space-y-2">
            <div class="grid grid-cols-3 gap-2">
              <button v-for="t in soulOutTargets" :key="t.value"
                @click="soulOutForm.target = t.value"
                :disabled="loading"
                class="text-xs py-2 px-2 rounded border transition-all"
                :class="soulOutForm.target === t.value
                  ? 'bg-purple-950/40 border-purple-600 text-purple-300'
                  : 'bg-stone-900/40 border-stone-700 text-stone-400 hover:border-stone-500'">
                <div class="font-bold">{{ t.label }}</div>
                <div class="text-[10px] text-stone-500">{{ t.desc }}</div>
              </button>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <span class="text-stone-500">时长：</span>
              <select v-model="soulOutForm.duration_sec"
                :disabled="loading"
                class="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-stone-200 focus:border-purple-500 outline-none">
                <option :value="300">5分钟（试探）</option>
                <option :value="1800">30分钟（默认）</option>
                <option :value="3600">1小时（深度）</option>
                <option :value="7200">2小时（极限）</option>
              </select>
              <span class="text-stone-500 ml-auto">今日 {{ status.soul_out.daily_count }} / {{ status.soul_out.daily_limit }}</span>
            </div>
            <div v-if="status.soul_out.cooldown_remaining_sec > 0" class="text-[11px] text-amber-400">
              冷却中：剩余 {{ formatTime(status.soul_out.cooldown_remaining_sec) }}
            </div>
            <button @click="handleStartSoulOut"
              :disabled="loading || !canStartSoulOut"
              class="w-full py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-purple-950/40 border border-purple-700 text-purple-300 hover:bg-purple-900/40 hover:border-purple-500">
              <span v-if="loading">出窍中...</span>
              <span v-else-if="status.soul_out.cooldown_remaining_sec > 0">冷却中</span>
              <span v-else-if="status.soul_out.daily_count >= status.soul_out.daily_limit">今日次数已用尽</span>
              <span v-else>元婴出窍</span>
            </button>
          </div>

          <!-- 未解锁提示 -->
          <div v-else class="text-xs text-stone-500 text-center py-2">
            境界达到 <span class="text-amber-400">元婴初期</span> 后解锁
          </div>
        </section>

        <!-- 模块2：问道 -->
        <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-cyan-950/40 border border-cyan-700/40 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 16v-4"/>
                  <path d="M12 8h.01"/>
                </svg>
              </div>
              <div>
                <div class="text-sm font-bold text-cyan-300">问道</div>
                <div class="text-[10px] text-stone-500">向天道问道，积累感悟值用于突破加成</div>
              </div>
            </div>
            <div v-if="!status?.ask_dao.unlocked" class="text-[10px] text-rose-400 px-2 py-0.5 rounded bg-rose-950/40 border border-rose-900/40">需化神初期</div>
          </div>

          <div v-if="status?.ask_dao.unlocked" class="space-y-2">
            <div class="text-xs text-stone-400 flex items-center justify-between">
              <span>当前感悟：<span class="text-cyan-300 font-bold">{{ status.ask_dao.insight.toFixed(2) }}</span></span>
              <span>突破加成：<span class="text-emerald-300 font-bold">+{{ Math.min(20, Math.floor(status.ask_dao.insight / 10)) }}%</span></span>
              <span>今日：<span class="text-stone-300">{{ status.ask_dao.daily_count }} / {{ status.ask_dao.daily_limit }}</span></span>
            </div>
            <div v-if="status.ask_dao.cooldown_remaining_sec > 0" class="text-[11px] text-amber-400">
              冷却中：剩余 {{ formatTime(status.ask_dao.cooldown_remaining_sec) }}
            </div>
            <button @click="handleAskDao"
              :disabled="loading || !canAskDao"
              class="w-full py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-950/40 border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40 hover:border-cyan-500">
              <span v-if="loading">问道中...</span>
              <span v-else-if="status.ask_dao.cooldown_remaining_sec > 0">冷却中</span>
              <span v-else-if="status.ask_dao.daily_count >= status.ask_dao.daily_limit">今日次数已用尽</span>
              <span v-else>向天道问道</span>
            </button>
          </div>
          <div v-else class="text-xs text-stone-500 text-center py-2">
            境界达到 <span class="text-amber-400">化神初期</span> 后解锁
          </div>
        </section>

        <!-- 模块3：法相天地 -->
        <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-amber-950/40 border border-amber-700/40 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2 4 7v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V7l-8-5z"/>
                </svg>
              </div>
              <div>
                <div class="text-sm font-bold text-amber-300">法相天地</div>
                <div class="text-[10px] text-stone-500">凝聚法相，每级提供 5% 属性加成</div>
              </div>
            </div>
            <div v-if="!status?.dharma_form.unlocked" class="text-[10px] text-rose-400 px-2 py-0.5 rounded bg-rose-950/40 border border-rose-900/40">需化神后期</div>
          </div>

          <div v-if="status?.dharma_form.unlocked" class="space-y-2">
            <div class="text-xs text-stone-400">
              当前等级：<span class="text-amber-300 font-bold">{{ status.dharma_form.level }} / {{ status.dharma_form.max_level }}</span>
              ·  属性加成：<span class="text-emerald-300 font-bold">+{{ (status.dharma_form.attribute_bonus * 100).toFixed(0) }}%</span>
            </div>
            <div class="h-2 bg-stone-800 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-amber-700 to-amber-400 transition-all duration-500"
                :style="{ width: `${(status.dharma_form.level / status.dharma_form.max_level) * 100}%` }"></div>
            </div>
            <div v-if="status.dharma_form.level < status.dharma_form.max_level" class="text-xs text-stone-400 flex justify-between">
              <span>下一级消耗：</span>
              <span>修为 <span class="text-amber-300">{{ formatNumber(status.dharma_form.next_level_exp_cost) }}</span></span>
              <span>神识 <span class="text-cyan-300">{{ status.dharma_form.next_level_sense_cost }}</span></span>
            </div>
            <button @click="handleCultivateDharmaForm"
              :disabled="loading || status.dharma_form.level >= status.dharma_form.max_level"
              class="w-full py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-amber-950/40 border border-amber-700 text-amber-300 hover:bg-amber-900/40 hover:border-amber-500">
              <span v-if="loading">凝聚中...</span>
              <span v-else-if="status.dharma_form.level >= status.dharma_form.max_level">已达最高等级</span>
              <span v-else>凝聚法相</span>
            </button>
          </div>
          <div v-else class="text-xs text-stone-500 text-center py-2">
            境界达到 <span class="text-amber-400">化神后期</span> 后解锁
          </div>
        </section>

        <!-- 模块4：探寻裂缝 -->
        <section class="bg-[#292524] border border-stone-700 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-indigo-950/40 border border-indigo-700/40 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9.5 2a7.5 7.5 0 0 0 0 15 7.5 7.5 0 0 0 0-15z"/>
                  <path d="M14.5 9a7.5 7.5 0 0 1 0 15"/>
                </svg>
              </div>
              <div>
                <div class="text-sm font-bold text-indigo-300">探寻虚空裂缝</div>
                <div class="text-[10px] text-stone-500">探寻虚空裂缝，有几率获得稀有材料</div>
              </div>
            </div>
            <div v-if="!status?.fracture_explore.unlocked" class="text-[10px] text-rose-400 px-2 py-0.5 rounded bg-rose-950/40 border border-rose-900/40">需炼虚初期</div>
          </div>

          <div v-if="status?.fracture_explore.unlocked" class="space-y-2">
            <div class="text-xs text-stone-400 flex justify-between">
              <span>今日：<span class="text-stone-300">{{ status.fracture_explore.daily_count }} / {{ status.fracture_explore.daily_limit }}</span></span>
              <span>神识消耗：<span class="text-cyan-300">{{ status.fracture_explore.sense_cost }}</span></span>
            </div>
            <div v-if="status.fracture_explore.cooldown_remaining_sec > 0" class="text-[11px] text-amber-400">
              冷却中：剩余 {{ formatTime(status.fracture_explore.cooldown_remaining_sec) }}
            </div>
            <div v-if="lastFractureResult" class="text-xs p-2 rounded border"
              :class="lastFractureResult.rare_drop
                ? 'bg-amber-950/30 border-amber-800/50 text-amber-300'
                : (lastFractureResult.discovered
                  ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-300'
                  : 'bg-stone-900/40 border-stone-700 text-stone-400')">
              <div v-if="lastFractureResult.drop_item">
                {{ lastFractureResult.drop_item.name }} ×{{ lastFractureResult.drop_item.count }}
                <span class="text-[10px]">（{{ lastFractureResult.drop_item.rarity }}）</span>
              </div>
              <div v-else>未发现裂缝，但获得 {{ lastFractureResult.exp_reward }} 修为</div>
              <div class="text-[10px] mt-1">残魂 -{{ lastFractureResult.remnant_soul_cost.toFixed(2) }}</div>
            </div>
            <button @click="handleExploreFracture"
              :disabled="loading || !canExploreFracture"
              class="w-full py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-indigo-950/40 border border-indigo-700 text-indigo-300 hover:bg-indigo-900/40 hover:border-indigo-500">
              <span v-if="loading">探寻中...</span>
              <span v-else-if="status.fracture_explore.cooldown_remaining_sec > 0">冷却中</span>
              <span v-else-if="status.fracture_explore.daily_count >= status.fracture_explore.daily_limit">今日次数已用尽</span>
              <span v-else>探寻裂缝</span>
            </button>
          </div>
          <div v-else class="text-xs text-stone-500 text-center py-2">
            境界达到 <span class="text-amber-400">炼虚初期</span> 后解锁
          </div>
        </section>

        <!-- 模块5：夺舍重生 -->
        <section class="bg-[#292524] border border-rose-900/40 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-rose-950/40 border border-rose-700/40 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>
                </svg>
              </div>
              <div>
                <div class="text-sm font-bold text-rose-300">夺舍重生</div>
                <div class="text-[10px] text-stone-500">残魂过低时尝试夺舍，重置境界但保留部分修为</div>
              </div>
            </div>
            <div class="text-[10px] text-stone-500">成功率：<span class="text-amber-400">{{ (status?.reincarnation.success_rate * 100).toFixed(0) }}%</span></div>
          </div>

          <div class="space-y-2">
            <div class="text-xs text-stone-400">
              残魂值：<span :class="status?.remnant_soul.is_unstable ? 'text-rose-400 font-bold' : 'text-emerald-400'">
                {{ status?.remnant_soul.value.toFixed(1) }} / {{ status?.remnant_soul.max }}
              </span>
              <span v-if="status?.remnant_soul.is_unstable" class="text-rose-400 ml-1">（残魂不稳定！）</span>
              ·  自然恢复：{{ status?.remnant_soul.recovery_rate_per_hour }}/小时
            </div>
            <div v-if="status?.reincarnation.cooldown_remaining_sec > 0" class="text-[11px] text-amber-400">
              夺舍冷却中：剩余 {{ formatTime(status.reincarnation.cooldown_remaining_sec) }}
            </div>
            <button @click="confirmReincarnate"
              :disabled="loading || !status?.reincarnation.available || !status?.reincarnation.cooldown_ready"
              class="w-full py-2 rounded-lg text-xs font-bold tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-rose-950/40 border border-rose-700 text-rose-300 hover:bg-rose-900/40 hover:border-rose-500">
              <span v-if="loading">夺舍中...</span>
              <span v-else-if="!status?.reincarnation.available">残魂不足</span>
              <span v-else-if="!status?.reincarnation.cooldown_ready">冷却中</span>
              <span v-else>尝试夺舍重生</span>
            </button>
            <div class="text-[10px] text-stone-500 leading-relaxed">
              风险提示：成功则境界降为元婴初期保留 30% 修为；失败则残魂大幅下降且进入 2 小时虚弱状态。
            </div>
          </div>
        </section>
      </div>

      <!-- 底部操作栏 -->
      <div class="mt-4 flex gap-2">
        <button @click="handleRefresh"
          :disabled="loading"
          class="px-4 py-2.5 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors disabled:opacity-50">
          刷新状态
        </button>
        <button @click="$emit('close')"
          class="flex-1 py-2.5 rounded-lg font-bold tracking-widest text-sm transition-all bg-stone-900/40 border border-stone-700 text-stone-300 hover:bg-stone-800/40 hover:border-stone-500">
          关闭
        </button>
      </div>
    </div>

    <!-- 夺舍重生二次确认弹窗 -->
    <Modal :isOpen="reincarnateConfirmOpen" title="夺舍重生确认" width="500px" @close="reincarnateConfirmOpen = false">
      <div class="space-y-3 text-sm text-stone-300">
        <p class="text-rose-300 font-bold">此操作风险极高，请仔细确认！</p>
        <ul class="text-xs text-stone-400 space-y-1 list-disc pl-5">
          <li>当前残魂值：<span class="text-amber-300">{{ status?.remnant_soul.value.toFixed(1) }}</span></li>
          <li>夺舍成功率：<span class="text-amber-300">{{ (status?.reincarnation.success_rate * 100).toFixed(0) }}%</span></li>
          <li>成功：境界降为元婴初期，保留 30% 修为</li>
          <li>失败：残魂下降 30 点，进入 2 小时虚弱状态</li>
        </ul>
        <p class="text-xs text-amber-400">建议在残魂极低、无法继续修炼时再使用此功能。</p>
      </div>
      <template #footer>
        <button @click="reincarnateConfirmOpen = false"
          class="px-4 py-2 text-sm text-stone-400 hover:text-white border border-stone-700 hover:border-stone-500 rounded-lg transition-colors">
          取消
        </button>
        <button @click="handleReincarnate"
          :disabled="loading"
          class="px-4 py-2 text-sm font-bold text-rose-300 bg-rose-950/40 border border-rose-700 hover:bg-rose-900/40 rounded-lg transition-colors disabled:opacity-50">
          <span v-if="loading">执行中...</span>
          <span v-else>确认夺舍</span>
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { formatTime, formatNumber } from '../../utils/format'
import Modal from '../common/Modal.vue'
import {
  getStatus,
  startSoulOut,
  endSoulOut,
  askDao,
  cultivateDharmaForm,
  exploreFracture,
  reincarnate
} from '../../api/nascentSoul'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

const loading = ref(false)
const status = ref(null)
const lastFractureResult = ref(null)
const reincarnateConfirmOpen = ref(false)
// 当前时间 tick，用于驱动倒计时显示
const now = ref(Date.now())
let tickTimer = null

/**
 * 元婴出窍目标选项
 */
const soulOutTargets = [
  { value: 'explore', label: '探索', desc: '平衡收益' },
  { value: 'scout', label: '窥探', desc: '偏向情报' },
  { value: 'cultivate', label: '修炼', desc: '偏向修为' }
]

/**
 * 出窍表单
 */
const soulOutForm = ref({
  target: 'explore',
  duration_sec: 1800
})

/**
 * 出窍进度百分比（用于进度条显示）
 */
const soulOutProgress = computed(() => {
  if (!status.value?.soul_out || status.value.soul_out.state !== 'out') return 0
  const total = status.value.soul_out.duration || 1
  const remaining = status.value.soul_out.out_remaining_sec || 0
  return Math.max(0, Math.min(100, ((total - remaining) / total) * 100))
})

/**
 * 是否可以开始出窍
 */
const canStartSoulOut = computed(() => {
  if (!status.value?.soul_out) return false
  return status.value.soul_out.unlocked
    && status.value.soul_out.state !== 'out'
    && status.value.soul_out.cooldown_ready
    && status.value.soul_out.daily_count < status.value.soul_out.daily_limit
    && !status.value.weakness.is_weak
    && !status.value.remnant_soul.is_unstable
})

/**
 * 是否可以问道
 */
const canAskDao = computed(() => {
  if (!status.value?.ask_dao) return false
  return status.value.ask_dao.unlocked
    && status.value.ask_dao.cooldown_ready
    && status.value.ask_dao.daily_count < status.value.ask_dao.daily_limit
    && status.value.soul_out.state !== 'out'
})

/**
 * 是否可以探寻裂缝
 */
const canExploreFracture = computed(() => {
  if (!status.value?.fracture_explore) return false
  return status.value.fracture_explore.unlocked
    && status.value.fracture_explore.cooldown_ready
    && status.value.fracture_explore.daily_count < status.value.fracture_explore.daily_limit
    && status.value.soul_out.state !== 'out'
})

/**
 * 获取出窍目标中文标签
 */
const getSoulOutTargetLabel = (target) => {
  const item = soulOutTargets.find(t => t.value === target)
  return item ? item.label : target
}

/**
 * 拉取元婴系统状态
 */
const fetchStatus = async () => {
  try {
    const res = await getStatus()
    status.value = res.data?.data || res.data
  } catch (err) {
    console.error('获取元婴系统状态失败:', err)
    uiStore.showToast('获取元婴系统状态失败', 'error')
  }
}

/**
 * 开始元婴出窍
 */
const handleStartSoulOut = async () => {
  if (loading.value) return
  if (!canStartSoulOut.value) {
    uiStore.showToast('当前无法出窍', 'warning')
    return
  }
  loading.value = true
  try {
    const res = await startSoulOut({
      target: soulOutForm.value.target,
      duration_sec: soulOutForm.value.duration_sec
    })
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '出窍失败', 'warning')
    } else {
      uiStore.showToast(payload.message || '元婴出窍成功', 'success')
      uiStore.addLog({
        content: `元婴出窍，目标：${getSoulOutTargetLabel(soulOutForm.value.target)}，时长 ${formatTime(soulOutForm.value.duration_sec)}`,
        type: 'info',
        actorId: 'self'
      })
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '元婴出窍失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 召回元婴
 */
const handleEndSoulOut = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await endSoulOut()
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '召回失败', 'warning')
    } else {
      uiStore.showToast(payload.message || '元婴归来', 'success')
      uiStore.addLog({
        content: `元婴归来，获得修为 ${payload.data?.exp_reward || 0}，消耗残魂 ${(payload.data?.remnant_soul_cost || 0).toFixed(2)}`,
        type: 'success',
        actorId: 'self'
      })
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '召回元婴失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 问道
 */
const handleAskDao = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await askDao()
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '问道失败', 'warning')
    } else {
      uiStore.showToast(payload.message || '问道成功', 'success')
      uiStore.addLog({
        content: `${payload.data?.event || '向天道问道'}，获得感悟 ${payload.data?.insight_gain?.toFixed(2) || 0}`,
        type: 'info',
        actorId: 'self'
      })
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '问道失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 凝聚法相天地
 */
const handleCultivateDharmaForm = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await cultivateDharmaForm()
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '凝聚失败', 'warning')
    } else {
      uiStore.showToast(payload.message || '法相凝聚成功', 'success')
      uiStore.addLog({
        content: `法相天地突破至第 ${payload.data?.level} 层，属性加成 +${((payload.data?.attribute_bonus || 0) * 100).toFixed(0)}%`,
        type: 'success',
        actorId: 'self'
      })
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '法相凝聚失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 探寻虚空裂缝
 */
const handleExploreFracture = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await exploreFracture()
    const payload = res.data
    if (payload.success === false) {
      uiStore.showToast(payload.message || '探寻失败', 'warning')
    } else {
      uiStore.showToast(payload.message || '探寻完成', payload.data?.rare_drop ? 'success' : 'info')
      uiStore.addLog({
        content: payload.message,
        type: payload.data?.rare_drop ? 'success' : 'info',
        actorId: 'self'
      })
      lastFractureResult.value = payload.data
      await fetchStatus()
    }
  } catch (err) {
    const msg = err?.response?.data?.message || '探寻裂缝失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 弹出夺舍重生二次确认弹窗
 */
const confirmReincarnate = () => {
  if (loading.value) return
  if (!status.value?.reincarnation.available) {
    uiStore.showToast('残魂不足，无法夺舍', 'warning')
    return
  }
  if (!status.value?.reincarnation.cooldown_ready) {
    uiStore.showToast('夺舍冷却中', 'warning')
    return
  }
  reincarnateConfirmOpen.value = true
}

/**
 * 执行夺舍重生
 */
const handleReincarnate = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await reincarnate()
    const payload = res.data
    reincarnateConfirmOpen.value = false
    if (payload.success === false) {
      uiStore.showToast(payload.message || '夺舍失败', 'error')
      uiStore.addLog({
        content: payload.message,
        type: 'error',
        actorId: 'self'
      })
    } else {
      uiStore.showToast(payload.message || '夺舍成功', 'success')
      uiStore.addLog({
        content: payload.message,
        type: 'success',
        actorId: 'self'
      })
    }
    await fetchStatus()
  } catch (err) {
    const msg = err?.response?.data?.message || '夺舍失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 手动刷新状态
 */
const handleRefresh = async () => {
  await fetchStatus()
  uiStore.showToast('状态已刷新', 'info')
}

onMounted(() => {
  fetchStatus()
  // 每秒更新 now 用于驱动倒计时显示（前端只是显示用，权威值仍在后端）
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})
</script>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
</style>
