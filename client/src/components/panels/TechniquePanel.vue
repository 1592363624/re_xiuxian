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
  <PanelShell
    title="功法"
    hint="修炼 · 突破 · 领悟 · 装备"
    size="xl"
    :loading="loading"
    :error="error"
    @close="emit('close')"
    @retry="fetchList"
  >
    <!-- 空态一定要留在插槽里，不能交给 PanelShell 的 :empty：
         外壳的空态会整块替换掉 slot，连页签栏一起藏掉，
         于是"一本功法都还没习得"的新号再也点不到「可习得」，直接卡死在入门处。 -->
    <!-- 标签页切换 -->
    <Tabs v-model="view" :items="tabItems" class="mb-4" />

    <!-- 玩家资源联动展示：修炼/突破/研习消耗实时抵扣，操作后会自动刷新 -->
    <div class="flex items-center justify-between gap-3 mb-3 text-xs rounded-control border border-line-subtle bg-surface-raised px-3 py-2">
      <div class="flex flex-wrap gap-3">
        <span class="text-amber-300">灵石 <b class="text-amber-200 num">{{ formatCompact(playerSS) }}</b></span>
        <span class="text-sky-300">灵力 <b class="text-sky-200 num">{{ formatCompact(playerMP) }}<span v-if="playerStore.player?.mp_max"> / {{ formatCompact(playerStore.player.mp_max) }}</span></b></span>
        <span class="text-emerald-300">修为 <b class="text-emerald-200 num">{{ formatCompact(playerStore.player?.exp) }}</b></span>
      </div>
      <AppButton size="xs" variant="ghost" @click="fetchList">刷新</AppButton>
    </div>

    <!-- 已习得功法 -->
    <div v-if="view === 'owned'" class="space-y-3">
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
          <span class="text-xs text-fg-muted">第 {{ item.layer }} / {{ item.max_layer }} 层</span>
        </div>

        <!-- 熟练度进度 -->
        <div class="mt-2 flex items-center gap-2 text-xs text-fg-muted">
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
          >{{ formatBonus(key, val) }}</span>
        </div>

        <!-- 消耗预览：精确展示各操作消耗，并与实时余额对比，不足时标红 -->
        <div class="mt-1 text-xs space-y-0.5">
          <div class="text-fg-faint">今日修炼 {{ item.daily_practice_count }} / {{ item.daily_practice_limit }}</div>
          <div class="flex flex-wrap gap-x-3 gap-y-0.5">
            <span :class="enoughSS(item.practice_cost) ? 'text-amber-300/90' : 'text-rose-400'">修炼 灵石{{ item.practice_cost }}</span>
            <span :class="enoughMP(item.mp_cost) ? 'text-sky-300/90' : 'text-rose-400'">灵力{{ item.mp_cost }}</span>
            <span :class="enoughSS(item.breakthrough_cost) ? 'text-rose-300/90' : 'text-rose-400'">突破 灵石{{ item.breakthrough_cost }}</span>
            <span :class="enoughSS(item.comprehend_cost) ? 'text-purple-300/90' : 'text-rose-400'">领悟 灵石{{ item.comprehend_cost }}</span>
          </div>
          <!-- 灰按钮旁的常驻理由：hover title 在触屏上等于没有，必须有一行可见文案 -->
          <div v-if="practiceBlockReason(item)" class="text-rose-400/90">
            修炼不可用：{{ practiceBlockReason(item) }}
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="px-3 py-1 text-xs rounded bg-amber-800/50 hover:bg-amber-700/60 border border-amber-700/50"
            :disabled="!canPractice(item)"
            :class="canPractice(item) ? '' : 'opacity-40 cursor-not-allowed'"
            :title="practiceBlockReason(item) || '消耗灵石与灵力，提升熟练度'"
            @click="confirmPractice(item)"
          >修炼</button>
          <button
            class="px-3 py-1 text-xs rounded bg-rose-900/50 hover:bg-rose-800/60 border border-rose-700/50"
            :disabled="!canBreakthrough(item)"
            :class="canBreakthrough(item) ? '' : 'opacity-40 cursor-not-allowed'"
            :title="breakthroughBlockReason(item) || '熟练度满后突破，提升功法层数'"
            @click="confirmBreakthrough(item)"
          >突破</button>
          <button
            class="px-3 py-1 text-xs rounded bg-purple-900/50 hover:bg-purple-800/60 border border-purple-700/50"
            :disabled="!canComprehend(item)"
            :class="canComprehend(item) ? '' : 'opacity-40 cursor-not-allowed'"
            :title="comprehendBlockReason(item) || '消耗灵石，随机领悟一个神通'"
            @click="confirmComprehend(item)"
          >领悟神通</button>
          <template v-if="item.equip_slot">
            <button
              class="px-3 py-1 text-xs rounded bg-surface-active/50 hover:bg-surface-active/60 border border-line-strong/50"
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

        <!-- 神通槽位：已用/上限常驻展示；槽位 0 时点明「功法第 N 层解锁」，避免玩家对着报错猜「第三层」是什么 -->
        <div class="mt-2 text-xs text-purple-300">
          神通 {{ item.skill_slots_used ?? item.comprehended_skills?.length ?? 0 }} / {{ item.skill_slots_total ?? 0 }} 槽
          <span v-if="(item.skill_slots_total ?? 0) === 0 && item.next_skill_unlock_layer" class="text-fg-muted">
            · 功法修至第 {{ item.next_skill_unlock_layer }} 层解锁槽位
          </span>
          <span v-else-if="(item.skill_slots_used ?? 0) >= (item.skill_slots_total ?? 0) && item.next_skill_unlock_layer" class="text-fg-muted">
            · 已满，功法第 {{ item.next_skill_unlock_layer }} 层再解锁
          </span>
          <span v-if="item.comprehended_skills?.length" class="text-purple-200/80">
            （{{ item.comprehended_skills.length }} 项已悟）
          </span>
        </div>
      </div>
      <EmptyState
        v-if="!owned.length"
        text="尚未习得任何功法"
        hint="前往「可习得」页签研习一本入门功法，再回来运转周天"
      />
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
        <div v-if="tech.description" class="mt-1 text-xs text-fg-muted">{{ tech.description }}</div>
        <div v-if="tech.bonuses && Object.keys(tech.bonuses).length" class="mt-2 flex flex-wrap gap-1.5 text-xs">
          <span
            v-for="(val, key) in tech.bonuses"
            :key="key"
            class="px-1.5 py-0.5 rounded bg-black/20"
          >{{ formatBonus(key, val) }}</span>
        </div>
        <div class="mt-1 text-xs text-amber-300">
          研习途径：{{ acquireLabel(tech.acquire) }}
          <!-- 代价与"现在凑不凑得齐"都由服务端算（acquire_hint / acquire_ready）：
               以前这里自己读 acquire.cost_spirit_stones 判余额，而配置里那个键叫 cost_spirit_stone，
               判空结果永远算"够"，宗门贡献与残卷两种代价更是根本没看 —— 按钮于是专门骗人。 -->
          <span
            v-if="tech.acquire_hint"
            :class="tech.acquire_ready === false ? 'text-rose-400' : 'text-amber-300/90'"
          >（{{ tech.acquire_hint }}{{ tech.acquire_ready === false ? '·不足' : '' }}）</span>
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
      <div v-if="!available.length" class="text-center text-fg-faint py-10 text-sm">暂无可习得的功法</div>
    </div>

    <!-- 系统设置 -->
    <div v-else-if="view === 'settings'" class="space-y-2 text-sm">
      <div class="rounded-lg border border-line/50 p-3 space-y-1">
        <div class="flex justify-between"><span class="text-fg-muted">功法系统</span><span>{{ settings.enabled ? '开放' : '关闭' }}</span></div>
        <div class="flex justify-between"><span class="text-fg-muted">主修槽位上限</span><span>{{ settings.max_equipped_main }}</span></div>
        <div class="flex justify-between"><span class="text-fg-muted">辅修槽位上限</span><span>{{ settings.max_equipped_auxiliary }}</span></div>
        <div class="flex justify-between"><span class="text-fg-muted">每日修炼上限</span><span>{{ settings.daily_practice_limit }}</span></div>
        <div class="flex justify-between"><span class="text-fg-muted">修炼冷却</span><span>{{ settings.practice_cooldown_seconds }} 秒</span></div>
        <div class="flex justify-between"><span class="text-fg-muted">你的悟性</span><span>{{ wisdom }}</span></div>
      </div>
      <div class="text-xs text-fg-faint leading-relaxed">
        说明：修炼消耗灵石与灵力提升熟练度；熟练度达标后可突破升阶，突破有成功率与保底。
        可装备 1 个主修与多个辅修功法，主修切换需付出代价。神通需在已修功法上领悟，
        槽位数随功法层数解锁。
      </div>
    </div>

    <!-- 二次确认弹窗
         Modal 的开关属性是 isOpen，正文走默认插槽、按钮走 #footer 插槽；
         它并没有 message/confirmText/cancelText/type 这几个 prop。
         之前直接当确认框用，于是这里渲染出来是一个只有标题和 ✕ 的空盒子，
         修炼/突破/领悟的确认按钮根本不存在，整条操作流程走不到。 -->
    <Modal
      :is-open="confirmModal.show"
      :title="confirmModal.title"
      @close="closeConfirm"
    >
      <p class="text-sm leading-relaxed text-fg-secondary whitespace-pre-line">{{ confirmModal.message }}</p>
      <template #footer>
        <AppButton variant="outline" @click="closeConfirm">{{ confirmModal.cancelText }}</AppButton>
        <AppButton
          :variant="confirmModal.type === 'danger' || confirmModal.type === 'error' ? 'danger' : 'primary'"
          @click="confirmModal.onConfirm"
        >{{ confirmModal.confirmText }}</AppButton>
      </template>
    </Modal>

    <!-- 处理遮罩：absolute 定位到 PanelShell 的 .panel-body，盖住整块面板 -->
    <div v-if="busy" class="absolute inset-0 z-10 grid place-items-center bg-black/55 backdrop-blur-[1px]">
      <div class="flex items-center gap-2 text-[13px] text-gold-300">
        <span class="inline-block w-4 h-4 rounded-full border-2 border-gold-700 border-t-gold-400 animate-spin"></span>
        运转功法中…
      </div>
    </div>
  </PanelShell>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useUIStore } from '../../stores/ui'
