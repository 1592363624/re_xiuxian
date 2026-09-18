# scripts 目录 - 部署与运维脚本

## 文件说明

| 文件 | 用途 | 执行位置 | 触发方式 |
|------|------|---------|---------|
| `deploy-bootstrap.ps1` | CI 引导脚本：修复 SSH 会话 PATH/编码 → 更新代码 → 调用 deploy.ps1 | Windows 服务器 | 仅 GitHub Actions（base64 后通过 `powershell -EncodedCommand` 执行） |
| `deploy.ps1` | 服务器端部署脚本（git pull + build + pm2 restart + 健康检查） | Windows 服务器 | 由 deploy-bootstrap.ps1 调用 / 手动执行 |
| `deploy.bat` | 手动部署触发器（调用 deploy.ps1） | Windows 服务器 | 双击运行 |

## 常见故障

### `[FAIL] git not on PATH`（或 deploy.ps1 报 `Tool(s) not found on PATH`）

Windows 的 sshd 服务在**启动时**快照了一份环境变量，之后安装/升级的 Git、Node 不会出现在
SSH 会话的 PATH 里（本地双击打开的终端却是好的）。deploy-bootstrap.ps1 会主动把常见安装目录
补回 PATH，但要彻底解决，需要在服务器上把 Git/Node 加入**系统** PATH 后重启服务：

```powershell
Restart-Service sshd
```

### Actions 日志里出现乱码

乱码有两个来源，都已修掉：PowerShell 按 OEM 代码页（简体中文为 936）输出、git 的 UTF-8 输出被
错误解码。两个脚本开头统一设置 `[Console]::OutputEncoding = UTF8` 并把 CurrentUICulture 设为
`en-US`，因此远程输出全部为 UTF-8 英文。若在服务器手动执行仍看到乱码，先执行 `chcp 65001`。

## 部署流程

### 自动部署（推荐）

```
本地 git push origin main
  → GitHub Actions 触发
  → SSH 到服务器执行 deploy-bootstrap.ps1（修复 PATH/编码 + 更新代码）
  → deploy-bootstrap.ps1 调用 deploy.ps1
  → git pull + npm install + build + pm2 restart + 健康检查
  → 完成
```

### 手动部署

在服务器上双击 `deploy.bat`，或执行：
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\re_xiuxian\scripts\deploy.ps1"
```

## 首次部署准备

1. **安装依赖软件**
   - Git
   - Node.js 18+
   - PM2：`npm install -g pm2`

2. **Clone 仓库**
   ```bash
   git clone <repo-url> C:\Projects\re_xiuxian
   cd C:\Projects\re_xiuxian
   ```

3. **配置 server/.env**
   复制 `server/.env.example` 为 `server/.env`，填写：
   - 数据库连接（DB_HOST/DB_USER/DB_PASS/DB_NAME）
   - JWT_SECRET
   - SERVE_STATIC=false（用 nginx 托管前端）

4. **首次构建**
   ```powershell
   cd C:\Projects\re_xiuxian\scripts
   .\deploy.ps1
   ```

5. **配置 nginx**
   参考 README 中的 nginx 配置示例

## 回滚

```powershell
cd C:\Projects\re_xiuxian
git reset --hard HEAD~1  # 回退到上一个版本
cd server
pm2 restart xiuxian-server
```

## 常用 PM2 命令

```bash
pm2 status                    # 查看进程状态
pm2 logs xiuxian-server       # 实时查看日志
pm2 logs xiuxian-server --lines 100  # 查看最近 100 行日志
pm2 restart xiuxian-server    # 重启服务
pm2 reload xiuxian-server      # 零停机重启
pm2 stop xiuxian-server        # 停止服务
pm2 delete xiuxian-server      # 删除进程
pm2 save                      # 保存进程列表（开机自启）
pm2 startup                   # 配置开机自启
```
