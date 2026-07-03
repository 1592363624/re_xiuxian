/**
 * 坊市（万宝楼）系统 API
 *
 * 封装坊市挂单的查询、搜索、上架、购买（换物）、下架接口调用。
 * 万宝楼为换物系统：卖家上架物品 A，标价换取物品 B，买家用 B 换走 A。
 * 所有业务逻辑由后端 MarketService 处理，前端仅做调用与展示。
 */
import apiClient from './index';

/**
 * 挂单状态枚举
 * - active: 上架中
 * - sold: 已售出
 * - cancelled: 已下架
 */
export type ListingStatus = 'active' | 'sold' | 'cancelled';

/**
 * 坊市挂单数据结构
 * 对应后端 market_listings 表（raw 查询返回的字段）
 */
export interface MarketListing {
  /** 挂单 ID */
  id: number;
  /** 卖家玩家 ID */
  seller_id: number;
  /** 出售物品配置键名 */
  item_key: string;
  /** 出售物品名称（冗余存储便于列表展示） */
  item_name: string;
  /** 出售数量 */
  quantity: number;
  /** 换取物品配置键名 */
  want_item_key: string;
  /** 换取物品名称 */
  want_item_name: string;
  /** 换取数量 */
  want_quantity: number;
  /** 挂单状态 */
  status: ListingStatus;
  /** 买家玩家 ID（成交时写入，未成交为 null） */
  buyer_id: number | null;
  /** 成交时间（未成交为 null） */
  sold_at: string | null;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/**
 * 创建挂单（上架）请求参数
 */
export interface CreateListingData {
  /** 出售物品配置键名 */
  item_key: string;
  /** 出售数量 */
  quantity: number;
  /** 换取物品配置键名 */
  want_item_key: string;
  /** 换取数量 */
  want_quantity: number;
}

/**
 * 挂单列表分页响应
 */
export interface ListingListResponse {
  /** 当前页挂单列表 */
  list: MarketListing[];
  /** 总记录数 */
  total: number;
  /** 当前页码（从 1 开始） */
  page: number;
  /** 每页条数 */
  page_size: number;
  /** 总页数 */
  total_pages: number;
}

/**
 * 获取坊市挂单列表（分页，支持按物品类型/名称筛选）
 * @param params 查询参数 { page?, type?, keyword? }
 */
export const getListings = (params: { page?: number; type?: string; keyword?: string } = {}) => {
  return apiClient.get('/market/list', { params });
};

/**
 * 搜索坊市挂单（按物品名称模糊搜索，同时匹配出售与换取物品名称）
 * @param keyword 搜索关键词
 * @param page 页码（从 1 开始）
 */
export const searchListings = (keyword: string, page: number = 1) => {
  return apiClient.get('/market/search', { params: { keyword, page } });
};

/**
 * 获取我的货摊（当前玩家的所有挂单，含已售出/已下架）
 * @param page 页码（从 1 开始）
 */
export const getMyListings = (page: number = 1) => {
  return apiClient.get('/market/my', { params: { page } });
};

/**
 * 上架物品（创建挂单）
 * @param data 上架参数
 */
export const createListing = (data: CreateListingData) => {
  return apiClient.post('/market/list', data);
};

/**
 * 购买挂单（换物交易，用换取物品换走上架物品）
 * @param listing_id 挂单 ID
 */
export const buyListing = (listing_id: number) => {
  return apiClient.post('/market/buy', { listing_id });
};

/**
 * 下架挂单（退还物品给卖家）
 * @param listing_id 挂单 ID
 */
export const cancelListing = (listing_id: number) => {
  return apiClient.post('/market/cancel', { listing_id });
};
