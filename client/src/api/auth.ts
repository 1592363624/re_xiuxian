/**
 * 认证相关 API
 */
import apiClient from './index';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
  nickname: string;
}

/**
 * 认证响应结构
 *
 * 修复（2026-07-21）：
 *   历史类型定义为 `data: { token, player }` 嵌套结构，
 *   但后端实际返回 token/player 在响应体顶层（与 code/message 平级）。
 *   详见 server/routes/auth.js:220-230 的 res.json 输出。
 *
 * axios 调用方拿到的完整结构为：
 *   res.data = { code, message, token, player }
 * 因此本类型用于描述 res.data（即后端响应 body），token/player 应在顶层。
 */
export interface AuthResponse {
  code: number;
  message?: string;
  token: string;
  player: {
    id: number;
    nickname: string;
    realm: string;
    role: string;
  };
}

/**
 * 登录
 */
export const login = (data: LoginRequest) => {
  return apiClient.post<AuthResponse>('/auth/login', data);
};

/**
 * 注册
 */
export const register = (data: RegisterRequest) => {
  return apiClient.post<AuthResponse>('/auth/register', data);
};

/**
 * 登出
 */
export const logout = () => {
  return apiClient.post('/auth/logout');
};

/**
 * 检查账号/道号唯一性
 * @param type - 'username' | 'nickname'
 * @param value - 待校验的值
 */
export const checkUnique = (type: 'username' | 'nickname', value: string) => {
  return apiClient.get('/auth/check-unique', {
    params: { type, value }
  });
};
