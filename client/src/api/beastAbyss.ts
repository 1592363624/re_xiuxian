/**
 * 灵兽探渊系统 API 客户端
 *
 * 统一封装灵兽探渊系统的 8 个接口（路由前缀：/api/spirit-beast/abyss）：
 *   1. GET  /floors      - 获取可用深渊层数列表（按玩家境界过滤）
 *   2. POST /start       - 开始探渊（指定灵兽 + 时长）
 *   3. POST /recall      - 召回灵兽（提前召回 / 到期自动结算）
 *   4. GET  /status      - 获取当前探渊状态（进行中列表 + 今日次数）
 *   5. GET  /history     - 获取探渊历史（分页）
 *   6. GET  /encounters  - 获取指定探渊的遭遇详情
 *   7. GET  /ranking     - 获取探渊排行榜（3 个子分类）
 *   8. GET  /config      - 获取探渊配置（深渊层数/时长/体力/事件类型等）
 *
 * 重要说明：
 *   - 后端统一返回 { code, success?, message, data, error_code? } 包装结构
 *   - 业务失败时 code=200 但 success=false，由前端组件按 message 提示
 *   - 所有方法返回 axios response，调用方通过 resp.data 取业务数据
 *   - 请求体字段一律使用 snake_case，与后端路由保持一致
 *
 * 对应后端路由文件：server/routes/spirit_beast_abyss.js（如有差异以后端为准）
 */
import apiClient from './index';

// ==================== 通用类型 ====================

/** 通用业务响应包装 */
export interface ServiceResponse<T> {
  /** HTTP 业务码（200=正常） */
  code: number;
  /** 业务是否成功（部分接口返回） */
  success?: boolean;
  /** 业务消息（成功/失败描述） */
  message?: string;
  /** 业务数据 */
  data: T | null;
  /** 业务错误码（失败时返回） */
  error_code?: string;
}

// ==================== 基础枚举类型 ====================

/** 排行榜分类 */
export type AbyssRankingCategory =
  | 'deepest_floor'       // 最深层数
  | 'total_explore_count' // 累计探渊次数
  | 'total_pvp_wins';     // 累计 PVP 胜利

/** 召回类型（提前召回 / 到期自动结算） */
export type AbyssRecallType = 'early' | 'expired';

/** 探渊结局（成功归来 / 中途陨落 / 提前召回） */
export type AbyssExploreOutcome = 'success' | 'dead' | 'recalled';

// ==================== 各接口请求/响应数据类型 ====================

/** GET /floors 响应数据 - 可用深渊层数列表 */
export interface AbyssFloorsData {
  /** 可用层数列表（按层数升序，已按玩家境界过滤） */
  floors: Array<{
    /** 层数（1-based） */
    floor: number;
    /** 层数名称（如：第一层·幽冥谷） */
    name: string;
    /** 最低境界等级数值（用于过滤） */
    min_realm_rank: number;
    /** 最低境界中文名（如：筑基初期） */
    min_realm_name: string;
    /** 层数描述（含特色与风险提示，后端字段名为 description） */
    description: string;
    /** 该层数单次探渊消耗体力 */
    stamina_cost: number;
    /** 怪物难度系数（用于战斗计算） */
    monster_difficulty: number;
  }>;
  /** 同时可派出的最大灵兽数量 */
  max_concurrent_beasts: number;
  /** 单次探渊最短时长（小时） */
  min_duration_hours: number;
  /** 单次探渊最长时长（小时） */
  max_duration_hours: number;
  /** 每日探渊次数上限 */
  daily_explore_limit: number;
  /** 今日剩余探渊次数 */
  daily_remaining: number;
}

/** POST /start 请求体 - 开始探渊 */
export interface AbyssStartRequest {
  /** 灵兽 ID（玩家拥有的灵兽实例 ID） */
  beast_id: number;
  /** 探渊时长（小时，需在 min_duration_hours ~ max_duration_hours 之间） */
  duration_hours: number;
}

