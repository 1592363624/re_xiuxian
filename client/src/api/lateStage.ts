/**
 * 批次3 后期系统 API 客户端
 *
 * 统一封装批次3 后期系统 6 大子系统的接口：
 *   1. 第二元神（/api/second-soul）：凝练 / 分化 / 调度 / 独立修炼 / 面板
 *   2. 小世界（/api/small-world）：开辟 / 显灵 / 神迹干预 / 面板
 *   3. 神庙（/api/divine-temple）：升级 / 修复禁制 / 兑换供奉 / 面板
 *   4. 香火（/api/incense）：收割 / 流水分页
 *   5. 神识（/api/divine-sense）：淬炼 / 面板
 *   6. 法则（/api/law）：神识/碎片转法则点 / 法则转换 / 面板
 *
 * GM 后台接口（/api/admin/late-stage）：
 *   - 调整副元神属性 / 重置小世界 / 调整小世界&神庙等级
 *   - 发放/扣减 香火 / 神识 / 法则点 / 法则碎片
 *
 * 重要说明：
 *   - 后端统一返回 { code, success?, message, data, error_code? } 包装结构
 *   - 业务失败时 code=200 但 success=false，由前端组件按 message 提示
 *   - 所有方法返回 axios response，调用方通过 resp.data 取业务数据
 *   - 请求体字段一律使用 snake_case，与后端路由保持一致
 *
 * 对应后端路由文件：
 *   - server/routes/second-soul.js
 *   - server/routes/small-world.js
 *   - server/routes/divine-temple.js
 *   - server/routes/incense.js
 *   - server/routes/divine-sense.js
 *   - server/routes/law.js
 *   - server/routes/admin_late_stage.js
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

// ==================== 第二元神相关类型 ====================

/** 副元神记录（PlayerSecondSoul 行） */
export interface SecondSoul {
  id: number;
  /** 1=主元神 2=第二元神 3=第三元神 */
  soul_index: number;
  soul_name: string;
  soul_type: string;
  realm: string;
  realm_rank: number;
  /** 修为字符串（BigInt 序列化） */
  exp: string;
  /** 属性对象：atk/def/hp_max/speed/sense 等 */
  attributes: {
    atk?: number;
    def?: number;
    hp_max?: number;
    speed?: number;
    sense?: number;
    [key: string]: number | undefined;
  };
  inherit_ratio: number;
  is_active: number;
  is_cultivating: number;
  cultivate_started_at: string | null;
  cultivate_end_time: string | null;
  /** 上次调度模式：combat/cultivate/scout/defend */
  last_dispatch_mode: string | null;
  dispatch_until: string | null;
  combat_count: number;
  cultivate_count: number;
}

/** 元神残篇收集进度项 */
export interface SoulFragmentProgress {
  /** 残篇名称 */
  name: string;
  /** 获取途径说明 */
  source: string;
  /** 已收集数量 */
  collected: number;
  /** 所需数量 */
  required: number;
  /** 是否已满足 */
  met: boolean;
}

/** 第二元神凝练条件 */
export interface CondenseRequirements {
  realm_met: boolean;
  realm_required: string;
  realm_current: string;
  fragments_met: boolean;
  can_condense: boolean;
  cost: {
    spirit_stones: number;
    divine_sense: number;
    remnant_soul: number;
  };
}

/** GET /second-soul/profile 响应数据 */
export interface SecondSoulProfileData {
  player: {
    id: number;
    nickname: string;
    realm: string;
    realm_rank: number;
    spirit_stones: string;
    divine_sense: number;
    remnant_soul: number;
    second_soul_count: number;
  };
  souls: SecondSoul[];
  /** 残篇收集进度，按 fragment_type 索引 */
  fragment_progress: Record<string, SoulFragmentProgress>;
  condense_requirements: CondenseRequirements;
}

// ==================== 小世界相关类型 ====================

/** 小世界面板-未开辟时返回 */
export interface SmallWorldProfileEmpty {
  has_small_world: false;
  can_create: boolean;
  create_cost: {
    spirit_stones: number;
    realm_required: string;
  };
}

