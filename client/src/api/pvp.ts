/**
 * PVP 斗法相关 API
 *
 * 第四阶段新增玩法：玩家之间通过斗法争夺段位（散修/道子/真传/长老/宗主/大能），
 * 胜者获得积分、荣誉、灵石奖励，败者扣除积分并进入虚弱状态。
 *
 * 段位体系（六档）：
 *   - 散修：0 ~ 499
 *   - 道子：500 ~ 999
 *   - 真传：1000 ~ 1999
 *   - 长老：2000 ~ 3499
 *   - 宗主：3500 ~ 4999
 *   - 大能：5000+
 *
 * 限制与冷却：
 *   - 每日挑战次数上限（默认 10 次）
 *   - 每日防守次数上限（默认 5 次）
 *   - 战斗冷却（默认 300 秒）
 *   - 失败后虚弱状态（默认 30 分钟，修炼/突破效率下降）
 *   - 最大回合数（默认 30 回合）
 *   - 回合超时（默认 60 秒，超时自动跳过/判负）
 *
 * 战斗操作：
 *   - attack：普通攻击（无消耗）
 *   - skill：技能攻击（消耗 MP）
 *   - defend：防御（减少受到的伤害，回复部分 MP）
 *   - flee：逃跑（放弃战斗，按失败结算）
 */
import apiClient from './index';

/** 战斗动作类型 */
export type BattleActionType = 'attack' | 'skill' | 'defend';

/** 战斗类型 */
export type BattleType = 'normal' | 'ranked';

/** 段位配置项 */
export interface PvpRankTier {
  /** 段位名称 */
  name: string;
  /** 最低积分（含） */
  min_score: number;
  /** 最高积分（含，-1 表示无上限） */
  max_score: number;
}

/** PVP 系统配置 */
export interface PvpConfig {
  /** 每日挑战次数上限 */
  daily_challenge_limit: number;
  /** 每日防守次数上限 */
  daily_defend_limit: number;
  /** 战斗冷却时间（秒） */
  cooldown_seconds: number;
  /** 虚弱状态持续时间（分钟） */
  weakness_duration_minutes: number;
  /** 最大回合数 */
  max_rounds: number;
  /** 回合超时时间（秒） */
  round_timeout_seconds: number;
  /** 段位列表（按积分区间递增） */
  ranks: PvpRankTier[];
}

/** 进行中战斗信息 */
export interface PvpBattleInfo {
  /** 战斗唯一 ID */
  battle_id: number | string;
  /** 是否为挑战方 */
  is_attacker: boolean;
  /** 对手玩家 ID */
  opponent_id: number;
  /** 对手昵称 */
  opponent_nickname: string;
  /** 对手境界 */
  opponent_realm: string;
  /** 对手战力 */
  opponent_power: number;
  /** 己方战力 */
  attacker_power: number;
  /** 当前回合 */
  current_round: number;
  /** 最大回合 */
  max_rounds: number;
  /** 是否己方回合 */
  is_my_turn: boolean;
  /** 战斗开始时间 */
  started_at: string;
  /** 战斗日志（按时间倒序，最新在前） */
  battle_log: PvpBattleLogEntry[];
}

/** 战斗日志条目 */
export interface PvpBattleLogEntry {
  /** 回合号 */
  round?: number;
  /** 行动方：attacker / defender */
  actor?: string;
  /** 动作类型 */
  action?: BattleActionType;
  /** 造成的伤害 */
  damage?: number;
  /** 行动方剩余 HP */
  attacker_hp?: number;
  /** 防守方剩余 HP */
  defender_hp?: number;
  /** 文案内容 */
  text?: string;
  /** 时间戳 */
  timestamp?: string;
}

