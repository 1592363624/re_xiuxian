/**
 * 大衍诀修炼系统 API
 *
 * 封装大衍诀修炼玩法的接口调用：获取配置、查看修炼状态、参悟、突破、飞升前置检查。
 *
 * 设计原则：
 *   - 所有业务逻辑由后端 DayanService 处理，前端仅做调用与展示
 *   - 禁止直接 axios，统一使用 apiClient（携带 JWT + 统一错误处理）
 *   - BIGINT 修为字段使用 string 类型，避免 JS Number 精度问题
 *   - 与神识淬炼系统联动：层数影响神识上限（dayan_level * 100）
 *
 * 玩法文档对照：xiuxian_game_guide.md 第23节·大衍诀与傀儡路线
 *   `.参悟大衍诀` / `.大衍诀` / `.修炼大衍诀` 查看和推进层数
 *
 * 系统定位：
 *   - 5层修炼：凝识 → 分念 → 控傀 → 千机 → 衍神
 *   - 参悟推进：每日3次，冷却10分钟，消耗修为获得大衍诀经验
 *   - 突破判定：经验满后消耗残篇尝试突破，成功率随层数递减（80%→70%→60%→50%→40%）
 *   - 神识联动：层数影响神识上限（dayan_level * 100），已在 DivineSenseService 中集成
 *   - 飞升前置：五层·衍神是飞升灵界的必要条件
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
import apiClient from './index';

// ==================== 类型定义 ====================

/**
 * 大衍诀单层配置
 */
export interface DayanLevelConfig {
  /** 层级名称（如"第一层·凝识"） */
  name: string;
  /** 神识倍率（1.30/1.60/2.00/2.45/3.00） */
  sense_multiplier: number;
  /** 升至下一层所需经验（0=最高层） */
  exp_to_next: number;
  /** 突破所需残篇物品 key（null=无需残篇） */
  fragment_required: string | null;
  /** 突破所需残篇数量 */
  fragment_count?: number;
  /** 该层描述 */
  description: string;
}

/**
 * 残篇信息配置
 */
export interface DayanFragmentConfig {
  /** 残篇名称 */
  name: string;
  /** 对应层级 */
  level: number;
  /** 获取来源 */
  source: string;
  /** 残篇描述 */
  description: string;
}

/**
 * 参悟参数配置
 */
export interface DayanMeditateConfig {
  /** 每日参悟次数上限 */
  daily_limit: number;
  /** 参悟冷却（秒） */
  cooldown_sec: number;
  /** 单次参悟获得经验 */
  exp_per_meditate: number;
  /** 修为消耗基础值 */
  cost_exp_base: number;
  /** 每层附加修为消耗 */
  cost_exp_per_level: number;
}

/**
 * 突破参数配置
 */
export interface DayanBreakthroughConfig {
  /** 基础成功率 */
  success_rate_base: number;
  /** 每层成功率衰减 */
  success_rate_per_level_decay: number;
  /** 最低成功率下限 */
  min_success_rate: number;
}

/**
 * 飞升前置条件配置
 */
export interface DayanAscensionRequirement {
  /** 飞升所需大衍诀层数 */
  required_level: number;
  /** 描述说明 */
  description?: string;
}

/**
 * 大衍诀系统完整配置（GET /dayan/config 返回）
 */
export interface DayanConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 最低修炼境界 rank（默认15=炼气期） */
  min_realm_rank: number;
  /** 最高层数 */
  max_level: number;
  /** 参悟参数 */
  meditate: DayanMeditateConfig;
  /** 突破参数 */
  breakthrough: DayanBreakthroughConfig;
  /** 各层配置（key=层级数字字符串） */
  levels: Record<string, DayanLevelConfig>;
  /** 残篇物品配置 */
  fragments: Record<string, DayanFragmentConfig>;
  /** 飞升前置条件 */
  ascension_requirement: DayanAscensionRequirement;
  /** 每层神识上限加成 */
  sense_bonus_per_level: number;
}

/**
 * 下一层突破所需残篇信息（status 接口内嵌）
 */
export interface DayanNextFragmentInfo {
  /** 残篇物品 key */
  item_key: string;
  /** 残篇名称 */
  name: string;
  /** 所需数量 */
  required: number;
  /** 当前持有数量 */
  owned: number;
  /** 获取来源 */
  source: string;
  /** 残篇描述 */
  description: string;
}

/**
 * 参悟状态信息（status 接口内嵌）
 */
export interface DayanMeditateStatus {
  /** 每日上限 */
  daily_limit: number;
  /** 今日已用次数 */
  daily_used: number;
  /** 今日剩余次数 */
  daily_remaining: number;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
  /** 是否可参悟 */
  can_meditate: boolean;
  /** 单次修为消耗 */
  cost_exp: number;
  /** 单次获得经验 */
  exp_per_meditate: number;
}

/**
 * 大衍诀修炼状态（GET /dayan/status 返回）
 */
