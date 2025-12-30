#!/usr/bin/env node
/**
 * 启动脚本
 * 等待后端服务就绪后再启动前端，避免启动时的连接错误
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const BACKEND_PORT = 3000;
const FRONTEND_PORT = 5173;
const MAX_WAIT_TIME = 60 * 1000; // 最长等待60秒
const CHECK_INTERVAL = 1000; // 每秒检查一次

/**
 * 检查后端服务是否就绪
 */
function checkBackendReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${BACKEND_PORT}/api/status`, (res) => {
      resolve(true);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 等待后端服务就绪
 */
async function waitForBackend() {
  console.log('[启动脚本] 正在等待后端服务就绪...');
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_TIME) {
    if (await checkBackendReady()) {
      console.log('[启动脚本] 后端服务已就绪 ✓');
      return true;
    }
    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }

  console.warn('[启动脚本] 等待后端超时，前端可能无法正常加载');
  return false;
}

/**
 * 启动子进程
 * 注意：此函数仅用于内部调用，command 和 args 必须为硬编码常量，禁止使用用户可控输入
 */
function spawnProcess(command, args, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });

    child.on(name === 'server' ? 'message' : 'close', (code) => {
      if (name === 'client' && code !== 0) {
        console.error(`[${name}] 进程异常退出，退出码: ${code}`);
      }
    });

    resolve(child);
  });
}

/**
 * 主函数
 */
async function main() {
  console.log('=================================');
  console.log('  凡人修仙传 - 开发环境启动器');
  console.log('=================================\n');

  // 先启动后端
  console.log('[启动脚本] 正在启动后端服务...');
  const backendProcess = await spawnProcess('npm', ['run', 'server'], 'server');

  // 等待后端就绪
  await waitForBackend();

  // 再启动前端
  console.log('[启动脚本] 正在启动前端服务...');
  const frontendProcess = await spawnProcess('npm', ['run', 'client'], 'client');

  console.log('\n=================================');
  console.log('  服务启动完成！');
  console.log('  前端: http://localhost:' + FRONTEND_PORT);
  console.log('  后端: http://localhost:' + BACKEND_PORT);
  console.log('=================================\n');

  // 优雅退出
  const cleanup = () => {
    console.log('\n[启动脚本] 正在关闭服务...');
    backendProcess.kill();
    frontendProcess.kill();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(console.error);