/** 玩家段位与战绩信息 */
export interface PvpRanking {
  /** 当前积分 */
  score: number;
  /** 当前段位名称 */
  rank_tier: string;
  /** 赛季胜场 */
  season_wins: number;
  /** 赛季败场 */
  season_losses: number;
  /** 赛季平局 */
  season_draws: number;
  /** 当前连胜 */
  win_streak: number;
  /** 历史最高连胜 */
  max_win_streak: number;
  /** 今日剩余挑战次数 */
  daily_challenge_remaining: number;
  /** 今日剩余防守次数 */
  daily_defend_remaining: number;
  /** 总场次 */
  total_battles: number;
  /** 胜率（0-100） */
  win_rate: number;
}

/** 玩家自身 PVP 状态 */
export interface PvpPlayerState {
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
  /** 当前 PVP 积分 */
  pvp_score: number;
  /** 当前段位 */
  pvp_rank: string;
  /** 战斗冷却剩余时间（秒） */
  cooldown_remaining_seconds: number;
}

/** GET /pvp/status 返回的完整状态 */
export interface PvpStatus {
  /** 是否在 PVP 战斗中 */
  is_in_pvp_battle: boolean;
  /** 进行中战斗信息（无则 null） */
  battle_info: PvpBattleInfo | null;
  /** 段位与战绩 */
  ranking: PvpRanking;
  /** 玩家自身状态 */
  player: PvpPlayerState;
  /** PVP 系统配置 */
  config: PvpConfig;
  /** 服务端时间戳（用于本地 tick 倒计时） */
  server_time: number;
}

/** 排行榜条目 */
export interface PvpLeaderboardItem {
  /** 玩家 ID */
  player_id: number;
  /** 昵称 */
  nickname: string;
  /** 积分 */
  score: number;
  /** 段位 */
  rank_tier: string;
  /** 赛季胜场 */
  season_wins: number;
  /** 赛季败场 */
  season_losses: number;
  /** 当前连胜 */
  win_streak: number;
  /** 总场次 */
  total_battles: number;
}

/** 历史战斗记录项 */
export interface PvpHistoryItem {
  /** 战斗 ID */
  id: number;
  /** 战斗类型：normal/ranked */
  battle_type: BattleType;
  /** 攻击方玩家 ID */
  attacker_id: number;
  /** 防守方玩家 ID */
  defender_id: number;
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
  /** 开始时间 */
  started_at: string;
  /** 结束时间 */
  finished_at: string;
}

/** 战斗动作返回结果 */
export interface PvpActionResult {
  /** 当前回合 */
  round: number;
  /** 行动方：attacker / defender */
  actor: string;
  /** 动作类型 */
  action: BattleActionType;
  /** 造成的伤害 */
  damage: number;
  /** 攻击方剩余 HP */
  attacker_hp: number;
  /** 防守方剩余 HP */
  defender_hp: number;
  /** 战斗是否已结束 */
  is_finished: boolean;
  /** 胜方玩家 ID（未结束为 null） */
  winner_id: number | null;
  /** 战斗日志（按时间倒序） */
  battle_log: PvpBattleLogEntry[];
  /** 提示文案 */
  message?: string;
}

/** 发起挑战返回结果 */
export interface PvpChallengeResult {
  /** 战斗唯一 ID */
  battle_id: number | string;
  /** 对手信息 */
  opponent_info: {
    player_id: number;
    nickname: string;
    realm: string;
    power: number;
  };
  /** 先手方：attacker / defender */
  first_attacker: string;
  /** 提示文案 */
  message: string;
}

/** 历史记录查询参数 */
export interface PvpHistoryParams {
  /** 页码（默认 1） */
  page?: number;
  /** 每页条数（默认 20） */
  limit?: number;
}

/**
 * 获取 PVP 状态（段位、战绩、进行中战斗、冷却、虚弱等）
 * GET /pvp/status
 */
export const getStatus = () => {
  return apiClient.get<PvpStatus>('/pvp/status');
};

/**
 * 获取 PVP 排行榜
 * GET /pvp/leaderboard?limit=X
 * @param limit 返回条数，默认 50
 */
