/**
 * 灵溪垂钓系统 API
 *
 * 封装灵溪垂钓玩法的接口调用：购买/升级钓竿、购买/制作鱼饵、
 * 抛竿/试探/提竿、剖鱼/烹鱼、鱼篓/鱼谱/排行榜。
 *
 * 设计原则：
 *   - 所有业务逻辑由后端 FishingService 处理，前端仅做调用与展示
 *   - 禁止直接 axios，统一使用 apiClient（携带 JWT + 统一错误处理）
 *   - 异步钓鱼流程由后端管理时间窗口，前端轮询 /status 获取进度
 *
 * 玩法文档对照：xiuxian_game_guide.md 第21节·经济与博彩补充
 *
 * 系统定位：
 *   - 4级钓竿（青竹/银竹/金竹/金雷竹），LDC购买+法则碎片·雷+天雷竹升级
 *   - 4种鱼饵（蚯蚓/灵虫饵/天灵饵/自制灵饵），购买+制饵
 *   - 4个鱼塘（青云溪/碧波潭/灵泉湖/乱星海礁），按钓术熟练度解锁
 *   - 异步钓鱼：抛竿→等待鱼讯→试探咬饵→提竿/收竿
 *   - 钓术熟练度0-100级，降低空竿/升珍稀/缩短等鱼/延长提竿窗口
 *   - 剖鱼产出灵鱼肉/灵鱼鳞/水草团 + 灵石/修为/LDC（有日上限）
 *   - 多人交互：LDC全服每日保底 + 排行榜竞争 + 剖鱼产出可流通
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
import apiClient from './index';

// ==================== 配置类型 ====================

/** 钓竿配置 */
export interface RodConfig {
  name: string;
  description: string;
  tier: number;
  daily_limit: number;
  law_phase_required: number;
  purchase_cost_ldc: number | null;
  upgrade_cost: Record<string, number> | null;
  wait_time_min_sec: number;
  wait_time_max_sec: number;
  reel_window_sec: number;
  nibble_bonus: number;
  rare_bonus: number;
}

/** 鱼饵配置 */
export interface BaitConfig {
  name: string;
  description: string;
  price: number | null;
  craftable: boolean;
  craft_cost: Record<string, number> | null;
  craft_batch?: number;
}

/** 鱼塘配置 */
export interface PondConfig {
  name: string;
  description: string;
  required_skill_level: number;
  required_bait: string;
  fish_pool: string;
  rare_material_pool: string | null;
  is_advanced: boolean;
}

/** 鱼类配置 */
export interface FishConfig {
  id: string;
  name: string;
  quality: string;
  weight: number;
  min_kg: number;
  max_kg: number;
  filet_yield: number;
  scale_yield: number;
  grass_yield: number;
  exp_reward: number;
  stone_reward: number;
  cultivation_reward: number;
}

/** 灵溪垂钓完整配置 */
export interface FishingConfig {
  enabled: boolean;
  rods: Record<string, RodConfig>;
  baits: Record<string, BaitConfig>;
  ponds: Record<string, PondConfig>;
  fish_pools: Record<string, { empty_weight: number; fishes: FishConfig[] }>;
  skill: {
    max_level: number;
    level_exp_base: number;
    level_exp_growth: number;
    empty_rate_reduction_per_level: number;
    rare_bonus_per_level: number;
    wait_reduction_per_level_sec: number;
    reel_window_bonus_per_level_sec: number;
  };
  nibble: {
    max_attempts: number;
    rare_bonus_per_attempt: number;
    empty_rate_bonus_per_attempt: number;
    reel_window_reduction_sec: number;
  };
  daily_limits: {
    spirit_stone: number;
    cultivation: number;
  };
  ldc: {
    ldc_server_daily_min: number;
    ldc_server_daily_max: number;
    ldc_fish_chance: number;
    ldc_amounts: number[];
  };
  cooking: {
    exp_per_filet: number;
    max_filet_per_cook: number;
  };
  scale_talisman: {
    scale_cost: number;
    buff_casts: number;
    buff_luck_bonus: number;
    buff_reel_window_sec: number;
  };
  ranking: {
    max_entries: number;
  };
}

// ==================== 响应类型 ====================

