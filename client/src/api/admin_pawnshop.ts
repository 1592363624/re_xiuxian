/**
 * 当铺管理 API（GM 后台）
 *
 * 封装 GM 后台对当铺系统的统计、查询、强制赎回、强制取消、调整信用等接口。
 * 所有接口需要管理员权限（后端 auth + adminCheck 双层中间件）。
 *
 * 接口列表：
 *   1. GET  /admin/pawnshop/metrics                - 统计指标（活跃当票数、今日典当总额、逾期数）
 *   2. GET  /admin/pawnshop/list                   - 分页查询所有当票
 *   3. GET  /admin/pawnshop/:listingId             - 查询指定当票详情
 *   4. POST /admin/pawnshop/:listingId/force-redeem - 强制赎回（GM 代赎，不扣玩家灵石）
 *   5. POST /admin/pawnshop/:listingId/cancel      - 强制取消（物品归还玩家，不扣灵石）
 *   6. PUT  /admin/pawnshop/credit/:playerId       - 调整玩家当铺信用额度
 */
import apiClient from './index';
import type {
  PawnshopListing,
  PawnshopHistoryItem
} from './pawnshop';

/**
 * 当铺管理 - 当票列表项（含玩家信息）
 */
export interface AdminPawnshopListItem extends PawnshopListing {
  /** 玩家昵称 */
  player_nickname: string;
  /** 玩家境界 */
  player_realm: string;
}

/**
 * 当铺管理 - 当票详情（含玩家信息与关联历史）
 */
export interface AdminPawnshopDetail {
  /** 当票信息 */
  listing: PawnshopListing;
  /** 玩家信息 */
  player: {
    id: number;
    nickname: string;
    realm: string;
    pawnshop_credit: number;
    spirit_stones: string;
  } | null;
  /** 关联历史记录 */
  histories: PawnshopHistoryItem[];
}

/**
 * 统计指标（GET /admin/pawnshop/metrics 返回）
 */
export interface PawnshopMetrics {
  /** 当票状态分布 */
  listings: {
    active: number;
    overdue: number;
    redeemed: number;
    total: number;
  };
  /** 今日交易汇总 */
  today: {
    /** 今日典当笔数 */
    pawn_count: number;
    /** 今日典当总额（字符串大数） */
    pawn_total_amount: string;
    /** 今日赎回笔数 */
    redeem_count: number;
    /** 今日赎回总额（字符串大数） */
    redeem_total_amount: string;
  };
  /** 信用分布 */
  credit: {
    /** 信用额度 > 0 的玩家数 */
    players_with_credit: number;
    /** 总玩家数 */
    total_players: number;
    /** 平均信用额度 */
    avg_credit: number;
  };
}

/**
 * 列表查询参数
 */
export interface AdminPawnshopListParams {
  /** 页码（默认 1） */
  page?: number;
  /** 每页条数（默认 20，最大 100） */
  limit?: number;
  /** 按玩家 ID 筛选 */
  player_id?: number;
  /** 按状态筛选：active/redeemed/overdue/auctioned */
  status?: string;
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
 * 获取当铺系统统计指标
 * GET /admin/pawnshop/metrics
 */
export const getMetrics = () => {
  return apiClient.get<PawnshopMetrics>('/admin/pawnshop/metrics');
};

/**
 * 分页查询所有当票（支持 player_id 与 status 筛选）
 * GET /admin/pawnshop/list
 * @param params 查询参数
 */
export const getList = (params: AdminPawnshopListParams = {}) => {
  return apiClient.get<PaginatedResponse<AdminPawnshopListItem>>(
    '/admin/pawnshop/list',
    { params }
  );
};

/**
 * 查询指定当票详情
 * GET /admin/pawnshop/:listingId
 * @param listingId 当票 ID
 */
export const getDetail = (listingId: number) => {
  return apiClient.get<AdminPawnshopDetail>(`/admin/pawnshop/${listingId}`);
};

/**
 * 强制赎回当票（GM 代赎，不扣玩家灵石）
 * POST /admin/pawnshop/:listingId/force-redeem
 * @param listingId 当票 ID
 * @param playerId 玩家 ID（用于校验归属）
 * @param reason 操作原因
 */
export const forceRedeem = (listingId: number, playerId: number, reason: string) => {
  return apiClient.post(`/admin/pawnshop/${listingId}/force-redeem`, {
    player_id: playerId,
    reason
  });
};

/**
 * 强制取消当票（物品归还玩家，不扣灵石）
 * POST /admin/pawnshop/:listingId/cancel
 * @param listingId 当票 ID
 * @param reason 操作原因
 */
export const cancelListing = (listingId: number, reason: string) => {
  return apiClient.post(`/admin/pawnshop/${listingId}/cancel`, { reason });
};

/**
 * 调整玩家当铺信用额度
 * PUT /admin/pawnshop/credit/:playerId
 * @param playerId 玩家 ID
 * @param credit 新的信用额度值（0 - credit_max）
 * @param reason 操作原因
 */
export const updateCredit = (playerId: number, credit: number, reason: string) => {
  return apiClient.put(`/admin/pawnshop/credit/${playerId}`, { credit, reason });
};
