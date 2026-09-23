/**
 * 妖兽入侵（兽潮）API
 *
 * 对应服务端 routes/beast_invasion.js 全部 12 个玩家接口。
 * 此前后端玩法完整、客户端零入口 —— 本文件与 BeastInvasionPanel 一并补齐。
 */
import apiClient from './index';

/** 活跃事件摘要（GET /beast-invasion/active） */
export interface BeastInvasionActive {
  id: number;
  beast_key: string;
  beast_name: string;
  realm_rank_min: number;
  hp_current: string;
  hp_max: string;
  hp_percentage: number;
  atk: number;
  def: number;
  speed: number;
  phase: 'donation' | 'battle' | 'ended';
  status: 'active' | 'defeated' | 'escaped' | 'expired';
  donation_target: number;
  donation_current: number;
  donation_percentage: number;
  start_time: string;
  donation_end_time: string | null;
  battle_end_time: string | null;
  defeat_time: string | null;
  killer_player_id: number | null;
  killer_nickname: string | null;
  participant_count: number;
  total_damage_taken: string;
  total_damage_dealt: string;
  countdown_seconds: number;
  server_time: string;
}

/** 事件详情（GET /beast-invasion/:id） */
export interface BeastInvasionDetail {
  invasion: BeastInvasionActive & {
    aggregated_battle_log?: string | null;
    season_id?: number | null;
  };
  description: string;
  skills: Array<Record<string, unknown>>;
  countdown_seconds: number;
  server_time: string;
}

/** 伤害排行条目 */
export interface BeastInvasionRankRow {
  rank: number;
  player_id: number;
  player_nickname: string;
  player_realm: string;
  total_damage: string;
  attack_count: number;
  best_single_damage: string;
  total_counter_damage: number;
  damage_percentage: number;
}

export interface BeastInvasionRanking {
  invasion_id: number;
  beast_name: string;
  total_damage_taken: string;
  ranking: BeastInvasionRankRow[];
}

/** 攻击结果 */
export interface BeastInvasionAttackResult {
  attack: {
    skill_id: string;
    skill_used: string;
    damage: string | number;
    is_crit: boolean;
    damage_breakdown?: Record<string, unknown>;
  };
  beast: {
    id: number;
    name: string;
    hp_before: string;
    hp_after: string;
    hp_current: string;
    hp_max: string;
    hp_percentage: number;
    status: string;
    defeated: boolean;
  };
  counter: {
    triggered: boolean;
    damage: string | number;
  };
  player: {
    battle_hp_before: string;
    battle_hp_after: string;
    battle_hp_max: string;
    is_dead?: boolean;
  };
  settle?: Record<string, unknown> | null;
}

/** 捐献结果 */
export interface BeastInvasionContributeResult {
  success: boolean;
  message: string;
  contribution?: number;
  donation_current?: number;
  donation_target?: number;
  phase?: string;
  [key: string]: unknown;
}

/** 玩法说明 */
export interface BeastInvasionHelp {
  title: string;
  content: string;
  current_invasion?: unknown;
}

/** 获取当前活跃入侵事件（无则 data 为 null） */
export const getActiveInvasion = () =>
  apiClient.get<BeastInvasionActive | null>('/beast-invasion/active');

/** 历史事件列表 */
export const listInvasions = (params: { status?: string; limit?: number; offset?: number } = {}) =>
  apiClient.get<{ list?: unknown[]; total?: number }>('/beast-invasion/list', { params });

/** 事件详情 */
export const getInvasionDetail = (invasionId: number) =>
  apiClient.get<BeastInvasionDetail>(`/beast-invasion/${invasionId}`);

/** 捐献物品到锁灵大阵 */
export const contributeItem = (invasionId: number, item_key: string, quantity: number) =>
  apiClient.post<BeastInvasionContributeResult>(`/beast-invasion/${invasionId}/contribute`, {
    item_key,
    quantity,
  });

/** 捐献进度 */
export const getContributionProgress = (invasionId: number) =>
  apiClient.get<Record<string, unknown>>(`/beast-invasion/${invasionId}/contribution/progress`);

/** 我的捐献 */
export const getMyContribution = (invasionId: number) =>
  apiClient.get<Record<string, unknown>>(`/beast-invasion/${invasionId}/contribution/me`);

/** 攻击妖兽（skill_id 可选：basic/skill/ultimate） */
export const attackBeast = (invasionId: number, skill_id?: string) =>
  apiClient.post<BeastInvasionAttackResult>(`/beast-invasion/${invasionId}/attack`, skill_id ? { skill_id } : {});

/** 原地复活 */
export const reviveInBattle = (invasionId: number) =>
  apiClient.post<Record<string, unknown>>(`/beast-invasion/${invasionId}/revive`);

/** 撤退 */
export const retreatBattle = (invasionId: number) =>
  apiClient.post<Record<string, unknown>>(`/beast-invasion/${invasionId}/retreat`);

/** 伤害排行 */
export const getAttackRanking = (invasionId: number, limit = 50) =>
  apiClient.get<BeastInvasionRanking>(`/beast-invasion/${invasionId}/ranking`, { params: { limit } });

/** 奖励池说明 */
export const getRewardsInfo = (invasionId: number) =>
  apiClient.get<Record<string, unknown>>(`/beast-invasion/${invasionId}/rewards`);

/** 玩法帮助 */
export const getBeastInvasionHelp = () =>
  apiClient.get<BeastInvasionHelp>('/beast-invasion/help');
