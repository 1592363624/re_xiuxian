<#
.SYNOPSIS
    重生之凡人修仙传 - 服务器端部署脚本（加固版）
.DESCRIPTION
    核心流程：git pull(带镜像加速) -> 前端 build -> 后端 npm install -> PM2 重启 -> 健康检查
    兼容场景：
      1. PM2 进程不存在/运行中/已停止/卡死 - 全部能正确重启
      2. 手动 node index.js 占用 5000 端口 - 自动检测并处理
      3. 国内 GitHub 拉取超时 - 自动切换镜像加速
      4. npm install 超时 - 配置 npmmirror 镜像加速
      5. 部署失败 - 自动回滚到上一个版本
      6. 健康检查失败 - 输出 PM2 日志便于排查
.NOTES
    首次部署前需：
    1. 服务器已安装 git、Node.js、PM2 (npm install -g pm2)
    2. 仓库已 clone 到 PROJECT_DIR 目录
    3. 配置好 git 凭据（SSH key 或 PAT），保证 git fetch 不需要密码
    4. server/.env 文件已配置好数据库、JWT_SECRET 等
#>

# 强制 UTF-8 输出，避免中文日志乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# ========== 配置区 ==========
$projectDir = "C:\Projects\re_xiuxian"
$healthCheckUrl = "http://localhost:5000/api/health"
$healthCheckTimeout = 15        # 健康检查等待秒数
$healthCheckRetryCount = 3     # 健康检查重试次数
$healthCheckRetryDelay = 5     # 健康检查重试间隔
$branch = "main"                # 部署分支
$serverPort = 5000             # 服务端口（用于端口占用检测）
$pm2AppName = "xiuxian-server" # PM2 进程名称
# GitHub 加速镜像列表（按优先级排序，第一个成功的就用）
$gitMirrors = @(
    "https://ghfast.top/https://github.com",      # ghfast.top
    "https://ghproxy.net/https://github.com",     # ghproxy.net
    "https://mirror.ghproxy.com/https://github.com", # mirror.ghproxy.com
    "https://github.com"                          # 原始 GitHub（最后兜底）
)
# npm 加速镜像
$npmMirror = "https://registry.npmmirror.com"
# ===========================

Set-Location $projectDir

Write-Host ""
Write-Host "=================================================="
Write-Host "  重生之凡人修仙传 - 服务器部署开始"
Write-Host "  时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "=================================================="
Write-Host ""

# 记录部署前的 commit hash，用于失败时回滚
$previousCommit = $null
try {
    $previousCommit = git rev-parse HEAD 2>$null
    if ($previousCommit) {
        Write-Host "[信息] 部署前版本: $($previousCommit.Substring(0,7))"
    }
} catch {
    Write-Host "[警告] 无法获取当前版本（可能是首次部署）"
}

# ========== 0. 预检查 ==========
Write-Host "[0/7] 预检查..."
Write-Host "--------------------------------------------------"

# 检查 Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未检测到 Node.js，请先安装"
    exit 1
}

# 检查 git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未检测到 git，请先安装"
    exit 1
}

# 检查项目目录
if (-not (Test-Path $projectDir)) {
    Write-Host "[错误] 项目目录不存在: $projectDir"
    Write-Host "[提示] 请先 clone 仓库到该目录"
    exit 1
}

# 检查 server/.env
if (-not (Test-Path "$projectDir\server\.env")) {
    Write-Host "[错误] 未找到 server\.env 配置文件"
    Write-Host "[提示] 请复制 .env.example 为 .env 并填写配置"
    exit 1
}

Write-Host "[成功] 预检查通过"
Write-Host ""

# ========== 1. 拉取最新代码（带镜像加速） ==========
Write-Host "[1/7] 拉取最新代码..."
Write-Host "--------------------------------------------------"

# 记录原始 remote URL，用于恢复
$originalRemote = git remote get-url origin 2>$null
Write-Host "[信息] 原始远程地址: $originalRemote"

$pullSuccess = $false
$usedMirror = $null

foreach ($mirror in $gitMirrors) {
    # 构造镜像 URL：把原始 github.com 替换为镜像地址
    $mirrorUrl = $originalRemote -replace "https://github\.com", $mirror
    if ($mirrorUrl -eq $originalRemote) {
        # SSH URL 或其他格式，跳过镜像
        continue
    }

    Write-Host "[尝试] 使用镜像: $mirror"
    try {
        git remote set-url origin $mirrorUrl
        # 设置超时（30秒），避免卡死
        $env:GIT_HTTP_CONNECT_TIMEOUT = 30
        git fetch --all --prune 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            $pullSuccess = $true
            $usedMirror = $mirror
            Write-Host "[成功] 镜像可用: $mirror"
            break
        }
    } catch {
        Write-Host "[失败] 镜像不可用: $mirror"
        continue
    }
}

