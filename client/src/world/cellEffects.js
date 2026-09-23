/**
 * 格子 on_enter 效果分派（L2/L3）
 * 把「踩到据点 / 采资源 / 进遗迹」接到真实后端，而不是只弹 toast。
 */
import { encounter } from '../api/combat'
import { startExplore, getExploreEvent } from '../api/explore'
import { collectResource } from '../api/gather'

/** map_data 的怪物 id 与 combat/monsters 对齐 */
const FALLBACK_MONSTER = 'wolf'

export async function runCellAction({ id, cell, playerStore, uiStore, goPanel }) {
  const type = id

  // ── 采集 ──
  if (type === 'gather') {
    const rid = cell?.resource?.id
    if (!rid) {
      uiStore.showToast('此处没有可采之物', 'warning')
      return { ok: false }
    }
    try {
      const res = await collectResource(rid)
      const data = res.data?.data || res.data
      const gained = data?.items || data?.gained || data?.yields
      const msg = data?.message
        || (Array.isArray(gained) && gained.length
          ? `采得 ${gained.map(g => `${g.name || g.item_id || g.resource_id}×${g.count ?? g.quantity ?? 1}`).join('、')}`
          : '采集完成')
      uiStore.showToast(msg, 'success')
      uiStore.addLog?.({ content: msg, type: 'gather', actorId: 'self' })
      return { ok: true, data }
    } catch (e) {
      // 采集冷却 / 不在该图等
      const m = e?.response?.data?.message || e?.message || '采集失败'
      uiStore.showToast(m, 'error')
      return { ok: false }
    }
  }

  // ── 据点：强制进战 ──
  if (type === 'challenge' || type === 'monster_nest') {
    const mid = cell?.monster_id || FALLBACK_MONSTER
    try {
      const res = await encounter(mid)
      const data = res.data?.data || res.data
      const battleId = data?.battle_id || data?.battleId || data?.id
      if (battleId) playerStore.setActiveBattle(battleId)
      uiStore.showToast(`狭路相逢！${data?.monster?.name || '妖兽'}扑来！`, 'warning')
      uiStore.addLog?.({
        content: `你在${cell?.name || '据点'}遭遇${data?.monster?.name || '妖兽'}，战斗开始。`,
        type: 'combat',
        actorId: 'self',
      })
      goPanel?.('combat')
      return { ok: true, data }
    } catch (e) {
      const m = e?.response?.data?.message || '遭遇失败'
      uiStore.showToast(m, 'error')
      // 已有战斗则直接进
      if (playerStore.activeBattleId) goPanel?.('combat')
      return { ok: false }
    }
  }

  // ── 小遗迹：短途探索事件 ──
  if (type === 'explore' || type === 'ruin_small') {
    try {
      // 若已有事件，先看一眼
      try {
        const ev = await getExploreEvent()
        const t = ev.data?.data?.event?.title || ev.data?.event?.title
        if (t) uiStore.showToast(`遗迹回响：${t}`, 'info')
      } catch { /* 可选 */ }

      const res = await startExplore('short')
      const data = res.data?.data || res.data
      uiStore.showToast('你步入遗迹，搜寻片刻…（短途历练已开始）', 'info')
      uiStore.addLog?.({
        content: `探索${cell?.name || '小遗迹'}，短途历练开始。`,
        type: 'explore',
        actorId: 'self',
      })
      goPanel?.('explore')
      return { ok: true, data }
    } catch (e) {
      const m = e?.response?.data?.message || '探索失败（可能仍在历练中）'
      uiStore.showToast(m, 'error')
      return { ok: false }
    }
  }

  // ── 大遗迹 / 副本门 ──
  if (type === 'enter' || type === 'ruin_large') {
    const ct = cell?.cell_type
    if (ct === 'sect') {
      uiStore.showToast(`踏入${cell?.name || '山门'}`, 'success')
      goPanel?.('sect')
      return { ok: true }
    }
    if (ct === 'town') {
      uiStore.showToast(`进入${cell?.name || '坊市'}`, 'success')
      goPanel?.('market')
      return { ok: true }
    }
    if (ct === 'ruin_large' || cell?.sub_region_id) {
      uiStore.showToast(`开启${cell?.name || '遗迹'}…`, 'info')
      goPanel?.('dungeon')
      return { ok: true }
    }
    if (ct === 'cave_player') {
      goPanel?.('cave')
      return { ok: true }
    }
    uiStore.showToast('进入中…', 'info')
    return { ok: true }
  }

  // ── 市井 ──
  if (type === 'market') { goPanel?.('market'); return { ok: true } }
  if (type === 'pawnshop') { goPanel?.('pawnshop'); return { ok: true } }
  if (type === 'sect') { goPanel?.('sect'); return { ok: true } }
  if (type === 'build') {
    uiStore.showToast('灵力凝成门牌……（安家将接洞府创建）', 'info')
    goPanel?.('cave')
    return { ok: true }
  }
  if (type === 'knock') { goPanel?.('cave_social'); return { ok: true } }
  if (type === 'portal') {
    uiStore.showToast('传送阵嗡鸣——跨区跋涉即将接通', 'info')
    return { ok: true }
  }
  if (type === 'probe') {
    uiStore.showToast('神识扫过……（探查消耗将接神识池）', 'info')
    return { ok: true }
  }
  if (type === 'mark') {
    uiStore.showToast('已在私人舆图钉下标记', 'success')
    return { ok: true }
  }

  uiStore.showToast(`「${type}」暂无效果`, 'warning')
  return { ok: false }
}

/**
 * 到达脚下的自动 on_enter（强制事件）
 * @returns {null | {type, cell}}
 */
export function autoEnterOnArrive(cell) {
  if (!cell) return null
  if (cell.cell_type === 'monster_nest') {
    return { type: 'challenge', cell, force: true }
  }
  return null
}
