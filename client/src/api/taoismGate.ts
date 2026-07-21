/**
 * 太一门引道系统 API 客户端
 *
 * 统一封装太一门引道系统的9个接口（路由前缀：/api/taoism-gate）：
 *   1. GET  /profile       - 获取道途面板（道途/等级/经验/神识/技能/任务/共鸣/统计）
 *   2. POST /choose        - 选择道途（首次选择，免费，需境界rank 18+神识200+）
 *   3. POST /switch        - 切换道途（每月1次免费，之后消耗100五行法则碎片，7天冷却）
 *   4. POST /cultivate     - 引道修炼（消耗50神识获得道途经验，每日5次上限）
 *   5. POST /skill         - 使用道途技能（金锋裂魂/木灵回春/水镜映心/火眼金睛/土牢定身）
 *   6. GET  /tasks         - 获取今日任务（3个随机任务，跨日重置）
 *   7. POST /tasks/claim   - 领取任务奖励
 *   8. GET  /ranking       - 获取道途排行榜（dao_level/total_skill_use/total_resonance）
 *   9. GET  /resonance     - 查询道途共鸣状态（同道途玩家数+共鸣加成+相克道途）
 *
 * 重要说明：
 *   - 后端统一返回 { code, success?, message, data, error_code? } 包装结构
 *   - 业务失败时 code=400 且 success=false，由前端组件按 message 提示
 *   - 所有方法返回 axios response，调用方通过 resp.data 取业务数据
 *   - 请求体字段一律使用 snake_case，与后端路由保持一致
 *
 * 对应后端路由文件：
 *   - server/routes/taoism_gate.js
 *   - server/game/services/TaoismGateService.js
 *   - 配置文件：server/config/taoism_gate_data.json
 */
import apiClient from './index';

// ==================== 通用类型 ====================

/** 通用业务响应包装（与 multiDungeon.ts 保持一致） */
export interface ServiceResponse<T> {
  /** HTTP 业务码（200=正常，400=业务失败） */
  code: number;
  /** 业务是否成功（失败时返回 false） */
  success?: boolean;
  /** 业务消息（成功/失败描述） */
  message?: string;
  /** 业务数据 */
  data: T | null;
  /** 业务错误码（失败时返回，如 BUSINESS_LOGIC_ERROR） */
  error_code?: string;
}

// ==================== 道途基础类型 ====================

/**
 * 五行道途类型
 * - metal：金道·锐金（神识攻击 + 金锋裂魂）
 * - wood：木道·长生（灵兽HP恢复 + 木灵回春）
 * - water：水道·玄水（神识防御 + 水镜映心）
 * - fire：火道·焚天（炼化效率 + 火眼金睛）
 * - earth：土道·厚土（法则转换 + 土牢定身）
 */
export type DaoPath = 'metal' | 'wood' | 'water' | 'fire' | 'earth';

/**
 * 道途中文名映射
 * 用于前端展示，避免硬编码到模板中
 */
export const DAO_PATH_NAME_MAP: Record<DaoPath, string> = {
  metal: '金道',
  wood: '木道',
  water: '水道',
  fire: '火道',
  earth: '土道'
};

/**
 * 道途主题色映射（Tailwind 工具类配置，用于卡片/边框/文字配色）
 * 五行配色：金=黄色、木=绿色、水=蓝色、火=红色、土=棕色
 */
export const DAO_PATH_THEME_MAP: Record<DaoPath, {
  /** 卡片背景类 */
  cardBg: string;
  /** 边框类 */
  border: string;
  /** 主文字色 */
  text: string;
  /** 徽章背景+边框 */
  badge: string;
  /** 按钮背景类 */
  button: string;
  /** 进度条渐变 */
  bar: string;
}> = {
  metal: {
    cardBg: 'bg-yellow-950/30',
    border: 'border-yellow-700',
    text: 'text-yellow-300',
    badge: 'bg-yellow-950/60 text-yellow-300 border-yellow-800',
    button: 'bg-yellow-800 hover:bg-yellow-700 text-yellow-100',
    bar: 'bg-gradient-to-r from-yellow-700 to-yellow-400'
  },
  wood: {
    cardBg: 'bg-emerald-950/30',
    border: 'border-emerald-700',
    text: 'text-emerald-300',
    badge: 'bg-emerald-950/60 text-emerald-300 border-emerald-800',
    button: 'bg-emerald-800 hover:bg-emerald-700 text-emerald-100',
    bar: 'bg-gradient-to-r from-emerald-700 to-emerald-400'
  },
  water: {
    cardBg: 'bg-sky-950/30',
    border: 'border-sky-700',
    text: 'text-sky-300',
    badge: 'bg-sky-950/60 text-sky-300 border-sky-800',
    button: 'bg-sky-800 hover:bg-sky-700 text-sky-100',
    bar: 'bg-gradient-to-r from-sky-700 to-sky-400'
  },
  fire: {
    cardBg: 'bg-rose-950/30',
    border: 'border-rose-700',
    text: 'text-rose-300',
    badge: 'bg-rose-950/60 text-rose-300 border-rose-800',
    button: 'bg-rose-800 hover:bg-rose-700 text-rose-100',
    bar: 'bg-gradient-to-r from-rose-700 to-rose-400'
  },
  earth: {
    cardBg: 'bg-stone-900/40',
    border: 'border-amber-700',
    text: 'text-amber-300',
    badge: 'bg-amber-950/60 text-amber-300 border-amber-800',
    button: 'bg-amber-800 hover:bg-amber-700 text-amber-100',
    bar: 'bg-gradient-to-r from-amber-700 to-amber-500'
  }
};

