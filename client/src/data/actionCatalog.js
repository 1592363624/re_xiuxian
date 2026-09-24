/**
 * 功能入口目录
 *
 * 全站唯一事实来源：右坞（桌面）与底部操作条（移动）都从这里取数，
 * 避免两处各维护一份按钮清单导致漂移。
 *
 * 新增功能三步：
 *   1. 在 ACTIONS 里补一条 { name, desc, icon }
 *   2. 把 id 追加进某个分组的 ids
 *   3. 在 components/panels/registry.js 里把同一个 id 登记到面板组件
 *      （动态 import，Vite 会自动切出独立 chunk）
 * 漏做第 2 步会在控制台告警（见 FeatureDock 的 ungroupedActionIds）；
 * 漏做第 3 步也会告警，且 GameLayout 会给出"暂未开放"而不是白屏。
 *
 * 本文件只放元数据，不要 import 任何组件 —— 它被首屏同步加载。
 */

const svg = (cls, paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="${cls}">${paths}</svg>`

export const ACTIONS = {
  /* ── 修行 ── */
  cultivate: { name: '修炼', desc: '闭关修炼 突破境界', icon: svg('text-cyan-400', '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>') },
  technique: { name: '功法', desc: '修炼突破 领悟装备', icon: svg('text-sky-400', '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>') },
  meditation: { name: '悟道', desc: '静思悟道 破除瓶颈', icon: svg('text-amber-400', '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>') },
  dayan: { name: '大衍诀', desc: '大衍诀修炼 神识飞升前置', icon: svg('text-indigo-300', '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="11"/><path d="M12 1v3"/><path d="M12 20v3"/>') },

  /* ── 历练 ── */
  explore: { name: '历练', desc: '历练探索 随机事件', icon: svg('text-emerald-400', '<path d="M12 2 2.5 9.5l1 10.5L12 22l8.5-2L22 10l-10-7.5z"/><path d="M12 12 12 22"/><path d="M12 12 22 12"/>') },
  trial_tower: { name: '试炼古塔', desc: '闯塔首通 琉璃塔榜', icon: svg('text-amber-300', '<path d="M12 2l2 6h6l-5 4 2 7-5-4-5 4 2-7-5-4h6z"/>') },
  map: { name: '地图', desc: '当前区域 相邻快传', icon: svg('text-emerald-300', '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>') },
  dungeon: { name: '副本', desc: '秘境副本 三星扫荡', icon: svg('text-amber-400', '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/><path d="M9 11h6"/>') },
  multi_dungeon: { name: '多人副本', desc: '掩月抢亲 端午镇蛟', icon: svg('text-amber-300', '<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/>') },
  beast_abyss: { name: '灵兽探渊', desc: '异步多人 PVE+PVP 探索', icon: svg('text-teal-400', '<path d="M12 2a4 4 0 0 0-4 4v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/><path d="M12 10v8"/><path d="M9 14h6"/><path d="M3 12a9 9 0 0 1 18 0"/>') },

  /* ── 征伐 ── */
  arena: { name: '斗法', desc: '挑战同修 争夺段位', icon: svg('text-red-400', '<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/>') },
  fengshen: { name: '封神台', desc: '镜像排名竞技场', icon: svg('text-purple-400', '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>') },
  divine_sense_duel: { name: '神识对决', desc: '1v1 同时选择博弈', icon: svg('text-purple-300', '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/><path d="M12 3v2"/><path d="M12 19v2"/><circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.4"/>') },
  bounty: { name: '悬赏', desc: '悬赏追杀 缉拿目标', icon: svg('text-amber-400', '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>') },
  world_risk: { name: '天道异闻', desc: '神魂风雷 凶名天机', icon: svg('text-purple-300', '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>') },
  world_boss: { name: '世界BOSS', desc: '全服讨伐 伤害排行', icon: svg('text-red-500', '<path d="M5 3v4l3 3"/><path d="M19 3v4l-3 3"/><path d="M3 5h4l3 3"/><path d="M21 5h-4l-3 3"/><path d="M12 12v9"/><path d="M8 17h8"/><circle cx="12" cy="9" r="3"/>') },
  sect_war: { name: '宗门战', desc: '领地争夺 赛季结算', icon: svg('text-amber-500', '<path d="M4 22V4l4-2 4 2 4-2 4 2v18"/><path d="M4 14h16"/><path d="M9 9h2"/><path d="M13 9h2"/><path d="M9 17h2"/><path d="M13 17h2"/>') },

  /* ── 经营 ── */
  inventory: { name: '储物袋', desc: '查看物品 整理行囊', icon: svg('text-amber-400', '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>') },
  market: { name: '坊市', desc: '买卖物品 互通有无', icon: svg('text-rose-400', '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>') },
  pawnshop: { name: '聚宝当铺', desc: '典当赎回 周转灵石', icon: svg('text-amber-400', '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>') },
  stock: { name: '聚宝股市', desc: '行情持仓 买卖融资', icon: svg('text-cyan-400', '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>') },
  auction: { name: '拍卖', desc: '竞价博弈 多人经济', icon: svg('text-rose-400', '<circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94"/>') },
  crafting: { name: '炼制', desc: '炼丹炼器 学习配方', icon: svg('text-orange-400', '<path d="M12 2c0 0-4 4-4 8a4 4 0 0 0 8 0c0-4-4-8-4-8z"/><path d="M8 14a4 4 0 1 0 8 0"/><path d="M5 18h14"/><path d="M7 22h10"/>') },
  lottery: { name: '寻仙机缘', desc: '单次十连 奖池预览', icon: svg('text-yellow-400', '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>') },

  /* ── 养成 ── */
  cave: { name: '洞府', desc: '洞府经营 药园种植', icon: svg('text-stone-400', '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/><path d="M9 11h6"/>') },
  treasure: { name: '法宝', desc: '祭炼本命 祭出收宝', icon: svg('text-indigo-400', '<path d="M12 2 4 7v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V7l-8-5z"/><path d="m9 12 2 2 4-4"/>') },
  deep_line: { name: '法宝深线', desc: '血魔剑残契 祭血镇契铭印', icon: svg('text-rose-400', '<path d="M12 22V8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/><path d="M12 8a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>') },
  artifact_spirit: { name: '器灵', desc: '唤醒温养 试炼护主', icon: svg('text-cyan-400', '<path d="M12 2v6"/><path d="M12 22v-6"/><path d="M4.93 4.93l4.24 4.24"/><path d="M14.83 14.83l4.24 4.24"/><path d="M2 12h6"/><path d="M22 12h-6"/><path d="M4.93 19.07l4.24-4.24"/><path d="M14.83 9.17l4.24-4.24"/>') },
  formation: { name: '阵法', desc: '布阵加持 五行相克', icon: svg('text-purple-400', '<circle cx="12" cy="12" r="10"/><path d="M12 2v20"/><path d="M2 12h20"/><circle cx="12" cy="12" r="4"/>') },
  puppet: { name: '傀儡工坊', desc: '制造出战 淬炼维修', icon: svg('text-amber-400', '<circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/>') },
  spirit_beast: { name: '灵兽', desc: '图鉴捕获 喂养出战', icon: svg('text-emerald-300', '<path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-2.97 7 .41 1.04 1 2.02 1.56 2.85 2.53 3.8-1.41 6.35-4.5 4.73l-3.23-1.68a19 19 0 0 0-2.57 0l-3.23 1.68c-3.09 1.62-7.03-.93-4.5-4.73.56-.83 1.15-1.81 1.56-2.85-2.55 0-4.37-6.42-2.97-7C4.62 2.25 7.87 3.09 9.65 5.09 10.3 4.92 11.33 5 12 5z"/>') },

  /* ── 境界 ── */
  nascent_soul: { name: '元婴出窍', desc: '出窍问道 法相天地', icon: svg('text-purple-400', '<path d="M12 2a3 3 0 0 0-3 3c0 1.6.8 3 2 4-1.2 1-2 2.4-2 4a3 3 0 0 0 6 0c0-1.6-.8-3-2-4 1.2-1 2-2.4 2-4a3 3 0 0 0-3-3z"/><path d="M5 22h14"/><path d="M12 16v6"/>') },
  second_soul: { name: '第二元神', desc: '凝练分化 独立修炼', icon: svg('text-indigo-300', '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18"/><path d="M3 12h18"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>') },
  small_world: { name: '小世界', desc: '开辟世界 香火神庙', icon: svg('text-cyan-300', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a9 9 0 0 1 0 18"/><path d="M12 3a9 9 0 0 0 0 18"/><path d="M7 8h10"/><path d="M7 16h10"/>') },
  ascension: { name: '飞升灵界', desc: '飞升渡劫 夺舍重生', icon: svg('text-amber-300', '<path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/>') },

  /* ── 宗门 ── */
  sect: { name: '宗门', desc: '宗门任务 兑换贡献', icon: svg('text-violet-400', '<path d="M3 21h18"/><path d="M5 21V7l8-4 8 4v14"/><path d="M17 21v-8H7v8"/>') },
  taoism_gate: { name: '太一门', desc: '五行道途 多人共鸣', icon: svg('text-indigo-300', '<path d="M12 2 4 7v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V7l-8-5z"/><path d="M12 8a4 4 0 0 1 4 4"/><path d="M12 16a4 4 0 0 1-4-4"/><path d="M12 2v20"/><path d="M4 12h16"/>') },

  /* ── 红尘 ── */
  companion: { name: '道侣', desc: '道侣面板 心契心劫', icon: svg('text-rose-300', '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>') },
  dao_companion: { name: '双修', desc: '玩家间 1v1 长期社交', icon: svg('text-rose-400', '<path d="M12 21s-7.5-4.9-9.5-9.2A5.3 5.3 0 0 1 12 6.3a5.3 5.3 0 0 1 9.5 5.5C19.5 16.1 12 21 12 21z"/><path d="M12 6.3v14.7"/>') },
  concubine: { name: '侍妾', desc: '红尘寻缘 远航归来', icon: svg('text-fuchsia-300', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>') },
  cave_social: { name: '洞府社交', desc: '留言板 访客录 游商', icon: svg('text-emerald-400', '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>') },

  /* ── 闲趣 ── */
  fishing: { name: '灵溪垂钓', desc: '钓竿鱼饵 剖鱼排行', icon: svg('text-cyan-400', '<path d="M12 2v14"/><path d="M12 16a4 4 0 0 1-4-4"/><circle cx="12" cy="20" r="2"/><path d="M6 20q3 2 6 0t6 0"/>') },
  gambling_stone: { name: '赌石', desc: '线索博弈 切石机缘', icon: svg('text-purple-400', '<path d="M12 2 4 7v10l8 5 8-5V7l-8-5z"/><path d="M12 22V12"/><path d="M4 7l8 5 8-5"/><path d="M9 9l3-2 3 2"/>') },
  ghost_casino: { name: '鬼赌坊', desc: '天命玉简 六道轮回', icon: svg('text-fuchsia-400', '<path d="M12 3a6 6 0 0 0-6 6c0 4 6 12 6 12s6-8 6-12a6 6 0 0 0-6-6z"/><circle cx="12" cy="9" r="2"/>') },

  /* ── 自身 ── */
  character: { name: '角色', desc: '属性资质 装备总览', icon: svg('text-stone-300', '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>') },
  achievement: { name: '成就', desc: '成就总览 奖励领取', icon: svg('text-yellow-500', '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>') },
  announcement: { name: '公告', desc: '全服公告 消息存档', icon: svg('text-amber-400', '<path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8a5 5 0 0 1 0 8"/><path d="M18 5a9 9 0 0 1 0 14"/>') },
}

/**
 * 分类标签页。总览固定第一位，其余按游戏节奏排列。
 */
export const DOCK_TABS = [
  { key: 'practice', label: '修行', ids: ['cultivate', 'technique', 'meditation', 'dayan'] },
  { key: 'adventure', label: '历练', ids: ['explore', 'trial_tower', 'map', 'dungeon', 'multi_dungeon', 'beast_abyss'] },
  { key: 'battle', label: '征伐', ids: ['arena', 'fengshen', 'divine_sense_duel', 'bounty', 'world_risk', 'world_boss', 'sect_war'] },
  { key: 'economy', label: '经营', ids: ['inventory', 'market', 'pawnshop', 'stock', 'auction', 'crafting', 'lottery'] },
  { key: 'nurture', label: '养成', ids: ['cave', 'treasure', 'deep_line', 'artifact_spirit', 'formation', 'puppet', 'spirit_beast'] },
  { key: 'sect', label: '宗门', ids: ['sect', 'taoism_gate'] },
  { key: 'worldly', label: '红尘', ids: ['companion', 'dao_companion', 'concubine', 'cave_social'] },
  { key: 'realm', label: '境界', ids: ['nascent_soul', 'second_soul', 'small_world', 'ascension'] },
  { key: 'leisure', label: '闲趣', ids: ['fishing', 'gambling_stone', 'ghost_casino'] },
  { key: 'self', label: '自身', ids: ['character', 'achievement', 'announcement'] },
]

/** 移动端底部操作条的高频入口 */
export const QUICK_ACTION_IDS = [
  'cultivate', 'explore', 'inventory', 'technique', 'market', 'sect',
  'cave', 'treasure', 'crafting', 'meditation', 'arena', 'map'
]

export const resolveAction = (id) => {
  const meta = ACTIONS[id]
  return meta ? { id, ...meta } : null
}

export const tabEntries = (tab) => tab.ids.map(resolveAction).filter(Boolean)
