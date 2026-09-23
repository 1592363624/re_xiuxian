/**
 * 区域内容（与 server/config/grid_config.json 对齐的客户端裁剪）
 * 保证离线/未接 GridMapService 时主舞台也能玩。
 */

export const REGIONS = {
  yueguo: {
    id: 'yueguo',
    name: '越国·天南',
    kind: 'region',
    size: [12, 12],
    anchor: [0, 0],
    parent_id: null,
    seed: 20240901,
    required_realm: '凡人',
    default_map_id: 1,
    spawn_cells: [[0, 7], [1, 7], [0, 6]],
    danger: 2,
    terrain_zones: [
      { rect: [0, 0, 4, 11], terrain: 'plains', zone_id: 'yue_plain', name: '越国平原', danger: 1 },
      { rect: [5, 0, 8, 5], terrain: 'mountain', zone_id: 'qixuan_mtn', name: '七玄山径', danger: 2 },
      { rect: [5, 6, 11, 11], terrain: 'mountain', zone_id: 'caixia', name: '彩霞山', danger: 3 },
      { rect: [6, 8, 8, 10], terrain: 'forest', zone_id: 'wolf_valley', name: '狼谷', danger: 4 },
    ],
    terrain_fill: { plains: 0.55, forest: 0.25, mountain: 0.15, cave: 0.05 },
    poi_cells: [
      { x: 3, y: 4, cell_type: 'town', poi: 'yueguo_market', name: '越国坊市' },
      { x: 6, y: 3, cell_type: 'sect', poi: 'qixuanmen', name: '七玄门' },
      { x: 5, y: 2, cell_type: 'ruin_small', poi: 'caixia_trail', name: '彩霞山径' },
      { x: 8, y: 6, cell_type: 'ruin_small', poi: 'abandoned_mine', name: '废弃矿洞' },
      { x: 6, y: 9, cell_type: 'monster_nest', poi: 'wolf_nest', name: '狼谷', monster_id: 'wolf' },
      { x: 3, y: 10, cell_type: 'ruin_large', poi: 'cangkun_gate', name: '苍坤旧禁', sub_region_id: 'cangkun_ruin_inner' },
      { x: 4, y: 8, cell_type: 'resource', poi: 'herb_slope', name: '灵草坡', resource: { id: 'wild_herb', amount: 4, respawn_minutes: 25 } },
      { x: 9, y: 1, cell_type: 'resource', resource: { id: 'condensing_flower', amount: 3, respawn_minutes: 30 } },
      { x: 10, y: 8, cell_type: 'barrier' },
      { x: 10, y: 9, cell_type: 'barrier' },
      { x: 11, y: 5, cell_type: 'portal', poi: 'to_luanxing', name: '渡口', portal_id: 'yueguo_to_luanxing' },
    ],
    hidden_cells: [
      { x: 9, y: 3, hidden: 'hidden_vein' },
      { x: 2, y: 11, hidden: 'hidden_cave' },
    ],
    resource_rules: [
      { terrain: 'plains', pool: ['wild_herb', 'condensing_flower', 'firewood'], density: 0.2, respawn_minutes: 25 },
      { terrain: 'forest', pool: ['wild_herb', 'blood_grass', 'firewood'], density: 0.22, respawn_minutes: 35 },
      { terrain: 'mountain', pool: ['blood_grass', 'golden_ore', 'condensing_flower'], density: 0.24, respawn_minutes: 45 },
      { terrain: 'cave', pool: ['golden_ore'], density: 0.18, respawn_minutes: 50 },
    ],
    monster_density: 0.14,
    cell_type_weights: { empty: 72, resource: 0, monster_nest: 14, ruin_small: 8, barrier: 6 },
    overrides: [
      { x: 9, y: 3, forbid_build: true },
      { x: 2, y: 11, forbid_build: true },
    ],
  },

  luanxing_sea: {
    id: 'luanxing_sea',
    name: '乱星海',
    kind: 'region',
    size: [20, 20],
    anchor: [2, 0],
    parent_id: null,
    seed: 20240903,
    required_realm: '筑基期',
    default_map_id: 4,
    danger: 5,
    terrain_zones: [
      { rect: [0, 0, 6, 6], terrain: 'plains', zone_id: 'hai_gang', name: '海港', danger: 3 },
      { rect: [7, 0, 19, 19], terrain: 'ocean', zone_id: 'xing_hai', name: '星海腹地', danger: 6 },
      { rect: [12, 12, 19, 19], terrain: 'ocean', zone_id: 'an_jiao', name: '暗礁带', danger: 8 },
    ],
    terrain_fill: { ocean: 0.7, plains: 0.15, mountain: 0.1, cave: 0.05 },
    poi_cells: [
      { x: 0, y: 5, cell_type: 'portal', poi: 'to_yueguo', name: '归渡', portal_id: 'yueguo_to_luanxing' },
      { x: 2, y: 3, cell_type: 'town', poi: 'haigang', name: '海港坊市' },
      { x: 14, y: 8, cell_type: 'ruin_large', poi: 'xinghai_altar', name: '星祭坛' },
      { x: 16, y: 16, cell_type: 'ruin_large', poi: 'anxiao_gate', name: '暗礁禁门' },
      { x: 10, y: 10, cell_type: 'monster_nest', monster_id: 'shark', hidden: 'hidden_robber' },
    ],
    resource_rules: [
      { terrain: 'ocean', pool: ['seaweed', 'pearl', 'coral'], density: 0.18, respawn_minutes: 60 },
      { terrain: 'plains', pool: ['wild_herb', 'condensing_flower'], density: 0.15, respawn_minutes: 30 },
    ],
    cell_type_weights: { empty: 68, resource: 0, monster_nest: 18, ruin_small: 7, barrier: 7 },
  },
}

