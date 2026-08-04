<!--
  功法面板（TechniquePanel）
  功能：
    1. 已习得：查看熟练度/层数/加成，进行修炼、突破、装备、领悟神通
    2. 可习得：浏览可研习功法（境界门槛与效果预览），消耗资源习得
    3. 系统：展示功法系统开关与修炼/装备规则
  依赖后端：server/routes/technique.js（list/learn/practice/breakthrough/comprehend/equip）
  交互：通过 useUIStore 写入日志与 toast，并 emit 'close' 由父层收口面板
-->
<template>
  <div class="technique-panel relative">
    <!-- 标签页切换 -->
    <div class="flex gap-2 mb-4 border-b border-stone-700/60 pb-2">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="px-3 py-1.5 text-sm rounded-md transition-colors"
        :class="view === tab.id
          ? 'bg-amber-700/40 text-amber-200 border border-amber-600/50'
          : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'"
        @click="switchView(tab.id)"
      >{{ tab.name }}</button>
    </div>

    <!-- 玩家资源联动展示：修炼/突破/研习消耗实时抵扣，操作后会自动刷新 -->
    <div class="flex items-center justify-between gap-3 mb-3 text-xs rounded-lg border border-stone-700/50 bg-stone-900/40 px-3 py-2">
      <div class="flex flex-wrap gap-3">
        <span class="text-amber-300">灵石 <b class="text-amber-200">{{ playerStore.player?.spirit_stones ?? '—' }}</b></span>
        <span class="text-sky-300">灵力 <b class="text-sky-200">{{ playerStore.player?.mp ?? '—' }}<span v-if="playerStore.player?.mp_max"> / {{ playerStore.player.mp_max }}</span></b></span>
        <span class="text-emerald-300">修为 <b class="text-emerald-200">{{ playerStore.player?.exp ?? '—' }}</b></span>
      </div>
      <button
        class="shrink-0 px-2 py-0.5 rounded bg-stone-700/50 hover:bg-stone-600/60 border border-stone-600/50"
        @click="emit('close')"
      >收起</button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center text-stone-400 py-12 text-sm">
      正在运转周天，请稍候...
    </div>

    <!-- 已习得功法 -->
    <div v-else-if="view === 'owned'" class="space-y-3">
      <div
        v-for="item in owned"
        :key="item.technique_id"
        class="rounded-lg border p-3"
        :style="gradeStyle(item.grade_color)"
      >
        <!-- 头部：名称 + 阶层/装备槽 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-medium">{{ item.name }}</span>
            <span class="text-xs px-1.5 py-0.5 rounded bg-black/30">{{ item.grade_name }}</span>
            <span v-if="item.equip_slot" class="text-xs px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-300">
              {{ item.equip_slot === 'main' ? '主修' : '辅修' }}
            </span>
          </div>
          <span class="text-xs text-stone-400">第 {{ item.layer }} / {{ item.max_layer }} 层</span>
        </div>

        <!-- 熟练度进度 -->
        <div class="mt-2 flex items-center gap-2 text-xs text-stone-400">
          <span>熟练度 {{ item.proficiency }} / {{ item.required_proficiency }}</span>
          <div class="flex-1 h-1.5 bg-black/40 rounded overflow-hidden">
            <div
              class="h-full bg-amber-500/70"
              :style="{ width: profPercent(item) + '%' }"
            ></div>
          </div>
        </div>

        <!-- 属性加成预览 -->
        <div v-if="item.current_bonus && Object.keys(item.current_bonus).length" class="mt-2 flex flex-wrap gap-1.5 text-xs">
          <span
            v-for="(val, key) in item.current_bonus"
            :key="key"
            class="px-1.5 py-0.5 rounded bg-black/20"
          >{{ bonusLabel(key) }} {{ val > 0 ? '+' : '' }}{{ val }}</span>
        </div>

        <!-- 消耗预览：精确展示各操作消耗，并与实时余额对比，不足时标红 -->
        <div class="mt-1 text-xs space-y-0.5">
          <div class="text-stone-500">今日修炼 {{ item.daily_practice_count }} / {{ item.daily_practice_limit }}</div>
          <div class="flex flex-wrap gap-x-3 gap-y-0.5">
            <span :class="enoughSS(item.practice_cost) ? 'text-amber-300/90' : 'text-rose-400'">修炼 灵石{{ item.practice_cost }}</span>
            <span :class="enoughMP(item.mp_cost) ? 'text-sky-300/90' : 'text-rose-400'">灵力{{ item.mp_cost }}</span>
            <span :class="enoughSS(item.breakthrough_cost) ? 'text-rose-300/90' : 'text-rose-400'">突破 灵石{{ item.breakthrough_cost }}</span>
            <span :class="enoughSS(item.comprehend_cost) ? 'text-purple-300/90' : 'text-rose-400'">领悟 灵石{{ item.comprehend_cost }}</span>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="px-3 py-1 text-xs rounded bg-amber-800/50 hover:bg-amber-700/60 border border-amber-700/50"
            :disabled="!canPractice(item)"
            :class="canPractice(item) ? '' : 'opacity-40 cursor-not-allowed'"
            @click="confirmPractice(item)"
          >修炼</button>
          <button
            class="px-3 py-1 text-xs rounded bg-rose-900/50 hover:bg-rose-800/60 border border-rose-700/50"
            :disabled="!canBreakthrough(item)"
            :class="canBreakthrough(item) ? '' : 'opacity-40 cursor-not-allowed'"
            @click="confirmBreakthrough(item)"
          >突破</button>
          <button
            class="px-3 py-1 text-xs rounded bg-purple-900/50 hover:bg-purple-800/60 border border-purple-700/50"
            :disabled="!canComprehend(item)"
            :class="canComprehend(item) ? '' : 'opacity-40 cursor-not-allowed'"
            @click="confirmComprehend(item)"
          >领悟神通</button>
          <template v-if="item.equip_slot">
            <button
              class="px-3 py-1 text-xs rounded bg-stone-700/50 hover:bg-stone-600/60 border border-stone-600/50"
              @click="confirmUnequip(item)"
            >卸下</button>
          </template>
          <template v-else>
            <button
              class="px-3 py-1 text-xs rounded bg-emerald-900/50 hover:bg-emerald-800/60 border border-emerald-700/50"
              @click="confirmEquipMain(item)"
            >设为主修</button>
            <button
              class="px-3 py-1 text-xs rounded bg-sky-900/50 hover:bg-sky-800/60 border border-sky-700/50"
              @click="confirmEquipAux(item)"
            >设为辅修</button>
          </template>
        </div>

        <!-- 已悟神通 -->
        <div v-if="item.comprehended_skills?.length" class="mt-2 text-xs text-purple-300">
          神通：{{ item.comprehended_skills.length }} 项
        </div>
      </div>
      <div v-if="!owned.length" class="text-center text-stone-500 py-10 text-sm">
        尚未习得任何功法，去「可习得」研习吧
      </div>
    </div>

    <!-- 可习得功法 -->
    <div v-else-if="view === 'available'" class="space-y-3">
      <div
        v-for="tech in available"
        :key="tech.technique_id"
        class="rounded-lg border p-3"
        :style="gradeStyle(tech.grade_color)"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-medium">{{ tech.name }}</span>
            <span class="text-xs px-1.5 py-0.5 rounded bg-black/30">{{ tech.grade_name }}</span>
            <span class="text-xs px-1.5 py-0.5 rounded bg-black/30">{{ elementLabel(tech.element) }}</span>
          </div>
          <span
            class="text-xs px-1.5 py-0.5 rounded"
            :class="tech.realm_satisfied ? 'bg-emerald-900/40 text-emerald-300' : 'bg-rose-900/40 text-rose-300'"
          >{{ tech.realm_satisfied ? '境界达标' : '境界不足' }}</span>
        </div>
        <div v-if="tech.description" class="mt-1 text-xs text-stone-400">{{ tech.description }}</div>
        <div v-if="tech.bonuses && Object.keys(tech.bonuses).length" class="mt-2 flex flex-wrap gap-1.5 text-xs">
          <span
            v-for="(val, key) in tech.bonuses"
            :key="key"
            class="px-1.5 py-0.5 rounded bg-black/20"
          >{{ bonusLabel(key) }} {{ val > 0 ? '+' : '' }}{{ val }}</span>
        </div>
        <div class="mt-1 text-xs text-amber-300">
          研习途径：{{ acquireLabel(tech.acquire) }}
          <span
            v-if="tech.acquire?.source === 'shop'"
            :class="enoughSS(tech.acquire.cost_spirit_stones) ? 'text-amber-300/90' : 'text-rose-400'"
          >（余额 {{ playerSS }}）</span>
        </div>
        <div class="mt-3">
          <button
            class="px-3 py-1 text-xs rounded bg-amber-800/50 hover:bg-amber-700/60 border border-amber-700/50"
            :disabled="!canLearn(tech)"
            :class="canLearn(tech) ? '' : 'opacity-40 cursor-not-allowed'"
            @click="confirmLearn(tech)"
          >研习</button>
        </div>
      </div>
      <div v-if="!available.length" class="text-center text-stone-500 py-10 text-sm">暂无可习得的功法</div>
    </div>

    <!-- 系统设置 -->
    <div v-else-if="view === 'settings'" class="space-y-2 text-sm">
      <div class="rounded-lg border border-stone-700/50 p-3 space-y-1">
        <div class="flex justify-between"><span class="text-stone-400">功法系统</span><span>{{ settings.enabled ? '开放' : '关闭' }}</span></div>
        <div class="flex justify-between"><span class="text-stone-400">主修槽位上限</span><span>{{ settings.max_equipped_main }}</span></div>
        <div class="flex justify-between"><span class="text-stone-400">辅修槽位上限</span><span>{{ settings.max_equipped_auxiliary }}</span></div>
        <div class="flex justify-between"><span class="text-stone-400">每日修炼上限</span><span>{{ settings.daily_practice_limit }}</span></div>
        <div class="flex justify-between"><span class="text-stone-400">修炼冷却</span><span>{{ settings.practice_cooldown_seconds }} 秒</span></div>
        <div class="flex justify-between"><span class="text-stone-400">你的悟性</span><span>{{ wisdom }}</span></div>
      </div>
      <div class="text-xs text-stone-500 leading-relaxed">
        说明：修炼消耗灵石与灵力提升熟练度；熟练度达标后可突破升阶，突破有成功率与保底。
        可装备 1 个主修与多个辅修功法，主修切换需付出代价。神通需在已修功法上领悟，
        槽位数随功法层数解锁。
      </div>
    </div>

    <!-- 二次确认弹窗 -->
    <Modal
      v-if="confirmModal.show"
      :title="confirmModal.title"
      :message="confirmModal.message"
      :confirmText="confirmModal.confirmText"
      :cancelText="confirmModal.cancelText"
      :type="confirmModal.type"
      @confirm="confirmModal.onConfirm"
      @cancel="closeConfirm"
    />

    <!-- 处理遮罩 -->
    <div v-if="busy" class="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg z-10">
      <div class="text-amber-300 text-sm">运转功法中...</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import Modal from '../common/Modal.vue'
