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
