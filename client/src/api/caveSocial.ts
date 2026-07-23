/**
 * 洞府社交系统 API
 *
 * 提供洞府社交玩法的接口调用：
 * 1. 拜访洞府：访问他人洞府，触发访客记录
 * 2. 洞府留言：在他人洞府留言板留言
 * 3. 查看留言：查看自己洞府的留言列表
 * 4. 查看访客：查看自己洞府的访客记录
 * 5. 布置景观：设置洞府外观景观（含属性加成）
 * 6. 洞府商人：查看货品 + 购买商品（按时间刷新）
 *
 * 设计原则：所有业务逻辑在后端，前端仅做展示与接口调用
 */
import apiClient from './index';

/** 留言信息 */
export interface CaveMessage {
  /** 留言 ID */
  id: number;
  /** 留言者 ID */
  sender_id: number;
  /** 留言者昵称 */
  sender_nickname: string;
  /** 留言内容 */
  content: string;
  /** 留言时间 */
  created_at: string;
}

/** 访客记录 */
export interface CaveVisitor {
  /** 记录 ID */
  id: number;
  /** 访客 ID */
  visitor_id: number;
  /** 访客昵称 */
  visitor_nickname: string;
  /** 访客境界 */
  visitor_realm?: string;
  /** 拜访时间 */
  visited_at: string;
}

/** 景观加成（对象格式，如 { meditation_exp_bonus: 0.05 }） */
export interface LandscapeBonus {
  /** 静思悟道经验加成 */
  meditation_exp_bonus?: number;
  /** 灵脉产出加成 */
  spirit_vein_bonus?: number;
  /** 突破成功率加成 */
  breakthrough_bonus?: number;
  [key: string]: number | undefined;
}

/** 景观配置项 */
export interface LandscapeItem {
  /** 景观 ID */
  id: string;
  /** 景观名称 */
  name: string;
  /** 景观描述 */
  description: string;
  /** 布置消耗（灵石） */
  cost: number;
  /** 属性加成 */
  bonus: LandscapeBonus;
  /** 所需境界排名 */
  required_realm_rank: number;
  /** 当前玩家是否可布置 */
  can_setup: boolean;
  /** 是否为当前已布置景观 */
  is_current: boolean;
}

/** 景观列表返回 */
export interface LandscapeListResult {
  landscapes: LandscapeItem[];
  current_landscape_id: string | null;
}

/** 洞府商人商品 */
export interface MerchantGood {
  /** 商品序号（1-based） */
  index: number;
  /** 物品 key */
  item_key: string;
  /** 物品名称 */
  item_name: string;
  /** 基础售价（灵石） */
  base_price: number;
  /** 实际售价（灵石，含折扣/溢价） */
  price: number;
  /** 折扣率（<1 为打折，>1 为溢价） */
  discount_rate: number;
  /** 最大可购数量 */
  max_buy: number;
  /** 已购数量 */
  bought: number;
  /** 剩余可购数量 */
  remaining: number;
}

/** 洞府商人货品返回 */
export interface MerchantGoodsResult {
  /** 刷新批次标识 */
  refresh_batch: string;
  /** 当前刷新时间 */
  refresh_at: string;
  /** 下次刷新时间 */
  next_refresh_at: string;
  /** 商品列表 */
  items: MerchantGood[];
}

/** 购买商品返回 */
export interface BuyMerchantResult {
  message: string;
  item_name: string;
  quantity: number;
  total_cost: number;
  remaining_stones: string;
}

/** 拜访奇遇奖励 */
export interface VisitEncounterRewards {
  /** 获得的物品ID */
  item_id?: string;
  /** 获得的物品名称 */
  item_name?: string;
  /** 获得的物品数量 */
  item_count?: number;
  /** 获得的经验 */
  exp?: number;
  /** 获得的灵石 */
  spirit_stone?: number;
  /** 损失的气血（陷阱类型） */
  hp_loss?: number;
}

/** 拜访奇遇结果 */
export interface VisitEncounter {
  /** 是否触发了奇遇 */
  triggered: boolean;
  /** 未触发原因（triggered=false 时有值） */
  reason?: string;
  /** 奇遇ID（triggered=true 时有值） */
  encounter_id?: string;
  /** 奇遇名称 */
  name?: string;
  /** 奇遇描述 */
  description?: string;
  /** 奇遇类型：item/exp/spirit_stone/trap/nothing */
  type?: string;
  /** 奇遇奖励 */
  rewards?: VisitEncounterRewards;
  /** 今日已触发奇遇次数 */
  today_encounters?: number;
  /** 每日奇遇上限 */
  daily_limit?: number;
}

