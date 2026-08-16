<script setup>
/**
 * 大世界地图面板（World Map MVP）
 * 2D 俯視視角世界地图：地图节点 + 连线 + 玩家实体 + 点击移动 + 同图多人在线同步
 *
 * 设计：
 *   - 服务器权威坐标（WorldMovementService），前端负责平滑插值渲染
 *   - 点击空白处/地图节点 → 发起移动请求（自动节流 350ms）
 *   - Socket 实时同步同图玩家位置（world:player-moved）
 *   - 滚轮缩放、拖拽平移、点击玩家查看信息
 */
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import { useUIStore } from '../../stores/ui'
import { usePlayerStore } from '../../stores/player'
import { socketService } from '../../services/socket'
import { getWorldState, moveWorld, getWorldPlayers } from '../../api/world'
import { getMapConfig } from '../../api/map'
import { getGameBalancePublic } from '../../api/config'
import { buildMapTypeNameMap } from '../../utils/mapStyles'

const uiStore = useUIStore()
const playerStore = usePlayerStore()

const emit = defineEmits(['close'])

// ===== 基础状态 =====
const canvasRef = ref(null)
const loading = ref(true)
const loadingPlayers = ref(false)
const maps = ref([])          // 地图节点配置
const worldState = ref(null)  // 自身世界状态
const mapTypeNameMap = ref({})
const selectedPlayer = ref(null)
const hoveringPlayer = ref(null)
const moving = ref(false)

// 世界坐标变换（viewX/viewY = 视口中心对应的世界坐标）
const view = reactive({ x: 0, y: 0, scale: 1 })
const worldBounds = reactive({ minX: -340, maxX: 340, minY: -190, maxY: 190 })

// 玩家实体（含插值渲染状态）
const players = ref([])
const selfEntity = reactive({ id: null, x: 0, y: 0, targetX: 0, targetY: 0, name: '', realm: '', visible: false })

const MOVE_THROTTLE_MS = 350
const INTERP_SPEED = 5
let lastMoveAt = 0
let rafId = null
let dragState = null
let canvasSize = { w: 0, h: 0 }

// ===== 地图节点样式 =====
const typeColors = {
  country: '#34d399',
  sect: '#38bdf8',
  mountain: '#fbbf24',
  ocean: '#22d3ee',
  talent: '#c084fc',
  world: '#fb7185'
}
const typeNames = computed(() => mapTypeNameMap.value)

// ===== 数据加载 =====
const fetchMaps = async () => {
  try {
    const res = await getMapConfig()
    const list = res.data?.data?.maps || res.data?.maps || []
    maps.value = list
    // 计算世界边界
    let maxAbs = 10
    list.forEach(m => {
      maxAbs = Math.max(maxAbs, Math.abs(m.x || 0), Math.abs(m.y || 0))
    })
    const margin = 40
    worldBounds.minX = -(maxAbs + margin)
    worldBounds.maxX = maxAbs + margin
    worldBounds.minY = -(maxAbs + margin)
    worldBounds.maxY = maxAbs + margin
  } catch (e) {
    console.error('[WorldMap] 加载地图配置失败:', e)
  }
}

const fetchMapTypeNames = async () => {
  try {
    const res = await getGameBalancePublic()
    if (res.data?.code === 200 && res.data.data?.map_types) {
      mapTypeNameMap.value = buildMapTypeNameMap(res.data.data.map_types)
    }
  } catch (e) {
    console.error('[WorldMap] 加载地图类型名称失败:', e)
  }
}

const fetchWorldState = async () => {
  const res = await getWorldState()
  const data = res.data?.data || res.data
  if (!data) return null
  worldState.value = data
  selfEntity.id = playerStore.player?.id
  selfEntity.name = playerStore.player?.nickname || playerStore.player?.username || '我'
  selfEntity.realm = playerStore.player?.realm || ''
  selfEntity.x = data.pos_x
  selfEntity.y = data.pos_y
  selfEntity.targetX = data.pos_x
  selfEntity.targetY = data.pos_y
  selfEntity.visible = true
  // 视口定位到玩家
  view.x = data.pos_x
  view.y = data.pos_y
  return data
}

