/**
 * 元婴出窍与高阶境界系统 API 客户端
 *
 * 高阶境界（化神及以上）玩法接口封装：
 * 1. 元婴出窍：元婴初期以上玩家元神离体，进行探索/窥探/远方修炼
 * 2. 问道：化神初期以上玩家每日向天道问道，积累感悟值用于突破加成
 * 3. 法相天地：化神后期以上玩家凝聚法相，每级 5% 属性加成
 * 4. 探寻裂缝：炼虚初期以上玩家探寻虚空裂缝，获得稀有材料
 * 5. 虚弱/残魂：突破失败、出窍时间过长等触发，影响修炼与突破
 * 6. 夺舍重生：残魂过低时可尝试夺舍，重置境界但保留部分修为
 *
 * 对应后端路由：/api/nascent-soul/*
 * 业务逻辑全部由后端处理，前端仅做展示与接口调用
 */
import apiClient from './index';

/** 元婴出窍目标类型 */
export type SoulOutTarget = 'explore' | 'scout' | 'cultivate';

/** 元神状态 */
export type SoulState = 'none' | 'out';

/** 元婴出窍状态子对象 */
export interface SoulOutStatus {
  /** 是否解锁（境界达到元婴初期） */
  unlocked: boolean;
  /** 当前元神状态：none=体内，out=出窍中 */
  state: SoulState;
  /** 出窍目标 */
  target: SoulOutTarget | 'explore';
  /** 今日已出窍次数 */
  daily_count: number;
  /** 每日次数上限 */
  daily_limit: number;
  /** 冷却是否已就绪 */
  cooldown_ready: boolean;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
  /** 出窍剩余秒数（出窍中才有值） */
  out_remaining_sec: number;
  /** 出窍开始时间 */
  start_time: string | null;
  /** 出窍预计结束时间 */
  end_time: string | null;
}

/** 问道状态子对象 */
export interface AskDaoStatus {
  /** 是否解锁（境界达到化神初期） */
  unlocked: boolean;
  /** 当前感悟值 */
  insight: number;
  /** 今日已问道次数 */
  daily_count: number;
  /** 每日次数上限 */
  daily_limit: number;
  /** 冷却是否已就绪 */
  cooldown_ready: boolean;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
}

/** 法相天地状态子对象 */
export interface DharmaFormStatus {
  /** 是否解锁（境界达到化神后期） */
  unlocked: boolean;
  /** 当前法相等级 */
  level: number;
  /** 法相最高等级 */
  max_level: number;
  /** 当前属性加成（小数形式，0.05=5%） */
  attribute_bonus: number;
  /** 下一级所需修为 */
  next_level_exp_cost: number;
  /** 下一级所需神识 */
  next_level_sense_cost: number;
}

/** 探寻裂缝状态子对象 */
export interface FractureExploreStatus {
  /** 是否解锁（境界达到炼虚初期） */
  unlocked: boolean;
  /** 今日已探寻次数 */
  daily_count: number;
  /** 每日次数上限 */
  daily_limit: number;
  /** 冷却是否已就绪 */
  cooldown_ready: boolean;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
  /** 每次探寻神识消耗 */
  sense_cost: number;
}

/** 虚弱状态子对象 */
export interface WeaknessStatus {
  /** 是否处于虚弱状态 */
  is_weak: boolean;
  /** 虚弱结束时间 */
  end_time: string | null;
  /** 虚弱剩余秒数 */
  remaining_sec: number;
  /** 修炼经验惩罚比例（0.5=减少50%经验获取） */
  exp_gain_penalty: number;
  /** 突破成功率惩罚（百分比，20=减少20%成功率） */
  breakthrough_penalty: number;
}

/** 残魂状态子对象 */
export interface RemnantSoulStatus {
  /** 当前残魂值 */
  value: number;
  /** 残魂最大值 */
  max: number;
  /** 残魂危险阈值 */
  trigger_threshold: number;
  /** 是否处于不稳定状态（残魂低于阈值） */
  is_unstable: boolean;
  /** 每小时自然恢复速率 */
  recovery_rate_per_hour: number;
}

/** 夺舍重生状态子对象 */
export interface ReincarnationStatus {
  /** 是否可执行夺舍（残魂值足够） */
  available: boolean;
  /** 冷却是否已就绪 */
  cooldown_ready: boolean;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
  /** 夺舍成功率（小数形式，0.4=40%） */
  success_rate: number;
  /** 夺舍所需最低残魂值 */
  min_remnant_soul: number;
}

/** 元婴系统状态总览（GET /nascent-soul/status 返回） */
export interface NascentSoulStatus {
  /** 当前境界名称 */
  realm: string;
  /** 当前境界排名 */
  realm_rank: number;
  /** 元婴出窍状态 */
  soul_out: SoulOutStatus;
  /** 问道状态 */
  ask_dao: AskDaoStatus;
  /** 法相天地状态 */
  dharma_form: DharmaFormStatus;
  /** 探寻裂缝状态 */
  fracture_explore: FractureExploreStatus;
  /** 虚弱状态 */
  weakness: WeaknessStatus;
  /** 残魂状态 */
  remnant_soul: RemnantSoulStatus;
  /** 夺舍重生状态 */
  reincarnation: ReincarnationStatus;
}

