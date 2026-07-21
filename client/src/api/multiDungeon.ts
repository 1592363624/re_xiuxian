/**
 * 批次3 多人副本系统 API 客户端
 *
 * 统一封装批次3 多人副本系统的接口：
 *   1. 玩家路由（/api/multi-dungeon）：副本规则 / 开启 / 加入 / 进入 / 状态 / 抉择 / 投粽 / 解散 / 踢人 / 奖励池 / 历史 / 冷却
 *   2. GM 管理（/api/admin/multi-dungeon）：强制解散 / 调整变量 / 发放奖励 / 重置冷却
 *
 * 重要说明：
 *   - 后端统一返回 { code, success?, message, data, error_code? } 包装结构
 *   - 业务失败时 code=200 但 success=false，由前端组件按 message 提示
 *   - 所有方法返回 axios response，调用方通过 resp.data 取业务数据
 *   - 请求体字段一律使用 snake_case，与后端路由保持一致
 *
 * 对应后端路由文件：
 *   - server/routes/multi_dungeon.js
 *   - server/routes/admin_multi_dungeon.js
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
  /** 业务错误码（失败时返回，如 BUSINESS_LOGIC_ERROR） */
  error_code?: string;
}

// ==================== 副本基础类型 ====================

/** 副本 key（与后端配置对齐） */
// 2026-07-21 新增 xutian（虚天殿）
export type DungeonKey = 'yanyue' | 'duanwu' | 'kunwu' | 'xutian';

/** 副本实例状态 */
export type DungeonStatus = 'forming' | 'active' | 'choosing' | 'finished' | 'dissolved';

/** 副本变量名（GM 调整 / 前端进度条展示使用） */
export type DungeonVariable =
  | 'morale'              // 士气
  | 'vigilance'           // 警戒
  | 'demon_corruption'    // 魔染
  | 'seal_stability'      // 封印稳定度
  | 'soul_stability'      // 神魂稳定度
  | 'harvest_multiplier'  // 收获倍率
  // 昆吾山·封魔塔专属变量（2026-07-21 新增）
  | 'demonic_qi'          // 魔气值（0-100，>=100 失败）
  | 'mountain_seal'       // 山禁值（0-100）
  | 'treasure_pressure'   // 宝压值（0-100）/ 虚天殿·夺宝压力（0-100）
  | 'linglong'            // 玲珑值（0-100，越高决战伤害越高）
  | 'seal_progress'       // 封印推进值（第四幕，需>=80通关）
  | 'tower_shadow_hp'     // 塔心魔影HP（第四幕）
  // 虚天殿专属变量（2026-07-21 新增）
  | 'path_choice'         // 道路选择（0=未选 / 1=冰道 / 2=火道）
  | 'formation_power'     // 阵法强度（0-100，影响第六幕决战伤害）
  | 'void_soul_hp';       // 虚天主魂HP（第六幕，BIGINT 字符串）

/** 副本成员信息 */
export interface MultiDungeonMember {
  /** 玩家 ID */
  player_id: number;
  /** 玩家道号 */
  player_name: string;
  /** 玩家境界 */
  player_realm?: string;
  /** 是否为队长 */
  is_leader: boolean;
  /** 是否在线 */
  is_online?: boolean;
  /** 加入时间 */
  joined_at?: string;
  /** 当幕贡献 */
  contribution?: number;
}

/** 抉择选项（推进剧情时显示） */
export interface MultiDungeonChoice {
  /** 选项 key */
  choice_key: string;
  /** 选项名称 */
  name: string;
  /** 选项描述 */
  description?: string;
  /** 变量变化预览（key 为变量名，value 为变化值） */
  variable_changes?: Partial<Record<DungeonVariable, number>>;
  /** 是否为推荐选项 */
  is_recommended?: boolean;
}

/** 副本奖励条目 */
export interface MultiDungeonReward {
  /** 奖励 key */
  reward_key: string;
  /** 奖励名称 */
  name: string;
  /** 奖励类型：normal=普通掉落 / first_clear=首通奖励 / rare=稀有掉落 */
  type: 'normal' | 'first_clear' | 'rare';
  /** 奖励描述 */
  description?: string;
  /** 数量或概率（视后端定义） */
  amount?: number | string;
  /** 物品 key（如 type=item 时存在） */
  item_key?: string;
}

