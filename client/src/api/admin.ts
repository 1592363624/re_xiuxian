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
 * 编辑通知（部分更新）
 *
 * 配图按"最终列表"提交：保留原地址即复用已上传的图，不需要重新上传。
 * @param notificationId - 通知 ID
 * @param patch - 只传需要改的字段；imageUrls 传最终列表（空数组表示清空配图）
 */
export const updateNotification = (
  notificationId: number,
  patch: { title?: string; content?: string; priority?: string; imageUrls?: string[] }
) => {
  return apiClient.put<{
    code: number;
    message: string;
    data: { before: Record<string, any>; after: Record<string, any> };
  }>(`/admin/notifications/${notificationId}`, patch);
};

/**
 * 撤回通知（下架，保留记录与配图）
 */
export const unpublishNotification = (notificationId: number) => {
  return apiClient.post<{ code: number; message: string }>(`/admin/notifications/${notificationId}/unpublish`);
};

/**
 * 重新上架已撤回的通知
 */
export const publishNotification = (notificationId: number) => {
  return apiClient.post<{ code: number; message: string }>(`/admin/notifications/${notificationId}/publish`);
};

/**
 * 批量删除通知
 *
 * 为什么不循环调单删接口：删 200 条就是 200 次请求，既慢又会撞上 /api/admin 的限流阈值
 * @param ids - 通知 ID 列表（后端会去重、过滤非法值并限制单次条数）
 */
export const batchDeleteNotifications = (ids: number[]) => {
  return apiClient.post<{
    code: number;
    message: string;
    data: { deleted: number; removedImages: number; ids: number[] };
  }>('/admin/notifications/batch-delete', { ids });
};

/**
 * 获取操作日志
 */
export const getLogs = (params: { page?: number; limit?: number; action?: string } = {}) => {
  return apiClient.get('/admin/logs', { params });
};

/**
 * 发送全服公告
 * @param imageUrls - 公告配图地址（由 uploadAnnouncementImage 上传后得到，最多 3 张）
 */
export const sendAnnouncement = (title: string, content: string, priority: string, imageUrls: string[] = []) => {
  return apiClient.post('/notifications/announcement', { title, content, priority, imageUrls });
};

/** 公告配图上传结果 */
export interface AnnouncementImageUploadResult {
  /** 可直接用于公告展示的地址，随公告提交给后端 */
  url: string;
  /** 服务端落盘文件名 */
  fileName: string;
  /** 实际字节数 */
  size: number;
  /** 服务端识别的真实 MIME */
  mimeType: string;
}

/**
 * 上传公告配图（原始二进制直传）
 *
 * 用 Blob 作为 body 而不是 base64 塞进 JSON：base64 会让体积膨胀约 33%，
 * 整屏截图会因此轻易超过体积上限；同时上传耗时更长，这里单独放宽超时时间。
 * @param blob - 已压缩的图片数据
 * @param mimeType - 图片 MIME（不传则取 blob.type）
 */
export const uploadAnnouncementImage = (blob: Blob, mimeType?: string) => {
  return apiClient.post<{ code: number; message: string; data: AnnouncementImageUploadResult }>(
    '/uploads/announcement-image',
    blob,
    {
      headers: { 'Content-Type': mimeType || blob.type },
      timeout: 60000
    }
  );
};

/**
 * 获取公告配图配置（GM）
 * GET /api/admin/announcement/config
 *
 * 返回三样：完整配置、可改字段清单、以及"为什么不能在前台改"的锁死清单（如 url_prefix）
 */
export const getAnnouncementConfig = () => {
  return apiClient.get<{
    code: number;
    data: {
      config: Record<string, any>;
      editable_fields: string[];
      locked_fields: string[];
    };
  }>('/admin/announcement/config');
};

/**
 * 局部更新公告配图配置并触发热加载
 * POST /api/admin/announcement/config
 *
 * @param patch - 点分路径 → 新值，如 { 'upload.max_file_size_bytes': 8388608, 'cleanup.enabled': true }
 *               后端按白名单校验范围与类型，越界值会被拒绝而不是静默截断
 */
