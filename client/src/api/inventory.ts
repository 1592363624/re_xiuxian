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
/**
 * 物品品质档位键。**故意不写成字面量联合**：档名住在 `game_balance.item_qualities`
 * （资料片能加一档），前端抄一份联合类型必然过期 —— 原来这份就漏了 mythic，
 * 于是神话档物品的载荷在类型上"不可能出现"，界面也就顺理成章地按未知档渲染。
 * 标签与颜色一律走 composables/useItemQualities.js 读服务端词表。
 */
export type ItemQuality = string;

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
 * 物品获取途径标签
 * 由后端 itemSources 反向扫描产出配置推导，不依赖人工维护的来源表
 */
export interface ItemSource {
    /** 来源类型：gather 采集 / drop 掉落 / craft 炼制 / quest 指归任务 / sect 宗门库房 / shop 军需铺 */
    type: string;
    /** 人类可读的来源描述，如「采集 · 越国」「击杀「野兔」掉落」 */
    label: string;
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
    /** 获取途径标签；空数组表示当前没有稳定产出途径 */
    sources: ItemSource[];
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
 *
 * 这份键清单按服务端 `InventoryService._planItemEffect` 实际会产生的回执写（2026-09-23 对齐）：
 * `breakthrough_bonus` 已从出参里删掉 —— 服务器从来没把那个数写到玩家身上，
 * 报出来只是一个抄配置的数（16 件突破丹药因此"用了但什么也没多"）。
 * 业主定了出口（永久 / 一次性 / 抬上限）之后它会带真实语义回来。
 */
export interface AppliedEffects {
    hp_restore?: number;
    mp_restore?: number;
    spirit_stones?: number;
    exp?: number;
    longevity_add?: number;
    toxicity_reduce?: number;
    permanent_attribute_bonus?: Record<string, number>;
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
