<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
    <div class="bg-gray-900 border border-gray-700 w-full max-w-6xl h-[85vh] flex flex-col rounded-lg shadow-2xl">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800">
        <h2 class="text-xl font-bold text-xiuxian-gold">GM 管理后台</h2>
        <button @click="$emit('close')" class="text-gray-400 hover:text-white">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-700 bg-gray-800/50 overflow-x-auto">
        <button 
          v-for="tab in tabs" 
          :key="tab.id"
          @click="currentTab = tab.id"
          class="px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap"
          :class="currentTab === tab.id ? 'text-xiuxian-gold' : 'text-gray-400 hover:text-gray-200'"
        >
          {{ tab.name }}
          <div v-if="currentTab === tab.id" class="absolute bottom-0 left-0 w-full h-0.5 bg-xiuxian-gold"></div>
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto p-4 custom-scrollbar">
        <!-- 玩家管理 -->
        <div v-if="currentTab === 'players'" class="space-y-4">
          <div class="flex flex-wrap justify-between items-center gap-4 mb-4">
            <h3 class="text-lg font-bold text-white">玩家列表</h3>
            <div class="flex gap-2">
              <input 
                v-model="playerSearch" 
                @keyup.enter="fetchPlayers(1)"
                placeholder="搜索账号/昵称" 
                class="px-3 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm"
              >
              <select v-model="playerFilter" @change="fetchPlayers(1)" class="px-3 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm">
                <option value="">全部状态</option>
                <option value="active">正常玩家</option>
                <option value="banned">已封禁</option>
                <option value="dead">已死亡</option>
              </select>
              <button @click="fetchPlayers(1)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">搜索</button>
            </div>
          </div>
          
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm text-gray-300">
              <thead class="bg-gray-800 text-gray-400 uppercase">
                <tr>
                  <th class="px-4 py-3 whitespace-nowrap">ID</th>
                  <th class="px-4 py-3 whitespace-nowrap">账号</th>
                  <th class="px-4 py-3 whitespace-nowrap">昵称</th>
                  <th class="px-4 py-3 whitespace-nowrap">境界</th>
                  <th class="px-4 py-3 whitespace-nowrap">寿元</th>
                  <th class="px-4 py-3 whitespace-nowrap">状态</th>
                  <th class="px-4 py-3 whitespace-nowrap">注册时间</th>
                  <th class="px-4 py-3 whitespace-nowrap">最后在线</th>
                  <th class="px-4 py-3 whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-700">
                <tr v-for="p in players" :key="p.id" class="hover:bg-gray-800/50">
                  <td class="px-4 py-3 whitespace-nowrap">{{ p.id }}</td>
                  <td class="px-4 py-3 whitespace-nowrap">{{ p.username }}</td>
                  <td class="px-4 py-3 whitespace-nowrap">{{ p.nickname }}</td>
                  <td class="px-4 py-3 whitespace-nowrap">{{ p.realm }}</td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    <span :class="getLifespanClass(p)">{{ p.lifespan_current }}/{{ p.lifespan_max }}</span>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    <span v-if="p.role === 'admin'" class="text-red-400">管理员</span>
                    <span v-else-if="p.role === 'banned'" class="text-orange-400">已封禁</span>
                    <span v-else-if="p.is_dead" class="text-gray-500">已死亡</span>
                    <span v-else class="text-green-400">正常</span>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ formatDate(p.createdAt) }}</td>
                  <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ formatDate(p.last_online) }}</td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    <div class="flex gap-1 flex-wrap">
                      <button @click="editPlayer(p)" class="text-blue-400 hover:text-blue-300 text-xs px-1">编辑</button>
                      <button v-if="p.role !== 'admin' && p.role !== 'banned'" @click="showBanModal(p)" class="text-orange-400 hover:text-orange-300 text-xs px-1">封禁</button>
                      <button v-if="p.role === 'banned'" @click="unbanPlayer(p)" class="text-green-400 hover:text-green-300 text-xs px-1">解封</button>
                      <button v-if="p.role !== 'admin'" @click="showGiveModal(p)" class="text-purple-400 hover:text-purple-300 text-xs px-1">发放</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 分页 -->
          <div class="flex justify-center items-center gap-4 mt-4">
            <button 
              :disabled="pagination.currentPage === 1"
              @click="fetchPlayers(pagination.currentPage - 1)"
              class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
            >上一页</button>
            <span class="text-gray-400">第 {{ pagination.currentPage }} / {{ pagination.totalPages }} 页 (共{{ pagination.total }}条)</span>
            <button 
              :disabled="pagination.currentPage === pagination.totalPages"
              @click="fetchPlayers(pagination.currentPage + 1)"
              class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
            >下一页</button>
          </div>
        </div>

        <!-- 系统配置 -->
        <div v-if="currentTab === 'config'" class="space-y-6">
          <div class="flex justify-between items-center">
             <h3 class="text-lg font-bold text-white">系统参数配置</h3>
             <button @click="fetchConfig" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新配置</button>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <!-- 自动存档间隔 -->
            <div class="bg-gray-800 p-4 rounded border border-gray-700">
              <label class="block text-sm font-medium text-gray-400 mb-2">自动存档间隔 (毫秒)</label>
              <div class="flex space-x-2">
                <input 
                  v-model="configs.auto_save_interval" 
                  type="number" 
                  class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                >
                <button @click="saveConfig('auto_save_interval', configs.auto_save_interval, '自动存档间隔(ms)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
              </div>
              <p class="mt-1 text-xs text-gray-500">默认: 10000 (10秒)</p>
            </div>

            <!-- 闭关冷却时间 -->
            <div class="bg-gray-800 p-4 rounded border border-gray-700">
              <label class="block text-sm font-medium text-gray-400 mb-2">闭关冷却时间 (秒)</label>
              <div class="flex space-x-2">
                <input 
                  v-model="configs.seclusion_cooldown" 
                  type="number" 
                  class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                >
                <button @click="saveConfig('seclusion_cooldown', configs.seclusion_cooldown, '闭关冷却时间(秒)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
              </div>
              <p class="mt-1 text-xs text-gray-500">默认: 3600 (60分钟)</p>
            </div>

            <!-- 闭关经验倍率 -->
            <div class="bg-gray-800 p-4 rounded border border-gray-700">
              <label class="block text-sm font-medium text-gray-400 mb-2">闭关基础收益 (修为/秒)</label>
              <div class="flex space-x-2">
                <input 
                  v-model="configs.seclusion_exp_rate" 
                  type="number" 
                  step="0.01"
                  class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                >
                <button @click="saveConfig('seclusion_exp_rate', configs.seclusion_exp_rate, '闭关经验倍率(修为/秒)')" class="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-white text-sm">保存</button>
              </div>
              <p class="mt-1 text-xs text-gray-500">默认: 0.1 (每10秒1点修为)</p>
            </div>
            
            <!-- 时间控制 (GM) -->
            <div class="bg-gray-800 p-4 rounded border border-gray-700 md:col-span-2 lg:col-span-3 mt-4">
              <label class="block text-sm font-medium text-amber-500 mb-2 font-bold">⏳ 时光飞逝 (时间加速)</label>
              <div class="flex items-center gap-4 flex-wrap">
                <div class="flex items-center gap-2 flex-1 min-w-[200px]">
                  <span class="text-gray-400 text-sm">加速年份:</span>
                  <input 
                    v-model="timeTravelYears" 
                    type="number" 
                    min="0.1"
                    step="0.1"
                    class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white"
                    placeholder="输入年份，如 1 或 0.5"
                  >
                </div>
                <button 
                  @click="confirmTimeTravel" 
                  :disabled="isTimeTraveling"
                  class="px-6 py-2 bg-amber-700 hover:bg-amber-600 rounded text-white text-sm font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg v-if="isTimeTraveling" class="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                  {{ isTimeTraveling ? '加速中...' : '执行加速' }}
                </button>
              </div>
              <p class="mt-2 text-xs text-gray-500">警告：此操作会增加全服所有玩家的寿命，可能导致寿元耗尽的玩家死亡！(24小时=1年)</p>
            </div>
          </div>
        </div>

        <!-- 服务器统计 -->
        <div v-if="currentTab === 'stats'" class="space-y-6">
          <div class="flex justify-between items-center">
            <h3 class="text-lg font-bold text-white">服务器统计</h3>
            <button @click="fetchStats" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
          </div>

          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="bg-gray-800 p-4 rounded border border-gray-700 text-center">
              <div class="text-3xl font-bold text-xiuxian-gold">{{ stats.total_players || 0 }}</div>
              <div class="text-gray-400 text-sm mt-1">总玩家数</div>
            </div>
            <div class="bg-gray-800 p-4 rounded border border-gray-700 text-center">
              <div class="text-3xl font-bold text-green-400">{{ stats.online_players || 0 }}</div>
              <div class="text-gray-400 text-sm mt-1">在线玩家</div>
            </div>
            <div class="bg-gray-800 p-4 rounded border border-gray-700 text-center">
              <div class="text-3xl font-bold text-red-400">{{ stats.banned_count || 0 }}</div>
              <div class="text-gray-400 text-sm mt-1">已封禁</div>
            </div>
            <div class="bg-gray-800 p-4 rounded border border-gray-700 text-center">
              <div class="text-3xl font-bold text-blue-400">{{ formatUptime(stats.server_uptime) }}</div>
              <div class="text-gray-400 text-sm mt-1">服务器运行时间</div>
            </div>
          </div>

          <!-- 境界分布 -->
          <div class="bg-gray-800 p-4 rounded border border-gray-700">
            <h4 class="text-md font-bold text-white mb-4">境界分布</h4>
            <div class="space-y-2">
              <div v-for="realm in stats.realm_distribution" :key="realm.realm" class="flex items-center gap-3">
                <span class="text-gray-300 w-24">{{ realm.realm }}</span>
                <div class="flex-1 h-6 bg-gray-700 rounded overflow-hidden">
                  <div 
                    class="h-full bg-xiuxian-gold/50 transition-all duration-300"
                    :style="{ width: getRealmBarWidth(realm.count) + '%' }"
                  ></div>
                </div>
                <span class="text-gray-400 w-12 text-right">{{ realm.count }}</span>
              </div>
              <div v-if="!stats.realm_distribution?.length" class="text-gray-500 text-center py-4">暂无数据</div>
            </div>
          </div>
        </div>

        <!-- 操作日志 -->
        <div v-if="currentTab === 'logs'" class="space-y-4">
          <div class="flex flex-wrap justify-between items-center gap-4 mb-4">
            <h3 class="text-lg font-bold text-white">操作日志</h3>
            <div class="flex gap-2">
              <select v-model="logFilter" @change="fetchLogs(1)" class="px-3 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm">
                <option value="">全部操作</option>
                <option value="time_travel">时间加速</option>
                <option value="ban_player">封禁玩家</option>
                <option value="unban_player">解封玩家</option>
                <option value="modify_player">修改玩家</option>
                <option value="give_item">发放物品</option>
                <option value="give_spirit_stones">发放灵石</option>
                <option value="add_exp">增加修为</option>
                <option value="reset_player">重置玩家</option>
                <option value="force_breakthrough">强制突破</option>
                <option value="delete_player">删除玩家</option>
                <option value="update_config">修改配置</option>
              </select>
              <button @click="fetchLogs(1)" class="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm">刷新</button>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm text-gray-300">
              <thead class="bg-gray-800 text-gray-400 uppercase">
                <tr>
                  <th class="px-4 py-3 whitespace-nowrap">时间</th>
                  <th class="px-4 py-3 whitespace-nowrap">管理员ID</th>
                  <th class="px-4 py-3 whitespace-nowrap">操作类型</th>
                  <th class="px-4 py-3 whitespace-nowrap">操作详情</th>
                  <th class="px-4 py-3 whitespace-nowrap">IP地址</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-700">
                <tr v-for="log in logs" :key="log.id" class="hover:bg-gray-800/50">
                  <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ formatDateTime(log.createdAt) }}</td>
                  <td class="px-4 py-3 whitespace-nowrap">{{ log.admin_id }}</td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    <span class="px-2 py-0.5 rounded text-xs" :class="getActionClass(log.action)">{{ getActionName(log.action) }}</span>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap text-gray-400 max-w-xs truncate">{{ log.details }}</td>
                  <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ log.ip || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="flex justify-center items-center gap-4 mt-4">
            <button 
              :disabled="logPagination.currentPage === 1"
              @click="fetchLogs(logPagination.currentPage - 1)"
              class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
            >上一页</button>
            <span class="text-gray-400">第 {{ logPagination.currentPage }} / {{ logPagination.totalPages }} 页</span>
            <button 
              :disabled="logPagination.currentPage === logPagination.totalPages"
              @click="fetchLogs(logPagination.currentPage + 1)"
              class="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
            >下一页</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑玩家弹窗 -->
    <Modal :isOpen="!!editingPlayer" title="编辑玩家" @close="editingPlayer = null">
      <div v-if="editingPlayer" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm text-gray-400 mb-1">账号</label>
            <input :value="editingPlayer.username" disabled class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-gray-500">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">昵称</label>
            <input v-model="editingPlayer.nickname" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">修为 (Exp)</label>
            <input v-model.number="editingPlayer.exp" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">灵石</label>
            <input v-model.number="editingPlayer.spirit_stones" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">境界</label>
            <input v-model="editingPlayer.realm" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">当前寿元</label>
            <input v-model.number="editingPlayer.lifespan_current" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">最大寿元</label>
            <input v-model.number="editingPlayer.lifespan_max" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">角色权限</label>
            <select v-model="editingPlayer.role" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
        </div>
      </div>
      <template #footer>
        <button @click="editingPlayer = null" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="submitPlayerEdit" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded">保存</button>
      </template>
    </Modal>

    <!-- 封禁玩家弹窗 -->
    <Modal :isOpen="!!banningPlayer" title="封禁玩家" @close="banningPlayer = null">
      <div v-if="banningPlayer" class="space-y-4">
        <p class="text-gray-300">封禁玩家: <span class="text-xiuxian-gold">{{ banningPlayer.nickname }}</span></p>
        <div>
          <label class="block text-sm text-gray-400 mb-1">封禁原因</label>
          <input v-model="banReason" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" placeholder="输入封禁原因">
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">封禁天数 (-1表示永久)</label>
          <input v-model.number="banDays" type="number" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
      </div>
      <template #footer>
        <button @click="banningPlayer = null" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="confirmBan" class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded">确认封禁</button>
      </template>
    </Modal>

    <!-- 发放物品弹窗 -->
    <Modal :isOpen="!!givingPlayer" title="发放物品" @close="givingPlayer = null">
      <div v-if="givingPlayer" class="space-y-4">
        <p class="text-gray-300">发放给: <span class="text-xiuxian-gold">{{ givingPlayer.nickname }}</span></p>
        
        <div>
          <label class="block text-sm text-gray-400 mb-1">发放类型</label>
          <select v-model="giveType" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="item">物品</option>
            <option value="spirit_stones">灵石</option>
            <option value="exp">修为</option>
          </select>
        </div>

        <div v-if="giveType === 'item'">
          <label class="block text-sm text-gray-400 mb-1">物品ID</label>
          <input v-model="giveItemId" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" placeholder="输入物品ID">
          <p class="mt-1 text-xs text-gray-500">提示: 可用物品ID见 item_data.json 配置</p>
        </div>

        <div v-if="giveType === 'item'">
          <label class="block text-sm text-gray-400 mb-1">数量</label>
          <input v-model.number="giveQuantity" type="number" min="1" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>

        <div v-if="giveType === 'spirit_stones'">
          <label class="block text-sm text-gray-400 mb-1">灵石数量</label>
          <input v-model.number="giveAmount" type="number" min="1" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>

        <div v-if="giveType === 'exp'">
          <label class="block text-sm text-gray-400 mb-1">修为数量</label>
          <input v-model.number="giveAmount" type="number" min="1" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white">
        </div>
      </div>
      <template #footer>
        <button @click="givingPlayer = null" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="confirmGive" class="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded">确认发放</button>
      </template>
    </Modal>

    <!-- Confirm Modal -->
    <Modal :isOpen="showTimeTravelConfirm" title="确认时间加速" @close="showTimeTravelConfirm = false">
      <div class="space-y-4">
        <p class="text-gray-300">
          确定要让时间加速 <span class="text-red-400 font-bold text-lg">{{ timeTravelYears }}</span> 年吗？
        </p>
        <div class="bg-red-900/30 border border-red-800 rounded p-3">
          <p class="text-red-400 text-sm">
            ⚠️ 警告：这会导致所有在线/离线玩家消耗寿元。寿元耗尽者将会死亡并掉落境界！
          </p>
        </div>
      </div>
      <template #footer>
        <button @click="showTimeTravelConfirm = false" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">取消</button>
        <button @click="triggerTimeTravel" class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded">确认执行</button>
      </template>
    </Modal>

    <!-- Death Modal -->
    <Modal :isOpen="showDeathModal" title="⚠️ 噩耗" :showClose="true" @close="showDeathModal = false">
      <div class="space-y-6 text-center py-4">
        <div class="text-6xl">🪦</div>
        <h3 class="text-2xl font-bold text-red-500">寿元已尽</h3>
        <p class="text-gray-300 text-lg">{{ deathMessage }}</p>
        <p class="text-gray-400">你的境界已跌落，请重新来过。</p>
      </div>
      <template #footer>
        <button @click="showDeathModal = false" class="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">
          黯然接受
        </button>
      </template>
    </Modal>

  </div>