import {
  getTechniqueList,
  learnTechnique,
  practiceTechnique,
  breakthroughTechnique,
  comprehendTechnique,
  equipTechnique
} from '../../api/technique'

const uiStore = useUIStore()
const playerStore = usePlayerStore()
const emit = defineEmits(['close'])

/** 标签页定义 */
const tabs = [
  { id: 'owned', name: '已习得' },
  { id: 'available', name: '可习得' },
  { id: 'settings', name: '系统' }
]

/** 组件状态 */
const view = ref('owned')
const payload = ref(null)
const loading = ref(false)
const busy = ref(false)

/** 二次确认弹窗状态 */
const confirmModal = ref({
  show: false,
  title: '',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
  type: 'warning',
  onConfirm: () => {}
})

/** 解构总览数据 */
const owned = computed(() => payload.value?.owned || [])
const available = computed(() => payload.value?.available || [])
const settings = computed(() => payload.value?.settings || {})
const wisdom = computed(() => payload.value?.wisdom ?? 0)

/** 玩家实时余额（与顶部资源条同源，操作后可被 socket/主动刷新更新） */
const playerSS = computed(() => Number(playerStore.player?.spirit_stones ?? 0))
const playerMP = computed(() => Number(playerStore.player?.mp ?? 0))

/** 灵石是否足够 */
const enoughSS = (cost) => playerSS.value >= Number(cost || 0)
/** 灵力是否足够 */
const enoughMP = (cost) => playerMP.value >= Number(cost || 0)

