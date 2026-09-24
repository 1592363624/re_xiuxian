/**
 * 维护/断线遮罩守卫：部署期间后端 /api 返回 503(code=MAINTENANCE)、cutover 窗口直接
 * 连不上时，原地盖一层全屏遮罩（SPA 内自绘，不依赖服务端返回什么页面），
 * 并由遮罩自己轮询 /api/system/maintenance：
 *   - 503 → 维护文案；
 *   - 网络错误 → 断线文案；
 *   - 200 → 恢复。
 * 恢复策略（禁止无脑 reload，否则会「登录页 ↔ 连接中断」来回闪）：
 *   - 从 maintenance 恢复：整页刷新进新版本（cutover 真的换了静态资源）；
 *   - 从 disconnected 恢复：只收起遮罩，让 SPA 继续跑（服务端本来就是好的，
 *     断线多半是瞬时抖动/误报，reload 反而打断在途请求再触发一轮误报）。
 * 30 秒内最多 reload 一次，防止假失败死循环。
 * 禁止整页跳转 '/'：生产环境页面由 nginx 静态托管，跳转只会拿到 SPA 壳而不是维护页。
 */

/** 轮询间隔(毫秒)，与服务端维护页保持一致 */
const POLL_INTERVAL_MS = 5000;
/** 恢复探测接口：维护中被中间件拦成 503，结束后返回 200 */
const PROBE_URL = '/api/system/maintenance';
/** 断线遮罩的触发阈值：30 秒内连续 3 次网络失败才显示，避免瞬时抖动误伤 */
const NET_FAIL_THRESHOLD = 3;
const NET_FAIL_WINDOW_MS = 30000;
/** reload 节流键：cutover 刷新后短时间内不再刷 */
const RELOAD_STAMP_KEY = 'xiuxian_maint_reload_at';
const RELOAD_MIN_GAP_MS = 30_000;

/** 当前模式：null=未激活 | 'maintenance'=维护中 | 'disconnected'=连接中断 */
let mode = null;
/** 轮询定时器句柄（激活期间常驻，收起遮罩后销毁） */
let pollTimer = null;
/** 遮罩根元素 */
let overlayEl = null;
/** 标题/正文元素（模式切换时原地改文案） */
let titleEl = null;
let descEl = null;
/** 网络失败计数（阈值判定用） */
let netFailCount = 0;
let lastFailAt = 0;

/** 各模式的遮罩文案 */
const MODE_TEXT = {
  maintenance: {
    title: '系统维护中',
    desc: '服务器正在更新版本，维护期间暂时无法进入游戏。<br>页面将在维护结束后自动刷新，无需手动操作。',
  },
  disconnected: {
    title: '连接中断',
    desc: '与服务器失去连接，正在尝试重连…<br>恢复后将自动继续，无需刷新页面。',
  },
};

/** 创建遮罩 DOM（只创建一次；再次调用仅切换文案） */
function ensureOverlay() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.setAttribute('data-maintenance-overlay', '');
  overlayEl.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:radial-gradient(ellipse at 50% 0%, #1c1410 0%, #0c0a09 70%)',
    'color:#d6d3d1', 'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
    'text-align:center', 'padding:24px',
  ].join(';');
  overlayEl.innerHTML = `
    <div style="max-width:460px;padding:48px 36px;border-radius:16px;background:rgba(28,25,23,.92);border:1px solid rgba(245,158,11,.18);box-shadow:0 12px 40px rgba(0,0,0,.5);">
      <div style="width:64px;height:64px;margin:0 auto 24px;border-radius:50%;border:4px solid rgba(245,158,11,.2);border-top-color:#f59e0b;animation:maintenance-spin 1s linear infinite;"></div>
      <h1 style="font-size:22px;color:#fafaf9;margin-bottom:12px;letter-spacing:2px;"></h1>
      <p style="font-size:14px;line-height:1.8;color:#a8a29e;"></p>
    </div>`;
  const style = document.createElement('style');
  style.textContent = '@keyframes maintenance-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  titleEl = overlayEl.querySelector('h1');
  descEl = overlayEl.querySelector('p');
  document.body.appendChild(overlayEl);
}

/** 切换遮罩文案（模式变化时调用） */
function applyModeText() {
  if (!titleEl) return;
  const text = MODE_TEXT[mode] || MODE_TEXT.maintenance;
  titleEl.textContent = text.title;
  descEl.innerHTML = text.desc;
}

function hideOverlay() {
  if (overlayEl?.parentNode) {
    overlayEl.parentNode.removeChild(overlayEl);
  }
  overlayEl = null;
  titleEl = null;
  descEl = null;
}

/** 30 秒内是否已经整页刷新过（防止假失败 → reload → 再假失败） */
function reloadedRecently() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_STAMP_KEY) || 0);
    return last > 0 && Date.now() - last < RELOAD_MIN_GAP_MS;
  } catch {
    return false;
  }
}

function markReloaded() {
  try {
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch { /* 隐私模式忽略 */ }
}

/**
 * 探测服务器状态并决定下一步：
 * 200 → 恢复（维护态才整页刷新）；503 → 维护态；其余 → 断线态。
 */
async function probe() {
  try {
    const res = await fetch(PROBE_URL, { cache: 'no-store' });
    if (res.ok) {
      const wasMaintenance = mode === 'maintenance';
      stop();
      // 只有「维护 → 恢复」才需要进新版本；断线误报恢复时 reload 会打断 SPA
      // 并立刻把人扔回登录页/遮罩之间来回闪。
      if (wasMaintenance && !reloadedRecently()) {
        markReloaded();
        window.location.reload();
      }
      return;
    }
    setMode(res.status === 503 ? 'maintenance' : 'disconnected');
  } catch {
    setMode('disconnected');
  }
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  if (next) ensureOverlay();
  applyModeText();
}

function start() {
  if (pollTimer) return;
  pollTimer = setInterval(probe, POLL_INTERVAL_MS);
  probe();
}

function stop() {
  clearInterval(pollTimer);
  pollTimer = null;
  mode = null;
  netFailCount = 0;
  hideOverlay();
}

/**
 * 进入维护遮罩（503 MAINTENANCE 时由响应拦截器调用，立即显示）。
 * 幂等：重复调用不会叠加轮询或重建 DOM。
 */
export function showMaintenanceOverlay() {
  netFailCount = 0;
  ensureOverlay();
  setMode('maintenance');
  start();
}

/**
 * 报告一次网络层失败（无响应的 axios 错误，如 cutover 窗口的 ECONNREFUSED）。
 * 阈值内不动作；达到阈值后显示断线遮罩并开始轮询。
 * @returns {boolean} 是否已接管为遮罩态（true 时拦截器应抑制 toast）
 */
export function reportNetworkFailure() {
  const now = Date.now();
  netFailCount = now - lastFailAt < NET_FAIL_WINDOW_MS ? netFailCount + 1 : 1;
  lastFailAt = now;
  if (netFailCount < NET_FAIL_THRESHOLD) return false;
  // 已在维护遮罩态则不降级为断线文案（维护期网络抖动很常见）
  if (mode === 'maintenance') return true;
  ensureOverlay();
  setMode('disconnected');
  start();
  return true;
}

/** 当前是否已显示维护/断线遮罩（拦截器据此决定是否还要弹 toast） */
export function isMaintenanceOverlayActive() {
  return mode !== null;
}
