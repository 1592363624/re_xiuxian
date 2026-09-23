/**
 * 玩家个人 AI 配置 API
 *
 * 封装游戏设置里的"AI 配置"功能接口：
 * 玩家可填写自己的 OpenAI 兼容接口（Base URL / 模型 / API Key），
 * 启用后 AI 相关调用（历练事件、副本剧情等）优先走自己的接口与额度。
 * 所有接口需登录，只能操作自己的配置。
 */
import apiClient from './index';

/** 玩家个人 AI 配置（API Key 已脱敏） */
export interface UserAiConfigItem {
  base_url: string;
  model: string;
  /** 脱敏后的 API Key（仅显示后4位） */
  api_key_masked: string;
  /** 是否已配置 Key */
  has_api_key: boolean;
  temperature: number | null;
  max_tokens: number | null;
  timeout: number | null;
  /** 是否启用个人配置（关闭后 AI 调用回落服务器公共配置） */
  enabled: boolean;
  updatedAt: string;
}

/** 获取个人 AI 配置的响应数据 */
export interface UserAiConfigResponse {
  /** 服务器是否开放了自定义 AI 功能（false 时前端隐藏编辑入口） */
  feature_enabled: boolean;
  /** 当前配置；从未配置过时为 null */
  config: UserAiConfigItem | null;
}

/** 连接测试结果（失败时 message/detail 含详细原因） */
export interface UserAiTestResult {
  status: 'success' | 'failed';
  message: string;
  detail?: string;
  http_status: number | null;
  tested_at: string;
}

/**
 * 获取当前玩家的个人 AI 配置
 */
export const getUserAiConfig = () => {
  return apiClient.get('/user/ai-config');
};

/**
 * 保存/更新当前玩家的个人 AI 配置（首次保存必须填 api_key）
 * api_key 留空表示保留旧 Key
 */
export const saveUserAiConfig = (data: {
  base_url: string;
  model: string;
  api_key?: string;
  temperature?: number | null;
  max_tokens?: number | null;
  timeout?: number | null;
  enabled?: boolean;
}) => {
  return apiClient.put('/user/ai-config', data);
};

/**
 * 删除当前玩家的个人 AI 配置（回到使用服务器公共配置）
 */
export const deleteUserAiConfig = () => {
  return apiClient.delete('/user/ai-config');
};

/**
 * 测试 AI 连接（保存前即可测试）
 *
 * 表单里没填的字段后端会自动用已保存的值补齐 —— 编辑已保存配置时
 * 不用重新输入 Key 也能测试新改的 URL / 模型。
 * 该接口要等后端请求第三方大模型，放宽到 120s（默认 30s 会先超时）。
 */
export const testUserAiConfig = (data: {
  base_url?: string;
  model?: string;
  api_key?: string;
  timeout?: number;
} = {}) => {
  return apiClient.post('/user/ai-config/test', data, { timeout: 120000 });
};