/** 小世界面板-已开辟时的小世界数据 */
export interface SmallWorldInfo {
  id: number;
  world_name: string;
  world_level: number;
  world_type: string;
  population: number;
  population_max: number;
  faith: number;
  faith_max: number;
  stability: number;
  /** 香火产出（每小时） */
  incense_production_rate: number;
  last_incense_harvest_time: string;
  temple_id: number | null;
  created_at: string;
}

/** 小世界面板-已开辟时的神庙简要数据 */
export interface SmallWorldTempleBrief {
  id: number;
  temple_level: number;
  temple_name: string;
  defense_power: number;
  defense_max: number;
  last_upgrade_time: string;
}

/** 小世界面板-已开辟时的玩家资源 */
export interface SmallWorldPlayerResources {
  incense_balance: number;
  divine_sense_balance: number;
  law_points: number;
}

/** 小世界面板-已开辟时返回 */
export interface SmallWorldProfileActive {
  has_small_world: true;
  world: SmallWorldInfo;
  temple: SmallWorldTempleBrief | null;
  player: SmallWorldPlayerResources;
}

/** GET /small-world/profile 响应数据（联合类型） */
export type SmallWorldProfileData = SmallWorldProfileEmpty | SmallWorldProfileActive;

// ==================== 神庙相关类型 ====================

/** 神庙下一级升级信息 */
export interface TempleNextUpgrade {
  to_level: number;
  cost_incense: number;
  cost_spirit_stones: number;
  unlock_feature: string;
  temple_bonus: string;
}

/** 神庙面板-未创建时返回 */
export interface DivineTempleProfileEmpty {
  has_temple: false;
  message: string;
}

/** 神庙面板-已创建时返回 */
export interface DivineTempleProfileActive {
  has_temple: true;
  temple: {
    id: number;
    temple_level: number;
    temple_name: string;
    defense_power: number;
    defense_max: number;
    offering_pool: Array<{ offering_id: string; count: number }>;
    last_upgrade_time: string;
    last_defense_repair_time: string;
  };
  upgrade_info: {
    current_level: number;
    is_max_level: boolean;
    next_upgrade: TempleNextUpgrade | null;
  };
  /** 当前等级可兑换的供奉列表 */
  available_offerings: Array<{
    offering_id: string;
    name: string;
    cost_incense: number;
    reward: { type: string; amount: number };
    min_temple_level: number;
    description?: string;
  }>;
  player_incense_balance: number;
  player_spirit_stones: string;
}

/** GET /divine-temple/profile 响应数据（联合类型） */
export type DivineTempleProfileData = DivineTempleProfileEmpty | DivineTempleProfileActive;

// ==================== 香火相关类型 ====================

/** 单条香火流水 */
export interface IncenseLogItem {
  id: number;
  change_type: string;
  change_type_name: string;
  change_amount: number;
  balance_after: number;
  reason: string;
  created_at: string;
}