# 如果所有镜像都失败，尝试原始 URL
if (-not $pullSuccess) {
    Write-Host "[尝试] 使用原始 GitHub 地址"
    git remote set-url origin $originalRemote
    try {
        git fetch --all --prune 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            $pullSuccess = $true
            Write-Host "[成功] 原始地址可用"
        }
    } catch {
        Write-Host "[失败] 原始地址也不可用"
    }
}

# 恢复原始 remote URL（避免污染配置）
git remote set-url origin $originalRemote

if (-not $pullSuccess) {
    Write-Host "[错误] 所有镜像和原始地址都拉取失败"
    Write-Host "[提示] 请检查网络或手动配置 git 凭据"
    exit 1
}

# 强制同步到远程最新
git reset --hard "origin/$branch"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] git reset 失败，分支 $branch 可能不存在"
    exit 1
}
$currentCommit = git rev-parse --short HEAD
Write-Host "[成功] 当前版本: $currentCommit"
Write-Host ""

# ========== 2. 配置 npm 镜像加速 ==========
Write-Host "[2/7] 配置 npm 镜像..."
Write-Host "--------------------------------------------------"
# 配置 npm 镜像（国内访问加速），写入项目级 .npmrc
# 注意：不写入全局配置，避免污染其他项目
$clientNpmrc = "$projectDir\client\.npmrc"
$serverNpmrc = "$projectDir\server\.npmrc"
"registry=$npmMirror" | Out-File -FilePath $clientNpmrc -Encoding utf8 -Force
"registry=$npmMirror" | Out-File -FilePath $serverNpmrc -Encoding utf8 -Force
Write-Host "[成功] npm 镜像已配置: $npmMirror"
Write-Host ""

# ========== 3. 安装前端依赖 ==========
Write-Host "[3/7] 安装前端依赖..."
Write-Host "--------------------------------------------------"
Set-Location "$projectDir\client"
# 使用 npm ci 保证依赖版本一致，优先用本地缓存加速
if (Test-Path "node_modules") {
    npm ci --prefer-offline --no-audit 2>&1 | Out-Host
} else {
    npm install --no-audit 2>&1 | Out-Host
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 前端依赖安装失败"
    exit 1
}
Write-Host "[成功] 前端依赖安装完成"
Write-Host ""

# ========== 4. 构建前端 ==========
Write-Host "[4/7] 构建前端..."
Write-Host "--------------------------------------------------"
# 清理旧构建产物，避免缓存污染
if (Test-Path "dist") {
    Remove-Item -Recurse -Force "dist"
}
npm run build 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 前端构建失败"
    exit 1
}
Write-Host "[成功] 前端构建完成 -> client\dist"
Write-Host ""

# ========== 5. 安装后端依赖 ==========
Write-Host "[5/7] 安装后端依赖..."
Write-Host "--------------------------------------------------"
Set-Location "$projectDir\server"
# 后端只装生产依赖，减少体积
if (Test-Path "node_modules") {
    npm ci --prefer-offline --no-audit 2>&1 | Out-Host
} else {
    npm install --no-audit 2>&1 | Out-Host
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 后端依赖安装失败"
    exit 1
}
Write-Host "[成功] 后端依赖安装完成"
Write-Host ""

# ========== 6. 重启服务（加固版） ==========
Write-Host "[6/7] 重启服务..."
Write-Host "--------------------------------------------------"
Set-Location $projectDir

# 检查 PM2 是否安装
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "[信息] PM2 未安装，正在全局安装..."
    npm install -g pm2 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] PM2 安装失败"
        exit 1
    }
}

# 6.1 检测端口占用（可能是手动 node index.js 跑着）
Write-Host "[信息] 检测端口 $serverPort 占用..."
$portConn = Get-NetTCPConnection -LocalPort $serverPort -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" }
if ($portConn) {
    $portPid = $portConn.OwningProcess
    $portProc = Get-Process -Id $portPid -ErrorAction SilentlyContinue
    Write-Host "[警告] 端口 $serverPort 已被占用: PID=$portPid ($($portProc.ProcessName))"

    # 检查是不是 PM2 管理的进程
    $pm2List = pm2 list 2>$null
    $pm2PidMatch = $pm2List | Select-String -Pattern "\s$portPid\s"
    if ($pm2PidMatch) {
        Write-Host "[信息] 该进程由 PM2 管理，将通过 PM2 reload 重启"
    } else {
        Write-Host "[警告] 该进程不是 PM2 管理的（可能是手动 node index.js）"
        Write-Host "[信息] 尝试停止该进程..."
        try {
            Stop-Process -Id $portPid -Force -ErrorAction Stop
            Start-Sleep -Seconds 2
            Write-Host "[成功] 已停止占用进程"
        } catch {
            Write-Host "[错误] 无法停止进程 PID=$portPid，请手动关闭后重试"
            exit 1
        }
    }
} else {
    Write-Host "[信息] 端口 $serverPort 未被占用"
}

