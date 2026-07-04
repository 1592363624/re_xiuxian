<#
.SYNOPSIS
    XiuXian Game - Server Deployment Script (PowerShell 5.1 Compatible)
.DESCRIPTION
    Core flow: git pull -> npm install -> build -> pm2 reload -> health check
    Compatible scenarios:
      1. PM2 process not exist / running / stopped / stuck - all can restart correctly
      2. Manual node index.js occupying port 5000 - auto detect and handle
      3. Health check failure - auto rollback to previous version
    Notes:
      - This script uses ASCII-only comments to avoid PowerShell 5.1 UTF-8 parsing issues
      - All output messages are in English to ensure compatibility
      - Chinese comments are kept in this header block (PowerShell ignores .SYNOPSIS content)
.NOTES
    First-time deployment prerequisites:
    1. Server has git, Node.js, PM2 installed (npm install -g pm2)
    2. Repository cloned to PROJECT_DIR
    3. git credentials configured (SSH key or PAT)
    4. server/.env configured with DB, JWT_SECRET, etc.
#>

# Force UTF-8 output encoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# ========== Configuration ==========
# Auto-detect project directory from script location
# This makes the script portable - no hardcoded path
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$healthCheckUrl = "http://localhost:5000/api/health"
$healthCheckTimeout = 15
$healthCheckRetryCount = 3
$healthCheckRetryDelay = 5
$branch = "main"
$serverPort = 5000
$pm2AppName = "xiuxian-server"
$npmMirror = "https://registry.npmmirror.com"
# GitHub mirror list (priority order, first working one will be used)
# Purpose: avoid GitHub access issues in China (proxy may not always be available)
$gitMirrors = @(
    "https://ghfast.top/https://github.com",
    "https://ghproxy.net/https://github.com",
    "https://mirror.ghproxy.com/https://github.com",
    "https://github.com"
)
# ===================================

Set-Location $projectDir

Write-Host ""
Write-Host "=================================================="
Write-Host "  XiuXian Game - Server Deployment Start"
Write-Host "  Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "=================================================="
Write-Host ""

# Record previous commit hash for rollback
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
Write-Host "[0/7] Pre-check..."
Write-Host "--------------------------------------------------"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js not found, please install first"
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] git not found, please install first"
    exit 1
}

if (-not (Test-Path $projectDir)) {
    Write-Host "[ERROR] Project directory not exists: $projectDir"
    Write-Host "[HINT] Please clone repository to this directory first"
    exit 1
}

if (-not (Test-Path "$projectDir\server\.env")) {
    Write-Host "[ERROR] server\.env not found"
    Write-Host "[HINT] Please copy .env.example to .env and configure it"
    exit 1
}

Write-Host "[OK] Pre-check passed"
Write-Host ""

# ========== 1. Pull latest code (with mirror fallback) ==========
Write-Host "[1/7] Pulling latest code..."
Write-Host "--------------------------------------------------"

$originalRemote = git remote get-url origin 2>$null
Write-Host "[INFO] Original remote: $originalRemote"

$pullSuccess = $false
$usedMirror = $null

# Try each mirror in priority order
foreach ($mirror in $gitMirrors) {
    # Construct mirror URL: replace github.com with mirror prefix
    $mirrorUrl = $originalRemote -replace "https://github\.com", $mirror
    if ($mirrorUrl -eq $originalRemote) {
        # SSH URL or other format, skip mirror
        continue
    }

    Write-Host "[TRY] Using mirror: $mirror"
    try {
        git remote set-url origin $mirrorUrl
        $env:GIT_HTTP_CONNECT_TIMEOUT = 30
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
    }
}

# If all mirrors failed, try original remote as last resort
if (-not $pullSuccess) {
    Write-Host "[TRY] Using original remote as fallback"
    git remote set-url origin $originalRemote
    try {
        $env:GIT_HTTP_CONNECT_TIMEOUT = 30
        git fetch --all --prune 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            $pullSuccess = $true
            Write-Host "[OK] Original remote available"
        }
    } catch {
        Write-Host "[FAIL] Original remote also not available"
    }
}

# Restore original remote URL (avoid polluting config)
git remote set-url origin $originalRemote

if (-not $pullSuccess) {
    Write-Host "[ERROR] All mirrors and original remote failed"
    Write-Host "[HINT] Please check network or git credentials"
    exit 1
}

# Force sync to remote latest
git reset --hard "origin/$branch"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] git reset failed, branch $branch may not exist"
    exit 1
}
$currentCommit = git rev-parse --short HEAD
Write-Host "[OK] Current version: $currentCommit"
Write-Host ""

# ========== 2. Configure npm mirror ==========
Write-Host "[2/7] Configuring npm mirror..."
Write-Host "--------------------------------------------------"
$clientNpmrc = "$projectDir\client\.npmrc"
$serverNpmrc = "$projectDir\server\.npmrc"
"registry=$npmMirror" | Out-File -FilePath $clientNpmrc -Encoding utf8 -Force
"registry=$npmMirror" | Out-File -FilePath $serverNpmrc -Encoding utf8 -Force
Write-Host "[OK] npm mirror configured: $npmMirror"
Write-Host ""