</template>

<script setup>
import { ref, onMounted, reactive } from 'vue'
import axios from 'axios'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import Modal from '../common/Modal.vue'

const emit = defineEmits(['close'])
const playerStore = usePlayerStore()
const uiStore = useUIStore()

const tabs = [
  { id: 'players', name: '玩家数据' },
  { id: 'config', name: '系统配置' },
  // { id: 'events', name: '事件管理' }
]
const currentTab = ref('players')

// 玩家数据
const players = ref([])
const pagination = reactive({
  currentPage: 1,
  totalPages: 1,
  total: 0
})

// 系统配置
const configs = reactive({
  auto_save_interval: 10000,
  seclusion_cooldown: 3600,
  seclusion_exp_rate: 0.1
})

const editingPlayer = ref(null)

// 时间加速
const timeTravelYears = ref(1)
const isTimeTraveling = ref(false)
const showTimeTravelConfirm = ref(false)
const showDeathModal = ref(false)
const deathMessage = ref('')

// 封禁功能相关
const banningPlayer = ref(null)
const banReason = ref('')
const banDays = ref(-1)

const showBanModal = (player) => {
  banningPlayer.value = player
  banReason.value = ''
  banDays.value = -1
}

const confirmBan = async () => {
  if (!banningPlayer.value) return
  try {
    await axios.post(`/api/admin/players/${banningPlayer.value.id}/ban`, {
      reason: banReason.value,
      days: banDays.value
    })
    alert('封禁成功')
    banningPlayer.value = null
    fetchPlayers(pagination.currentPage)
  } catch (error) {
    alert('封禁失败: ' + (error.response?.data?.message || error.message))
  }
}

