/**
 * 玩家档案编辑器 API（GM 后台）
 *
 * 后台要能编辑玩家除基础信息外的全部资产：战斗属性、统计计数、灵根、背包物品、装备、功法。
 * 可编辑字段清单不在前端硬编码，统一由 GET /admin/player-editor/schema 下发
 * （服务端读 config/admin_player_editor.json），前端按字段声明动态渲染表单。
 */
import apiClient from './index';

/** 单个可编辑字段的声明（后端配置下发） */
export interface EditorField {
  /** 字段名（标量列写列名，整块列写 blob 内的键名） */
  key: string;
  /** 显示名 */
  label: string;
  /** 控件类型 */
  type: 'string' | 'number' | 'boolean' | 'enum';
  min?: number;
  max?: number;
  max_length?: number;
  /** enum 类型的可选项；string 类型若带 options 则渲染成可检索下拉（如境界、灵根） */
  options?: Array<{ value: string; label: string; meta?: string }>;
}

/** 字段分组；column 存在表示这一组写在哪个整块 JSON 列里 */
export interface EditorFieldGroup {
  id: string;
  name: string;
  column?: string;
  fields: EditorField[];
}

/** 法宝深线分组：deep_line_state 里的一个子对象（如 blood_sword） */
export interface DeepLineGroup {
  /** 深线键名，如 blood_sword / xutian_cauldron / sky_bottle / five_element_wheel */
  key: string;
  label: string;
  fields: EditorField[];
}

/** 深线字段值：数值、布尔、枚举字符串，或时间字符串（null 表示未设置） */
export type DeepLineValue = number | boolean | string | null;

/** 编辑器整体 schema：可编辑字段 + 各类资产的编辑限制 */
export interface PlayerEditorSchema {
  player_field_groups: EditorFieldGroup[];
  blob_field_groups: EditorFieldGroup[];
  inventory: {
    max_quantity: number;
    max_add_quantity: number;
    default_ignore_capacity: boolean;
    allow_unknown_item: boolean;
    page_size_default: number;
    page_size_max: number;
    editable_fields: string[];
  };
  equipment: {
    editable_fields: string[];
    slots: string[];
    refine_level_range: [number, number];
    durability_range: [number, number];
    attr_multiplier_range: [number, number];
    spirit_power_range: [number, number];
    /** 法宝深线（deep_line_state）可视化编辑用的字段声明，一条线一组 */
    deep_lines: DeepLineGroup[];
  };
  techniques: {
    editable_fields: string[];
    equip_slots: string[];
    layer_range: [number, number];
    proficiency_range: [number, number];
    fail_streak_range: [number, number];
    practice_count_range: [number, number];
    allow_unknown_technique: boolean;
  };
  dictionaries: {
    item_option_limit_default: number;
    item_option_limit_max: number;
    technique_option_limit_default: number;
    technique_option_limit_max: number;
    /** 背包筛选用的物品类型词表（取自 item_data 实际取值） */
    item_types: string[];
    /** 背包筛选用的品质词表（取自 game_balance.item_qualities，带中文档名） */
    item_qualities: Array<{ value: string; label: string }>;
  };
}

/** 背包物品行 */
export interface InventoryRow {
  id: number;
  player_id: number;
  item_key: string;
  quantity: number;
  metadata: Record<string, any> | null;
  item_name?: string;
  item_type?: string;
  item_quality?: string;
  config_missing?: boolean;
  created_at?: string;
}

/** 装备行 */
export interface EquipmentRow {
  id: number;
  player_id: number;
  slot: string;
  item_key: string;
  durability: number;
  max_durability: number;
  refine_level: number;
  is_benming: boolean;
  benming_slot: number | null;
  spirit_power: number;
  sort_order: number;
  attr_multiplier: number;
  is_summoned: boolean;
  deep_line_state?: Record<string, any> | null;
  item_name?: string;
  config_missing?: boolean;
}

/** 功法行 */
export interface TechniqueRow {
  id: number;
  player_id: number;
  technique_id: string;
  layer: number;
  proficiency: number;
  equip_slot: string | null;
  comprehended_skills: string[];
  fail_streak: number;
  practice_count: number;
  daily_practice_count: number;
  technique_name?: string;
  technique_grade?: string;
  config_missing?: boolean;
}

/** 玩家档案 */
export interface PlayerProfile {
  player: Record<string, any>;
  inventory: {
    items: InventoryRow[];
    total_kinds: number;
    total_quantity: number;
    capacity: number;
    max_quantity: number;
  };
  equipment: EquipmentRow[];
  techniques: TechniqueRow[];
}

/** 统一响应外壳 */
interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data: T;
}

const BASE = '/admin/player-editor';

/**
 * 获取可编辑字段 schema
 */
export const getPlayerEditorSchema = () => {
  return apiClient.get<ApiEnvelope<PlayerEditorSchema>>(`${BASE}/schema`);
};

/**
 * 获取玩家完整档案（含背包 / 装备 / 功法）
 */
export const getPlayerProfile = (playerId: number) => {
  return apiClient.get<ApiEnvelope<PlayerProfile>>(`${BASE}/${playerId}`);
};

/**
 * 局部更新玩家档案
 * @param patch.columns 标量列绝对值，如 { exp: 1000 }
 * @param patch.blobs   整块 JSON 列的键级补丁，如 { attributes: { atk: 50 } }
 */
export const patchPlayerProfile = (
  playerId: number,
  patch: {
    columns?: Record<string, any>;
    blobs?: Record<string, Record<string, any>>;
  }
) => {
  return apiClient.patch<ApiEnvelope<{ changed: string[]; player: Record<string, any> }>>(
    `${BASE}/${playerId}`,
    patch
  );
};

