/**
 * 装备穿戴系统相关 API
 * 封装装备查询、穿戴、卸下、加成等接口调用
 * 业务逻辑全部由后端 EquipmentService 处理，前端仅做展示与接口调用
 *
 * 装备槽位（slot）说明：
 *   - weapon    武器
 *   - armor     护甲
 *   - accessory 饰品
 *   - boots     靴子
 *   - dharma    法器
 * 槽位由物品静态配置的 subtype 字段决定，一个玩家每个槽位只能装备一件物品
 */
import apiClient from './index';

/**
 * 装备槽位类型
 * 与后端 game_balance.equipment.valid_slots 对应
 */
export type EquipmentSlot = 'weapon' | 'armor' | 'accessory' | 'boots' | 'dharma' | string;

/**
 * 已装备物品信息
 * 与后端 EquipmentService.getEquipped 返回结构中 slots[slot] 字段对应
 * （后端实际返回字段名为 name，前端组件中按 name 访问）
 */
export interface EquippedItem {
    /** 槽位标识（weapon/armor/accessory/boots/dharma） */
    slot: string;
    /** 槽位中文名（武器/护甲/饰品/靴子/法器） */
    slot_name: string;
    /** 物品配置键名（业务标识） */
    item_key: string;
    /** 物品名称 */
    item_name: string;
    /** 物品品质（common/uncommon/rare/epic/legendary） */
    quality: string;
    /** 物品描述 */
    description: string;
    /** 装备效果（属性加成字典，如 { atk: 5, speed: 3 }） */
    effect: Record<string, number>;
    /** 穿戴时间（ISO 字符串） */
    equipped_at: string;
}

/**
 * 获取已装备列表接口返回结果
 * 后端以 slots 字典形式返回所有槽位的装备信息
 */
export interface EquippedListData {
    /** 槽位字典 { [slot]: EquippedItem }，未装备的槽位不存在该 key */
    slots: Record<string, EquippedItem>;
    /** 已装备物品数量 */
    count: number;
}

/**
 * 装备总加成
 * 由后端遍历所有已装备物品的 effect 字段累加得出
 * 仅累加数值型属性，非数值属性（如描述）不参与计算
 */
export interface EquipmentBonus {
    /** 攻击加成 */
    atk?: number;
    /** 防御加成 */
    def?: number;
    /** 气血上限加成 */
    hp_max?: number;
    /** 灵力上限加成 */
    mp_max?: number;
    /** 身法加成 */
    speed?: number;
    /** 感知加成 */
    sense?: number;
    /** 气运加成 */
    luck?: number;
    /** 修炼速度加成 */
    cultivate_speed?: number;
    /** 其他动态属性 */
    [key: string]: number | undefined;
}

/**
 * 穿戴装备接口返回结果
 * 若该槽位已有装备，后端会自动卸下旧装备并归还背包
 */
export interface EquipResult {
    /** 是否成功 */
    success: boolean;
    /** 提示消息 */
    message: string;
    /** 装备槽位标识 */
    slot: string;
    /** 装备槽位中文名 */
    slot_name: string;
    /** 新穿戴的装备信息 */
    item: {
        item_key: string;
        name: string;
        quality: string;
        effect: Record<string, number>;
    };
    /** 被替换下的旧装备（若该槽位原本已有装备，否则为 null） */
    unequipped: { item_key: string; name: string } | null;
}

/**
 * 卸下装备接口返回结果
 */
export interface UnequipResult {
    /** 是否成功 */
    success: boolean;
    /** 提示消息 */
    message: string;
    /** 装备槽位标识 */
    slot: string;
    /** 装备槽位中文名 */
    slot_name: string;
    /** 被卸下的装备信息 */
    item: {
        item_key: string;
        name: string;
    };
}

/**
 * 获取玩家已装备物品列表
 * GET /equipment
 * @returns 已装备物品列表（按槽位分组，含已装备数量）
 */
export const getEquipped = () => {
    return apiClient.get('/equipment');
};

/**
 * 穿戴装备
 * POST /equipment/equip
 * 业务说明：若该槽位已有装备，后端会自动卸下旧装备并归还背包
 * @param itemKey - 物品配置键名（必须为 equipment 类型）
 * @returns 穿戴结果（含被替换下的旧装备信息）
 */
export const equipItem = (itemKey: string) => {
    return apiClient.post('/equipment/equip', { item_key: itemKey });
};

