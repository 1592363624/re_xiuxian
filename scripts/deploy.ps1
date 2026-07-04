<#
.SYNOPSIS
    XiuXian Game - Server Deployment Script (PowerShell 5.1 Compatible)
.DESCRIPTION
    Core flow: git pull -> npm install -> build -> pm2 reload -> health check
    Compatible scenarios covered:
      1. PM2 process not exist / running / stopped / stuck - all can restart correctly
      2. Manual node index.js occupying port 5000 - auto detect and handle
      3. Health check failure - auto rollback to previous version
      4. npm install failure - auto retry after cleaning node_modules
      5. dist directory locked - rename instead of delete
      6. ecosystem.config.js missing - fallback to pm2 start npm
      7. /api/health endpoint missing - fallback to port check
      8. Git credentials failure - avoid hang with GIT_TERMINAL_PROMPT=0
      9. Node version too old - check version >= 16
     10. Disk space insufficient - check before deploy
     11. PM2 not installed - auto install
     12. System process occupying port - skip and warn
    Anti-fake-success (兜底) checks added to prevent "Action green but service down":
     13. npm install exit 0 但依赖缺失 - 验证关键依赖目录 (express/sequelize/mysql2 等)
     14. git reset 后源码文件缺失 - 验证 server/index.js 等关键文件存在
     15. 前端 build 后 dist\assets 空 - 验证 JS/CSS 产物完整，防白屏
     16. pm2 start exit 0 但进程崩溃 - 验证 status=online，不只看退出码
     17. PM2 启动前 node_modules 残缺 - 紧急重装，防进程立即崩溃
     18. server/.env 缺失或无 JWT_SECRET - 启动前预检，Node 必崩场景拦截
     19. pm2 save 后 dump.pm2 未生成 - 验证开机自启配置生效
     20. 健康检查通过后服务崩溃 - 15s 后二次验证 (PM2 online + HTTP 200)
     21. 健康检查失败 - 输出 8 维度诊断 (PM2/端口/依赖/.env/磁盘/dump.pm2)
     22. 回滚后验证 - HTTP 200 + PM2 online 双条件，失败也输出诊断
    Notes:
      - This script uses ASCII-only output to avoid PowerShell 5.1 UTF-8 parsing issues
      - Chinese comments are kept in this header block (PowerShell ignores .SYNOPSIS content)
.NOTES
    First-time deployment prerequisites:
    1. Server has git, Node.js installed
    2. Repository cloned to project directory
    3. git credentials configured (SSH key or PAT)
    4. server/.env configured with DB, JWT_SECRET, etc.
#>

# Force UTF-8 output encoding (for console display only, not for script parsing)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# ========== Configuration ==========
# Auto-detect project directory from script location (portable, no hardcoded path)
$scriptPath = $MyInvocation.MyCommand.Path
if (-not $scriptPath) {
    $scriptPath = $PSCommandPath
}
if (-not $scriptPath) {
    # Fallback: use current directory
    $projectDir = (Get-Location).Path
} else {
    # scripts/deploy.ps1 -> parent = project root
    $projectDir = Split-Path -Parent (Split-Path -Parent $scriptPath)
}

$healthCheckUrl = "http://localhost:5000/api/health"
$healthCheckTimeout = 15
$healthCheckRetryCount = 3
$healthCheckRetryDelay = 5
$branch = "main"
$serverPort = 5000
$pm2AppName = "xiuxian-server"
$npmMirror = "https://registry.npmmirror.com"
$minNodeVersion = 16
$minDiskSpaceMB = 500

# GitHub mirror list (priority order, first working one will be used)
# Purpose: avoid GitHub access issues in China (proxy may not always be available)
$gitMirrors = @(
    "https://ghfast.top/https://github.com",
    "https://ghproxy.net/https://github.com",
    "https://mirror.ghproxy.com/https://github.com",
    "https://github.com"
)

# 后端关键依赖清单（npm install 后逐一验证是否存在，任一缺失即判定 install 假成功）
# 为什么需要：npm install 有时因网络/磁盘/lock 文件冲突返回 0 但实际没装全，导致 Node 启动崩
$criticalServerDeps = @(
    "express", "cors", "dotenv", "sequelize", "mysql2",
    "socket.io", "jsonwebtoken", "bcryptjs", "axios"
)
# 前端关键依赖清单（vite/vue 必须存在，否则 build 必失败）
$criticalClientDeps = @("vite", "vue")
# ===================================

# ========== Helper Functions (兜底检查函数集) ==========

# 检查 node_modules 健康度：逐一验证关键依赖目录是否存在
# 参数：WorkDir-项目目录  Label-标签用于日志  CriticalDeps-关键依赖数组
# 返回：$true=健康  $false=有关键依赖缺失
function Test-NodeModulesHealth {
    param(
        [string]$WorkDir,
        [string]$Label,
        [string[]]$CriticalDeps
    )
    $missing = @()
    foreach ($dep in $CriticalDeps) {
        # Windows 路径：node_modules\<dep>
        if (-not (Test-Path "$WorkDir\node_modules\$dep")) {
            $missing += $dep
        }
    }
    if ($missing.Count -gt 0) {
        Write-Host "[ERROR] $Label node_modules incomplete, missing: $($missing -join ', ')"
        Write-Host "[HINT] Try: Remove-Item -Recurse -Force node_modules, package-lock.json; npm install"
        return $false
    }
    Write-Host "[OK] $Label node_modules health check passed ($($CriticalDeps.Count) critical deps verified)"
    return $true
}

