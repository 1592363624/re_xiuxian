/**
 * 阵法系统 API 客户端
 *
 * 阵法玩法接口封装：
 * 1. 10大阵法，4类（攻击/防御/辅助/特殊）×4品阶（凡/灵/仙/圣）
 * 2. 学习机制：境界达标 + 灵石消耗 + 前置阵法
 * 3. 布阵/撤阵：4小时持续，撤阵后30分钟冷却
 * 4. 熟练度：每次布阵 +1，每100点 +5% 效果
 * 5. 阵法相克：attack > defense > support > special > attack（PVP时相克方效果 -20%）
 * 6. 战力加成：阵法效果作用于玩家属性计算
 *
 * 对应后端路由：/api/formation/*
 * 业务逻辑全部由后端处理，前端仅做展示与接口调用
 */
import apiClient from './index';

/** 阵法分类 */
export type FormationCategory = 'attack' | 'defense' | 'support' | 'special';

/** 阵法品阶 */
export type FormationGrade = 'mortal' | 'spirit' | 'immortal' | 'saint';

/** 阵法效果（属性加成比例） */
export interface FormationEffects {
  /** 攻击力加成比例（0.08 = +8%） */
  atk_ratio?: number;
  /** 防御力加成比例 */
  def_ratio?: number;
  /** 最大HP加成比例 */
  hp_max_ratio?: number;
  /** 最大MP加成比例 */
  mp_max_ratio?: number;
  /** 速度加成比例 */
  speed_ratio?: number;
  /** 神识加成比例 */
  sense_ratio?: number;
  /** 熟练度倍率（内部字段，前端展示用） */
  _proficiency_multiplier?: number;
}

/** 阵法简要信息（getConfig 返回） */
export interface FormationBrief {
  /** 阵法ID，如 "f_tiangan_sword" */
  id: string;
  /** 阵法名称 */
  name: string;
  /** 阵法分类 */
  category: FormationCategory;
  /** 分类显示名（如"攻杀阵"） */
  category_display: string;
  /** 品阶 */
  grade: FormationGrade;
  /** 品阶显示名（如"仙品"） */
  grade_display: string;
  /** 阵法描述 */
  description: string;
  /** 学习所需最低境界排名 */
  min_realm_rank: number;
  /** 推荐境界名称 */
  recommended_realm: string;
  /** 学习消耗灵石 */
  learn_cost_spirit_stones: number;
  /** 前置阵法ID（null表示无前置） */
  prerequisite_formation_id: string | null;
  /** 布阵消耗灵石 */
  activate_cost_spirit_stones: number;
  /** 基础效果（不含熟练度加成） */
  effects: FormationEffects;
  /** 阵法背景故事 */
  lore: string;
}

/** 阵法全局配置（GET /formation/config 返回） */
export interface FormationConfig {
  global: {
    /** 进入阵法系统所需最低境界排名 */
    min_realm_rank: number;
    /** 阵法持续时间（秒，默认 14400 = 4小时） */
    active_duration_seconds: number;
    /** 撤阵冷却时间（秒，默认 1800 = 30分钟） */
    deactivate_cooldown_seconds: number;
    /** 每次布阵获得的熟练度 */
    proficiency_per_activate: number;
    /** 熟练度效果步长（每100点触发一次效果提升） */
    proficiency_effect_step: number;
    /** 熟练度效果加成比例（每步长 +5%） */
    proficiency_effect_bonus_ratio: number;
    /** 熟练度上限 */
    proficiency_max: number;
    /** 相克惩罚比例（0.2 = 被克制方效果 -20%） */
    counter_penalty_ratio: number;
    /** 阵法战力权重系数 */
    combat_power_weight: number;
    /** 相克关系映射 */
    counter_relationships: Record<FormationCategory, FormationCategory>;
    /** 品阶显示名映射 */
    grade_display_names: Record<FormationGrade, string>;
    /** 分类显示名映射 */
    category_display_names: Record<FormationCategory, string>;
    /** 各品阶所需最低境界排名 */
    grade_min_realm_rank: Record<FormationGrade, number>;
    /** 各品阶学习灵石消耗 */
    grade_learn_cost: Record<FormationGrade, number>;
  };
  /** 所有阵法列表 */
  formations: FormationBrief[];
}