const unbanPlayer = async (player) => {
  if (!confirm(`确定要解封玩家 ${player.nickname} 吗？`)) return
  try {
    await axios.post(`/api/admin/players/${player.id}/unban`)
    alert('解封成功')
    fetchPlayers(pagination.currentPage)
  } catch (error) {
    alert('解封失败: ' + (error.response?.data?.message || error.message))
  }
}

const confirmTimeTravel = () => {
  if (!timeTravelYears.value || timeTravelYears.value <= 0) {
    uiStore.showToast('请输入有效的年数', 'warning')
    return
  }
  showTimeTravelConfirm.value = true
}

// 获取玩家列表
const fetchPlayers = async (page = 1) => {
  try {
    const res = await axios.get('/api/admin/players', {
      params: { page, limit: 10 }
    })
    players.value = res.data.players
    pagination.currentPage = res.data.currentPage
    pagination.totalPages = res.data.totalPages
    pagination.total = res.data.total
  } catch (error) {
    console.error('Fetch players error:', error)
    alert('获取玩家列表失败')
  }
}

// 获取配置
const fetchConfig = async () => {
  try {
    const res = await axios.get('/api/admin/config')
    res.data.forEach(item => {
      if (item.key === 'auto_save_interval') configs.auto_save_interval = parseInt(item.value)
      if (item.key === 'seclusion_cooldown') configs.seclusion_cooldown = parseInt(item.value)
      if (item.key === 'seclusion_exp_rate') configs.seclusion_exp_rate = parseFloat(item.value)
    })
  } catch (error) {
    console.error('Fetch config error:', error)
  }
}

