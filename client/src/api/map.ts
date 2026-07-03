/**
 * 地图相关 API
 */
import apiClient from './index';

/**
 * 获取当前地图信息
 */
export const getMapInfo = () => {
  return apiClient.get('/map/info');
};

/**
 * 获取地图列表
 */
export const getMapList = () => {
  return apiClient.get('/map/list');
};

/**
 * 获取地图配置
 */
export const getMapConfig = () => {
  return apiClient.get('/map/config');
};

/**
 * 计算移动到目标地图的消耗
 */
export const calculateMoveCost = (targetMapId: number) => {
  return apiClient.post('/map/calculate-move-cost', { targetMapId });
};

/**
 * 批量计算移动消耗（性能优化接口）
 *
 * 设计目的：FullMapList 全图浏览时一次性获取所有地图的移动消耗，
 *   避免前端对每个地图发一次 /calculate-move-cost 请求（N 次请求）
 *
 * @param targetMapIds 目标地图ID数组
 */
export const batchCalculateMoveCost = (targetMapIds: number[]) => {
  return apiClient.post('/map/batch-calculate-move-cost', { targetMapIds });
};

/**
 * 开始移动
 */
export const startMove = (targetMapId: string) => {
  return apiClient.post('/map/start-move', { targetMapId });
};

/**
 * 移动到指定地图
 */
export const moveTo = (mapId: number) => {
  return apiClient.post('/map/move', { mapId });
};

/**
 * 取消移动
 */
export const cancelMove = () => {
  return apiClient.post('/map/cancel-move');
};
