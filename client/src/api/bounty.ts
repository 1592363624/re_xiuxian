/**
 * PVP 悬赏系统 API
 *
 * 提供玩家间悬赏追杀玩法的接口调用：
 * 1. 发布悬赏：扣灵石（含手续费）、设过期时间、WS 通知目标
 * 2. 接取悬赏：自动发起 bounty 类型 PVP 战斗
 * 3. 悬赏榜单：分页查询 + 状态过滤
 * 4. 我的悬赏：发布的 + 接取的
 * 5. 取消悬赏：仅 active 可取消，退灵石扣手续费
 *
 * 悬赏状态流转：
 *   active（悬赏中）→ accepted（已接单）→ completed（接单者胜）/ reverted（回流 active）
 *   active → expired（超时无人接单，退全额）/ cancelled（发布者主动取消，扣手续费）
 *
 * 结算机制（双保险）：
 *   - 同步钩子：PvpService 战斗结束后立即调用 settleBountyByBattle
 *   - 异步扫描：StateCleanerService 定期调用 settlePendingBountyBattles 兜底
 */
import apiClient from './index';

/** 悬赏状态 */
export type BountyStatus = 'active' | 'accepted' | 'completed' | 'expired' | 'cancelled';

/** 悬赏列表项 */
export interface BountyListItem {
  /** 悬赏唯一 ID */
  bounty_id: number;
  /** 发布者信息 */
  publisher: {
    id: number;
    nickname: string;
    realm?: string;
    realm_rank?: number;
  } | null;
  /** 目标信息 */
  target: {
    id: number;
    nickname: string;
    realm?: string;
    realm_rank?: number;
  } | null;
  /** 接单者信息（accepted 状态才有） */
  acceptor?: {
    id: number;
    nickname: string;
    realm?: string;
    realm_rank?: number;
  } | null;
  /** 悬赏金额（灵石） */
  bounty_amount: number;
  /** 悬赏状态 */
  status: BountyStatus;
  /** 悬赏理由 */
  reason: string | null;
  /** 接单时间 */
  accepted_at: string | null;
  /** 完成时间 */
  completed_at: string | null;
  /** 过期时间 */
  expire_at: string;
  /** 关联战斗记录 ID */
  battle_record_id: number | null;
  /** 创建时间 */
  created_at: string;
}

/** 我的悬赏返回结构 */
export interface MyBountiesResult {
  /** 我发布的悬赏 */
  published: BountyListItem[];
  /** 我接取的悬赏 */
  accepted: BountyListItem[];
}

/** 发布悬赏返回结果 */
export interface PublishBountyResult {
  bounty_id: number;
  publisher: { id: number; nickname: string };
  target: { id: number; nickname: string; realm: string; realm_rank: number };
  bounty_amount: number;
  platform_fee: number;
  total_cost: number;
  status: BountyStatus;
  reason: string | null;
  expire_at: string;
  created_at: string;
}

/** 接取悬赏返回结果 */
export interface AcceptBountyResult {
  bounty_id: number;
  battle_id: number | string;
  opponent_info: {
    player_id: number;
    nickname: string;
    realm: string;
    power: number;
  };
  message: string;
}

/** 取消悬赏返回结果 */
export interface CancelBountyResult {
  bounty_id: number;
  refund_amount: number;
  fee_amount: number;
  message: string;
}

/** 悬赏列表分页返回 */
export interface BountyListResult {
  list: BountyListItem[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * 发布悬赏
 * POST /bounty/publish
 * @param target_id 目标玩家 ID
 * @param amount 悬赏金额（灵石）
 * @param reason 悬赏理由（可选，最多 200 字）
 */
export const publishBounty = (
  target_id: number,
  amount: number,
  reason?: string
) => {
  return apiClient.post<PublishBountyResult>('/bounty/publish', {
    target_id,
    amount,
    reason
  });
};

/**
 * 接取悬赏（自动发起 bounty 类型 PVP 战斗）
 * POST /bounty/:bountyId/accept
 * @param bountyId 悬赏 ID
 */
export const acceptBounty = (bountyId: number) => {
  return apiClient.post<AcceptBountyResult>(`/bounty/${bountyId}/accept`);
};

/**
 * 获取悬赏榜单（分页 + 状态过滤）
 * GET /bounty/list
 * @param params { page?, page_size?, status? }
 */
export const getBountyList = (params: {
  page?: number;
  page_size?: number;
  status?: BountyStatus;
} = {}) => {
  return apiClient.get<BountyListResult>('/bounty/list', { params });
};

/**
 * 获取我的悬赏（发布的 + 接取的 + 针对我的）
 * GET /bounty/my
 */
export const getMyBounties = () => {
  return apiClient.get<MyBountiesResult>('/bounty/my');
};

/**
 * 取消悬赏（仅发布者可取消，仅 active 状态可取消）
 * POST /bounty/:bountyId/cancel
 * @param bountyId 悬赏 ID
 */
export const cancelBounty = (bountyId: number) => {
  return apiClient.post<CancelBountyResult>(`/bounty/${bountyId}/cancel`);
};