/** 拜访洞府返回 */
export interface VisitCaveResult {
  success: boolean;
  message: string;
  target: {
    player_id: number;
    nickname: string;
    realm_rank: number;
  };
  cave: {
    is_opened: boolean;
    opened_at: string;
    spirit_vein_level: number;
    quiet_room_level: number;
    pill_room_level: number;
    tool_room_level: number;
    grand_formation_level: number;
    garden_plots: any;
    landscape: { id: string; name: string; description: string } | null;
  };
  /** 拜访奇遇结果 */
  encounter: VisitEncounter | null;
  today_visited_count: number;
  daily_limit: number;
}

/** 留言返回 */
export interface LeaveMessageResult {
  message: string;
  content: string;
  created_at: string;
}

/**
 * 拜访他人洞府
 * POST /cave-social/visit
 * @param target_player_id 目标玩家 ID
 */
export const visitCave = (target_player_id: number) => {
  return apiClient.post<VisitCaveResult>('/cave-social/visit', { target_player_id });
};

/**
 * 在他人洞府留言
 * POST /cave-social/messages
 * @param target_player_id 目标玩家 ID
 * @param content 留言内容
 */
export const leaveMessage = (target_player_id: number, content: string) => {
  return apiClient.post<LeaveMessageResult>('/cave-social/messages', {
    target_player_id,
    content
  });
};

/**
 * 查看自己洞府的留言列表
 * GET /cave-social/messages
 * @param limit 返回条数，默认 50
 */
export const getMessages = (limit = 50) => {
  return apiClient.get<{ messages: CaveMessage[] }>('/cave-social/messages', {
    params: { limit }
  });
};

/**
 * 查看自己洞府的访客记录
 * GET /cave-social/visitors
 * @param limit 返回条数，默认 50
 */
export const getVisitors = (limit = 50) => {
  return apiClient.get<{ visitors: CaveVisitor[] }>('/cave-social/visitors', {
    params: { limit }
  });
};

/**
 * 查询可布置的景观列表（含已布置状态）
 * GET /cave-social/landscapes
 */
export const getLandscapes = () => {
  return apiClient.get<LandscapeListResult>('/cave-social/landscapes');
};

/**
 * 布置洞府景观
 * POST /cave-social/landscape
 * @param landscape_id 景观 ID
 */
export const setLandscape = (landscape_id: string) => {
  return apiClient.post<{ message: string }>('/cave-social/landscape', {
    landscape_id
  });
};

/**
 * 查看洞府商人货品（按时间自动刷新）
 * GET /cave-social/merchant
 */
export const getMerchantGoods = () => {
  return apiClient.get<MerchantGoodsResult>('/cave-social/merchant');
};

/**
 * 购买洞府商人商品
 * POST /cave-social/merchant/buy
 * @param item_index 商品编号（1-based）
 * @param quantity 购买数量，默认 1
 */
export const buyMerchantItem = (item_index: number, quantity = 1) => {
  return apiClient.post<BuyMerchantResult>('/cave-social/merchant/buy', {
    item_index,
    quantity
  });
};

// ==================== 洞天寻宝系统 ====================

/** 寻宝奖励/损失明细 */
export interface TreasureHuntRewards {
  /** 借取的灵石（从洞府主人处获得） */
  spirit_stones?: number;
  /** 获得的修为 */
  exp?: number;
  /** 获得的物品ID */
  item_id?: string;
  /** 获得的物品名称 */
  item_name?: string;
  /** 损失的气血（陷阱类型） */
  hp_loss?: number;
  /** 损失的灵石（陷阱/遭遇护阵类型） */
  spirit_stone_loss?: number;
}

/** 寻宝结果 */
export interface TreasureHuntResult {
  success: boolean;
  message: string;
  /** 结果类型：treasure/trap/encounter/empty */
  result_type: string;
  /** 结果名称 */
  result_name: string;
  /** 奖励/损失明细 */
  rewards: TreasureHuntRewards;
  /** 是否被洞府主人发现 */
  is_discovered: boolean;
  /** 本次寻宝成功率 */
  success_rate: number;
  /** 探索地块编号 */
  plot_number: number;
  /** 目标洞府信息 */
  target: {
    player_id: number;
    nickname: string;
  };
  /** 今日已寻宝次数 */
  today_count: number;
  /** 每日寻宝上限 */
  daily_limit: number;
  /** 寻宝消耗灵石 */
  cost: number;
  /** 剩余灵石 */
  remaining_spirit_stones: number;
}

