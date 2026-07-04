/**
 * 管理员相关 API
 */
import apiClient from './index';

export interface PlayerListParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export interface PlayerListResponse {
  code: number;
  data: {
    players: any[];
    pagination: {
      currentPage: number;
      totalPages: number;
      total: number;
    };
  };
}

/**
 * 获取玩家列表
 */
export const getPlayers = (params: PlayerListParams) => {
  return apiClient.get<PlayerListResponse>('/admin/players', { params });
};

/**
 * 更新玩家信息
 */
export const updatePlayer = (playerId: number, data: any) => {
  return apiClient.put(`/admin/players/${playerId}`, data);
};

/**
 * 删除玩家
 */
export const deletePlayer = (playerId: number) => {
  return apiClient.delete(`/admin/players/${playerId}`);
};

/**
 * 封禁玩家
 */
export const banPlayer = (playerId: number, reason: string, days: number = -1) => {
  return apiClient.post(`/admin/players/${playerId}/ban`, { reason, days });
};

/**
 * 解封玩家
 */
export const unbanPlayerApi = (playerId: number) => {
  return apiClient.post(`/admin/players/${playerId}/unban`);
};

/**
 * 发放物品
 */
export const giveItem = (playerId: number, itemId: string, quantity: number) => {
  return apiClient.post('/admin/give-item', {
    playerId,
    itemId,
    quantity
  });
};

/**
 * 发放灵石
 */
export const giveSpiritStones = (playerId: number, amount: number) => {
  return apiClient.post('/admin/give-spirit-stones', { playerId, amount });
};

/**
 * 发放修为
 */
export const giveExp = (playerId: number, amount: number) => {
  return apiClient.post('/admin/add-exp', { playerId, amount });
};

/**
 * 获取系统配置
 */
export const getConfig = () => {
  return apiClient.get('/admin/config');
};

/**
 * 更新系统配置
 */
export const updateConfig = (key: string, value: string, description?: string) => {
  return apiClient.post('/admin/config', { key, value, description });
};

/**
 * 获取服务器统计
 */
export const getStats = () => {
  return apiClient.get('/admin/stats');
};

/**
 * 时间加速
 */
export const timeTravel = (years: number) => {
  return apiClient.post('/admin/time-travel', { years });
};

/**
 * 删除通知
 */
export const deleteNotification = (notificationId: number) => {
  return apiClient.delete(`/admin/notifications/${notificationId}`);
};

/**
 * 获取操作日志
 */
export const getLogs = (params: { page?: number; limit?: number; action?: string } = {}) => {
  return apiClient.get('/admin/logs', { params });
};

/**
 * 发送全服公告
 */
export const sendAnnouncement = (title: string, content: string, priority: string) => {
  return apiClient.post('/notifications/announcement', { title, content, priority });
};

/**
 * 获取通知列表（管理员视角）
 */
export const getAdminNotifications = (params: { page?: number; limit?: number; includeGlobal?: string } = {}) => {
  return apiClient.get('/notifications', { params });
};

// ========== 状态清理调度器监控 ==========

/**
 * 获取状态清理调度器监控指标
 * GET /api/admin/state-cleaner/metrics
 * 返回：lastRunAt/lastRunDurationMs/totalRuns/totalErrors/errorRate/registeredStates 等
 */
export const getStateCleanerMetrics = () => {
  return apiClient.get('/admin/state-cleaner/metrics');
};

/**
 * 手动触发一次状态清理扫描
 * POST /api/admin/state-cleaner/run
 * 用于运维手动清理线上遗留状态
 */
export const triggerStateCleanerRun = () => {
  return apiClient.post('/admin/state-cleaner/run');
};

// ========== 状态转移日志 ==========

/**
 * 获取玩家状态转移日志
 * GET /api/admin/state-logs
 * @param params - 查询参数 { player_id?, action?, state_type?, page?, limit? }
 */
export const getStateLogs = (params: { player_id?: number; action?: string; state_type?: string; page?: number; limit?: number } = {}) => {
  return apiClient.get('/admin/state-logs', { params });
};
