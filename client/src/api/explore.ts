/**
 * 历练探索相关 API
 */
import apiClient from './index';

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
 */
export const startExplore = (duration: number = 90) => {
  return apiClient.post('/map/explore/start', { duration });
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