/**
 * 卸下装备
 * POST /equipment/unequip
 * 业务说明：卸下后装备归还背包，需保证背包有剩余容量
 * @param slot - 装备槽位（weapon/armor/accessory/boots/dharma）
 * @returns 卸下结果
 */
export const unequipItem = (slot: string) => {
    return apiClient.post('/equipment/unequip', { slot });
};

/**
 * 获取装备总加成
 * GET /equipment/bonus
 * 业务说明：遍历所有已装备物品，累加 effect 字段中的数值型属性
 * @returns 装备总加成（属性字典）
 */
export const getEquipmentBonus = () => {
    return apiClient.get('/equipment/bonus');
};

// ========================================
// 法宝深度系统 API（v1.2 新增）
// ========================================

/**
 * 法宝深度系统扩展字段
 * 对应后端 player_equipment 表新增字段
 */
export interface TreasureFields {
    /** 当前耐久度（0 时装备破碎） */
    durability: number;
    /** 最大耐久度（每次修理扣减上限） */
    max_durability: number;
    /** 祭炼等级 0~15 */
    refine_level: number;
    /** 是否本命法器 */
    is_benming: boolean;
    /** 本命槽位编号 1~max_slots（仅 is_benming=true 时有效） */
    benming_slot: number | null;
    /** 本命法器法力值 */
    spirit_power: number;
    /** 装备排序顺序 */
    sort_order: number;
    /** 本命法器是否已祭出 */
    is_summoned: boolean;
    /** 派生字段：是否已破碎 */
    is_broken: boolean;
}

/**
 * 祭炼结果
 */
export interface RefineResult {
    success: boolean;
    message: string;
    slot: string;
    refine_level: number;
    is_success: boolean;
    cost: {
        spirit_stones: number;
        material: { id: string; quantity: number };
    };
}

/**
 * 设置本命法器结果
 */
export interface BenmingResult {
    success: boolean;
    message: string;
    slot: string;
    benming_slot: number;
    spirit_power: number;
    cost: {
        spirit_stones: number;
        material: { id: string; quantity: number };
    };
}

/**
 * 修理结果
 */
export interface RepairResult {
    success: boolean;
    message: string;
    slot: string;
    durability: number;
    max_durability: number;
    cost: { spirit_stones: number; max_durability_loss: number };
}

/**
 * 一键修理结果汇总
 */
export interface RepairAllResult {
    success: boolean;
    message: string;
    total_repaired: number;
    total_cost: number;
    details: Array<{
        slot: string;
        success?: boolean;
        skipped?: boolean;
        message?: string;
        durability?: number;
        max_durability?: number;
        cost?: number;
    }>;
}

/**
 * 祭炼装备
 * POST /equipment/refine
 * 消耗灵石+材料，按成功率随机成功/失败，成功则 refine_level +1
 */
export const refineItem = (slot: string) => {
    return apiClient.post('/equipment/refine', { slot });
};

/**
 * 设置本命法器
 * POST /equipment/benming
 * 消耗灵石+材料，将装备绑定为本命
 */
export const setBenming = (slot: string) => {
    return apiClient.post('/equipment/benming', { slot });
};

/**
 * 祭出本命法器
 * POST /equipment/summon
 * 标记 is_summoned=true，受场景限制
 */
export const summonTreasure = (slot: string) => {
    return apiClient.post('/equipment/summon', { slot });
};

/**
 * 收回本命法器
 * POST /equipment/recall
 * 标记 is_summoned=false
 */
export const recallTreasure = (slot: string) => {
    return apiClient.post('/equipment/recall', { slot });
};

/**
 * 调整装备排序
 * POST /equipment/order
 * 更新 sort_order 字段，影响面板显示顺序
 */
export const adjustOrder = (slot: string, newOrder: number) => {
    return apiClient.post('/equipment/order', { slot, new_order: newOrder });
};

/**
 * 散念（解除本命法器）
 * POST /equipment/disperse
 * 清除本命标记，回收部分材料
 */
export const disperseSpirit = (slot: string) => {
    return apiClient.post('/equipment/disperse', { slot });
};

/**
 * 修理单件装备
 * POST /equipment/repair
 * 恢复耐久至 max_durability，扣减 max_durability 上限
 */
export const repairItem = (slot: string) => {
    return apiClient.post('/equipment/repair', { slot });
};

/**
 * 一键修理所有装备
 * POST /equipment/repair-all
 * 遍历所有装备，对需要修理的逐个调用 repair
 */
export const repairAll = () => {
    return apiClient.post('/equipment/repair-all', {});
};
