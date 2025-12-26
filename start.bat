@echo off
title 重生之凡人修仙传 - 一键启动脚本
color 0A

echo ===============================================
echo    重生之凡人修仙传 - 一键启动脚本
echo ===============================================
echo.

:: 检查Node.js是否安装
node --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到Node.js，请先安装Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 检查npm是否可用
npm --version >nul 2>&1
if errorlevel 1 (
    echo [错误] npm不可用，请检查Node.js安装
    pause
    exit /b 1
)

echo [信息] 检测到Node.js版本:
node --version
echo.

:: 检查项目依赖
if not exist "node_modules" (
    echo [信息] 首次运行，正在安装依赖...
    npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
    echo.
)

:: 检查数据库连接配置
if not exist "server\config\database.js" (
    echo [错误] 数据库配置文件不存在
    echo 请确保server/config/database.js文件存在
    pause
    exit /b 1
)

echo [信息] 正在启动服务器...
echo.

:: 启动后端服务器
start "修仙服务器" cmd /k "cd server && npm start"

:: 等待服务器启动
timeout /t 3 /nobreak >nul

echo [信息] 正在启动前端客户端...
echo.

:: 启动前端客户端
start "修仙客户端" cmd /k "cd client && npm run dev"

echo.
echo ===============================================
echo [成功] 服务器启动完成！
echo.
echo 后端服务器: http://localhost:3000
echo 前端客户端: http://localhost:5173
echo API文档: http://localhost:3000/api-docs
echo.
echo 测试账号: testuser1592363624
echo 测试密码: 123456
echo.
echo 按任意键关闭此窗口...
echo ===============================================

pause >nul