import { useAsyncTask } from '../../composables/useAsyncTask'
import { useStatSchema } from '../../composables/useStatSchema'
import { usePlayerStore } from '../../stores/player'
import { formatCompact } from '../../utils/format'
import Modal from '../common/Modal.vue'
import PanelShell from '../ui/PanelShell.vue'
import Tabs from '../ui/Tabs.vue'
import AppButton from '../ui/AppButton.vue'
import EmptyState from '../ui/EmptyState.vue'
import {
  getTechniqueList,
  learnTechnique,
  practiceTechnique,
  breakthroughTechnique,
  comprehendTechnique,
  equipTechnique
} from '../../api/technique'

import { usePlayerResources } from '../../composables/usePlayerResources'

const uiStore = useUIStore()
const playerStore = usePlayerStore()
const { spiritStones: playerSS, mp: playerMP, enoughSpirit, enoughMp, patchFromResponse } = usePlayerResources()
const emit = defineEmits(['close'])

/** 标签页定义（key/label 契约见 ui/Tabs.vue） */
const tabItems = [
  { key: 'owned', label: '已习得' },
  { key: 'available', label: '可习得' },
  { key: 'settings', label: '系统' }
]

/** 组件状态 */
const view = ref('owned')
const payload = ref(null)
const { loading, error, run } = useAsyncTask({ fallback: '获取功法总览失败' })
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

