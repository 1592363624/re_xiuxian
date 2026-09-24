<script setup>
/**
 * 战斗面板组件
 * 使用统一 API 层进行战斗操作
 *
 * 回合模型：一次出招 = 一个完整回合（玩家出招 + 怪物回击），
 * 后端在 /combat/attack 与 /combat/skill 内结算两侧，回合权回到玩家。
 * monsterTurn 仅用于历史卡死战斗的恢复。
 */
import { ref, computed, onMounted } from 'vue'
import {
  getCombatStatus,
  getMonsters,
  getCombatStats,
  encounter,
  attack,
  useSkill,
  monsterTurn,
  escape,
  abandon
} from '../../api/combat'
import { getMapInfo } from '../../api/map'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { formatCompact } from '../../utils/format'
import PanelShell from '../ui/PanelShell.vue'
import PanelCard from '../ui/PanelCard.vue'
import StatBar from '../ui/StatBar.vue'
import Badge from '../ui/Badge.vue'
import AppButton from '../ui/AppButton.vue'
import EmptyState from '../ui/EmptyState.vue'

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

// 进行中战斗的事实来源是 store（由 /combat/status 同步），
// 面板自己读，不再由 GameLayout 逐层传 prop。
const battleId = computed(() => playerStore.activeBattleId)

const loading = ref(true)
const combatLoading = ref(false)
const currentMap = ref(null)
const monsters = ref([])
const currentBattle = ref(null)
const battleLog = ref([])
const combatStats = ref(null)
const skillMpCost = ref(20) // 默认值，由后端返回
const isPlayerTurn = computed(() => currentBattle.value?.is_player_turn !== false)
const roundLabel = computed(() => currentBattle.value?.round || 1)

/**
 * 战斗收尾
 *
 * 本地 currentBattle 清掉的同时必须抹掉 store 里的进行中战斗，
 * 否则 GameLayout 的「返回战斗」按钮会继续挂在一场已经不存在的战斗上。
 */
const endBattle = () => {
  currentBattle.value = null
  playerStore.clearActiveBattle()
}

/**
 * 把一次完整回合的服务端结果写回本地战场
 */
const applyRoundResult = (result) => {
  if (!currentBattle.value) return

  const playerAct = result.player_action
  const monsterAct = result.monster_action || result.recovered_monster_action

  if (playerAct) {
    uiStore.addLog({
      content: playerAct.missed
        ? `你对 ${currentBattle.value.monster.name} 的攻击落空了。`
        : `你对 ${currentBattle.value.monster.name} 造成了 ${playerAct.damage} 点伤害${playerAct.crit ? '（暴击）' : ''}。`,
      type: 'combat',
      actorId: 'self'
    })
    if (currentBattle.value.monster && result.monster_hp != null) {
      currentBattle.value.monster.hp = result.monster_hp
    }
    if (currentBattle.value.player && result.player_mp != null) {
      currentBattle.value.player.mp = result.player_mp
    }
    if (currentBattle.value.player && result.player_hp != null) {
      currentBattle.value.player.hp = result.player_hp
    }
  }

  if (monsterAct) {
    uiStore.addLog({
      content: monsterAct.missed
        ? `${currentBattle.value.monster.name} 的攻击被你闪开了。`
        : `${currentBattle.value.monster.name} 对你造成了 ${monsterAct.damage} 点伤害。`,
      type: 'combat',
      actorId: 'enemy'
    })
    if (currentBattle.value.player && monsterAct.player_hp != null) {
      currentBattle.value.player.hp = monsterAct.player_hp
    }
    if (currentBattle.value.monster && monsterAct.monster_hp != null) {
      currentBattle.value.monster.hp = monsterAct.monster_hp
    }
    if (monsterAct.protect_info?.triggered) {
      uiStore.addLog({
        content: `道侣远程护持，分担 ${monsterAct.protect_info.shared_damage} 点伤害。`,
        type: 'combat',
        actorId: 'self'
      })
    }
  }

  if (result.round != null) currentBattle.value.round = result.round
  currentBattle.value.turn = result.turn || 'player'
  currentBattle.value.is_player_turn = result.is_player_turn !== false
}

/**
 * 通用战斗结果收尾（胜利/失败/继续）
 * @returns {boolean} 是否已结束战斗
 */
