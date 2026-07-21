/**
 * 批次3 道侣 / 双修 / 侍妾系统 API 客户端
 *
 * 统一封装批次3 道侣侍妾系统 3 大子模块的接口：
 *   1. 道侣（/api/companion）：道侣面板 / 寻找 / 同意 / 解除 / 双修 / 温养 / 采补 / 立誓 / 心契 / 心劫
 *   2. 侍妾（/api/concubine）：列表 / 寻缘 / 问安 / 反哺 / 赠予 / 安置 / 召回 / 遣散 / 远航 / 护法 / 觉醒
 *   3. GM 管理（/api/admin/companion-concubine）：强制解除道侣 / 调整心契 / 触发心劫 / 发放侍妾 / 调整属性 / 完成远航
 *
 * 重要说明：
 *   - 后端统一返回 { code, success?, message, data, error_code? } 包装结构
 *   - 业务失败时 code=200 但 success=false，由前端组件按 message 提示
 *   - 所有方法返回 axios response，调用方通过 resp.data 取业务数据
 *   - 请求体字段一律使用 snake_case，与后端路由保持一致
 *
 * 对应后端路由文件：
 *   - server/routes/companion.js
 *   - server/routes/concubine.js
 *   - server/routes/admin_companion_concubine.js
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

// ==================== 道侣相关类型 ====================

/** 道侣关系记录（DaoCompanion 行） */
export interface DaoCompanion {
  /** 关系记录主键 ID */
  id: number;
  /** 主动方玩家 ID */
  player_a_id: number;
  /** 被邀方玩家 ID */
  player_b_id: number;
  /** 主动方道号 */
  player_a_name?: string;
  /** 被邀方道号 */
  player_b_name?: string;
  /** 主动方境界 */
  player_a_realm?: string;
  /** 被邀方境界 */
  player_b_realm?: string;
  /** 亲密度（0-100） */
  intimacy: number;
  /** 心契等级（0-5） */
  heart_contract_level: number;
  /** 心契经验 */
  heart_contract_exp: number;
  /** 状态：pending=待对方同意 / active=已结侣 / broken=已解除 */
  status: 'pending' | 'active' | 'broken';
  /** 当日双修次数 */
  dual_cultivate_count: number;
  /** 双修日上限 */
  dual_cultivate_limit: number;
  /** 当日温养次数 */
  warm_nourish_count: number;
  /** 温养日上限 */
  warm_nourish_limit: number;
  /** 当日采补次数 */
  pluck_supplement_count: number;
  /** 采补日上限 */
  pluck_supplement_limit: number;
  /** 已立誓列表 */
  vows?: string[];
  /** 结侣时间 */
  created_at?: string;
}

/** 道侣誓言信息 */
export interface VowInfo {
  /** 誓言类型：protect=护道 / secret=守秘 / cultivate=共修 */
  vow_type: 'protect' | 'secret' | 'cultivate';
  /** 誓言名称 */
  name: string;
  /** 誓言描述 */
  description: string;
  /** 是否已立此誓 */
  activated: boolean;
}

/** 心契等级信息 */
export interface HeartContract {
  /** 当前心契等级（0-5） */
  level: number;
  /** 当前心契经验 */
  exp: number;
  /** 升级到下一级所需经验 */
  exp_to_next: number;
  /** 下一级加成描述 */
  next_bonus: string;
  /** 当前等级加成描述 */
  current_bonus: string;
  /** 5 级心契加成说明列表 */
  level_bonuses: Array<{
    level: number;
    name: string;
    description: string;
  }>;
}

/** 心劫事件选项 */
export interface HeartTribulationOption {
  /** 选项类型：steady=稳 / ruthless=狠 / deceive=骗 */
  option: 'steady' | 'ruthless' | 'deceive';
  /** 选项名称 */
  name: string;
  /** 成功率（0-1） */
  success_rate: number;
  /** 亲密度变化（正数增加，负数减少） */
  intimacy_change: number;
  /** 残魂消耗 */
  remnant_soul_cost: number;
  /** 选项描述 */
  description: string;
}

