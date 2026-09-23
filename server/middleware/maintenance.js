/**
 * 维护模式中间件（部署期间向玩家展示维护页面，防止切版本时数据异常）
 *
 * 工作方式：
 * - 部署脚本在开始部署时于 server/ 运行目录写入 maintenance.flag，健康检查通过后删除；
 * - 本中间件在每个请求进入路由之前检测该文件（带 2 秒缓存）；
 * - 维护激活时：
 *     - /api/health            → 直接放行（deploy.ps1 健康检查依赖此端点）
 *     - 其余 /api/*、/socket.io → 503 JSON(code=MAINTENANCE)
 *     - 其余请求（页面/静态资源） → 返回内嵌维护 HTML（自动轮询恢复）
 * - flag 文件不存在时零开销直通（仅 2 秒一次的 statSync）。
 *
 * 恢复探测：前端遮罩与维护页轮询 GET /api/system/maintenance
 * （维护中被本中间件拦成 503；维护结束由 routes/system.js 返回 200）。
 *
 * 注意：WebSocket 升级请求不一定经过 Express 中中间件栈，维护期间已建立的
 * WS 连接可能仍存活，但所有 HTTP 指令接口已 503，游戏交互实际不可用。
 */

const fs = require('fs');
const path = require('path');

/**
 * 维护开关文件路径（PM2 cwd = server/ 目录）
 * 解析放在函数内：支持环境变量改路径，也方便单测指向临时 flag。
 */
function getFlagPath() {
    return process.env.MAINTENANCE_FLAG_PATH || path.join(process.cwd(), 'maintenance.flag');
}

/** flag 存在性检测结果缓存时长（毫秒），避免每个请求都 statSync */
const FLAG_CHECK_TTL_MS = 2000;

let flagCache = { checkedAt: 0, active: false };

/** 检测维护开关是否激活（带 TTL 缓存）。flag 内容为维护开始时间 ISO 字符串 */
function isMaintenanceActive() {
    const now = Date.now();
    if (now - flagCache.checkedAt < FLAG_CHECK_TTL_MS) {
        return flagCache.active;
    }
    let active = false;
    try {
        fs.statSync(getFlagPath());
        active = true;
    } catch {
        active = false;
    }
    flagCache = { checkedAt: now, active };
    return active;
}

/** 读取维护开始时间（flag 文件内容），读取失败返回空字符串 */
function readMaintenanceSince() {
    try {
        return fs.readFileSync(getFlagPath(), 'utf8').trim();
    } catch {
        return '';
    }
}

/** 统一的维护态 API 响应（机器可读，前端遮罩据此识别） */
function sendMaintenanceJson(res) {
    res.status(503);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        code: 'MAINTENANCE',
        error_code: 'MAINTENANCE',
        success: false,
        message: '服务器正在维护更新，请稍后再试（Server is under maintenance）',
    });
}

/**
 * 内嵌维护页面（自包含 HTML，不依赖 client/dist —— 目录切换期间静态目录不可靠）
 * 页面每 5 秒轮询 /api/system/maintenance，一旦返回 200（维护结束）立即整页刷新。
 * 视觉与 client/public/maintenance.html、client/src/utils/maintenanceGuard.js 保持一致。
 */
function renderMaintenancePage(since) {
    const sinceText = since ? `维护开始于 ${since}` : '服务器正在更新版本';
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>修仙 · 系统维护中</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at 50% 0%, #1c1410 0%, #0c0a09 70%);
    color: #d6d3d1; font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    text-align: center; padding: 24px;
  }
  .card {
    max-width: 460px; padding: 48px 36px; border-radius: 16px;
    background: rgba(28, 25, 23, .92); border: 1px solid rgba(245, 158, 11, .18);
    box-shadow: 0 12px 40px rgba(0,0,0,.5);
  }
  .orb {
    width: 64px; height: 64px; margin: 0 auto 24px; border-radius: 50%;
    border: 4px solid rgba(245, 158, 11, .2); border-top-color: #f59e0b;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 22px; color: #fafaf9; margin-bottom: 12px; letter-spacing: 2px; }
  p  { font-size: 14px; line-height: 1.8; color: #a8a29e; }
  .since { margin-top: 16px; font-size: 12px; color: #78716c; }
  .hint  { margin-top: 6px; font-size: 12px; color: #78716c; }
</style>
</head>
<body>
  <div class="card">
    <div class="orb"></div>
    <h1>系统维护中</h1>
    <p>服务器正在更新版本，维护期间暂时无法进入游戏。<br>页面将在维护结束后自动刷新，无需手动操作。</p>
    <p class="since">${sinceText}</p>
    <p class="hint">感谢道友耐心等候</p>
  </div>
<script>
(function poll() {
  fetch('/api/system/maintenance', { cache: 'no-store' })
    .then(function (r) { if (r.ok) location.reload(); })
    .catch(function () {});
  setTimeout(poll, 5000);
})();
</script>
</body>
</html>`;
}

/**
 * Express 中间件本体。必须注册在路由 / 静态资源之前（index.js 创建 app 后立刻挂载）。
 */
function maintenanceMiddleware(req, res, next) {
    if (!isMaintenanceActive()) {
        next();
        return;
    }

    const rawPath = req.path || req.originalUrl || '/';
    const pathname = rawPath.split('?')[0];

    // 部署健康检查放行：deploy.ps1 的 /api/health 依赖此端点在维护期仍返回 200
    if (pathname === '/api/health' || pathname === '/api/health/') {
        next();
        return;
    }

    if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/socket.io')) {
        sendMaintenanceJson(res);
        return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderMaintenancePage(readMaintenanceSince()));
}

module.exports = {
    maintenanceMiddleware,
    isMaintenanceActive,
    getFlagPath,
};