// 保存配置
const saveConfig = async (key, value, desc) => {
  try {
    await axios.post('/api/admin/config', {
      key,
      value: value.toString(),
      description: desc
    })
    alert('配置保存成功')
  } catch (error) {
    alert('配置保存失败')
  }
}

// 编辑玩家
const editPlayer = (player) => {
  // 深拷贝防止直接修改显示
  editingPlayer.value = JSON.parse(JSON.stringify(player))
}

const submitPlayerEdit = async () => {
  if (!editingPlayer.value) return
  try {
    await axios.put(`/api/admin/players/${editingPlayer.value.id}`, editingPlayer.value)
    alert('玩家信息更新成功')
    editingPlayer.value = null
    fetchPlayers(pagination.currentPage)
  } catch (error) {
    alert('更新失败: ' + (error.response?.data?.message || error.message))
  }
}

const triggerTimeTravel = async () => {
  showTimeTravelConfirm.value = false
  isTimeTraveling.value = true
  try {
    const res = await axios.post('/api/admin/time-travel', {
      years: parseFloat(timeTravelYears.value)
    })
    
    console.log('Time travel response:', res.data)

    // 刷新玩家数据
    try {
        await playerStore.fetchPlayer()
    } catch (e) {
        console.warn('Refresh player failed:', e)
    }
    
    // 刷新管理员面板的玩家列表（如果当前在看列表）
    if (currentTab.value === 'players') {
      fetchPlayers(pagination.currentPage)
    }

    // 检查死亡通知
    if (res.data && res.data.userDied) {
       deathMessage.value = res.data.deathLog || '寿元耗尽，身死道消。'
       showDeathModal.value = true
    } else {
       const msg = res.data?.message || '操作成功'
       if (uiStore) {
           uiStore.showToast(msg, 'success')
       } else {
           alert(msg)
       }
    }

  } catch (error) {
    console.error('Time travel error object:', error)
    const errorMsg = error.response?.data?.message || '时间加速失败'
    if (uiStore) {
        uiStore.showToast(errorMsg, 'error')
    } else {
        alert(errorMsg)
    }
  } finally {
    isTimeTraveling.value = false
  }
}