/** 排行榜类别 */
export type RankingCategory = 'dao_level' | 'total_skill_use' | 'total_resonance';

// ==================== 各接口响应数据类型 ====================

/** 道途技能信息（GET /profile 中 skills 数组元素） */
export interface TaoismSkillInfo {
  /** 技能 ID（metal_blade/wood_heal/water_mirror/fire_eye/earth_prison） */
  skill_id: string;
  /** 技能名称 */
  skill_name: string;
  /** 技能描述 */
  skill_description: string;
  /** 神识消耗量 */
  skill_divine_sense_cost: number;
  /** 冷却时长（小时） */
  skill_cooldown_hours: number;
  /** 解锁所需道途等级 */
  skill_min_level: number;
  /** 当前是否可使用（等级达标 + 神识充足 + 未冷却） */
  can_use: boolean;
  /** 冷却结束时间（ISO 字符串，null 表示未冷却） */
  cooldown_end: string | null;
  /** 是否已锁定（道途等级未达 skill_min_level） */
  is_locked: boolean;
}

/** 道途被动加成（GET /profile 中 gate.passive_bonus） */
export interface TaoismPassiveBonus {
  /** 加成类型（attack_percent/hp_recover_percent/defense_percent/craft_efficiency_percent/law_convert_percent） */
  type: string;
  /** 加成数值（如 0.25 表示 25%） */
  value: number;
  /** 加成描述 */
  description: string;
}

/** 道途共鸣信息（GET /profile 中 resonance） */
export interface TaoismResonanceInfo {
  /** 同道途玩家总数 */
  same_path_player_count: number;
  /** 共鸣加成（0-0.5） */
  resonance_bonus: number;
  /** 相克道途 key 列表（如金道克木道，restraint_targets=['wood']） */
  restraint_targets: DaoPath[];
}

/** 道途统计信息（GET /profile 中 stats） */
export interface TaoismStatsInfo {
  /** 累计修炼次数 */
  total_cultivate_count: number;
  /** 累计技能使用次数 */
  total_skill_use_count: number;
  /** 累计共鸣次数 */
  total_resonance_count: number;
}

/** 道途面板核心信息（GET /profile 中 gate） */
export interface TaoismGateInfo {
  /** 当前道途 key（未选择时为 null） */
  dao_path: DaoPath | null;
  /** 道途中文名（未选择时为"未选择道途"） */
  dao_path_name: string;
  /** 道途描述 */
  dao_path_description: string;
  /** 道途主题色（hex 字符串，如 #FFD700） */
  dao_path_color: string;
  /** 道途等级（0-10） */
  dao_level: number;
  /** 道途等级标题（如"初窥门径"/"道心初显"） */
  dao_level_title: string;
  /** 当前道途经验 */
  dao_exp: number;
  /** 升至下一级所需经验 */
  next_level_exp: number;
  /** 被动加成信息（未选择道途时为 null） */
  passive_bonus: TaoismPassiveBonus | null;
}

/** 神识信息（GET /profile 中 divine_sense） */
export interface TaoismDivineSenseInfo {
  /** 当前神识值 */
  current: number;
  /** 神识上限 */
  max: number;
}

/** GET /profile 响应数据 */
export interface TaoismProfileData {
  /** 道途核心信息 */
  gate: TaoismGateInfo;
  /** 神识信息 */
  divine_sense: TaoismDivineSenseInfo;
  /** 道途技能列表（每种道途仅1个技能） */
  skills: TaoismSkillInfo[];
  /** 日常任务列表（未选择道途时为空数组） */
  daily_tasks: TaoismTaskInfo[];
  /** 共鸣信息 */
  resonance: TaoismResonanceInfo;
  /** 累计统计 */
  stats: TaoismStatsInfo;
}