/** POST /start 响应数据 - 开始探渊结果 */
export interface AbyssStartResult {
  /** 探渊记录 ID */
  explore_id: number;
  /** 灵兽 ID */
  beast_id: number;
  /** 灵兽名称 */
  beast_name: string;
  /** 探渊层数 */
  floor: number;
  /** 探渊时长（小时） */
  duration_hours: number;
  /** 体力消耗 */
  stamina_cost: number;
  /** 结束时间（ISO 字符串） */
  end_time: string;
  /** 结果描述 */
  message: string;
}

/** POST /recall 请求体 - 召回灵兽 */
export interface AbyssRecallRequest {
  /** 灵兽 ID（玩家拥有的灵兽实例 ID） */
  beast_id: number;
}

/** POST /recall 响应数据 - 召回灵兽结果 */
export interface AbyssRecallResult {
  /** 探渊记录 ID */
  explore_id: number;
  /** 灵兽 ID */
  beast_id: number;
  /** 召回类型：early=提前召回 / expired=到期结算 */
  recall_type: AbyssRecallType;
  /** 奖励汇总（灵石/经验/物品等） */
  rewards: {
    /** 灵石奖励 */
    spirit_stones?: number;
    /** 经验奖励 */
    exp?: number;
    /** 物品奖励列表 */
    items?: Array<{ item_key: string; name: string; amount: number }>;
    /** PVP 胜利次数 */
    pvp_wins?: number;
    /** 击败怪物次数 */
    monster_kills?: number;
  };
  /** 结果描述 */
  message: string;
}

/** GET /status 响应数据 - 当前探渊状态 */
export interface AbyssStatusData {
  /** 进行中的探渊列表 */
  active_explores: Array<{
    /** 探渊记录 ID */
    explore_id: number;
    /** 灵兽 ID */
    beast_id: number;
    /** 灵兽名称 */
    beast_name: string;
    /** 探渊层数 */
    floor: number;
    /** 开始时间（ISO 字符串） */
    start_time: string;
    /** 结束时间（ISO 字符串） */
    end_time: string;
    /** 剩余秒数（<0 表示已到期未召回） */
    remaining_seconds: number;
    /** 是否已到期（true 表示可以召回结算） */
    is_expired: boolean;
  }>;
  /** 今日已探渊次数 */
  daily_explores_today: number;
  /** 每日探渊次数上限 */
  daily_limit: number;
}

/** GET /history 响应数据 - 探渊历史（分页） */
export interface AbyssHistoryData {
  /** 历史记录列表（后端字段名为 history） */
  history: Array<{
    /** 探渊记录 ID */
    explore_id: number;
    /** 灵兽 ID */
    beast_id: number;
    /** 起始层数 */
    start_floor: number;
    /** 最深到达层数 */
    max_floor_reached: number;
    /** 探渊时长（小时） */
    duration_hours: number;
    /** 开始时间（ISO 字符串） */
    start_time: string;
    /** 计划结束时间（ISO 字符串） */
    end_time: string;
    /** 实际结束时间（ISO 字符串） */
    actual_end_time?: string;
    /** 探渊状态：active=进行中 / settled=已结算 / recalled=已召回 */
    status: string;
    /** 召回类型：early=提前召回 / auto=到期自动结算 / manual=手动结算 */
    recall_type?: string;
    /** PVP 遭遇次数 */
    pvp_encounters: number;
    /** PVP 胜利次数 */
    pvp_wins: number;
    /** PVP 失败次数 */
    pvp_losses: number;
    /** 怪物击杀数 */
    monster_kills: number;
    /** 宝箱发现数 */
    treasures_found: number;
    /** 陷阱触发数 */
    traps_triggered: number;
    /** 体力消耗 */
    stamina_used: number;
    /** 灵兽之魂获得 */
    beast_soul_gained: number;
    /** 奖励快照（后端原始 JSON） */
    rewards: Record<string, any>;
  }>;
  /** 总记录数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页大小 */
  page_size: number;
}

