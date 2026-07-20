/**
 * 副本进行中视图子组件
 *
 * 作为 DungeonPanel.vue 的子组件，负责渲染副本进行中的所有内容：
 *   1. 顶部进度信息栏：章节名 / 难度 / 剩余时间 / 节点进度
 *   2. 玩家状态条：HP / MP / 修为 / 灵石（关卡间持续，不复位）
 *   3. 节点内容区：根据节点类型（story/battle/puzzle/boss/reward）渲染不同 UI
 *   4. 战斗结果区：胜利/失败 + 战斗日志（battleResult 有值时展示）
 *   5. 副本结算区：星级 / 奖励 / 用时（settlement 有值时遮盖其他内容）
 *
 * 设计原则：
 *   - 纯展示组件，不直接调用 API，所有操作通过 emit 事件向外抛
 *   - 所有数据从 props 传入，禁止硬编码任何业务数值
 *   - 使用 Tailwind CSS 风格统一（深色修仙主题）
 *   - 不使用浏览器原生弹窗
 */
<template>
  <div class="space-y-3">
    <!-- ============ 1. 副本结算遮盖层（settlement 有值时优先展示） ============ -->
    <div v-if="settlement" class="bg-[#292524] border-2 rounded-lg p-5 space-y-4"
      :class="settlement.is_success ? 'border-amber-600' : 'border-rose-800'">
      <div class="text-center">
        <div class="text-2xl font-bold tracking-widest mb-1"
          :class="settlement.is_success ? 'text-amber-300' : 'text-rose-400'">
          {{ getSettleTitle() }}
        </div>
        <div class="text-xs text-stone-500">{{ getSettleReasonText() }}</div>
      </div>

      <!-- 星级展示 -->
      <div v-if="settlement.is_success" class="flex items-center justify-center gap-2 py-2">
        <svg v-for="i in 3" :key="i" xmlns="http://www.w3.org/2000/svg"
          width="36" height="36" viewBox="0 0 24 24"
          :fill="i <= settlement.stars ? '#fbbf24' : 'none'"
          :stroke="i <= settlement.stars ? '#fbbf24' : '#44403c'"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </div>

      <!-- 通关用时 -->
      <div class="text-center text-xs text-stone-400">
        用时：<span class="text-amber-300 font-bold">{{ formatTime(settlement.completion_time_sec) }}</span>
        <span v-if="settlement.record_updated" class="ml-2 text-emerald-400">· 更新了通关记录</span>
      </div>

      <!-- 奖励列表 -->
      <div class="bg-stone-900/50 border border-stone-700 rounded-lg p-3 space-y-2">
        <div class="text-xs text-stone-500 mb-1">本次奖励</div>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div class="flex items-center gap-2">
            <span class="text-stone-500">修为：</span>
            <span class="text-cyan-300 font-bold">+{{ formatNumber(settlement.rewards.exp) }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-stone-500">灵石：</span>
            <span class="text-amber-300 font-bold">+{{ formatNumber(settlement.rewards.spirit_stones) }}</span>
          </div>
        </div>
        <div v-if="settlement.rewards.items && settlement.rewards.items.length > 0" class="pt-2 border-t border-stone-800">
          <div class="text-xs text-stone-500 mb-1">物品</div>
          <div class="flex flex-wrap gap-2">
            <span v-for="(item, idx) in settlement.rewards.items" :key="idx"
              class="text-[11px] px-2 py-0.5 rounded bg-stone-800 border border-stone-700 text-stone-300">
              {{ item.item_key }} ×{{ item.quantity }}
            </span>
          </div>
        </div>
      </div>

      <!-- 退出按钮 -->
      <button @click="$emit('exit')"
        class="w-full py-2 rounded-lg text-sm font-bold tracking-wider bg-stone-900/40 border border-stone-700 text-stone-300 hover:bg-stone-800/40 hover:border-stone-500 transition-all">
        返回章节列表
      </button>
    </div>

    <!-- ============ 2. 副本进行中主体（无 settlement 时展示） ============ -->
    <template v-else>
      <!-- 顶部进度信息栏 -->
      <div v-if="progress" class="bg-[#292524] border border-stone-700 rounded-lg p-3">
        <div class="flex items-center justify-between mb-2">
          <div class="text-sm font-bold text-amber-300">{{ progress.chapter_name }}</div>
          <div class="text-[10px] px-2 py-0.5 rounded"
            :class="getDifficultyBadgeClass(progress.difficulty)">
            {{ getDifficultyLabel(progress.difficulty) }}
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2 text-[11px]">
          <div>
            <div class="text-stone-500">剩余时间</div>
            <div class="font-bold"
              :class="progress.remaining_seconds < 300 ? 'text-rose-400' : 'text-stone-300'">
              {{ formatTime(progress.remaining_seconds) }}
            </div>
          </div>
          <div>
            <div class="text-stone-500">关卡进度</div>
            <div class="text-stone-300 font-bold">
              {{ progress.nodes_completed_count }} / {{ nodesTotal }}
            </div>
          </div>
          <div>
            <div class="text-stone-500">当前关</div>
            <div class="text-cyan-300 font-bold truncate">{{ currentNode?.title || '—' }}</div>
          </div>
        </div>
      </div>

      <!-- 玩家状态条 -->
      <div v-if="progress" class="bg-[#292524] border border-stone-700 rounded-lg p-3 space-y-2">
        <div class="text-[10px] text-stone-500 mb-1">道友状态</div>
        <!-- HP -->
        <div>
          <div class="flex items-center justify-between text-[11px] mb-0.5">
            <span class="text-stone-400">气血</span>
            <span class="text-rose-300 font-bold">{{ formatNumber(progress.hp_remaining) }}</span>
          </div>
          <div class="h-1.5 bg-stone-900 rounded overflow-hidden">
            <div class="h-full bg-gradient-to-r from-rose-700 to-rose-500 transition-all"
              :style="{ width: hpRatio + '%' }"></div>
          </div>
        </div>
        <!-- MP -->
        <div>
          <div class="flex items-center justify-between text-[11px] mb-0.5">
            <span class="text-stone-400">灵力</span>
            <span class="text-cyan-300 font-bold">{{ formatNumber(progress.mp_remaining) }}</span>
          </div>
          <div class="h-1.5 bg-stone-900 rounded overflow-hidden">
            <div class="h-full bg-gradient-to-r from-cyan-700 to-cyan-500 transition-all"
              :style="{ width: mpRatio + '%' }"></div>
          </div>
        </div>
        <!-- 修为与灵石 -->
        <div class="grid grid-cols-2 gap-2 pt-1 text-[11px]">
          <div class="flex items-center gap-1">
            <span class="text-stone-500">已获修为：</span>
            <span class="text-emerald-300 font-bold">+{{ formatNumber(progress.exp_accumulated) }}</span>
          </div>
          <div class="flex items-center gap-1">
            <span class="text-stone-500">已获灵石：</span>
            <span class="text-amber-300 font-bold">+{{ formatNumber(progress.spirit_stones_accumulated) }}</span>
          </div>
        </div>
        <!-- 已收集物品 -->
        <div v-if="progress.items_collected && progress.items_collected.length > 0" class="pt-1">
          <div class="text-[10px] text-stone-500 mb-1">已收集物品</div>
          <div class="flex flex-wrap gap-1">
            <span v-for="(item, idx) in progress.items_collected" :key="idx"
              class="text-[10px] px-1.5 py-0.5 rounded bg-stone-800 border border-stone-700 text-stone-300">
              {{ item.item_key }} ×{{ item.quantity }}
            </span>
          </div>
        </div>
      </div>

      <!-- 战斗结果展示区（battleResult 有值时展示） -->
      <div v-if="battleResult" class="bg-[#292524] border rounded-lg p-3 space-y-2"
        :class="battleResult.battle_result === 'victory' ? 'border-emerald-700/50' : 'border-rose-800/50'">
        <div class="flex items-center justify-between">
          <div class="text-sm font-bold"
            :class="battleResult.battle_result === 'victory' ? 'text-emerald-300' : 'text-rose-400'">
            {{ battleResult.battle_result === 'victory' ? '✦ 战斗胜利 ✦' : '✦ 战斗失利 ✦' }}
          </div>
          <div class="text-[10px] text-stone-500">
            敌方剩余HP：<span class="text-rose-300">{{ formatNumber(battleResult.final_monster_hp) }}</span>
          </div>
        </div>

        <!-- 战斗日志（精简展示前 8 条） -->
        <div v-if="battleResult.battle_log && battleResult.battle_log.length > 0"
          class="bg-stone-900/50 border border-stone-800 rounded p-2 max-h-32 overflow-y-auto text-[10px] space-y-0.5">
          <div v-for="(log, idx) in battleResult.battle_log" :key="idx"
            class="flex items-center gap-2">
            <span class="text-stone-600 shrink-0">R{{ log.round }}</span>
            <span class="shrink-0"
              :class="log.side === 'player' ? 'text-cyan-400' : 'text-rose-400'">
              {{ log.side === 'player' ? '我' : '敌' }}
            </span>
            <span class="text-stone-400">造成</span>
            <span class="font-bold"
              :class="log.side === 'player' ? 'text-cyan-300' : 'text-rose-300'">
              {{ formatNumber(log.damage) }}
            </span>
            <span class="text-stone-400">伤害</span>
            <span v-if="log.player_hp" class="text-stone-500 ml-auto">
              我:{{ formatNumber(log.player_hp) }} / 敌:{{ formatNumber(log.monster_hp) }}
            </span>
          </div>
        </div>

        <!-- 战斗奖励 -->
        <div v-if="battleResult.rewards" class="text-[11px] text-stone-400 flex flex-wrap gap-3">
          <span>修为：<span class="text-emerald-300 font-bold">+{{ formatNumber(battleResult.rewards.exp) }}</span></span>
          <span>灵石：<span class="text-amber-300 font-bold">+{{ formatNumber(battleResult.rewards.spirit_stones) }}</span></span>
          <span v-if="battleResult.rewards.items && battleResult.rewards.items.length > 0">
            物品：
            <span v-for="(item, idx) in battleResult.rewards.items" :key="idx"
              class="text-stone-300 mr-1">{{ item.item_key }} ×{{ item.quantity }}</span>
          </span>
        </div>

        <!-- 胜利/失败文案 -->
        <div v-if="battleResult.battle_result === 'victory' && battleResult.victory_text"
          class="text-xs text-amber-300 italic leading-relaxed border-t border-stone-800 pt-2">
          {{ battleResult.victory_text }}
        </div>
        <div v-if="battleResult.battle_result === 'defeat' && battleResult.defeat_text"
          class="text-xs text-rose-400 italic leading-relaxed border-t border-stone-800 pt-2">
          {{ battleResult.defeat_text }}
        </div>
      </div>

      <!-- ============ 3. 当前节点内容区（按类型渲染） ============ -->
      <div v-if="currentNode" class="bg-[#292524] border border-stone-700 rounded-lg p-4 space-y-3">
        <!-- 节点头部 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-[10px] px-2 py-0.5 rounded font-bold"
              :class="getNodeTypeBadgeClass(currentNode.type)">
              {{ getNodeTypeLabel(currentNode.type) }}
            </span>
            <div class="text-sm font-bold text-amber-300">{{ currentNode.title }}</div>
          </div>
          <div v-if="currentNode.is_final_node" class="text-[10px] text-rose-400 px-2 py-0.5 rounded bg-rose-950/40 border border-rose-900/40">
            终结关卡
          </div>
        </div>

        <!-- story 节点：剧情文本 -->
        <div v-if="currentNode.type === 'story'">
          <div class="text-sm text-stone-300 leading-relaxed whitespace-pre-line">
            {{ currentNode.narrative }}
          </div>
          <div v-if="currentNode.ai_generated" class="text-[10px] text-purple-400 mt-2 italic">
            ✦ 此段剧情由 AI 即兴生成
          </div>
        </div>

        <!-- battle / boss 节点：怪物信息 -->
        <div v-else-if="currentNode.type === 'battle' || currentNode.type === 'boss'">
          <div v-if="currentNode.description" class="text-xs text-stone-400 italic mb-2 leading-relaxed">
            {{ currentNode.description }}
          </div>
          <div v-if="currentNode.monster"
            class="bg-stone-900/50 border border-stone-700 rounded-lg p-3 space-y-2">
            <div class="flex items-center justify-between">
              <div class="text-sm font-bold"
                :class="currentNode.type === 'boss' ? 'text-rose-400' : 'text-orange-300'">
                {{ currentNode.monster.name }}
              </div>
              <div v-if="currentNode.monster.skills && currentNode.monster.skills.length > 0"
                class="text-[10px] text-stone-500">
                技能：{{ currentNode.monster.skills.join(' · ') }}
              </div>
            </div>
            <div v-if="currentNode.monster.description" class="text-[11px] text-stone-500 italic">
              {{ currentNode.monster.description }}
            </div>
            <div class="grid grid-cols-3 gap-2 text-[11px]">
              <div class="bg-stone-950/40 rounded px-2 py-1">
                <div class="text-stone-500">气血</div>
                <div class="text-rose-300 font-bold">{{ formatNumber(currentNode.monster.hp) }}</div>
              </div>
              <div class="bg-stone-950/40 rounded px-2 py-1">
                <div class="text-stone-500">攻击</div>
                <div class="text-orange-300 font-bold">{{ formatNumber(currentNode.monster.attack) }}</div>
              </div>
              <div class="bg-stone-950/40 rounded px-2 py-1">
                <div class="text-stone-500">防御</div>
                <div class="text-cyan-300 font-bold">{{ formatNumber(currentNode.monster.defense) }}</div>
              </div>
            </div>
          </div>
          <!-- 战斗奖励预览 -->
          <div v-if="currentNode.rewards" class="text-[11px] text-stone-500 mt-2">
            胜利奖励：修为+{{ formatNumber(currentNode.rewards.exp) }} · 灵石+{{ formatNumber(currentNode.rewards.spirit_stones) }}
            <span v-if="currentNode.rewards.items && currentNode.rewards.items.length > 0">
              · 物品：<span v-for="(item, idx) in currentNode.rewards.items" :key="idx">{{ item.item_key }}×{{ item.quantity }} </span>
            </span>
          </div>
        </div>

        <!-- puzzle 节点：选项分支 -->
        <div v-else-if="currentNode.type === 'puzzle'">
          <div class="text-sm text-stone-300 leading-relaxed whitespace-pre-line mb-3">
            {{ currentNode.narrative }}
          </div>
          <div class="space-y-2">
            <button v-for="option in (currentNode.options || [])" :key="option.id"
              @click="$emit('choose-option', option.id)"
              :disabled="loading"
              class="w-full text-left p-2.5 rounded-lg border border-stone-700 bg-stone-900/40 hover:bg-stone-800/60 hover:border-amber-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <div class="text-xs text-amber-300 font-bold mb-0.5">{{ option.text }}</div>
              <div v-if="option.hint" class="text-[10px] text-stone-500">{{ option.hint }}</div>
            </button>
          </div>
        </div>

        <!-- reward 节点：奖励展示 -->
        <div v-else-if="currentNode.type === 'reward'">
          <div v-if="currentNode.narrative" class="text-sm text-stone-300 leading-relaxed whitespace-pre-line mb-2">
            {{ currentNode.narrative }}
          </div>
          <div v-if="currentNode.rewards"
            class="bg-amber-950/20 border border-amber-800/50 rounded-lg p-3 space-y-2">
            <div class="text-[10px] text-amber-500">宝物掉落</div>
            <div class="grid grid-cols-2 gap-2 text-xs">
              <div>修为：<span class="text-emerald-300 font-bold">+{{ formatNumber(currentNode.rewards.exp) }}</span></div>
              <div>灵石：<span class="text-amber-300 font-bold">+{{ formatNumber(currentNode.rewards.spirit_stones) }}</span></div>
            </div>
            <div v-if="currentNode.rewards.items && currentNode.rewards.items.length > 0" class="flex flex-wrap gap-1 pt-1">
              <span v-for="(item, idx) in currentNode.rewards.items" :key="idx"
                class="text-[11px] px-2 py-0.5 rounded bg-stone-800 border border-stone-700 text-stone-300">
                {{ item.item_key }} ×{{ item.quantity }}
              </span>
            </div>
          </div>
        </div>

        <!-- ============ 4. 节点操作按钮区 ============ -->
        <div class="pt-2 border-t border-stone-800 flex gap-2">
          <!-- story 节点：继续探索 -->
          <button v-if="currentNode.type === 'story'" @click="$emit('advance')"
            :disabled="loading"
            class="flex-1 py-2 rounded-lg text-xs font-bold tracking-wider bg-amber-950/40 border border-amber-700 text-amber-300 hover:bg-amber-900/40 hover:border-amber-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            <span v-if="loading">推进中...</span>
            <span v-else>继续探索 →</span>
          </button>

          <!-- reward 节点：领取并前进 -->
          <button v-else-if="currentNode.type === 'reward'" @click="$emit('advance')"
            :disabled="loading"
            class="flex-1 py-2 rounded-lg text-xs font-bold tracking-wider bg-amber-950/40 border border-amber-700 text-amber-300 hover:bg-amber-900/40 hover:border-amber-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            <span v-if="loading">领取中...</span>
            <span v-else>领取宝物 →</span>
          </button>

          <!-- battle 节点：开战 -->
          <button v-else-if="currentNode.type === 'battle'" @click="$emit('battle')"
            :disabled="loading"
            class="flex-1 py-2 rounded-lg text-xs font-bold tracking-wider bg-orange-950/40 border border-orange-700 text-orange-300 hover:bg-orange-900/40 hover:border-orange-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            <span v-if="loading">战斗中...</span>
            <span v-else>⚔ 开战</span>
          </button>

          <!-- boss 节点：挑战BOSS -->
          <button v-else-if="currentNode.type === 'boss'" @click="$emit('battle')"
            :disabled="loading"
            class="flex-1 py-2 rounded-lg text-xs font-bold tracking-wider bg-rose-950/40 border border-rose-700 text-rose-300 hover:bg-rose-900/40 hover:border-rose-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            <span v-if="loading">挑战中...</span>
            <span v-else>⚔ 挑战 BOSS</span>
          </button>

          <!-- 中断副本按钮（始终可点击，独立于节点操作） -->
          <button @click="$emit('interrupt')"
            :disabled="loading"
            class="px-3 py-2 rounded-lg text-xs text-stone-400 hover:text-rose-400 border border-stone-700 hover:border-rose-800 transition-colors disabled:opacity-50">
            中断副本
          </button>
        </div>
      </div>

      <!-- 无节点内容兜底 -->
      <div v-else class="bg-[#292524] border border-stone-700 rounded-lg p-6 text-center text-stone-500 text-sm">
        {{ loading ? '正在加载副本内容...' : '暂无节点内容' }}
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * Props 定义
 * - progress: 副本进度信息（来自 GET /dungeon/status 的 in_progress 字段）
 * - currentNode: 当前节点内容（来自 GET /dungeon/current-node）
 * - battleResult: 上一次战斗结果（POST /dungeon/battle 返回）
 * - settlement: 副本结算信息（章节通关或失败时返回，展示后遮盖其他内容）
 * - loading: 父组件加载状态，禁用所有操作按钮
 */
import { computed } from 'vue'
import { formatTime, formatNumber } from '../../utils/format'

const props = defineProps({
  progress: {
    type: Object,
    default: null
  },
  currentNode: {
    type: Object,
    default: null
  },
  battleResult: {
    type: Object,
    default: null
  },
  settlement: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  }
})

