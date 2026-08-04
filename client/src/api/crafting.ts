/**
 * 炼制系统相关 API
 * 封装炼丹/炼器的配方查询、学习、炼制接口调用
 * 业务逻辑全部由后端 CraftingService 处理，前端仅做展示与接口调用
 *
 * 炼制类型（craft_type）说明：
 *   - alchemy  炼丹（产出丹药类消耗品）
 *   - refining 炼器（产出装备类物品）
 */
import apiClient from './index';

/**
 * 配方材料信息
 */
export interface RecipeMaterial {
    item_key: string;
    name: string;
    required: number;
    owned: number;
    sufficient: boolean;
}

/**
 * 已学配方信息（含实时状态：材料持有量、冷却、成功率）
 */
export interface LearnedRecipe {
    record_id: number;
    recipe_id: string;
    name: string;
    type: 'alchemy' | 'refining';
    description: string;
    product: {
        item_key: string;
        name: string;
        quantity: number;
        quality: string;
    };
    materials: RecipeMaterial[];
    required_realm_rank: number;
    required_skill_level: number;
    base_success_rate: number;
    actual_success_rate: number;
    skill_exp: number;
    cooldown_sec: number;
    cooldown_remaining: number;
    craft_count: number;
    can_craft: boolean;
}

/**
 * 炼制技能信息
 */
export interface CraftSkillInfo {
    level: number;
    exp: number;
    title: string;
    success_bonus: number;
    next_level_exp: number | null;
    max_level: number;
}

/**
 * 已学配方列表返回数据
 */
export interface LearnedRecipesData {
    alchemy: LearnedRecipe[];
    refining: LearnedRecipe[];
    skill_info: CraftSkillInfo;
}

/**
 * 可学习配方信息
 */
export interface AvailableRecipe {
    recipe_id: string;
    name: string;
    type: 'alchemy' | 'refining';
    description: string;
    product: {
        item_key: string;
        name: string;
        quantity: number;
    };
    required_realm_rank: number;
    required_skill_level: number;
    base_success_rate: number;
    learn_source: string;
    learned: boolean;
}

/**
 * 可学习配方列表返回数据
 */
export interface AvailableRecipesData {
    alchemy: AvailableRecipe[];
    refining: AvailableRecipe[];
}

/**
 * 炼制结果
 */
export interface CraftResult {
    success: boolean;
    recipe_name: string;
    /** 配方类型（alchemy/refining），用于区分丹药效果倍率与装备属性倍率展示 */
    recipe_type: 'alchemy' | 'refining';
    total_attempts: number;
    success_count: number;
    fail_count: number;
    product: {
        item_key: string;
        name: string;
        quantity: number;
        /** 成品最终品质（受火候偏差影响浮动） */
        quality: string;
        /** 品质档位名称：完美/极品/上品/凡品/劣品 */
        quality_tier: string;
        /** 丹药：品质对应的效果倍率（服用恢复/修为放大系数） */
        effect_multiplier: number;
        /** 装备：品质对应的属性浮动倍率（穿戴后放大装备基础属性；仅炼器产物有值，丹药为 1） */
        attr_multiplier: number;
    };
    /** 成功率构成明细，用于前端展示数值来源 */
    rate_detail: {
        base: number;
        skill_bonus: number;
        realm_modifier: number;
        cave_bonus: number;
        heat_modifier: number;
        final: number;
    };
    /** 本次炼制的最终火候偏差 */
    heat_deviation: number;
    skill_exp_gained: number;
    skill_level: number;
    skill_level_up: boolean;
    message: string;
}

/**
 * 火候提示（模糊描述，不泄露精确目标值）
 */
export interface HeatHint {
    level: 'low' | 'mid' | 'high';
    text: string;
}

/**
 * 开炉结果（火候会话已创建）
 */
export interface CraftStartResult {
    success: boolean;
    recipe_id: string;
    recipe_name: string;
    quantity: number;
    total_stages: number;
    current_stage: number;
    heat_min: number;
    heat_max: number;
    hint: HeatHint;
    expires_at: number;
    message: string;
}

