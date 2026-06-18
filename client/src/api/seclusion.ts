/**
 * 闭关相关 API
 */
import apiClient from './index';

/**
 * 获取闭关状态
 */
export const getStatus = () => {
  return apiClient.get('/seclusion/status');
};

/**
 * 开始闭关
 */
export const start = (duration?: number) => {
  return apiClient.post('/seclusion/start', { duration });
};

/**
 * 结束闭关
 */
export const end = () => {
  return apiClient.post('/seclusion/end');
};