/** GET /encounters 响应数据 - 遭遇详情 */
export interface AbyssEncountersData {
  /** 遭遇列表（按回合顺序） */
  encounters: Array<{
    /** 回合数（1-based） */
    round: number;
    /** 遭遇类型：monster=怪物 / pvp=玩家 / event=随机事件 / treasure=宝箱 / trap=陷阱 */
    encounter_type: string;
    /** 遭遇描述 */
    description: string;
    /** 结果描述（胜/负/触发效果） */
    result: string;
    /** HP 变化（负数表示掉血） */
    hp_change: number;
    /** 经验变化 */
    exp_change: number;
    /** 物品奖励列表 */
    items?: Array<{ item_key: string; name: string; amount: number }>;
    /** 灵石奖励 */
    spirit_stones?: number;
    /** PVP 对手信息（仅 pvp 类型存在） */
    pvp_opponent?: {
      player_id: number;
      nickname: string;
      realm: string;
    } | null;
  }>;
}

/** GET /ranking 响应数据 - 排行榜 */
export interface AbyssRankingData {
  /** 当前排行榜分类 */
  category: AbyssRankingCategory;
  /** 排行列表（按名次升序，后端字段名为 ranking） */
  ranking: Array<{
    /** 名次（1-based） */
    rank: number;
    /** 玩家 ID */
    player_id: number;
    /** 玩家昵称 */
    nickname: string;
    /** 玩家境界 */
    realm: string;
    /** 排行数值（层数 / 次数 / 胜场，按 category 不同字段名不同） */
    value?: number;
    /** 最深层数（deepest_floor 类别返回） */
    max_floor_reached?: number;
    /** 探渊时长（deepest_floor 类别返回） */
    duration_hours?: number;
    /** 怪物击杀数（deepest_floor 类别返回） */
    monster_kills?: number;
    /** PVP 胜利数（deepest_floor/total_pvp_wins 类别返回） */
    pvp_wins?: number;
    /** 探渊次数（total_explore_count 类别返回） */
    explore_count?: number;
    /** PVP 遭遇次数（total_pvp_wins 类别返回） */
    total_encounters?: number;
  }>;
  /** 总记录数（仅 deepest_floor 类别返回） */
  total?: number;
  /** 当前页码 */
  page: number;
  /** 每页大小 */
  page_size: number;
}

/** GET /config 响应数据 - 探渊配置 */
export interface AbyssConfigData {
  /** 深渊核心配置 */
  abyss: {
    /** 总层数 */
    total_floors: number;
    /** 单次最短时长（小时） */
    min_duration_hours: number;
    /** 单次最长时长（小时） */
    max_duration_hours: number;
    /** 同时可派出的最大灵兽数量 */
    max_concurrent_beasts: number;
    /** 每次探渊消耗体力 */
    stamina_per_explore: number;
    /** 灵兽体力上限 */
    stamina_max: number;
    /** 体力每小时恢复速度 */
    stamina_recover_per_hour: number;
    /** 每日探渊次数上限 */
    daily_explore_limit: number;
    /** 灵兽 HP 伤势恢复小时数（受伤后需休养） */
    beast_hp_injury_recover_hours: number;
    /** PVP 遭遇基础概率（0-1） */
    pvp_encounter_base_rate: number;
    /** PVP 胜者掠夺败者奖励的比例（0-1） */
    pvp_winner_loot_ratio: number;
  };
  /** 事件类型映射（后端按 event_key 作为对象 key 返回，含 name/weight/description） */
  event_types: Record<string, {
    /** 事件类型中文名 */
    name: string;
    /** 事件权重（用于概率计算） */
    weight: number;
    /** 事件描述 */
    description: string;
  }>;
  /** 灵兽之魂配置（探渊积分/兑换等） */
  beast_soul_config: {
    /** 灵兽之魂名称 */
    name: string;
    /** 兑换比率说明 */
    description: string;
  };
  /** 召回配置 */
  recall_config: {
    /** 提前召回奖励比例（0-1，会按剩余时间折算） */
    early_recall_reward_ratio: number;
    /** 提前召回是否扣除忠诚度 */
    early_recall_loyalty_penalty: boolean;
  };
}

