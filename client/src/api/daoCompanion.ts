/**
 * 道侣/双修系统 API 客户端
 *
 * 封装道侣/双修系统 10 个玩家接口（路由前缀 /api/dao-companion）：
 *   1. POST /propose                       - 求婚
 *   2. POST /respond                        - 响应求婚（accept/refuse）
 *   3. GET  /my                             - 我的道侣信息
 *   4. POST /interact                       - 道侣互动（每日问安）
 *   5. POST /dual-cultivation               - 双修
 *   6. POST /break                          - 解除道侣关系
 *   7. GET  /proposals                      - 我收到的求婚列表
 *   8. POST /heart-tribulation/respond      - 心劫抉择
 *   9. GET  /heart-tribulation/status       - 心劫状态
 *  10. POST /heart-imprint                  - 凝聚心印
 *
 * 设计原则：
 *   - 业务逻辑全部在后端，前端仅做展示与接口调用
 *   - 后端统一返回 { code, success?, message, data, error_code? } 包装结构
 *   - 业务失败时 code=200 但 success=false，由前端组件按 message 提示
 *   - 所有方法返回 axios response，调用方通过 resp.data 取业务数据
 *   - 请求体字段一律使用 snake_case，与后端路由保持一致
 *
 * 对应后端文件：
 *   - server/routes/dao_companion.js
 *   - server/game/services/DaoCompanionService.js
 *   - server/config/dao_companion_data.json
 */
import apiClient from './index';

/** 通用业务响应包装 */
export interface ServiceResponse<T> {
  code: number;
  success?: boolean;
  message?: string;
  data: T | null;
  error_code?: string;
}

/** 心劫抉择选项类型 */
export type HeartTribulationOption = 'trust' | 'doubt' | 'trial';

/** 心劫选项详情 */
export interface HeartTribulationOptionInfo {
  /** 选项 key */
  option: HeartTribulationOption;
  /** 选项中文名 */
  name: string;
  /** 成功率（0-1） */
  success_rate: number;
  /** 亲密度变化（正数增加，负数减少） */
  intimacy_gain: number;
  /** 选项描述 */
  description: string;
}

/** 待处理心劫事件 */
export interface PendingHeartTribulation {
  /** 心劫事件 ID */
  event_id: number;
  /** 关联道侣关系 ID */
  companion_id: number;
  /** 触发时间 */
  created_at: string;
  /** 过期时间（24 小时内必须抉择） */
  expires_at: string;
  /** 三选项详情 */
  options: HeartTribulationOptionInfo[];
}

/** 心劫状态响应 */
export interface HeartTribulationStatusData {
  /** 是否有待处理心劫 */
  has_pending: boolean;
  /** 待处理事件（无则 null） */
  pending_event: PendingHeartTribulation | null;
}

/** 心劫抉择结果 */
export interface HeartTribulationResult {
  /** 是否成功 */
  is_success: boolean;
  /** 选择的选项 */
  chosen_option: HeartTribulationOption;
  /** 选项中文名 */
  option_name: string;
  /** 成功率 */
  success_rate: number;
  /** 新的亲密度 */
  new_intimacy: number;
  /** 新的心契等级 */
  new_heart_contract_level: number;
  /** 奖励详情（成功时） */
  reward?: { intimacy_gain: number; heart_contract_exp_gain: number };
  /** 惩罚详情（失败时） */
  penalty?: { intimacy_loss: number; heart_contract_level_loss: number };
}

/** 道侣对方玩家信息 */
export interface PartnerInfo {
  /** 玩家 ID */
  id: number;
  /** 玩家道号 */
  nickname: string;
  /** 境界名称 */
  realm: string;
  /** 境界等阶 */
  realm_rank: number;
  /** 是否在线 */
  is_online: boolean;
}