# 验证 PM2 进程是否真的 online（不只看 pm2 start 的退出码）
# 为什么需要：pm2 start 有时返回 0 但进程立即崩溃，$LASTEXITCODE 不可靠
# 参数：AppName-PM2 进程名
# 返回：$true=online  $false=未运行
function Test-Pm2ProcessOnline {
    param([string]$AppName)
    # 等待 2 秒让 PM2 完成进程状态收敛
    Start-Sleep -Seconds 2
    try {
        $describe = pm2 describe $AppName 2>&1 | Out-String
        if ($describe -match "status.*online") {
            Write-Host "[OK] PM2 process '$AppName' is online"
            return $true
        } else {
            Write-Host "[ERROR] PM2 process '$AppName' is NOT online (status mismatch)"
            Write-Host "[INFO] pm2 describe output:"
            Write-Host $describe
            return $false
        }
    } catch {
        Write-Host "[ERROR] Cannot get PM2 process status: $($_.Exception.Message)"
        return $false
    }
}

# 输出完整诊断信息（健康检查失败时调用，帮助定位根因）
# 包含：PM2 列表/日志、端口状态、node_modules、.env、Node 版本、磁盘空间
function Show-DiagnosticInfo {
    param(
        [string]$AppName,
        [int]$Port,
        [string]$ProjectDir
    )
    Write-Host ""
    Write-Host "=================================================="
    Write-Host "  DIAGNOSTIC INFORMATION (健康检查失败诊断)"
    Write-Host "=================================================="

    Write-Host ""
    Write-Host "--- 1. PM2 Process List ---"
    try { pm2 list 2>&1 | Out-Host } catch { Write-Host "[WARN] pm2 list failed: $($_.Exception.Message)" }

    Write-Host ""
    Write-Host "--- 2. PM2 Logs (last 50 lines) ---"
    try { pm2 logs $AppName --lines 50 --nostream 2>&1 | Out-Host } catch { Write-Host "[WARN] pm2 logs failed" }

    Write-Host ""
    Write-Host "--- 3. Port $Port Status (netstat) ---"
    try {
        $portInfo = netstat -ano | Select-String ":$Port\s"
        if ($portInfo) {
            $portInfo | Out-Host
        } else {
            Write-Host "[INFO] No activity on port $Port (后端未监听)"
        }
    } catch { Write-Host "[WARN] netstat failed" }

    Write-Host ""
    Write-Host "--- 4. Server node_modules Health ---"
    if (Test-Path "$ProjectDir\server\node_modules\express") {
        Write-Host "[OK] server/node_modules/express exists"
    } else {
        Write-Host "[ERROR] server/node_modules/express MISSING - 依赖未安装！"
    }

    Write-Host ""
    Write-Host "--- 5. server/.env Check ---"
    if (Test-Path "$ProjectDir\server\.env") {
        Write-Host "[OK] server/.env exists"
        # 只显示非敏感字段（不输出密码/密钥值）
        Get-Content "$ProjectDir\server\.env" | Select-String -Pattern "^(PORT|DB_HOST|DB_NAME|DB_USER|NODE_ENV)=" | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host "[ERROR] server/.env MISSING - Node 启动必崩！"
    }

    Write-Host ""
    Write-Host "--- 6. Node.js Version ---"
    try { node --version 2>&1 | Out-Host } catch { Write-Host "[WARN] node version check failed" }

    Write-Host ""
    Write-Host "--- 7. Disk Space ---"
    try {
        $drive = (Get-Item $ProjectDir).PSDrive.Name
        $disk = Get-PSDrive -Name $drive -ErrorAction SilentlyContinue
        if ($disk) {
            $freeMB = [math]::Floor($disk.Free / 1MB)
            Write-Host "[INFO] Free space on ${drive}: ${freeMB}MB"
            if ($freeMB -lt 500) {
                Write-Host "[WARN] Disk space low (<500MB), may cause npm install failure"
            }
        }
    } catch { Write-Host "[WARN] disk check failed" }

    Write-Host ""
    Write-Host "--- 8. PM2 dump.pm2 (开机自启配置) ---"
    $pm2Home = $env:USERPROFILE + "\.pm2\dump.pm2"
    if (Test-Path $pm2Home) {
        Write-Host "[OK] dump.pm2 exists at $pm2Home"
    } else {
        Write-Host "[WARN] dump.pm2 NOT found - 服务器重启后 PM2 不会自动恢复进程"
        Write-Host "[HINT] Run: pm2 save  (after service is online)"
    }

    Write-Host ""
    Write-Host "=================================================="
    Write-Host "  END DIAGNOSTIC INFORMATION"
    Write-Host "=================================================="
}
# ====================================

Set-Location $projectDir

Write-Host ""
Write-Host "=================================================="
Write-Host "  XiuXian Game - Server Deployment Start"
Write-Host "  Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "  Project: $projectDir"
Write-Host "=================================================="
Write-Host ""