# 6.2 PM2 状态机：根据当前状态选择正确的重启方式
Write-Host "[信息] 检查 PM2 进程状态..."
$pm2ProcessExists = $false
$pm2ProcessRunning = $false
try {
    $pm2Describe = pm2 describe $pm2AppName 2>&1
    if ($LASTEXITCODE -eq 0) {
        $pm2ProcessExists = $true
        if ($pm2Describe -match "status.*online") {
            $pm2ProcessRunning = $true
            Write-Host "[信息] PM2 进程状态: online（运行中）"
        } else {
            Write-Host "[信息] PM2 进程状态: stopped/error（已存在但未运行）"
        }
    } else {
        Write-Host "[信息] PM2 进程不存在，将首次启动"
    }
} catch {
    Write-Host "[信息] PM2 进程不存在，将首次启动"
}

if ($pm2ProcessExists -and $pm2ProcessRunning) {
    # 状态: 运行中 → 用 reload 零停机重启
    Write-Host "[信息] 使用 reload 零停机重启..."
    pm2 reload $pm2AppName --update-env 2>&1 | Out-Host
} elseif ($pm2ProcessExists -and -not $pm2ProcessRunning) {
    # 状态: 已存在但已停止 → 先 delete 再 start
    Write-Host "[信息] 进程已停止，清理后重新启动..."
    pm2 delete $pm2AppName 2>&1 | Out-Host
    pm2 start ecosystem.config.js --env production 2>&1 | Out-Host
} else {
    # 状态: 不存在 → 首次启动
    Write-Host "[信息] 首次启动服务..."
    pm2 start ecosystem.config.js --env production 2>&1 | Out-Host
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] PM2 启动失败"
    exit 1
}

# 6.3 持久化 PM2 进程列表（确保服务器重启后自动恢复）
pm2 save 2>&1 | Out-Host
Write-Host "[成功] PM2 服务已重启"
Write-Host ""

# ========== 7. 健康检查 ==========
Write-Host "[7/7] 健康检查..."
Write-Host "--------------------------------------------------"
# 等待服务完全启动
Write-Host "[信息] 等待 ${healthCheckTimeout}s 服务启动..."
Start-Sleep -Seconds $healthCheckTimeout

$isHealthy = $false

for ($i = 1; $i -le $healthCheckRetryCount; $i++) {
    try {
        $res = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
        if ($res.StatusCode -eq 200) {
            $isHealthy = $true
            Write-Host "[成功] 健康检查通过 (HTTP 200)"
            break
        }
    } catch {
        Write-Host "[警告] 第 $i/$healthCheckRetryCount 次健康检查失败: $($_.Exception.Message)"
        if ($i -lt $healthCheckRetryCount) {
            Write-Host "[信息] ${healthCheckRetryDelay}s 后重试..."
            Start-Sleep -Seconds $healthCheckRetryDelay
        }
    }
}

if (-not $isHealthy) {
    Write-Host "[错误] 健康检查失败，服务可能未正常启动"
    Write-Host ""
    Write-Host "[信息] 最近 30 行 PM2 日志:"
    Write-Host "--------------------------------------------------"
    pm2 logs $pm2AppName --lines 30 --nostream 2>&1 | Out-Host
    Write-Host "--------------------------------------------------"

    # 自动回滚到部署前版本（避免线上挂掉）
    if ($previousCommit) {
        Write-Host ""
        Write-Host "[回滚] 正在回滚到部署前版本: $($previousCommit.Substring(0,7))"
        git reset --hard $previousCommit 2>&1 | Out-Host
        Set-Location "$projectDir\server"
        npm ci --prefer-offline --no-audit 2>&1 | Out-Host
        pm2 restart $pm2AppName --update-env 2>&1 | Out-Host
        Start-Sleep -Seconds $healthCheckTimeout
        try {
            $rollbackRes = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
            if ($rollbackRes.StatusCode -eq 200) {
                Write-Host "[回滚成功] 已恢复到版本 $($previousCommit.Substring(0,7))"
            } else {
                Write-Host "[回滚失败] 回滚后服务仍未启动，请手动排查"
            }
        } catch {
            Write-Host "[回滚失败] 回滚后服务仍未启动，请手动排查"
        }
    }

    exit 1
}

Write-Host ""
Write-Host "=================================================="
Write-Host "  部署成功完成"
Write-Host "  版本: $currentCommit"
Write-Host "  时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
if ($usedMirror) {
    Write-Host "  镜像: $usedMirror"
}
Write-Host "  访问: http://localhost:$serverPort"
Write-Host "  日志: pm2 logs $pm2AppName"
Write-Host "=================================================="
Write-Host ""
