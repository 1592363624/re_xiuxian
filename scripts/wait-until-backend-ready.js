#!/usr/bin/env node
/**
 * 只等后端就绪，不启动任何服务（start.bat 在弹前端窗口前调用）。
 * 探测 /api/health，最长 90 秒；成功 exit 0，超时 exit 1。
 */
const http = require('http');

const PORT = process.env.SERVER_PORT || process.env.PORT || 5000;
const MAX_WAIT_MS = 90 * 1000;
const CHECK_INTERVAL_MS = 500;

function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

(async () => {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    if (await probe()) {
      console.log(`[启动] 后端已就绪 http://localhost:${PORT}/api/health`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
  }
  console.log(`[启动] 等待后端超时（${MAX_WAIT_MS / 1000}s）`);
  process.exit(1);
})();
