<#
.SYNOPSIS
    修仙游戏 - 服务器部署脚本（极简版 v2）
.DESCRIPTION
    核心流程: git pull -> 杀端口 -> npm install -> build -> pm2 restart -> 健康检查
    设计原则: KISS - 每步明确，失败即停，不搞过度防御
    相比 v1 (955 行) 的精简:
      - 去掉 mirror 逻辑（直接用原 remote，避免缓存旧数据导致 fetch 假成功）
      - 去掉 22 项兜底检查（过度防御反而增加失败点）
      - 去掉回滚逻辑（失败手动回滚更可靠）
      - 端口处理简化为无条件杀（不再区分 PM2/非 PM2 进程）
.NOTES
    前提: 服务器已装 git/Node.js/PM2，server/.env 已配置
    失败排查: 看 PM2 日志 pm2 logs xiuxian-server --lines 50
#>

# 强制 UTF-8 输出（仅控制台显示用，不影响脚本解析）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 关键：必须用 'Continue'，不能用 'Stop'
# 原因: git/npm 等 native command 把进度/警告写到 stderr（不是错误），
#        'Stop' 模式下 PowerShell 会把这些 stderr 当成 NativeCommandError 终止错误抛出，
#        导致 git fetch "Connection reset" 时脚本直接崩溃，无法重试或尝试镜像
# 失败传播改用显式 $LASTEXITCODE 检查（比 Stop 更可靠）
$ErrorActionPreference = 'Continue'

# ========== 配置 ==========
# 自动检测项目目录（scripts/deploy.ps1 的父目录的父目录，可移植不硬编码路径）
$scriptPath = $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent (Split-Path -Parent $scriptPath)
$branch = "main"
$serverPort = 5000
$pm2AppName = "xiuxian-server"
$healthCheckUrl = "http://localhost:5000/api/health"
# ==================

Set-Location $projectDir

Write-Host ""
Write-Host "=================================================="
Write-Host "  XiuXian Deploy Start (v2 minimal)"
Write-Host "  Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "  Dir: $projectDir"
Write-Host "=================================================="

# ========== 1. 拉取最新代码（带重试 + 镜像兜底） ==========
Write-Host ""
Write-Host "[1/6] Pulling latest code..."
# 禁止 git 弹出凭证提示（避免挂起，凭证失败应直接报错而非等待输入）
$env:GIT_TERMINAL_PROMPT = 0

# 记录 fetch 前的 origin/main commit（用于验证 fetch 是否真的拉到新数据）
# 为什么需要: 镜像可能返回缓存旧数据但 exit 0，导致"假成功"（v1 的根因之一）
$preFetchCommit = git rev-parse "origin/$branch" 2>$null
if (-not $preFetchCommit) { $preFetchCommit = "none" }
# 注意：${branch} 必须用 {} 包裹，否则 PowerShell 把 "$branch:" 当成 drive 引用报错
Write-Host "[INFO] Pre-fetch origin/${branch}: $($preFetchCommit.Substring(0,7))"

# GitHub 镜像列表（按优先级，第一个可用的就用）
# 为什么需要镜像: 中国服务器直连 GitHub 偶发连接重置（Recv failure: Connection was reset）
# 为什么把直连放第一: 直连无缓存问题，最可靠；只有直连失败才用镜像兜底
$mirrors = @(
    "https://github.com",
    "https://ghfast.top/https://github.com",
    "https://ghproxy.net/https://github.com",
    "https://mirror.ghproxy.com/https://github.com"
)

$originalRemote = git remote get-url origin
if (-not $originalRemote) {
    Write-Host "[FATAL] No git remote configured"
    exit 1
}
Write-Host "[INFO] Original remote: $originalRemote"

$fetchOk = $false
$usedMirror = $null