# Record previous commit hash for rollback (MUST be captured before git pull)
$previousCommit = $null
try {
    $previousCommit = git rev-parse HEAD 2>$null
    if ($previousCommit) {
        Write-Host "[INFO] Previous version: $($previousCommit.Substring(0,7))"
    }
} catch {
    Write-Host "[WARN] Cannot get current version (maybe first deployment)"
}

# ========== 0. Pre-check ==========
Write-Host "[0/8] Pre-check..."
Write-Host "--------------------------------------------------"

# 0.1 Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js not found, please install Node.js $minNodeVersion+ first"
    exit 1
}

# 0.2 Check Node version
$nodeVersion = (node --version) -replace 'v','' -split '\.'
$nodeMajor = [int]$nodeVersion[0]
if ($nodeMajor -lt $minNodeVersion) {
    Write-Host "[ERROR] Node.js version too old: v$($nodeVersion -join '.') (need v$minNodeVersion+)"
    Write-Host "[HINT] Please upgrade Node.js from https://nodejs.org/"
    exit 1
}
Write-Host "[OK] Node.js version: v$($nodeVersion -join '.')"

# 0.3 Check git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] git not found, please install first"
    exit 1
}

# 0.4 Check project directory
if (-not (Test-Path $projectDir)) {
    Write-Host "[ERROR] Project directory not exists: $projectDir"
    Write-Host "[HINT] Please clone repository to this directory first"
    exit 1
}

# 0.5 Check server/.env (critical, without it Node will crash)
if (-not (Test-Path "$projectDir\server\.env")) {
    Write-Host "[ERROR] server\.env not found"
    Write-Host "[HINT] Please copy .env.example to .env and configure DB, JWT_SECRET, etc."
    exit 1
}

# 0.6 Check disk space
$drive = (Get-Item $projectDir).PSDrive.Name
$disk = Get-PSDrive -Name $drive -ErrorAction SilentlyContinue
if ($disk) {
    $freeMB = [math]::Floor($disk.Free / 1MB)
    if ($freeMB -lt $minDiskSpaceMB) {
        Write-Host "[ERROR] Disk space insufficient: ${freeMB}MB free (need ${minDiskSpaceMB}MB+)"
        Write-Host "[HINT] Please clean up disk space"
        exit 1
    }
    Write-Host "[OK] Disk space: ${freeMB}MB free"
}

Write-Host "[OK] Pre-check passed"
Write-Host ""

# ========== 1. Pull latest code (with mirror fallback) ==========
Write-Host "[1/8] Pulling latest code..."
Write-Host "--------------------------------------------------"

# Avoid git hanging on credential prompt (use non-interactive mode)
$env:GIT_TERMINAL_PROMPT = 0
$env:GIT_HTTP_CONNECT_TIMEOUT = 30

$originalRemote = git remote get-url origin 2>$null
if (-not $originalRemote) {
    Write-Host "[ERROR] No git remote configured"
    exit 1
}
Write-Host "[INFO] Original remote: $originalRemote"

$pullSuccess = $false
$usedMirror = $null

# Try each mirror in priority order (skip if SSH URL)
$isSSH = $originalRemote -match "^git@|ssh://"
if ($isSSH) {
    Write-Host "[INFO] Using SSH URL, skip mirror"
    $gitMirrors = @("https://github.com")
}

foreach ($mirror in $gitMirrors) {
    $mirrorUrl = $originalRemote -replace "https://github\.com", $mirror
    if ($mirrorUrl -eq $originalRemote) {
        continue
    }

    Write-Host "[TRY] Using mirror: $mirror"
    try {
        git remote set-url origin $mirrorUrl
        git fetch --all --prune 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            $pullSuccess = $true
            $usedMirror = $mirror
            Write-Host "[OK] Mirror available: $mirror"
            break
        }
    } catch {
        Write-Host "[FAIL] Mirror not available: $mirror"
        continue
    } finally {
        # Always restore original remote URL (avoid polluting git config)
        git remote set-url origin $originalRemote 2>$null
    }
}

if (-not $pullSuccess) {
    Write-Host "[ERROR] All git fetch attempts failed"
    Write-Host "[HINT] Please check network, git credentials, or configure SSH key"
    Write-Host "[HINT] SSH key setup: ssh-keygen -> add public key to GitHub -> git remote set-url origin git@github.com:user/repo.git"
    exit 1
}

# Force sync to remote latest (clean untracked files that may block reset)
git clean -fd 2>&1 | Out-Null
git reset --hard "origin/$branch"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] git reset failed, branch $branch may not exist"
    Write-Host "[HINT] Check branch name: git branch -a"
    exit 1
}
$currentCommit = git rev-parse --short HEAD
Write-Host "[OK] Current version: $currentCommit"

# 兜底：验证关键源码文件存在（git reset 可能因磁盘满/权限问题未完整写入）
# 任一缺失直接退出，避免后续 npm install / build 在残缺代码上白跑
$criticalFiles = @(
    "$projectDir\server\index.js",
    "$projectDir\server\package.json",
    "$projectDir\server\ecosystem.config.js",
    "$projectDir\client\package.json",
    "$projectDir\client\vite.config.js"
)
$missingFiles = @()
foreach ($f in $criticalFiles) {
    if (-not (Test-Path $f)) { $missingFiles += $f }
}
if ($missingFiles.Count -gt 0) {
    Write-Host "[ERROR] Critical files missing after git reset (代码未完整同步):"
    $missingFiles | ForEach-Object { Write-Host "  - $_" }
    Write-Host "[HINT] Check disk space, git permissions, or try: git clean -fdx; git reset --hard origin/main"
    exit 1
}
Write-Host "[OK] Critical source files verified ($($criticalFiles.Count) files)"
Write-Host ""