defineEmits(['advance', 'battle', 'choose-option', 'interrupt', 'exit'])

/**
 * 节点总数（来自 currentNode 的 is_final_node 推断，或回退到 progress 已完成+1）
 * 这里仅用作展示进度参考，权威值在后端
 */
const nodesTotal = computed(() => {
  // currentNode 是终结节点时，已完成数+1 即为总数
  if (props.currentNode?.is_final_node && props.progress) {
    return props.progress.nodes_completed_count + 1
  }
  // 否则展示为已完成 +1（当前正在挑战的节点）
  return props.progress ? props.progress.nodes_completed_count + 1 : 0
})

/**
 * HP 比例（基于后端权威返回的 hp_max 计算）
 *
 * 修复 B14：原代码硬编码 1000 作为 max HP 估算值，与玩家实际属性差距大，
 * 导致高境界玩家 HP 进度条永远显示满格，低境界玩家永远显示 5% 兜底值。
 * 现已通过后端 DungeonService.getStatus 返回真实 hp_max / mp_max，
 * 前端直接使用即可。兜底：HP>0 时至少展示 5%，避免出现空进度条。
 */
const hpRatio = computed(() => {
  if (!props.progress) return 0
  const hp = Number(props.progress.hp_remaining || 0)
  if (hp <= 0) return 0
  const hpMax = Number(props.progress.hp_max || 0)
  // 后端未返回 max 时兜底为 1000（极端情况，不应发生）
  const safeMax = hpMax > 0 ? hpMax : 1000
  const ratio = Math.min(100, (hp / safeMax) * 100)
  return Math.max(5, ratio)
})

