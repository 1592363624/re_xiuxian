/**
 * 飞升 + 夺舍重生系统 API 客户端
 *
 * 批次3 飞升+夺舍重生系统接口封装：
 * 1. 飞升面板：获取飞升进度、大衍诀、节点列表、问道感悟、法相等级、成功率预估
 * 2. 空间节点：搜寻节点 → 定星稳固 → 获取逆灵通道坐标/法则碎片/丹方/灵乳
 * 3. 飞升尝试：满足前置后触发飞升，成功飞升灵界，失败残魂-30/修为-10%/虚弱2小时
 * 4. 天机回溯：飞升失败后每日1次回溯机会，回到飞升前状态
 * 5. 问道：化神后期向天道问道，每日3次/CD 30分钟，积累感悟值（10点感悟=1%飞升加成）
 * 6. 法相天地：9级数值表，每级 5% 全属性加成 + 2% 飞升成功率加成
 * 7. 探寻裂缝：元婴初期探寻虚空裂缝，每日5次/CD 10分钟，15% 反噬概率
 * 8. 夺舍重生：飞升失败/寿命尽/PVP被杀时触发，推送3个目标，72小时冷却
 *
 * 对应后端路由：
 *   - 玩家接口：/api/ascension/*（飞升相关）+ /api/reincarnation/*（夺舍相关）
 *   - GM 接口：/api/admin/ascension/*
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

// ==================== 飞升面板相关类型 ====================

/** 飞升前置条件检查结果 */
export interface AscensionPrerequisites {
  /** 是否满足所有前置条件 */
  canAscend: boolean;
  /** 未满足的原因列表（canAscend=false 时有值） */
  reasons: string[];
  /** 检查时间 ISO 字符串 */
  checked_at: string;
}

/** 飞升成功率拆解 */
export interface SuccessRateBreakdown {
  /** 问道感悟加成（小数，0.048=4.8%） */
  ask_dao_bonus: number;
  /** 法相天地加成 */
  dharma_form_bonus: number;
  /** 大衍诀加成 */
  dayan_bonus: number;
  /** 残魂加成 */
  remnant_soul_bonus: number;
  /** 法则碎片加成 */
  law_fragments_bonus: number;
  /** 总加成（未封顶） */
  total_bonus: number;
  /** 是否已封顶 */
  total_bonus_capped: boolean;
}

/** 飞升成功率估算 */
export interface SuccessRate {
  /** 最终成功率（小数，0.348=34.8%） */
  final_rate: number;
  /** 基础成功率 */
  base_rate: number;
  /** 加成拆解 */
  breakdown: SuccessRateBreakdown;
  /** 成功率上限 */
  max_rate: number;
}

/** 玩家基础信息（飞升面板返回的子对象） */
export interface AscensionPlayerInfo {
  id: number;
  nickname: string;
  realm: string;
  /** 境界排名（用于前置条件判断） */
  realm_rank: number;
  /** 当前修为（字符串避免 BigInt 序列化问题） */
  exp: string;
  /** 灵石数量 */
  spirit_stones: string;
  /** 残魂值（0-100） */
  remnant_soul: number;
  /** 神识值 */
  divine_sense: number;
  /** 问道感悟值 */
  ask_dao_insight: number;
  /** 法相天地等级 */
  dharma_form_level: number;
  /** 虚弱结束时间（null=未虚弱） */
  weakness_end_time: string | null;
  /** 是否死亡 */
  is_dead: boolean;
}

/** 飞升档案子对象 */
export interface AscensionProfile {
  /** 飞升状态：preparing=准备中，ascending=飞升中，failed=失败 */
  ascension_state: 'preparing' | 'ascending' | 'failed';
  /** 大衍诀层数（0-5） */
  dayan_level: number;
  /** 大衍诀经验 */
  dayan_exp: number;
  /** 空间法则碎片数量 */
  law_fragments_count: number;
  /** 飞升尝试次数 */
  ascension_attempt_count: number;
  /** 飞升成功次数 */
  ascension_success_count: number;
  /** 是否已飞升（0否1是） */
  is_ascended: number;
  /** 天机回溯次数 */
  revert_count: number;
}

