/**
 * 统一 API 请求层
 * 封装 axios 实例，提供统一的请求拦截、响应处理和错误处理
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { usePlayerStore } from '../stores/player';
import { useUIStore } from '../stores/ui';

// 创建 axios 实例
const apiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// 请求拦截器
apiClient.interceptors.request.use(
  (config: AxiosRequestConfig) => {
    const playerStore = usePlayerStore();
    if (playerStore.token && config.headers) {
      config.headers.Authorization = `Bearer ${playerStore.token}`;
    }
    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    return response;
  },
  (error: AxiosError) => {
    const uiStore = useUIStore();
    
    if (error.response) {
      const { status, data } = error.response;
      
      // 统一错误处理
      if (status === 401) {
        const playerStore = usePlayerStore();
        playerStore.logout();
        uiStore.showToast('登录已过期，请重新登录', 'error');
      } else if (status === 403) {
        uiStore.showToast('没有权限执行此操作', 'error');
      } else if (status === 404) {
        uiStore.showToast('请求的资源不存在', 'error');
      } else if (status === 500) {
        uiStore.showToast('服务器错误，请稍后重试', 'error');
      } else {
        const message = (data as any)?.message || '请求失败';
        uiStore.showToast(message, 'error');
      }
    } else if (error.request) {
      uiStore.showToast('网络错误，请检查网络连接', 'error');
    } else {
      uiStore.showToast('请求配置错误', 'error');
    }
    
    return Promise.reject(error);
  }
);

export default apiClient;