const settleBattleOutcome = (result, winLog, loseToastPrefix) => {
  if (result.victory || result.battleEnded || result.result === 'win') {
    const expGained = result.rewards?.exp || 0
    uiStore.showToast(`战斗胜利！获得 ${expGained} 修为`, 'success')
    uiStore.addLog({
      content: winLog(expGained),
      type: 'combat',
      actorId: 'self'
    })
    endBattle()
    return true
  }
  if (result.defeat || result.result === 'lose') {
    uiStore.showToast(`${loseToastPrefix}，扣除 ${result.penalty_exp || 0} 修为`, 'error')
    endBattle()
    return true
  }
  return false
}

/**
 * 历史卡死战斗恢复：状态显示怪物回合时补结算一记
 */
const recoverMonsterTurn = async () => {
  if (!currentBattle.value || isPlayerTurn.value) return false
  try {
    const res = await monsterTurn()
    const result = res.data
    if (!result || result.waiting_for_player) {
      currentBattle.value.is_player_turn = true
      currentBattle.value.turn = 'player'
      return false
    }
    if (settleBattleOutcome(result, () => `你击败了 ${currentBattle.value?.monster?.name || '怪物'}。`, '战斗失败')) {
      return true
    }
    applyRoundResult({ ...result, player_action: null, monster_action: result.monster_action || result })
    return false
  } catch (error) {
    uiStore.showApiError(error, '怪物回合恢复失败')
    return false
  }
}

/**
 * 获取战斗数据
 */
const fetchData = async () => {
  loading.value = true
  let battleRes = null

  if (battleId.value) {
    try {
      battleRes = await getCombatStatus(battleId.value)
      if (battleRes.data.in_battle) {
        currentBattle.value = battleRes.data
        currentBattle.value.is_player_turn = battleRes.data.is_player_turn !== false
        battleLog.value = battleRes.data.battle_log || []
      }
    } catch (e) {
      console.error('获取战斗数据失败:', e)
    }
  }

  try {
    const [mapRes, monstersRes, statsRes] = await Promise.all([
      getMapInfo(),
      getMonsters(),
      getCombatStats()
    ])

    // 修复：后端 /map/info 与 /combat/monsters 返回结构为 { code, data: {...} }
    // 旧代码访问 .data.current_map 会拿到 undefined（缺少一层 data 包裹）
    // /combat/stats 直接展开返回（无 data 包裹），保留原访问方式
    currentMap.value = mapRes.data?.data?.current_map || mapRes.data.current_map
    const monstersData = monstersRes.data?.data || monstersRes.data
    monsters.value = monstersData?.monsters || []
    skillMpCost.value = monstersData?.skill_mp_cost || 20
    combatStats.value = statsRes.data
    if (!battleRes?.data?.battle_log) {
      battleLog.value = battleRes?.data?.battle_log || []
    }
  } catch (error) {
    console.error('获取战斗数据失败:', error)
    if (error.response?.status === 404) {
      monsters.value = []
    } else {
      uiStore.showApiError(error, '操作失败')
    }
  } finally {
    loading.value = false
  }

  // 刷新后若仍停在怪物回合（旧存档/异常残留），自动补一记，避免再次点攻击被拒
  if (currentBattle.value && currentBattle.value.is_player_turn === false) {
    await recoverMonsterTurn()
  }
}

/**
 * 遭遇怪物
 */
const handleEncounter = async (monster) => {
  if (combatLoading.value) return

  combatLoading.value = true
  try {
    await encounter(monster.id)
    // 新战斗的 battle_id 只有后端知道，直接回读一次，别在前端猜返回字段名
    await playerStore.syncActiveBattle()
    uiStore.addLog({
      content: `你遭遇了 ${monster.name}！`,
      type: 'combat',
      actorId: 'self'
    })

    await fetchData()
  } catch (error) {
    uiStore.showApiError(error, '遭遇失败')
  } finally {
    combatLoading.value = false
  }
}

/**
 * 普通攻击
 * 后端返回字段说明：
 *   - victory=true / battleEnded=true / result='win' → 战斗胜利
 *   - defeat=true / result='lose' → 战斗失败
 *   - 否则一次完整回合：player_action + monster_action，turn 回到 player
 */
