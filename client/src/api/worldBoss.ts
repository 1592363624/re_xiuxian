/**
 * 世界BOSS系统 API
 *
 * 批次2多人玩法：3档BOSS(元婴/化神/炼虚)、3阶段切换、个人/宗门伤害排行、赛季结算
 *
 * 接口分组：
 *   1. 列表与详情：getAvailableBosses / getBossDetail / getBossRanking
 *   2. 核心战斗：attackBoss / revive / retreat
 *   3. 赛季查询：getSeasons / getSeasonRanking
 *
 * 数据规范：
 *   - HP/伤害等大整数统一以字符串形式返回（避免 JSON 精度丢失）
 *   - 排行榜按伤害倒序，个人/宗门两种维度
 *   - 攻击冷却默认 5 秒，复活冷却 60 秒，撤退禁入 5 分钟
 */
import apiClient from './index';

/** BOSS 状态 */
export type BossStatus = 'pending' | 'active' | 'defeated' | 'expired';

/** 资源点类型 */
export type TerritoryType = 'spirit_vein' | 'mine' | 'secret_realm' | 'strategic';

/** 技能ID */
export type BossSkillId = 'basic' | 'skill' | 'ultimate';

/** 可挑战BOSS列表项 */
export interface AvailableBoss {
  id: number;
  boss_key: string;
  boss_name: string;
  realm_rank_min: number;
  phase: number;
  status: BossStatus;
  spawn_time: string;
  active_start_time: string | null;
  expire_time: string;
  season_id: number;
  participant_count: number;
  hp_percentage: number;
  hp_current: string;
  hp_max: string;
  killer_player_id: number | null;
  killer_nickname: string | null;
  countdown_seconds: number;
}

/** 可挑战BOSS响应 */
export interface AvailableBossesResponse {
  bosses: AvailableBoss[];
  current_season: {
    id: number;
    season_name: string;
    start_date: string;
    end_date: string;
    total_bosses_killed: number;
  } | null;
  server_time: string;
}

/** BOSS阶段技能 */
export interface BossSkill {
  name: string;
  description: string;
  type: string;
  damage_multiplier: number;
  cooldown_seconds: number;
  effect: string;
}

/** 伤害排行项 */
export interface DamageRankItem {
  rank: number;
  player_id: number;
  player_nickname: string;
  player_realm: string;
  sect_name: string | null;
  total_damage: string;
  damage_count: number;
  best_single_damage: string;
  damage_percentage: number;
}

/** 宗门伤害排行项 */
export interface SectRankItem {
  rank: number;
  sect_id: string;
  sect_name: string;
  sect_total_damage: string;
  member_count: number;
  damage_percentage: number;
}

/** BOSS详情 */
export interface BossDetail {
  boss: {
    id: number;
    boss_key: string;
    boss_name: string;
    realm_rank_min: number;
    phase: number;
    status: BossStatus;
    atk: number;
    def: number;
    speed: number;
    spawn_time: string;
    active_start_time: string | null;
    defeat_time: string | null;
    expire_time: string;
    season_id: number;
    participant_count: number;
    killer_player_id: number | null;
    killer_nickname: string | null;
    first_kill_server: number;
    hp_current: string;
    hp_max: string;
    hp_percentage: number;
    total_damage_dealt: string;
    total_damage_taken: string;
  };
  current_phase_skills: BossSkill[];
  description: string;
  personal_ranking: DamageRankItem[];
  sect_ranking: SectRankItem[];
  server_time: string;
}

/** 攻击BOSS结果 */
export interface AttackBossResult {
  attack: {
    skill_id: string;
    damage: number;
    is_crit: boolean;
    damage_breakdown: {
      player_atk: number;
      skill_multiplier: number;
      boss_def: number;
      damage_reduce_rate: number;
      crit_factor: number;
      random_factor: number;
      solo_ratio: number;
      base_damage: number;
      final_damage: number;
    };
  };
  boss: {
    id: number;
    name: string;
    hp_before: string;
    hp_after: string;
    hp_max: string;
    hp_percentage: number;
    phase: number;
    phase_changed: boolean;
    status: string;
    defeated: boolean;
  };
  counter: {
    damage: number;
    phase_multiplier: number;
    boss_skill_factor: number;
  };
  player: {
    battle_hp_before: string;
    battle_hp_after: string;
    battle_hp_max: string;
    is_dead: boolean;
    death_count: number;
    attack_count: number;
  };
  settle: {
    rewards?: Array<{ type: string; name: string; amount: number | string }>;
    is_first_kill?: boolean;
    is_killer?: boolean;
    summary?: string;
  } | null;
  timestamp: string;
}

/** 赛季列表项 */
export interface SeasonItem {
  season_id: number;
  season_name: string;
  start_date: string;
  end_date: string;
  status: 'active' | 'pending' | 'ended';
  total_bosses_killed: number;
  total_damage_dealt: string;
  settlement_time: string | null;
}

// ===================== API 函数 =====================

/**
 * 获取可挑战BOSS列表
 * 包含 pending（即将刷新）和 active（正在交战）状态的BOSS
 */
export const getAvailableBosses = () => {
  return apiClient.get<AvailableBossesResponse>('/world-boss/available');
};

/**
 * 获取BOSS详情
 * @param bossId BOSS实例ID
 */
export const getBossDetail = (bossId: number) => {
  return apiClient.get<BossDetail>(`/world-boss/${bossId}`);
};

/**
 * 获取BOSS伤害排行
 * @param bossId BOSS实例ID
 * @param type 排行类型：personal=个人 / sect=宗门
 * @param limit 返回条数（最大500）
 */
export const getBossRanking = (
  bossId: number,
  type: 'personal' | 'sect' = 'personal',
  limit = 100
) => {
  return apiClient.get<{ ranking: DamageRankItem[] | SectRankItem[] }>(
    `/world-boss/${bossId}/ranking`,
    { params: { type, limit } }
  );
};

/**
 * 攻击世界BOSS
 * @param bossId BOSS实例ID
 * @param skillId 技能ID：basic=1.0倍率 / skill=1.5倍率 / ultimate=2.5倍率
 */
export const attackBoss = (bossId: number, skillId: BossSkillId = 'basic') => {
  return apiClient.post<AttackBossResult>(`/world-boss/${bossId}/attack`, {
    skill_id: skillId,
  });
};

/**
 * 原地复活（BOSS战死亡后）
 * 消耗灵石（默认1000），60秒CD
 * @param bossId BOSS实例ID
 */
export const revive = (bossId: number) => {
  return apiClient.post<{ message: string; battle_hp: string; cost: number }>(
    `/world-boss/${bossId}/revive`
  );
};

/**
 * 撤退（主动脱离BOSS战）
 * 5分钟内不可再次加入
 * @param bossId BOSS实例ID
 */
export const retreat = (bossId: number) => {
  return apiClient.post<{ message: string }>(`/world-boss/${bossId}/retreat`);
};

/**
 * 获取赛季列表
 * @param status 状态过滤：active/pending/ended
 * @param limit 返回条数（最大100）
 */
export const getSeasons = (
  status?: 'active' | 'pending' | 'ended',
  limit = 20
) => {
  return apiClient.get<SeasonItem[]>('/world-boss/seasons', {
    params: { status, limit },
  });
};

/**
 * 获取赛季宗门伤害排行
 * @param seasonId 赛季ID
 * @param limit 返回条数（最大500）
 */
export const getSeasonRanking = (seasonId: number, limit = 100) => {
  return apiClient.get('/world-boss/season/ranking', {
    params: { season_id: seasonId, limit },
  });
};