/** 寻宝日志记录 */
export interface TreasureLog {
  id: number;
  hunter_id: number;
  hunter_nickname: string;
  cave_owner_id: number;
  cave_owner_nickname: string;
  plot_number: number;
  result_type: string;
  rewards: TreasureHuntRewards;
  is_discovered: boolean;
  created_at: string;
}

/** 寻宝日志返回 */
export interface TreasureLogsResult {
  role: string;
  logs: TreasureLog[];
  total: number;
}

/**
 * 洞天寻宝：在他人洞府探索地块寻宝
 * POST /cave-social/treasure
 * @param target_player_id 目标洞府主人玩家ID
 * @param plot_number 地块编号（1-9）
 */
export const treasureHunt = (target_player_id: number, plot_number: number) => {
  return apiClient.post<TreasureHuntResult>('/cave-social/treasure', {
    target_player_id,
    plot_number
  });
};

/**
 * 查询寻宝日志
 * GET /cave-social/treasure/logs
 * @param role 角色：hunter（寻宝者）/ owner（洞府主人被寻宝）
 * @param limit 返回条数，默认 50
 */
export const getTreasureLogs = (role: 'hunter' | 'owner' = 'hunter', limit = 50) => {
  return apiClient.get<TreasureLogsResult>('/cave-social/treasure/logs', {
    params: { role, limit }
  });
};

// ==================== 接待/驱逐访客系统 ====================

/** 待处理访客信息 */
export interface PendingVisitor {
  /** 访客记录ID */
  id: number;
  /** 访客玩家ID */
  visitor_id: number;
  /** 访客昵称 */
  visitor_nickname: string;
  /** 访客境界 */
  visitor_realm: string;
  /** 拜访时间 */
  visited_at: string;
  /** 奇遇类型ID */
  encounter_type: string | null;
  /** 奇遇奖励 */
  encounter_reward: any;
  /** 接待状态 */
  reception_status: 'pending' | 'received' | 'expelled' | 'ignored';
  /** 处理时间 */
  reception_at: string | null;
  /** 接待buff到期时间 */
  reception_buff_until: string | null;
  /** 接待buff是否仍有效 */
  buff_active: boolean;
  /** 驱逐封锁是否仍有效 */
  block_active: boolean;
}

/** 接待列表返回 */
export interface VisitorReceptionListResult {
  pending: PendingVisitor[];
  recent: PendingVisitor[];
  total_pending: number;
}

/** 接待访客返回 */
export interface ReceiveVisitorResult {
  success: boolean;
  message: string;
  visitor: { player_id: number; nickname: string; realm: string };
  cost: number;
  buff_until: string;
  buff_meditation_bonus: number;
  buff_merchant_discount: number;
  remaining_spirit_stones: number;
}

/** 驱逐访客返回 */
export interface ExpelVisitorResult {
  success: boolean;
  message: string;
  visitor: { player_id: number; nickname: string; realm: string };
  block_until: string;
  block_hours: number;
}

/**
 * 获取待处理访客列表（洞府主人视角）
 * GET /cave-social/visitors/reception
 * @param limit 返回条数，默认 20
 */
export const getVisitorReceptionList = (limit = 20) => {
  return apiClient.get<VisitorReceptionListResult>('/cave-social/visitors/reception', {
    params: { limit }
  });
};

/**
 * 接待访客（消耗灵石，赠予临时增益buff）
 * POST /cave-social/visitors/:recordId/receive
 * @param recordId 访客记录ID
 */
export const receiveVisitor = (recordId: number) => {
  return apiClient.post<ReceiveVisitorResult>(`/cave-social/visitors/${recordId}/receive`);
};

/**
 * 驱逐访客（封锁拜访+寻宝24h）
 * POST /cave-social/visitors/:recordId/expel
 * @param recordId 访客记录ID
 */
export const expelVisitor = (recordId: number) => {
  return apiClient.post<ExpelVisitorResult>(`/cave-social/visitors/${recordId}/expel`);
};

/**
 * 忽略访客（不予理睬）
 * POST /cave-social/visitors/:recordId/ignore
 * @param recordId 访客记录ID
 */
export const ignoreVisitor = (recordId: number) => {
  return apiClient.post<{ success: boolean; message: string }>(`/cave-social/visitors/${recordId}/ignore`);
};

// ==================== 万宝阁展品系统 ====================