/** 心劫事件 */
export interface HeartTribulationEvent {
  /** 事件 ID */
  event_id: number;
  /** 事件名称 */
  title: string;
  /** 事件背景描述 */
  description: string;
  /** 事件类型 */
  event_type?: string;
  /** 3 个选项详情 */
  options: HeartTribulationOption[];
}

/** 心劫抉择结果 */
export interface HeartTribulationResult {
  /** 是否成功 */
  success: boolean;
  /** 亲密度变化 */
  intimacy_change: number;
  /** 残魂消耗 */
  remnant_soul_cost: number;
  /** 心契经验变化 */
  heart_contract_exp_change?: number;
  /** 结果描述 */
  message: string;
}

/** GET /companion/profile 响应数据 */
export interface CompanionProfileData {
  /** 当前玩家 ID */
  player_id: number;
  /** 当前玩家道号 */
  player_name: string;
  /** 当前玩家境界 */
  player_realm: string;
  /** 是否已结侣 */
  has_companion: boolean;
  /** 道侣信息（无道侣时为 null） */
  companion: DaoCompanion | null;
  /** 对方玩家 ID（无道侣时为 null） */
  companion_player_id: number | null;
  /** 对方道号（无道侣时为 null） */
  companion_name: string | null;
  /** 对方境界（无道侣时为 null） */
  companion_realm: string | null;
  /** 待处理的邀请列表（他人邀请当前玩家） */
  pending_invitations: Array<{
    companion_id: number;
    from_player_id: number;
    from_player_name: string;
    from_player_realm: string;
    created_at: string;
  }>;
}

/** GET /companion/heart-contract 响应数据 */
export interface HeartContractData {
  /** 心契信息 */
  heart_contract: HeartContract;
  /** 道侣双方加成当前生效列表 */
  active_bonuses: string[];
}

/** GET /companion/heart-tribulation 响应数据 */
export interface HeartTribulationListData {
  /** 待处理心劫事件列表 */
  events: HeartTribulationEvent[];
  /** 是否有心劫待处理 */
  has_event: boolean;
}

// ==================== 侍妾相关类型 ====================

/** 侍妾记录（PlayerConcubine 行） */
export interface Concubine {
  /** 侍妾 ID */
  id: number;
  /** 所属玩家 ID */
  player_id: number;
  /** 侍妾原型 key（如 nan_gong_wan） */
  concubine_key: string;
  /** 侍妾名字 */
  name: string;
  /** 头像 emoji */
  avatar?: string;
  /** 境界名称 */
  realm: string;
  /** 境界等阶（数字） */
  realm_rank: number;
  /** 魅力（0-100） */
  charm: number;
  /** 亲密度（0-100） */
  intimacy: number;
  /** 忠诚度（0-100） */
  loyalty: number;
  /** 经验值 */
  exp: number;
  /** 状态：idle=空闲 / placed=已安置 / voyaging=远航中 / protecting=护法中 */
  status: 'idle' | 'placed' | 'voyaging' | 'protecting';
  /** 安置地点（已安置时存在） */
  location?: string;
  /** 觉醒等级（0=未觉醒婉影） */
  awaken_level: number;
  /** 上次问安时间 */
  last_ask_after_time?: string;
  /** 上次反哺时间 */
  last_backfeed_time?: string;
  /** 是否已觉醒婉影 */
  is_awakened: boolean;
  /** 创建时间 */
  created_at?: string;
}