/**
 * 玩家实时余额：走 usePlayerResources 统一契约（规范字段 mp_current/spirit_stones）。
 * 旧写法各面板自己猜字段名（曾读不存在的 player.mp → 恒 0），是「左侧 10 万、面板 0」的根因。
 */
/** 灵石是否足够 */
const enoughSS = (cost) => enoughSpirit(cost)
/** 灵力是否足够 */
const enoughMP = (cost) => enoughMp(cost)

/** 切换标签页 */

/** 关闭弹窗 */
const closeConfirm = () => { confirmModal.value.show = false }

/** 统一二次确认构造 */
const openConfirm = (opts) => {
  confirmModal.value = { show: true, confirmText: '确认', cancelText: '取消', type: 'warning', ...opts }
}

/**
 * 品阶色（取自后端 grade_color，兜底默认）
 *
 * 这里的兜底色必须保持十六进制字面量：下面靠拼接 '66' / '14' 两个
 * alpha 后缀得到描边和底色，换成 rgb(var(--x)) 就拼不动了。
 * 文字色没有这个约束，取令牌。
 */
const gradeStyle = (color) => {
  const c = color || '#78716c'
  return {
    borderColor: `${c}66`,
    background: `${c}14`,
    color: 'rgb(var(--fg-primary))'
  }
}

