<template>
  <!-- 全屏布局：占满整个视口，为各管理面板提供最大显示空间 -->
  <div class="fixed inset-0 z-system bg-surface-base flex flex-col">
    <div class="bg-surface-base w-full h-full flex flex-col">
      <!-- Header -->
      <div class="flex items-center justify-between px-4 h-12 shrink-0 border-b border-line-subtle bg-surface-raised">
        <h2 class="font-display text-[15px] font-bold text-gold-500 tracking-[0.08em] truncate">GM 管理后台</h2>
        <button
          type="button"
          @click="$emit('close')"
          class="focus-ring grid place-items-center w-7 h-7 -mr-1 rounded text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors"
          aria-label="关闭管理后台"
          title="关闭"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
        </button>
      </div>

      <!-- Body：左侧竖向分类菜单 + 右侧内容区，全屏下最大化内容空间 -->
      <div class="flex-1 min-h-0 flex">
        <!-- 左侧菜单栏：按功能域分组，支持折叠/展开，便于后续持续新增管理页 -->
        <aside class="w-52 shrink-0 border-r border-line-subtle bg-surface-raised/40 overflow-y-auto scroll-thin py-2">
          <nav v-for="group in tabGroups" :key="group.id" class="mb-1">
            <!-- 分组标题：点击切换折叠状态，箭头旋转指示 -->
            <button
              type="button"
              @click="toggleGroup(group.id)"
              class="focus-ring w-full flex items-center justify-between px-4 py-2 text-xs font-bold text-fg-faint uppercase tracking-wider hover:text-fg-secondary hover:bg-surface-hover/40 transition-colors cursor-pointer"
            >
              <span>{{ group.name }}</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="transition-transform duration-200"
                :class="expandedGroups[group.id] ? 'rotate-180' : ''"
              ><path d="m6 9 6 6 6-6"></path></svg>
            </button>
            <!-- 分组内的菜单项：仅当前项高亮，点击切换内容区 -->
            <div v-show="expandedGroups[group.id]">
              <button
                v-for="tab in group.tabs"
                :key="tab.id"
                type="button"
                @click="currentTab = tab.id"
                class="focus-ring w-full text-left pl-8 pr-4 py-2 text-sm transition-colors relative cursor-pointer whitespace-nowrap"
                :class="currentTab === tab.id
                  ? 'text-gold-500 bg-gold-500/10 font-medium'
                  : 'text-fg-muted hover:text-fg-primary hover:bg-surface-hover/50'"
              >
                <!-- 左侧高亮竖条：标记当前激活项 -->
                <div v-if="currentTab === tab.id" class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-gold-500"></div>
                {{ tab.name }}
              </button>
            </div>
          </nav>
        </aside>

        <!-- 右侧内容区 -->
        <div class="flex-1 min-w-0 overflow-auto p-4 scroll-thin">
        <!-- 玩家管理 -->
        <PlayerManagement
          v-if="currentTab === 'players'"
          ref="playerManagementRef"
          @editPlayer="editPlayer"
          @banPlayer="showBanModal"
          @unbanPlayer="unbanPlayer"
          @givePlayer="showGiveModal"
          @editAssets="openPlayerEditor"
        />

        <!-- 玩家档案编辑器（属性/背包/装备/功法全量编辑） -->
        <PlayerEditor
          v-if="currentTab === 'player_editor'"
          ref="playerEditorRef"
          :player-id="editorPlayerId"
          @showConfirm="showConfirm"
        />

        <!-- 系统配置 -->
        <SystemConfig
          v-if="currentTab === 'config'"
          @timeTravelComplete="handleTimeTravelComplete"
          @showConfirm="showConfirm"
        />

        <!-- 修炼配置（闭关 + 历练，热加载） -->
        <CultivationConfig v-if="currentTab === 'cultivation'" />

        <!-- AI 配置管理 -->
        <AIConfig v-if="currentTab === 'ai_config'" />

        <!-- 宗门管理 -->
        <SectManagement v-if="currentTab === 'sect'" @showConfirm="showConfirm" />

        <!-- 洞府管理 -->
        <CaveManagement v-if="currentTab === 'cave'" />

        <!-- 装备管理（法宝深度系统：祭炼/本命/修理） -->
        <EquipmentManagement v-if="currentTab === 'equipment'" />

        <!-- 悟道与瓶颈管理（第三阶段新增：静思悟道系统 + 瓶颈状态管理） -->
        <MeditationManagement v-if="currentTab === 'meditation'" />

        <!-- PVP 斗法管理（第四阶段新增：玩家段位、积分调整、战斗记录、强制取消） -->
        <PvpManagement v-if="currentTab === 'pvp'" />

        <!-- 聚宝当铺管理（第四阶段新增：当票查询、强制赎回、取消当票、信用调整） -->
        <PawnshopManagement v-if="currentTab === 'pawnshop'" />

        <!-- 聚宝股市管理（第四阶段新增：股票管理、调价/暂停/恢复、触发事件、交易流水、融资管理、强制平仓、手动分红） -->
        <StockManagement v-if="currentTab === 'stock'" />

        <!-- 通知管理 -->
        <NotificationManagement
          v-if="currentTab === 'notifications'"
          ref="notificationManagementRef"
          @showConfirm="showConfirm"
        />

        <!-- 服务器统计 -->
        <ServerStats v-if="currentTab === 'stats'" ref="serverStatsRef" />

        <!-- 操作日志 -->
        <OperationLogs v-if="currentTab === 'logs'" ref="operationLogsRef" />

        <!-- 状态清理监控 -->
        <StateCleanerMonitor v-if="currentTab === 'state_cleaner'" />

        <!-- 状态转移日志 -->
        <StateLogViewer v-if="currentTab === 'state_logs'" />

        <!-- 后台日志（服务器控制台输出，支持实时跟随） -->
        <SystemLogViewer v-if="currentTab === 'system_logs'" />

        <!-- 世界BOSS管理（批次2新增：BOSS刷新/过期/赛季管理） -->
        <WorldBossManagement v-if="currentTab === 'world_boss'" @showConfirm="showConfirm" />

        <!-- 宗门战管理（批次2新增：赛季管理/资源点初始化/战役推进） -->
        <SectWarManagement v-if="currentTab === 'sect_war'" @showConfirm="showConfirm" />

        <!-- 飞升+夺舍重生系统管理（批次3新增：统计/玩家进度/大衍诀调整/法则碎片/坐标/重置冷却/夺舍目标CRUD） -->
        <AscensionManagement v-if="currentTab === 'ascension'" @showConfirm="showConfirm" />
        <LateStageManagement v-if="currentTab === 'late_stage'" @showConfirm="showConfirm" />
        <CompanionConcubineManagement v-if="currentTab === 'companion_concubine'" @showConfirm="showConfirm" />
        <MultiDungeonManagement v-if="currentTab === 'multi_dungeon'" @showConfirm="showConfirm" />
        <!-- 灵兽系统管理（批次2新增：统计/查询/发放/编辑/删除/强制出战/重置冷却） -->
        <SpiritBeastManagement v-if="currentTab === 'spirit_beast'" @showConfirm="showConfirm" />
        </div>
      </div>
    </div>

    <!-- 编辑玩家弹窗 -->
    <Modal :isOpen="!!editingPlayer" title="编辑玩家" width="640px" @close="editingPlayer = null">
      <div v-if="editingPlayer" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm text-fg-muted mb-1">账号</label>
            <input :value="editingPlayer.username" disabled class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-faint">
          </div>
          <div>
            <label class="block text-sm text-fg-muted mb-1">昵称</label>
            <input v-model="editingPlayer.nickname" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-sm text-fg-muted mb-1">修为 (Exp)</label>
            <input v-model.number="editingPlayer.exp" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-sm text-fg-muted mb-1">灵石</label>
            <input v-model.number="editingPlayer.spirit_stones" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-sm text-fg-muted mb-1">境界</label>
            <SearchableSelect
              v-model="editingPlayer.realm"
              :options="realmOptions"
              :loading="realmLoading"
              title="选择境界"
              placeholder="选择境界"
              search-placeholder="搜索境界名，如：化神初期"
              :allow-empty="false"
              :clearable="false"
            />
          </div>
          <div>
            <label class="block text-sm text-fg-muted mb-1">当前寿元</label>
            <input v-model.number="editingPlayer.lifespan_current" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-sm text-fg-muted mb-1">最大寿元</label>
            <input v-model.number="editingPlayer.lifespan_max" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
          </div>
          <div>
            <label class="block text-sm text-fg-muted mb-1">角色权限</label>
            <select v-model="editingPlayer.role" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="editingPlayer = null">取消</AppButton>
        <AppButton variant="primary" @click="submitPlayerEdit">保存</AppButton>
      </template>
    </Modal>

    <!-- 封禁玩家弹窗 -->
    <Modal :isOpen="!!banningPlayer" title="封禁玩家" @close="banningPlayer = null">
      <div v-if="banningPlayer" class="space-y-4">
        <p class="text-fg-secondary">封禁玩家: <span class="text-gold-500">{{ banningPlayer.nickname }}</span></p>
        <div>
          <label class="block text-sm text-fg-muted mb-1">封禁原因</label>
          <input v-model="banReason" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600" placeholder="输入封禁原因">
        </div>
        <div>
          <label class="block text-sm text-fg-muted mb-1">封禁天数 (-1表示永久)</label>
          <input v-model.number="banDays" type="number" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="banningPlayer = null">取消</AppButton>
        <AppButton variant="danger" @click="confirmBan">确认封禁</AppButton>
      </template>
    </Modal>

    <!-- 发放物品弹窗 -->
    <Modal :isOpen="!!givingPlayer" title="发放物品" width="520px" @close="givingPlayer = null">
      <div v-if="givingPlayer" class="space-y-4">
        <p class="text-fg-secondary">发放给: <span class="text-gold-500">{{ givingPlayer.nickname }}</span></p>

        <div>
          <label class="block text-sm text-fg-muted mb-1">发放类型</label>
          <select v-model="giveType" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
            <option value="item">物品</option>
            <option value="spirit_stones">灵石</option>
            <option value="exp">修为</option>
          </select>
        </div>

        <div v-if="giveType === 'item'">
          <label class="block text-sm text-fg-muted mb-1">物品</label>
          <SearchableSelect
            v-model="giveItemId"
            :options="itemOptions"
            :loading="itemLoading"
            title="选择物品"
            placeholder="选择物品"
            search-placeholder="搜索物品名 / ID / 类型…"
            :allow-empty="false"
            :clearable="false"
            :list-height="320"
          />
          <p class="mt-1 text-xs text-fg-faint">支持按名称、ID、类型检索；也可切换「平铺」浏览全部</p>
        </div>

        <div v-if="giveType === 'item'">
          <label class="block text-sm text-fg-muted mb-1">数量</label>
          <input v-model.number="giveQuantity" type="number" min="1" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
        </div>

        <div v-if="giveType === 'spirit_stones'">
          <label class="block text-sm text-fg-muted mb-1">灵石数量</label>
          <input v-model.number="giveAmount" type="number" min="1" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
        </div>

        <div v-if="giveType === 'exp'">
          <label class="block text-sm text-fg-muted mb-1">修为数量</label>
          <input v-model.number="giveAmount" type="number" min="1" class="w-full bg-surface-sunken border border-line rounded-control px-2 py-1 text-fg-secondary focus-ring focus:border-gold-600">
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="givingPlayer = null">取消</AppButton>
        <AppButton variant="primary" @click="confirmGive">确认发放</AppButton>
      </template>
    </Modal>

    <!-- 确认对话框 -->
    <Modal :isOpen="confirmDialog.show" title="确认操作" @close="confirmDialog.show = false" width="400px">
      <p class="text-fg-secondary whitespace-pre-line">{{ confirmDialog.message }}</p>
      <template #footer>
        <AppButton variant="default" @click="confirmDialog.show = false">
          取消
        </AppButton>
        <AppButton variant="danger" @click="handleConfirm">
          确认
        </AppButton>
      </template>
    </Modal>

    <!-- Death Modal -->
    <Modal :isOpen="showDeathModal" title="⚠️ 噩耗" :showClose="true" @close="showDeathModal = false">
      <div class="space-y-6 text-center py-4">
        <div class="text-6xl">🪦</div>
        <h3 class="text-2xl font-bold text-red-500">寿元已尽</h3>
        <p class="text-fg-secondary text-lg">{{ deathMessage }}</p>
        <p class="text-fg-muted">你的境界已跌落，请重新来过。</p>
      </div>
      <template #footer>
        <AppButton variant="default" block @click="showDeathModal = false">
          黯然接受
        </AppButton>
      </template>
    </Modal>
  </div>
