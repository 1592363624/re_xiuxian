/**
 * 悟道与瓶颈管理 API（GM 后台）
 *
 * 封装 GM 后台对玩家悟道状态和瓶颈状态的查询/强制结算/强制中断/修改瓶颈等接口。
 * 所有接口需要管理员权限（后端 auth + adminCheck 双层中间件）。
 *
 * 接口列表：
 *   1. GET  /admin/meditation/metrics：获取悟道与瓶颈系统统计指标
 *   2. GET  /admin/meditation/list：分页查询悟道/瓶颈玩家
 *   3. GET  /admin/meditation/:playerId：查询指定玩家悟道详情
 *   4. POST /admin/meditation/:playerId/force-settle：强制结算悟道
 *   5. POST /admin/meditation/:playerId/force-interrupt：强制中断悟道
 *   6. PUT  /admin/meditation/:playerId/bottleneck：修改瓶颈状态
 *   7. POST /admin/meditation/:playerId/bottleneck/reset：重置瓶颈
 */
import apiClient from './index';
import type { BottleneckState } from './meditation';

/** 瓶颈状态分布 */
export interface BottleneckStateDistribution {
  none: number;
  active: number;
  broken: number;
  failed: number;
}

/** 各境界瓶颈玩家分布 */
export interface BottleneckByRealm {
  realm_rank: number;
  count: number;
}

/** 系统统计指标（GET /admin/meditation/metrics 返回） */
export interface MeditationMetrics {
  meditation: {
    /** 当前悟道中的玩家数 */
    meditating_count: number;
    /** 每日常规悟道次数上限 */
    daily_normal_limit: number;
    /** 每日深度悟道次数上限 */
    daily_deep_limit: number;
    /** 冷却时间（秒） */
    cooldown_seconds: number;
  };
  bottleneck: {
    /** 是否启用瓶颈系统 */
    enabled: boolean;
    /** 瓶颈境界排名列表 */
    bottleneck_realms: number[];
    /** 最大失败次数 */
    max_failure_count: number;
    /** 破除瓶颈后突破成功率加成 */
    broken_bonus: number;
    /** 瓶颈状态分布 */
    state_distribution: BottleneckStateDistribution;
    /** 各境界瓶颈玩家分布 */
    by_realm: BottleneckByRealm[];
  };
}

/** 玩家悟道列表项（GET /admin/meditation/list 返回） */
export interface MeditationListItem {
  /** 玩家ID */
  id: number;
  /** 昵称 */
  nickname: string;
  /** 当前境界 */
  realm: string;
  /** 境界排名 */
  realm_rank: number;
  /** 是否正在悟道 */
  is_meditating: boolean;
  /** 悟道模式 */
  meditation_mode: string | null;
  /** 悟道开始时间 */
  meditation_start_time: string | null;
  /** 悟道结束时间 */
  meditation_end_time: string | null;
  /** 悟道时长 */
  meditation_duration: number | null;
  /** 瓶颈状态 */
  bottleneck_state: BottleneckState;
  /** 瓶颈境界排名 */
  bottleneck_realm_rank: number | null;
  /** 瓶颈感悟值 */
  bottleneck_insight: number;
  /** 瓶颈阈值 */
  bottleneck_threshold: number;
  /** 瓶颈开始时间 */
  bottleneck_started_at: string | null;
  /** 突破失败次数 */
  breakthrough_failure_count: number;
  /** 上次悟道时间 */
  last_meditation_time: string | null;
  /** 今日已用常规悟道次数 */
  daily_meditation_count: number;
  /** 今日已用深度悟道次数 */
  daily_deep_meditation_count: number;
}

/** 列表查询参数 */
export interface MeditationListParams {
  /** 筛选类型：all=全部 / meditating=仅悟道中 / bottleneck=仅瓶颈期 */
  filter?: 'all' | 'meditating' | 'bottleneck';
  /** 页码（默认1） */
  page?: number;
  /** 每页条数（默认20，最大100） */
  limit?: number;
}

/** 玩家悟道详情（GET /admin/meditation/:playerId 返回） */
export interface MeditationPlayerDetail extends MeditationListItem {
  /** 修为（字符串大数） */
  exp: string;
  /** 灵石 */
  spirit_stones: number;
  /** 当前悟道感悟值 */
  meditation_insight: number;
  /** 上次悟道日期 */
  last_meditation_date: string | null;
}

/** 强制结算结果 */
export interface ForceSettleResult {
  /** 悟道模式 */
  mode: string;
  /** 实际悟道时长（秒） */
  elapsed: number;
  /** 总时长（秒） */
  duration: number;
  /** 完成度 */
  completion_rate: number;
  /** 获得的感悟值 */
  insight_gain: number;
  /** 获得的修为 */
  exp_gain: string;
  /** 是否触发瓶颈破除 */
  bottleneck_broken: boolean;
}

/** 修改瓶颈状态请求体 */
export interface UpdateBottleneckBody {
  /** 瓶颈状态：none/active/broken/failed */
  bottleneck_state?: BottleneckState;
  /** 感悟值（0-threshold） */
  bottleneck_insight?: number;
  /** 瓶颈阈值（>=1） */
  bottleneck_threshold?: number;
  /** 突破失败次数（>=0） */
  breakthrough_failure_count?: number;
}

/**
 * 获取悟道与瓶颈系统统计指标
 * GET /admin/meditation/metrics
 */
export const getMetrics = () => {
  return apiClient.get<MeditationMetrics>('/admin/meditation/metrics');
};

/**
 * 分页查询所有正在悟道或处于瓶颈期的玩家
 * GET /admin/meditation/list
 * @param params 查询参数（filter/page/limit）
 */
export const getList = (params: MeditationListParams = {}) => {
  return apiClient.get<{ list: MeditationListItem[]; total: number; page: number; pageSize: number }>(
    '/admin/meditation/list',
    { params }
  );
};

/**
 * 查询指定玩家的悟道状态与瓶颈详情
 * GET /admin/meditation/:playerId
 * @param playerId 玩家ID
 */
export const getPlayerDetail = (playerId: number) => {
  return apiClient.get<MeditationPlayerDetail>(`/admin/meditation/${playerId}`);
};

/**
 * 强制结算玩家悟道（无惩罚，相当于自动到期）
 * POST /admin/meditation/:playerId/force-settle
 * @param playerId 玩家ID
 */
export const forceSettle = (playerId: number) => {
  return apiClient.post<ForceSettleResult>(`/admin/meditation/${playerId}/force-settle`);
};

/**
 * 强制中断玩家悟道（带惩罚）
 * POST /admin/meditation/:playerId/force-interrupt
 * @param playerId 玩家ID
 */
export const forceInterrupt = (playerId: number) => {
  return apiClient.post<ForceSettleResult>(`/admin/meditation/${playerId}/force-interrupt`);
};

/**
 * 修改玩家瓶颈状态（用于测试和补偿）
 * PUT /admin/meditation/:playerId/bottleneck
 * @param playerId 玩家ID
 * @param body 修改字段（bottleneck_state/insight/threshold/failure_count）
 */
export const updateBottleneck = (playerId: number, body: UpdateBottleneckBody) => {
  return apiClient.put(`/admin/meditation/${playerId}/bottleneck`, body);
};

/**
 * 重置玩家瓶颈状态（清空所有瓶颈字段）
 * POST /admin/meditation/:playerId/bottleneck/reset
 * @param playerId 玩家ID
 */
export const resetBottleneck = (playerId: number) => {
  return apiClient.post(`/admin/meditation/${playerId}/bottleneck/reset`);
};
