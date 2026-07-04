/**
 * PM2 进程管理配置
 *
 * 用途：守护 Node 后端进程，崩溃自动重启、零停机 reload、日志管理
 * 启动：pm2 startOrReload ecosystem.config.js --env production
 * 管理：pm2 status | pm2 logs xiuxian-server | pm2 restart xiuxian-server
 * 持久化：pm2 save（保存进程列表，服务器重启后自动恢复）
 *
 * 环境变量优先级（高 -> 低）：
 *   1. server/.env 文件（本地开发/手动部署时使用）
 *   2. env_production（PM2 启动时注入，生产部署用，敏感信息由 .env 提供）
 *
 * 注意：此配置不硬编码任何敏感信息（数据库密码、JWT_SECRET）
 *       敏感信息统一由 server/.env 文件提供，PM2 启动时会自动加载 .env
 */

// 确保日志目录存在，避免 PM2 启动时因找不到目录而失败
const path = require('path');
const fs = require('fs');
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    try {
        fs.mkdirSync(logsDir, { recursive: true });
    } catch (e) {
        // 目录创建失败时仅打印警告，不阻止 PM2 启动
        // PM2 会在当前目录下创建日志文件作为降级方案
        console.warn('[ecosystem.config.js] Warning: Cannot create logs directory:', e.message);
    }
}

module.exports = {
  apps: [{
    name: 'xiuxian-server',           // 进程名称（pm2 logs/status 用）
    script: './index.js',             // 入口文件
    cwd: __dirname,                   // 工作目录（确保相对路径正确）
    instances: 1,                    // 单实例（游戏服务有状态，不能多实例）
    exec_mode: 'fork',                // fork 模式（不 cluster，避免 socket.io 状态丢失）
    autorestart: true,                // 崩溃自动重启
    watch: false,                     // 不监听文件变化（生产环境不热更新）
    max_memory_restart: '1G',         // 内存超过 1G 自动重启（防内存泄漏）
    max_restarts: 10,                 // 最大重启次数（1分钟内超过则停止）
    min_uptime: '10s',                // 进程至少运行 10s 才算启动成功
    error_file: './logs/error.log',   // 错误日志路径
    out_file: './logs/out.log',       // 输出日志路径
    merge_logs: true,                 // 合并日志（不按日期分文件）
    log_date_format: 'YYYY-MM-DD HH:mm:ss', // 日志时间戳格式
    env: {
      // 开发环境（pm2 start ecosystem.config.js）
      NODE_ENV: 'development',
      PORT: 5000
    },
    env_production: {
      // 生产环境（pm2 startOrReload ecosystem.config.js --env production）
      NODE_ENV: 'production',
      PORT: 5000,
      SERVE_STATIC: 'false'  // 生产环境用 nginx 托管前端，Node 只管 API
      // 数据库、JWT_SECRET 等敏感信息由 server/.env 提供，不在此配置
    }
  }]
};
