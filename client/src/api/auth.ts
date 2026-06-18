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

export interface AuthResponse {
  code: number;
  data: {
    token: string;
    player: any;
  };
  message?: string;
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
