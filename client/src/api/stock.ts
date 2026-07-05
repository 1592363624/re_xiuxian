/**
 * 聚宝股市系统 API（玩家端）
 *
 * 封装玩家在股市的行情查询、买卖交易、融资融券、分红查询、资金转入转出接口调用。
 * 股市为高阶修士的灵石博弈玩法：玩家将灵石转入股市账户，买卖 12 只主题股票，
 * 支持融资融券（max_leverage × 总资产），T+1 结算，熔断与强平机制保障系统稳定。
 *
 * 设计原则：
 *   - 所有业务逻辑由后端 StockMarketService 处理，前端仅做调用与展示
 *   - 禁止直接 axios，统一使用 apiClient（携带 JWT + 统一错误处理）
 *   - BIGINT 金额字段使用 string 类型，避免 JS Number 精度问题
 *   - 所有手续费/印花税/市值由后端计算返回，前端不做任何业务计算
 */
import apiClient from './index';

/**
 * 股票分类枚举
 * - sect: 宗门股
 * - mine: 灵矿股
 * - dungeon: 秘境股
 * - event: 事件股
 */
export type StockCategory = 'sect' | 'mine' | 'dungeon' | 'event';

/**
 * 交易类型枚举
 * - buy: 买入
 * - sell: 卖出
 */
export type StockTradeType = 'buy' | 'sell';

/**
 * 分红类型枚举
 * - regular: 常规分红
 * - special: 特别分红
 */
export type StockDividendType = 'regular' | 'special';

/**
 * 交易状态枚举
 * - success: 成交
 * - failed: 失败
 * - pending: 待结算
 */
export type StockTransactionStatus = 'success' | 'failed' | 'pending';

/**
 * K线周期枚举
 * - 1h: 1 小时
 * - 1d: 1 天
 * - 1w: 1 周
 */
export type StockKlinePeriod = '1h' | '1d' | '1w';

/**
 * 股票行情数据结构（列表项）
 * 对应后端 stocks 表，金额字段为字符串（BIGINT 序列化）
 */
export interface Stock {
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
  /** 今日涨跌幅（小数，如 0.05 表示 +5%） */
  daily_change_pct: number;
  /** 今日成交量（字符串大数） */
  daily_volume: string;
  /** 总股本（字符串大数） */
  total_shares: string;
  /** 流通股本（字符串大数） */
  float_shares: string;
  /** 是否熔断停牌 */
  is_trading_halted: boolean;
  /** 熔断恢复时间 */
  halt_until: string | null;
  /** 股票描述 */
  description: string;
  /** 活跃事件列表（影响股价） */
  active_events?: StockEvent[];
}

/**
 * 股票活跃事件
 */
export interface StockEvent {
  /** 事件 ID（详情接口返回） */
  id?: number;
  /** 事件类型 */
  event_type: string;
  /** 影响百分比（小数） */
  impact_pct: number;
  /** 事件描述 */
  description: string;
  /** 过期时间 */
  expire_at: string;
}

/**
 * K线数据
 */
export interface StockKline {
  /** 开盘价（字符串大数） */
  open: string;
  /** 收盘价（字符串大数） */
  close: string;
  /** 最高价（字符串大数） */
  high: string;
  /** 最低价（字符串大数） */
  low: string;
  /** 成交量（字符串大数） */
  volume: string;
  /** 周期开始时间 */
  period_start: string;
  /** 周期结束时间 */
  period_end: string;
}

/**
 * 股票详情（含 K线与活跃事件）
 */
export interface StockDetail extends Stock {
  /** 最后价格更新时间 */
  last_price_update: string;
  /** 近 30 条 1h K线 */
  klines: StockKline[];
  /** 活跃事件列表 */
  active_events: StockEvent[];
}

/**
 * 玩家持仓数据
 * 金额字段为字符串（BIGINT 序列化），展示时用 Number() 转换
 */