onMounted(() => {
  fetchPlayers()
  fetchConfig()
})
</script>

<style scoped>
.admin-panel {
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}

.modal-transition-enter-active,
.modal-transition-leave-active {
  transition: all 0.3s ease;
}

.modal-transition-enter-from,
.modal-transition-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: #1f2937;
  border-radius: 4px;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #4b5563;
  border-radius: 4px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #6b7280;
}

.table-row-hover:hover {
  background-color: rgba(55, 65, 81, 0.5);
  transition: background-color 0.15s ease;
}

.btn-primary {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  transition: all 0.2s ease;
}

.btn-primary:hover {
  background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
}

.btn-danger {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  transition: all 0.2s ease;
}

.btn-danger:hover {
  background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
}

.btn-success {
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  transition: all 0.2s ease;
}

.btn-success:hover {
  background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(34, 197, 94, 0.4);
}

.btn-warning {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  transition: all 0.2s ease;
}

.btn-warning:hover {
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(245, 158, 11, 0.4);
}

.btn-purple {
  background: linear-gradient(135deg, #a855f7 0%, #9333ea 100%);
  transition: all 0.2s ease;
}

.btn-purple:hover {
  background: linear-gradient(135deg, #c084fc 0%, #a855f7 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(168, 85, 247, 0.4);
}

.tab-button {
  position: relative;
  transition: all 0.2s ease;
}

.tab-button:hover {
  background-color: rgba(75, 85, 99, 0.3);
}

.tab-indicator {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, #fbbf24, #f59e0b);
  transition: all 0.3s ease;
}

.stat-card {
  background: linear-gradient(145deg, #1f2937 0%, #111827 100%);
  border: 1px solid #374151;
  transition: all 0.3s ease;
}

.stat-card:hover {
  border-color: #4b5563;
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
}

.input-field {
  transition: all 0.2s ease;
}

.input-field:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
  outline: none;
}

.select-field {
  transition: all 0.2s ease;
}

.select-field:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
  outline: none;
}

.action-btn {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  transition: all 0.15s ease;
  cursor: pointer;
}

.action-btn:hover {
  transform: scale(1.05);
}

.action-btn-edit {
  color: #60a5fa;
  background: rgba(96, 165, 250, 0.1);
  border: 1px solid rgba(96, 165, 250, 0.3);
}

.action-btn-edit:hover {
  background: rgba(96, 165, 250, 0.2);
}

.action-btn-ban {
  color: #fb923c;
  background: rgba(251, 146, 60, 0.1);
  border: 1px solid rgba(251, 146, 60, 0.3);
}

.action-btn-ban:hover {
  background: rgba(251, 146, 60, 0.2);
}

.action-btn-unban {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.1);
  border: 1px solid rgba(74, 222, 128, 0.3);
}