/** 切换标签页 */
const switchView = (newView) => { view.value = newView }

/** 关闭弹窗 */
const closeConfirm = () => { confirmModal.value.show = false }

/** 统一二次确认构造 */
const openConfirm = (opts) => {
  confirmModal.value = { show: true, confirmText: '确认', cancelText: '取消', type: 'warning', ...opts }
}

/** 品阶色（取自后端 grade_color，兜底默认） */
const gradeStyle = (color) => {
  const c = color || '#78716c'
  return {
    borderColor: `${c}66`,
    background: `${c}14`,
    color: '#e7e5e4'
  }
}

/** 熟练度百分比 */
const profPercent = (item) => {
  const req = item.required_proficiency || 1
  return Math.min(100, Math.round((item.proficiency / req) * 100))
}

/** 是否可修炼：熟练度未满 + 今日未超限 + 灵石/灵力余额足够 */
const canPractice = (item) => {
  const notMax = item.proficiency < item.required_proficiency
  const notDailyFull = item.daily_practice_count < item.daily_practice_limit
  return notMax && notDailyFull && enoughSS(item.practice_cost) && enoughMP(item.mp_cost)
}

/** 是否可突破：未达满层 + 熟练度达标 + 灵石余额足够 */
const canBreakthrough = (item) =>
  !item.is_max_layer &&
  item.proficiency >= item.required_proficiency &&
  enoughSS(item.breakthrough_cost)

