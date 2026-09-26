# CI bootstrap -> powershell -EncodedCommand. Budget rule: deploy.yml (7000 cap).
$ProjectDir = 'C:\Users\Administrator\Desktop\re_xiuxian'
$Branch = 'main'
$ErrorActionPreference = 'Continue'
# Codepage 936 mangles git/PS output: force UTF-8 + en-US.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Threading.Thread]::CurrentThread.CurrentUICulture = New-Object Globalization.CultureInfo('en-US')
} catch {}
function Fail($m) { Write-Host "[FAIL] $m"; exit 1 }
$script:pathAdded = 0
# Malformed registry PATH entries are skipped.
function AddPath($d) {
  if (-not $d) { return }
  $d = ([string]$d).Trim().Trim('"')
  if (-not $d) { return }
  # Silent skip: an illegal path errors even inside catch.
  try { if (-not (Test-Path -LiteralPath $d -EA SilentlyContinue)) { return } } catch { return }
  if (($env:Path -split ';') -notcontains $d) {
    $env:Path = "$($env:Path);$d"; $script:pathAdded++
  }
}
# sshd snapshots PATH at start; later installs are missing.
foreach ($scope in 'Machine', 'User') {
  foreach ($d in [Environment]::GetEnvironmentVariable('Path', $scope) -split ';') { AddPath $d }
}
AddPath "$env:ProgramFiles\Git\cmd"
AddPath 'C:\Program Files\Git\cmd'
AddPath "$env:LOCALAPPDATA\Programs\Git\cmd"
Write-Host "[PATH] +$($script:pathAdded) dir(s)"
if (-not (Get-Command git -EA SilentlyContinue)) { Fail "git not on PATH. PATH = $env:Path" }
if (-not (Test-Path -LiteralPath $ProjectDir)) { Fail "project dir missing: $ProjectDir" }
Set-Location -LiteralPath $ProjectDir
if (-not (Test-Path -LiteralPath '.git')) { Fail "$ProjectDir is not a git working copy" }
$env:GIT_TERMINAL_PROMPT = '0'
# Best effort: deploy.ps1 retries via mirrors when this fetch fails.
git fetch --all --prune 2>&1 | %{ Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Host '[WARN] direct git fetch failed, deploy.ps1 will retry via mirrors'
} else {
  git reset --hard "origin/$Branch" 2>&1 | %{ Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Fail "git reset --hard origin/$Branch failed" }
  Write-Host "[OK] updated to $(git rev-parse --short HEAD 2>&1)"
}
$deploy = Join-Path $ProjectDir 'scripts\deploy.ps1'
if (-not (Test-Path -LiteralPath $deploy)) { Fail "deploy script not found: $deploy" }
& powershell -NoProfile -ExecutionPolicy Bypass -File $deploy
if ($LASTEXITCODE -ne 0) { Fail "scripts/deploy.ps1 exited with code $LASTEXITCODE" }
Write-Host '[DONE] deployment finished successfully'