const fetchPlayers = async () => {
  loadingPlayers.value = true
  try {
    const res = await getWorldPlayers()
    const data = res.data?.data || {}
    const list = data.players || []
    const myId = Number(playerStore.player?.id)
    const next = []
    for (const p of list) {
      if (Number(p.player_id) === myId) continue
      next.push({
        id: Number(p.player_id),
        name: p.name,
        realm: p.realm,
        sect_name: p.sect_name,
        x: p.pos_x,
        y: p.pos_y,
        targetX: p.pos_x,
        targetY: p.pos_y
      })
    }
    // 保留旧实体（平滑过渡），移除已不在线的
    const oldMap = new Map(players.value.map(p => [p.id, p]))
    players.value = next.map(p => {
      const old = oldMap.get(p.id)
      if (old) {
        old.name = p.name
        old.realm = p.realm
        old.sect_name = p.sect_name
        old.targetX = p.targetX
        old.targetY = p.targetY
        return old
      }
      return { ...p }
    })
  } catch (e) {
    console.error('[WorldMap] 加载在线玩家失败:', e)
  } finally {
    loadingPlayers.value = false
  }
}

// ===== 移动 =====
const tryMove = async (worldX, worldY) => {
  const now = Date.now()
  if (now - lastMoveAt < MOVE_THROTTLE_MS) return
  if (moving.value) return
  lastMoveAt = now

  // 与自身当前位置过近则忽略
  const dx = worldX - selfEntity.x
  const dy = worldY - selfEntity.y
  if (Math.sqrt(dx * dx + dy * dy) < 1.5) return

  moving.value = true
  try {
    const res = await moveWorld(worldX, worldY)
    const data = res.data?.data || res.data
    if (data) {
      selfEntity.targetX = data.pos_x
      selfEntity.targetY = data.pos_y
      worldState.value = {
        ...(worldState.value || {}),
        map_id: data.map_id,
        map_name: data.map_name,
        map_type: data.map_type,
        pos_x: data.pos_x,
        pos_y: data.pos_y
      }
      playerStore.worldState = worldState.value
    }
  } catch (error) {
    const msg = error.response?.data?.message || error.response?.data?.error || '移动失败'
    uiStore.showToast(msg, 'error')
  } finally {
    moving.value = false
  }
}

// ===== Socket 同步 =====
let socketOff = null
const onPlayerMoved = (data) => {
  const p = data?.player
  if (!p) return
  const myId = Number(playerStore.player?.id)
  if (Number(p.player_id) === myId) {
    // 自己：更新插值目标（store 也会同步 worldState）
    selfEntity.targetX = p.pos_x
    selfEntity.targetY = p.pos_y
    if (worldState.value) {
      worldState.value.pos_x = p.pos_x
      worldState.value.pos_y = p.pos_y
      worldState.value.map_id = p.map_id
      worldState.value.map_name = p.map_name
    }
    return
  }
  // 其他玩家：更新或新增
  const target = players.value.find(q => q.id === Number(p.player_id))
  if (target) {
    target.targetX = p.pos_x
    target.targetY = p.pos_y
    target.name = p.name
    target.realm = p.realm
    target.sect_name = p.sect_name
  } else {
    players.value.push({
      id: Number(p.player_id),
      name: p.name,
      realm: p.realm,
      sect_name: p.sect_name,
      x: p.pos_x,
      y: p.pos_y,
      targetX: p.pos_x,
      targetY: p.pos_y
    })
  }
}

// ===== 画布渲染 =====
const ensureCanvasSize = () => {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = rect.width
  const h = rect.height
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  canvasSize = { w, h, dpr }
}

const worldToScreen = (wx, wy) => {
  return {
    sx: (wx - view.x) * view.scale + canvasSize.w / 2,
    sy: (wy - view.y) * view.scale + canvasSize.h / 2
  }
}

const screenToWorld = (sx, sy) => {
  return {
    wx: (sx - canvasSize.w / 2) / view.scale + view.x,
    wy: (sy - canvasSize.h / 2) / view.scale + view.y
  }
}

