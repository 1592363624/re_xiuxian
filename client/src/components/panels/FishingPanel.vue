<template>
  <!--
    灵溪垂钓面板（玩法文档第21节·经济与博彩补充）
    - 5 Tab：钓台（钓鱼流程）/ 渔具（钓竿+鱼饵+鳞符）/ 鱼篓（鱼获+剖鱼）/ 鱼谱（图鉴）/ 排行
    - 业务逻辑全部在后端 FishingService 中处理，前端仅展示与接口调用
    - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
    - 异步钓鱼：抛竿后轮询 /status 获取进度，鱼讯到来后可试探/提竿
  -->
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm" @click.self="emit('close')">
    <div class="relative w-full max-w-4xl max-h-[92vh] mx-4 bg-gradient-to-b from-[#0c1a2e] to-[#050a14] border border-cyan-900/50 rounded-2xl shadow-2xl shadow-cyan-900/30 flex flex-col">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-cyan-900/40 shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-600 to-blue-800 flex items-center justify-center shadow-lg shadow-cyan-900/50">
            <!-- 鱼钩图标 -->
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-100">
              <path d="M12 2v14"/><path d="M12 16a4 4 0 0 1-4-4"/><circle cx="12" cy="20" r="2"/>
            </svg>
          </div>
          <div>
            <h2 class="text-xl font-bold text-cyan-200 tracking-wider">灵溪垂钓</h2>
            <p class="text-[11px] text-slate-500">钓竿4级 · 鱼饵4种 · 鱼塘4处 · 钓术熟练度 · 剖鱼机缘</p>
          </div>
        </div>
        <button @click="emit('close')" class="text-slate-400 hover:text-rose-400 transition-colors w-8 h-8 flex items-center justify-center rounded-full hover:bg-rose-900/30">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- 状态条：钓竿/熟练度/LDC/今日竿数 -->
      <div v-if="profile" class="px-6 py-2 bg-cyan-950/20 border-b border-cyan-900/30 flex items-center justify-between text-[11px] shrink-0 flex-wrap gap-2">
        <span class="text-slate-400">
          钓竿：<span class="text-cyan-300 font-bold">{{ profile.rod_name }}</span>
          <span class="text-slate-600 mx-1">|</span>
          熟练度：<span class="text-indigo-300 font-bold">Lv.{{ profile.skill_level }}</span>
          <span class="text-slate-600">（{{ profile.skill_exp }}/{{ profile.next_level_exp }}）</span>
        </span>
        <span class="text-slate-400">
          LDC：<span class="text-amber-300 font-bold">{{ profile.ldc_balance }}</span>
          <span class="text-slate-600 mx-1">|</span>
          今日：<span class="text-cyan-300 font-bold">{{ profile.daily_casts }}</span>
          <span class="text-slate-600">/ {{ profile.daily_limit }} 竿</span>
          <span class="text-slate-600 mx-1">|</span>
          灵石：<span class="text-emerald-300 font-bold">{{ profile.daily_stone_earned }}</span>
          <span class="text-slate-600">/ {{ profile.daily_stone_limit }}</span>
        </span>
      </div>

      <!-- Tab 栏 -->
      <div class="flex border-b border-cyan-900/40 shrink-0">
        <button v-for="tab in tabs" :key="tab.id" @click="switchTab(tab.id)"
          :class="['flex-1 px-3 py-3 text-sm font-bold tracking-wider transition-all relative',
                   activeTab === tab.id ? 'text-cyan-200 bg-cyan-900/20' : 'text-slate-500 hover:text-slate-300']">
          {{ tab.name }}
        </button>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto p-6">
        <!-- 加载态 -->
        <div v-if="loading" class="text-center py-10 text-slate-500">查询中...</div>

        <!-- ========== Tab 1: 钓台（钓鱼流程） ========== -->
        <div v-else-if="activeTab === 'fishing'">
          <!-- 无钓竿提示 -->
          <div v-if="profile && profile.rod_tier === 0" class="text-center py-12">
            <div class="text-4xl mb-3 opacity-50">🎣</div>
            <div class="text-sm text-rose-300 mb-1">你还没有钓竿</div>
            <div class="text-[11px] text-slate-500 mb-4">请前往「渔具」Tab 购买青竹钓竿（30 LDC）</div>
            <button @click="switchTab('tackle')" class="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-cyan-100 text-sm font-bold transition-colors">前往渔具铺</button>
          </div>

          <!-- 钓鱼会话区 -->
          <div v-else>
            <!-- 鱼塘选择 -->
            <div v-if="!status || !status.has_active_session" class="mb-6">
              <h3 class="text-sm text-cyan-300 font-bold mb-3">选择鱼塘抛竿</h3>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div v-for="pond in shop?.ponds" :key="pond.key"
                     :class="['rounded-xl border p-4 transition-all cursor-pointer',
                              pond.is_unlocked ? 'bg-slate-900/50 border-cyan-700/50 hover:border-cyan-500 hover:bg-cyan-950/30'
                                              : 'bg-slate-900/30 border-slate-700/30 opacity-50 cursor-not-allowed']"
                     @click="pond.is_unlocked && onCast(pond.key)">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-sm font-bold" :class="pond.is_unlocked ? 'text-cyan-200' : 'text-slate-500'">{{ pond.name }}</span>
                    <span v-if="pond.is_advanced" class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-800/60 text-amber-200">高级</span>
                    <span v-else-if="!pond.is_unlocked" class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-700/60 text-slate-400">🔒 Lv.{{ pond.required_skill_level }}</span>
                  </div>
                  <div class="text-[11px] text-slate-500 mb-2">{{ pond.description }}</div>
                  <div class="text-[10px] text-slate-600">
                    需熟练度 Lv.{{ pond.required_skill_level }}
                    <span class="mx-1">|</span>
                    鱼饵：{{ getBaitName(pond.required_bait) }}
                    <span v-if="pond.has_rare_material" class="text-amber-400 ml-1">| 稀有材料池</span>
                  </div>
                </div>
              </div>
              <!-- 今日天象 -->
              <div v-if="shop" class="mt-4 px-4 py-2 rounded-lg bg-indigo-950/20 border border-indigo-800/30 text-[11px] text-indigo-300">
                🌤 今日天象：{{ shop.today_weather }}（幸运修正 {{ (shop.luck_modifier * 100).toFixed(0) }}%）
              </div>
            </div>

            <!-- 活跃会话状态 -->
            <div v-else class="text-center py-8">
              <!-- 等待鱼讯 -->
              <div v-if="status.status === 'waiting'" class="space-y-4">
                <div class="text-5xl opacity-60">🌊</div>
                <div class="text-sm text-cyan-300">{{ status.message }}</div>
                <div class="w-full max-w-xs mx-auto bg-slate-800/50 rounded-full h-3 overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-cyan-600 to-blue-500 transition-all duration-1000"
                       :style="{ width: waitingProgress + '%' }"></div>
                </div>
                <div class="text-2xl font-bold text-cyan-200">{{ status.remaining_sec }}s</div>
                <button @click="onGiveUp" class="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs transition-colors">放弃收竿</button>
              </div>

              <!-- 鱼讯到来，可试探/提竿 -->
              <div v-else-if="status.status === 'biting'" class="space-y-4">
                <div class="text-5xl animate-bounce">🐟</div>
                <div class="text-sm text-amber-300 font-bold">{{ status.message }}</div>
                <div class="w-full max-w-xs mx-auto bg-slate-800/50 rounded-full h-3 overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-amber-500 to-rose-500 transition-all duration-500"
                       :style="{ width: bitingProgress + '%' }"></div>
                </div>
                <div class="text-lg font-bold text-amber-200">剩余 {{ status.remaining_sec }}s</div>
                <div class="text-[11px] text-slate-500">试探次数：{{ status.nibble_count }} / {{ status.max_nibble }}</div>
                <div class="flex gap-3 justify-center">
                  <!-- 试探咬饵：提高稀有度但有空竿风险 -->
                  <button v-if="status.nibble_count < status.max_nibble"
                          @click="onNibble"
                          class="px-5 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-amber-100 text-sm font-bold transition-colors">
                    试探咬饵
                  </button>
                  <!-- 提竿：直接结算 -->
                  <button @click="onReel"
                          class="px-6 py-2 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white text-sm font-bold transition-colors shadow-lg shadow-cyan-900/50">
                    提竿！
                  </button>
                </div>
              </div>

              <!-- 已过期 -->
              <div v-else class="space-y-3">
                <div class="text-5xl opacity-40">💨</div>
                <div class="text-sm text-slate-500">{{ status.message }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- ========== Tab 2: 渔具（钓竿+鱼饵+鳞符） ========== -->
        <div v-else-if="activeTab === 'tackle'">
          <!-- 钓竿区 -->
          <div class="mb-6">
            <h3 class="text-sm text-cyan-300 font-bold mb-3">钓竿</h3>
            <div v-if="profile && profile.rod_tier === 0" class="rounded-xl border border-amber-700/50 bg-amber-950/20 p-4">
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm font-bold text-amber-200">青竹钓竿</div>
                  <div class="text-[11px] text-slate-500">入门钓竿，每日5竿，适合初学者</div>
                </div>
                <button @click="showBuyRodModal = true"
                        class="px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-amber-100 text-sm font-bold transition-colors">
                  购买（30 LDC）
                </button>
              </div>
            </div>
            <div v-else class="rounded-xl border border-cyan-700/50 bg-cyan-950/20 p-4">
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm font-bold text-cyan-200">{{ profile?.rod_name }}（{{ profile?.rod_tier }}级）</div>
                  <div class="text-[11px] text-slate-500">每日 {{ profile?.daily_limit }} 竿</div>
                </div>
                <button v-if="profile?.upgrade_info && profile.upgrade_info.cost"
                        @click="showUpgradeRodModal = true"
                        class="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-indigo-100 text-sm font-bold transition-colors">
                  升级钓竿
                </button>
                <span v-else class="text-[11px] text-amber-400 font-bold">已达最高级</span>
              </div>
              <!-- 升级消耗预览 -->
              <div v-if="profile?.upgrade_info?.cost" class="mt-2 text-[10px] text-slate-500">
                升级消耗：
                <span v-for="(v, k) in profile.upgrade_info.cost" :key="k" class="mr-2">{{ formatMaterialName(k) }} ×{{ v }}</span>
              </div>
            </div>
          </div>

          <!-- 鱼饵区 -->
          <div class="mb-6">
            <h3 class="text-sm text-cyan-300 font-bold mb-3">鱼饵</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div v-for="bait in shop?.baits" :key="bait.key" class="rounded-xl border border-slate-700/50 bg-slate-900/50 p-4">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm font-bold text-slate-200">{{ bait.name }}</span>
                  <span v-if="bait.craftable" class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-800/60 text-emerald-200">可制作</span>
                </div>
                <div class="text-[11px] text-slate-500 mb-3">{{ bait.description }}</div>
                <div class="flex gap-2">
                  <button v-if="bait.price" @click="openBuyBaitModal(bait)"
                          class="flex-1 px-3 py-1.5 rounded-lg bg-cyan-800 hover:bg-cyan-700 text-cyan-100 text-xs font-bold transition-colors">
                    购买（{{ bait.price }}灵石）
                  </button>
                  <button v-if="bait.craftable" @click="openCraftBaitModal(bait)"
                          class="flex-1 px-3 py-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-emerald-100 text-xs font-bold transition-colors">
                    制作
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 鳞符区 -->
          <div>
            <h3 class="text-sm text-cyan-300 font-bold mb-3">鳞符（消耗灵鱼鳞获得3竿增益）</h3>
            <div class="rounded-xl border border-violet-700/50 bg-violet-950/20 p-4">
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm font-bold text-violet-200">鳞符</div>
                  <div class="text-[11px] text-slate-500">消耗灵鱼鳞×10，获得3竿提竿窗口延长+珍稀鱼概率提升</div>
                  <div v-if="profile && profile.buff_casts_remaining > 0" class="text-[10px] text-violet-400 mt-1">
                    当前增益：剩余 {{ profile.buff_casts_remaining }} 竿（幸运 +{{ (profile.buff_luck_bonus * 100).toFixed(0) }}%）
                  </div>
                </div>
                <button @click="showScaleTalismanModal = true"
                        class="px-4 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 text-violet-100 text-sm font-bold transition-colors">
                  炼制鳞符
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ========== Tab 3: 鱼篓（鱼获+剖鱼+烹鱼） ========== -->
        <div v-else-if="activeTab === 'creel'">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm text-cyan-300 font-bold">鱼篓（共 {{ creel?.total || 0 }} 条）</h3>
            <div class="flex gap-2 text-[11px]">
              <button @click="loadCreel('all')" :class="['px-2 py-1 rounded', creelFilter==='all'?'bg-cyan-800 text-cyan-100':'bg-slate-800 text-slate-400']">全部</button>
              <button @click="loadCreel('unfilleted')" :class="['px-2 py-1 rounded', creelFilter==='unfilleted'?'bg-cyan-800 text-cyan-100':'bg-slate-800 text-slate-400']">未剖</button>
              <button @click="loadCreel('filleted')" :class="['px-2 py-1 rounded', creelFilter==='filleted'?'bg-cyan-800 text-cyan-100':'bg-slate-800 text-slate-400']">已剖</button>
            </div>
          </div>

          <!-- 空鱼篓 -->
          <div v-if="!creel || creel.catches.length === 0" class="text-center py-12 text-slate-500 text-sm">
            <div class="text-4xl mb-3 opacity-40">📦</div>
            <p>鱼篓空空如也</p>
            <p class="text-[11px] mt-1">前往「钓台」抛竿钓鱼吧</p>
          </div>

          <!-- 鱼获列表 -->
          <div v-else class="space-y-2">
            <div v-for="c in creel.catches" :key="c.id"
                 :class="['rounded-lg border p-3 flex items-center justify-between',
                          c.is_filleted ? 'bg-slate-900/30 border-slate-700/30 opacity-60' : 'bg-slate-900/50 border-slate-700/50']">
              <div class="flex items-center gap-3">
                <span class="w-8 h-8 rounded flex items-center justify-center text-xs font-bold"
                      :class="qualityBgClass(c.quality)">🐟</span>
                <div>
                  <div class="text-sm font-bold" :class="qualityTextClass(c.quality)">{{ c.fish_name }}</div>
                  <div class="text-[10px] text-slate-500">{{ c.weight_kg }}kg · {{ qualityLabel(c.quality) }} · {{ formatTime(c.caught_at) }}</div>
                </div>
              </div>
              <div v-if="!c.is_filleted" class="flex gap-2">
                <button @click="openFilletModal(c)" class="px-3 py-1 rounded bg-cyan-800 hover:bg-cyan-700 text-cyan-100 text-[11px] font-bold transition-colors">剖鱼</button>
              </div>
              <span v-else class="text-[10px] text-slate-600">已剖</span>
            </div>
            <!-- 翻页 -->
            <div v-if="creel.total_pages > 1" class="flex justify-center gap-2 pt-2">
              <button @click="loadCreel(creelFilter, creel.page - 1)" :disabled="creel.page <= 1"
                      class="px-3 py-1 rounded bg-slate-800 text-slate-300 text-xs disabled:opacity-30">上一页</button>
              <span class="text-xs text-slate-500 py-1">{{ creel.page }} / {{ creel.total_pages }}</span>
              <button @click="loadCreel(creelFilter, creel.page + 1)" :disabled="creel.page >= creel.total_pages"
                      class="px-3 py-1 rounded bg-slate-800 text-slate-300 text-xs disabled:opacity-30">下一页</button>
            </div>
          </div>

          <!-- 烹鱼换修为 -->
          <div class="mt-6 rounded-xl border border-emerald-700/50 bg-emerald-950/20 p-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-bold text-emerald-200">烹鱼换修为</div>
                <div class="text-[11px] text-slate-500">消耗灵鱼肉，按比例获得修为</div>
              </div>
              <button @click="showCookModal = true" class="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-emerald-100 text-sm font-bold transition-colors">烹鱼</button>
            </div>
          </div>
        </div>

        <!-- ========== Tab 4: 鱼谱（图鉴） ========== -->
        <div v-else-if="activeTab === 'album'">
          <div class="mb-4 text-center">
            <span class="text-sm text-cyan-300 font-bold">发现 {{ album?.discovered || 0 }} / {{ album?.total_species || 0 }} 种</span>
            <span class="text-[11px] text-slate-500 ml-2">（{{ ((album?.discovery_rate || 0) * 100).toFixed(0) }}%）</span>
          </div>
          <div v-if="album && album.album.length > 0" class="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div v-for="a in album.album" :key="a.fish_id" class="rounded-lg border p-3 bg-slate-900/50" :class="qualityBorderClass(a.quality)">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-7 h-7 rounded flex items-center justify-center text-xs" :class="qualityBgClass(a.quality)">🐟</span>
                <span class="text-sm font-bold" :class="qualityTextClass(a.quality)">{{ a.fish_name }}</span>
              </div>
              <div class="text-[10px] text-slate-500">
                {{ qualityLabel(a.quality) }} · 共钓 {{ a.total_caught }} 条
              </div>
              <div class="text-[10px] text-slate-600">最大：{{ a.biggest_kg }}kg</div>
            </div>
          </div>
          <div v-else class="text-center py-12 text-slate-500 text-sm">
            <div class="text-4xl mb-3 opacity-40">📖</div>
            <p>鱼谱尚未开张</p>
            <p class="text-[11px] mt-1">钓到第一条鱼即可解锁图鉴</p>
          </div>
        </div>

        <!-- ========== Tab 5: 排行榜 ========== -->
        <div v-else-if="activeTab === 'ranking'">
          <div class="flex gap-2 mb-4 text-[11px]">
            <button v-for="cat in rankingCats" :key="cat.key" @click="loadRanking(cat.key)"
                    :class="['px-3 py-1 rounded font-bold transition-colors', rankingCategory===cat.key?'bg-cyan-800 text-cyan-100':'bg-slate-800 text-slate-400 hover:text-slate-300']">
              {{ cat.label }}
            </button>
          </div>
          <div v-if="ranking && ranking.entries.length > 0" class="space-y-2">
            <div v-for="e in ranking.entries" :key="e.rank"
                 :class="['rounded-lg border p-3 flex items-center justify-between',
                          e.rank === 1 ? 'bg-amber-950/30 border-amber-700/50'
                          : e.rank === 2 ? 'bg-slate-700/30 border-slate-500/50'
                          : e.rank === 3 ? 'bg-orange-950/30 border-orange-800/50'
                          : 'bg-slate-900/50 border-slate-700/50']">
              <div class="flex items-center gap-3">
                <span class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                      :class="e.rank <= 3 ? 'bg-gradient-to-br from-amber-500 to-amber-700 text-white' : 'bg-slate-700 text-slate-300'">{{ e.rank }}</span>
                <span class="text-sm font-bold text-slate-200">{{ e.nickname }}</span>
              </div>
              <span class="text-sm font-bold text-cyan-300">{{ e.display }}</span>
            </div>
          </div>
          <div v-else class="text-center py-12 text-slate-500 text-sm">
            <div class="text-4xl mb-3 opacity-40">🏆</div>
            <p>暂无排行数据</p>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 自定义 Modal：购买钓竿确认 ========== -->
    <CustomModal :isOpen="showBuyRodModal" title="购买青竹钓竿" @close="showBuyRodModal = false">
      <div class="text-sm text-slate-300 space-y-2">
        <p>将消耗 <span class="text-amber-300 font-bold">30 LDC</span> 购买青竹钓竿。</p>
        <p class="text-[11px] text-slate-500">当前 LDC：{{ profile?.ldc_balance }}</p>
        <p class="text-[11px] text-slate-500">青竹钓竿：每日5竿，等鱼90-180秒，提竿窗口10秒</p>
      </div>
      <template #footer>
        <button @click="showBuyRodModal = false" class="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm">取消</button>
        <button @click="onBuyRod" class="px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-amber-100 text-sm font-bold">确认购买</button>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：升级钓竿确认 ========== -->
    <CustomModal :isOpen="showUpgradeRodModal" title="升级钓竿" @close="showUpgradeRodModal = false">
      <div class="text-sm text-slate-300 space-y-2">
        <p>将消耗以下材料升级钓竿：</p>
        <div v-if="profile?.upgrade_info?.cost" class="bg-slate-800/50 rounded p-2">
          <div v-for="(v, k) in profile.upgrade_info.cost" :key="k" class="text-[12px]">
            {{ formatMaterialName(k) }} ×{{ v }}
          </div>
        </div>
        <p v-if="profile?.upgrade_info?.next_rod" class="text-[11px] text-cyan-400">
          升级后：{{ profile.upgrade_info.next_rod.name }}（每日{{ profile.upgrade_info.next_rod.daily_limit }}竿）
        </p>
      </div>
      <template #footer>
        <button @click="showUpgradeRodModal = false" class="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm">取消</button>
        <button @click="onUpgradeRod" class="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-indigo-100 text-sm font-bold">确认升级</button>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：购买鱼饵 ========== -->
    <CustomModal :isOpen="showBuyBaitModal" :title="`购买${buyBaitTarget?.name || ''}`" @close="showBuyBaitModal = false">
      <div class="text-sm text-slate-300 space-y-3">
        <p>单价 {{ buyBaitTarget?.price }} 灵石</p>
        <div>
          <label class="text-[11px] text-slate-500 block mb-1">购买数量（1-100）</label>
          <input v-model.number="buyBaitQty" type="number" min="1" max="100"
                 class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-sm" />
        </div>
        <p class="text-[11px] text-amber-300">总计：{{ (buyBaitTarget?.price || 0) * buyBaitQty }} 灵石</p>
      </div>
      <template #footer>
        <button @click="showBuyBaitModal = false" class="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm">取消</button>
        <button @click="onBuyBait" class="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-cyan-100 text-sm font-bold">确认购买</button>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：制作鱼饵 ========== -->
    <CustomModal :isOpen="showCraftBaitModal" :title="`制作${craftBaitTarget?.name || ''}`" @close="showCraftBaitModal = false">
      <div class="text-sm text-slate-300 space-y-3">
        <p class="text-[11px] text-slate-500">每批次消耗：</p>
        <div v-if="craftBaitTarget?.craft_cost" class="bg-slate-800/50 rounded p-2">
          <div v-for="(v, k) in craftBaitTarget.craft_cost" :key="k" class="text-[12px]">
            {{ formatMaterialName(k) }} ×{{ v }}
          </div>
        </div>
        <p class="text-[11px] text-emerald-300">每批次产出 {{ craftBaitTarget?.craft_batch || 3 }} 个</p>
        <div>
          <label class="text-[11px] text-slate-500 block mb-1">制作批次（1-50）</label>
          <input v-model.number="craftBaitBatches" type="number" min="1" max="50"
                 class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-sm" />
        </div>
      </div>
      <template #footer>
        <button @click="showCraftBaitModal = false" class="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm">取消</button>
        <button @click="onCraftBait" class="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-emerald-100 text-sm font-bold">确认制作</button>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：炼制鳞符 ========== -->
    <CustomModal :isOpen="showScaleTalismanModal" title="炼制鳞符" @close="showScaleTalismanModal = false">
      <div class="text-sm text-slate-300 space-y-2">
        <p>将消耗 <span class="text-violet-300 font-bold">灵鱼鳞 ×10</span> 炼制鳞符。</p>
        <p class="text-[11px] text-slate-500">效果：接下来3竿提竿窗口延长 + 珍稀鱼概率提升</p>
      </div>
      <template #footer>
        <button @click="showScaleTalismanModal = false" class="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm">取消</button>
        <button @click="onCraftScaleTalisman" class="px-4 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 text-violet-100 text-sm font-bold">确认炼制</button>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：剖鱼 ========== -->
    <CustomModal :isOpen="showFilletModal" :title="`剖鱼 - ${filletTarget?.fish_name || ''}`" @close="showFilletModal = false">
      <div class="text-sm text-slate-300 space-y-2">
        <p>将剖开 <span class="text-cyan-300 font-bold">{{ filletTarget?.fish_name }}</span>（{{ filletTarget?.weight_kg }}kg）</p>
        <p class="text-[11px] text-slate-500">产出：灵鱼肉/灵鱼鳞/水草团 + 灵石/修为（有日上限）</p>
        <div>
          <label class="text-[11px] text-slate-500 block mb-1">剖鱼数量（1-100）</label>
          <input v-model.number="filletQty" type="number" min="1" max="100"
                 class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-sm" />
        </div>
      </div>
      <template #footer>
        <button @click="showFilletModal = false" class="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm">取消</button>
        <button @click="onFillet" class="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-cyan-100 text-sm font-bold">确认剖鱼</button>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：烹鱼 ========== -->
    <CustomModal :isOpen="showCookModal" title="烹鱼换修为" @close="showCookModal = false">
      <div class="text-sm text-slate-300 space-y-2">
        <p>消耗灵鱼肉，按比例获得修为</p>
        <div>
          <label class="text-[11px] text-slate-500 block mb-1">灵鱼肉数量（1-100）</label>
          <input v-model.number="cookQty" type="number" min="1" max="100"
                 class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-sm" />
        </div>
      </div>
      <template #footer>
        <button @click="showCookModal = false" class="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm">取消</button>
        <button @click="onCook" class="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-emerald-100 text-sm font-bold">确认烹鱼</button>
      </template>
    </CustomModal>

    <!-- ========== Toast 提示 ========== -->
    <Transition name="toast">
      <div v-if="toastMsg" class="fixed top-6 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-lg shadow-xl text-sm font-bold"
           :class="toastType === 'success' ? 'bg-emerald-700 text-emerald-100' : toastType === 'error' ? 'bg-rose-700 text-rose-100' : 'bg-cyan-700 text-cyan-100'">
        {{ toastMsg }}
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
/**
 * 灵溪垂钓面板
 *
 * 5 Tab 设计：
 *   1. 钓台：鱼塘选择 + 抛竿 + 会话进度 + 试探/提竿/放弃
 *   2. 渔具：钓竿购买/升级 + 鱼饵购买/制作 + 鳞符炼制
 *   3. 鱼篓：鱼获列表 + 剖鱼 + 烹鱼换修为
 *   4. 鱼谱：鱼类图鉴 + 发现率
 *   5. 排行：4类排行（熟练度/最大鱼获/最稀有/总钓获）
 *
 * 异步钓鱼流程：
 *   抛竿 → 轮询status(waiting) → 鱼讯到来(status=biting) → 试探/提竿 → 结算
 *   轮询间隔 2 秒，鱼讯到来后每秒刷新倒计时
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import * as fishingApi from '../../api/fishing';
import type {
  FishingProfile, FishingShop, FishingStatus, FishCreel, FishAlbum,
  FishingRanking, ShopBait, FishCatchRecord,
} from '../../api/fishing';
import CustomModal from '../common/Modal.vue';

const emit = defineEmits<{ close: [] }>();

// ==================== 响应式状态 ====================
const loading = ref(false);
const activeTab = ref('fishing');
const profile = ref<FishingProfile | null>(null);
const shop = ref<FishingShop | null>(null);
const status = ref<FishingStatus | null>(null);
const creel = ref<FishCreel | null>(null);
const album = ref<FishAlbum | null>(null);
const ranking = ref<FishingRanking | null>(null);
const creelFilter = ref<'all' | 'unfilleted' | 'filleted'>('all');
const rankingCategory = ref<string>('skill_level');

// Modal 控制
const showBuyRodModal = ref(false);
const showUpgradeRodModal = ref(false);
const showBuyBaitModal = ref(false);
const showCraftBaitModal = ref(false);
const showScaleTalismanModal = ref(false);
const showFilletModal = ref(false);
const showCookModal = ref(false);

// Modal 数据
const buyBaitTarget = ref<ShopBait | null>(null);
const buyBaitQty = ref(1);
const craftBaitTarget = ref<ShopBait | null>(null);
const craftBaitBatches = ref(1);
const filletTarget = ref<FishCatchRecord | null>(null);
const filletQty = ref(1);
const cookQty = ref(1);

// Toast 提示
const toastMsg = ref('');
const toastType = ref<'success' | 'error' | 'info'>('info');

// 轮询定时器
let statusTimer: ReturnType<typeof setInterval> | null = null;

// Tab 定义
const tabs = [
  { id: 'fishing', name: '钓台' },
  { id: 'tackle', name: '渔具' },
  { id: 'creel', name: '鱼篓' },
  { id: 'album', name: '鱼谱' },
  { id: 'ranking', name: '排行' },
];

// 排行类别
const rankingCats = [
  { key: 'skill_level', label: '熟练度' },
  { key: 'biggest_catch_kg', label: '最大鱼获' },
  { key: 'rarest_catch_quality', label: '最稀有' },
  { key: 'total_success', label: '总钓获' },
];

// ==================== 计算属性 ====================
/** 等待鱼讯进度条百分比 */
const waitingProgress = computed(() => {
  if (!status.value || !status.value.remaining_sec) return 0;
  // 假设最大等待 180 秒
  return Math.max(0, Math.min(100, (1 - status.value.remaining_sec / 180) * 100));
});

