@echo off
chcp 65001
echo ===================================================
echo 重生之凡人修仙传 - 一键启动脚本
echo ===================================================
echo 正在安装依赖... (首次运行可能较慢)
call npm install
cd server
call npm install
cd ../client
call npm install
cd ..

echo.
echo ===================================================
echo 正在启动服务...
echo 1. 后端 API (Port 3000)
echo 2. 前端界面 (Port 5173)
echo ===================================================
npm start

pause
