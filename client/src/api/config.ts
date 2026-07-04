/**
 * 公开游戏配置 API
 *
 * 提供"玩家可见"的游戏配置（如历练时长、闭关参数、技能消耗等）。
 * 接口来源：GET /api/config/game-balance/public（无需鉴权）。
 *
 * 设计目的：
 *   遵循"配置驱动、禁止硬编码"原则，前端面板不再硬编码时长/倍率/概率等数值，
 *   统一通过本接口从后端拉取，确保前后端数据一致。
 */
import apiClient from './index';

/** 单档历练时长配置 */
export interface DurationTypeConfig {
  /** 时长（秒） */
  duration: number;
  /** 奖励倍率 */
  reward_multiplier: number;
  /** 受伤概率（0-1） */
  injury_chance: number;
  /** 受伤时气血损失比例（0-1） */
  injury_hp_loss_rate: number;
  /** 显示名称（如"短时历练"） */
  label: string;
}

/** 历练时长分级配置 */
export interface AdventureConfig {
  duration_types: {
    short: DurationTypeConfig;
    medium: DurationTypeConfig;
    long: DurationTypeConfig;
  };
  /** 默认时长类型 */
  default_duration_type: 'short' | 'medium' | 'long';
  /** 提前结束惩罚比例（0-1） */
  early_finish_penalty: number;
}

/** 闭关模式配置 */
export interface SeclusionModeConfig {
  max_duration?: number;
  min_duration?: number;
  daily_limit: number;
  cooldown: number;
  exp_rate: number;
  min_realm?: string;
  forced_penalty?: number;
}

/** 闭关配置 */
export interface SeclusionConfig {
  base_exp_rate: number;
  normal: SeclusionModeConfig | null;
  deep: SeclusionModeConfig | null;
}

/** 战斗可见配置 */
export interface CombatPublicConfig {
  skill_mp_cost: number;
}

/** 装备槽位配置（与后端 game_balance.equipment 对应） */
export interface EquipmentConfig {
  /** 有效槽位顺序（如 ['weapon','armor','accessory','boots','dharma']） */
  valid_slots: string[];
  /** 槽位中文名映射（如 { weapon: '武器', armor: '护甲' }） */
  slot_names: Record<string, string>;
}

/** 背包分类 tab 项 */
export interface ItemCategory {
  key: string;
  label: string;
}

/** 背包相关配置 */
export interface InventoryConfig {
  /** 使用物品单次最大数量 */
  max_use_quantity: number;
}

/** 公开游戏配置完整结构 */
export interface GameBalancePublicConfig {
  adventure: AdventureConfig | null;
  seclusion: SeclusionConfig;
  combat: CombatPublicConfig;
  /** 装备槽位配置 */
  equipment: EquipmentConfig;
  /** 物品类型中文名映射（consumable→丹药 等） */
  item_types: Record<string, string>;
  /** 背包分类 tabs */
  item_categories: ItemCategory[];
  /** 地图类型中文名映射 */
  map_types: Record<string, string>;
  /** 地图危险等级中文名映射（key 为数字字符串） */
  safety_levels: Record<string, string>;
  /** 背包相关配置 */
  inventory: InventoryConfig;
}

/**
 * 获取玩家可见的游戏平衡配置
 * GET /api/config/game-balance/public
 *
 * 返回历练时长分级、闭关参数、技能消耗等玩家面板需要的配置数值。
 * 该接口公开无需鉴权，但仅返回玩家可见的配置段，不暴露内部调度参数。
 */
export const getGameBalancePublic = () => {
  return apiClient.get<{ code: number; data: GameBalancePublicConfig }>('/config/game-balance/public');
};