</template>

<script setup>
/**
 * GM 管理后台主组件
 * 负责 Tab 导航和弹窗管理，具体功能委托给子组件
 */
import { ref, reactive, watch, onMounted } from 'vue'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { UI_CONFIG } from '../../config'
import Modal from '../common/Modal.vue'
import AppButton from '../ui/AppButton.vue'
import SearchableSelect from '../ui/SearchableSelect.vue'
import { useRealmOptions, useItemOptions } from '../../composables/useContentOptions'
import PlayerManagement from './sub/PlayerManagement.vue'
// 玩家档案编辑器：属性 / 背包 / 装备 / 功法全量编辑（可编辑字段由后端配置下发）
import PlayerEditor from './sub/PlayerEditor.vue'
import SystemConfig from './sub/SystemConfig.vue'
import NotificationManagement from './sub/NotificationManagement.vue'
import ServerStats from './sub/ServerStats.vue'
import OperationLogs from './sub/OperationLogs.vue'
import AIConfig from './sub/AIConfig.vue'
import SectManagement from './sub/SectManagement.vue'
// 洞府管理（GM 后台）：玩家洞府列表查询、设施等级调整、洞府重置、药园地块数调整
import CaveManagement from './sub/CaveManagement.vue'
import EquipmentManagement from './sub/EquipmentManagement.vue'
// 悟道与瓶颈管理（第三阶段新增）：玩家悟道状态查询、强制结算/中断、瓶颈修改
import MeditationManagement from './sub/MeditationManagement.vue'
// PVP 斗法管理（第四阶段新增）：玩家段位、积分调整、战斗记录、强制取消
import PvpManagement from './sub/PvpManagement.vue'
// 聚宝当铺管理（第四阶段新增：当票查询、强制赎回、取消当票、信用调整）
import PawnshopManagement from './sub/PawnshopManagement.vue'
// 聚宝股市管理（第四阶段新增：股票管理、调价/暂停/恢复、触发事件、交易流水、融资管理、强制平仓、手动分红）
import StockManagement from './sub/StockManagement.vue'
// 修炼配置（闭关 + 历练）子组件：提供 GM 后台对参数的可视化编辑与热加载
import CultivationConfig from './sub/CultivationConfig.vue'
// 状态清理监控面板：可视化展示 StateCleanerService 的运行指标
import StateCleanerMonitor from './sub/StateCleanerMonitor.vue'
// 状态转移日志查看器：展示 player_state_log 表数据
import StateLogViewer from './sub/StateLogViewer.vue'
// 后台日志（服务器控制台输出）：读取 PM2 落盘的日志文件，支持实时跟随与级别/关键词过滤
import SystemLogViewer from './sub/SystemLogViewer.vue'
// 世界BOSS管理（批次2新增）：GM 后台 BOSS刷新/过期、赛季创建/结算、统计指标查看
import WorldBossManagement from './sub/WorldBossManagement.vue'
// 宗门战/领地争夺管理（批次2新增）：GM 后台 赛季管理、资源点初始化、战役推进、产出结算
import SectWarManagement from './sub/SectWarManagement.vue'
// 飞升+夺舍重生系统管理（批次3新增）：GM 后台 统计/玩家进度/大衍诀调整/法则碎片/坐标/重置冷却/夺舍目标CRUD
import AscensionManagement from './sub/AscensionManagement.vue'
import LateStageManagement from './sub/LateStageManagement.vue'
// 道侣/双修/侍妾系统管理（批次3新增：强制解除道侣、心契调整、触发心劫、发放侍妾、属性调整、完成远航）
import CompanionConcubineManagement from './sub/CompanionConcubineManagement.vue'
// 多人副本系统管理（批次3新增：强制解散副本、调整副本变量、发放副本奖励、重置玩家冷却）
import MultiDungeonManagement from './sub/MultiDungeonManagement.vue'
// 灵兽系统管理（批次2新增：统计/查询/发放/编辑/删除/强制出战/重置冷却）
import SpiritBeastManagement from './sub/SpiritBeastManagement.vue'
import {
  updatePlayer,
  banPlayer,
  unbanPlayerApi,
  giveItem,
  giveSpiritStones,
  giveExp
} from '../../api/admin'

