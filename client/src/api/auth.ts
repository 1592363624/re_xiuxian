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

/**
 * ===== QQ 登录与账号绑定 =====
 *
 * 游戏账号仍以注册流程产生的记录为主体，QQ 只是挂在账号上的第二种登录凭证。
 */

export interface QQBinding {
  nickname: string | null;
  avatarUrl: string | null;
  boundAt: string;
  lastLoginAt: string | null;
}

/** QQ 登录是否已在服务端配置启用 */
export const getQQStatus = () => {
  return apiClient.get<{ code: number; enabled: boolean }>('/auth/qq/config');
};

/** 取 QQ 授权页地址，调用方整页跳转过去；intent=bind 需携带登录态 */
export const getQQAuthorizeUrl = (intent: 'login' | 'bind') => {
  return apiClient.get<{ code: number; url: string }>('/auth/qq/authorize-url', { params: { intent } });
};

/** 用回调带回的一次性票据换正式登录态 */
export const exchangeQQTicket = (ticket: string) => {
  return apiClient.post<{ code: number; message: string; token: string }>('/auth/qq/exchange', { ticket });
};

/** 查询待绑定 QQ 的资料，用于登录页提示"即将绑定到哪个 QQ" */
export const getQQPending = (ticket: string) => {
  return apiClient.get<{ code: number; profile: { nickname: string | null; avatarUrl: string | null } }>(
    '/auth/qq/pending',
    { params: { ticket } }
  );
};

/** 登录成功后，把待绑定的 QQ 挂到当前账号 */
export const bindQQPending = (pendingTicket: string) => {
  return apiClient.post<{ code: number; message: string; binding: QQBinding }>('/auth/qq/bind', { pendingTicket });
};

/** 当前账号的 QQ 绑定状态 */
export const getQQBinding = () => {
  return apiClient.get<{ code: number; enabled: boolean; binding: QQBinding | null }>('/auth/qq/binding');
};

/** 解除 QQ 绑定，解绑后该 QQ 不能再登录本账号 */
export const unbindQQ = () => {
  return apiClient.delete<{ code: number; message: string }>('/auth/qq/binding');
};