const handleAttack = async () => {
  if (combatLoading.value || !currentBattle.value) return

  combatLoading.value = true
  try {
    const res = await attack('attack')
    const result = res.data

    if (!settleBattleOutcome(
      result,
      (expGained) => `你击败了 ${currentBattle.value.monster.name}，获得 ${expGained} 修为。`,
      '战斗失败'
    )) {
      applyRoundResult(result)
    }

    if (result.rewards?.items && result.rewards.items.length > 0) {
      uiStore.addLog({
        content: `获得物品: ${result.rewards.items.map(r => (r.item_name || r.item_id) + 'x' + r.quantity).join('、')}`,
        type: 'loot',
        actorId: 'self'
      })
    }

    await refreshStats()
  } catch (error) {
    uiStore.showApiError(error, '攻击失败')
  } finally {
    combatLoading.value = false
  }
}

/**
 * 使用技能
 */
const handleUseSkill = async (skillIndex) => {
  if (combatLoading.value || !currentBattle.value) return

  combatLoading.value = true
  try {
    const res = await useSkill(skillIndex)
    const result = res.data

    if (!settleBattleOutcome(
      result,
      (expGained) => `你使用技能击败了 ${currentBattle.value.monster.name}，获得 ${expGained} 修为。`,
      '战斗失败'
    )) {
      applyRoundResult(result)
    }

    if (result.rewards?.items && result.rewards.items.length > 0) {
      uiStore.addLog({
        content: `获得物品: ${result.rewards.items.map(r => (r.item_name || r.item_id) + 'x' + r.quantity).join('、')}`,
        type: 'loot',
        actorId: 'self'
      })
    }

    await refreshStats()
  } catch (error) {
    uiStore.showApiError(error, '技能使用失败')
  } finally {
    combatLoading.value = false
  }
}

/**
 * 逃跑
 * 后端返回 fled=true 表示成功逃跑；失败时空过一招并由怪物回击，回合仍回到玩家
 */
const handleEscape = async () => {
  if (combatLoading.value || !currentBattle.value) return

  combatLoading.value = true
  try {
    const res = await escape()
    const result = res.data

    if (result.fled) {
      uiStore.showToast('成功逃跑', 'info')
      uiStore.addLog({
        content: `你从 ${currentBattle.value.monster.name} 手中逃脱了。`,
        type: 'combat',
        actorId: 'self'
      })
      endBattle()
    } else if (settleBattleOutcome(
      result,
      () => '逃跑失败，但你击败了怪物！',
      '逃跑失败'
    )) {
      // 战斗已结束
    } else {
      uiStore.showToast('逃跑失败！', 'warn')
      uiStore.addLog({
        content: `你试图从 ${currentBattle.value.monster.name} 手中逃跑，但失败了！`,
        type: 'combat',
        actorId: 'self'
      })
      applyRoundResult({ ...result, player_action: null, monster_action: result.monster_action })
    }
    await refreshStats()
  } catch (error) {
    uiStore.showApiError(error, '逃跑失败')
  } finally {
    combatLoading.value = false
  }
}

/**
 * 放弃战斗（强制脱离，无惩罚，用于清理卡死的遗留战斗）
 */
const handleAbandon = async () => {
  if (combatLoading.value || !currentBattle.value) return

  combatLoading.value = true
  try {
    await abandon()
    uiStore.showToast('已放弃战斗', 'info')
    uiStore.addLog({
      content: `你放弃了与 ${currentBattle.value.monster.name} 的战斗。`,
      type: 'combat',
      actorId: 'self'
    })
    endBattle()
    await refreshStats()
  } catch (error) {
    uiStore.showApiError(error, '放弃战斗失败')
  } finally {
    combatLoading.value = false
  }
}

/**
 * 刷新战斗统计
 */
const refreshStats = async () => {
  try {
    const res = await getCombatStats()
    combatStats.value = res.data
  } catch (error) {
    console.error('刷新统计失败:', error)
  }
}

/**
 * 获取怪物难度
 * 使用后端返回的难度标签，避免前端硬编码境界顺序；
 * 呈现只看 name/safe 两个字段，样式由 Badge 的 tone 决定。
 */
const getMonsterDifficulty = (monster) => {
  if (monster.difficulty) return monster.difficulty
  return { name: '未知', safe: false }
}




