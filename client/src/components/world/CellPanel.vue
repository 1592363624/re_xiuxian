<script setup>
/**
 * 脚下格操作板（L2/L3 的 UI 形状）
 * 只对「当前脚下」展示世界行动；其他格只读详情 + 路径摘要。
 */
import { computed } from 'vue'
import { TERRAIN, CELL_TYPE, CELL_SIZE, cellToWorld } from '../../world/gridWorld'
import { RESOURCE_NAMES, PLACE_ACTIONS } from '../../world/regions'

const props = defineProps({
  cell: { type: Object, default: null },
  isSelf: { type: Boolean, default: true },
  visibility: { type: String, default: 'visible' },
  pathPreview: { type: Object, default: null },
  visionR: { type: Number, default: 3 },
  regionName: { type: String, default: '' },
  zoneName: { type: String, default: '' },
  cellX: { type: Number, default: 0 },
  cellY: { type: Number, default: 0 },
  sensePool: { type: Number, default: 0 },
})
const emit = defineEmits(['action', 'depart', 'cancel-path', 'open-panel'])

const terr = computed(() => TERRAIN[props.cell?.terrain] || TERRAIN.plains)
const meta = computed(() => CELL_TYPE[props.cell?.cell_type] || CELL_TYPE.empty)
const resName = computed(() => {
  const id = props.cell?.resource?.id
  return id ? (RESOURCE_NAMES[id] || id) : ''
})
const actions = computed(() => {
  if (!props.cell) return []
  const key = props.cell.cell_type === 'empty' && props.cell.resource ? 'resource' : props.cell.cell_type
  return PLACE_ACTIONS[key] || PLACE_ACTIONS.wild
})
const primary = computed(() => actions.value.find(a => a.primary))
const secondaries = computed(() => actions.value.filter(a => !a.primary))
const canAct = computed(() => props.isSelf && props.visibility === 'visible')
</script>

<template>
  <aside class="w-[260px] shrink-0 border-r border-line-subtle bg-surface-base flex flex-col min-h-0">
    <!-- 位置条 -->
    <div class="px-3 py-2 border-b border-line-subtle">
      <div class="text-[10px] tracking-[0.2em] text-fg-faint font-display">脚下 · 操作台</div>
      <div class="mt-1 text-[13px] font-bold text-gold-400 truncate">
        {{ regionName || '未知疆域' }}
        <span class="text-fg-faint font-normal">›</span>
        <span class="text-emerald-400">{{ zoneName || '—' }}</span>
      </div>
      <div class="mt-0.5 text-[12px] text-fg-muted num">
        格 ({{ cellX }}, {{ cellY }})
        <span class="text-fg-faint ml-1">视野 R={{ visionR }}</span>
      </div>
    </div>

    <!-- 格详情 -->
    <div class="p-3 border-b border-line-subtle space-y-2">
      <div class="flex items-start gap-2">
        <div class="w-10 h-10 rounded border border-line flex items-center justify-center text-lg shrink-0 bg-surface-canvas">
          {{ meta.icon || '·' }}
        </div>
        <div class="min-w-0">
          <div class="text-[14px] font-bold text-fg-primary truncate">{{ cell?.name || meta.name }}</div>
          <div class="text-[11px] text-fg-faint">
            {{ terr.name }}
            <span v-if="cell?.danger" class="ml-1" :class="cell.danger >= 4 ? 'text-rose-400' : 'text-fg-muted'">
              危险 {{ cell.danger }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="!isSelf" class="text-[11px] text-amber-500/90 bg-amber-900/20 border border-amber-800/40 rounded px-2 py-1.5">
        不是脚下格 · 只可规划路径，不能操作
      </div>
      <div v-else-if="visibility === 'known'" class="text-[11px] text-fg-faint bg-surface-canvas border border-line-subtle rounded px-2 py-1.5">
        记忆中的样子 · 可能已过期
      </div>
      <div v-else-if="visibility === 'unknown'" class="text-[11px] text-fg-faint">迷雾未开</div>

      <!-- 资源 -->
      <div v-if="cell?.resource" class="text-[12px] text-emerald-300 flex items-center gap-2">
        <span>❖ {{ resName }}</span>
        <span class="text-fg-faint">×{{ cell.resource.amount }}</span>
      </div>

      <!-- 子区域 / 传送 -->
      <div v-if="cell?.sub_region_id" class="text-[11px] text-gold-300/90">
        可进入子区域 · {{ cell.sub_region_id }}
      </div>
      <div v-if="cell?.portal_id" class="text-[11px] text-cyan-300/90">
        传送阵 · {{ cell.portal_id }}
      </div>
    </div>

    <!-- 路径预览摘要 -->
    <div v-if="pathPreview" class="p-3 border-b border-line-subtle space-y-2">
      <div class="text-[10px] tracking-[0.2em] text-fg-faint font-display">路径预览</div>
      <div class="text-[12px] text-fg-secondary">
        前往 ({{ pathPreview.to.x }}, {{ pathPreview.to.y }}) ·
        <b class="text-sky-300">{{ pathPreview.steps }}</b> 格 ·
        约 <b class="text-sky-300">{{ pathPreview.seconds }}</b>s
      </div>
      <div v-if="pathPreview.hazards.length" class="text-[11px] text-rose-400">
        途经危险：{{ pathPreview.hazards.map(h => h.label).join('、') }}
      </div>
      <div class="flex gap-2">
        <button
          class="flex-1 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white text-[13px] font-bold"
          @click="emit('depart')"
        >启程</button>
        <button
          class="px-3 py-2 rounded border border-line text-[12px] text-fg-muted hover:text-fg-primary"
          @click="emit('cancel-path')"
        >取消</button>
      </div>
    </div>

    <!-- 行动按钮 -->
    <div class="p-3 flex-1 min-h-0 overflow-y-auto">
      <div class="text-[10px] tracking-[0.2em] text-fg-faint font-display mb-2">
        {{ canAct ? '此刻可做' : '（走到此格才能动手）' }}
      </div>

      <template v-if="canAct">
        <button
          v-if="primary"
          class="w-full py-3 rounded-lg bg-gold-700/80 hover:bg-gold-600/90 text-[14px] font-bold text-white tracking-wider mb-2"
          @click="emit('action', { id: primary.action || primary.id, label: primary.label, cell })"
        >{{ primary.label }}</button>

        <div class="grid grid-cols-1 gap-1.5">
          <button
            v-for="a in secondaries"
            :key="a.id + a.label"
            class="py-2 rounded border border-line-subtle bg-surface-raised text-[12px] text-fg-secondary hover:text-gold-500 hover:border-line"
            @click="emit('action', { id: a.action || a.id, label: a.label, cell })"
          >{{ a.label }}</button>
        </div>

        <button
          v-if="cell?.hidden"
          class="w-full mt-2 py-2 rounded border border-purple-700/50 text-purple-300 text-[12px] hover:bg-purple-900/20"
          @click="emit('action', { id: 'probe', label: '神识探查', cell })"
        >神识探查（扣神识池）</button>
      </template>

      <p v-else class="text-[11px] text-fg-faint leading-relaxed">
        世界行动只发生在脚下。先在地图上点一格，走到那儿，这里才会长出按钮。
      </p>
    </div>
  </aside>
</template>