/** 空间节点信息 */
export interface AscensionNode {
  id: number;
  /** 节点名称（如「时空涟漪」） */
  node_name: string;
  /** 节点类型 */
  node_type: string;
  /** 节点状态：discovered=已发现，stabilizing=稳固中，stable=已稳固 */
  node_state: string;
  /** 奖励类型 */
  reward_type: string;
  /** 奖励数量 */
  reward_amount: number;
  /** 发现时间 */
  discovered_at: string;
  /** 稳固结束时间（stabilizing 状态才有值） */
  stabilize_end_time: string | null;
  /** 过期时间 */
  expires_at: string;
}

/** GET /ascension/profile 响应数据 */
export interface AscensionProfileData {
  player: AscensionPlayerInfo;
  ascension: AscensionProfile;
  nodes: AscensionNode[];
  success_rate: SuccessRate;
  prerequisites: AscensionPrerequisites;
}

// ==================== 飞升操作响应类型 ====================

/** 问道响应 */
export interface AskDaoResult {
  /** 本次获得的感悟值 */
  insight_gain: number;
  /** 当前累计感悟值 */
  total_insight: number;
  /** 消耗的灵石 */
  spirit_stones_cost: number;
  /** 问道事件文本 */
  event: string;
  /** 今日已问道次数 */
  daily_count: number;
  /** 每日次数上限 */
  daily_limit: number;
  /** 是否暴击（10% 概率双倍感悟） */
  is_critical: boolean;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
}

/** 法相天地修炼响应 */
export interface DharmaFormResult {
  /** 新法相等级 */
  level: number;
  /** 法相最高等级 */
  max_level: number;
  /** 消耗的问道感悟 */
  insight_cost: number;
  /** 消耗的灵石 */
  spirit_stones_cost: number;
  /** 当前属性加成（小数形式，0.05=5%） */
  attribute_bonus: number;
  /** 飞升成功率加成（小数形式，0.02=2%） */
  ascension_bonus: number;
  /** 下一级所需感悟 */
  next_level_insight_cost: number;
  /** 下一级所需灵石 */
  next_level_spirit_stones_cost: number;
}

/** 探寻裂缝响应 */
export interface ExploreFractureResult {
  /** 是否发现裂缝 */
  discovered: boolean;
  /** 是否触发反噬（15% 概率） */
  is_backfire: boolean;
  /** 反噬伤害（is_backfire=true 时有值） */
  backfire_damage?: number;
  /** 掉落物品信息 */
  drop_item: {
    name: string;
    count: number;
    rarity: string;
    description?: string;
  } | null;
  /** 获得的法则碎片 */
  law_fragments_gain: number;
  /** 消耗的神识 */
  divine_sense_cost: number;
  /** 当前神识值 */
  divine_sense: number;
  /** 今日已探寻次数 */
  daily_count: number;
  /** 每日次数上限 */
  daily_limit: number;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
}

/** 搜寻节点响应 */
export interface SearchNodeResult {
  /** 是否发现节点 */
  discovered: boolean;
  /** 节点信息 */
  node: AscensionNode | null;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
}

/** 定星稳固节点响应 */
export interface StabilizeNodeResult {
  /** 是否开始稳固 */
  success: boolean;
  /** 节点ID */
  node_id: number;
  /** 稳固结束时间 */
  stabilize_end_time: string;
  /** 稳固时长（秒） */
  stabilize_duration: number;
  /** 消耗的神识 */
  divine_sense_cost: number;
  /** 消耗的灵石 */
  spirit_stones_cost: number;
}

/** 飞升尝试响应 */
export interface AscendResult {
  /** 是否飞升成功 */
  success: boolean;
  /** 飞升结果消息 */
  message: string;
  /** 新境界（成功时返回） */
  new_realm?: string;
  /** 残魂变化（成功时返回） */
  remnant_soul_change?: number;
  /** 当前残魂值 */
  remnant_soul: number;
  /** 失败时的修为损失 */
  exp_loss?: string;
  /** 虚弱结束时间（失败时返回） */
  weakness_end_time?: string;
  /** 飞升尝试次数 */
  ascension_attempt_count: number;
  /** 飞升成功次数 */
  ascension_success_count: number;
}

