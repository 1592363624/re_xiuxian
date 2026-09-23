/**
 * 格子世界引擎（客户端确定性生成 + 视野 + 寻路）
 * 设计：docs/大地图格子化设计方案.md / docs/大地图行动为主_总体设计.md
 *
 * 同一 (seed, regionId, x, y) 永远得到同一格 —— 与服务端 GridMapService 对齐。
 */

export const CELL_SIZE = 10

/** mulberry32 — 与设计稿约定的确定性 PRNG */
export function mulberry32(seed) {
  let t = seed >>> 0
  return function next() {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** 坐标哈希混入种子 */
export function cellHash(seed, x, y) {
  let h = (seed ^ (x * 374761393) ^ (y * 668265263)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

export function hash01(seed, x, y) {
  return cellHash(seed, x, y) / 4294967296
}

export const TERRAIN = {
  plains:   { name: '平原', color: '#2f3a28', walk: true },
  forest:   { name: '山林', color: '#243528', walk: true },
  mountain: { name: '山地', color: '#3a3428', walk: true },
  cave:     { name: '洞窟', color: '#2c2830', walk: true },
  ocean:    { name: '海域', color: '#1a2c38', walk: true },
  ruin:     { name: '遗迹', color: '#322828', walk: true },
  celestial:{ name: '云海', color: '#2a3040', walk: true },
}

export const CELL_TYPE = {
  empty:        { name: '空地',   icon: '',  walk: true },
  resource:     { name: '资源',   icon: '❖', walk: true },
  monster_nest: { name: '据点',   icon: '☠', walk: true },
  ruin_small:   { name: '小遗迹', icon: '◈', walk: true },
  ruin_large:   { name: '大遗迹', icon: '壱', walk: true },
  cave_player:  { name: '洞府',   icon: '家', walk: true },
  sect:         { name: '宗门',   icon: '門', walk: true },
  town:         { name: '坊市',   icon: '市', walk: true },
  portal:       { name: '传送',   icon: '阵', walk: true },
  barrier:      { name: '险地',   icon: '✕', walk: false },
}

/**
 * 由区域配置生成单格（确定性）
 * @returns {{x,y,terrain,zone_id,cell_type,passable,poi,resource,danger,name}}
 */
export function generateCell(region, x, y) {
  const w = region.size[0]
  const h = region.size[1]
  if (x < 0 || y < 0 || x >= w || y >= h) return null

  // 1) 手工覆盖
  const ovr = (region.overrides || []).find(o => o.x === x && o.y === y)
  const poi = (region.poi_cells || []).find(p => p.x === x && p.y === y)

  // 2) 地形分区
  let terrain = null
  let zoneId = null
  let zoneName = null
  let danger = region.danger || 2
  for (const z of region.terrain_zones || []) {
    const [x0, y0, x1, y1] = z.rect
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      terrain = z.terrain
      zoneId = z.zone_id
      zoneName = z.name
      if (z.danger != null) danger = z.danger
      break
    }
  }

  // 3) 噪声填充
  if (!terrain) {
    const fill = region.terrain_fill || { plains: 1 }
    const keys = Object.keys(fill)
    const total = keys.reduce((s, k) => s + (fill[k] || 0), 0) || 1
    let r = hash01(region.seed, x, y) * total
    for (const k of keys) {
      r -= fill[k] || 0
      if (r <= 0) { terrain = k; break }
    }
    if (!terrain) terrain = keys[0] || 'plains'
  }

  // 4) cell_type
  let cellType = 'empty'
  if (poi?.cell_type) {
    cellType = poi.cell_type
  } else if (ovr?.cell_type) {
    cellType = ovr.cell_type
  } else if (poi?.resource) {
    cellType = 'resource'
  } else {
    // 资源密度
    const rule = (region.resource_rules || []).find(rr => rr.terrain === terrain)
    const density = rule?.density ?? 0
    const rType = hash01(region.seed + 11, x, y)
    const rRes = hash01(region.seed + 22, x, y)
    const weights = region.cell_type_weights || { empty: 70, resource: 0, monster_nest: 15, ruin_small: 8, barrier: 7 }
    const wKeys = Object.keys(weights).filter(k => (weights[k] || 0) > 0)
    const wTotal = wKeys.reduce((s, k) => s + weights[k], 0) || 1

    if (rule && rRes < density) {
      cellType = 'resource'
    } else {
      let rr = rType * wTotal
      for (const k of wKeys) {
        rr -= weights[k]
        if (rr <= 0) { cellType = k; break }
      }
      if (cellType === 'resource' && !rule) cellType = 'empty'
    }
  }

  if (ovr?.terrain) terrain = ovr.terrain
  if (ovr?.cell_type) cellType = ovr.cell_type

  // 5) 资源
  let resource = poi?.resource || null
  if (cellType === 'resource' && !resource) {
    const rule = (region.resource_rules || []).find(rr => rr.terrain === terrain)
    const pool = rule?.pool || []
    if (pool.length) {
      const idx = Math.floor(hash01(region.seed + 33, x, y) * pool.length) % pool.length
      const amount = 1 + Math.floor(hash01(region.seed + 44, x, y) * 3)
      resource = {
        id: pool[idx],
        amount,
        respawn_minutes: rule.respawn_minutes || 30,
      }
    }
  }

  const hidden = (region.hidden_cells || []).find(hc => hc.x === x && hc.y === y) || null
  const passable = cellType !== 'barrier' && (TERRAIN[terrain]?.walk !== false)

  return {
    x, y,
    terrain,
    zone_id: zoneId,
    zone_name: zoneName,
    cell_type: cellType,
    passable,
    poi: poi?.poi || null,
    poi_name: poi?.name || null,
    sub_region_id: poi?.sub_region_id || null,
    portal_id: poi?.portal_id || null,
    resource,
    hidden: hidden ? hidden.hidden : null,
    danger,
    forbid_build: ovr?.forbid_build || !['mountain', 'cave', 'forest'].includes(terrain),
    monster_id: poi?.monster_id || null,
    name: poi?.name || null,
  }
}

export function getRegionCells(region) {
  const w = region.size[0]
  const h = region.size[1]
  const cells = new Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      cells[y * w + x] = generateCell(region, x, y)
    }
  }
  return cells
}

/** 切比雪夫视野 */
export function visibilityMap(region, cx, cy, radius, known = new Set()) {
  const w = region.size[0]
  const h = region.size[1]
  const vis = new Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - cx)
      const dy = Math.abs(y - cy)
      const max = Math.max(dx, dy)
      const key = `${x},${y}`
      if (max <= radius) vis[y * w + x] = 'visible'
      else if (known.has(key)) vis[y * w + x] = 'known'
      else vis[y * w + x] = 'unknown'
    }
  }
  return vis
}