/** 远航记录 */
export interface ConcubineVoyage {
  /** 远航 ID */
  id: number;
  /** 侍妾 ID */
  concubine_id: number;
  /** 侍妾名称 */
  concubine_name: string;
  /** 远航模式：safe=稳妥 / balanced=均衡 / risky=冒险 / moon_palace=月殿寻痕 */
  mode: 'safe' | 'balanced' | 'risky' | 'moon_palace';
  /** 远航模式中文名 */
  mode_name?: string;
  /** 远航时长（小时） */
  duration_hours: number;
  /** 出发时间 */
  started_at: string;
  /** 预计归来时间 */
  expected_return_time: string;
  /** 是否已完成 */
  is_finished: boolean;
  /** 远航奖励列表（归来后才有） */
  rewards?: VoyageReward[];
}

/** 远航奖励 */
export interface VoyageReward {
  /** 奖励类型：spirit_stone=灵石 / exp=修为 / item=物品 / fragment=法则碎片 */
  type: string;
  /** 奖励名称 */
  name: string;
  /** 奖励数量 */
  amount: number;
  /** 物品 key（type=item 时存在） */
  item_key?: string;
}

/** GET /concubine/list 响应数据 */
export interface ConcubineListData {
  /** 侍妾列表 */
  concubines: Concubine[];
  /** 侍妾数量 */
  total: number;
  /** 今日剩余寻缘次数（含免费 + 灵石） */
  seek_fate_remaining: number;
  /** 寻缘日总上限 */
  seek_fate_limit: number;
}

/** POST /concubine/seek-fate 响应数据 */
export interface SeekFateResult {
  /** 是否寻到侍妾 */
  found: boolean;
  /** 寻到的侍妾信息（未寻到为 null） */
  concubine: Concubine | null;
  /** 今日剩余寻缘次数 */
  seek_fate_remaining: number;
  /** 消耗的灵石（免费时为 0） */
  cost_spirit_stones: number;
  /** 结果描述 */
  message: string;
}

/** POST /concubine/ask-after 响应数据 */
export interface AskAfterResult {
  /** 侍妾 ID */
  concubine_id: number;
  /** 亲密度变化 */
  intimacy_change: number;
  /** 忠诚度变化 */
  loyalty_change: number;
  /** 结果描述 */
  message: string;
}

/** POST /concubine/backfeed 响应数据 */
export interface BackfeedResult {
  /** 侍妾 ID */
  concubine_id: number;
  /** 侍妾修为增加量 */
  concubine_exp_gain: number;
  /** 玩家修为消耗量 */
  player_exp_cost: number;
  /** 结果描述 */
  message: string;
}

/** POST /concubine/gift 响应数据 */
export interface GiftResult {
  /** 侍妾 ID */
  concubine_id: number;
  /** 亲密度变化 */
  intimacy_change: number;
  /** 魅力变化 */
  charm_change: number;
  /** 结果描述 */
  message: string;
}

/** POST /concubine/place 响应数据 */
export interface PlaceResult {
  /** 侍妾 ID */
  concubine_id: number;
  /** 安置地点 */
  location: string;
  /** 结果描述 */
  message: string;
}

/** POST /concubine/recall 响应数据 */
export interface RecallResult {
  /** 侍妾 ID */
  concubine_id: number;
  /** 结果描述 */
  message: string;
}

/** POST /concubine/dismiss 响应数据 */
export interface DismissResult {
  /** 侍妾 ID */
  concubine_id: number;
  /** 结果描述 */
  message: string;
}

/** POST /concubine/voyage/start 响应数据 */
export interface VoyageStartResult {
  /** 远航 ID */
  voyage_id: number;
  /** 侍妾 ID */
  concubine_id: number;
  /** 远航模式 */
  mode: 'safe' | 'balanced' | 'risky' | 'moon_palace';
  /** 预计归来时间 */
  expected_return_time: string;
  /** 结果描述 */
  message: string;
}

/** GET /concubine/voyage/status 响应数据 */
export interface VoyageStatusData {
  /** 进行中的远航列表 */
  active_voyages: ConcubineVoyage[];
  /** 已完成待领取的远航列表 */
  finished_voyages: ConcubineVoyage[];
}

