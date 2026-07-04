@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 重生之凡人修仙传 - 手动触发部署脚本
color 0A

echo ===================================================
echo   重生之凡人修仙传 - 手动部署触发器
echo   用途: 在服务器上手动执行 deploy.ps1
echo   场景: GitHub Actions 未配置或想手动部署时使用
echo ===================================================
echo.

:: 检查 PowerShell 是否可用
powershell -Command "exit" >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 PowerShell，请确认系统已安装
    pause
    exit /b 1
)

:: 定位部署脚本（与 deploy.bat 同目录）
set "SCRIPT_DIR=%~dp0"
set "DEPLOY_PS1=%SCRIPT_DIR%deploy.ps1"

if not exist "%DEPLOY_PS1%" (
    echo [错误] 未找到部署脚本: %DEPLOY_PS1%
    echo [提示] 请确认 scripts 目录下存在 deploy.ps1
    pause
    exit /b 1
)

echo [信息] 即将执行: %DEPLOY_PS1%
echo [信息] 按 Ctrl+C 取消，按任意键继续...
pause >nul

:: 执行 PowerShell 部署脚本，绕过执行策略限制
powershell -ExecutionPolicy Bypass -File "%DEPLOY_PS1%"

if errorlevel 1 (
    echo.
    echo ===================================================
    echo   部署失败
    echo   请查看上方日志排查错误
    echo ===================================================
    pause
    exit /b 1
)

echo.
echo ===================================================
echo   部署成功完成
echo ===================================================
pause