/** 天机回溯响应 */
export interface RevertResult {
  /** 是否回溯成功 */
  success: boolean;
  /** 回溯结果消息 */
  message: string;
  /** 今日剩余回溯次数 */
  remaining_count: number;
  /** 每日回溯次数上限 */
  daily_limit: number;
}

// ==================== 夺舍相关类型 ====================

/** 夺舍目标 */
export interface ReincarnationTarget {
  /** 序号（1-3） */
  index: number;
  /** 目标ID */
  target_id: number;
  /** 目标名称 */
  target_name: string;
  /** 目标类型：mortal=凡人，cultivator=修士，monster=妖兽 */
  target_type: 'mortal' | 'cultivator' | 'monster';
  /** 目标类型中文名 */
  target_type_display: string;
  /** 目标境界排名 */
  target_realm_rank: number;
  /** 风险等级（1=低，2=中，3=高） */
  risk_level: 1 | 2 | 3;
  /** 修为继承比例（小数，0.3=30%） */
  inherit_ratio: number;
  /** 境界跌落数（大境界） */
  drop_realm_count: number;
  /** 是否稀有目标 */
  is_rare: boolean;
  /** 目标描述 */
  description: string;
  /** 夺舍成功率（小数形式） */
  success_rate: number;
}

/** 触发夺舍响应 */
export interface TriggerReincarnationResult {
  /** 死亡原因 */
  death_reason: string;
  /** 可选目标列表（3个） */
  targets: ReincarnationTarget[];
  /** 超时秒数（30分钟） */
  timeout_seconds: number;
}

/** 选定夺舍目标响应 */
export interface ChooseTargetResult {
  /** 是否夺舍成功 */
  success: boolean;
  /** 结果消息 */
  message: string;
  /** 夺舍前境界 */
  old_realm?: string;
  /** 夺舍后境界 */
  new_realm?: string;
  /** 夺舍前修为 */
  old_exp?: string;
  /** 夺舍后修为 */
  new_exp?: string;
  /** 继承的攻击力 */
  inherited_atk?: number;
  /** 继承的防御力 */
  inherited_def?: number;
  /** 继承的 HP 上限 */
  inherited_hp_max?: number;
  /** 当前残魂值（恢复至50） */
  remnant_soul: number;
  /** 冷却结束时间 */
  cooldown_end_time: string;
}

/** 夺舍记录 */
export interface ReincarnationRecord {
  id: number;
  player_id: number;
  /** 原境界 */
  origin_realm: string;
  /** 新境界 */
  new_realm: string;
  /** 死亡原因 */
  death_reason: string;
  /** 夺舍的目标名称 */
  target_name: string;
  /** 是否成功 */
  is_success: boolean;
  /** 继承的攻击力 */
  inherited_atk: number;
  /** 继承的防御力 */
  inherited_def: number;
  /** 夺舍时间 */
  reincarnated_at: string;
  /** 冷却结束时间 */
  cooldown_end_time: string;
}