/** POST /choose 响应数据 */
export interface TaoismChooseResult {
  /** 已选择的道途 key */
  dao_path: DaoPath;
  /** 道途中文名 */
  dao_path_name: string;
  /** 初始道途等级（始终为 1） */
  dao_level: number;
  /** 被动加成描述 */
  passive_bonus: string;
}

/** POST /switch 响应数据 */
export interface TaoismSwitchResult {
  /** 新道途 key */
  dao_path: DaoPath;
  /** 新道途中文名 */
  dao_path_name: string;
  /** 新道途等级（切换后重置为 1） */
  dao_level: number;
  /** 保留的道途经验（旧经验的 50%） */
  dao_exp: number;
  /** 消耗的法则碎片数（免费切换时为 0） */
  fragment_consumed: number;
}

/** POST /cultivate 响应数据 */
export interface TaoismCultivateResult {
  /** 本次获得道途经验 */
  exp_gained: number;
  /** 当前道途经验 */
  dao_exp: number;
  /** 当前道途等级 */
  dao_level: number;
  /** 是否升级 */
  leveled_up: boolean;
  /** 升级后的新等级（未升级时为当前等级） */
  new_level: number;
  /** 剩余神识值 */
  divine_sense_left: number;
}

/** POST /skill 响应数据 */
export interface TaoismSkillResult {
  /** 技能 ID */
  skill_id: string;
  /** 技能名称 */
  skill_name: string;
  /** 技能效果结果（后端返回的详细效果对象） */
  skill_result: Record<string, any>;
  /** 本次使用获得的道途经验 */
  exp_gained: number;
  /** 剩余神识值 */
  divine_sense_left: number;
  /** 冷却结束时间（ISO 字符串） */
  cooldown_end: string;
}

/** 日常任务信息（GET /tasks 中 tasks 数组元素） */
export interface TaoismTaskInfo {
  /** 任务类型（cultivate/use_skill/resonance） */
  task_type: string;
  /** 任务名称 */
  task_name: string;
  /** 任务描述 */
  task_description: string;
  /** 目标次数 */
  target_count: number;
  /** 当前进度 */
  current_count: number;
  /** 是否已完成 */
  completed: boolean;
  /** 奖励是否已领取 */
  rewards_claimed: boolean;
  /** 奖励配置 */
  rewards: {
    /** 道途经验奖励 */
    dao_exp?: number;
    /** 神识奖励 */
    divine_sense?: number;
    /** 五行法则碎片奖励 */
    law_fragment_five_elements?: number;
  };
}

/** GET /tasks 响应数据 */
export interface TaoismTasksData {
  /** 今日任务列表（未选择道途时为空数组） */
  tasks: TaoismTaskInfo[];
  /** 任务重置时间（ISO 字符串） */
  reset_time?: string;
  /** 提示消息（未选择道途时返回） */
  message?: string;
}

/** POST /tasks/claim 响应数据 */
export interface TaoismClaimResult {
  /** 任务名称 */
  task_name: string;
  /** 实际发放的奖励 */
  rewards: {
    dao_exp?: number;
    divine_sense?: number;
    law_fragment_five_elements?: number;
  };
}

/** 排行榜条目（GET /ranking 中 rankings 数组元素） */
export interface TaoismRankingEntry {
  /** 排名（1-based） */
  rank: number;
  /** 玩家 ID */
  player_id: number;
  /** 玩家昵称 */
  player_nickname: string;
  /** 道途 key */
  dao_path: DaoPath;
  /** 道途中文名 */
  dao_path_name: string;
  /** 道途等级 */
  dao_level: number;
  /** 排行数值（按 category 不同：dao_level/total_skill_use_count/total_resonance_count） */
  value: number;
}

/** GET /ranking 响应数据 */
export interface TaoismRankingData {
  /** 排行类别 */
  category: RankingCategory;
  /** 排行列表 */
  rankings: TaoismRankingEntry[];
  /** 总记录数 */
  total: number;
  /** 当前页码 */
  current_page: number;
  /** 总页数 */
  total_pages: number;
}

/** 相克道途信息（GET /resonance 中 restraint_targets 元素，后端实际返回字符串数组，前端展示时映射为中文名） */
export interface TaoismCounterPath {
  /** 道途 key */
  dao_path: DaoPath;
  /** 道途中文名 */
  dao_path_name: string;
}

