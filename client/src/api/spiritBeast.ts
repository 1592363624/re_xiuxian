/**
 * 灵兽系统 API 客户端
 *
 * 灵兽系统接口封装：
 * 1. 灵兽图鉴：返回所有灵兽种类 + 玩家已捕获标记
 * 2. 我的灵兽：玩家拥有的灵兽列表 + 统计信息
 * 3. 灵兽详情：完整属性、战力、元素相克、冷却剩余
 * 4. 寻觅捕获：按概率捕获灵兽，消耗灵力
 * 5. 喂养：消耗灵石，增加经验/忠诚度，1小时冷却
 * 6. 互动：增加忠诚度+经验，10分钟冷却
 * 7. 设置出战：同时仅 1 只出战
 * 8. 放生：返还部分灵石
 * 9. 今日状态：今日捕获次数/上限/剩余
 *
 * 对应后端路由：/api/spirit-beast/*
 *
 * 业务逻辑全部由后端处理，前端仅做展示与接口调用
 */
import apiClient from './index';

// ==================== 通用类型 ====================

/** 通用业务响应包装 */
export interface ServiceResponse<T> {
  code: number;
  success?: boolean;
  message?: string;
  data: T | null;
  error_code?: string;
}

// ==================== 灵兽图鉴类型 ====================

/** 灵兽种类配置（图鉴项） */
export interface BeastTypeInfo {
  /** 灵兽种类key */
  beast_key: string;
  /** 默认名称 */
  name: string;
  /** 元素属性 key */
  element: string;
  /** 元素中文名 */
  element_name: string;
  /** 元素颜色（用于UI） */
  element_color: string;
  /** 稀有度 key */
  rarity: string;
  /** 稀有度中文名 */
  rarity_name: string;
  /** 稀有度颜色 */
  rarity_color: string;
  /** 基础气血 */
  base_hp: number;
  /** 基础攻击 */
  base_atk: number;
  /** 基础防御 */
  base_def: number;
  /** 基础速度 */
  base_speed: number;
  /** 最低境界rank */
  min_realm_rank: number;
  /** 捕获成功率（小数） */
  catch_chance: number;
  /** 捕获消耗灵力 */
  catch_cost_mp: number;
  /** 喂养获得经验 */
  feed_exp: number;
  /** 描述 */
  description: string;
  /** 是否已捕获 */
  caught: boolean;
  /** 玩家拥有的最高星级记录 */
  my_best: {
    star_level: number;
    level: number;
    is_active: boolean;
  } | null;
}

/** 元素配置 */
export interface ElementInfo {
  key: string;
  name: string;
  strong_against: string;
  weak_against: string;
  color: string;
}

/** 稀有度配置 */
export interface RarityInfo {
  key: string;
  name: string;
  color: string;
}

/** GET /spirit-beast/types 响应数据 */
export interface BeastTypesData {
  beast_types: BeastTypeInfo[];
  elements: ElementInfo[];
  rarity_config: RarityInfo[];
}

// ==================== 灵兽实例类型 ====================

/** 灵兽实例（列表/详情共用） */
export interface SpiritBeastItem {
  /** 灵兽实例ID */
  id: number;
  /** 玩家ID */
  player_id: number;
  /** 灵兽种类key */
  beast_key: string;
  /** 自定义昵称 */
  beast_name: string | null;
  /** 显示名（昵称或默认名） */
  display_name: string;
  /** 默认名 */
  default_name: string;
  /** 元素属性 key */
  element: string;
  /** 元素中文名 */
  element_name: string;
  /** 元素颜色 */
  element_color: string;
  /** 稀有度 key */
  rarity: string;
  /** 稀有度中文名 */
  rarity_name: string;
  /** 稀有度颜色 */
  rarity_color: string;
  /** 星级 */
  star_level: number;
  /** 等级 */
  level: number;
  /** 经验（字符串避免 BigInt 精度问题） */
  exp: string;
  /** 气血上限（字符串） */
  hp_max: string;
  /** 攻击 */
  atk: number;
  /** 防御 */
  def: number;
  /** 速度 */
  speed: number;
  /** 忠诚度（0-100） */
  loyalty: number;
  /** 是否出战中 */
  is_active: boolean;
  /** 最后喂养时间 */
  last_feed_time: string | null;
  /** 最后互动时间 */
  last_interact_time: string | null;
  /** 捕获时间 */
  caught_at: string | null;
  /** 创建时间 */
  created_at: string;
  /** 描述 */
  description: string;
  /** 战力 */
  combat_power: number;
}

/** 灵兽列表统计 */
export interface BeastListStats {
  total: number;
  max: number;
  active_count: number;
  by_rarity: {
    common: number;
    rare: number;
    epic: number;
    legendary: number;
  };
}

/** GET /spirit-beast/list 响应数据 */
export interface BeastListData {
  beasts: SpiritBeastItem[];
  stats: BeastListStats;
}

/** 灵兽详情扩展字段 */
export interface SpiritBeastDetail extends SpiritBeastItem {
  /** 战力 */
  combat_power: number;
  /** 当前等级经验上限 */
  exp_cap: string;
  /** 经验百分比（0-100） */
  exp_percent: number;
  /** 冷却信息 */
  cooldown: {
    /** 喂养冷却剩余秒数 */
    feed_remaining_sec: number;
    /** 互动冷却剩余秒数 */
    interact_remaining_sec: number;
    /** 喂养冷却总秒数 */
    feed_cooldown_sec: number;
    /** 互动冷却总秒数 */
    interact_cooldown_sec: number;
  };
  /** 元素相克关系 */
  element_relations: {
    element: string;
    element_name: string;
    strong_against: { key: string; name: string; multiplier: number };
    weak_against: { key: string; name: string; multiplier: number };
  } | null;
}

