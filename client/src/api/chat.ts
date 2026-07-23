/**
 * 聊天相关 API
 *
 * 包含两部分：
 * 1. 聊天消息：历史记录、发送消息、未读计数、标记已读
 * 2. 红包玩法：发送红包、领取红包、查询红包详情、活跃红包列表
 */
import apiClient from './index';

/* ============================================================
 * 聊天消息接口
 * ============================================================ */

/** 聊天消息类型 */
export type ChatMessageType = 'system' | 'player' | 'red_packet' | 'item_show';

/** 聊天消息 */
export interface ChatMessage {
  id: number;
  sender: string;
  content: string;
  type: ChatMessageType;
  createdAt: string;
}

/**
 * 获取聊天历史
 */
export const getChatHistory = () => {
  return apiClient.get('/chat/history');
};

/**
 * 发送消息
 */
export const sendMessage = (content: string) => {
  return apiClient.post('/chat/send', { content });
};

/**
 * 获取未读消息数量
 */
export const getUnreadCount = (lastReadTime?: string) => {
  return apiClient.get('/chat/unread-count', { params: { lastReadTime } });
};

/**
 * 标记消息已读
 */
export const markRead = () => {
  return apiClient.post('/chat/mark-read');
};

/* ============================================================
 * 红包玩法接口
 * ============================================================ */

/** 红包类型 */
export type RedPacketType = 'lucky' | 'equal';

/** 红包状态 */
export type RedPacketStatus = 'active' | 'exhausted' | 'expired' | 'refunded';

/** 红包消息 content 字段的 JSON 结构（type='red_packet' 时） */
export interface RedPacketMessageContent {
  red_packet_id: number;
  total_amount: number;
  total_count: number;
  packet_type: RedPacketType;
  message: string;
}

/** 发送红包返回结果 */
export interface SendRedPacketResult {
  red_packet_id: number;
  sender: { id: number; nickname: string };
  total_amount: number;
  total_count: number;
  packet_type: RedPacketType;
  message: string | null;
  status: RedPacketStatus;
  expire_at: string;
  created_at: string;
  chat_message_id: number;
}

/** 领取红包返回结果 */
export interface ClaimRedPacketResult {
  red_packet_id: number;
  claim_id: number;
  amount: number;
  is_lucky_king: boolean;
  is_last_claim: boolean;
  sender_nickname: string;
  remain_count: number;
  remain_amount: number;
  message: string;
}

/** 红包领取记录 */
export interface RedPacketClaimRecord {
  receiver: { id: number; nickname: string };
  amount: number;
  is_lucky_king: boolean;
  claimed_at: string;
}

/** 红包详情 */
export interface RedPacketDetail {
  red_packet_id: number;
  sender: { id: number; nickname: string };
  total_amount: number;
  total_count: number;
  remain_amount: number;
  remain_count: number;
  packet_type: RedPacketType;
  status: RedPacketStatus;
  message: string | null;
  expire_at: string;
  created_at: string;
  /** 当前玩家是否已领取及领取信息 */
  my_claim: { amount: number; is_lucky_king: boolean; claimed_at: string } | null;
  /** 所有领取记录 */
  claims: RedPacketClaimRecord[];
}

/** 活跃红包列表项 */
export interface ActiveRedPacket {
  red_packet_id: number;
  sender: { id: number; nickname: string };
  total_amount: number;
  total_count: number;
  remain_count: number;
  packet_type: RedPacketType;
  message: string | null;
  created_at: string;
  expire_at: string;
}

/**
 * 发送红包
 * POST /chat/red-packet/send
 * @param total_amount 红包总金额（灵石）
 * @param total_count 红包个数
 * @param packet_type 红包类型：lucky(拼手气) / equal(普通均分)
 * @param message 红包附言（可选）
 */
export const sendRedPacket = (
  total_amount: number,
  total_count: number,
  packet_type: RedPacketType = 'lucky',
  message?: string
) => {
  return apiClient.post<SendRedPacketResult>('/chat/red-packet/send', {
    total_amount,
    total_count,
    packet_type,
    message
  });
};

/**
 * 领取红包
 * POST /chat/red-packet/:id/claim
 * @param id 红包ID
 */
export const claimRedPacket = (id: number) => {
  return apiClient.post<ClaimRedPacketResult>(`/chat/red-packet/${id}/claim`);
};

/**
 * 查询红包详情（含领取记录列表）
 * GET /chat/red-packet/:id
 * @param id 红包ID
 */
export const getRedPacketDetail = (id: number) => {
  return apiClient.get<RedPacketDetail>(`/chat/red-packet/${id}`);
};

/**
 * 获取频道内可领取的活跃红包列表
 * GET /chat/red-packet/active
 */
export const getActiveRedPackets = () => {
  return apiClient.get<ActiveRedPacket[]>('/chat/red-packet/active');
};

/* ============================================================
 * 物品展示接口
 * ============================================================ */

/** 物品品质类型（与 inventory.ts ItemQuality 对齐） */
export type ItemQuality = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'unknown';

/** 物品类型 */
export type ItemType = 'consumable' | 'material' | 'equipment' | 'recipe_scroll' | 'unknown' | string;

/**
 * 物品展示消息 content 字段的 JSON 结构（type='item_show' 时）
 * 由后端 POST /chat/show-item 构造，存储物品基础信息
 */
export interface ItemShowMessageContent {
  /** 物品配置键名 */
  item_key: string;
  /** 物品名称 */
  item_name: string;
  /** 物品品质 */
  quality: ItemQuality;
  /** 物品类型 */
  type: ItemType;
  /** 物品子类型（可为 null） */
  subtype: string | null;
  /** 物品描述 */
  description: string;
  /** 物品售价（灵石） */
  price: number;
  /** 展示时持有数量 */
  quantity: number;
}

/** 物品展示返回结果 */
export interface ShowItemResult {
  /** 聊天消息 ID */
  chat_message_id: number;
  /** 物品展示信息 */
  item_show: ItemShowMessageContent;
}

/**
 * 在聊天中展示背包物品（多人社交互动·炫耀装备/分享收获）
 * POST /chat/show-item
 * @param itemKey 物品键名（必须为玩家背包中持有的物品）
 */
export const showItem = (itemKey: string) => {
  return apiClient.post<ShowItemResult>('/chat/show-item', { item_key: itemKey });
};
