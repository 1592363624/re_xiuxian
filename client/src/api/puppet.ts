/**
 * 傀儡工坊系统 API
 *
 * 封装傀儡工坊玩法的接口调用：查看工坊、参悟图谱、制造傀儡、
 * 出战/护法设置、淬炼升级、维修耐久、回收。
 *
 * 设计原则：
 *   - 所有业务逻辑由后端 PuppetService 处理，前端仅做调用与展示
 *   - 禁止直接 axios，统一使用 apiClient（携带 JWT + 统一错误处理）
 *   - BIGINT 灵石字段使用 string 类型，避免 JS Number 精度问题
 *
 * 玩法文档对照：xiuxian_game_guide.md 第23节·大衍诀与傀儡路线
 *
 * 系统定位：
 *   - 大衍诀第三层·控傀解锁，5种傀儡制造/淬炼/维修/回收
 *   - 出战傀儡提供 PVP/PVE 属性加成（30%属性）
 *   - 护法傀儡闭关时自动反击（50%攻击力）
 *   - 图谱来自多人副本（虚天殿/昆吾山/苍坤/世界Boss）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
import apiClient from './index';

// ==================== 类型定义 ====================

/** 傀儡基础属性 */
export interface PuppetBaseStats {
  atk: number;
  def: number;
  hp: number;
  speed: number;
}

/** 制造消耗 */
export interface ManufactureCost {
  spirit_stone: number;
  materials: Record<string, number>;
}

/** 傀儡类型配置 */
export interface PuppetTypeConfig {
  name: string;
  description: string;
  quality: string;
  required_dayan_level: number;
  blueprint_key: string;
  base_stats: PuppetBaseStats;
  manufacture_cost: ManufactureCost;
  color: string;
}

/** 图谱配置 */
export interface BlueprintConfig {
  name: string;
  puppet_type: string;
  source: string;
  description: string;
}

/** 淬炼配置 */
export interface QuenchConfig {
  max_level: number;
  cost_per_level: {
    spirit_stone_base: number;
    spirit_stone_per_level: number;
    mechanism_core: number;
  };
}

/** 维修配置 */
export interface RepairConfig {
  max_durability: number;
  spirit_stone_per_point: number;
}

/** 回收配置 */
export interface RecycleConfig {
  material_return_rate: number;
  spirit_stone_return_rate: number;
}

/** 傀儡工坊完整配置 */
export interface PuppetConfig {
  enabled: boolean;
  min_dayan_level: number;
  max_puppets: number;
  max_battle_puppets: number;
  max_guard_puppets: number;
  battle_stat_ratio: number;
  guard_counter_ratio: number;
  puppet_types: Record<string, PuppetTypeConfig>;
  blueprints: Record<string, BlueprintConfig>;
  quench: QuenchConfig & {
    stat_growth_rate: Record<string, number>;
    durability_cost: number;
    success_rate_base: number;
    success_rate_per_level_decay: number;
    min_success_rate: number;
  };
  repair: RepairConfig & {
    mechanism_core_per_repair: number;
    durability_loss_per_battle_min: number;
    durability_loss_per_battle_max: number;
  };
  recycle: RecycleConfig & { require_confirmation: boolean };
}

/** 玩家持有的傀儡 */
export interface PlayerPuppet {
  id: number;
  puppet_type: string;
  name: string;
  quality: string;
  level: number;
  durability: number;
  max_durability: number;
  atk: number;
  def: number;
  hp: number;
  speed: number;
  status: 'idle' | 'battle' | 'guard';
  description: string;
  color: string;
  created_at: string;
}

/** 已学图谱 */
export interface PlayerBlueprint {
  blueprint_key: string;
  blueprint_name: string;
  puppet_type: string;
  learned_at: string;
  source: string;
}

/** 可制造项 */
export interface ManufacturableItem {
  puppet_type: string;
  name: string;
  quality: string;
  description: string;
  required_dayan_level: number;
  has_blueprint: boolean;
  dayan_met: boolean;
  can_manufacture: boolean;
  manufacture_cost: ManufactureCost;
  base_stats: PuppetBaseStats;
  blueprint_source: string;
}

