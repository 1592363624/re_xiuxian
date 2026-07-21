/**
 * 灵兽系统管理 API（GM 后台）
 *
 * 封装 GM 后台对灵兽系统的管理接口（参考 server/routes/admin_spirit_beast.js）。
 * 所有接口需要管理员权限（后端 auth + adminCheck 双层中间件）。
 *
 * 接口列表：
 *   1. GET    /admin/spirit-beast/stats：全局统计（总数/出战/分布/Top10）
 *   2. GET    /admin/spirit-beast/beasts：分页查询所有灵兽（多条件过滤）
 *   3. GET    /admin/spirit-beast/beasts/:beastId：灵兽详情
 *   4. GET    /admin/spirit-beast/players/:playerId/beasts：玩家全部灵兽
 *   5. POST   /admin/spirit-beast/give：GM 直接发放灵兽
 *   6. PUT    /admin/spirit-beast/beasts/:beastId：修改灵兽属性
 *   7. DELETE /admin/spirit-beast/beasts/:beastId：删除灵兽
 *   8. POST   /admin/spirit-beast/beasts/:beastId/set-active：强制出战
 *   9. POST   /admin/spirit-beast/beasts/:beastId/reset-cooldowns：重置冷却
 */
import apiClient from './index';

/** 灵兽管理列表项/详情类型（与后端 formatBeast 输出一致） */
export interface AdminSpiritBeastItem {
  /** 灵兽实例ID */
  beast_id: number;
  /** 所属玩家ID */
  player_id: number;
  /** 所属玩家昵称 */
  player_nickname: string | null;
  /** 所属玩家境界名 */
  player_realm: string | null;
  /** 所属玩家境界rank */
  player_realm_rank: number | null;
  /** 灵兽种类key（如 qingyun_wolf） */
  beast_key: string;
  /** 灵兽自定义昵称（null 表示使用默认名） */
  beast_name: string | null;
  /** 元素属性：metal/wood/water/fire/earth */
  element: string;
  /** 稀有度：common/rare/epic/legendary */
  rarity: string;
  /** 星级（1-10） */
  star_level: number;
  /** 等级（1-100） */
  level: number;
  /** 经验值（BIGINT 字符串） */
  exp: string;
  /** 气血上限（BIGINT 字符串） */
  hp_max: string;
  /** 攻击 */
  atk: number;
  /** 防御 */
  def: number;
  /** 速度 */
  speed: number;
  /** 忠诚度（0-100） */
  loyalty: number;
  /** 是否出战中 */
  is_active: boolean;
  /** 最后喂养时间 */
  last_feed_time: string | null;
  /** 最后互动时间 */
  last_interact_time: string | null;
  /** 捕获时间 */
  caught_at: string | null;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
}

/** 全局灵兽系统统计 */
export interface SpiritBeastStats {
  /** 总灵兽数 */
  total_beasts: number;
  /** 出战灵兽数 */
  active_beasts: number;
  /** 拥有灵兽的玩家数 */
  players_with_beasts: number;
  /** 今日新增捕获数 */
  today_new_beasts: number;
  /** 按稀有度分布 */
  rarity_distribution: Array<{ rarity: string; rarity_name: string; count: number }>;
  /** 按元素分布 */
  element_distribution: Array<{ element: string; element_name: string; count: number }>;
  /** 按种类分布 */
  breed_distribution: Array<{ beast_key: string; count: number }>;
  /** 灵兽数量 Top10 玩家 */
  top_players: Array<{
    player_id: number;
    player_nickname: string;
    player_realm: string;
    beast_count: number;
  }>;
}

/** 列表查询参数 */
export interface BeastListParams {
  page?: number;
  limit?: number;
  player_id?: number;
  beast_key?: string;
  rarity?: string;
  element?: string;
  is_active?: 'true' | 'false';
  keyword?: string;
}

/** GM 发放灵兽参数 */
export interface GiveBeastParams {
  player_id: number;
  beast_key: string;
  star_level?: number;
  level?: number;
  loyalty?: number;
  is_active?: boolean;
  beast_name?: string;
}

/** GM 修改灵兽属性参数 */
export interface UpdateBeastParams {
  beast_name?: string | null;
  star_level?: number;
  level?: number;
  exp?: string | number;
  loyalty?: number;
  atk?: number;
  def?: number;
  hp_max?: string | number;
  speed?: number;
  is_active?: boolean;
  /** 是否按新 level/star 重算属性 */
  recalculate?: boolean;
}

/** 重置冷却类型 */
export type ResetCooldownType = 'feed' | 'interact' | 'all';

/**
 * 获取灵兽系统全局统计
 * GET /admin/spirit-beast/stats
 */
export function getStats() {
  return apiClient.get('/admin/spirit-beast/stats');
}

/**
 * 分页查询所有灵兽（多条件过滤）
 * GET /admin/spirit-beast/beasts
 */
export function getBeastList(params: BeastListParams = {}) {
  return apiClient.get('/admin/spirit-beast/beasts', { params });
}

/**
 * 获取灵兽详情
 * GET /admin/spirit-beast/beasts/:beastId
 * @param beastId 灵兽ID
 */
export function getBeastDetail(beastId: number) {
  return apiClient.get(`/admin/spirit-beast/beasts/${beastId}`);
}

/**
 * 查询指定玩家全部灵兽
 * GET /admin/spirit-beast/players/:playerId/beasts
 * @param playerId 玩家ID
 */
export function getPlayerBeasts(playerId: number) {
  return apiClient.get(`/admin/spirit-beast/players/${playerId}/beasts`);
}

/**
 * GM 直接发放灵兽
 * POST /admin/spirit-beast/give
 */
export function giveBeast(params: GiveBeastParams) {
  return apiClient.post('/admin/spirit-beast/give', params);
}

/**
 * 修改灵兽属性
 * PUT /admin/spirit-beast/beasts/:beastId
 * @param beastId 灵兽ID
 * @param params 修改参数
 */
export function updateBeast(beastId: number, params: UpdateBeastParams) {
  return apiClient.put(`/admin/spirit-beast/beasts/${beastId}`, params);
}

/**
 * 删除灵兽（GM 介入）
 * DELETE /admin/spirit-beast/beasts/:beastId
 * @param beastId 灵兽ID
 * @param reason 删除原因（可选）
 */
export function deleteBeast(beastId: number, reason?: string) {
  const query = reason ? `?reason=${encodeURIComponent(reason)}` : '';
  return apiClient.delete(`/admin/spirit-beast/beasts/${beastId}${query}`);
}

/**
 * 强制设置出战状态
 * POST /admin/spirit-beast/beasts/:beastId/set-active
 * @param beastId 灵兽ID
 * @param active true=设为出战，false=取消出战
 */
export function setBeastActive(beastId: number, active: boolean = true) {
  return apiClient.post(`/admin/spirit-beast/beasts/${beastId}/set-active`, { active });
}

/**
 * 重置灵兽冷却时间
 * POST /admin/spirit-beast/beasts/:beastId/reset-cooldowns
 * @param beastId 灵兽ID
 * @param type 重置类型：feed/interact/all
 */
export function resetBeastCooldowns(beastId: number, type: ResetCooldownType = 'all') {
  return apiClient.post(`/admin/spirit-beast/beasts/${beastId}/reset-cooldowns`, { type });
}
