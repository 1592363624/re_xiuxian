<template>
  <!--
    赌石系统面板（玩法文档第21节·经济与博彩补充）
    - 4 Tab：赌石台（生成+原石列表+切石）/ 历史（切开记录）/ 排行（4类排行）/ 说明（规则）
    - 业务逻辑全部在后端 GamblingStoneService 中处理，前端仅展示与接口调用
    - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
    - 核心交互：生成原石 → 查看线索 → 选择切法 → 切开产出
    - 外壳与标签页走 ui/PanelShell.vue + ui/Tabs.vue，颜色统一取设计令牌
  -->
  <PanelShell
    title="赌石坊"
    hint="博彩机缘 · 线索博弈 · 切石玄机 · 熟练度成长"
    size="lg"
    scoped-scroll
    @close="emit('close')"
  >
    <div class="h-full flex flex-col min-h-0">
      <!-- 状态条：熟练度/日次数/诅咒状态 -->
      <div v-if="profile" class="shrink-0 px-4 py-2 bg-surface-tint-arcane border-b border-line-subtle flex items-center justify-between text-[11px] flex-wrap gap-2">
        <span class="text-fg-muted">
          熟练度：<span class="text-purple-300 font-bold">Lv.{{ profile.skill_level }}</span>
          <span class="text-gold-300 ml-1">「{{ profile.skill_title }}」</span>
          <span class="text-fg-faint mx-1">|</span>
          今日：<span class="text-cyan-300 font-bold num">{{ profile.daily_generates }}</span>
          <span class="text-fg-faint">/ {{ profile.daily_generate_limit }} 次</span>
        </span>
        <span class="text-fg-muted">
          <span v-if="profile.curse_active" class="text-rose-400 font-bold animate-pulse">⚠ 诅咒中（{{ formatCurseTime(profile.curse_until) }}）</span>
          <span v-else class="text-emerald-400">无诅咒</span>
          <span class="text-fg-faint mx-1">|</span>
          稀有：<span class="text-gold-300 font-bold num" :title="String(profile.stats.rare_drop_count)">{{ formatCompact(profile.stats.rare_drop_count) }}</span>
          <span class="text-fg-faint mx-1">|</span>
          LDC：<span class="text-gold-300 font-bold num" :title="String(profile.stats.ldc_earned)">{{ formatCompact(profile.stats.ldc_earned) }}</span>
        </span>
      </div>

      <!-- Tab 栏 -->
      <Tabs :model-value="activeTab" :items="tabItems" class="shrink-0" @update:model-value="switchTab" />

      <!-- 内容区 -->
      <div class="flex-1 min-h-0 overflow-y-auto p-6 scroll-thin">
        <!-- 加载态 -->
        <LoadingBlock v-if="loading && activeTab !== 'guide'" text="查询中…" />

        <!-- ========== Tab 1: 赌石台（生成+原石列表+切石） ========== -->
        <div v-else-if="activeTab === 'gamble'">
          <!-- 生成按钮 -->
          <div class="mb-5 flex items-center justify-between">
            <div>
              <h3 class="text-sm font-bold text-purple-200">◆ 原石生成</h3>
              <p class="text-[11px] text-fg-faint mt-0.5">每次生成3块原石，每日{{ profile?.daily_generate_limit || 3 }}次</p>
            </div>
            <AppButton variant="primary" size="sm" :loading="generateLoading" @click="handleGenerate">
              {{ generateLoading ? '生成中...' : '🎰 赌石' }}
            </AppButton>
          </div>

          <!-- 空列表提示 -->
          <EmptyState
            v-if="!stones || stones.length === 0"
            icon="🗿"
            text="尚无未切开原石"
            hint="点击「赌石」生成3块原石，根据线索判断价值"
          />

          <!-- 原石卡片列表 -->
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div v-for="s in stones" :key="s.id"
                 class="rounded-xl border p-4 transition-all bg-surface-raised/50 border-line/50 hover:border-purple-700/50">
              <!-- 卡片头部：产地+品质+基础价 -->
              <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-2">
                  <span class="w-9 h-9 rounded flex items-center justify-center text-lg"
                        :style="{ background: s.quality_color + '20', border: '1px solid ' + s.quality_color + '60' }">{{ s.origin_icon }}</span>
                  <div>
                    <div class="text-sm font-bold" :style="{ color: s.quality_color }">{{ s.quality_name }}</div>
                    <div class="text-[10px] text-fg-faint">{{ s.origin_name }} · 基础价 {{ s.base_price }}灵石</div>
                  </div>
                </div>
                <span v-if="s.is_listed" class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-800/60 text-emerald-200">已上架</span>
              </div>

              <!-- 4维线索展示 -->
              <div class="grid grid-cols-2 gap-2 mb-3">
                <div class="bg-surface-canvas/40 rounded px-2 py-1.5">
                  <div class="text-[9px] text-fg-faint">皮壳纹路</div>
                  <div class="text-xs font-bold text-purple-300">{{ s.clues.crust }}</div>
                </div>
                <div class="bg-surface-canvas/40 rounded px-2 py-1.5">
                  <div class="text-[9px] text-fg-faint">重量手感</div>
                  <div class="text-xs font-bold text-cyan-300">{{ s.clues.weight }}</div>
                </div>
                <div class="bg-surface-canvas/40 rounded px-2 py-1.5">
                  <div class="text-[9px] text-fg-faint">灵气强度</div>
                  <div class="text-xs font-bold text-gold-300">{{ s.clues.aura }}</div>
                </div>
                <div class="bg-surface-canvas/40 rounded px-2 py-1.5">
                  <div class="text-[9px] text-fg-faint">色泽光华</div>
                  <div class="text-xs font-bold text-rose-300">{{ s.clues.color }}</div>
                </div>
              </div>
              <p class="text-[10px] text-fg-faint mb-3 italic">线索可能含假，熟练度提升可降低假线索概率</p>

              <!-- 操作按钮组 -->
              <div class="grid grid-cols-3 gap-2">
                <button @click="openCutModal(s, 'rough')"
                  class="px-2 py-1.5 rounded text-[11px] font-bold bg-surface-active/60 hover:bg-surface-active/60 text-fg-secondary transition-all">
                  粗切<br><span class="text-[9px] text-fg-muted">免费·30%损耗</span>
                </button>
                <button @click="openCutModal(s, 'fine')"
                  class="px-2 py-1.5 rounded text-[11px] font-bold bg-indigo-800/60 hover:bg-indigo-700/60 text-indigo-200 transition-all">
                  精切<br><span class="text-[9px] text-indigo-300">100灵石·10%损耗</span>
                </button>
                <button @click="openCutModal(s, 'divine_sense')"
                  class="px-2 py-1.5 rounded text-[11px] font-bold bg-gold-800/60 hover:bg-gold-700/60 text-gold-200 transition-all">
                  神识切<br><span class="text-[9px] text-gold-300">大衍诀1层·无损</span>
                </button>
              </div>

              <!-- 流转按钮 -->
              <div class="grid grid-cols-2 gap-2 mt-2">
                <button v-if="!s.is_listed" @click="openListModal(s)"
                  class="px-2 py-1 rounded text-[11px] font-bold bg-emerald-800/40 hover:bg-emerald-700/40 text-emerald-200 transition-all">
                  上架拍卖
                </button>
                <button v-else @click="handleUnlist(s)"
                  class="px-2 py-1 rounded text-[11px] font-bold bg-rose-800/40 hover:bg-rose-700/40 text-rose-200 transition-all">
                  取消上架
                </button>
                <button v-if="profile?.insight_unlocked" @click="handleInsight(s)"
                  class="px-2 py-1 rounded text-[11px] font-bold bg-purple-800/40 hover:bg-purple-700/40 text-purple-200 transition-all">
                  灵识透石
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ========== Tab 2: 历史（切开记录） ========== -->
        <div v-else-if="activeTab === 'history'">
          <EmptyState v-if="!records || records.length === 0" icon="📜" text="尚无切开记录" />
          <div v-else class="space-y-3">
            <div v-for="r in records" :key="r.id" class="rounded-lg border border-line-subtle bg-surface-raised/40 p-3">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-bold" :class="getQualityColor(r.real_quality)">{{ r.real_quality_name }}</span>
                  <span class="text-[10px] text-fg-faint">{{ r.origin_name }}</span>
                  <span class="text-[10px] text-fg-faint">·</span>
                  <span class="text-[10px] text-indigo-300">{{ r.cut_method_name }}</span>
                </div>
                <span class="text-[10px] text-fg-faint">{{ formatTime(r.cut_at) }}</span>
              </div>
              <div class="text-[11px] text-fg-muted flex flex-wrap gap-3">
                <span v-if="parseYield(r.yield, 'spirit_stones') !== '0'" class="text-emerald-300">灵石+{{ parseYield(r.yield, 'spirit_stones') }}</span>
                <span v-if="parseYield(r.yield, 'cultivation') !== '0'" class="text-cyan-300">修为+{{ parseYield(r.yield, 'cultivation') }}</span>
                <span v-if="parseYield(r.yield, 'ldc') > 0" class="text-gold-300">LDC+{{ parseYield(r.yield, 'ldc') }}</span>
                <span v-if="parseYield(r.yield, 'rare_drops').length > 0" class="text-rose-300">稀有：{{ parseYield(r.yield, 'rare_drops').map((d:any)=>d.name).join('、') }}</span>
                <span v-if="parseYield(r.yield, 'curse_triggered')" class="text-rose-400">⚠触发诅咒</span>
                <span class="text-fg-faint">价值{{ r.yield_value }}灵石</span>
              </div>
            </div>
            <!-- 分页 -->
            <div v-if="recordsTotal > recordsPageSize" class="flex items-center justify-center gap-2 pt-2">
              <AppButton variant="default" size="xs" :disabled="recordsPage <= 1" @click="loadRecords(recordsPage - 1)">上一页</AppButton>
              <span class="text-xs text-fg-muted num">{{ recordsPage }} / {{ recordsTotalPages }}</span>
              <AppButton variant="default" size="xs" :disabled="recordsPage >= recordsTotalPages" @click="loadRecords(recordsPage + 1)">下一页</AppButton>
            </div>
          </div>
        </div>

        <!-- ========== Tab 3: 排行榜 ========== -->
        <div v-else-if="activeTab === 'ranking'">
          <div class="mb-4 flex gap-2 flex-wrap">
            <button v-for="t in rankingTypes" :key="t.id" @click="loadRanking(t.id)"
              :class="['px-3 py-1.5 rounded-lg text-xs font-bold transition-all',
                       rankingType === t.id ? 'bg-purple-700 text-purple-100' : 'bg-surface-hover text-fg-muted hover:bg-surface-active']">
              {{ t.name }}
            </button>
          </div>
          <EmptyState v-if="!ranking || ranking.length === 0" icon="🏆" text="暂无排行数据" />
          <div v-else class="space-y-2">
            <div v-for="r in ranking" :key="r.rank"
                 :class="['rounded-lg border p-3 flex items-center gap-3',
                          r.rank <= 3 ? 'bg-gradient-to-r from-gold-900/40 to-surface-raised/40 border-gold-700/40'
                          : 'bg-surface-raised/40 border-line-subtle']">
              <span :class="['w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold',
                             r.rank === 1 ? 'bg-gold-500 text-gold-900' : r.rank === 2 ? 'bg-surface-active text-surface-raised' : r.rank === 3 ? 'bg-gold-700 text-gold-200' : 'bg-surface-active text-fg-secondary']">{{ r.rank }}</span>
              <div class="flex-1">
                <div class="text-sm font-bold text-fg-secondary">{{ r.nickname }}</div>
                <div class="text-[10px] text-fg-faint">{{ r.realm }} · {{ r.skill_title }}（Lv.{{ r.skill_level }}）</div>
              </div>
              <div class="text-right">
                <div class="text-sm font-bold text-gold-300">{{ r.value }}</div>
                <div class="text-[9px] text-fg-faint">{{ getRankingUnit(rankingType) }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- ========== Tab 4: 说明（规则） ========== -->
        <div v-else-if="activeTab === 'guide'" class="text-sm text-fg-secondary space-y-4">
          <div>
            <h3 class="text-purple-200 font-bold mb-2">◆ 赌石流程</h3>
            <p class="text-fg-muted text-xs leading-relaxed">点击「赌石」生成3块原石（每日3次）→ 根据4维线索判断价值 → 选择切法（粗切/精切/神识切）→ 切开获得产出。</p>
          </div>
          <div>
            <h3 class="text-purple-200 font-bold mb-2">◆ 产地差异</h3>
            <ul class="text-fg-muted text-xs space-y-1">
              <li>🏝 <span class="text-cyan-300">乱星海岛</span>：偏灵石修为产出</li>
              <li>⛏ <span class="text-emerald-300">黄枫谷矿脉</span>：偏材料丹方产出</li>
              <li>🏔 <span class="text-gold-300">昆吾山深处</span>：偏法宝碎片残卷</li>
              <li>✨ <span class="text-purple-300">虚天殿遗矿</span>：极小概率出LDC稀有道具</li>
              <li>💀 <span class="text-rose-300">诅咒矿脉</span>：2倍产出但40%触发24h诅咒</li>
            </ul>
          </div>
          <div>
            <h3 class="text-purple-200 font-bold mb-2">◆ 品质与线索</h3>
            <p class="text-fg-muted text-xs leading-relaxed">4档品质：<span class="text-fg-secondary">普通</span>/<span class="text-blue-300">灵纹</span>/<span class="text-gold-300">宝光</span>/<span class="text-purple-300">仙雾</span>，基础价100/500/2000/8000灵石。4维线索（皮壳/重量/灵气/色泽）每条有30%概率为假线索，熟练度每级降低0.5%假线索概率。</p>
          </div>
          <div>
            <h3 class="text-purple-200 font-bold mb-2">◆ 切法选择</h3>
            <ul class="text-fg-muted text-xs space-y-1">
              <li>🔪 <span class="text-fg-secondary">粗切</span>：免费，30%损耗，无保底，赌性最强</li>
              <li>🔮 <span class="text-indigo-300">精切</span>：100灵石，10%损耗，保底不低于基础价60%</li>
              <li>👁 <span class="text-gold-300">神识切</span>：需大衍诀1层，无损，必出稀有</li>
            </ul>
          </div>
          <div>
            <h3 class="text-purple-200 font-bold mb-2">◆ 熟练度成长</h3>
            <p class="text-fg-muted text-xs leading-relaxed">每切开1块+10经验，稀有掉落额外+50经验。每5级+1%线索解读准确度，每10级+1%稀有产出权重。100级解锁「灵识透石」：查看1条真实线索。</p>
          </div>
          <div>
            <h3 class="text-purple-200 font-bold mb-2">◆ 多人交互</h3>
            <ul class="text-fg-muted text-xs space-y-1">
              <li>未切开原石可上架拍卖行流转（最高3倍基础价）</li>
              <li>切出稀有物品全服广播</li>
              <li>诅咒期间产出可被其他玩家劫镖令劫走30%</li>
              <li>LDC全服每日保底1-2个，稀有道具保底1-2件</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 自定义 Modal：切石确认 ========== -->
    <CustomModal :isOpen="cutModal.open" :title="cutModal.title" @close="cutModal.open = false">
      <div class="space-y-3 text-sm">
        <div v-if="cutModal.stone" class="bg-surface-raised/50 rounded p-3">
          <div class="text-fg-secondary mb-1">原石：<span class="font-bold" :style="{ color: cutModal.stone.quality_color }">{{ cutModal.stone.quality_name }}</span>（{{ cutModal.stone.origin_name }}）</div>
          <div class="text-[11px] text-fg-faint">基础价：{{ cutModal.stone.base_price }}灵石</div>
          <div class="grid grid-cols-2 gap-1 mt-2 text-[11px]">
            <span class="text-fg-muted">皮壳：{{ cutModal.stone.clues.crust }}</span>
            <span class="text-fg-muted">重量：{{ cutModal.stone.clues.weight }}</span>
            <span class="text-fg-muted">灵气：{{ cutModal.stone.clues.aura }}</span>
            <span class="text-fg-muted">色泽：{{ cutModal.stone.clues.color }}</span>
          </div>
        </div>
        <div class="text-fg-secondary">
          <p>切法：<span class="font-bold text-purple-300">{{ cutModal.methodName }}</span></p>
          <p class="text-[11px] text-fg-faint mt-1">{{ cutModal.methodDesc }}</p>
        </div>
        <div v-if="cutModal.cost > 0" class="text-gold-300 text-xs">消耗：{{ cutModal.cost }}灵石</div>
      </div>
      <template #footer>
        <AppButton variant="default" size="sm" @click="cutModal.open = false">取消</AppButton>
        <AppButton variant="primary" size="sm" :loading="cutLoading" @click="confirmCut">
          {{ cutLoading ? '切石中...' : '确认切石' }}
        </AppButton>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：切石结果展示 ========== -->
    <CustomModal :isOpen="resultModal.open" title="🎲 切石结果" @close="resultModal.open = false" width="500px">
      <div v-if="resultModal.data" class="space-y-3 text-sm">
        <!-- 真实品质揭示 -->
        <div class="text-center py-3 bg-gradient-to-r from-purple-950/40 to-gold-900/40 rounded-lg">
          <div class="text-[11px] text-fg-faint">真实品质</div>
          <div class="text-lg font-bold" :class="getQualityColor(resultModal.data.real_quality)">{{ resultModal.data.real_quality_name }}</div>
          <div class="text-[10px] text-fg-faint">{{ resultModal.data.origin_name }} · {{ resultModal.data.cut_method_name }}</div>
        </div>
        <!-- 产出明细 -->
        <div class="space-y-2">
          <div v-if="resultModal.data.yield.spirit_stones !== '0'" class="flex justify-between bg-emerald-950/30 rounded px-3 py-2">
            <span class="text-fg-muted">灵石</span>
            <span class="text-emerald-300 font-bold">+{{ resultModal.data.yield.spirit_stones }}</span>
          </div>
          <div v-if="resultModal.data.yield.cultivation !== '0'" class="flex justify-between bg-cyan-950/30 rounded px-3 py-2">
            <span class="text-fg-muted">修为</span>
            <span class="text-cyan-300 font-bold">+{{ resultModal.data.yield.cultivation }}</span>
          </div>
          <div v-if="resultModal.data.yield.ldc > 0" class="flex justify-between bg-gold-900/30 rounded px-3 py-2">
            <span class="text-fg-muted">LDC灵鱼丹珠</span>
            <span class="text-gold-300 font-bold">+{{ resultModal.data.yield.ldc }}</span>
          </div>
          <div v-if="resultModal.data.yield.items.length > 0" class="flex justify-between bg-violet-950/30 rounded px-3 py-2">
            <span class="text-fg-muted">物品</span>
            <span class="text-violet-300 font-bold">{{ resultModal.data.yield.items.map((i:any)=>`${i.item_id}×${i.quantity}`).join('、') }}</span>
          </div>
          <div v-if="resultModal.data.yield.rare_drops.length > 0" class="flex justify-between bg-rose-950/30 rounded px-3 py-2 animate-pulse">
            <span class="text-fg-muted">🌟 稀有掉落</span>
            <span class="text-rose-300 font-bold">{{ resultModal.data.yield.rare_drops.map((r:any)=>r.name).join('、') }}</span>
          </div>
          <div v-if="resultModal.data.yield.curse_triggered" class="text-center text-rose-400 text-xs py-2 animate-pulse">⚠ 触发石中诅咒！24小时内产出可被劫掠</div>
        </div>
        <div class="flex justify-between border-t border-line-subtle pt-2 text-xs">
          <span class="text-fg-faint">等价价值：{{ resultModal.data.yield_value }}灵石</span>
          <span class="text-fg-faint">净收益：{{ resultModal.data.net_profit }}灵石</span>
        </div>
        <div class="text-center text-[11px] text-purple-300">熟练度 Lv.{{ resultModal.data.skill_level }}「{{ resultModal.data.skill_title }}」</div>
      </div>
      <template #footer>
        <button @click="resultModal.open = false" class="px-4 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-purple-100 text-sm font-bold">收下产出</button>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：上架拍卖行 ========== -->
    <CustomModal :isOpen="listModal.open" title="上架拍卖行" @close="listModal.open = false">
      <div v-if="listModal.stone" class="space-y-3 text-sm">
        <div class="bg-surface-raised/50 rounded p-3">
          <div class="text-fg-secondary">原石：<span class="font-bold" :style="{ color: listModal.stone.quality_color }">{{ listModal.stone.quality_name }}</span></div>
          <div class="text-[11px] text-fg-faint">基础价：{{ listModal.stone.base_price }}灵石 · 最高{{ Math.floor(listModal.stone.base_price * 3) }}灵石</div>
        </div>
        <div>
          <label class="text-fg-muted text-xs">上架价格（灵石）</label>
          <input v-model.number="listModal.price" type="number" :min="1" :max="Math.floor(listModal.stone.base_price * 3)"
            class="w-full mt-1 px-3 py-2 bg-surface-raised border border-line rounded text-fg-secondary text-sm" placeholder="输入价格" />
        </div>
        <p class="text-[11px] text-fg-faint">未切开原石上架后可被其他玩家购买，切开后不可交易。</p>
      </div>
      <template #footer>
        <AppButton variant="default" size="sm" @click="listModal.open = false">取消</AppButton>
        <AppButton variant="primary" size="sm" :loading="listLoading" @click="confirmList">
          {{ listLoading ? '上架中...' : '确认上架' }}
        </AppButton>
      </template>
    </CustomModal>

    <!-- ========== 自定义 Modal：灵识透石结果 ========== -->
    <CustomModal :isOpen="insightModal.open" title="👁 灵识透石" @close="insightModal.open = false">
      <div v-if="insightModal.data" class="space-y-3 text-sm">
        <div class="bg-purple-950/30 rounded p-3 text-center">
          <div class="text-[11px] text-fg-faint">{{ insightModal.data.insight_dim_name }}</div>
          <div class="text-lg font-bold text-purple-300 mt-1">{{ insightModal.data.insight_value }}</div>
        </div>
        <div class="text-[11px] text-fg-muted">
          当前线索显示：<span class="text-fg-secondary">{{ insightModal.data.current_clue_value }}</span>
        </div>
        <div v-if="insightModal.data.is_fake" class="text-rose-400 text-xs">⚠ 该线索为假线索！与真实价值不符</div>
        <div v-else class="text-emerald-400 text-xs">✓ 该线索为真实线索</div>
      </div>
      <template #footer>
        <button @click="insightModal.open = false" class="px-4 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-purple-100 text-sm font-bold">明白</button>
      </template>
    </CustomModal>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 赌石系统面板
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   赌石流程是 `.赌石` 生成三块原石，再用 `.切 <编号>` 购买切开。
 *
 * 设计原则：
 *   - 所有业务逻辑由后端 GamblingStoneService 处理，前端仅展示与接口调用
 *   - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
 *   - 4维线索可能含假线索，玩家根据熟练度解读博弈
 */
import { ref, onMounted } from 'vue';
import CustomModal from '../common/Modal.vue';
import PanelShell from '../ui/PanelShell.vue';
import Tabs from '../ui/Tabs.vue';
import AppButton from '../ui/AppButton.vue';
import EmptyState from '../ui/EmptyState.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
import { formatCompact } from '../../utils/format';
import * as gamblingApi from '../../api/gamblingStone';
import type { GamblingStoneProfile, UncutStone, StoneRecord, RankingEntry } from '../../api/gamblingStone';

const emit = defineEmits<{ close: [] }>();

// ==================== 响应式状态 ====================
const loading = ref(false);
const activeTab = ref('gamble');
const profile = ref<GamblingStoneProfile | null>(null);
const stones = ref<UncutStone[]>([]);
const records = ref<StoneRecord[]>([]);
const recordsPage = ref(1);
const recordsPageSize = ref(20);
const recordsTotal = ref(0);
const recordsTotalPages = ref(1);
const ranking = ref<RankingEntry[]>([]);
const rankingType = ref('biggest_win');

const generateLoading = ref(false);
const cutLoading = ref(false);
const listLoading = ref(false);

// Tab 配置（key/label 契约见 ui/Tabs.vue）
const tabItems = [
  { key: 'gamble', label: '赌石台' },
  { key: 'history', label: '历史' },
  { key: 'ranking', label: '排行' },
  { key: 'guide', label: '说明' }
];

// 排行类型
const rankingTypes = [
  { id: 'biggest_win', name: '最大单块' },
  { id: 'total_profit', name: '总收益' },
  { id: 'rare_count', name: '稀有掉落' },
  { id: 'skill_level', name: '熟练度' }
];

// Modal 状态
const cutModal = ref<{ open: boolean; stone: UncutStone | null; method: string; methodName: string; methodDesc: string; cost: number; title: string }>({
  open: false, stone: null, method: '', methodName: '', methodDesc: '', cost: 0, title: ''
});
const resultModal = ref<{ open: boolean; data: any }>({ open: false, data: null });
const listModal = ref<{ open: boolean; stone: UncutStone | null; price: number }>({
  open: false, stone: null, price: 0
});
const insightModal = ref<{ open: boolean; data: any }>({ open: false, data: null });

// ==================== 工具方法 ====================

/** 获取品质文字色（返回设计令牌类名，见 styles/tokens.css；品质色为玩法语义色） */
function getQualityColor(quality: string): string {
  const colors: Record<string, string> = {
    common: 'text-fg-muted',
    spirit_vein: 'text-state-info',
    treasure_glow: 'text-gold-400',
    fairy_mist: 'text-state-arcane'
  };
  return colors[quality] || 'text-fg-muted';
}

/** 格式化时间 */
function formatTime(t: string): string {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** 格式化诅咒剩余时间 */
function formatCurseTime(t: string | null): string {
  if (!t) return '';
  const remain = new Date(t).getTime() - Date.now();
  if (remain <= 0) return '已过期';
  const h = Math.floor(remain / 3600000);
  const m = Math.floor((remain % 3600000) / 60000);
  return `${h}时${m}分`;
}

/** 解析产出字段（历史记录展示用） */
function parseYield(yieldData: any, field: string): any {
  if (!yieldData) return field === 'spirit_stones' || field === 'cultivation' ? '0' : field === 'ldc' ? 0 : field === 'rare_drops' ? [] : false;
  return yieldData[field] ?? (field === 'spirit_stones' || field === 'cultivation' ? '0' : field === 'ldc' ? 0 : field === 'rare_drops' ? [] : false);
}

/** 获取排行单位 */
function getRankingUnit(type: string): string {
  const units: Record<string, string> = {
    biggest_win: '灵石',
    total_profit: '灵石',
    rare_count: '件',
    skill_level: '级'
  };
  return units[type] || '';
}

// ==================== 数据加载 ====================

/** 切换 Tab */
async function switchTab(tabId: string) {
  activeTab.value = tabId;
  if (tabId === 'gamble') await loadStones();
  else if (tabId === 'history') await loadRecords(1);
  else if (tabId === 'ranking') await loadRanking(rankingType.value);
}

/** 加载玩家档案 */
async function loadProfile() {
  try {
    const data = await gamblingApi.getProfile();
    profile.value = data;
  } catch (err: any) {
    console.error('加载赌石档案失败:', err);
  }
}

/** 加载未切开原石列表 */
async function loadStones() {
  loading.value = true;
  try {
    const data = await gamblingApi.getStones();
    stones.value = data.stones;
  } catch (err: any) {
    console.error('加载原石列表失败:', err);
  } finally {
    loading.value = false;
  }
}

/** 加载历史记录 */
async function loadRecords(page: number) {
  loading.value = true;
  try {
    const data = await gamblingApi.getRecords(page, recordsPageSize.value);
    records.value = data.records;
    recordsPage.value = data.page;
    recordsTotal.value = data.total;
    recordsTotalPages.value = data.total_pages;
  } catch (err: any) {
    console.error('加载历史记录失败:', err);
  } finally {
    loading.value = false;
  }
}

/** 加载排行榜 */
async function loadRanking(type: string) {
  rankingType.value = type;
  loading.value = true;
  try {
    const data = await gamblingApi.getRanking(type as any);
    ranking.value = data.ranking;
  } catch (err: any) {
    console.error('加载排行榜失败:', err);
  } finally {
    loading.value = false;
  }
}

// ==================== 业务操作 ====================

/** 生成3块原石 */
async function handleGenerate() {
  generateLoading.value = true;
  try {
    const res = await gamblingApi.generateStones();
    if (res.code === 200) {
      await loadStones();
      await loadProfile();
    }
  } catch (err: any) {
    // 错误由 axios 拦截器统一处理
  } finally {
    generateLoading.value = false;
  }
}

/** 打开切石确认 Modal */
function openCutModal(stone: UncutStone, method: string) {
  const methodNames: Record<string, string> = { rough: '粗切', fine: '精切', divine_sense: '神识切' };
  const methodDescs: Record<string, string> = {
    rough: '免费粗切，30%损耗，无保底，赌性最强',
    fine: '精切工艺，100灵石，10%损耗，保底不低于基础价60%',
    divine_sense: '大衍诀神识切，无损，必出稀有，需大衍诀1层'
  };
  const costs: Record<string, number> = { rough: 0, fine: 100, divine_sense: 0 };
  cutModal.value = {
    open: true,
    stone,
    method,
    methodName: methodNames[method],
    methodDesc: methodDescs[method],
    cost: costs[method],
    title: `确认${methodNames[method]}`
  };
}

/** 确认切石 */
async function confirmCut() {
  if (!cutModal.value.stone) return;
  cutLoading.value = true;
  try {
    const res = await gamblingApi.cutStone(cutModal.value.stone.id, cutModal.value.method as any);
    if (res.code === 200) {
      resultModal.value = { open: true, data: res.data };
      cutModal.value.open = false;
      await loadStones();
      await loadProfile();
    }
  } catch (err: any) {
    // 错误由 axios 拦截器统一处理
  } finally {
    cutLoading.value = false;
  }
}

/** 打开上架 Modal */
function openListModal(stone: UncutStone) {
  listModal.value = {
    open: true,
    stone,
    price: stone.base_price
  };
}

/** 确认上架 */
async function confirmList() {
  if (!listModal.value.stone) return;
  listLoading.value = true;
  try {
    const res = await gamblingApi.listStone(listModal.value.stone.id, listModal.value.price);
    if (res.code === 200) {
      listModal.value.open = false;
      await loadStones();
    }
  } catch (err: any) {
    // 错误由 axios 拦截器统一处理
  } finally {
    listLoading.value = false;
  }
}

/** 取消上架 */
async function handleUnlist(stone: UncutStone) {
  try {
    await gamblingApi.unlistStone(stone.id);
    await loadStones();
  } catch (err: any) {
    // 错误由 axios 拦截器统一处理
  }
}

/** 灵识透石 */
async function handleInsight(stone: UncutStone) {
  try {
    const res = await gamblingApi.insightStone(stone.id);
    if (res.code === 200) {
      insightModal.value = { open: true, data: res.data };
    }
  } catch (err: any) {
    // 错误由 axios 拦截器统一处理
  }
}

// ==================== 生命周期 ====================
onMounted(async () => {
  await Promise.all([loadProfile(), loadStones()]);
});
</script>