/**
 * MP 比例（同 HP，使用后端返回的 mp_max 计算）
 */
const mpRatio = computed(() => {
  if (!props.progress) return 0
  const mp = Number(props.progress.mp_remaining || 0)
  if (mp <= 0) return 0
  const mpMax = Number(props.progress.mp_max || 0)
  // 后端未返回 max 时兜底为 500（极端情况，不应发生）
  const safeMax = mpMax > 0 ? mpMax : 500
  const ratio = Math.min(100, (mp / safeMax) * 100)
  return Math.max(5, ratio)
})

/**
 * 获取难度中文标签
 */
const getDifficultyLabel = (difficulty) => {
  return { normal: '普通', hard: '困难', nightmare: '噩梦' }[difficulty] || difficulty
}

/**
 * 获取难度徽章样式
 */
const getDifficultyBadgeClass = (difficulty) => {
  return {
    normal: 'bg-emerald-950/40 border border-emerald-700 text-emerald-300',
    hard: 'bg-amber-950/40 border border-amber-700 text-amber-300',
    nightmare: 'bg-rose-950/40 border border-rose-700 text-rose-300'
  }[difficulty] || 'bg-stone-800 text-stone-300'
}

/**
 * 获取节点类型中文标签
 */
const getNodeTypeLabel = (type) => {
  return {
    story: '剧情',
    battle: '战斗',
    puzzle: '解谜',
    boss: 'BOSS',
    reward: '奖励'
  }[type] || type
}

