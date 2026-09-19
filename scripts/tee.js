const { spawn } = require('child_process');
const fs = require('fs');

const [logPath, ...cmd] = process.argv.slice(2);
if (!logPath || cmd.length === 0) {
  console.error('用法: node tee.js <日志文件> <命令> [参数...]');
  process.exit(2);
}

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;

const logDir = require('path').dirname(logPath);
if (logDir && logDir !== '.') fs.mkdirSync(logDir, { recursive: true });

fs.writeFileSync(logPath, `=== ${new Date().toString()} ===\n$ ${cmd.join(' ')}\n\n`);
const log = fs.createWriteStream(logPath, { flags: 'a' });

const child = spawn(cmd.join(' '), {
  cwd: process.cwd(),
  shell: true,
  env: process.env.NO_COLOR ? process.env : { ...process.env, FORCE_COLOR: '3' },
});

for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  if (!from) continue;
  from.on('data', (chunk) => {
    to.write(chunk);
    log.write(chunk.toString('utf8').replace(ANSI, ''));
  });
}

child.on('close', (code) => {
  log.write(`\n=== 进程退出 code=${code} ===\n`);
  log.end();
  process.exitCode = code ?? 0;
});