# ========== 3. Install client dependencies ==========
Write-Host "[3/7] Installing client dependencies..."
Write-Host "--------------------------------------------------"
Set-Location "$projectDir\client"
if (Test-Path "node_modules") {
    npm ci --prefer-offline --no-audit 2>&1 | Out-Host
} else {
    npm install --no-audit 2>&1 | Out-Host
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Client dependencies install failed"
    exit 1
}
Write-Host "[OK] Client dependencies installed"
Write-Host ""

# ========== 4. Build client ==========
Write-Host "[4/7] Building client..."
Write-Host "--------------------------------------------------"
if (Test-Path "dist") {
    Remove-Item -Recurse -Force "dist"
}
npm run build 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Client build failed"
    exit 1
}
Write-Host "[OK] Client build complete -> client\dist"
Write-Host ""

# ========== 5. Install server dependencies ==========
Write-Host "[5/7] Installing server dependencies..."
Write-Host "--------------------------------------------------"
Set-Location "$projectDir\server"
if (Test-Path "node_modules") {
    npm ci --prefer-offline --no-audit 2>&1 | Out-Host
} else {
    npm install --no-audit 2>&1 | Out-Host
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Server dependencies install failed"
    exit 1
}
Write-Host "[OK] Server dependencies installed"
Write-Host ""

# ========== 6. Restart service ==========
Write-Host "[6/7] Restarting service..."
Write-Host "--------------------------------------------------"
Set-Location $projectDir

# Check if PM2 is installed
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "[INFO] PM2 not found, installing globally..."
    npm install -g pm2 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] PM2 install failed"
        exit 1
    }
}

# 6.1 Detect port occupation (maybe manual node index.js running)
Write-Host "[INFO] Checking port $serverPort occupation..."
$portConn = Get-NetTCPConnection -LocalPort $serverPort -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" }
if ($portConn) {
    $portPid = $portConn.OwningProcess
    $portProc = Get-Process -Id $portPid -ErrorAction SilentlyContinue
    Write-Host "[WARN] Port $serverPort is occupied: PID=$portPid ($($portProc.ProcessName))"

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
            exit 1
        }
    }
} else {
    Write-Host "[INFO] Port $serverPort is free"
}

# 6.2 PM2 state machine: choose correct restart method based on current state
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

if ($pm2ProcessExists -and $pm2ProcessRunning) {
    # State: running -> zero-downtime reload
    Write-Host "[INFO] Using reload for zero-downtime restart..."
    pm2 reload $pm2AppName --update-env 2>&1 | Out-Host
} elseif ($pm2ProcessExists -and -not $pm2ProcessRunning) {
    # State: exists but stopped -> delete then start
    Write-Host "[INFO] Process stopped, cleaning up and restarting..."
    pm2 delete $pm2AppName 2>&1 | Out-Host
    pm2 start ecosystem.config.js --env production 2>&1 | Out-Host
} else {
    # State: not exists -> first start
    Write-Host "[INFO] First start..."
    pm2 start ecosystem.config.js --env production 2>&1 | Out-Host
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] PM2 start failed"
    exit 1
}

# 6.3 Persist PM2 process list (auto-restore after server reboot)
pm2 save 2>&1 | Out-Host
Write-Host "[OK] PM2 service restarted"
Write-Host ""

# ========== 7. Health check ==========
Write-Host "[7/7] Health check..."
Write-Host "--------------------------------------------------"
Write-Host "[INFO] Waiting ${healthCheckTimeout}s for service startup..."
Start-Sleep -Seconds $healthCheckTimeout

$isHealthy = $false

for ($i = 1; $i -le $healthCheckRetryCount; $i++) {
    try {
        $res = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
        if ($res.StatusCode -eq 200) {
            $isHealthy = $true
            Write-Host "[OK] Health check passed (HTTP 200)"
            break
        }
    } catch {
        Write-Host "[WARN] Health check attempt $i/$healthCheckRetryCount failed: $($_.Exception.Message)"
        if ($i -lt $healthCheckRetryCount) {
            Write-Host "[INFO] Retrying in ${healthCheckRetryDelay}s..."
            Start-Sleep -Seconds $healthCheckRetryDelay
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

    # Auto rollback to previous version
    if ($previousCommit) {
        Write-Host ""
        Write-Host "[ROLLBACK] Rolling back to previous version: $($previousCommit.Substring(0,7))"
        git reset --hard $previousCommit 2>&1 | Out-Host
        Set-Location "$projectDir\server"
        npm ci --prefer-offline --no-audit 2>&1 | Out-Host
        pm2 restart $pm2AppName --update-env 2>&1 | Out-Host
        Start-Sleep -Seconds $healthCheckTimeout
        try {
            $rollbackRes = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
            if ($rollbackRes.StatusCode -eq 200) {
                Write-Host "[ROLLBACK OK] Restored to version $($previousCommit.Substring(0,7))"
            } else {
                Write-Host "[ROLLBACK FAIL] Service still not running after rollback, please investigate manually"
            }
        } catch {
            Write-Host "[ROLLBACK FAIL] Service still not running after rollback, please investigate manually"
        }
    }

    exit 1
}

Write-Host ""
Write-Host "=================================================="
Write-Host "  Deployment Success"
Write-Host "  Version: $currentCommit"
Write-Host "  Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
if ($usedMirror) {
    Write-Host "  Mirror: $usedMirror"
}
Write-Host "  URL: http://localhost:$serverPort"
Write-Host "  Logs: pm2 logs $pm2AppName"
Write-Host "=================================================="
Write-Host ""