.action-btn-unban:hover {
  background: rgba(74, 222, 128, 0.2);
}

.action-btn-give {
  color: #c084fc;
  background: rgba(192, 132, 252, 0.1);
  border: 1px solid rgba(192, 132, 252, 0.3);
}

.action-btn-give:hover {
  background: rgba(192, 132, 252, 0.2);
}

@keyframes pulse-ring {
  0% {
    transform: scale(0.8);
    opacity: 0.8;
  }
  100% {
    transform: scale(1.3);
    opacity: 0;
  }
}

.loading-indicator {
  position: relative;
}

.loading-indicator::before {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: currentColor;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.realm-bar {
  transition: width 0.5s ease-out;
}

.status-badge-admin {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.status-badge-banned {
  background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.status-badge-dead {
  background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.status-badge-normal {
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.action-log-entry {
  transition: background-color 0.15s ease;
}

.action-log-entry:hover {
  background-color: rgba(55, 65, 81, 0.4);
}

.action-type-time-travel {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  color: white;
}

.action-type-ban {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: white;
}

.action-type-unban {
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  color: white;
}

.action-type-modify {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
}

.action-type-give {
  background: linear-gradient(135deg, #a855f7 0%, #9333ea 100%);
  color: white;
}

.action-type-config {
  background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
  color: white;
}

.tooltip {
  position: relative;
}

.tooltip::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 8px;
  background: #1f2937;
  border: 1px solid #374151;
  border-radius: 4px;
  font-size: 12px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: all 0.2s ease;
}

.tooltip:hover::after {
  opacity: 1;
  visibility: visible;
  bottom: calc(100% + 4px);
}

@keyframes slide-up {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-slide-up {
  animation: slide-up 0.3s ease-out;
}

@keyframes fade-in-scale {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.animate-fade-in-scale {
  animation: fade-in-scale 0.2s ease-out;
}

.lifespan-warning {
  color: #fbbf24;
  text-shadow: 0 0 10px rgba(251, 191, 36, 0.3);
}

.lifespan-danger {
  color: #ef4444;
  text-shadow: 0 0 10px rgba(239, 68, 68, 0.3);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

.pagination-btn {
  transition: all 0.15s ease;
}

.pagination-btn:hover:not(:disabled) {
  background-color: #4b5563;
  transform: translateY(-1px);
}

.pagination-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.search-input {
  transition: all 0.2s ease;
}

.search-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.config-section {
  background: linear-gradient(145deg, #1f2937 0%, #111827 100%);
  border: 1px solid #374151;
  border-radius: 8px;
  transition: all 0.3s ease;
}

.config-section:hover {
  border-color: #4b5563;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
}

.config-label {
  color: #9ca3af;
  font-size: 14px;
  font-weight: 500;
}

.config-input {
  background: #030712;
  border: 1px solid #374151;
  color: #f3f4f6;
  transition: all 0.2s ease;
}

.config-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.save-btn {
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  transition: all 0.2s ease;
}

.save-btn:hover {
  background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(34, 197, 94, 0.3);
}
</style>
