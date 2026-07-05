/**
 * 聚宝股市管理 API（GM 后台）
 *
 * 封装 GM 后台对股市系统的统计、查询、调价、暂停/恢复、事件触发、
 * 强制平仓、分红派发等接口。所有接口需要管理员权限（auth + adminCheck 双层中间件）。
 *
 * 接口列表：
 *   1.  GET  /admin/stock/metrics                       - 股市统计指标
 *   2.  GET  /admin/stock/stocks                        - 所有股票列表（分页）
 *   3.  GET  /admin/stock/stocks/:stockId               - 股票详情
 *   4.  PUT  /admin/stock/stocks/:stockId/price         - GM 调整股价
 *   5.  POST /admin/stock/stocks/:stockId/halt          - GM 暂停交易
 *   6.  POST /admin/stock/stocks/:stockId/resume       - GM 恢复交易
 *   7.  POST /admin/stock/events                        - GM 触发股价事件
 *   8.  GET  /admin/stock/margin/list                   - 融资账户列表（分页）
 *   9.  POST /admin/stock/margin/:playerId/force-liquidate - GM 强制平仓
 *  10.  GET  /admin/stock/transactions                  - 全服交易流水（分页，支持筛选）
 *  11.  POST /admin/stock/dividends/distribute          - GM 手动触发分红
 */
import apiClient from './index';
import type {
  StockCategory,
  StockTradeType,
  StockDetail,
  PaginatedResponse
} from './stock';

/**
 * 股市统计指标（GET /admin/stock/metrics 返回）
 */
export interface StockMetrics {
  /** 股票统计 */
  stocks: {
    /** 活跃股票数 */
    active: number;
    /** 熔断中股票数 */
    halted: number;
  };
  /** 持仓玩家数（去重） */
  holders_count: number;
  /** 总持仓市值（字符串大数） */
  total_holdings_value: string;
  /** 今日交易汇总 */
  today_transactions: {
    /** 今日交易笔数 */
    count: number;
    /** 今日买入总额（字符串大数） */
    buy_amount: string;
    /** 今日卖出总额（字符串大数） */
    sell_amount: string;
  };
  /** 融资账户统计 */
  margin: {
    /** 融资账户总数 */
    accounts_count: number;
    /** 已爆仓账户数 */
    liquidated_count: number;
    /** 总负债（字符串大数） */
    total_debt: string;
  };
  /** 活跃事件数 */
  active_events_count: number;
}

/**
 * GM 端股票列表项（含管理字段，比玩家端多 is_active/last_price_update 等）
 */
export interface StockAdmin {
  /** 股票 ID */
  id: number;
  /** 股票代码 */
  code: string;
  /** 股票名称 */
  name: string;
  /** 分类 */
  category: StockCategory;
  /** 当前价（字符串大数） */
  current_price: string;
  /** 今日开盘价（字符串大数） */
  open_price: string;
  /** 昨日收盘价（字符串大数） */
  yesterday_close_price: string;
  /** 今日涨跌幅（小数） */
  daily_change_pct: number;
  /** 今日成交量（字符串大数） */
  daily_volume: string;
  /** 总股本（字符串大数） */
  total_shares: string;
  /** 流通股本（字符串大数） */
  float_shares: string;
  /** 基础波动率（小数） */
  base_volatility: number;
  /** 是否熔断停牌 */
  is_trading_halted: boolean;
  /** 熔断恢复时间 */
  halt_until: string | null;
  /** 股票描述 */
  description: string;
  /** 是否启用 */
  is_active: boolean;
  /** 最后价格更新时间 */
  last_price_update: string;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
}

/**
 * GM 端交易流水项（含玩家昵称、境界信息）
 */
export interface StockAdminTransaction {
  /** 交易 ID */
  id: number;
  /** 玩家 ID */
  player_id: number;
  /** 玩家昵称 */
  player_nickname: string;
  /** 玩家境界 */
  player_realm: string;
  /** 股票 ID */
  stock_id: number;
  /** 股票代码 */
  stock_code: string;
  /** 股票名称 */
  stock_name: string;
  /** 交易类型 */
  trade_type: StockTradeType;
  /** 数量（字符串大数） */
  quantity: string;
  /** 成交价（字符串大数） */
  price: string;
  /** 成交金额（字符串大数） */
  amount: string;
  /** 手续费（字符串大数） */
  fee: string;
  /** 印花税（字符串大数） */
  tax: string;
  /** 是否融资交易 */
  is_margin: boolean;
  /** 交易状态 */
  status: string;
  /** 交易时间 */
  created_at: string;
}

/**
 * GM 端融资账户列表项
 */
export interface StockAdminMarginAccount {
  /** 融资账户 ID */
  id: number;
  /** 玩家 ID */
  player_id: number;
  /** 玩家昵称 */
  player_nickname: string;
  /** 玩家境界 */
  player_realm: string;
  /** 总资产（字符串大数） */
  total_assets: string;
  /** 负债（字符串大数） */
  debt: string;
  /** 维持保证金率（小数） */
  margin_ratio: number;
  /** 是否已爆仓 */
  is_liquidated: boolean;
  /** 最后强平检查时间 */
  last_liquidation_check: string;
  /** 玩家股市账户余额（实时，字符串大数） */
  player_stock_account_balance: string;
  /** 玩家融资负债（实时，字符串大数） */
  player_stock_margin_debt: string;
  /** 创建时间 */
  created_at: string;
}

/**
 * GM 调价请求参数
 */
export interface StockAdjustPriceRequest {
  /** 新价格 */
  new_price: number | string;
  /** 操作原因（记录到审计日志） */
  reason: string;
}