/** 鱼讯窗口进度条百分比 */
const bitingProgress = computed(() => {
  if (!status.value || !status.value.remaining_sec) return 0;
  // 假设最大窗口 18 秒
  return Math.max(0, Math.min(100, (status.value.remaining_sec / 18) * 100));
});

// ==================== 工具方法 ====================
/** 显示 Toast 提示 */
function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  toastMsg.value = msg;
  toastType.value = type;
  setTimeout(() => { toastMsg.value = ''; }, 3000);
}

/** 品质背景色 */
function qualityBgClass(q: string): string {
  const map: Record<string, string> = {
    common: 'bg-slate-600 text-slate-200',
    uncommon: 'bg-emerald-700 text-emerald-200',
    rare: 'bg-blue-700 text-blue-200',
    epic: 'bg-violet-700 text-violet-200',
    legendary: 'bg-amber-700 text-amber-200',
    mythic: 'bg-rose-700 text-rose-200',
  };
  return map[q] || 'bg-slate-600 text-slate-200';
}

/** 品质文字色 */
function qualityTextClass(q: string): string {
  const map: Record<string, string> = {
    common: 'text-slate-300',
    uncommon: 'text-emerald-300',
    rare: 'text-blue-300',
    epic: 'text-violet-300',
    legendary: 'text-amber-300',
    mythic: 'text-rose-300',
  };
  return map[q] || 'text-slate-300';
}