/** 展品信息（我的展品 / 查看他人展品通用） */
export interface CaveExhibit {
  /** 展品ID */
  id: number;
  /** 物品配置键名 */
  item_key: string;
  /** 物品名称 */
  item_name: string;
  /** 品质：common/uncommon/rare/epic/legendary/mythic */
  quality: string;
  /** 物品描述 */
  description?: string;
  /** 物品效果 */
  effect?: Record<string, unknown>;
  /** 物品基础价格 */
  price?: number;
  /** 物品类型 */
  type?: string;
  /** 展位编号 */
  exhibit_slot: number;
  /** 热度值（被鉴赏次数） */
  heat_count: number;
  /** 上架时间 */
  created_at: string;
  /** 今日是否已鉴赏过（仅查看他人展品时有值） */
  appreciated_today?: boolean;
}

/** 我的展品列表返回 */
export interface MyExhibitsResult {
  exhibits: CaveExhibit[];
  total: number;
  max_exhibits: number;
  min_quality: string;
}

/** 上架展品返回 */
export interface ListExhibitResult {
  success: boolean;
  message: string;
  exhibit: {
    id: number;
    item_key: string;
    item_name: string;
    quality: string;
    exhibit_slot: number;
    heat_count: number;
    created_at: string;
  };
  total_exhibits: number;
  max_exhibits: number;
}

/** 取下展品返回 */
export interface UnlistExhibitResult {
  success: boolean;
  message: string;
  returned_item: {
    item_key: string;
    item_name: string;
    quantity: number;
  };
  cleared_heat: number;
}

/** 查看他人洞府展品返回 */
export interface ViewPlayerExhibitsResult {
  target_player_id: number;
  target_nickname: string;
  target_realm: string;
  exhibits: CaveExhibit[];
  total: number;
  today_appreciated_count: number;
  daily_limit: number;
  remaining_appreciations: number;
  message?: string;
}

/** 鉴赏展品返回 */
export interface AppreciateExhibitResult {
  success: boolean;
  message: string;
  exhibit: {
    id: number;
    item_key: string;
    item_name: string;
    quality: string;
  };
  /** 是否触发顿悟 */
  is_enlightened: boolean;
  /** 获得的修为 */
  exp_gained: number;
  /** 基础修为（顿悟前） */
  base_exp: number;
  /** 顿悟倍率（顿悟时为 3，否则为 1） */
  enlighten_multiplier: number;
  /** 顿悟buff到期时间（顿悟时有值） */
  enlighten_buff_until: string | null;
  /** 顿悟修炼加成（顿悟时有值） */
  enlighten_buff_meditation_bonus: number;
  /** 今日已鉴赏次数 */
  today_appreciated_count: number;
  /** 每日鉴赏上限 */
  daily_limit: number;
  /** 剩余鉴赏次数 */
  remaining_appreciations: number;
  /** 主人获得的声望 */
  owner_honor_gained: number;
  /** 展品新热度 */
  new_heat: number;
}

/** 热度榜单项 */
export interface HeatBoardItem {
  rank: number;
  exhibit_id: number;
  item_key: string;
  item_name: string;
  quality: string;
  heat_count: number;
  owner_id: number;
  owner_nickname: string;
  owner_realm: string;
  created_at: string;
}

/** 热度榜返回 */
export interface HeatBoardResult {
  board: HeatBoardItem[];
  total: number;
  message?: string;
}

/**
 * 获取我的万宝阁展品列表
 * GET /cave-social/exhibits
 */
export const getMyExhibits = () => {
  return apiClient.get<MyExhibitsResult>('/cave-social/exhibits');
};

/**
 * 上架展品至万宝阁
 * POST /cave-social/exhibits/list
 * @param item_key 物品配置键名
 */
export const listExhibit = (item_key: string) => {
  return apiClient.post<ListExhibitResult>('/cave-social/exhibits/list', { item_key });
};

/**
 * 从万宝阁取下展品（物品归还背包）
 * DELETE /cave-social/exhibits/:exhibitId
 * @param exhibitId 展品ID
 */
export const unlistExhibit = (exhibitId: number) => {
  return apiClient.delete<UnlistExhibitResult>(`/cave-social/exhibits/${exhibitId}`);
};

/**
 * 查看他人洞府的万宝阁展品（供鉴赏）
 * GET /cave-social/exhibits/player/:playerId
 * @param playerId 目标洞府主人玩家ID
 */
export const viewPlayerExhibits = (playerId: number) => {
  return apiClient.get<ViewPlayerExhibitsResult>(`/cave-social/exhibits/player/${playerId}`);
};

/**
 * 鉴赏展品（获得修为，有概率触发顿悟）
 * POST /cave-social/exhibits/:exhibitId/appreciate
 * @param exhibitId 展品ID
 */
export const appreciateExhibit = (exhibitId: number) => {
  return apiClient.post<AppreciateExhibitResult>(`/cave-social/exhibits/${exhibitId}/appreciate`);
};

