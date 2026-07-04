# scripts 目录 - 部署与运维脚本

## 文件说明

| 文件 | 用途 | 执行位置 | 触发方式 |
|------|------|---------|---------|
| `deploy.ps1` | 服务器端部署脚本（git pull + build + pm2 reload + 健康检查） | Windows 服务器 | GitHub Actions SSH 触发 / 手动执行 |
| `deploy.bat` | 手动部署触发器（调用 deploy.ps1） | Windows 服务器 | 双击运行 |

## 部署流程

### 自动部署（推荐）

```
本地 git push origin main
  → GitHub Actions 触发
  → SSH 到服务器执行 deploy.ps1
  → git pull + npm install + build + pm2 reload + 健康检查
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