# ========== 2. Configure npm mirror ==========
Write-Host "[2/8] Configuring npm mirror..."
Write-Host "--------------------------------------------------"
$clientNpmrc = "$projectDir\client\.npmrc"
$serverNpmrc = "$projectDir\server\.npmrc"
"registry=$npmMirror" | Out-File -FilePath $clientNpmrc -Encoding ascii -Force
"registry=$npmMirror" | Out-File -FilePath $serverNpmrc -Encoding ascii -Force
Write-Host "[OK] npm mirror configured: $npmMirror"
Write-Host ""

# ========== 3. Install client dependencies (with retry) ==========
Write-Host "[3/8] Installing client dependencies..."
Write-Host "--------------------------------------------------"
Set-Location "$projectDir\client"

function Invoke-NpmInstall {
    param(
        [string]$WorkDir,
        [string]$Label,
        [string[]]$CriticalDeps = @()
    )
    Set-Location $WorkDir
    $retryCount = 2
    # Save and relax error preference: npm/vite may emit stderr warnings (e.g. Browserslist)
    # that should NOT abort the deployment. Only check $LASTEXITCODE for real failures.
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        for ($i = 1; $i -le $retryCount; $i++) {
            Write-Host "[TRY] $Label install attempt $i/$retryCount"
            if (Test-Path "node_modules") {
                npm ci --prefer-offline --no-audit 2>&1 | Out-Host
            } else {
                npm install --no-audit 2>&1 | Out-Host
            }
            if ($LASTEXITCODE -eq 0) {
                # 兜底：npm install 返回 0 不代表真装全，必须验证关键依赖目录存在
                # 场景：lock 文件损坏/磁盘满/网络中断导致部分依赖缺失
                if ($CriticalDeps.Count -gt 0) {
                    if (-not (Test-NodeModulesHealth -WorkDir $WorkDir -Label $Label -CriticalDeps $CriticalDeps)) {
                        Write-Host "[WARN] $Label install exit 0 but node_modules incomplete (attempt $i), retrying..."
                        # 清理后重试，避免脏 node_modules 干扰下次 install
                        if (Test-Path "node_modules") {
                            Remove-Item -Recurse -Force "node_modules" -ErrorAction SilentlyContinue
                        }
                        if (Test-Path "package-lock.json") {
                            Remove-Item -Force "package-lock.json" -ErrorAction SilentlyContinue
                        }
                        continue
                    }
                }
                Write-Host "[OK] $Label dependencies installed and verified"
                return $true
            } else {
                Write-Host "[WARN] $Label install failed (attempt $i), cleaning node_modules..."
                if (Test-Path "node_modules") {
                    Remove-Item -Recurse -Force "node_modules" -ErrorAction SilentlyContinue
                }
                if (Test-Path "package-lock.json") {
                    Remove-Item -Force "package-lock.json" -ErrorAction SilentlyContinue
                }
            }
        }
        return $false
    } finally {
        $ErrorActionPreference = $oldEAP
    }
}

# Helper: run npm build safely (avoid $ErrorActionPreference='Stop' aborting on stderr warnings)
# Why: Vite/npm may emit Browserslist or deprecation warnings to stderr. These are NOT errors
#      but PowerShell $ErrorActionPreference='Stop' treats any stderr as terminating error,
#      causing the whole deploy to abort. We relax it here and rely on $LASTEXITCODE.
function Invoke-NpmBuild {
    param([string]$WorkDir, [string]$Label)
    Set-Location $WorkDir
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Write-Host "[TRY] $Label build starting..."
        npm run build 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] $Label build succeeded"
            return $true
        } else {
            Write-Host "[ERROR] $Label build failed (exit code: $LASTEXITCODE)"
            return $false
        }
    } finally {
        $ErrorActionPreference = $oldEAP
    }
}

$clientInstallOk = Invoke-NpmInstall -WorkDir "$projectDir\client" -Label "Client" -CriticalDeps $criticalClientDeps
if (-not $clientInstallOk) {
    Write-Host "[ERROR] Client dependencies install failed after retries"
    exit 1
}
Write-Host ""

# ========== 4. Build client ==========
Write-Host "[4/8] Building client..."
Write-Host "--------------------------------------------------"
Set-Location "$projectDir\client"

# Handle dist directory: rename if locked, delete if possible
if (Test-Path "dist") {
    try {
        Remove-Item -Recurse -Force "dist" -ErrorAction Stop
        Write-Host "[OK] Old dist removed"
    } catch {
        # dist may be locked by IIS/nginx, rename it instead
        $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
        $backupName = "dist.old.$timestamp"
        try {
            Rename-Item -Path "dist" -NewName $backupName -ErrorAction Stop
            Write-Host "[WARN] dist locked, renamed to $backupName"
            # Async delete old backup (don't block deploy)
            Start-Job -ScriptBlock {
                param($p)
                Start-Sleep -Seconds 5
                Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
            } -ArgumentList "$projectDir\client\$backupName" | Out-Null
        } catch {
            Write-Host "[ERROR] Cannot remove or rename old dist: $($_.Exception.Message)"
            Write-Host "[HINT] Please manually stop IIS/nginx or delete dist directory"
            exit 1
        }
    }
}