export const REGION_BY_MAP_ID = {
  1: 'yueguo',
  2: 'yueguo',
  3: 'yueguo',
  4: 'luanxing_sea',
  5: 'yueguo',
  6: 'yueguo',
  7: 'yueguo',
  8: 'yueguo',
}

export function resolveRegion(mapId, mapName) {
  if (mapName && String(mapName).includes('乱星')) return REGIONS.luanxing_sea
  if (mapName && (String(mapName).includes('越') || String(mapName).includes('七玄') || String(mapName).includes('彩霞'))) {
    return REGIONS.yueguo
  }
  const id = REGION_BY_MAP_ID[mapId] || 'yueguo'
  return REGIONS[id] || REGIONS.yueguo
}

export const RESOURCE_NAMES = {
  wild_herb: '普通灵草',
  condensing_flower: '凝气花',
  firewood: '干柴',
  blood_grass: '血灵草',
  golden_ore: '金精石',
  seaweed: '海藻',
  pearl: '珍珠',
  coral: '珊瑚',
  spirit_root: '血灵根',
}

export const PLACE_ACTIONS = {
  wild: [
    { id: 'mark', label: '钉下标记', primary: false },
  ],
  resource: [
    { id: 'gather', label: '采集', primary: true },
    { id: 'mark', label: '钉下标记', primary: false },
  ],
  monster_nest: [
    { id: 'challenge', label: '挑战据点', primary: true },
    { id: 'probe', label: '神识探查', primary: false },
  ],
  ruin_small: [
    { id: 'explore', label: '探索遗迹', primary: true },
    { id: 'mark', label: '钉下标记', primary: false },
  ],
  ruin_large: [
    { id: 'enter', label: '进入子区域', primary: true },
    { id: 'mark', label: '钉下标记', primary: false },
  ],
  cave_player: [
    { id: 'knock', label: '叩门拜访', primary: true },
  ],
  sect: [
    { id: 'enter', label: '进入山门', primary: true },
    { id: 'sect', label: '宗门事务', primary: false },
  ],
  town: [
    { id: 'enter', label: '进入坊市', primary: true },
    { id: 'market', label: '买卖', primary: false },
    { id: 'market', label: '典当', primary: false, action: 'pawnshop' },
  ],
  portal: [
    { id: 'portal', label: '启用传送', primary: true },
  ],
  barrier: [],
  empty: [
    { id: 'build', label: '安家立府', primary: true },
    { id: 'mark', label: '钉下标记', primary: false },
  ],
}
