/**
 * 境界突破相关 API
 * 封装突破接口调用，避免在 store 中直接使用动态 import
 */
import apiClient from './index';

/**
 * 尝试突破当前境界
 * @returns 突破结果（成功/失败、境界变化、修为消耗等）
 */
export const tryBreakthrough = () => {
  return apiClient.post('/breakthrough/try');
};