export interface StockHolding {
  /** 持仓 ID */
  id: number;
  /** 股票 ID */
  stock_id: number;
  /** 股票代码 */
  code: string;
  /** 股票名称 */
  name: string;
  /** 分类 */
  category: StockCategory;
  /** 持有数量（字符串大数） */
  quantity: string;
  /** 可用数量（T+1 结算，买入次日可用）（字符串大数） */
  available_quantity: string;
  /** 平均成本价（字符串大数） */
  average_cost: string;
  /** 总成本（字符串大数） */
  total_cost: string;
  /** 当前价（字符串大数） */
  current_price: string;
  /** 持仓市值（字符串大数） */
  market_value: string;
  /** 浮动盈亏（字符串大数，正数盈利负数亏损） */
  profit: string;
  /** 浮动盈亏率（小数，如 0.05 表示 +5%） */
  profit_pct: number;
  /** 股票是否熔断 */
  is_trading_halted: boolean;
}

/**
 * 交易历史记录
 */
export interface StockTransaction {
  /** 交易 ID */
  id: number;
  /** 股票 ID */
  stock_id: number;
  /** 股票代码 */
  code: string;
  /** 股票名称 */
  name: string;
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
  /** 印花税（仅卖出，字符串大数） */
  tax: string;
  /** 是否融资交易 */
  is_margin: boolean;
  /** 交易状态 */
  status: StockTransactionStatus;
  /** 交易时间 */
  created_at: string;
}

/**
 * 分红记录
 */
export interface StockDividend {
  /** 分红 ID */
  id: number;
  /** 股票 ID */
  stock_id: number;
  /** 股票代码 */
  code: string;
  /** 股票名称 */
  name: string;
  /** 持股数量（字符串大数） */
  quantity: string;
  /** 每股分红（字符串大数） */
  dividend_per_share: string;
  /** 分红总额（字符串大数） */
  total_dividend: string;
  /** 分红类型 */
  dividend_type: StockDividendType;
  /** 分红时间 */
  created_at: string;
}

/**
 * 融资账户详情
 */
export interface StockMarginAccount {
  /** 是否已开通融资账户 */
  has_margin_account: boolean;
  /** 融资账户 ID（未开通时为 null） */
  id?: number;
  /** 总资产（字符串大数） */
  total_assets?: string;
  /** 账户余额（字符串大数） */
  balance?: string;
  /** 持仓市值（字符串大数） */
  holdings_value?: string;
  /** 负债（字符串大数） */
  debt?: string;
  /** 维持保证金率（小数） */
  margin_ratio?: number;
  /** 是否已爆仓 */
  is_liquidated?: boolean;
  /** 最后强平检查时间 */
  last_liquidation_check?: string;
  /** 维持保证金率阈值（小数，低于此值触发强平） */
  maintenance_margin_rate?: number;
  /** 是否处于危险区（保证金率低于维持率） */
  is_danger?: boolean;
  /** 最大可融额度（字符串大数） */
  max_credit?: string;
  /** 可用融资额度（字符串大数） */
  available_credit?: string;
  /** 提示文案（未开通时返回） */
  message?: string;
}

/**
 * 股市配置（status 接口返回）
 */
export interface StockMarketConfig {
  /** 买入手续费率 */
  trading_fee_buy: number;
  /** 卖出手续费率 */
  trading_fee_sell: number;
  /** 卖出印花税率 */
  stamp_tax_sell: number;
  /** 最大杠杆倍数 */
  max_leverage: number;
  /** 单笔最小交易量 */
  min_trade_quantity: number;
  /** 单笔最大交易量 */
  max_trade_quantity: number;
  /** 每日交易次数上限 */
  daily_trade_limit: number;
  /** 是否启用 T+1 结算 */
  t_plus_1_settlement: boolean;
}

/**
 * 玩家股市状态（GET /stock/status 返回）
 */