/**
 * 获取万宝阁热度榜
 * GET /cave-social/exhibits/heat-board
 * @param limit 返回条数，默认 20
 */
export const getExhibitHeatBoard = (limit = 20) => {
  return apiClient.get<HeatBoardResult>('/cave-social/exhibits/heat-board', {
    params: { limit }
  });
};

// ==================== 洞天绘卷系统 ====================

/** 洞府主人信息 */
export interface ScrollOwner {
  /** 玩家ID */
  player_id: number;
  /** 昵称 */
  nickname: string;
  /** 境界名称 */
  realm: string;
  /** 境界排名 */
  realm_rank: number;
}

/** 洞府设施等级 */
export interface ScrollFacilities {
  spirit_vein: number;
  quiet_room: number;
  pill_room: number;
  tool_room: number;
  grand_formation: number;
}

/** 洞府信息 */
export interface ScrollCave {
  is_opened: boolean;
  opened_at: string | null;
  facilities: ScrollFacilities;
  facility_total_level: number;
  landscape: { id: string; name: string; description: string } | null;
  garden_plots: number;
}

/** 展品统计 */
export interface ScrollExhibits {
  count: number;
  top_quality: string | null;
  total_heat: number;
  top_exhibits: Array<{ item_name: string; quality: string; heat_count: number }>;
}

/** 人气统计 */
export interface ScrollPopularity {
  visitor_count: number;
  message_count: number;
}

/** 风貌评级 */
export interface ScrollRating {
  /** 综合得分 */
  score: number;
  /** 评级名称（凡品/灵品/玄品/地品/天品/仙品） */
  tier_name: string;
  /** 评级序号（0-5） */
  tier_index: number;
}

/** 题词记录 */
export interface ScrollInscription {
  id: number;
  inscriber_id: number;
  inscriber_nickname: string;
  content: string;
  created_at: string;
}

/** 洞天绘卷数据（通用结构：我的/他人） */
export interface ScrollData {
  owner: ScrollOwner;
  cave: ScrollCave;
  exhibits: ScrollExhibits;
  popularity: ScrollPopularity;
  rating: ScrollRating;
  inscriptions: ScrollInscription[];
  inscription_count: number;
  /** 以下字段仅查看他人绘卷时返回 */
  today_inscribed?: boolean;
  inscribe_today_count?: number;
  inscribe_daily_limit?: number;
  can_inscribe?: boolean;
  /** 提示信息（仅排行榜为空等特殊场景） */
  message?: string;
}

/** 题词返回 */
export interface InscribeScrollResult {
  success: boolean;
  message: string;
  inscription: {
    id: number;
    content: string;
    created_at: string;
  };
  target: { player_id: number; nickname: string; realm: string };
  /** 被题词者获得的声望 */
  honor_gained: number;
  /** 题词者今日已题词次数（含本次） */
  today_inscribe_count: number;
  /** 每日题词上限 */
  daily_limit: number;
}

/** 绘卷风貌榜单项 */
export interface ScrollRankingItem {
  rank: number;
  player_id: number;
  nickname: string;
  realm: string;
  realm_rank: number;
  facility_total_level: number;
  exhibit_count: number;
  visitor_count: number;
  message_count: number;
  score: number;
  tier_name: string;
  tier_index: number;
}

/** 绘卷风貌榜返回 */
export interface ScrollRankingResult {
  ranking: ScrollRankingItem[];
  total: number;
  message?: string;
}

/**
 * 查看自己的洞天绘卷
 * GET /cave-social/scroll/me
 */
export const getMyScroll = () => {
  return apiClient.get<ScrollData>('/cave-social/scroll/me');
};

/**
 * 查看他人洞天绘卷
 * GET /cave-social/scroll/player/:playerId
 * @param playerId 目标洞府主人玩家ID
 */
export const viewPlayerScroll = (playerId: number) => {
  return apiClient.get<ScrollData>(`/cave-social/scroll/player/${playerId}`);
};

/**
 * 在他人洞天绘卷上题词
 * POST /cave-social/scroll/:playerId/inscribe
 * @param playerId 目标洞府主人玩家ID
 * @param content 题词内容（最长20字）
 */
export const inscribeScroll = (playerId: number, content: string) => {
  return apiClient.post<InscribeScrollResult>(`/cave-social/scroll/${playerId}/inscribe`, {
    content
  });
};

/**
 * 获取洞天绘卷风貌排行榜
 * GET /cave-social/scroll/ranking
 * @param limit 返回条数，默认 20
 */
export const getScrollRanking = (limit = 20) => {
  return apiClient.get<ScrollRankingResult>('/cave-social/scroll/ranking', {
    params: { limit }
  });
};
