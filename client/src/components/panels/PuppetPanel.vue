<template>
  <!--
    傀儡工坊面板（玩法文档第23节·大衍诀与傀儡路线）
    - 3 Tab：工坊（傀儡列表+操作）/ 制造（图谱参悟+制造傀儡）/ 说明
    - 业务逻辑全部在后端 PuppetService 中处理，前端仅展示与接口调用
    - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
    - 核心交互：参悟图谱 → 制造傀儡 → 出战/护法/淬炼/维修/回收
  -->
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm" @click.self="emit('close')">
    <div class="relative w-full max-w-4xl max-h-[92vh] mx-4 bg-gradient-to-b from-[#1c1917] to-[#0c0a09] border border-amber-900/50 rounded-2xl shadow-2xl shadow-amber-900/30 flex flex-col">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-amber-900/40 shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-amber-600 to-stone-700 flex items-center justify-center shadow-lg shadow-amber-900/50">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-amber-100">
              <path d="M12 2v4"/><path d="M12 18v4"/><circle cx="12" cy="12" r="3"/>
              <path d="M5 7l2 2"/><path d="M17 15l2 2"/><path d="M5 17l2-2"/><path d="M17 9l2-2"/>
            </svg>
          </div>
          <div>
            <h2 class="text-xl font-bold text-amber-200 tracking-wider">傀儡工坊</h2>
            <p class="text-[11px] text-stone-500">大衍诀·控傀 · 制造出战护法 · 淬炼维修回收</p>
          </div>
        </div>
        <button @click="emit('close')" class="text-stone-400 hover:text-rose-400 transition-colors w-8 h-8 flex items-center justify-center rounded-full hover:bg-rose-900/30">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- 大衍诀层数提示条 -->
      <div v-if="workshop" class="px-6 py-2 bg-amber-950/20 border-b border-amber-900/30 flex items-center justify-between text-[11px] shrink-0">
        <span class="text-stone-400">
          大衍诀层数：<span class="text-indigo-300 font-bold">{{ workshop.dayan_level }}</span>
          <span class="text-stone-600">/ 最低需 {{ workshop.min_dayan_level }} 层·控傀</span>
        </span>
        <span class="text-stone-400">
          傀儡：<span class="text-amber-300 font-bold">{{ workshop.puppet_count }}</span>
          <span class="text-stone-600">/ {{ workshop.max_puppets }}</span>
          <span class="text-stone-600 mx-1">|</span>
          出战加成 <span class="text-emerald-300 font-bold">{{ (workshop.battle_stat_ratio * 100).toFixed(0) }}%</span>
          <span class="text-stone-600 mx-1">|</span>
          护法反击 <span class="text-rose-300 font-bold">{{ (workshop.guard_counter_ratio * 100).toFixed(0) }}%</span>
        </span>
      </div>

      <!-- Tab 栏 -->
      <div class="flex border-b border-amber-900/40 shrink-0">
        <button v-for="tab in tabs" :key="tab.id" @click="switchTab(tab.id)"
          :class="['flex-1 px-4 py-3 text-sm font-bold tracking-wider transition-all relative',
                   activeTab === tab.id ? 'text-amber-200 bg-amber-900/20' : 'text-stone-500 hover:text-stone-300']">
          {{ tab.name }}
        </button>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto p-6">
        <!-- 加载态 -->
        <div v-if="loading && activeTab !== 'guide'" class="text-center py-10 text-stone-500">查询中...</div>

        <!-- ========== Tab 1: 工坊（傀儡列表） ========== -->
        <div v-else-if="activeTab === 'workshop'">
          <!-- 未解锁提示 -->
          <div v-if="workshop && workshop.dayan_level < workshop.min_dayan_level" class="text-center py-12">
            <div class="text-4xl mb-3 opacity-50">🔒</div>
            <div class="text-sm text-rose-300 mb-1">大衍诀层数不足，傀儡工坊尚未解锁</div>
            <div class="text-[11px] text-stone-500">需将大衍诀修至第三层·控傀方可开启傀儡制造</div>
          </div>

          <!-- 空列表提示 -->
          <div v-else-if="workshop && workshop.puppets.length === 0" class="text-center py-12 text-stone-500 text-sm">
            <div class="text-4xl mb-3 opacity-40">⚙</div>
            <p>工坊中尚无傀儡</p>
            <p class="text-[11px] mt-1">请前往「制造」Tab 参悟图谱并制造你的第一具傀儡</p>
          </div>

          <!-- 傀儡卡片列表 -->
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div v-for="p in workshop.puppets" :key="p.id"
                 :class="['rounded-xl border p-4 transition-all',
                          p.status === 'battle' ? 'bg-emerald-950/20 border-emerald-700/50 shadow-lg shadow-emerald-900/20'
                          : p.status === 'guard' ? 'bg-rose-950/20 border-rose-700/50 shadow-lg shadow-rose-900/20'
                          : 'bg-stone-900/50 border-stone-700/50']">
              <!-- 卡片头部：名称 + 状态 -->
              <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-2">
                  <span class="w-8 h-8 rounded flex items-center justify-center text-xs font-bold"
                        :class="qualityBgClass(p.quality)">★</span>
                  <div>
                    <div class="text-sm font-bold" :class="qualityTextClass(p.quality)">{{ p.name }}</div>
                    <div class="text-[10px] text-stone-500">Lv.{{ p.level }} · {{ qualityLabel(p.quality) }}</div>
                  </div>
                </div>
                <!-- 状态徽章 -->
                <span v-if="p.status === 'battle'" class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-800/60 text-emerald-200">出战中</span>
                <span v-else-if="p.status === 'guard'" class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-800/60 text-rose-200">护法中</span>
                <span v-else class="px-2 py-0.5 rounded text-[10px] font-bold bg-stone-700/60 text-stone-400">闲置</span>
              </div>

              <!-- 属性栏 -->
              <div class="grid grid-cols-4 gap-2 mb-3 text-center">
                <div class="bg-stone-950/40 rounded-lg py-1.5">
                  <div class="text-[9px] text-stone-500">攻击</div>
                  <div class="text-xs font-bold text-rose-300">{{ p.atk }}</div>
                </div>
                <div class="bg-stone-950/40 rounded-lg py-1.5">
                  <div class="text-[9px] text-stone-500">防御</div>
                  <div class="text-xs font-bold text-cyan-300">{{ p.def }}</div>
                </div>
                <div class="bg-stone-950/40 rounded-lg py-1.5">
                  <div class="text-[9px] text-stone-500">气血</div>
                  <div class="text-xs font-bold text-emerald-300">{{ p.hp }}</div>
                </div>
                <div class="bg-stone-950/40 rounded-lg py-1.5">
                  <div class="text-[9px] text-stone-500">速度</div>
                  <div class="text-xs font-bold text-amber-300">{{ p.speed }}</div>
                </div>
              </div>

              <!-- 耐久度条 -->
              <div class="mb-3">
                <div class="flex items-center justify-between text-[10px] mb-1">
                  <span class="text-stone-500">耐久度</span>
                  <span :class="p.durability <= 20 ? 'text-rose-400' : 'text-stone-400'">{{ p.durability }} / {{ p.max_durability }}</span>
                </div>
                <div class="w-full h-2 bg-stone-950 rounded-full overflow-hidden border border-stone-800">
                  <div class="h-full rounded-full transition-all duration-500"
                       :class="p.durability <= 20 ? 'bg-rose-600' : p.durability <= 50 ? 'bg-amber-600' : 'bg-emerald-600'"
                       :style="{ width: (p.durability / p.max_durability * 100) + '%' }"></div>
                </div>
              </div>

              <!-- 操作按钮组 -->
              <div class="grid grid-cols-2 gap-2">
                <!-- 出战/取消出战 -->
                <button v-if="p.status !== 'battle'" @click="handleSetBattle(p)"
                  :disabled="p.durability <= 0 || actionLoading === p.id"
                  :class="['px-2 py-1.5 rounded text-[11px] font-bold transition-all',
                           p.durability <= 0 ? 'bg-stone-800 text-stone-600 cursor-not-allowed'
                           : 'bg-emerald-800/60 hover:bg-emerald-700/60 text-emerald-200']">
                  {{ actionLoading === p.id ? '...' : '出战' }}
                </button>
                <button v-else @click="handleUnset(p)" :disabled="actionLoading === p.id"
                  class="px-2 py-1.5 rounded text-[11px] font-bold bg-stone-700 hover:bg-stone-600 text-stone-200 transition-all">
                  {{ actionLoading === p.id ? '...' : '取消出战' }}
                </button>

                <!-- 护法/取消护法 -->
                <button v-if="p.status !== 'guard'" @click="handleSetGuard(p)"
                  :disabled="p.durability <= 0 || actionLoading === p.id"
                  :class="['px-2 py-1.5 rounded text-[11px] font-bold transition-all',
                           p.durability <= 0 ? 'bg-stone-800 text-stone-600 cursor-not-allowed'
                           : 'bg-rose-800/60 hover:bg-rose-700/60 text-rose-200']">
                  {{ actionLoading === p.id ? '...' : '护法' }}
                </button>
                <button v-else @click="handleUnset(p)" :disabled="actionLoading === p.id"
                  class="px-2 py-1.5 rounded text-[11px] font-bold bg-stone-700 hover:bg-stone-600 text-stone-200 transition-all">
                  {{ actionLoading === p.id ? '...' : '取消护法' }}
                </button>

                <!-- 淬炼 -->
                <button @click="openQuenchConfirm(p)"
                  :disabled="p.level >= workshop.quench_config.max_level || p.durability <= 0 || actionLoading === p.id"
                  :class="['px-2 py-1.5 rounded text-[11px] font-bold transition-all',
                           (p.level >= workshop.quench_config.max_level || p.durability <= 0) ? 'bg-stone-800 text-stone-600 cursor-not-allowed'
                           : 'bg-indigo-800/60 hover:bg-indigo-700/60 text-indigo-200']">
                  淬炼
                </button>

                <!-- 维修 -->
                <button @click="handleRepair(p)"
                  :disabled="p.durability >= p.max_durability || actionLoading === p.id"
                  :class="['px-2 py-1.5 rounded text-[11px] font-bold transition-all',
                           p.durability >= p.max_durability ? 'bg-stone-800 text-stone-600 cursor-not-allowed'
                           : 'bg-amber-800/60 hover:bg-amber-700/60 text-amber-200']">
                  {{ actionLoading === p.id ? '...' : '维修' }}
                </button>

                <!-- 回收（仅闲置可回收） -->
                <button @click="openRecyclePreview(p)"
                  :disabled="p.status !== 'idle' || actionLoading === p.id"
                  :class="['col-span-2 px-2 py-1.5 rounded text-[11px] font-bold transition-all',
                           p.status !== 'idle' ? 'bg-stone-800 text-stone-600 cursor-not-allowed'
                           : 'bg-stone-700/60 hover:bg-rose-800/60 text-stone-400 hover:text-rose-200']">
                  回收
                </button>
              </div>

              <!-- 耐久度为0警告 -->
              <div v-if="p.durability <= 0" class="mt-2 text-center text-[10px] text-rose-400">
                ⚠ 耐久度为0，无法出战/护法/淬炼，请先维修
              </div>
            </div>
          </div>
        </div>

        <!-- ========== Tab 2: 制造（图谱参悟 + 制造傀儡） ========== -->
        <div v-else-if="activeTab === 'manufacture'">
          <div v-if="!workshop" class="text-center py-12 text-stone-500 text-sm">数据加载中...</div>
          <div v-else class="space-y-5">
            <!-- 已学图谱区 -->
            <div v-if="workshop.blueprints.length > 0">
              <h3 class="text-sm font-bold text-amber-200 mb-2">◆ 已参悟图谱（{{ workshop.blueprints.length }}）</h3>
              <div class="flex flex-wrap gap-2">
                <span v-for="bp in workshop.blueprints" :key="bp.blueprint_key"
                      class="px-3 py-1 rounded-full text-[11px] bg-violet-900/30 border border-violet-700/40 text-violet-200">
                  {{ bp.blueprint_name }}
                </span>
              </div>
            </div>

            <!-- 可制造傀儡列表 -->
            <div>
              <h3 class="text-sm font-bold text-amber-200 mb-3">◆ 傀儡制造</h3>
              <div class="space-y-3">
                <div v-for="m in workshop.manufacturable" :key="m.puppet_type"
                     :class="['rounded-xl border p-4 transition-all',
                              m.can_manufacture ? 'bg-stone-900/50 border-amber-700/40'
                              : 'bg-stone-900/30 border-stone-800 opacity-60']">
                  <div class="flex items-start justify-between mb-2">
                    <div class="flex items-center gap-2">
                      <span class="w-8 h-8 rounded flex items-center justify-center text-xs font-bold"
                            :class="qualityBgClass(m.quality)">★</span>
                      <div>
                        <div class="text-sm font-bold" :class="qualityTextClass(m.quality)">{{ m.name }}</div>
                        <div class="text-[10px] text-stone-500">{{ m.description }}</div>
                      </div>
                    </div>
                    <!-- 条件状态 -->
                    <div class="text-right text-[10px]">
                      <div :class="m.dayan_met ? 'text-emerald-300' : 'text-rose-400'">
                        {{ m.dayan_met ? '✓' : '✕' }} 大衍诀 {{ m.required_dayan_level }} 层
                      </div>
                      <div :class="m.has_blueprint ? 'text-emerald-300' : 'text-rose-400'">
                        {{ m.has_blueprint ? '✓' : '✕' }} 已参悟图谱
                      </div>
                    </div>
                  </div>

                  <!-- 基础属性 -->
                  <div class="grid grid-cols-4 gap-2 mb-2 text-center text-[11px]">
                    <div class="bg-stone-950/40 rounded px-1 py-1"><span class="text-stone-500">攻</span> <span class="text-rose-300 font-bold">{{ m.base_stats.atk }}</span></div>
                    <div class="bg-stone-950/40 rounded px-1 py-1"><span class="text-stone-500">防</span> <span class="text-cyan-300 font-bold">{{ m.base_stats.def }}</span></div>
                    <div class="bg-stone-950/40 rounded px-1 py-1"><span class="text-stone-500">血</span> <span class="text-emerald-300 font-bold">{{ m.base_stats.hp }}</span></div>
                    <div class="bg-stone-950/40 rounded px-1 py-1"><span class="text-stone-500">速</span> <span class="text-amber-300 font-bold">{{ m.base_stats.speed }}</span></div>
                  </div>

                  <!-- 制造消耗 -->
                  <div class="bg-stone-950/40 rounded-lg p-2 mb-2 text-[11px]">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-stone-500">制造消耗</span>
                      <span class="text-stone-600">图谱来源：{{ m.blueprint_source }}</span>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <span class="text-amber-300">灵石 {{ formatBigNumber(m.manufacture_cost.spirit_stone) }}</span>
                      <span v-for="(qty, mat) in m.manufacture_cost.materials" :key="mat" class="text-stone-400">
                        {{ materialName(mat) }} ×{{ qty }}
                      </span>
                    </div>
                  </div>

                  <!-- 操作按钮 -->
                  <div class="flex gap-2">
                    <!-- 参悟图谱按钮（未参悟时显示） -->
                    <button v-if="!m.has_blueprint" @click="openLearnConfirm(m)"
                      :disabled="actionLoading === ('learn_' + m.puppet_type)"
                      class="flex-1 px-3 py-2 rounded-lg text-[11px] font-bold bg-violet-800/60 hover:bg-violet-700/60 text-violet-200 transition-all">
                      {{ actionLoading === ('learn_' + m.puppet_type) ? '参悟中...' : '参悟图谱' }}
                    </button>
                    <!-- 制造按钮 -->
                    <button v-if="m.has_blueprint" @click="openManufactureConfirm(m)"
                      :disabled="!m.can_manufacture || actionLoading === ('mfg_' + m.puppet_type)"
                      :class="['flex-1 px-3 py-2 rounded-lg text-[11px] font-bold transition-all',
                               m.can_manufacture ? 'bg-gradient-to-r from-amber-700 to-stone-700 hover:from-amber-600 hover:to-stone-600 text-amber-100'
                               : 'bg-stone-800 text-stone-600 cursor-not-allowed']">
                      {{ actionLoading === ('mfg_' + m.puppet_type) ? '制造中...' : (m.can_manufacture ? '制造傀儡' : '条件未满足') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ========== Tab 3: 玩法说明 ========== -->
        <div v-else-if="activeTab === 'guide'" class="space-y-4 text-sm text-stone-300 leading-relaxed">
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-amber-300 font-bold mb-2">◆ 傀儡工坊简介</h3>
            <p class="text-stone-400 text-[13px]">傀儡工坊是大衍诀第三层·控傀解锁的后期系统。玩家通过参悟图谱、消耗材料制造傀儡，为PVP/PVE战斗提供属性加成，或设置护法在闭关被袭时自动反击。傀儡可通过淬炼提升等级、维修恢复耐久、回收返还材料。</p>
          </div>
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-amber-300 font-bold mb-2">◆ 五种傀儡</h3>
            <ul class="text-stone-400 text-[13px] space-y-1">
              <li>· <span class="text-stone-200">机关木傀</span>（稀有）：入门傀儡，属性均衡，大衍诀3层解锁</li>
              <li>· <span class="text-stone-200">铁甲战傀</span>（史诗）：重装防御型，防御极高，大衍诀3层解锁</li>
              <li>· <span class="text-stone-200">五行灵傀</span>（史诗）：法术型傀儡，攻防兼备，大衍诀3层解锁</li>
              <li>· <span class="text-stone-200">影傀</span>（传说）：速度极快，擅长突袭，大衍诀4层·千机解锁</li>
              <li>· <span class="text-stone-200">大衍灵傀</span>（神话）：终极傀儡，全属性卓越，大衍诀5层·衍神解锁</li>
            </ul>
          </div>
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-amber-300 font-bold mb-2">◆ 图谱获取</h3>
            <ul class="text-stone-400 text-[13px] space-y-1">
              <li>· 机关木傀图谱：LDC商城购买 / 基础副本掉落</li>
              <li>· 铁甲战傀图谱：昆吾山·封魔塔副本掉落</li>
              <li>· 五行灵傀图谱：苍坤洞府副本掉落</li>
              <li>· 影傀图谱：虚天殿副本 / 玄骨高阶分支掉落</li>
              <li>· 大衍灵傀图谱：青元子世界Boss掉落（极稀有）</li>
            </ul>
            <p class="text-[11px] text-stone-500 mt-2">获得图谱物品后，在「制造」Tab 参悟图谱即可解锁对应傀儡的制造权限。</p>
          </div>
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-amber-300 font-bold mb-2">◆ 出战与护法</h3>
            <ul class="text-stone-400 text-[13px] space-y-1">
              <li>· <span class="text-emerald-300">出战傀儡</span>：PVP/PVE战斗中提供 <span class="text-emerald-300 font-bold">30%</span> 属性加成（攻防血速）</li>
              <li>· <span class="text-rose-300">护法傀儡</span>：闭关被袭击时自动反击，造成 <span class="text-rose-300 font-bold">50%</span> 攻击力伤害</li>
              <li>· 同时只能设置 1 个出战 + 1 个护法傀儡</li>
              <li>· 耐久度为0时无法出战/护法，需先维修</li>
            </ul>
          </div>
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-amber-300 font-bold mb-2">◆ 淬炼与维修</h3>
            <ul class="text-stone-400 text-[13px] space-y-1">
              <li>· <span class="text-indigo-300">淬炼</span>：消耗灵石+机关核心提升等级，属性按 8%/级 增长（速度3%/级）</li>
              <li>· 淬炼成功率随等级递减（100% → 50%下限），失败材料消耗但等级不变</li>
              <li>· 每次淬炼成功消耗 2 点耐久</li>
              <li>· <span class="text-amber-300">维修</span>：消耗灵石（50/点）+机关核心×1，恢复满耐久</li>
              <li>· 最高等级 20 级</li>
            </ul>
          </div>
          <div class="bg-stone-900/50 border border-stone-700/50 rounded-xl p-4">
            <h3 class="text-amber-300 font-bold mb-2">◆ 回收机制</h3>
            <ul class="text-stone-400 text-[13px] space-y-1">
              <li>· 仅闲置状态傀儡可回收，出战/护法中需先取消</li>
              <li>· 材料返还率 <span class="text-amber-300">50%</span>，灵石返还率 <span class="text-amber-300">30%</span>（含淬炼投入）</li>
              <li>· 回收需二次确认，先预览返还再执行</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 底部刷新 -->
      <div class="px-6 py-3 border-t border-amber-900/40 shrink-0 text-center">
        <button @click="loadData" class="text-xs text-stone-500 hover:text-amber-300 transition-colors">
          ↻ 刷新数据
        </button>
      </div>
    </div>

    <!-- 参悟图谱确认 Modal -->
    <Modal :isOpen="learnConfirmShow" @close="learnConfirmShow = false" title="确认参悟图谱" width="420px">
      <div class="space-y-3 text-sm text-stone-300">
        <p>即将参悟图谱，本次将消耗：</p>
        <div class="bg-stone-950/50 rounded-lg p-3 space-y-1 text-[13px]">
          <div class="flex justify-between">
            <span class="text-stone-500">消耗物品</span>
            <span class="text-violet-300 font-bold">{{ pendingLearn?.name }}图谱 ×1</span>
          </div>
          <div class="flex justify-between">
            <span class="text-stone-500">解锁制造</span>
            <span class="text-amber-300 font-bold">{{ pendingLearn?.name }}</span>
          </div>
        </div>
        <p class="text-[11px] text-stone-500">参悟后图谱物品将被消耗，解锁对应傀儡的制造权限。</p>
      </div>
      <template #footer>
        <button @click="learnConfirmShow = false" class="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 transition-colors">取消</button>
        <button @click="executeLearn" :disabled="actionLoading === ('learn_' + pendingLearn?.puppet_type)"
          class="px-4 py-2 text-sm bg-violet-700 hover:bg-violet-600 text-violet-100 rounded-lg font-bold transition-colors disabled:opacity-50">
          {{ actionLoading === ('learn_' + pendingLearn?.puppet_type) ? '参悟中...' : '确认参悟' }}
        </button>
      </template>
    </Modal>

    <!-- 制造傀儡确认 Modal -->
    <Modal :isOpen="mfgConfirmShow" @close="mfgConfirmShow = false" title="确认制造傀儡" width="440px">
      <div class="space-y-3 text-sm text-stone-300">
        <p>即将制造 <span class="text-amber-300 font-bold">{{ pendingMfg?.name }}</span>，本次将消耗：</p>
        <div class="bg-stone-950/50 rounded-lg p-3 space-y-1 text-[13px]">
          <div class="flex justify-between">
            <span class="text-stone-500">灵石</span>
            <span class="text-amber-300 font-bold">{{ formatBigNumber(pendingMfg?.manufacture_cost.spirit_stone) }}</span>
          </div>
          <div v-for="(qty, mat) in pendingMfg?.manufacture_cost.materials" :key="mat" class="flex justify-between">
            <span class="text-stone-500">{{ materialName(mat) }}</span>
            <span class="text-rose-300 font-bold">×{{ qty }}</span>
          </div>
        </div>
        <div class="bg-amber-950/30 border border-amber-800/40 rounded-lg p-3 text-[12px] text-amber-200">
          ⚠ 制造消耗不可退还，请确认材料充足后继续。
        </div>
      </div>
      <template #footer>
        <button @click="mfgConfirmShow = false" class="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 transition-colors">取消</button>
        <button @click="executeManufacture" :disabled="actionLoading === ('mfg_' + pendingMfg?.puppet_type)"
          class="px-4 py-2 text-sm bg-gradient-to-r from-amber-700 to-stone-700 hover:from-amber-600 hover:to-stone-600 text-amber-100 rounded-lg font-bold transition-colors disabled:opacity-50">
          {{ actionLoading === ('mfg_' + pendingMfg?.puppet_type) ? '制造中...' : '确认制造' }}
        </button>
      </template>
    </Modal>

    <!-- 淬炼确认 Modal -->
    <Modal :isOpen="quenchConfirmShow" @close="quenchConfirmShow = false" title="确认淬炼傀儡" width="420px">
      <div class="space-y-3 text-sm text-stone-300">
        <p>即将淬炼 <span class="text-indigo-300 font-bold">{{ pendingQuench?.name }}</span>（当前 Lv.{{ pendingQuench?.level }}）</p>
        <div class="bg-stone-950/50 rounded-lg p-3 space-y-1 text-[13px]">
          <div class="flex justify-between">
            <span class="text-stone-500">消耗灵石</span>
            <span class="text-amber-300 font-bold">{{ quenchCostStones }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-stone-500">消耗机关核心</span>
            <span class="text-rose-300 font-bold">×1</span>
          </div>
          <div class="flex justify-between">
            <span class="text-stone-500">耐久消耗</span>
            <span class="text-stone-300">-2</span>
          </div>
        </div>
        <div class="bg-indigo-950/30 border border-indigo-800/40 rounded-lg p-3 text-[12px] text-indigo-200">
          ⚠ 淬炼存在失败风险，失败时材料消耗但等级不变。成功率随等级递减。
        </div>
      </div>
      <template #footer>
        <button @click="quenchConfirmShow = false" class="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 transition-colors">取消</button>
        <button @click="executeQuench" :disabled="actionLoading === pendingQuench?.id"
          class="px-4 py-2 text-sm bg-indigo-700 hover:bg-indigo-600 text-indigo-100 rounded-lg font-bold transition-colors disabled:opacity-50">
          {{ actionLoading === pendingQuench?.id ? '淬炼中...' : '确认淬炼' }}
        </button>
      </template>
    </Modal>

    <!-- 回收预览 Modal -->
    <Modal :isOpen="recyclePreviewShow" @close="recyclePreviewShow = false" title="回收预览" width="440px">
      <div v-if="recycleData" class="space-y-3 text-sm text-stone-300">
        <p>即将回收 <span class="text-rose-300 font-bold">{{ recycleData.puppet_name }}</span>（Lv.{{ recycleData.level }}）</p>
        <div class="bg-stone-950/50 rounded-lg p-3 space-y-1 text-[13px]">
          <div class="text-stone-500 mb-1">返还材料（{{ (recycleData.material_return_rate * 100).toFixed(0) }}% 返还率）：</div>
          <div v-if="Object.keys(recycleData.material_returns).length === 0" class="text-stone-600 text-center py-1">无材料返还</div>
          <div v-for="(qty, mat) in recycleData.material_returns" :key="mat" class="flex justify-between">
            <span class="text-stone-400">{{ materialName(mat) }}</span>
            <span class="text-emerald-300 font-bold">×{{ qty }}</span>
          </div>
          <div class="border-t border-stone-800 mt-2 pt-2 flex justify-between">
            <span class="text-stone-500">返还灵石（{{ (recycleData.spirit_stone_return_rate * 100).toFixed(0) }}% 返还率）</span>
            <span class="text-amber-300 font-bold">{{ formatBigNumber(recycleData.spirit_stone_return) }}</span>
          </div>
        </div>
        <div class="bg-rose-950/30 border border-rose-800/40 rounded-lg p-3 text-[12px] text-rose-200">
          ⚠ 回收后傀儡将被永久销毁，此操作不可撤销！
        </div>
      </div>
      <template #footer>
        <button @click="recyclePreviewShow = false" class="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 transition-colors">取消</button>
        <button @click="executeRecycle" :disabled="actionLoading === recycleData?.puppet_id"
          class="px-4 py-2 text-sm bg-rose-800 hover:bg-rose-700 text-rose-100 rounded-lg font-bold transition-colors disabled:opacity-50">
          {{ actionLoading === recycleData?.puppet_id ? '回收中...' : '确认回收' }}
        </button>
      </template>
    </Modal>

    <!-- 操作结果 Modal -->
    <Modal :isOpen="resultShow" @close="resultShow = false" :title="resultData?.title || '操作结果'" width="400px">
      <div class="space-y-3 text-sm text-stone-300 text-center">
        <div class="text-4xl py-2">{{ resultData?.icon || '✦' }}</div>
        <div :class="['text-base font-bold', resultData?.success ? 'text-emerald-300' : 'text-rose-400']">{{ resultData?.message }}</div>
        <div v-if="resultData?.details" class="bg-stone-950/50 rounded-lg p-3 space-y-1 text-[13px] text-left">
          <div v-for="(val, key) in resultData.details" :key="key" class="flex justify-between">
            <span class="text-stone-500">{{ key }}</span>
            <span class="text-stone-300 font-bold">{{ val }}</span>
          </div>
        </div>
      </div>
      <template #footer>
        <button @click="resultShow = false" class="px-4 py-2 text-sm bg-amber-700 hover:bg-amber-600 text-amber-100 rounded-lg font-bold transition-colors">知道了</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * 傀儡工坊面板
 *
 * 功能职责：
 *   - 展示玩家所有傀儡（属性/耐久/状态）+ 操作（出战/护法/淬炼/维修/回收）
 *   - 展示已学图谱 + 可制造列表 + 参悟图谱/制造傀儡操作
 *   - 系统玩法说明
 *
 * 设计原则：后端计算，前端只渲染与接口调用
 *   - 不在前端计算属性/成功率/返还值，全部以后端返回为准
 *   - 状态变更后调用 loadData 刷新权威数据
 *   - 所有操作均通过自定义 Modal 二次确认（禁用浏览器原生 alert/confirm）
 *
 * 玩法文档对照：xiuxian_game_guide.md 第23节·大衍诀与傀儡路线
 */
import { ref, computed, onMounted } from 'vue'
import Modal from '../common/Modal.vue'
import { useUIStore } from '../../stores/ui'
import {
  getWorkshop,
  learnBlueprint,
  manufacture,
  setBattle,
  setGuard,
  unsetRole,
  quench,
  repair,
  recyclePreview,
  recycle
} from '../../api/puppet'

// 运行时声明 emit
const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ===== Tab 管理 =====
const tabs = [
  { id: 'workshop', name: '工坊' },
  { id: 'manufacture', name: '制造' },
  { id: 'guide', name: '说明' }
]
const activeTab = ref('workshop')

// ===== 数据 =====
const workshop = ref(null)
const loading = ref(false)
// 当前操作的傀儡/制造项ID，用于按钮 loading 状态
const actionLoading = ref(null)

// ===== Modal 状态 =====
const learnConfirmShow = ref(false)
const pendingLearn = ref(null)       // 待参悟的制造项
const mfgConfirmShow = ref(false)
const pendingMfg = ref(null)          // 待制造的制造项
const quenchConfirmShow = ref(false)
const pendingQuench = ref(null)       // 待淬炼的傀儡
const recyclePreviewShow = ref(false)
const recycleData = ref(null)         // 回收预览数据
const resultShow = ref(false)
const resultData = ref(null)          // 操作结果

// ===== 材料名称映射（UI 展示用，材料 ID 来源于后端 puppet_data.json 配置） =====
const materialNameMap = {
  mechanism_core: '机关核心',
  iron_armor_piece: '铁甲片',
  five_element_crystal: '五行灵晶',
  shadow_stone: '影石',
  dayan_spirit_crystal: '大衍灵晶',
  soul_nurturing_wood: '万年养魂木',
  ancient_soul_wood: '上古养魂木'
}

// ===== 计算属性 =====
/** 淬炼消耗灵石（base + per_level × current_level） */
const quenchCostStones = computed(() => {
  if (!pendingQuench.value || !workshop.value) return 0
  const qCfg = workshop.value.quench_config
  const lvl = pendingQuench.value.level
  return qCfg.cost_per_level.spirit_stone_base + qCfg.cost_per_level.spirit_stone_per_level * lvl
})

// ===== 工具方法 =====
/** 格式化大数字（BigInt 安全） */
const formatBigNumber = (val) => {
  if (val === null || val === undefined) return '0'
  const str = String(val)
  if (str.length <= 4) return str
  // 保留前3位有效数字 + 万/亿单位
  const num = Number(str)
  if (num >= 1e8) return (num / 1e8).toFixed(2) + '亿'
  if (num >= 1e4) return (num / 1e4).toFixed(1) + '万'
  return str
}

/** 材料名称（根据 material ID 查找中文名） */
const materialName = (matKey) => {
  return materialNameMap[matKey] || matKey
}

/** 品质标签 */
const qualityLabel = (quality) => {
  const map = { common: '普通', uncommon: '精良', rare: '稀有', epic: '史诗', legendary: '传说', mythic: '神话' }
  return map[quality] || quality
}

/** 品质背景色 class */
const qualityBgClass = (quality) => {
  const map = {
    common: 'bg-stone-600 text-stone-200',
    uncommon: 'bg-green-800 text-green-200',
    rare: 'bg-blue-800 text-blue-200',
    epic: 'bg-purple-800 text-purple-200',
    legendary: 'bg-amber-700 text-amber-100',
    mythic: 'bg-gradient-to-br from-amber-500 to-rose-600 text-white'
  }
  return map[quality] || 'bg-stone-600 text-stone-200'
}

/** 品质文字色 class */
const qualityTextClass = (quality) => {
  const map = {
    common: 'text-stone-300',
    uncommon: 'text-green-300',
    rare: 'text-blue-300',
    epic: 'text-purple-300',
    legendary: 'text-amber-300',
    mythic: 'text-amber-200'
  }
  return map[quality] || 'text-stone-300'
}

// ===== 数据加载 =====
/**
 * 加载工坊数据
 * 调用 GET /puppet/workshop 获取玩家傀儡+图谱+可制造列表
 */
const loadData = async () => {
  loading.value = true
  try {
    const res = await getWorkshop()
    // 后端响应格式：{ code: 200, data: {...} }
    if (res.data?.code === 200 && res.data?.data) {
      workshop.value = res.data.data
    }
  } catch (err) {
    console.error('加载傀儡工坊失败:', err)
    uiStore.showToast?.(err?.response?.data?.message || '加载工坊失败', 'error')
  } finally {
    loading.value = false
  }
}

// ===== Tab 切换 =====
const switchTab = (tabId) => {
  activeTab.value = tabId
  if (tabId !== 'guide' && !workshop.value) {
    loadData()
  }
}

// ===== 参悟图谱 =====
const openLearnConfirm = (mfg) => {
  pendingLearn.value = mfg
  learnConfirmShow.value = true
}

const executeLearn = async () => {
  if (!pendingLearn.value) return
  const mfg = pendingLearn.value
  // 通过类型配置反查 blueprint_key
  const blueprintKey = mfg.puppet_type + '_blueprint'
  actionLoading.value = 'learn_' + mfg.puppet_type
  try {
    const res = await learnBlueprint(blueprintKey)
    if (res.data?.code === 200) {
      learnConfirmShow.value = false
      uiStore.showToast?.('参悟图谱成功：' + mfg.name, 'success')
      await loadData()
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '参悟失败', 'error')
  } finally {
    actionLoading.value = null
    pendingLearn.value = null
  }
}

// ===== 制造傀儡 =====
const openManufactureConfirm = (mfg) => {
  pendingMfg.value = mfg
  mfgConfirmShow.value = true
}

const executeManufacture = async () => {
  if (!pendingMfg.value) return
  const mfg = pendingMfg.value
  actionLoading.value = 'mfg_' + mfg.puppet_type
  try {
    const res = await manufacture(mfg.puppet_type)
    if (res.data?.code === 200 && res.data?.data) {
      mfgConfirmShow.value = false
      const d = res.data.data
      // 展示制造结果
      resultData.value = {
        title: '制造成功',
        icon: '✦',
        success: true,
        message: `${mfg.name} 制造成功！`,
        details: {
          '等级': 'Lv.1',
          '攻击': d.atk,
          '防御': d.def,
          '气血': d.hp,
          '速度': d.speed,
          '耐久': d.durability,
          '剩余灵石': formatBigNumber(d.spirit_stones_after)
        }
      }
      resultShow.value = true
      await loadData()
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '制造失败', 'error')
  } finally {
    actionLoading.value = null
    pendingMfg.value = null
  }
}

// ===== 出战/护法/取消 =====
const handleSetBattle = async (puppet) => {
  actionLoading.value = puppet.id
  try {
    const res = await setBattle(puppet.id)
    if (res.data?.code === 200) {
      uiStore.showToast?.(`${puppet.name} 已设为出战傀儡`, 'success')
      await loadData()
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '设置失败', 'error')
  } finally {
    actionLoading.value = null
  }
}

const handleSetGuard = async (puppet) => {
  actionLoading.value = puppet.id
  try {
    const res = await setGuard(puppet.id)
    if (res.data?.code === 200) {
      uiStore.showToast?.(`${puppet.name} 已设为护法傀儡`, 'success')
      await loadData()
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '设置失败', 'error')
  } finally {
    actionLoading.value = null
  }
}

const handleUnset = async (puppet) => {
  actionLoading.value = puppet.id
  try {
    const res = await unsetRole(puppet.id)
    if (res.data?.code === 200) {
      uiStore.showToast?.(`已取消${puppet.status === 'battle' ? '出战' : '护法'}`, 'success')
      await loadData()
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '取消失败', 'error')
  } finally {
    actionLoading.value = null
  }
}

// ===== 淬炼 =====
const openQuenchConfirm = (puppet) => {
  pendingQuench.value = puppet
  quenchConfirmShow.value = true
}

const executeQuench = async () => {
  if (!pendingQuench.value) return
  const puppet = pendingQuench.value
  actionLoading.value = puppet.id
  try {
    const res = await quench(puppet.id)
    if (res.data?.code === 200 && res.data?.data) {
      quenchConfirmShow.value = false
      const d = res.data.data
      resultData.value = {
        title: d.quench_success ? '淬炼成功' : '淬炼失败',
        icon: d.quench_success ? '✦' : '✕',
        success: d.quench_success,
        message: d.quench_success
          ? `${puppet.name} 升至 Lv.${d.level}！`
          : `淬炼失败，${puppet.name} 等级不变`,
        details: {
          '成功率': (d.success_rate * 100).toFixed(0) + '%',
          '当前等级': 'Lv.' + d.level,
          '攻击': d.atk,
          '防御': d.def,
          '气血': d.hp,
          '速度': d.speed,
          '耐久': d.durability,
          '剩余灵石': formatBigNumber(d.spirit_stones_after)
        }
      }
      resultShow.value = true
      await loadData()
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '淬炼失败', 'error')
  } finally {
    actionLoading.value = null
    pendingQuench.value = null
  }
}

// ===== 维修 =====
const handleRepair = async (puppet) => {
  actionLoading.value = puppet.id
  try {
    const res = await repair(puppet.id)
    if (res.data?.code === 200 && res.data?.data) {
      const d = res.data.data
      uiStore.showToast?.(`${puppet.name} 维修完成（+${d.repaired_points}耐久，消耗${formatBigNumber(d.cost_spirit_stones)}灵石）`, 'success')
      await loadData()
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '维修失败', 'error')
  } finally {
    actionLoading.value = null
  }
}

// ===== 回收（二步确认） =====
const openRecyclePreview = async (puppet) => {
  actionLoading.value = puppet.id
  try {
    const res = await recyclePreview(puppet.id)
    if (res.data?.code === 200 && res.data?.data) {
      recycleData.value = res.data.data
      recyclePreviewShow.value = true
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '回收预览失败', 'error')
  } finally {
    actionLoading.value = null
  }
}

const executeRecycle = async () => {
  if (!recycleData.value) return
  const puppetId = recycleData.value.puppet_id
  actionLoading.value = puppetId
  try {
    const res = await recycle(puppetId)
    if (res.data?.code === 200 && res.data?.data) {
      recyclePreviewShow.value = false
      const d = res.data.data
      uiStore.showToast?.(`回收成功，返还灵石 ${formatBigNumber(d.spirit_stone_return)}`, 'success')
      await loadData()
    }
  } catch (err) {
    uiStore.showToast?.(err?.response?.data?.message || '回收失败', 'error')
  } finally {
    actionLoading.value = null
    recycleData.value = null
  }
}

// ===== 生命周期 =====
onMounted(() => {
  loadData()
})
</script>

<style scoped>
/* 自定义滚动条样式 */
:deep(.custom-scrollbar)::-webkit-scrollbar {
  width: 6px;
}
:deep(.custom-scrollbar)::-webkit-scrollbar-track {
  background: rgba(0,0,0,0.2);
}
:deep(.custom-scrollbar)::-webkit-scrollbar-thumb {
  background: rgba(120,113,108,0.4);
  border-radius: 3px;
}
</style>