/**
 * 获取背包列表
 * @param params.type 物品类型筛选（consumable / equipment / material…）
 * @param params.quality 品质筛选（common / rare / mythic…）
 */
export const getPlayerInventory = (
  playerId: number,
  params: { keyword?: string; type?: string; quality?: string; limit?: number } = {}
) => {
  return apiClient.get<ApiEnvelope<PlayerProfile['inventory']>>(`${BASE}/${playerId}/inventory`, { params });
};

/**
 * 新增 / 追加背包物品
 * @param payload.mode add=累加（默认）/ set=直接设定为 quantity
 */
export const addInventoryItem = (
  playerId: number,
  payload: { item_key: string; quantity?: number; mode?: 'add' | 'set'; ignore_capacity?: boolean; metadata?: Record<string, any> | null }
) => {
  return apiClient.post<ApiEnvelope<{ item: InventoryRow }>>(`${BASE}/${playerId}/inventory`, payload);
};

/** 批量发放结果里的单条回执 */
export interface BatchGrantResult {
  ok: boolean;
  item_key: string;
  item_name?: string;
  mode?: 'add' | 'set';
  quantity?: number;
  message?: string;
}

/**
 * 批量发放 / 调整背包物品
 *
 * 服务端逐条处理：某条失败不影响其余条目，返回里带回每一条的成功/失败原因，
 * 避免"20 件里错 1 件就整批发不出去、还得一件件试"的情况。
 */
export const batchGrantItems = (
  playerId: number,
  payload: {
    items: Array<{ item_key: string; quantity?: number; mode?: 'add' | 'set'; metadata?: Record<string, any> | null }>;
    mode?: 'add' | 'set';
    ignore_capacity?: boolean;
  }
) => {
  return apiClient.post<ApiEnvelope<{ succeeded: number; failed: number; results: BatchGrantResult[] }>>(
    `${BASE}/${playerId}/inventory/batch`,
    payload
  );
};

/**
 * 修改背包物品数量 / 元数据（数量传 0 等价于回收该物品）
 */
export const updateInventoryItem = (
  playerId: number,
  itemId: number,
  payload: { quantity?: number; metadata?: Record<string, any> | null }
) => {
  return apiClient.put<ApiEnvelope<{ item?: InventoryRow; removed?: boolean }>>(
    `${BASE}/${playerId}/inventory/${itemId}`,
    payload
  );
};

/**
 * 删除背包物品
 */
export const deleteInventoryItem = (playerId: number, itemId: number) => {
  return apiClient.delete<ApiEnvelope<null>>(`${BASE}/${playerId}/inventory/${itemId}`);
};

/**
 * 清空背包
 */
export const clearInventory = (playerId: number) => {
  return apiClient.post<ApiEnvelope<{ removed_kinds: number }>>(`${BASE}/${playerId}/inventory/clear`);
};

/**
 * 强制穿戴装备（同槽位已有则替换）
 */
export const equipItem = (
  playerId: number,
  payload: { slot: string; item_key: string; refine_level?: number; durability?: number; max_durability?: number }
) => {
  return apiClient.post<ApiEnvelope<{ equipment: EquipmentRow }>>(`${BASE}/${playerId}/equipment`, payload);
};

/**
 * 修改装备记录
 */
export const updateEquipment = (playerId: number, equipmentId: number, payload: Record<string, any>) => {
  return apiClient.put<ApiEnvelope<{ equipment: EquipmentRow }>>(
    `${BASE}/${playerId}/equipment/${equipmentId}`,
    payload
  );
};

/**
 * 强制卸下装备
 */
export const unequipItem = (playerId: number, equipmentId: number) => {
  return apiClient.delete<ApiEnvelope<null>>(`${BASE}/${playerId}/equipment/${equipmentId}`);
};

/**
 * 授予功法（已习得则更新进度）
 */
export const grantTechnique = (
  playerId: number,
  payload: { technique_id: string; layer?: number; proficiency?: number; equip_slot?: string | null }
) => {
  return apiClient.post<ApiEnvelope<{ technique: TechniqueRow }>>(`${BASE}/${playerId}/techniques`, payload);
};

/**
 * 修改功法进度
 */
export const updateTechnique = (playerId: number, techniqueRecordId: number, payload: Record<string, any>) => {
  return apiClient.put<ApiEnvelope<{ technique: TechniqueRow }>>(
    `${BASE}/${playerId}/techniques/${techniqueRecordId}`,
    payload
  );
};

/**
 * 删除功法
 */
export const deleteTechnique = (playerId: number, techniqueRecordId: number) => {
  return apiClient.delete<ApiEnvelope<null>>(`${BASE}/${playerId}/techniques/${techniqueRecordId}`);
};

/**
 * 物品字典检索（背包新增时下拉用）
 */
export const searchItemOptions = (params: { keyword?: string; type?: string; limit?: number } = {}) => {
  return apiClient.get<ApiEnvelope<{ items: Array<{ value: string; label: string; meta: string; group: string }>; total: number }>>(
    `${BASE}/item-options`,
    { params }
  );
};

/**
 * 功法字典检索（授予功法时下拉用）
 */
export const searchTechniqueOptions = (params: { keyword?: string; limit?: number } = {}) => {
  return apiClient.get<ApiEnvelope<{ techniques: Array<{ value: string; label: string; meta: string; group: string }>; total: number }>>(
    `${BASE}/technique-options`,
    { params }
  );
};