/** 是否可领悟神通：存在未获得神通槽位 + 灵石余额足够 */
const canComprehend = (item) =>
  Array.isArray(item.comprehended_skills) &&
  item.comprehended_skills.length < (item.skillSlotsTotal || 1) &&
  enoughSS(item.comprehend_cost)

/** 是否可研习：境界达标 + 灵石余额足够（shop 来源需灵石；sect 来源贡献暂不前端校验） */
const canLearn = (tech) => {
  if (!tech.realm_satisfied) return false
  if (tech.acquire?.source === 'shop') return enoughSS(tech.acquire.cost_spirit_stones)
  return true
}

/** 属性加成字段中文标签 */
const bonusLabel = (key) => {
  const labels = {
    atk: '攻击', def: '防御', hp_max: '气血上限', mp_max: '灵力上限',
    speed: '速度', crit: '暴击', sense: '神识', atk_ratio: '攻击%',
    def_ratio: '防御%', hp_max_ratio: '气血%', mp_max_ratio: '灵力%'
  }
  return labels[key] || key
}

/** 五行标签 */
const elementLabel = (el) => {
  const map = { metal: '金', wood: '木', water: '水', fire: '火', earth: '土', none: '无' }
  return map[el] || el
}

/** 研习途径文案 */
const acquireLabel = (acquire) => {
  if (!acquire) return '未知'
  const src = { default: '新手指引', shop: '灵石购买', sect: '宗门贡献', secret_realm: '秘境奇遇' }
  let text = src[acquire.source] || acquire.source
  if (acquire.source === 'shop' && acquire.cost_spirit_stones) text += `（${acquire.cost_spirit_stones} 灵石）`
  if (acquire.source === 'sect' && acquire.cost_contribution) text += `（${acquire.cost_contribution} 贡献）`
  if (acquire.source === 'secret_realm') text += '（不可主动研习）'
  return text
}

/** 拉取功法总览 */
const fetchList = async () => {
  try {
    const res = await getTechniqueList()
    payload.value = res.data?.data || res.data || {}
  } catch (err) {
    console.error('获取功法总览失败:', err)
    uiStore.showToast('获取功法总览失败', 'error')
  }
}

/** 资源刷新通知父层（仅记录日志，不关闭面板，保持持续操作体验） */
const emitRefresh = () => {
  uiStore.addLog({ type: 'technique', content: '功法状态已更新' })
}

