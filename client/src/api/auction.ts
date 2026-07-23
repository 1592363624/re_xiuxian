/**
 * 拍卖系统 API
 *
 * 封装拍卖竞价博弈玩法的接口调用：创建拍卖、列表查询、详情、出价、撤销、
 * 我的拍卖、我的竞价、GM 运维接口。
 *
 * 设计原则：
 *   - 所有业务逻辑由后端 AuctionService 处理，前端仅做调用与展示
 *   - 禁止直接 axios，统一使用 apiClient（携带 JWT + 统一错误处理）
 *   - BIGINT 金额字段使用 string 类型，避免 JS Number 精度问题
 *   - 与万宝楼（标价直购）差异化：拍卖是"竞价博弈"（多人竞争 + 倒计时 + 防秒杀）
 *
 * 玩法文档对照：xiuxian_game_guide.md 第27节·市场、股市与资产路线
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
import apiClient from './index';

/**
 * 拍卖状态枚举
 * - open: 进行中（可竞价）
 * - closed: 已结束（已结算）
 * - cancelled: 已撤销（卖家主动撤销）
 */
export type AuctionStatus = 'open' | 'closed' | 'cancelled';

/**
 * 拍卖配置（GET /auction/config 返回）
 */
export interface AuctionConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 拍卖时长（小时） */
  duration_hours: {
    min: number;
    max: number;
    default: number;
  };
  /** 起拍价范围 */
  starting_price: {
    min: number;
    max: number;
  };
  /** 加价规则 */
  bid: {
    min_increment_rate: number;
    min_increment_absolute: number;
    max_increment_absolute: number;
  };
  /** 手续费率（成交时从卖家所得中扣除） */
  fee_rate: number;
  /** 防秒杀机制 */
  anti_snipe: {
    enabled: boolean;
    extension_seconds: number;
    trigger_threshold_seconds: number;
    max_extensions: number;
  };
  /** 卖家限制 */
  seller: {
    max_concurrent_auctions: number;
    cancel_fee_when_bidded: number;
    min_level_rank: number;
  };
  /** 竞价者限制 */
  bidder: {
    min_level_rank: number;
    max_concurrent_bids: number;
  };
  /** 调度器配置 */
  scheduler: {
    settle_check_interval_ms: number;
    batch_size: number;
  };
  /** 列表配置 */
  list: {
    default_page_size: number;
    max_page_size: number;
  };
  /** WebSocket 事件名 */
  websocket: {
    events: {
      auction_new_bid: string;
      auction_won: string;
      auction_settled: string;
      auction_cancelled: string;
      auction_outbid: string;
    };
  };
}

/**
 * 拍卖摘要（列表项 / 我的拍卖项）
 * 对应后端 AuctionService._formatAuctionSummary 返回
 */
export interface AuctionSummary {
  /** 拍卖 ID */
  id: number;
  /** 卖家玩家 ID */
  seller_id: number;
  /** 卖家昵称 */
  seller_nickname: string | null;
  /** 物品配置键名 */
  item_key: string;
  /** 物品名称 */
  item_name: string;
  /** 物品品质 */
  item_quality: string;
  /** 数量 */
  quantity: number;
  /** 起拍价（字符串大数） */
  starting_price: string;
  /** 当前价（字符串大数） */
  current_price: string;
  /** 当前最高竞价者 ID */
  current_bidder_id: number | null;
  /** 拍卖状态 */
  status: AuctionStatus;
  /** 开始时间 */
  start_at: string;
  /** 结束时间 */
  end_at: string;
  /** 得标者 ID */
  winner_id: number | null;
  /** 成交价（字符串大数） */
  final_price: string | null;
  /** 手续费率快照 */
  fee_rate: number;
  /** 防秒杀延长次数 */
  extension_count: number;
  /** 剩余时间（毫秒，负值表示已过期） */
  remaining_ms: number;
  /** 是否即将结束（剩余 < 60s） */
  ending_soon: boolean;
  /** 创建时间 */
  created_at: string;
  /** 结算时间 */
  settled_at: string | null;
}

/**
 * 竞价历史项
 */
export interface AuctionBidRecord {
  /** 竞价记录 ID */
  id: number;
  /** 拍卖 ID */
  auction_id: number;
  /** 竞价者 ID */
  bidder_id: number;
  /** 竞价者昵称 */
  bidder_nickname: string | null;
  /** 出价（字符串大数） */
  bid_price: string;
  /** 竞价时间 */
  created_at: string;
}

/**
 * 拍卖详情（GET /auction/:id 返回）
 */
export interface AuctionDetail extends AuctionSummary {
  /** 卖家详情（含境界） */
  seller: {
    player_id: number;
    nickname: string;
    realm: string;
  } | null;
  /** 当前查看者是否为卖家 */
  is_seller: boolean;
  /** 当前查看者是否为最高竞价者 */
  is_current_bidder: boolean;
  /** 最小下一手出价（前端用于提示） */
  min_next_bid: number;
  /** 竞价总数 */
  bid_count: number;
  /** 竞价历史（最近 20 条，按时间倒序） */
  bids: AuctionBidRecord[];
}

/**
 * 我的竞价项（GET /auction/my-bids 返回）
 */