export interface DayanStatus {
  /** 是否启用 */
  enabled: boolean;
  /** 当前层数（0-5） */
  current_level: number;
  /** 当前层名称 */
  current_level_name: string;
  /** 当前层描述 */
  current_level_description: string;
  /** 当前层已积累经验 */
  current_exp: number;
  /** 升至下一层所需经验（0=最高层） */
  exp_to_next: number;
  /** 当前神识倍率 */
  sense_multiplier: number;
  /** 神识上限加成（current_level * sense_bonus_per_level） */
  sense_max_bonus: number;
  /** 是否满足飞升前置 */
  can_ascend: boolean;
  /** 飞升前置条件配置 */
  ascension_requirement: DayanAscensionRequirement;
  /** 参悟状态 */
  meditate: DayanMeditateStatus;
  /** 下一层残篇信息（最高层为 null） */
  next_fragment: DayanNextFragmentInfo | null;
  /** 是否可突破 */
  can_breakthrough: boolean;
  /** 玩家当前修为（字符串大数） */
  player_exp: string;
  /** 玩家境界名称 */
  player_realm: string;
  /** 玩家境界 rank */
  player_realm_rank: number;
}

/**
 * 参悟结果（POST /dayan/meditate 返回）
 */
export interface DayanMeditateResult {
  /** 是否成功 */
  success: boolean;
  /** 结果消息 */
  message: string;
  /** 参悟时所在层数 */
  level: number;
  /** 层数名称 */
  level_name: string;
  /** 本次获得经验 */
  exp_gained: number;
  /** 当前层累计经验 */
  exp_current: number;
  /** 升至下一层所需经验 */
  exp_to_next: number;
  /** 是否已可突破 */
  can_breakthrough: boolean;
  /** 本次消耗修为 */
  cost_exp: number;
  /** 参悟后玩家修为余额（字符串大数） */
  player_exp_after: string;
  /** 今日剩余参悟次数 */
  daily_remaining: number;
}

/**
 * 突破结果（POST /dayan/breakthrough 返回）
 */
export interface DayanBreakthroughResult {
  /** 接口是否成功（区别于突破是否成功） */
  success: boolean;
  /** 突破是否成功 */
  breakthrough: boolean;
  /** 结果消息 */
  message: string;
  /** 突破前层数（成功时） */
  old_level?: number;
  /** 突破后层数（成功时） */
  new_level?: number;
  /** 新层数名称（成功时） */
  new_level_name?: string;
  /** 新层数描述（成功时） */
  new_level_description?: string;
  /** 新神识倍率（成功时） */
  sense_multiplier?: number;
  /** 是否满足飞升前置（成功时） */
  can_ascend?: boolean;
  /** 失败时所在层数 */
  level?: number;
  /** 失败时的成功率 */
  success_rate?: number;
  /** 失败时保留的经验 */
  exp_current?: number;
}

/**
 * 飞升前置检查结果（GET /dayan/ascension-check 返回）
 */
export interface DayanAscensionCheckResult {
  /** 飞升所需层数 */
  required_level: number;
  /** 当前层数 */
  current_level: number;
  /** 是否满足 */
  met: boolean;
  /** 说明消息 */
  message: string;
}

// ==================== API 函数 ====================

/**
 * 获取大衍诀系统配置（无需鉴权）
 * GET /dayan/config
 * 供前端展示规则说明与各层详情
 */
export const getConfig = () => {
  return apiClient.get<DayanConfig>('/dayan/config');
};

/**
 * 获取玩家大衍诀修炼状态（需鉴权）
 * GET /dayan/status
 * 返回当前层数/经验/参悟次数/冷却/突破条件/神识倍率/飞升前置
 */
export const getStatus = () => {
  return apiClient.get<DayanStatus>('/dayan/status');
};

/**
 * 参悟大衍诀（需鉴权）
 * POST /dayan/meditate
 *
 * 业务规则（后端校验）：
 *   - 玩家境界 rank ≥ min_realm_rank（默认15=炼气期）
 *   - 今日参悟次数未超限（默认3次/日）
 *   - 冷却已结束（默认10分钟）
 *   - 修为充足（消耗随层数递增）
 *   - 大衍诀未达最高层
 */
export const meditate = () => {
  return apiClient.post<{ code: number; message: string; data: DayanMeditateResult }>('/dayan/meditate');
};

/**
 * 突破大衍诀层数（需鉴权）
 * POST /dayan/breakthrough
 *
 * 业务规则（后端校验）：
 *   - 经验已满当前层上限
 *   - 持有对应层数的残篇（突破时扣除）
 *   - 成功率随层数递减（80%→70%→60%→50%→40%，下限30%）
 *   - 失败时残篇损耗，经验保留
 */
export const breakthrough = () => {
  return apiClient.post<{ code: number; message: string; data: DayanBreakthroughResult }>('/dayan/breakthrough');
};

/**
 * 检查飞升前置条件（需鉴权）
 * GET /dayan/ascension-check
 * 返回 required_level/current_level/met/message
 */
export const checkAscension = () => {
  return apiClient.get<DayanAscensionCheckResult>('/dayan/ascension-check');
};
