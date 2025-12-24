@echo off
chcp 65001
title 重生之凡人修仙传 - 开发环境

echo.
echo ===================================================
echo   重生之凡人修仙传 - 一键启动脚本
echo   凡人世界，仙道长生
echo ===================================================
echo.

cd /d "%~dp0"

if not exist node_modules (
    echo [1/4] 正在安装项目依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo 项目依赖安装失败！
        pause
        exit /b 1
    )
    echo 依赖安装完成
) else (
    echo [跳过] 项目依赖已存在
)

echo.
if not exist server\node_modules (
    echo [2/4] 正在安装后端依赖...
    cd server
    call npm install
    if %errorlevel% neq 0 (
        echo 后端依赖安装失败！
        cd ..
        pause
        exit /b 1
    )
    cd ..
    echo 后端依赖安装完成
) else (
    echo [跳过] 后端依赖已存在
)

echo.
if not exist client\node_modules (
    echo [3/4] 正在安装前端依赖...
    cd client
    call npm install
    if %errorlevel% neq 0 (
        echo 前端依赖安装失败！
        cd ..
        pause
        exit /b 1
    )
    cd ..
    echo 前端依赖安装完成
) else (
    echo [跳过] 前端依赖已存在
)

echo.
echo ===================================================
echo [4/4] 正在启动服务...
echo   - 后端 API: http://localhost:3000
echo   - 前端界面: http://localhost:5173
echo ===================================================
echo.
echo 服务启动中，请稍候...
echo.

cd server
start /B npm start > ..\logs\server.log 2>&1
cd ..\client
start /B npm run dev > ..\logs\client.log 2>&1
cd ..

echo 服务已启动！
echo - 后端日志: logs\server.log
echo - 前端日志: logs\client.log
echo.
echo 请在浏览器中访问 http://localhost:5173 开始游戏
echo 按 Ctrl+C 可停止所有服务
echo.

:waitloop
timeout /t 1 >nul
goto waitloop
