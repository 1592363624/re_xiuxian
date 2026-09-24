/**
 * 统一 API 请求层
 * 封装 axios 实例，提供统一的请求拦截、响应处理和错误处理
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { usePlayerStore } from '../stores/player';
import { useUIStore } from '../stores/ui';
import { showMaintenanceOverlay, reportNetworkFailure, isMaintenanceOverlayActive } from '../utils/maintenanceGuard';
import { extractRequestKey, signRequestHeaders, needsRequestSign } from '../utils/requestSign';

// 创建 axios 实例
const apiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// 请求拦截器
// 写操作附带 X-Request-Timestamp / Nonce / Signature（防重放 + 防改包），
// 算法与 server/utils/requestSign.js 对齐；rk 从 JWT 载荷取出。
apiClient.interceptors.request.use(
  async (config: AxiosRequestConfig) => {
    const playerStore = usePlayerStore();
    const token = playerStore.token;
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    const method = (config.method || 'get').toUpperCase();
    // 与服务端 req.originalUrl 对齐：含 /api 前缀与 query
    const joinUrl = (base: string, path: string) => {
      const b = (base || '').replace(/\/+$/, '');
      const p = path.startsWith('/') ? path : `/${path}`;
      return `${b}${p}` || p;
    };
    let originalUrl = joinUrl(config.baseURL || '/api', config.url || '');
    if (!originalUrl.startsWith('/')) originalUrl = `/${originalUrl}`;
    if (!originalUrl.startsWith('/api')) originalUrl = `/api${originalUrl.startsWith('/') ? '' : '/'}${originalUrl.replace(/^\/+/, '')}`;
    // 仅拼简单 query（写接口几乎不用 params；GET 不签名）
    if (config.params && typeof config.params === 'object') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(config.params as Record<string, unknown>)) {
        if (v !== undefined && v !== null) qs.append(k, String(v));
      }
      const q = qs.toString();
      if (q) originalUrl += (originalUrl.includes('?') ? '&' : '?') + q;
    }
    const fullUrl = originalUrl;

    if (needsRequestSign(method) && !String(fullUrl).startsWith('/api/auth')) {
      // 统一序列化 body，保证 HMAC 与线上字节一致（axios 默认 JSON.stringify 同源）
      let rawBody = '';
      if (config.data !== undefined && config.data !== null && config.data !== '') {
        rawBody = typeof config.data === 'string' ? config.data : JSON.stringify(config.data);
        config.data = rawBody;
        if (config.headers) {
          config.headers['Content-Type'] = config.headers['Content-Type'] || 'application/json';
        }
      }

      const rk = extractRequestKey(token);
      if (!rk) {
        // 旧会话令牌没有 rk：强制重新登录，不能静默不签名（服务端 enforce 会拒）
        const err: any = new Error('会话缺少请求签名密钥，请重新登录');
        err.__uiNotified = true;
        err.config = config;
        return Promise.reject(err);
      }

      const signHeaders = await signRequestHeaders(rk, {
        method,
        url: fullUrl,
        rawBody
      });
      if (config.headers) {
        Object.assign(config.headers, signHeaders);
      }
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
        const guardCode = (data as any)?.error_code;
        // 登录接口本身失败不要再说「请重新登录」——用户正在登录
        const isLoginApi = /\/auth\/(login|register|qq)/.test(requestUrl || '');
        notify(
          isLoginApi
            ? (serverMessage || '登录失败，请重试')
            : guardCode === 'REQUEST_KEY_MISSING' || guardCode === 'REQUEST_SIGN_MISSING' || guardCode === 'REQUEST_SIGN_INVALID'
              ? '安全校验未通过，请重新登录'
              : '登录已过期，请重新登录'
        );
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
