/**
 * 统一 API 请求层
 * 封装 axios 实例，提供统一的请求拦截、响应处理和错误处理
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { usePlayerStore } from '../stores/player';
import { useUIStore } from '../stores/ui';
import { showMaintenanceOverlay, reportNetworkFailure, isMaintenanceOverlayActive } from '../utils/maintenanceGuard';

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

    // 请求路径：排障时最关键的定位信息（如 /admin/ai-config/3/test）
    const requestUrl = (error.config as any)?.url || '';

    if (error.response) {
      const { status, data } = error.response;
      // 后端统一错误体是 { code, message }，能拿到具体原因就用具体原因，不再吞掉
      const serverMessage = (data as any)?.message;

      if (status === 401) {
        const playerStore = usePlayerStore();
        playerStore.logout();
        notify('登录已过期，请重新登录');
      } else if (status === 503 && (data as any)?.code === 'MAINTENANCE') {
        // 部署维护中：原地盖维护遮罩并轮询恢复，绝不整页跳转、也不刷 toast
        // （组件 catch 会走 showApiError，认 __uiNotified 不再叠一条）
        showMaintenanceOverlay();
        (error as any).__uiNotified = true;
      } else if (isMaintenanceOverlayActive()) {
        // 维护/断线遮罩已接管：吞掉后续错误播报，避免遮罩底下刷红字
        (error as any).__uiNotified = true;
      } else if (status === 403) {
        notify(serverMessage || '没有权限执行此操作');
      } else if (status === 404) {
        notify(`请求的资源不存在：${requestUrl}`);
      } else if (status === 500) {
        notify(serverMessage ? `服务器错误：${serverMessage}` : `服务器错误，请稍后重试：${requestUrl}`);
      }
      // 400 等业务错误不在此处弹 toast，由调用方组件处理
    } else if (error.request) {
      // 请求已发出但没拿到响应：细分原因，避免"网络错误，请检查网络连接"这种无法定位的提示
      const timeoutSeconds = error.config?.timeout ? Math.round(error.config.timeout / 1000) : 0;
      const code = (error as any).code || '';
      const isTimeout = code === 'ECONNABORTED' || /timeout/i.test(error.message || '');

      if (isMaintenanceOverlayActive()) {
        (error as any).__uiNotified = true;
      } else if (isTimeout) {
        // 前端主动超时：后端可能仍在处理（例如代理第三方 AI 接口），所以提示等待上限而非断言"断网"，
        // 也不计入断线遮罩阈值（慢 ≠ 掉线）
        notify(`请求超时${timeoutSeconds ? `（${timeoutSeconds} 秒）` : ''}：${requestUrl}`);
      } else if (code === 'ERR_CANCELED') {
        notify(`请求已取消：${requestUrl}`);
      } else if (code === 'ERR_NETWORK' || !code) {
        // cutover 窗口 ECONNREFUSED / 真断网：连续达阈值后显示断线遮罩并轮询
        const overlayTookOver = reportNetworkFailure();
        if (overlayTookOver) {
          (error as any).__uiNotified = true;
        } else {
          notify(`网络不可达：${requestUrl}（请确认后端服务已启动且地址可访问）`);
        }
      } else {
        const overlayTookOver = reportNetworkFailure();
        if (overlayTookOver) {
          (error as any).__uiNotified = true;
        } else {
          notify(`网络请求失败：${requestUrl}${error.message ? `（${error.message}）` : ''}`);
        }
      }
    } else {
      uiStore.showToast('请求配置错误', 'error');
      (error as any).__uiNotified = true;
    }

    return Promise.reject(error);
  }
);

export default apiClient;
