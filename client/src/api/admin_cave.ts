/**
 * 洞府管理 API（GM 后台）
 * 封装玩家洞府列表查询、洞府详情、设施等级调整、洞府重置、药园地块数调整等接口
 * 所有接口需要 admin 权限（后端 auth + adminCheck 双层中间件）
 */
import apiClient from './index';

/** 玩家洞府列表项 */
export interface CaveListItem {
  /** 玩家ID */
  player_id: number;
  /** 玩家昵称 */
  nickname: string;
  /** 登录账号 */
  username: string;
  /** 当前境界 */
  realm: string;
  /** 是否已开辟洞府 */
  is_opened: boolean;
  /** 开辟洞府时间 */
  opened_at: string | null;
  /** 灵脉等级 */
  spirit_vein_level: number;
  /** 静室等级 */
  quiet_room_level: number;
  /** 丹房等级 */
  pill_room_level: number;
  /** 器室等级 */
  tool_room_level: number;
  /** 护山大阵等级 */
  grand_formation_level: number;
  /** 药园已开垦地块数 */
  garden_plots: number;
  /** 灵脉累计产出灵石数 */
  spirit_vein_accumulated: number;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
}

/** 洞府列表响应 */
export interface CaveListResponse {
  /** 洞府列表 */
  list: CaveListItem[];
  /** 总记录数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页条数 */
  page_size: number;
  /** 总页数 */
  total_pages: number;
}

/** 洞府列表查询参数 */
export interface CaveListParams {
  /** 玩家ID（可选，精确匹配） */
  player_id?: number | string;
  /** 玩家昵称（可选，模糊匹配） */
  nickname?: string;
  /** 页码（默认1） */
  page?: number;
  /** 每页条数（默认从后端配置读取） */
  page_size?: number;
}

/** 设施详情 */
export interface FacilityDetail {
  /** 设施中文名 */
  name: string;
  /** 设施等级 */
  level: number;
}

/** 玩家洞府详情 */
export interface CaveDetail {
  /** 玩家ID */
  player_id: number;
  /** 玩家昵称 */
  nickname: string;
  /** 登录账号 */
  username: string;
  /** 当前境界 */
  realm: string;
  /** 是否已开辟洞府 */
  is_opened: boolean;
  /** 开辟洞府时间 */
  opened_at: string | null;
  /** 五大设施信息 */
  facilities: {
    spirit_vein: FacilityDetail;
    quiet_room: FacilityDetail;
    pill_room: FacilityDetail;
    tool_room: FacilityDetail;
    grand_formation: FacilityDetail;
  };
  /** 灵脉累计产出灵石数 */
  spirit_vein_accumulated: number;
  /** 灵脉待领取灵石数 */
  spirit_vein_pending: number;
  /** 上次领取灵脉灵石时间 */
  last_spirit_vein_collect: string | null;
  /** 药园已开垦地块数 */
  garden_plots: number;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
}

/** 设施类型（与后端白名单一致） */
export type FacilityType =
  | 'spirit_vein'
  | 'quiet_room'
  | 'pill_room'
  | 'tool_room'
  | 'grand_formation';

/** 调整设施等级请求体 */
export interface UpdateFacilityBody {
  /** 设施类型 */
  facility: FacilityType;
  /** 新等级 */
  level: number;
}

/** 调整药园地块数请求体 */
export interface UpdateGardenPlotsBody {
  /** 新地块数 */
  plots: number;
}

/**
 * 获取玩家洞府列表（分页，可按玩家ID/昵称筛选）
 * GET /admin/cave/list
 */
export const getCaveList = (params: CaveListParams = {}) => {
  return apiClient.get('/admin/cave/list', { params });
};

/**
 * 获取指定玩家洞府详情
 * GET /admin/cave/:playerId
 * @param playerId 玩家ID
 */
export const getCaveDetail = (playerId: number) => {
  return apiClient.get(`/admin/cave/${playerId}`);
};

/**
 * 调整玩家设施等级（GM 直接覆盖原有等级，不消耗资源）
 * PUT /admin/cave/:playerId/facility
 * @param playerId 玩家ID
 * @param body { facility, level }
 */
export const updateCaveFacility = (playerId: number, body: UpdateFacilityBody) => {
  return apiClient.put(`/admin/cave/${playerId}/facility`, body);
};

/**
 * 重置玩家洞府（GM 强制重置：清空所有设施等级、灵脉产出、药园地块数）
 * POST /admin/cave/:playerId/reset
 * @param playerId 玩家ID
 */
export const resetCave = (playerId: number) => {
  return apiClient.post(`/admin/cave/${playerId}/reset`);
};

/**
 * 调整玩家药园地块数（GM 直接覆盖，不消耗灵石）
 * PUT /admin/cave/:playerId/garden-plots
 * @param playerId 玩家ID
 * @param body { plots }
 */
export const updateGardenPlots = (playerId: number, body: UpdateGardenPlotsBody) => {
  return apiClient.put(`/admin/cave/${playerId}/garden-plots`, body);
};
