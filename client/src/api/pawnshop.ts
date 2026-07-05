/**
 * 当铺（聚宝当铺）系统 API
 *
 * 封装玩家在当铺的状态查询、估值、典当、赎回、当票列表与历史记录接口调用。
 * 当铺为周转灵石的玩法：玩家把物品当给聚宝当铺换灵石，7 天内可赎回（含利息），
 * 赎回可增加当铺信用额度（影响估值折扣）。逾期当票物品将归当铺所有。
 *
 * 设计原则：
 *   - 所有业务逻辑由后端 PawnshopService 处理，前端仅做调用与展示
 *   - 禁止直接 axios，统一使用 apiClient（携带 JWT + 统一错误处理）
 *   - BIGINT 金额字段使用 string 类型，避免 JS Number 精度问题
 */
import apiClient from './index';

/**
 * 当票状态枚举
 * - active: 典当中
 * - redeemed: 已赎回
 * - overdue: 已逾期（物品归当铺所有）
 * - auctioned: 已拍卖（保留状态，当前版本未实现）
 */
export type PawnshopListingStatus = 'active' | 'redeemed' | 'overdue' | 'auctioned';

/**
 * 历史记录操作类型
 * - pawn: 典当
 * - redeem: 赎回
 * - overdue: 逾期
 * - auction: 拍卖
 */
export type PawnshopActionType = 'pawn' | 'redeem' | 'overdue' | 'auction';

/**
 * 当票数据结构
 * 对应后端 pawnshop_listings 表
 */
export interface PawnshopListing {
  /** 当票 ID */
  id: number;
  /** 典当人玩家 ID */
  player_id: number;
  /** 物品配置键名 */
  item_key: string;
  /** 物品名称 */
  item_name: string;
  /** 物品品质 */
  item_quality: string;
  /** 典当数量 */
  quantity: number;
  /** 物品基础价值 */
  base_price: number;
  /** 估值（含信用加成） */
  valuation: number;
  /** 实际获得灵石（估值 - 手续费） */
  pawn_amount: number;
  /** 赎回价（含利息） */
  redeem_amount: number;
  /** 手续费 */
  pawn_fee: number;
  /** 典当时间 */
  pawned_at: string;
  /** 赎回截止时间 */
  redeem_deadline: string;
  /** 实际赎回时间 */
  redeemed_at: string | null;
  /** 状态 */
  status: PawnshopListingStatus;
  /** 赎回操作人玩家 ID（GM 代赎时记录） */
  redeemed_by: number | null;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
  /** 当前赎回价（活跃当票动态计算，含已产生利息） */
  current_redeem_amount?: number;
  /** 剩余赎回时间（毫秒，仅活跃当票返回） */
  remaining_ms?: number;
}

/**
 * 当铺历史记录
 */
export interface PawnshopHistoryItem {
  /** 记录 ID */
  id: number;
  /** 玩家 ID */
  player_id: number;
  /** 关联当票 ID */
  listing_id: number | null;
  /** 操作类型 */
  action_type: PawnshopActionType;
  /** 物品 key */
  item_key: string;
  /** 物品名称 */
  item_name: string;
  /** 数量 */
  quantity: number;
  /** 涉及灵石数 */
  amount: number;
  /** 详情 JSON */
  detail: string | null;
  /** 创建时间 */
  created_at: string;
}

/**
 * 当铺公开配置
 */
export interface PawnshopConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 单次典当最大数量 */
  max_pawn_quantity_per_transaction: number;
  /** 每日典当次数上限 */
  daily_pawn_limit: number;
  /** 活跃当票上限 */
  max_active_listings: number;
  /** 赎回期限（天） */
  redeem_period_days: number;
  /** 每日利息率 */
  redeem_daily_interest_rate: number;
  /** 逾期宽限小时数 */
  overdue_grace_hours: number;
  /** 手续费率 */
  pawn_fee_rate: number;
  /** 信用额度上限 */
  credit_max: number;
  /** 每点信用增加的估值比例 */
  credit_discount_bonus_per_point: number;
}

/**
 * 当铺状态（GET /pawnshop/status 返回）
 */
export interface PawnshopStatus {
  /** 当铺信用额度 */
  credit: number;
  /** 当前灵石（字符串大数） */
  spirit_stones: string;
  /** 今日已典当次数 */
  daily_pawn_count: number;
  /** 每日典当次数上限 */
  daily_pawn_limit: number;
  /** 活跃当票数 */
  active_listings_count: number;
  /** 活跃当票上限 */
  max_active_listings: number;
  /** 最近活跃当票列表（5 条） */
  active_listings: PawnshopListing[];
  /** 最近历史记录（5 条） */
  history: PawnshopHistoryItem[];
  /** 当铺配置 */
  config: PawnshopConfig;
}

