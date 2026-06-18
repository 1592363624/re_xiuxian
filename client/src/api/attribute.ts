/**
 * 属性相关 API
 */
import apiClient from './index';

/**
 * 获取玩家完整属性信息
 */
export const getFullAttributes = () => {
  return apiClient.get('/attribute/full');
};

/**
 * 获取属性详细信息
 */
export const getAttributeDetails = () => {
  return apiClient.get('/attribute/details');
};

/**
 * 分配属性点
 */
export const allocateAttributePoints = (data: { attribute: string; points: number }) => {
  return apiClient.post('/attribute/allocate', data);
};

/**
 * 重置属性点
 */
export const resetAttributePoints = () => {
  return apiClient.post('/attribute/reset');
};