const draw = () => {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const { w, h, dpr } = canvasSize
  if (!w || !h) return

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // 背景
  ctx.fillStyle = '#0c0a09'
  ctx.fillRect(0, 0, w, h)

  // 网格（随缩放调整密度）
  const gridStep = 20
  const startX = view.x - w / 2 / view.scale
  const endX = view.x + w / 2 / view.scale
  const startY = view.y - h / 2 / view.scale
  const endY = view.y + h / 2 / view.scale
  ctx.strokeStyle = 'rgba(68, 64, 60, 0.35)'
  ctx.lineWidth = 1 / view.scale
  ctx.beginPath()
  for (let gx = Math.floor(startX / gridStep) * gridStep; gx <= endX; gx += gridStep) {
    const { sx } = worldToScreen(gx, 0)
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx, h)
  }
  for (let gy = Math.floor(startY / gridStep) * gridStep; gy <= endY; gy += gridStep) {
    const { sy } = worldToScreen(0, gy)
    ctx.moveTo(0, sy)
    ctx.lineTo(w, sy)
  }
  ctx.stroke()

  // 世界边界
  ctx.strokeStyle = 'rgba(217, 119, 6, 0.25)'
  ctx.lineWidth = 2 / view.scale
  const tl = worldToScreen(worldBounds.minX, worldBounds.minY)
  const br = worldToScreen(worldBounds.maxX, worldBounds.maxY)
  ctx.strokeRect(tl.sx, tl.sy, br.sx - tl.sx, br.sy - tl.sy)

  // 地图区域圈（虚线）与连线
  const areaRadius = 14
  for (const m of maps.value) {
    if (!m.can_enter) continue
    const { sx, sy } = worldToScreen(m.x || 0, m.y || 0)
    ctx.strokeStyle = 'rgba(120, 113, 108, 0.25)'
    ctx.lineWidth = 1 / view.scale
    ctx.setLineDash([4 / view.scale, 4 / view.scale])
    ctx.beginPath()
    ctx.arc(sx, sy, areaRadius * view.scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // 地图连线
  const drawn = new Set()
  ctx.strokeStyle = 'rgba(68, 64, 60, 0.8)'
  ctx.lineWidth = 1.5 / view.scale
  for (const m of maps.value) {
    const a = worldToScreen(m.x || 0, m.y || 0)
    for (const connId of m.connections || []) {
      const key = [Math.min(m.id, connId), Math.max(m.id, connId)].join('-')
      if (drawn.has(key)) continue
      drawn.add(key)
      const other = maps.value.find(q => q.id === connId)
      if (!other) continue
      const b = worldToScreen(other.x || 0, other.y || 0)
      ctx.beginPath()
      ctx.moveTo(a.sx, a.sy)
      ctx.lineTo(b.sx, b.sy)
      ctx.stroke()
    }
  }

  // 地图节点
  for (const m of maps.value) {
    const { sx, sy } = worldToScreen(m.x || 0, m.y || 0)
    const color = typeColors[m.type] || '#a8a29e'
    const isCurrent = worldState.value && Number(m.id) === Number(worldState.value.map_id)
    const radius = (isCurrent ? 7 : 5.5)

    // 外发光
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius * 3.5)
    glow.addColorStop(0, color + '55')
    glow.addColorStop(1, 'transparent')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(sx, sy, radius * 3.5, 0, Math.PI * 2)
    ctx.fill()

    // 节点主体
    ctx.fillStyle = m.can_enter ? color : '#57534e'
    ctx.strokeStyle = m.can_enter ? color : '#44403c'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // 当前地图高亮圈
    if (isCurrent) {
      ctx.strokeStyle = '#fbbf24'
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.arc(sx, sy, radius + 5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // 节点名称
    if (view.scale > 0.35) {
      ctx.font = `${Math.max(9, 11 / Math.sqrt(view.scale))}px "Noto Serif SC", serif`
      ctx.fillStyle = m.can_enter ? '#d6d3d1' : '#78716c'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const label = m.can_enter ? m.name : `${m.name}(未达境界)`
      ctx.fillText(label, sx, sy + radius + 4)
      if (view.scale > 0.8) {
        ctx.font = `${8 / Math.sqrt(view.scale)}px sans-serif`
        ctx.fillStyle = '#78716c'
        const tname = (typeNames.value[m.type] && typeNames.value[m.type].name) || m.type
        ctx.fillText(tname, sx, sy + radius + 16)
      }
    }
  }

  // 其他在线玩家
  for (const p of players.value) {
    const { sx, sy } = worldToScreen(p.x, p.y)
    const isHover = hoveringPlayer.value && hoveringPlayer.value.id === p.id
    const isSelected = selectedPlayer.value && selectedPlayer.value.id === p.id
    ctx.fillStyle = isHover || isSelected ? '#7dd3fc' : '#38bdf8'
    ctx.strokeStyle = '#0ea5e9'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(sx, sy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.font = '10px sans-serif'
    ctx.fillStyle = isHover || isSelected ? '#e0f2fe' : '#a8a29e'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(p.name, sx, sy - 6)
  }

  // 自己（金色 + 呼吸光环）
  if (selfEntity.visible) {
    const { sx, sy } = worldToScreen(selfEntity.x, selfEntity.y)
    const pulse = 1 + Math.sin(Date.now() / 400) * 0.15
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.5)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(sx, sy, 12 * pulse, 0, Math.PI * 2)
    ctx.stroke()
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 18)
    glow.addColorStop(0, 'rgba(251, 191, 36, 0.25)')
    glow.addColorStop(1, 'transparent')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(sx, sy, 18, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fbbf24'
    ctx.strokeStyle = '#f59e0b'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(sx, sy, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.font = 'bold 11px "Noto Serif SC", serif'
    ctx.fillStyle = '#fbbf24'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(`${selfEntity.name}(我)`, sx, sy - 8)
  }
}

// 插值更新玩家实体位置
const interp = (dt) => {
  if (selfEntity.visible) {
    selfEntity.x += (selfEntity.targetX - selfEntity.x) * Math.min(1, dt * INTERP_SPEED)
    selfEntity.y += (selfEntity.targetY - selfEntity.y) * Math.min(1, dt * INTERP_SPEED)
    if (Math.abs(selfEntity.x - selfEntity.targetX) < 0.05) selfEntity.x = selfEntity.targetX
    if (Math.abs(selfEntity.y - selfEntity.targetY) < 0.05) selfEntity.y = selfEntity.targetY
  }
  for (const p of players.value) {
    p.x += (p.targetX - p.x) * Math.min(1, dt * INTERP_SPEED)
    p.y += (p.targetY - p.y) * Math.min(1, dt * INTERP_SPEED)
    if (Math.abs(p.x - p.targetX) < 0.05) p.x = p.targetX
    if (Math.abs(p.y - p.targetY) < 0.05) p.y = p.targetY
  }
}

const loop = (ts) => {
  const dt = Math.min(0.05, (ts - (loop.lastTs || ts)) / 1000)
  loop.lastTs = ts
  interp(dt)
  draw()
  rafId = requestAnimationFrame(loop)
}
loop.lastTs = 0

// ===== 交互 =====
const onWheel = (e) => {
  e.preventDefault()
  const rect = canvasRef.value.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const { wx, wy } = screenToWorld(mx, my)
  const factor = e.deltaY > 0 ? 0.85 : 1.18
  const newScale = Math.max(0.2, Math.min(4, view.scale * factor))
  // 以光标为中心缩放
  view.x = wx - (mx - canvasSize.w / 2) / newScale
  view.y = wy - (my - canvasSize.h / 2) / newScale
  view.scale = newScale
  clampView()
}

const onPointerDown = (e) => {
  dragState = { x: e.clientX, y: e.clientY, moved: 0, pointerId: e.pointerId }
  canvasRef.value.setPointerCapture(e.pointerId)
}

const onPointerMove = (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) return
  const dx = e.clientX - dragState.x
  const dy = e.clientY - dragState.y
  dragState.moved = Math.max(dragState.moved, Math.abs(dx) + Math.abs(dy))
  if (dragState.moved < 3) return
  view.x -= dx / view.scale
  view.y -= dy / view.scale
  dragState.x = e.clientX
  dragState.y = e.clientY
  clampView()
}

const onPointerUp = (e) => {
  if (!dragState) return
  const wasDrag = dragState.moved >= 5
  const rect = canvasRef.value.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  dragState = null

  if (wasDrag) return

  const { wx, wy } = screenToWorld(mx, my)

  // 点击玩家（半径 12 内优先命中）
  const hitPlayer = players.value.find(p => {
    const dx = p.x - wx
    const dy = p.y - wy
    return Math.sqrt(dx * dx + dy * dy) <= 12 / view.scale
  })
  const selfHit = Math.sqrt((selfEntity.x - wx) ** 2 + (selfEntity.y - wy) ** 2) <= 10 / view.scale
  if (hitPlayer) {
    selectedPlayer.value = hitPlayer
    return
  }
  if (selfHit) {
    selectedPlayer.value = null
    return
  }
  selectedPlayer.value = null
  tryMove(wx, wy)
}

const clampView = () => {
  const rangeX = (worldBounds.maxX - worldBounds.minX)
  const rangeY = (worldBounds.maxY - worldBounds.minY)
  view.x = Math.max(worldBounds.minX, Math.min(worldBounds.maxX, view.x))
  view.y = Math.max(worldBounds.minY, Math.min(worldBounds.maxY, view.y))
}

// ===== 鼠标悬停检测 =====
const onMouseMove = (e) => {
  if (dragState) return
  const rect = canvasRef.value.getBoundingClientRect()
  const { wx, wy } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  const hit = players.value.find(p => Math.sqrt((p.x - wx) ** 2 + (p.y - wy) ** 2) <= 12 / view.scale)
  hoveringPlayer.value = hit || null
  canvasRef.value.style.cursor = hit ? 'pointer' : (moving.value ? 'progress' : 'default')
}

// ===== 生命周期 =====
let pollTimer = null
let resizeObserver = null

onMounted(async () => {
  await Promise.all([fetchMaps(), fetchMapTypeNames()])
  await fetchWorldState()
  await fetchPlayers()

  socketOff = socketService.on('world:player-moved', onPlayerMoved)

  ensureCanvasSize()
  rafId = requestAnimationFrame(loop)
  resizeObserver = new ResizeObserver(() => {
    ensureCanvasSize()
  })
  if (canvasRef.value?.parentElement) {
    resizeObserver.observe(canvasRef.value.parentElement)
  }
  pollTimer = setInterval(fetchPlayers, 15000)

  loading.value = false
})

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId)
  if (socketOff) socketOff()
  if (pollTimer) clearInterval(pollTimer)
  if (resizeObserver) resizeObserver.disconnect()
})
</script>