$buildOk = Invoke-NpmBuild -WorkDir "$projectDir\client" -Label "Client"
if (-not $buildOk) {
    Write-Host "[ERROR] Client build failed"
    exit 1
}

# Verify build output
if (-not (Test-Path "dist\index.html")) {
    Write-Host "[ERROR] Build output verification failed: dist\index.html not found"
    exit 1
}
# 兜底：验证 dist\assets 目录存在且非空（index.html 存在不代表 JS/CSS 产物完整）
# 场景：vite build 部分失败但 index.html 已写入，导致前端白屏
if (-not (Test-Path "dist\assets")) {
    Write-Host "[ERROR] Build output verification failed: dist\assets directory not found"
    Write-Host "[HINT] Vite build may have partially failed, check build logs above"
    exit 1
}
$assetFiles = Get-ChildItem -Path "dist\assets" -File -ErrorAction SilentlyContinue
if ($assetFiles.Count -eq 0) {
    Write-Host "[ERROR] dist\assets directory is empty (no JS/CSS bundles generated)"
    exit 1
}
Write-Host "[OK] Client build complete -> client\dist (index.html + $($assetFiles.Count) asset files)"
Write-Host ""

# ========== 5. Install server dependencies (with retry) ==========
Write-Host "[5/8] Installing server dependencies..."
Write-Host "--------------------------------------------------"
$serverInstallOk = Invoke-NpmInstall -WorkDir "$projectDir\server" -Label "Server" -CriticalDeps $criticalServerDeps
if (-not $serverInstallOk) {
    Write-Host "[ERROR] Server dependencies install failed after retries"
    exit 1
}
Write-Host ""

# ========== 6. Restart service ==========
Write-Host "[6/8] Restarting service..."
Write-Host "--------------------------------------------------"
Set-Location $projectDir

# 6.1 Check if PM2 is installed
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "[INFO] PM2 not found, installing globally..."
    # Relax error preference: npm install may emit deprecation warnings to stderr
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        npm install -g pm2 2>&1 | Out-Host
    } finally {
        $ErrorActionPreference = $oldEAP
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] PM2 install failed"
        Write-Host "[HINT] Try: npm install -g pm2 --force"
        exit 1
    }
    # Refresh PATH to include newly installed pm2
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
}
Write-Host "[OK] PM2 available"

# 6.2 Detect port occupation (manual node index.js running)
Write-Host "[INFO] Checking port $serverPort occupation..."
$portConn = $null
try {
    # Use Get-NetTCPConnection (Windows 8+)
    $portConn = Get-NetTCPConnection -LocalPort $serverPort -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" } | Select-Object -First 1
} catch {
    # Fallback to netstat (older Windows)
    $netstat = netstat -ano | Select-String ":$serverPort\s.*LISTENING"
    if ($netstat) {
        $pidMatch = [regex]::Match($netstat.ToString(), '\s+(\d+)$')
        if ($pidMatch.Success) {
            $portConn = [PSCustomObject]@{ OwningProcess = [int]$pidMatch.Groups[1].Value }
        }
    }
}

if ($portConn) {
    $portPid = $portConn.OwningProcess
    # Skip system processes (PID < 100 are usually system)
    if ($portPid -lt 100) {
        Write-Host "[WARN] Port $serverPort occupied by system process (PID=$portPid), skip killing"
    } else {
        $portProc = Get-Process -Id $portPid -ErrorAction SilentlyContinue
        $procName = if ($portProc) { $portProc.ProcessName } else { "unknown" }
        Write-Host "[WARN] Port $serverPort is occupied: PID=$portPid ($procName)"

        # Check if this process is managed by PM2
        $pm2List = pm2 list 2>$null
        $pm2PidMatch = $pm2List | Select-String -Pattern "\s$portPid\s"
        if ($pm2PidMatch) {
            Write-Host "[INFO] Process is managed by PM2, will reload via PM2"
        } else {
            Write-Host "[WARN] Process is NOT managed by PM2 (maybe manual node index.js)"
            Write-Host "[INFO] Stopping this process..."
            try {
                Stop-Process -Id $portPid -Force -ErrorAction Stop
                Start-Sleep -Seconds 2
                Write-Host "[OK] Occupying process stopped"
            } catch {
                Write-Host "[ERROR] Cannot stop process PID=$portPid, please stop it manually"
                Write-Host "[HINT] Run: Stop-Process -Id $portPid -Force"
                exit 1
            }
        }
    }
} else {
    Write-Host "[OK] Port $serverPort is free"
}

