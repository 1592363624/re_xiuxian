/**
 * 功能面板注册表
 *
 * 改造前：GameLayout 静态 import 了 43 个面板，再各写一条
 * `v-if="openPanel === 'xxx'"`。后果有两层——
 *   1. 首屏必须把全部玩法代码下载完（实测单个 JS chunk 1.79 MB / gzip 478 KB），
 *      哪怕玩家这一局只点得开其中三五个；
 *   2. 新增一个玩法要改三处（ACTIONS、DOCK_TABS、GameLayout 的 if 链），
 *      漏掉 if 链就是「卡片在但点不开」，而这一步没有任何编译期检查。
 *
 * 现在这里按 actionId 登记动态 import，Vite 构建时切出独立 chunk；
 * GameLayout 只剩一个 <component :is>。新增玩法只剩两步，且 id 对不上时
 * 会在控制台直接报出来（见 resolvePanel 与文件末尾的自检）。
 */
import { defineAsyncComponent, h } from 'vue'
import { ACTIONS } from '../../data/actionCatalog'

/** @type {Record<string, () => Promise<import('vue').Component>>} */
const LOADERS = {
  /* ── 修行 ── */
  cultivate: () => import('./SeclusionPanel.vue'),
  technique: () => import('./TechniquePanel.vue'),
  meditation: () => import('./MeditationPanel.vue'),
  dayan: () => import('./DayanPanel.vue'),

  /* ── 历练 ── */
  explore: () => import('./ExplorePanel.vue'),
  trial_tower: () => import('./TrialTowerPanel.vue'),
  map: () => import('./MapPanel.vue'),
  dungeon: () => import('./DungeonPanel.vue'),
  multi_dungeon: () => import('./MultiDungeonPanel.vue'),
  beast_abyss: () => import('./BeastAbyssPanel.vue'),

  /* ── 征伐 ── */
  combat: () => import('./CombatPanel.vue'),
  arena: () => import('./PvpPanel.vue'),
  fengshen: () => import('./FengshenPanel.vue'),
  divine_sense_duel: () => import('./DivineSenseDuelPanel.vue'),
  bounty: () => import('./BountyPanel.vue'),
  world_risk: () => import('./WorldRiskPanel.vue'),
  world_boss: () => import('./WorldBossPanel.vue'),
  year_beast: () => import('./YearBeastPanel.vue'),
  sect_war: () => import('./SectWarPanel.vue'),

  /* ── 经营 ── */
  inventory: () => import('./InventoryPanel.vue'),
  market: () => import('./MarketPanel.vue'),
  pawnshop: () => import('./PawnshopPanel.vue'),
  stock: () => import('./StockPanel.vue'),
  auction: () => import('./AuctionPanel.vue'),
  crafting: () => import('./CraftingPanel.vue'),
  lottery: () => import('./LotteryPanel.vue'),

  /* ── 养成 ── */
  cave: () => import('./CavePanel.vue'),
  treasure: () => import('./EquipmentPanel.vue'),
  deep_line: () => import('./BloodSwordPanel.vue'),
  artifact_spirit: () => import('./ArtifactSpiritPanel.vue'),
  formation: () => import('./FormationPanel.vue'),
  puppet: () => import('./PuppetPanel.vue'),
  spirit_beast: () => import('./SpiritBeastPanel.vue'),

  /* ── 境界 ── */
  nascent_soul: () => import('./NascentSoulPanel.vue'),
  second_soul: () => import('./SecondSoulPanel.vue'),
  small_world: () => import('./SmallWorldPanel.vue'),
  ascension: () => import('./AscensionPanel.vue'),

  /* ── 宗门 ── */
  sect: () => import('./SectPanel.vue'),
  taoism_gate: () => import('./TaoismGatePanel.vue'),

  /* ── 红尘 ── */
  companion: () => import('./CompanionPanel.vue'),
  dao_companion: () => import('./DaoCompanionPanel.vue'),
  concubine: () => import('./ConcubinePanel.vue'),
  cave_social: () => import('./CaveSocialPanel.vue'),

  /* ── 闲趣 ── */
  fishing: () => import('./FishingPanel.vue'),
  gambling_stone: () => import('./GamblingStonePanel.vue'),
  ghost_casino: () => import('./GhostCasinoPanel.vue'),

  /* ── 自身 ── */
  character: () => import('../modals/CharacterModal.vue'),
  achievement: () => import('./AchievementPanel.vue'),
  // 公告消息：玩家侧唯一的公告长期存档入口（实时弹窗关掉即消失，配图也就找不回来了）
  announcement: () => import('./AnnouncementPanel.vue'),
}

/** chunk 下载期间的占位，只在首次打开某个玩法的那几十毫秒出现 */
const PanelFallback = {
  render() {
    return h('div', { class: 'h-full grid place-items-center' }, [
      h('span', {
        class: 'inline-block w-6 h-6 rounded-full border-2 border-line-strong border-t-gold-500 animate-spin',
        'aria-hidden': 'true',
      }),
    ])
  },
}

const cache = new Map()

/**
 * 取面板组件。首次访问时才创建 async wrapper 并缓存，
 * 否则每次切换都会生成新的 defineAsyncComponent，Vue 会整块重挂。
 */
export function resolvePanel(id) {
  if (!id) return null
  if (cache.has(id)) return cache.get(id)

  const loader = LOADERS[id]
  if (!loader) {
    console.error(`[panelRegistry] 功能「${ACTIONS[id]?.name || id}」(${id}) 已登记在目录中，但没有对应的面板。`)
    return null
  }

  const component = defineAsyncComponent({ loader, loadingComponent: PanelFallback, delay: 120, timeout: 20000 })
  cache.set(id, component)
  return component
}

/**
 * 启动自检：目录里有入口但这里没登记，玩家点了就是空白坞。
 * 这种错编译期发现不了，所以在控制台先报一遍。
 */
const missing = Object.keys(ACTIONS).filter(id => !LOADERS[id])
if (missing.length) {
  console.warn('[panelRegistry] 以下功能在 actionCatalog 中但无面板实现:', missing)
}
