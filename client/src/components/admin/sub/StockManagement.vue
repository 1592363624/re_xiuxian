<template>
  <div class="space-y-6">
    <!-- 标题与操作按钮 -->
    <div class="flex justify-between items-center">
      <h3 class="text-lg font-bold text-white flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-400">
          <path d="M3 3v18h18"/>
          <path d="m19 9-5 5-4-4-3 3"/>
        </svg>
        聚宝股市管理
      </h3>
      <div class="flex space-x-2">
        <button @click="fetchStocks(pagination.page)" class="px-3 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-white text-sm">刷新股票</button>
        <button @click="fetchMetrics" class="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-white text-sm">更新指标</button>
      </div>
    </div>

    <!-- 统计指标卡片 -->
    <div v-if="metrics" class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <!-- 活跃股票数 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">活跃股票</div>
        <div class="text-2xl font-bold text-cyan-400">{{ metrics.stocks.active }}</div>
        <div class="text-[10px] text-rose-400 mt-1">熔断中 {{ metrics.stocks.halted }}</div>
      </div>
      <!-- 持仓玩家数 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">持仓玩家数</div>
        <div class="text-2xl font-bold text-cyan-400">{{ metrics.holders_count }}</div>
        <div class="text-[10px] text-gray-500 mt-1">总市值 {{ metrics.total_holdings_value }}</div>
      </div>
      <!-- 今日交易 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">今日交易</div>
        <div class="text-2xl font-bold text-amber-400">{{ metrics.today_transactions.count }} 笔</div>
        <div class="text-[10px] text-gray-500 mt-1">
          买 {{ metrics.today_transactions.buy_amount }} · 卖 {{ metrics.today_transactions.sell_amount }}
        </div>
      </div>
      <!-- 融资账户 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3">
        <div class="text-xs text-gray-400 mb-1">融资账户</div>
        <div class="text-2xl font-bold text-amber-400">{{ metrics.margin.accounts_count }}</div>
        <div class="text-[10px] text-rose-400 mt-1">已爆仓 {{ metrics.margin.liquidated_count }} · 总负债 {{ metrics.margin.total_debt }}</div>
      </div>
    </div>

    <!-- 子 Tab 切换 -->
    <div class="flex border-b border-gray-700 bg-gray-800/50">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        @click="switchSubTab(tab.id)"
        class="px-4 py-2 text-sm font-medium transition-colors relative whitespace-nowrap"
        :class="activeSubTab === tab.id ? 'text-cyan-400' : 'text-gray-400 hover:text-white'"
      >
        {{ tab.name }}
        <div v-if="activeSubTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-cyan-500"></div>
      </button>
    </div>

    <!-- ===================== 股票管理 Tab ===================== -->
    <div v-if="activeSubTab === 'stocks'">
      <!-- 筛选 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3 mb-3">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">分类：</label>
            <select
              v-model="stockParams.category"
              class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm"
              @change="fetchStocks(1)"
            >
              <option value="">全部</option>
              <option value="sect">宗门</option>
              <option value="mine">灵矿</option>
              <option value="dungeon">秘境</option>
              <option value="event">事件</option>
            </select>
          </div>
          <button @click="fetchStocks(pagination.page)" class="px-3 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-white text-sm">查询</button>
        </div>
      </div>

      <!-- 股票列表 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">代码</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">名称</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">分类</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">当前价</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">涨跌幅</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">成交量</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">状态</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading" class="text-center text-gray-500">
                <td colspan="8" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="stockList.length === 0" class="text-center text-gray-500">
                <td colspan="8" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="stock in stockList" :key="stock.id" class="border-t border-gray-700 hover:bg-gray-750">
                <td class="px-3 py-2 text-gray-400 font-mono">{{ stock.code }}</td>
                <td class="px-3 py-2 text-gray-200">{{ stock.name }}</td>
                <td class="px-3 py-2 text-gray-400">{{ categoryLabel(stock.category) }}</td>
                <td class="px-3 py-2 text-right text-cyan-400 font-bold">{{ stock.current_price }}</td>
                <td class="px-3 py-2 text-right font-bold" :class="changeColorClass(stock.daily_change_pct)">
                  {{ changeText(stock.daily_change_pct) }}
                </td>
                <td class="px-3 py-2 text-right text-gray-400">{{ stock.daily_volume }}</td>
                <td class="px-3 py-2 text-center">
                  <span v-if="stock.is_trading_halted" class="px-2 py-0.5 rounded text-xs bg-rose-900 text-rose-300">熔断</span>
                  <span v-else-if="!stock.is_active" class="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300">已停用</span>
                  <span v-else class="px-2 py-0.5 rounded text-xs bg-emerald-900 text-emerald-300">交易中</span>
                </td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <button @click="openAdjustPriceModal(stock)" class="px-2 py-1 bg-amber-600 hover:bg-amber-500 rounded text-white text-xs mr-1">调价</button>
                  <button v-if="!stock.is_trading_halted" @click="openHaltModal(stock)" class="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-xs mr-1">暂停</button>
                  <button v-else @click="openResumeModal(stock)" class="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-white text-xs mr-1">恢复</button>
                  <button @click="openTriggerEventModal(stock)" class="px-2 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white text-xs">事件</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-gray-700 flex items-center justify-between text-sm">
          <div class="text-gray-400">共 {{ pagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button @click="fetchStocks(pagination.page - 1)" :disabled="pagination.page <= 1 || loading" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
            <span class="text-gray-300">{{ pagination.page }} / {{ pagination.totalPages }}</span>
            <button @click="fetchStocks(pagination.page + 1)" :disabled="pagination.page >= pagination.totalPages || loading" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
          </div>
        </div>
      </div>

      <!-- 触发事件入口（全市场事件） -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <h4 class="text-sm font-bold text-purple-400 mb-3">触发全市场事件</h4>
        <p class="text-xs text-gray-500 mb-3">不指定股票时，事件将影响所有股票（如天劫降临、灵气复苏等）</p>
        <button @click="openGlobalEventModal" class="px-4 py-1 bg-purple-700 hover:bg-purple-600 rounded text-white text-sm">触发全市场事件</button>
      </div>
    </div>

    <!-- ===================== 交易流水 Tab ===================== -->
    <div v-if="activeSubTab === 'transactions'">
      <!-- 筛选 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-3 mb-3">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">玩家ID：</label>
            <input v-model.number="txParams.player_id" type="number" min="1" placeholder="按玩家ID筛选" class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm w-32" @keyup.enter="fetchTransactions" />
          </div>
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">股票ID：</label>
            <input v-model.number="txParams.stock_id" type="number" min="1" placeholder="按股票ID筛选" class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm w-32" @keyup.enter="fetchTransactions" />
          </div>
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">类型：</label>
            <select v-model="txParams.trade_type" class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm" @change="fetchTransactions">
              <option value="">全部</option>
              <option value="buy">买入</option>
              <option value="sell">卖出</option>
            </select>
          </div>
          <button @click="fetchTransactions" class="px-3 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-white text-sm">查询</button>
          <button @click="resetTxSearch" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">重置</button>
        </div>
      </div>

      <!-- 流水表 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">时间</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">玩家</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">股票</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">类型</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">数量</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">价格</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">金额</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">手续费</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">印花税</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="txLoading" class="text-center text-gray-500">
                <td colspan="9" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="txList.length === 0" class="text-center text-gray-500">
                <td colspan="9" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="tx in txList" :key="tx.id" class="border-t border-gray-700 hover:bg-gray-750">
                <td class="px-3 py-2 text-xs text-gray-400">{{ formatDate(tx.created_at) }}</td>
                <td class="px-3 py-2">
                  <div class="text-white">{{ tx.player_nickname }}</div>
                  <div class="text-xs text-gray-500">ID: {{ tx.player_id }} · {{ tx.player_realm }}</div>
                </td>
                <td class="px-3 py-2">
                  <div class="text-cyan-300">{{ tx.stock_name }}</div>
                  <div class="text-xs text-gray-500 font-mono">{{ tx.stock_code }}</div>
                </td>
                <td class="px-3 py-2 text-center">
                  <span class="font-bold" :class="tx.trade_type === 'buy' ? 'text-emerald-400' : 'text-rose-400'">
                    {{ tx.trade_type === 'buy' ? '买入' : '卖出' }}
                  </span>
                  <span v-if="tx.is_margin" class="text-[10px] text-amber-500 ml-1">融</span>
                </td>
                <td class="px-3 py-2 text-right text-gray-300">{{ tx.quantity }}</td>
                <td class="px-3 py-2 text-right text-gray-300">{{ tx.price }}</td>
                <td class="px-3 py-2 text-right text-cyan-400 font-bold">{{ tx.amount }}</td>
                <td class="px-3 py-2 text-right text-rose-400">{{ tx.fee }}</td>
                <td class="px-3 py-2 text-right text-rose-400">{{ tx.tax }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-gray-700 flex items-center justify-between text-sm">
          <div class="text-gray-400">共 {{ txPagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button @click="fetchTransactions(txPagination.page - 1)" :disabled="txPagination.page <= 1 || txLoading" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
            <span class="text-gray-300">{{ txPagination.page }} / {{ txPagination.totalPages }}</span>
            <button @click="fetchTransactions(txPagination.page + 1)" :disabled="txPagination.page >= txPagination.totalPages || txLoading" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ===================== 融资管理 Tab ===================== -->
    <div v-if="activeSubTab === 'margin'">
      <!-- 手动分红入口 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-3">
        <h4 class="text-sm font-bold text-emerald-400 mb-3">手动触发分红</h4>
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">股票ID：</label>
            <input v-model.number="dividendForm.stock_id" type="number" min="1" placeholder="股票ID" class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm w-32" />
          </div>
          <div class="flex items-center gap-2">
            <label class="text-sm text-gray-400 whitespace-nowrap">原因：</label>
            <input v-model="dividendForm.reason" type="text" placeholder="操作原因（选填）" class="px-3 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm w-64" />
          </div>
          <button @click="openDividendConfirmModal" :disabled="operating" class="px-4 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed">触发分红</button>
        </div>
        <p class="text-xs text-gray-500 mt-2">将向该股票所有持仓玩家派发分红（金额由后端计算）</p>
      </div>

      <!-- 融资账户列表 -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-900 text-gray-400">
              <tr>
                <th class="px-3 py-2 text-left whitespace-nowrap">玩家</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">总资产</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">负债</th>
                <th class="px-3 py-2 text-right whitespace-nowrap">保证金率</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">状态</th>
                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="marginLoading" class="text-center text-gray-500">
                <td colspan="6" class="px-3 py-6">加载中...</td>
              </tr>
              <tr v-else-if="marginList.length === 0" class="text-center text-gray-500">
                <td colspan="6" class="px-3 py-6">暂无数据</td>
              </tr>
              <tr v-for="acc in marginList" :key="acc.id" class="border-t border-gray-700 hover:bg-gray-750">
                <td class="px-3 py-2">
                  <div class="text-white">{{ acc.player_nickname }}</div>
                  <div class="text-xs text-gray-500">ID: {{ acc.player_id }} · {{ acc.player_realm }}</div>
                </td>
                <td class="px-3 py-2 text-right text-amber-400 font-bold">{{ acc.total_assets }}</td>
                <td class="px-3 py-2 text-right text-rose-400">{{ acc.debt }}</td>
                <td class="px-3 py-2 text-right">
                  <span class="font-bold" :class="(acc.margin_ratio || 0) < 0.3 ? 'text-rose-500' : ((acc.margin_ratio || 0) < 0.5 ? 'text-amber-400' : 'text-emerald-400')">
                    {{ ((acc.margin_ratio || 0) * 100).toFixed(2) }}%
                  </span>
                </td>
                <td class="px-3 py-2 text-center">
                  <span v-if="acc.is_liquidated" class="px-2 py-0.5 rounded text-xs bg-rose-900 text-rose-300">已爆仓</span>
                  <span v-else-if="(acc.margin_ratio || 0) < 0.3" class="px-2 py-0.5 rounded text-xs bg-amber-900 text-amber-300">危险</span>
                  <span v-else class="px-2 py-0.5 rounded text-xs bg-emerald-900 text-emerald-300">正常</span>
                </td>
                <td class="px-3 py-2 text-center whitespace-nowrap">
                  <button @click="openForceLiquidateModal(acc)" class="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-white text-xs">强制平仓</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 分页 -->
        <div class="px-4 py-3 border-t border-gray-700 flex items-center justify-between text-sm">
          <div class="text-gray-400">共 {{ marginPagination.total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button @click="fetchMarginList(marginPagination.page - 1)" :disabled="marginPagination.page <= 1 || marginLoading" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
            <span class="text-gray-300">{{ marginPagination.page }} / {{ marginPagination.totalPages }}</span>
            <button @click="fetchMarginList(marginPagination.page + 1)" :disabled="marginPagination.page >= marginPagination.totalPages || marginLoading" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 调价弹窗 ========== -->
    <Modal :isOpen="adjustPriceModal.show" title="调整股价" width="480px" @close="adjustPriceModal.show = false">
      <div v-if="adjustPriceModal.stock" class="space-y-3 text-sm">
        <div class="bg-gray-900 rounded p-3 border border-gray-700 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-gray-500">股票</span>
            <span class="text-cyan-300 font-bold">{{ adjustPriceModal.stock.name }} ({{ adjustPriceModal.stock.code }})</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">当前价</span>
            <span class="text-cyan-400 font-bold">{{ adjustPriceModal.stock.current_price }} 灵石</span>
          </div>
        </div>
        <div>
          <label class="block text-gray-400 mb-1">新价格（灵石）</label>
          <input v-model.number="adjustPriceModal.new_price" type="number" min="1" placeholder="新价格" class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white" />
        </div>
        <div>
          <label class="block text-gray-400 mb-1">操作原因（必填）</label>
          <textarea v-model="adjustPriceModal.reason" rows="3" placeholder="请填写调价原因，将记录到审计日志" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"></textarea>
        </div>
        <p class="text-xs text-amber-400">提示：调价会立即生效，并触发涨跌幅重算与可能的熔断。</p>
      </div>
      <template #footer>
        <button @click="adjustPriceModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="confirmAdjustPrice" :disabled="operating" class="px-4 py-2 bg-amber-700 hover:bg-amber-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">
          {{ operating ? '执行中...' : '确认调价' }}
        </button>
      </template>
    </Modal>

    <!-- ========== 暂停交易弹窗 ========== -->
    <Modal :isOpen="haltModal.show" title="暂停股票交易" width="480px" @close="haltModal.show = false">
      <div v-if="haltModal.stock" class="space-y-3 text-sm">
        <div class="bg-gray-900 rounded p-3 border border-gray-700 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-gray-500">股票</span>
            <span class="text-cyan-300 font-bold">{{ haltModal.stock.name }} ({{ haltModal.stock.code }})</span>
          </div>
        </div>
        <div>
          <label class="block text-gray-400 mb-1">暂停时长（分钟）</label>
          <input v-model.number="haltModal.duration_minutes" type="number" min="1" placeholder="如 60" class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white" />
        </div>
        <div>
          <label class="block text-gray-400 mb-1">操作原因（必填）</label>
          <textarea v-model="haltModal.reason" rows="3" placeholder="请填写暂停原因，将记录到审计日志" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"></textarea>
        </div>
      </div>
      <template #footer>
        <button @click="haltModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="confirmHalt" :disabled="operating" class="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">
          {{ operating ? '执行中...' : '确认暂停' }}
        </button>
      </template>
    </Modal>

    <!-- ========== 恢复交易确认弹窗（替代浏览器 confirm） ========== -->
    <Modal :isOpen="resumeModal.show" title="恢复交易确认" width="420px" @close="resumeModal.show = false">
      <div v-if="resumeModal.stock" class="space-y-3 text-sm">
        <p class="text-gray-300">确认恢复股票 <span class="text-cyan-300 font-bold">{{ resumeModal.stock.name }} ({{ resumeModal.stock.code }})</span> 的交易？</p>
        <p class="text-xs text-emerald-400">恢复后该股票即可正常买卖。</p>
      </div>
      <template #footer>
        <button @click="resumeModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="confirmResumeStock" :disabled="operating" class="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">
          {{ operating ? '执行中...' : '确认恢复' }}
        </button>
      </template>
    </Modal>

    <!-- ========== 触发事件弹窗（单股票或全市场） ========== -->
    <Modal :isOpen="eventModal.show" :title="eventModal.isGlobal ? '触发全市场事件' : '触发股价事件'" width="520px" @close="eventModal.show = false">
      <div class="space-y-3 text-sm">
        <div v-if="eventModal.stock" class="bg-gray-900 rounded p-3 border border-gray-700">
          <div class="flex items-center justify-between">
            <span class="text-gray-500">目标股票</span>
            <span class="text-cyan-300 font-bold">{{ eventModal.stock.name }} ({{ eventModal.stock.code }})</span>
          </div>
        </div>
        <div v-else class="bg-purple-950/40 border border-purple-700/50 rounded p-3 text-purple-300 text-xs">
          全市场事件：将影响所有股票
        </div>
        <div>
          <label class="block text-gray-400 mb-1">事件类型</label>
          <select v-model="eventForm.event_type" class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white">
            <option value="positive">利好（positive）</option>
            <option value="negative">利空（negative）</option>
            <option value="volatility">波动（volatility）</option>
            <option value="custom">自定义（custom）</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-gray-400 mb-1">影响百分比（%）</label>
            <input v-model.number="eventForm.impact_pct" type="number" step="0.01" placeholder="如 5 表示 +5%" class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white" />
            <p class="text-xs text-gray-500 mt-1">实际影响 = impact_pct / 100</p>
          </div>
          <div>
            <label class="block text-gray-400 mb-1">持续时间（小时）</label>
            <input v-model.number="eventForm.duration_hours" type="number" min="1" placeholder="如 24" class="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white" />
          </div>
        </div>
        <div>
          <label class="block text-gray-400 mb-1">事件描述</label>
          <textarea v-model="eventForm.description" rows="3" placeholder="如：天劫降临，宗门股票全线下挫" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"></textarea>
        </div>
      </div>
      <template #footer>
        <button @click="eventModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="confirmTriggerEvent" :disabled="operating" class="px-4 py-2 bg-purple-700 hover:bg-purple-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">
          {{ operating ? '执行中...' : '触发事件' }}
        </button>
      </template>
    </Modal>

    <!-- ========== 强制平仓确认弹窗 ========== -->
    <Modal :isOpen="forceLiquidateModal.show" title="强制平仓确认" width="480px" @close="forceLiquidateModal.show = false">
      <div v-if="forceLiquidateModal.account" class="space-y-3 text-sm">
        <p class="text-rose-300 font-bold">⚠️ 警告：强制平仓将卖出玩家所有持仓偿还负债！</p>
        <div class="bg-gray-900 rounded p-3 border border-gray-700 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-gray-500">玩家</span>
            <span class="text-white">{{ forceLiquidateModal.account.player_nickname }} (ID: {{ forceLiquidateModal.account.player_id }})</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">总资产</span>
            <span class="text-amber-400 font-bold">{{ forceLiquidateModal.account.total_assets }} 灵石</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">负债</span>
            <span class="text-rose-400 font-bold">{{ forceLiquidateModal.account.debt }} 灵石</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-500">保证金率</span>
            <span class="font-bold">{{ ((forceLiquidateModal.account.margin_ratio || 0) * 100).toFixed(2) }}%</span>
          </div>
        </div>
        <div>
          <label class="block text-gray-400 mb-1">操作原因（必填）</label>
          <textarea v-model="forceLiquidateModal.reason" rows="3" placeholder="请填写强制平仓原因，将记录到审计日志" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"></textarea>
        </div>
      </div>
      <template #footer>
        <button @click="forceLiquidateModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="confirmForceLiquidate" :disabled="operating" class="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">
          {{ operating ? '执行中...' : '确认平仓' }}
        </button>
      </template>
    </Modal>

    <!-- ========== 分红确认弹窗 ========== -->
    <Modal :isOpen="dividendConfirmModal.show" title="确认触发分红" width="420px" @close="dividendConfirmModal.show = false">
      <div class="space-y-3 text-sm">
        <p class="text-gray-300">确认对股票 ID {{ dividendForm.stock_id }} 触发分红？</p>
        <p class="text-xs text-amber-400">分红金额由后端根据持仓与分红率计算，将派发给所有持仓玩家。</p>
      </div>
      <template #footer>
        <button @click="dividendConfirmModal.show = false" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">取消</button>
        <button @click="confirmDistributeDividend" :disabled="operating" class="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">
          {{ operating ? '执行中...' : '确认分红' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * 聚宝股市管理组件（GM 后台）
 *
 * 功能：
 *   1. 展示股市统计指标（活跃股票数、持仓玩家数、今日交易额、融资账户数）
 *   2. 股票管理：列表查询、GM 调价、暂停/恢复交易、触发股价事件
 *   3. 交易流水：全服交易流水查询，支持按玩家 ID / 股票 ID / 交易类型筛选
 *   4. 融资管理：融资账户列表、强制平仓、手动触发分红
 *
 * 所有操作均通过 admin_stock API 调用后端，前端只做展示与接口调用。
 * 所有写操作均要求填写操作原因，记录到 admin_logs 审计日志。
 */
import { ref, reactive, onMounted } from 'vue'
import { useUIStore } from '../../../stores/ui'
import Modal from '../../common/Modal.vue'
// 注意：resumeStock / haltStock 等API函数使用别名导入，避免与本地处理函数重名递归
import {
  getMetrics,
  getStocks,
  adjustPrice,
  haltStock,
  resumeStock as resumeStockApi,
  triggerEvent,
  getMarginList,
  forceLiquidate,
  getTransactions,
  distributeDividend
} from '../../../api/admin_stock'

const uiStore = useUIStore()

/* ===================== 响应式状态 ===================== */

const loading = ref(false)
const operating = ref(false)
const metrics = ref(null)

// 子 Tab
const subTabs = [
  { id: 'stocks', name: '股票管理' },
  { id: 'transactions', name: '交易流水' },
  { id: 'margin', name: '融资管理' }
]
const activeSubTab = ref('stocks')

/* ===================== 股票管理状态 ===================== */

const stockList = ref([])
const stockParams = reactive({ category: '' })
const pagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
})

// 调价弹窗
const adjustPriceModal = ref({
  show: false,
  stock: null,
  new_price: 0,
  reason: ''
})

// 暂停弹窗
const haltModal = ref({
  show: false,
  stock: null,
  duration_minutes: 60,
  reason: ''
})

// 恢复交易确认弹窗（替代浏览器 confirm，符合项目规范）
const resumeModal = ref({
  show: false,
  stock: null
})

// 触发事件弹窗
const eventModal = ref({
  show: false,
  stock: null,
  isGlobal: false
})
const eventForm = reactive({
  event_type: 'positive',
  impact_pct: 5,
  duration_hours: 24,
  description: ''
})

/* ===================== 交易流水状态 ===================== */

const txLoading = ref(false)
const txList = ref([])
const txParams = reactive({
  player_id: undefined,
  stock_id: undefined,
  trade_type: ''
})
const txPagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
})

/* ===================== 融资管理状态 ===================== */

const marginLoading = ref(false)
const marginList = ref([])
const marginPagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
})

// 强制平仓弹窗
const forceLiquidateModal = ref({
  show: false,
  account: null,
  reason: ''
})

// 分红表单
const dividendForm = reactive({
  stock_id: undefined,
  reason: ''
})
const dividendConfirmModal = ref({ show: false })

/* ===================== 子 Tab 切换 ===================== */

/**
 * 切换子 Tab 并按需加载数据
 * @param {string} tab - stocks/transactions/margin
 */
const switchSubTab = (tab) => {
  if (activeSubTab.value === tab) return
  activeSubTab.value = tab
  if (tab === 'transactions' && txList.value.length === 0) {
    fetchTransactions()
  } else if (tab === 'margin' && marginList.value.length === 0) {
    fetchMarginList()
  }
}

/* ===================== 数据获取 ===================== */

/**
 * 拉取统计指标
 */
const fetchMetrics = async () => {
  try {
    const res = await getMetrics()
    metrics.value = res.data?.data || res.data
  } catch (err) {
    console.error('[StockManagement] 获取指标失败:', err)
    uiStore.showToast('获取指标失败', 'error')
  }
}

/**
 * 拉取股票列表
 * @param {number} page - 页码
 */
const fetchStocks = async (page = 1) => {
  if (page < 1) page = 1
  loading.value = true
  try {
    const params = {
      page,
      limit: pagination.pageSize
    }
    if (stockParams.category) params.category = stockParams.category
    const res = await getStocks(params)
    const data = res.data?.data || res.data
    stockList.value = data.list || []
    pagination.total = data.total || 0
    pagination.page = data.page || page
    pagination.totalPages = data.total_pages || 1
  } catch (err) {
    console.error('[StockManagement] 获取股票列表失败:', err)
    const msg = err?.response?.data?.message || '获取股票列表失败'
    uiStore.showToast(msg, 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 拉取交易流水
 * @param {number} page - 页码
 */
const fetchTransactions = async (page = 1) => {
  if (page < 1) page = 1
  txLoading.value = true
  try {
    const params = {
      page,
      limit: txPagination.pageSize
    }
    if (txParams.player_id) params.player_id = txParams.player_id
    if (txParams.stock_id) params.stock_id = txParams.stock_id
    if (txParams.trade_type) params.trade_type = txParams.trade_type
    const res = await getTransactions(params)
    const data = res.data?.data || res.data
    txList.value = data.list || []
    txPagination.total = data.total || 0
    txPagination.page = data.page || page
    txPagination.totalPages = data.total_pages || 1
  } catch (err) {
    console.error('[StockManagement] 获取流水失败:', err)
    const msg = err?.response?.data?.message || '获取流水失败'
    uiStore.showToast(msg, 'error')
  } finally {
    txLoading.value = false
  }
}

/**
 * 重置流水筛选
 */
const resetTxSearch = () => {
  txParams.player_id = undefined
  txParams.stock_id = undefined
  txParams.trade_type = ''
  fetchTransactions(1)
}

/**
 * 拉取融资账户列表
 * @param {number} page - 页码
 */
const fetchMarginList = async (page = 1) => {
  if (page < 1) page = 1
  marginLoading.value = true
  try {
    const res = await getMarginList(page, marginPagination.pageSize)
    const data = res.data?.data || res.data
    marginList.value = data.list || []
    marginPagination.total = data.total || 0
    marginPagination.page = data.page || page
    marginPagination.totalPages = data.total_pages || 1
  } catch (err) {
    console.error('[StockManagement] 获取融资账户失败:', err)
    const msg = err?.response?.data?.message || '获取融资账户失败'
    uiStore.showToast(msg, 'error')
  } finally {
    marginLoading.value = false
  }
}

/* ===================== 调价操作 ===================== */

/**
 * 打开调价弹窗
 * @param {Object} stock - 股票对象
 */
const openAdjustPriceModal = (stock) => {
  adjustPriceModal.value = {
    show: true,
    stock,
    new_price: Number(stock.current_price) || 0,
    reason: ''
  }
}

/**
 * 确认调价
 */
const confirmAdjustPrice = async () => {
  const { stock, new_price, reason } = adjustPriceModal.value
  if (!stock) return
  if (!new_price || new_price <= 0) {
    uiStore.showToast('新价格必须大于 0', 'warning')
    return
  }
  if (!reason || !reason.trim()) {
    uiStore.showToast('请填写操作原因', 'warning')
    return
  }
  if (operating.value) return
  operating.value = true
  try {
    const res = await adjustPrice(stock.id, { new_price, reason: reason.trim() })
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '调价成功', 'success')
    adjustPriceModal.value.show = false
    await Promise.all([fetchStocks(pagination.page), fetchMetrics()])
  } catch (err) {
    console.error('[StockManagement] 调价失败:', err)
    const msg = err?.response?.data?.message || '调价失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/* ===================== 暂停/恢复交易 ===================== */

/**
 * 打开暂停弹窗
 * @param {Object} stock - 股票对象
 */
const openHaltModal = (stock) => {
  haltModal.value = {
    show: true,
    stock,
    duration_minutes: 60,
    reason: ''
  }
}

/**
 * 确认暂停
 */
const confirmHalt = async () => {
  const { stock, duration_minutes, reason } = haltModal.value
  if (!stock) return
  if (!duration_minutes || duration_minutes <= 0) {
    uiStore.showToast('暂停时长必须大于 0', 'warning')
    return
  }
  if (!reason || !reason.trim()) {
    uiStore.showToast('请填写操作原因', 'warning')
    return
  }
  if (operating.value) return
  operating.value = true
  try {
    const res = await haltStock(stock.id, { duration_minutes, reason: reason.trim() })
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '暂停成功', 'success')
    haltModal.value.show = false
    await fetchStocks(pagination.page)
  } catch (err) {
    console.error('[StockManagement] 暂停失败:', err)
    const msg = err?.response?.data?.message || '暂停失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/**
 * 打开恢复交易确认弹窗（替代浏览器 confirm，符合项目规范）
 * @param {Object} stock - 股票对象
 */
const openResumeModal = (stock) => {
  resumeModal.value = {
    show: true,
    stock
  }
}

/**
 * 确认恢复交易
 */
const confirmResumeStock = async () => {
  const { stock } = resumeModal.value
  if (!stock) return
  if (operating.value) return
  operating.value = true
  try {
    // 调用别名导入的 API 函数 resumeStockApi，避免本地函数名递归调用 bug
    const res = await resumeStockApi(stock.id)
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '恢复成功', 'success')
    resumeModal.value.show = false
    await fetchStocks(pagination.page)
  } catch (err) {
    console.error('[StockManagement] 恢复失败:', err)
    const msg = err?.response?.data?.message || '恢复失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/* ===================== 触发事件 ===================== */

/**
 * 打开单股票事件弹窗
 * @param {Object} stock - 股票对象
 */
const openTriggerEventModal = (stock) => {
  eventModal.value = {
    show: true,
    stock,
    isGlobal: false
  }
  // 重置表单
  eventForm.event_type = 'positive'
  eventForm.impact_pct = 5
  eventForm.duration_hours = 24
  eventForm.description = ''
}

/**
 * 打开全市场事件弹窗
 */
const openGlobalEventModal = () => {
  eventModal.value = {
    show: true,
    stock: null,
    isGlobal: true
  }
  eventForm.event_type = 'positive'
  eventForm.impact_pct = 5
  eventForm.duration_hours = 24
  eventForm.description = ''
}

/**
 * 确认触发事件
 */
const confirmTriggerEvent = async () => {
  if (!eventForm.description || !eventForm.description.trim()) {
    uiStore.showToast('请填写事件描述', 'warning')
    return
  }
  if (!eventForm.impact_pct || eventForm.impact_pct === 0) {
    uiStore.showToast('影响百分比不能为 0', 'warning')
    return
  }
  if (!eventForm.duration_hours || eventForm.duration_hours <= 0) {
    uiStore.showToast('持续时间必须大于 0', 'warning')
    return
  }
  if (operating.value) return
  operating.value = true
  try {
    const res = await triggerEvent({
      stock_id: eventModal.value.stock ? eventModal.value.stock.id : null,
      event_type: eventForm.event_type,
      // impact_pct 后端期望小数（如 0.05），前端输入百分比（如 5）需转换
      impact_pct: eventForm.impact_pct / 100,
      duration_hours: eventForm.duration_hours,
      description: eventForm.description.trim()
    })
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '事件触发成功', 'success')
    eventModal.value.show = false
    await fetchMetrics()
  } catch (err) {
    console.error('[StockManagement] 触发事件失败:', err)
    const msg = err?.response?.data?.message || '触发事件失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/* ===================== 强制平仓 ===================== */

/**
 * 打开强制平仓弹窗
 * @param {Object} account - 融资账户对象
 */
const openForceLiquidateModal = (account) => {
  forceLiquidateModal.value = {
    show: true,
    account,
    reason: ''
  }
}

/**
 * 确认强制平仓
 */
const confirmForceLiquidate = async () => {
  const { account, reason } = forceLiquidateModal.value
  if (!account) return
  if (!reason || !reason.trim()) {
    uiStore.showToast('请填写操作原因', 'warning')
    return
  }
  if (operating.value) return
  operating.value = true
  try {
    const res = await forceLiquidate(account.player_id, reason.trim())
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || '强制平仓成功', 'success')
    forceLiquidateModal.value.show = false
    await Promise.all([fetchMarginList(marginPagination.page), fetchMetrics()])
  } catch (err) {
    console.error('[StockManagement] 强制平仓失败:', err)
    const msg = err?.response?.data?.message || '强制平仓失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/* ===================== 手动分红 ===================== */

/**
 * 打开分红确认弹窗
 */
const openDividendConfirmModal = () => {
  if (!dividendForm.stock_id || dividendForm.stock_id < 1) {
    uiStore.showToast('请填写有效的股票 ID', 'warning')
    return
  }
  dividendConfirmModal.value.show = true
}

/**
 * 确认触发分红
 */
const confirmDistributeDividend = async () => {
  if (operating.value) return
  operating.value = true
  try {
    const res = await distributeDividend(dividendForm.stock_id, dividendForm.reason?.trim())
    const data = res.data?.data || res.data || {}
    uiStore.showToast(data.message || `分红触发成功，派发 ${data.distributed_count || 0} 笔，总金额 ${data.total_dividend || 0}`, 'success')
    dividendConfirmModal.value.show = false
    dividendForm.stock_id = undefined
    dividendForm.reason = ''
    await fetchMetrics()
  } catch (err) {
    console.error('[StockManagement] 触发分红失败:', err)
    const msg = err?.response?.data?.message || '触发分红失败'
    uiStore.showToast(msg, 'error')
  } finally {
    operating.value = false
  }
}

/* ===================== 工具函数 ===================== */

/**
 * 涨跌幅颜色：绿涨红跌
 * @param {number} pct - 涨跌幅小数
 */
const changeColorClass = (pct) => {
  if (pct > 0) return 'text-emerald-400'
  if (pct < 0) return 'text-rose-400'
  return 'text-gray-400'
}

/**
 * 涨跌幅文案
 * @param {number} pct - 涨跌幅小数
 */
const changeText = (pct) => {
  const sign = pct > 0 ? '+' : ''
  return `${sign}${(pct * 100).toFixed(2)}%`
}

/**
 * 股票分类中文标签
 * @param {string} category - 分类
 */
const categoryLabel = (category) => {
  const map = {
    sect: '宗门',
    mine: '灵矿',
    dungeon: '秘境',
    event: '事件'
  }
  return map[category] || category
}

/**
 * 格式化日期
 * @param {string} dateStr - ISO 时间字符串
 */
const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return dateStr
  }
}

/* ===================== 生命周期 ===================== */

onMounted(() => {
  // 进入面板时并行拉取指标与股票列表
  fetchMetrics()
  fetchStocks(1)
})
</script>

<style scoped>
</style>