foreach ($mirror in $mirrors) {
    # 跳过 SSH remote（无法用镜像替换）
    if ($originalRemote -match "^git@|ssh://") {
        $mirrorUrl = $originalRemote
        $mirror = "ssh-direct"
    } else {
        $mirrorUrl = $originalRemote -replace "https://github\.com", $mirror
        if ($mirrorUrl -eq $originalRemote -and $mirror -ne "https://github.com") {
            continue
        }
    }

    Write-Host "[TRY] Fetching via: $mirror"
    # 每个源重试 2 次（网络偶发失败，重试通常能成功）
    for ($i = 1; $i -le 2; $i++) {
        try {
            if ($mirror -ne "https://github.com" -and $mirror -ne "ssh-direct") {
                git remote set-url origin $mirrorUrl 2>$null
            }
            # 关键：用 & git ... 2>&1 捕获输出，不能用 | Out-Host
            # 原因: | Out-Host 模式在 PowerShell 5.1 下会把 stderr 转成 ErrorRecord
            #        即使 ErrorActionPreference=Continue 也可能触发 NativeCommandError
            $fetchOutput = & git fetch --all --prune 2>&1
            $fetchOutput | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -eq 0) {
                $fetchOk = $true
                $usedMirror = $mirror
                break
            }
        } catch {
            # 捕获 NativeCommandError 等异常，不终止脚本，继续重试
            Write-Host "[WARN] Exception during fetch: $($_.Exception.Message)"
        } finally {
            # 始终恢复原 remote URL（避免污染 git config）
            if ($mirror -ne "https://github.com" -and $mirror -ne "ssh-direct") {
                git remote set-url origin $originalRemote 2>$null
            }
        }
        if ($i -lt 2) {
            Write-Host "[WARN] Fetch attempt $i failed, retrying in 5s..."
            Start-Sleep -Seconds 5
        }
    }
    if ($fetchOk) { break }
}

if (-not $fetchOk) {
    Write-Host "[FATAL] All fetch attempts failed (direct + mirrors)"
    Write-Host "[HINT] Configure SSH key: git remote set-url origin git@github.com:user/repo.git"
    exit 1
}

# 验证 fetch 是否真的拉到新数据（防止镜像缓存返回旧数据但 exit 0 的假成功）
$postFetchCommit = git rev-parse "origin/$branch" 2>$null
if (-not $postFetchCommit) {
    Write-Host "[FATAL] Cannot resolve origin/${branch} after fetch"
    exit 1
}
# 注意：${branch} 必须用 {} 包裹，否则 "$branch:" 被当成 drive 引用导致语法错误
Write-Host "[OK] Fetched via $usedMirror, origin/${branch}: $($postFetchCommit.Substring(0,7))"
if ($preFetchCommit -eq $postFetchCommit) {
    Write-Host "[INFO] origin/${branch} unchanged (no new commits, or mirror cache hit)"
    # 不 fail：可能确实没新提交。如果是镜像缓存，下一步 reset 后 HEAD 不变也无害
}

git reset --hard "origin/$branch"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FATAL] git reset failed (branch ${branch} may not exist)"
    exit 1
}
Write-Host "[OK] Code updated to $(git rev-parse --short HEAD)"

# ========== 2. 释放端口 + 清理旧 PM2 进程 ==========
Write-Host ""
Write-Host "[2/6] Releasing port $serverPort and cleaning PM2..."

# 无条件杀掉占用端口的进程（无论 PM2 管理的还是手动 node）
# 为什么无条件杀: v1 区分 PM2/非 PM2 进程导致逻辑分支过多，且 PM2 list 空时
#   手动 node 占端口会卡住。直接杀最简单可靠
$portConn = Get-NetTCPConnection -LocalPort $serverPort -State Listen -ErrorAction SilentlyContinue
if ($portConn) {
    $portPid = $portConn.OwningProcess
    try {
        Stop-Process -Id $portPid -Force -ErrorAction Stop
        Start-Sleep -Seconds 2
        Write-Host "[OK] Killed process PID=$portPid on port $serverPort"
    } catch {
        Write-Host "[FATAL] Cannot kill process PID=$portPid (permission denied?)"
        Write-Host "[HINT] Run: Stop-Process -Id $portPid -Force"
        exit 1
    }
} else {
    Write-Host "[OK] Port $serverPort is free"
}

# 删除 PM2 旧进程（如果存在，不存在也不报错）
pm2 delete $pm2AppName 2>$null
Write-Host "[OK] Old PM2 process cleaned"

# ========== 3. 安装依赖 ==========
Write-Host ""
Write-Host "[3/6] Installing dependencies..."