/** POST /concubine/voyage/return 响应数据 */
export interface VoyageReturnResult {
  /** 远航 ID */
  voyage_id: number;
  /** 侍妾 ID */
  concubine_id: number;
  /** 是否成功归来 */
  success: boolean;
  /** 远航奖励列表 */
  rewards: VoyageReward[];
  /** 结果描述 */
  message: string;
}

/** POST /concubine/protect 响应数据 */
export interface ProtectResult {
  /** 侍妾 ID */
  concubine_id: number;
  /** 护法开始时间 */
  started_at: string;
  /** 结果描述 */
  message: string;
}

/** POST /concubine/awaken 响应数据 */
export interface AwakenResult {
  /** 侍妾 ID */
  concubine_id: number;
  /** 觉醒等级 */
  awaken_level: number;
  /** 是否觉醒成功 */
  success: boolean;
  /** 结果描述 */
  message: string;
}

// ==================== 道侣玩家接口（11 个） ====================

/**
 * 获取道侣面板数据
 * GET /companion/profile
 * 包含当前玩家道侣状态 / 待处理邀请 / 双修次数 / 誓言等
 */
export const companionGetProfile = () => {
  return apiClient.get<ServiceResponse<CompanionProfileData>>('/companion/profile');
};

/**
 * 寻找道侣（发起邀请）
 * POST /companion/seek
 * @param targetPlayerId 目标玩家 ID
 */
export const companionSeek = (targetPlayerId: number) => {
  return apiClient.post<ServiceResponse>('/companion/seek', {
    target_player_id: targetPlayerId
  });
};

/**
 * 同意结侣
 * POST /companion/accept
 * @param companionId 道侣关系记录 ID（来自 pending 邀请）
 */
export const companionAccept = (companionId: number) => {
  return apiClient.post<ServiceResponse>('/companion/accept', {
    companion_id: companionId
  });
};

/**
 * 解除道侣
 * POST /companion/break
 * @param mode 解除模式：agreement=和离 / vow_break=毁誓
 */
export const companionBreak = (mode: 'agreement' | 'vow_break') => {
  return apiClient.post<ServiceResponse>('/companion/break', { mode });
};

/**
 * 闭关双修
 * POST /companion/dual-cultivate
 * 主方修为 +5%，日上限 3 次
 */
export const companionDualCultivate = () => {
  return apiClient.post<ServiceResponse>('/companion/dual-cultivate', {});
};

/**
 * 温养
 * POST /companion/warm-nourish
 * 双方修为 +3%，日上限 2 次
 */
export const companionWarmNourish = () => {
  return apiClient.post<ServiceResponse>('/companion/warm-nourish', {});
};

/**
 * 采补
 * POST /companion/pluck-supplement
 * 主方 +10%，副方 -3%，日上限 1 次
 */
export const companionPluckSupplement = () => {
  return apiClient.post<ServiceResponse>('/companion/pluck-supplement', {});
};

/**
 * 立誓
 * POST /companion/vow
 * @param vowType 誓言类型：protect=护道 / secret=守秘 / cultivate=共修
 */
export const companionVow = (vowType: 'protect' | 'secret' | 'cultivate') => {
  return apiClient.post<ServiceResponse>('/companion/vow', {
    vow_type: vowType
  });
};

/**
 * 获取心契面板
 * GET /companion/heart-contract
 * 含心契等级 / 经验 / 5 级加成说明
 */
export const companionGetHeartContract = () => {
  return apiClient.get<ServiceResponse<HeartContractData>>('/companion/heart-contract');
};

/**
 * 获取待处理心劫事件
 * GET /companion/heart-tribulation
 * 返回事件列表，每个事件含 3 个选项详情
 */
export const companionGetHeartTribulation = () => {
  return apiClient.get<ServiceResponse<HeartTribulationListData>>('/companion/heart-tribulation');
};

