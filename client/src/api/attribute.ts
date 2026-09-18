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
 * 可加点属性名（与服务端 ALLOCATABLE_BONUS_KEYS 白名单一致）
 */
export type AllocatableAttribute = 'hp' | 'mp' | 'atk' | 'def' | 'speed' | 'sense';

/**
 * 分配属性点
 */
export const allocateAttributePoints = (points: Partial<Record<AllocatableAttribute, number>>) => {
  return apiClient.post('/attribute/allocate', { points });
};

/**
 * 重置属性点
 */
export const resetAttributePoints = () => {
  return apiClient.post('/attribute/reset');
};
