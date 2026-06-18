/**
 * 系统相关 API
 */
import apiClient from './index';

/**
 * 获取系统配置
 */
export const getConfig = () => {
  return apiClient.get('/system/config');
};

/**
 * 获取系统统计
 */
export const getStats = () => {
  return apiClient.get('/system/stats');
};