export const getLeaderboard = (limit = 50) => {
  return apiClient.get<{ list: PvpLeaderboardItem[]; total: number }>(
    '/pvp/leaderboard',
    { params: { limit } }
  );
};

/**
 * 获取 PVP 历史战斗记录（分页）
 * GET /pvp/history?page=X&limit=X
 * @param params 分页参数
 */
export const getHistory = (params: PvpHistoryParams = {}) => {
  return apiClient.get<{
    list: PvpHistoryItem[];
    total: number;
    page: number;
    pageSize: number;
  }>('/pvp/history', { params });
};

/**
 * 发起 PVP 挑战
 * POST /pvp/challenge
 * @param target_player_id 目标玩家 ID
 * @param battle_type 战斗类型，默认 normal
 */
export const challenge = (
  target_player_id: number,
  battle_type: BattleType = 'normal'
) => {
  return apiClient.post<PvpChallengeResult>('/pvp/challenge', {
    target_player_id,
    battle_type
  });
};

/**
 * 执行战斗动作
 * POST /pvp/action
 * @param action 动作类型：attack / skill / defend
 * @param skill_index 技能槽位（仅 skill 动作有效，默认 0）
 */
export const executeAction = (
  action: BattleActionType,
  skill_index = 0
) => {
  return apiClient.post<PvpActionResult>('/pvp/action', {
    action,
    skill_index
  });
};

/**
 * 逃跑（放弃当前战斗，按失败结算）
 * POST /pvp/flee
 */
export const flee = () => {
  return apiClient.post<{ message: string }>('/pvp/flee');
};

// ==================== PVP 模式（避世/入世） ====================

/**
 * PVP 模式类型
 * - active：入世（可正常发起和接受 PVP 挑战、决斗、封神台、被悬赏）
 * - recluse：避世（免疫所有 PVP 袭扰，但自身也无法发起挑战/决斗/封神台）
 *
 * 业务影响范围（后端 5 个 Service 已集成校验）：
 *   1. PvpService.challenge：双方任一为避世都拒绝
 *   2. DuelService.challenge：双方任一为避世都拒绝
 *   3. FengshenService：双方任一为避世都拒绝
 *   4. BountyService：目标为避世时不可被悬赏
 *   5. TaoismGateService：目标为避世时不可被神识探查
 */
export type PvpModeType = 'active' | 'recluse';

/** PVP 模式信息（GET /pvp/mode 返回） */
export interface PvpModeInfo {
  /** 玩家 ID */
  player_id: number;
  /** 道号 */
  nickname: string;
  /** 境界名 */
  realm: string;
  /** 境界序号（数值，便于前端比较） */
  realm_rank: number;
  /** PVP 模式：active=入世 / recluse=避世 */
  pvp_mode: PvpModeType;
  /** 模式中文名（入世 / 避世） */
  mode_name: string;
}

/** 切换 PVP 模式响应 */
export interface PvpModeSwitchResult {
  player_id: number;
  pvp_mode: PvpModeType;
  mode_name: string;
}

/**
 * 切换 PVP 模式（避世 ↔ 入世）
 * POST /pvp/mode
 *
 * 业务校验（后端）：
 *   - 玩家存在且未死亡
 *   - 当前无进行中的 PVP 战斗
 *   - mode 参数必须为 active / recluse
 *
 * 影响范围：
 *   - 避世时：免疫 PVP 挑战、决斗、封神台、悬赏、神识探查
 *   - 入世时：恢复所有 PVP 交互能力
 *
 * @param mode 目标模式：active=入世 / recluse=避世
 */
export const setPvpMode = (mode: PvpModeType) => {
  return apiClient.post<PvpModeSwitchResult>('/pvp/mode', { mode });
};

/**
 * 查询当前玩家 PVP 模式
 * GET /pvp/mode
 */
export const getPvpMode = () => {
  return apiClient.get<PvpModeInfo>('/pvp/mode');
};