// ==================== 操作响应类型 ====================

/** 捕获灵兽响应 */
export interface CatchBeastResult {
  /** 是否捕获成功 */
  caught: boolean;
  /** 灵兽种类key */
  beast_key: string;
  /** 灵兽名 */
  beast_name: string;
  /** 捕获时随机点数（0-1） */
  roll: string;
  /** 捕获成功率 */
  catch_chance: number;
  /** 消耗灵力 */
  cost_mp: string;
  /** 失败返还灵力（成功时无） */
  return_mp?: string;
  /** 灵兽实例ID（成功时返回） */
  beast_id?: number;
  /** 元素属性（成功时返回） */
  element?: string;
  /** 稀有度（成功时返回） */
  rarity?: string;
  /** 今日已捕获次数 */
  today_count: number;
  /** 每日上限 */
  daily_limit: number;
}

/** 喂养/互动响应 */
export interface FeedOrInteractResult {
  /** 灵兽实例ID */
  beast_id: number;
  /** 消耗灵石（仅喂养返回） */
  cost_spirit_stones?: string;
  /** 获得经验 */
  exp_gain: string;
  /** 获得忠诚度 */
  loyalty_gain: number;
  /** 是否升级 */
  level_up: boolean;
  /** 新等级 */
  new_level: number;
  /** 新经验 */
  new_exp: string;
  /** 新忠诚度 */
  new_loyalty: number;
}

/** 设置出战响应 */
export interface SetActiveResult {
  beast_id: number;
  beast_key: string;
  is_active: boolean;
}

/** 放生响应 */
export interface ReleaseResult {
  beast_id: number;
  beast_key: string;
  /** 返还灵石 */
  return_spirit_stones: string;
  /** 玩家新灵石余额 */
  new_spirit_stones: string;
}

/** 今日捕获状态 */
export interface DailyStatusData {
  /** 今日已捕获次数 */
  today_count: number;
  /** 每日上限 */
  daily_limit: number;
  /** 今日剩余次数 */
  remaining: number;
  /** 当前灵兽数量 */
  current_beast_count: number;
  /** 灵兽背包上限 */
  max_beast_count: number;
  /** 重置时间（明日零点 ISO） */
  reset_time: string;
}

// ==================== 灵兽系统玩家接口 ====================

/**
 * 获取所有灵兽种类（图鉴）
 * GET /spirit-beast/types
 */
export const getBeastTypes = () => {
  return apiClient.get<ServiceResponse<BeastTypesData>>('/spirit-beast/types');
};

/**
 * 获取我的灵兽列表
 * GET /spirit-beast/list
 */
export const getMyBeasts = () => {
  return apiClient.get<ServiceResponse<BeastListData>>('/spirit-beast/list');
};

/**
 * 获取灵兽详情
 * GET /spirit-beast/:beastId
 * @param beastId 灵兽实例ID
 */
export const getBeastDetail = (beastId: number) => {
  return apiClient.get<ServiceResponse<SpiritBeastDetail>>(`/spirit-beast/${beastId}`);
};

/**
 * 获取今日捕获状态
 * GET /spirit-beast/daily-status
 */
export const getDailyStatus = () => {
  return apiClient.get<ServiceResponse<DailyStatusData>>('/spirit-beast/daily-status');
};

/**
 * 寻觅/捕获灵兽
 * POST /spirit-beast/catch
 * 按 catch_chance 概率捕获，消耗灵力；失败返还部分灵力
 * @param beastKey 灵兽种类key
 */
export const catchBeast = (beastKey: string) => {
  return apiClient.post<ServiceResponse<CatchBeastResult>>('/spirit-beast/catch', { beast_key: beastKey });
};

/**
 * 喂养灵兽
 * POST /spirit-beast/:beastId/feed
 * 消耗灵石 = level * feed_cost_per_level，增加经验+忠诚度，1小时冷却
 * @param beastId 灵兽实例ID
 */
export const feedBeast = (beastId: number) => {
  return apiClient.post<ServiceResponse<FeedOrInteractResult>>(`/spirit-beast/${beastId}/feed`, {});
};

/**
 * 互动灵兽
 * POST /spirit-beast/:beastId/interact
 * 增加忠诚度+经验，10分钟冷却，无消耗
 * @param beastId 灵兽实例ID
 */
export const interactBeast = (beastId: number) => {
  return apiClient.post<ServiceResponse<FeedOrInteractResult>>(`/spirit-beast/${beastId}/interact`, {});
};

/**
 * 设置出战灵兽
 * POST /spirit-beast/:beastId/set-active
 * 同时仅 1 只灵兽出战
 * @param beastId 灵兽实例ID
 */
export const setActiveBeast = (beastId: number) => {
  return apiClient.post<ServiceResponse<SetActiveResult>>(`/spirit-beast/${beastId}/set-active`, {});
};

/**
 * 放生灵兽
 * POST /spirit-beast/:beastId/release
 * 返还部分灵石（按稀有度比例），删除灵兽记录
 * @param beastId 灵兽实例ID
 */
export const releaseBeast = (beastId: number) => {
  return apiClient.post<ServiceResponse<ReleaseResult>>(`/spirit-beast/${beastId}/release`, {});
};
