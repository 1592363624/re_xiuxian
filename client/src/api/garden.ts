/**
 * 药园系统 API
 *
 * 药园是洞府的生产系统：播种种子、等待成熟、采收获得灵草材料
 * 种子配置由后端 cave_data.json 决定，前端仅做展示与接口调用
 */
import apiClient from './index';

/** 地块状态 */
export type PlotStatus = 'empty' | 'planted' | 'mature';

/** 地块信息 */
export interface PlotInfo {
  plot_index: number;
  status: PlotStatus;
  seed: {
    seed_id: string;
    name: string;
    produce_name: string;
    grow_time_seconds: number;
  } | null;
  planted_at: string | null;
  mature_at: string | null;
  remaining_seconds: number;
  can_harvest: boolean;
}

/** 可用种子 */
export interface AvailableSeed {
  seed_id: string;
  name: string;
  produce_name: string;
  grow_time_seconds: number;
  base_yield: number;
  min_cave_level: number;
}

/** 药园完整状态 */
export interface GardenStatus {
  is_opened: boolean;
  message?: string;
  plot_count?: number;
  max_plots?: number;
  plots?: PlotInfo[];
  available_seeds?: AvailableSeed[];
}

/** 采收结果 */
export interface HarvestResult {
  success: boolean;
  message: string;
  plot_index: number;
  produce_item_id: string;
  produce_name: string;
  yield: number;
  quality: string;
}

/** 获取药园状态 */
export const getGardenStatus = () => {
  return apiClient.get<{ code: number; data: GardenStatus }>('/garden/status');
};

/** 播种 */
export const plantSeed = (plotIndex: number, seedId: string) => {
  return apiClient.post<{ code: number; message: string; data: any }>('/garden/plant', {
    plot_index: plotIndex,
    seed_id: seedId
  });
};

/** 采收指定地块 */
export const harvestPlot = (plotIndex: number) => {
  return apiClient.post<{ code: number; message: string; data: HarvestResult }>('/garden/harvest', {
    plot_index: plotIndex
  });
};

/** 一键采收所有成熟作物 */
export const harvestAll = () => {
  return apiClient.post<{ code: number; message: string; data: any }>('/garden/harvest-all');
};