/** 品质边框色 */
function qualityBorderClass(q: string): string {
  const map: Record<string, string> = {
    common: 'border-slate-600/50',
    uncommon: 'border-emerald-700/50',
    rare: 'border-blue-700/50',
    epic: 'border-violet-700/50',
    legendary: 'border-amber-700/50',
    mythic: 'border-rose-700/50',
  };
  return map[q] || 'border-slate-600/50';
}

/** 品质中文标签 */
function qualityLabel(q: string): string {
  const map: Record<string, string> = {
    common: '普通', uncommon: '优秀', rare: '稀有',
    epic: '史诗', legendary: '传说', mythic: '神话',
  };
  return map[q] || q;
}

/** 获取鱼饵名称 */
function getBaitName(key: string): string {
  return shop.value?.baits.find(b => b.key === key)?.name || key;
}

/** 格式化材料名称 */
function formatMaterialName(key: string): string {
  const map: Record<string, string> = {
    law_fragment_lei: '法则碎片·雷',
    tianlei_zhu: '天雷竹',
    jinlei_zhu: '金雷竹',
    ling_yu_rou: '灵鱼肉',
    ling_yu_lin: '灵鱼鳞',
    shui_cao_tuan: '水草团',
  };
  return map[key] || key;
}

/** 格式化时间 */
function formatTime(t: string): string {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ==================== 数据加载 ====================
/** 加载钓鱼档案 */
async function loadProfile() {
  try {
    const res = await fishingApi.getProfile();
    if (res.data?.code === 200) {
      profile.value = res.data.data;
    }
  } catch (e) { /* 静默处理 */ }
}

/** 加载商店 */
async function loadShop() {
  try {
    const res = await fishingApi.getShop();
    if (res.data?.code === 200) {
      shop.value = res.data.data;
    }
  } catch (e) { /* 静默处理 */ }
}

/** 加载会话状态 */
async function loadStatus() {
  try {
    const res = await fishingApi.getStatus();
    if (res.data?.code === 200) {
      status.value = res.data.data;
      // 如果有活跃会话，自动启动轮询
      if (status.value.has_active_session) {
        startPolling();
      }
    }
  } catch (e) { /* 静默处理 */ }
}

/** 加载鱼篓 */
async function loadCreel(filter: 'all' | 'unfilleted' | 'filleted' = 'all', page = 1) {
  creelFilter.value = filter;
  try {
    const res = await fishingApi.getCreel(page, 20, filter);
    if (res.data?.code === 200) {
      creel.value = res.data.data;
    }
  } catch (e) { /* 静默处理 */ }
}

/** 加载鱼谱 */
async function loadAlbum() {
  try {
    const res = await fishingApi.getAlbum();
    if (res.data?.code === 200) {
      album.value = res.data.data;
    }
  } catch (e) { /* 静默处理 */ }
}

/** 加载排行榜 */
async function loadRanking(category: string) {
  rankingCategory.value = category;
  try {
    const res = await fishingApi.getRanking(category as any);
    if (res.data?.code === 200) {
      ranking.value = res.data.data;
    }
  } catch (e) { /* 静默处理 */ }
}

// ==================== 轮询 ====================
/** 启动会话状态轮询 */
function startPolling() {
  stopPolling();
  // 鱼讯等待中：每2秒轮询；鱼讯窗口中：每1秒刷新
  statusTimer = setInterval(async () => {
    await loadStatus();
    if (!status.value || !status.value.has_active_session) {
      stopPolling();
      // 会话结束后刷新档案
      await loadProfile();
    }
  }, 2000);
}

/** 停止轮询 */
function stopPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

// ==================== Tab 切换 ====================
/** 切换 Tab，按需加载数据 */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  loading.value = true;
  try {
    if (tabId === 'fishing') {
      await Promise.all([loadProfile(), loadShop(), loadStatus()]);
    } else if (tabId === 'tackle') {
      await Promise.all([loadProfile(), loadShop()]);
    } else if (tabId === 'creel') {
      await loadCreel(creelFilter.value);
    } else if (tabId === 'album') {
      await loadAlbum();
    } else if (tabId === 'ranking') {
      await loadRanking(rankingCategory.value);
    }
  } finally {
    loading.value = false;
  }
}

