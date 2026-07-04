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
# ===================================

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
    param([string]$WorkDir, [string]$Label)
    Set-Location $WorkDir
    $retryCount = 2
    for ($i = 1; $i -le $retryCount; $i++) {
        Write-Host "[TRY] $Label install attempt $i/$retryCount"
        if (Test-Path "node_modules") {
            npm ci --prefer-offline --no-audit 2>&1 | Out-Host
        } else {
            npm install --no-audit 2>&1 | Out-Host
        }
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] $Label dependencies installed"
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
}

$clientInstallOk = Invoke-NpmInstall -WorkDir "$projectDir\client" -Label "Client"
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

npm run build 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Client build failed"
    exit 1
}

# Verify build output
if (-not (Test-Path "dist\index.html")) {
    Write-Host "[ERROR] Build output verification failed: dist\index.html not found"
    exit 1
}
Write-Host "[OK] Client build complete -> client\dist"
Write-Host ""

# ========== 5. Install server dependencies (with retry) ==========
Write-Host "[5/8] Installing server dependencies..."
Write-Host "--------------------------------------------------"
$serverInstallOk = Invoke-NpmInstall -WorkDir "$projectDir\server" -Label "Server"
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
    npm install -g pm2 2>&1 | Out-Host
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
    Write-Host "[ERROR] PM2 start failed"
    Write-Host "[INFO] PM2 logs (last 20 lines):"
    pm2 logs $pm2AppName --lines 20 --nostream 2>&1 | Out-Host
    exit 1
}

# 6.5 Persist PM2 process list (auto-restore after server reboot)
pm2 save 2>&1 | Out-Host
Write-Host "[OK] PM2 service restarted"
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

    # Auto rollback to previous version
    if ($previousCommit) {
        Write-Host ""
        Write-Host "[ROLLBACK] Rolling back to previous version: $($previousCommit.Substring(0,7))"
        git reset --hard $previousCommit 2>&1 | Out-Host

        # Rollback needs rebuild (frontend code may have changed)
        Write-Host "[ROLLBACK] Rebuilding client with old version..."
        Set-Location "$projectDir\client"
        if (Test-Path "dist") {
            Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
        }
        npm run build 2>&1 | Out-Host

        Write-Host "[ROLLBACK] Reinstalling server dependencies..."
        Set-Location "$projectDir\server"
        if (Test-Path "node_modules") {
            npm ci --prefer-offline --no-audit 2>&1 | Out-Host
        } else {
            npm install --no-audit 2>&1 | Out-Host
        }

        Write-Host "[ROLLBACK] Restarting PM2..."
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
            Write-Host "[HINT] Check PM2 logs: pm2 logs $pm2AppName --lines 50"
        }
    } else {
        Write-Host "[INFO] No previous version to rollback (first deployment)"
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
