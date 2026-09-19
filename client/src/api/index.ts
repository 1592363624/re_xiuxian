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
//
// 分工：传输层/协议层的错误（登录失效、无权限、404、500、断网）在这里统一播报，
// 因为组件再怎么补充也只能给出"获取X失败"这种更没信息量的话；
// 400 这类带具体原因的业务错误留给调用方，只有它知道自己在干什么。
//
// 关键：弹过 toast 的错误要打 __uiNotified 标记。
// 之前没有这个标记，组件的 catch 无从得知提示已经出现过，于是每个 500 都会
// 再叠一条自己的"××失败"——玩家同时看到两条互相矛盾的红字。
// 组件侧统一走 uiStore.showApiError()，它会认这个标记并且不再重复播报。
apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    return response;
  },
  (error: AxiosError) => {
    const uiStore = useUIStore();

    const notify = (message: string) => {
      uiStore.showToast(message, 'error');
      (error as any).__uiNotified = true;
    };

    if (error.response) {
      const { status, data } = error.response;

      if (status === 401) {
        const playerStore = usePlayerStore();
        playerStore.logout();
        notify('登录已过期，请重新登录');
      } else if (status === 403) {
        notify('没有权限执行此操作');
      } else if (status === 404) {
        notify('请求的资源不存在');
      } else if (status === 500) {
        notify('服务器错误，请稍后重试');
      }
      // 400 等业务错误不在此处弹 toast，由调用方组件处理
    } else if (error.request) {
      notify('网络错误，请检查网络连接');
    } else {
      uiStore.showToast('请求配置错误', 'error');
      (error as any).__uiNotified = true;
    }

    return Promise.reject(error);
  }
);

export default apiClient;