<template>
  <div class="relative w-full h-full bg-[#0c0a09] overflow-hidden flex flex-col">
    <!-- 顶栏：玩家状态 + 图例 -->
    <div class="flex items-center justify-between px-4 py-2 border-b border-stone-800 bg-[#141210] shrink-0 gap-2">
      <div class="flex items-center gap-2 text-xs text-stone-400 min-w-0">
        <span class="text-amber-500 font-bold shrink-0">大世界</span>
        <template v-if="worldState">
          <span class="bg-stone-800 border border-stone-700 rounded px-2 py-0.5 text-stone-300 truncate">
            📍 {{ worldState.map_name }}
          </span>
          <span class="hidden sm:inline text-stone-500">
            ({{ worldState.pos_x }}, {{ worldState.pos_y }})
          </span>
          <span class="text-sky-400 hidden md:inline">● {{ players.length }} 名道友同在</span>
        </template>
        <span v-else class="text-stone-500">加载中...</span>
      </div>
      <div class="flex items-center gap-3 text-[10px] text-stone-500 shrink-0">
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-[#fbbf24] inline-block"></span>自己</span>
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-[#38bdf8] inline-block"></span>道友</span>
        <span class="hidden sm:inline text-stone-600">滚轮缩放 · 拖拽平移 · 点击移动</span>
      </div>
    </div>

    <!-- 画布区 -->
    <div class="flex-1 relative min-h-0">
      <canvas
        ref="canvasRef"
        class="w-full h-full block touch-none select-none"
        @wheel.prevent="onWheel"
        @pointerdown.prevent="onPointerDown"
        @pointermove.prevent="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @mousemove="onMouseMove"
        @mouseleave="hoveringPlayer = null"
      ></canvas>

      <!-- 加载遮罩 -->
      <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-[#0c0a09]/80">
        <div class="flex flex-col items-center gap-3">
          <svg class="animate-spin h-8 w-8 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span class="text-stone-400 text-sm">观星定位中...</span>
        </div>
      </div>

      <!-- 选中玩家信息卡 -->
      <div v-if="selectedPlayer && !loading"
           class="absolute bottom-3 left-3 bg-[#1c1917]/95 border border-sky-800/50 rounded-lg px-4 py-3 shadow-xl backdrop-blur animate-fade-in">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-sky-900/40 border border-sky-700/50 flex items-center justify-center text-sky-300 text-xs font-bold">
            {{ (selectedPlayer.name || '?').slice(0, 1) }}
          </div>
          <div>
            <div class="text-stone-200 font-bold text-sm">{{ selectedPlayer.name }}</div>
            <div class="text-xs text-sky-400">{{ selectedPlayer.realm || '未知境界' }}</div>
            <div v-if="selectedPlayer.sect_name" class="text-[10px] text-amber-600">宗门：{{ selectedPlayer.sect_name }}</div>
          </div>
          <button @click="selectedPlayer = null" class="ml-2 text-stone-600 hover:text-stone-300 px-1">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="text-[10px] text-stone-500 mt-1.5">后续版本将支持切磋/拜访等交互</div>
      </div>

      <!-- 底部操作提示 -->
      <div class="absolute bottom-2 right-3 text-[10px] text-stone-600 pointer-events-none">
        当前位置（{{ worldState ? Math.round(worldState.pos_x * 10) / 10 : '-' }}, {{ worldState ? Math.round(worldState.pos_y * 10) / 10 : '-' }}）
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>