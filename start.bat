@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 修仙启动脚本
color 0A

echo ===============================================
echo    重生之凡人修仙传 - 一键启动脚本
echo ===============================================
echo.

rem 检查Node.js是否安装（node 是exe，无需call）
node --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到Node.js，请先安装Node.js
    echo 下载地址: https://nodejs.org/
    goto :wait
)

rem 检查npm是否可用（npm是.cmd文件，必须用call，否则会带崩整个脚本）
call npm --version >nul 2>&1
if errorlevel 1 (
    echo [错误] npm不可用，请检查Node.js安装
    goto :wait
)

echo [信息] 检测到Node.js版本:
node --version
echo.

rem 检查后端依赖
if not exist "server\node_modules" (
    echo [信息] 首次运行，正在安装后端依赖...
    cd /d server
    call npm install
    if errorlevel 1 (
        echo [错误] 后端依赖安装失败，请查看上方红色报错
        goto :wait
    )
    cd /d ..
    echo.
)

rem 检查数据库连接配置
if not exist "server\config\database.js" (
    echo [错误] 数据库配置文件不存在
    echo 请确保server/config/database.js文件存在
    goto :wait
)

rem 默认端口
set SERVER_PORT=5000
set CLIENT_PORT=5173

rem 端口占用预检（使用netstat，纯cmd）
echo [信息] 正在检查端口占用情况...
netstat -ano 2>nul | findstr ":5000 " >nul
if not errorlevel 1 (
    echo [警告] 端口 5000 已被占用，后端启动可能失败
    echo         可关闭占用进程或执行: taskkill /f /im node.exe
)
netstat -ano 2>nul | findstr ":5173 " >nul
if not errorlevel 1 (
    echo [警告] 端口 5173 已被占用，前端启动可能失败
)
echo.

echo [信息] 正在启动服务器（新窗口）...
echo.

rem 启动后端服务器（cmd /k 保活，输出写入日志，报错不关窗）
start "修仙服务器" cmd /k "chcp 65001 >nul & cd /d server && call npm start >> ..\startup_backend.log 2>&1"

rem 等待服务器启动
timeout /t 3 /nobreak >nul

echo [信息] 正在启动前端客户端（新窗口）...
echo.

rem 启动前端客户端（cmd /k 保活，输出写入日志）
start "修仙客户端" cmd /k "chcp 65001 >nul & cd /d client && call npm run dev >> ..\startup_frontend.log 2>&1"

echo.
echo ===============================================
echo [成功] 前后端已分别在两个新窗口启动
echo.
echo 后端服务器: http://localhost:%SERVER_PORT%
echo 前端客户端: http://localhost:%CLIENT_PORT%
echo API入口: http://localhost:%SERVER_PORT%/api
echo.
echo 测试账号: 1592363624
echo 测试密码: 1592363624
echo.
echo 若子窗口报错，请查看 startup_backend.log / startup_frontend.log
echo ===============================================
echo.

goto :wait

:wait
echo.
echo 按任意键关闭本窗口（子窗口不受影响）...
pause >nul
