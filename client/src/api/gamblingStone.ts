/**
 * 赌石系统 API
 *
 * 封装赌石玩法的接口调用：生成原石/查看线索/选择切法/切开产出/
 * 历史记录/排行榜/上架拍卖行/灵识透石。
 *
 * 设计原则：
 *   - 所有业务逻辑由后端 GamblingStoneService 处理，前端仅做调用与展示
 *   - 禁止直接 axios，统一使用 apiClient（携带 JWT + 统一错误处理）
 *   - 线索博弈核心：4维线索可能含假线索，玩家根据熟练度解读
 *
 * 玩法文档对照：xiuxian_game_guide.md 第21节·经济与博彩补充
 *   赌石流程是 `.赌石` 生成三块原石，再用 `.切 <编号>` 购买切开。
 *
 * 系统定位：
 *   - 4+1产地（乱星海岛/黄枫谷矿脉/昆吾山深处/虚天殿遗矿/诅咒矿脉）差异化产出池
 *   - 4档品质（普通/灵纹/宝光/仙雾）+4维线索（皮壳/重量/灵气/色泽）含假线索博弈
 *   - 3种切法（粗切免费30%损耗/精切100灵石10%损耗/神识切需大衍诀1层无损必稀有）
 *   - 赌石熟练度0-100级，每5级+1%线索解读，每10级+1%稀有产出，100级解锁灵识透石
 *   - 多人交互：未切开原石上架拍卖行 + 稀有掉落全服广播 + 诅咒PVP劫掠 + LDC全服保底
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
import apiClient from './index';

// ==================== 配置类型 ====================

/** 产地配置 */
export interface OriginConfig {
  name: string;
  description: string;
  icon: string;
  weight: number;
  pool_bias: { spirit_stones: number; cultivation: number; material: number; rare: number };
  triggers_curse?: boolean;
}

/** 品质配置 */
export interface QualityConfig {
  name: string;
  tier: number;
  base_price: number;
  weight: number;
  yield_multiplier: number;
  rare_chance_bonus: number;
  color: string;
}

/** 线索维度配置 */
export interface ClueDimConfig {
  name: string;
  values: string[];
}

/** 切法配置 */
export interface CutMethodConfig {
  name: string;
  description: string;
  cost_spirit_stones: number;
  cost_dayan_level: number;
  loss_rate: number;
  guarantee_rare: boolean;
}

/** 赌石系统配置 */
export interface GamblingStoneConfig {
  enabled: boolean;
  daily: {
    generate_limit: number;
    stones_per_generate: number;
    max_uncut_stones: number;
    daily_spirit_stone_cap: number;
    daily_cultivation_cap: number;
  };
  origins: Record<string, OriginConfig>;
  qualities: Record<string, QualityConfig>;
  clues: Record<string, ClueDimConfig> & { fake_probability: number };
  cut_methods: Record<string, CutMethodConfig>;
  skill: {
    max_level: number;
    exp_per_cut: number;
    exp_per_rare_drop: number;
    insight_unlock_level: number;
    fake_reduction_per_level: number;
    rare_bonus_per_10_level: number;
    level_titles: Record<string, string>;
  };
  trade: { enabled: boolean; max_markup_rate: number };
  ranking: { types: string[]; limit: number };
}

// ==================== 数据类型 ====================

/** 玩家赌石档案 */
export interface GamblingStoneProfile {
  skill_level: number;
  skill_exp: number;
  skill_title: string;
  daily_generates: number;
  daily_generate_limit: number;
  daily_spirit_stone_earned: string;
  daily_cultivation_earned: string;
  daily_spirit_stone_cap: number;
  daily_cultivation_cap: number;
  curse_active: boolean;
  curse_until: string | null;
  stats: {
    total_cuts: number;
    total_spirit_stone_earned: string;
    total_cultivation_earned: string;
    total_profit: string;
    biggest_win: string;
    rare_drop_count: number;
    ldc_earned: number;
  };
  insight_unlocked: boolean;
}

/** 原石线索（4维） */
export interface StoneClues {
  crust: string;
  weight: string;
  aura: string;
  color: string;
}

/** 未切开原石 */
export interface UncutStone {
  id: number;
  origin: string;
  origin_name: string;
  origin_icon: string;
  quality: string;
  quality_name: string;
  quality_color: string;
  base_price: number;
  clues: StoneClues;
  is_listed: boolean;
  listing_price: string | null;
  generated_at: string;
}

