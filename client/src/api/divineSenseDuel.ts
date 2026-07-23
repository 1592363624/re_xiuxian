/**
 * 神识对决（1v1 同时选择博弈 PvP）API 客户端
 *
 * 对应后端路由：/api/divine-sense/duel/*
 * 业务逻辑全部由后端 DivineDuelService 处理，前端仅做展示与接口调用
 *
 * 玩法说明（玩法文档第18节）：
 *   - 1v1 同时选择博弈：双方同时选择"凝神（focus）"或"固元（stabilize）"，互不知晓
 *   - 凝神 vs 固元：凝神方造成 30 点伤害（固元方减伤至 15）
 *   - 凝神 vs 凝神：双方各造成 20 点伤害（互相试探）
 *   - 固元 vs 固元：双方各恢复 10 点护盾（和平互守）
 *   - 固元 vs 凝神：固元方承受 30 点伤害（凝神方 dominant）
 *   - 胜负判定：护盾归零者负 / 回合上限（默认10回合）后按护盾多寡判定
 *   - 赌注机制：灵石 或 神识，胜者通吃
 *   - 超时机制：未按时行动自动"固元"
 *
 * @author 修仙游戏开发组
 * @updated 2026-07-22
 */
import apiClient from './index';

// ==================== 类型定义 ====================

/** 赌注类型：spirit_stone=灵石 / divine_sense=神识 */
export type BetType = 'spirit_stone' | 'divine_sense';

/** 对决行动：focus=凝神（攻击试探） / stabilize=固元（防御恢复） */
export type DuelAction = 'focus' | 'stabilize';

/** 对决状态：pending=待接受 / ongoing=进行中 / finished=已结束 / cancelled=已取消 / expired=已过期 */
export type DuelStatus = 'pending' | 'ongoing' | 'finished' | 'cancelled' | 'expired';

/** 对局结束原因：shield_zero=护盾归零 / rounds_limit=回合上限 / surrender=投降 / timeout=超时 / cancel=取消 */
export type SettleReason = 'shield_zero' | 'rounds_limit' | 'surrender' | 'timeout' | 'cancel' | null;

/** 玩家简要信息（对决中双方信息） */
export interface DuelPlayerInfo {
  id: number;
  nickname: string;
  realm_rank: number;
  realm_name?: string;
}

/** POST /divine-sense/duel/challenge 响应数据 */
export interface ChallengeResult {
  duel_id: number;
  status: DuelStatus;
  bet_type: BetType;
  bet_amount: number;
  challenger_shield: number;
  defender_shield: number;
  /** 挑战接受截止时间（ISO 字符串），超时自动取消 */
  challenge_deadline: string;
  /** 发起挑战消耗的神识（仅 bet_type=divine_sense 时有意义） */
  entry_divine_sense_cost: number;
}

/** POST /divine-sense/duel/accept 响应数据 */
export interface AcceptResult {
  duel_id: number;
  status: DuelStatus;
  round_number: number;
  challenger_shield: number;
  defender_shield: number;
  /** 本回合行动截止时间（ISO 字符串） */
  action_deadline: string;
}

/** POST /divine-sense/duel/action 响应数据（联合类型） */
export interface ActionResultWaiting {
  duel_id: number;
  round_number: number;
  your_action: DuelAction;
  /** 是否等待对方行动（true=仅你已提交，false=双方都已提交并结算） */
  waiting_opponent: true;
  action_deadline: string;
}

/** POST /divine-sense/duel/action 响应数据（已结算） */
export interface ActionResultSettled {
  duel_id: number;
  round_number: number;
  /** 发起方本回合行动 */
  challenger_action: DuelAction;
  /** 应战方本回合行动 */
  defender_action: DuelAction;
  /** 发起方护盾变化（恢复-伤害，正=净恢复，负=净损失） */
  challenger_shield_change: number;
  defender_shield_change: number;
  /** 结算后发起方护盾值 */
  challenger_shield: number;
  defender_shield: number;
  /** 发起方承受的伤害 */
  challenger_damage_taken: number;
  defender_damage_taken: number;
  /** 是否已结算 */
  settled: true;
  /** 对局是否结束 */
  duel_finished: boolean;
  /** 胜者玩家ID（null=平局） */
  winner_id: number | null;
  settle_reason: SettleReason;
  /** 赌注结算（仅对局结束时返回） */
  bet_settlement?: {
    winner_gain: number;
    loser_loss: number;
  };
  /** 下一回合号（仅对局未结束时返回） */
  next_round?: number;
  /** 下一回合行动截止时间（仅对局未结束时返回） */
  next_action_deadline?: string;
}

