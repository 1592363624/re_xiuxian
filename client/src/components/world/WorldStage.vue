<script setup>
/**
 * 大地图主舞台（L1：常驻中央，不是可开关的面板）
 * - 确定性格子 + 迷雾三态
 * - 点终点 → 路径预览 → 启程
 * - 选中格与脚下格分离
 */
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  generateCell, getRegionCells, visibilityMap, findPath, pathSeconds, collectHazards,
  worldToCell, cellToWorld, radiusFromSense, TERRAIN, CELL_TYPE, CELL_SIZE,
} from '../../world/gridWorld'
import { resolveRegion, RESOURCE_NAMES } from '../../world/regions'
import { getWorldState, moveWorld, getWorldPlayers } from '../../api/world'
import { usePlayerStore } from '../../stores/player'
import { useUIStore } from '../../stores/ui'
import { socketService } from '../../services/socket'

const playerStore = usePlayerStore()
const uiStore = useUIStore()
const emit = defineEmits(['cell-select', 'path-preview', 'action', 'region-ready'])

const canvasRef = ref(null)
const loading = ref(true)
const region = ref(null)
const cells = ref([])
const vis = ref([])
const known = ref(new Set())
const selfCell = reactive({ x: 0, y: 7 })
const selected = ref(null)
const pathPreview = ref(null)
const players = ref([])
const visionR = ref(3)

const view = reactive({ x: 6, y: 6, scale: 22 })
// 格子默认 22px：原先 36px 在宽屏上一格过大、整图只露出一角，
// 既浪费中间舞台又看不全周围；22px 一次能多看一圈，滚轮仍可放大到 72。
const DEFAULT_PX = 22

let raf = null
let drag = null
let resizeObs = null
let socketOff = null
let pollTimer = null
let arriveTimer = null

const width = computed(() => region.value?.size[0] || 12)
const height = computed(() => region.value?.size[1] || 12)

function cellAt(x, y) {
  if (!region.value) return null
  if (x < 0 || y < 0 || x >= width.value || y >= height.value) return null
  return cells.value[y * width.value + x] || null
}

function refreshVis() {
  vis.value = visibilityMap(region.value, selfCell.x, selfCell.y, visionR.value, known.value)
  // 写入 known
  for (let y = 0; y < height.value; y++) {
    for (let x = 0; x < width.value; x++) {
      if (vis.value[y * width.value + x] === 'visible') known.value.add(`${x},${y}`)
    }
  }
}

function loadRegion(reg) {
  region.value = reg
  cells.value = getRegionCells(reg)
  // 出生/落在区域中心附近
  const spawn = reg.spawn_cells?.[0] || [Math.floor(reg.size[0] / 2), Math.floor(reg.size[1] / 2)]
  // 若已有世界坐标则反算
  const ws = playerStore.worldState
  if (ws && ws.pos_x != null) {
    const c = worldToCell(Number(ws.pos_x), Number(ws.pos_y), reg.anchor, CELL_SIZE)
    selfCell.x = Math.min(Math.max(c.x, 0), reg.size[0] - 1)
    selfCell.y = Math.min(Math.max(c.y, 0), reg.size[1] - 1)
  } else {
    selfCell.x = spawn[0]
    selfCell.y = spawn[1]
  }
  visionR.value = radiusFromSense(Number(playerStore.player?.sense || playerStore.player?.attributes?.sense || 10))
  refreshVis()
  view.x = selfCell.x
  view.y = selfCell.y
  view.scale = DEFAULT_PX
  emit('region-ready', {
    region: reg,
    cell: cellAt(selfCell.x, selfCell.y),
    self: { ...selfCell },
    visionR: visionR.value,
  })
}

async function bootstrap() {
  loading.value = true
  try {
    let mapId = playerStore.worldState?.map_id
    let mapName = playerStore.worldState?.map_name
    if (!mapId) {
      try {
        await playerStore.fetchWorldState?.()
      } catch { /* offline */ }
      mapId = playerStore.worldState?.map_id
      mapName = playerStore.worldState?.map_name
    }
    // 侧栏旧位置显示「彩霞山」等 map_name
    if (!mapName && playerStore.player) mapName = playerStore.player.current_map_name || ''
    const reg = resolveRegion(mapId, mapName)
    loadRegion(reg)
    try {
      const res = await getWorldPlayers()
      players.value = res.data?.data?.players || res.data?.players || []
    } catch { players.value = [] }
  } finally {
    loading.value = false
    ensureSize()
    raf = requestAnimationFrame(loop)
  }
}