/**
 * 资源联动刷新：操作后主动拉取玩家最新资源（灵石/灵力/修为等）
 * 后端对功法类操作未必推送 player_update 事件，前端主动 fetchPlayer
 * 以保证顶部资源条与本面板余额实时同步，避免"消耗不显示"的错位。
 */
const refreshResources = async () => {
  try {
    await playerStore.fetchPlayer()
  } catch (err) {
    console.error('刷新玩家资源失败:', err)
  }
}

/** 修炼确认 */
const confirmPractice = (item) => {
  openConfirm({
    title: '运转功法',
    message: `确认修炼《${item.name}》？\n消耗 灵石 ${item.practice_cost}（余额 ${playerSS}）、灵力 ${item.mp_cost}（余额 ${playerMP}）提升熟练度。`,
    confirmText: '修炼',
    onConfirm: async () => { closeConfirm(); await doPractice(item.technique_id) }
  })
}

/** 执行修炼 */
const doPractice = async (id) => {
  busy.value = true
  try {
    const res = await practiceTechnique(id)
    const p = res.data
    if (p.code !== 200) { uiStore.showToast(p.message || '修炼失败', 'warning'); return }
    uiStore.showToast(p.message || '修炼成功', 'success')
    await fetchList()
    await refreshResources()
  } catch (err) {
    console.error('修炼失败:', err)
    uiStore.showToast('修炼失败', 'error')
  } finally {
    busy.value = false
  }
}

/** 突破确认 */
const confirmBreakthrough = (item) => {
  if (!canBreakthrough(item)) { uiStore.showToast('熟练度不足或已至圆满', 'warning'); return }
  openConfirm({
    title: '突破功法',
    message: `确认突破《${item.name}》？\n消耗灵石 ${item.breakthrough_cost}（余额 ${playerSS}），当前突破成功率约 ${Math.round((item.breakthrough_rate || 0) * 100)}%。`,
    confirmText: '突破',
    onConfirm: async () => { closeConfirm(); await doBreakthrough(item.technique_id) }
  })
}

/** 执行突破 */
const doBreakthrough = async (id) => {
  busy.value = true
  try {
    const res = await breakthroughTechnique(id)
    const p = res.data
    if (p.code !== 200) { uiStore.showToast(p.message || '突破失败', 'warning'); return }
    uiStore.showToast(p.message || '突破完成', 'success')
    await fetchList()
    await refreshResources()
  } catch (err) {
    console.error('突破失败:', err)
    uiStore.showToast('突破失败', 'error')
  } finally {
    busy.value = false
  }
}

/** 领悟神通确认 */
const confirmComprehend = (item) => {
  openConfirm({
    title: '领悟神通',
    message: `确认对《${item.name}》进行神通领悟？\n消耗灵石 ${item.comprehend_cost}（余额 ${playerSS}），成败凭机缘。`,
    confirmText: '领悟',
    type: 'purple',
    onConfirm: async () => { closeConfirm(); await doComprehend(item.technique_id) }
  })
}

/** 执行领悟神通 */
const doComprehend = async (id) => {
  busy.value = true
  try {
    const res = await comprehendTechnique(id)
    const p = res.data
    if (p.code !== 200) { uiStore.showToast(p.message || '领悟失败', 'warning'); return }
    uiStore.showToast(p.message || '领悟完成', 'success')
    await fetchList()
    await refreshResources()
  } catch (err) {
    console.error('领悟失败:', err)
    uiStore.showToast('领悟失败', 'error')
  } finally {
    busy.value = false
  }
}

/** 研习确认 */
const confirmLearn = (tech) => {
  if (!tech.realm_satisfied) { uiStore.showToast('境界不足，无法研习', 'warning'); return }
  openConfirm({
    title: '研习功法',
    message: `确认研习《${tech.name}》？\n${acquireLabel(tech.acquire)}`,
    confirmText: '研习',
    onConfirm: async () => { closeConfirm(); await doLearn(tech.technique_id) }
  })
}

