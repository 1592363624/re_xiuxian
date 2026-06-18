/**
 * 玩家相关 API
 */
import apiClient from './index';

export interface PlayerData {
  id: number;
  username: string;
  nickname: string;
  realm: string;
  exp: number;
  spirit_stones: number;
  hp_current: number;
  hp_max: number;
  mp_current: number;
  mp_max: number;
  lifespan_current: number;
  lifespan_max: number;
  attributes: Record<string, number>;
  avatar_url?: string;
  role?: string;
}

export interface PlayerResponse {
  code: number;
  data: PlayerData;
  message?: string;
}

/**
 * 获取玩家信息
 */
export const getPlayer = () => {
  return apiClient.get<PlayerResponse>('/player/me');
};

/**
 * 更新玩家信息
 */
export const updatePlayer = (data: Partial<PlayerData>) => {
  return apiClient.put<PlayerResponse>('/player/me', data);
};

/**
 * 获取玩家境界信息
 */
export const getPlayerRealm = () => {
  return apiClient.get('/player/realm');
};

/**
 * 检查用户名是否可用
 */
export const checkUsername = (username: string) => {
  return apiClient.get('/auth/check-unique', {
    params: { type: 'username', value: username }
  });
};

/**
 * 检查昵称是否可用
 */
export const checkNickname = (nickname: string) => {
  return apiClient.get('/auth/check-unique', {
    params: { type: 'nickname', value: nickname }
  });
};