/** 副本冷却信息 */
export interface MultiDungeonCooldown {
  /** 副本 key */
  dungeon_key: DungeonKey;
  /** 副本中文名 */
  dungeon_name?: string;
  /** 是否处于冷却中 */
  in_cooldown: boolean;
  /** 剩余冷却秒数（不在冷却时为 0） */
  remaining_seconds: number;
  /** 冷却总时长（秒） */
  total_cooldown?: number;
  /** 上次完成时间 */
  last_finished_at?: string;
}

/** 副本实例详情 */
export interface MultiDungeonInstance {
  /** 实例 ID */
  instance_id: number;
  /** 副本 key */
  dungeon_key: DungeonKey;
  /** 副本中文名 */
  dungeon_name: string;
  /** 当前状态 */
  status: DungeonStatus;
  /** 当前幕数（第几幕） */
  current_act: number;
  /** 总幕数 */
  total_acts?: number;
  /** 队长玩家 ID */
  leader_player_id: number;
  /** 队长道号 */
  leader_player_name?: string;
  /** 成员列表 */
  members: MultiDungeonMember[];
  /** 副本变量（key 为变量名，value 为当前值） */
  variables?: Partial<Record<DungeonVariable, number>>;
  /** 当前幕可选项 */
  current_choices?: MultiDungeonChoice[];
  /** 当前幕剧情描述 */
  current_act_description?: string;
  /** 创建时间 */
  created_at?: string;
  /** 结束时间（已结束时存在） */
  finished_at?: string;
  /** 是否为当前玩家为队长 */
  is_leader?: boolean;
  /** 是否为当前玩家已加入 */
  is_member?: boolean;
  // 昆吾山·封魔塔专属字段（2026-07-21 新增）
  /** 当前幕是否为自动决战幕（昆吾山第四幕 / 虚天殿第六幕，调用 /advance 推进） */
  is_auto_advance?: boolean;
  /** 自动决战最大回合数（is_auto_advance=true 时存在；昆吾山=5 / 虚天殿=6） */
  rounds_max?: number;
  /** 第三幕阵眼进度（is_multi_choice_act=true 时存在） */
  multi_choice_progress?: {
    finished_count: number;
    total_count: number;
    next_eye_key: string | null;
    next_eye_name: string | null;
    next_eye_choices: MultiDungeonChoice[];
  };
  /** 历史抉择记录（含阵眼键、回合数等审计信息） */
  history_choices?: Array<{
    act_number: number;
    choice_text: string;
    eye_key?: string | null;
    round_number?: number | null;
  }>;
}

// ==================== 各接口响应数据类型 ====================

/** GET /multi-dungeon/help 响应数据 */
export interface MultiDungeonHelpData {
  /** 副本规则说明（多段文本） */
  rules: string[];
  /** 副本列表概要 */
  dungeons: Array<{
    dungeon_key: DungeonKey;
    name: string;
    description: string;
    min_players: number;
    max_players: number;
    realm_required: string;
    duration_text?: string;
  }>;
}

/** POST /multi-dungeon/create 响应数据 */
export interface MultiDungeonCreateResult {
  /** 新建的实例 ID */
  instance_id: number;
  /** 副本 key */
  dungeon_key: DungeonKey;
  /** 副本名 */
  dungeon_name: string;
  /** 创建结果描述 */
  message: string;
}

/** POST /multi-dungeon/join 响应数据 */
export interface MultiDungeonJoinResult {
  /** 实例 ID */
  instance_id: number;
  /** 副本名 */
  dungeon_name: string;
  /** 加入结果描述 */
  message: string;
}

/** POST /multi-dungeon/enter 响应数据 */
export interface MultiDungeonEnterResult {
  /** 实例 ID */
  instance_id: number;
  /** 当前幕数 */
  current_act: number;
  /** 当前幕剧情描述 */
  current_act_description?: string;
  /** 进入开打结果描述 */
  message: string;
}

/** GET /multi-dungeon/status 响应数据 */
export interface MultiDungeonStatusData {
  /** 当前玩家是否参与副本 */
  has_instance: boolean;
  /** 副本实例详情（无副本时为 null） */
  instance: MultiDungeonInstance | null;
}

