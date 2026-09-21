@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 修仙启动脚本
color 0A

rem cd to script dir: this file uses many relative paths
cd /d "%~dp0"

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

rem ports are read from .env; hardcoded values would kill the wrong pid after a config change
set SERVER_PORT=5000
set CLIENT_PORT=5173
if exist "%~dp0server\.env" for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0server\.env") do if /i "%%~A"=="PORT" set "SERVER_PORT=%%~B"
if exist "%~dp0client\.env" for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0client\.env") do if /i "%%~A"=="VITE_CLIENT_PORT" set "CLIENT_PORT=%%~B"

rem kill the occupants first, or the new instance dies with EADDRINUSE
echo [信息] 正在检查并清理端口占用...
call :free_port !SERVER_PORT! 后端API
call :free_port !CLIENT_PORT! 前端Vite
echo.

echo [信息] 正在启动服务器（新窗口）...
echo.

rem 本脚本所有 start 行必须保持纯 ASCII：中文会让 cmd 的引号扫描错位，
rem 引号内的连接符会泄漏成命令分隔符，start 就不弹窗而是内联阻塞主脚本
start "Backend" cmd /k "%~dp0scripts\run-server.bat"

rem 等待服务器启动
timeout /t 3 /nobreak >nul

echo [信息] 正在启动前端客户端（新窗口）...
echo.

rem 启动前端客户端（同样保持纯 ASCII）
start "Frontend" cmd /k "%~dp0scripts\run-client.bat"

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
echo 子窗口已实时显示日志，同时写入 logs\startup_backend.log / logs\startup_frontend.log
echo.
echo 若窗口里出现方括号形式的转义乱码，启动前执行 set NO_COLOR=1 即可关闭颜色
echo ===============================================
echo.

goto :wait

rem ---- sub-routine: kill every process LISTENING on a port. %~1=port %~2=label ----
:free_port
set "_PORT=%~1"
echo !_PORT!| findstr /R "^[1-9][0-9]*$" >nul
if errorlevel 1 (
    echo   [跳过] 端口值 "!_PORT!" 非法，未做检查
    goto :eof
)
rem LISTENING only: ESTABLISHED lines also carry ":5000" as the peer address, matching them would kill the client
set "_PIDS="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /C:":!_PORT! " ^| findstr /C:"LISTENING"') do (
    if not defined SEEN_%%P (
        set "SEEN_%%P=1"
        if not "%%P"=="0" if not "%%P"=="4" set "_PIDS=!_PIDS! %%P"
    )
)
for /f "delims=" %%V in ('set SEEN_ 2^>nul') do set "%%V="
if not defined _PIDS (
    echo   [空闲] 端口 !_PORT!  [%~2]
    goto :eof
)
echo   [占用] 端口 !_PORT!  [%~2]  正被以下进程使用，已全部结束:
for %%P in (!_PIDS!) do (
    tasklist /FI "PID eq %%P" /NH 2>nul
    taskkill /F /T /PID %%P >nul 2>&1
)
rem killing a pid does not free the socket instantly, so poll; each netstat pass is itself the delay
set "_LEFT="
set _TRY=0
:port_recheck
set "_LEFT="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /C:":!_PORT! " ^| findstr /C:"LISTENING"') do set "_LEFT=%%P"
if not defined _LEFT goto port_recheck_done
set /a _TRY+=1
if !_TRY! LSS 15 goto port_recheck
:port_recheck_done
if defined _LEFT (
    echo   [失败] 端口 !_PORT! 仍被 PID !_LEFT! 占用，可能需要管理员权限
) else (
    echo   [释放] 端口 !_PORT! 已可用
)
goto :eof

:wait
echo.
echo 按任意键关闭本窗口（子窗口不受影响）...
pause >nul