const emit = defineEmits(['close'])
const playerStore = usePlayerStore()
const uiStore = useUIStore()

// Tab 分组配置：左侧竖向菜单按功能域分类展示
// 新增管理页时只需在对应分组的 tabs 里追加一项，菜单自动支持折叠，无需改动布局逻辑
const tabGroups = [
  // 玩家运营：玩家档案、公告推送等直接面向单玩家的操作
  { id: 'player', name: '玩家运营', tabs: [
    { id: 'players', name: '玩家数据' },
    { id: 'player_editor', name: '玩家档案' },
    { id: 'notifications', name: '通知管理' }
  ]},
  // 系统配置：全局参数、修炼数值、AI 接入等平台级设置
  { id: 'system', name: '系统配置', tabs: [
    { id: 'config', name: '系统配置' },
    { id: 'cultivation', name: '修炼配置' },
    { id: 'ai_config', name: 'AI 配置' }
  ]},
  // 玩法管理：宗门/洞府/装备/PVP/当铺/股市等核心玩法后台
  { id: 'gameplay', name: '玩法管理', tabs: [
    { id: 'sect', name: '宗门管理' },
    { id: 'cave', name: '洞府管理' },
    { id: 'equipment', name: '装备管理' },
    { id: 'meditation', name: '悟道瓶颈' },
    { id: 'pvp', name: 'PVP斗法' },
    { id: 'pawnshop', name: '当铺管理' },
    { id: 'stock', name: '股市管理' }
  ]},
  // 世界活动：世界BOSS/宗门战/多人副本/灵兽等跨玩家大型玩法
  { id: 'world', name: '世界活动', tabs: [
    { id: 'world_boss', name: '世界BOSS' },
    { id: 'sect_war', name: '宗门战' },
    { id: 'multi_dungeon', name: '多人副本' },
    { id: 'spirit_beast', name: '灵兽系统' }
  ]},
  // 进阶系统：飞升/后期系统/道侣侍妾等高境界内容
  { id: 'advanced', name: '进阶系统', tabs: [
    { id: 'ascension', name: '飞升系统' },
    { id: 'late_stage', name: '后期系统' },
    { id: 'companion_concubine', name: '道侣侍妾' }
  ]},
  // 运维监控：服务器统计、日志与状态数据排查
  { id: 'ops', name: '运维监控', tabs: [
    { id: 'system_logs', name: '后台日志' },
    { id: 'stats', name: '服务器统计' },
    { id: 'logs', name: '操作日志' },
    { id: 'state_cleaner', name: '状态清理' },
    { id: 'state_logs', name: '状态日志' }
  ]}
]
// 默认停留在第一个分组的第一项（有本地存档时会被覆盖）
const defaultTab = tabGroups[0].tabs[0].id
// 默认仅展开默认 Tab 所在分组，其余收起以保持菜单简洁
const defaultGroup = tabGroups.find(g => g.tabs.some(t => t.id === defaultTab))