/**
 * 获取节点类型徽章样式
 */
const getNodeTypeBadgeClass = (type) => {
  return {
    story: 'bg-cyan-950/40 border border-cyan-800 text-cyan-300',
    battle: 'bg-orange-950/40 border border-orange-800 text-orange-300',
    puzzle: 'bg-purple-950/40 border border-purple-800 text-purple-300',
    boss: 'bg-rose-950/40 border border-rose-800 text-rose-300',
    reward: 'bg-amber-950/40 border border-amber-700 text-amber-300'
  }[type] || 'bg-stone-800 text-stone-300'
}

/**
 * 获取结算标题
 */
const getSettleTitle = () => {
  if (!props.settlement) return ''
  if (props.settlement.is_success) return '✦ 通关成功 ✦'
  if (props.settlement.is_interrupt) return '已中断副本'
  if (props.settlement.is_expired) return '副本超时'
  return '挑战失败'
}

/**
 * 获取结算原因文案
 */
const getSettleReasonText = () => {
  if (!props.settlement) return ''
  return props.settlement.settle_reason || ''
}
</script>

<style scoped>
/* 滚动条样式 */
.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}
.overflow-y-auto::-webkit-scrollbar-track {
  background: #1c1917;
}
.overflow-y-auto::-webkit-scrollbar-thumb {
  background: #44403c;
  border-radius: 2px;
}
</style>