// ==================== 玩家接口（8 个，全部 /spirit-beast/abyss 下） ====================

/**
 * 获取可用深渊层数列表
 * GET /spirit-beast/abyss/floors
 * 按玩家当前境界过滤可用层数，同时返回探渊时长范围/次数限制等参数
 */
export const beastAbyssGetFloors = () => {
  return apiClient.get<ServiceResponse<AbyssFloorsData>>('/spirit-beast/abyss/floors');
};

/**
 * 开始探渊
 * POST /spirit-beast/abyss/start
 * @param beastId 灵兽 ID（玩家拥有的灵兽实例 ID）
 * @param durationHours 探渊时长（小时，需在 min_duration_hours ~ max_duration_hours 之间）
 */
export const beastAbyssStart = (beastId: number, durationHours: number) => {
  return apiClient.post<ServiceResponse<AbyssStartResult>>('/spirit-beast/abyss/start', {
    beast_id: beastId,
    duration_hours: durationHours
  } as AbyssStartRequest);
};

/**
 * 召回灵兽
 * POST /spirit-beast/abyss/recall
 * 灵兽到期自动结算前，玩家可提前召回；已到期则结算奖励
 * @param beastId 灵兽 ID
 */
export const beastAbyssRecall = (beastId: number) => {
  return apiClient.post<ServiceResponse<AbyssRecallResult>>('/spirit-beast/abyss/recall', {
    beast_id: beastId
  } as AbyssRecallRequest);
};

/**
 * 获取当前探渊状态
 * GET /spirit-beast/abyss/status
 * 含进行中探渊列表 + 今日探渊次数
 */
export const beastAbyssGetStatus = () => {
  return apiClient.get<ServiceResponse<AbyssStatusData>>('/spirit-beast/abyss/status');
};

/**
 * 获取探渊历史
 * GET /spirit-beast/abyss/history
 * @param page 页码（默认 1）
 * @param pageSize 每页数量（默认 10）
 */
export const beastAbyssGetHistory = (page: number = 1, pageSize: number = 10) => {
  return apiClient.get<ServiceResponse<AbyssHistoryData>>('/spirit-beast/abyss/history', {
    params: { page, page_size: pageSize }
  });
};

/**
 * 获取指定探渊的遭遇详情
 * GET /spirit-beast/abyss/encounters
 * @param exploreId 探渊记录 ID
 */
export const beastAbyssGetEncounters = (exploreId: number) => {
  return apiClient.get<ServiceResponse<AbyssEncountersData>>('/spirit-beast/abyss/encounters', {
    params: { explore_id: exploreId }
  });
};

/**
 * 获取探渊排行榜
 * GET /spirit-beast/abyss/ranking
 * @param category 分类：deepest_floor=最深层数 / total_explore_count=累计探渊次数 / total_pvp_wins=累计PVP胜利
 * @param page 页码（默认 1）
 * @param pageSize 每页数量（默认 20）
 */
export const beastAbyssGetRanking = (
  category: AbyssRankingCategory = 'deepest_floor',
  page: number = 1,
  pageSize: number = 20
) => {
  return apiClient.get<ServiceResponse<AbyssRankingData>>('/spirit-beast/abyss/ranking', {
    params: { category, page, page_size: pageSize }
  });
};

/**
 * 获取探渊配置
 * GET /spirit-beast/abyss/config
 * 含深渊核心配置 / 事件类型 / 灵兽之魂配置 / 召回配置
 */
export const beastAbyssGetConfig = () => {
  return apiClient.get<ServiceResponse<AbyssConfigData>>('/spirit-beast/abyss/config');
};
