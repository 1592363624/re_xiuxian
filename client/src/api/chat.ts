/**
 * 聊天相关 API
 */
import apiClient from './index';

/**
 * 获取聊天历史
 */
export const getChatHistory = () => {
  return apiClient.get('/chat/history');
};

/**
 * 发送消息
 */
export const sendMessage = (content: string) => {
  return apiClient.post('/chat/send', { content });
};

/**
 * 获取未读消息数量
 */
export const getUnreadCount = (lastReadTime?: string) => {
  return apiClient.get('/chat/unread-count', { params: { lastReadTime } });
};

/**
 * 标记消息已读
 */
export const markRead = () => {
  return apiClient.post('/chat/mark-read');
};