/** 道侣系统配置（前端展示用） */
export interface DaoCompanionSettings {
  /** 心劫触发所需最低亲密度 */
  min_intimacy_for_heart_tribulation: number;
  /** 凝聚心印所需最低亲密度 */
  min_intimacy_for_heart_imprint: number;
  /** 凝聚心印消耗修为 */
  heart_imprint_exp_cost: number;
  /** 提升心契等级所需心印数 */
  heart_imprint_count_per_level: number;
  /** 心契等级上限 */
  max_heart_contract_level: number;
}

/** 我的道侣信息 */
export interface MyCompanionData {
  /** 是否有道侣 */
  has_companion: boolean;
  /** 道侣关系 ID（无道侣时不存在） */
  companion_id?: number;
  /** 道侣对方信息（无道侣时为 null） */
  partner?: PartnerInfo | null;
  /** 关系状态 */
  status?: 'pending' | 'accepted' | 'refused' | 'broken';
  /** 亲密度（0-100） */
  intimacy?: number;
  /** 心契等级（0-9） */
  heart_contract_level?: number;
  /** 心印数量 */
  heart_imprint_count?: number;
  /** 历史双修总次数 */
  dual_cultivation_count?: number;
  /** 双修加成比例 */
  dual_cultivation_bonus_rate?: number;
  /** 互动冷却剩余秒数 */
  interact_cooldown_remaining?: number;
  /** 双修冷却剩余秒数 */
  dual_cultivation_cooldown_remaining?: number;
  /** 最后互动时间 */
  last_interaction_time?: string | null;
  /** 最后双修时间 */
  last_dual_cultivation_time?: string | null;
  /** 结侣时间 */
  created_at?: string;
  /** 配置参数（前端展示用） */
  settings?: DaoCompanionSettings;
  /** 最低境界等阶（无道侣时存在） */
  min_realm_rank?: number;
  /** 最低境界名称（无道侣时存在） */
  min_realm_name?: string;
  /** 是否满足求婚境界要求（无道侣时存在） */
  can_propose?: boolean;
}

/** 求婚记录 */
export interface ProposalItem {
  /** 求婚记录 ID */
  proposal_id: number;
  /** 求婚方玩家信息 */
  from_player: {
    id: number;
    nickname: string;
    realm: string;
    realm_rank: number;
  } | null;
  /** 求婚时间 */
  created_at: string;
}

/** 我收到的求婚列表 */
export interface ProposalListData {
  /** 求婚列表 */
  proposals: ProposalItem[];
  /** 求婚数量 */
  count: number;
  /** 接收方最大待处理求婚数 */
  max_pending: number;
}

/** 求婚结果 */
export interface ProposeResult {
  /** 求婚记录 ID */
  proposal_id: number;
  /** 目标玩家信息 */
  target_player: { id: number; nickname: string; realm: string };
  /** 求婚时间 */
  created_at: string;
}

/** 响应求婚结果 */
export interface RespondResult {
  /** 道侣关系 ID */
  companion_id: number;
  /** 接受时为对方信息，拒绝时无 */
  partner?: { id: number; nickname: string; realm: string };
  /** 接受时为初始亲密度 */
  intimacy?: number;
  /** 动作 */
  action?: 'accept' | 'refuse';
}

/** 道侣互动结果 */
export interface InteractResult {
  /** 亲密度增加量 */
  intimacy_gain: number;
  /** 新的亲密度 */
  new_intimacy: number;
  /** 自己修为增加量 */
  player_exp_gain: string;
  /** 道侣修为增加量 */
  partner_exp_gain: string;
  /** 最后互动时间 */
  last_interaction_time: string;
}

/** 双修结果 */
export interface DualCultivationResult {
  /** 自己修为增加量 */
  player_exp_gain: string;
  /** 道侣修为增加量 */
  partner_exp_gain: string;
  /** 亲密度增加量 */
  intimacy_gain: number;
  /** 新的亲密度 */
  new_intimacy: number;
  /** 双修持续秒数 */
  duration: number;
  /** 双修总次数 */
  dual_cultivation_count: number;
  /** 最后双修时间 */
  last_dual_cultivation_time: string;
}

