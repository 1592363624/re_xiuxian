/**
 * 器灵系统 API（法宝器灵养成与多人试炼竞技）
 *
 * 器灵系统是法宝的深度养成玩法：玩家在已装备的法宝上唤醒器灵，
 * 通过抚摸/温养/试炼提升器灵等级、亲密度、力量值，并可开启护主/催发状态强化战斗。
 * 试炼累计分数进入全服排行榜，实现多人竞争。
 *
 * 设计原则：所有业务逻辑在后端，前端仅做展示与接口调用
 *
 * 9 个接口：
 *   1. POST /artifact-spirit/awaken        — 唤醒器灵
 *   2. GET  /artifact-spirit/list          — 我的器灵列表
 *   3. GET  /artifact-spirit/:spirit_id    — 器灵详情
 *   4. POST /artifact-spirit/trial         — 器灵试炼
 *   5. POST /artifact-spirit/protect       — 器灵护主
 *   6. POST /artifact-spirit/activate      — 催发器灵
 *   7. POST /artifact-spirit/pet           — 抚摸法宝
 *   8. POST /artifact-spirit/nurture       — 温养器灵
 *   9. GET  /artifact-spirit/trial-ranking — 器灵试炼榜
 */
import apiClient from './index';

/** 器灵类型 */
export type SpiritType = 'attack' | 'defense' | 'support' | 'balance';

/** 器灵状态 */
export type SpiritState = 'idle' | 'protecting' | 'activating';

/** 我的器灵列表条目 */
export interface MySpiritEntry {
  /** 器灵记录ID */
  spirit_id: number;
  /** 关联装备ID */
  equipment_id: number;
  /** 法宝配置键名 */
  item_key: string;
  /** 器灵类型 */
  spirit_type: SpiritType;
  /** 器灵类型名称 */
  spirit_type_name: string;
  /** 器灵类型描述 */
  spirit_type_desc: string;
  /** 器灵自定义名称 */
  spirit_name: string | null;
  /** 器灵等级 */
  spirit_level: number;
  /** 器灵经验 */
  spirit_exp: number;
  /** 亲密度 */
  intimacy: number;
  /** 力量值 */
  power: number;
  /** 唤醒时间 */
  awakened_at: string;
  /** 状态 */
  state: SpiritState;
  /** 是否护主中 */
  is_protecting: boolean;
  /** 是否催发中 */
  is_activating: boolean;
  /** 试炼最高分 */
  trial_best_score: number;
  /** 试炼累计分（字符串避免BigInt精度丢失） */
  trial_total_score: string;
  /** 装备槽位 */
  equipment_slot: string | null;
  /** 装备是否已破碎 */
  is_equipment_broken: boolean;
}

/** 器灵详情 */
export interface SpiritDetail extends MySpiritEntry {
  /** 下一级所需经验 */
  next_level_exp: number;
  /** 最大等级 */
  max_level: number;
  /** 亲密度上限 */
  intimacy_max: number;
  /** 力量值上限 */
  power_max: number;
  /** 护主状态结束时间 */
  protect_active_until: string | null;
  /** 催发状态结束时间 */
  activate_active_until: string | null;
  /** 试炼累计次数 */
  trial_total_count: number;
  /** 今日试炼次数 */
  daily_trial_count: number;
  /** 每日试炼上限 */
  daily_trial_limit: number;
  /** 冷却剩余时间（秒） */
  cooldowns: {
    pet: number;
    nurture: number;
    protect: number;
    activate: number;
  };
}

/** 唤醒器灵请求 */
export interface AwakenSpiritRequest {
  /** 装备记录ID */
  equipment_id: number;
  /** 器灵类型 */
  spirit_type: SpiritType;
  /** 器灵自定义名称（可选） */
  spirit_name?: string;
}

/** 唤醒器灵响应 */
export interface AwakenSpiritResult {
  spirit_id: number;
  spirit_type: SpiritType;
  spirit_name: string | null;
  spirit_level: number;
  intimacy: number;
  power: number;
  success_rate: number;
}

/** 试炼响应 */
export interface TrialResult {
  spirit_id: number;
  /** 本次试炼分数 */
  score: number;
  /** 是否破纪录 */
  is_best_score: boolean;
  /** 奖励 */
  rewards: {
    exp: number;
    spirit_stones: number;
    power_gain: number;
  };
  /** 试炼后器灵等级 */
  spirit_level: number;
  /** 试炼后器灵经验 */
  spirit_exp: number;
  /** 是否升级 */
  leveled_up: boolean;
  /** 今日已试炼次数 */
  daily_trial_count: number;
  /** 每日试炼上限 */
  daily_trial_limit: number;
}