# 6.25 兜底：PM2 启动前最后验证 server/node_modules 健康
# 为什么需要：即使前面 npm install 通过，也可能因并发操作/手动清理/磁盘问题导致 node_modules 残缺
# 此时不验证直接 pm2 start，进程会立即崩溃，PM2 重试 10 次后放弃，复现"PM2 list 空"问题
Write-Host "[INFO] Pre-start check: verifying server node_modules integrity..."
if (-not (Test-NodeModulesHealth -WorkDir "$projectDir\server" -Label "Server" -CriticalDeps $criticalServerDeps)) {
    Write-Host "[WARN] node_modules incomplete before PM2 start, force reinstalling..."
    $emergencyInstallOk = Invoke-NpmInstall -WorkDir "$projectDir\server" -Label "Emergency-Server" -CriticalDeps $criticalServerDeps
    if (-not $emergencyInstallOk) {
        Write-Host "[ERROR] Emergency reinstall failed, abort deployment"
        Show-DiagnosticInfo -AppName $pm2AppName -Port $serverPort -ProjectDir $projectDir
        exit 1
    }
    Write-Host "[OK] Emergency reinstall succeeded"
}

# 兜底：验证 server/.env 存在且包含 JWT_SECRET（Node 启动时强制检查，缺失即崩）
if (-not (Test-Path "$projectDir\server\.env")) {
    Write-Host "[ERROR] server\.env NOT FOUND before PM2 start - Node will crash immediately"
    Write-Host "[HINT] Copy server\.env.example to server\.env and configure DB/JWT_SECRET"
    exit 1
}
$envContent = Get-Content "$projectDir\server\.env" -Raw
if ($envContent -notmatch "JWT_SECRET\s*=\s*\S+") {
    Write-Host "[ERROR] JWT_SECRET not configured in server\.env - Node will refuse to start"
    Write-Host "[HINT] Add 'JWT_SECRET=your_secret_here' to server\.env"
    exit 1
}
Write-Host "[OK] Pre-start checks passed (node_modules + .env + JWT_SECRET verified)"

# 6.3 PM2 state machine: choose correct restart method based on current state
Write-Host "[INFO] Checking PM2 process state..."
$pm2ProcessExists = $false
$pm2ProcessRunning = $false
try {
    $pm2Describe = pm2 describe $pm2AppName 2>&1
    if ($LASTEXITCODE -eq 0) {
        $pm2ProcessExists = $true
        if ($pm2Describe -match "status.*online") {
            $pm2ProcessRunning = $true
            Write-Host "[INFO] PM2 process state: online (running)"
        } else {
            Write-Host "[INFO] PM2 process state: stopped/error (exists but not running)"
        }
    } else {
        Write-Host "[INFO] PM2 process does not exist, will start fresh"
    }
} catch {
    Write-Host "[INFO] PM2 process does not exist, will start fresh"
}

# 6.4 Check ecosystem.config.js existence
$ecosystemFile = "$projectDir\server\ecosystem.config.js"
$hasEcosystem = Test-Path $ecosystemFile

if (-not $hasEcosystem) {
    Write-Host "[WARN] ecosystem.config.js not found, will use fallback pm2 start"
}

$pm2StartOk = $false
if ($pm2ProcessExists -and $pm2ProcessRunning) {
    # State: running -> zero-downtime reload
    Write-Host "[INFO] Using reload for zero-downtime restart..."
    pm2 reload $pm2AppName --update-env 2>&1 | Out-Host
    $pm2StartOk = ($LASTEXITCODE -eq 0)
} elseif ($pm2ProcessExists -and -not $pm2ProcessRunning) {
    # State: exists but stopped -> delete then start
    Write-Host "[INFO] Process stopped, cleaning up and restarting..."
    pm2 delete $pm2AppName 2>&1 | Out-Host
    if ($hasEcosystem) {
        pm2 start $ecosystemFile --env production 2>&1 | Out-Host
    } else {
        Set-Location "$projectDir\server"
        pm2 start npm --name $pm2AppName -- start 2>&1 | Out-Host
        Set-Location $projectDir
    }
    $pm2StartOk = ($LASTEXITCODE -eq 0)
} else {
    # State: not exists -> first start
    Write-Host "[INFO] First start..."
    if ($hasEcosystem) {
        pm2 start $ecosystemFile --env production 2>&1 | Out-Host
    } else {
        Set-Location "$projectDir\server"
        pm2 start npm --name $pm2AppName -- start 2>&1 | Out-Host
        Set-Location $projectDir
    }
    $pm2StartOk = ($LASTEXITCODE -eq 0)
}

if (-not $pm2StartOk) {
    Write-Host "[ERROR] PM2 start failed (exit code non-zero)"
    Write-Host "[INFO] PM2 logs (last 20 lines):"
    pm2 logs $pm2AppName --lines 20 --nostream 2>&1 | Out-Host
    exit 1
}

# 兜底：pm2 start 返回 0 不代表进程真的起来，必须验证 status=online
# 场景：.env 缺失/端口冲突/代码错误导致进程启动后立即崩溃，PM2 退出码仍是 0
if (-not (Test-Pm2ProcessOnline -AppName $pm2AppName)) {
    Write-Host "[ERROR] PM2 start reported success but process is NOT online"
    Write-Host "[INFO] This usually means Node crashed immediately after start."
    Write-Host "[INFO] Common causes: missing .env, DB connection failed, port conflict, code error"
    Write-Host ""
    Write-Host "[INFO] PM2 logs (last 30 lines):"
    pm2 logs $pm2AppName --lines 30 --nostream 2>&1 | Out-Host
    exit 1
}

