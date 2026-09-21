/**
 * 通知相关 API
 */
import apiClient from './index';

/**
 * 获取通知列表
 */
export const getNotifications = (options: {
  page?: number;
  limit?: number;
  type?: string;
  unreadOnly?: boolean;
  /** 是否同时返回全服通知（targetPlayerId 为 null 的公告，默认后端为 true） */
  includeGlobal?: boolean;
} = {}) => {
  return apiClient.get('/notifications', { params: options });
};

/**
 * 获取未读通知数量
 */
export const getUnreadCount = () => {
  return apiClient.get('/notifications/unread-count');
};

/**
 * 获取全服通知
 */
export const getGlobalNotifications = (limit: number = 10) => {
  return apiClient.get('/notifications/global', { params: { limit } });
};

/**
 * 标记通知已读
 */
export const markAsRead = (notificationId: number) => {
  return apiClient.post(`/notifications/${notificationId}/read`);
};

/**
 * 标记所有通知已读
 */
export const markAllAsRead = () => {
  return apiClient.post('/notifications/read-all');
};