/** POST /multi-dungeon/choose 响应数据 */
export interface MultiDungeonChooseResult {
  /** 实例 ID */
  instance_id: number;
  /** 已推进到的幕数 */
  current_act: number;
  /** 下一幕剧情描述 */
  next_act_description?: string;
  /** 下一幕可选项 */
  next_choices?: MultiDungeonChoice[];
  /** 副本是否已结束 */
  is_finished: boolean;
  /** 抉择结果描述 */
  message: string;
  /** 抉择产生的奖励列表（结束时存在） */
  rewards?: MultiDungeonReward[];
}

/** 昆吾山第四幕自动决战回合日志 */
export interface KunwuRoundLog {
  /** 回合数（1-5） */
  round: number;
  /** 本回合造成伤害（字符串形式的 BIGINT） */
  damage: string;
  /** 本回合前塔心魔影HP */
  tower_shadow_hp_before: string;
  /** 本回合后塔心魔影HP */
  tower_shadow_hp_after: string;
  /** 本回合后封印推进值 */
  seal_progress_after: number;
  /** 本回合后魔气值 */
  demonic_qi_after: number;
  /** 本回合后士气值 */
  morale_after: number;
}

/** 虚天殿第六幕自动决战回合日志（2026-07-21 新增） */
export interface XutianRoundLog {
  /** 回合数（1-6） */
  round: number;
  /** 本回合造成伤害（字符串形式的 BIGINT） */
  damage: string;
  /** 本回合前虚天主魂HP（字符串形式的 BIGINT） */
  void_soul_hp_before: string;
  /** 本回合后虚天主魂HP（字符串形式的 BIGINT） */
  void_soul_hp_after: string;
  /** 本回合后阵法强度（0-100） */
  formation_power_after: number;
  /** 本回合后士气值 */
  morale_after: number;
}

/** POST /multi-dungeon/advance 响应数据（昆吾山第四幕 / 虚天殿第六幕自动决战） */
// 2026-07-21 扩展：支持虚天殿第六幕决战
export interface MultiDungeonAdvanceResult {
  /** 实例 ID */
  instance_id: number;
  /** 副本最终状态：cleared=通关 / failed=失败 */
  instance_state: 'cleared' | 'failed';
  /** 自动战斗详情（昆吾山/虚天殿共用，rounds_log 按副本类型区分字段） */
  auto_battle: {
    /** 战斗结果 */
    outcome: 'cleared' | 'failed';
    /** 实际战斗回合数（昆吾山 1-5 / 虚天殿 1-6） */
    rounds_total: number;
    /**
     * 回合日志
     * - kunwu（昆吾山）：包含 tower_shadow_hp_* / seal_progress_after / demonic_qi_after 字段
     * - xutian（虚天殿）：包含 void_soul_hp_* / formation_power_after 字段
     * 前端可通过 instance.dungeon_key 判断取哪个字段
     */
    rounds_log: KunwuRoundLog[] | XutianRoundLog[];
    /** 失败原因（cleared 时为 null） */
    fail_reason?: string | null;
  };
  /** 奖励摘要（仅通关时返回） */
  rewards?: MultiDungeonReward[];
  /** 结果描述 */
  message: string;
}

/** POST /multi-dungeon/throw-zongzi 响应数据 */
export interface MultiDungeonThrowZongziResult {
  /** 实例 ID */
  instance_id: number;
  /** 本次投粽数量 */
  count: number;
  /** 端午副本变量变化（如封印稳定度提升） */
  variable_changes?: Partial<Record<DungeonVariable, number>>;
  /** 投粽结果描述 */
  message: string;
}

/** POST /multi-dungeon/dissolve 响应数据 */
export interface MultiDungeonDissolveResult {
  /** 实例 ID */
  instance_id: number;
  /** 解散结果描述 */
  message: string;
}

/** POST /multi-dungeon/kick 响应数据 */
export interface MultiDungeonKickResult {
  /** 实例 ID */
  instance_id: number;
  /** 被踢玩家 ID */
  target_player_id: number;
  /** 踢人结果描述 */
  message: string;
}

/** GET /multi-dungeon/rewards 响应数据 */
export interface MultiDungeonRewardsData {
  /** 副本 key */
  dungeon_key: DungeonKey;
  /** 副本名 */
  dungeon_name: string;
  /** 普通掉落列表 */
  normal_rewards: MultiDungeonReward[];
  /** 首通奖励列表 */
  first_clear_rewards: MultiDungeonReward[];
  /** 稀有掉落列表 */
  rare_rewards: MultiDungeonReward[];
}

