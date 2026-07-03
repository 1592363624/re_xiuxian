/**
 * 宗门管理 API（GM 后台）
 * 封装宗门成员列表查询、宗门统计、贡献度调整、身份设置、踢出宗门等接口
 * 所有接口需要 admin 权限
 */
import apiClient from './index';

/** 宗门成员信息 */
export interface SectMember {
  /** 玩家ID */
  player_id: number;
  /** 玩家昵称 */
  nickname: string;
  /** 宗门ID */
  sect_id: string;
  /** 宗门名称 */
  sect_name: string;
  /** 宗门贡献度 */
  contribution: number;
  /** 宗门身份：disciple（弟子）/ elder（长老） */
  role: string;
  /** 加入宗门时间 */
  joined_at: string;
  /** 最近点卯时间 */
  last_check_in: string | null;
  /** 最近传功时间 */
  last_transfer: string | null;
}

/** 宗门统计数据 */
export interface SectStat {
  /** 宗门ID */
  sect_id: string;
  /** 宗门名称 */
  sect_name: string;
  /** 成员总数 */
  member_count: number;
  /** 宗门总贡献度 */
  total_contribution: number;
  /** 长老数量 */
  elder_count: number;
  /** 弟子数量 */
  disciple_count: number;
}

/** 宗门成员列表响应 */
export interface SectMembersResponse {
  /** 成员列表 */
  list: SectMember[];
  /** 总记录数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页条数 */
  page_size: number;
  /** 总页数 */
  total_pages: number;
}

/** 宗门成员列表查询参数 */
export interface SectMembersParams {
  /** 宗门ID（可选，不传则查全部宗门） */
  sect_id?: string;
  /** 页码（默认1） */
  page?: number;
  /** 每页条数（默认从后端配置读取） */
  page_size?: number;
}

/**
 * 获取宗门成员列表（分页，可按宗门筛选）
 * GET /admin/sect/list
 */
export const getSectMembers = (params: SectMembersParams = {}) => {
  return apiClient.get('/admin/sect/list', { params });
};

/**
 * 获取所有宗门的统计数据
 * GET /admin/sect/stats
 */
export const getSectStats = () => {
  return apiClient.get('/admin/sect/stats');
};

/**
 * 调整玩家宗门贡献度
 * PUT /admin/sect/:playerId/contribution
 * @param playerId 玩家ID
 * @param contribution 新的贡献度数值
 */
export const updateMemberContribution = (playerId: number, contribution: number) => {
  return apiClient.put(`/admin/sect/${playerId}/contribution`, { contribution });
};

/**
 * 设置玩家宗门身份（弟子/长老）
 * PUT /admin/sect/:playerId/role
 * @param playerId 玩家ID
 * @param role 身份：disciple（弟子）/ elder（长老）
 */
export const updateMemberRole = (playerId: number, role: string) => {
  return apiClient.put(`/admin/sect/${playerId}/role`, { role });
};

/**
 * 踢出宗门（删除 PlayerSect 记录，贡献度随之清空）
 * POST /admin/sect/:playerId/kick
 * @param playerId 玩家ID
 */
export const kickMember = (playerId: number) => {
  return apiClient.post(`/admin/sect/${playerId}/kick`);
};
