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
 *   - 颜色全部取 tokens.css 的 surface-* / line-* / fg-* / gold-* / state-* 令牌
 *   - 使用 Tailwind CSS 工具类，无自定义 CSS
 *   - 联合类型判别字段：has_small_world / has_temple
 */
<template>
  <PanelShell
    title="小世界 · 神域治理"
    size="xl"
    scoped-scroll
    @close="$emit('close')"
  >
    <div class="h-full flex flex-col">
      <!-- Tab 切换栏 -->
      <Tabs :model-value="activeTab" :items="tabs" class="shrink-0 px-4" @update:model-value="switchTab" />

      <!-- 内容滚动区 -->
      <div class="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-4">

        <!-- ============ Tab 1: 小世界 ============ -->
        <div v-show="activeTab === 'small_world'" class="space-y-3">
          <LoadingBlock v-if="loading.smallWorld" text="加载小世界数据中…" />
          <template v-else-if="smallWorldProfile">
            <!-- 未开辟小世界 -->
            <section v-if="!smallWorldProfile.has_small_world" class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-gold-400 mb-3 font-display">开辟小世界</div>
              <div class="text-xs text-fg-secondary space-y-1 mb-4">
                <div>· 境界要求：<span class="text-gold-400">{{ smallWorldProfile.create_cost.realm_required }}</span></div>
                <div>· 消耗灵石：<span class="text-gold-400 num" :title="String(smallWorldProfile.create_cost.spirit_stones)">{{ formatCompact(smallWorldProfile.create_cost.spirit_stones) }}</span></div>
                <div>· 开辟后可建立神域、收割香火、显灵干预</div>
              </div>
              <div class="flex items-center gap-2">
                <input v-model="worldName" maxlength="50" placeholder="为小世界赐名（最长 50 字符）"
                  class="flex-1 bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-gold-500 focus:outline-none focus-ring" />
                <AppButton
                  variant="primary"
                  :disabled="loading.action || !smallWorldProfile.can_create || !worldName.trim()"
                  @click="handleCreateWorld"
                >
                  开辟
                </AppButton>
              </div>
              <div v-if="!smallWorldProfile.can_create" class="text-[10px] text-state-danger mt-2">
                · 境界或灵石条件未满足，无法开辟
              </div>
            </section>

            <!-- 已开辟小世界 -->
            <template v-else>
              <!-- 小世界信息 -->
              <section class="bg-surface-hover border border-line rounded-panel p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-sm font-bold text-gold-400 font-display">{{ smallWorldProfile.world.world_name }}</div>
                  <Badge tone="gold">Lv.{{ smallWorldProfile.world.world_level }}</Badge>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div class="text-fg-muted">人口</div>
                    <div class="text-fg-primary font-bold num">{{ smallWorldProfile.world.population }} / {{ smallWorldProfile.world.population_max }}</div>
                  </div>
                  <div>
                    <div class="text-fg-muted">信仰</div>
                    <div class="text-state-arcane font-bold num">{{ smallWorldProfile.world.faith }} / {{ smallWorldProfile.world.faith_max }}</div>
                  </div>
                  <div>
                    <div class="text-fg-muted">稳定度</div>
                    <div class="text-state-success font-bold num">{{ smallWorldProfile.world.stability }} / 100</div>
                  </div>
                  <div>
                    <div class="text-fg-muted">香火产出/h</div>
                    <div class="text-gold-400 font-bold num">{{ smallWorldProfile.world.incense_production_rate }}</div>
                  </div>
                </div>
                <!-- 稳定度进度条 -->
                <StatBar
                  class="mt-3"
                  :value="smallWorldProfile.world.stability"
                  :max="100"
                  tone="jade"
                  :show-value="false"
                  height="h-1.5"
                />
              </section>

              <!-- 玩家资源 -->
              <section class="bg-surface-hover border border-line rounded-panel p-4">
                <div class="text-sm font-bold text-gold-400 mb-3 font-display">玩家资源</div>
                <div class="grid grid-cols-3 gap-3 text-xs">
                  <div class="bg-surface-sunken rounded-control p-2 text-center border border-line-subtle">
                    <div class="text-fg-muted">香火余额</div>
                    <div class="text-gold-400 font-bold text-lg num">{{ smallWorldProfile.player.incense_balance }}</div>
                  </div>
                  <div class="bg-surface-sunken rounded-control p-2 text-center border border-line-subtle">
                    <div class="text-fg-muted">神识余额</div>
                    <div class="text-state-info font-bold text-lg num">{{ smallWorldProfile.player.divine_sense_balance }}</div>
                  </div>
                  <div class="bg-surface-sunken rounded-control p-2 text-center border border-line-subtle">
                    <div class="text-fg-muted">法则点</div>
                    <div class="text-state-arcane font-bold text-lg num">{{ smallWorldProfile.player.law_points }}</div>
                  </div>
                </div>
              </section>

              <!-- 显灵 + 神迹干预 -->
              <section class="bg-surface-hover border border-line rounded-panel p-4">
                <div class="text-sm font-bold text-state-arcane mb-3 font-display">显灵与神迹</div>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <AppButton block variant="outline" :disabled="loading.action" @click="handleManifest">
                    显灵回应祈愿（消耗 100 香火）
                  </AppButton>
                  <AppButton block variant="primary" :disabled="loading.action" @click="handleMiracle('relieve_disaster')">
                    赈灾（稳定度+）
                  </AppButton>
                  <AppButton block variant="primary" :disabled="loading.action" @click="handleMiracle('preach')">
                    布道（信仰+）
                  </AppButton>
                </div>
                <div class="text-[10px] text-fg-muted mt-2">
                  · 显灵：消耗 100 香火，获得信仰+5 / 稳定+3 / 灵石回馈<br>
                  · 赈灾、布道各有每日次数上限，用尽后次日恢复
                </div>
              </section>
            </template>
          </template>
        </div>

        <!-- ============ Tab 2: 神庙 ============ -->
        <div v-show="activeTab === 'divine_temple'" class="space-y-3">
          <LoadingBlock v-if="loading.temple" text="加载神庙数据中…" />
          <template v-else-if="templeProfile">
            <!-- 未创建神庙 -->
            <section v-if="!templeProfile.has_temple" class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-gold-400 mb-2 font-display">神庙</div>
              <div class="text-xs text-fg-secondary">{{ templeProfile.message || '尚未创建神庙，需先开辟小世界' }}</div>
            </section>

            <!-- 已创建神庙 -->
            <template v-else>
              <!-- 神庙信息 -->
              <section class="bg-surface-hover border border-line rounded-panel p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-sm font-bold text-gold-400 font-display">{{ templeProfile.temple.temple_name }}</div>
                  <Badge tone="gold">Lv.{{ templeProfile.temple.temple_level }}</Badge>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div>
                    <div class="text-fg-muted">护界禁制</div>
                    <div class="text-state-success font-bold num">{{ templeProfile.temple.defense_power }} / {{ templeProfile.temple.defense_max }}</div>
                  </div>
                  <div>
                    <div class="text-fg-muted">玩家香火</div>
                    <div class="text-gold-400 font-bold num">{{ templeProfile.player_incense_balance }}</div>
                  </div>
                  <div>
                    <div class="text-fg-muted">玩家灵石</div>
                    <div class="text-gold-300 font-bold num" :title="String(templeProfile.player_spirit_stones)">{{ formatCompact(templeProfile.player_spirit_stones) }}</div>
                  </div>
                </div>
                <!-- 禁制进度条 -->
                <StatBar
                  class="mt-3"
                  :value="templeProfile.temple.defense_power"
                  :max="templeProfile.temple.defense_max"
                  tone="jade"
                  :show-value="false"
                  height="h-1.5"
                />
              </section>

              <!-- 升级 + 修复 -->
              <section class="bg-surface-hover border border-line rounded-panel p-4">
                <div class="text-sm font-bold text-gold-400 mb-3 font-display">升级与修复</div>
                <div v-if="templeProfile.upgrade_info.is_max_level" class="text-xs text-state-success mb-3">
                  · 已达最高等级
                </div>
                <div v-else-if="templeProfile.upgrade_info.next_upgrade" class="text-[11px] text-fg-secondary space-y-1 mb-3">
                  <div>· 升级至 Lv.<span class="text-gold-400 num">{{ templeProfile.upgrade_info.next_upgrade.to_level }}</span></div>
                  <div>· 消耗香火：<span class="text-gold-400 num">{{ templeProfile.upgrade_info.next_upgrade.cost_incense }}</span></div>
                  <div>· 消耗灵石：<span class="text-gold-400 num" :title="String(templeProfile.upgrade_info.next_upgrade.cost_spirit_stones)">{{ formatCompact(templeProfile.upgrade_info.next_upgrade.cost_spirit_stones) }}</span></div>
                  <div>· 解锁特性：<span class="text-state-arcane">{{ templeProfile.upgrade_info.next_upgrade.unlock_feature }}</span></div>
                  <div>· 神庙加成：<span class="text-state-success">{{ templeProfile.upgrade_info.next_upgrade.temple_bonus }}</span></div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <AppButton block variant="primary"
                    :disabled="loading.action || templeProfile.upgrade_info.is_max_level"
                    @click="handleUpgradeTemple">
                    {{ templeProfile.upgrade_info.is_max_level ? '已满级' : '升级神庙' }}
                  </AppButton>
                  <AppButton block variant="outline" :disabled="loading.action" @click="handleRepairDefense">
                    修复禁制（消耗灵石，CD 1h）
                  </AppButton>
                </div>
              </section>

              <!-- 供奉兑换 -->
              <section class="bg-surface-hover border border-line rounded-panel p-4">
                <div class="text-sm font-bold text-state-arcane mb-3 font-display">供奉兑换</div>
                <EmptyState
                  v-if="templeProfile.available_offerings.length === 0"
                  text="当前等级暂无可兑换供奉"
                />
                <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div v-for="offering in templeProfile.available_offerings" :key="offering.offering_id"
                    class="bg-surface-sunken border border-line rounded-control p-2 text-xs">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-gold-400 font-bold">{{ offering.name }}</span>
                      <span class="text-[10px] text-fg-muted num">Lv.{{ offering.min_temple_level }}+</span>
                    </div>
                    <div class="text-fg-secondary text-[11px] mb-2">
                      · 消耗香火：<span class="text-gold-400 num">{{ offering.cost_incense }}</span><br>
                      · 奖励：<span class="text-state-success">{{ offering.reward.type }} ×{{ offering.reward.amount }}</span>
                      <span v-if="offering.description"> · {{ offering.description }}</span>
                    </div>
                    <AppButton block size="xs" variant="outline" :disabled="loading.action" @click="handleExchangeOffering(offering.offering_id)">
                      兑换
                    </AppButton>
                  </div>
                </div>
              </section>
            </template>
          </template>
        </div>

        <!-- ============ Tab 3: 香火 ============ -->
        <div v-show="activeTab === 'incense'" class="space-y-3">
          <section class="bg-surface-hover border border-line rounded-panel p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-gold-400 font-display">香火收割</div>
              <AppButton variant="primary" :disabled="loading.action" @click="handleHarvest">收割香火</AppButton>
            </div>
            <div class="text-[11px] text-fg-secondary">
              · 按小世界产出速率累计，收割后同步更新人口/信仰/稳定度
            </div>
          </section>

          <!-- 香火流水 -->
          <section class="bg-surface-hover border border-line rounded-panel p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-gold-400 font-display">香火流水</div>
              <div class="flex items-center gap-2 text-xs">
                <AppButton size="xs" variant="default" :disabled="loading.logs || incenseLogs.page <= 1" @click="changeLogPage(incenseLogs.page - 1)">
                  上一页
                </AppButton>
                <span class="text-fg-secondary num">{{ incenseLogs.page }} / {{ incenseLogs.total_pages || 1 }}</span>
                <AppButton size="xs" variant="default" :disabled="loading.logs || incenseLogs.page >= incenseLogs.total_pages" @click="changeLogPage(incenseLogs.page + 1)">
                  下一页
                </AppButton>
              </div>
            </div>
            <LoadingBlock v-if="loading.logs" text="加载流水中…" />
            <EmptyState v-else-if="incenseLogs.list.length === 0" text="暂无流水记录" />
            <div v-else class="space-y-1 max-h-72 overflow-y-auto scroll-thin">
              <div v-for="log in incenseLogs.list" :key="log.id"
                class="bg-surface-sunken border border-line-subtle rounded-control p-2 text-[11px] flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <span class="text-fg-secondary">{{ log.change_type_name }}</span>
                  <span class="text-fg-muted ml-2">{{ log.reason }}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="num" :class="log.change_amount >= 0 ? 'text-state-success' : 'text-state-danger'">
                    {{ log.change_amount >= 0 ? '+' : '' }}{{ log.change_amount }}
                  </span>
                  <span class="text-fg-muted num">余额 {{ log.balance_after }}</span>
                  <span class="text-fg-faint num">{{ formatTime(log.created_at) }}</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- ============ Tab 4: 神识 ============ -->
        <div v-show="activeTab === 'divine_sense'" class="space-y-3">
          <LoadingBlock v-if="loading.divineSense" text="加载神识数据中…" />
          <template v-else-if="divineSenseProfile">
            <!-- 神识状态 -->
            <section class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-state-info mb-3 font-display">神识状态</div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <div class="text-fg-muted">当前/上限</div>
                  <div class="text-state-info font-bold num">{{ divineSenseProfile.divine_sense.current }} / {{ divineSenseProfile.divine_sense.max }}</div>
                </div>
                <div>
                  <div class="text-fg-muted">恢复/h</div>
                  <div class="text-state-success font-bold num">{{ divineSenseProfile.divine_sense.regen_rate_per_hour }}</div>
                </div>
                <div>
                  <div class="text-fg-muted">累计淬炼</div>
                  <div class="text-state-arcane font-bold num">{{ divineSenseProfile.divine_sense.total_quenched }}</div>
                </div>
                <div>
                  <div class="text-fg-muted">累计消耗</div>
                  <div class="text-state-danger font-bold num">{{ divineSenseProfile.divine_sense.total_consumed }}</div>
                </div>
              </div>
              <!-- 神识进度条 -->
              <StatBar
                class="mt-3"
                :value="divineSenseProfile.divine_sense.current"
                :max="divineSenseProfile.divine_sense.max"
                tone="azure"
                :show-value="false"
                height="h-1.5"
              />
            </section>

            <!-- 淬炼操作 -->
            <section class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-state-info mb-3 font-display">神识淬炼</div>
              <div class="text-[11px] text-fg-secondary space-y-1 mb-3">
                <div>· 每日次数：<span class="num">{{ divineSenseProfile.quench_info.daily_count }} / {{ divineSenseProfile.quench_info.daily_limit }}</span>（剩余 <span class="num">{{ divineSenseProfile.quench_info.daily_remaining }}</span>）</div>
                <div>· 比率：每 <span class="num">1</span> 神识消耗 <span class="num">{{ divineSenseProfile.quench_info.cost_incense_per_sense }}</span> 香火</div>
                <div>· 单次最大：<span class="num">{{ divineSenseProfile.quench_info.max_amount_per_time }}</span> 神识</div>
                <div>· CD 状态：<span class="num" :class="divineSenseProfile.quench_info.cooldown_ready ? 'text-state-success' : 'text-state-danger'">
                  {{ divineSenseProfile.quench_info.cooldown_ready ? '可淬炼' : `冷却中（剩余 ${divineSenseProfile.quench_info.cooldown_remaining_sec} 秒）` }}
                </span></div>
                <div>· 玩家香火余额：<span class="text-gold-400 num">{{ divineSenseProfile.player_incense_balance }}</span></div>
              </div>
              <div class="flex items-center gap-2">
                <input v-model.number="quenchAmount" type="number" min="1" :max="divineSenseProfile.quench_info.max_amount_per_time" placeholder="淬炼数量"
                  class="flex-1 num bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-state-info focus:outline-none focus-ring" />
                <AppButton
                  variant="primary"
                  :disabled="loading.action || !divineSenseProfile.quench_info.cooldown_ready || divineSenseProfile.quench_info.daily_remaining <= 0 || !quenchAmount"
                  @click="handleQuench"
                >
                  淬炼
                </AppButton>
              </div>
            </section>

            <!-- 神识用途表 -->
            <section class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-state-arcane mb-3 font-display">神识用途</div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div v-for="(usage, idx) in divineSenseProfile.usage_table" :key="idx"
                  class="bg-surface-sunken border border-line rounded-control p-2 text-xs">
                  <div class="flex items-center justify-between">
                    <span class="text-gold-400 font-bold">{{ usage.name }}</span>
                    <span class="text-state-info num">消耗 {{ usage.cost }}</span>
                  </div>
                  <div v-if="usage.description" class="text-fg-muted text-[10px] mt-1">{{ usage.description }}</div>
                </div>
              </div>
            </section>
          </template>
        </div>

        <!-- ============ Tab 5: 法则 ============ -->
        <div v-show="activeTab === 'law'" class="space-y-3">
          <LoadingBlock v-if="loading.law" text="加载法则数据中…" />
          <template v-else-if="lawProfile">
            <!-- 法则点 + 碎片 -->
            <section class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-state-arcane mb-3 font-display">法则点与碎片</div>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                <div class="bg-surface-sunken rounded-control p-2 border border-line-subtle">
                  <div class="text-fg-muted">当前法则点</div>
                  <div class="text-state-arcane font-bold text-lg num">{{ lawProfile.law_points.current }}</div>
                  <div class="text-[10px] text-fg-muted num">每日剩余：{{ lawProfile.law_points.daily_remaining }} / {{ lawProfile.law_points.daily_limit }}</div>
                </div>
                <div class="bg-surface-sunken rounded-control p-2 border border-line-subtle">
                  <div class="text-fg-muted">累计获得</div>
                  <div class="text-state-success font-bold num">{{ lawProfile.law_points.total_earned }}</div>
                </div>
                <div class="bg-surface-sunken rounded-control p-2 border border-line-subtle">
                  <div class="text-fg-muted">累计消耗</div>
                  <div class="text-state-danger font-bold num">{{ lawProfile.law_points.total_spent }}</div>
                </div>
              </div>
              <div class="grid grid-cols-5 gap-2 mt-3 text-[11px]">
                <div v-for="(count, key) in lawProfile.fragments" :key="key"
                  class="bg-surface-sunken border border-line rounded-control p-2 text-center">
                  <div class="text-fg-muted">{{ getFragmentName(lawProfile.fragment_types, key) }}</div>
                  <div class="text-state-info font-bold num">{{ count }}</div>
                </div>
              </div>
            </section>

            <!-- 转换：神识→法则点 -->
            <section class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-state-info mb-3 font-display">神识 → 法则点</div>
              <div class="text-[11px] text-fg-secondary mb-2">
                · 比率：<span class="num">100</span> 神识 = <span class="num">1</span> 法则点（受每日上限限制）
              </div>
              <div class="flex items-center gap-2">
                <input v-model.number="convertDivineSenseAmount" type="number" min="100" step="100" placeholder="神识数量"
                  class="flex-1 num bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-state-info focus:outline-none focus-ring" />
                <AppButton variant="primary" :disabled="loading.action || !convertDivineSenseAmount" @click="handleConvertDivineSense">
                  转换
                </AppButton>
              </div>
            </section>

            <!-- 转换：碎片→法则点 -->
            <section class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-gold-400 mb-3 font-display">碎片 → 法则点</div>
              <div class="text-[11px] text-fg-secondary mb-2">
                · 比率：空间碎片=<span class="num">5</span> 点 / 其他碎片=<span class="num">3</span> 点
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
                <select v-model="convertFragType"
                  class="bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-gold-500 focus:outline-none focus-ring">
                  <option value="">选择碎片类型</option>
                  <option v-for="(info, key) in lawProfile.fragment_types" :key="key" :value="key">
                    {{ info.name }}（存量 <span class="num">{{ lawProfile.fragments[key] || 0 }}</span>）
                  </option>
                </select>
                <input v-model.number="convertFragCount" type="number" min="1" placeholder="碎片数量"
                  class="num bg-surface-sunken border border-line rounded-control px-3 py-2 text-xs text-fg-primary focus:border-gold-500 focus:outline-none focus-ring" />
              </div>
              <AppButton block variant="primary" :disabled="loading.action || !convertFragType || !convertFragCount" @click="handleConvertFragment">
                转换碎片
              </AppButton>
            </section>

            <!-- 法则转换选项 -->
            <section class="bg-surface-hover border border-line rounded-panel p-4">
              <div class="text-sm font-bold text-state-arcane mb-3 font-display">法则转换（消耗法则点，兑换永久/临时效果）</div>
              <EmptyState v-if="lawProfile.convert_options.length === 0" text="暂无可转换选项" />
              <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div v-for="opt in lawProfile.convert_options" :key="opt.convert_id"
                  class="bg-surface-sunken border border-line rounded-control p-2 text-xs">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-state-arcane font-bold">{{ opt.name }}</span>
                    <span class="text-gold-400 num">{{ opt.cost_law_points }} 点</span>
                  </div>
                  <!-- 名称本身已含效果数值（如「问道感悟 +10」），效果说明取后端 description -->
                  <div v-if="opt.description" class="text-fg-secondary text-[11px] mb-2">
                    · {{ opt.description }}
                  </div>
                  <AppButton block size="xs" variant="outline" :disabled="loading.action" @click="handleConvertLaw(opt.convert_id)">
                    转换
                  </AppButton>
                </div>
              </div>
            </section>
          </template>
        </div>
      </div>
    </div>

    <!-- 二次确认弹窗（通用） -->
    <Modal :isOpen="confirmModal.show" :title="confirmModal.title" @close="confirmModal.show = false" width="420px">
      <p class="text-fg-secondary text-sm whitespace-pre-line wrap-cjk">{{ confirmModal.message }}</p>
      <template #footer>
        <AppButton variant="default" @click="confirmModal.show = false">取消</AppButton>
        <AppButton variant="primary" :disabled="loading.action" @click="confirmModal.onConfirm(); confirmModal.show = false">
          确认
        </AppButton>
      </template>
    </Modal>
  </PanelShell>
</template>


<script setup lang="ts">
/**
 * 小世界综合面板脚本
 * 5 Tab 共享一个面板，按需懒加载对应子模块数据
 */
import { ref, reactive, onMounted } from 'vue';
import { formatBeijing } from '../../utils/time';
import Modal from '../common/Modal.vue';
import PanelShell from '../ui/PanelShell.vue';
import Tabs from '../ui/Tabs.vue';
import AppButton from '../ui/AppButton.vue';
import Badge from '../ui/Badge.vue';
import StatBar from '../ui/StatBar.vue';
import EmptyState from '../ui/EmptyState.vue';
import LoadingBlock from '../ui/LoadingBlock.vue';
import { useUIStore } from '../../stores/ui';
import { formatCompact } from '../../utils/format';
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

/** Tab 配置（key/label 契约见 ui/Tabs.vue） */
const tabs = [
  { key: 'small_world', label: '小世界' },
  { key: 'divine_temple', label: '神庙' },
  { key: 'incense', label: '香火' },
  { key: 'divine_sense', label: '神识' },
  { key: 'law', label: '法则' }
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
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(time, { dateStyle: 'short', seconds: false, fallback: '-' });
}
</script>