/**
 * 读取本地存档：分组折叠状态 + 上次停留的 Tab
 * 只接受当前菜单中仍存在的分组/页签，避免菜单增删后旧存档把界面带到不存在的页
 * @returns {{expanded: Record<string, boolean>, currentTab: string}}
 */
const loadMenuState = () => {
  const state = {
    expanded: Object.fromEntries(tabGroups.map(g => [g.id, g.id === defaultGroup?.id])),
    currentTab: defaultTab
  }
  try {
    const saved = JSON.parse(localStorage.getItem(UI_CONFIG.adminMenuStateKey) || 'null')
    if (!saved || typeof saved !== 'object') return state
    for (const g of tabGroups) {
      if (typeof saved.expanded?.[g.id] === 'boolean') state.expanded[g.id] = saved.expanded[g.id]
    }
    // 仅当存档中的 Tab 仍在菜单里才还原，配置重构后不会停在空白页
    if (tabGroups.flatMap(g => g.tabs).some(t => t.id === saved.currentTab)) {
      state.currentTab = saved.currentTab
    }
  } catch (e) {
    console.warn('[AdminPanel] 菜单状态读取失败，回退默认:', e)
  }
  return state
}

const menuState = loadMenuState()
const currentTab = ref(menuState.currentTab)
const expandedGroups = reactive(menuState.expanded)