export type ActionResult = ActionResultWaiting | ActionResultSettled;

/** GET /divine-sense/duel/active 响应数据（无进行中对局时返回 null） */
export interface ActiveDuelData {
  duel_id: number;
  status: DuelStatus;
  bet_type: BetType;
  bet_amount: number;
  round_number: number;
  challenger: DuelPlayerInfo;
  defender: DuelPlayerInfo;
  challenger_shield: number;
  defender_shield: number;
  /** 当前玩家本回合已提交的行动（null=未提交） */
  your_action: DuelAction | null;
  /** 对手本回合已提交的行动（null=未提交，结算后可见） */
  opponent_action: DuelAction | null;
  action_deadline: string | null;
  settle_reason: SettleReason;
  created_at: string;
}

/** 历史对决条目 */
export interface DuelHistoryEntry {
  duel_id: number;
  status: DuelStatus;
  bet_type: BetType;
  bet_amount: number;
  round_number: number;
  challenger: DuelPlayerInfo;
  defender: DuelPlayerInfo;
  /** 胜者玩家ID（null=平局） */
  winner_id: number | null;
  /** 当前玩家是否为胜者 */
  is_winner: boolean;
  /** 是否平局 */
  is_draw: boolean;
  settle_reason: SettleReason;
  challenger_shield: number;
  defender_shield: number;
  created_at: string;
  finished_at: string | null;
}

/** GET /divine-sense/duel/history 响应数据 */
export interface DuelHistoryData {
  total: number;
  page: number;
  page_size: number;
  duels: DuelHistoryEntry[];
}

/** POST /divine-sense/duel/surrender 响应数据 */
export interface SurrenderResult {
  duel_id: number;
  status: DuelStatus;
  winner_id: number;
  settle_reason: SettleReason;
  bet_settlement: {
    winner_gain: number;
    loser_loss: number;
  };
}

/** 通用业务响应包装 */
export interface ServiceResponse<T> {
  code: number;
  success?: boolean;
  message?: string;
  data: T | null;
  error_code?: string;
}

// ==================== API 方法 ====================

/**
 * 发起神识对决挑战
 * POST /divine-sense/duel/challenge
 * @param targetPlayerId 目标玩家ID
 * @param betType 赌注类型：spirit_stone / divine_sense
 * @param betAmount 赌注数量（正整数）
 */
export const challengeDuel = (
  targetPlayerId: number,
  betType: BetType,
  betAmount: number
) => {
  return apiClient.post<ServiceResponse<ChallengeResult>>(
    '/divine-sense/duel/challenge',
    {
      target_player_id: targetPlayerId,
      bet_type: betType,
      bet_amount: betAmount
    }
  );
};

/**
 * 接受神识对决挑战
 * POST /divine-sense/duel/accept
 * @param duelId 对决ID
 */
export const acceptDuel = (duelId: number) => {
  return apiClient.post<ServiceResponse<AcceptResult>>('/divine-sense/duel/accept', {
    duel_id: duelId
  });
};

/**
 * 执行神识对决行动（凝神/固元）
 * POST /divine-sense/duel/action
 * @param duelId 对决ID
 * @param action 行动：focus=凝神 / stabilize=固元
 */
export const performDuelAction = (duelId: number, action: DuelAction) => {
  return apiClient.post<ServiceResponse<ActionResult>>('/divine-sense/duel/action', {
    duel_id: duelId,
    action
  });
};

/**
 * 查询当前进行中的神识对决
 * GET /divine-sense/duel/active
 * 无进行中对局时返回 data=null
 */
export const getActiveDuel = () => {
  return apiClient.get<ServiceResponse<ActiveDuelData | null>>('/divine-sense/duel/active');
};

/**
 * 查询神识对决历史
 * GET /divine-sense/duel/history
 * @param page 页码（默认1）
 * @param pageSize 每页条数（默认10）
 */
export const getDuelHistory = (page: number = 1, pageSize: number = 10) => {
  return apiClient.get<ServiceResponse<DuelHistoryData>>('/divine-sense/duel/history', {
    params: { page, page_size: pageSize }
  });
};

/**
 * 投降（认输）
 * POST /divine-sense/duel/surrender
 * @param duelId 对决ID
 */
export const surrenderDuel = (duelId: number) => {
  return apiClient.post<ServiceResponse<SurrenderResult>>('/divine-sense/duel/surrender', {
    duel_id: duelId
  });
};
