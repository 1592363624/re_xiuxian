/**
 * 宗门战/领地争夺系统 API
 *
 * 批次2多人玩法：9个资源点(灵脉/矿脉/秘境/战略)、宣战/加入/攻防/占领、宗门资金、赛季结算
 *
 * 接口分组：
 *   1. 查询：getCurrentSeason / getTerritories / getMySectInfo / getWarList / getWarDetail / getMyWarRecords
 *   2. 战役操作：declareWar / joinWar / leaveWar / attackPlayer / captureTerritory / surrender
 *   3. 排行：getSeasonRanking
 *
 * 战役状态机：
 *   preparing → announced → active → settled
 *   - preparing: 宣战后24小时，可加入/离开
 *   - announced: 开战前1小时通告，不可离开
 *   - active: 交战期（默认2小时），可攻击/占领/投降
 *   - settled: 已结算，胜负判定+war_chest发放
 */
import apiClient from './index';

/** 战役状态 */
export type WarStatus = 'preparing' | 'announced' | 'active' | 'settled';

/** 玩家阵营 */
export type WarSide = 'attacker' | 'defender';

/** 战斗行动类型 */
export type WarAction = 'attack' | 'skill' | 'defend';

/** 资源点类型 */
export type TerritoryType = 'spirit_vein' | 'mine' | 'secret_realm' | 'strategic';

/** 资源点产出类型 */
export type ProductionType = 'spirit_stones' | 'materials' | 'contribution';

/** 资源点信息 */
export interface Territory {
  territory_key: string;
  territory_name: string;
  territory_type: TerritoryType;
  map_x: number;
  map_y: number;
  owner_sect_id: string | null;
  owner_sect_name: string | null;
  owner_since: string | null;
  defense_level: number;
  defense_formation: string | null;
  defender_player_ids: number[];
  daily_production: number;
  production_type: ProductionType;
  is_under_attack: number;
  last_battle_time: string | null;
  season_id: number;
  description?: string;
  strategic_win_bonus?: number;
}

/** 赛季信息 */
export interface SectWarSeason {
  id: number;
  season_name: string;
  start_date: string;
  end_date: string;
  status: 'active' | 'pending' | 'ended';
  total_wars: number;
  total_participants?: number;
  settlement_time: string | null;
}

/** 我的宗门战信息 */
export interface MySectInfo {
  sect_id: string;
  sect_name: string;
  role: string;
  is_leader: boolean;
  fund: {
    fund_balance: string;
    war_score: number;
    season_war_score: number;
    territories_count: number;
  };
  season: SectWarSeason | null;
  ongoing_wars: any[];
  owned_territories: Territory[];
  member_count: number;
}

/** 战役列表项 */
export interface WarListItem {
  id: number;
  attacker_sect_id: string;
  attacker_sect_name: string;
  defender_sect_id: string;
  defender_sect_name: string;
  target_territory_id: number | null;
  target_territory_name: string | null;
  status: WarStatus;
  war_chest: string;
  next_status_time: string;
  battle_start_time: string | null;
  battle_end_time: string | null;
  attacker_count: number;
  defender_count: number;
  attacker_kills: number;
  defender_kills: number;
  winner_side: WarSide | null;
  settle_time: string | null;
  createdAt: string;
}

/** 战役详情 */
export interface WarDetail extends WarListItem {
  participants?: any[];
  territories?: Territory[];
  recent_battles?: any[];
}

/** 攻击玩家结果 */
export interface AttackPlayerResult {
  attack: {
    action: string;
    damage: number;
    is_crit: boolean;
  };
  attacker: {
    player_id: number;
    nickname: string;
    hp_before: number;
    hp_after: number;
    hp_max: number;
    is_dead: boolean;
    mp_before: number;
    mp_after: number;
  };
  defender: {
    player_id: number;
    nickname: string;
    hp_before: number;
    hp_after: number;
    hp_max: number;
    is_dead: boolean;
  };
  counter?: {
    damage: number;
    is_crit: boolean;
  };
  rewards?: {
    honor?: number;
    kill_count?: number;
  };
  war: {
    attacker_kills: number;
    defender_kills: number;
  };
  timestamp: string;
}

/** 占领资源点结果 */
export interface CaptureResult {
  message: string;
  war_id: number;
  territory_id: number;
  territory_name: string;
  capture_seconds: number;
  status: 'started' | 'completed' | 'interrupted';
}

