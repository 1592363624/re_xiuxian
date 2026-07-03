/**
 * 宗门系统相关 API
 *
 * 封装宗门系统的全部前端调用：宗门列表/详情、拜入/叛出、
 * 每日点卯、宗门传功、宝库兑换、宗门日常任务等。
 *
 * 设计说明：
 *   - 所有接口复用统一 apiClient（已注入 JWT 鉴权与统一错误处理）
 *   - 业务参数命名与后端路由保持一致（sect_id / treasure_id / quest_id）
 *   - TypeScript 接口与后端 sect_data.json / SectService 返回结构对齐
 */
import apiClient from './index';

/**
 * 宗门加入要求
 */
export interface JoinRequirement {
  /** 最低境界名（如"炼气初期"） */
  realm_min: string;
  /** 拜入所需灵石 */
  spirit_stones: number;
}

/**
 * 宗门加成配置（不同宗门加成字段不同，全部可选）
 */
export interface SectBonus {
  /** 修为获取倍率 */
  exp_multiplier?: number;
  /** 采集产出加成 */
  gather_bonus?: number;
  /** 感知倍率 */
  sense_multiplier?: number;
  /** 突破成功率加成 */
  breakthrough_bonus?: number;
  /** 幸运加成 */
  luck_bonus?: number;
  /** 攻击倍率 */
  atk_multiplier?: number;
  /** 魔道功法加成 */
  dark_arts_bonus?: number;
  /** 魅惑加成 */
  charm_bonus?: number;
  /** 灵力倍率 */
  mp_multiplier?: number;
  /** 道心强度加成 */
  mental_strength?: number;
}

/**
 * 宗门基础信息（列表项）
 * 对应后端 GET /sect/list 中每个 sect 对象
 */
export interface Sect {
  /** 宗门ID（如 luoyun） */
  id: string;
  /** 宗门名称 */
  name: string;
  /** 宗门描述 */
  description: string;
  /** 阵营：正道 / 魔道 */
  alignment: '正道' | '魔道';
  /** 五行属性：金/木/水/火/土 */
  element: string;
  /** 加入要求 */
  join_requirement: JoinRequirement;
  /** 宗门加成 */
  bonus: SectBonus;
}

/**
 * 宗门宝库物品
 */
export interface TreasuryItem {
  /** 物品ID */
  id: string;
  /** 物品名称 */
  name: string;
  /** 物品 key（关联背包系统） */
  item_key: string;
  /** 兑换所需贡献度 */
  cost: number;
  /** 物品描述 */
  description: string;
}

/**
 * 宗门任务配置（静态）
 */
export interface SectQuestConfig {
  /** 任务ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务描述 */
  description: string;
  /** 贡献度奖励 */
  contribution: number;
  /** 修为奖励 */
  exp_reward: number;
  /** 是否每日任务 */
  daily: boolean;
}

/**
 * 宗门详情（含宝库和任务，对应 GET /sect/:sect_id）
 */
export interface SectDetail extends Sect {
  /** 宝库物品列表 */
  treasury: TreasuryItem[];
  /** 宗门任务列表 */
  quests: SectQuestConfig[];
}

/**
 * 我的宗门信息（合并静态配置 + 动态成员数据）
 * 对应后端 GET /sect/my 返回的 data 字段
 */
export interface MySect {
  /** 宗门ID */
  sect_id: string;
  /** 宗门名称 */
  name: string;
  /** 宗门描述 */
  description: string;
  /** 阵营 */
  alignment: '正道' | '魔道';
  /** 五行属性 */
  element: string;
  /** 宗门加成 */
  bonus: SectBonus;
  /** 当前贡献度 */
  contribution: number;
  /** 身份：disciple 弟子 / elder 长老 */
  role: 'disciple' | 'elder';
  /** 加入时间 */
  joined_at: string;
  /** 上次点卯时间 */
  last_check_in: string | null;
  /** 上次传功时间 */
  last_transfer: string | null;
  /** 点卯冷却剩余毫秒（后端权威计算，前端基于此 + server_time tick 递减） */
  checkin_cooldown_remaining_ms?: number;
  /** 传功冷却剩余毫秒（后端权威计算，前端基于此 + server_time tick 递减） */
  transfer_cooldown_remaining_ms?: number;
  /** 服务端时间戳（毫秒），供前端基于此 tick 计算实时冷却剩余，避免时钟漂移 */
  server_time?: number;
  /** 静态配置是否缺失（兜底标志） */
  config_missing?: boolean;
}

/**
 * 宗门任务（含今日完成状态）
 * 对应 GET /sect/quests 返回的 quests 数组项
 */
export interface SectQuest extends SectQuestConfig {
  /** 今日是否已完成 */
  completed: boolean;
}

/**
 * 宗门任务列表响应
 */
export interface SectQuestsResponse {
  /** 宗门ID */
  sect_id: string;
  /** 宗门名称 */
  sect_name: string;
  /** 任务列表 */
  quests: SectQuest[];
  /** 任务重置时间 */
  quests_reset_at: string;
}

/**
 * 获取所有宗门列表（基础信息）
 * GET /sect/list
 */
export const getSectList = () => {
  return apiClient.get('/sect/list');
};

/**
 * 获取宗门详情（包含宝库和任务）
 * GET /sect/:sect_id
 * @param sectId - 宗门ID
 */
export const getSectDetail = (sectId: string) => {
  return apiClient.get(`/sect/${sectId}`);
};

/**
 * 拜入宗门
 * POST /sect/join
 * @param sectId - 宗门ID
 */
export const joinSect = (sectId: string) => {
  return apiClient.post('/sect/join', { sect_id: sectId });
};

/**
 * 叛出宗门
 * POST /sect/leave
 */
export const leaveSect = () => {
  return apiClient.post('/sect/leave');
};

/**
 * 获取我的宗门信息
 * GET /sect/my
 */
export const getMySect = () => {
  return apiClient.get('/sect/my');
};

/**
 * 每日点卯
 * POST /sect/check-in
 */
export const dailyCheckIn = () => {
  return apiClient.post('/sect/check-in');
};

/**
 * 宗门传功
 * POST /sect/transfer
 */
export const transferSkill = () => {
  return apiClient.post('/sect/transfer');
};

/**
 * 获取宗门宝库物品列表
 * GET /sect/treasury/:sect_id
 * @param sectId - 宗门ID
 */
export const getTreasury = (sectId: string) => {
  return apiClient.get(`/sect/treasury/${sectId}`);
};

/**
 * 兑换宝库物品
 * POST /sect/exchange
 * @param treasureId - 宝库物品ID
 */
export const exchangeTreasury = (treasureId: string) => {
  return apiClient.post('/sect/exchange', { treasure_id: treasureId });
};

/**
 * 获取宗门任务列表（标记今日是否已完成）
 * GET /sect/quests
 */
export const getQuests = () => {
  return apiClient.get('/sect/quests');
};

/**
 * 提交宗门任务
 * POST /sect/submit-quest
 * @param questId - 任务ID
 */
export const submitQuest = (questId: string) => {
  return apiClient.post('/sect/submit-quest', { quest_id: questId });
};