/** 原石详情 */
export interface StoneDetail extends UncutStone {
  origin_description: string;
  clues: StoneClues;
  skill_level: number;
  skill_title: string;
  insight_unlocked: boolean;
}

/** 切开产出 */
export interface StoneYield {
  spirit_stones: string;
  cultivation: string;
  items: Array<{ item_id: string; quantity: number }>;
  ldc: number;
  rare_drops: Array<{ item_id?: string; type?: string; amount?: number; name: string }>;
  curse_triggered: boolean;
}

/** 切开结果 */
export interface CutResult {
  stone_id: number;
  origin: string;
  origin_name: string;
  display_quality: string;
  real_quality: string;
  real_quality_name: string;
  cut_method: string;
  cut_method_name: string;
  cut_cost: string;
  yield: StoneYield;
  yield_value: string;
  net_profit: string;
  skill_level: number;
  skill_exp: number;
  skill_title: string;
}

/** 历史记录 */
export interface StoneRecord {
  id: number;
  origin: string;
  origin_name: string;
  quality: string;
  real_quality: string;
  real_quality_name: string;
  cut_method: string;
  cut_method_name: string;
  cut_at: string;
  cut_cost: string;
  yield: StoneYield;
  yield_value: string;
}

/** 排行榜条目 */
export interface RankingEntry {
  rank: number;
  player_id: number;
  nickname: string;
  realm: string;
  skill_level: number;
  skill_title: string;
  value: string;
}

/** 灵识透石结果 */
export interface InsightResult {
  stone_id: number;
  insight_dim: string;
  insight_dim_name: string;
  insight_value: string;
  current_clue_value: string;
  is_fake: boolean;
}

// ==================== API 方法 ====================

/** 获取赌石系统配置（无需鉴权） */
export async function getConfig() {
  const res = await apiClient.get('/gambling-stone/config');
  return res.data.data as GamblingStoneConfig;
}

/** 获取玩家赌石档案 */
export async function getProfile() {
  const res = await apiClient.get('/gambling-stone/profile');
  return res.data.data as GamblingStoneProfile;
}

/** 生成3块原石（每日3次上限） */
export async function generateStones() {
  const res = await apiClient.post('/gambling-stone/generate');
  return res.data as { code: number; message: string; data: { stones: UncutStone[]; daily_generates_remaining: number } };
}

/** 获取未切开原石列表 */
export async function getStones() {
  const res = await apiClient.get('/gambling-stone/stones');
  return res.data.data as { stones: UncutStone[]; count: number };
}

/** 获取原石详情（含线索） */
export async function getStoneDetail(stoneId: number) {
  const res = await apiClient.get(`/gambling-stone/stones/${stoneId}`);
  return res.data.data as StoneDetail;
}

/** 切开原石 */
export async function cutStone(stoneId: number, cutMethod: 'rough' | 'fine' | 'divine_sense') {
  const res = await apiClient.post('/gambling-stone/cut', { stone_id: stoneId, cut_method: cutMethod });
  return res.data as { code: number; message: string; data: CutResult };
}

/** 获取切开历史记录 */
export async function getRecords(page = 1, pageSize = 20) {
  const res = await apiClient.get('/gambling-stone/records', { params: { page, page_size: pageSize } });
  return res.data.data as { records: StoneRecord[]; total: number; page: number; page_size: number; total_pages: number };
}

/** 获取排行榜 */
export async function getRanking(type: 'biggest_win' | 'total_profit' | 'rare_count' | 'skill_level') {
  const res = await apiClient.get('/gambling-stone/ranking', { params: { type } });
  return res.data.data as { ranking: RankingEntry[]; type: string };
}

/** 上架拍卖行 */
export async function listStone(stoneId: number, price: number) {
  const res = await apiClient.post('/gambling-stone/list', { stone_id: stoneId, price });
  return res.data as { code: number; message: string; data: { stone_id: number; listing_price: string; base_price: number; max_price: number } };
}

/** 取消上架 */
export async function unlistStone(stoneId: number) {
  const res = await apiClient.post('/gambling-stone/unlist', { stone_id: stoneId });
  return res.data as { code: number; message: string; data: { stone_id: number } };
}

/** 灵识透石（熟练度100级解锁） */
export async function insightStone(stoneId: number) {
  const res = await apiClient.post('/gambling-stone/insight', { stone_id: stoneId });
  return res.data as { code: number; message: string; data: InsightResult };
}