/** 解除道侣结果 */
export interface BreakCompanionResult {
  /** 道侣关系 ID */
  companion_id: number;
  /** 亲密度惩罚 */
  intimacy_penalty: number;
  /** 解除时间 */
  broken_at: string;
  /** 重新求婚冷却天数 */
  cooldown_days: number;
}

/** 凝聚心印结果 */
export interface CondenseHeartImprintResult {
  /** 消耗修为 */
  exp_cost: string;
  /** 新的心印数量 */
  new_heart_imprint_count: number;
  /** 新的心契等级 */
  new_heart_contract_level: number;
  /** 是否提升心契等级 */
  level_up: boolean;
  /** 距离下次升级还差的心印数 */
  imprint_to_next_level: number;
}

// ==================== 护道机制相关类型（心契 L2 解锁） ====================

/** 护道日志单条记录 */
export interface ProtectLogItem {
  /** 日志 ID */
  id: number;
  /** 道侣关系 ID */
  companion_id: number;
  /** 攻击方玩家 ID */
  attacker_id: number;
  /** 被攻击方玩家 ID（被护道者） */
  defender_id: number;
  /** 护道方玩家 ID（道侣） */
  protector_id: number;
  /** 原始伤害值（BIGINT 字符串） */
  original_damage: string;
  /** 护道方分担的伤害值 */
  shared_damage: string;
  /** 护道方反击伤害值 */
  counter_damage: string;
  /** 触发时的心契等级（2-9） */
  heart_contract_level: number;
  /** 触发概率（0-1） */
  protect_rate: number;
  /** 伤害分担比例 */
  damage_share_rate: number;
  /** 反击概率 */
  counter_attack_rate: number;
  /** 战斗类型：pvp/sect_war/world_boss */
  battle_type: string;
  /** 战斗记录 ID */
  battle_id: number | null;
  /** 战斗回合数 */
  battle_round: number | null;
  /** 备注 */
  remark: string | null;
  /** 护道触发时间 */
  created_at: string;
}

/** 护道日志分页响应 */
export interface ProtectLogsData {
  /** 日志列表 */
  logs: ProtectLogItem[];
  /** 总记录数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页条数 */
  limit: number;
  /** 总页数 */
  total_pages: number;
}

/** 单边护道统计 */
export interface ProtectStatSide {
  /** 总次数 */
  total_count: number;
  /** 累计分担伤害（BIGINT 字符串） */
  total_shared_damage: string;
  /** 累计反击伤害（BIGINT 字符串） */
  total_counter_damage: string;
  /** 最后护道时间（无记录时为 null） */
  last_protect_time: string | null;
}

/** 护道统计响应 */
export interface ProtectStatsData {
  /** 作为被护道方（道侣护我）的统计 */
  as_defender: ProtectStatSide;
  /** 作为护道方（我护道侣）的统计 */
  as_protector: ProtectStatSide;
}

// ==================== 玩家接口（10 个） ====================

/**
 * 求婚
 * POST /dao-companion/propose
 * @param targetPlayerId 目标玩家 ID
 */
export const daoCompanionPropose = (targetPlayerId: number) => {
  return apiClient.post<ServiceResponse<ProposeResult>>('/dao-companion/propose', {
    target_player_id: targetPlayerId
  });
};

/**
 * 响应求婚
 * POST /dao-companion/respond
 * @param proposalId 求婚记录 ID
 * @param action 动作：accept=接受 / refuse=拒绝
 */
export const daoCompanionRespond = (
  proposalId: number,
  action: 'accept' | 'refuse'
) => {
  return apiClient.post<ServiceResponse<RespondResult>>('/dao-companion/respond', {
    proposal_id: proposalId,
    action
  });
};

/**
 * 获取我的道侣信息
 * GET /dao-companion/my
 * 含道侣详情 + 对方玩家信息 + 双修加成比例 + 冷却剩余
 */