/**
 * 估值预览结果（POST /pawnshop/appraise 返回）
 */
export interface AppraiseResult {
  /** 物品信息 */
  item_info: {
    item_key: string;
    name: string;
    type: string;
    subtype: string | null;
    quality: string;
    description: string;
  };
  /** 物品基础价值 */
  base_price: number;
  /** 品质折扣比例 */
  quality_ratio: number;
  /** 信用加成（0-0.10） */
  credit_bonus: number;
  /** 单件估值 */
  valuation_per_item: number;
  /** 典当数量 */
  quantity: number;
  /** 总估值 */
  total_valuation: number;
  /** 实得灵石 */
  pawn_amount: number;
  /** 手续费 */
  pawn_fee: number;
  /** 手续费率 */
  pawn_fee_rate: number;
  /** 7 天后赎回价预估 */
  redeem_amount_7d: number;
}

/**
 * 典当响应（POST /pawnshop/pawn 返回）
 */
export interface PawnResult {
  success: boolean;
  message: string;
  listing_id: number;
  item_key: string;
  item_name: string;
  quantity: number;
  pawn_amount: number;
  pawn_fee: number;
  /** 初始赎回价（含 7 天利息） */
  redeem_amount_initial: number;
  /** 赎回截止时间 */
  redeem_deadline: string;
  /** 典当后灵石余额（字符串大数） */
  spirit_stones_after: string;
}

/**
 * 赎回响应（POST /pawnshop/redeem 返回）
 */
export interface RedeemResult {
  success: boolean;
  message: string;
  listing_id: number;
  item_key: string;
  item_name: string;
  quantity: number;
  redeem_amount: number;
  /** 赎回后信用额度 */
  credit_after: number;
  /** 赎回后灵石余额（字符串大数） */
  spirit_stones_after: string;
}

/**
 * 当票列表查询参数
 */
export interface PawnshopListParams {
  /** 页码（默认 1） */
  page?: number;
  /** 每页条数（默认 10，最大 50） */
  limit?: number;
  /** 筛选类型：all/active/redeemed/overdue */
  filter?: 'all' | 'active' | 'redeemed' | 'overdue';
}

/**
 * 历史记录查询参数
 */
export interface PawnshopHistoryParams {
  /** 页码（默认 1） */
  page?: number;
  /** 每页条数（默认 10，最大 50） */
  limit?: number;
}

/**
 * 分页响应
 */
export interface PaginatedResponse<T> {
  list: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

/**
 * 获取当铺状态（信用/今日次数/活跃当票/最近历史）
 * GET /pawnshop/status
 */
export const getStatus = () => {
  return apiClient.get<PawnshopStatus>('/pawnshop/status');
};

/**
 * 估值预览（不实际典当，仅返回估值）
 * POST /pawnshop/appraise
 * @param item_key 物品 key
 * @param quantity 典当数量
 */
export const appraise = (item_key: string, quantity: number) => {
  return apiClient.post<AppraiseResult>('/pawnshop/appraise', { item_key, quantity });
};

/**
 * 典当物品（扣减物品、增加灵石、创建当票）
 * POST /pawnshop/pawn
 * @param item_key 物品 key
 * @param quantity 典当数量
 */
export const pawn = (item_key: string, quantity: number) => {
  return apiClient.post<PawnResult>('/pawnshop/pawn', { item_key, quantity });
};

/**
 * 赎回当票（扣减灵石、归还物品、增加信用）
 * POST /pawnshop/redeem
 * @param listing_id 当票 ID
 */
export const redeem = (listing_id: number) => {
  return apiClient.post<RedeemResult>('/pawnshop/redeem', { listing_id });
};

/**
 * 获取当票列表（分页）
 * GET /pawnshop/list
 * @param params 查询参数 { page, limit, filter }
 */
export const getList = (params: PawnshopListParams = {}) => {
  return apiClient.get<PaginatedResponse<PawnshopListing>>('/pawnshop/list', { params });
};

/**
 * 获取历史记录（分页）
 * GET /pawnshop/history
 * @param params 查询参数 { page, limit }
 */
export const getHistory = (params: PawnshopHistoryParams = {}) => {
  return apiClient.get<PaginatedResponse<PawnshopHistoryItem>>('/pawnshop/history', { params });
};