export const updateAnnouncementConfig = (patch: Record<string, number | boolean>) => {
  return apiClient.post<{ code: number; message: string; data: { changes: Record<string, any>; config: Record<string, any> } }>(
    '/admin/announcement/config',
    patch
  );
};

/**
 * 获取通知列表（管理员视角）
 * @param params.includeInactive - 传 'true' 时连同已撤回的通知一起返回（仅管理员生效），
 *                                 否则撤回后记录会从列表里消失，"恢复"按钮永远点不到
 */
export const getAdminNotifications = (
  params: { page?: number; limit?: number; includeGlobal?: string; includeInactive?: string } = {}
) => {
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

// ========== 状态清理调度器配置（GM 可视化编辑 interval_ms 等） ==========

/** 单个状态的清理配置（前端编辑用） */
export interface StateCleanerStateConfig {
  /** 状态类型（如 seclusion/combat/adventure/moving/ban） */
  stateType: string;
  /** 显示名称（如"闭关"/"战斗"） */
  displayName: string;
  /** 清理间隔（毫秒），GM 可编辑 */
  intervalMs: number;
  /** 是否启用该状态清理 */
  enable: boolean;
  /** 是否自动结算（如闭关到期自动结算修为） */
  autoSettle: boolean;
  /** 是否自动完成（如历练到期自动发奖） */
  autoComplete: boolean;
  /** 是否记录每次清理日志 */
  logEach: boolean;
  /** 上次清理时间（ISO 字符串，只读） */
  lastCleanedAt: string | null;
}

/** GET /state-cleaner/config 返回的调度器状态 */
export interface StateCleanerConfigData {
  /** 主调度间隔（取所有状态中最小 interval_ms） */
  masterTickMs: number;
  /** 调度器总开关 */
  enabled: boolean;
  /** 单次扫描批量大小 */
  batchSize: number;
  /** 各状态配置详情 */
  states: StateCleanerStateConfig[];
}

/** POST /state-cleaner/config 入参（部分更新，仅传需要修改的字段） */
export interface StateCleanerConfigUpdate {
  /** 调度器总开关（可选） */
  enable?: boolean;
  /** 单次扫描批量大小（1-1000，可选） */
  batch_size?: number;
  /** 各状态配置（可选，key 为状态类型） */
  states?: {
    [stateType: string]: {
      /** 清理间隔（毫秒，1-3600000） */
      interval_ms?: number;
      /** 是否启用该状态清理 */
      enable?: boolean;
      /** 是否自动结算 */
      auto_settle?: boolean;
      /** 是否自动完成 */
      auto_complete?: boolean;
      /** 是否记录每次清理日志 */
      log_each?: boolean;
    };
  };
}

/**
 * 获取状态清理调度器当前配置
 * GET /api/admin/state-cleaner/config
 * 返回主调度间隔、总开关、批量大小、各状态配置详情
 */
export const getStateCleanerConfig = () => {
  return apiClient.get<{ code: number; data: StateCleanerConfigData }>('/admin/state-cleaner/config');
};

/**
 * 更新状态清理调度器配置（热重载，无需重启服务）
 * POST /api/admin/state-cleaner/config
 *
 * 修改后立即调用后端 reloadScheduler() 重启定时器，新间隔即时生效。
 * 所有修改会被记录到 GM 操作日志，原配置会自动备份到 server/config/backup/。
 *
 * @param payload - 配置更新（部分更新，仅传需要修改的字段）
 */
export const updateStateCleanerConfig = (payload: StateCleanerConfigUpdate) => {
  return apiClient.post<{
    code: number;
    message: string;
    data: {
      reloaded: boolean;
      masterTickMs: number;
      changes: string[];
      message: string;
    };
  }>('/admin/state-cleaner/config', payload);
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