function ensureSize() {
  const cv = canvasRef.value
  if (!cv) return
  const parent = cv.parentElement
  const w = parent?.clientWidth || 800
  const h = parent?.clientHeight || 600
  const dpr = window.devicePixelRatio || 1
  cv.width = Math.floor(w * dpr)
  cv.height = Math.floor(h * dpr)
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function screenToWorld(sx, sy) {
  const cv = canvasRef.value
  const w = cv.clientWidth
  const h = cv.clientHeight
  const wx = view.x + (sx - w / 2) / view.scale
  const wy = view.y + (sy - h / 2) / view.scale
  return { x: wx, y: wy }
}

function cellFromEvent(e) {
  const rect = canvasRef.value.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const w = screenToWorld(sx, sy)
  return { x: Math.floor(w.x), y: Math.floor(w.y) }
}

function onPointerDown(e) {
  canvasRef.value.setPointerCapture?.(e.pointerId)
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
}

function onPointerMove(e) {
  if (!drag) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
  view.x = drag.vx - dx / view.scale
  view.y = drag.vy - dy / view.scale
}

function onPointerUp(e) {
  const wasDrag = drag?.moved
  drag = null
  if (wasDrag) return
  const c = cellFromEvent(e)
  handleCellClick(c.x, c.y)
}

function onWheel(e) {
  const rect = canvasRef.value.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const before = screenToWorld(sx, sy)
  const factor = e.deltaY > 0 ? 0.9 : 1.1
  view.scale = Math.min(72, Math.max(14, view.scale * factor))
  const after = screenToWorld(sx, sy)
  view.x += before.x - after.x
  view.y += before.y - after.y
}

function handleCellClick(x, y) {
  const cell = cellAt(x, y)
  if (!cell) return
  selected.value = { x, y }
  emit('cell-select', {
    cell,
    isSelf: x === selfCell.x && y === selfCell.y,
    visibility: vis.value[y * width.value + x],
  })

  // 脚下：不规划路径
  if (x === selfCell.x && y === selfCell.y) {
    pathPreview.value = null
    emit('path-preview', null)
    return
  }

  // 目标：路径预览
  const from = { x: selfCell.x, y: selfCell.y }
  const to = { x, y }
  const path = findPath(region.value, cells.value, from, to)
  if (!path) {
    uiStore.showToast('此路不通，换一格试试', 'warning')
    pathPreview.value = null
    emit('path-preview', null)
    return
  }
  const secs = pathSeconds(path)
  const hazards = collectHazards(cells.value, width.value, path)
  pathPreview.value = {
    path,
    seconds: secs,
    steps: path.length - 1,
    hazards,
    to: { x, y },
    toCell: cell,
  }
  emit('path-preview', pathPreview.value)
}

function confirmMove() {
  const pv = pathPreview.value
  if (!pv) return
  const dest = cellToWorld(pv.to.x, pv.to.y, region.value.anchor, CELL_SIZE)
  const steps = pv.steps
  const ms = Math.max(350, pv.seconds * 1000)
  uiStore.showToast(`启程 · ${pv.steps} 格 · 约 ${pv.seconds}s`, 'info')
  emit('action', { type: 'depart', pathPreview: pv })

  // 服务端权威移动（连续坐标）；本地先播走路
  moveWorld(dest.x, dest.y).catch((e) => {
    console.warn('[WorldStage] moveWorld', e)
  })

  // 逐步走格：途中强制事件（据点）停在前一格并结算（§13.5）
  if (arriveTimer) clearInterval(arriveTimer)
  const fullPath = pv.path.slice()
  let i = 1
  const tick = Math.max(120, ms / Math.max(steps, 1))
  arriveTimer = setInterval(() => {
    if (i >= fullPath.length) {
      clearInterval(arriveTimer)
      arriveTimer = null
      selfCell.x = pv.to.x
      selfCell.y = pv.to.y
      pathPreview.value = null
      refreshVis()
      const cell = cellAt(selfCell.x, selfCell.y)
      emit('action', { type: 'arrive', cell, self: { ...selfCell } })
      emit('cell-select', { cell, isSelf: true, visibility: 'visible' })
      emit('path-preview', null)
      return
    }

    const next = fullPath[i]
    const nextCell = cellAt(next.x, next.y)

    // 路径级强制事件：下一格是据点 → 停在当前格结算
    if (nextCell?.cell_type === 'monster_nest' && !(next.x === pv.to.x && next.y === pv.to.y)) {
      clearInterval(arriveTimer)
      arriveTimer = null
      pathPreview.value = null
      refreshVis()
      const here = cellAt(selfCell.x, selfCell.y)
      emit('action', {
        type: 'force-event',
        cell: nextCell,
        self: { ...selfCell },
        standOn: here,
        blockedBy: next,
      })
      emit('cell-select', { cell: here, isSelf: true, visibility: 'visible' })
      emit('path-preview', null)
      return
    }

    selfCell.x = next.x
    selfCell.y = next.y
    refreshVis()
    i += 1
  }, tick)
}

function cancelPath() {
  if (arriveTimer) { clearInterval(arriveTimer); arriveTimer = null }
  pathPreview.value = null
  emit('path-preview', null)
}

function centerOnSelf() {
  view.x = selfCell.x
  view.y = selfCell.y
}

/** 同图其他玩家实时坐标（socket 推送时合并进列表） */
function syncOtherPlayer(p) {
  const pid = Number(p.player_id)
  const existing = players.value.find(q => Number(q.id ?? q.player_id) === pid)
  const next = {
    id: pid,
    player_id: pid,
    name: p.name || p.nickname || existing?.name || '道友',
    realm: p.realm || existing?.realm || '',
    pos_x: Number(p.pos_x),
    pos_y: Number(p.pos_y),
  }
  if (existing) Object.assign(existing, next)
  else players.value.push(next)
}

/**
 * 他人动向写进修仙录（竖条日志的主内容）。
 * 进/出视野各记一条；视野内赶路按人节流，避免连续移动把日志刷爆。
 */
const otherLogAt = new Map()
const otherInSight = new Map()
function logOtherActivity(p) {
  const pid = Number(p.player_id)
  const name = p.name || p.nickname || '道友'
  const pc = worldToCell(Number(p.pos_x || 0), Number(p.pos_y || 0), region.value?.anchor || [0, 0], CELL_SIZE)
  const inMap = !region.value || (pc.x >= 0 && pc.y >= 0 && pc.x < width.value && pc.y < height.value)
  const dist = inMap
    ? Math.max(Math.abs(pc.x - selfCell.x), Math.abs(pc.y - selfCell.y))
    : 999
  const saw = otherInSight.get(pid) || false
  const nowSee = inMap && dist <= visionR.value + 2

  if (nowSee && !saw) {
    otherInSight.set(pid, true)
    uiStore.addLog({
      content: `${name} 来到了你附近`,
      type: 'join',
      actorId: 'other',
    })
  } else if (!nowSee && saw) {
    otherInSight.set(pid, false)
    uiStore.addLog({
      content: `${name} 离开了你的视野`,
      type: 'leave',
      actorId: 'other',
    })
    return
  }

  if (!nowSee) return
  const now = Date.now()
  const last = otherLogAt.get(pid) || 0
  if (now - last < 10000) return
  otherLogAt.set(pid, now)
  const zone = cellAt(pc.x, pc.y)?.zone_name || p.map_name || '野外'
  uiStore.addLog({
    content: `${name} 在${zone}一带走动`,
    type: 'movement',
    actorId: 'other',
  })
}

function loop() {
  draw()
  raf = requestAnimationFrame(loop)
}

function draw() {
  const cv = canvasRef.value
  if (!cv || !region.value) return
  const ctx = cv.getContext('2d')
  const w = cv.clientWidth
  const h = cv.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#0c0f0e'
  ctx.fillRect(0, 0, w, h)

  const s = view.scale
  const ox = w / 2 - view.x * s
  const oy = h / 2 - view.y * s

  for (let y = 0; y < height.value; y++) {
    for (let x = 0; x < width.value; x++) {
      const cell = cells.value[y * width.value + x]
      const v = vis.value[y * width.value + x] || 'unknown'
      const px = ox + x * s
      const py = oy + y * s

      if (v === 'unknown') {
        ctx.fillStyle = '#121614'
        ctx.fillRect(px, py, s - 1, s - 1)
        continue
      }

      const terr = TERRAIN[cell.terrain] || TERRAIN.plains
      let fill = terr.color
      if (v === 'known') {
        // 记忆做旧
        ctx.globalAlpha = 0.55
        fill = shade(terr.color, -18)
      }

      ctx.fillStyle = fill
      ctx.fillRect(px, py, s - 1, s - 1)

      // 分区细线（已知）
      if (v === 'visible') {
        ctx.strokeStyle = 'rgba(255,255,255,0.04)'
        ctx.strokeRect(px + 0.5, py + 0.5, s - 2, s - 2)
      }

      // 内容图标
      const meta = CELL_TYPE[cell.cell_type] || CELL_TYPE.empty
      if (cell.cell_type !== 'empty') {
        ctx.font = `bold ${Math.max(11, s * 0.38)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = v === 'known' ? 'rgba(220,200,140,0.55)' : iconColor(cell.cell_type)
        ctx.fillText(meta.icon || '·', px + s / 2, py + s / 2)
        if (s >= 28 && cell.name && v === 'visible') {
          ctx.font = `${Math.max(9, s * 0.22)}px sans-serif`
          ctx.fillStyle = 'rgba(240,230,200,0.7)'
          ctx.fillText(cell.name.slice(0, 4), px + s / 2, py + s - 8)
        }
      } else if (cell.resource && v === 'visible') {
        ctx.fillStyle = '#7ddea0'
        ctx.font = `${Math.max(10, s * 0.32)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('❖', px + s / 2, py + s / 2)
      }

      // 危险角标
      if (v === 'visible' && (cell.danger || 0) >= 4) {
        ctx.fillStyle = 'rgba(248,113,113,0.85)'
        ctx.beginPath()
        ctx.moveTo(px + s - 8, py + 2)
        ctx.lineTo(px + s - 2, py + 2)
        ctx.lineTo(px + s - 2, py + 8)
        ctx.closePath()
        ctx.fill()
      }

      ctx.globalAlpha = 1
    }
  }

  // 路径预览
  if (pathPreview.value) {
    const p = pathPreview.value.path
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < p.length; i++) {
      const cx = ox + (p[i].x + 0.5) * s
      const cy = oy + (p[i].y + 0.5) * s
      if (i === 0) ctx.moveTo(cx, cy)
      else ctx.lineTo(cx, cy)
    }
    ctx.stroke()

    // 危险格红圈
    for (const hz of pathPreview.value.hazards) {
      ctx.strokeStyle = '#f87171'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(ox + (hz.x + 0.5) * s, oy + (hz.y + 0.5) * s, s * 0.35, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 终点
    const t = pathPreview.value.to
    ctx.strokeStyle = '#22d3ee'
    ctx.lineWidth = 2
    ctx.strokeRect(ox + t.x * s + 2, oy + t.y * s + 2, s - 5, s - 5)
  }

  // 选中格
  if (selected.value) {
    ctx.strokeStyle = '#22d3ee'
    ctx.lineWidth = 2
    ctx.strokeRect(ox + selected.value.x * s + 1, oy + selected.value.y * s + 1, s - 3, s - 3)
  }

  // 其他玩家
  for (const p of players.value) {
    // 旧连续坐标 → 近似格
    const pc = worldToCell(Number(p.pos_x || 0), Number(p.pos_y || 0), region.value.anchor, CELL_SIZE)
    if (pc.x === selfCell.x && pc.y === selfCell.y) continue
    if (vis.value[pc.y * width.value + pc.x] !== 'visible') continue
    ctx.fillStyle = '#38bdf8'
    ctx.beginPath()
    ctx.arc(ox + (pc.x + 0.5) * s, oy + (pc.y + 0.5) * s, s * 0.14, 0, Math.PI * 2)
    ctx.fill()
  }

  // 自己
  {
    const px = ox + selfCell.x * s
    const py = oy + selfCell.y * s
    ctx.strokeStyle = '#fbbf24'
    ctx.lineWidth = 2.5
    ctx.strokeRect(px + 1.5, py + 1.5, s - 4, s - 4)
    ctx.fillStyle = '#fbbf24'
    ctx.beginPath()
    ctx.arc(px + s / 2, py + s / 2, s * 0.18, 0, Math.PI * 2)
    ctx.fill()
  }

  // 视野圈
  ctx.strokeStyle = 'rgba(251,191,36,0.25)'
  ctx.setLineDash([4, 4])
  ctx.lineWidth = 1
  ctx.strokeRect(
    ox + (selfCell.x - visionR.value) * s,
    oy + (selfCell.y - visionR.value) * s,
    (visionR.value * 2 + 1) * s,
    (visionR.value * 2 + 1) * s,
  )
  ctx.setLineDash([])
}

function shade(hex, amt) {
  const n = hex.replace('#', '')
  let r = parseInt(n.slice(0, 2), 16) + amt
  let g = parseInt(n.slice(2, 4), 16) + amt
  let b = parseInt(n.slice(4, 6), 16) + amt
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b))
  return `rgb(${r},${g},${b})`
}

function iconColor(type) {
  const map = {
    resource: '#7ddea0',
    monster_nest: '#f87171',
    ruin_small: '#c4b5fd',
    ruin_large: '#fbbf24',
    cave_player: '#a8a29e',
    sect: '#7dd3fc',
    town: '#fda4af',
    portal: '#67e8f9',
    barrier: '#fca5a5',
  }
  return map[type] || '#d6d3d1'
}

onMounted(() => {
  bootstrap()
  resizeObs = new ResizeObserver(() => ensureSize())
  if (canvasRef.value?.parentElement) resizeObs.observe(canvasRef.value.parentElement)

  socketOff = socketService.on('world:player-moved', (data) => {
    const p = data?.player
    if (!p || !playerStore.player) return
    const myId = Number(playerStore.player.id)
    const pid = Number(p.player_id)
    if (pid === myId) {
      const c = worldToCell(Number(p.pos_x), Number(p.pos_y), region.value?.anchor || [0, 0], CELL_SIZE)
      selfCell.x = c.x
      selfCell.y = c.y
      refreshVis()
      emit('cell-select', { cell: cellAt(c.x, c.y), isSelf: true, visibility: 'visible' })
      return
    }

    // 同图其他人：即时进列表，并把「谁在附近动了」写进修仙录
    syncOtherPlayer(p)
    logOtherActivity(p)
  })

  pollTimer = setInterval(async () => {
    try {
      const res = await getWorldPlayers()
      players.value = res.data?.data?.players || res.data?.players || []
    } catch { /* ignore */ }
  }, 20000)
})

onUnmounted(() => {
  if (raf) cancelAnimationFrame(raf)
  if (arriveTimer) clearInterval(arriveTimer)
  if (pollTimer) clearInterval(pollTimer)
  if (socketOff) socketOff()
  resizeObs?.disconnect()
})

defineExpose({
  confirmMove,
  cancelPath,
  centerOnSelf,
  getState: () => ({
    region: region.value,
    self: { ...selfCell },
    selected: selected.value,
    pathPreview: pathPreview.value,
    visionR: visionR.value,
    cell: selected.value ? cellAt(selected.value.x, selected.value.y) : cellAt(selfCell.x, selfCell.y),
    isSelf: selected.value
      ? selected.value.x === selfCell.x && selected.value.y === selfCell.y
      : true,
    visibility: selected.value
      ? (vis.value[selected.value.y * width.value + selected.value.x] || 'unknown')
      : 'visible',
  }),
})
</script>

<template>
  <div class="relative w-full h-full min-h-0 overflow-hidden bg-[#0c0f0e]">
    <canvas
      ref="canvasRef"
      class="w-full h-full block touch-none select-none cursor-crosshair"
      @pointerdown.prevent="onPointerDown"
      @pointermove.prevent="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel.prevent="onWheel"
    />

    <!-- 右下工具 -->
    <div class="absolute bottom-3 right-3 flex flex-col gap-1.5 items-end">
      <button
        class="px-2.5 py-1.5 rounded bg-surface-raised/90 border border-line-subtle text-[12px] text-fg-secondary hover:text-gold-500"
        @click="centerOnSelf"
      >回中</button>
      <div class="px-2 py-1 rounded bg-surface-raised/80 text-[10px] text-fg-faint border border-line-subtle">
        拖拽平移 · 滚轮缩放 · 点格预览路径
      </div>
    </div>

    <!-- 路径预览确认 -->
    <div
      v-if="pathPreview"
      class="absolute top-3 left-1/2 -translate-x-1/2 bg-surface-raised/95 border border-sky-700/50 rounded-lg px-4 py-2.5 shadow-xl flex items-center gap-3"
    >
      <div class="text-[12px] text-fg-secondary">
        途经 <b class="text-sky-300">{{ pathPreview.steps }}</b> 格 · 约
        <b class="text-sky-300">{{ pathPreview.seconds }}</b>s
        <span v-if="pathPreview.hazards.length" class="text-rose-400 ml-2">
          途中有 {{ pathPreview.hazards.length }} 处危险
        </span>
      </div>
      <button
        class="px-3 py-1 rounded bg-sky-700 hover:bg-sky-600 text-white text-[12px] font-bold"
        @click="confirmMove"
      >启程</button>
      <button
        class="px-2 py-1 rounded border border-line text-[12px] text-fg-muted hover:text-fg-primary"
        @click="cancelPath"
      >取消</button>
    </div>

    <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-black/40">
      <span class="text-gold-500 animate-pulse">观星定位中…</span>
    </div>
  </div>
</template>