/** 开始元婴出窍请求参数 */
export interface StartSoulOutParams {
  /** 出窍目标 */
  target?: SoulOutTarget;
  /** 出窍时长（秒），可选，范围 300-7200 */
  duration_sec?: number;
}

/** 开始元婴出窍响应数据 */
export interface StartSoulOutResult {
  soul_state: SoulState;
  target: SoulOutTarget;
  start_time: string;
  end_time: string;
  duration: number;
  sense_cost: number;
  daily_count: number;
  daily_limit: number;
}

/** 元婴归来响应数据 */
export interface EndSoulOutResult {
  soul_state: SoulState;
  actual_duration: number;
  /** 完成率（0-1） */
  completion_rate: number;
  exp_reward: number;
  remnant_soul_cost: number;
  remnant_soul: number;
  cooldown_remaining_sec: number;
}

/** 问道响应数据 */
export interface AskDaoResult {
  /** 本次获得的感悟值 */
  insight_gain: number;
  /** 当前累计感悟值 */
  total_insight: number;
  /** 消耗的修为 */
  exp_cost: number;
  /** 问道事件文本 */
  event: string;
  /** 今日已问道次数 */
  daily_count: number;
  /** 每日次数上限 */
  daily_limit: number;
}

/** 凝聚法相天地响应数据 */
export interface CultivateDharmaFormResult {
  /** 新法相等级 */
  level: number;
  /** 法相最高等级 */
  max_level: number;
  /** 消耗的修为 */
  exp_cost: number;
  /** 消耗的神识 */
  sense_cost: number;
  /** 当前属性加成（小数形式） */
  attribute_bonus: number;
  /** 下一级所需修为 */
  next_level_exp_cost: number;
  /** 下一级所需神识 */
  next_level_sense_cost: number;
}

/** 探寻裂缝响应数据 */
export interface ExploreFractureResult {
  /** 是否发现裂缝 */
  discovered: boolean;
  /** 是否稀有掉落 */
  rare_drop: boolean;
  /** 掉落物品信息（可能为 null） */
  drop_item: { name: string; count: number; rarity: string } | null;
  /** 获得的修为 */
  exp_reward: number;
  /** 消耗的残魂值 */
  remnant_soul_cost: number;
  /** 当前残魂值 */
  remnant_soul: number;
  /** 今日已探寻次数 */
  daily_count: number;
  /** 每日次数上限 */
  daily_limit: number;
}

/** 夺舍重生响应数据 */
export interface ReincarnateResult {
  /** 夺舍前的境界（成功时返回） */
  old_realm?: string;
  /** 夺舍后的境界（成功时返回） */
  new_realm?: string;
  /** 夺舍前的修为（成功时返回） */
  old_exp?: number;
  /** 夺舍后的修为（成功时返回） */
  new_exp?: number;
  /** 残魂值（失败时也返回当前残魂值） */
  remnant_soul: number;
  /** 虚弱结束时间（失败时返回） */
  weakness_end_time?: string;
}

/** 通用业务响应包装 */
export interface ServiceResponse<T> {
  code: number;
  success?: boolean;
  message?: string;
  data: T | null;
  error_code?: string;
}

/**
 * 获取元婴系统状态总览
 * GET /nascent-soul/status
 */
export const getStatus = () => {
  return apiClient.get<ServiceResponse<NascentSoulStatus>>('/nascent-soul/status');
};

/**
 * 开始元婴出窍
 * POST /nascent-soul/soul-out/start
 * @param params 出窍参数（目标与时长）
 */
export const startSoulOut = (params: StartSoulOutParams = {}) => {
  return apiClient.post<ServiceResponse<StartSoulOutResult>>('/nascent-soul/soul-out/start', params);
};

/**
 * 主动召回元婴
 * POST /nascent-soul/soul-out/end
 * 提前召回将按完成率折减收益
 */
export const endSoulOut = () => {
  return apiClient.post<ServiceResponse<EndSoulOutResult>>('/nascent-soul/soul-out/end');
};

/**
 * 向天道问道
 * POST /nascent-soul/ask-dao
 * 获得感悟值，每 10 点感悟可提供 1% 突破加成（最高 20%）
 */
export const askDao = () => {
  return apiClient.post<ServiceResponse<AskDaoResult>>('/nascent-soul/ask-dao');
};

/**
 * 凝聚法相天地
 * POST /nascent-soul/dharma-form/cultivate
 * 消耗修为与神识提升法相等级，每级提供 5% 属性加成
 */
export const cultivateDharmaForm = () => {
  return apiClient.post<ServiceResponse<CultivateDharmaFormResult>>('/nascent-soul/dharma-form/cultivate');
};

/**
 * 探寻虚空裂缝
 * POST /nascent-soul/fracture/explore
 * 消耗神识与残魂，有几率获得稀有材料
 */
export const exploreFracture = () => {
  return apiClient.post<ServiceResponse<ExploreFractureResult>>('/nascent-soul/fracture/explore');
};

/**
 * 夺舍重生
 * POST /nascent-soul/reincarnate
 * 高风险操作：成功则境界降为元婴初期保留30%修为，失败则残魂大幅下降且进入虚弱
 */
export const reincarnate = () => {
  return apiClient.post<ServiceResponse<ReincarnateResult>>('/nascent-soul/reincarnate');
};
