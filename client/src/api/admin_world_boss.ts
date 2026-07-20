/**
 * 世界BOSS管理 API（GM 后台）
 *
 * 封装 GM 后台对世界BOSS系统的管理接口（参考 server/routes/admin_world_boss.js）。
 * 所有接口需要管理员权限（后端 auth + adminCheck 双层中间件）。
 *
 * 接口列表：
 *   1. GET  /admin/world-boss/metrics：获取世界BOSS系统统计指标
 *   2. GET  /admin/world-boss/bosses：分页查询所有BOSS实例（含已结束）
 *   3. GET  /admin/world-boss/seasons：分页查询所有赛季
 *   4. POST /admin/world-boss/spawn：手动刷新BOSS
 *   5. POST /admin/world-boss/:bossId/expire：强制过期BOSS
 *   6. POST /admin/world-boss/season/create：创建新赛季
 *   7. POST /admin/world-boss/season/:seasonId/settle：强制结算赛季
 */
import apiClient from './index';

/** 世界BOSS系统统计指标（GET /admin/world-boss/metrics 返回） */
export interface WorldBossMetrics {
  /** 当前活跃BOSS数（pending + active） */
  active_boss_count: number;
  /** 历史总击杀BOSS数 */
  total_bosses_killed: number;
  /** 当前活跃赛季数 */
  active_season_count: number;
  /** 总赛季数 */
  total_season_count: number;
}

/** BOSS实例列表项（GET /admin/world-boss/bosses 返回项） */
export interface BossInstanceItem {
  /** BOSS实例ID */
  boss_id: number;
  /** BOSS配置key（如 qing_yuan_zi） */
  boss_key: string;
  /** BOSS名称 */
  boss_name: string;
  /** 所属赛季ID */
  season_id: number;
  /** 当前状态：pending/active/defeated/expired */
  status: string;
  /** 当前HP */
  hp_current: string;
  /** 最大HP */
  hp_max: string;
  /** HP百分比（0-100） */
  hp_percentage: number;
  /** 当前阶段（1/2/3） */
  phase: number;
  /** 生成时间 */
  spawn_time: string;
  /** 过期时间 */
  expire_time: string;
  /** 击杀者玩家ID（未击杀为null） */
  killer_player_id: number | null;
  /** 击杀者昵称 */
  killer_nickname: string | null;
  /** 参战玩家数 */
  attacker_count: number;
}

/** 赛季列表项（GET /admin/world-boss/seasons 返回项） */
export interface WorldBossSeasonItem {
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
  /** 已击杀BOSS数 */
  total_bosses_killed: number;
  /** 总BOSS数 */
  total_bosses: number;
  /** 参战玩家数 */
  total_attackers: number;
}

/** 创建BOSS请求参数 */
export interface SpawnBossParams {
  /** BOSS配置key（如 qing_yuan_zi） */
  boss_key: string;
  /** 自定义HP（可选，不填则用配置默认值） */
  custom_hp?: string;
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
 * 获取世界BOSS系统统计指标
 * GET /admin/world-boss/metrics
 */
export function getMetrics() {
  return apiClient.get('/admin/world-boss/metrics');
}

/**
 * 分页查询所有BOSS实例
 * GET /admin/world-boss/bosses
 * @param page 页码（从1开始）
 * @param pageSize 每页数量
 * @param status 状态过滤（可选）
 */
export function getBossList(page: number = 1, pageSize: number = 20, status?: string) {
  const params: any = { page, page_size: pageSize };
  if (status) params.status = status;
  return apiClient.get('/admin/world-boss/bosses', { params });
}

/**
 * 分页查询所有赛季
 * GET /admin/world-boss/seasons
 * @param page 页码
 * @param pageSize 每页数量
 */
export function getSeasonList(page: number = 1, pageSize: number = 20) {
  return apiClient.get('/admin/world-boss/seasons', { params: { page, page_size: pageSize } });
}

/**
 * 手动刷新BOSS
 * POST /admin/world-boss/spawn
 * @param params BOSS刷新参数
 */
export function spawnBoss(params: SpawnBossParams) {
  return apiClient.post('/admin/world-boss/spawn', params);
}

/**
 * 强制过期BOSS
 * POST /admin/world-boss/:bossId/expire
 * @param bossId BOSS实例ID
 */
export function expireBoss(bossId: number) {
  return apiClient.post(`/admin/world-boss/${bossId}/expire`);
}

/**
 * 创建新赛季
 * POST /admin/world-boss/season/create
 * @param params 赛季参数
 */
export function createSeason(params: CreateSeasonParams) {
  return apiClient.post('/admin/world-boss/season/create', params);
}

/**
 * 强制结算赛季
 * POST /admin/world-boss/season/:seasonId/settle
 * @param seasonId 赛季ID
 */
export function settleSeason(seasonId: number) {
  return apiClient.post(`/admin/world-boss/season/${seasonId}/settle`);
}