/**
 * 持久化菜单状态：折叠状态或当前 Tab 变更后写回本地存储，刷新页面自动还原
 * localStorage 在隐私模式/超额时会抛错，这里静默降级不影响菜单使用
 */
const persistMenuState = () => {
  try {
    localStorage.setItem(UI_CONFIG.adminMenuStateKey, JSON.stringify({
      expanded: expandedGroups,
      currentTab: currentTab.value
    }))
  } catch (e) {
    console.warn('[AdminPanel] 菜单状态持久化失败:', e)
  }
}

watch([expandedGroups, currentTab], persistMenuState, { deep: true })

/**
 * 切换分组折叠/展开状态
 * @param {string} groupId 分组 ID
 */
const toggleGroup = (groupId) => {
  expandedGroups[groupId] = !expandedGroups[groupId]
}

// 子组件引用
const playerManagementRef = ref(null)
// 玩家档案编辑器：从列表点「档案」进入时带上的玩家 ID
const editorPlayerId = ref(null)
const playerEditorRef = ref(null)
const notificationManagementRef = ref(null)
const serverStatsRef = ref(null)
const operationLogsRef = ref(null)

// 自定义确认对话框
const confirmDialog = reactive({
  show: false,
  title: '',
  message: '',
  onConfirm: null
})

