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
  /** 通信协议（现恒为 openai；字段仅为兼容历史数据保留） */
  protocol: 'openai';
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
 *
 * 该接口要等后端去请求第三方大模型，耗时可能远超默认 30s 超时。
 * 这里单独放宽到 120s（后端自身会在 90s 内返回并说明具体失败原因），
 * 否则前端会先超时，用户只能看到"请求超时"，拿不到后端的详细诊断信息。
 */
export const testAiConfig = (id: number) => {
  return apiClient.post(`/admin/ai-config/${id}/test`, null, { timeout: 120000 });
};

/**
 * 测试"未保存"的表单配置（编辑/新增弹窗保存前即可验证连接）
 *
 * 与 testAiConfig 一样放宽到 120s；api_key 留空且传 config_id 时，
 * 后端会复用该条已保存配置的 Key（编辑时不想重输 Key 的场景）
 */
export const testAiConfigPayload = (data: {
  base_url: string;
  model: string;
  api_key?: string;
  timeout?: number;
  /** 编辑已有配置时传入，api_key 留空则复用该配置已保存的 Key */
  config_id?: number;
}) => {
  return apiClient.post('/admin/ai-config/test', data, { timeout: 120000 });
};