export interface MyBidItem {
  /** 拍卖摘要 */
  auction: AuctionSummary;
  /** 我的出价（字符串大数） */
  my_bid_price: string;
  /** 我的竞价时间 */
  my_bid_at: string;
  /** 是否领先（我是当前最高竞价者） */
  leading: boolean;
  /** 是否得标（拍卖已结束且我得标） */
  won: boolean;
  /** 是否落标（拍卖已结束且我未得标，灵石已退还） */
  lost: boolean;
}

/**
 * 列表查询参数
 */
export interface AuctionListParams {
  page?: number;
  page_size?: number;
  status?: AuctionStatus;
  quality?: string;
  keyword?: string;
  sort?: 'end_at_asc' | 'current_price_desc' | 'current_price_asc';
}

/**
 * 列表响应
 */
export interface AuctionListResult {
  auctions: AuctionSummary[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * 我的拍卖响应
 */
export interface MyAuctionsResult {
  auctions: AuctionSummary[];
  total: number;
}

/**
 * 我的竞价响应
 */
export interface MyBidsResult {
  bids: MyBidItem[];
  total: number;
}

/**
 * 创建拍卖请求体
 */
export interface CreateAuctionPayload {
  item_key: string;
  quantity: number;
  starting_price: number;
  duration_hours: number;
}

/**
 * 创建拍卖响应
 */
export interface CreateAuctionResult {
  success: boolean;
  message: string;
  auction: {
    id: number;
    item_key: string;
    item_name: string;
    item_quality: string;
    quantity: number;
    starting_price: string;
    current_price: string;
    status: AuctionStatus;
    end_at: string;
    fee_rate: number;
  };
}

/**
 * 出价响应
 */
export interface PlaceBidResult {
  success: boolean;
  message: string;
  auction_id: number;
  new_price: string;
  previous_bidder_id: number | null;
  /** 防秒杀是否触发延长 */
  extended: boolean;
  /** 延长后的新结束时间（仅 extended=true 时有值） */
  new_end_at: string | null;
  /** 剩余冻结灵石（字符串大数） */
  frozen_amount: string;
  /** 竞价后灵石余额（字符串大数） */
  spirit_stones_after: string;
}

/**
 * 撤销拍卖响应
 */
export interface CancelAuctionResult {
  success: boolean;
  message: string;
  auction_id: number;
  /** 补偿费（已有人竞价时撤销需支付） */
  compensation_fee: number;
}

/**
 * GM 结算响应
 */
export interface GmSettleResult {
  settled: number;
  failed: number;
  details: Array<{
    auction_id: number;
    status: 'ok' | 'error';
    result?: unknown;
    message?: string;
  }>;
}

/**
 * GM 调度器状态
 */
export interface GmSchedulerStatus {
  running: boolean;
  busy: boolean;
  interval_ms: number;
}

// ==================== API 函数 ====================

/**
 * 获取拍卖系统配置（无需鉴权）
 * GET /auction/config
 */
export const getConfig = () => {
  return apiClient.get<AuctionConfig>('/auction/config');
};

/**
 * 获取拍卖列表（分页 + 筛选）
 * GET /auction/list
 */
export const getList = (params: AuctionListParams = {}) => {
  return apiClient.get<AuctionListResult>('/auction/list', { params });
};

/**
 * 获取拍卖详情（含竞价历史）
 * GET /auction/:id
 * @param id 拍卖 ID
 */
export const getDetail = (id: number) => {
  return apiClient.get<AuctionDetail>(`/auction/${id}`);
};

/**
 * 创建拍卖
 * POST /auction/create
 * @param payload 创建参数
 */
export const createAuction = (payload: CreateAuctionPayload) => {
  return apiClient.post<{ code: number; message: string; data: CreateAuctionResult }>('/auction/create', payload);
};

/**
 * 出价
 * POST /auction/:id/bid
 * @param id 拍卖 ID
 * @param bid_price 出价金额
 */
export const placeBid = (id: number, bid_price: number) => {
  return apiClient.post<{ code: number; message: string; data: PlaceBidResult }>(`/auction/${id}/bid`, { bid_price });
};

/**
 * 撤销拍卖
 * POST /auction/:id/cancel
 * @param id 拍卖 ID
 * @param reason 撤销原因（可选）
 */
export const cancelAuction = (id: number, reason?: string) => {
  return apiClient.post<{ code: number; message: string; data: CancelAuctionResult }>(`/auction/${id}/cancel`, { reason: reason || '' });
};

/**
 * 获取我的拍卖
 * GET /auction/my
 * @param status 状态筛选（可选）
 */
export const getMyAuctions = (status?: AuctionStatus) => {
  return apiClient.get<MyAuctionsResult>('/auction/my', { params: status ? { status } : {} });
};

/**
 * 获取我的竞价
 * GET /auction/my-bids
 */
export const getMyBids = () => {
  return apiClient.get<MyBidsResult>('/auction/my-bids');
};

// ==================== GM 运维接口 ====================

/**
 * [GM] 手动触发到期拍卖结算
 * POST /auction/gm/settle
 */
export const gmSettle = () => {
  return apiClient.post<{ code: number; message: string; data: GmSettleResult }>('/auction/gm/settle', {});
};

/**
 * [GM] 查看调度器状态
 * GET /auction/gm/scheduler
 */
export const gmGetSchedulerStatus = () => {
  return apiClient.get<GmSchedulerStatus>('/auction/gm/scheduler');
};