/** 熟练度百分比 */
const profPercent = (item) => {
  const req = item.required_proficiency || 1
  return Math.min(100, Math.round((item.proficiency / req) * 100))
}

/**
 * 按钮禁用理由：灰按钮必须能自解释，否则玩家只会看到「点不了」——
 * 上一轮就是因为灵力 0 / 修炼要 4.5 万灵力，按钮灰着却没有任何提示。
 * 返回 null 表示可以点。
 */
const practiceBlockReason = (item) => {
  if (item.proficiency >= item.required_proficiency) return '熟练度已满，可尝试突破'
  if (item.daily_practice_count >= item.daily_practice_limit) return '今日修炼次数已用完'
  if (!enoughSS(item.practice_cost)) return `灵石不足（需 ${item.practice_cost}）`
  if (!enoughMP(item.mp_cost)) return `灵力不足（需 ${item.mp_cost}，当前 ${playerMP.value}），可闭关回满灵力后再修`
  return null
}
const breakthroughBlockReason = (item) => {
  if (item.is_max_layer) return '已至满层'
  if (item.proficiency < item.required_proficiency) return `熟练度不足（${item.proficiency}/${item.required_proficiency}）`
  if (!enoughSS(item.breakthrough_cost)) return `灵石不足（需 ${item.breakthrough_cost}）`
  return null
}
const comprehendBlockReason = (item) => {
  const used = item.skill_slots_used ?? item.comprehended_skills?.length ?? 0
  const total = item.skill_slots_total ?? 0
  if (used >= total) {
    return item.next_skill_unlock_layer
      ? `神通槽位已满，功法修至第 ${item.next_skill_unlock_layer} 层再解锁`
      : '神通槽位已满'
  }
  if (!enoughSS(item.comprehend_cost)) return `灵石不足（需 ${item.comprehend_cost}）`
  return null
}

/** 是否可修炼：熟练度未满 + 今日未超限 + 灵石/灵力余额足够 */
const canPractice = (item) => !practiceBlockReason(item)

/** 是否可突破：未达满层 + 熟练度达标 + 灵石余额足够 */
const canBreakthrough = (item) => !breakthroughBlockReason(item)

/**
 * 是否可领悟神通：有空余槽位 + 灵石余额足够。
 * 槽位上限以前读 skillSlotsTotal（后端从未下发，恒 undefined → 兜底 1），
 * 于是功法 1 层（0 槽）按钮仍可点，点下去才被服务端拒。改读后端 skill_slots_total。
 */
const canComprehend = (item) => !comprehendBlockReason(item)

