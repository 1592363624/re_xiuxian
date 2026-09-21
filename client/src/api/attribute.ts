/**
 * 属性相关 API
 */
import apiClient from './index';

/**
 * 获取玩家完整属性信息
 */
export const getFullAttributes = () => {
  return apiClient.get('/attribute/full');
};

/**
 * 属性面板字段定义（服务端属性注册表 + 已启用资料片）
 * 标签/图标/说明/后缀/显示位置都从这里来，前端不再各自抄一份属性表
 */
export const getPanelSchema = () => {
  return apiClient.get('/attribute/panel');
};

/** 面板字段定义，字段含义见 server/game/stats/StatRegistry.js#panelStats */
export interface StatSchemaEntry {
  key: string;
  label: string;
  /** 窄位（左栏属性格、加成角标）用的短名，缺省等于 label */
  shortLabel: string;
  icon: string;
  description: string;
  suffix: string;
  unit: 'point' | 'percent' | string;
  group: string;
  order: number;
  /** sidebar = 左栏常驻属性格；detail = 属性详情/悬浮层 */
  spot: 'sidebar' | 'detail' | string;
  aliases: string[];
  allocatable: boolean;
  allocInputKey: string;
  bonusKey: string;
}

/**
 * 可加点属性名。
 * 旧写法是 'hp' | 'mp' | 'atk' | ... 的字面量联合，资料片加一个可加点属性就得改一次；
 * 现在服务端把白名单随面板定义下发，类型放宽为 string，运行时由 useStatSchema 校验。
 */
export type AllocatableAttribute = string;

/**
 * 分配属性点
 */
export const allocateAttributePoints = (points: Partial<Record<AllocatableAttribute, number>>) => {
  return apiClient.post('/attribute/allocate', { points });
};

/**
 * 重置属性点
 */
export const resetAttributePoints = () => {
  return apiClient.post('/attribute/reset');
};