/** 执行研习 */
const doLearn = async (id) => {
  busy.value = true
  try {
    const res = await learnTechnique(id)
    const p = res.data
    if (p.code !== 200) { uiStore.showToast(p.message || '研习失败', 'warning'); return }
    uiStore.showToast(p.message || '研习成功', 'success')
    await fetchList()
    await refreshResources()
  } catch (err) {
    console.error('研习失败:', err)
    uiStore.showToast('研习失败', 'error')
  } finally {
    busy.value = false
  }
}

/**
 * 装备为主修（带代价预览）
 * 说明：后端已在 getPlayerTechniques 返回 switch_main 配置与 current_main，
 *      这里据此生成"灵石代价 / 原主修熟练度衰减 / 冷却剩余"的预览文案，
 *      让玩家在确认前看清改修换脉的代价。
 */
const confirmEquipMain = (item) => {
  const s = settings.value || {}
  const cur = payload.value?.current_main || null
  const lines = [`确认将《${item.name}》设为主修？`]

  // 仅在"已存在其他主修"时才产生切换代价
  if (cur && cur.technique_id !== item.technique_id) {
    const costSS = Number(s.switch_main_cost_spirit_stone) || 0
    const decayPct = Number(s.proficiency_decay_on_switch_pct) || 0
    const decay = Math.floor((Number(cur.proficiency) || 0) * decayPct / 100)

    lines.push(`· 灵石代价：${costSS}（余额 ${playerSS}）`)
    lines.push(`· 原主修《${cur.name}》熟练度 -${decay}（${decayPct}%）`)

    // 冷却预览：以原主修 updated_at 为上次切换时间近似计算剩余小时
    const cdHours = Number(s.switch_main_cooldown_hours) || 0
    if (cdHours > 0 && cur.updated_at) {
      const elapsedH = (Date.now() - new Date(cur.updated_at).getTime()) / 3600000
      const remain = cdHours - elapsedH
      lines.push(remain > 0
        ? `· 冷却中：${Math.ceil(remain)} 小时后方可改修`
        : '· 冷却已结束，可立即改修')
    }
    if (costSS > playerSS) {
      lines.push('⚠ 灵石不足，无法切换')
    }
  } else {
    lines.push('当前无主修或无其他主修，设置无额外代价。')
  }

  openConfirm({
    title: '设为主修',
    message: lines.join('\n'),
    confirmText: '设为主修',
    onConfirm: async () => { closeConfirm(); await doEquip(item.technique_id, 'main') }
  })
}

/** 装备为辅修 */
const confirmEquipAux = (item) => {
  openConfirm({
    title: '设为辅修',
    message: `确认将《${item.name}》设为辅修？`,
    confirmText: '设为辅修',
    onConfirm: async () => { closeConfirm(); await doEquip(item.technique_id, 'auxiliary') }
  })
}

/** 卸下确认 */
const confirmUnequip = (item) => {
  openConfirm({
    title: '卸下功法',
    message: `确认卸下《${item.name}》？`,
    confirmText: '卸下',
    onConfirm: async () => { closeConfirm(); await doUnequip(item.technique_id) }
  })
}

/** 执行装备 */
const doEquip = async (id, slot) => {
  busy.value = true
  try {
    const res = await equipTechnique(id, slot)
    const p = res.data
    if (p.code !== 200) { uiStore.showToast(p.message || '装备失败', 'warning'); return }
    uiStore.showToast(p.message || '装备成功', 'success')
    await fetchList()
    await refreshResources()
  } catch (err) {
    console.error('装备失败:', err)
    uiStore.showToast('装备失败', 'error')
  } finally {
    busy.value = false
  }
}

/** 执行卸下（slot 为 null） */
const doUnequip = async (id) => {
  busy.value = true
  try {
    const res = await equipTechnique(id, null)
    const p = res.data
    if (p.code !== 200) { uiStore.showToast(p.message || '卸下失败', 'warning'); return }
    uiStore.showToast(p.message || '已卸下', 'success')
    await fetchList()
    await refreshResources()
  } catch (err) {
    console.error('卸下失败:', err)
    uiStore.showToast('卸下失败', 'error')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  loading.value = true
  await fetchList()
  loading.value = false
})
</script>

<style scoped>
.technique-panel {
  min-height: 320px;
}
</style>