/** GET /multi-dungeon/history 响应数据 */
export interface MultiDungeonHistoryData {
  /** 历史记录列表 */
  list: Array<{
    /** 记录 ID */
    id: number;
    /** 实例 ID */
    instance_id: number;
    /** 副本 key */
    dungeon_key: DungeonKey;
    /** 副本名 */
    dungeon_name: string;
    /** 完成结果：success=成功 / fail=失败 / dissolved=解散 */
    result: 'success' | 'fail' | 'dissolved';
    /** 到达幕数 */
    reached_act?: number;
    /** 总幕数 */
    total_acts?: number;
    /** 是否为首通 */
    is_first_clear?: boolean;
    /** 获得奖励（精简列表） */
    rewards?: Array<{ name: string; amount?: number | string }>;
    /** 完成时间 */
    finished_at: string;
  }>;
  /** 总记录数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页大小 */
  page_size: number;
  /** 总页数 */
  total_pages: number;
}

/** GET /multi-dungeon/cooldown 响应数据 */
export interface MultiDungeonCooldownData {
  /** 冷却列表（含两个副本） */
  cooldowns: MultiDungeonCooldown[];
}

// ==================== 玩家接口（12 个，全部 /multi-dungeon 下） ====================

/**
 * 获取副本规则说明
 * GET /multi-dungeon/help
 * 含副本列表 / 人数要求 / 境界要求 / 规则文本
 */
export const multiDungeonGetHelp = () => {
  return apiClient.get<ServiceResponse<MultiDungeonHelpData>>('/multi-dungeon/help');
};

/**
 * 队长开启副本
 * POST /multi-dungeon/create
 * @param dungeonKey 副本 key：yanyue=掩月抢亲 / duanwu=端午镇蛟 / kunwu=昆吾山·封魔塔 / xutian=虚天殿
 */
export const multiDungeonCreate = (dungeonKey: DungeonKey) => {
  return apiClient.post<ServiceResponse<MultiDungeonCreateResult>>('/multi-dungeon/create', {
    dungeon_key: dungeonKey
  });
};

/**
 * 队员加入副本
 * POST /multi-dungeon/join
 * @param instanceId 实例 ID
 */
export const multiDungeonJoin = (instanceId: number) => {
  return apiClient.post<ServiceResponse<MultiDungeonJoinResult>>('/multi-dungeon/join', {
    instance_id: instanceId
  });
};

/**
 * 队长进入开打
 * POST /multi-dungeon/enter
 * 仅队长可调用，进入后开启第一幕剧情
 */
export const multiDungeonEnter = () => {
  return apiClient.post<ServiceResponse<MultiDungeonEnterResult>>('/multi-dungeon/enter', {});
};

/**
 * 查看当前副本进度
 * GET /multi-dungeon/status
 * 含实例详情 / 成员 / 变量 / 当前幕抉择
 */
export const multiDungeonGetStatus = () => {
  return apiClient.get<ServiceResponse<MultiDungeonStatusData>>('/multi-dungeon/status');
};

/**
 * 队长推进抉择
 * POST /multi-dungeon/choose
 * @param choiceKey 选项 key（来自 current_choices）
 */
export const multiDungeonChoose = (choiceKey: string) => {
  return apiClient.post<ServiceResponse<MultiDungeonChooseResult>>('/multi-dungeon/choose', {
    choice_key: choiceKey
  });
};

/**
 * 队长触发自动决战（昆吾山第四幕 / 虚天殿第六幕通用）
 * POST /multi-dungeon/advance
 * 一次性结算自动战斗，不可中途干预
 * - 昆吾山：5 回合，每回合伤害 = 200000 + 玲珑值 × 2000
 * - 虚天殿：6 回合，每回合伤害 = 180000 + 阵法强度 × 2500
 * 仅在当前幕标记 is_auto_advance 时允许调用
 */
export const multiDungeonAdvance = () => {
  return apiClient.post<ServiceResponse<MultiDungeonAdvanceResult>>('/multi-dungeon/advance', {});
};