/** 工坊状态（GET /puppet/workshop 返回） */
export interface PuppetWorkshop {
  enabled: boolean;
  dayan_level: number;
  min_dayan_level: number;
  max_puppets: number;
  puppet_count: number;
  puppets: PlayerPuppet[];
  blueprints: PlayerBlueprint[];
  manufacturable: ManufacturableItem[];
  battle_stat_ratio: number;
  guard_counter_ratio: number;
  quench_config: QuenchConfig;
  repair_config: RepairConfig;
  recycle_config: RecycleConfig;
}

/** 制造结果 */
export interface ManufactureResult {
  puppet_id: number;
  puppet_type: string;
  name: string;
  level: number;
  atk: number;
  def: number;
  hp: number;
  speed: number;
  durability: number;
  spirit_stones_after: string;
}

/** 淬炼结果 */
export interface QuenchResult {
  puppet_id: number;
  quench_success: boolean;
  success_rate: number;
  level: number;
  atk: number;
  def: number;
  hp: number;
  speed: number;
  durability: number;
  spirit_stones_after: string;
}

/** 维修结果 */
export interface RepairResult {
  puppet_id: number;
  durability: number;
  max_durability: number;
  repaired_points: number;
  cost_spirit_stones: string;
  spirit_stones_after: string;
}

/** 回收预览结果 */
export interface RecyclePreviewResult {
  puppet_id: number;
  puppet_name: string;
  puppet_type: string;
  level: number;
  material_returns: Record<string, number>;
  spirit_stone_return: number;
  material_return_rate: number;
  spirit_stone_return_rate: number;
  require_confirmation: boolean;
}

/** 回收结果 */
export interface RecycleResult {
  puppet_id: number;
  material_returns: Record<string, number>;
  spirit_stone_return: string;
  spirit_stones_after: string;
}

/** 出战/护法设置结果 */
export interface SetRoleResult {
  puppet_id: number;
  name: string;
  role: 'battle' | 'guard';
  atk: number;
  def: number;
  hp: number;
  speed: number;
}

// ==================== API 函数 ====================

/** 获取傀儡工坊配置（无需鉴权） */
export const getConfig = () => {
  return apiClient.get<PuppetConfig>('/puppet/config');
};

/** 查看傀儡工坊（需鉴权） */
export const getWorkshop = () => {
  return apiClient.get<PuppetWorkshop>('/puppet/workshop');
};

/** 参悟图谱（需鉴权） */
export const learnBlueprint = (blueprintKey: string) => {
  return apiClient.post<{ code: number; message: string; data: any }>('/puppet/blueprint/learn', { blueprint_key: blueprintKey });
};

/** 制造傀儡（需鉴权） */
export const manufacture = (puppetType: string) => {
  return apiClient.post<{ code: number; message: string; data: ManufactureResult }>('/puppet/manufacture', { puppet_type: puppetType });
};

/** 设置出战（需鉴权） */
export const setBattle = (puppetId: number) => {
  return apiClient.post<{ code: number; message: string; data: SetRoleResult }>(`/puppet/${puppetId}/battle`);
};

/** 设置护法（需鉴权） */
export const setGuard = (puppetId: number) => {
  return apiClient.post<{ code: number; message: string; data: SetRoleResult }>(`/puppet/${puppetId}/guard`);
};

/** 取消出战/护法（需鉴权） */
export const unsetRole = (puppetId: number) => {
  return apiClient.post<{ code: number; message: string; data: any }>(`/puppet/${puppetId}/unset`);
};

/** 淬炼升级（需鉴权） */
export const quench = (puppetId: number) => {
  return apiClient.post<{ code: number; message: string; data: QuenchResult }>(`/puppet/${puppetId}/quench`);
};

/** 维修耐久（需鉴权） */
export const repair = (puppetId: number) => {
  return apiClient.post<{ code: number; message: string; data: RepairResult }>(`/puppet/${puppetId}/repair`);
};

/** 回收预览（需鉴权） */
export const recyclePreview = (puppetId: number) => {
  return apiClient.get<RecyclePreviewResult>(`/puppet/${puppetId}/recycle-preview`);
};

/** 确认回收（需鉴权） */
export const recycle = (puppetId: number) => {
  return apiClient.post<{ code: number; message: string; data: RecycleResult }>(`/puppet/${puppetId}/recycle`);
};