export const daoCompanionGetMy = () => {
  return apiClient.get<ServiceResponse<MyCompanionData>>('/dao-companion/my');
};

/**
 * 道侣互动（每日问安/灵力反哺）
 * POST /dao-companion/interact
 * 24 小时冷却，亲密度+2，双方各获得少量修为
 */
export const daoCompanionInteract = () => {
  return apiClient.post<ServiceResponse<InteractResult>>('/dao-companion/interact', {});
};

/**
 * 双修
 * POST /dao-companion/dual-cultivation
 * 双方必须都在线，且未闭关/未战斗/未双修
 */
export const daoCompanionDualCultivate = () => {
  return apiClient.post<ServiceResponse<DualCultivationResult>>(
    '/dao-companion/dual-cultivation',
    {}
  );
};

/**
 * 解除道侣关系
 * POST /dao-companion/break
 * 亲密度-20 惩罚，7 天冷却期不能再次求婚
 */
export const daoCompanionBreak = () => {
  return apiClient.post<ServiceResponse<BreakCompanionResult>>('/dao-companion/break', {});
};

/**
 * 获取我收到的求婚列表
 * GET /dao-companion/proposals
 * 返回 pending 状态的求婚记录 + 求婚方玩家信息
 */
export const daoCompanionGetProposals = () => {
  return apiClient.get<ServiceResponse<ProposalListData>>('/dao-companion/proposals');
};

/**
 * 心劫抉择
 * POST /dao-companion/heart-tribulation/respond
 * @param eventId 心劫事件 ID
 * @param option 选项：trust=信任 / doubt=怀疑 / trial=考验
 */
export const daoCompanionRespondHeartTribulation = (
  eventId: number,
  option: HeartTribulationOption
) => {
  return apiClient.post<ServiceResponse<HeartTribulationResult>>(
    '/dao-companion/heart-tribulation/respond',
    {
      event_id: eventId,
      option
    }
  );
};

/**
 * 心劫状态查询
 * GET /dao-companion/heart-tribulation/status
 * 返回当前是否有 pending 心劫 + 三选项详情
 */
export const daoCompanionGetHeartTribulationStatus = () => {
  return apiClient.get<ServiceResponse<HeartTribulationStatusData>>(
    '/dao-companion/heart-tribulation/status'
  );
};

/**
 * 凝聚心印
 * POST /dao-companion/heart-imprint
 * 亲密度>=80 时可凝聚，消耗双方各 1000 修为，每 3 个心印提升 1 级心契
 */
export const daoCompanionCondenseHeartImprint = () => {
  return apiClient.post<ServiceResponse<CondenseHeartImprintResult>>(
    '/dao-companion/heart-imprint',
    {}
  );
};

// ==================== 护道机制接口（心契 L2 解锁） ====================

/**
 * 查询护道日志
 * GET /dao-companion/protect-logs
 * @param options 分页与过滤参数
 * @param options.page 页码（从1开始，默认1）
 * @param options.limit 每页条数（默认10，上限50）
 * @param options.role 角色：all/defender/protector
 */
export const daoCompanionGetProtectLogs = (options?: {
  page?: number;
  limit?: number;
  role?: 'all' | 'defender' | 'protector';
}) => {
  const params: Record<string, number | string> = {};
  if (options?.page) params.page = options.page;
  if (options?.limit) params.limit = options.limit;
  if (options?.role) params.role = options.role;
  return apiClient.get<ServiceResponse<ProtectLogsData>>(
    '/dao-companion/protect-logs',
    { params }
  );
};

/**
 * 查询护道统计
 * GET /dao-companion/protect-stats
 * 返回玩家作为被护道方/护道方的综合统计
 */
export const daoCompanionGetProtectStats = () => {
  return apiClient.get<ServiceResponse<ProtectStatsData>>(
    '/dao-companion/protect-stats'
  );
};