# 6.5 Persist PM2 process list (auto-restore after server reboot)
pm2 save 2>&1 | Out-Host
# 兜底：验证 dump.pm2 文件确实生成（pm2 save 偶发失败但不报错）
# 没有此文件服务器重启后进程列表会丢，复现你当前遇到的"PM2 list 空"问题
$pm2DumpFile = "$env:USERPROFILE\.pm2\dump.pm2"
if (-not (Test-Path $pm2DumpFile)) {
    Write-Host "[WARN] pm2 save completed but dump.pm2 not found at $pm2DumpFile"
    Write-Host "[WARN] Server reboot will NOT auto-restore PM2 processes"
    Write-Host "[HINT] Run 'pm2 save' manually after service stabilizes"
} else {
    Write-Host "[OK] PM2 process list saved to dump.pm2 (auto-restore on reboot enabled)"
}
Write-Host "[OK] PM2 service restarted and verified online"
Write-Host ""

# ========== 7. Health check ==========
Write-Host "[7/8] Health check..."
Write-Host "--------------------------------------------------"
Write-Host "[INFO] Waiting ${healthCheckTimeout}s for service startup..."
Start-Sleep -Seconds $healthCheckTimeout

$isHealthy = $false
$healthCheckMethod = "none"

for ($i = 1; $i -le $healthCheckRetryCount; $i++) {
    # Method 1: HTTP health check endpoint
    try {
        $res = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
        if ($res.StatusCode -eq 200) {
            $isHealthy = $true
            $healthCheckMethod = "HTTP /api/health"
            Write-Host "[OK] Health check passed (HTTP 200)"
            break
        }
    } catch {
        $errMsg = $_.Exception.Message
        if ($errMsg -match "404") {
            Write-Host "[WARN] /api/health endpoint not found (old code version), fallback to port check"
            break
        }
        Write-Host "[WARN] Health check attempt $i/$healthCheckRetryCount failed: $errMsg"
        if ($i -lt $healthCheckRetryCount) {
            Write-Host "[INFO] Retrying in ${healthCheckRetryDelay}s..."
            Start-Sleep -Seconds $healthCheckRetryDelay
        }
    }
}

# Method 2: Fallback - check if port is listening
if (-not $isHealthy) {
    Write-Host "[INFO] Fallback: checking port $serverPort listening..."
    try {
        $portCheck = Get-NetTCPConnection -LocalPort $serverPort -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" }
        if ($portCheck) {
            $isHealthy = $true
            $healthCheckMethod = "Port $serverPort listening"
            Write-Host "[OK] Port $serverPort is listening (service started)"
        }
    } catch {
        # netstat fallback
        $netstatCheck = netstat -ano | Select-String ":$serverPort\s.*LISTENING"
        if ($netstatCheck) {
            $isHealthy = $true
            $healthCheckMethod = "Port $serverPort listening (netstat)"
            Write-Host "[OK] Port $serverPort is listening (netstat)"
        }
    }
}

