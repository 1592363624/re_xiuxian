/**
 * 封神台 API（PVP 镜像排名竞技场）
 *
 * 封神台是赛季制异步 PVP 竞技场：玩家设置防守阵容（快照当前属性），
 * 其他玩家可挑战排名高于自己的玩家，胜利则交换排名。
 * 赛季结束后按排名发放荣誉和灵石奖励，积分重置。
 *
 * 设计原则：所有业务逻辑在后端，前端仅做展示与接口调用
 *
 * 6 个接口：
 *   1. GET  /fengshen/ranking   — 获取排行榜（分页）
 *   2. GET  /fengshen/my         — 获取我的封神台信息
 *   3. POST /fengshen/defense    — 设置防守阵容
 *   4. GET  /fengshen/defense    — 获取我的防守阵容
 *   5. POST /fengshen/challenge  — 挑战指定排名
 *   6. GET  /fengshen/season     — 获取赛季信息
 */
import apiClient from './index';

/** 排行榜条目 */
export interface FengshenRankingEntry {
  /** 排名 */
  rank: number;
  /** 玩家ID */
  player_id: number;
  /** 玩家昵称 */
  nickname: string;
  /** 境界名称 */
  realm: string;
  /** 境界排名（数值） */
  realm_rank: number;
  /** 封神积分 */
  fengshen_score: number;
  /** 累计胜利次数 */
  total_wins: number;
  /** 累计失败次数 */
  total_losses: number;
  /** 胜率（百分比） */
  win_rate: number;
}

/** 排行榜返回 */
export interface FengshenRankingResult {
  /** 排行榜列表 */
  list: FengshenRankingEntry[];
  /** 总人数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页数量 */
  page_size: number;
  /** 我的排名（0=未上榜） */
  my_rank: number;
  /** 我的封神积分 */
  my_score: number;
}

/** 我的封神台信息 */
export interface MyFengshenInfo {
  /** 排名（0=未上榜） */
  rank: number;
  /** 封神积分 */
  fengshen_score: number;
  /** 累计胜利次数 */
  total_wins: number;
  /** 累计失败次数 */
  total_losses: number;
  /** 胜率（百分比） */
  win_rate: number;
  /** 今日挑战次数 */
  daily_challenge_count: number;
  /** 今日剩余挑战次数 */
  daily_challenge_remaining: number;
  /** 是否已设置防守阵容 */
  defense_set: boolean;
  /** 防守阵容设置时间 */
  defense_set_at: string | null;
  /** 当前赛季编号 */
  season: number;
}

/** 防守阵容属性快照 */
export interface DefenseSnapshot {
  nickname: string;
  realm: string;
  realm_rank: number;
  atk: number;
  def: number;
  speed: number;
  hp_max: number;
  hp_current: number;
  mp_current: number;
}

/** 防守阵容返回 */
export interface DefenseResult {
  has_defense: boolean;
  defense_config: Record<string, any>;
  snapshot: DefenseSnapshot | null;
  defense_set_at: string | null;
}

/** 设置防守阵容返回 */
export interface SetDefenseResult {
  success: boolean;
  defense_set_at: string;
  rank: number;
  fengshen_score: number;
}

/** 战斗日志条目 */
export interface BattleLogEntry {
  round: number;
  event: string;
  attacker_power?: number;
  defender_power?: number;
  attacker_roll?: number;
  defender_roll?: number;
  winner?: string;
  timestamp: string;
}

/** 挑战结果 */
export interface ChallengeResult {
  battle_result: {
    attacker_wins: boolean;
    attacker_power: number;
    defender_power: number;
    attacker_score_change: number;
    defender_score_change: number;
    battle_log: BattleLogEntry[];
  };
  my_rank: number;
  my_score: number;
  defender_id: number;
  defender_nickname: string;
  defender_rank: number;
  defender_score: number;
  daily_challenge_count: number;
  daily_challenge_remaining: number;
}

/** 赛季信息 */
export interface SeasonInfo {
  current_season: number;
  season_start: string;
  season_end: string;
  remaining_days: number;
  season_duration_days: number;
  reward_enabled: boolean;
  top_ranks: number[];
  rank_reward_honor: number[];
  rank_reward_stones: number[];
}

/**
 * 获取封神台排行榜（分页）
 * GET /fengshen/ranking
 * @param page 页码（默认 1）
 * @param page_size 每页数量（默认 20，最大 100）
 */
export const getRanking = (page = 1, page_size = 20) => {
  return apiClient.get<FengshenRankingResult>('/fengshen/ranking', {
    params: { page, page_size }
  });
};

/**
 * 获取我的封神台信息
 * GET /fengshen/my
 */
export const getMyRanking = () => {
  return apiClient.get<MyFengshenInfo>('/fengshen/my');
};

/**
 * 设置防守阵容
 * POST /fengshen/defense
 * @param defense_config 防守配置（装备/法宝选择等，后端会快照当前属性）
 */
export const setDefense = (defense_config: Record<string, any> = {}) => {
  return apiClient.post<SetDefenseResult>('/fengshen/defense', { defense_config });
};

/**
 * 获取我的防守阵容
 * GET /fengshen/defense
 */
export const getDefense = () => {
  return apiClient.get<DefenseResult>('/fengshen/defense');
};

/**
 * 挑战指定排名的玩家
 * POST /fengshen/challenge
 * @param target_rank 目标排名（必须比自己高，且在 challenge_rank_range 范围内）
 */
export const challengeRank = (target_rank: number) => {
  return apiClient.post<ChallengeResult>('/fengshen/challenge', { target_rank });
};

/**
 * 获取赛季信息
 * GET /fengshen/season
 */
export const getSeasonInfo = () => {
  return apiClient.get<SeasonInfo>('/fengshen/season');
};