/** 战役记录项 */
export interface WarRecordItem {
  war_id: number;
  war_status: WarStatus;
  attacker_sect_name: string;
  defender_sect_name: string;
  side: WarSide;
  kills: number;
  deaths: number;
  damage_dealt: string;
  damage_taken: string;
  honor_gained: number;
  spirit_stone_rewarded: string;
  is_winner: boolean;
  settle_time: string | null;
}

// ===================== API 函数 =====================

/**
 * 获取当前宗门战赛季
 * 无活跃赛季时返回 null
 */
export const getCurrentSeason = () => {
  return apiClient.get<SectWarSeason | null>('/sect-war/season/current');
};

/**
 * 获取所有资源点列表
 * 含归属/占领状态/产出/防御等级
 */
export const getTerritories = () => {
  return apiClient.get<Territory[]>('/sect-war/territories');
};

/**
 * 获取我的宗门战信息
 * 含宗门ID/角色/资金/成员数/赛季战绩
 */
export const getMySectInfo = () => {
  return apiClient.get<MySectInfo>('/sect-war/mysect');
};

/**
 * 获取战役列表
 * @param status 状态过滤：all/preparing/announced/active/settled
 * @param page 页码（最大100）
 * @param limit 每页条数（最大100）
 */
export const getWarList = (
  status: 'all' | WarStatus = 'all',
  page = 1,
  limit = 20
) => {
  return apiClient.get<{ list: WarListItem[]; total: number; page: number; limit: number }>(
    '/sect-war/wars',
    { params: { status, page, limit } }
  );
};

/**
 * 获取战役详情
 * @param warId 战役ID
 */
export const getWarDetail = (warId: number) => {
  return apiClient.get<WarDetail>(`/sect-war/wars/${warId}`);
};

/**
 * 宣战（宗主权限）
 * @param defenderSectId 防守方宗门ID
 * @param targetTerritoryId 目标资源点ID（可选，NULL表示纯荣誉战）
 */
export const declareWar = (
  defenderSectId: string,
  targetTerritoryId?: number | null
) => {
  return apiClient.post('/sect-war/wars', {
    defender_sect_id: defenderSectId,
    target_territory_id: targetTerritoryId ?? null,
  });
};

/**
 * 加入战役
 * 自动根据玩家宗门分配攻方/守方阵营
 * @param warId 战役ID
 */
export const joinWar = (warId: number) => {
  return apiClient.post(`/sect-war/wars/${warId}/join`);
};

/**
 * 离开战役
 * 仅 preparing/announced 阶段可离开；active 阶段离开视为逃跑
 * @param warId 战役ID
 */
export const leaveWar = (warId: number) => {
  return apiClient.post(`/sect-war/wars/${warId}/leave`);
};

/**
 * 攻击敌方玩家
 * @param warId 战役ID
 * @param targetPlayerId 目标玩家ID
 * @param action 行动类型：attack/skill/defend
 */
export const attackPlayer = (
  warId: number,
  targetPlayerId: number,
  action: WarAction = 'attack'
) => {
  return apiClient.post<AttackPlayerResult>(`/sect-war/wars/${warId}/attack`, {
    target_player_id: targetPlayerId,
    action,
  });
};

/**
 * 占领资源点
 * 开始30秒占领计时，需在计时内不被击杀/打断才能完成占领
 * @param warId 战役ID
 * @param territoryId 资源点ID
 */
export const captureTerritory = (warId: number, territoryId: number) => {
  return apiClient.post<CaptureResult>(`/sect-war/wars/${warId}/capture`, {
    territory_id: territoryId,
  });
};

/**
 * 投降（认输）
 * 仅攻方宗主可调用，对方获胜获得 war_chest
 * @param warId 战役ID
 */
export const surrender = (warId: number) => {
  return apiClient.post(`/sect-war/wars/${warId}/surrender`);
};

/**
 * 获取赛季宗门排行
 * @param seasonId 赛季ID（缺省取当前赛季）
 * @param limit 返回条数（最大500）
 */
export const getSeasonRanking = (seasonId?: number, limit = 100) => {
  return apiClient.get('/sect-war/season/ranking', {
    params: { season_id: seasonId, limit },
  });
};

/**
 * 获取我的历史战役记录
 * @param page 页码
 * @param limit 每页条数
 */
export const getMyWarRecords = (page = 1, limit = 20) => {
  return apiClient.get<{ list: WarRecordItem[]; total: number; page: number; limit: number }>(
    '/sect-war/myrecords',
    { params: { page, limit } }
  );
};