/** A* 寻路（8 邻接，绕开 barrier） */
export function findPath(region, cells, from, to) {
  const w = region.size[0]
  const h = region.size[1]
  const key = (x, y) => y * w + x
  const start = key(from.x, from.y)
  const goal = key(to.x, to.y)
  if (start === goal) return [{ x: from.x, y: from.y }]
  if (!cells[goal]?.passable && !(to.x === from.x && to.y === from.y)) {
    // 目标不可达则失败
    if (!cells[goal]?.passable) return null
  }

  const open = [start]
  const g = new Map([[start, 0]])
  const came = new Map()
  const f = new Map([[start, hCost(from.x, from.y, to.x, to.y)]])
  const inOpen = new Set([start])
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ]

  while (open.length) {
    let bi = 0
    for (let i = 1; i < open.length; i++) {
      if ((f.get(open[i]) ?? 1e9) < (f.get(open[bi]) ?? 1e9)) bi = i
    }
    const cur = open.splice(bi, 1)[0]
    inOpen.delete(cur)
    if (cur === goal) {
      const path = []
      let c = cur
      while (c != null) {
        path.push({ x: c % w, y: Math.floor(c / w) })
        c = came.get(c)
      }
      return path.reverse()
    }
    const cx = cur % w
    const cy = Math.floor(cur / w)
    for (const [dx, dy] of dirs) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nid = key(nx, ny)
      const cell = cells[nid]
      if (!cell?.passable && nid !== goal) continue
      const step = (dx && dy) ? 1.414 : 1
      const ng = (g.get(cur) ?? 1e9) + step
      if (ng < (g.get(nid) ?? 1e9)) {
        came.set(nid, cur)
        g.set(nid, ng)
        f.set(nid, ng + hCost(nx, ny, to.x, to.y))
        if (!inOpen.has(nid)) {
          open.push(nid)
          inOpen.add(nid)
        }
      }
    }
  }
  return null
}

function hCost(x, y, tx, ty) {
  const dx = Math.abs(x - tx)
  const dy = Math.abs(y - ty)
  return Math.max(dx, dy) + 0.414 * Math.min(dx, dy)
}

export function pathSeconds(path) {
  if (!path || path.length < 2) return 0
  // 1 格 = 1 秒；对角约 1.4 秒（向下取整到 0.5）
  let s = 0
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x)
    const dy = Math.abs(path[i].y - path[i - 1].y)
    s += (dx && dy) ? 1.4 : 1
  }
  return Math.round(s * 10) / 10
}

export function pathHazards(cells, path) {
  const marks = []
  for (const p of path || []) {
    const c = cells[p.y * /* filled by caller size */ 0] // placeholder never used
    void c
  }
  // 由调用方传 cells + width；保留独立函数
  return marks
}

export function collectHazards(cells, width, path) {
  const out = []
  for (const p of path || []) {
    const c = cells[p.y * width + p.x]
    if (!c) continue
    if (c.cell_type === 'monster_nest') out.push({ ...p, kind: 'monster_nest', label: '据点' })
    else if (c.cell_type === 'barrier') out.push({ ...p, kind: 'barrier', label: '险地' })
    else if ((c.danger || 0) >= 6) out.push({ ...p, kind: 'danger', label: `危险 ${c.danger}` })
  }
  return out
}

/** 世界坐标 ↔ 格坐标 */
export function worldToCell(posX, posY, anchor = [0, 0], cellSize = CELL_SIZE) {
  return {
    x: Math.floor((posX - anchor[0] * cellSize) / cellSize),
    y: Math.floor((posY - anchor[1] * cellSize) / cellSize),
  }
}

export function cellToWorld(cx, cy, anchor = [0, 0], cellSize = CELL_SIZE) {
  return {
    x: (anchor[0] + cx) * cellSize + cellSize / 2,
    y: (anchor[1] + cy) * cellSize + cellSize / 2,
  }
}

/** 感知神识 → 视野半径（对齐 grid_config.vision.sense_tiers） */
export function radiusFromSense(sense) {
  const tiers = [
    { min: 0, r: 3 },
    { min: 30, r: 4 },
    { min: 200, r: 5 },
    { min: 1000, r: 6 },
    { min: 3000, r: 8 },
    { min: 8000, r: 10 },
  ]
  let r = 3
  for (const t of tiers) {
    if (sense >= t.min) r = t.r
  }
  return r
}
