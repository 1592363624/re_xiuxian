/**
 * 历练探索相关 API
 *
 * 重构后支持时长分级：
 *   - short：短时历练（30秒，0.6x奖励，0%受伤概率）
 *   - medium：中时历练（90秒，1.0x奖励，5%受伤概率，默认）
 *   - long：长时历练（300秒，1.8x奖励，10%受伤概率）
 *
 * 提前结束奖励公式：基础奖励 × (已时长/总时长) × (1 - early_finish_penalty)
 * 不设保底，防止玩家反复"开始→立即结束"刷保底
 */
import apiClient from './index';

/**
 * 历练时长类型
 *   - short：短时历练（低风险低收益）
 *   - medium：中时历练（中风险中收益，默认）
 *   - long：长时历练（高风险高收益）
 */
export type DurationType = 'short' | 'medium' | 'long';

/**
 * 获取 AI 状态
 */
export const getAiStatus = () => {
  return apiClient.get('/map/explore/ai-status');
};

/**
 * 获取探索事件
 */
export const getExploreEvent = () => {
  return apiClient.get('/map/explore/event');
};

/** 进行中的历练详情（来自后端 /explore/status） */
export interface ActiveAdventure {
  id: number;
  player_id: number;
  map_id: number;
  map_name: string;
  event_id: string;
  event_type: 'peaceful' | 'combat' | 'treasure' | 'encounter' | 'discovery';
  event_data: any;
  start_time: string;
  end_time: string;
  status: 'in_progress' | 'completed' | 'cancelled';
  combat_battle_id?: string | null;
}

/** /explore/status 返回数据结构 */
export interface ExploreStatusData {
  /** 是否正在历练 */
  is_adventuring: boolean;
  /** 历练详情（无则 null） */
  adventure: ActiveAdventure | null;
  /** 后端权威剩余秒数 */
  remaining_seconds: number;
  /** 后端权威总时长（秒） */
  total_seconds: number;
  /** 是否已到结束时间（玩家应点击完成领取奖励） */
  is_expired: boolean;
  /** 服务器当前时间戳（毫秒，用于前端时钟对齐） */
  server_time: number;
}

/**
 * 获取当前历练状态（用于前端面板重开时恢复"历练中"状态）
 *
 * 设计说明：
 *   - 后端权威返回剩余时间、总时长、是否结束
 *   - 前端不再用本地缓存估算历练进度，避免关闭面板后状态丢失
 *   - 防止前端伪造历练状态
 */
export const getExploreStatus = () => {
  return apiClient.get('/map/explore/status');
};

/**
 * 开始历练
 * @param durationType - 时长类型 short|medium|long（默认 medium）
 * @param duration - 兼容旧参数，直接指定时长（秒）；durationType 优先
 */
export const startExplore = (durationType: DurationType = 'medium', duration?: number) => {
  return apiClient.post('/map/explore/start', { durationType, duration });
};

/**
 * 完成历练
 */
export const completeExplore = () => {
  return apiClient.post('/map/explore/complete');
};

/**
 * 进入战斗（历练触发的战斗）
 */
export const enterCombat = () => {
  return apiClient.post('/map/explore/combat');
};