/**
 * 显示确认对话框
 */
const showConfirm = (title, message, onConfirm) => {
  confirmDialog.title = title
  confirmDialog.message = message
  confirmDialog.onConfirm = onConfirm
  confirmDialog.show = true
}

/**
 * 处理确认操作
 */
const handleConfirm = () => {
  if (confirmDialog.onConfirm) {
    confirmDialog.onConfirm()
  }
  confirmDialog.show = false
}

// 游戏内容选项：境界 / 物品一律从内容层拉取，禁止手输主键
const { options: realmOptions, loading: realmLoading, load: loadRealms } = useRealmOptions()
const { options: itemOptions, loading: itemLoading, load: loadItems } = useItemOptions()

onMounted(() => {
  loadRealms().catch(err => uiStore.showToast('境界清单加载失败: ' + (err?.message || err), 'error'))
  loadItems().catch(err => uiStore.showToast('物品清单加载失败: ' + (err?.message || err), 'error'))
})

// 编辑玩家
const editingPlayer = ref(null)

/**
 * 编辑玩家
 */
const editPlayer = (player) => {
  // 深拷贝防止直接修改显示
  editingPlayer.value = JSON.parse(JSON.stringify(player))
}

/**
 * 提交玩家编辑
 */
const submitPlayerEdit = async () => {
  if (!editingPlayer.value) return
  try {
    await updatePlayer(editingPlayer.value.id, editingPlayer.value)
    uiStore.showToast('玩家信息更新成功', 'success')
    editingPlayer.value = null
    playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
  } catch (error) {
    uiStore.showToast('更新失败: ' + (error.response?.data?.message || error.message), 'error')
  }
}

