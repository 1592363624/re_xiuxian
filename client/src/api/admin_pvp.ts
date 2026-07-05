/**
 * PVP 斗法管理 API（GM 后台）
 *
 * 封装 GM 后台对玩家 PVP 段位、积分、战斗记录的查询/调整/重置/取消等接口。
 * 所有接口需要管理员权限（后端 auth + adminCheck 双层中间件）。
 *
 * 接口列表：
 *   1. GET  /admin/pvp/metrics：获取 PVP 系统统计指标（在线战斗、段位分布等）
 *   2. GET  /admin/pvp/list：分页查询玩家段位列表
 *   3. GET  /admin/pvp/battles：分页查询战斗记录
 *   4. GET  /admin/pvp/:playerId：查询指定玩家 PVP 详情
 *   5. PUT  /admin/pvp/:playerId/score：调整玩家 PVP 积分
 *   6. POST /admin/pvp/:playerId/score/reset：重置玩家段位（清零积分与赛季战绩）
 *   7. POST /admin/pvp/battle/:battleId/cancel：强制取消进行中的战斗
 */
import apiClient from './index';
import type { BattleType } from './pvp';

/** 段位分布柱状图数据（key=段位名，value=玩家数） */
export type PvpRankDistribution = Record<string, number>;

/** PVP 系统统计指标（GET /admin/pvp/metrics 返回） */
export interface PvpMetrics {
  /** 当前进行中战斗数 */
  ongoing_battles: number;
  /** 段位分布（按段位名分组计数） */
  rank_distribution: PvpRankDistribution;
  /** 今日战斗总数 */
  total_battles_today: number;
  /** PVP 玩家总数 */
  total_players: number;
}

/** 玩家段位列表项（GET /admin/pvp/list 返回项） */
export interface PvpListItem {
  /** 玩家 ID */
  id: number;
  /** 昵称 */
  nickname: string;
  /** 当前境界 */
  realm: string;
  /** 段位名称 */
  rank_tier: string;
  /** 当前积分 */
  score: number;
  /** 赛季胜场 */
  season_wins: number;
  /** 赛季败场 */
  season_losses: number;
  /** 当前连胜 */
  win_streak: number;
  /** 总场次 */
  total_battles: number;
  /** 胜率（0-100） */
  win_rate: number;
  /** 是否在战斗中 */
  is_in_battle?: boolean;
}

/** 列表查询参数 */
export interface PvpListParams {
  /** 筛选段位（散修/道子/真传/长老/宗主/大能），不传则全部 */
  rank_tier?: string;
  /** 是否仅查询在战斗中玩家 */
  in_battle?: boolean;
  /** 昵称模糊搜索关键字 */
  keyword?: string;
  /** 页码（默认 1） */
  page?: number;
  /** 每页条数（默认 20，最大 100） */
  limit?: number;
}

/** 战斗记录列表项（GET /admin/pvp/battles 返回项） */
export interface PvpBattleItem {
  /** 战斗 ID */
  id: number;
  /** 战斗类型 */
  battle_type: BattleType;
  /** 攻击方玩家 ID */
  attacker_id: number;
  /** 攻击方昵称 */
  attacker_nickname?: string;
  /** 防守方玩家 ID */
  defender_id: number;
  /** 防守方昵称 */
  defender_nickname?: string;
  /** 胜方玩家 ID（null 表示平局） */
  winner_id: number | null;
  /** 总回合数 */
  total_rounds: number;
  /** 攻击方积分变化 */
  attacker_score_change: number;
  /** 防守方积分变化 */
  defender_score_change: number;
  /** 攻击方荣誉获得 */
  attacker_honor_gain: number;
  /** 防守方荣誉获得 */
  defender_honor_gain: number;
  /** 灵石奖励 */
  spirit_stone_reward: number;
  /** 战斗状态：ongoing / finished / cancelled */
  status?: string;
  /** 开始时间 */
  started_at: string;
  /** 结束时间（进行中为 null） */
  finished_at: string | null;
}