/** GET /resonance 响应数据 */
export interface TaoismResonanceData {
  /** 当前道途 key（未选择道途时无此字段） */
  dao_path?: DaoPath;
  /** 当前道途中文名 */
  dao_path_name?: string;
  /** 同道途玩家总数 */
  same_path_total: number;
  /** 同道途高等级玩家数（5级以上） */
  same_path_advanced: number;
  /** 共鸣加成（0-0.5） */
  resonance_bonus: number;
  /** 共鸣描述（如"同道途 5 人，共鸣加成 50%"） */
  resonance_description: string;
  /** 相克道途 key 列表（后端返回字符串数组） */
  restraint_targets: DaoPath[];
  /** 提示消息（未选择道途时返回） */
  message?: string;
}

// ==================== 玩家接口（9 个，全部 /taoism-gate 下） ====================

/**
 * 获取道途面板
 * GET /taoism-gate/profile
 * 含道途/等级/经验/神识/技能/任务/共鸣/统计
 */
export const taoismGateGetProfile = () => {
  return apiClient.get<ServiceResponse<TaoismProfileData>>('/taoism-gate/profile');
};

/**
 * 选择道途（首次选择，免费）
 * POST /taoism-gate/choose
 * 校验：境界≥元婴期(rank 18) + 神识≥200 + 未选择过道途
 * @param daoPath 道途 key：metal=金道 / wood=木道 / water=水道 / fire=火道 / earth=土道
 */
export const taoismGateChoose = (daoPath: DaoPath) => {
  return apiClient.post<ServiceResponse<TaoismChooseResult>>('/taoism-gate/choose', {
    dao_path: daoPath
  });
};

/**
 * 切换道途（每月1次免费，之后消耗100五行法则碎片，7天冷却）
 * POST /taoism-gate/switch
 * 切换后等级重置为1，保留50%经验
 * @param daoPath 新道途 key
 */
export const taoismGateSwitch = (daoPath: DaoPath) => {
  return apiClient.post<ServiceResponse<TaoismSwitchResult>>('/taoism-gate/switch', {
    dao_path: daoPath
  });
};

/**
 * 引道修炼（消耗50神识获得道途经验，每日5次上限）
 * POST /taoism-gate/cultivate
 * 经验 = 基础100 + 神识上限×0.5
 */
export const taoismGateCultivate = () => {
  return apiClient.post<ServiceResponse<TaoismCultivateResult>>('/taoism-gate/cultivate', {});
};

/**
 * 使用道途技能
 * POST /taoism-gate/skill
 * 五行技能：金锋裂魂/木灵回春/水镜映心/火眼金睛/土牢定身
 * @param targetPlayerId 目标玩家 ID（攻击/探查/定身类技能需要，恢复类传 undefined）
 * @param targetBeastId 目标灵兽 ID（攻击/定身类技能需要）
 */
export const taoismGateUseSkill = (
  targetPlayerId?: number,
  targetBeastId?: number
) => {
  return apiClient.post<ServiceResponse<TaoismSkillResult>>('/taoism-gate/skill', {
    target_player_id: targetPlayerId,
    target_beast_id: targetBeastId
  });
};

/**
 * 获取今日任务
 * GET /taoism-gate/tasks
 * 含3个随机任务（修炼/技能/共鸣），跨日重置
 */
export const taoismGateGetTasks = () => {
  return apiClient.get<ServiceResponse<TaoismTasksData>>('/taoism-gate/tasks');
};

/**
 * 领取任务奖励
 * POST /taoism-gate/tasks/claim
 * @param taskIndex 任务索引（0-based）
 */
export const taoismGateClaimTask = (taskIndex: number) => {
  return apiClient.post<ServiceResponse<TaoismClaimResult>>('/taoism-gate/tasks/claim', {
    task_index: taskIndex
  });
};

/**
 * 获取道途排行榜
 * GET /taoism-gate/ranking
 * @param category 排行类别：dao_level=道途等级 / total_skill_use=技能使用次数 / total_resonance=共鸣次数
 * @param page 页码（默认 1）
 * @param pageSize 每页数量（默认 20）
 */
export const taoismGateGetRanking = (
  category: RankingCategory = 'dao_level',
  page: number = 1,
  pageSize: number = 20
) => {
  return apiClient.get<ServiceResponse<TaoismRankingData>>('/taoism-gate/ranking', {
    params: { category, page, page_size: pageSize }
  });
};

/**
 * 查询道途共鸣状态
 * GET /taoism-gate/resonance
 * 含同道途玩家数/高等级玩家数/共鸣加成/相克道途
 */
export const taoismGateGetResonance = () => {
  return apiClient.get<ServiceResponse<TaoismResonanceData>>('/taoism-gate/resonance');
};