/**
 * 端午投粽
 * POST /multi-dungeon/throw-zongzi
 * @param count 投粽数量（1-5）
 */
export const multiDungeonThrowZongzi = (count: number) => {
  return apiClient.post<ServiceResponse<MultiDungeonThrowZongziResult>>('/multi-dungeon/throw-zongzi', {
    count
  });
};

/**
 * 队长解散副本
 * POST /multi-dungeon/dissolve
 * 仅队长可调用，解散后所有成员退出
 */
export const multiDungeonDissolve = () => {
  return apiClient.post<ServiceResponse<MultiDungeonDissolveResult>>('/multi-dungeon/dissolve', {});
};

/**
 * 队长踢人
 * POST /multi-dungeon/kick
 * @param targetPlayerId 被踢玩家 ID
 */
export const multiDungeonKick = (targetPlayerId: number) => {
  return apiClient.post<ServiceResponse<MultiDungeonKickResult>>('/multi-dungeon/kick', {
    target_player_id: targetPlayerId
  });
};

/**
 * 查看奖励池
 * GET /multi-dungeon/rewards
 * @param dungeonKey 副本 key：yanyue / duanwu / kunwu / xutian
 */
export const multiDungeonGetRewards = (dungeonKey: DungeonKey) => {
  return apiClient.get<ServiceResponse<MultiDungeonRewardsData>>('/multi-dungeon/rewards', {
    params: { dungeon_key: dungeonKey }
  });
};

/**
 * 历史副本记录
 * GET /multi-dungeon/history
 * @param page 页码（默认 1）
 * @param size 每页数量（默认 20）
 */
export const multiDungeonGetHistory = (page: number = 1, size: number = 20) => {
  return apiClient.get<ServiceResponse<MultiDungeonHistoryData>>('/multi-dungeon/history', {
    params: { page, size }
  });
};

/**
 * 查询冷却状态
 * GET /multi-dungeon/cooldown
 * 含两个副本的冷却信息
 */
export const multiDungeonGetCooldown = () => {
  return apiClient.get<ServiceResponse<MultiDungeonCooldownData>>('/multi-dungeon/cooldown');
};

// ==================== GM 后台接口（4 个，全部 /admin/multi-dungeon 下） ====================

/**
 * GM 强制解散副本
 * POST /admin/multi-dungeon/force-dissolve
 * @param instanceId 实例 ID
 */
export const adminForceDissolve = (instanceId: number) => {
  return apiClient.post<ServiceResponse>('/admin/multi-dungeon/force-dissolve', {
    instance_id: instanceId
  });
};

/**
 * GM 调整副本变量
 * POST /admin/multi-dungeon/adjust-variable
 * @param instanceId 实例 ID
 * @param variable 变量名：morale/vigilance/demon_corruption/seal_stability/soul_stability/harvest_multiplier
 * @param value 新值
 */
export const adminAdjustVariable = (
  instanceId: number,
  variable: DungeonVariable,
  value: number
) => {
  return apiClient.post<ServiceResponse>('/admin/multi-dungeon/adjust-variable', {
    instance_id: instanceId,
    variable,
    value
  });
};

/**
 * GM 直接发放副本奖励
 * POST /admin/multi-dungeon/grant-reward
 * @param playerId 玩家 ID
 * @param dungeonKey 副本 key：yanyue / duanwu / kunwu / xutian
 * @param rewardKey 奖励 key（来自奖励池配置）
 */
export const adminGrantReward = (
  playerId: number,
  dungeonKey: DungeonKey,
  rewardKey: string
) => {
  return apiClient.post<ServiceResponse>('/admin/multi-dungeon/grant-reward', {
    player_id: playerId,
    dungeon_key: dungeonKey,
    reward_key: rewardKey
  });
};

/**
 * GM 重置玩家冷却
 * POST /admin/multi-dungeon/reset-cooldown
 * @param playerId 玩家 ID
 * @param dungeonKey 副本 key：yanyue / duanwu / kunwu / xutian（也可传 'all' 重置全部，由后端处理）
 */
export const adminResetCooldown = (playerId: number, dungeonKey: DungeonKey | 'all') => {
  return apiClient.post<ServiceResponse>('/admin/multi-dungeon/reset-cooldown', {
    player_id: playerId,
    dungeon_key: dungeonKey
  });
};
