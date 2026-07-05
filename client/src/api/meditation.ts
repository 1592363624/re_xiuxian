/**
 * 静思悟道相关 API
 *
 * 第三阶段新增玩法：玩家通过静思悟道积累感悟值（insight），
 * 用于破除境界瓶颈，提升突破成功率。
 *
 * 时长类型（duration_type）：
 *   - short：静思一刻（60秒，每日多次）
 *   - medium：凝神悟道（5分钟，每日多次）
 *   - long：闭关参悟（30分钟，每日多次）
 *   - deep：深度悟道（1小时，仅瓶颈期可用，需筑基期以上）
 *
 * 瓶颈系统：
 *   - bottleneck_state：none/active/broken/failed
 *   - 瓶颈境界：rank 10/13/17/21 会触发瓶颈
 *   - 通过悟道积累感悟值达到阈值后破除瓶颈
 *   - 破除瓶颈后突破可获 +30% 成功率加成
 */
import apiClient from './index';

/** 悟道时长类型 */
export type MeditationDurationType = 'short' | 'medium' | 'long' | 'deep';

/** 瓶颈状态 */
export type BottleneckState = 'none' | 'active' | 'broken' | 'failed';

/** 单种时长类型配置 */
export interface DurationTypeConfig {
  /** 时长（秒） */
  duration: number;
  /** 基础感悟值 */
  insight_base: number;
  /** 随机感悟值上限 */
  insight_random: number;
  /** 修为奖励倍率（按当前修为计算） */
  exp_reward_rate: number;
  /** 中文标签 */
  label: string;
}

/** 深度悟道配置 */
export interface DeepMeditationConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 时长（秒） */
  duration: number;
  /** 基础感悟值 */
  insight_base: number;
  /** 随机感悟值上限 */
  insight_random: number;
  /** 修为奖励倍率 */
  exp_reward_rate: number;
  /** 最低境界排名要求 */
  min_realm_rank: number;
  /** 中文标签 */
  label: string;
}

/** 公开悟道配置（GET /meditation/config 返回） */
export interface MeditationPublicConfig {
  duration_types: Record<string, DurationTypeConfig>;
  deep: DeepMeditationConfig;
  /** 每日常规悟道次数上限 */
  daily_normal_limit: number;
  /** 每日深度悟道次数上限 */
  daily_deep_limit: number;
  /** 冷却时间（秒） */
  cooldown_seconds: number;
  /** 瓶颈系统公开配置 */
  bottleneck: {
    enabled: boolean;
    bottleneck_realms: number[];
    max_failure_count: number;
    broken_breakthrough_bonus: number;
  };
}

/** 悟道状态（GET /meditation/status 返回） */
export interface MeditationStatus {
  /** 是否正在悟道中 */
  is_meditating: boolean;
  /** 悟道模式 */
  meditation_mode: string | null;
  /** 悟道开始时间 */
  meditation_start_time: string | null;
  /** 悟道结束时间（预计） */
  meditation_end_time: string | null;
  /** 悟道时长（秒） */
  meditation_duration: number | null;
  /** 当前已积累的感悟值 */
  meditation_insight: number;
  /** 今日已用常规悟道次数 */
  daily_meditation_count: number;
  /** 今日已用深度悟道次数 */
  daily_deep_meditation_count: number;
  /** 上次悟道时间 */
  last_meditation_time: string | null;
  /** 冷却剩余秒数 */
  cooldown_remaining: number;
  /** 服务端时间戳（用于本地 tick 计算） */
  server_time: number;
  /** 瓶颈系统状态 */
  bottleneck: {
    state: BottleneckState;
    insight: number;
    threshold: number;
    failure_count: number;
    realm_rank: number | null;
    started_at: string | null;
  };
}

/** 开始悟道响应（POST /meditation/start 返回） */
export interface StartMeditationResult {
  /** 悟道模式 */
  mode: string;
  /** 时长（秒） */
  duration: number;
  /** 开始时间 */
  start_time: string;
  /** 预计结束时间 */
  end_time: string;
  /** 当前累计感悟 */
  insight: number;
  /** 提示文案 */
  message: string;
}

/** 中断悟道响应（POST /meditation/interrupt 返回） */
export interface InterruptMeditationResult {
  /** 悟道模式 */
  mode: string;
  /** 实际悟道时长（秒） */
  elapsed: number;
  /** 总时长（秒） */
  duration: number;
  /** 完成度（0-1） */
  completion_rate: number;
  /** 获得的感悟值 */
  insight_gain: number;
  /** 获得的修为 */
  exp_gain: string;
  /** 是否触发瓶颈破除 */
  bottleneck_broken: boolean;
  /** 提示文案 */
  message: string;
}

/**
 * 获取悟道状态与瓶颈进度
 * GET /meditation/status
 */
export const getStatus = () => {
  return apiClient.get<MeditationStatus>('/meditation/status');
};

/**
 * 获取悟道配置（供前端展示时长选项和说明）
 * GET /meditation/config
 */
export const getConfig = () => {
  return apiClient.get<MeditationPublicConfig>('/meditation/config');
};

/**
 * 开始静思悟道
 * POST /meditation/start
 * @param duration_type 时长类型：short/medium/long/deep
 */
export const startMeditation = (duration_type: MeditationDurationType) => {
  return apiClient.post<StartMeditationResult>('/meditation/start', { duration_type });
};

/**
 * 主动中断悟道（带惩罚）
 * 中断时仅按完成度比例发放感悟值
 * POST /meditation/interrupt
 */
export const interruptMeditation = () => {
  return apiClient.post<InterruptMeditationResult>('/meditation/interrupt');
};