export interface StockStatus {
  /** 账户余额（字符串大数） */
  balance: string;
  /** 持仓总市值（字符串大数） */
  holdings_value: string;
  /** 总资产 = 余额 + 持仓市值（字符串大数） */
  total_assets: string;
  /** 融资负债（字符串大数） */
  debt: string;
  /** 维持保证金率（小数） */
  margin_ratio: number;
  /** 是否被锁定交易（GM 可锁定） */
  is_trading_locked: boolean;
  /** 持仓股票数量 */
  holdings_count: number;
  /** 是否已开通融资账户 */
  has_margin_account: boolean;
  /** 融资账户状态快照 */
  margin_account_status: {
    is_liquidated: boolean;
    last_check: string | null;
  } | null;
  /** 最大可融额度（字符串大数） */
  max_credit: string;
  /** 股市配置 */
  config: StockMarketConfig;
}

/**
 * 买入请求参数
 */
export interface BuyRequest {
  /** 股票 ID */
  stock_id: number;
  /** 买入数量 */
  quantity: number;
  /** 是否使用融资买入 */
  use_margin?: boolean;
}

/**
 * 卖出请求参数
 */
export interface SellRequest {
  /** 股票 ID */
  stock_id: number;
  /** 卖出数量 */
  quantity: number;
}

/**
 * 金额请求参数（转入/转出/偿还融资）
 */
export interface AmountRequest {
  /** 金额 */
  amount: number | string;
}

/**
 * 偿还融资请求参数
 */
export interface RepayMarginRequest extends AmountRequest {}

/**
 * 买入响应（POST /stock/buy 返回）
 */
export interface BuyResult {
  success: boolean;
  message: string;
  /** 交易 ID */
  transaction_id: number;
  stock_id: number;
  stock_code: string;
  stock_name: string;
  /** 成交数量（字符串大数） */
  quantity: string;
  /** 成交价（字符串大数） */
  price: string;
  /** 成交金额（字符串大数） */
  amount: string;
  /** 手续费（字符串大数） */
  fee: string;
  /** 是否融资买入 */
  is_margin: boolean;
  /** 操作后股市账户余额（字符串大数） */
  stock_account_balance: string;
  /** 操作后融资负债（字符串大数） */
  stock_margin_debt: string;
}

/**
 * 卖出响应（POST /stock/sell 返回）
 */
export interface SellResult {
  success: boolean;
  message: string;
  transaction_id: number;
  stock_id: number;
  stock_code: string;
  stock_name: string;
  quantity: string;
  price: string;
  amount: string;
  fee: string;
  /** 印花税（字符串大数） */
  tax: string;
  /** 实得金额（成交金额 - 手续费 - 印花税）（字符串大数） */
  net_amount: string;
  /** 卖出融资持仓时偿还的负债（字符串大数） */
  repay_debt: string;
  stock_account_balance: string;
  stock_margin_debt: string;
}

/**
 * 转入/转出响应
 */
export interface TransferResult {
  success: boolean;
  message: string;
  /** 转账金额（字符串大数） */
  amount: string;
  /** 操作后灵石余额（字符串大数） */
  spirit_stones: string;
  /** 操作后股市账户余额（字符串大数） */
  stock_account_balance: string;
}

/**
 * 开通融资账户响应
 */
export interface OpenMarginResult {
  success: boolean;
  message: string;
  /** 融资账户 ID */
  account_id: number;
}

/**
 * 偿还融资响应
 */
