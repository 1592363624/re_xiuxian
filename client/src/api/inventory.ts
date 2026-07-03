/**
 * 背包（储物袋）系统相关 API
 * 封装背包查询、使用、丢弃、分类等接口调用
 * 业务逻辑全部由后端 InventoryService 处理，前端仅做展示与接口调用
 */
import apiClient from './index';

/**
 * 物品品质类型
 * common 普通 / uncommon 非凡 / rare 稀有 / epic 史诗 / legendary 传说
 */
export type ItemQuality = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'unknown';

/**
 * 物品类型
 * consumable 消耗品 / material 材料 / equipment 装备 / unknown 未知
 */
export type ItemType = 'consumable' | 'material' | 'equipment' | 'unknown' | string;

/**
 * 物品效果配置（与后端 item_data.json effect 字段对应）
 */
export interface ItemEffect {
    /** 恢复气血值 */
    hp_restore?: number;
    /** 恢复灵力值 */
    mp_restore?: number;
    /** 增加灵石 */
    spirit_stones?: number;
    /** 增加修为 */
    exp?: number;
    /** 突破加成 */
    breakthrough_bonus?: number;
    [key: string]: any;
}

/**
 * 背包物品（静态配置 + 动态数量合并后的结构）
 */
export interface InventoryItem {
    /** 玩家物品记录 ID */
    record_id: number;
    /** 物品配置键名（业务标识） */
    item_key: string;
    /** 物品名称 */
    name: string;
    /** 物品类型 */
    type: ItemType;
    /** 物品子类型（可为空） */
    subtype: string | null;
    /** 物品品质 */
    quality: ItemQuality;
    /** 物品描述 */
    description: string;
    /** 物品效果 */
    effect: ItemEffect;
    /** 物品售价（灵石） */
    price: number;
    /** 当前持有数量 */
    quantity: number;
    /** 是否可使用（消耗品为 true） */
    usable: boolean;
}

/**
 * 背包完整数据
 */
export interface InventoryData {
    /** 物品列表 */
    items: InventoryItem[];
    /** 物品总数量 */
    total_count: number;
    /** 储物袋容量上限 */
    capacity: number;
}

/**
 * 物品分类信息
 */
export interface CategoryInfo {
    /** 分类类型 */
    type: string;
    /** 该分类下物品种类数 */
    count: number;
    /** 该分类下物品总数量 */
    total_quantity: number;
}

/**
 * 分类接口返回结构
 */
export interface CategoryData {
    /** 分类列表 */
    categories: CategoryInfo[];
    /** 储物袋容量上限 */
    capacity: number;
    /** 物品总数量 */
    total_count: number;
}

/**
 * 使用物品后返回的效果信息
 */
export interface AppliedEffects {
    hp_restore?: number;
    mp_restore?: number;
    spirit_stones?: number;
    exp?: number;
    breakthrough_bonus?: number;
    [key: string]: any;
}

/**
 * 使用物品接口返回结果
 */
export interface UseItemResult {
    success: boolean;
    message: string;
    effects: AppliedEffects;
    player: {
        hp_current: number;
        mp_current: number;
        spirit_stones: number | string;
    };
}

/**
 * 丢弃物品接口返回结果
 */
export interface DiscardItemResult {
    success: boolean;
    message: string;
}

/**
 * 获取玩家背包列表
 * GET /inventory
 * @returns 背包数据（物品列表 + 容量信息）
 */
export const getInventory = () => {
    return apiClient.get('/inventory');
};

/**
 * 使用物品（消耗品）
 * POST /inventory/use
 * @param itemKey - 物品配置键名
 * @param quantity - 使用数量
 * @returns 使用结果（效果、玩家状态变化）
 */
export const useItem = (itemKey: string, quantity: number = 1) => {
    return apiClient.post('/inventory/use', { item_key: itemKey, quantity });
};

/**
 * 丢弃物品
 * POST /inventory/discard
 * @param itemKey - 物品配置键名
 * @param quantity - 丢弃数量
 * @returns 丢弃结果
 */
export const discardItem = (itemKey: string, quantity: number = 1) => {
    return apiClient.post('/inventory/discard', { item_key: itemKey, quantity });
};

/**
 * 获取物品分类（用于前端按类型筛选）
 * GET /inventory/categories
 * @returns 分类数据
 */
export const getCategories = () => {
    return apiClient.get('/inventory/categories');
};