/**
 * 心劫抉择
 * POST /companion/heart-tribulation/choose
 * @param eventId 心劫事件 ID
 * @param option 选项：steady=稳 / ruthless=狠 / deceive=骗
 */
export const companionChooseHeartTribulation = (
  eventId: number,
  option: 'steady' | 'ruthless' | 'deceive'
) => {
  return apiClient.post<ServiceResponse<HeartTribulationResult>>(
    '/companion/heart-tribulation/choose',
    {
      event_id: eventId,
      option
    }
  );
};

// ==================== 侍妾玩家接口（13 个） ====================

/**
 * 获取侍妾列表
 * GET /concubine/list
 * 含所有侍妾详情 + 今日剩余寻缘次数
 */
export const concubineGetList = () => {
  return apiClient.get<ServiceResponse<ConcubineListData>>('/concubine/list');
};

/**
 * 红尘寻缘
 * POST /concubine/seek-fate
 * 每日 1 次免费，额外 3 次消耗灵石
 */
export const concubineSeekFate = () => {
  return apiClient.post<ServiceResponse<SeekFateResult>>('/concubine/seek-fate', {});
};

/**
 * 每日问安
 * POST /concubine/ask-after
 * @param concubineId 侍妾 ID
 */
export const concubineAskAfter = (concubineId: number) => {
  return apiClient.post<ServiceResponse<AskAfterResult>>('/concubine/ask-after', {
    concubine_id: concubineId
  });
};

/**
 * 灵力反哺
 * POST /concubine/backfeed
 * 侍妾修为 +1000，消耗玩家修为 500
 * @param concubineId 侍妾 ID
 */
export const concubineBackfeed = (concubineId: number) => {
  return apiClient.post<ServiceResponse<BackfeedResult>>('/concubine/backfeed', {
    concubine_id: concubineId
  });
};

/**
 * 赠予物品
 * POST /concubine/gift
 * @param concubineId 侍妾 ID
 * @param itemKey 物品 key（来自物品配置）
 * @param count 数量（1-99）
 */
export const concubineGift = (concubineId: number, itemKey: string, count: number) => {
  return apiClient.post<ServiceResponse<GiftResult>>('/concubine/gift', {
    concubine_id: concubineId,
    item_key: itemKey,
    count
  });
};

/**
 * 安置侍妾
 * POST /concubine/place
 * @param concubineId 侍妾 ID
 * @param location 安置地点（如：药园/洞府/灵泉等）
 */
export const concubinePlace = (concubineId: number, location: string) => {
  return apiClient.post<ServiceResponse<PlaceResult>>('/concubine/place', {
    concubine_id: concubineId,
    location
  });
};

/**
 * 召回侍妾
 * POST /concubine/recall
 * @param concubineId 侍妾 ID
 */
export const concubineRecall = (concubineId: number) => {
  return apiClient.post<ServiceResponse<RecallResult>>('/concubine/recall', {
    concubine_id: concubineId
  });
};

/**
 * 遣散侍妾
 * POST /concubine/dismiss
 * @param concubineId 侍妾 ID
 */
export const concubineDismiss = (concubineId: number) => {
  return apiClient.post<ServiceResponse<DismissResult>>('/concubine/dismiss', {
    concubine_id: concubineId
  });
};

/**
 * 侍妾远航
 * POST /concubine/voyage/start
 * @param concubineId 侍妾 ID
 * @param mode 远航模式：safe=稳妥(4h) / balanced=均衡(8h) / risky=冒险(12h) / moon_palace=月殿寻痕(24h)
 */
export const concubineStartVoyage = (
  concubineId: number,
  mode: 'safe' | 'balanced' | 'risky' | 'moon_palace'
) => {
  return apiClient.post<ServiceResponse<VoyageStartResult>>('/concubine/voyage/start', {
    concubine_id: concubineId,
    mode
  });
};

/**
 * 远航状态
 * GET /concubine/voyage/status
 * 含进行中 + 已完成待领取的远航列表
 */