if (-not $isHealthy) {
    Write-Host "[ERROR] Health check failed, service may not be running properly"
    Write-Host ""
    Write-Host "[INFO] Last 30 lines of PM2 logs:"
    Write-Host "--------------------------------------------------"
    pm2 logs $pm2AppName --lines 30 --nostream 2>&1 | Out-Host
    Write-Host "--------------------------------------------------"

    # 兜底：输出完整诊断信息，避免"Action 假绿但服务没起"的盲排查
    # 包含 PM2 状态/日志/端口/node_modules/.env/磁盘/dump.pm2 全维度检查
    Show-DiagnosticInfo -AppName $pm2AppName -Port $serverPort -ProjectDir $projectDir

    # Auto rollback to previous version
    if ($previousCommit) {
        Write-Host ""
        Write-Host "[ROLLBACK] Rolling back to previous version: $($previousCommit.Substring(0,7))"
        git reset --hard $previousCommit 2>&1 | Out-Host

        # 兜底：回滚后验证关键文件存在（git reset 可能失败）
        $rollbackIndexExists = Test-Path "$projectDir\server\index.js"
        if (-not $rollbackIndexExists) {
            Write-Host "[ROLLBACK ERROR] git reset failed - server\index.js missing after rollback"
            Write-Host "[HINT] Manual recovery: git reset --hard <good-commit>; npm install; pm2 restart"
            exit 1
        }

        # Rollback needs rebuild (frontend code may have changed)
        Write-Host "[ROLLBACK] Rebuilding client with old version..."
        Set-Location "$projectDir\client"
        if (Test-Path "dist") {
            Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
        }
        # Reuse the safe builder (handles Browserslist-style stderr warnings)
        $rollbackBuildOk = Invoke-NpmBuild -WorkDir "$projectDir\client" -Label "Rollback-Client"
        if (-not $rollbackBuildOk) {
            Write-Host "[ROLLBACK WARN] Client rebuild failed during rollback (service may still be in old state)"
        }

        Write-Host "[ROLLBACK] Reinstalling server dependencies..."
        # Reuse the safe installer (handles npm stderr warnings, with retry, with deps health check)
        $rollbackServerOk = Invoke-NpmInstall -WorkDir "$projectDir\server" -Label "Rollback-Server" -CriticalDeps $criticalServerDeps
        if (-not $rollbackServerOk) {
            Write-Host "[ROLLBACK WARN] Server dependencies reinstall failed during rollback"
        }

        Write-Host "[ROLLBACK] Restarting PM2..."
        pm2 restart $pm2AppName --update-env 2>&1 | Out-Host
        Start-Sleep -Seconds $healthCheckTimeout

        # 兜底：回滚后也验证 PM2 进程 online，不只看 HTTP 200
        $rollbackOnline = Test-Pm2ProcessOnline -AppName $pm2AppName
        try {
            $rollbackRes = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
            if ($rollbackRes.StatusCode -eq 200 -and $rollbackOnline) {
                Write-Host "[ROLLBACK OK] Restored to version $($previousCommit.Substring(0,7)) (HTTP 200 + PM2 online)"
            } else {
                Write-Host "[ROLLBACK FAIL] Service still not running properly after rollback"
                Write-Host "[INFO] HTTP status: $($rollbackRes.StatusCode), PM2 online: $rollbackOnline"
                # 回滚失败也输出诊断，方便排查
                Show-DiagnosticInfo -AppName $pm2AppName -Port $serverPort -ProjectDir $projectDir
            }
        } catch {
            Write-Host "[ROLLBACK FAIL] Service still not running after rollback (HTTP check failed)"
            Write-Host "[INFO] PM2 online: $rollbackOnline"
            Write-Host "[HINT] Check PM2 logs: pm2 logs $pm2AppName --lines 50"
            # 回滚失败也输出诊断，方便排查
            Show-DiagnosticInfo -AppName $pm2AppName -Port $serverPort -ProjectDir $projectDir
        }
    } else {
        Write-Host "[INFO] No previous version to rollback (first deployment)"
        Write-Host "[HINT] Manual recovery steps:"
        Write-Host "  1. cd $projectDir\server"
        Write-Host "  2. node index.js    (前台运行看真实报错)"
        Write-Host "  3. 修复报错后: pm2 restart $pm2AppName"
    }

    exit 1
}

Write-Host "[OK] Health check passed via: $healthCheckMethod"
Write-Host ""

# ========== 8. Final summary ==========
Write-Host "[8/8] Deployment summary..."
Write-Host "--------------------------------------------------"
Write-Host ""
Write-Host "=================================================="
Write-Host "  Deployment Success"
Write-Host "  Version: $currentCommit"
Write-Host "  Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
if ($usedMirror) {
    Write-Host "  Git Mirror: $usedMirror"
}
Write-Host "  Health Check: $healthCheckMethod"
Write-Host "  Service URL: http://localhost:$serverPort"
Write-Host "  PM2 App Name: $pm2AppName"
Write-Host "  Logs: pm2 logs $pm2AppName"
Write-Host "  Status: pm2 status"
Write-Host "=================================================="
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  pm2 logs $pm2AppName --lines 50   # View logs"
Write-Host "  pm2 restart $pm2AppName          # Manual restart"
Write-Host "  pm2 stop $pm2AppName              # Stop service"
Write-Host ""

# ========== 9. Post-deploy verification (二次验证，防止"假绿") ==========
# 为什么需要：健康检查通过 ≠ 服务稳定。等 5 秒后再验一次，确保进程没在退出后崩溃
Write-Host "[9/9] Post-deploy verification (15s stability check)..."
Write-Host "--------------------------------------------------"
Start-Sleep -Seconds 15

# 二次验证 PM2 进程仍然 online（防止进程在健康检查后崩溃）
if (-not (Test-Pm2ProcessOnline -AppName $pm2AppName)) {
    Write-Host "[ERROR] Post-deploy check FAILED: PM2 process went down after health check"
    Write-Host "[INFO] This indicates the service crashed shortly after starting"
    Show-DiagnosticInfo -AppName $pm2AppName -Port $serverPort -ProjectDir $projectDir
    exit 1
}

# 二次验证 HTTP 健康检查仍然通过
try {
    $postCheckRes = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
    if ($postCheckRes.StatusCode -ne 200) {
        Write-Host "[ERROR] Post-deploy HTTP check FAILED: status $($postCheckRes.StatusCode)"
        Show-DiagnosticInfo -AppName $pm2AppName -Port $serverPort -ProjectDir $projectDir
        exit 1
    }
} catch {
    Write-Host "[ERROR] Post-deploy HTTP check FAILED: $($_.Exception.Message)"
    Show-DiagnosticInfo -AppName $pm2AppName -Port $serverPort -ProjectDir $projectDir
    exit 1
}

# 兜底：最后再确认一次 dump.pm2 存在（防止健康检查后的 pm2 save 没生效）
if (-not (Test-Path "$env:USERPROFILE\.pm2\dump.pm2")) {
    Write-Host "[WARN] dump.pm2 still missing after deploy - run 'pm2 save' manually"
    Write-Host "[WARN] Server reboot will NOT auto-restore PM2 processes"
}

Write-Host "[OK] Post-deploy verification passed (service stable after 15s)"
Write-Host "[OK] Deployment is FULLY verified - service is online and stable"
Write-Host ""