/** 已学阵法信息 */
export interface LearnedFormation {
  /** 阵法ID */
  formation_id: string;
  /** 阵法名称 */
  name: string;
  /** 分类 */
  category?: FormationCategory;
  /** 分类显示名 */
  category_display?: string;
  /** 品阶 */
  grade?: FormationGrade;
  /** 品阶显示名 */
  grade_display?: string;
  /** 当前熟练度 */
  proficiency: number;
  /** 熟练度上限 */
  proficiency_max: number;
  /** 学习时间 */
  learned_at: string;
  /** 含熟练度加成的实际效果 */
  effects: FormationEffects | null;
}

/** 当前激活阵法信息 */
export interface ActiveFormationInfo {
  /** 阵法ID */
  formation_id: string;
  /** 阵法名称 */
  name: string;
  /** 分类 */
  category: FormationCategory;
  /** 分类显示名 */
  category_display: string;
  /** 品阶 */
  grade: FormationGrade;
  /** 品阶显示名 */
  grade_display: string;
  /** 当前熟练度 */
  proficiency: number;
  /** 激活时间 */
  activated_at: string;
  /** 剩余持续时间（秒） */
  remaining_seconds: number;
  /** 总持续时间（秒） */
  duration_seconds: number;
  /** 实际效果（含熟练度加成） */
  effects: FormationEffects;
  /** 阵法描述 */
  description: string;
}

/** 玩家阵法状态总览（GET /formation/status 返回） */
export interface FormationStatus {
  /** 当前境界排名 */
  realm_rank: number;
  /** 当前境界名称 */
  realm_name: string;
  /** 系统所需最低境界排名 */
  min_realm_rank: number;
  /** 是否已解锁阵法系统 */
  unlocked: boolean;
  /** 当前激活阵法（null表示未激活） */
  active_formation: ActiveFormationInfo | null;
  /** 已学阵法数量 */
  learned_count: number;
  /** 已学阵法列表 */
  learned_formations: LearnedFormation[];
  /** 撤阵冷却是否已就绪 */
  deactivate_cooldown_ready: boolean;
  /** 撤阵冷却剩余秒数 */
  deactivate_cooldown_remaining_sec: number;
  /** 阵法持续时间（秒） */
  active_duration_seconds: number;
  /** 熟练度效果步长 */
  proficiency_effect_step: number;
  /** 熟练度效果加成比例 */
  proficiency_effect_bonus_ratio: number;
}

/** 学习阵法结果 */
export interface LearnFormationResult {
  formation_id: string;
  formation_name: string;
  proficiency: number;
  spirit_stones_remaining: string;
}

/** 布阵激活结果 */
export interface ActivateFormationResult {
  formation_id: string;
  formation_name: string;
  proficiency: number;
  activated_at: string;
  remaining_seconds: number;
  duration_seconds: number;
  effects: FormationEffects;
  spirit_stones_remaining: string;
}

/** 撤阵结果 */
export interface DeactivateFormationResult {
  deactivated_formation_id: string;
  deactivated_formation_name: string;
  cooldown_seconds: number;
  can_reactivate_at: string;
}

/** 激活阵法效果（GET /formation/active-effect 返回） */
export interface ActiveFormationEffect {
  active: boolean;
  formation_id: string | null;
  formation_name?: string;
  category?: FormationCategory;
  grade?: FormationGrade;
  proficiency?: number;
  effects: FormationEffects;
  counter_penalty: number;
}

/** 统一响应格式 */
interface ServiceResponse<T> {
  code: number;
  message?: string;
  data: T;
  success?: boolean;
  error_code?: string;
}

