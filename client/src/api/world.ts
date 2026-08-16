/**
 * 大世界地图相关 API（World Map MVP）
 * 依赖 WorldMovementService 提供服务器权威的世界坐标移动与同图在线玩家查询
 */
import apiClient from './index';

/**
 * 获取玩家大世界状态（无坐标时自动分配随机出生点）
 */
export const getWorldState = () => {
  return apiClient.get('/world/state');
};

/**
 * 世界移动（点击地图目标点，服务器权威校验后更新坐标）
 * @param x 目标X坐标
 * @param y 目标Y坐标
 */
export const moveWorld = (x: number, y: number) => {
  return apiClient.post('/world/move', { x, y });
};

/**
 * 获取当前地图的在线玩家列表（大世界同图可见）
 */
export const getWorldPlayers = () => {
  return apiClient.get('/world/players');
};