/** 钓鱼档案 */
export interface FishingProfile {
  enabled: boolean;
  rod_tier: number;
  rod_name: string;
  rod_config: RodConfig | null;
  upgrade_info: {
    cost: Record<string, number> | null;
    next_rod: RodConfig | null;
    purchase_ldc?: number;
  } | null;
  skill_level: number;
  skill_exp: number;
  next_level_exp: number;
  skill_effects: {
    empty_rate_reduction: number;
    rare_bonus: number;
    wait_reduction_sec: number;
    reel_window_bonus_sec: number;
  };
  daily_casts: number;
  daily_limit: number;
  daily_stone_earned: string;
  daily_stone_limit: number;
  daily_cultivation_earned: string;
  daily_cultivation_limit: number;
  buff_casts_remaining: number;
  buff_luck_bonus: number;
  has_active_session: boolean;
  total_catches: number;
  total_success: number;
  success_rate: number;
  biggest_catch_kg: number;
  rarest_catch_quality: string;
  ldc_balance: number;
}

/** 商店鱼塘项 */
export interface ShopPond {
  key: string;
  name: string;
  description: string;
  required_skill_level: number;
  required_bait: string;
  is_unlocked: boolean;
  is_advanced: boolean;
  has_rare_material: boolean;
}

/** 商店鱼饵项 */
export interface ShopBait {
  key: string;
  name: string;
  description: string;
  price: number | null;
  craftable: boolean;
  craft_cost: Record<string, number> | null;
}

/** 钓具商店 */
export interface FishingShop {
  today_weather: string;
  luck_modifier: number;
  ponds: ShopPond[];
  baits: ShopBait[];
  skill_level: number;
  rod_tier: number;
}

/** 抛竿结果 */
export interface CastResult {
  status: string;
  pond_id: string;
  pond_name: string;
  wait_sec: number;
  nibble_at: number;
  reel_deadline: number;
  bait_used: string;
  daily_casts: number;
  daily_limit: number;
}

/** 钓鱼会话状态 */
export interface FishingStatus {
  has_active_session: boolean;
  status: 'waiting' | 'biting' | 'expired' | 'idle';
  message: string;
  remaining_sec: number;
  pond_id?: string;
  pond_name?: string;
  nibble_count: number;
  max_nibble: number;
  cast_at?: number;
  nibble_at?: number;
  reel_deadline?: number;
}

/** 试探咬饵结果 */
export interface NibbleResult {
  nibble_count: number;
  max_nibble: number;
  message: string;
  fish_scared?: boolean;
  session_ended?: boolean;
}

/** 鱼获信息 */
export interface CaughtFish {
  fish_id: string;
  fish_name: string;
  quality: string;
  weight_kg: number;
  pond_id: string;
}

/** 提竿结果 */
export interface ReelResult {
  success: boolean;
  fish: CaughtFish | null;
  bonus_items: Array<{ item_id: string; item_name: string; quantity: number }>;
  skill_exp_gained: number;
  stone_earned: number;
  cultivation_earned: number;
  ldc_earned: number;
  is_new_species: boolean;
}

/** 鱼篓记录 */
export interface FishCatchRecord {
  id: number;
  fish_id: string;
  fish_name: string;
  quality: string;
  weight_kg: number;
  pond_id: string;
  is_filleted: number;
  bonus_items: string | null;
  caught_at: string;
}

/** 鱼篓列表 */
export interface FishCreel {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  filter: string;
  catches: FishCatchRecord[];
}

/** 鱼谱图鉴项 */
export interface AlbumEntry {
  fish_id: string;
  fish_name: string;
  quality: string;
  first_caught_at: string;
  total_caught: number;
  biggest_kg: number;
}

/** 鱼谱图鉴 */
export interface FishAlbum {
  total_species: number;
  discovered: number;
  discovery_rate: number;
  album: AlbumEntry[];
}

/** 剖鱼结果 */
export interface FilletResult {
  fish_name: string;
  quantity: number;
  filet_gained: number;
  scale_gained: number;
  grass_gained: number;
  stone_earned: number;
  cultivation_earned: number;
  ldc_earned: number;
  spirit_stones_after: string;
}

/** 烹鱼结果 */
export interface CookResult {
  filet_used: number;
  cultivation_gained: number;
}

/** 排行榜条目 */
export interface RankingEntry {
  rank: number;
  player_id: number;
  nickname: string;
  value: number | string;
  display: string;
}