export const concubineGetVoyageStatus = () => {
  return apiClient.get<ServiceResponse<VoyageStatusData>>('/concubine/voyage/status');
};

/**
 * 远航归来
 * POST /concubine/voyage/return
 * @param voyageId 远航 ID
 */
export const concubineReturnVoyage = (voyageId: number) => {
  return apiClient.post<ServiceResponse<VoyageReturnResult>>('/concubine/voyage/return', {
    voyage_id: voyageId
  });
};

/**
 * 请侍妾护法
 * POST /concubine/protect
 * @param concubineId 侍妾 ID
 */
export const concubineProtect = (concubineId: number) => {
  return apiClient.post<ServiceResponse<ProtectResult>>('/concubine/protect', {
    concubine_id: concubineId
  });
};

/**
 * 觉醒婉影
 * POST /concubine/awaken
 * @param concubineId 侍妾 ID
 */
export const concubineAwaken = (concubineId: number) => {
  return apiClient.post<ServiceResponse<AwakenResult>>('/concubine/awaken', {
    concubine_id: concubineId
  });
};

// ==================== GM 后台接口（6 个，全部 /admin/companion-concubine 下） ====================

/**
 * GM 强制解除道侣
 * POST /admin/companion-concubine/dao-companion/break
 * @param playerId 玩家 ID
 */
export const adminBreakDaoCompanion = (playerId: number) => {
  return apiClient.post<ServiceResponse>(
    '/admin/companion-concubine/dao-companion/break',
    {
      player_id: playerId
    }
  );
};

/**
 * GM 调整心契等级
 * POST /admin/companion-concubine/dao-companion/set-heart-contract
 * @param playerId 玩家 ID
 * @param level 心契等级（0-5）
 */
export const adminSetHeartContractLevel = (playerId: number, level: number) => {
  return apiClient.post<ServiceResponse>(
    '/admin/companion-concubine/dao-companion/set-heart-contract',
    {
      player_id: playerId,
      level
    }
  );
};

/**
 * GM 触发心劫
 * POST /admin/companion-concubine/heart-tribulation/trigger
 * @param playerId 玩家 ID
 */
export const adminTriggerHeartTribulation = (playerId: number) => {
  return apiClient.post<ServiceResponse>(
    '/admin/companion-concubine/heart-tribulation/trigger',
    {
      player_id: playerId
    }
  );
};

/**
 * GM 直接发放侍妾
 * POST /admin/companion-concubine/concubine/grant
 * @param playerId 玩家 ID
 * @param concubineKey 侍妾原型 key（如 nan_gong_wan / zi_ling 等 7 种之一）
 */
export const adminGrantConcubine = (playerId: number, concubineKey: string) => {
  return apiClient.post<ServiceResponse>(
    '/admin/companion-concubine/concubine/grant',
    {
      player_id: playerId,
      concubine_key: concubineKey
    }
  );
};

/**
 * GM 调整侍妾属性
 * POST /admin/companion-concubine/concubine/set-attr
 * @param concubineId 侍妾 ID
 * @param attr 属性名：charm=魅力 / intimacy=亲密度 / loyalty=忠诚度 / exp=经验 / realm_rank=境界等阶
 * @param value 新值
 */
export const adminSetConcubineAttr = (
  concubineId: number,
  attr: 'charm' | 'intimacy' | 'loyalty' | 'exp' | 'realm_rank',
  value: number
) => {
  return apiClient.post<ServiceResponse>(
    '/admin/companion-concubine/concubine/set-attr',
    {
      concubine_id: concubineId,
      attr,
      value
    }
  );
};

/**
 * GM 立即完成远航
 * POST /admin/companion-concubine/voyage/finish
 * @param voyageId 远航 ID
 */
export const adminFinishVoyage = (voyageId: number) => {
  return apiClient.post<ServiceResponse>(
    '/admin/companion-concubine/voyage/finish',
    {
      voyage_id: voyageId
    }
  );
};
