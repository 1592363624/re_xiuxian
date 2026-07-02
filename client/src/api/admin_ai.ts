/**
 * AI 配置管理 API（GM 后台）
 * 封装 AI 配置的增删改查、激活、测试连接等接口
 * 所有接口需要 admin 权限
 */
import apiClient from './index';

/** AI 配置项（API Key 已脱敏） */
export interface AiConfigItem {
  id: number;
  provider: string;
  display_name: string;
  base_url: string;
  model: string;
  /** 脱敏后的 API Key（仅显示后4位） */
  api_key_masked: string;
  /** 是否已配置 Key */
  has_api_key: boolean;
  protocol: 'openai' | 'anthropic';
  temperature: number;
  max_tokens: number;
  timeout: number;
  is_active: boolean;
  last_tested_at: string | null;
  last_test_status: 'success' | 'failed' | null;
  last_test_message: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 可选提供商（从 ai_config.json 读取） */
export interface AiProviderOption {
  provider: string;
  name: string;
  models: string[];
  default_endpoint: string;
  compatible_with: string;
  description: string;
}

/** 测试连接结果 */
export interface AiTestResult {
  status: 'success' | 'failed';
  message: string;
  tested_at: string;
}

/**
 * 获取所有 AI 配置列表
 */
export const getAiConfigs = () => {
  return apiClient.get('/admin/ai-config');
};

/**
 * 获取可选提供商列表
 */
export const getAiProviders = () => {
  return apiClient.get('/admin/ai-config/providers');
};

/**
 * 新增 AI 配置
 */
export const createAiConfig = (data: {
  provider: string;
  display_name: string;
  base_url: string;
  model: string;
  api_key?: string;
  protocol?: string;
  temperature?: number;
  max_tokens?: number;
  timeout?: number;
  is_active?: boolean;
}) => {
  return apiClient.post('/admin/ai-config', data);
};

/**
 * 更新 AI 配置（支持部分更新）
 */
export const updateAiConfig = (id: number, data: {
  display_name?: string;
  base_url?: string;
  model?: string;
  api_key?: string;
  protocol?: string;
  temperature?: number;
  max_tokens?: number;
  timeout?: number;
}) => {
  return apiClient.put(`/admin/ai-config/${id}`, data);
};

/**
 * 删除 AI 配置
 */
export const deleteAiConfig = (id: number) => {
  return apiClient.delete(`/admin/ai-config/${id}`);
};

/**
 * 激活指定 AI 配置（其他自动停用）
 */
export const activateAiConfig = (id: number) => {
  return apiClient.post(`/admin/ai-config/${id}/activate`);
};

/**
 * 测试 AI 配置连接性
 */
export const testAiConfig = (id: number) => {
  return apiClient.post(`/admin/ai-config/${id}/test`);
};