/** 战斗记录查询参数 */
export interface PvpBattleListParams {
  /** 战斗状态：ongoing / finished / cancelled，不传则全部 */
  status?: string;
  /** 攻击方/防守方玩家 ID 过滤 */
  player_id?: number;
  /** 战斗类型过滤 */
  battle_type?: BattleType;
  /** 页码 */
  page?: number;
  /** 每页条数 */
  limit?: number;
}

/** 玩家 PVP 详情（GET /admin/pvp/:playerId 返回） */
export interface PvpPlayerDetail extends PvpListItem {
  /** 战力 */
  power: number;
  /** 荣誉值 */
  honor: number;
  /** 因果值 */
  karma: number;
  /** 是否处于虚弱状态 */
  is_weak: boolean;
  /** 虚弱剩余时间（秒） */
  weakness_remaining_seconds: number;
  /** 战斗冷却剩余时间（秒） */
  cooldown_remaining_seconds: number;
  /** 今日已用挑战次数 */
  daily_challenge_used?: number;
  /** 今日已用防守次数 */
  daily_defend_used?: number;
  /** 历史最高连胜 */
  max_win_streak?: number;
  /** 赛季平局数 */
  season_draws?: number;
  /** 上次战斗时间 */
  last_battle_time?: string | null;
}

/** 调整积分请求体 */
export interface UpdateScoreBody {
  /** 新积分（>=0） */
  score: number;
  /** 调整原因（必填，记录到操作日志） */
  reason: string;
}

/**
 * 获取 PVP 系统统计指标
 * GET /admin/pvp/metrics
 */
export const getMetrics = () => {
  return apiClient.get<PvpMetrics>('/admin/pvp/metrics');
};

/**
 * 分页查询玩家段位列表
 * GET /admin/pvp/list
 * @param params 查询参数（rank_tier/in_battle/keyword/page/limit）
 */
export const getList = (params: PvpListParams = {}) => {
  return apiClient.get<{ list: PvpListItem[]; total: number; page: number; pageSize: number }>(
    '/admin/pvp/list',
    { params }
  );
};

/**
 * 分页查询战斗记录
 * GET /admin/pvp/battles
 * @param params 查询参数（status/player_id/battle_type/page/limit）
 */
export const getBattles = (params: PvpBattleListParams = {}) => {
  return apiClient.get<{ list: PvpBattleItem[]; total: number; page: number; pageSize: number }>(
    '/admin/pvp/battles',
    { params }
  );
};

/**
 * 查询指定玩家的 PVP 详情
 * GET /admin/pvp/:playerId
 * @param playerId 玩家 ID
 */
export const getPlayerDetail = (playerId: number) => {
  return apiClient.get<PvpPlayerDetail>(`/admin/pvp/${playerId}`);
};

/**
 * 调整玩家 PVP 积分（GM 调整）
 * PUT /admin/pvp/:playerId/score
 * @param playerId 玩家 ID
 * @param body 调整参数（score + reason）
 */
export const updateScore = (playerId: number, body: UpdateScoreBody) => {
  return apiClient.put<{ score: number; rank_tier: string; message: string }>(
    `/admin/pvp/${playerId}/score`,
    body
  );
};

/**
 * 重置玩家段位（清零积分与赛季战绩）
 * POST /admin/pvp/:playerId/score/reset
 * @param playerId 玩家 ID
 */
export const resetScore = (playerId: number) => {
  return apiClient.post<{ message: string }>(`/admin/pvp/${playerId}/score/reset`);
};

/**
 * 强制取消进行中的战斗
 * POST /admin/pvp/battle/:battleId/cancel
 * @param battleId 战斗 ID
 */
export const cancelBattle = (battleId: number | string) => {
  return apiClient.post<{ message: string }>(`/admin/pvp/battle/${battleId}/cancel`);
};
