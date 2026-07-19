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
    total_attempts: number;
    success_count: number;
    fail_count: number;
    product: {
        item_key: string;
        name: string;
        quantity: number;
    };
    skill_exp_gained: number;
    skill_level: number;
    skill_level_up: boolean;
    message: string;
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
