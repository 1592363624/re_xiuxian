/**
 * 玩家资源统一读写层。
 *
 * 为什么要有这个文件：灵力字段在 /player/me 里叫 mp_current，战斗回包叫 player_mp，
 * 采集回包叫 mp_remaining —— 各面板自己猜字段名，猜错就出现「左侧 10 万灵力、
 * 功法面板判灵力不足」这类两套数据。这里把读、判、写收成一份契约：
 *
 *   规范字段（与 GET /player/me 对齐，BIGINT 一律序列化为字符串）：
 *     hp_current / hp_max / mp_current / mp_max / exp / exp_next / spirit_stones
 *
 *   历史别名在 patchFromResponse 里映射到规范字段，面板不要再手写
 *   `playerStore.player.mp_current = result.mp_remaining` 这类搬运。
 *
 * 数值口径：对外一律 Number（够用到 2^53）；需要精确大数的场景
 * （修为进度条）自己用 BigInt 读 player.exp，不要经过这里的 getter。
 */
import { computed } from 'vue'
import { usePlayerStore } from '../stores/player'

/** 规范字段名（与 server/routes/player.js 的 /player/me 响应一致） */
export const PLAYER_FIELDS = Object.freeze({
  hp: 'hp_current',
  hpMax: 'hp_max',
  mp: 'mp_current',
  mpMax: 'mp_max',
  exp: 'exp',
  expNext: 'exp_next',
  spiritStones: 'spirit_stones'
})

const CANONICAL_KEYS = new Set(Object.values(PLAYER_FIELDS))

/**
 * 各接口历史别名 → 规范字段。
 * 只收「同一个语义、不同键名」的别名；消耗量（spirit_stones_cost 等）不是余额，不在此列。
 */
const FIELD_ALIASES = Object.freeze({
  player_hp: 'hp_current',
  player_mp: 'mp_current',
  mp_remaining: 'mp_current',
  hp_remaining: 'hp_current',
  current_balance: 'spirit_stones',
  balance_after: 'spirit_stones',
  hp: 'hp_current',
  mp: 'mp_current'
})

/** BIGINT 字符串 / number / null 统一转 Number；非法值一律 0 */
export function toNum(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function usePlayerResources() {
  const playerStore = usePlayerStore()
  const player = computed(() => playerStore.player || {})

  const hp = computed(() => toNum(player.value.hp_current))
  const hpMax = computed(() => toNum(player.value.hp_max))
  const mp = computed(() => toNum(player.value.mp_current))
  const mpMax = computed(() => toNum(player.value.mp_max))
  const exp = computed(() => toNum(player.value.exp))
  const expNext = computed(() => toNum(player.value.exp_next))
  const spiritStones = computed(() => toNum(player.value.spirit_stones))

  const enoughHp = (cost) => hp.value >= toNum(cost)
  const enoughMp = (cost) => mp.value >= toNum(cost)
  const enoughSpirit = (cost) => spiritStones.value >= toNum(cost)

  /**
   * 把任意接口回包里的资源字段写回 player store。
   * 同时接受规范字段与历史别名；只覆盖「本次响应里出现过」的键，
   * 不会把没返回的字段抹成 0。递归处理 { player: {...} } 这类嵌套。
   */
  const patchFromResponse = (payload) => {
    if (!payload || typeof payload !== 'object' || !playerStore.player) return
    const target = playerStore.player
    let touched = false

    for (const [rawKey, rawVal] of Object.entries(payload)) {
      if (rawVal === undefined || rawVal === null || typeof rawVal === 'object') continue
      const key = FIELD_ALIASES[rawKey] || rawKey
      if (CANONICAL_KEYS.has(key)) {
        target[key] = rawVal
        touched = true
      }
    }

    // 常见嵌套：{ player: { hp_current, ... } } 或战斗 { player: { hp, mp } }
    if (payload.player && typeof payload.player === 'object') {
      patchFromResponse(payload.player)
      return
    }

    if (touched) playerStore.setPlayer({ ...target })
  }

  return {
    hp, hpMax, mp, mpMax, exp, expNext, spiritStones,
    enoughHp, enoughMp, enoughSpirit,
    patchFromResponse
  }
}