/** 护主响应 */
export interface ProtectResult {
  spirit_id: number;
  active_until: string;
  duration_seconds: number;
  intimacy_cost: number;
  intimacy_remaining: number;
}

/** 催发响应 */
export interface ActivateResult {
  spirit_id: number;
  active_until: string;
  duration_seconds: number;
  power_cost: number;
  power_remaining: number;
  bonus_multiplier: number;
}

/** 抚摸响应 */
export interface PetResult {
  spirit_id: number;
  intimacy_gain: number;
  intimacy: number;
  intimacy_max: number;
  exp_gain: number;
  spirit_exp: number;
  spirit_level: number;
  leveled_up: boolean;
}

/** 温养响应 */
export interface NurtureResult {
  spirit_id: number;
  power_gain: number;
  power: number;
  power_max: number;
  spirit_stones_cost: number;
}

/** 试炼榜条目 */
export interface TrialRankingEntry {
  rank: number;
  player_id: number;
  player_name: string;
  player_realm: string;
  spirit_id: number;
  spirit_type: SpiritType;
  spirit_type_name: string;
  spirit_name: string | null;
  spirit_level: number;
  trial_best_score: number;
  trial_total_score: string;
  trial_total_count: number;
  is_self: boolean;
}

/** 试炼榜响应 */
export interface TrialRankingResult {
  ranking: TrialRankingEntry[];
  my_rank: number;
  my_spirit: {
    spirit_id: number;
    spirit_type: SpiritType;
    trial_total_score: string;
    trial_best_score: number;
  } | null;
  total: number;
  page: number;
  page_size: number;
  top_count: number;
}

/** 统一API响应 */
interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  success?: boolean;
  error_code?: string;
}

/**
 * 唤醒器灵
 * @param data 装备ID + 器灵类型 + 可选名称
 */
export async function awakenSpirit(data: AwakenSpiritRequest): Promise<ApiResponse<AwakenSpiritResult>> {
  const response = await apiClient.post('/artifact-spirit/awaken', data);
  return response.data;
}

/**
 * 获取我的器灵列表
 */
export async function getMySpirits(): Promise<ApiResponse<{ spirits: MySpiritEntry[]; count: number }>> {
  const response = await apiClient.get('/artifact-spirit/list');
  return response.data;
}

/**
 * 获取器灵详情
 * @param spiritId 器灵记录ID
 */
export async function getSpiritDetail(spiritId: number): Promise<ApiResponse<SpiritDetail>> {
  const response = await apiClient.get(`/artifact-spirit/${spiritId}`);
  return response.data;
}

/**
 * 器灵试炼
 * @param spiritId 器灵记录ID
 */
export async function trialSpirit(spiritId: number): Promise<ApiResponse<TrialResult>> {
  const response = await apiClient.post('/artifact-spirit/trial', { spirit_id: spiritId });
  return response.data;
}

/**
 * 器灵护主
 * @param spiritId 器灵记录ID
 */
export async function protectSpirit(spiritId: number): Promise<ApiResponse<ProtectResult>> {
  const response = await apiClient.post('/artifact-spirit/protect', { spirit_id: spiritId });
  return response.data;
}

/**
 * 催发器灵
 * @param spiritId 器灵记录ID
 */
export async function activateSpirit(spiritId: number): Promise<ApiResponse<ActivateResult>> {
  const response = await apiClient.post('/artifact-spirit/activate', { spirit_id: spiritId });
  return response.data;
}

/**
 * 抚摸法宝
 * @param spiritId 器灵记录ID
 */
export async function petSpirit(spiritId: number): Promise<ApiResponse<PetResult>> {
  const response = await apiClient.post('/artifact-spirit/pet', { spirit_id: spiritId });
  return response.data;
}

/**
 * 温养器灵
 * @param spiritId 器灵记录ID
 */
export async function nurtureSpirit(spiritId: number): Promise<ApiResponse<NurtureResult>> {
  const response = await apiClient.post('/artifact-spirit/nurture', { spirit_id: spiritId });
  return response.data;
}

/**
 * 获取器灵试炼榜
 * @param page 页码
 * @param pageSize 每页条数
 */
export async function getTrialRanking(page = 1, pageSize = 20): Promise<ApiResponse<TrialRankingResult>> {
  const response = await apiClient.get('/artifact-spirit/trial-ranking', {
    params: { page, page_size: pageSize }
  });
  return response.data;
}