/** 夺舍记录分页响应 */
export interface ReincarnationRecordsData {
  records: ReincarnationRecord[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

// ==================== GM 后台相关类型 ====================

/** 飞升系统全局统计 */
export interface AscensionStats {
  /** 已飞升玩家总数 */
  total_ascended: number;
  /** 飞升尝试总次数 */
  total_attempts: number;
  /** 飞升成功总次数 */
  total_success: number;
  /** 整体成功率（小数） */
  success_rate: number;
  /** 活跃空间节点数 */
  active_nodes: number;
  /** 状态分布 */
  state_distribution: {
    preparing: number;
    ascending: number;
    failed: number;
  };
}

/** 玩家飞升进度列表项 */
export interface PlayerAscensionListItem {
  id: number;
  player_id: number;
  nickname: string;
  realm: string;
  realm_rank: number;
  ascension_state: string;
  dayan_level: number;
  law_fragments_count: number;
  /** 逆灵通道坐标 */
  reverse_channel_coord: string | null;
  is_ascended: number;
  ascension_attempt_count: number;
  ascension_success_count: number;
  last_ascension_time: string | null;
}

/** 玩家飞升进度列表响应 */
export interface PlayerAscensionList {
  list: PlayerAscensionListItem[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

// ==================== 飞升玩家接口 ====================

/**
 * 获取飞升面板数据
 * GET /ascension/profile
 * 包含玩家基础信息、飞升档案、空间节点列表、成功率估算、前置条件检查
 */
export const getProfile = () => {
  return apiClient.get<ServiceResponse<AscensionProfileData>>('/ascension/profile');
};

/**
 * 搜寻空间节点
 * POST /ascension/search-node
 * CD 1 小时，从 node_pool 加权随机抽取
 */
export const searchNode = () => {
  return apiClient.post<ServiceResponse<SearchNodeResult>>('/ascension/search-node', {});
};

/**
 * 定星稳固节点
 * POST /ascension/stabilize-node
 * 消耗神识+灵石，稳固 30 分钟后获得奖励
 * @param nodeId 节点ID
 */
export const stabilizeNode = (nodeId: number) => {
  return apiClient.post<ServiceResponse<StabilizeNodeResult>>('/ascension/stabilize-node', { node_id: nodeId });
};

/**
 * 飞升灵界
 * POST /ascension/ascend
 * 满足前置条件后触发飞升，事务+行级锁保证原子性
 * 成功：飞升灵界（真仙境界）；失败：残魂-30、修为-10%、虚弱2小时
 */
export const ascend = () => {
  return apiClient.post<ServiceResponse<AscendResult>>('/ascension/ascend', {});
};

/**
 * 天机回溯
 * POST /ascension/revert
 * 每日1次，跨日重置，仅飞升失败后可用，回到飞升前状态
 */
export const revert = () => {
  return apiClient.post<ServiceResponse<RevertResult>>('/ascension/revert', {});
};

/**
 * 向天道问道
 * POST /ascension/ask-dao
 * 化神后期可解锁，每日3次、CD 30分钟，积累感悟值（10点感悟=1%飞升加成，最高20%）
 */
export const askDao = () => {
  return apiClient.post<ServiceResponse<AskDaoResult>>('/ascension/ask-dao', {});
};

/**
 * 修炼法相天地
 * POST /ascension/dharma-form
 * 9级数值表，每级 5% 全属性加成 + 2% 飞升成功率加成
 */
export const practiceDharmaForm = () => {
  return apiClient.post<ServiceResponse<DharmaFormResult>>('/ascension/dharma-form', {});
};

/**
 * 探寻虚空裂缝
 * POST /ascension/explore-fracture
 * 元婴初期可探寻，每日5次、CD 10分钟，15% 反噬概率
 */
export const exploreFracture = () => {
  return apiClient.post<ServiceResponse<ExploreFractureResult>>('/ascension/explore-fracture', {});
};

// ==================== 夺舍玩家接口 ====================

/**
 * 触发夺舍重生
 * POST /reincarnation/reborn
 * 飞升失败/寿命尽/PVP被杀时调用，推送3个目标按权重随机
 * @param deathReason 死亡原因：lifespan_out=寿元尽，pvp_kill=PVP被杀，breakthrough_fail=突破失败，ascension_fail=飞升失败
 */
export const triggerReincarnation = (deathReason: 'lifespan_out' | 'pvp_kill' | 'breakthrough_fail' | 'ascension_fail') => {
  return apiClient.post<ServiceResponse<TriggerReincarnationResult>>('/reincarnation/reborn', { death_reason: deathReason });
};

/**
 * 选定夺舍目标
 * POST /reincarnation/choose
 * 事务+行级锁，计算境界跌落、属性继承、残魂恢复至50、72小时冷却
 * @param targetId 目标ID
 */
export const chooseTarget = (targetId: number) => {
  return apiClient.post<ServiceResponse<ChooseTargetResult>>('/reincarnation/choose', { target_id: targetId });
};

/**
 * 获取夺舍历史记录
 * GET /reincarnation/records
 * @param page 页码（默认1）
 * @param pageSize 每页条数（默认10）
 */
export const getReincarnationRecords = (page: number = 1, pageSize: number = 10) => {
  return apiClient.get<ServiceResponse<ReincarnationRecordsData>>('/reincarnation/records', {
    params: { page, page_size: pageSize }
  });
};

// ==================== GM 后台接口 ====================

/**
 * GM 获取飞升系统全局统计
 * GET /admin/ascension/stats
 */
export const gmGetStats = () => {
  return apiClient.get<ServiceResponse<AscensionStats>>('/admin/ascension/stats');
};

/**
 * GM 获取玩家飞升进度列表
 * GET /admin/ascension/players
 * @param page 页码
 * @param pageSize 每页条数
 */
export const gmGetPlayerList = (page: number = 1, pageSize: number = 20) => {
  return apiClient.get<ServiceResponse<PlayerAscensionList>>('/admin/ascension/players', {
    params: { page, page_size: pageSize }
  });
};

/**
 * GM 调整玩家大衍诀层数
 * POST /admin/ascension/set-dayan-level
 * @param playerId 玩家ID
 * @param dayanLevel 大衍诀层数（0-5）
 */
export const gmSetDayanLevel = (playerId: number, dayanLevel: number) => {
  return apiClient.post<ServiceResponse>('/admin/ascension/set-dayan-level', {
    player_id: playerId,
    dayan_level: dayanLevel
  });
};

/**
 * GM 发放法则碎片
 * POST /admin/ascension/give-law-fragment
 * @param playerId 玩家ID
 * @param count 数量
 */
export const gmGiveLawFragment = (playerId: number, count: number) => {
  return apiClient.post<ServiceResponse>('/admin/ascension/give-law-fragment', {
    player_id: playerId,
    count
  });
};

/**
 * GM 发放逆灵通道坐标
 * POST /admin/ascension/give-coord
 * @param playerId 玩家ID
 * @param coord 坐标字符串（可选，不传则自动生成）
 */
export const gmGiveCoord = (playerId: number, coord?: string) => {
  return apiClient.post<ServiceResponse>('/admin/ascension/give-coord', {
    player_id: playerId,
    coord: coord || null
  });
};

/**
 * GM 重置玩家飞升冷却
 * POST /admin/ascension/reset-cooldown
 * @param playerId 玩家ID
 */
export const gmResetCooldown = (playerId: number) => {
  return apiClient.post<ServiceResponse>('/admin/ascension/reset-cooldown', {
    player_id: playerId
  });
};

/**
 * GM 获取夺舍目标列表
 * GET /admin/ascension/targets
 */
export const gmGetTargets = () => {
  return apiClient.get<ServiceResponse>('/admin/ascension/targets');
};

/**
 * GM 新增夺舍目标
 * POST /admin/ascension/targets
 */
export const gmCreateTarget = (target: {
  target_key: string;
  target_name: string;
  target_type: 'mortal' | 'cultivator' | 'monster';
  realm_rank: number;
  base_atk: number;
  base_def: number;
  base_hp_max: number;
  base_speed: number;
  base_sense: number;
  spirit_root_grade?: string;
  talent_id?: string;
  inherit_ratio?: number;
  drop_realm_count?: number;
  risk_level: 1 | 2 | 3;
  description?: string;
  weight?: number;
  is_rare?: boolean;
}) => {
  return apiClient.post<ServiceResponse>('/admin/ascension/targets', target);
};

/**
 * GM 编辑夺舍目标
 * PUT /admin/ascension/targets/:id
 * @param targetId 目标ID
 * @param updates 可更新字段
 */
export const gmUpdateTarget = (targetId: number, updates: Partial<{
  target_name: string;
  target_type: 'mortal' | 'cultivator' | 'monster';
  realm_rank: number;
  base_atk: number;
  base_def: number;
  base_hp_max: number;
  base_speed: number;
  base_sense: number;
  inherit_ratio: number;
  drop_realm_count: number;
  risk_level: 1 | 2 | 3;
  description: string;
  weight: number;
  is_rare: boolean;
}>) => {
  return apiClient.put<ServiceResponse>(`/admin/ascension/targets/${targetId}`, updates);
};