/**
 * 获取阵法全局配置与全阵法列表
 * GET /formation/config
 * 未登录也可调用（用于展示规则）
 */
export const getConfig = () => {
  return apiClient.get<ServiceResponse<FormationConfig>>('/formation/config');
};

/**
 * 查询玩家阵法状态总览
 * GET /formation/status
 */
export const getStatus = () => {
  return apiClient.get<ServiceResponse<FormationStatus>>('/formation/status');
};

/**
 * 学习阵法
 * POST /formation/learn
 * @param formation_id 阵法ID
 */
export const learnFormation = (formation_id: string) => {
  return apiClient.post<ServiceResponse<LearnFormationResult>>('/formation/learn', {
    formation_id
  });
};

/**
 * 布阵激活
 * POST /formation/activate
 * @param formation_id 阵法ID
 */
export const activateFormation = (formation_id: string) => {
  return apiClient.post<ServiceResponse<ActivateFormationResult>>('/formation/activate', {
    formation_id
  });
};

/**
 * 撤阵
 * POST /formation/deactivate
 * 撤阵后进入冷却期（默认30分钟）
 */
export const deactivateFormation = () => {
  return apiClient.post<ServiceResponse<DeactivateFormationResult>>('/formation/deactivate');
};

/**
 * 获取当前激活阵法效果（战力预览用）
 * GET /formation/active-effect?opponent_category=attack
 * @param opponent_category 对手阵法类型（用于PVP相克判定预览，可选）
 */
export const getActiveEffect = (opponent_category?: FormationCategory) => {
  const params = opponent_category ? { opponent_category } : {};
  return apiClient.get<ServiceResponse<ActiveFormationEffect>>('/formation/active-effect', { params });
};

// ===== GM 后台接口（管理员专用） =====

/** GM 阵法统计信息 */
export interface GmFormationStats {
  total_learned_records: number;
  formation_stats: Array<{
    formation_id: string;
    name: string;
    category: FormationCategory;
    grade: FormationGrade;
    learned_count: number;
    active_count: number;
  }>;
  recent_learned: Array<{
    player_id: number;
    player_nickname: string;
    player_realm: string;
    formation_id: string;
    formation_name: string;
    proficiency: number;
    learned_at: string;
  }>;
}

/** GM 获取阵法统计 */
export const gmGetStats = (limit = 100) => {
  return apiClient.get<ServiceResponse<GmFormationStats>>('/admin/formation/stats', {
    params: { limit }
  });
};

/** GM 给玩家发放阵法 */
export const gmGrantFormation = (player_id: number, formation_id: string) => {
  return apiClient.post<ServiceResponse<{ formation_id: string; formation_name?: string; proficiency: number }>>(
    '/admin/formation/grant',
    { player_id, formation_id }
  );
};

/** GM 强制激活玩家阵法 */
export const gmForceActivate = (playerId: number, formation_id: string) => {
  return apiClient.post<ServiceResponse<{ player_id: number; formation_id: string; activated_at: string }>>(
    `/admin/formation/player/${playerId}/activate`,
    { formation_id }
  );
};

/** GM 强制撤阵 */
export const gmForceDeactivate = (playerId: number) => {
  return apiClient.post<ServiceResponse<{ player_id: number; formation_id: string }>>(
    `/admin/formation/player/${playerId}/deactivate`
  );
};

/** GM 剥夺玩家阵法 */
export const gmRevokeFormation = (playerId: number, formationId: string) => {
  return apiClient.delete<ServiceResponse<{ player_id: number; formation_id: string }>>(
    `/admin/formation/player/${playerId}/${formationId}`
  );
};

/** GM 热更新阵法全局配置 */
export const gmUpdateConfig = (global: Partial<FormationConfig['global']>) => {
  return apiClient.put<ServiceResponse<{ global: FormationConfig['global'] }>>('/admin/formation/config', { global });
};
