# CI bootstrap: base64-encoded by GitHub Actions into `powershell -EncodedCommand`.
# Keep pure ASCII and small - cmd.exe caps a command line at 8191 chars.
$ProjectDir = 'C:\Users\Administrator\Desktop\re_xiuxian'
$Branch = 'main'
$ErrorActionPreference = 'Continue'
# Console uses the OEM codepage (936 on zh-CN), which mangles git output and PS errors.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Threading.Thread]::CurrentThread.CurrentUICulture = New-Object Globalization.CultureInfo('en-US')
} catch {}
function Fail($m) { Write-Host "[FAIL] $m"; exit 1 }
$script:pathAdded = 0
function AddPath($d) {
  if (-not $d) { return }
  # Registry PATH entries are user-editable and can be malformed (stray quotes,
  # placeholder chars). Test-Path throws on those and would spam the CI log with
  # a red "Illegal characters in path" error, so strip quotes and skip on failure.
  $d = ([string]$d).Trim().Trim('"')
  if (-not $d) { return }
  $exists = $false
  try { $exists = Test-Path -LiteralPath $d } catch { return }
  if ($exists -and (($env:Path -split ';') -notcontains $d)) {
    $env:Path = "$($env:Path);$d"; $script:pathAdded++
  }
}
# sshd snapshots PATH when the service starts, so Git/Node installed later are missing
# in SSH sessions. Read PATH live from the registry, then guess well-known locations.
foreach ($scope in 'Machine', 'User') {
  foreach ($d in [Environment]::GetEnvironmentVariable('Path', $scope) -split ';') { AddPath $d }
}
AddPath "$env:ProgramFiles\Git\cmd"
AddPath 'C:\Program Files\Git\cmd'
AddPath "$env:LOCALAPPDATA\Programs\Git\cmd"
Write-Host "[PATH] restored $($script:pathAdded) dir(s) missing from this SSH session"
if (-not (Get-Command git -EA SilentlyContinue)) { Fail "git not on PATH. PATH = $env:Path" }
if (-not (Test-Path -LiteralPath $ProjectDir)) { Fail "project directory not found: $ProjectDir" }
Set-Location -LiteralPath $ProjectDir
if (-not (Test-Path -LiteralPath '.git')) { Fail "$ProjectDir is not a git working copy" }
$env:GIT_TERMINAL_PROMPT = '0'
Write-Host "[OK] $(git --version 2>&1) @ $ProjectDir, HEAD $(git rev-parse --short HEAD 2>&1)"
# Best effort: deploy.ps1 retries through GitHub mirrors if this direct fetch fails.
git fetch --all --prune 2>&1 | %{ Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Host '[WARN] direct git fetch failed, deploy.ps1 will retry through mirrors'
} else {
  git reset --hard "origin/$Branch" 2>&1 | %{ Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Fail "git reset --hard origin/$Branch failed" }
  Write-Host "[OK] working copy updated to $(git rev-parse --short HEAD 2>&1)"
}
$deploy = Join-Path $ProjectDir 'scripts\deploy.ps1'
if (-not (Test-Path -LiteralPath $deploy)) { Fail "deploy script not found: $deploy" }
& powershell -NoProfile -ExecutionPolicy Bypass -File $deploy
if ($LASTEXITCODE -ne 0) { Fail "scripts/deploy.ps1 exited with code $LASTEXITCODE" }
Write-Host '[DONE] deployment finished successfully'