# npm 安装函数（带一次重试）
# 为什么需要重试: npm install 偶发网络失败，清理后重试通常能成功
# 为什么放松 ErrorActionPreference: npm/vite 会把 Browserslist 等警告输出到 stderr，
#   PowerShell 默认会把 stderr 当终止错误，导致脚本误中止
function Invoke-NpmInstall {
    param(
        [string]$WorkDir,
        [string]$Label
    )
    Set-Location $WorkDir
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # 第一次尝试
        npm install --no-audit 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] $Label dependencies installed"
            return $true
        }
        # 重试：清理后重装
        Write-Host "[WARN] $Label install failed, retrying after clean..."
        Remove-Item -Recurse -Force "node_modules" -ErrorAction SilentlyContinue
        Remove-Item -Force "package-lock.json" -ErrorAction SilentlyContinue
        npm install --no-audit 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] $Label dependencies installed (retry)"
            return $true
        }
        Write-Host "[FATAL] $Label dependencies install failed"
        return $false
    } finally {
        $ErrorActionPreference = $oldEAP
    }
}

$clientOk = Invoke-NpmInstall -WorkDir "$projectDir\client" -Label "Client"
if (-not $clientOk) { exit 1 }

$serverOk = Invoke-NpmInstall -WorkDir "$projectDir\server" -Label "Server"
if (-not $serverOk) { exit 1 }

# ========== 4. 构建前端 ==========
Write-Host ""
Write-Host "[4/6] Building client..."
Set-Location "$projectDir\client"

# 清理旧 dist（被锁就改名，避免删除失败阻塞部署）
if (Test-Path "dist") {
    try {
        Remove-Item -Recurse -Force "dist" -ErrorAction Stop
    } catch {
        $ts = Get-Date -Format 'yyyyMMddHHmmss'
        Rename-Item -Path "dist" -NewName "dist.old.$ts" -ErrorAction SilentlyContinue
        Write-Host "[WARN] dist locked, renamed to dist.old.$ts"
    }
}

# 放松错误偏好，避免 vite 的 stderr 警告导致中止
$oldEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    npm run build 2>&1 | Out-Host
} finally {
    $ErrorActionPreference = $oldEAP
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FATAL] Client build failed"
    exit 1
}
# 验证构建产物存在（index.html 缺失说明 build 部分失败）
if (-not (Test-Path "dist\index.html")) {
    Write-Host "[FATAL] Build output dist\index.html not found"
    exit 1
}
Write-Host "[OK] Client build complete"

# ========== 5. 启动 PM2 ==========
Write-Host ""
Write-Host "[5/6] Starting PM2..."
Set-Location "$projectDir\server"

pm2 start ecosystem.config.js --env production 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FATAL] PM2 start failed"
    pm2 logs $pm2AppName --lines 30 --nostream 2>&1 | Out-Host
    exit 1
}

# 验证进程真的 online（pm2 start 返回 0 不代表进程没崩溃）
# 场景: .env 缺失/代码错误导致 Node 启动后立即崩溃，但 pm2 start 退出码仍是 0
Start-Sleep -Seconds 3
$describe = pm2 describe $pm2AppName 2>&1 | Out-String
if ($describe -notmatch "status.*online") {
    Write-Host "[FATAL] PM2 process is NOT online"
    Write-Host $describe
    pm2 logs $pm2AppName --lines 30 --nostream 2>&1 | Out-Host
    exit 1
}
# 保存进程列表（服务器重启后自动恢复）
pm2 save 2>&1 | Out-Null
Write-Host "[OK] PM2 started (online)"

# ========== 6. 健康检查 ==========
Write-Host ""
Write-Host "[6/6] Health check..."
Start-Sleep -Seconds 10

try {
    $res = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
    if ($res.StatusCode -eq 200) {
        Write-Host ""
        Write-Host "=================================================="
        Write-Host "  Deploy SUCCESS"
        Write-Host "  Version: $(git rev-parse --short HEAD)"
        Write-Host "  Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        Write-Host "  URL: http://localhost:$serverPort"
        Write-Host "  Logs: pm2 logs $pm2AppName"
        Write-Host "=================================================="
    } else {
        Write-Host "[FATAL] Health check failed: HTTP $($res.StatusCode)"
        pm2 logs $pm2AppName --lines 30 --nostream 2>&1 | Out-Host
        exit 1
    }
} catch {
    Write-Host "[FATAL] Health check failed: $($_.Exception.Message)"
    Write-Host "[INFO] PM2 logs (last 30 lines):"
    pm2 logs $pm2AppName --lines 30 --nostream 2>&1 | Out-Host
    exit 1
}
