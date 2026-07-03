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
