<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'

const props = defineProps({
  initialBattleId: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['close'])
const uiStore = useUIStore()
const playerStore = usePlayerStore()

const loading = ref(true)
const combatLoading = ref(false)
const currentMap = ref(null)
const monsters = ref([])
const currentBattle = ref(null)
const battleLog = ref([])
const combatStats = ref(null)

const fetchData = async () => {
  loading.value = true
  try {
    if (props.initialBattleId) {
      const battleRes = await axios.get(`/api/combat/status?battle_id=${props.initialBattleId}`)
      if (battleRes.data.in_battle) {
        currentBattle.value = battleRes.data
      }
    }
    
    const [mapRes, monstersRes, statsRes] = await Promise.all([
      axios.get('/api/map/info'),
      axios.get('/api/combat/monsters'),
      axios.get('/api/combat/stats')
    ])
    
    currentMap.value = mapRes.data.current_map
    monsters.value = monstersRes.data.monsters || []
    combatStats.value = statsRes.data
    battleLog.value = battleRes?.data?.recent_battles || []
  } catch (error) {
    console.error('Failed to fetch combat data:', error)
    if (error.response?.status === 404) {
      monsters.value = []
    } else {
      uiStore.showToast('获取战斗数据失败', 'error')
    }
  } finally {
    loading.value = false
  }
}

const handleEncounter = async (monster) => {
  if (combatLoading.value) return
  
  combatLoading.value = true
  try {
    const res = await axios.post('/api/combat/encounter', { monsterId: monster.id })
    
    currentBattle.value = res.data.battle
    uiStore.addLog({
      content: `你遭遇了 ${monster.name}！`,
      type: 'combat',
      actorId: 'self'
    })
    
    await fetchData()
  } catch (error) {
    const msg = error.response?.data?.error || '遭遇失败'
    uiStore.showToast(msg, 'error')
  } finally {
    combatLoading.value = false
  }
}

const handleAttack = async () => {
  if (combatLoading.value || !currentBattle.value) return
  
  combatLoading.value = true
  try {
    const res = await axios.post('/api/combat/attack')
    
    const result = res.data
    if (result.victory) {
      uiStore.showToast(`战斗胜利！获得 ${result.exp_gained} 修为`, 'success')
      uiStore.addLog({
        content: `你击败了 ${currentBattle.value.monster.name}，获得 ${result.exp_gained} 修为。`,
        type: 'combat',
        actorId: 'self'
      })
      currentBattle.value = null
    } else if (result.defeat) {
      uiStore.showToast('战斗失败，您已逃跑', 'info')
      currentBattle.value = null
    } else {
      uiStore.addLog({
        content: `你对 ${currentBattle.value.monster.name} 造成了 ${result.damage} 点伤害。`,
        type: 'combat',
        actorId: 'self'
      })
      currentBattle.value = res.data
    }
    
    if (result.rewards && result.rewards.length > 0) {
      uiStore.addLog({
        content: `获得物品: ${result.rewards.map(r => r.name + 'x' + r.quantity).join('、')}`,
        type: 'loot',
        actorId: 'self'
      })
    }
    
    await refreshStats()
  } catch (error) {
    const msg = error.response?.data?.error || '攻击失败'
    uiStore.showToast(msg, 'error')
  } finally {
    combatLoading.value = false
  }
}

const handleUseSkill = async (skillIndex) => {
  if (combatLoading.value || !currentBattle.value) return
  
  combatLoading.value = true
  try {
    const res = await axios.post('/api/combat/skill', { skillIndex })
    
    const result = res.data
    if (result.victory) {
      uiStore.showToast(`战斗胜利！获得 ${result.exp_gained} 修为`, 'success')
      uiStore.addLog({
        content: `你使用技能击败了 ${currentBattle.value.monster.name}，获得 ${result.exp_gained} 修为。`,
        type: 'combat',
        actorId: 'self'
      })
      currentBattle.value = null
    } else if (result.mp_insufficient) {
      uiStore.showToast('灵力不足', 'error')
      return
    } else if (result.skill_failed) {
      uiStore.showToast('技能使用失败', 'error')
      return
    } else if (result.defeat) {
      uiStore.showToast('战斗失败，您已逃跑', 'info')
      currentBattle.value = null
    } else {
      uiStore.addLog({
        content: `你对 ${currentBattle.value.monster.name} 使用了技能，造成 ${result.damage} 点伤害。`,
        type: 'combat',
        actorId: 'self'
      })
      currentBattle.value = res.data
    }
    
    if (result.rewards && result.rewards.length > 0) {
      uiStore.addLog({
        content: `获得物品: ${result.rewards.map(r => r.name + 'x' + r.quantity).join('、')}`,
        type: 'loot',
        actorId: 'self'
      })
    }
    
    await refreshStats()
  } catch (error) {
    const msg = error.response?.data?.error || '技能使用失败'
    uiStore.showToast(msg, 'error')
  } finally {
    combatLoading.value = false
  }
}

const handleEscape = async () => {
  if (combatLoading.value || !currentBattle.value) return
  
  combatLoading.value = true
  try {
    await axios.post('/api/combat/escape')
    
    uiStore.showToast('成功逃跑', 'info')
    uiStore.addLog({
        content: `你从 ${currentBattle.value.monster.name} 手中逃脱了。`,
        type: 'combat',
        actorId: 'self'
      })
    currentBattle.value = null
    await refreshStats()
  } catch (error) {
    const msg = error.response?.data?.error || '逃跑失败'
    uiStore.showToast(msg, 'error')
  } finally {
    combatLoading.value = false
  }
}

const refreshStats = async () => {
  try {
    const res = await axios.get('/api/combat/stats')
    combatStats.value = res.data
  } catch (error) {
    console.error('Failed to refresh stats:', error)
  }
}

const getMonsterDifficulty = (monster) => {
  const realmOrder = [
    '凡人', '炼气1层', '炼气2层', '炼气3层', '炼气4层', '炼气5层',
    '炼气6层', '炼气7层', '炼气8层', '炼气9层', '炼气10层',
    '筑基期', '筑基初期', '筑基中期', '筑基后期', '筑基圆满',
    '金丹期', '金丹初期', '金丹中期', '金丹后期', '金丹圆满',
    '元婴期'
  ]
  const playerRealm = playerStore.player?.realm || '凡人'
  const playerIdx = realmOrder.indexOf(playerRealm)
  const monsterIdx = realmOrder.indexOf(monster.realm)
  
  const diff = monsterIdx - playerIdx
  if (diff <= -2) return { class: 'text-emerald-400', name: '弱小的怪物', safe: true }
  if (diff <= 0) return { class: 'text-yellow-400', name: '同级怪物', safe: true }
  if (diff <= 2) return { class: 'text-orange-400', name: '较强的怪物', safe: false }
  return { class: 'text-red-400', name: '极危险的怪物', safe: false }
}

const getMonsterHpPercent = (battle) => {
  if (!battle) return 0
  return Math.max(0, Math.min(100, (battle.monster.hp / battle.monster.max_hp) * 100))
}

const getPlayerHpPercent = (battle) => {
  if (!battle) return 0
  return Math.max(0, Math.min(100, (battle.player.hp / battle.player.max_hp) * 100))
}

const getPlayerMpPercent = (battle) => {
  if (!battle) return 0
  return Math.max(0, Math.min(100, (battle.player.mp / battle.player.max_mp) * 100))
}

const formatNumber = (num) => {
  if (num >= 10000) return (num / 10000).toFixed(1) + '万'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k'
  return num.toString()
}

onMounted(() => {
  fetchData()
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-black/80 backdrop-blur-sm" @click="emit('close')"></div>
    
    <div class="relative bg-[#141210] border border-stone-700 rounded-lg w-full max-w-5xl h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
      <div class="flex items-center justify-between p-4 border-b border-stone-800 bg-[#1c1917]">
        <h2 class="text-xl font-bold text-amber-500 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4"/><path d="M6 12H3"/><path d="M15 6h5a3 3 0 0 1 3 3 3 3 0 0 1-3 3h-3"/><path d="M18 12l-4-6"/><path d="M18 12l4 6"/><circle cx="18" cy="18" r="3"/><path d="M6 8v8"/></svg>
          战斗系统
        </h2>
        <button @click="emit('close')" class="text-stone-500 hover:text-stone-300 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="flex-1 overflow-hidden flex">
        <div class="w-1/2 flex flex-col border-r border-stone-800">
          <div class="p-4 border-b border-stone-800 bg-[#0c0a09]">
            <h3 class="text-sm font-bold text-stone-400 uppercase tracking-wider">当前战斗</h3>
          </div>
          
          <div class="flex-1 overflow-y-auto p-4">
            <div v-if="loading" class="flex justify-center items-center h-64">
              <svg class="animate-spin h-10 w-10 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>

            <div v-else-if="!currentBattle" class="flex flex-col items-center justify-center h-64 text-stone-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-4 opacity-50"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
              <p class="text-lg mb-2">当前没有战斗</p>
              <p class="text-sm opacity-70">选择右侧的怪物进行遭遇</p>
            </div>

            <div v-else class="space-y-6">
              <div class="bg-[#1c1917] rounded-lg p-4 border border-stone-800">
                <div class="flex justify-between items-center mb-3">
                  <h4 class="text-lg font-bold text-red-400">{{ currentBattle.monster.name }}</h4>
                  <span class="text-xs px-2 py-0.5 rounded bg-red-900/30 border border-red-700/50 text-red-400">
                    {{ currentBattle.monster.realm }}
                  </span>
                </div>
                
                <div class="mb-2 flex justify-between text-xs text-stone-500">
                  <span>怪物气血</span>
                  <span>{{ formatNumber(currentBattle.monster.hp) }} / {{ formatNumber(currentBattle.monster.max_hp) }}</span>
                </div>
                <div class="h-3 bg-stone-900 rounded-full overflow-hidden mb-4">
                  <div 
                    class="h-full bg-gradient-to-r from-red-700 to-red-500 transition-all duration-300"
                    :style="{ width: getMonsterHpPercent(currentBattle) + '%' }"
                  ></div>
                </div>

                <div class="grid grid-cols-3 gap-4 text-center">
                  <div class="bg-stone-900/50 rounded p-2">
                    <div class="text-xs text-stone-500">攻击力</div>
                    <div class="text-sm font-bold text-red-400">{{ currentBattle.monster.atk }}</div>
                  </div>
                  <div class="bg-stone-900/50 rounded p-2">
                    <div class="text-xs text-stone-500">防御力</div>
                    <div class="text-sm font-bold text-amber-400">{{ currentBattle.monster.def }}</div>
                  </div>
                  <div class="bg-stone-900/50 rounded p-2">
                    <div class="text-xs text-stone-500">经验奖励</div>
                    <div class="text-sm font-bold text-emerald-400">{{ formatNumber(currentBattle.monster.exp_reward) }}</div>
                  </div>
                </div>
              </div>

              <div class="bg-[#1c1917] rounded-lg p-4 border border-stone-800">
                <div class="flex justify-between items-center mb-3">
                  <h4 class="text-lg font-bold text-stone-200">你的状态</h4>
                </div>
                
                <div class="mb-2 flex justify-between text-xs text-stone-500">
                  <span>气血</span>
                  <span>{{ formatNumber(currentBattle.player.hp) }} / {{ formatNumber(currentBattle.player.max_hp) }}</span>
                </div>
                <div class="h-2 bg-stone-900 rounded-full overflow-hidden mb-2">
                  <div 
                    class="h-full bg-gradient-to-r from-red-700 to-red-500 transition-all duration-300"
                    :style="{ width: getPlayerHpPercent(currentBattle) + '%' }"
                  ></div>
                </div>

                <div class="mb-2 flex justify-between text-xs text-stone-500">
                  <span>灵力</span>
                  <span>{{ formatNumber(currentBattle.player.mp) }} / {{ formatNumber(currentBattle.player.max_mp) }}</span>
                </div>
                <div class="h-2 bg-stone-900 rounded-full overflow-hidden">
                  <div 
                    class="h-full bg-gradient-to-r from-cyan-700 to-cyan-500 transition-all duration-300"
                    :style="{ width: getPlayerMpPercent(currentBattle) + '%' }"
                  ></div>
                </div>
              </div>

              <div class="flex gap-2">
                <button 
                  @click="handleAttack"
                  :disabled="combatLoading"
                  class="flex-1 py-3 rounded bg-red-900/30 border border-red-700/50 text-red-400 hover:bg-red-800/50 hover:text-red-300 transition-colors disabled:opacity-50"
                >
                  <span v-if="combatLoading">战斗中...</span>
                  <span v-else>普通攻击</span>
                </button>
                <button 
                  @click="handleUseSkill(0)"
                  :disabled="combatLoading || currentBattle.player.mp < 20"
                  class="flex-1 py-3 rounded bg-purple-900/30 border border-purple-700/50 text-purple-400 hover:bg-purple-800/50 hover:text-purple-300 transition-colors disabled:opacity-50"
                >
                  <span>技能 (20灵力)</span>
                </button>
                <button 
                  @click="handleEscape"
                  :disabled="combatLoading"
                  class="flex-1 py-3 rounded bg-stone-800 border border-stone-700 text-stone-400 hover:bg-stone-700 hover:text-stone-300 transition-colors disabled:opacity-50"
                >
                  逃跑
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="w-1/2 flex flex-col">
          <div class="p-4 border-b border-stone-800 bg-[#0c0a09]">
            <h3 class="text-sm font-bold text-stone-400 uppercase tracking-wider">遭遇列表</h3>
          </div>
          
          <div class="flex-1 overflow-y-auto p-4">
            <div v-if="loading" class="flex justify-center items-center h-64">
              <svg class="animate-spin h-8 w-8 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>

            <div v-else-if="monsters.length === 0" class="flex flex-col items-center justify-center h-64 text-stone-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
              <p>{{ currentMap?.name || '当前区域' }} 暂无怪物</p>
            </div>

            <div v-else class="space-y-3">
              <div 
                v-for="monster in monsters" 
                :key="monster.id"
                class="bg-[#1c1917] border border-stone-800 rounded-lg p-3 transition-all hover:border-stone-700"
              >
                <div class="flex justify-between items-start mb-2">
                  <div>
                    <h4 class="font-bold text-stone-200">{{ monster.name }}</h4>
                    <p class="text-xs text-stone-500">{{ monster.realm }}</p>
                  </div>
                  <span 
                    class="text-xs px-2 py-0.5 rounded border"
                    :class="getMonsterDifficulty(monster).safe 
                      ? 'bg-emerald-900/20 border-emerald-700/50 text-emerald-400' 
                      : 'bg-red-900/20 border-red-700/50 text-red-400'"
                  >
                    {{ getMonsterDifficulty(monster).name }}
                  </span>
                </div>
                
                <div class="flex justify-between text-xs text-stone-500 mb-3">
                  <span>EXP: <span class="text-emerald-400">{{ formatNumber(monster.exp) }}</span></span>
                  <span>ATK: <span class="text-red-400">{{ monster.atk || '?' }}</span></span>
                  <span>DEF: <span class="text-amber-400">{{ monster.def || '?' }}</span></span>
                </div>

                <button 
                  @click="handleEncounter(monster)"
                  :disabled="combatLoading || !getMonsterDifficulty(monster).safe"
                  class="w-full py-2 rounded bg-stone-800 border border-stone-700 text-stone-400 hover:bg-stone-700 hover:text-stone-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  遭遇
                </button>
              </div>
            </div>

            <div class="mt-6 p-4 bg-[#1c1917] rounded-lg border border-stone-800">
              <h4 class="text-sm font-bold text-stone-400 mb-3 uppercase tracking-wider">战斗统计</h4>
              <div class="grid grid-cols-3 gap-3 text-center">
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-lg font-bold text-emerald-400">{{ combatStats?.victories || 0 }}</div>
                  <div class="text-[10px] text-stone-500">胜利</div>
                </div>
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-lg font-bold text-red-400">{{ combatStats?.defeats || 0 }}</div>
                  <div class="text-[10px] text-stone-500">失败</div>
                </div>
                <div class="bg-stone-900/50 rounded p-2">
                  <div class="text-lg font-bold text-yellow-400">{{ combatStats?.escapes || 0 }}</div>
                  <div class="text-[10px] text-stone-500">逃跑</div>
                </div>
              </div>
              <div class="mt-3 pt-3 border-t border-stone-800">
                <div class="flex justify-between text-xs">
                  <span class="text-stone-500">总获得修为</span>
                  <span class="text-amber-400 font-bold">{{ formatNumber(combatStats?.total_exp || 0) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
</style>
