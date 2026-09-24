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
 * 后端在一次请求内结算「玩家出招 + 怪物回击」完整回合
 */
export const attack = (action: 'attack' | 'skill' = 'attack') => {
  return apiClient.post('/combat/attack', { action });
};

/**
 * 使用技能
 */
export const useSkill = (skillIndex: number) => {
  return apiClient.post('/combat/skill', { skillIndex });
};

/**
 * 怪物行动（残留怪物回合的恢复口）
 *
 * 主流程已由 attack/useSkill 内联结算怪物回击；此接口用于：
 *   1) 历史卡死战斗（is_player_turn=false）恢复；
 *   2) 旧两段式调用兼容。
 */
export const monsterTurn = () => {
  return apiClient.post('/combat/monster-turn');
};

/**
 * 逃跑
 * 注意：后端路由为 /combat/flee（非 escape），此处保留 escape 函数名以保持调用方代码不变
 */
export const escape = () => {
  return apiClient.post('/combat/flee');
};

/**
 * 放弃战斗（强制脱离卡死的战斗，无惩罚，不计入历史）
 * 使用场景：遗留的过期战斗无法通过 flee 清除时，用此接口直接放弃
 */
export const abandon = () => {
  return apiClient.post('/combat/abandon');
};

/**
 * 战斗中使用物品
 */
export const useBattleItem = (itemId: string, quantity = 1) => {
  return apiClient.post('/combat/use-item', { itemId, quantity });
};