onMounted(() => {
  fetchData()
})
</script>

<template>
  <PanelShell title="战斗" :hint="currentMap?.name" size="xl" :loading="loading" scoped-scroll fill @close="emit('close')">
    <div class="flex flex-col md:flex-row h-full min-h-0">
      <!-- 左：当前战斗。窄屏（面板是全屏 modal）先看战场，怪物列表往下排 -->
      <div class="w-full md:w-1/2 flex flex-col md:border-r border-line-subtle border-b md:border-b-0">
        <div class="shrink-0 px-4 py-2.5 border-b border-line-subtle bg-surface-canvas">
          <h3 class="text-xs font-bold text-fg-muted tracking-[0.15em]">当前战斗</h3>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto p-4">
          <EmptyState
            v-if="!currentBattle"
            text="当前没有战斗"
            hint="从右侧选择怪物遭遇，开始一场斗法"
          />

          <div v-else class="space-y-4">
            <PanelCard>
              <div class="flex justify-between items-center mb-3 gap-2">
                <h4 class="text-lg font-bold text-rose-400 truncate">{{ currentBattle.monster.name }}</h4>
                <div class="flex items-center gap-2 shrink-0">
                  <Badge tone="neutral">第 {{ roundLabel }} 回合</Badge>
                  <Badge :tone="isPlayerTurn ? 'success' : 'gold'">
                    {{ isPlayerTurn ? '你的回合' : '怪物行动中' }}
                  </Badge>
                  <Badge tone="danger">{{ currentBattle.monster.realm }}</Badge>
                </div>
              </div>

              <StatBar
                label="怪物气血"
                tone="blood"
                :value="currentBattle.monster.hp"
                :max="currentBattle.monster.max_hp"
                height="h-2.5"
              />

              <div class="grid grid-cols-3 gap-2 text-center mt-3">
                <div class="bg-surface-sunken rounded-control p-2">
                  <div class="text-[10px] text-fg-faint">攻击力</div>
                  <div class="text-sm font-bold text-rose-400 num" :title="String(currentBattle.monster.atk)">{{ formatCompact(currentBattle.monster.atk || 0) }}</div>
                </div>
                <div class="bg-surface-sunken rounded-control p-2">
                  <div class="text-[10px] text-fg-faint">防御力</div>
                  <div class="text-sm font-bold text-gold-400 num" :title="String(currentBattle.monster.def)">{{ formatCompact(currentBattle.monster.def || 0) }}</div>
                </div>
                <div class="bg-surface-sunken rounded-control p-2">
                  <div class="text-[10px] text-fg-faint">经验奖励</div>
                  <div class="text-sm font-bold text-emerald-400 num">{{ formatCompact(currentBattle.monster.exp_reward) }}</div>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="你的状态">
              <StatBar
                class="mb-2"
                tone="blood"
                :value="currentBattle.player.hp"
                :max="currentBattle.player.max_hp"
              />
              <StatBar
                tone="azure"
                :value="currentBattle.player.mp"
                :max="currentBattle.player.max_mp"
              />
            </PanelCard>

            <div class="grid grid-cols-3 gap-2">
              <AppButton
                variant="danger"
                :disabled="combatLoading || !isPlayerTurn"
                :loading="combatLoading"
                @click="handleAttack"
              >普通攻击</AppButton>
              <AppButton
                variant="outline"
                :disabled="combatLoading || !isPlayerTurn || currentBattle.player.mp < skillMpCost"
                @click="handleUseSkill(0)"
              >技能 · {{ skillMpCost }}灵力</AppButton>
              <AppButton
                :disabled="combatLoading || !isPlayerTurn"
                @click="handleEscape"
              >逃跑</AppButton>
            </div>

            <!-- 放弃战斗：用于清理卡死的遗留战斗，做得不起眼以免误点 -->
            <div class="text-center">
              <AppButton
                variant="ghost"
                size="xs"
                :disabled="combatLoading"
                title="放弃战斗会直接结束当前战斗，无惩罚但也不获得奖励"
                @click="handleAbandon"
              >放弃战斗</AppButton>
            </div>

            <PanelCard v-if="battleLog.length" title="战斗日志">
              <ul class="space-y-1 text-xs text-fg-muted max-h-40 overflow-y-auto">
                <li v-for="(entry, idx) in battleLog.slice(-8).reverse()" :key="idx">
                  <span class="text-fg-faint">#{{ entry.round ?? '-' }}</span>
                  <span
                    class="ml-1"
                    :class="entry.attacker === 'player' ? 'text-emerald-400' : entry.attacker === 'monster' ? 'text-rose-400' : 'text-gold-400'"
                  >{{ entry.attacker === 'player' ? '你' : entry.attacker === 'monster' ? currentBattle.monster.name : '道侣' }}</span>
                  <span class="ml-1">
                    {{ entry.action === 'victory' ? '取得胜利'
                      : entry.action === 'defeat' ? '身死道消'
                      : entry.action === 'flee' ? (entry.success ? '成功遁走' : '逃跑失败')
                      : entry.action === 'use_item' ? `使用物品（回血 ${entry.hp_restore || 0}）`
                      : entry.action === 'protect' ? `护道分担 ${entry.shared_damage || 0}`
                      : `造成 ${entry.damage ?? 0} 点伤害${entry.missed ? '（落空）' : entry.crit ? '（暴击）' : ''}` }}
                  </span>
                </li>
              </ul>
            </PanelCard>
          </div>
        </div>
      </div>

      <!-- 右：遭遇列表 + 战斗统计 -->
      <div class="w-full md:w-1/2 flex flex-col min-h-0">
        <div class="shrink-0 px-4 py-2.5 border-b border-line-subtle bg-surface-canvas">
          <h3 class="text-xs font-bold text-fg-muted tracking-[0.15em]">遭遇列表</h3>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <EmptyState
            v-if="monsters.length === 0"
            :text="`${currentMap?.name || '当前区域'} 暂无怪物`"
            hint="换个区域历练，或等待怪物刷新"
          />

          <PanelCard
            v-for="monster in monsters"
            :key="monster.id"
            class="transition-colors hover:border-line-strong"
          >
            <div class="flex justify-between items-start mb-2 gap-2">
              <div class="min-w-0">
                <h4 class="font-bold text-fg-primary truncate">{{ monster.name }}</h4>
                <p class="text-xs text-fg-faint">{{ monster.realm }}</p>
              </div>
              <Badge :tone="getMonsterDifficulty(monster).safe ? 'success' : 'danger'">
                {{ getMonsterDifficulty(monster).name }}
              </Badge>
            </div>

            <div class="flex justify-between text-xs text-fg-faint num mb-3">
              <span>EXP <span class="text-emerald-400">{{ formatCompact(monster.exp) }}</span></span>
              <span>ATK <span class="text-rose-400">{{ monster.atk || '?' }}</span></span>
              <span>DEF <span class="text-gold-400">{{ monster.def || '?' }}</span></span>
            </div>

            <AppButton
              block
              :disabled="combatLoading || !getMonsterDifficulty(monster).safe || !!currentBattle"
              @click="handleEncounter(monster)"
            >{{ currentBattle ? '战斗中' : '遭遇' }}</AppButton>
          </PanelCard>

          <PanelCard title="战斗统计" v-if="combatStats">
            <div class="grid grid-cols-3 gap-2 text-center">
              <div class="bg-surface-sunken rounded-control p-2">
                <div class="text-lg font-bold text-emerald-400 num">{{ combatStats.victories || 0 }}</div>
                <div class="text-[10px] text-fg-faint">胜利</div>
              </div>
              <div class="bg-surface-sunken rounded-control p-2">
                <div class="text-lg font-bold text-rose-400 num">{{ combatStats.defeats || 0 }}</div>
                <div class="text-[10px] text-fg-faint">失败</div>
              </div>
              <div class="bg-surface-sunken rounded-control p-2">
                <div class="text-lg font-bold text-gold-400 num">{{ combatStats.escapes || 0 }}</div>
                <div class="text-[10px] text-fg-faint">逃跑</div>
              </div>
            </div>
            <div class="mt-3 pt-3 border-t border-line-subtle flex justify-between text-xs">
              <span class="text-fg-faint">总获得修为</span>
              <span class="text-gold-400 font-bold num">{{ formatCompact(combatStats.total_exp || 0) }}</span>
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  </PanelShell>
</template>