/**
 * 是否可研习：境界达标 + 代价凑得齐。
 * 代价这一半读服务端算好的 acquire_ready（灵石 / 宗门贡献 / 残卷三种分支都在同一处判），
 * 前端不再自己拼键名 —— 缺字段时按"允许点"处理，真正的拒绝仍由 learnTechnique 在事务里给出理由。
 */
const canLearn = (tech) => !!tech.realm_satisfied && tech.acquire_ready !== false

/**
 * 属性加成字段中文标签：取自服务端属性注册表（含别名 crit/dodge/hp_steal 与资料片属性）。
 * 旧实现在这里抄了一份 11 行的标签表，功法加一个属性就要来改一次前端。
 */
const { formatBonus } = useStatSchema()

/** 五行标签 */
const elementLabel = (el) => {
  const map = { metal: '金', wood: '木', water: '水', fire: '火', earth: '土', none: '无' }
  return map[el] || el
}

/**
 * 研习途径文案：只负责"这条途径叫什么"，代价的数字一律用服务端给的 hint
 * （以前这里自己按 source 拼 cost_spirit_stone / sect_contribution，配置一改键名就静默少一段文案）。
 */
const acquireLabel = (acquire, hint) => {
  const text = hint ? `（${hint}）` : ''
  if (!acquire) return '未知'
  const src = { default: '新手指引', shop: '灵石购买', sect: '宗门贡献', secret_realm: '秘境奇遇', recipe_scroll: '残卷研习' }
  const label = src[acquire.source] || acquire.source
  return acquire.source === 'secret_realm' ? `${label}（不可主动研习）` : `${label}${text}`
}

/** 拉取功法总览 */
const fetchList = () => run(async () => {
  const res = await getTechniqueList()
  payload.value = res.data?.data || res.data || {}
})

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
    message: `确认修炼《${item.name}》？\n消耗 灵石 ${item.practice_cost}（余额 ${playerSS.value}）、灵力 ${item.mp_cost}（余额 ${playerMP.value}）提升熟练度。`,
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
    uiStore.showApiError(err, '修炼失败')
  } finally {
    busy.value = false
  }
}

/** 突破确认 */
const confirmBreakthrough = (item) => {
  if (!canBreakthrough(item)) { uiStore.showToast('熟练度不足或已至圆满', 'warning'); return }
  openConfirm({
    title: '突破功法',
    message: `确认突破《${item.name}》？\n消耗灵石 ${item.breakthrough_cost}（余额 ${playerSS.value}），当前突破成功率约 ${Math.round((item.breakthrough_rate || 0) * 100)}%。`,
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
    uiStore.showApiError(err, '突破失败')
  } finally {
    busy.value = false
  }
}

/** 领悟神通确认 */
const confirmComprehend = (item) => {
  const used = item.skill_slots_used ?? item.comprehended_skills?.length ?? 0
  const total = item.skill_slots_total ?? 0
  openConfirm({
    title: '领悟神通',
    message: `确认对《${item.name}》进行神通领悟？\n消耗灵石 ${item.comprehend_cost}（余额 ${playerSS.value}），成败凭机缘。\n神通槽位 ${used}/${total}。`,
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
    uiStore.showApiError(err, '领悟失败')
  } finally {
    busy.value = false
  }
}

/** 研习确认 */
const confirmLearn = (tech) => {
  if (!tech.realm_satisfied) { uiStore.showToast('境界不足，无法研习', 'warning'); return }
  openConfirm({
    title: '研习功法',
    message: `确认研习《${tech.name}》？\n${acquireLabel(tech.acquire, tech.acquire_hint)}`,
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
    uiStore.showApiError(err, '研习失败')
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

    lines.push(`· 灵石代价：${costSS}（余额 ${playerSS.value}）`)
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
    if (costSS > playerSS.value) {
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
    uiStore.showApiError(err, '装备失败')
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
    uiStore.showApiError(err, '卸下失败')
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

