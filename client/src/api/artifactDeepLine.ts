/**
 * 法宝深线 API（玩法文档第19节）
 *
 * 当前实现血魔剑残契线：
 *   - 血契阶数 0~5（祭血推进，18h 冷却，每周 36 进度上限）
 *   - 魔染/镇契双值博弈（魔染越高反噬越重，镇契降低反噬）
 *   - 镇契（无冷却，-魔染+镇契）
 *   - 雷洗（24h 冷却，天雷竹降 20~30 / 金雷竹降 35~50）
 *   - 铭印（7d 冷却，blood 高输出+反噬 / suppress 稳定无反噬）
 *   - 封鞘（24h，期间不提供战力，结束后 -魔染+镇契）
 *
 * 血魔剑来源：掩月抢亲多人副本成功后 0.1% 掉率
 */
import apiClient from './index';

/** 铭印类型 */
export type ImprintType = 'none' | 'blood' | 'suppress';

/** 雷洗材料类型 */
export type ThunderWashMaterialType = 'tianlei' | 'jinlei';

/** 血契阶段配置（来自后端 config 回显） */
export interface BloodPactStageConfig {
  stage: number;
  name: string;
  description?: string;
  atk_bonus_rate: number;
  hp_steal_bonus_rate: number;
  corruption_gain_min: number;
  corruption_gain_max: number;
  materials: Array<{ item_key: string; count: number }>;
}

/** 战力加成汇总 */
export interface BloodSwordCombatBonus {
  atk_bonus_rate: number;
  hp_steal_bonus_rate: number;
  def_bonus_rate: number;
  crit_rate_bonus: number;
  crit_damage_bonus: number;
  blood_backlash_hp_rate_per_round: number;
  is_active: boolean;
  reason?: string;
  imprint_type?: ImprintType;
}

/** 系统配置回显 */
export interface BloodSwordConfigEcho {
  max_stage: number;
  weekly_limit: number;
  sacrifice_cooldown_hours: number;
  thunder_wash_cooldown_hours: number;
  imprint_cooldown_days: number;
  sheath_duration_hours: number;
}

/** 未持有血魔剑时的状态 */
export interface BloodSwordStatusNotHeld {
  has_blood_sword: false;
  item_key: string;
  item_name: string;
  min_realm_rank: number;
  player_realm: string;
  player_realm_rank: number;
  meets_realm: boolean;
  source_hint: string;
  config: BloodSwordConfigEcho;
}

/** 已持有血魔剑时的状态 */
export interface BloodSwordStatusHeld {
  has_blood_sword: true;
  item_key: string;
  item_name: string;
  equipment_id: number;
  slot: string;
  durability: number;
  max_durability: number;
  refine_level: number;
  is_benming: boolean;
  is_summoned: boolean;
  // 血契状态
  blood_pact_stage: number;
  blood_pact_stage_name: string;
  blood_pact_stage_description?: string;
  blood_pact_max_stage: number;
  blood_pact_weekly_progress: number;
  blood_pact_weekly_limit: number;
  // 魔染/镇契
  corruption: number;
  corruption_max: number;
  corruption_level: string;
  corruption_extra_backlash_rate: number;
  corruption_loss_control_chance: number;
  suppression: number;
  suppression_max: number;
  // 铭印
  imprint_type: ImprintType;
  imprint_name: string;
  last_imprint_at: string | null;
  // 封鞘
  sheath_until: string | null;
  is_sheathed: boolean;
  sheath_remaining_seconds: number;
  // 冷却剩余
  sacrifice_cooldown_remaining: number;
  thunder_wash_cooldown_remaining: number;
  imprint_cooldown_remaining: number;
  // 战力加成
  combat_bonus: BloodSwordCombatBonus;
  // 配置回显
  config: BloodSwordConfigEcho;
  server_time: number;
}

/** 血魔剑状态联合类型 */
export type BloodSwordStatus = BloodSwordStatusNotHeld | BloodSwordStatusHeld;

/** 祭血结果 */
export interface BloodSacrificeResult {
  success: boolean;
  message: string;
  blood_pact_stage: number;
  blood_pact_stage_name: string;
  corruption: number;
  corruption_gain: number;
  blood_pact_weekly_progress: number;
  blood_pact_weekly_remaining: number;
  materials_consumed: Array<{ item_key: string; count: number }>;
}

/** 镇契结果 */
export interface SuppressResult {
  success: boolean;
  message: string;
  corruption: number;
  suppression: number;
  corruption_reduce: number;
  suppression_gain: number;
  materials_consumed: Array<{ item_key: string; count: number }>;
}

/** 雷洗结果 */
export interface ThunderWashResult {
  success: boolean;
  message: string;
  corruption: number;
  suppression: number;
  corruption_reduce: number;
  suppression_gain: number;
  material_type: ThunderWashMaterialType;
  materials_consumed: Array<{ item_key: string; count: number }>;
}

/** 铭印结果 */
export interface ImprintResult {
  success: boolean;
  message: string;
  imprint_type: ImprintType;
  imprint_name: string;
  last_imprint_at: string;
}

/** 封鞘结果 */
export interface SheathResult {
  success: boolean;
  message: string;
  sheath_until: string;
  sheath_duration_hours: number;
  is_summoned: boolean;
}

/**
 * 获取血魔剑残契状态
 * GET /artifact-deep-line/blood-sword/status
 */
export const getBloodSwordStatus = () => {
  return apiClient.get<BloodSwordStatus>('/artifact-deep-line/blood-sword/status');
};

/**
 * 祭血推进血契阶数
 * POST /artifact-deep-line/blood-sword/sacrifice
 */
export const sacrificeBlood = () => {
  return apiClient.post<BloodSacrificeResult>('/artifact-deep-line/blood-sword/sacrifice');
};

/**
 * 镇契降低魔染
 * POST /artifact-deep-line/blood-sword/suppress
 */
export const suppressBloodSword = () => {
  return apiClient.post<SuppressResult>('/artifact-deep-line/blood-sword/suppress');
};

/**
 * 雷洗强力降魔染
 * POST /artifact-deep-line/blood-sword/thunder-wash
 * @param materialType 材料类型：tianlei=天雷竹 / jinlei=金雷竹
 */
export const thunderWashBloodSword = (materialType: ThunderWashMaterialType) => {
  return apiClient.post<ThunderWashResult>(
    '/artifact-deep-line/blood-sword/thunder-wash',
    { material_type: materialType }
  );
};

/**
 * 铭印选择路线
 * POST /artifact-deep-line/blood-sword/imprint
 * @param imprintType 铭印类型：blood=血契铭印 / suppress=镇契铭印
 */
export const imprintBloodSword = (imprintType: 'blood' | 'suppress') => {
  return apiClient.post<ImprintResult>(
    '/artifact-deep-line/blood-sword/imprint',
    { imprint_type: imprintType }
  );
};

/**
 * 封鞘 24 小时
 * POST /artifact-deep-line/blood-sword/sheath
 */
export const sheathBloodSword = () => {
  return apiClient.post<SheathResult>('/artifact-deep-line/blood-sword/sheath');
};
