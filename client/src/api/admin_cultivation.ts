/**
 * 修炼配置管理 API（GM 后台）
 * 封装闭关（常规/深度）与历练（时长分级）配置的查询、更新接口
 * 所有接口均需 admin 权限（后端 auth + adminCheck 双层校验）
 *
 * 修改后自动写回 JSON 配置文件并触发热更新，无需重启服务
 */
import apiClient from './index';

/** 常规闭关配置 */
export interface NormalSeclusionConfig {
  /** 单次最长时长（秒） */
  max_duration: number;
  /** 每日次数上限 */
  daily_limit: number;
  /** 冷却时间（秒） */
  cooldown: number;
  /** 收益倍率 */
  exp_rate: number;
}

/** 深度闭关配置 */
export interface DeepSeclusionConfig {
  /** 最短时长（秒，未达此时长提前结束按强行出关处理） */
  min_duration: number;
  /** 最长时长（秒） */
  max_duration: number;
  /** 每日次数上限 */
  daily_limit: number;
  /** 冷却时间（秒） */
  cooldown: number;
  /** 收益倍率（如 2 表示 2 倍收益） */
  exp_rate: number;
  /** 境界要求（如 "筑基期"） */
  min_realm: string;
  /** 强行出关损失比例（0-1，如 0.5 表示损失 50%） */
  forced_penalty: number;
}

/** 闭关整体配置 */
export interface SeclusionConfig {
  /** 闭关基础修为速率（每秒） */
  base_exp_rate: number;
  /** 常规闭关配置 */
  normal: NormalSeclusionConfig;
  /** 深度闭关配置 */
  deep: DeepSeclusionConfig;
}

/** 单档时长配置 */
export interface DurationTypeConfig {
  /** 时长（秒） */
  duration: number;
  /** 奖励倍率 */
  reward_multiplier: number;
  /** 受伤概率（0-1） */
  injury_chance: number;
  /** 受伤时气血损失比例（0-1） */
  injury_hp_loss_rate: number;
  /** 显示标签 */
  label: string;
}

/** 历练整体配置 */
export interface AdventureConfig {
  /** 时长分级配置（short/medium/long） */
  duration_types: {
    short: DurationTypeConfig;
    medium: DurationTypeConfig;
    long: DurationTypeConfig;
  };
  /** 默认时长类型 */
  default_duration_type: 'short' | 'medium' | 'long';
  /** 提前结束惩罚比例（0-1，如 0.5 表示再扣 50%） */
  early_finish_penalty: number;
}

/** 修炼整体配置（GET 接口返回） */
export interface CultivationConfig {
  seclusion: SeclusionConfig;
  adventure: AdventureConfig;
}

/**
 * 获取修炼配置（闭关双模式 + 历练时长分级）
 * GET /api/admin/cultivation/config
 */
export const getCultivationConfig = () => {
  return apiClient.get('/admin/cultivation/config');
};

/**
 * 更新闭关配置（双模式整体替换）
 * POST /api/admin/cultivation/seclusion
 *
 * @param data 闭关配置参数（任意字段可选，仅更新提供的字段）
 */
export const updateSeclusionConfig = (data: {
  normal?: Partial<NormalSeclusionConfig>;
  deep?: Partial<DeepSeclusionConfig>;
  base_exp_rate?: number;
}) => {
  return apiClient.post('/admin/cultivation/seclusion', data);
};

/**
 * 更新历练配置（时长分级整体替换）
 * POST /api/admin/cultivation/adventure
 *
 * @param data 历练配置参数（任意字段可选，仅更新提供的字段）
 */
export const updateAdventureConfig = (data: {
  duration_types?: Partial<AdventureConfig['duration_types']>;
  default_duration_type?: AdventureConfig['default_duration_type'];
  early_finish_penalty?: number;
}) => {
  return apiClient.post('/admin/cultivation/adventure', data);
};

/** 历史备份版本项 */
export interface BackupVersion {
  /** 备份文件名（含 .json 后缀） */
  filename: string;
  /** 配置类型 seclusion | game_balance */
  configType: 'seclusion' | 'game_balance';
  /** 中文友好名称 */
  configLabel: string;
  /** 文件字节数 */
  size: number;
  /** 文件大小（人类可读） */
  sizeText: string;
  /** 修改时间 ISO 字符串 */
  mtime: string;
  /** 修改时间戳（毫秒） */
  mtimeMs: number;
}

/**
 * 获取配置历史版本列表
 * GET /api/admin/cultivation/backups
 *
 * @param type 可选，按配置类型筛选 'seclusion' | 'game_balance'
 */
export const getBackupVersions = (type?: 'seclusion' | 'game_balance') => {
  const params = type ? { type } : {};
  return apiClient.get('/admin/cultivation/backups', { params });
};

/**
 * 一键回滚到指定历史版本
 * POST /api/admin/cultivation/rollback
 *
 * 安全设计：回滚前会自动备份当前版本，形成回滚链，避免误操作不可逆
 *
 * @param filename 备份文件名（不含路径）
 */
export const rollbackConfig = (filename: string) => {
  return apiClient.post('/admin/cultivation/rollback', { filename });
};
