/**
 * 副本系统 API 客户端
 *
 * 副本挑战玩法接口封装：
 * 1. 5章节×5-7关，每关类型：story/battle/puzzle/boss/reward
 * 2. 难度三档：normal/hard/nightmare，影响怪物属性与奖励倍率
 * 3. HP/MP在关卡间持续，不复位（玩家需策略性管理资源）
 * 4. AI剧情可选增强：AI不可用时降级到静态narrative
 * 5. 三星评级：HP剩余率≥80%=3星；≥50%=2星；>0%=1星
 * 6. 扫荡：三星通关后可扫荡，奖励按比例发放
 *
 * 对应后端路由：/api/dungeon/*
 * 业务逻辑全部由后端处理，前端仅做展示与接口调用
 */
import apiClient from './index';

/** 副本难度类型 */
export type DungeonDifficulty = 'normal' | 'hard' | 'nightmare';

/** 副本节点类型 */
export type DungeonNodeType = 'story' | 'battle' | 'puzzle' | 'boss' | 'reward';

/** 章节简要信息（getConfig 返回） */
export interface ChapterBrief {
  /** 章节ID，如 "ch1" */
  id: string;
  /** 章节名称 */
  name: string;
  /** 章节描述 */
  description: string;
  /** 进入此章节所需最低境界排名 */
  min_realm_rank: number;
  /** 推荐境界名称 */
  recommended_realm: string;
  /** 章节时长（秒） */
  duration_sec: number;
  /** 关卡节点数量 */
  node_count: number;
  /** BOSS 名称 */
  boss_name?: string;
}

/** 副本全局配置（GET /dungeon/config 返回） */
export interface DungeonConfig {
  global: {
    /** 每日挑战次数上限 */
    daily_challenge_limit: number;
    /** 副本冷却时间（秒） */
    cooldown_seconds: number;
    /** 副本超时时间（秒） */
    expire_seconds: number;
    /** 进入副本所需最低境界排名 */
    min_realm_rank: number;
    /** 扫荡所需最低星级 */
    sweep_min_stars: number;
    /** 扫荡奖励比例（0.6=60%） */
    sweep_reward_ratio: number;
    /** 星级阈值（HP剩余率） */
    star_thresholds: {
      three_star_hp_ratio: number;
      two_star_hp_ratio: number;
      one_star_hp_ratio: number;
    };
    /** 难度倍率配置 */
    difficulty_multipliers: {
      [key in DungeonDifficulty]: {
        hp: number;
        atk: number;
        exp: number;
        spirit_stones: number;
        drop_rate: number;
      };
    };
  };
  /** 所有章节简要信息列表 */
  chapters: ChapterBrief[];
}

/** 进行中副本进度信息 */
export interface DungeonProgressInfo {
  chapter_id: string;
  chapter_name: string;
  difficulty: DungeonDifficulty;
  current_node_id: string;
  current_node_type: DungeonNodeType;
  current_node_title: string;
  /** 副本内剩余HP（字符串形式，避免BigInt精度问题） */
  hp_remaining: string;
  /** 副本内剩余MP */
  mp_remaining: string;
  /** 已积累修为 */
  exp_accumulated: string;
  /** 已积累灵石 */
  spirit_stones_accumulated: string;
  /** 已收集物品列表 */
  items_collected: Array<{ item_key: string; quantity: number; source?: string }>;
  start_time: string;
  expires_at: string;
  /** 剩余时间（秒） */
  remaining_seconds: number;
  /** 已完成节点数 */
  nodes_completed_count: number;
}

/** 通关章节记录（用于星级展示与扫荡资格判断） */
export interface CompletedChapter {
  chapter_id: string;
  chapter_name: string;
  difficulty: DungeonDifficulty;
  /** 星级（1-3） */
  stars: number;
  completed_at: string;
}