/**
 * 单阶段控火结果
 */
export interface CraftHeatResult {
    success: boolean;
    /** perfect=恰到好处 too_hot=火大 too_cold=火小 */
    stage_result: 'perfect' | 'too_hot' | 'too_cold';
    stage_message: string;
    current_stage: number;
    total_stages: number;
    finished: boolean;
    hint: HeatHint | null;
    message: string;
}

/**
 * 火候会话状态（断线重连用）
 */
export interface HeatSession {
    recipe_id: string;
    quantity: number;
    current_stage: number;
    total_stages: number;
    finished: boolean;
    heat_min: number;
    heat_max: number;
    hint: HeatHint | null;
    expires_at: number;
}

/**
 * 获取已学配方列表
 * GET /api/crafting/recipes
 * @returns 已学配方列表（含材料持有量、冷却状态、实际成功率）
 */
export async function getLearnedRecipes(): Promise<LearnedRecipesData> {
    const res = await apiClient.get('/crafting/recipes');
    return res.data.data;
}

/**
 * 获取所有可学习配方列表
 * GET /api/crafting/available
 * @returns 可学习配方列表（含学习状态）
 */
export async function getAvailableRecipes(): Promise<AvailableRecipesData> {
    const res = await apiClient.get('/crafting/available');
    return res.data.data;
}

/**
 * 学习配方（通过消耗丹方/图谱物品）
 * POST /api/crafting/learn
 * @param itemKey - 丹方/图谱的物品key
 * @returns 学习结果
 */
export async function learnRecipe(itemKey: string): Promise<{ success: boolean; message: string; recipe_name: string; recipe_id: string }> {
    const res = await apiClient.post('/crafting/learn', { item_key: itemKey });
    return res.data;
}

/**
 * 炼制物品
 * POST /api/crafting/craft
 * @param recipeId - 配方ID
 * @param quantity - 炼制次数（默认1）
 * @returns 炼制结果
 */
export async function craft(recipeId: string, quantity: number = 1): Promise<CraftResult> {
    const res = await apiClient.post('/crafting/craft', { recipe_id: recipeId, quantity });
    return res.data;
}

/**
 * 开炉：创建火候炼制会话
 * POST /api/crafting/craft/start
 * @param recipeId - 配方ID
 * @param quantity - 炼制次数（默认1）
 * @returns 会话信息（含首阶段火候提示）
 */
export async function craftStart(recipeId: string, quantity: number = 1): Promise<CraftStartResult> {
    const res = await apiClient.post('/crafting/craft/start', { recipe_id: recipeId, quantity });
    return res.data;
}

/**
 * 控火：提交当前阶段的火候档位
 * POST /api/crafting/craft/heat
 * @param heat - 火候档位（heat_min ~ heat_max）
 * @returns 阶段反馈
 */
export async function craftHeat(heat: number): Promise<CraftHeatResult> {
    const res = await apiClient.post('/crafting/craft/heat', { heat });
    return res.data;
}

/**
 * 开炉结算：执行炼制并产出成品
 * POST /api/crafting/craft/finish
 * @returns 炼制结果
 */
export async function craftFinish(): Promise<CraftResult> {
    const res = await apiClient.post('/crafting/craft/finish');
    return res.data;
}

/**
 * 停火散炉：放弃当前会话
 * POST /api/crafting/craft/cancel
 */
export async function craftCancel(): Promise<{ success: boolean; cancelled: boolean; message: string }> {
    const res = await apiClient.post('/crafting/craft/cancel');
    return res.data;
}

/**
 * 查询当前火候会话（断线重连恢复界面）
 * GET /api/crafting/craft/session
 * @returns 会话状态，无进行中会话时为 null
 */
export async function getHeatSession(): Promise<HeatSession | null> {
    const res = await apiClient.get('/crafting/craft/session');
    return res.data.data;
}