/** 排行榜 */
export interface FishingRanking {
  category: string;
  entries: RankingEntry[];
}

// ==================== API 函数 ====================

/** 获取灵溪垂钓配置（无需鉴权） */
export const getConfig = () => {
  return apiClient.get<FishingConfig>('/fishing/config');
};

/** 钓鱼档案（需鉴权） */
export const getProfile = () => {
  return apiClient.get<{ code: number; data: FishingProfile }>('/fishing/profile');
};

/** 钓具商店（需鉴权） */
export const getShop = () => {
  return apiClient.get<{ code: number; data: FishingShop }>('/fishing/shop');
};

/** 购买青竹钓竿（需鉴权，消耗30 LDC） */
export const buyRod = () => {
  return apiClient.post<{ code: number; message: string; data: any }>('/fishing/rod/buy');
};

/** 升级钓竿（需鉴权，消耗法则碎片·雷+天雷竹） */
export const upgradeRod = () => {
  return apiClient.post<{ code: number; message: string; data: any }>('/fishing/rod/upgrade');
};

/** 购买鱼饵（需鉴权） */
export const buyBait = (baitKey: string, quantity: number) => {
  return apiClient.post<{ code: number; message: string; data: any }>('/fishing/bait/buy', {
    bait_key: baitKey,
    quantity,
  });
};

/** 制作鱼饵（需鉴权，仅handmade可制作） */
export const craftBait = (baitKey: string, batches: number) => {
  return apiClient.post<{ code: number; message: string; data: any }>('/fishing/bait/craft', {
    bait_key: baitKey,
    batches,
  });
};

/** 炼制鳞符（需鉴权，消耗灵鱼鳞×10获得3竿buff） */
export const craftScaleTalisman = () => {
  return apiClient.post<{ code: number; message: string; data: any }>('/fishing/scale-talisman');
};

/** 抛竿（需鉴权，创建活跃会话） */
export const cast = (pondId: string) => {
  return apiClient.post<{ code: number; message: string; data: CastResult }>('/fishing/cast', {
    pond_id: pondId,
  });
};

/** 会话状态（需鉴权，轮询获取进度） */
export const getStatus = () => {
  return apiClient.get<{ code: number; data: FishingStatus }>('/fishing/status');
};

/** 试探咬饵（需鉴权，提高稀有度但有空竿风险） */
export const nibble = () => {
  return apiClient.post<{ code: number; message: string; data: NibbleResult }>('/fishing/nibble');
};

/** 提竿结算（需鉴权，在鱼讯窗口内调用） */
export const reel = () => {
  return apiClient.post<{ code: number; message: string; data: ReelResult }>('/fishing/reel');
};

/** 放弃收竿（需鉴权，主动放弃当前会话） */
export const giveUp = () => {
  return apiClient.post<{ code: number; message: string; data: any }>('/fishing/give-up');
};

/** 鱼篓（需鉴权，分页查询鱼获记录） */
export const getCreel = (page = 1, pageSize = 20, filter: 'all' | 'unfilleted' | 'filleted' = 'all') => {
  return apiClient.get<{ code: number; data: FishCreel }>(
    `/fishing/creel?page=${page}&page_size=${pageSize}&filter=${filter}`,
  );
};

/** 鱼谱图鉴（需鉴权） */
export const getAlbum = () => {
  return apiClient.get<{ code: number; data: FishAlbum }>('/fishing/album');
};

/** 剖鱼（需鉴权，产出灵鱼肉/鳞/草+灵石/修为/LDC） */
export const fillet = (catchId: number, quantity = 1) => {
  return apiClient.post<{ code: number; message: string; data: FilletResult }>('/fishing/fillet', {
    catch_id: catchId,
    quantity,
  });
};

/** 烹鱼换修为（需鉴权，消耗灵鱼肉） */
export const cook = (quantity: number) => {
  return apiClient.post<{ code: number; message: string; data: CookResult }>('/fishing/cook', {
    quantity,
  });
};

/** 排行榜（需鉴权，4类：skill_level/biggest_catch_kg/rarest_catch_quality/total_success） */
export const getRanking = (category: 'skill_level' | 'biggest_catch_kg' | 'rarest_catch_quality' | 'total_success' = 'skill_level') => {
  return apiClient.get<{ code: number; data: FishingRanking }>(`/fishing/ranking?category=${category}`);
};
