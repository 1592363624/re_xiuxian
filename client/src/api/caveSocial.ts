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

/** 拜访洞府返回 */
export interface VisitCaveResult {
  message: string;
  target_nickname: string;
  target_realm: string;
  landscape_name?: string;
  visited_at: string;
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