/** 副本状态总览（GET /dungeon/status 返回） */
export interface DungeonStatus {
  /** 当前境界排名 */
  realm_rank: number;
  /** 当前境界名称 */
  realm_name: string;
  /** 进入副本所需最低境界排名 */
  min_realm_rank: number;
  /** 是否已解锁副本 */
  unlocked: boolean;
  /** 是否在副本中 */
  in_dungeon: boolean;
  /** 进行中副本进度（in_dungeon=true 时有值） */
  in_progress: DungeonProgressInfo | null;
  /** 今日已挑战次数 */
  daily_challenge_count: number;
  /** 每日挑战上限 */
  daily_challenge_limit: number;
  /** 冷却是否已就绪 */
  cooldown_ready: boolean;
  /** 冷却剩余秒数 */
  cooldown_remaining_sec: number;
  /** 通关章节记录列表 */
  completed_chapters: CompletedChapter[];
  /** 扫荡所需最低星级 */
  sweep_min_stars: number;
  /** 扫荡奖励比例 */
  sweep_reward_ratio: number;
}

/** 解谜节点选项 */
export interface PuzzleOption {
  id: string;
  text: string;
  /** 选项影响提示（如"损失15% HP"） */
  hint: string;
}

/** 怪物信息 */
export interface MonsterInfo {
  name: string;
  description?: string;
  hp: number;
  attack: number;
  defense: number;
  skills?: string[];
}

/** 节点奖励信息 */
export interface NodeRewards {
  exp: number;
  spirit_stones: number;
  items?: Array<{ item_key: string; quantity: number }>;
}

/** 当前节点内容（GET /dungeon/current-node 返回的 current_node 字段） */
export interface CurrentNode {
  id: string;
  type: DungeonNodeType;
  title: string;
  chapter_name: string;
  difficulty: DungeonDifficulty;
  is_final_node: boolean;
  /** story 节点：剧情文本（可能由 AI 生成） */
  narrative?: string;
  /** story 节点：是否由 AI 生成 */
  ai_generated?: boolean;
  /** story/reward 节点：下一节点ID */
  next_node_id?: string | null;
  /** battle/boss 节点：怪物信息 */
  monster?: MonsterInfo;
  /** battle/boss 节点：战斗胜利奖励 */
  rewards?: NodeRewards;
  /** battle/boss 节点：BOSS 战胜利文本 */
  victory_text?: string;
  /** puzzle 节点：可选项列表 */
  options?: PuzzleOption[];
  /** 通用：节点描述 */
  description?: string;
}

/** 开始副本响应数据 */
export interface StartDungeonResult {
  progress_id: number;
  chapter_id: string;
  chapter_name: string;
  difficulty: DungeonDifficulty;
  current_node: CurrentNode;
  hp_remaining: string;
  mp_remaining: string;
  expires_at: string;
  nodes_total: number;
}

/** 当前节点响应数据 */
export interface GetCurrentNodeResult {
  chapter_id: string;
  chapter_name: string;
  difficulty: DungeonDifficulty;
  current_node: CurrentNode;
  hp_remaining: string;
  mp_remaining: string;
  exp_accumulated: string;
  spirit_stones_accumulated: string;
  items_collected: Array<{ item_key: string; quantity: number; source?: string }>;
  nodes_completed_count: number;
  nodes_total: number;
  expires_at: string;
  remaining_seconds: number;
}

/** 战斗日志条目 */
export interface BattleLogEntry {
  round: number;
  side: 'player' | 'monster';
  damage: string;
  player_hp?: string;
  monster_hp?: string;
}

/** 解谜选择响应数据 */
export interface ChooseOptionResult {
  choice_result: string;
  hp_change: string;
  rewards: {
    exp: string;
    spirit_stones: string;
    items: Array<{ item_key: string; quantity: number }>;
  };
  current_node: CurrentNode;
  hp_remaining: string;
  mp_remaining: string;
}

/** 推进节点响应数据 */
export interface AdvanceNodeResult {
  current_node: CurrentNode;
  hp_remaining: string;
  mp_remaining: string;
  exp_accumulated: string;
  spirit_stones_accumulated: string;
}

/** 战斗节点响应数据 */
export interface BattleNodeResult {
  battle_result: 'victory' | 'defeat';
  battle_log: BattleLogEntry[];
  final_player_hp: string;
  final_monster_hp: string;
  rewards?: {
    exp: string;
    spirit_stones: string;
    items: Array<{ item_key: string; quantity: number }>;
  };
  victory_text?: string;
  /** BOSS 胜利后的下一节点内容（非终结节点时返回） */
  current_node?: CurrentNode;
  /** 结算信息（boss 终结节点或战斗失败时返回） */
  settlement?: DungeonSettlement;
  defeat_text?: string;
}

