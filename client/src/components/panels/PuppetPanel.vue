<template>
  <!--
    傀儡工坊面板（玩法文档第23节·大衍诀与傀儡路线）
    - 3 Tab：工坊（傀儡列表+操作）/ 制造（图谱参悟+制造傀儡）/ 说明
    - 业务逻辑全部在后端 PuppetService 中处理，前端仅展示与接口调用
    - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
    - 核心交互：参悟图谱 → 制造傀儡 → 出战/护法/淬炼/维修/回收
  -->
  <PanelShell
    title="傀儡工坊"
    hint="大衍诀·控傀 · 制造出战护法 · 淬炼维修回收"
    size="xl"
    scoped-scroll
    @close="emit('close')"
  >
    <template #header-actions>
      <AppButton size="xs" variant="ghost" @click="loadData">刷新数据</AppButton>
    </template>

    <div class="h-full flex flex-col">
      <!-- Tab 栏 -->
      <Tabs :model-value="activeTab" :items="tabs" class="shrink-0 px-4" @update:model-value="switchTab" />

      <!-- 内容区 -->
      <div class="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-4">
        <!-- 大衍诀层数提示条 -->
        <div v-if="workshop" class="bg-surface-tint-gold border border-line-subtle rounded-panel px-3 py-2 mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px]">
          <span class="text-fg-secondary">
            大衍诀层数：<span class="text-state-arcane font-bold num">{{ workshop.dayan_level }}</span>
            <span class="text-fg-faint">/ 最低需 {{ workshop.min_dayan_level }} 层·控傀</span>
          </span>
          <span class="text-fg-secondary">
            傀儡：<span class="text-gold-400 font-bold num">{{ workshop.puppet_count }}</span>
            <span class="text-fg-faint num">/ {{ workshop.max_puppets }}</span>
            <span class="text-fg-faint mx-1">|</span>
            出战加成 <span class="text-state-success font-bold num">{{ (workshop.battle_stat_ratio * 100).toFixed(0) }}%</span>
            <span class="text-fg-faint mx-1">|</span>
            护法反击 <span class="text-state-danger font-bold num">{{ (workshop.guard_counter_ratio * 100).toFixed(0) }}%</span>
          </span>
        </div>

        <!-- 加载态 -->
        <LoadingBlock v-if="loading && activeTab !== 'guide'" text="查询中…" />

        <!-- ========== Tab 1: 工坊（傀儡列表） ========== -->
        <div v-else-if="activeTab === 'workshop'">
          <!-- 工坊数据缺失（接口失败或尚未返回）：必须挡在列表分支之前，否则 v-else 会对 null 取 puppets -->
          <EmptyState
            v-if="!workshop"
            text="傀儡工坊数据加载失败"
            hint="请重新打开面板，或稍后再试"
          />

          <!-- 未解锁提示 -->
          <EmptyState
            v-else-if="workshop.dayan_level < workshop.min_dayan_level"
            text="大衍诀层数不足，傀儡工坊尚未解锁"
            hint="需将大衍诀修至第三层·控傀方可开启傀儡制造"
          />

          <!-- 空列表提示 -->
          <EmptyState
            v-else-if="workshop.puppets.length === 0"
            text="工坊中尚无傀儡"
            hint="请前往「制造」页签参悟图谱并制造你的第一具傀儡"
          />

          <!-- 傀儡卡片列表 -->
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div v-for="p in workshop.puppets" :key="p.id"
                 :class="['rounded-panel border p-4 transition-colors',
                          p.status === 'battle' ? 'bg-surface-tint-jade border-state-success/50'
                          : p.status === 'guard' ? 'bg-rose-950/20 border-state-danger/50'
                          : 'bg-surface-sunken border-line']">
              <!-- 卡片头部：名称 + 状态 -->
              <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-8 h-8 rounded-control flex items-center justify-center text-xs font-bold shrink-0"
                        :class="qualityBgClass(p.quality)">★</span>
                  <div class="min-w-0">
                    <div class="text-sm font-bold font-display" :class="qualityTextClass(p.quality)">{{ p.name }}</div>
                    <div class="text-[10px] text-fg-muted num">Lv.{{ p.level }} · {{ qualityLabel(p.quality) }}</div>
                  </div>
                </div>
                <!-- 状态徽章 -->
                <Badge v-if="p.status === 'battle'" tone="success" solid>出战中</Badge>
                <Badge v-else-if="p.status === 'guard'" tone="danger" solid>护法中</Badge>
                <Badge v-else tone="muted">闲置</Badge>
              </div>

              <!-- 属性栏 -->
              <div class="grid grid-cols-4 gap-2 mb-3 text-center">
                <div class="bg-surface-sunken rounded-control py-1.5 border border-line-subtle">
                  <div class="text-[9px] text-fg-muted">攻击</div>
                  <div class="text-xs font-bold text-state-danger num">{{ p.atk }}</div>
                </div>
                <div class="bg-surface-sunken rounded-control py-1.5 border border-line-subtle">
                  <div class="text-[9px] text-fg-muted">防御</div>
                  <div class="text-xs font-bold text-state-info num">{{ p.def }}</div>
                </div>
                <div class="bg-surface-sunken rounded-control py-1.5 border border-line-subtle">
                  <div class="text-[9px] text-fg-muted">气血</div>
                  <div class="text-xs font-bold text-state-success num">{{ p.hp }}</div>
                </div>
                <div class="bg-surface-sunken rounded-control py-1.5 border border-line-subtle">
                  <div class="text-[9px] text-fg-muted">速度</div>
                  <div class="text-xs font-bold text-gold-400 num">{{ p.speed }}</div>
                </div>
              </div>

              <!-- 耐久度条 -->
              <div class="mb-3">
                <div class="flex items-center justify-between text-[10px] mb-1">
                  <span class="text-fg-muted">耐久度</span>
                  <span class="num" :class="p.durability <= 20 ? 'text-state-danger' : 'text-fg-secondary'">{{ p.durability }} / {{ p.max_durability }}</span>
                </div>
                <div class="w-full h-2 bg-surface-sunken rounded-full overflow-hidden border border-line">
                  <div class="h-full rounded-full transition-all duration-500"
                       :class="p.durability <= 20 ? 'bg-state-danger' : p.durability <= 50 ? 'bg-gold-500' : 'bg-state-success'"
                       :style="{ width: (p.durability / p.max_durability * 100) + '%' }"></div>
                </div>
              </div>

              <!-- 操作按钮组 -->
              <div class="grid grid-cols-2 gap-2">
                <!-- 出战/取消出战 -->
                <AppButton v-if="p.status !== 'battle'" block size="xs" variant="primary"
                  :loading="actionLoading === p.id"
                  :disabled="p.durability <= 0"
                  @click="handleSetBattle(p)">
                  出战
                </AppButton>
                <AppButton v-else block size="xs" variant="default"
                  :loading="actionLoading === p.id"
                  @click="handleUnset(p)">
                  取消出战
                </AppButton>

                <!-- 护法/取消护法 -->
                <AppButton v-if="p.status !== 'guard'" block size="xs" variant="danger"
                  :loading="actionLoading === p.id"
                  :disabled="p.durability <= 0"
                  @click="handleSetGuard(p)">
                  护法
                </AppButton>
                <AppButton v-else block size="xs" variant="default"
                  :loading="actionLoading === p.id"
                  @click="handleUnset(p)">
                  取消护法
                </AppButton>

                <!-- 淬炼 -->
                <AppButton block size="xs" variant="outline"
                  :loading="actionLoading === p.id"
                  :disabled="p.level >= workshop.quench_config.max_level || p.durability <= 0"
                  @click="openQuenchConfirm(p)">
                  淬炼
                </AppButton>

                <!-- 维修 -->
                <AppButton block size="xs" variant="default"
                  :loading="actionLoading === p.id"
                  :disabled="p.durability >= p.max_durability"
                  @click="handleRepair(p)">
                  维修
                </AppButton>

                <!-- 回收（仅闲置可回收） -->
                <AppButton class="col-span-2" block size="xs" variant="danger"
                  :loading="actionLoading === p.id"
                  :disabled="p.status !== 'idle'"
                  @click="openRecyclePreview(p)">
                  回收
                </AppButton>
              </div>

              <!-- 耐久度为0警告 -->
              <div v-if="p.durability <= 0" class="mt-2 text-center text-[10px] text-state-danger">
                耐久度为0，无法出战/护法/淬炼，请先维修
              </div>
            </div>
          </div>
        </div>

        <!-- ========== Tab 2: 制造（图谱参悟 + 制造傀儡） ========== -->
        <div v-else-if="activeTab === 'manufacture'">
          <LoadingBlock v-if="!workshop" text="数据加载中…" />
          <div v-else class="space-y-5">
            <!-- 已学图谱区 -->
            <div v-if="workshop.blueprints.length > 0">
              <h3 class="text-sm font-bold text-gold-400 mb-2 font-display">◆ 已参悟图谱（<span class="num">{{ workshop.blueprints.length }}</span>）</h3>
              <div class="flex flex-wrap gap-2">
                <span v-for="bp in workshop.blueprints" :key="bp.blueprint_key"
                      class="px-3 py-1 rounded-full text-[11px] bg-surface-tint-arcane border border-state-arcane/40 text-state-arcane">
                  {{ bp.blueprint_name }}
                </span>
              </div>
            </div>

            <!-- 可制造傀儡列表 -->
            <div>
              <h3 class="text-sm font-bold text-gold-400 mb-3 font-display">◆ 傀儡制造</h3>
              <div class="space-y-3">
                <div v-for="m in workshop.manufacturable" :key="m.puppet_type"
                     :class="['rounded-panel border p-4 transition-colors',
                              m.can_manufacture ? 'bg-surface-sunken border-gold-800/60'
                              : 'bg-surface-sunken border-line opacity-60']">
                  <div class="flex items-start justify-between gap-3 mb-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="w-8 h-8 rounded-control flex items-center justify-center text-xs font-bold shrink-0"
                            :class="qualityBgClass(m.quality)">★</span>
                      <div class="min-w-0">
                        <div class="text-sm font-bold font-display" :class="qualityTextClass(m.quality)">{{ m.name }}</div>
                        <div class="text-[10px] text-fg-muted wrap-cjk">{{ m.description }}</div>
                      </div>
                    </div>
                    <!-- 条件状态 -->
                    <div class="text-right text-[10px] shrink-0">
                      <div :class="m.dayan_met ? 'text-state-success' : 'text-state-danger'">
                        {{ m.dayan_met ? '✓' : '✕' }} 大衍诀 <span class="num">{{ m.required_dayan_level }}</span> 层
                      </div>
                      <div :class="m.has_blueprint ? 'text-state-success' : 'text-state-danger'">
                        {{ m.has_blueprint ? '✓' : '✕' }} 已参悟图谱
                      </div>
                    </div>
                  </div>

                  <!-- 基础属性 -->
                  <div class="grid grid-cols-4 gap-2 mb-2 text-center text-[11px]">
                    <div class="bg-surface-sunken rounded-control px-1 py-1 border border-line-subtle"><span class="text-fg-muted">攻</span> <span class="text-state-danger font-bold num">{{ m.base_stats.atk }}</span></div>
                    <div class="bg-surface-sunken rounded-control px-1 py-1 border border-line-subtle"><span class="text-fg-muted">防</span> <span class="text-state-info font-bold num">{{ m.base_stats.def }}</span></div>
                    <div class="bg-surface-sunken rounded-control px-1 py-1 border border-line-subtle"><span class="text-fg-muted">血</span> <span class="text-state-success font-bold num">{{ m.base_stats.hp }}</span></div>
                    <div class="bg-surface-sunken rounded-control px-1 py-1 border border-line-subtle"><span class="text-fg-muted">速</span> <span class="text-gold-400 font-bold num">{{ m.base_stats.speed }}</span></div>
                  </div>

                  <!-- 制造消耗 -->
                  <div class="bg-surface-sunken rounded-panel p-2 mb-2 text-[11px] border border-line-subtle">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-fg-muted">制造消耗</span>
                      <span class="text-fg-faint">图谱来源：{{ m.blueprint_source }}</span>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <span class="text-gold-400 num" :title="String(m.manufacture_cost.spirit_stone)">灵石 {{ formatCompact(m.manufacture_cost.spirit_stone) }}</span>
                      <span v-for="(qty, mat) in m.manufacture_cost.materials" :key="mat" class="text-fg-secondary num">
                        {{ materialName(mat) }} ×{{ qty }}
                      </span>
                    </div>
                  </div>

                  <!-- 操作按钮 -->
                  <div class="flex gap-2">
                    <!-- 参悟图谱按钮（未参悟时显示） -->
                    <AppButton v-if="!m.has_blueprint" block size="xs" variant="outline"
                      :loading="actionLoading === ('learn_' + m.puppet_type)"
                      @click="openLearnConfirm(m)">
                      参悟图谱
                    </AppButton>
                    <!-- 制造按钮 -->
                    <AppButton v-if="m.has_blueprint" block size="xs" variant="primary"
                      :loading="actionLoading === ('mfg_' + m.puppet_type)"
                      :disabled="!m.can_manufacture"
                      @click="openManufactureConfirm(m)">
                      {{ m.can_manufacture ? '制造傀儡' : '条件未满足' }}
                    </AppButton>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ========== Tab 3: 玩法说明 ========== -->
        <div v-else-if="activeTab === 'guide'" class="space-y-4 text-sm text-fg-secondary leading-relaxed">
          <div class="bg-surface-sunken border border-line rounded-panel p-4">
            <h3 class="text-gold-400 font-bold mb-2 font-display">◆ 傀儡工坊简介</h3>
            <p class="text-[13px] text-fg-muted wrap-cjk">傀儡工坊是大衍诀第三层·控傀解锁的后期系统。玩家通过参悟图谱、消耗材料制造傀儡，为PVP/PVE战斗提供属性加成，或设置护法在闭关被袭时自动反击。傀儡可通过淬炼提升等级、维修恢复耐久、回收返还材料。</p>
          </div>
          <div class="bg-surface-sunken border border-line rounded-panel p-4">
            <h3 class="text-gold-400 font-bold mb-2 font-display">◆ 五种傀儡</h3>
            <ul class="text-[13px] text-fg-muted space-y-1">
              <li>· <span class="text-fg-secondary">机关木傀</span>（稀有）：入门傀儡，属性均衡，大衍诀3层解锁</li>
              <li>· <span class="text-fg-secondary">铁甲战傀</span>（史诗）：重装防御型，防御极高，大衍诀3层解锁</li>
              <li>· <span class="text-fg-secondary">五行灵傀</span>（史诗）：法术型傀儡，攻防兼备，大衍诀3层解锁</li>
              <li>· <span class="text-fg-secondary">影傀</span>（传说）：速度极快，擅长突袭，大衍诀4层·千机解锁</li>
              <li>· <span class="text-fg-secondary">大衍灵傀</span>（神话）：终极傀儡，全属性卓越，大衍诀5层·衍神解锁</li>
            </ul>
          </div>
          <div class="bg-surface-sunken border border-line rounded-panel p-4">
            <h3 class="text-gold-400 font-bold mb-2 font-display">◆ 图谱获取</h3>
            <ul class="text-[13px] text-fg-muted space-y-1">
              <li>· 机关木傀图谱：LDC商城购买 / 基础副本掉落</li>
              <li>· 铁甲战傀图谱：昆吾山·封魔塔副本掉落</li>
              <li>· 五行灵傀图谱：苍坤洞府副本掉落</li>
              <li>· 影傀图谱：虚天殿副本 / 玄骨高阶分支掉落</li>
              <li>· 大衍灵傀图谱：青元子世界Boss掉落（极稀有）</li>
            </ul>
            <p class="text-[11px] text-fg-faint mt-2">获得图谱物品后，在「制造」页签参悟图谱即可解锁对应傀儡的制造权限。</p>
          </div>
          <div class="bg-surface-sunken border border-line rounded-panel p-4">
            <h3 class="text-gold-400 font-bold mb-2 font-display">◆ 出战与护法</h3>
            <ul class="text-[13px] text-fg-muted space-y-1">
              <li>· <span class="text-state-success">出战傀儡</span>：PVP/PVE战斗中提供 <span class="text-state-success font-bold num">30%</span> 属性加成（攻防血速）</li>
              <li>· <span class="text-state-danger">护法傀儡</span>：闭关被袭击时自动反击，造成 <span class="text-state-danger font-bold num">50%</span> 攻击力伤害</li>
              <li>· 同时只能设置 1 个出战 + 1 个护法傀儡</li>
              <li>· 耐久度为0时无法出战/护法，需先维修</li>
            </ul>
          </div>
          <div class="bg-surface-sunken border border-line rounded-panel p-4">
            <h3 class="text-gold-400 font-bold mb-2 font-display">◆ 淬炼与维修</h3>
            <ul class="text-[13px] text-fg-muted space-y-1">
              <li>· <span class="text-state-arcane">淬炼</span>：消耗灵石+机关核心提升等级，属性按 <span class="num">8%/级</span> 增长（速度<span class="num">3%/级</span>）</li>
              <li>· 淬炼成功率随等级递减（<span class="num">100% → 50%</span> 下限），失败材料消耗但等级不变</li>
              <li>· 每次淬炼成功消耗 2 点耐久</li>
              <li>· <span class="text-gold-400">维修</span>：消耗灵石（<span class="num">50/点</span>）+机关核心×1，恢复满耐久</li>
              <li>· 最高等级 <span class="num">20</span> 级</li>
            </ul>
          </div>
          <div class="bg-surface-sunken border border-line rounded-panel p-4">
            <h3 class="text-gold-400 font-bold mb-2 font-display">◆ 回收机制</h3>
            <ul class="text-[13px] text-fg-muted space-y-1">
              <li>· 仅闲置状态傀儡可回收，出战/护法中需先取消</li>
              <li>· 材料返还率 <span class="text-gold-400 num">50%</span>，灵石返还率 <span class="text-gold-400 num">30%</span>（含淬炼投入）</li>
              <li>· 回收需二次确认，先预览返还再执行</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- 参悟图谱确认 Modal -->
    <Modal :isOpen="learnConfirmShow" @close="learnConfirmShow = false" title="确认参悟图谱" width="420px">
      <div class="space-y-3 text-sm text-fg-secondary">
        <p>即将参悟图谱，本次将消耗：</p>
        <div class="bg-surface-sunken rounded-panel p-3 space-y-1 text-[13px] border border-line-subtle">
          <div class="flex justify-between">
            <span class="text-fg-muted">消耗物品</span>
            <span class="text-state-arcane font-bold">{{ pendingLearn?.name }}图谱 ×1</span>
          </div>
          <div class="flex justify-between">
            <span class="text-fg-muted">解锁制造</span>
            <span class="text-gold-400 font-bold">{{ pendingLearn?.name }}</span>
          </div>
        </div>
        <p class="text-[11px] text-fg-muted">参悟后图谱物品将被消耗，解锁对应傀儡的制造权限。</p>
      </div>
      <template #footer>
        <AppButton variant="default" @click="learnConfirmShow = false">取消</AppButton>
        <AppButton variant="outline" :loading="actionLoading === ('learn_' + pendingLearn?.puppet_type)" @click="executeLearn">
          确认参悟
        </AppButton>
      </template>
    </Modal>

    <!-- 制造傀儡确认 Modal -->
    <Modal :isOpen="mfgConfirmShow" @close="mfgConfirmShow = false" title="确认制造傀儡" width="440px">
      <div class="space-y-3 text-sm text-fg-secondary">
        <p>即将制造 <span class="text-gold-400 font-bold">{{ pendingMfg?.name }}</span>，本次将消耗：</p>
        <div class="bg-surface-sunken rounded-panel p-3 space-y-1 text-[13px] border border-line-subtle">
          <div class="flex justify-between">
            <span class="text-fg-muted">灵石</span>
            <span
              class="text-gold-400 font-bold num"
              :title="String(pendingMfg?.manufacture_cost.spirit_stone)"
            >{{ formatCompact(pendingMfg?.manufacture_cost.spirit_stone) }}</span>
          </div>
          <div v-for="(qty, mat) in pendingMfg?.manufacture_cost.materials" :key="mat" class="flex justify-between">
            <span class="text-fg-muted">{{ materialName(mat) }}</span>
            <span class="text-state-danger font-bold num">×{{ qty }}</span>
          </div>
        </div>
        <div class="bg-surface-tint-gold border border-gold-800/40 rounded-panel p-3 text-[12px] text-gold-300">
          制造消耗不可退还，请确认材料充足后继续。
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" @click="mfgConfirmShow = false">取消</AppButton>
        <AppButton variant="primary" :loading="actionLoading === ('mfg_' + pendingMfg?.puppet_type)" @click="executeManufacture">
          确认制造
        </AppButton>
      </template>
    </Modal>

    <!-- 淬炼确认 Modal -->
    <Modal :isOpen="quenchConfirmShow" @close="quenchConfirmShow = false" title="确认淬炼傀儡" width="420px">
      <div class="space-y-3 text-sm text-fg-secondary">
        <p>即将淬炼 <span class="text-state-arcane font-bold">{{ pendingQuench?.name }}</span>（当前 Lv.<span class="num">{{ pendingQuench?.level }}</span>）</p>
        <div class="bg-surface-sunken rounded-panel p-3 space-y-1 text-[13px] border border-line-subtle">
          <div class="flex justify-between">
            <span class="text-fg-muted">消耗灵石</span>
            <span class="text-gold-400 font-bold num" :title="String(quenchCostStones)">{{ formatCompact(quenchCostStones) }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-fg-muted">消耗机关核心</span>
            <span class="text-state-danger font-bold num">×1</span>
          </div>
          <div class="flex justify-between">
            <span class="text-fg-muted">耐久消耗</span>
            <span class="text-fg-secondary num">-2</span>
          </div>
        </div>
        <div class="bg-surface-tint-arcane border border-state-arcane/40 rounded-panel p-3 text-[12px] text-state-arcane">
          淬炼存在失败风险，失败时材料消耗但等级不变。成功率随等级递减。
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" @click="quenchConfirmShow = false">取消</AppButton>
        <AppButton variant="outline" :loading="actionLoading === pendingQuench?.id" @click="executeQuench">
          确认淬炼
        </AppButton>
      </template>
    </Modal>

    <!-- 回收预览 Modal -->
    <Modal :isOpen="recyclePreviewShow" @close="recyclePreviewShow = false" title="回收预览" width="440px">
      <div v-if="recycleData" class="space-y-3 text-sm text-fg-secondary">
        <p>即将回收 <span class="text-state-danger font-bold">{{ recycleData.puppet_name }}</span>（Lv.<span class="num">{{ recycleData.level }}</span>）</p>
        <div class="bg-surface-sunken rounded-panel p-3 space-y-1 text-[13px] border border-line-subtle">
          <div class="text-fg-muted mb-1">返还材料（<span class="num">{{ (recycleData.material_return_rate * 100).toFixed(0) }}%</span> 返还率）：</div>
          <div v-if="Object.keys(recycleData.material_returns).length === 0" class="text-fg-faint text-center py-1">无材料返还</div>
          <div v-for="(qty, mat) in recycleData.material_returns" :key="mat" class="flex justify-between">
            <span class="text-fg-secondary">{{ materialName(mat) }}</span>
            <span class="text-state-success font-bold num">×{{ qty }}</span>
          </div>
          <div class="border-t border-line mt-2 pt-2 flex justify-between">
            <span class="text-fg-muted">返还灵石（<span class="num">{{ (recycleData.spirit_stone_return_rate * 100).toFixed(0) }}%</span> 返还率）</span>
            <span class="text-gold-400 font-bold num" :title="String(recycleData.spirit_stone_return)">{{ formatCompact(recycleData.spirit_stone_return) }}</span>
          </div>
        </div>
        <div class="bg-rose-950/30 border border-state-danger/40 rounded-panel p-3 text-[12px] text-rose-200">
          回收后傀儡将被永久销毁，此操作不可撤销！
        </div>
      </div>
      <template #footer>
        <AppButton variant="default" @click="recyclePreviewShow = false">取消</AppButton>
        <AppButton variant="danger" :loading="actionLoading === recycleData?.puppet_id" @click="executeRecycle">
          确认回收
        </AppButton>
      </template>
    </Modal>

    <!-- 操作结果 Modal -->
    <Modal :isOpen="resultShow" @close="resultShow = false" :title="resultData?.title || '操作结果'" width="400px">
      <div class="space-y-3 text-sm text-fg-secondary text-center">
        <div class="text-2xl py-2 text-gold-500" aria-hidden="true">{{ resultData?.icon || '✦' }}</div>
        <div :class="['text-base font-bold', resultData?.success ? 'text-state-success' : 'text-state-danger']">{{ resultData?.message }}</div>
        <div v-if="resultData?.details" class="bg-surface-sunken rounded-panel p-3 space-y-1 text-[13px] text-left border border-line-subtle">
          <div v-for="(val, key) in resultData.details" :key="key" class="flex justify-between">
            <span class="text-fg-muted">{{ key }}</span>
            <span class="text-fg-secondary font-bold num">{{ val }}</span>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton variant="primary" @click="resultShow = false">知道了</AppButton>
      </template>
    </Modal>
  </PanelShell>
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
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import Badge from '../ui/Badge.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import { useUIStore } from '../../stores/ui'
import { formatCompact } from '../../utils/format'
import { useItemQualities } from '../../composables/useItemQualities'
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

// ===== Tab 管理（key/label 契约见 ui/Tabs.vue） =====
const tabs = [
  { key: 'workshop', label: '工坊' },
  { key: 'manufacture', label: '制造' },
  { key: 'guide', label: '说明' }
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
/** 材料名称（根据 material ID 查找中文名） */
const materialName = (matKey) => {
  return materialNameMap[matKey] || matKey
}

/**
 * 傀儡品质的档名与颜色：一律取服务端 game_balance.item_qualities（见 composables/useItemQualities.js）。
 * 这里以前抄了三份字典，彼此还不一样：标签那份把 uncommon 叫"精良"（同一档在背包里叫"非凡"），
 * 文字色那份只到 legendary —— mythic 落不进表，神话傀儡的名字就退成"普通"的中性灰。
 */
const { labelOf: qualityLabel, tileClass: qualityBgClass, textClass: qualityTextClass } = useItemQualities()

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
  if (!mfg.blueprint_key) {
    uiStore.showToast?.(`${mfg.name || '这只傀儡'}没有登记图谱（内容里 blueprint_key 缺失）`, 'error')
    return
  }
  // 图谱 key 由服务端随"可制造列表"下发（blueprint_key）。
  // 以前这里在界面里按傀儡类型名拼出图谱键（补上 _blueprint 后缀）：那是把内容的一条命名约定抄进了 UI ——
  // 资料片给新傀儡配的图谱只要不叫这个名字，点「参悟」就报图谱不存在，看起来像这傀儡根本学不了。
  const blueprintKey = mfg.blueprint_key
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
          '剩余灵石': formatCompact(d.spirit_stones_after)
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
          '剩余灵石': formatCompact(d.spirit_stones_after)
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
      uiStore.showToast?.(`${puppet.name} 维修完成（+${d.repaired_points}耐久，消耗${formatCompact(d.cost_spirit_stones)}灵石）`, 'success')
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
      uiStore.showToast?.(`回收成功，返还灵石 ${formatCompact(d.spirit_stone_return)}`, 'success')
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