/**
 * GM 暂停交易请求参数
 */
export interface StockHaltRequest {
  /** 暂停时长（分钟） */
  duration_minutes: number;
  /** 操作原因 */
  reason: string;
}

/**
 * GM 触发事件请求参数
 */
export interface StockTriggerEventRequest {
  /** 股票 ID（null 表示全市场事件） */
  stock_id: number | null;
  /** 事件类型 */
  event_type: string;
  /** 影响百分比（小数，如 0.05 表示 +5%） */
  impact_pct: number;
  /** 持续时间（小时） */
  duration_hours: number;
  /** 事件描述 */
  description: string;
}

/**
 * GM 手动触发分红请求参数
 */
export interface StockDistributeDividendRequest {
  /** 股票 ID */
  stock_id: number;
  /** 操作原因 */
  reason?: string;
}

/**
 * GM 强制平仓请求参数
 */
export interface StockForceLiquidateRequest {
  /** 操作原因 */
  reason?: string;
}

/**
 * 股票列表查询参数
 */
export interface StockAdminListParams {
  /** 页码 */
  page?: number;
  /** 每页条数 */
  limit?: number;
  /** 按分类筛选 */
  category?: StockCategory;
}

/**
 * 交易流水查询参数
 */
export interface StockAdminTransactionParams {
  /** 页码 */
  page?: number;
  /** 每页条数 */
  limit?: number;
  /** 按玩家 ID 筛选 */
  player_id?: number;
  /** 按股票 ID 筛选 */
  stock_id?: number;
  /** 按交易类型筛选：buy/sell */
  trade_type?: StockTradeType;
}

/**
 * 融资账户列表查询参数
 */
export interface StockAdminMarginListParams {
  /** 页码 */
  page?: number;
  /** 每页条数 */
  limit?: number;
  /** 按爆仓状态筛选：true 仅已爆仓，false 仅未爆仓 */
  is_liquidated?: boolean;
}

/* ===================== API 函数 ===================== */

/**
 * 获取股市统计指标
 * GET /admin/stock/metrics
 */
export const getMetrics = () => {
  return apiClient.get<StockMetrics>('/admin/stock/metrics');
};

/**
 * 获取所有股票列表（分页，含管理字段）
 * GET /admin/stock/stocks
 * @param params 查询参数 { page, limit, category }
 */
export const getStocks = (params: StockAdminListParams = {}) => {
  return apiClient.get<PaginatedResponse<StockAdmin>>('/admin/stock/stocks', {
    params
  });
};

/**
 * 获取股票详情（含 K线、活跃事件）
 * GET /admin/stock/stocks/:stockId
 * @param stockId 股票 ID
 */
export const getStockDetail = (stockId: number) => {
  return apiClient.get<StockDetail>(`/admin/stock/stocks/${stockId}`);
};

/**
 * GM 调整股价
 * PUT /admin/stock/stocks/:stockId/price
 * @param stockId 股票 ID
 * @param params { new_price, reason }
 */
export const adjustPrice = (stockId: number, params: StockAdjustPriceRequest) => {
  return apiClient.put(`/admin/stock/stocks/${stockId}/price`, params);
};

/**
 * GM 暂停股票交易
 * POST /admin/stock/stocks/:stockId/halt
 * @param stockId 股票 ID
 * @param params { duration_minutes, reason }
 */
export const haltStock = (stockId: number, params: StockHaltRequest) => {
  return apiClient.post(`/admin/stock/stocks/${stockId}/halt`, params);
};

/**
 * GM 恢复股票交易
 * POST /admin/stock/stocks/:stockId/resume
 * @param stockId 股票 ID
 * @param reason 操作原因
 */
export const resumeStock = (stockId: number, reason?: string) => {
  return apiClient.post(`/admin/stock/stocks/${stockId}/resume`, { reason });
};

/**
 * GM 触发股价事件
 * POST /admin/stock/events
 * @param params 事件参数
 */
export const triggerEvent = (params: StockTriggerEventRequest) => {
  return apiClient.post('/admin/stock/events', params);
};

/**
 * 获取融资账户列表（分页）
 * GET /admin/stock/margin/list
 * @param params 查询参数 { page, limit, is_liquidated }
 */
export const getMarginList = (page: number = 1, limit: number = 20, params: StockAdminMarginListParams = {}) => {
  return apiClient.get<PaginatedResponse<StockAdminMarginAccount>>('/admin/stock/margin/list', {
    params: { page, limit, ...params }
  });
};

/**
 * GM 强制平仓
 * POST /admin/stock/margin/:playerId/force-liquidate
 * @param playerId 玩家 ID
 * @param reason 操作原因
 */
export const forceLiquidate = (playerId: number, reason?: string) => {
  return apiClient.post(`/admin/stock/margin/${playerId}/force-liquidate`, { reason });
};

/**
 * 获取全服交易流水（分页，支持筛选）
 * GET /admin/stock/transactions
 * @param params 查询参数 { page, limit, player_id, stock_id, trade_type }
 */
export const getTransactions = (params: StockAdminTransactionParams = {}) => {
  return apiClient.get<PaginatedResponse<StockAdminTransaction>>('/admin/stock/transactions', {
    params
  });
};

/**
 * GM 手动触发分红
 * POST /admin/stock/dividends/distribute
 * @param stockId 股票 ID
 * @param reason 操作原因
 */
export const distributeDividend = (stockId: number, reason?: string) => {
  return apiClient.post('/admin/stock/dividends/distribute', { stock_id: stockId, reason });
};
