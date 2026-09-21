<template>
  <!--
    洞府社交面板：拜访洞府、留言板、访客记录、景观布置、洞府商人。

    设计原则：
      - 所有业务逻辑在后端，前端仅做展示与接口调用
      - 禁用浏览器原生 alert/confirm，使用自定义 Modal 二次确认
      - 颜色风格：洞府社交用青绿色系（emerald），中性层一律取 surface-*/line-*/fg-* 令牌，
        鎏金强调统一走同值的 gold-* 令牌
      - 外壳与标签页走 ui/PanelShell.vue + ui/Tabs.vue，内容自管滚动（scoped-scroll）

    Tab 结构：
      1. 留言板：查看自己洞府的留言 + 在他人洞府留言
      2. 访客录：查看自己洞府的访客记录 + 拜访他人洞府
      3. 景观：查看可布置的景观列表 + 布置景观
      4. 游商：查看洞府商人货品 + 购买商品
      5. 寻宝：在他人洞府地块寻宝，触发宝物/陷阱/遭遇，资源真实转移（多人交互核心）
      6. 接待：洞府主人对接待访客进行接待（赠予临时增益buff）/ 驱逐（封锁拜访+寻宝）/ 忽略
         — 与洞天寻宝联动形成社交博弈：接待后访客若寻宝该洞府，被发现率额外+50%（背叛惩罚）
      7. 万宝阁：展品上架/取下/鉴赏/热度榜
      8. 绘卷：洞天风貌评级 + 题词互动 + 风貌榜

    数据来源：api/caveSocial（getMessages / getVisitors / getLandscapes / getMerchantGoods /
    treasureHunt / getVisitorReceptionList / getMyExhibits / getMyScroll 等，逐个 Tab 懒加载）
  -->
  <PanelShell
    title="洞府社交"
    size="xl"
    scoped-scroll
    @close="$emit('close')"
  >
    <div class="h-full flex flex-col">
      <!-- Tab 切换栏 -->
      <Tabs
        :model-value="activeTab"
        :items="tabs"
        class="shrink-0 px-4"
        @update:model-value="switchTab"
      />

      <!-- 内容滚动区 -->
      <div class="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-4 space-y-4">
        <!-- ===== Tab 1: 留言板 ===== -->
        <div v-if="activeTab === 'messages'">
          <!-- 在他人洞府留言 -->
          <div class="bg-surface-hover border border-line rounded-lg p-3 mb-3">
            <h3 class="text-sm font-bold text-emerald-300 mb-2">📝 留言给道友</h3>
            <div class="flex gap-2 mb-2">
              <input
                v-model.number="messageForm.target_player_id"
                type="number"
                placeholder="目标玩家 ID"
                class="flex-1 bg-surface-raised border border-line rounded px-2 py-1 text-fg-primary text-sm focus:border-emerald-600/50 focus:outline-none"
              />
            </div>
            <textarea
              v-model="messageForm.content"
              rows="2"
              maxlength="200"
              placeholder="留言内容（最多 200 字）..."
              class="w-full bg-surface-raised border border-line rounded px-2 py-1 text-fg-primary text-sm focus:border-emerald-600/50 focus:outline-none resize-none mb-2"
            ></textarea>
            <button
              @click="handleLeaveMessage"
              :disabled="actionLoading || !messageForm.target_player_id || !messageForm.content"
              class="px-3 py-1 text-sm bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-30"
            >
              {{ actionLoading ? '发送中...' : '发送留言' }}
            </button>
          </div>

          <!-- 我的留言板 -->
          <div>
            <h3 class="text-sm font-bold text-emerald-300 mb-2">📬 我的洞府留言</h3>
            <LoadingBlock v-if="messagesLoading" />
            <EmptyState v-else-if="messages.length === 0" text="暂无留言" />
            <div v-else class="space-y-2">
              <div
                v-for="msg in messages"
                :key="msg.id"
                class="bg-surface-hover border border-line rounded-lg p-3"
              >
                <div class="flex items-center justify-between mb-1">
                  <span class="text-sm font-bold text-emerald-300">{{ msg.visitor_nickname }}</span>
                  <span class="text-xs text-fg-faint num">{{ formatTime(msg.created_at) }}</span>
                </div>
                <p class="text-sm text-fg-secondary">{{ msg.content }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 2: 访客录 ===== -->
        <div v-else-if="activeTab === 'visitors'">
          <!-- 拜访他人洞府 -->
          <div class="bg-surface-hover border border-line rounded-lg p-3 mb-3">
            <h3 class="text-sm font-bold text-emerald-300 mb-2">🚶 拜访道友洞府</h3>
            <div class="flex gap-2">
              <input
                v-model.number="visitForm.target_player_id"
                type="number"
                placeholder="目标玩家 ID"
                class="flex-1 bg-surface-raised border border-line rounded px-2 py-1 text-fg-primary text-sm focus:border-emerald-600/50 focus:outline-none"
              />
              <button
                @click="handleVisit"
                :disabled="actionLoading || !visitForm.target_player_id"
                class="px-3 py-1 text-sm bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-30"
              >
                {{ actionLoading ? '拜访中...' : '前往拜访' }}
              </button>
            </div>
          </div>

          <!-- 我的访客记录 -->
          <div>
            <h3 class="text-sm font-bold text-emerald-300 mb-2">📖 访客录</h3>
            <LoadingBlock v-if="visitorsLoading" />
            <EmptyState v-else-if="visitors.length === 0" text="暂无访客记录" />
            <div v-else class="space-y-2">
              <div
                v-for="visitor in visitors"
                :key="visitor.id"
                class="bg-surface-hover border border-line rounded-lg p-3 flex items-center justify-between"
              >
                <div>
                  <span class="text-sm font-bold text-fg-primary">{{ visitor.visitor_nickname }}</span>
                  <span v-if="visitor.visitor_realm_rank > 0" class="text-xs text-fg-muted ml-2">第 <span class="num">{{ visitor.visitor_realm_rank }}</span> 阶</span>
                </div>
                <span class="text-xs text-fg-faint num">{{ formatTime(visitor.visited_at) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 3: 景观 ===== -->
        <div v-else-if="activeTab === 'landscape'">
          <LoadingBlock v-if="landscapeLoading" />
          <EmptyState v-else-if="landscapes.length === 0" text="暂无可布置的景观" />
          <div v-else class="space-y-2">
            <div class="bg-emerald-950/20 border border-emerald-800/40 rounded-lg p-2 mb-2 text-xs text-emerald-300/80">
              当前景观：<span class="font-bold">{{ currentLandscapeName || '未布置' }}</span>
            </div>
            <div
              v-for="ls in landscapes"
              :key="ls.id"
              class="bg-surface-hover border rounded-lg p-3 transition-colors"
              :class="ls.is_current ? 'border-emerald-600/50' : 'border-line hover:border-emerald-800/50'"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-sm font-bold text-fg-primary">{{ ls.name }}</span>
                    <span v-if="ls.is_current" class="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-700/50">当前</span>
                    <span v-if="!ls.can_setup" class="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-fg-faint border border-line">境界不足</span>
                  </div>
                  <p class="text-xs text-fg-muted mb-1">{{ ls.description }}</p>
                  <div class="flex gap-3 text-xs">
                    <span class="text-gold-400 num" :title="String(ls.cost)">消耗：{{ formatCompact(ls.cost) }} 灵石</span>
                    <span class="text-emerald-400">加成：{{ formatBonus(ls.bonus) }}</span>
                  </div>
                </div>
                <button
                  v-if="!ls.is_current && ls.can_setup"
                  @click="handleSetLandscape(ls)"
                  :disabled="actionLoading"
                  class="px-3 py-1 text-xs bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-50 shrink-0"
                >
                  布置
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 4: 游商 ===== -->
        <div v-else-if="activeTab === 'merchant'">
          <LoadingBlock v-if="merchantLoading" />
          <template v-else-if="merchantGoods.length > 0">
            <!-- 刷新时间 -->
            <div class="bg-emerald-950/20 border border-emerald-800/40 rounded-lg p-2 mb-3 text-xs text-emerald-300/80">
              下次刷新：{{ formatTime(merchantRefreshAt) }}
            </div>
            <!-- 商品列表 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div
                v-for="good in merchantGoods"
                :key="good.index"
                class="bg-surface-hover border border-line rounded-lg p-3"
              >
                <div class="flex items-center justify-between mb-1">
                  <span class="text-sm font-bold text-fg-primary">{{ good.item_name }}</span>
                  <span v-if="good.discount_rate < 1" class="text-xs text-emerald-400 num">折扣 {{ (good.discount_rate * 10).toFixed(1) }}折</span>
                  <span v-else-if="good.discount_rate > 1" class="text-xs text-rose-400 num">溢价 +{{ Math.round((good.discount_rate - 1) * 100) }}%</span>
                </div>
                <div class="flex items-center justify-between">
                  <div>
                    <span class="text-gold-400 font-bold num" :title="String(good.price)">{{ formatCompact(good.price) }}</span>
                    <span class="text-xs text-fg-faint ml-1">灵石</span>
                    <span v-if="good.base_price !== good.price" class="text-xs text-fg-faint line-through ml-1 num" :title="String(good.base_price)">{{ formatCompact(good.base_price) }}</span>
                    <span v-if="good.remaining < 5" class="text-xs text-rose-400 ml-2 num">仅剩 {{ good.remaining }}</span>
                  </div>
                  <button
                    v-if="good.remaining > 0"
                    @click="handleBuy(good)"
                    :disabled="actionLoading"
                    class="px-2 py-1 text-xs bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-50"
                  >
                    购买
                  </button>
                  <span v-else class="text-xs text-fg-faint">已售罄</span>
                </div>
              </div>
            </div>
          </template>
          <EmptyState v-else text="游商暂时没有货品，请稍后再来" />
        </div>

        <!-- ===== Tab 5: 寻宝 ===== -->
        <div v-else-if="activeTab === 'treasure'">
          <!-- 寻宝操作区 -->
          <div class="bg-surface-hover border border-line rounded-lg p-3 mb-3">
            <h3 class="text-sm font-bold text-emerald-300 mb-2">💎 洞天寻宝</h3>
            <p class="text-xs text-fg-muted mb-2">
              拜访道友洞府，选择地块探索。寻宝成功可从对方灵石中借取资源，失败则触发陷阱或护阵反噬。
              <span class="text-rose-400">每日限 {{ treasureDailyLimit }} 次，同一洞府 24 小时内仅可寻宝一次。</span>
            </p>
            <div class="flex gap-2 mb-3">
              <input
                v-model.number="treasureForm.target_player_id"
                type="number"
                placeholder="目标洞府主人 ID"
                class="flex-1 bg-surface-raised border border-line rounded px-2 py-1 text-fg-primary text-sm focus:border-emerald-600/50 focus:outline-none"
              />
            </div>
            <!-- 九宫格地块选择 -->
            <div class="grid grid-cols-3 gap-2 mb-3">
              <button
                v-for="n in 9"
                :key="n"
                @click="treasureForm.plot_number = n"
                :disabled="actionLoading || !treasureForm.target_player_id"
                :class="treasureForm.plot_number === n
                  ? 'bg-emerald-900/60 border-emerald-500 text-emerald-200'
                  : 'bg-surface-raised border-line text-fg-secondary hover:border-emerald-800/50'"
                class="aspect-square border rounded-lg flex flex-col items-center justify-center transition-colors disabled:opacity-30"
              >
                <span class="text-xs text-fg-faint">地块</span>
                <span class="text-lg font-bold">{{ n }}</span>
              </button>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-fg-muted">
                今日已寻宝 <span class="num">{{ treasureTodayCount }} / {{ treasureDailyLimit }}</span> 次
              </span>
              <button
                @click="handleTreasureHunt"
                :disabled="actionLoading || !treasureForm.target_player_id || !treasureForm.plot_number"
                class="px-3 py-1 text-sm bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-30"
              >
                {{ actionLoading ? '探索中...' : `开始寻宝（消耗 ${treasureCost} 灵石）` }}
              </button>
            </div>
          </div>

          <!-- 寻宝日志切换 -->
          <div class="flex gap-2 mb-2">
            <button
              @click="loadTreasureLogs('hunter')"
              :class="treasureLogRole === 'hunter'
                ? 'text-emerald-400 border-b-2 border-emerald-400'
                : 'text-fg-muted hover:text-fg-primary border-b-2 border-transparent'"
              class="px-2 py-1 text-xs font-medium transition-colors"
            >
              我的寻宝记录
            </button>
            <button
              @click="loadTreasureLogs('owner')"
              :class="treasureLogRole === 'owner'
                ? 'text-emerald-400 border-b-2 border-emerald-400'
                : 'text-fg-muted hover:text-fg-primary border-b-2 border-transparent'"
              class="px-2 py-1 text-xs font-medium transition-colors"
            >
              洞府被寻宝记录
            </button>
          </div>

          <!-- 寻宝日志列表 -->
          <LoadingBlock v-if="treasureLogsLoading" />
          <EmptyState v-else-if="treasureLogs.length === 0" text="暂无寻宝记录" />
          <div v-else class="space-y-2">
            <div
              v-for="log in treasureLogs"
              :key="log.id"
              class="bg-surface-hover border border-line rounded-lg p-3"
            >
              <div class="flex items-center justify-between mb-1">
                <div class="flex items-center gap-2">
                  <span
                    class="text-xs px-1.5 py-0.5 rounded border"
                    :class="treasureResultBadgeClass(log.result_type)"
                  >
                    {{ treasureResultLabel(log.result_type) }}
                  </span>
                  <span class="text-sm font-bold text-fg-primary">
                    {{ treasureLogRole === 'hunter' ? log.cave_owner_nickname : log.hunter_nickname }}
                  </span>
                  <span class="text-xs text-fg-faint">
                    {{ treasureLogRole === 'hunter' ? '的洞府' : '闯入了你的洞府' }}
                  </span>
                </div>
                <span class="text-xs text-fg-faint num">{{ formatTime(log.created_at) }}</span>
              </div>
              <div class="flex items-center gap-3 text-xs mt-1">
                <span class="text-fg-faint">地块 {{ log.plot_number }}</span>
                <span v-if="log.is_discovered" class="text-rose-400">⚠ 已被对方发现</span>
                <!-- 奖励/损失明细 -->
                <span v-if="log.rewards?.spirit_stones" class="text-gold-400 num" :title="String(log.rewards.spirit_stones)">+{{ formatCompact(log.rewards.spirit_stones) }} 灵石</span>
                <span v-if="log.rewards?.exp" class="text-purple-300 num" :title="String(log.rewards.exp)">+{{ formatCompact(log.rewards.exp) }} 修为</span>
                <span v-if="log.rewards?.item_name" class="text-emerald-300">💎 {{ log.rewards.item_name }}</span>
                <span v-if="log.rewards?.hp_loss" class="text-rose-400">-{{ log.rewards.hp_loss }} 气血</span>
                <span v-if="log.rewards?.spirit_stone_loss" class="text-rose-400 num" :title="String(log.rewards.spirit_stone_loss)">-{{ formatCompact(log.rewards.spirit_stone_loss) }} 灵石</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 6: 接待 ===== -->
        <div v-else-if="activeTab === 'reception'">
          <!-- 玩法说明 -->
          <div class="bg-emerald-950/20 border border-emerald-800/40 rounded-lg p-3 mb-3 text-xs text-emerald-300/80">
            <p class="mb-1">🍵 <span class="font-bold">接待访客</span>：消耗灵石赠予访客临时增益buff（悟道经验+10%、游商折扣+10%，持续2小时）。</p>
            <p class="mb-1">⚔️ <span class="font-bold">驱逐访客</span>：封锁该访客24小时内无法拜访和寻宝你的洞府。</p>
            <p class="text-rose-400/80">⚠ <span class="font-bold">背叛惩罚</span>：接待期间访客若寻宝你的洞府，被发现率额外+50%。</p>
          </div>

          <!-- 待处理访客列表 -->
          <div class="mb-4">
            <h3 class="text-sm font-bold text-emerald-300 mb-2">
              📋 待处理访客
              <span v-if="receptionPending.length > 0" class="text-xs text-fg-muted ml-1">（{{ receptionPending.length }} 人）</span>
            </h3>
            <LoadingBlock v-if="receptionLoading" />
            <EmptyState v-else-if="receptionPending.length === 0" text="暂无待处理访客" />
            <div v-else class="space-y-2">
              <div
                v-for="v in receptionPending"
                :key="v.id"
                class="bg-surface-hover border border-line rounded-lg p-3"
              >
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-bold text-fg-primary">{{ v.visitor_nickname }}</span>
                    <span v-if="v.visitor_realm" class="text-xs text-fg-muted">{{ v.visitor_realm }}</span>
                    <span v-if="v.encounter_type" class="text-xs px-1.5 py-0.5 rounded bg-purple-900/30 text-purple-300 border border-purple-700/40">
                      触发奇遇
                    </span>
                  </div>
                  <span class="text-xs text-fg-faint num">{{ formatTime(v.visited_at) }}</span>
                </div>
                <!-- 操作按钮 -->
                <div class="flex gap-2">
                  <button
                    @click="handleReceive(v)"
                    :disabled="actionLoading"
                    class="px-3 py-1 text-xs bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-50"
                  >
                    🍵 接待（消耗 {{ receptionCost }} 灵石）
                  </button>
                  <button
                    @click="handleExpel(v)"
                    :disabled="actionLoading"
                    class="px-3 py-1 text-xs bg-rose-900/30 text-rose-300 border border-rose-700/50 rounded hover:bg-rose-800/50 transition-colors disabled:opacity-50"
                  >
                    ⚔️ 驱逐
                  </button>
                  <button
                    @click="handleIgnore(v)"
                    :disabled="actionLoading"
                    class="px-3 py-1 text-xs bg-surface-hover text-fg-muted border border-line rounded hover:bg-surface-active transition-colors disabled:opacity-50"
                  >
                    无视
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 近期处理记录 -->
          <div v-if="receptionRecent.length > 0">
            <h3 class="text-sm font-bold text-fg-muted mb-2">📜 近期处理记录</h3>
            <div class="space-y-2">
              <div
                v-for="v in receptionRecent"
                :key="v.id"
                class="bg-surface-hover border border-line rounded-lg p-3 flex items-center justify-between"
              >
                <div class="flex items-center gap-2">
                  <span
                    class="text-xs px-1.5 py-0.5 rounded border"
                    :class="receptionStatusBadgeClass(v.reception_status)"
                  >
                    {{ receptionStatusLabel(v.reception_status) }}
                  </span>
                  <span class="text-sm text-fg-primary">{{ v.visitor_nickname }}</span>
                  <span v-if="v.buff_active" class="text-xs text-emerald-400">增益生效中</span>
                  <span v-if="v.block_active" class="text-xs text-rose-400">封锁生效中</span>
                </div>
                <span class="text-xs text-fg-faint num">{{ formatTime(v.reception_at || v.visited_at) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 7: 万宝阁 ===== -->
        <div v-else-if="activeTab === 'pavilion'">
          <!-- 玩法说明 -->
          <div class="bg-surface-tint-gold border border-gold-800/40 rounded-lg p-3 mb-3 text-xs text-gold-300/80">
            <p class="mb-1">🏺 <span class="font-bold">万宝阁展品</span>：将珍贵物品上架展示，彰显实力。展品被鉴赏可累积热度，高品质展品为主人带来声望。</p>
            <p class="mb-1">✨ <span class="font-bold">鉴赏展品</span>：拜访他人洞府后可鉴赏展品获得修为，有概率触发<span class="text-gold-400">顿悟</span>（修为×3 + 临时修炼加成）。</p>
            <p class="text-rose-400/80">⚠ <span class="font-bold">财富外露</span>：展品越多越显眼，被寻宝成功率上升；传说级以上展品自带灵气护体，可提升大阵防御。</p>
          </div>

          <!-- 我的展品管理 -->
          <div class="bg-surface-hover border border-line rounded-lg p-3 mb-3">
            <h3 class="text-sm font-bold text-gold-300 mb-2 flex items-center justify-between">
              <span>🏺 我的展品（{{ myExhibits.length }}/{{ maxExhibits }}）</span>
              <span class="text-xs text-fg-faint">最低品质：{{ qualityLabel(minExhibitQuality) }}</span>
            </h3>

            <!-- 上架表单 -->
            <div class="flex gap-2 mb-3" v-if="myExhibits.length < maxExhibits">
              <input
                v-model="listExhibitForm.item_key"
                type="text"
                placeholder="输入物品ID（如 foundation_pill）"
                class="flex-1 bg-surface-raised border border-line rounded px-2 py-1 text-fg-primary text-sm focus:border-gold-600/50 focus:outline-none"
              />
              <button
                @click="handleListExhibit"
                :disabled="actionLoading || !listExhibitForm.item_key"
                class="px-3 py-1 text-sm bg-gold-900/40 text-gold-300 border border-gold-700/50 rounded hover:bg-gold-800/50 transition-colors disabled:opacity-30"
              >
                上架
              </button>
            </div>
            <p v-else class="text-xs text-rose-400 mb-3">展位已满，请先取下部分展品</p>

            <!-- 展品列表 -->
            <LoadingBlock v-if="exhibitLoading" />
            <EmptyState v-else-if="myExhibits.length === 0" text="暂无展品，上架珍宝彰显实力" />
            <div v-else class="space-y-2">
              <div
                v-for="e in myExhibits"
                :key="e.id"
                class="bg-surface-raised border border-line rounded-lg p-2.5"
              >
                <div class="flex items-start justify-between">
                  <div class="flex-1">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-sm font-bold text-fg-primary">{{ e.item_name }}</span>
                      <span class="text-xs px-1.5 py-0.5 rounded border" :class="qualityBadgeClass(e.quality)">
                        {{ qualityLabel(e.quality) }}
                      </span>
                      <span class="text-xs text-fg-faint">#{{ e.exhibit_slot }}</span>
                    </div>
                    <div class="text-xs text-fg-muted mb-1">{{ e.description || '无描述' }}</div>
                    <div class="text-xs text-gold-400 num" :title="String(e.heat_count)">🔥 热度：{{ formatCompact(e.heat_count) }}</div>
                  </div>
                  <button
                    @click="handleUnlistExhibit(e)"
                    :disabled="actionLoading"
                    class="px-2 py-1 text-xs bg-surface-hover text-fg-secondary border border-line rounded hover:bg-surface-active transition-colors disabled:opacity-50"
                  >
                    取下
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 鉴赏他人展品 -->
          <div class="bg-surface-hover border border-line rounded-lg p-3 mb-3">
            <h3 class="text-sm font-bold text-emerald-300 mb-2">✨ 鉴赏他人展品</h3>
            <div class="flex gap-2 mb-2">
              <input
                v-model.number="viewTargetPlayerId"
                type="number"
                placeholder="目标玩家 ID"
                class="flex-1 bg-surface-raised border border-line rounded px-2 py-1 text-fg-primary text-sm focus:border-emerald-600/50 focus:outline-none"
              />
              <button
                @click="handleViewExhibits"
                :disabled="viewExhibitsLoading"
                class="px-3 py-1 text-sm bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-50"
              >
                查看
              </button>
            </div>
            <div class="text-xs text-fg-faint mb-2">
              今日鉴赏：<span class="num">{{ appreciateTodayCount }}/{{ appreciateDailyLimit }}</span> 次
            </div>

            <!-- 目标展品列表 -->
            <LoadingBlock v-if="viewExhibitsLoading" />
            <EmptyState v-else-if="viewingExhibits.length === 0 && viewingTargetInfo" text="对方洞府万宝阁暂无展品" />
            <div v-else-if="viewingExhibits.length > 0" class="space-y-2">
              <div class="text-xs text-fg-muted mb-1">
                {{ viewingTargetInfo?.nickname || '未知' }} 的展品（{{ viewingExhibits.length }} 件）
              </div>
              <div
                v-for="e in viewingExhibits"
                :key="e.id"
                class="bg-surface-raised border border-line rounded-lg p-2.5"
              >
                <div class="flex items-start justify-between">
                  <div class="flex-1">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-sm font-bold text-fg-primary">{{ e.item_name }}</span>
                      <span class="text-xs px-1.5 py-0.5 rounded border" :class="qualityBadgeClass(e.quality)">
                        {{ qualityLabel(e.quality) }}
                      </span>
                    </div>
                    <div class="text-xs text-fg-muted mb-1">{{ e.description || '无描述' }}</div>
                    <div class="text-xs text-gold-400 num" :title="String(e.heat_count)">🔥 热度：{{ formatCompact(e.heat_count) }}</div>
                  </div>
                  <button
                    v-if="!e.appreciated_today"
                    @click="handleAppreciate(e)"
                    :disabled="actionLoading || appreciateTodayCount >= appreciateDailyLimit"
                    class="px-2 py-1 text-xs bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/50 transition-colors disabled:opacity-50"
                  >
                    鉴赏
                  </button>
                  <span v-else class="text-xs text-fg-faint px-2 py-1">今日已鉴赏</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 热度榜 -->
          <div class="bg-surface-hover border border-line rounded-lg p-3">
            <h3 class="text-sm font-bold text-gold-300 mb-2">🏆 展品热度榜</h3>
            <LoadingBlock v-if="heatBoardLoading" />
            <EmptyState v-else-if="heatBoard.length === 0" text="暂无热度展品" />
            <div v-else class="space-y-1.5">
              <div
                v-for="item in heatBoard"
                :key="item.exhibit_id"
                class="flex items-center gap-2 bg-surface-raised border border-line rounded px-2.5 py-1.5"
              >
                <span class="text-sm font-bold w-6 text-center" :class="item.rank <= 3 ? 'text-gold-400' : 'text-fg-faint'">
                  {{ item.rank }}
                </span>
                <span class="text-xs px-1.5 py-0.5 rounded border" :class="qualityBadgeClass(item.quality)">
                  {{ qualityLabel(item.quality) }}
                </span>
                <span class="text-sm text-fg-primary flex-1">{{ item.item_name }}</span>
                <span class="text-xs text-fg-muted">{{ item.owner_nickname }}</span>
                <span class="text-xs text-gold-400 num" :title="String(item.heat_count)">🔥{{ formatCompact(item.heat_count) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== Tab 8: 绘卷 ===== -->
        <div v-else-if="activeTab === 'scroll'">
          <!-- 说明区 -->
          <div class="bg-surface-raised border border-line rounded p-3 mb-3 text-xs text-fg-muted leading-relaxed">
            <p class="mb-1">📜 <span class="font-bold">洞天绘卷</span>：展示洞府全景风貌，含设施、景观、展品、人气四维评级（凡/灵/玄/地/天/仙六品）。</p>
            <p class="mb-1">✍️ <span class="font-bold">题词互动</span>：拜访道友洞府后可题词留言，被题词者获得<span class="text-gold-400">声望</span>奖励（每日上限20点）。</p>
            <p class="text-rose-400/80">⚠ 每日题词限5次，同一洞府每日仅可题词1次，题词内容限20字。</p>
          </div>

          <!-- 查看模式切换 -->
          <div class="flex gap-2 mb-3">
            <button
              @click="switchScrollViewMode('mine')"
              :class="scrollViewMode === 'mine'
                ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50'
                : 'bg-surface-hover text-fg-muted border-line'"
              class="flex-1 px-3 py-1.5 text-sm border rounded transition-colors"
            >📜 我的绘卷</button>
            <button
              @click="switchScrollViewMode('others')"
              :class="scrollViewMode === 'others'
                ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50'
                : 'bg-surface-hover text-fg-muted border-line'"
              class="flex-1 px-3 py-1.5 text-sm border rounded transition-colors"
            >✍️ 题词道友</button>
          </div>

          <!-- ===== 我的绘卷区 ===== -->
          <div v-if="scrollViewMode === 'mine'">
            <LoadingBlock v-if="scrollLoading" text="绘卷展开中…" />
            <EmptyState v-else-if="!myScrollData" text="暂无绘卷数据，请先开辟洞府" />
            <div v-else>
              <!-- 洞府全景 + 评级 -->
              <div class="bg-gradient-to-br from-surface-raised to-surface-hover border border-line rounded p-4 mb-3">
                <div class="flex items-center justify-between mb-3">
                  <div>
                    <h3 class="text-base font-bold text-gold-200">{{ myScrollData.owner.nickname }} 的洞天</h3>
                    <p class="text-xs text-fg-muted mt-0.5">{{ myScrollData.owner.realm }} · 开辟于 {{ formatTime(myScrollData.cave.opened_at) }}</p>
                  </div>
                  <span
                    class="px-3 py-1 text-sm font-bold rounded border"
                    :class="ratingBadgeClass(myScrollData.rating.tier_index)"
                  >{{ myScrollData.rating.tier_name }}</span>
                </div>
                <!-- 设施一览 -->
                <div class="grid grid-cols-3 gap-2 text-xs">
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">灵脉</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ myScrollData.cave.facilities.spirit_vein }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">静室</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ myScrollData.cave.facilities.quiet_room }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">丹房</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ myScrollData.cave.facilities.pill_room }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">器室</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ myScrollData.cave.facilities.tool_room }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">大阵</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ myScrollData.cave.facilities.grand_formation }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">药园</span>
                    <span class="text-emerald-300 ml-1">{{ myScrollData.cave.garden_plots }} 块</span>
                  </div>
                </div>
                <!-- 景观 + 展品 -->
                <div class="mt-2 flex items-center gap-3 text-xs">
                  <span class="text-fg-faint">景观：</span>
                  <span v-if="myScrollData.cave.landscape" class="text-purple-300">{{ myScrollData.cave.landscape.name }}</span>
                  <span v-else class="text-fg-faint">未布置</span>
                  <span class="text-fg-faint ml-3">展品：</span>
                  <span class="text-gold-300">{{ myScrollData.exhibits.count }} 件</span>
                </div>
              </div>

              <!-- 风貌得分 + 统计明细 -->
              <div class="bg-surface-raised border border-line rounded p-3 mb-3">
                <h4 class="text-xs font-bold text-fg-secondary mb-2">📊 风貌得分与统计</h4>
                <div class="space-y-1.5 text-xs">
                  <div class="border-t border-line pt-1.5 flex justify-between font-bold">
                    <span class="text-fg-secondary">综合得分</span>
                    <span class="text-gold-200 num" :title="String(myScrollData.rating.score)">{{ formatCompact(myScrollData.rating.score) }}</span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-fg-muted">设施总等级</span>
                    <span class="text-emerald-300 num" :title="String(myScrollData.cave.facility_total_level)">{{ formatCompact(myScrollData.cave.facility_total_level) }}</span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-fg-muted">展品数量 / 总热度</span>
                    <span class="text-gold-300">{{ myScrollData.exhibits.count }} 件 / <span class="num" :title="String(myScrollData.exhibits.total_heat)">🔥{{ formatCompact(myScrollData.exhibits.total_heat) }}</span></span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-fg-muted">访客数 / 留言数</span>
                    <span class="text-rose-300 num">{{ myScrollData.popularity.visitor_count }} / {{ myScrollData.popularity.message_count }}</span>
                  </div>
                  <div v-if="myScrollData.exhibits.top_exhibits && myScrollData.exhibits.top_exhibits.length > 0" class="pt-1.5 border-t border-line">
                    <span class="text-fg-muted">珍宝精选：</span>
                    <span v-for="(ex, i) in myScrollData.exhibits.top_exhibits" :key="i" class="text-gold-200 ml-1">
                      {{ ex.item_name }}(<span class="num" :title="String(ex.heat_count)">🔥{{ formatCompact(ex.heat_count) }}</span>)
                    </span>
                  </div>
                </div>
              </div>

              <!-- 近期题词 -->
              <div class="bg-surface-raised border border-line rounded p-3">
                <h4 class="text-xs font-bold text-fg-secondary mb-2">✍️ 近期题词（{{ myScrollData.inscriptions?.length || 0 }}）</h4>
                <EmptyState icon="🖋" v-if="!myScrollData.inscriptions || myScrollData.inscriptions.length === 0" text="尚无道友题词，邀请好友来访题词吧" />
                <div v-else class="space-y-2">
                  <div
                    v-for="ins in myScrollData.inscriptions"
                    :key="ins.id"
                    class="bg-surface-hover border border-line rounded px-3 py-2"
                  >
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-xs text-emerald-300 font-bold">{{ ins.inscriber_nickname }}</span>
                      <span class="text-xs text-fg-faint num">{{ formatTime(ins.created_at) }}</span>
                    </div>
                    <p class="text-sm text-gold-200 italic">"{{ ins.content }}"</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ===== 查看他人绘卷 + 题词区 ===== -->
          <div v-if="scrollViewMode === 'others'">
            <!-- 目标ID输入 -->
            <div class="flex gap-2 mb-3">
              <input
                v-model.number="viewScrollTargetId"
                type="number"
                placeholder="输入道友玩家ID"
                class="flex-1 bg-surface-raised border border-line rounded px-3 py-1.5 text-sm text-fg-primary placeholder:text-fg-faint focus:border-emerald-700 focus:outline-none"
                @keyup.enter="handleViewPlayerScroll"
              />
              <button
                @click="handleViewPlayerScroll"
                :disabled="viewScrollLoading"
                class="px-4 py-1.5 text-sm bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 rounded hover:bg-emerald-800/60 transition-colors disabled:opacity-50"
              >{{ viewScrollLoading ? '展开中...' : '展开绘卷' }}</button>
            </div>

            <!-- 他人绘卷展示 -->
            <LoadingBlock v-if="viewScrollLoading" text="绘卷展开中…" />
            <EmptyState v-else-if="!viewScrollData" text="输入道友ID，欣赏其洞天绘卷并题词" />
            <div v-else>
              <!-- 目标洞府全景 + 评级 -->
              <div class="bg-gradient-to-br from-surface-raised to-surface-hover border border-line rounded p-4 mb-3">
                <div class="flex items-center justify-between mb-3">
                  <div>
                    <h3 class="text-base font-bold text-gold-200">{{ viewScrollData.owner.nickname }} 的洞天</h3>
                    <p class="text-xs text-fg-muted mt-0.5">{{ viewScrollData.owner.realm }}</p>
                  </div>
                  <span
                    class="px-3 py-1 text-sm font-bold rounded border"
                    :class="ratingBadgeClass(viewScrollData.rating.tier_index)"
                  >{{ viewScrollData.rating.tier_name }}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 text-xs">
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">灵脉</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ viewScrollData.cave.facilities.spirit_vein }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">静室</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ viewScrollData.cave.facilities.quiet_room }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">丹房</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ viewScrollData.cave.facilities.pill_room }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">器室</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ viewScrollData.cave.facilities.tool_room }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">大阵</span>
                    <span class="text-emerald-300 ml-1 num">Lv.{{ viewScrollData.cave.facilities.grand_formation }}</span>
                  </div>
                  <div class="bg-surface-raised border border-line rounded px-2 py-1.5">
                    <span class="text-fg-faint">景观</span>
                    <span v-if="viewScrollData.cave.landscape" class="text-purple-300 ml-1">{{ viewScrollData.cave.landscape.name }}</span>
                    <span v-else class="text-fg-faint ml-1">无</span>
                  </div>
                </div>
                <!-- 得分简览 -->
                <div class="mt-2 flex items-center justify-between text-xs">
                  <span class="text-fg-muted">综合得分：<span class="text-gold-200 font-bold num" :title="String(viewScrollData.rating.score)">{{ formatCompact(viewScrollData.rating.score) }}</span></span>
                  <span class="text-fg-muted">展品：<span class="text-gold-300">{{ viewScrollData.exhibits.count }}</span> 件</span>
                </div>
              </div>

              <!-- 题词输入区 -->
              <div class="bg-surface-raised border border-line rounded p-3 mb-3">
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-xs font-bold text-fg-secondary">✍️ 题词留言</h4>
                  <span class="text-xs" :class="viewScrollData.today_inscribed ? 'text-rose-400' : 'text-emerald-400'">
                    {{ viewScrollData.today_inscribed ? '今日已题词' : `剩余 ${(viewScrollData.inscribe_daily_limit || 0) - (viewScrollData.inscribe_today_count || 0)} 次` }}
                  </span>
                </div>
                <div v-if="viewScrollData.today_inscribed" class="text-xs text-fg-faint py-2">
                  今日已为该洞府题词，同一洞府每日仅可题词一次
                </div>
                <div v-else-if="!viewScrollData.can_inscribe" class="text-xs text-fg-faint py-2">
                  今日题词次数已用完，明日再来
                </div>
                <div v-else>
                  <textarea
                    v-model="inscribeForm.content"
                    maxlength="20"
                    placeholder="题词内容（限20字，如：仙府灵气盎然，令人心旷神怡）"
                    class="w-full bg-surface-hover border border-line rounded px-3 py-2 text-sm text-fg-primary placeholder:text-fg-faint focus:border-emerald-700 focus:outline-none resize-none"
                    rows="2"
                  ></textarea>
                  <div class="flex items-center justify-between mt-2">
                    <span class="text-xs text-fg-faint">{{ (inscribeForm.content || '').length }}/20</span>
                    <button
                      @click="handleInscribe"
                      :disabled="inscribeSubmitting || !inscribeForm.content?.trim()"
                      class="px-4 py-1.5 text-sm bg-gold-900/50 text-gold-300 border border-gold-700/50 rounded hover:bg-gold-800/60 transition-colors disabled:opacity-50"
                    >{{ inscribeSubmitting ? '题词中...' : '落笔题词' }}</button>
                  </div>
                </div>
              </div>

              <!-- 近期题词展示 -->
              <div class="bg-surface-raised border border-line rounded p-3">
                <h4 class="text-xs font-bold text-fg-secondary mb-2">✍️ 题词录（{{ viewScrollData.inscriptions?.length || 0 }}）</h4>
                <EmptyState icon="🖋" v-if="!viewScrollData.inscriptions || viewScrollData.inscriptions.length === 0" text="尚无题词，成为第一位题词者" />
                <div v-else class="space-y-2 max-h-48 overflow-y-auto">
                  <div
                    v-for="ins in viewScrollData.inscriptions"
                    :key="ins.id"
                    class="bg-surface-hover border border-line rounded px-3 py-2"
                  >
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-xs text-emerald-300 font-bold">{{ ins.inscriber_nickname }}</span>
                      <span class="text-xs text-fg-faint num">{{ formatTime(ins.created_at) }}</span>
                    </div>
                    <p class="text-sm text-gold-200 italic">"{{ ins.content }}"</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ===== 风貌排行榜（两种模式都显示） ===== -->
          <div class="mt-3 bg-surface-raised border border-line rounded p-3">
            <h4 class="text-xs font-bold text-fg-secondary mb-2">🏆 洞天风貌榜</h4>
            <LoadingBlock v-if="scrollRankingLoading" text="榜单加载中…" />
            <EmptyState v-else-if="scrollRanking.length === 0" text="暂无榜单数据" />
            <div v-else class="space-y-1.5">
              <div
                v-for="item in scrollRanking"
                :key="item.player_id"
                class="flex items-center gap-2 bg-surface-hover border border-line rounded px-2.5 py-1.5"
              >
                <span class="text-sm font-bold w-6 text-center" :class="item.rank <= 3 ? 'text-gold-400' : 'text-fg-faint'">
                  {{ item.rank }}
                </span>
                <span class="text-xs px-1.5 py-0.5 rounded border" :class="ratingBadgeClass(item.tier_index)">
                  {{ item.tier_name }}
                </span>
                <span class="text-sm text-fg-primary flex-1">{{ item.nickname }}</span>
                <span class="text-xs text-fg-muted">{{ item.realm }}</span>
                <span class="text-xs text-gold-400 num" :title="String(item.score)">{{ formatCompact(item.score) }}分</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Modal :isOpen="buyConfirmShow" title="购买商品" @close="buyConfirmShow = false">
        <div class="space-y-2 text-sm text-fg-secondary">
          <p>确认购买此商品？</p>
          <div v-if="pendingBuy" class="bg-surface-hover border border-line rounded p-3 mt-2">
            <div>商品：<span class="text-emerald-300 font-bold">{{ pendingBuy.item_name }}</span></div>
            <div>价格：<span class="text-gold-400 font-bold num" :title="String(pendingBuy.price)">{{ formatCompact(pendingBuy.price) }}</span> 灵石</div>
          </div>
        </div>
        <template #footer>
          <AppButton variant="default" @click="buyConfirmShow = false">取消</AppButton>
          <AppButton variant="primary" @click="confirmBuy">确认购买</AppButton>
        </template>
      </Modal>

      <!-- 布置景观确认弹窗 -->
      <Modal :isOpen="landscapeConfirmShow" title="布置景观" @close="landscapeConfirmShow = false">
        <div class="space-y-2 text-sm text-fg-secondary">
          <p>确认布置此景观？将消耗灵石并替换当前景观。</p>
          <div v-if="pendingLandscape" class="bg-surface-hover border border-line rounded p-3 mt-2">
            <div>景观：<span class="text-emerald-300 font-bold">{{ pendingLandscape.name }}</span></div>
            <div>消耗：<span class="text-gold-400 font-bold num" :title="String(pendingLandscape.cost)">{{ formatCompact(pendingLandscape.cost) }}</span> 灵石</div>
            <div class="text-xs text-fg-muted mt-1">加成：{{ formatBonus(pendingLandscape.bonus) }}</div>
          </div>
        </div>
        <template #footer>
          <AppButton variant="default" @click="landscapeConfirmShow = false">取消</AppButton>
          <AppButton variant="primary" @click="confirmSetLandscape">确认布置</AppButton>
        </template>
      </Modal>

      <!-- ===== 拜访奇遇结果弹窗 ===== -->
      <Modal :isOpen="encounterResultShow" title="🌟 洞府奇遇" @close="encounterResultShow = false">
        <div v-if="encounterResult" class="space-y-3">
          <!-- 奇遇名称和描述 -->
          <div class="text-center py-2">
            <div class="text-lg font-bold"
              :class="encounterResult.type === 'trap' ? 'text-rose-400' : 'text-gold-400'">
              {{ encounterResult.name }}
            </div>
            <p class="text-sm text-fg-muted mt-1">{{ encounterResult.description }}</p>
          </div>

          <!-- 奖励展示 -->
          <div v-if="encounterResult.rewards" class="bg-surface-hover border border-line rounded-lg p-3 space-y-1">
            <div v-if="encounterResult.rewards.item_name" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">获得物品：</span>
              <span class="text-emerald-300 font-bold">💊 {{ encounterResult.rewards.item_name }}</span>
              <span class="text-fg-faint">×{{ encounterResult.rewards.item_count }}</span>
            </div>
            <div v-if="encounterResult.rewards.exp" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">获得修为：</span>
              <span class="text-purple-300 font-bold num" :title="String(encounterResult.rewards.exp)">+{{ formatCompact(encounterResult.rewards.exp) }}</span>
            </div>
            <div v-if="encounterResult.rewards.spirit_stone" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">获得灵石：</span>
              <span class="text-gold-400 font-bold num" :title="String(encounterResult.rewards.spirit_stone)">+{{ formatCompact(encounterResult.rewards.spirit_stone) }}</span>
            </div>
            <div v-if="encounterResult.rewards.hp_loss" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">机关伤害：</span>
              <span class="text-rose-400 font-bold">-{{ encounterResult.rewards.hp_loss }} 气血</span>
            </div>
            <div v-if="encounterResult.type === 'nothing'" class="text-sm text-fg-faint text-center py-1">
              这次什么也没发现...
            </div>
          </div>

          <!-- 今日奇遇次数 -->
          <div class="text-xs text-fg-faint text-center">
            今日奇遇 <span class="num">{{ encounterResult.today_encounters }} / {{ encounterResult.daily_limit }}</span>
          </div>
        </div>
        <template #footer>
          <AppButton variant="primary" @click="encounterResultShow = false">收下</AppButton>
        </template>
      </Modal>

      <!-- ===== 寻宝结果弹窗 ===== -->
      <Modal :isOpen="treasureResultShow" title="💎 洞天寻宝结果" @close="treasureResultShow = false">
        <div v-if="treasureResult" class="space-y-3">
          <!-- 结果标题 -->
          <div class="text-center py-2">
            <div class="text-lg font-bold" :class="treasureResultTitleClass(treasureResult.result_type)">
              {{ treasureResult.result_name }}
            </div>
            <p class="text-sm text-fg-muted mt-1">{{ treasureResult.message }}</p>
            <div class="text-xs text-fg-faint mt-1">
              成功率 {{ (treasureResult.success_rate * 100).toFixed(0) }}% · 地块 {{ treasureResult.plot_number }}
            </div>
          </div>

          <!-- 奖励/损失展示 -->
          <div v-if="treasureResult.rewards" class="bg-surface-hover border border-line rounded-lg p-3 space-y-1">
            <div v-if="treasureResult.rewards.spirit_stones" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">借取灵石：</span>
              <span class="text-gold-400 font-bold num" :title="String(treasureResult.rewards.spirit_stones)">+{{ formatCompact(treasureResult.rewards.spirit_stones) }}</span>
            </div>
            <div v-if="treasureResult.rewards.exp" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">获得修为：</span>
              <span class="text-purple-300 font-bold num" :title="String(treasureResult.rewards.exp)">+{{ formatCompact(treasureResult.rewards.exp) }}</span>
            </div>
            <div v-if="treasureResult.rewards.item_name" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">获得物品：</span>
              <span class="text-emerald-300 font-bold">💎 {{ treasureResult.rewards.item_name }}</span>
            </div>
            <div v-if="treasureResult.rewards.hp_loss" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">陷阱伤害：</span>
              <span class="text-rose-400 font-bold">-{{ treasureResult.rewards.hp_loss }} 气血</span>
            </div>
            <div v-if="treasureResult.rewards.spirit_stone_loss" class="flex items-center gap-2 text-sm">
              <span class="text-fg-muted">损失灵石：</span>
              <span class="text-rose-400 font-bold num" :title="String(treasureResult.rewards.spirit_stone_loss)">-{{ formatCompact(treasureResult.rewards.spirit_stone_loss) }}</span>
            </div>
            <div v-if="treasureResult.result_type === 'empty'" class="text-sm text-fg-faint text-center py-1">
              这块地方似乎什么也没有...
            </div>
          </div>

          <!-- 被发现警告 -->
          <div v-if="treasureResult.is_discovered" class="bg-rose-950/30 border border-rose-800/50 rounded-lg p-2 text-sm text-rose-300 text-center">
            ⚠ 你的行踪被洞府主人发现了！
          </div>

          <!-- 今日寻宝次数 -->
          <div class="text-xs text-fg-faint text-center">
            今日寻宝 <span class="num">{{ treasureResult.today_count }} / {{ treasureResult.daily_limit }}</span> 次
          </div>
        </div>
        <template #footer>
          <AppButton variant="default" @click="treasureResultShow = false">知晓</AppButton>
        </template>
      </Modal>

      <!-- ===== 接待访客确认弹窗 ===== -->
      <Modal :isOpen="receiveConfirmShow" title="🍵 接待访客" @close="receiveConfirmShow = false">
        <div class="space-y-2 text-sm text-fg-secondary">
          <p>确认接待此访客？将消耗灵石赠予临时增益。</p>
          <div v-if="pendingReception" class="bg-surface-hover border border-line rounded p-3 mt-2 space-y-1">
            <div>访客：<span class="text-emerald-300 font-bold">{{ pendingReception.visitor_nickname }}</span></div>
            <div>消耗：<span class="text-gold-400 font-bold num" :title="String(receptionCost)">{{ formatCompact(receptionCost) }}</span> 灵石</div>
            <div class="text-xs text-fg-muted mt-1">
              增益效果：悟道经验+10%、游商折扣+10%，持续2小时
            </div>
            <div class="text-xs text-rose-400/80 mt-1">
              ⚠ 接待期间该访客若寻宝你的洞府，被发现率额外+50%（背叛惩罚）
            </div>
          </div>
        </div>
        <template #footer>
          <AppButton variant="default" @click="receiveConfirmShow = false">取消</AppButton>
          <AppButton variant="primary" @click="confirmReceive">确认接待</AppButton>
        </template>
      </Modal>

      <!-- ===== 驱逐访客确认弹窗 ===== -->
      <Modal :isOpen="expelConfirmShow" title="⚔️ 驱逐访客" @close="expelConfirmShow = false">
        <div class="space-y-2 text-sm text-fg-secondary">
          <p>确认驱逐此访客？驱逐后该访客24小时内无法拜访和寻宝你的洞府。</p>
          <div v-if="pendingReception" class="bg-surface-hover border border-line rounded p-3 mt-2">
            <div>访客：<span class="text-rose-300 font-bold">{{ pendingReception.visitor_nickname }}</span></div>
            <div class="text-xs text-fg-muted mt-1">封锁时长：24小时</div>
          </div>
        </div>
        <template #footer>
          <AppButton variant="default" @click="expelConfirmShow = false">取消</AppButton>
          <AppButton variant="danger" @click="confirmExpel">确认驱逐</AppButton>
        </template>
      </Modal>

      <!-- ===== 取下展品确认弹窗 ===== -->
      <Modal :isOpen="unlistConfirmShow" title="🏺 取下展品" @close="unlistConfirmShow = false">
        <div class="space-y-2 text-sm text-fg-secondary">
          <p>确认将此展品从万宝阁取下？物品将归还背包，展品热度将清零。</p>
          <div v-if="pendingUnlist" class="bg-surface-hover border border-line rounded p-3 mt-2">
            <div>展品：<span class="text-gold-300 font-bold">{{ pendingUnlist.item_name }}</span></div>
            <div class="text-xs text-fg-muted mt-1">当前热度：<span class="num" :title="String(pendingUnlist.heat_count)">{{ formatCompact(pendingUnlist.heat_count) }}</span>（取下后清零）</div>
          </div>
        </div>
        <template #footer>
          <AppButton variant="default" @click="unlistConfirmShow = false">取消</AppButton>
          <AppButton variant="primary" @click="confirmUnlistExhibit">确认取下</AppButton>
        </template>
      </Modal>

      <!-- ===== 鉴赏展品结果弹窗 ===== -->
      <Modal :isOpen="appreciateResultShow" title="✨ 展品鉴赏" @close="appreciateResultShow = false">
        <div v-if="appreciateResult" class="space-y-3">
          <!-- 顿悟特效 -->
          <div v-if="appreciateResult.is_enlightened" class="text-center py-3 bg-gradient-to-r from-gold-900/40 to-purple-950/40 rounded-lg border border-gold-700/40">
            <div class="text-2xl mb-1">🌟 顿悟！</div>
            <p class="text-sm text-gold-300">鉴赏「{{ appreciateResult.exhibit.item_name }}」触发顿悟，修为大增！</p>
          </div>
          <div v-else class="text-center py-3">
            <div class="text-lg mb-1">📖</div>
            <p class="text-sm text-emerald-300">鉴赏「{{ appreciateResult.exhibit.item_name }}」有所感悟</p>
          </div>

          <!-- 奖励明细 -->
          <div class="bg-surface-hover border border-line rounded p-3 space-y-1.5 text-sm">
            <div class="flex justify-between">
              <span class="text-fg-muted">获得修为</span>
              <span class="text-emerald-400 font-bold num" :title="String(appreciateResult.exp_gained)">+{{ formatCompact(appreciateResult.exp_gained) }}</span>
            </div>
            <div v-if="appreciateResult.is_enlightened" class="flex justify-between text-xs">
              <span class="text-fg-faint">基础 <span class="num" :title="String(appreciateResult.base_exp)">{{ formatCompact(appreciateResult.base_exp) }}</span> × 顿悟 {{ appreciateResult.enlighten_multiplier }}x</span>
              <span class="text-gold-400 num" :title="String(appreciateResult.exp_gained - appreciateResult.base_exp)">+{{ formatCompact(appreciateResult.exp_gained - appreciateResult.base_exp) }}</span>
            </div>
            <div v-if="appreciateResult.is_enlightened && appreciateResult.enlighten_buff_until" class="flex justify-between">
              <span class="text-fg-muted">修炼加成</span>
              <span class="text-gold-400">+{{ Math.round(appreciateResult.enlighten_buff_meditation_bonus * 100) }}%（1小时）</span>
            </div>
            <div v-if="appreciateResult.owner_honor_gained > 0" class="flex justify-between">
              <span class="text-fg-muted">主人声望</span>
              <span class="text-purple-400 num" :title="String(appreciateResult.owner_honor_gained)">+{{ formatCompact(appreciateResult.owner_honor_gained) }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-fg-muted">展品热度</span>
              <span class="text-gold-400 num" :title="String(appreciateResult.new_heat)">🔥 {{ formatCompact(appreciateResult.new_heat) }}</span>
            </div>
            <div class="flex justify-between text-xs text-fg-faint pt-1 border-t border-line">
              <span>今日鉴赏</span>
              <span>{{ appreciateResult.today_appreciated_count }}/{{ appreciateResult.daily_limit }} 次</span>
            </div>
          </div>
        </div>
        <template #footer>
          <AppButton variant="default" @click="appreciateResultShow = false">确 认</AppButton>
        </template>
      </Modal>

      <!-- ===== 题词结果弹窗 ===== -->
      <Modal :isOpen="inscribeResultShow" title="✍️ 题词成功" @close="inscribeResultShow = false">
        <div v-if="inscribeResult" class="space-y-3">
          <!-- 题词内容展示 -->
          <div class="text-center py-3 bg-gradient-to-r from-gold-900/40 to-emerald-950/40 rounded-lg border border-gold-700/40">
            <div class="text-2xl mb-1">📜</div>
            <p class="text-sm text-gold-200 italic">"{{ inscribeResult.inscription.content }}"</p>
          </div>

          <!-- 奖励明细 -->
          <div class="bg-surface-hover border border-line rounded p-3 space-y-1.5 text-sm">
            <div class="flex justify-between">
              <span class="text-fg-muted">被题词者声望</span>
              <span class="text-purple-400 font-bold num" :title="String(inscribeResult.honor_gained)">+{{ formatCompact(inscribeResult.honor_gained) }}</span>
            </div>
            <div class="flex justify-between text-xs text-fg-faint pt-1 border-t border-line">
              <span>今日题词</span>
              <span>{{ inscribeResult.today_inscribe_count }}/{{ inscribeResult.daily_limit }} 次</span>
            </div>
            <div class="flex justify-between text-xs">
              <span class="text-fg-faint">剩余题词次数</span>
              <span class="text-emerald-400">{{ inscribeResult.daily_limit - inscribeResult.today_inscribe_count }} 次</span>
            </div>
          </div>
        </div>
        <template #footer>
          <AppButton variant="primary" @click="inscribeResultShow = false">确 认</AppButton>
        </template>
      </Modal>
    </div>
  </PanelShell>
</template>

<script setup>
/**
 * 洞府社交面板组件
 *
 * 功能模块：
 *   1. 留言板：查看自己洞府留言 + 在他人洞府留言
 *   2. 访客录：查看自己洞府访客 + 拜访他人洞府
 *   3. 景观：查看可布置景观列表 + 布置景观（含属性加成）
 *   4. 游商：查看洞府商人货品 + 购买商品
 *
 * 所有数据通过 api/caveSocial 模块调用后端，前端只做展示与接口调用。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { formatBeijing } from '../../utils/time'
import { useUIStore } from '../../stores/ui'
import { formatCompact } from '../../utils/format'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import EmptyState from '../ui/EmptyState.vue'
import LoadingBlock from '../ui/LoadingBlock.vue'
import {
  getMessages,
  leaveMessage,
  getVisitors,
  visitCave,
  getLandscapes,
  setLandscape,
  getMerchantGoods,
  buyMerchantItem,
  treasureHunt,
  getTreasureLogs,
  getVisitorReceptionList,
  receiveVisitor,
  expelVisitor,
  ignoreVisitor,
  getMyExhibits,
  listExhibit,
  unlistExhibit,
  viewPlayerExhibits,
  appreciateExhibit,
  getExhibitHeatBoard,
  getMyScroll,
  viewPlayerScroll,
  inscribeScroll,
  getScrollRanking
} from '../../api/caveSocial'

const emit = defineEmits(['close'])
const uiStore = useUIStore()

// ====== Tab 配置（key/label 契约见 ui/Tabs.vue） ======
const tabs = [
  { key: 'messages', label: '留言板' },
  { key: 'visitors', label: '访客录' },
  { key: 'landscape', label: '景观' },
  { key: 'merchant', label: '游商' },
  { key: 'treasure', label: '寻宝' },
  { key: 'reception', label: '接待' },
  { key: 'pavilion', label: '万宝阁' },
  { key: 'scroll', label: '绘卷' }
]
const activeTab = ref('messages')

// ====== 留言板 ======
const messagesLoading = ref(false)
const messages = ref([])
const messageForm = ref({
  target_player_id: null,
  content: ''
})

// ====== 访客录 ======
const visitorsLoading = ref(false)
const visitors = ref([])
const visitForm = ref({
  target_player_id: null
})

// ====== 景观 ======
const landscapeLoading = ref(false)
const landscapes = ref([])
const currentLandscapeId = ref(null)

// ====== 游商 ======
const merchantLoading = ref(false)
const merchantGoods = ref([])
const merchantRefreshAt = ref('')

// ====== 寻宝 ======
const treasureLoading = ref(false)
const treasureLogsLoading = ref(false)
const treasureLogs = ref([])
const treasureLogRole = ref('hunter') // hunter: 我的寻宝记录 / owner: 洞府被寻宝记录
const treasureForm = ref({
  target_player_id: null,
  plot_number: null
})
// 寻宝配置（由后端响应动态填充，初始默认值仅用于按钮展示）
const treasureCost = ref(100)
const treasureDailyLimit = ref(5)
const treasureTodayCount = ref(0)
// 寻宝结果弹窗
const treasureResultShow = ref(false)
const treasureResult = ref(null)

// ====== 接待/驱逐访客 ======
const receptionLoading = ref(false)
const receptionPending = ref([])   // 待处理访客列表
const receptionRecent = ref([])    // 近期已处理访客记录
const receptionCost = ref(100)     // 接待消耗灵石（由后端响应动态填充）
// 接待/驱逐确认弹窗
const receiveConfirmShow = ref(false)
const expelConfirmShow = ref(false)
const pendingReception = ref(null) // 当前操作的访客记录

// ====== 万宝阁展品系统 ======
const exhibitLoading = ref(false)
const myExhibits = ref([])          // 我的展品列表
const maxExhibits = ref(6)          // 展品上限
const minExhibitQuality = ref('uncommon') // 最低品质要求
// 上架展品表单
const listExhibitForm = ref({ item_key: '' })
// 取下展品确认弹窗
const unlistConfirmShow = ref(false)
const pendingUnlist = ref(null)     // 待取下的展品
// 鉴赏他人展品
const viewTargetPlayerId = ref(null) // 查看目标玩家ID
const viewingExhibits = ref([])      // 目标玩家的展品列表
const viewingTargetInfo = ref(null)  // 目标玩家信息
const viewExhibitsLoading = ref(false)
const appreciateDailyLimit = ref(3)  // 每日鉴赏上限
const appreciateTodayCount = ref(0)  // 今日已鉴赏次数
// 鉴赏结果弹窗
const appreciateResultShow = ref(false)
const appreciateResult = ref(null)
// 热度榜
const heatBoard = ref([])
const heatBoardLoading = ref(false)

// ====== 洞天绘卷系统 ======
const scrollLoading = ref(false)              // 我的绘卷加载状态
const myScrollData = ref(null)                // 我的洞天绘卷数据
const scrollRankingLoading = ref(false)       // 风貌榜加载状态
const scrollRanking = ref([])                 // 风貌榜列表
// 查看他人绘卷
const viewScrollTargetId = ref(null)          // 查看目标玩家ID
const viewScrollLoading = ref(false)
const viewScrollData = ref(null)              // 目标洞天绘卷数据
// 题词表单
const inscribeForm = ref({ content: '' })
const inscribeSubmitting = ref(false)
// 题词结果弹窗
const inscribeResultShow = ref(false)
const inscribeResult = ref(null)
// 绘卷查看模式切换：'mine'（我的绘卷）/ 'others'（查看他人）
const scrollViewMode = ref('mine')

// ====== 操作状态 ======
const actionLoading = ref(false)

// ====== 确认弹窗 ======
const buyConfirmShow = ref(false)
const pendingBuy = ref(null)
const landscapeConfirmShow = ref(false)

// ===== 拜访奇遇结果弹窗 =====
const encounterResultShow = ref(false)
const encounterResult = ref(null)
const pendingLandscape = ref(null)

// ====== 计算属性 ======
const currentLandscapeName = computed(() => {
  const ls = landscapes.value.find(l => l.id === currentLandscapeId.value)
  return ls?.name || null
})

// ====== 工具函数 ======
/**
 * 格式化时间
 */
function formatTime(timeStr) {
  // 统一按北京时间展示（固定 UTC+8）
  return formatBeijing(timeStr, { dateStyle: 'short', seconds: false, fallback: '-' })
}

/**
 * 格式化景观加成（将 bonus 对象转为可读字符串）
 * 如 { meditation_exp_bonus: 0.05, spirit_vein_bonus: 0.1 } -> "悟道经验+5%, 灵脉产出+10%"
 */
function formatBonus(bonus) {
  if (!bonus || typeof bonus !== 'object') return '无'
  const bonusMap = {
    meditation_exp_bonus: '悟道经验',
    spirit_vein_bonus: '灵脉产出',
    breakthrough_bonus: '突破概率'
  }
  const parts = []
  for (const [key, value] of Object.entries(bonus)) {
    if (typeof value === 'number' && value > 0) {
      const name = bonusMap[key] || key
      parts.push(`${name}+${(value * 100).toFixed(0)}%`)
    }
  }
  return parts.length > 0 ? parts.join(', ') : '无'
}

// ====== 数据加载 ======
/**
 * 加载留言列表
 */
async function loadMessages() {
  messagesLoading.value = true
  try {
    const res = await getMessages(50)
    messages.value = res.data.data?.messages || []
  } catch (err) {
    uiStore.showApiError(err, '加载留言失败')
  } finally {
    messagesLoading.value = false
  }
}

/**
 * 加载访客记录
 */
async function loadVisitors() {
  visitorsLoading.value = true
  try {
    const res = await getVisitors(50)
    visitors.value = res.data.data?.visitors || []
  } catch (err) {
    uiStore.showApiError(err, '加载访客记录失败')
  } finally {
    visitorsLoading.value = false
  }
}

/**
 * 加载景观列表
 */
async function loadLandscapes() {
  landscapeLoading.value = true
  try {
    const res = await getLandscapes()
    landscapes.value = res.data.data?.landscapes || []
    currentLandscapeId.value = res.data.data?.current_landscape_id || null
  } catch (err) {
    uiStore.showApiError(err, '加载景观列表失败')
  } finally {
    landscapeLoading.value = false
  }
}

/**
 * 加载游商货品
 */
async function loadMerchantGoods() {
  merchantLoading.value = true
  try {
    const res = await getMerchantGoods()
    merchantGoods.value = res.data.data?.items || []
    merchantRefreshAt.value = res.data.data?.next_refresh_at || ''
  } catch (err) {
    uiStore.showApiError(err, '加载游商货品失败')
  } finally {
    merchantLoading.value = false
  }
}

// ====== Tab 切换 ======
/**
 * 切换 Tab 时自动加载对应数据
 */
function switchTab(tabId) {
  activeTab.value = tabId
  if (tabId === 'messages' && messages.value.length === 0) {
    loadMessages()
  } else if (tabId === 'visitors' && visitors.value.length === 0) {
    loadVisitors()
  } else if (tabId === 'landscape' && landscapes.value.length === 0) {
    loadLandscapes()
  } else if (tabId === 'merchant' && merchantGoods.value.length === 0) {
    loadMerchantGoods()
  } else if (tabId === 'treasure' && treasureLogs.value.length === 0) {
    // 寻宝 Tab 默认加载"我的寻宝记录"
    loadTreasureLogs('hunter')
  } else if (tabId === 'reception') {
    // 接待 Tab 每次切换都刷新待处理列表（新访客可能随时到来）
    loadReceptionList()
  } else if (tabId === 'pavilion') {
    // 万宝阁 Tab 默认加载"我的展品"和"热度榜"
    loadMyExhibits()
    loadHeatBoard()
  } else if (tabId === 'scroll') {
    // 绘卷 Tab 默认加载"我的绘卷"和"风貌榜"
    loadMyScroll()
    loadScrollRanking()
  }
}

// ====== 操作处理 ======
/**
 * 发送留言
 */
async function handleLeaveMessage() {
  const { target_player_id, content } = messageForm.value
  if (!target_player_id || !content) {
    uiStore.showToast('请填写目标 ID 和留言内容', 'error')
    return
  }
  actionLoading.value = true
  try {
    const res = await leaveMessage(target_player_id, content)
    uiStore.showToast(res.data.message || '留言发送成功', 'success')
    // 清空表单
    messageForm.value = { target_player_id: null, content: '' }
  } catch (err) {
    uiStore.showApiError(err, '留言失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 拜访他人洞府
 * 拜访成功后若触发奇遇，展示奇遇结果弹窗
 */
async function handleVisit() {
  const { target_player_id } = visitForm.value
  if (!target_player_id) {
    uiStore.showToast('请填写目标玩家 ID', 'error')
    return
  }
  actionLoading.value = true
  try {
    const res = await visitCave(target_player_id)
    const data = res.data?.data || res.data
    // 展示拜访成功提示
    uiStore.showToast(data.message || `已拜访 ${data.target?.nickname || '道友'} 的洞府`, 'success')

    // 若触发了奇遇，展示奇遇结果弹窗
    if (data.encounter && data.encounter.triggered) {
      encounterResult.value = data.encounter
      encounterResultShow.value = true
    }

    // 清空表单
    visitForm.value = { target_player_id: null }
  } catch (err) {
    uiStore.showApiError(err, '拜访失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 点击布置景观（弹出确认）
 */
function handleSetLandscape(ls) {
  pendingLandscape.value = ls
  landscapeConfirmShow.value = true
}

/**
 * 确认布置景观
 */
async function confirmSetLandscape() {
  if (!pendingLandscape.value) return
  actionLoading.value = true
  try {
    const res = await setLandscape(pendingLandscape.value.id)
    uiStore.showToast(res.data.message || '景观布置成功', 'success')
    landscapeConfirmShow.value = false
    pendingLandscape.value = null
    // 刷新景观列表
    await loadLandscapes()
  } catch (err) {
    uiStore.showApiError(err, '布置景观失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 点击购买商品（弹出确认）
 */
function handleBuy(good) {
  pendingBuy.value = good
  buyConfirmShow.value = true
}

/**
 * 确认购买商品
 */
async function confirmBuy() {
  if (!pendingBuy.value) return
  actionLoading.value = true
  try {
    const res = await buyMerchantItem(pendingBuy.value.index, 1)
    uiStore.showToast(res.data.message || `购买成功，获得 ${res.data.data?.purchase?.item_name}`, 'success')
    buyConfirmShow.value = false
    pendingBuy.value = null
    // 刷新游商货品（库存可能已变）
    await loadMerchantGoods()
  } catch (err) {
    uiStore.showApiError(err, '购买失败')
  } finally {
    actionLoading.value = false
  }
}

// ====== 寻宝相关 ======
/**
 * 寻宝结果类型 -> 中文标签
 */
function treasureResultLabel(type) {
  const map = {
    treasure: '🎉 得手',
    trap: '💀 陷阱',
    encounter: '⚔ 遭遇',
    empty: '🍃 空手'
  }
  return map[type] || type
}

/**
 * 寻宝结果类型 -> 徽章样式
 */
function treasureResultBadgeClass(type) {
  const map = {
    treasure: 'bg-gold-900/40 text-gold-300 border-gold-700/50',
    trap: 'bg-rose-900/40 text-rose-300 border-rose-700/50',
    encounter: 'bg-purple-900/40 text-purple-300 border-purple-700/50',
    empty: 'bg-surface-hover text-fg-muted border-line'
  }
  return map[type] || 'bg-surface-hover text-fg-muted border-line'
}

/**
 * 寻宝结果类型 -> 标题颜色
 */
function treasureResultTitleClass(type) {
  const map = {
    treasure: 'text-gold-400',
    trap: 'text-rose-400',
    encounter: 'text-purple-400',
    empty: 'text-fg-muted'
  }
  return map[type] || 'text-fg-muted'
}

/**
 * 加载寻宝日志
 * @param role hunter: 我的寻宝记录 / owner: 洞府被寻宝记录
 */
async function loadTreasureLogs(role) {
  treasureLogRole.value = role
  treasureLogsLoading.value = true
  try {
    const res = await getTreasureLogs(role, 50)
    const data = res.data?.data || res.data
    treasureLogs.value = data.logs || []
  } catch (err) {
    uiStore.showApiError(err, '加载寻宝日志失败')
  } finally {
    treasureLogsLoading.value = false
  }
}

/**
 * 执行寻宝
 * 调用后端寻宝接口，成功后展示寻宝结果弹窗并刷新日志
 */
async function handleTreasureHunt() {
  const { target_player_id, plot_number } = treasureForm.value
  if (!target_player_id) {
    uiStore.showToast('请填写目标洞府主人 ID', 'error')
    return
  }
  if (!plot_number || plot_number < 1 || plot_number > 9) {
    uiStore.showToast('请选择探索地块（1-9）', 'error')
    return
  }
  actionLoading.value = true
  try {
    const res = await treasureHunt(target_player_id, plot_number)
    const data = res.data?.data || res.data
    // 填充寻宝配置（用于下次按钮展示）
    if (data.cost !== undefined) treasureCost.value = data.cost
    if (data.daily_limit !== undefined) treasureDailyLimit.value = data.daily_limit
    if (data.today_count !== undefined) treasureTodayCount.value = data.today_count
    // 展示寻宝结果弹窗
    treasureResult.value = data
    treasureResultShow.value = true
    // 刷新寻宝日志
    await loadTreasureLogs(treasureLogRole.value)
  } catch (err) {
    uiStore.showApiError(err, '寻宝失败')
  } finally {
    actionLoading.value = false
  }
}

// ====== 接待/驱逐访客相关 ======
/**
 * 加载待处理访客列表 + 近期处理记录
 * 调用后端接口获取洞府主人视角的访客接待信息
 */
async function loadReceptionList() {
  receptionLoading.value = true
  try {
    const res = await getVisitorReceptionList(20)
    const data = res.data?.data || res.data
    receptionPending.value = data.pending || []
    receptionRecent.value = data.recent || []
  } catch (err) {
    uiStore.showApiError(err, '加载访客接待列表失败')
  } finally {
    receptionLoading.value = false
  }
}

/**
 * 点击接待访客（弹出确认弹窗）
 * @param v 待处理的访客记录
 */
function handleReceive(v) {
  pendingReception.value = v
  receiveConfirmShow.value = true
}

/**
 * 确认接待访客
 * 调用后端接待接口，消耗灵石赠予访客临时增益buff
 */
async function confirmReceive() {
  if (!pendingReception.value) return
  actionLoading.value = true
  try {
    const res = await receiveVisitor(pendingReception.value.id)
    const data = res.data?.data || res.data
    uiStore.showToast(data.message || `已接待访客 ${data.visitor?.nickname || ''}`, 'success')
    receiveConfirmShow.value = false
    pendingReception.value = null
    // 刷新接待列表
    await loadReceptionList()
  } catch (err) {
    uiStore.showApiError(err, '接待访客失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 点击驱逐访客（弹出确认弹窗）
 * @param v 待处理的访客记录
 */
function handleExpel(v) {
  pendingReception.value = v
  expelConfirmShow.value = true
}

/**
 * 确认驱逐访客
 * 调用后端驱逐接口，封锁该访客24小时内无法拜访和寻宝
 */
async function confirmExpel() {
  if (!pendingReception.value) return
  actionLoading.value = true
  try {
    const res = await expelVisitor(pendingReception.value.id)
    const data = res.data?.data || res.data
    uiStore.showToast(data.message || `已驱逐访客 ${data.visitor?.nickname || ''}`, 'success')
    expelConfirmShow.value = false
    pendingReception.value = null
    // 刷新接待列表
    await loadReceptionList()
  } catch (err) {
    uiStore.showApiError(err, '驱逐访客失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 忽略访客（无需二次确认，操作可逆——访客仍可再次拜访触发新记录）
 * @param v 待处理的访客记录
 */
async function handleIgnore(v) {
  actionLoading.value = true
  try {
    const res = await ignoreVisitor(v.id)
    uiStore.showToast(res.data?.data?.message || res.data?.message || '已忽略该访客', 'success')
    // 刷新接待列表
    await loadReceptionList()
  } catch (err) {
    uiStore.showApiError(err, '忽略访客失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 接待状态 -> 中文标签
 * @param status pending/received/expelled/ignored
 */
function receptionStatusLabel(status) {
  const map = {
    pending: '⏳ 待处理',
    received: '🍵 已接待',
    expelled: '⚔️ 已驱逐',
    ignored: '🔕 已忽略'
  }
  return map[status] || status
}

/**
 * 接待状态 -> 徽章样式
 * @param status pending/received/expelled/ignored
 */
function receptionStatusBadgeClass(status) {
  const map = {
    pending: 'bg-gold-900/40 text-gold-300 border-gold-700/50',
    received: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50',
    expelled: 'bg-rose-900/40 text-rose-300 border-rose-700/50',
    ignored: 'bg-surface-hover text-fg-muted border-line'
  }
  return map[status] || 'bg-surface-hover text-fg-muted border-line'
}

// ====== 万宝阁展品系统 ======
/**
 * 加载我的展品列表
 */
async function loadMyExhibits() {
  exhibitLoading.value = true
  try {
    const res = await getMyExhibits()
    const data = res.data?.data || res.data
    myExhibits.value = data.exhibits || []
    maxExhibits.value = data.max_exhibits || 6
    minExhibitQuality.value = data.min_quality || 'uncommon'
  } catch (err) {
    uiStore.showApiError(err, '加载展品失败')
  } finally {
    exhibitLoading.value = false
  }
}

/**
 * 上架展品
 */
async function handleListExhibit() {
  const { item_key } = listExhibitForm.value
  if (!item_key || !item_key.trim()) {
    uiStore.showToast('请输入物品ID', 'error')
    return
  }
  actionLoading.value = true
  try {
    const res = await listExhibit(item_key.trim())
    uiStore.showToast(res.data?.message || '上架成功', 'success')
    listExhibitForm.value = { item_key: '' }
    // 刷新展品列表
    await loadMyExhibits()
  } catch (err) {
    uiStore.showApiError(err, '上架失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 触发取下展品确认
 */
function handleUnlistExhibit(exhibit) {
  pendingUnlist.value = exhibit
  unlistConfirmShow.value = true
}

/**
 * 确认取下展品
 */
async function confirmUnlistExhibit() {
  if (!pendingUnlist.value) return
  actionLoading.value = true
  try {
    const res = await unlistExhibit(pendingUnlist.value.id)
    uiStore.showToast(res.data?.message || '取下成功', 'success')
    unlistConfirmShow.value = false
    pendingUnlist.value = null
    // 刷新展品列表
    await loadMyExhibits()
  } catch (err) {
    uiStore.showApiError(err, '取下失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 加载热度榜
 */
async function loadHeatBoard() {
  heatBoardLoading.value = true
  try {
    const res = await getExhibitHeatBoard(20)
    const data = res.data?.data || res.data
    heatBoard.value = data.board || []
  } catch (err) {
    // 热度榜加载失败不提示错误，静默处理
    heatBoard.value = []
  } finally {
    heatBoardLoading.value = false
  }
}

/**
 * 查看他人洞府的展品（供鉴赏）
 */
async function handleViewExhibits() {
  if (!viewTargetPlayerId.value) {
    uiStore.showToast('请输入目标玩家ID', 'error')
    return
  }
  viewExhibitsLoading.value = true
  try {
    const res = await viewPlayerExhibits(viewTargetPlayerId.value)
    const data = res.data?.data || res.data
    viewingExhibits.value = data.exhibits || []
    viewingTargetInfo.value = {
      nickname: data.target_nickname,
      realm: data.target_realm,
      player_id: data.target_player_id
    }
    appreciateDailyLimit.value = data.daily_limit || 3
    appreciateTodayCount.value = data.today_appreciated_count || 0
  } catch (err) {
    uiStore.showApiError(err, '查看展品失败')
    viewingExhibits.value = []
    viewingTargetInfo.value = null
  } finally {
    viewExhibitsLoading.value = false
  }
}

/**
 * 鉴赏展品
 */
async function handleAppreciate(exhibit) {
  actionLoading.value = true
  try {
    const res = await appreciateExhibit(exhibit.id)
    const data = res.data?.data || res.data
    // 展示鉴赏结果弹窗
    appreciateResult.value = data
    appreciateResultShow.value = true
    // 更新今日鉴赏次数
    appreciateTodayCount.value = data.today_appreciated_count || appreciateTodayCount.value + 1
    // 更新该展品的已鉴赏标记
    exhibit.appreciated_today = true
  } catch (err) {
    uiStore.showApiError(err, '鉴赏失败')
  } finally {
    actionLoading.value = false
  }
}

/**
 * 品质 -> 中文标签
 */
function qualityLabel(quality) {
  const map = {
    common: ' 普通',
    uncommon: '·精良',
    rare: '★稀有',
    epic: '✦史诗',
    legendary: '✧传说',
    mythic: '✺神话'
  }
  return map[quality] || quality
}

/**
 * 品质 -> 徽章样式
 */
function qualityBadgeClass(quality) {
  const map = {
    common: 'bg-surface-hover text-fg-secondary border-line-strong',
    uncommon: 'bg-green-900/40 text-green-300 border-green-700/50',
    rare: 'bg-blue-900/40 text-blue-300 border-blue-700/50',
    epic: 'bg-purple-900/40 text-purple-300 border-purple-700/50',
    legendary: 'bg-gold-900/40 text-gold-300 border-gold-700/50',
    mythic: 'bg-rose-900/40 text-rose-300 border-rose-700/50'
  }
  return map[quality] || 'bg-surface-hover text-fg-secondary border-line-strong'
}

// ====== 洞天绘卷系统 ======
/**
 * 加载我的洞天绘卷
 * 展示洞府全景、风貌评级、得分明细、近期题词
 */
async function loadMyScroll() {
  scrollLoading.value = true
  try {
    const res = await getMyScroll()
    myScrollData.value = res.data?.data || res.data
  } catch (err) {
    uiStore.showApiError(err, '加载绘卷失败')
    myScrollData.value = null
  } finally {
    scrollLoading.value = false
  }
}

/**
 * 加载洞天绘卷风貌排行榜
 */
async function loadScrollRanking() {
  scrollRankingLoading.value = true
  try {
    const res = await getScrollRanking(20)
    const data = res.data?.data || res.data
    scrollRanking.value = data.ranking || []
  } catch (err) {
    // 排行榜加载失败静默处理
    scrollRanking.value = []
  } finally {
    scrollRankingLoading.value = false
  }
}

/**
 * 切换绘卷查看模式
 * @param mode 'mine'（我的绘卷）/ 'others'（查看他人）
 */
function switchScrollViewMode(mode) {
  scrollViewMode.value = mode
  // 切换到"查看他人"时清空之前的查看结果
  if (mode === 'others') {
    viewScrollData.value = null
    viewScrollTargetId.value = null
    inscribeForm.value = { content: '' }
  }
}

/**
 * 查看他人洞天绘卷
 * 用于欣赏他人洞府风貌并题词互动
 */
async function handleViewPlayerScroll() {
  if (!viewScrollTargetId.value) {
    uiStore.showToast('请输入目标玩家ID', 'error')
    return
  }
  viewScrollLoading.value = true
  try {
    const res = await viewPlayerScroll(viewScrollTargetId.value)
    viewScrollData.value = res.data?.data || res.data
    // 重置题词表单
    inscribeForm.value = { content: '' }
  } catch (err) {
    uiStore.showApiError(err, '查看绘卷失败')
    viewScrollData.value = null
  } finally {
    viewScrollLoading.value = false
  }
}

/**
 * 在他人洞天绘卷上题词
 * 题词后被题词者获得声望奖励（每日上限），题词者每日限5次
 */
async function handleInscribe() {
  if (!viewScrollData.value) return
  const content = (inscribeForm.value.content || '').trim()
  if (!content) {
    uiStore.showToast('题词内容不能为空', 'error')
    return
  }
  const targetId = viewScrollData.value.owner?.player_id
  if (!targetId) {
    uiStore.showToast('目标洞府信息异常', 'error')
    return
  }
  inscribeSubmitting.value = true
  try {
    const res = await inscribeScroll(targetId, content)
    const data = res.data?.data || res.data
    // 展示题词结果弹窗
    inscribeResult.value = data
    inscribeResultShow.value = true
    // 清空题词表单
    inscribeForm.value = { content: '' }
    // 刷新他人绘卷数据（更新题词列表+今日题词状态）
    await handleViewPlayerScroll()
  } catch (err) {
    uiStore.showApiError(err, '题词失败')
  } finally {
    inscribeSubmitting.value = false
  }
}

/**
 * 评级序号 -> 徽章样式（凡品灰色 → 仙品金色渐变）
 * @param ratingIndex 评级序号 0-5
 */
function ratingBadgeClass(ratingIndex) {
  const map = [
    'bg-surface-hover/60 text-fg-secondary border-line-strong',       // 凡品
    'bg-green-900/40 text-green-300 border-green-700/50',    // 灵品
    'bg-blue-900/40 text-blue-300 border-blue-700/50',       // 玄品
    'bg-purple-900/40 text-purple-300 border-purple-700/50', // 地品
    'bg-gold-900/40 text-gold-300 border-gold-700/50',    // 天品
    'bg-gradient-to-r from-rose-900/60 to-gold-900/60 text-gold-200 border-gold-500/60' // 仙品
  ]
  return map[ratingIndex] || map[0]
}

// ====== 初始化 ======
onMounted(() => {
  loadMessages()
})
</script>