/** 副本结算信息 */
export interface DungeonSettlement {
  settle_reason: string;
  chapter_id: string;
  chapter_name: string;
  difficulty: DungeonDifficulty;
  is_success: boolean;
  is_interrupt: boolean;
  is_expired: boolean;
  /** 星级（0表示失败） */
  stars: number;
  /** 通关用时（秒） */
  completion_time_sec: number;
  rewards: {
    exp: string;
    spirit_stones: string;
    items: Array<{ item_key: string; quantity: number }>;
  };
  /** 是否更新了通关记录 */
  record_updated: boolean;
  player_exp: string;
  player_spirit_stones: string;
}

/** 扫荡响应数据 */
export interface SweepDungeonResult {
  chapter_id: string;
  chapter_name: string;
  difficulty: DungeonDifficulty;
  rewards: {
    exp: string;
    spirit_stones: string;
    items: Array<{ item_key: string; quantity: number }>;
  };
  daily_challenge_count: number;
  daily_challenge_limit: number;
}

/** 通关历史记录条目 */
export interface DungeonHistoryEntry {
  id: number;
  chapter_id: string;
  chapter_name: string;
  difficulty: DungeonDifficulty;
  stars: number;
  completion_time_sec: number;
  exp_gained: string;
  spirit_stones_gained: string;
  items_gained: Array<{ item_key: string; quantity: number }>;
  completed_at: string;
}

/** 通用业务响应包装 */
export interface ServiceResponse<T> {
  code: number;
  success?: boolean;
  message?: string;
  data: T | null;
  error_code?: string;
}

/**
 * 获取副本全局配置与章节列表
 * GET /dungeon/config
 * 未登录也可访问，用于展示规则
 */
export const getConfig = () => {
  return apiClient.get<ServiceResponse<DungeonConfig>>('/dungeon/config');
};

/**
 * 获取玩家副本状态总览
 * GET /dungeon/status
 */
export const getStatus = () => {
  return apiClient.get<ServiceResponse<DungeonStatus>>('/dungeon/status');
};

/**
 * 开始副本挑战
 * POST /dungeon/start
 * @param chapter_id 章节ID，如 "ch1"
 * @param difficulty 难度：normal/hard/nightmare
 */
export const startDungeon = (chapter_id: string, difficulty: DungeonDifficulty) => {
  return apiClient.post<ServiceResponse<StartDungeonResult>>('/dungeon/start', {
    chapter_id,
    difficulty
  });
};

/**
 * 获取当前关卡节点内容
 * GET /dungeon/current-node
 */
export const getCurrentNode = () => {
  return apiClient.get<ServiceResponse<GetCurrentNodeResult>>('/dungeon/current-node');
};

/**
 * 解谜节点选项选择
 * POST /dungeon/choose-option
 * @param option_id 选项ID
 */
export const chooseOption = (option_id: string) => {
  return apiClient.post<ServiceResponse<ChooseOptionResult>>('/dungeon/choose-option', {
    option_id
  });
};

/**
 * 推进 story/reward 节点
 * POST /dungeon/advance
 */
export const advanceNode = () => {
  return apiClient.post<ServiceResponse<AdvanceNodeResult>>('/dungeon/advance');
};

/**
 * 执行 battle/boss 节点战斗
 * POST /dungeon/battle
 */
export const battleNode = () => {
  return apiClient.post<ServiceResponse<BattleNodeResult>>('/dungeon/battle');
};

/**
 * 主动中断副本
 * POST /dungeon/interrupt
 * 按失败结算，补偿50%积累修为，不发放物品与灵石
 */
export const interruptDungeon = () => {
  return apiClient.post<ServiceResponse<DungeonSettlement>>('/dungeon/interrupt');
};

/**
 * 扫荡已三星通关的副本
 * POST /dungeon/sweep
 * @param chapter_id 章节ID
 * @param difficulty 难度
 */
export const sweepDungeon = (chapter_id: string, difficulty: DungeonDifficulty) => {
  return apiClient.post<ServiceResponse<SweepDungeonResult>>('/dungeon/sweep', {
    chapter_id,
    difficulty
  });
};

/**
 * 查询通关历史记录
 * GET /dungeon/history?limit=20
 * @param limit 返回条数，最多50
 */
export const getHistory = (limit = 20) => {
  return apiClient.get<ServiceResponse<DungeonHistoryEntry[]>>('/dungeon/history', {
    params: { limit }
  });
};