// ==================== 业务操作 ====================
/** 抛竿 */
async function onCast(pondKey: string) {
  try {
    const res = await fishingApi.cast(pondKey);
    if (res.data?.code === 200) {
      showToast(`抛竿成功：${res.data.data.pond_name}，鱼讯预计 ${res.data.data.wait_sec} 秒后到来`, 'success');
      await loadStatus();
      startPolling();
    } else {
      showToast(res.data?.message || '抛竿失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '抛竿失败', 'error');
  }
}

/** 试探咬饵 */
async function onNibble() {
  try {
    const res = await fishingApi.nibble();
    if (res.data?.code === 200) {
      showToast(res.data.message, res.data.data?.fish_scared ? 'error' : 'info');
      await loadStatus();
      if (!status.value?.has_active_session) {
        stopPolling();
        await loadProfile();
      }
    } else {
      showToast(res.data?.message || '试探失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '试探失败', 'error');
  }
}

/** 提竿 */
async function onReel() {
  try {
    const res = await fishingApi.reel();
    if (res.data?.code === 200) {
      const d = res.data.data;
      if (d.fish) {
        showToast(`钓到 ${d.fish.fish_name}（${qualityLabel(d.fish.quality)}）${d.fish.weight_kg}kg！`, 'success');
      } else {
        showToast('空竿了，鱼跑了', 'error');
      }
      stopPolling();
      status.value = null;
      await loadProfile();
    } else {
      showToast(res.data?.message || '提竿失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '提竿失败', 'error');
  }
}

/** 放弃收竿 */
async function onGiveUp() {
  try {
    const res = await fishingApi.giveUp();
    if (res.data?.code === 200) {
      showToast('已放弃当前会话', 'info');
      stopPolling();
      status.value = null;
      await loadProfile();
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '操作失败', 'error');
  }
}

/** 购买钓竿 */
async function onBuyRod() {
  showBuyRodModal.value = false;
  try {
    const res = await fishingApi.buyRod();
    if (res.data?.code === 200) {
      showToast(res.data.message, 'success');
      await loadProfile();
    } else {
      showToast(res.data?.message || '购买失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '购买失败', 'error');
  }
}

/** 升级钓竿 */
async function onUpgradeRod() {
  showUpgradeRodModal.value = false;
  try {
    const res = await fishingApi.upgradeRod();
    if (res.data?.code === 200) {
      showToast(res.data.message, 'success');
      await loadProfile();
    } else {
      showToast(res.data?.message || '升级失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '升级失败', 'error');
  }
}

/** 打开购买鱼饵 Modal */
function openBuyBaitModal(bait: ShopBait) {
  buyBaitTarget.value = bait;
  buyBaitQty.value = 1;
  showBuyBaitModal.value = true;
}

/** 确认购买鱼饵 */
async function onBuyBait() {
  if (!buyBaitTarget.value) return;
  showBuyBaitModal.value = false;
  try {
    const res = await fishingApi.buyBait(buyBaitTarget.value.key, buyBaitQty.value);
    if (res.data?.code === 200) {
      showToast(res.data.message, 'success');
    } else {
      showToast(res.data?.message || '购买失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '购买失败', 'error');
  }
}

/** 打开制作鱼饵 Modal */
function openCraftBaitModal(bait: ShopBait) {
  craftBaitTarget.value = bait;
  craftBaitBatches.value = 1;
  showCraftBaitModal.value = true;
}

/** 确认制作鱼饵 */
async function onCraftBait() {
  if (!craftBaitTarget.value) return;
  showCraftBaitModal.value = false;
  try {
    const res = await fishingApi.craftBait(craftBaitTarget.value.key, craftBaitBatches.value);
    if (res.data?.code === 200) {
      showToast(res.data.message, 'success');
    } else {
      showToast(res.data?.message || '制作失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '制作失败', 'error');
  }
}

/** 炼制鳞符 */
async function onCraftScaleTalisman() {
  showScaleTalismanModal.value = false;
  try {
    const res = await fishingApi.craftScaleTalisman();
    if (res.data?.code === 200) {
      showToast(res.data.message, 'success');
      await loadProfile();
    } else {
      showToast(res.data?.message || '炼制失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '炼制失败', 'error');
  }
}

/** 打开剖鱼 Modal */
function openFilletModal(c: FishCatchRecord) {
  filletTarget.value = c;
  filletQty.value = 1;
  showFilletModal.value = true;
}

/** 确认剖鱼 */
async function onFillet() {
  if (!filletTarget.value) return;
  showFilletModal.value = false;
  try {
    const res = await fishingApi.fillet(filletTarget.value.id, filletQty.value);
    if (res.data?.code === 200) {
      const d = res.data.data;
      showToast(`剖鱼成功：灵鱼肉×${d.filet_gained} 灵鱼鳞×${d.scale_gained} 灵石+${d.stone_earned}`, 'success');
      await loadCreel(creelFilter.value, creel.value?.page || 1);
      await loadProfile();
    } else {
      showToast(res.data?.message || '剖鱼失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '剖鱼失败', 'error');
  }
}

/** 确认烹鱼 */
async function onCook() {
  showCookModal.value = false;
  try {
    const res = await fishingApi.cook(cookQty.value);
    if (res.data?.code === 200) {
      showToast(res.data.message, 'success');
    } else {
      showToast(res.data?.message || '烹鱼失败', 'error');
    }
  } catch (e: any) {
    showToast(e.response?.data?.message || '烹鱼失败', 'error');
  }
}

// ==================== 生命周期 ====================
onMounted(async () => {
  await switchTab('fishing');
});

onUnmounted(() => {
  stopPolling();
});
</script>

<style scoped>
/* Toast 过渡动画 */
.toast-enter-active, .toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from, .toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -20px);
}
</style>