/** GET /incense/logs 响应数据 */
export interface IncenseLogsData {
  list: IncenseLogItem[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

// ==================== 神识相关类型 ====================

/** 神识淬炼面板数据 */
export interface DivineSenseProfileData {
  divine_sense: {
    current: number;
    max: number;
    regen_rate_per_hour: number;
    last_regen_time: string;
    total_quenched: number;
    total_consumed: number;
  };
  quench_info: {
    daily_count: number;
    daily_limit: number;
    daily_remaining: number;
    cooldown_ready: boolean;
    cooldown_remaining_sec: number;
    /** 淬炼比率（每 1 神识消耗多少香火） */
    cost_incense_per_sense: number;
    /** 单次最大淬炼数量 */
    max_amount_per_time: number;
  };
  usage_table: Array<{
    usage: string;
    name: string;
    cost: number;
    description?: string;
  }>;
  player_incense_balance: number;
}

// ==================== 法则相关类型 ====================

/** 法则面板数据 */
export interface LawProfileData {
  law_points: {
    current: number;
    total_earned: number;
    total_spent: number;
    daily_earned: number;
    daily_limit: number;
    daily_remaining: number;
  };
  fragments: {
    space: number;
    time: number;
    five_elements: number;
    soul: number;
    karma: number;
  };
  convert_rates: {
    divine_sense_to_points: number;
    space_fragment_to_points: number;
    other_fragment_to_points: number;
  };
  /** 法则转换选项（7 种） */
  convert_options: Array<{
    convert_id: string;
    name: string;
    cost_points: number;
    effect: string;
    description?: string;
  }>;
  /** 碎片类型中文名映射 */
  fragment_types: Record<string, { name: string; description?: string }>;
}

// ==================== 第二元神玩家接口 ====================

/**
 * 获取第二元神面板数据
 * GET /second-soul/profile
 * 包含玩家基础信息、元神列表、残篇收集进度、凝练条件
 */
export const secondSoulGetProfile = () => {
  return apiClient.get<ServiceResponse<SecondSoulProfileData>>('/second-soul/profile');
};

/**
 * 凝练第二元神
 * POST /second-soul/condense
 * 校验境界≥化神期、5 类残篇各 1 份、灵石/神识/残魂消耗
 * @param soulName 元神名称（玩家自定义，最长 50 字符）
 */
export const secondSoulCondense = (soulName: string) => {
  return apiClient.post<ServiceResponse>('/second-soul/condense', { soul_name: soulName });
};

/**
 * 分化第三元神
 * POST /second-soul/divide
 * 需第二元神境界≥化神期，消耗额外资源
 * @param soulName 第三元神名称
 */
export const secondSoulDivide = (soulName: string) => {
  return apiClient.post<ServiceResponse>('/second-soul/divide', { soul_name: soulName });
};

/**
 * 切换元神调度模式
 * POST /second-soul/dispatch
 * 各模式独立 CD：combat=斗法 / cultivate=修炼 / scout=窥探 / defend=护身
 * @param soulIndex 元神序号（2=第二元神，3=第三元神）
 * @param mode 调度模式
 */
export const secondSoulDispatch = (soulIndex: 2 | 3, mode: 'combat' | 'cultivate' | 'scout' | 'defend') => {
  return apiClient.post<ServiceResponse>('/second-soul/dispatch', {
    soul_index: soulIndex,
    mode
  });
};

/**
 * 开始元神独立修炼
 * POST /second-soul/cultivate
 * 12 小时上限，每日 2 次
 * @param soulIndex 元神序号（2 或 3）
 */
export const secondSoulCultivate = (soulIndex: 2 | 3) => {
  return apiClient.post<ServiceResponse>('/second-soul/cultivate', { soul_index: soulIndex });
};

// ==================== 小世界玩家接口 ====================

/**
 * 获取小世界面板数据
 * GET /small-world/profile
 * 返回联合类型：未开辟时 has_small_world=false，已开辟时含 world/temple/player 三段
 */
export const smallWorldGetProfile = () => {
  return apiClient.get<ServiceResponse<SmallWorldProfileData>>('/small-world/profile');
};

/**
 * 开辟小世界
 * POST /small-world/create
 * 化神期可开辟，消耗 500000 灵石
 * @param worldName 小世界名称（最长 50 字符）
 */
export const smallWorldCreate = (worldName: string) => {
  return apiClient.post<ServiceResponse>('/small-world/create', { world_name: worldName });
};

/**
 * 显灵回应祈愿
 * POST /small-world/manifest
 * 消耗 100 香火，获得信仰+5 / 稳定+3 / 灵石回馈
 */
export const smallWorldManifest = () => {
  return apiClient.post<ServiceResponse>('/small-world/manifest', {});
};

/**
 * 神迹干预
 * POST /small-world/miracle
 * 每日次数限制：relieve_disaster=赈灾（提升稳定度）/ preach=布道（提升信仰）
 * @param type 干预类型
 */
export const smallWorldMiracle = (type: 'relieve_disaster' | 'preach') => {
  return apiClient.post<ServiceResponse>('/small-world/miracle', { type });
};

// ==================== 神庙玩家接口 ====================

/**
 * 获取神庙面板数据
 * GET /divine-temple/profile
 * 含等级/护界禁制/供奉池/升级表/可兑换供奉
 */
export const divineTempleGetProfile = () => {
  return apiClient.get<ServiceResponse<DivineTempleProfileData>>('/divine-temple/profile');
};

/**
 * 升级神庙
 * POST /divine-temple/upgrade
 * 按 10 级表消耗香火+灵石
 */
export const divineTempleUpgrade = () => {
  return apiClient.post<ServiceResponse>('/divine-temple/upgrade', {});
};

/**
 * 修复护界禁制
 * POST /divine-temple/repair-defense
 * 消耗灵石修复 100 点禁制，CD 1 小时
 */
export const divineTempleRepairDefense = () => {
  return apiClient.post<ServiceResponse>('/divine-temple/repair-defense', {});
};

/**
 * 兑换供奉
 * POST /divine-temple/exchange-offering
 * 用香火兑换灵石/神识丹/法则碎片等
 * @param offeringId 供奉ID（来自 available_offerings 列表）
 */
export const divineTempleExchangeOffering = (offeringId: string) => {
  return apiClient.post<ServiceResponse>('/divine-temple/exchange-offering', {
    offering_id: offeringId
  });
};

// ==================== 香火玩家接口 ====================

/**
 * 收割香火
 * POST /incense/harvest
 * 按公式结算累计产出，同步更新小世界人口/信仰/稳定度
 */
export const incenseHarvest = () => {
  return apiClient.post<ServiceResponse>('/incense/harvest', {});
};

/**
 * 分页查询香火流水
 * GET /incense/logs?page=1&page_size=10
 * @param page 页码（默认 1）
 * @param pageSize 每页条数（1-100，默认 10）
 * @param changeType 可选：按变更类型过滤
 */
export const incenseGetLogs = (page: number = 1, pageSize: number = 10, changeType?: string) => {
  return apiClient.get<ServiceResponse<IncenseLogsData>>('/incense/logs', {
    params: {
      page,
      page_size: pageSize,
      ...(changeType ? { change_type: changeType } : {})
    }
  });
};

// ==================== 神识玩家接口 ====================

/**
 * 获取神识淬炼面板数据
 * GET /divine-sense/profile
 * 含神识余额/上限/恢复速率/淬炼次数/CD/用途消耗表
 */
export const divineSenseGetProfile = () => {
  return apiClient.get<ServiceResponse<DivineSenseProfileData>>('/divine-sense/profile');
};

/**
 * 神识淬炼
 * POST /divine-sense/quench
 * 100 香火 = 1 神识，每日 3 次，CD 1 小时
 * @param amount 期望淬炼的神识数量（1-100）
 */
export const divineSenseQuench = (amount: number) => {
  return apiClient.post<ServiceResponse>('/divine-sense/quench', { amount });
};

// ==================== 法则玩家接口 ====================

/**
 * 获取法则面板数据
 * GET /law/profile
 * 含法则点/5 类碎片存量/转换比率/7 种转换选项
 */
export const lawGetProfile = () => {
  return apiClient.get<ServiceResponse<LawProfileData>>('/law/profile');
};

/**
 * 神识→法则点 转换
 * POST /law/convert-divine-sense
 * 100 神识=1 法则点，受每日上限限制
 * @param divineSenseAmount 消耗的神识数量
 */
export const lawConvertDivineSense = (divineSenseAmount: number) => {
  return apiClient.post<ServiceResponse>('/law/convert-divine-sense', {
    divine_sense_amount: divineSenseAmount
  });
};

/**
 * 碎片→法则点 转换
 * POST /law/convert-fragment
 * 空间碎片=5 点 / 其他碎片=3 点，受每日上限限制
 * @param fragmentType 碎片类型：space/time/five_elements/soul/karma
 * @param fragmentCount 消耗的碎片数量
 */
export const lawConvertFragment = (fragmentType: string, fragmentCount: number) => {
  return apiClient.post<ServiceResponse>('/law/convert-fragment', {
    fragment_type: fragmentType,
    fragment_count: fragmentCount
  });
};

/**
 * 法则转换（消耗法则点，兑换7种永久/临时效果）
 * POST /law/convert
 * @param convertId 转换ID（来自 convert_options 列表）
 * @param count 转换次数（1-100，默认 1）
 */
export const lawConvert = (convertId: string, count: number = 1) => {
  return apiClient.post<ServiceResponse>('/law/convert', {
    convert_id: convertId,
    count
  });
};

// ==================== GM 后台接口（全部 /admin/late-stage 下） ====================

/**
 * GM 调整副元神属性
 * POST /admin/late-stage/second-soul/adjust-attributes
 * @param playerId 玩家ID
 * @param soulIndex 元神序号（2 或 3）
 * @param attributes 待覆盖的属性对象（仅传需要调整的字段）
 */
export const gmSecondSoulAdjustAttributes = (
  playerId: number,
  soulIndex: 2 | 3,
  attributes: { atk?: number; def?: number; hp_max?: number; speed?: number; sense?: number }
) => {
  return apiClient.post<ServiceResponse>('/admin/late-stage/second-soul/adjust-attributes', {
    player_id: playerId,
    soul_index: soulIndex,
    attributes
  });
};

/**
 * GM 重置玩家小世界
 * POST /admin/late-stage/small-world/reset
 * 删除小世界与神庙记录，玩家可重新开辟
 * @param playerId 玩家ID
 */
export const gmSmallWorldReset = (playerId: number) => {
  return apiClient.post<ServiceResponse>('/admin/late-stage/small-world/reset', {
    player_id: playerId
  });
};

/**
 * GM 调整小世界等级
 * POST /admin/late-stage/small-world/set-level
 * @param playerId 玩家ID
 * @param level 新等级（1-10）
 */
export const gmSmallWorldSetLevel = (playerId: number, level: number) => {
  return apiClient.post<ServiceResponse>('/admin/late-stage/small-world/set-level', {
    player_id: playerId,
    level
  });
};

/**
 * GM 调整神庙等级
 * POST /admin/late-stage/divine-temple/set-level
 * @param playerId 玩家ID
 * @param level 新等级（1-10）
 */
export const gmDivineTempleSetLevel = (playerId: number, level: number) => {
  return apiClient.post<ServiceResponse>('/admin/late-stage/divine-temple/set-level', {
    player_id: playerId,
    level
  });
};

/**
 * GM 发放/扣减香火
 * POST /admin/late-stage/incense/grant
 * @param playerId 玩家ID
 * @param amount 数量（正数发放，负数扣减，范围 -1000000~1000000）
 */
export const gmIncenseGrant = (playerId: number, amount: number) => {
  return apiClient.post<ServiceResponse>('/admin/late-stage/incense/grant', {
    player_id: playerId,
    amount
  });
};

/**
 * GM 发放/扣减神识
 * POST /admin/late-stage/divine-sense/grant
 * @param playerId 玩家ID
 * @param amount 数量（正数发放，负数扣减，范围 -10000~10000）
 */
export const gmDivineSenseGrant = (playerId: number, amount: number) => {
  return apiClient.post<ServiceResponse>('/admin/late-stage/divine-sense/grant', {
    player_id: playerId,
    amount
  });
};

/**
 * GM 发放/扣减法则点
 * POST /admin/late-stage/law/grant-points
 * @param playerId 玩家ID
 * @param amount 数量（正数发放，负数扣减，范围 -10000~10000）
 */
export const gmLawGrantPoints = (playerId: number, amount: number) => {
  return apiClient.post<ServiceResponse>('/admin/late-stage/law/grant-points', {
    player_id: playerId,
    amount
  });
};

/**
 * GM 发放/扣减法则碎片
 * POST /admin/late-stage/law/grant-fragment
 * @param playerId 玩家ID
 * @param fragmentType 碎片类型：space/time/five_elements/soul/karma
 * @param amount 数量（正数发放，负数扣减，范围 -1000~1000）
 */
export const gmLawGrantFragment = (
  playerId: number,
  fragmentType: 'space' | 'time' | 'five_elements' | 'soul' | 'karma',
  amount: number
) => {
  return apiClient.post<ServiceResponse>('/admin/late-stage/law/grant-fragment', {
    player_id: playerId,
    fragment_type: fragmentType,
    amount
  });
};