/**
 * 打开玩家档案编辑器（列表行「档案」按钮）
 * 只切 Tab 并传 ID：编辑器挂载后会按 ID 拉档案，避免在这里重复请求
 */
const openPlayerEditor = (player) => {
  editorPlayerId.value = player?.id ?? null
  currentTab.value = 'player_editor'
}

// 封禁功能相关
const banningPlayer = ref(null)
const banReason = ref('')
const banDays = ref(-1)

/**
 * 显示封禁弹窗
 */
const showBanModal = (player) => {
  banningPlayer.value = player
  banReason.value = ''
  banDays.value = -1
}

/**
 * 确认封禁
 */
const confirmBan = async () => {
  if (!banningPlayer.value) return
  try {
    await banPlayer(banningPlayer.value.id, banReason.value, banDays.value)
    uiStore.showToast('封禁成功', 'success')
    banningPlayer.value = null
    playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
  } catch (error) {
    uiStore.showToast('封禁失败: ' + (error.response?.data?.message || error.message), 'error')
  }
}

/**
 * 解封玩家
 */
const unbanPlayer = (player) => {
  showConfirm('解封玩家', `确定要解封玩家 ${player.nickname} 吗？`, async () => {
    try {
      await unbanPlayerApi(player.id)
      uiStore.showToast('解封成功', 'success')
      playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
    } catch (error) {
      uiStore.showToast('解封失败: ' + (error.response?.data?.message || error.message), 'error')
    }
  })
}

// 发放功能相关
const givingPlayer = ref(null)
const giveType = ref('item')
const giveItemId = ref('')
const giveQuantity = ref(1)
const giveAmount = ref(0)

/**
 * 显示发放弹窗
 */
const showGiveModal = (player) => {
  givingPlayer.value = player
  giveType.value = 'item'
  giveItemId.value = ''
  giveQuantity.value = 1
  giveAmount.value = 0
}

/**
 * 确认发放
 */
const confirmGive = async () => {
  if (!givingPlayer.value) return
  try {
    if (giveType.value === 'item') {
      if (!giveItemId.value) {
        uiStore.showToast('请选择要发放的物品', 'warning')
        return
      }
      await giveItem(givingPlayer.value.id, giveItemId.value, giveQuantity.value)
      uiStore.showToast('物品发放成功', 'success')
    } else if (giveType.value === 'spirit_stones') {
      await giveSpiritStones(givingPlayer.value.id, giveAmount.value)
      uiStore.showToast('灵石发放成功', 'success')
    } else if (giveType.value === 'exp') {
      await giveExp(givingPlayer.value.id, giveAmount.value)
      uiStore.showToast('修为发放成功', 'success')
    }
    givingPlayer.value = null
    playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
  } catch (error) {
    uiStore.showToast('发放失败: ' + (error.response?.data?.message || error.message), 'error')
  }
}

// 死亡弹窗
const showDeathModal = ref(false)
const deathMessage = ref('')

/**
 * 处理时间加速完成
 */
const handleTimeTravelComplete = async (result) => {
  // 刷新玩家数据
  try {
    await playerStore.scheduleFetchPlayer(0)
  } catch (e) {
    console.warn('Refresh player failed:', e)
  }

  // 刷新管理员面板的玩家列表（如果当前在看列表）
  if (currentTab.value === 'players') {
    playerManagementRef.value?.fetchPlayers(playerManagementRef.value.pagination.currentPage)
  }

  // 检查死亡通知
  if (result.died) {
    deathMessage.value = result.message || '寿元耗尽，身死道消。'
    showDeathModal.value = true
  }
}
</script>
