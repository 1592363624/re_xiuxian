/**
 * 宗门战管理 API（GM 后台）
 *
 * 封装 GM 后台对宗门战/领地争夺系统的管理接口（参考 server/routes/admin_sect_war.js）。
 * 所有接口需要管理员权限（后端 auth + adminCheck 双层中间件）。
 *
 * 接口列表：
 *   1. GET  /admin/sect-war/metrics：获取宗门战系统统计指标
 *   2. GET  /admin/sect-war/wars：分页查询所有战役
 *   3. GET  /admin/sect-war/seasons：分页查询所有赛季
 *   4. POST /admin/sect-war/season/create：创建新赛季
 *   5. POST /admin/sect-war/season/:seasonId/settle：强制结算赛季
 *   6. POST /admin/sect-war/wars/:warId/advance：手动推进战役状态
 *   7. POST /admin/sect-war/territories/initialize：初始化资源点
 *   8. POST /admin/sect-war/production/settle：手动触发产出结算
 */
import apiClient from './index';

/** 宗门战系统统计指标（GET /admin/sect-war/metrics 返回） */
export interface SectWarMetrics {
  /** 当前活跃战役数（preparing + announced + active） */
  active_war_count: number;
  /** 总资源点数 */
  total_territory_count: number;
  /** 已被占领资源点数 */
  occupied_territory_count: number;
  /** 当前活跃赛季数 */
  active_season_count: number;
  /** 总赛季数 */
  total_season_count: number;
}

/** 战役列表项（GET /admin/sect-war/wars 返回项） */
export interface WarListItem {
  /** 战役ID */
  war_id: number;
  /** 所属赛季ID */
  season_id: number;
  /** 进攻方宗门ID */
  attacker_sect_id: number;
  /** 进攻方宗门名称 */
  attacker_sect_name: string;
  /** 防守方宗门ID */
  defender_sect_id: number;
  /** 防守方宗门名称 */
  defender_sect_name: string;
  /** 目标资源点ID */
  target_territory_id: number | null;
  /** 目标资源点名称 */
  target_territory_name: string | null;
  /** 战役状态：preparing/announced/active/settled */
  status: string;
  /** 胜方宗门ID（未结算为null） */
  winner_sect_id: number | null;
  /** 开战时间 */
  start_time: string;
  /** 结束时间 */
  end_time: string | null;
  /** 下一阶段时间 */
  next_status_time: string | null;
  /** 进攻方参战人数 */
  attacker_count: number;
  /** 防守方参战人数 */
  defender_count: number;
}

/** 赛季列表项（GET /admin/sect-war/seasons 返回项） */
export interface SectWarSeasonItem {
  /** 赛季ID */
  season_id: number;
  /** 赛季名称 */
  season_name: string;
  /** 状态：pending/active/ended */
  status: string;
  /** 开始时间 */
  start_date: string;
  /** 结束时间 */
  end_date: string;
  /** 总战役数 */
  total_wars: number;
  /** 已结算战役数 */
  settled_wars: number;
  /** 参战宗门数 */
  total_sects: number;
}

/** 创建赛季请求参数 */
export interface CreateSeasonParams {
  /** 赛季名称 */
  season_name: string;
  /** 开始时间（ISO 字符串） */
  start_date: string;
  /** 结束时间（ISO 字符串） */
  end_date: string;
}

/**
 * 获取宗门战系统统计指标
 * GET /admin/sect-war/metrics
 */
export function getMetrics() {
  return apiClient.get('/admin/sect-war/metrics');
}

/**
 * 分页查询所有战役
 * GET /admin/sect-war/wars
 * @param page 页码（从1开始）
 * @param pageSize 每页数量
 * @param status 状态过滤（可选）
 */
export function getWarList(page: number = 1, pageSize: number = 20, status?: string) {
  const params: any = { page, page_size: pageSize };
  if (status) params.status = status;
  return apiClient.get('/admin/sect-war/wars', { params });
}

/**
 * 分页查询所有赛季
 * GET /admin/sect-war/seasons
 * @param page 页码
 * @param pageSize 每页数量
 */
export function getSeasonList(page: number = 1, pageSize: number = 20) {
  return apiClient.get('/admin/sect-war/seasons', { params: { page, page_size: pageSize } });
}

/**
 * 创建新赛季
 * POST /admin/sect-war/season/create
 * @param params 赛季参数
 */
export function createSeason(params: CreateSeasonParams) {
  return apiClient.post('/admin/sect-war/season/create', params);
}

/**
 * 强制结算赛季
 * POST /admin/sect-war/season/:seasonId/settle
 * @param seasonId 赛季ID
 */
export function settleSeason(seasonId: number) {
  return apiClient.post(`/admin/sect-war/season/${seasonId}/settle`);
}

/**
 * 手动推进战役状态（应急用）
 * POST /admin/sect-war/wars/:warId/advance
 * @param warId 战役ID
 */
export function advanceWarStatus(warId: number) {
  return apiClient.post(`/admin/sect-war/wars/${warId}/advance`);
}

/**
 * 初始化资源点（赛季开始时调用）
 * POST /admin/sect-war/territories/initialize
 * @param seasonId 赛季ID
 */
export function initializeTerritories(seasonId: number) {
  return apiClient.post('/admin/sect-war/territories/initialize', { season_id: seasonId });
}

/**
 * 手动触发资源点产出结算（应急用）
 * POST /admin/sect-war/production/settle
 */
export function settleProduction() {
  return apiClient.post('/admin/sect-war/production/settle');
}
