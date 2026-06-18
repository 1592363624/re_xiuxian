/**
 * 战斗相关 API
 */
import apiClient from './index';

/**
 * 获取战斗状态
 */
export const getCombatStatus = (battleId?: string) => {
  return apiClient.get('/combat/status', { params: { battle_id: battleId } });
};

/**
 * 获取可遭遇的怪物列表
 */
export const getMonsters = () => {
  return apiClient.get('/combat/monsters');
};

/**
 * 获取战斗统计
 */
export const getCombatStats = () => {
  return apiClient.get('/combat/stats');
};

/**
 * 遭遇怪物
 */
export const encounter = (monsterId: number) => {
  return apiClient.post('/combat/encounter', { monsterId });
};

/**
 * 普通攻击
 */
export const attack = () => {
  return apiClient.post('/combat/attack');
};

/**
 * 使用技能
 */
export const useSkill = (skillIndex: number) => {
  return apiClient.post('/combat/skill', { skillIndex });
};

/**
 * 逃跑
 */
export const escape = () => {
  return apiClient.post('/combat/escape');
};
