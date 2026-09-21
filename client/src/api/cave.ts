/**
 * 洞府系统 API
 *
 * 洞府是个人经营系统：灵脉产灵石、静室增闭关、丹房炼丹、器室炼器、大阵防御
 * 所有数值配置由后端 cave_data.json 决定，前端仅做展示与接口调用
 */
import apiClient from './index';

/**
 * 设施类型：取自内容（cave_data.cave.facilities 的键），服务端还会筛掉
 * player_caves 里还没有等级列的那些，所以这里不封成联合类型 —— 抄一份在客户端，
 * 资料片加了设施就得两边一起改。
 */
export type FacilityType = string;

/** 设施信息 */
export interface FacilityInfo {
  name: string;
  description: string;
  level: number;
  max_level: number;
  can_upgrade: boolean;
  upgrade_cost: {
    level: number;
    spirit_stone: number;
    material: string | null;
    material_count: number;
    /** 材料中文名：由服务端按 item_data 补，客户端不抄物品名典 */
    material_name?: string | null;
  } | null;
}

/** 灵脉信息 */
export interface SpiritVeinInfo {
  level: number;
  pending_stones: number;
  accumulated_stones: number;
  last_collect: string | null;
  produce_rate: number;
}

/** 药园地块概览 */
export interface GardenPlotsInfo {
  current: number;
  max: number;
  unlock_cost: { plot_index: number; spirit_stone: number } | null;
}

/** 洞府完整信息 */
export interface CaveInfo {
  is_opened: boolean;
  message?: string;
  opened_at?: string;
  facilities?: Record<FacilityType, FacilityInfo>;
  spirit_vein?: SpiritVeinInfo;
  garden_plots?: GardenPlotsInfo;
}

/** 获取洞府信息 */
export const getCaveInfo = () => {
  return apiClient.get<{ code: number; data: CaveInfo }>('/cave/info');
};

/** 开辟洞府 */
export const openCave = () => {
  return apiClient.post<{ code: number; message: string; data: any }>('/cave/open');
};

/** 升级设施 */
export const upgradeFacility = (facility: FacilityType) => {
  return apiClient.post<{ code: number; message: string; data: any }>('/cave/upgrade', { facility });
};

/** 领取灵脉灵石 */
export const collectStones = () => {
  return apiClient.post<{ code: number; message: string; data: any }>('/cave/collect-stones');
};

/** 解锁新的药园地块 */
export const unlockPlot = () => {
  return apiClient.post<{ code: number; message: string; data: any }>('/cave/unlock-plot');
};