export interface RepayMarginResult {
  success: boolean;
  message: string;
  /** 实际偿还金额（字符串大数） */
  repay_amount: string;
  /** 剩余负债（字符串大数） */
  remaining_debt: string;
  /** 操作后股市账户余额（字符串大数） */
  stock_account_balance: string;
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

/* ===================== API 函数 ===================== */

/**
 * 获取玩家股市状态（账户余额、持仓市值、总资产、负债、保证金率、配置）
 * GET /stock/status
 */
export const getStatus = () => {
  return apiClient.get<StockStatus>('/stock/status');
};

/**
 * 获取所有股票行情列表（12 只，含当前价、涨跌幅、成交量、是否熔断）
 * GET /stock/stocks
 */
export const getStockList = () => {
  return apiClient.get<Stock[]>('/stock/stocks');
};

/**
 * 获取股票详情（含 K线、活跃事件）
 * GET /stock/stocks/:stockId
 * @param stockId 股票 ID
 */
export const getStockDetail = (stockId: number) => {
  return apiClient.get<StockDetail>(`/stock/stocks/${stockId}`);
};

/**
 * 获取 K线数据
 * GET /stock/stocks/:stockId/kline?period=1h&limit=30
 * @param stockId 股票 ID
 * @param period 周期：1h/1d/1w
 * @param limit 返回条数（默认 30，最大 200）
 */
export const getKline = (stockId: number, period: StockKlinePeriod = '1h', limit: number = 30) => {
  return apiClient.get<StockKline[]>(`/stock/stocks/${stockId}/kline`, {
    params: { period, limit }
  });
};

/**
 * 获取玩家持仓列表（含市值、浮动盈亏、可用数量）
 * GET /stock/holdings
 */
export const getHoldings = () => {
  return apiClient.get<StockHolding[]>('/stock/holdings');
};

/**
 * 获取交易历史（分页）
 * GET /stock/transactions?page=1&limit=10
 * @param page 页码
 * @param limit 每页条数
 */
export const getTransactions = (page: number = 1, limit: number = 10) => {
  return apiClient.get<PaginatedResponse<StockTransaction>>('/stock/transactions', {
    params: { page, limit }
  });
};

/**
 * 获取分红历史（分页）
 * GET /stock/dividends?page=1&limit=10
 * @param page 页码
 * @param limit 每页条数
 */
export const getDividends = (page: number = 1, limit: number = 10) => {
  return apiClient.get<PaginatedResponse<StockDividend>>('/stock/dividends', {
    params: { page, limit }
  });
};

/**
 * 获取融资账户详情
 * GET /stock/margin
 */
export const getMarginAccount = () => {
  return apiClient.get<StockMarginAccount>('/stock/margin');
};

/**
 * 开通融资账户
 * POST /stock/margin/open
 */
export const openMarginAccount = () => {
  return apiClient.post<OpenMarginResult>('/stock/margin/open');
};

/**
 * 偿还融资负债
 * POST /stock/margin/repay
 * @param amount 偿还金额
 */
export const repayMargin = (amount: number | string) => {
  return apiClient.post<RepayMarginResult>('/stock/margin/repay', { amount });
};

/**
 * 买入股票（支持融资买入）
 * POST /stock/buy
 * @param stockId 股票 ID
 * @param quantity 买入数量
 * @param useMargin 是否使用融资买入
 */
export const buy = (stockId: number, quantity: number, useMargin: boolean = false) => {
  return apiClient.post<BuyResult>('/stock/buy', {
    stock_id: stockId,
    quantity,
    use_margin: useMargin
  });
};

/**
 * 卖出股票
 * POST /stock/sell
 * @param stockId 股票 ID
 * @param quantity 卖出数量
 */
export const sell = (stockId: number, quantity: number) => {
  return apiClient.post<SellResult>('/stock/sell', {
    stock_id: stockId,
    quantity
  });
};

/**
 * 从灵石转入股市账户
 * POST /stock/deposit
 * @param amount 转入金额
 */
export const deposit = (amount: number | string) => {
  return apiClient.post<TransferResult>('/stock/deposit', { amount });
};

/**
 * 从股市账户转出灵石
 * POST /stock/withdraw
 * @param amount 转出金额
 */
export const withdraw = (amount: number | string) => {
  return apiClient.post<TransferResult>('/stock/withdraw', { amount });
};
